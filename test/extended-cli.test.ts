import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = mkdtempSync(join(tmpdir(), 'mm-cli-v2-'));
const VAULT = join(BASE, 'vault');
const MEMO = join(BASE, 'memo.txt');
const MARKED = join(BASE, 'marked.txt');
const BUNDLE = join(BASE, 'evidence.mattermark.json');
const PASS = 'correct horse battery staple';
writeFileSync(MEMO, SAMPLE, 'utf8');
after(() => rmSync(BASE, { recursive: true, force: true }));

function run(args: string[], opts: { pass?: string; vault?: string } = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'bin.ts'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      MATTERMARK_PASSPHRASE: opts.pass === undefined ? PASS : opts.pass,
      MATTERMARK_VAULT: opts.vault === undefined ? VAULT : opts.vault,
      NO_COLOR: '1',
    },
  });
}

test('setup fixture through the existing commands', () => {
  assert.equal(run(['init', '--org', 'Test LLP']).status, 0);
  const protectedResult = run([
    'protect', MEMO, '--matter', 'M-100', '--recipient', 'alice@example.com', '--out', MARKED,
  ]);
  assert.equal(protectedResult.status, 0, protectedResult.stderr);
  assert.ok(existsSync(MARKED));
});

test('preflight human and JSON modes compare profiles', () => {
  const human = run(['preflight', MEMO]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /durable/i);
  assert.match(human.stdout, /search-safe/i);
  assert.match(human.stdout, /Recommendation/i);

  const json = run(['preflight', MEMO, '--json']);
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.profiles.length, 2);
});

test('key, export, and vault-free verify work end to end', () => {
  const keyResult = run(['key', '--json']);
  assert.equal(keyResult.status, 0, keyResult.stderr);
  const key = JSON.parse(keyResult.stdout);
  assert.match(key.keyid, /^sha256:[0-9a-f]{64}$/);

  const rows = JSON.parse(run(['list', '--json']).stdout);
  const exported = run(['export', rows[0].shortIdHex, '--out', BUNDLE, '--artifact', MARKED]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.ok(existsSync(BUNDLE));
  assert.match(exported.stdout, /sensitive/i);
  assert.equal(JSON.parse(readFileSync(BUNDLE, 'utf8')).mediaType.includes('mattermark'), true);

  const verified = run(
    ['verify', BUNDLE, '--artifact', MARKED, '--expect-key', key.keyid, '--json'],
    { pass: '', vault: join(BASE, 'does-not-exist') },
  );
  assert.equal(verified.status, 0, verified.stderr);
  const result = JSON.parse(verified.stdout);
  assert.equal(result.valid, true);
  assert.equal(result.keyPinned, true);
  assert.equal(result.artifact.digestMatches, true);
  assert.equal(result.artifact.markMatches, true);
});

test('tampered bundle and usage errors fail cleanly', () => {
  const tamperedPath = join(BASE, 'tampered.json');
  const tampered = JSON.parse(readFileSync(BUNDLE, 'utf8'));
  tampered.envelope.payload = Buffer.from('not the statement').toString('base64');
  writeFileSync(tamperedPath, JSON.stringify(tampered));
  const invalid = run(['verify', tamperedPath], { pass: '', vault: join(BASE, 'none') });
  assert.equal(invalid.status, 1);
  assert.ok(!invalid.stderr.includes('\n    at '));

  const usage = run(['export']);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage:/);
});
