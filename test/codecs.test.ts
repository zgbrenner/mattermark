import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whitespaceCodec } from '../src/codecs/whitespace.js';
import { zeroWidthCodec } from '../src/codecs/zerowidth.js';
import { homoglyphCodec, foldConfusables } from '../src/codecs/homoglyph.js';
import { SAMPLE } from './helpers.js';

const substitutive = [whitespaceCodec, homoglyphCodec];
const additive = [zeroWidthCodec];

// Zero-width alphabet codepoints, referenced numerically so this source file
// stays pure ASCII.
const ZW_CODEPOINTS = new Set([0x200b, 0x200c, 0x200d, 0x2060]);
const stripZeroWidth = (s: string) =>
  [...s].filter((ch) => !ZW_CODEPOINTS.has(ch.codePointAt(0) as number)).join('');

for (const codec of [whitespaceCodec, zeroWidthCodec, homoglyphCodec]) {
  test(`${codec.id}: encode then decode recovers the embedded digit stream`, () => {
    const cap = codec.capacityDigits(SAMPLE);
    assert.ok(cap > 8, `${codec.id} should have capacity in SAMPLE`);
    const digits = Array.from({ length: 8 }, (_, i) => i % codec.base);
    const marked = codec.encode(SAMPLE, digits);
    assert.ok(marked !== null);
    const decoded = codec.decode(marked as string);
    assert.deepEqual(decoded.slice(0, digits.length), digits);
  });

  test(`${codec.id}: encode returns null when digits exceed capacity`, () => {
    const cap = codec.capacityDigits(SAMPLE);
    const tooMany = new Array(cap + 1).fill(1);
    assert.equal(codec.encode(SAMPLE, tooMany), null);
  });
}

test('codec surfaces are disjoint (Rule 1 depends on this)', () => {
  const surfaces = [whitespaceCodec.surface, zeroWidthCodec.surface, homoglyphCodec.surface];
  assert.equal(new Set(surfaces).size, surfaces.length);
});

test('additive vs substitutive flags are correct', () => {
  for (const c of additive) assert.equal(c.additive, true);
  for (const c of substitutive) assert.equal(c.additive, false);
});

test('HG substitution is invisible-length and foldConfusables inverts it', () => {
  const digits = new Array(homoglyphCodec.capacityDigits(SAMPLE)).fill(1); // all-ones: max substitution
  const marked = homoglyphCodec.encode(SAMPLE, digits) as string;
  assert.notEqual(marked, SAMPLE); // glyphs were substituted
  assert.equal([...marked].length, [...SAMPLE].length); // 1:1 substitution, no length change
  assert.equal(foldConfusables(marked), SAMPLE); // folding restores the original letters
});

test('ZW insertion adds characters but preserves the visible text', () => {
  const marked = zeroWidthCodec.encode(SAMPLE, [1, 2, 3, 0, 1]) as string;
  assert.ok([...marked].length > [...SAMPLE].length); // additive
  assert.equal(stripZeroWidth(marked), SAMPLE);
});
