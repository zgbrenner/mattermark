/**
 * hashchain.ts — the tamper-evidence primitives for the registry.
 *
 * The registry is evidence (FRE 901). An append-only hash chain makes it
 * tamper-evident: each event commits to the previous event's hash, so a single
 * altered, deleted, or reordered row breaks the chain and is detectable by
 * recomputation. A Merkle root over all event hashes gives one compact digest
 * that stands in for the whole ledger — the value you anchor externally.
 *
 * Pure functions only; no I/O, no crypto keys. Easy to reason about and test.
 */

import { createHash } from 'node:crypto';

export function sha256hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Deterministic JSON: keys sorted, undefined values dropped. Hash-stable. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** Genesis link: the fixed root every chain descends from. */
export const GENESIS = sha256hex('markityours.ledger.v1');

/** The hashed core of a ledger event (everything except the hash itself). */
export interface EventCore {
  seq: number;
  type: 'copy' | 'investigation';
  at: string;
  payload: unknown;
}

/** hash = SHA-256(prevHash || canonical(core)). */
export function eventHash(prevHash: string, core: EventCore): string {
  return sha256hex(prevHash + stableStringify(core));
}

/** A Merkle root over event hashes (duplicate the last node on an odd level). */
export function merkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return GENESIS;
  let level = hashes.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256hex(level[i] + (level[i + 1] ?? level[i])));
    }
    level = next;
  }
  return level[0];
}

export interface ChainedEvent extends EventCore {
  prevHash: string;
  hash: string;
}

/** Recompute the chain over `events` and return whether it is intact, plus the
 *  head hash actually reached. A mismatch means a row was altered or reordered. */
export function verifyChain(events: ChainedEvent[]): { ok: boolean; head: string } {
  let prev = GENESIS;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const core: EventCore = { seq: e.seq, type: e.type, at: e.at, payload: e.payload };
    if (e.seq !== i || e.prevHash !== prev || e.hash !== eventHash(prev, core)) {
      return { ok: false, head: prev };
    }
    prev = e.hash;
  }
  return { ok: true, head: prev };
}
