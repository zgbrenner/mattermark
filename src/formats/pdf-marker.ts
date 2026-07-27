/**
 * Incremental invisible PDF carrier and high-level recipient marking.
 *
 * Original bytes remain an exact prefix. Supported pages receive a shared,
 * blank Type 3 font and invisible ToUnicode text stream through a new classic
 * xref revision, so visible glyphs and layout are unchanged.
 */

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mark } from '../orchestrator.js';
import type { MarkOptions, MarkResult } from '../orchestrator.js';
import type { CopyIdentity, Issuer } from '../crypto.js';
import { extractPdfText } from './pdf-reader.js';
import {
  bfcharBlocks,
  classicPdfIndex,
  groupContiguous,
  indexedDictionaries,
  patchPageContents,
  patchPageResources,
  streamBody,
  utf16beHex,
  type ReplacementObject,
  type XrefEntry,
} from './pdf-xref.js';

export interface AppendPdfCarrierResult {
  bytes: Buffer;
  pagesMarked: number;
  resourceName: string;
}

export interface MarkPdfResult {
  /** the marked PDF, ready to deliver */
  bytes: Buffer;
  /** the engine result for the hidden carrier text */
  result: MarkResult;
  /** number of page dictionaries updated to reference the carrier */
  pagesMarked: number;
}

/**
 * Append an invisible, extractable Unicode carrier to every page.
 *
 * The original file is an exact byte prefix of the result. The incremental
 * revision replaces only page/resource dictionaries and adds four shared
 * objects: blank glyph, ToUnicode CMap, Type 3 font, and carrier content.
 */
export function appendMattermarkPdfCarrier(
  input: Buffer,
  carrier: string,
): AppendPdfCarrierResult {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (typeof carrier !== 'string' || carrier.length === 0) {
    throw new Error('pdf: carrier text must not be empty');
  }
  if (/\/MattermarkCarrier\s+true\b/.test(bytes.toString('latin1'))) {
    throw new Error('pdf: a Mattermark carrier already exists; refusing to stack carriers');
  }

  const index = classicPdfIndex(bytes);
  const trailer = index.trailer;
  const objects = indexedDictionaries(bytes, index.entries);
  if ([...objects.values()].some((object) => /\/Type\s*\/ObjStm\b/.test(object.body))) {
    throw new Error('pdf: object streams are outside the safe marking envelope');
  }
  if (
    [...objects.values()].some((object) =>
      /\/Type\s*\/Sig\b|\/ByteRange\s*\[|\/DocMDP\b/.test(object.body),
    )
  ) {
    throw new Error(
      'pdf: signed or certified PDFs are outside the safe marking envelope',
    );
  }

  const pages = [...objects.values()].filter(
    (object) =>
      /\/Type\s*\/Page\b/.test(object.body) &&
      !/\/Type\s*\/Pages\b/.test(object.body),
  );
  if (pages.length === 0) {
    throw new Error('pdf: no directly addressable page objects found');
  }

  const unique = [...new Set([...carrier])];
  if (unique.length > 255) {
    throw new Error('pdf: carrier needs more than 255 distinct Unicode characters');
  }

  const maxExisting = Math.max(trailer.size - 1, ...index.entries.keys());
  const blankNumber = maxExisting + 1;
  const cmapNumber = maxExisting + 2;
  const fontNumber = maxExisting + 3;
  const contentNumber = maxExisting + 4;
  const fontRef = `${fontNumber} 0 R`;
  const contentRef = `${contentNumber} 0 R`;

  const suffix = createHash('sha256')
    .update(carrier)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  const resourceBase = `MMY${suffix}`;
  const sourceText = bytes.toString('latin1');
  let resourceName = resourceBase;
  let resourceAttempt = 0;
  while (new RegExp(`/${resourceName}\\b`).test(sourceText)) {
    resourceAttempt++;
    resourceName = `${resourceBase}X${resourceAttempt}`;
  }

  const codeOf = new Map<string, number>(unique.map((ch, index) => [ch, index + 1]));
  const shownHex = [...carrier]
    .map((ch) => codeOf.get(ch)!.toString(16).padStart(2, '0'))
    .join('');
  const content = `BT /${resourceName} 1 Tf 3 Tr 0 0 Td <${shownHex}> Tj ET`;
  const contentDeflated = deflateSync(Buffer.from(content, 'latin1'));

  const mappings = unique.map(
    (ch) =>
      `<${codeOf.get(ch)!.toString(16).padStart(2, '0')}> <${utf16beHex(ch)}>`,
  );
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Mattermark) /Ordering (Carrier) /Supplement 0 >> def
/CMapName /MattermarkCarrier def /CMapType 2 def
1 begincodespacerange <00> <ff> endcodespacerange
${bfcharBlocks(mappings)}
endcmap CMapName currentdict /CMap defineresource pop end end`;
  const cmapDeflated = deflateSync(Buffer.from(cmap, 'latin1'));

  const glyphNames = unique.map((_, index) => `/g${index + 1}`);
  const charProcs = glyphNames
    .map((name) => `${name} ${blankNumber} 0 R`)
    .join(' ');
  const widths = unique.map(() => '0').join(' ');
  const fontBody =
    `<< /Type /Font /Subtype /Type3 /Name /${resourceName} ` +
    '/FontBBox [0 0 0 0] /FontMatrix [0.001 0 0 0.001 0 0] ' +
    `/CharProcs << ${charProcs} >> ` +
    `/Encoding << /Type /Encoding /Differences [1 ${glyphNames.join(' ')}] >> ` +
    `/FirstChar 1 /LastChar ${unique.length} /Widths [${widths}] ` +
    `/Resources << >> /ToUnicode ${cmapNumber} 0 R /MattermarkCarrier true >>`;
  const blankGlyph = Buffer.from('0 0 d0', 'latin1');

  const replacements = new Map<number, ReplacementObject>();
  for (const page of pages) {
    let body = patchPageResources(
      page.body,
      fontRef,
      resourceName,
      objects,
      replacements,
    );
    body = patchPageContents(body, contentRef);
    replacements.set(page.num, { num: page.num, gen: page.gen, body });
  }

  const entries: ReplacementObject[] = [
    ...replacements.values(),
    {
      num: blankNumber,
      gen: 0,
      body: streamBody(`<< /Length ${blankGlyph.length} >>`, blankGlyph),
    },
    {
      num: cmapNumber,
      gen: 0,
      body: streamBody(
        `<< /Length ${cmapDeflated.length} /Filter /FlateDecode /MattermarkCarrier true >>`,
        cmapDeflated,
      ),
    },
    { num: fontNumber, gen: 0, body: fontBody },
    {
      num: contentNumber,
      gen: 0,
      body: streamBody(
        `<< /Length ${contentDeflated.length} /Filter /FlateDecode /MattermarkCarrier true >>`,
        contentDeflated,
      ),
    },
  ].sort((a, b) => a.num - b.num);

  const separator =
    bytes.length > 0 && bytes[bytes.length - 1] === 0x0a
      ? Buffer.alloc(0)
      : Buffer.from('\n');
  const parts: Buffer[] = [bytes, separator];
  let position = bytes.length + separator.length;
  const xrefEntries: XrefEntry[] = [];

  for (const entry of entries) {
    const object = Buffer.concat([
      Buffer.from(`${entry.num} ${entry.gen} obj\n`, 'latin1'),
      Buffer.from(entry.body, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    xrefEntries.push({ num: entry.num, gen: entry.gen, offset: position });
    parts.push(object);
    position += object.length;
  }

  const xrefStart = position;
  let xref = 'xref\n';
  for (const group of groupContiguous(xrefEntries)) {
    xref += `${group[0].num} ${group.length}\n`;
    for (const entry of group) {
      xref += `${String(entry.offset).padStart(10, '0')} ${String(entry.gen).padStart(5, '0')} n \n`;
    }
  }

  const newSize = Math.max(...entries.map((entry) => entry.num), maxExisting) + 1;
  let trailerDictionary =
    `<< /Size ${newSize} /Root ${trailer.rootRef} /Prev ${trailer.previousXref}`;
  if (trailer.info) trailerDictionary += ` ${trailer.info}`;
  if (trailer.id) trailerDictionary += ` ${trailer.id}`;
  trailerDictionary += ' >>';
  xref += `trailer\n${trailerDictionary}\nstartxref\n${xrefStart}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));

  return {
    bytes: Buffer.concat(parts),
    pagesMarked: pages.length,
    resourceName,
  };
}

