/**
 * Conservative classic-xref parsing and incremental-update helpers.
 *
 * These helpers intentionally reject xref streams, hybrid references,
 * encryption, inherited resources, and unsupported page shapes rather than
 * attempting a lossy repair.
 */

export interface PdfDictionaryObject {
  num: number;
  gen: number;
  bodyStart: number;
  endObj: number;
  dictStart: number;
  dictEnd: number;
  body: string;
  stream: null;
}

export interface TrailerInfo {
  previousXref: number;
  size: number;
  rootRef: string;
  info?: string;
  id?: string;
}

export interface SourceXrefEntry {
  num: number;
  gen: number;
  offset: number;
  inUse: boolean;
}

export interface ClassicPdfIndex {
  trailer: TrailerInfo;
  entries: Map<number, SourceXrefEntry>;
}

export interface ReplacementObject {
  num: number;
  gen: number;
  body: string;
}

export interface XrefEntry {
  num: number;
  gen: number;
  offset: number;
}

function findDictionaryEnd(text: string, start: number): number {
  if (text.slice(start, start + 2) !== '<<') {
    throw new Error('pdf: expected dictionary');
  }

  let depth = 0;
  let stringDepth = 0;
  let inHexString = false;
  let inComment = false;
  let escaped = false;

  for (let i = start; i < text.length - 1; i++) {
    const ch = text[i];

    if (inComment) {
      if (ch === '\r' || ch === '\n') inComment = false;
      continue;
    }

    if (stringDepth > 0) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '(') {
        stringDepth++;
      } else if (ch === ')') {
        stringDepth--;
      }
      continue;
    }

    if (inHexString) {
      if (ch === '>') inHexString = false;
      continue;
    }

    if (ch === '%') {
      inComment = true;
      continue;
    }
    if (ch === '(') {
      stringDepth = 1;
      continue;
    }
    if (ch === '<' && text[i + 1] !== '<') {
      inHexString = true;
      continue;
    }

    const pair = text.slice(i, i + 2);
    if (pair === '<<') {
      depth++;
      i++;
    } else if (pair === '>>') {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('pdf: unterminated dictionary');
}

function readPdfLine(text: string, start: number): { line: string; next: number } {
  let end = start;
  while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end++;
  let next = end;
  if (text[next] === '\r') next++;
  if (text[next] === '\n') next++;
  return { line: text.slice(start, end), next };
}

function skipPdfWhitespace(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && /[\x00\x09\x0a\x0c\x0d\x20]/.test(text[cursor])) {
    cursor++;
  }
  return cursor;
}

/** Parse every classic xref revision. Newer entries win, including free rows. */
export function classicPdfIndex(bytes: Buffer): ClassicPdfIndex {
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('pdf: missing PDF header');
  }

  const text = bytes.toString('latin1');
  const startIndex = text.lastIndexOf('startxref');
  if (startIndex < 0) throw new Error('pdf: missing startxref');
  const startMatch = /startxref\s+(\d+)/.exec(text.slice(startIndex));
  if (!startMatch) throw new Error('pdf: malformed startxref');

  const latestXref = Number(startMatch[1]);
  const entries = new Map<number, SourceXrefEntry>();
  const visited = new Set<number>();
  let currentXref: number | undefined = latestXref;
  let latestTrailer: TrailerInfo | undefined;

  while (currentXref !== undefined) {
    if (!Number.isSafeInteger(currentXref) || currentXref < 0 || currentXref >= bytes.length) {
      throw new Error('pdf: invalid classic xref offset');
    }
    if (visited.has(currentXref)) throw new Error('pdf: cyclic Prev chain');
    visited.add(currentXref);

    let cursor = currentXref;
    const first = readPdfLine(text, cursor);
    if (first.line.trim() !== 'xref') {
      throw new Error('pdf: xref streams are outside the safe marking envelope');
    }
    cursor = first.next;

    let trailerDictionary: string | undefined;
    while (cursor < text.length) {
      cursor = skipPdfWhitespace(text, cursor);
      const row = readPdfLine(text, cursor);
      const line = row.line.trim();
      cursor = row.next;
      if (!line) continue;

      if (line === 'trailer') {
        const dictionaryStart = skipPdfWhitespace(text, cursor);
        if (text.slice(dictionaryStart, dictionaryStart + 2) !== '<<') {
          throw new Error('pdf: malformed trailer dictionary');
        }
        const dictionaryEnd = findDictionaryEnd(text, dictionaryStart);
        trailerDictionary = text.slice(dictionaryStart, dictionaryEnd);
        cursor = dictionaryEnd;
        break;
      }

      const subsection = /^(\d+)\s+(\d+)$/.exec(line);
      if (!subsection) throw new Error('pdf: malformed xref subsection');
      const firstObject = Number(subsection[1]);
      const count = Number(subsection[2]);
      if (!Number.isSafeInteger(firstObject) || !Number.isSafeInteger(count) || count < 0) {
        throw new Error('pdf: malformed xref subsection');
      }

      for (let index = 0; index < count; index++) {
        const entryLine = readPdfLine(text, cursor);
        cursor = entryLine.next;
        const entry = /^(\d+)\s+(\d+)\s+([nf])\b/.exec(entryLine.line.trim());
        if (!entry) throw new Error('pdf: malformed xref entry');
        const num = firstObject + index;
        if (!entries.has(num)) {
          entries.set(num, {
            num,
            offset: Number(entry[1]),
            gen: Number(entry[2]),
            inUse: entry[3] === 'n',
          });
        }
      }
    }

    if (!trailerDictionary) throw new Error('pdf: missing classic trailer');
    if (/\/XRefStm\b/.test(trailerDictionary)) {
      throw new Error('pdf: hybrid xref streams are outside the safe marking envelope');
    }
    if (/\/Encrypt\b/.test(trailerDictionary)) {
      throw new Error('pdf: encrypted PDFs are outside the safe marking envelope');
    }

    if (!latestTrailer) {
      const root = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(trailerDictionary);
      if (!root) throw new Error('pdf: trailer has no Root reference');
      latestTrailer = {
        previousXref: latestXref,
        size: Number(/\/Size\s+(\d+)/.exec(trailerDictionary)?.[1] ?? '0'),
        rootRef: `${root[1]} ${root[2]} R`,
        info: /\/Info\s+\d+\s+\d+\s+R/.exec(trailerDictionary)?.[0],
        id: /\/ID\s*\[[^\]]+\]/.exec(trailerDictionary)?.[0],
      };
    }

    const previous = /\/Prev\s+(\d+)/.exec(trailerDictionary);
    currentXref = previous ? Number(previous[1]) : undefined;
  }

  if (!latestTrailer) throw new Error('pdf: missing classic trailer');
  return { trailer: latestTrailer, entries };
}

