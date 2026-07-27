import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import {
  appendMattermarkPdfCarrier,
  buildTextPdf,
  detectPdf,
  extractMattermarkPdfCarrier,
  extractPdfText,
  markPdf,
} from '../src/formats/pdf.js';
import { IDENTITY, SAMPLE, edSetup } from './helpers.js';

const cp = (value: number): string => String.fromCodePoint(value);

test('PDF carrier uses an incremental invisible Type 3 layer and preserves visible text', () => {
  const originalText =
    'Privileged legal memorandum. Settlement posture remains confidential.';
  const carrier = `M${cp(0x200b)}a${cp(0x0430)}ttermark hidden carrier with thin${cp(0x2009)}space.`;
  const original = buildTextPdf(originalText);
  const marked = appendMattermarkPdfCarrier(original, carrier);

  assert.equal(marked.pagesMarked, 1);
  assert.ok(
    marked.bytes.subarray(0, original.length).equals(original),
    'an incremental update must preserve every original byte',
  );
  assert.equal(extractPdfText(marked.bytes), originalText);
  assert.equal(extractMattermarkPdfCarrier(marked.bytes), carrier);

  const structure = marked.bytes.toString('latin1');
  assert.match(structure, /\/Prev\s+\d+/);
  assert.match(structure, /\/MattermarkCarrier\s+true/);
  assert.match(structure, /\/Subtype\s*\/Type3/);
});

test('markPdf attributes a PDF without modifying its ordinary visible text layer', () => {
  const { issuer } = edSetup();
  const original = buildTextPdf(SAMPLE);
  const marked = markPdf(original, IDENTITY(), issuer, {
    codecs: ['WS', 'ZW', 'HG'],
  });

  assert.equal(marked.pagesMarked, 1);
  assert.ok(marked.bytes.subarray(0, original.length).equals(original));
  assert.equal(extractPdfText(marked.bytes), SAMPLE);
  assert.notEqual(extractMattermarkPdfCarrier(marked.bytes), '');
  assert.ok(marked.result.durable);
  assert.ok(
    marked.result.warnings.some((warning) =>
      warning.startsWith('PDF STRUCTURE DEPENDENCE:'),
    ),
  );

  const detection = detectPdf(marked.bytes, ['WS', 'ZW', 'HG']);
  assert.ok(
    detection.tokens.some(
      (token) =>
        token.tokenHex === marked.result.tokenHex ||
        token.tokenHex === marked.result.shortIdHex,
    ),
  );
});

test('PDF marking refuses unsupported structures instead of risking corruption', () => {
  const original = buildTextPdf('Safety first.');
  const encryptedLike = Buffer.from(
    original
      .toString('latin1')
      .replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 99 0 R'),
    'latin1',
  );
  assert.throws(
    () => appendMattermarkPdfCarrier(encryptedLike, 'x'),
    /encrypted/i,
  );

  const objectStreamLike = Buffer.from(
    original.toString('latin1').replace('/Type /Catalog', '/Type /ObjStm '),
    'latin1',
  );
  assert.throws(
    () => appendMattermarkPdfCarrier(objectStreamLike, 'x'),
    /object streams/i,
  );

  const raw = original.toString('latin1');
  const resources = '/Resources << /Font << /F1 4 0 R >> >> ';
  assert.ok(raw.includes(resources));
  const inheritedResources = Buffer.from(
    raw.replace(resources, ' '.repeat(resources.length)),
    'latin1',
  );
  assert.throws(
    () => appendMattermarkPdfCarrier(inheritedResources, 'x'),
    /resources/i,
  );
});

test('PDF marking refuses to stack a second hidden carrier', () => {
  const original = buildTextPdf('One carrier only.');
  const first = appendMattermarkPdfCarrier(original, 'first carrier');
  assert.throws(
    () => appendMattermarkPdfCarrier(first.bytes, 'second carrier'),
    /already exists/i,
  );
});


test('PDF marking follows the classic xref table instead of object-like trailing bytes', () => {
  const original = buildTextPdf('Indexed page only.');
  const fakePage = Buffer.from(
    '\n999 0 obj\n<< /Type /Page /Resources << /Font << >> >> /Contents 5 0 R >>\nendobj\n',
    'latin1',
  );
  const withTrailingBytes = Buffer.concat([original, fakePage]);

  const marked = appendMattermarkPdfCarrier(withTrailingBytes, 'xref-bound carrier');
  assert.equal(marked.pagesMarked, 1);
});

test('PDF marking rejects signed or certified documents before invalidating evidence', () => {
  const original = buildTextPdf('Signed legal filing.');
  const certified = Buffer.from(
    original.toString('latin1').replace('/Type /Catalog', '/Type /Sig    '),
    'latin1',
  );

  assert.throws(
    () => appendMattermarkPdfCarrier(certified, 'carrier'),
    /signed|signature|certified/i,
  );
});

test('PDF marking rejects hybrid-reference files with XRefStm', () => {
  const original = buildTextPdf('Hybrid xref fixture.');
  const hybrid = Buffer.from(
    original.toString('latin1').replace('/Root 1 0 R', '/Root 1 0 R /XRefStm 42'),
    'latin1',
  );

  assert.throws(
    () => appendMattermarkPdfCarrier(hybrid, 'carrier'),
    /xref streams|hybrid/i,
  );
});

test('PDF marking chooses a resource name that does not already exist', () => {
  const carrier = 'collision-resistant carrier';
  const suffix = createHash('sha256')
    .update(carrier)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  const first = `MMY${suffix}`;
  const original = buildTextPdf('Resource collision fixture.');
  const occupied = Buffer.concat([
    original,
    Buffer.from(`% /${first} /${first}X\n`, 'latin1'),
  ]);

  const marked = appendMattermarkPdfCarrier(occupied, carrier);
  assert.notEqual(marked.resourceName, first);
  assert.notEqual(marked.resourceName, `${first}X`);
});

test('PDF carrier ToUnicode maps are emitted in at most 100-entry chunks', () => {
  const carrier = Array.from({ length: 150 }, (_, index) =>
    String.fromCodePoint(0x0100 + index),
  ).join('');
  const marked = appendMattermarkPdfCarrier(buildTextPdf('CMap chunking.'), carrier);
  const text = marked.bytes.toString('latin1');
  const counts: number[] = [];

  for (const match of text.matchAll(/<<(.*?)>>\s*stream\r?\n/gms)) {
    if (!/\/MattermarkCarrier\s+true\b/.test(match[1])) continue;
    const length = Number(/\/Length\s+(\d+)/.exec(match[1])?.[1] ?? '0');
    const start = match.index + match[0].length;
    const stream = marked.bytes.subarray(start, start + length);
    let decoded: Buffer;
    try {
      decoded = /\/FlateDecode/.test(match[1]) ? inflateSync(stream) : stream;
    } catch {
      continue;
    }
    for (const count of decoded.toString('latin1').matchAll(/(\d+)\s+beginbfchar/g)) {
      counts.push(Number(count[1]));
    }
  }

  assert.ok(counts.length >= 2, '150 mappings should be split across multiple blocks');
  assert.ok(counts.every((count) => count <= 100));
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 150);
  assert.equal(extractMattermarkPdfCarrier(marked.bytes), carrier);
});