function pdfCarrierSource(visibleText: string, targetLength = 8192): string {
  const clean = visibleText
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const seed = /[A-Za-z]/.test(clean)
    ? clean
    : 'Mattermark recipient attribution carrier for protected legal work product.';

  let output = '';
  while (output.length < targetLength) output += `${seed}\n`;
  return output.slice(0, targetLength);
}

/** Mark a PDF without changing its visible glyphs or existing byte content. */
export function markPdf(
  bytes: Buffer,
  identity: CopyIdentity,
  issuer: Issuer,
  opts: MarkOptions = {},
): MarkPdfResult {
  const visibleText = extractPdfText(bytes);
  if (!visibleText.trim()) {
    throw new Error(
      'pdf: no extractable text layer; scanned or image-only PDFs are outside the marking envelope',
    );
  }

  const result = mark(pdfCarrierSource(visibleText), identity, issuer, opts);
  result.warnings = result.warnings.filter(
    (warning) => !warning.startsWith('HOMOGLYPH CHANNEL ACTIVE:'),
  );
  if (result.layers.some((layer) => layer.codec === 'HG' && layer.embedded)) {
    result.warnings.unshift(
      'PDF HIDDEN-CARRIER HOMOGLYPHS: the visible page glyphs remain byte-for-byte ' +
        'untouched, so ordinary visible-text keyword search is preserved. The hidden ' +
        'carrier itself contains confusables and can be exposed by text extraction.',
    );
  }
  result.warnings.push(
    'PDF STRUCTURE DEPENDENCE: printing, rasterization, OCR replacement, flattening, ' +
      'optimization, or removal of invisible text can destroy the hidden carrier.',
  );

  const appended = appendMattermarkPdfCarrier(bytes, result.text);
  return {
    bytes: appended.bytes,
    result,
    pagesMarked: appended.pagesMarked,
  };
}
