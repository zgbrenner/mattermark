/**
 * vault.ts — encryption at rest for the registry file.
 *
 * The registry holds recipient identities, matter references, and token
 * material. It must not sit on disk in plaintext. This seals it with
 * AES-256-GCM under a key derived from a passphrase via scrypt. GCM's auth tag
 * doubles as an integrity check: a truncated or bit-flipped file fails to open
 * rather than decrypting to garbage.
 *
 * Node built-in crypto only. File layout:
 *   MAGIC(6) | salt(16) | iv(12) | authTag(16) | ciphertext
 */

import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const MAGIC = Buffer.from('MIYLv1', 'latin1');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // scrypt with a deliberately non-trivial cost; N=2^15 is a sane on-device default.
  return scryptSync(passphrase, salt, KEY_LEN, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}

/** Encrypt `plaintext` under `passphrase`, returning the sealed file bytes. */
export function seal(plaintext: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, ct]);
}

/** Decrypt a sealed file. Throws on a wrong passphrase or any tampering. */
export function unseal(buf: Buffer, passphrase: string): Buffer {
  if (buf.length < MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('vault: not a MarkItYours registry file');
  }
  let p = MAGIC.length;
  const salt = buf.subarray(p, (p += SALT_LEN));
  const iv = buf.subarray(p, (p += IV_LEN));
  const tag = buf.subarray(p, (p += TAG_LEN));
  const ct = buf.subarray(p);
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('vault: decryption failed (wrong passphrase or tampered file)');
  }
}
