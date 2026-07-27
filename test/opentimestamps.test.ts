import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  openTimestampsCliAnchor,
  type AnchorProof,
  type OtsCommandResult,
  type OtsRunner,
} from '../src/ledger/anchor.js';
import { SecureRegistry } from '../src/ledger/index.js';
import { Scheme } from '../src/frame.js';
import type { ProtectedCopy } from '../src/registry.js';

const DIGEST = 'ab'.repeat(32);
const AT = '2026-07-27T16:00:00.000Z';


function row(tokenHex: string, shortIdHex: string): ProtectedCopy {
  return {
    tokenHex,
    shortIdHex,
    scheme: Scheme.HMAC_SHA256,
    identity: {
      matterRef: 'MATTER-ANCHOR',
      recipientId: `${tokenHex}@example.com`,
      version: 'v1',
      issuedAt: AT,
      nonce: `nonce-${tokenHex}`,
    },
    originalHash: `original-${tokenHex}`,
    protectedHash: `protected-${tokenHex}`,
    generatedBy: 'anchor-test',
    generatedAt: AT,
    channels: [],
    deliveryMethod: 'email',
    transformTests: [],
    investigations: [],
  };
}

interface ScriptedRunner {
  runner: OtsRunner;
  calls: Array<{ args: string[]; cwd: string }>;
}

function material(proof: AnchorProof): {
  format: string;
  statement: string;
  ots: string;
} {
  return proof.proof as { format: string; statement: string; ots: string };
}

function scriptedRunner(states: string[]): ScriptedRunner {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runner: OtsRunner = (args, cwd): OtsCommandResult => {
    calls.push({ args: [...args], cwd });
    const operation = args[0];

    if (operation === 'stamp') {
      const target = join(cwd, args.at(-1)!);
      writeFileSync(`${target}.ots`, Buffer.from('pending-proof'));
      return { status: 0, stdout: 'Submitting to remote calendar\n', stderr: '' };
    }

    if (operation === 'verify') {
      const state = states.shift() ?? 'pending';
      if (state === 'verified') {
        return {
          status: 0,
          stdout:
            'Success! Bitcoin block 999999 attests existence as of 2026-07-27 UTC\n',
          stderr: '',
        };
      }
      if (state === 'pending') {
        return {
          status: 1,
          stdout: '',
          stderr: 'Pending confirmation in Bitcoin blockchain\n',
        };
      }
      return {
        status: 1,
        stdout: '',
        stderr: 'File does not match timestamp\n',
      };
    }

    if (operation === 'upgrade') {
      const proofPath = join(cwd, args.at(-1)!);
      writeFileSync(
        proofPath,
        Buffer.concat([readFileSync(proofPath), Buffer.from('-upgraded')]),
      );
      return { status: 0, stdout: 'Success! Timestamp is complete\n', stderr: '' };
    }

    throw new Error(`unexpected OpenTimestamps operation ${operation}`);
  };
  return { runner, calls };
}

test('OpenTimestamps commit creates a detached proof bound to the root and request time', () => {
  const { runner, calls } = scriptedRunner([]);
  const anchor = openTimestampsCliAnchor({ runner });
  const proof = anchor.commit(DIGEST.toUpperCase(), AT);
  const proofMaterial = material(proof);

  assert.equal(anchor.thirdPartyTime, true);
  assert.equal(proof.anchor, 'opentimestamps-bitcoin-v1');
  assert.equal(proof.digest, DIGEST);
  assert.equal(proof.at, AT);
  assert.equal(proofMaterial.format, 'opentimestamps-file-v1');
  assert.equal(Buffer.from(proofMaterial.ots, 'base64').toString(), 'pending-proof');
  assert.equal(calls[0].args[0], 'stamp');
  assert.equal(basename(calls[0].args.at(-1)!), 'mattermark-anchor.json');
  assert.equal(
    proofMaterial.statement,
    JSON.stringify({
      domain: 'mattermark.anchor.v1',
      digest: DIGEST,
      requestedAt: AT,
    }),
  );
});

test('OpenTimestamps inspection distinguishes pending from Bitcoin-confirmed proof', () => {
  const { runner } = scriptedRunner(['pending', 'verified', 'verified']);
  const anchor = openTimestampsCliAnchor({ runner });
  const proof = anchor.commit(DIGEST, AT);

  assert.deepEqual(anchor.inspect(proof), {
    status: 'pending',
    valid: false,
    thirdPartyTime: false,
    detail: 'Pending confirmation in Bitcoin blockchain',
  });
  assert.equal(anchor.verify(proof), true);

  const confirmed = anchor.inspect(proof);
  assert.equal(confirmed.status, 'verified');
  assert.equal(confirmed.valid, true);
  assert.equal(confirmed.thirdPartyTime, true);
  assert.equal(confirmed.blockHeight, 999999);
  assert.equal(confirmed.attestedAt, '2026-07-27 UTC');
});

