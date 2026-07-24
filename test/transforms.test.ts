import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T01, T05, T07, T09, CHAINS, applyChain, excerpt } from '../src/transforms.js';
import { mark, detect } from '../src/orchestrator.js';
import { homoglyphCodec } from '../src/codecs/homoglyph.js';
import { SAMPLE, IDENTITY, hmacSetup } from './helpers.js';

const cp = (n: number) => String.fromCodePoint(n);

test('T01 normalizes CRLF and CR to LF', () => {
  assert.equal(T01.apply('a\r\nb\rc'), 'a\nb\nc');
});

test('T05 (NFKC) folds a compatibility space toward U+0020', () => {
  const fourPerEm = cp(0x2004); // four-per-em space, NFKC-equivalent to U+0020
  assert.equal(fourPerEm.normalize('NFKC'), ' ');
  assert.equal(T05.apply('a' + fourPerEm + 'b'), 'a b');
});

test('T07 strips format characters (kills the ZW channel)', () => {
  const zw = cp(0x200b) + cp(0x2060); // ZWSP + WORD JOINER, both category Cf
  assert.equal(T07.apply('a' + zw + 'bc'), 'abc');
});

test('T09 folds confusables (kills the HG channel)', () => {
  const digits = new Array(homoglyphCodec.capacityDigits(SAMPLE)).fill(1);
  const marked = homoglyphCodec.encode(SAMPLE, digits) as string;
  assert.equal(T09.apply(marked), SAMPLE);
});

test('excerpt returns a contiguous middle slice of the requested fraction', () => {
  const s = 'abcdefghij'.repeat(10); // 100 chars
  const piece = excerpt(s, 0.5);
  assert.equal([...piece].length, 50);
  assert.ok(s.includes(piece)); // contiguous
});

test('a WS+ZW+HG mark survives Tier-1 handling but not Tier-3 stripping', () => {
  const { issuer, reg } = hmacSetup();
  const m = mark(SAMPLE, IDENTITY(), issuer, { codecs: ['WS', 'ZW', 'HG'] });
  reg.add(m.tokenHex);

  const tier1 = CHAINS.find((c) => c.name === 'Tier-1')!;
  const tier3 = CHAINS.find((c) => c.name === 'Tier-3')!;

  const afterT1 = detect(applyChain(tier1, m.text), ['WS', 'ZW', 'HG']);
  assert.ok(afterT1.tokens.some((t) => t.tokenHex === m.tokenHex || t.tokenHex === m.shortIdHex));

  const afterT3 = detect(applyChain(tier3, m.text), ['WS', 'ZW', 'HG']);
  assert.ok(!afterT3.tokens.some((t) => t.tokenHex === m.tokenHex || t.tokenHex === m.shortIdHex));
});
