import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFrame,
  scanFrames,
  bytesToDigits,
  digitsToBytes,
  framesFromDigits,
  repeatFrameToDigits,
  digitsPerByte,
  HEADER_BYTES,
  MAGIC,
  Scheme,
} from '../src/frame.js';

test('buildFrame lays out magic, version, scheme, length, token', () => {
  const token = Uint8Array.from([9, 8, 7]);
  const f = buildFrame(token, Scheme.ED25519);
  assert.equal(f.length, HEADER_BYTES + 3);
  assert.equal(f[0], MAGIC[0]);
  assert.equal(f[1], MAGIC[1]);
  assert.equal(f[3], Scheme.ED25519);
  assert.equal((f[4] << 8) | f[5], 3);
  assert.deepEqual([...f.slice(HEADER_BYTES)], [9, 8, 7]);
});

test('scanFrames finds a frame embedded in surrounding noise', () => {
  const token = Uint8Array.from([1, 2, 3, 4, 5]);
  const frame = buildFrame(token, Scheme.HMAC_SHA256);
  const buf = new Uint8Array([0x11, 0x22, ...frame, 0x33, 0x44]);
  const found = scanFrames(buf);
  assert.equal(found.length, 1);
  assert.equal(found[0].scheme, Scheme.HMAC_SHA256);
  assert.deepEqual([...found[0].token], [1, 2, 3, 4, 5]);
});

test('scanFrames rejects unknown scheme and zero length', () => {
  const bad = buildFrame(Uint8Array.from([1]), 0x7f as Scheme);
  assert.equal(scanFrames(bad).length, 0);
});

for (const base of [2, 4]) {
  test(`bytesToDigits/digitsToBytes round-trip at base ${base}`, () => {
    const bytes = Uint8Array.from([0x00, 0x5a, 0xff, 0xa5, 0x01]);
    const digits = bytesToDigits(bytes, base);
    assert.equal(digits.length, bytes.length * digitsPerByte(base));
    assert.deepEqual([...digitsToBytes(digits, base)], [...bytes]);
  });
}

test('framesFromDigits recovers a frame despite a non-byte-aligned slice', () => {
  const token = Uint8Array.from([7, 7, 7, 7]);
  const frame = buildFrame(token, Scheme.SHORT_ID);
  const digits = bytesToDigits(frame, 2);
  // prepend two stray digits so byte boundaries no longer align
  const misaligned = [1, 0, ...digits, 1, 1];
  const found = framesFromDigits(misaligned, 2);
  assert.ok(found.some((f) => [...f.token].join(',') === '7,7,7,7'));
});

test('repeatFrameToDigits fills capacity and refuses when too small', () => {
  const frame = buildFrame(Uint8Array.from([1, 2]), Scheme.HMAC_SHA256); // 8 bytes
  const perCopy = frame.length * 8; // base-2 digits per copy
  const filled = repeatFrameToDigits(frame, 2, perCopy * 3 + 5);
  assert.equal(filled.length, perCopy * 3); // whole copies only
  assert.deepEqual(repeatFrameToDigits(frame, 2, perCopy - 1), []);
});
