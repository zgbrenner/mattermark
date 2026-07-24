import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractText,
  reinjectText,
  buildDocumentXml,
  containsZeroWidth,
  isTextPart,
  sortTextParts,
} from '../src/formats/docx.js';
import { textToDocx, markDocx, detectDocx, readDocxText } from '../src/formats/index.js';
import { readZip, writeZip } from '../src/formats/zip.js';
import { foldConfusables } from '../src/codecs/homoglyph.js';
import { SAMPLE, IDENTITY, hmacSetup, edSetup } from './helpers.js';

const cp = (n: number) => String.fromCodePoint(n);
const ZWSP = cp(0x200b);

test('extractText concatenates run text in order and decodes entities', () => {
  const xml = buildDocumentXml([['Smith ', '& Co ', '<draft>'], 'second para']);
  assert.equal(extractText(xml), 'Smith & Co <draft>second para');
});

test('extractText ignores non-w:t tags like w:tab and w:tbl', () => {
  const xml = '<w:p><w:r><w:tab/><w:t>hi</w:t></w:r></w:p><w:tbl><w:tr/></w:tbl>';
  assert.equal(extractText(xml), 'hi');
});

test('reinjectText is lossless, including inserted zero-width markers', () => {
  const xml = buildDocumentXml([['abcde', 'fghij']]); // two runs, lengths 5 and 5
  const marked = 'ab' + ZWSP + 'cdef' + ZWSP + 'ghij'; // ZW inserted mid-run
  const out = reinjectText(xml, marked);
  assert.equal(extractText(out), marked); // every character preserved, in order
  assert.equal((out.match(/<w:t /g) || []).length, 2); // run count unchanged
  assert.match(out, /xml:space="preserve"/); // spaces protected
});

test('reinjectText re-escapes XML metacharacters', () => {
  const xml = buildDocumentXml(['x']);
  const out = reinjectText(xml, 'a & b < c > d');
  assert.match(out, /a &amp; b &lt; c &gt; d/);
  assert.equal(extractText(out), 'a & b < c > d'); // round-trips back
});

test('containsZeroWidth detects the insertion alphabet', () => {
  assert.equal(containsZeroWidth('clean ascii'), false);
  assert.equal(containsZeroWidth('sneaky' + ZWSP + 'text'), true);
});

test('textToDocx builds a valid 3-part DOCX that extracts back to its text', () => {
  const docx = textToDocx('line one\nline two');
  const parts = readZip(docx).map((e) => e.name);
  assert.deepEqual(parts, ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
  assert.equal(readDocxText(docx), 'line oneline two'); // paragraphs concatenate
});

for (const setup of [hmacSetup, edSetup]) {
  test(`markDocx -> detectDocx round-trips (${setup.name})`, () => {
    const { issuer } = setup();
    const docx = textToDocx(SAMPLE);
    const { bytes, result } = markDocx(docx, IDENTITY(), issuer, { codecs: ['WS', 'ZW', 'HG'] });
    assert.equal(result.durable, true);
    const det = detectDocx(bytes, ['WS', 'ZW', 'HG']);
    assert.ok(det.tokens.some((t) => t.tokenHex === result.tokenHex || t.tokenHex === result.shortIdHex));
  });
}

test('markDocx changes only word/document.xml', () => {
  const { issuer } = hmacSetup();
  const docx = textToDocx(SAMPLE);
  const { bytes } = markDocx(docx, IDENTITY(), issuer, { codecs: ['WS', 'ZW', 'HG'] });
  const before = readZip(docx);
  const after = readZip(bytes);
  for (const b of before) {
    const a = after.find((e) => e.name === b.name)!;
    if (b.name === 'word/document.xml') assert.ok(!a.data.equals(b.data), 'document changed');
    else assert.ok(a.data.equals(b.data), `${b.name} byte-identical`);
  }
});

test('a mark survives a word split across two runs', () => {
  const { issuer } = hmacSetup();
  // same visible text as SAMPLE, but every run is chopped so words straddle runs
  const chunks: string[] = [];
  for (let i = 0; i < SAMPLE.length; i += 7) chunks.push(SAMPLE.slice(i, i + 7));
  const xml = buildDocumentXml([chunks]);
  const docx = writeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'word/document.xml', data: Buffer.from(xml, 'utf8') },
  ]);
  const { bytes, result } = markDocx(docx, IDENTITY(), issuer, { codecs: ['WS', 'ZW', 'HG'] });
  const det = detectDocx(bytes, ['WS', 'ZW', 'HG']);
  assert.ok(det.tokens.some((t) => t.tokenHex === result.tokenHex || t.tokenHex === result.shortIdHex));
});

