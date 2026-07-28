/**
 * opentimestamps.ts — the OpenTimestamps anchor: submit the ledger's Merkle root
 * to public calendar servers and hold a standard `.ots` proof that any
 * OpenTimestamps tool can later verify against Bitcoin.
 *
 * Why this is the anchor that actually proves priority. The local attestation
 * anchor (anchor.ts) signs "we saw this digest at this time" — non-repudiable as
 * to us, but the time is our own word. OpenTimestamps replaces our word with
 * Bitcoin's: the calendar aggregates our digest into a Merkle tree, commits the
 * tree root into a Bitcoin transaction, and once that block is mined the proof
 * ties our digest to a block whose timestamp no one can forge or backdate. That
 * is third-party-provable priority.
 *
 * Two honesty boundaries, held deliberately:
 *   1. A freshly committed proof is PENDING — a calendar promise, not yet in
 *      Bitcoin. `describe()` says so. Priority becomes provable only after the
 *      calendar upgrades the proof (minutes to hours) and the block confirms.
 *   2. `verify()` here is OFFLINE and structural: it confirms the proof is a
 *      well-formed `.ots` that commits to your digest. It does NOT reach into
 *      Bitcoin — that needs a block-header source (see confirmProofAgainstBitcoin
 *      and ots.confirmBitcoin). We never conflate "well-formed" with "confirmed".
 *
 * All network I/O goes through an injectable HttpTransport, so the calendar
 * protocol is exercised in tests without touching the network.
 */

import type { AnchorProof, AsyncAnchor } from './anchor.js';
import {
  DetachedTimestamp,
  Timestamp,
  deserializeTimestamp,
  serializeDetached,
  deserializeDetached,
  detachedFromAttestations,
  summarize,
  spliceUpgrade,
  mergeTimestamps,
  confirmBitcoin,
} from './ots.js';

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  body?: Buffer;
  headers?: Record<string, string>;
}
export interface HttpResponse {
  status: number;
  body: Buffer;
}
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

/** The public Bitcoin calendar servers run by the OpenTimestamps project. */
export const DEFAULT_CALENDARS = [
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
];

const OTS_HEADERS = {
  Accept: 'application/vnd.opentimestamps.v1',
  'User-Agent': 'mattermark-markityours/1',
};

/** Real transport over global fetch. Used unless a test injects its own. */
export const fetchTransport: HttpTransport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body ? new Uint8Array(req.body) : undefined,
  });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body };
};

/* ------------------------------ calendar client ---------------------------- */

