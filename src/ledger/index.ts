/**
 * ledger/index.ts — SecureRegistry (Slice 3).
 *
 * The prototype registry (src/registry.ts) is a plaintext JSON file. This is the
 * durable version the README's roadmap calls for: a single file, encrypted at
 * rest, append-only and tamper-evident via a hash chain, with a Merkle root you
 * can anchor externally. It keeps the same narrow resolve/add/investigation
 * interface, so callers do not change.
 *
 * On SQLite: the roadmap names SQLite as the backing store. A true SQLite
 * backend needs either a native dependency or Node's `node:sqlite` (22.5+),
 * both of which break this repo's zero-dependency + Node-20 stance. The store is
 * therefore a sealed single file today; the interface is deliberately narrow so
 * a SQLite backend can slot in behind it unchanged when those constraints
 * relax. What SQLite was wanted for — a durable, single-file, encrypted,
 * evidentiary store — is delivered here.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { ProtectedCopy, InvestigationEvent } from '../registry.js';
import {
  ChainedEvent,
  EventCore,
  GENESIS,
  eventHash,
  merkleRoot,
  verifyChain,
} from './hashchain.js';
import {
  createMerkleProof,
  type MerkleInclusionProof,
} from './merkle-proof.js';
import { seal, unseal } from './vault.js';
import type { Anchor, AnchorProof, AsyncAnchor } from './anchor.js';

interface CopyPayload {
  copy: ProtectedCopy;
}
interface InvestigationPayload {
  tokenHex: string;
  event: InvestigationEvent;
}

/** A private ledger event plus the compact proof that it belongs to one root. */
export interface LedgerEventInclusion {
  event: ChainedEvent;
  proof: MerkleInclusionProof;
}

export class SecureRegistry {
  private events: ChainedEvent[] = [];
  private rows = new Map<string, ProtectedCopy>();
  private byShortId = new Map<string, ProtectedCopy>();

  private constructor(
    private readonly path: string,
    private readonly passphrase: string,
  ) {}

  /** Create a fresh encrypted registry file. Refuses to clobber an existing one. */
  static create(path: string, passphrase: string): SecureRegistry {
    if (existsSync(path)) throw new Error(`registry already exists at ${path}`);
    const r = new SecureRegistry(path, passphrase);
    r.flush();
    return r;
  }

  /** Open and decrypt an existing registry, verifying its hash chain. */
  static open(path: string, passphrase: string): SecureRegistry {
    const r = new SecureRegistry(path, passphrase);
    const plain = unseal(readFileSync(path), passphrase);
    r.events = JSON.parse(plain.toString('utf8')) as ChainedEvent[];
    if (!verifyChain(r.events).ok) {
      throw new Error('registry: hash chain broken — the file has been altered or reordered');
    }
    r.replay();
    return r;
  }

  static openOrCreate(path: string, passphrase: string): SecureRegistry {
    return existsSync(path) ? SecureRegistry.open(path, passphrase) : SecureRegistry.create(path, passphrase);
  }

  /* ------------------------------ mutations ------------------------------ */

  add(copy: ProtectedCopy, at = new Date().toISOString()): void {
    if (this.rows.has(copy.tokenHex)) {
      throw new Error(`token collision for ${copy.tokenHex} — refusing to overwrite evidence row`);
    }
    if (copy.shortIdHex && this.byShortId.has(copy.shortIdHex)) {
      throw new Error(`short-ID collision for ${copy.shortIdHex} — reissue with a fresh nonce`);
    }
    // Store the copy with an empty investigation list; investigations are their
    // own chained events so the copy row's hash never changes after the fact.
    const stored: ProtectedCopy = { ...copy, investigations: [] };
    this.append('copy', { copy: stored }, at);
  }

  recordInvestigation(tokenHex: string, event: InvestigationEvent, at = new Date().toISOString()): void {
    if (!this.rows.has(tokenHex)) throw new Error(`no registry row for ${tokenHex}`);
    this.append('investigation', { tokenHex, event }, at);
  }

  /* ------------------------------- reads --------------------------------- */

  resolve(tokenHex: string): ProtectedCopy | undefined {
    return this.rows.get(tokenHex) ?? this.byShortId.get(tokenHex);
  }

  has(tokenHex: string): boolean {
    return this.rows.has(tokenHex);
  }

  byMatter(matterRef: string): ProtectedCopy[] {
    return [...this.rows.values()].filter((r) => r.identity.matterRef === matterRef);
  }

  all(): ProtectedCopy[] {
    return [...this.rows.values()];
  }

  /* --------------------------- integrity / anchor ------------------------ */

  /** The current chain head hash (commits to every event, in order). */
  head(): string {
    return this.events.length ? this.events[this.events.length - 1].hash : GENESIS;
  }

  /** Compact digest over the whole ledger — the value to anchor externally. */
  merkleRoot(): string {
    return merkleRoot(this.events.map((e) => e.hash));
  }