/** Read only xref-indexed dictionaries, never object-like bytes inside streams. */
export function indexedDictionaries(
  bytes: Buffer,
  entries: Map<number, SourceXrefEntry>,
): Map<number, PdfDictionaryObject> {
  const text = bytes.toString('latin1');
  const objects = new Map<number, PdfDictionaryObject>();

  for (const entry of entries.values()) {
    if (!entry.inUse || entry.num === 0) continue;
    if (!Number.isSafeInteger(entry.offset) || entry.offset < 0 || entry.offset >= bytes.length) {
      throw new Error(`pdf: invalid xref offset for object ${entry.num}`);
    }

    const header = /^(\d+)\s+(\d+)\s+obj\b/.exec(text.slice(entry.offset));
    if (!header || Number(header[1]) !== entry.num || Number(header[2]) !== entry.gen) {
      throw new Error(`pdf: xref entry does not match object ${entry.num}`);
    }

    const bodyStart = entry.offset + header[0].length;
    const dictionaryStart = skipPdfWhitespace(text, bodyStart);
    if (text.slice(dictionaryStart, dictionaryStart + 2) !== '<<') continue;
    const dictionaryEnd = findDictionaryEnd(text, dictionaryStart);
    const body = text.slice(dictionaryStart, dictionaryEnd).trim();

    objects.set(entry.num, {
      num: entry.num,
      gen: entry.gen,
      bodyStart,
      endObj: dictionaryEnd,
      dictStart: dictionaryStart,
      dictEnd: dictionaryEnd,
      body,
      stream: null,
    });
  }

  return objects;
}

function insertBeforeDictionaryClose(dict: string, insertion: string): string {
  const end = dict.lastIndexOf('>>');
  if (end < 0) throw new Error('pdf: malformed dictionary');
  return `${dict.slice(0, end)}${insertion} ${dict.slice(end)}`;
}

function patchFontDictionaryObject(
  objectNumber: number,
  fontRef: string,
  resourceName: string,
  objects: Map<number, PdfDictionaryObject>,
  replacements: Map<number, ReplacementObject>,
): void {
  const current = replacements.get(objectNumber)?.body ?? objects.get(objectNumber)?.body;
  if (!current) {
    throw new Error(`pdf: missing referenced font resource object ${objectNumber}`);
  }
  if (!current.trim().startsWith('<<')) {
    throw new Error('pdf: indirect Font resource is not a dictionary');
  }
  if (new RegExp(`/${resourceName}\\b`).test(current)) return;

  replacements.set(objectNumber, {
    num: objectNumber,
    gen: objects.get(objectNumber)?.gen ?? 0,
    body: insertBeforeDictionaryClose(current, ` /${resourceName} ${fontRef} `),
  });
}

