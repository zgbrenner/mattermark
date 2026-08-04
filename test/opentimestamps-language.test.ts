import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { openTimestampsAnchor, type HttpTransport } from '../src/ledger/opentimestamps.js';
import { serializeTimestamp, type Timestamp } from '../src/ledger/ots.js';

const ROOT = createHash('sha256').update('root').digest('hex');

const transport: HttpTransport = async (req) => {
  if (req.method === 'POST') {
    const digest = req.body!;
    const hashed = createHash('sha256').update(digest).digest();
    const ts: Timestamp = {
      msg: digest,
      attestations: [],
      ops: [{ op: 0x08, next: { msg: hashed, attestations: [{ kind: 'pending', uri: 'https://cal.test' }], ops: [] } }],
    };
    return { status: 200, body: serializeTimestamp(ts) };
  }
  const commitment = Buffer.from(req.url.split('/timestamp/')[1], 'hex');
  const ts: Timestamp = { msg: commitment, attestations: [{ kind: 'bitcoin', height: 900001 }], ops: [] };
  return { status: 200, body: serializeTimestamp(ts) };
};

test('an upgraded OTS proof is an unconfirmed Bitcoin attestation until header verification', async () => {
  const anchor = openTimestampsAnchor({ calendars: ['https://cal.test'], transport });
  const pending = await anchor.commit(ROOT, '2026-08-04T00:00:00Z');
  const upgraded = await anchor.upgrade(pending);
  const description = anchor.describe(upgraded);
  assert.equal(upgraded.proof.bitcoinAttestation, true);
  assert.match(description, /Bitcoin attestation/i);
  assert.match(description, /not independently confirmed/i);
  assert.doesNotMatch(description, /confirmed in Bitcoin/i);
});
