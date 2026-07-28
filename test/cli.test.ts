/**
 * cli.test.ts — end-to-end tests of the command line, driven as a real
 * subprocess so exit codes, stdout/stderr routing, and env handling are all
 * exercised for real. Each spawn pays the tsx startup cost, so the suite
 * builds up one shared vault across ordered tests instead of re-initializing
 * per test.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = mkdtempSync(join(tmpdir(), 'mm-cli-'));
const VAULT = join(BASE, 'vault');
const MEMO = join(BASE, 'memo.txt');
const MARKED = join(BASE, 'marked.txt');
const PASS = 'correct horse battery staple';

writeFileSync(MEMO, SAMPLE, 'utf8');
after(() => rmSync(BASE, { recursive: true, force: true }));

function run(args: string[], opts: { pass?: string } = {}) {
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), ...args],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        MATTERMARK_PASSPHRASE: opts.pass ?? PASS,
        MATTERMARK_VAULT: VAULT,
        NO_COLOR: '1',
      },
    },
  );
  assert.equal(res.error, undefined);
  return res;
}

test('init creates a vault', () => {
  const res = run(['init', '--org', 'Test LLP']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(join(VAULT, 'config.json')));
  assert.ok(existsSync(join(VAULT, 'registry.mmv')));
  assert.match(res.stdout, /Vault created/);
  assert.match(res.stdout, /Test LLP/);
});

test('init refuses to overwrite an existing vault: exit 1, no stack trace', () => {
  const res = run(['init']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /already exists/);
  assert.ok(!res.stderr.includes('\n    at '));
});

test('protect writes a marked copy and summarizes what was embedded', () => {
  const res = run([
    'protect', MEMO,
    '--matter', 'M-100',
    '--recipient', 'alice@example.com',
    '--delivery', 'email',
    '--out', MARKED,
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(MARKED));
  assert.notEqual(readFileSync(MARKED, 'utf8'), SAMPLE); // actually marked
  assert.match(res.stdout, /alice@example\.com/);
  assert.match(res.stdout, /survived \d+ of \d+ simulated transformations/);
  // the homoglyph search-impact disclosure must reach the operator
  assert.match(res.stdout, /WARNING: HOMOGLYPH CHANNEL ACTIVE/);
});

test('identify attributes the marked copy: CONFIRMED, right recipient', () => {
  const res = run(['identify', MARKED]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /CONFIRMED/);
  assert.match(res.stdout, /cryptographically verified/);
  assert.match(res.stdout, /alice@example\.com/);
});

test('identify --json is machine-readable', () => {
  const res = run(['identify', MARKED, '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.attribution.confidence, 'confirmed');
  assert.equal(out.attribution.copy.identity.recipientId, 'alice@example.com');
});

test('identify on an unmarked file finds nothing and still exits 0', () => {
  const res = run(['identify', MEMO]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /No mark was found/);
  assert.match(res.stdout, /sanitization/);
});

test('list shows the protected copy', () => {
  const res = run(['list']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /M-100/);
  assert.match(res.stdout, /alice@example\.com/);
});

test('report --json returns the structured evidence report', () => {
  const listed = run(['list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout);
  assert.equal(rows.length, 1);

  const res = run(['report', rows[0].shortIdHex, '--json']);
  assert.equal(res.status, 0, res.stderr);
  const rep = JSON.parse(res.stdout);
  assert.equal(rep.copy.identity.matterRef, 'M-100');
  assert.equal(rep.copy.identity.recipientId, 'alice@example.com');
  assert.equal(rep.ledger.chainOk, true);
});

test('status reports a verified chain', () => {
  const res = run(['status']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Test LLP/);
  assert.match(res.stdout, /Chain verified\s+yes/);
  assert.match(res.stdout, /Merkle root\s+[0-9a-f]{64}/);
});

test('unknown command is a usage error: exit 2, usage on stderr', () => {
  const res = run(['frobnicate']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Unknown command/);
  assert.match(res.stderr, /Usage: mattermark/);
});

test('wrong passphrase fails with a friendly one-line message', () => {
  const res = run(['status'], { pass: 'not-the-passphrase' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Could not unlock the vault/);
  assert.ok(!res.stderr.includes('\n    at '));
});