test('search-safe DOCX makes zero homoglyph substitutions', () => {
  const { issuer } = hmacSetup();
  const docx = textToDocx(SAMPLE);
  const { bytes, result } = markDocx(docx, IDENTITY(), issuer, {
    codecs: ['WS', 'ZW'],
    allowNonDurable: true,
  });
  assert.equal(result.durable, false);
  const text = readDocxText(bytes);
  assert.equal(foldConfusables(text), text); // letters intact
});

/* ------------------------- multi-part documents -------------------------- */

test('isTextPart recognises body, footnotes, headers, footers, comments', () => {
  for (const n of ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml',
    'word/header1.xml', 'word/footer2.xml', 'word/comments.xml']) {
    assert.equal(isTextPart(n), true, n);
  }
  for (const n of ['word/styles.xml', 'word/settings.xml', '[Content_Types].xml', 'word/media/x.png']) {
    assert.equal(isTextPart(n), false, n);
  }
});

test('sortTextParts is deterministic', () => {
  const a = sortTextParts([{ name: 'word/header1.xml' }, { name: 'word/document.xml' }]);
  const b = sortTextParts([{ name: 'word/document.xml' }, { name: 'word/header1.xml' }]);
  assert.deepEqual(a.map((x) => x.name), b.map((x) => x.name));
});

function multiPartDocx(): Buffer {
  const half = Math.ceil(SAMPLE.length / 2);
  return writeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'word/document.xml', data: Buffer.from(buildDocumentXml([SAMPLE.slice(0, half)]), 'utf8') },
    { name: 'word/footnotes.xml', data: Buffer.from(buildDocumentXml([SAMPLE.slice(half)]), 'utf8') },
    { name: 'word/header1.xml', data: Buffer.from(buildDocumentXml(['CONFIDENTIAL - ATTORNEY WORK PRODUCT']), 'utf8') },
  ]);
}

test('marking spans all text-bearing parts and detection recovers the token', () => {
  const { issuer } = hmacSetup();
  const docx = multiPartDocx();
  const { bytes, result, markedParts } = markDocx(docx, IDENTITY(), issuer, { codecs: ['WS', 'ZW', 'HG'] });
  assert.deepEqual(markedParts, ['word/document.xml', 'word/footnotes.xml', 'word/header1.xml']);

  const before = readZip(docx);
  const after = readZip(bytes);
  for (const name of markedParts) {
    const b = before.find((e) => e.name === name)!;
    const a = after.find((e) => e.name === name)!;
    assert.ok(!a.data.equals(b.data), `${name} changed`);
  }
  // Content_Types (not a text part) is untouched.
  assert.ok(
    after.find((e) => e.name === '[Content_Types].xml')!.data.equals(
      before.find((e) => e.name === '[Content_Types].xml')!.data,
    ),
  );

  const det = detectDocx(bytes, ['WS', 'ZW', 'HG']);
  assert.ok(det.tokens.some((t) => t.tokenHex === result.tokenHex || t.tokenHex === result.shortIdHex));
});

test('readDocxText concatenates all text parts in canonical order', () => {
  const docx = multiPartDocx();
  const half = Math.ceil(SAMPLE.length / 2);
  // canonical order is by name: document, footnotes, header1
  const expected = SAMPLE.slice(0, half) + SAMPLE.slice(half) + 'CONFIDENTIAL - ATTORNEY WORK PRODUCT';
  assert.equal(readDocxText(docx), expected);
});
