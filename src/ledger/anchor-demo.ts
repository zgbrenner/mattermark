/**
 * ledger/anchor-demo.ts — Slice 5 walkthrough: prove the ledger predates a
 * dispute with an external OpenTimestamps anchor.
 *
 * The hash chain proves the ledger's records are ordered and unaltered. It does
 * NOT prove to a skeptic that a record existed before some date — for that you
 * need a timestamp from a party the skeptic trusts. This demo:
 *
 *   1. builds a small vault and protects a copy,
 *   2. anchors the ledger locally (instant, but self-asserted time),
 *   3. anchors the ledger through OpenTimestamps against a HERMETIC calendar
 *      (so the demo is deterministic and offline — the real anchor talks to the
 *      public Bitcoin calendars over the network),
 *   4. shows the pending proof, upgrades it once the calendar has a block, and
 *      confirms the resulting Bitcoin commitment against a header source.
 *
 * The OpenTimestamps proof we hold is a standard `.ots` file: in production you
 * could hand it to any OpenTimestamps tool and it would verify against Bitcoin.
 */

import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { initWorkspace } from '../workspace.js';
import { openTimestampsAnchor, confirmProofAgainstBitcoin, HttpTransport } from './opentimestamps.js';
import { serializeTimestamp, deserializeDetached, summarize, Timestamp } from './ots.js';

function line(s = ''): void {
  console.log(s);
}
function rule(title: string): void {
  line();
  line('='.repeat(78));
  line(title);
  line('='.repeat(78));
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

const SAMPLE =
  'PRIVILEGED AND CONFIDENTIAL. This memorandum sets out the settlement posture ' +
  'and discovery obligations of the parties under the applicable rules of procedure, ' +
  'and it must not circulate outside the steering committee. '.repeat(6);

/**
 * A hermetic OpenTimestamps calendar. On /digest it returns a pending
 * attestation; once `mineBlock` is set, /timestamp/<commitment> returns a
 * Bitcoin block-header attestation, exactly as the real calendars do after the
 * aggregation transaction is mined.
 */
function hermeticCalendar(state: { block?: number }): HttpTransport {
  return async (req) => {
    if (req.method === 'POST' && req.url.endsWith('/digest')) {
      const uri = req.url.replace(/\/digest$/, '');
      const hashed = sha256(req.body!);
      const ts: Timestamp = {
        msg: req.body!,
        attestations: [],
        ops: [{ op: 0x08, next: { msg: hashed, attestations: [{ kind: 'pending', uri }], ops: [] } }],
      };
      return { status: 200, body: serializeTimestamp(ts) };
    }
    if (req.method === 'GET' && req.url.includes('/timestamp/') && state.block !== undefined) {
      const commitment = Buffer.from(req.url.split('/timestamp/')[1], 'hex');
      const ext: Timestamp = { msg: commitment, attestations: [{ kind: 'bitcoin', height: state.block }], ops: [] };
      return { status: 200, body: serializeTimestamp(ext) };
    }
    return { status: 404, body: Buffer.alloc(0) };
  };
}

async function main(): Promise<void> {
  const dir = join(tmpdir(), 'mattermark-anchor-demo-' + randomBytes(6).toString('hex'));
  try {
    rule('1. Build a vault and protect a copy');
    const ws = initWorkspace(dir, 'demo-passphrase-do-not-use-in-production', { orgName: 'Demo LLP' });
    const out = ws.protect(
      { name: 'memo.txt', bytes: Buffer.from(SAMPLE, 'utf8') },
      { matter: 'M-2026-0417', recipient: 'opposing.counsel@example.com', deliveryMethod: 'email' },
    );
    line(`Protected a copy for ${out.copy.identity.recipientId}.`);
    line(`Ledger Merkle root: ${ws.status().merkleRoot}`);

    rule('2. Local anchor — instant, but the time is our own word');
    const local = await ws.anchorLedger(ws.localAnchor());
    line(`Anchor: ${local.proof.anchor}`);
    line(`Third-party time: ${local.thirdPartyTime ? 'yes' : 'no (self-asserted)'}`);
    line(`Verifies: ${await ws.verifyStoredAnchor(ws.localAnchor(), local)}`);

    rule('3. OpenTimestamps anchor — Bitcoin will vouch for the time');
    const state: { block?: number } = {};
    const ots = openTimestampsAnchor({ calendars: ['https://calendar.demo'], transport: hermeticCalendar(state) });
    const pending = await ws.anchorLedger(ots);
    line(`Anchor: ${pending.proof.anchor}`);
    line(`Third-party time: ${pending.thirdPartyTime ? 'yes' : 'no'}`);
    line(`Status now: ${pending.describe}`);
    line('The stored proof is a standard .ots file — any OpenTimestamps tool can read it.');

    rule('4. Upgrade once the aggregation block is mined, then confirm against Bitcoin');
    state.block = 815123; // the demo calendar now has a block
    const upgraded = await ots.upgrade(pending.proof);
    line(`Status after upgrade: ${ots.describe(upgraded)}`);

    const detached = deserializeDetached(Buffer.from(upgraded.proof.ots as string, 'base64'));
    const s = summarize(detached);
    // In production merkleRootOf would query a Bitcoin header source; here the
    // demo commitment IS the block merkle root, so we assert that equality.
    const results = await confirmProofAgainstBitcoin(upgraded, async (h) =>
      h === state.block ? s.bitcoin[0].commitment : null,
    );
    line(`Bitcoin block ${results[0].height} commitment confirmed: ${results[0].ok}`);

    rule('What this proves');
    line('The ledger — and therefore every protected copy committed before the anchor —');
    line('existed no later than the anchored moment. With the OpenTimestamps proof upgraded');
    line('into Bitcoin, that priority is provable to anyone who trusts the Bitcoin chain,');
    line('with no need to trust us. The local anchor is non-repudiable as to the firm but');
    line('its clock is self-asserted; use OpenTimestamps when priority is contested.');
    line();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
