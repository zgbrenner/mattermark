/**
 * pdf.ts — PDF text extraction for DETECTION, plus a small PDF writer used by
 * the demo and tests.
 *
 * Why detection only. The symbolic codecs are a text-stream technique. A PDF is
 * not a text stream; it is a display list that positions glyphs. Inserting a
 * zero-width marker, swapping a space for a wider one, or substituting a Latin
 * letter for a differently-metric'd confusable all require the glyph to exist in
 * the embedded (usually subsetted) font AND change the visible layout. So a PDF
 * cannot be marked in place with these codecs — that is a font/layout problem,
 * a separate slice. See README.
 *
 * What IS tractable is the other direction: a document marked as text (or as a
 * DOCX) and then exported to PDF keeps its marks in the PDF's text layer, and a
 * leaked PDF can be attributed by extracting that text and running the detector.
 * `extractPdfText` reads the common, well-defined subset:
 *
 *   - classic `N G obj ... endobj` objects (not object streams),
 *   - FlateDecode or unfiltered content streams,
 *   - text shown with Tj / TJ, decoded through the font's ToUnicode CMap
 *     (bfchar + bfrange), with a Latin-1 fallback when no CMap is present.
 *
 * Out of envelope (reported, not silently mangled): object streams / xref
 * streams (PDF 1.5+ full-compression), encryption, and scanned/image PDFs with
 * no text layer. This is validated against spec-compliant PDFs; it is not a
 * general-purpose PDF parser.
 */

import { inflateSync, deflateSync } from 'node:zlib';
import { detect, DetectResult } from '../orchestrator.js';
import type { StegoCodec } from '../codecs/types.js';

/* --------------------------------- reader -------------------------------- */

interface RawObject {
  num: number;
  dictStart: number;
  dictEnd: number;
  stream: Buffer | null;
}

/** Index every top-level `N G obj ... endobj` by object number (latin1 scan). */
function parseObjects(buf: Buffer): Map<number, RawObject> {
  const s = buf.toString('latin1'); // 1 char == 1 byte, offsets == byte offsets
  const objs = new Map<number, RawObject>();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const num = Number(m[1]);
    const dictStart = m.index + m[0].length;
    const endObj = s.indexOf('endobj', dictStart);
    if (endObj < 0) continue;

    let stream: Buffer | null = null;
    const streamKw = s.indexOf('stream', dictStart);
    if (streamKw >= 0 && streamKw < endObj) {
      // data begins after the EOL that follows the `stream` keyword
      let dataStart = streamKw + 'stream'.length;
      if (s[dataStart] === '\r') dataStart++;
      if (s[dataStart] === '\n') dataStart++;
      // Prefer the declared /Length (exact); fall back to scanning for endstream.
      const lenMatch = /\/Length\s+(\d+)\b/.exec(s.slice(dictStart, streamKw));
      if (lenMatch) {
        stream = buf.subarray(dataStart, dataStart + Number(lenMatch[1]));
      } else {
        const dataEnd = s.indexOf('endstream', dataStart);
        if (dataEnd >= 0) {
          let e = dataEnd;
          if (s[e - 1] === '\n') e--;
          if (s[e - 1] === '\r') e--;
          stream = buf.subarray(dataStart, e);
        }
      }
    }
    objs.set(num, { num, dictStart, dictEnd: streamKw >= 0 && streamKw < endObj ? streamKw : endObj, stream });
  }
  return objs;
}

function dictText(buf: Buffer, o: RawObject): string {
  return buf.toString('latin1', o.dictStart, o.dictEnd);
}

function decodeStream(dict: string, stream: Buffer): Buffer {
  if (/\/Filter\s*\/FlateDecode/.test(dict)) return inflateSync(stream);
  return stream;
}

/** Parse a ToUnicode CMap (bfchar + bfrange) into a code -> string map. */
function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const hexToStr = (h: string) => {
    const clean = h.replace(/\s+/g, '');
    let out = '';
    for (let i = 0; i + 4 <= clean.length; i += 4) out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
    return out;
  };

  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const e of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(e[1], 16), hexToStr(e[2]));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const e of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const lo = parseInt(e[1], 16);
      const hi = parseInt(e[2], 16);
      let dst = parseInt(e[3], 16);
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(dst++));
    }
  }
  return map;
}

/** Merge every ToUnicode CMap in the document into one code -> unicode map. */
function globalToUnicode(buf: Buffer, objs: Map<number, RawObject>): Map<number, string> {
  const merged = new Map<number, string>();
  for (const o of objs.values()) {
    if (!o.stream) continue;
    // A ToUnicode CMap is a stream object; recognise it by its decoded content.
    let data: Buffer;
    try {
      data = decodeStream(dictText(buf, o), o.stream);
    } catch {
      continue;
    }
    const text = data.toString('latin1');
    if (text.includes('beginbfchar') || text.includes('beginbfrange')) {
      for (const [k, v] of parseToUnicode(text)) merged.set(k, v);
    }
  }
  return merged;
}