test('OpenTimestamps requires a successful verifier exit before accepting success text', () => {
  const runner: OtsRunner = (args, cwd) => {
    if (args[0] === 'stamp') {
      const target = join(cwd, args.at(-1)!);
      writeFileSync(`${target}.ots`, Buffer.from('pending-proof'));
      return { status: 0, stdout: '', stderr: '' };
    }
    return {
      status: 1,
      stdout:
        'Success! Bitcoin block 999999 attests existence as of 2026-07-27 UTC\n',
      stderr: 'verification failed\n',
    };
  };
  const anchor = openTimestampsCliAnchor({ runner });
  const proof = anchor.commit(DIGEST, AT);

  const inspected = anchor.inspect(proof);
  assert.equal(inspected.status, 'invalid');
  assert.equal(inspected.valid, false);
});

test('OpenTimestamps proof binding is checked before invoking the CLI', () => {
  const { runner, calls } = scriptedRunner([]);
  const anchor = openTimestampsCliAnchor({ runner });
  const proof = anchor.commit(DIGEST, AT);
  const before = calls.length;

  const forged = { ...proof, digest: 'cd'.repeat(32) };
  const inspected = anchor.inspect(forged);
  assert.equal(inspected.status, 'invalid');
  assert.equal(inspected.valid, false);
  assert.equal(calls.length, before);
});

test('OpenTimestamps refresh returns upgraded bytes without mutating the input proof', () => {
  const { runner } = scriptedRunner([]);
  const anchor = openTimestampsCliAnchor({ runner });
  const proof = anchor.commit(DIGEST, AT);
  const refreshed = anchor.refresh(proof);

  assert.equal(Buffer.from(material(proof).ots, 'base64').toString(), 'pending-proof');
  assert.equal(
    Buffer.from(material(refreshed).ots, 'base64').toString(),
    'pending-proof-upgraded',
  );
});



test('SecureRegistry consumes the OpenTimestamps provider through the existing Anchor interface', () => {
  const { runner } = scriptedRunner(['pending', 'verified']);
  const anchor = openTimestampsCliAnchor({ runner });
  const directory = mkdtempSync(join(tmpdir(), 'mattermark-ots-registry-'));
  const path = join(directory, 'matter.reg');

  try {
    const registry = SecureRegistry.create(path, 'test-passphrase');
    const proof = registry.anchor(anchor, AT);
    assert.equal(registry.verifyAnchor(anchor, proof), false);
    assert.equal(registry.verifyAnchor(anchor, proof), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('OpenTimestamps missing CLI is reported clearly', () => {
  const runner: OtsRunner = () => ({
    status: null,
    stdout: '',
    stderr: '',
    error: new Error('spawn ots ENOENT'),
  });
  const anchor = openTimestampsCliAnchor({ runner });

  assert.throws(
    () => anchor.commit(DIGEST, AT),
    /OpenTimestamps CLI.*unavailable/i,
  );
});


test('anchored checkpoints remain verifiable after the ledger grows', () => {
  const { runner } = scriptedRunner(['verified', 'verified']);
  const anchor = openTimestampsCliAnchor({ runner });
  const directory = mkdtempSync(join(tmpdir(), 'mattermark-ots-checkpoint-'));
  const path = join(directory, 'matter.reg');

  try {
    const registry = SecureRegistry.create(path, 'test-passphrase');
    registry.add(row('aa', 'bb'), AT);
    const checkpoint = registry.anchorCheckpoint(anchor, AT);

    assert.equal(checkpoint.format, 'mattermark-anchor-checkpoint-v1');
    assert.equal(registry.verifyAnchorCheckpoint(anchor, checkpoint), true);
    registry.add(row('cc', 'dd'), '2026-07-27T17:00:00.000Z');

    assert.equal(registry.verifyAnchor(anchor, checkpoint.proof), false);
    assert.equal(registry.verifyAnchorCheckpoint(anchor, checkpoint), true);
    assert.equal(
      registry.verifyAnchorCheckpoint(anchor, {
        ...checkpoint,
        head: '00'.repeat(32),
      }),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
