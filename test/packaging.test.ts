/**
 * packaging.test.ts — proves the published artifact actually runs.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_BIN = join(ROOT, 'dist', 'bin.js');
const DIST_INDEX = join(ROOT, 'dist', 'index.js');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const CWD = mkdtempSync(join(tmpdir(), 'mm-pack-'));
after(() => rmSync(CWD, { recursive: true, force: true }));

function runBin(args: string[]) {
  return spawnSync(process.execPath, [DIST_BIN, ...args], {
    cwd: CWD,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

before(() => {
  const res = spawnSync(process.execPath, [TSC, '-p', join(ROOT, 'tsconfig.build.json')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300_000,
  });
  assert.equal(res.error, undefined, String(res.error));
  assert.equal(res.status, 0, `build failed:\n${res.stdout}\n${res.stderr}`);
  assert.ok(existsSync(DIST_BIN), 'dist/bin.js should exist after build');
});

test('the package and lockfile advertise the same release version', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages['']?.version, pkg.version);
});

test('the compiled bin keeps its shebang so it is directly executable', () => {
  assert.equal(readFileSync(DIST_BIN, 'utf8').split('\n', 1)[0], '#!/usr/bin/env node');
});

test('no compiled entry point imports tsx or a .ts path at runtime', () => {
  for (const file of ['bin.js', 'cli.js', 'cli-entry.js', 'index.js']) {
    const source = readFileSync(join(ROOT, 'dist', file), 'utf8');
    assert.ok(!/\btsx\b/.test(source), `${file} must not reference tsx`);
    assert.ok(!/from\s+['"][^'"]+\.ts['"]/.test(source), `${file} must not import a .ts path`);
  }
});

test('node dist/bin.js help prints the complete command surface and exits 0', () => {
  const res = runBin(['help']);
  assert.equal(res.error, undefined);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Usage: mattermark/);
  assert.match(res.stdout, /Commands:/);
  for (const command of ['preflight', 'key', 'export', 'verify']) {
    assert.match(res.stdout, new RegExp(`\\b${command}\\b`), `general help must list ${command}`);
  }
});

test('compiled extended-command help is available', () => {
  for (const command of ['preflight', 'key', 'export', 'verify']) {
    const res = runBin(['help', command]);
    assert.equal(res.status, 0, `${command}: ${res.stderr}`);
    assert.match(res.stdout, new RegExp(`Usage: mattermark ${command}`));
  }
});

test('compiled library exports the portable evidence and Merkle APIs', async () => {
  const api = await import(pathToFileURL(DIST_INDEX).href);
  for (const name of [
    'verifyEvidenceBundle',
    'parseEvidenceBundle',
    'exportWorkspaceEvidence',
    'preflightWorkspaceDocument',
    'createMerkleProof',
    'verifyMerkleProof',
  ]) {
    assert.equal(typeof api[name], 'function', `${name} must be exported`);
  }
});

test('node dist/bin.js with an unknown command exits 2', () => {
  const res = runBin(['frobnicate']);
  assert.equal(res.error, undefined);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Unknown command/);
  assert.match(res.stderr, /Usage: mattermark/);
});

test('node dist/bin.js status with no vault exits 1 with a friendly line', () => {
  const res = runBin(['status']);
  assert.equal(res.error, undefined);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /No vault at/);
  assert.ok(!res.stderr.includes('\n    at '));
});
