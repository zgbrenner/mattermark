import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markPdf, detectPdf } from '../src/formats/pdf-mark.js';
import { buildTextPdf, extractPdfText } from '../src/formats/pdf.js';
import { foldConfusables } from '../src/codecs/homoglyph.js';
import { SAMPLE, IDENTITY, hmacSetup, edSetup } from './helpers.js';

/** A structurally valid PDF that parses but carries no text-showing content:
 *  one classic object, no content stream, no Tj/TJ. In envelope for the parser
 *  (objects found) but out of envelope for marking (nothing to mark). */
function noTextLayerPdf(): Buffer {
  return Buffer.from('%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'latin1');
}

for (const setup of [hmacSetup, edSetup]) {
  test(`markPdf round-trips and the token attributes back (${setup.name})`, () => {
    const s = setup();
    const src = buildTextPdf(SAMPLE);
    const { bytes, result, markedText } = markPdf(src, IDENTITY(), s.issuer);

    // The rebuilt text layer is exactly the marked text.
    assert.equal(extractPdfText(bytes), markedText);
    assert.equal(markedText, result.text);

    // The full minted token is recovered from the rebuilt PDF...
    const det = detectPdf(bytes, ['WS', 'ZW']);
    const hit = det.tokens.find((t) => t.tokenHex === result.tokenHex);
    assert.ok(hit, 'full token recovered from the marked PDF');

    // ...and attributes back through the issuer (register for HMAC, which is
    // unforgeable but not self-verifying; Ed25519 verifies directly).
    if ('reg' in s) s.reg.add(result.tokenHex);
    assert.ok(s.issuer.verify(new Uint8Array(Buffer.from(result.tokenHex, 'hex'))));
  });
}

test('markPdf reports the normalized-layer and non-durable trade-offs honestly', () => {
  const { issuer } = hmacSetup();
  const { result } = markPdf(buildTextPdf(SAMPLE), IDENTITY(), issuer);

  // WS+ZW carry no Tier-2-surviving layer: this is non-durable by construction.
  assert.equal(result.durable, false);
  assert.ok(
    result.warnings.some((w) => /NORMALIZED TEXT-LAYER/.test(w)),
    'discloses that the output is a rebuilt text layer, not a faithful re-render',
  );
  assert.ok(
    result.warnings.some((w) => /NON-DURABLE/.test(w)),
    'discloses that the mark is Tier-1 only',
  );
});

test('markPdf embeds no homoglyphs and makes no false durability claim', () => {
  const { issuer } = hmacSetup();
  const { result, markedText } = markPdf(buildTextPdf(SAMPLE), IDENTITY(), issuer);

  // No HG layer in the stack, and the letters are untouched (search-preserving).
  assert.ok(!result.layers.some((l) => l.codec === 'HG'));
  assert.equal(foldConfusables(markedText), markedText);
});

test('markPdf refuses HG (and LM): cannot render confusables in the rebuilt font', () => {
  const { issuer } = hmacSetup();
  const src = buildTextPdf(SAMPLE);
  assert.throws(
    () => markPdf(src, IDENTITY(), issuer, { codecs: ['WS', 'ZW', 'HG'] }),
    /HG is not supported for PDF/,
  );
  assert.throws(
    () => markPdf(src, IDENTITY(), issuer, { codecs: ['WS', 'LM'] }),
    /LM is not supported for PDF/,
  );
});

test('scope guard: a non-PDF buffer is reported, not marked', () => {
  const { issuer } = hmacSetup();
  assert.throws(
    () => markPdf(Buffer.from('this is not a pdf'), IDENTITY(), issuer),
    /not a PDF/,
  );
});

test('scope guard: an in-envelope PDF with no text layer is reported, not marked', () => {
  const { issuer } = hmacSetup();
  assert.throws(
    () => markPdf(noTextLayerPdf(), IDENTITY(), issuer),
    /no extractable text layer/,
  );
});

test('scope guard: an encrypted / object-stream PDF surfaces the extractor error', () => {
  const { issuer } = hmacSetup();
  // %PDF header present but no classic `N G obj` objects: same shape the parser
  // reports for full-compression / encrypted PDFs it cannot open.
  const opaque = Buffer.from('%PDF-1.7\n<< binary object streams only >>\n%%EOF', 'latin1');
  assert.throws(() => markPdf(opaque, IDENTITY(), issuer), /no objects/);
});
