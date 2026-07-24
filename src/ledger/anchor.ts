/**
 * anchor.ts — anchoring the ledger's Merkle root so the protected-copy record
 * is provably prior to some point in time.
 *
 * Honest framing, because this is where it is easy to overclaim. The internal
 * hash chain proves ORDER and INTEGRITY within the ledger: nobody can alter or
 * reorder a past row without detection. It does NOT, by itself, prove to a
 * skeptical third party that a row existed before a given date — for that you
 * need a timestamp from a party the skeptic trusts (an OpenTimestamps calendar
 * committing to Bitcoin, a Rekor transparency log, or an RFC 3161 TSA).
 *
 * So this module defines the Anchor interface those external services plug
 * into, and ships one built-in anchor — a local Ed25519 attestation. The local
 * anchor proves "this organisation key attested this digest at this claimed
 * time"; it is genuine non-repudiable evidence from the org, but its timestamp
 * is self-asserted. Swap in an external Anchor for third-party-provable
 * priority. The mechanism is identical; only the trust root changes.
 */

import { sign, verify } from 'node:crypto';
import type { EdKeyPair } from '../crypto.js';

export interface AnchorProof {
  /** which anchor produced this proof */
  anchor: string;
  /** the digest (Merkle root) that was anchored */
  digest: string;
  /** claimed anchoring time (trusted only as far as the anchor is) */
  at: string;
  /** anchor-specific proof material */
  proof: Record<string, unknown>;
}

export interface Anchor {
  readonly name: string;
  /** whether this anchor's timestamp is attested by a third party */
  readonly thirdPartyTime: boolean;
  commit(digest: string, at: string): AnchorProof;
  verify(proof: AnchorProof): boolean;
}

/**
 * A local, offline anchor: the organisation signs the digest and claimed time
 * with its Ed25519 key. Non-repudiable as to the org, but the time is
 * self-asserted (thirdPartyTime = false). Use an external anchor when priority
 * must be provable to an adversary.
 */
export function localAttestationAnchor(kp: EdKeyPair): Anchor {
  const message = (digest: string, at: string) => Buffer.from(`markityours-anchor|${digest}|${at}`, 'utf8');
  return {
    name: 'local-ed25519-attestation',
    thirdPartyTime: false,
    commit(digest, at) {
      const sig = sign(null, message(digest, at), kp.privateKey).toString('hex');
      return { anchor: 'local-ed25519-attestation', digest, at, proof: { sig } };
    },
    verify(p) {
      if (p.anchor !== 'local-ed25519-attestation' || typeof p.proof.sig !== 'string') return false;
      try {
        return verify(null, message(p.digest, p.at), kp.publicKey, Buffer.from(p.proof.sig, 'hex'));
      } catch {
        return false;
      }
    },
  };
}
