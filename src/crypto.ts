/**
 * crypto.ts — recipient-copy token generation and verification.
 *
 * Implements both schemes from Raz et al. §4.2:
 *   HMAC-SHA256: token = HMAC(k_org, copy_id)[:16]        -> 16 B token, 22 B frame
 *   Ed25519:     token = copy_uuid(4) || Ed25519_Sign(sk, copy_uuid)  -> 68 B, 74 B frame
 *
 * Product deviation: the paper derives file_id from a path/hash of a canary
 * file. We derive it from the (matter, recipient, version) triple, because the
 * question this product answers is "WHICH RECIPIENT leaked", not "was a canary
 * ingested". The copy_id string is the attribution primitive.
 */

import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  createHash,
  randomBytes,
  timingSafeEqual,
  KeyObject,
} from 'node:crypto';
import { Scheme } from './frame.js';

export interface CopyIdentity {
  matterRef: string;
  recipientId: string;
  version: string;
  /** ISO-8601 issuance timestamp */
  issuedAt: string;
  /** random per-copy nonce, prevents two identical copies colliding */
  nonce: string;
}

export function newCopyIdentity(
  matterRef: string,
  recipientId: string,
  version: string,
): CopyIdentity {
  return {
    matterRef,
    recipientId,
    version,
    issuedAt: new Date().toISOString(),
    nonce: randomBytes(8).toString('hex'),
  };
}

/** Canonical, stable serialisation. Order matters — never reorder these. */
export function canonicalCopyId(id: CopyIdentity): string {
  return [
    'sonomos.tolaria.v1',
    id.matterRef,
    id.recipientId,
    id.version,
    id.issuedAt,
    id.nonce,
  ].join('\u001f');
}

export function copyIdHash(id: CopyIdentity): string {
  return createHash('sha256').update(canonicalCopyId(id), 'utf8').digest('hex');
}

/* ---------------------------- HMAC scheme ---------------------------- */

export function hmacToken(orgKey: Buffer, id: CopyIdentity): Uint8Array {
  return new Uint8Array(
    createHmac('sha256', orgKey).update(canonicalCopyId(id), 'utf8').digest().subarray(0, 16),
  );
}

export function hmacVerify(orgKey: Buffer, id: CopyIdentity, token: Uint8Array): boolean {
  const expected = Buffer.from(hmacToken(orgKey, id));
  const got = Buffer.from(token);
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

/* --------------------------- Ed25519 scheme --------------------------- */

export interface EdKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyRaw: Buffer; // 32 bytes
}

/** Deterministic derivation from org key material (RFC 8032 seed = 32 bytes). */
export function deriveEd25519(orgKey: Buffer): EdKeyPair {
  const seed = createHash('sha256').update(orgKey).update('tolaria-ed25519-v1').digest();
  // PKCS#8 wrapper for a raw Ed25519 seed.
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  // Derive the public half via a JWK round-trip: drop the private scalar `d`
  // and re-import. Avoids relying on createPublicKey's KeyObject overload,
  // whose typings differ across @types/node versions.
  const jwk = privateKey.export({ format: 'jwk' }) as {
    kty: string; crv: string; x: string; d?: string;
  };
  const { d: _discard, ...publicJwk } = jwk;
  const publicKey = createPublicKey({ key: publicJwk, format: 'jwk' });
  return {
    privateKey,
    publicKey,
    publicKeyRaw: Buffer.from(publicJwk.x, 'base64url'),
  };
}

export function ed25519Token(kp: EdKeyPair, id: CopyIdentity): Uint8Array {
  const uuid = createHash('sha256').update(canonicalCopyId(id), 'utf8').digest().subarray(0, 4);
  const sig = edSign(null, uuid, kp.privateKey); // 64 bytes
  return new Uint8Array(Buffer.concat([uuid, sig])); // 68 bytes
}

export function ed25519VerifyToken(publicKey: KeyObject, token: Uint8Array): boolean {
  if (token.length !== 68) return false;
  const buf = Buffer.from(token);
  return edVerify(null, buf.subarray(0, 4), { key: publicKey }, buf.subarray(4));
}

/** Does this token's embedded copy_uuid match this identity? */
export function ed25519MatchesIdentity(id: CopyIdentity, token: Uint8Array): boolean {
  if (token.length !== 68) return false;
  const expected = createHash('sha256')
    .update(canonicalCopyId(id), 'utf8')
    .digest()
    .subarray(0, 4);
  return Buffer.from(token).subarray(0, 4).equals(expected);
}

/* --------------------------- SHORT_ID scheme -------------------------- */

/** copy_uuid(4) || HMAC(k_org, canonical)[:8] = 12 bytes. Registry-resolvable. */
export function shortIdToken(orgKey: Buffer, id: CopyIdentity): Uint8Array {
  const uuid = createHash('sha256').update(canonicalCopyId(id), 'utf8').digest().subarray(0, 4);
  const tag = createHmac('sha256', orgKey)
    .update(canonicalCopyId(id), 'utf8')
    .digest()
    .subarray(0, 8);
  return new Uint8Array(Buffer.concat([uuid, tag]));
}

export function shortIdVerify(orgKey: Buffer, id: CopyIdentity, token: Uint8Array): boolean {
  if (token.length !== 12) return false;
  const expected = Buffer.from(shortIdToken(orgKey, id));
  return timingSafeEqual(expected, Buffer.from(token));
}

export function shortIdUuid(token: Uint8Array): string {
  return Buffer.from(token).subarray(0, 4).toString('hex');
}

/* ------------------------------ facade ------------------------------- */

export interface Issuer {
  scheme: Scheme;
  mint(id: CopyIdentity): Uint8Array;
  /** cryptographic validity only — registry lookup is a separate step */
  verify(token: Uint8Array): boolean;
  /** short registry pointer for low-capacity durable channels */
  mintShort(id: CopyIdentity): Uint8Array;
}

export function hmacIssuer(orgKey: Buffer, registryLookup: (tokenHex: string) => boolean): Issuer {
  return {
    scheme: Scheme.HMAC_SHA256,
    mint: (id) => hmacToken(orgKey, id),
    // HMAC tokens are unforgeable but not self-verifying: the only way to
    // validate one is to recompute it from a known identity. That is exactly
    // why this scheme REQUIRES a populated registry.
    verify: (t) => registryLookup(Buffer.from(t).toString('hex')),
    mintShort: (id) => shortIdToken(orgKey, id),
  };
}

export function ed25519Issuer(kp: EdKeyPair, orgKey: Buffer): Issuer {
  return {
    scheme: Scheme.ED25519,
    mint: (id) => ed25519Token(kp, id),
    verify: (t) => ed25519VerifyToken(kp.publicKey, t),
    mintShort: (id) => shortIdToken(orgKey, id),
  };
}
