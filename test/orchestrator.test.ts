import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mark, detect, assertComposable, CompositionError, CODECS } from '../src/orchestrator.js';
import { foldConfusables } from '../src/codecs/homoglyph.js';
import type { StegoCodec } from '../src/codecs/types.js';
import { SAMPLE, IDENTITY, hmacSetup, edSetup } from './helpers.js';

const fakeLM: StegoCodec = {
  id: 'LM',
  name: 'fake linguistic',
  surface: 'token-sequence',
  base: 2,
  additive: true,
  capacityDigits: () => 0,
  encode: () => null,
  decode: () => [],
};

test('assertComposable rejects duplicate codecs', () => {
  assert.throws(() => assertComposable([CODECS.WS, CODECS.WS]), CompositionError);
});

test('assertComposable rejects two codecs on the same surface (Rule 1)', () => {
  const dupSurface: StegoCodec = { ...CODECS.ZW, surface: CODECS.WS.surface };
  assert.throws(() => assertComposable([CODECS.WS, dupSurface]), /surface/);
});

test('assertComposable rejects WS beneath LM (Rule 2)', () => {
  assert.throws(() => assertComposable([CODECS.WS, fakeLM]), /WS cannot be stacked with LM/);
});

test('assertComposable rejects a stack with no Tier-2 survivor (Rule 3)', () => {
  assert.throws(() => assertComposable([CODECS.WS, CODECS.ZW]), /Tier-2/);
});

test('assertComposable accepts a non-durable stack when explicitly allowed', () => {
  assert.doesNotThrow(() => assertComposable([CODECS.WS, CODECS.ZW], { allowNonDurable: true }));
});

test('mark then detect round-trips and attributes (HMAC)', () => {
  const { reg, issuer } = hmacSetup();
  const m = mark(SAMPLE, IDENTITY(), issuer, { codecs: ['WS', 'ZW', 'HG'] });
  reg.add(m.tokenHex);
  assert.equal(m.durable, true);
  const det = detect(m.text, ['WS', 'ZW', 'HG']);
  assert.ok(det.tokens.some((t) => t.tokenHex === m.tokenHex || t.tokenHex === m.shortIdHex));
});

test('mark then detect round-trips and self-verifies (Ed25519)', () => {
  const { issuer, kp } = edSetup();
  const m = mark(SAMPLE, IDENTITY(), issuer, { codecs: ['WS', 'ZW', 'HG'] });
  const det = detect(m.text, ['WS', 'ZW', 'HG']);
  const hit = det.tokens.find((t) => t.tokenHex === m.tokenHex);
  assert.ok(hit, 'full token recovered');
  assert.ok(issuer.verify(Buffer.from(hit!.tokenHex, 'hex')));
  assert.ok(kp.publicKey); // keypair present
});

test('default stack is WS+ZW+HG and carries the homoglyph search warning', () => {
  const { issuer } = hmacSetup();
  const m = mark(SAMPLE, IDENTITY(), issuer);
  assert.equal(m.durable, true);
  const w = m.warnings.join(' ');
  assert.match(w, /HOMOGLYPH CHANNEL ACTIVE/);
  assert.match(w, /DISQUALIFYING/);
  assert.notEqual(foldConfusables(m.text), m.text); // HG actually substituted
});

test('search-safe WS+ZW mark is non-durable, warns, and makes zero HG substitutions', () => {
  const { issuer } = hmacSetup();
  const m = mark(SAMPLE, IDENTITY(), issuer, { codecs: ['WS', 'ZW'], allowNonDurable: true });
  assert.equal(m.durable, false);
  assert.match(m.warnings.join(' '), /NON-DURABLE/);
  assert.equal(foldConfusables(m.text), m.text); // no letter corruption -> search preserved
});

test('WS+ZW without allowNonDurable is rejected', () => {
  const { issuer } = hmacSetup();
  assert.throws(() => mark(SAMPLE, IDENTITY(), issuer, { codecs: ['WS', 'ZW'] }), CompositionError);
});

test('maxHomoglyphDensity 0 disables HG substitution and yields a non-durable mark', () => {
  const { issuer } = hmacSetup();
  const m = mark(SAMPLE, IDENTITY(), issuer, { maxHomoglyphDensity: 0 });
  const hg = m.layers.find((l) => l.codec === 'HG');
  assert.equal(hg?.embedded, false);
  assert.equal(m.durable, false);
  assert.equal(foldConfusables(m.text), m.text);
});

test('detect on unmarked text recovers nothing', () => {
  assert.equal(detect(SAMPLE, ['WS', 'ZW', 'HG']).anyRecovered, false);
});
