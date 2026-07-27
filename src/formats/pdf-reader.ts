/**
 * PDF text extraction for the conservative stream subset used by Mattermark.
 * Hidden Mattermark carrier streams are deliberately separated from ordinary
 * visible text so marking does not alter the existing text-layer result.
 */

import { inflateSync } from 'node:zlib';

interface RawObject {
  num: number;
  gen: number;
  bodyStart: number;
  endObj: number;
  dictStart: number;
  dictEnd: number;
  body: string;
  stream: Buffer | null;
}

interface PdfStringLiteral {
  hex: boolean;
  body: string;
}


/** Index top-level `N G obj ... endobj` objects. Later revisions win by number. */
function parseObjects(buf: Buffer): Map<number, RawObject> {
  const text = buf.toString('latin1');
  const objects = new Map<number, RawObject>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text))) {
    const num = Number(match[1]);
    const gen = Number(match[2]);
    const bodyStart = match.index + match[0].length;
    const endObj = text.indexOf('endobj', bodyStart);
    if (endObj < 0) continue;

    let stream: Buffer | null = null;
    const streamKeyword = text.indexOf('stream', bodyStart);
    if (streamKeyword >= 0 && streamKeyword < endObj) {
      let dataStart = streamKeyword + 'stream'.length;
      if (text[dataStart] === '\r') dataStart++;
      if (text[dataStart] === '\n') dataStart++;

      const lengthMatch = /\/Length\s+(\d+)\b/.exec(
        text.slice(bodyStart, streamKeyword),
      );
      if (lengthMatch) {
        stream = buf.subarray(dataStart, dataStart + Number(lengthMatch[1]));
      } else {
        const dataEnd = text.indexOf('endstream', dataStart);
        if (dataEnd >= 0) {
          let end = dataEnd;
          if (text[end - 1] === '\n') end--;
          if (text[end - 1] === '\r') end--;
          stream = buf.subarray(dataStart, end);
        }
      }
    }

    const dictEnd =
      streamKeyword >= 0 && streamKeyword < endObj ? streamKeyword : endObj;
    objects.set(num, {
      num,
      gen,
      bodyStart,
      endObj,
      dictStart: bodyStart,
      dictEnd,
      body: text.slice(bodyStart, endObj).trim(),
      stream,
    });
    re.lastIndex = endObj + 'endobj'.length;
  }

  return objects;
}

function dictText(buf: Buffer, object: RawObject): string {
  return buf.toString('latin1', object.dictStart, object.dictEnd);
}

function decodeStream(dict: string, stream: Buffer): Buffer {
  if (/\/Filter\s*\/FlateDecode/.test(dict)) return inflateSync(stream);
  if (/\/Filter\b/.test(dict)) {
    throw new Error('pdf: unsupported content-stream filter');
  }
  return stream;
}

/** Parse a ToUnicode CMap (bfchar + simple bfrange) into code -> Unicode. */
function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const hexToString = (hex: string): string => {
    const clean = hex.replace(/\s+/g, '');
    const bytes = Buffer.from(clean, 'hex');
    if (bytes.length % 2 !== 0) return '';
    const swapped = Buffer.alloc(bytes.length);
    for (let i = 0; i < bytes.length; i += 2) {
      swapped[i] = bytes[i + 1];
      swapped[i + 1] = bytes[i];
    }
    return swapped.toString('utf16le');
  };

  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const entry of block[1].matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g,
    )) {
      map.set(parseInt(entry[1], 16), hexToString(entry[2]));
    }
  }

  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const entry of block[1].matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g,
    )) {
      const low = parseInt(entry[1], 16);
      const high = parseInt(entry[2], 16);
      let destination = parseInt(entry[3], 16);
      for (let code = low; code <= high; code++) {
        map.set(code, String.fromCharCode(destination++));
      }
    }
  }

  return map;
}

/** Merge ordinary ToUnicode CMaps, excluding Mattermark's hidden carrier. */
function globalToUnicode(
  buf: Buffer,
  objects: Map<number, RawObject>,
): Map<number, string> {
  const merged = new Map<number, string>();
  for (const object of objects.values()) {
    if (!object.stream) continue;
    const dict = dictText(buf, object);
    if (/\/MattermarkCarrier\s+true\b/.test(dict)) continue;

    let data: Buffer;
    try {
      data = decodeStream(dict, object.stream);
    } catch {
      continue;
    }
    const text = data.toString('latin1');
    if (text.includes('beginbfchar') || text.includes('beginbfrange')) {
      for (const [code, value] of parseToUnicode(text)) merged.set(code, value);
    }
  }
  return merged;
}

