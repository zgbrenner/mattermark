import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  openTimestampsAnchor,
  stampDigest,
  upgradeDetached,
  confirmProofAgainstBitcoin,
  HttpTransport,
} from '../src/ledger/opentimestamps.js';
import {
  Timestamp,
  serializeTimestamp,
  serializeDetached,
  detachedFromAttestations,
  summarize,
  deserializeDetached,
} from '../src/ledger/ots.js';
import type { AnchorProof } from '../src/ledger/anchor.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();
const ROOT = sha256(Buffer.from('a-merkle-root')).toString('hex');

function calendarResponse(digest: Buffer, uri: string): Buffer {
  const hashed = sha256(digest);
  const ts: Timestamp = {
    msg: digest,
    attestations: [],
    ops: [{ op: 0x08, next: { msg: hashed, attestations: [{ kind: 'pending', uri }], ops: [] } }],
  };
  return serializeTimestamp(ts);
}

function fakeCalendars(opts: { upgradeAt?: number } = {}): { transport: HttpTransport; posts: string[] } {
  const posts: string[] = [];
  const transport: HttpTransport = async (req) => {
    if (req.method === 'POST' && req.url.endsWith('/digest')) {
      posts.push(req.url);
      const uri = req.url.replace(/\/digest$/, '');
      return { status: 200, body: calendarResponse(req.body!, uri) };
    }
    if (req.method === 'GET' && req.url.includes('/timestamp/')) {
      if (opts.upgradeAt === undefined) return { status: 404, body: Buffer.alloc(0) };
      const commitmentHex = req.url.split('/timestamp/')[1];
      const commitment = Buffer.from(commitmentHex, 'hex');
      const ext: Timestamp = { msg: commitment, attestations: [{ kind: 'bitcoin', height: opts.upgradeAt }], ops: [] };
      return { status: 200, body: serializeTimestamp(ext) };
    }
    return { status: 404, body: Buffer.alloc(0) };
  };
  return { transport, posts };
}

test('stampDigest submits to every calendar and merges the responses', async () => {
  const { transport, posts } = fakeCalendars();
  const { detached, errors } = await stampDigest(Buffer.from(ROOT, 'hex'), ['https://alice', 'https://bob'], transport);
  assert.equal(posts.length, 2);
  assert.equal(errors.length, 0);
  const s = summarize(detached);
  assert.equal(s.pending.length, 2);
  assert.equal(s.digestHex, ROOT);
});

test('stampDigest tolerates a partial calendar failure but not a total one', async () => {
  const flaky: HttpTransport = async (req) => {
    if (req.url.includes('alice')) return { status: 500, body: Buffer.alloc(0) };
    return { status: 200, body: calendarResponse(req.body!, req.url.replace(/\/digest$/, '')) };
  };
  const { detached, errors } = await stampDigest(Buffer.from(ROOT, 'hex'), ['https://alice', 'https://bob'], flaky);
  assert.equal(errors.length, 1);
  assert.equal(summarize(detached).pending.length, 1);

  const allDown: HttpTransport = async () => ({ status: 503, body: Buffer.alloc(0) });
  await assert.rejects(
    () => stampDigest(Buffer.from(ROOT, 'hex'), ['https://alice', 'https://bob'], allDown),
    /every calendar failed/,
  );
});

test('anchor commit produces a valid, standard .ots proof that verifies offline', async () => {
  const { transport } = fakeCalendars();
  const anchor = openTimestampsAnchor({ calendars: ['https://alice', 'https://bob'], transport });
  const proof = await anchor.commit(ROOT, '2026-07-28T00:00:00Z');

  assert.equal(proof.anchor, 'opentimestamps');
  assert.equal(proof.digest, ROOT);
  assert.equal(typeof proof.proof.ots, 'string');
  const detached = deserializeDetached(Buffer.from(proof.proof.ots as string, 'base64'));
  assert.equal(detached.fileDigest.toString('hex'), ROOT);

  assert.equal(await anchor.verify(proof), true);
  assert.match(anchor.describe(proof), /pending/);
});

test('anchor verify rejects a proof for a different digest or a foreign anchor', async () => {
  const { transport } = fakeCalendars();
  const anchor = openTimestampsAnchor({ calendars: ['https://alice'], transport });
  const proof = await anchor.commit(ROOT, '2026-07-28T00:00:00Z');

  const tampered: AnchorProof = { ...proof, digest: sha256(Buffer.from('other')).toString('hex') };
  assert.equal(await anchor.verify(tampered), false);

  const foreign: AnchorProof = { anchor: 'local-ed25519-attestation', digest: ROOT, at: proof.at, proof: { sig: 'x' } };
  assert.equal(await anchor.verify(foreign), false);
});

test('upgrade splices a Bitcoin attestation once the calendar is ready', async () => {
  const pending = fakeCalendars();
  const anchor = openTimestampsAnchor({ calendars: ['https://alice'], transport: pending.transport });
  const proof = await anchor.commit(ROOT, '2026-07-28T00:00:00Z');

  const still = await anchor.upgrade(proof);
  assert.equal(still.proof.confirmed, false);
  assert.equal(still.proof.bitcoinAttestation, false);
  assert.match(anchor.describe(still), /pending/);

  const ready = openTimestampsAnchor({ calendars: ['https://alice'], transport: fakeCalendars({ upgradeAt: 815000 }).transport });
  const upgraded = await ready.upgrade(proof);
  assert.equal(upgraded.proof.confirmed, true); // retained for old readers
  assert.equal(upgraded.proof.bitcoinAttestation, true);
  const description = ready.describe(upgraded);
  assert.match(description, /Bitcoin attestation/);
  assert.match(description, /815000/);
  assert.match(description, /not independently confirmed/);
  assert.doesNotMatch(description, /confirmed in Bitcoin/i);
  assert.equal(await ready.verify(upgraded), true);
});

test('confirmProofAgainstBitcoin checks the commitment against a header source', async () => {
  const digest = Buffer.from(ROOT, 'hex');
  const detached = detachedFromAttestations(digest, [{ kind: 'bitcoin', height: 700123 }]);
  const proof: AnchorProof = {
    anchor: 'opentimestamps',
    digest: ROOT,
    at: '2026-07-28T00:00:00Z',
    proof: { ots: serializeDetached(detached).toString('base64') },
  };
  const results = await confirmProofAgainstBitcoin(proof, async (h) => (h === 700123 ? ROOT : null));
  assert.equal(results[0].ok, true);
});
