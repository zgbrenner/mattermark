/**
 * opentimestamps.ts — the OpenTimestamps anchor: submit the ledger's Merkle root
 * to public calendar servers and hold a standard `.ots` proof that any
 * OpenTimestamps tool can later verify against Bitcoin.
 *
 * Two honesty boundaries are deliberate:
 *   1. A freshly committed proof is PENDING. It is a calendar promise, not yet
 *      a Bitcoin attestation.
 *   2. An upgraded proof may CONTAIN a Bitcoin block-height attestation, but it
 *      is not independently confirmed until its commitment is checked against a
 *      trusted block header. `confirmProofAgainstBitcoin` performs that final
 *      caller-supplied trust step.
 *
 * All network I/O goes through an injectable HttpTransport, so tests exercise
 * the real protocol without relying on external calendars.
 */

import type { AnchorProof, AsyncAnchor } from './anchor.js';
import {
  DetachedTimestamp,
  Timestamp,
  deserializeTimestamp,
  serializeDetached,
  deserializeDetached,
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

export const DEFAULT_CALENDARS = [
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
];

const OTS_HEADERS = {
  Accept: 'application/vnd.opentimestamps.v1',
  'User-Agent': 'mattermark-markityours/2',
};

export const fetchTransport: HttpTransport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body ? new Uint8Array(req.body) : undefined,
  });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
};

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

export async function stampDigest(
  digest: Buffer,
  calendars: string[],
  transport: HttpTransport,
): Promise<{ detached: DetachedTimestamp; errors: string[] }> {
  if (digest.length !== 32) throw new Error('opentimestamps: digest must be 32 bytes (a SHA-256 root)');
  let merged: Timestamp | null = null;
  const errors: string[] = [];
  for (const calendar of calendars) {
    try {
      const timestamp = await submitToCalendar(calendar, digest, transport);
      merged = merged ? mergeTimestamps(merged, timestamp) : timestamp;
    } catch (err) {
      errors.push(`${calendar}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!merged) throw new Error(`opentimestamps: every calendar failed — ${errors.join('; ')}`);
  return { detached: { fileHashOp: 0x08, fileDigest: digest, timestamp: merged }, errors };
}

export async function upgradeDetached(
  detached: DetachedTimestamp,
  transport: HttpTransport,
): Promise<{ detached: DetachedTimestamp; upgraded: boolean }> {
  let timestamp = detached.timestamp;
  let upgraded = false;
  for (const pending of summarize(detached).pending) {
    try {
      const response = await transport({
        method: 'GET',
        url: `${pending.uri.replace(/\/$/, '')}/timestamp/${pending.commitment}`,
        headers: OTS_HEADERS,
      });
      if (response.status !== 200 || response.body.length === 0) continue;
      const extension = deserializeTimestamp(response.body, Buffer.from(pending.commitment, 'hex'));
      timestamp = spliceUpgrade(timestamp, pending.commitment, extension);
      upgraded = true;
    } catch {
      // A calendar that is unreachable or not yet ready leaves the proof intact.
    }
  }
  return { detached: { ...detached, timestamp }, upgraded };
}

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
      return proofFrom(detached, at, {
        pending: true,
        bitcoinAttestation: false,
        calendarErrors: errors,
      });
    },

    async verify(proof) {
      try {
        const detached = parse(proof);
        if (detached.fileDigest.toString('hex') !== proof.digest.toLowerCase()) return false;
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
      const bitcoinAttestation = summary.bitcoin.length > 0;
      return proofFrom(next, proof.at, {
        pending: summary.pending.length > 0 && !bitcoinAttestation,
        bitcoinAttestation,
        // Backward-compatible field retained for old readers. It remains false
        // until a trusted block-header verification result can support it.
        confirmed: false,
        upgraded,
      });
    },

    describe(proof) {
      try {
        const summary = summarize(parse(proof));
        if (summary.bitcoin.length > 0) {
          const heights = summary.bitcoin.map((item) => item.height).join(', ');
          return (
            `contains a Bitcoin attestation for block ${heights}; ` +
            'not independently confirmed until checked against a trusted block header'
          );
        }
        if (summary.pending.length > 0) {
          return `pending at ${summary.pending.length} calendar(s) — upgrade later; no Bitcoin attestation yet`;
        }
        return 'OpenTimestamps proof with no recognizable attestation';
      } catch (err) {
        return `unreadable OpenTimestamps proof: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export async function confirmProofAgainstBitcoin(
  proof: AnchorProof,
  merkleRootOf: (height: number) => Promise<string | null>,
): Promise<Array<{ height: number; commitment: string; ok: boolean }>> {
  if (proof.anchor !== 'opentimestamps' || typeof proof.proof.ots !== 'string') {
    throw new Error('opentimestamps: not an OpenTimestamps proof');
  }
  return confirmBitcoin(deserializeDetached(Buffer.from(proof.proof.ots, 'base64')), merkleRootOf);
}
