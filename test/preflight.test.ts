import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

import { initWorkspace } from '../src/workspace.js';
import { preflightWorkspaceDocument } from '../src/preflight.js';
import { buildTextPdf } from '../src/formats/pdf.js';
import { SAMPLE } from './helpers.js';

const PASS = 'correct horse battery staple';
const tmp = () => join(tmpdir(), `mattermark-preflight-${randomBytes(8).toString('hex')}`);

test('preflight compares durable and search-safe profiles without changing the vault', () => {
  const dir = tmp();
  try {
    const ws = initWorkspace(dir, PASS);
    const before = ws.status();
    const outcome = preflightWorkspaceDocument(ws, {
      name: 'memo.txt', bytes: Buffer.from(SAMPLE),
    });
    assert.deepEqual(ws.status(), before);
    assert.equal(outcome.format, 'text');
    assert.equal(outcome.profiles.length, 2);
    assert.equal(outcome.profiles[0].profile, 'durable');
    assert.equal(outcome.profiles[1].profile, 'search-safe');
    assert.equal(outcome.profiles[0].exactSearchPreserved, false);
    assert.equal(outcome.profiles[1].exactSearchPreserved, true);
    for (const profile of outcome.profiles) {
      assert.deepEqual(profile.excerpts.map((e) => e.fraction), [0.1, 0.2, 0.33, 0.5]);
      assert.ok(profile.excerpts.every((e) => e.windows >= 1 && e.rate >= 0 && e.rate <= 1));
    }
    assert.match(outcome.recommendation, /durable|search-safe|too small/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normal PDF preflight is blocked honestly and rebuilt PDF is non-durable', () => {
  const dir = tmp();
  try {
    const ws = initWorkspace(dir, PASS);
    const pdf = buildTextPdf(SAMPLE);
    const blocked = preflightWorkspaceDocument(ws, { name: 'memo.pdf', bytes: pdf });
    assert.equal(blocked.format, 'pdf');
    assert.equal(blocked.profiles.length, 0);
    assert.match(blocked.blockedReason ?? '', /rebuild|source document/i);

    const rebuilt = preflightWorkspaceDocument(ws, { name: 'memo.pdf', bytes: pdf }, { rebuildPdf: true });
    assert.equal(rebuilt.profiles.length, 1);
    assert.equal(rebuilt.profiles[0].durable, false);
    assert.ok(rebuilt.profiles[0].warnings.some((w) => /layout|normalized|non-durable/i.test(w)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight validates homoglyph density and handles short documents honestly', () => {
  const dir = tmp();
  try {
    const ws = initWorkspace(dir, PASS);
    assert.throws(
      () => preflightWorkspaceDocument(ws, { name: 'x.txt', bytes: Buffer.from('hello') }, { maxHomoglyphDensity: 2 }),
      /between 0 and 1/i,
    );
    const short = preflightWorkspaceDocument(ws, { name: 'x.txt', bytes: Buffer.from('hello world') });
    assert.ok(short.profiles.some((p) => p.markable === false || p.layers.every((l) => !l.embedded)));
    assert.match(short.recommendation, /too small|cannot|unsuitable/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
