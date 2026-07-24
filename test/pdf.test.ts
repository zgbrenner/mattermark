import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTextPdf, extractPdfText, detectPdf } from '../src/formats/pdf.js';
import { mark } from '../src/orchestrator.js';
import { foldConfusables } from '../src/codecs/homoglyph.js';
import { SAMPLE, IDENTITY, hmacSetup, edSetup } from './helpers.js';

const cp = (n: number) => String.fromCodePoint(n);

test('text round-trips exactly through a generated PDF', () => {
  const text = 'The quick brown fox. Section 12(b)(6); Smith & Co. "quoted" 100%.';
  const pdf = buildTextPdf(text);
  assert.ok(pdf.subarray(0, 5).toString() === '%PDF-'); // it is a PDF
  assert.equal(extractPdfText(pdf), text);
});

test('the ToUnicode layer carries non-ASCII (homoglyphs) faithfully', () => {
  const text = 'm' + cp(0x0430) + 'tter'; // Latin m, Cyrillic a, then Latin
  const extracted = extractPdfText(buildTextPdf(text));
  assert.equal(extracted, text);
  assert.notEqual(foldConfusables(extracted), extracted); // the confusable survived extraction
});

for (const setup of [hmacSetup, edSetup]) {
  test(`a marked document rendered to a PDF text layer is attributable (${setup.name})`, () => {
    const { issuer } = setup();
    const res = mark(SAMPLE, IDENTITY(), issuer, { codecs: ['WS', 'ZW', 'HG'] });
    const pdf = buildTextPdf(res.text);
    assert.equal(extractPdfText(pdf), res.text); // marked text preserved in the text layer
    const det = detectPdf(pdf, ['WS', 'ZW', 'HG']);
    assert.ok(det.tokens.some((t) => t.tokenHex === res.tokenHex || t.tokenHex === res.shortIdHex));
  });
}

test('extractPdfText reports rather than mangles a non-PDF input', () => {
  assert.throws(() => extractPdfText(Buffer.from('this is not a pdf')), /no objects/);
});

test('buildTextPdf refuses inputs beyond the single-byte demo font', () => {
  const tooManyDistinct = Array.from({ length: 300 }, (_, i) => cp(0x4e00 + i)).join('');
  assert.throws(() => buildTextPdf(tooManyDistinct), /distinct characters/);
});