  /**
   * Recompute the Merkle root for an exact historical event prefix. Stored
   * anchors name their event count, so a copy can later receive an inclusion
   * proof against the same root without exposing the rest of the private log.
   */
  rootAt(eventCount: number): string {
    if (
      !Number.isInteger(eventCount) ||
      eventCount < 1 ||
      eventCount > this.events.length
    ) {
      throw new Error(
        `event count must be an integer from 1 through ${this.events.length}, not ${eventCount}`,
      );
    }
    return merkleRoot(this.events.slice(0, eventCount).map((e) => e.hash));
  }

  /**
   * Prove that a protected-copy issuance event belongs to the current ledger or
   * to an anchored historical prefix. A short ID resolves to the same immutable
   * full-token copy event. The returned event is cloned so evidence export code
   * cannot mutate the registry's in-memory chain by retaining a reference.
   */
  proveCopy(tokenHex: string, eventCount = this.events.length): LedgerEventInclusion {
    const copy = this.resolve(tokenHex);
    if (!copy) throw new Error(`no registry row resolves ${tokenHex}`);

    // Validate before searching so an empty or impossible prefix fails with the
    // same precise contract as rootAt().
    this.rootAt(eventCount);

    const index = this.events.findIndex(
      (event) =>
        event.type === 'copy' &&
        (event.payload as CopyPayload).copy.tokenHex === copy.tokenHex,
    );
    if (index < 0) {
      throw new Error(`registry row ${copy.tokenHex} has no copy event`);
    }
    if (index >= eventCount) {
      throw new Error(
        `event prefix ${eventCount} predates the copy event at index ${index}`,
      );
    }

    const prefix = this.events.slice(0, eventCount);
    return {
      event: structuredClone(this.events[index]),
      proof: createMerkleProof(prefix.map((event) => event.hash), index),
    };
  }

  /** Recompute the chain; false means the in-memory events were tampered with. */
  verify(): boolean {
    return verifyChain(this.events).ok;
  }

  eventCount(): number {
    return this.events.length;
  }

  /** Anchor the current Merkle root through the given (synchronous) anchor. */
  anchor(anchor: Anchor, at = new Date().toISOString()): AnchorProof {
    return anchor.commit(this.merkleRoot(), at);
  }

  /** An anchor proof is valid iff it verifies AND commits to the current root. */
  verifyAnchor(anchor: Anchor, proof: AnchorProof): boolean {
    return proof.digest === this.merkleRoot() && anchor.verify(proof);
  }

  /**
   * Anchor the current Merkle root through a network-backed anchor (an
   * OpenTimestamps calendar, a transparency log, an RFC 3161 TSA). Same
   * semantics as anchor(), but awaits the third party.
   */
  anchorAsync(anchor: AsyncAnchor, at = new Date().toISOString()): Promise<AnchorProof> {
    return anchor.commit(this.merkleRoot(), at);
  }

  /** A network anchor proof is valid iff it verifies AND commits to the current root. */
  async verifyAnchorAsync(anchor: AsyncAnchor, proof: AnchorProof): Promise<boolean> {
    return proof.digest === this.merkleRoot() && (await anchor.verify(proof));
  }

  /* ------------------------------ internals ------------------------------ */

  private append(type: 'copy' | 'investigation', payload: CopyPayload | InvestigationPayload, at: string): void {
    const seq = this.events.length;
    const prevHash = seq === 0 ? GENESIS : this.events[seq - 1].hash;
    const core: EventCore = { seq, type, at, payload };
    const hash = eventHash(prevHash, core);
    const event: ChainedEvent = { ...core, prevHash, hash };
    this.events.push(event);
    this.apply(event);
    this.flush();
  }

  private apply(e: ChainedEvent): void {
    if (e.type === 'copy') {
      const c = (e.payload as CopyPayload).copy;
      // Derived row is a distinct object with its own investigation list, so
      // later investigation events never mutate the stored (hashed) copy event.
      const row: ProtectedCopy = { ...c, investigations: [] };
      this.rows.set(row.tokenHex, row);
      if (row.shortIdHex) this.byShortId.set(row.shortIdHex, row);
    } else {
      const { tokenHex, event } = e.payload as InvestigationPayload;
      this.rows.get(tokenHex)?.investigations.push(event);
    }
  }

  private replay(): void {
    this.rows.clear();
    this.byShortId.clear();
    for (const e of this.events) this.apply(e);
  }

  private flush(): void {
    writeFileSync(this.path, seal(Buffer.from(JSON.stringify(this.events), 'utf8'), this.passphrase));
  }
}

export type { Anchor, AnchorProof, AsyncAnchor } from './anchor.js';
export { localAttestationAnchor, isAsyncAnchor } from './anchor.js';
export { openTimestampsAnchor, confirmProofAgainstBitcoin } from './opentimestamps.js';
export type { HttpTransport, HttpRequest, HttpResponse } from './opentimestamps.js';
export type { MerkleInclusionProof, MerkleProofStep } from './merkle-proof.js';
export { createMerkleProof, verifyMerkleProof } from './merkle-proof.js';