function patchResourcesDictionary(
  resources: string,
  fontRef: string,
  resourceName: string,
  objects: Map<number, PdfDictionaryObject>,
  replacements: Map<number, ReplacementObject>,
): string {
  if (new RegExp(`/${resourceName}\\b`).test(resources)) return resources;

  const fontMatch = /\/Font\s*/.exec(resources);
  if (!fontMatch) {
    return insertBeforeDictionaryClose(
      resources,
      ` /Font << /${resourceName} ${fontRef} >> `,
    );
  }

  let cursor = fontMatch.index + fontMatch[0].length;
  while (/\s/.test(resources[cursor] ?? '')) cursor++;
  if (resources.slice(cursor, cursor + 2) === '<<') {
    const end = findDictionaryEnd(resources, cursor);
    const fontDictionary = resources.slice(cursor, end);
    const patched = insertBeforeDictionaryClose(
      fontDictionary,
      ` /${resourceName} ${fontRef} `,
    );
    return `${resources.slice(0, cursor)}${patched}${resources.slice(end)}`;
  }

  const reference = /^(\d+)\s+(\d+)\s+R/.exec(resources.slice(cursor));
  if (!reference) throw new Error('pdf: unsupported Font resource shape');
  patchFontDictionaryObject(
    Number(reference[1]),
    fontRef,
    resourceName,
    objects,
    replacements,
  );
  return resources;
}

export function patchPageResources(
  body: string,
  fontRef: string,
  resourceName: string,
  objects: Map<number, PdfDictionaryObject>,
  replacements: Map<number, ReplacementObject>,
): string {
  const match = /\/Resources\s*/.exec(body);
  if (!match) {
    throw new Error(
      'pdf: page inherits or omits Resources; refusing to override inherited resources',
    );
  }

  let cursor = match.index + match[0].length;
  while (/\s/.test(body[cursor] ?? '')) cursor++;
  if (body.slice(cursor, cursor + 2) === '<<') {
    const end = findDictionaryEnd(body, cursor);
    const resources = body.slice(cursor, end);
    const patched = patchResourcesDictionary(
      resources,
      fontRef,
      resourceName,
      objects,
      replacements,
    );
    return `${body.slice(0, cursor)}${patched}${body.slice(end)}`;
  }

  const reference = /^(\d+)\s+(\d+)\s+R/.exec(body.slice(cursor));
  if (!reference) throw new Error('pdf: unsupported Resources shape');
  const objectNumber = Number(reference[1]);
  const current = replacements.get(objectNumber)?.body ?? objects.get(objectNumber)?.body;
  if (!current) throw new Error(`pdf: missing Resources object ${objectNumber}`);

  const patched = patchResourcesDictionary(
    current,
    fontRef,
    resourceName,
    objects,
    replacements,
  );
  replacements.set(objectNumber, {
    num: objectNumber,
    gen: objects.get(objectNumber)?.gen ?? Number(reference[2]),
    body: patched,
  });
  return body;
}

export function patchPageContents(body: string, contentRef: string): string {
  const direct = /\/Contents\s+(\d+)\s+(\d+)\s+R/.exec(body);
  if (direct) {
    return (
      body.slice(0, direct.index) +
      `/Contents [${direct[1]} ${direct[2]} R ${contentRef}]` +
      body.slice(direct.index + direct[0].length)
    );
  }

  const array = /\/Contents\s*\[([^\]]*)\]/.exec(body);
  if (array) {
    const patched = `/Contents [${array[1].trim()} ${contentRef}]`;
    return body.slice(0, array.index) + patched + body.slice(array.index + array[0].length);
  }

  throw new Error('pdf: page Contents shape is outside the safe marking envelope');
}

export function utf16beHex(ch: string): string {
  const littleEndian = Buffer.from(ch, 'utf16le');
  const bigEndian = Buffer.alloc(littleEndian.length);
  for (let i = 0; i < littleEndian.length; i += 2) {
    bigEndian[i] = littleEndian[i + 1];
    bigEndian[i + 1] = littleEndian[i];
  }
  return bigEndian.toString('hex');
}

export function bfcharBlocks(mappings: string[]): string {
  const blocks: string[] = [];
  for (let start = 0; start < mappings.length; start += 100) {
    const chunk = mappings.slice(start, start + 100);
    blocks.push(`${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`);
  }
  return blocks.join('\n');
}

export function streamObject(dict: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${dict}\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

export function streamBody(dict: string, data: Buffer): string {
  return streamObject(dict, data).toString('latin1');
}

export function groupContiguous(entries: XrefEntry[]): XrefEntry[][] {
  const groups: XrefEntry[][] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last && last.at(-1)!.num + 1 === entry.num) last.push(entry);
    else groups.push([entry]);
  }
  return groups;
}