/** Pull the string literals shown by a content stream, in order. */
function contentStrings(content: string): Array<{ hex: boolean; body: string }> {
  const out: Array<{ hex: boolean; body: string }> = [];
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '(') {
      let depth = 1;
      let j = i + 1;
      let body = '';
      while (j < content.length && depth > 0) {
        const c = content[j];
        if (c === '\\') {
          body += content[j] + (content[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') {
          depth--;
          if (depth === 0) break;
        }
        body += c;
        j++;
      }
      out.push({ hex: false, body });
      i = j;
    } else if (ch === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i);
      if (end < 0) break;
      out.push({ hex: true, body: content.slice(i + 1, end) });
      i = end;
    } else if (ch === '<' && content[i + 1] === '<') {
      i++; // skip dictionary opener
    }
  }
  return out;
}

/** Decode one PDF string literal's raw byte codes into text via ToUnicode. */
function decodeString(lit: { hex: boolean; body: string }, toUnicode: Map<number, string>): string {
  const codes: number[] = [];
  if (lit.hex) {
    const clean = lit.body.replace(/\s+/g, '');
    for (let i = 0; i + 2 <= clean.length; i += 2) codes.push(parseInt(clean.slice(i, i + 2), 16));
  } else {
    for (let i = 0; i < lit.body.length; i++) {
      const c = lit.body[i];
      if (c === '\\') {
        const n = lit.body[i + 1];
        if (n >= '0' && n <= '7') {
          let oct = n;
          let k = i + 2;
          while (k < lit.body.length && oct.length < 3 && lit.body[k] >= '0' && lit.body[k] <= '7') oct += lit.body[k++];
          codes.push(parseInt(oct, 8));
          i = k - 1;
        } else {
          const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
          codes.push(map[n] ?? n.charCodeAt(0));
          i++;
        }
      } else {
        codes.push(c.charCodeAt(0));
      }
    }
  }
  return codes.map((c) => toUnicode.get(c) ?? String.fromCharCode(c)).join('');
}

/** Extract the visible text of a PDF, in reading order (best effort). */
export function extractPdfText(bytes: Buffer): string {
  const objs = parseObjects(bytes);
  if (objs.size === 0) throw new Error('pdf: no objects found (encrypted or object-stream PDF?)');
  const toUnicode = globalToUnicode(bytes, objs);

  let out = '';
  for (const o of objs.values()) {
    if (!o.stream) continue;
    let data: Buffer;
    try {
      data = decodeStream(dictText(bytes, o), o.stream);
    } catch {
      continue;
    }
    const text = data.toString('latin1');
    if (text.includes('beginbfchar') || text.includes('beginbfrange')) continue; // a cmap, not content
    if (!/\bTj\b|\bTJ\b/.test(text)) continue; // not a content stream
    for (const lit of contentStrings(text)) out += decodeString(lit, toUnicode);
  }
  return out;
}

/** Detect a mark in a PDF by extracting its text layer and running the detector. */
export function detectPdf(bytes: Buffer, codecIds?: Array<StegoCodec['id']>): DetectResult {
  return detect(extractPdfText(bytes), codecIds);
}

/* --------------------------------- writer -------------------------------- */

/**
 * Build a minimal, spec-compliant PDF whose text layer is exactly `text`,
 * carried through a ToUnicode CMap. Used by the demo and tests to exercise the
 * extractor on a real PDF structure (classic xref, FlateDecode, ToUnicode).
 * Not a general document renderer: one page, glyphs are not laid out for
 * display, only the extractable text layer is faithful.
 */
export function buildTextPdf(text: string): Buffer {
  const chars = [...text];
  const unique = [...new Set(chars)];
  if (unique.length > 255) throw new Error('buildTextPdf: too many distinct characters for a 1-byte demo font');
  const codeOf = new Map(unique.map((ch, i) => [ch, i + 1])); // codes 1..N

  const hex2 = (n: number) => n.toString(16).padStart(2, '0');
  const hex4 = (n: number) => n.toString(16).padStart(4, '0');

  // Content stream: show the coded string.
  const shown = chars.map((ch) => '\\' + (codeOf.get(ch) as number).toString(8).padStart(3, '0')).join('');
  const content = `BT /F1 12 Tf 72 720 Td (${shown}) Tj ET`;
  const contentDeflated = deflateSync(Buffer.from(content, 'latin1'));

  // ToUnicode CMap.
  const bf = unique
    .map((ch) => `<${hex2(codeOf.get(ch) as number)}> <${hex4(ch.codePointAt(0) as number)}>`)
    .join('\n');
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def /CMapType 2 def
1 begincodespacerange <00> <ff> endcodespacerange
${unique.length} beginbfchar
${bf}
endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end`;
  const cmapDeflated = deflateSync(Buffer.from(cmap, 'latin1'));

  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>', 'latin1'),
    streamObject(`<< /Length ${contentDeflated.length} /Filter /FlateDecode >>`, contentDeflated),
    streamObject(`<< /Length ${cmapDeflated.length} /Filter /FlateDecode >>`, cmapDeflated),
  ];

  // Assemble the file with a classic xref table.
  const header = Buffer.from('%PDF-1.5\n%\xff\xff\xff\xff\n', 'latin1');
  const parts: Buffer[] = [header];
  const offsets: number[] = [];
  let pos = header.length;
  objects.forEach((body, i) => {
    offsets.push(pos);
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(obj);
    pos += obj.length;
  });

  const xrefStart = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(parts);
}

function streamObject(dict: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${dict}\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
}