/** Submit a 32-byte digest to one calendar; returns its Timestamp (from digest). */
export async function submitToCalendar(
  calendarUrl: string,
  digest: Buffer,
  transport: HttpTransport,
): Promise<Timestamp> {
  const res = await transport({
    method: 'POST',
    url: `${calendarUrl.replace(/\/$/, '')}/digest`,
    body: digest,
    headers: { ...OTS_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (res.status !== 200) {
    throw new Error(`opentimestamps: calendar ${calendarUrl} returned HTTP ${res.status}`);
  }
  return deserializeTimestamp(res.body, digest);
}

/**
 * Stamp a digest across several calendars and merge their responses into one
 * detached proof. A failure from any single calendar is tolerated as long as at
 * least one succeeds (redundancy is the point of multiple calendars); if all
 * fail, the error is surfaced.
 */
export async function stampDigest(
  digest: Buffer,
  calendars: string[],
  transport: HttpTransport,
): Promise<{ detached: DetachedTimestamp; errors: string[] }> {
  if (digest.length !== 32) throw new Error('opentimestamps: digest must be 32 bytes (a SHA-256 root)');
  let merged: Timestamp | null = null;
  const errors: string[] = [];
  for (const cal of calendars) {
    try {
      const ts = await submitToCalendar(cal, digest, transport);
      merged = merged ? mergeTimestamps(merged, ts) : ts;
    } catch (e) {
      errors.push(`${cal}: ${(e as Error).message}`);
    }
  }
  if (!merged) {
    throw new Error(`opentimestamps: every calendar failed — ${errors.join('; ')}`);
  }
  return { detached: { fileHashOp: 0x08, fileDigest: digest, timestamp: merged }, errors };
}

/**
 * Ask each pending calendar for a Bitcoin-attested extension of its commitment
 * and splice any that are ready into the proof. Calendars answer 404 until the
 * aggregation block is mined, so an un-upgraded proof simply comes back
 * unchanged — never an error.
 */
export async function upgradeDetached(
  detached: DetachedTimestamp,
  transport: HttpTransport,
): Promise<{ detached: DetachedTimestamp; upgraded: boolean }> {
  let timestamp = detached.timestamp;
  let upgraded = false;
  for (const p of summarize(detached).pending) {
    const commitment = Buffer.from(p.commitment, 'hex');
    try {
      const res = await transport({
        method: 'GET',
        url: `${p.uri.replace(/\/$/, '')}/timestamp/${p.commitment}`,
        headers: OTS_HEADERS,
      });
      if (res.status !== 200 || res.body.length === 0) continue;
      const ext = deserializeTimestamp(res.body, commitment);
      timestamp = spliceUpgrade(timestamp, p.commitment, ext);
      upgraded = true;
    } catch {
      // a calendar that is unreachable or not yet ready leaves the proof as-is
    }
  }
  return { detached: { ...detached, timestamp }, upgraded };
}

/* ------------------------------- the anchor -------------------------------- */

export interface OpenTimestampsOptions {
  calendars?: string[];
  transport?: HttpTransport;
}

export function openTimestampsAnchor(opts: OpenTimestampsOptions = {}): AsyncAnchor & {
  upgrade(proof: AnchorProof): Promise<AnchorProof>;
  describe(proof: AnchorProof): string;
} {
  const calendars = opts.calendars ?? DEFAULT_CALENDARS;
  const transport = opts.transport ?? fetchTransport;
  const NAME = 'opentimestamps';

  const proofFrom = (detached: DetachedTimestamp, at: string, extra: Record<string, unknown>): AnchorProof => ({
    anchor: NAME,
    digest: detached.fileDigest.toString('hex'),
    at,
    proof: { ots: serializeDetached(detached).toString('base64'), ...extra },
  });

  const parse = (proof: AnchorProof): DetachedTimestamp => {
    if (proof.anchor !== NAME || typeof proof.proof.ots !== 'string') {
      throw new Error('opentimestamps: not an OpenTimestamps proof');
    }
    return deserializeDetached(Buffer.from(proof.proof.ots, 'base64'));
  };

  return {
    name: NAME,
    thirdPartyTime: true,
    async: true,

    async commit(digest, at) {
      const bytes = Buffer.from(digest, 'hex');
      if (bytes.length !== 32) throw new Error('opentimestamps: digest must be a 32-byte SHA-256 hex string');
      const { detached, errors } = await stampDigest(bytes, calendars, transport);
      return proofFrom(detached, at, { pending: true, calendarErrors: errors });
    },

    async verify(proof) {
      try {
        const detached = parse(proof);
        if (detached.fileDigest.toString('hex') !== proof.digest.toLowerCase()) return false;
        // A structural walk that does not throw means every op replayed and the
        // proof is a well-formed commitment to this digest.
        summarize(detached);
        return true;
      } catch {
        return false;
      }
    },

    async upgrade(proof) {
      const detached = parse(proof);
      const { detached: next, upgraded } = await upgradeDetached(detached, transport);
      const summary = summarize(next);
      return proofFrom(next, proof.at, {
        pending: summary.pending.length > 0 && summary.bitcoin.length === 0,
        confirmed: summary.bitcoin.length > 0,
        upgraded,
      });
    },

    describe(proof) {
      let s;
      try {
        s = summarize(parse(proof));
      } catch (e) {
        return `unreadable OpenTimestamps proof: ${(e as Error).message}`;
      }
      if (s.bitcoin.length > 0) {
        const heights = s.bitcoin.map((b) => b.height).join(', ');
        return `confirmed in Bitcoin block ${heights} — priority provable to anyone who trusts Bitcoin`;
      }
      if (s.pending.length > 0) {
        return `pending at ${s.pending.length} calendar(s) — upgrade later, then Bitcoin confirms priority`;
      }
      return 'OpenTimestamps proof with no recognizable attestation';
    },
  };
}

/**
 * The optional final step: confirm a stored proof against Bitcoin using a
 * block-header source the caller trusts (a node, a header set, a block
 * explorer). Kept separate from the anchor so the trust root is explicit and
 * chosen by the caller — never assumed.
 */
export async function confirmProofAgainstBitcoin(
  proof: AnchorProof,
  merkleRootOf: (height: number) => Promise<string | null>,
): Promise<Array<{ height: number; commitment: string; ok: boolean }>> {
  if (proof.anchor !== 'opentimestamps' || typeof proof.proof.ots !== 'string') {
    throw new Error('opentimestamps: not an OpenTimestamps proof');
  }
  return confirmBitcoin(deserializeDetached(Buffer.from(proof.proof.ots, 'base64')), merkleRootOf);
}
