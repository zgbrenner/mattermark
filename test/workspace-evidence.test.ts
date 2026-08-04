import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

import { initWorkspace } from '../src/workspace.js';
import { evidenceKeyForWorkspace, exportWorkspaceEvidence } from '../src/workspace-evidence.js';
import { verifyEvidenceBundle } from '../src/evidence.js';
import { SAMPLE } from './helpers.js';

const PASS = 'correct horse battery staple';
const tmp = () => join(tmpdir(), `mattermark-evidence-${randomBytes(8).toString('hex')}`);

test('workspace exports signed evidence without mutating the ledger', () => {
  const dir = tmp();
  try {
    const ws = initWorkspace(dir, PASS, { orgName: 'Test LLP' });
    const issued = ws.protect(
      { name: 'memo.txt', bytes: Buffer.from(SAMPLE) },
      { matter: 'M-1', recipient: 'alice@example.com' },
    );
    const before = ws.status();
    const key = evidenceKeyForWorkspace(ws);
    const bundle = exportWorkspaceEvidence(ws, issued.copy.shortIdHex);
    assert.deepEqual(ws.status(), before);
    assert.match(key.keyid, /^sha256:[0-9a-f]{64}$/);

    const verified = verifyEvidenceBundle(bundle, { expectedKeyid: key.keyid });
    assert.equal(verified.valid, true, verified.errors.join('; '));
    assert.equal(verified.trust, 'key-pinned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace evidence binds a recovered artifact without recording an investigation', () => {
  const dir = tmp();
  try {
    const ws = initWorkspace(dir, PASS);
    const issued = ws.protect(
      { name: 'memo.txt', bytes: Buffer.from(SAMPLE) },
      { matter: 'M-2', recipient: 'bob@example.com' },
    );
    const before = ws.status();
    const bundle = exportWorkspaceEvidence(ws, issued.copy.tokenHex, {
      artifact: { name: 'recovered.txt', bytes: issued.bytes },
    });
    assert.deepEqual(ws.status(), before);

    const statement = JSON.parse(Buffer.from(bundle.envelope.payload, 'base64').toString('utf8'));
    assert.equal(statement.predicate.observation.sha256, issued.copy.protectedHash);
    assert.equal(statement.predicate.observation.recoveredToken, issued.copy.tokenHex);
    assert.equal(statement.predicate.observation.confidence, 'confirmed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace refuses to bind an unmarked or different-copy artifact', () => {
  const dir = tmp();
  try {
    const ws = initWorkspace(dir, PASS);
    const a = ws.protect(
      { name: 'memo.txt', bytes: Buffer.from(SAMPLE) },
      { matter: 'M-3', recipient: 'a@example.com' },
    );
    const b = ws.protect(
      { name: 'memo.txt', bytes: Buffer.from(SAMPLE) },
      { matter: 'M-3', recipient: 'b@example.com' },
    );
    assert.throws(
      () => exportWorkspaceEvidence(ws, a.copy.tokenHex, { artifact: { name: 'clean.txt', bytes: Buffer.from(SAMPLE) } }),
      /does not attribute/i,
    );
    assert.throws(
      () => exportWorkspaceEvidence(ws, a.copy.tokenHex, { artifact: { name: 'other.txt', bytes: b.bytes } }),
      /different protected copy/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
