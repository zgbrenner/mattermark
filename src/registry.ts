/**
 * registry.ts — the attribution ledger.
 *
 * The paper explicitly puts key distribution and notification OUT OF SCOPE
 * (§3.5). For a leak-attribution product that scope hole IS the product: a
 * recovered token is worthless unless it resolves to a recipient, a matter,
 * and a defensible provenance record.
 *
 * Storage here is a JSON file for the prototype. Production target is SQLite
 * (local-first, single file, encrypted at rest) — the interface below is
 * deliberately narrow so the backing store can be swapped without touching
 * callers.
 *
 * EVIDENTIARY NOTE: these records are the thing you would authenticate under
 * FRE 901(b)(9) (process or system producing an accurate result) if you ever
 * had to prove attribution. Treat the fields as an evidence schema, not a log.
 * Do not mutate rows in place; append investigation events instead.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CopyIdentity } from './crypto.js';
import { Scheme } from './frame.js';
import type { LayerReport } from './orchestrator.js';

export type DeliveryMethod = 'email' | 'secure-link' | 'physical' | 'portal' | 'other' | 'unknown';

export interface TransformTestResult {
  chain: string;
  recovered: boolean;
  survivingChannels: string[];
}

export interface ProtectedCopy {
  /** primary key: hex of the minted full token */
  tokenHex: string;
  /** secondary key: hex of the SHORT_ID pointer carried in durable channels */
  shortIdHex: string;
  scheme: Scheme;

  identity: CopyIdentity;

  /** SHA-256 of the unmarked source document */
  originalHash: string;
  /** SHA-256 of the marked artifact as delivered */
  protectedHash: string;
  /**
   * Original and protected filenames. Optional so workspace-v1 ledgers written
   * by Mattermark 0.1 remain readable without a migration. New issuances record
   * both names so a portable evidence statement can name its immutable subject
   * without relying on an external filename convention.
   */
  sourceName?: string;
  protectedName?: string;

  /** who at the firm generated this copy */
  generatedBy: string;
  generatedAt: string;

  channels: LayerReport[];
  deliveryMethod: DeliveryMethod;
  deliveryNote?: string;

  /** results of running the transform harness against THIS copy at issue time */
  transformTests: TransformTestResult[];

  /** append-only */
  investigations: InvestigationEvent[];

  /** optional active-canary linkage. See ETHICS note in README. */
  activeCanary?: {
    kind: 'url' | 'dns' | 'none';
    reference: string;
    disclosedToRecipient: boolean;
    disclosureBasis?: string;
  };
}

export interface InvestigationEvent {
  at: string;
  actor: string;
  kind: 'detection' | 'note' | 'export' | 'callback';
  detail: string;
  /** channels that yielded a verified frame, if kind === 'detection' */
  survivingChannels?: string[];
  sourceDescription?: string;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export class Registry {
  private rows = new Map<string, ProtectedCopy>();
  private byShortId = new Map<string, ProtectedCopy>();

  constructor(private path?: string) {
    if (path && existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as ProtectedCopy[];
      for (const r of parsed) this.index(r);
    }
  }

  private index(r: ProtectedCopy): void {
    this.rows.set(r.tokenHex, r);
    if (r.shortIdHex) this.byShortId.set(r.shortIdHex, r);
  }

  /** Resolve either a full token or a SHORT_ID pointer. */
  resolve(tokenHex: string): ProtectedCopy | undefined {
    return this.rows.get(tokenHex) ?? this.byShortId.get(tokenHex);
  }

  add(row: ProtectedCopy): void {
    if (this.rows.has(row.tokenHex)) {
      throw new Error(`token collision for ${row.tokenHex} — refusing to overwrite evidence row`);
    }
    if (row.shortIdHex && this.byShortId.has(row.shortIdHex)) {
      throw new Error(`short-ID collision for ${row.shortIdHex} — reissue with a fresh nonce`);
    }
    this.index(row);
    this.flush();
  }

  lookup(tokenHex: string): ProtectedCopy | undefined {
    return this.rows.get(tokenHex);
  }

  has(tokenHex: string): boolean {
    return this.rows.has(tokenHex);
  }

  /** All copies issued for a matter — the "who else had it" question. */
  byMatter(matterRef: string): ProtectedCopy[] {
    return [...this.rows.values()].filter((r) => r.identity.matterRef === matterRef);
  }

  recordInvestigation(tokenHex: string, ev: InvestigationEvent): void {
    const row = this.rows.get(tokenHex);
    if (!row) throw new Error(`no registry row for ${tokenHex}`);
    row.investigations.push(ev);
    this.flush();
  }

  all(): ProtectedCopy[] {
    return [...this.rows.values()];
  }

  private flush(): void {
    if (!this.path) return;
    writeFileSync(this.path, JSON.stringify([...this.rows.values()], null, 2), 'utf8');
  }
}