/** Pull string literals from Tj/TJ content, in stream order. */
function contentStrings(content: string): PdfStringLiteral[] {
  const output: PdfStringLiteral[] = [];
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '(') {
      let depth = 1;
      let cursor = i + 1;
      let body = '';
      while (cursor < content.length && depth > 0) {
        const current = content[cursor];
        if (current === '\\') {
          body += current + (content[cursor + 1] ?? '');
          cursor += 2;
          continue;
        }
        if (current === '(') depth++;
        else if (current === ')') {
          depth--;
          if (depth === 0) break;
        }
        body += current;
        cursor++;
      }
      output.push({ hex: false, body });
      i = cursor;
    } else if (ch === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i);
      if (end < 0) break;
      output.push({ hex: true, body: content.slice(i + 1, end) });
      i = end;
    } else if (ch === '<' && content[i + 1] === '<') {
      i++;
    }
  }
  return output;
}

function decodeString(
  literal: PdfStringLiteral,
  toUnicode: Map<number, string>,
): string {
  const codes: number[] = [];
  if (literal.hex) {
    const clean = literal.body.replace(/\s+/g, '');
    for (let i = 0; i + 2 <= clean.length; i += 2) {
      codes.push(parseInt(clean.slice(i, i + 2), 16));
    }
  } else {
    for (let i = 0; i < literal.body.length; i++) {
      const ch = literal.body[i];
      if (ch === '\\') {
        const next = literal.body[i + 1];
        if (next >= '0' && next <= '7') {
          let octal = next;
          let cursor = i + 2;
          while (
            cursor < literal.body.length &&
            octal.length < 3 &&
            literal.body[cursor] >= '0' &&
            literal.body[cursor] <= '7'
          ) {
            octal += literal.body[cursor++];
          }
          codes.push(parseInt(octal, 8));
          i = cursor - 1;
        } else {
          const escapes: Record<string, number> = {
            n: 10,
            r: 13,
            t: 9,
            b: 8,
            f: 12,
          };
          codes.push(escapes[next] ?? next.charCodeAt(0));
          i++;
        }
      } else {
        codes.push(ch.charCodeAt(0));
      }
    }
  }
  return codes.map((code) => toUnicode.get(code) ?? String.fromCharCode(code)).join('');
}

/** Extract ordinary PDF text while deliberately excluding Mattermark carriers. */
export function extractPdfText(bytes: Buffer): string {
  const objects = parseObjects(bytes);
  if (objects.size === 0) {
    throw new Error('pdf: no objects found (encrypted or object-stream PDF?)');
  }
  const toUnicode = globalToUnicode(bytes, objects);

  let output = '';
  for (const object of objects.values()) {
    if (!object.stream) continue;
    const dict = dictText(bytes, object);
    if (/\/MattermarkCarrier\s+true\b/.test(dict)) continue;

    let data: Buffer;
    try {
      data = decodeStream(dict, object.stream);
    } catch {
      continue;
    }
    const text = data.toString('latin1');
    if (text.includes('beginbfchar') || text.includes('beginbfrange')) continue;
    if (!/\bTj\b|\bTJ\b/.test(text)) continue;
    for (const literal of contentStrings(text)) {
      output += decodeString(literal, toUnicode);
    }
  }
  return output;
}

/** Extract only Mattermark's hidden carrier text. */
export function extractMattermarkPdfCarrier(bytes: Buffer): string {
  const objects = parseObjects(bytes);
  const toUnicode = new Map<number, string>();

  for (const object of objects.values()) {
    if (!object.stream) continue;
    const dict = dictText(bytes, object);
    if (!/\/MattermarkCarrier\s+true\b/.test(dict)) continue;

    let data: Buffer;
    try {
      data = decodeStream(dict, object.stream);
    } catch {
      continue;
    }
    const text = data.toString('latin1');
    if (text.includes('beginbfchar') || text.includes('beginbfrange')) {
      for (const [code, value] of parseToUnicode(text)) toUnicode.set(code, value);
    }
  }

  let output = '';
  for (const object of objects.values()) {
    if (!object.stream) continue;
    const dict = dictText(bytes, object);
    if (!/\/MattermarkCarrier\s+true\b/.test(dict)) continue;

    let data: Buffer;
    try {
      data = decodeStream(dict, object.stream);
    } catch {
      continue;
    }
    const text = data.toString('latin1');
    if (!/\bTj\b|\bTJ\b/.test(text)) continue;
    for (const literal of contentStrings(text)) {
      output += decodeString(literal, toUnicode);
    }
  }
  return output;
}
