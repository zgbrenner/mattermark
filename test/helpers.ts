/**
 * helpers.ts — shared fixtures for the test suite. Not a test file itself
 * (the runner only executes *.test.ts), but it is typechecked.
 */

import { randomBytes } from 'node:crypto';
import { hmacIssuer, ed25519Issuer, deriveEd25519, newCopyIdentity } from '../src/crypto.js';

/** ~1.8k chars, letter-dense so the HG channel clears the durability floor. */
export const SAMPLE = (
  'The settlement posture and discovery obligations require careful analysis ' +
  'of the exposure and the proportionality of the request under the applicable ' +
  'rules of procedure. '
).repeat(10);

export const IDENTITY = () => newCopyIdentity('MATTER-2026-0001', 'recipient@example.com', 'v1');

export function hmacSetup() {
  const orgKey = randomBytes(32);
  const reg = new Set<string>();
  const issuer = hmacIssuer(orgKey, (h) => reg.has(h));
  return { orgKey, reg, issuer };
}

export function edSetup() {
  const orgKey = randomBytes(32);
  const kp = deriveEd25519(orgKey);
  const issuer = ed25519Issuer(kp, orgKey);
  return { orgKey, kp, issuer };
}
