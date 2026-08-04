import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { openTimestampsAnchor } from '../src/ledger/opentimestamps.js';
import { detachedFromAttestations, serializeDetached } from '../src/ledger/ots.js';
import type { AnchorProof } from '../src/ledger/anchor.js';

const ROOT = createHash('sha256').update('mattermark-ots-metadata').digest('hex');

test('legacy confirmed metadata stays false until trusted header verification exists', async () => {
  const digest = Buffer.from(ROOT, 'hex');
  const proof: AnchorProof = {
    anchor: 'opentimestamps',
    digest: ROOT,
    at: '2026-08-04T10:00:00.000Z',
    proof: {
      ots: serializeDetached(
        detachedFromAttestations(digest, [{ kind: 'bitcoin', height: 900_001 }]),
      ).toString('base64'),
    },
  };
  const anchor = openTimestampsAnchor({
    calendars: [],
    transport: async () => ({ status: 404, body: Buffer.alloc(0) }),
  });

  const upgraded = await anchor.upgrade(proof);
  assert.equal(upgraded.proof.bitcoinAttestation, true);
  assert.equal(
    upgraded.proof.confirmed,
    false,
    'a block-height attestation alone must not populate a field named confirmed',
  );
  assert.match(anchor.describe(upgraded), /not independently confirmed/i);
});
