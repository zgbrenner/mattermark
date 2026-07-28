import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  Timestamp,
  Attestation,
  serializeTimestamp,
  deserializeTimestamp,
  serializeDetached,
  deserializeDetached,
  detachedFromAttestations,
  summarize,
  walkAttestations,
  spliceUpgrade,
  mergeTimestamps,
  applyOp,
  confirmBitcoin,
  HEADER_MAGIC,
} from '../src/ledger/ots.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

function digest(seed = 'root'): Buffer {
  return sha256(Buffer.from(seed, 'utf8'));
}

/** A pending timestamp: digest --append--> --sha256--> pending calendar. */
function pendingTimestamp(msg: Buffer, uri: string, suffix = Buffer.from('cafe', 'hex')): Timestamp {
  const appended = Buffer.concat([msg, suffix]);
  const hashed = sha256(appended);
  const pending: Attestation = { kind: 'pending', uri };
  return {
    msg,
    attestations: [],
    ops: [
      {
        op: 0xf0, // append
        arg: suffix,
        next: { msg: appended, attestations: [], ops: [{ op: 0x08, next: { msg: hashed, attestations: [pending], ops: [] } }] },
      },
    ],
  };
}

test('applyOp implements append, prepend, and sha256', () => {
  const m = Buffer.from('ab', 'hex');
  assert.deepEqual(applyOp(0xf0, Buffer.from('cd', 'hex'), m), Buffer.from('abcd', 'hex'));
  assert.deepEqual(applyOp(0xf1, Buffer.from('cd', 'hex'), m), Buffer.from('cdab', 'hex'));
  assert.deepEqual(applyOp(0x08, undefined, m), sha256(m));
  assert.throws(() => applyOp(0x99, undefined, m), /unsupported operation/);
});

test('timestamp serialize -> deserialize round-trips byte-for-byte', () => {
  const msg = digest();
  const ts = pendingTimestamp(msg, 'https://calendar.example/a');
  const bytes = serializeTimestamp(ts);
  const back = deserializeTimestamp(bytes, msg);
  assert.deepEqual(serializeTimestamp(back), bytes);
  const reached = walkAttestations(back);
  assert.equal(reached.length, 1);
  assert.equal(reached[0].attestation.kind, 'pending');
});

test('detached file round-trips through the standard .ots header', () => {
  const msg = digest('ledger-root');
  const ts = pendingTimestamp(msg, 'https://calendar.example/b');
  const detached = { fileHashOp: 0x08, fileDigest: msg, timestamp: ts };
  const file = serializeDetached(detached);
  assert.ok(file.subarray(0, HEADER_MAGIC.length).equals(HEADER_MAGIC));
  const back = deserializeDetached(file);
  assert.equal(back.fileDigest.toString('hex'), msg.toString('hex'));
  assert.deepEqual(serializeDetached(back), file);
});

test('summarize reports pending vs bitcoin and confirmation state', () => {
  const msg = digest();
  const pending = detachedFromAttestations(msg, [{ kind: 'pending', uri: 'https://cal/x' }]);
  const s1 = summarize(pending);
  assert.equal(s1.pending.length, 1);
  assert.equal(s1.confirmed, false);

  const bitcoin = detachedFromAttestations(msg, [{ kind: 'bitcoin', height: 800000 }]);
  const s2 = summarize(bitcoin);
  assert.equal(s2.bitcoin.length, 1);
  assert.equal(s2.bitcoin[0].height, 800000);
  assert.equal(s2.confirmed, true);
});

test('unknown attestations survive a round-trip without corrupting the tree', () => {
  const msg = digest();
  const unknown: Attestation = { kind: 'unknown', tag: '0102030405060708', payload: 'deadbeef' };
  const detached = detachedFromAttestations(msg, [unknown, { kind: 'pending', uri: 'https://cal/y' }]);
  const back = deserializeDetached(serializeDetached(detached));
  const s = summarize(back);
  assert.equal(s.unknown, 1);
  assert.equal(s.pending.length, 1);
});

test('spliceUpgrade attaches a bitcoin attestation at the pending commitment', () => {
  const msg = digest('upgrade-me');
  const ts = pendingTimestamp(msg, 'https://cal/z');
  const commitment = walkAttestations(ts)[0].commitment;

  // The calendar's upgrade: from the same commitment, a bitcoin attestation.
  const upgrade: Timestamp = {
    msg: Buffer.from(commitment, 'hex'),
    attestations: [{ kind: 'bitcoin', height: 812345 }],
    ops: [],
  };
  const spliced = spliceUpgrade(ts, commitment, upgrade);
  const s = summarize({ fileHashOp: 0x08, fileDigest: msg, timestamp: spliced });
  assert.equal(s.bitcoin.length, 1);
  assert.equal(s.bitcoin[0].height, 812345);
  assert.equal(s.pending.length, 1); // original pending promise is preserved too
});

test('mergeTimestamps combines two calendars sharing a root', () => {
  const msg = digest();
  const a = pendingTimestamp(msg, 'https://alice/');
  const b = pendingTimestamp(msg, 'https://bob/');
  const merged = mergeTimestamps(a, b);
  assert.equal(walkAttestations(merged).length, 2);
  assert.throws(() => mergeTimestamps(a, pendingTimestamp(digest('other'), 'https://c/')), /different root/);
});

test('confirmBitcoin verifies a commitment against a block-header source', async () => {
  const msg = digest();
  const detached = detachedFromAttestations(msg, [{ kind: 'bitcoin', height: 700000 }]);
  const commitment = msg.toString('hex');

  const good = await confirmBitcoin(detached, async (h) => (h === 700000 ? commitment : null));
  assert.equal(good[0].ok, true);

  const bad = await confirmBitcoin(detached, async () => 'ff'.repeat(32));
  assert.equal(bad[0].ok, false);

  const unknown = await confirmBitcoin(detached, async () => null);
  assert.equal(unknown[0].ok, false);
});

test('deserialize rejects a truncated proof rather than guessing', () => {
  const msg = digest();
  const ts = pendingTimestamp(msg, 'https://cal/trunc');
  const bytes = serializeTimestamp(ts);
  assert.throws(() => deserializeTimestamp(bytes.subarray(0, bytes.length - 3), msg), /unexpected end|end of proof/);
});
