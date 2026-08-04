import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';

import {
  initWorkspace,
  openWorkspace,
  REGISTRY_FILE,
} from '../src/workspace.js';
import { evidenceKeyForWorkspace, exportWorkspaceEvidence } from '../src/workspace-evidence.js';
import {
  verifyEvidenceBundle,
  type MattermarkEvidenceBundle,
  type MattermarkEvidenceStatement,
} from '../src/evidence.js';
import { Scheme } from '../src/frame.js';
import { SAMPLE } from './helpers.js';

const PASS = 'correct horse battery staple';
const tmp = () => join(tmpdir(), `mattermark-evidence-${randomBytes(8).toString('hex')}`);

function statement(bundle: MattermarkEvidenceBundle): MattermarkEvidenceStatement {
  return JSON.parse(Buffer.from(bundle.envelope.payload, 'base64').toString('utf8')) as MattermarkEvidenceStatement;
}

test('protect records stable source and protected filenames for portable subjects', () => {
  const dir = tmp();
  try {
    const ws = initWorkspace(dir, PASS, { orgName: 'Test LLP' });
    const issued = ws.protect(
      { name: 'client brief.txt', bytes: Buffer.from(SAMPLE) },
      { matter: 'M-NAMES', recipient: 'alice@example.com' },
    );
    assert.equal(issued.copy.sourceName, 'client brief.txt');
    assert.equal(issued.copy.protectedName, issued.suggestedName);

    const reopened = openWorkspace(dir, PASS);
    assert.equal(reopened.resolve(issued.copy.tokenHex)?.sourceName, 'client brief.txt');
    assert.equal(reopened.resolve(issued.copy.tokenHex)?.protectedName, issued.suggestedName);

    const payload = statement(exportWorkspaceEvidence(reopened, issued.copy.shortIdHex));
    assert.equal(payload.subject[0].name, issued.suggestedName);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace exports signed evidence without mutating the ledger file', () => {
  const dir = tmp();
  try {
    const ws = initWorkspace(dir, PASS, { orgName: 'Test LLP' });
    const issued = ws.protect(
      { name: 'memo.txt', bytes: Buffer.from(SAMPLE) },
      { matter: 'M-1', recipient: 'alice@example.com' },
    );
    const beforeStatus = ws.status();
    const beforeBytes = readFileSync(join(dir, REGISTRY_FILE));
    const key = evidenceKeyForWorkspace(ws);
    const bundle = exportWorkspaceEvidence(ws, issued.copy.shortIdHex);
    assert.deepEqual(ws.status(), beforeStatus);
    assert.deepEqual(readFileSync(join(dir, REGISTRY_FILE)), beforeBytes);
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

    const payload = statement(bundle);
    assert.equal(payload.predicate.observation?.sha256, issued.copy.protectedHash);
    assert.equal(payload.predicate.observation?.recoveredToken, issued.copy.tokenHex);
    assert.equal(payload.predicate.observation?.confidence, 'confirmed');
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

test('historical anchors carry exact copy proofs and pre-copy anchors are disclosed', async () => {
  const dir = tmp();
  try {
    const ws = initWorkspace(dir, PASS, { orgName: 'Anchor LLP' });
    const first = ws.protect(
      { name: 'first.txt', bytes: Buffer.from(SAMPLE) },
      { matter: 'M-ANCHOR', recipient: 'first@example.com' },
    );
    const stored = await ws.anchorLedger(ws.localAnchor(), '2026-08-04T10:00:00.000Z');
    const second = ws.protect(
      { name: 'second.txt', bytes: Buffer.from(SAMPLE) },
      { matter: 'M-ANCHOR', recipient: 'second@example.com' },
    );

    const firstBundle = exportWorkspaceEvidence(ws, first.copy.tokenHex);
    const firstPayload = statement(firstBundle);
    assert.equal(firstPayload.predicate.ledger.anchors.length, 1);
    assert.equal(firstPayload.predicate.ledger.anchors[0].stored.merkleRoot, stored.merkleRoot);
    assert.equal(firstPayload.predicate.ledger.anchors[0].inclusion.proof.root, stored.merkleRoot);
    assert.equal(firstPayload.predicate.ledger.anchors[0].inclusion.proof.treeSize, stored.events);
    const firstVerified = verifyEvidenceBundle(firstBundle, {
      expectedKeyid: evidenceKeyForWorkspace(ws).keyid,
    });
    assert.equal(firstVerified.anchorResults[0]?.proofStatus, 'local-valid');

    const secondPayload = statement(exportWorkspaceEvidence(ws, second.copy.tokenHex));
    assert.equal(secondPayload.predicate.ledger.anchors.length, 0);
    assert.ok(
      secondPayload.predicate.disclosures.some((item) => /anchor.*predates this copy/i.test(item)),
      'an omitted pre-copy anchor must be explained rather than silently disappearing',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('investigation history is labeled as a signed snapshot, not a separately proven event set', () => {
  const dir = tmp();
  try {
    const ws = initWorkspace(dir, PASS);
    const issued = ws.protect(
      { name: 'memo.txt', bytes: Buffer.from(SAMPLE) },
      { matter: 'M-HISTORY', recipient: 'history@example.com' },
    );
    ws.addNote(issued.copy.tokenHex, {
      at: '2026-08-04T11:00:00.000Z',
      actor: 'reviewer',
      kind: 'note',
      detail: 'Reviewed recovered artifact.',
    });

    const payload = statement(exportWorkspaceEvidence(ws, issued.copy.tokenHex));
    assert.equal(payload.predicate.copy.investigations.length, 1);
    assert.ok(
      payload.predicate.disclosures.some(
        (item) => /investigation.*signed snapshot/i.test(item) && /not.*separately.*proven/i.test(item),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HMAC workspaces export pinned evidence with an explicit public-token limit', () => {
  const dir = tmp();
  try {
    const ws = initWorkspace(dir, PASS, { scheme: 'hmac' });
    const issued = ws.protect(
      { name: 'memo.txt', bytes: Buffer.from(SAMPLE) },
      { matter: 'M-HMAC', recipient: 'hmac@example.com' },
    );
    assert.equal(issued.copy.scheme, Scheme.HMAC_SHA256);

    const bundle = exportWorkspaceEvidence(ws, issued.copy.tokenHex, {
      artifact: { name: 'recovered.txt', bytes: issued.bytes },
    });
    assert.equal(statement(bundle).predicate.observation?.publicTokenVerification, false);
    const verified = verifyEvidenceBundle(bundle, {
      expectedKeyid: evidenceKeyForWorkspace(ws).keyid,
    });
    assert.equal(verified.valid, true, verified.errors.join('; '));
    assert.ok(
      verified.warnings.some((item) => /HMAC/i.test(item) && /not publicly self-verifying/i.test(item)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
