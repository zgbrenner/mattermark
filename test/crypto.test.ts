import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newCopyIdentity,
  canonicalCopyId,
  hmacToken,
  hmacVerify,
  deriveEd25519,
  ed25519Token,
  ed25519VerifyToken,
  ed25519MatchesIdentity,
  shortIdToken,
  shortIdVerify,
} from '../src/crypto.js';
import { Scheme } from '../src/frame.js';
import { randomBytes } from 'node:crypto';

test('newCopyIdentity carries the attribution fields and a fresh nonce', () => {
  const a = newCopyIdentity('M-1', 'r@example.com', 'v1');
  const b = newCopyIdentity('M-1', 'r@example.com', 'v1');
  assert.equal(a.matterRef, 'M-1');
  assert.equal(a.recipientId, 'r@example.com');
  assert.notEqual(a.nonce, b.nonce); // nonce prevents identical copies colliding
});

test('canonicalCopyId is stable and order-sensitive', () => {
  const id = newCopyIdentity('M-1', 'r@example.com', 'v1');
  assert.equal(canonicalCopyId(id), canonicalCopyId(id));
  assert.match(canonicalCopyId(id), /^mattermark\.markityours\.v1/); // domain-separation tag
});

test('HMAC token is deterministic, 16 bytes, and verifies only for its identity', () => {
  const key = randomBytes(32);
  const id = newCopyIdentity('M-1', 'r@example.com', 'v1');
  const other = newCopyIdentity('M-1', 'someone.else@example.com', 'v1');
  const tok = hmacToken(key, id);
  assert.equal(tok.length, 16);
  assert.deepEqual([...hmacToken(key, id)], [...tok]); // deterministic
  assert.ok(hmacVerify(key, id, tok));
  assert.ok(!hmacVerify(key, other, tok)); // wrong identity
  assert.ok(!hmacVerify(randomBytes(32), id, tok)); // wrong key
});

test('Ed25519 token is 68 bytes, self-verifies, and rejects tampering', () => {
  const key = randomBytes(32);
  const kp = deriveEd25519(key);
  const id = newCopyIdentity('M-1', 'r@example.com', 'v1');
  const tok = ed25519Token(kp, id);
  assert.equal(tok.length, 68);
  assert.ok(ed25519VerifyToken(kp.publicKey, tok));
  assert.ok(ed25519MatchesIdentity(id, tok));
  const tampered = Uint8Array.from(tok);
  tampered[40] ^= 0xff;
  assert.ok(!ed25519VerifyToken(kp.publicKey, tampered));
});

test('deriveEd25519 is deterministic from org key material', () => {
  const key = randomBytes(32);
  assert.deepEqual([...deriveEd25519(key).publicKeyRaw], [...deriveEd25519(key).publicKeyRaw]);
});

test('SHORT_ID token is 12 bytes and registry-resolvable', () => {
  const key = randomBytes(32);
  const id = newCopyIdentity('M-1', 'r@example.com', 'v1');
  const tok = shortIdToken(key, id);
  assert.equal(tok.length, 12);
  assert.ok(shortIdVerify(key, id, tok));
  assert.ok(!shortIdVerify(key, newCopyIdentity('M-1', 'x@example.com', 'v1'), tok));
});

test('issuer schemes report their identity', () => {
  assert.equal(Scheme.HMAC_SHA256, 0x01);
  assert.equal(Scheme.ED25519, 0x02);
  assert.equal(Scheme.SHORT_ID, 0x03);
});
