/**
 * packaging.test.ts — proves the published artifact actually runs.
 *
 * Everything else in the suite runs the TypeScript sources under tsx. This
 * test does the opposite: it compiles src/ to plain ESM JavaScript in dist/
 * (exactly what `npm run build` / `prepack` ships) and then executes the
 * compiled bin with a bare `node dist/bin.js` — no --import tsx, no ts at
 * runtime. If this passes, `npx mattermark` and a global install work.
 *
 * It is deliberately a little slow: one real `tsc` invocation up front.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_BIN = join(ROOT, 'dist', 'bin.js');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

// A throwaway working directory: the bin must run from anywhere, and with no
// vault present so it never touches or creates real evidence files here.
const CWD = mkdtempSync(join(tmpdir(), 'mm-pack-'));
after(() => rmSync(CWD, { recursive: true, force: true }));

/** Run the *compiled* bin under plain node — no tsx, no TypeScript loader. */
function runBin(args: string[]) {
  return spawnSync(process.execPath, [DIST_BIN, ...args], {
    cwd: CWD,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

before(() => {
  // Build into the repo's dist/ using the project's own build config. Invoke
  // tsc directly via node so the test does not depend on npm being on PATH.
  const res = spawnSync(process.execPath, [TSC, '-p', join(ROOT, 'tsconfig.build.json')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300_000,
  });
  assert.equal(res.error, undefined, String(res.error));
  assert.equal(res.status, 0, `build failed:\n${res.stdout}\n${res.stderr}`);
  assert.ok(existsSync(DIST_BIN), 'dist/bin.js should exist after build');
});

test('the compiled bin keeps its shebang so it is directly executable', () => {
  const first = readFileSync(DIST_BIN, 'utf8').split('\n', 1)[0];
  assert.equal(first, '#!/usr/bin/env node');
});

test('no compiled file imports tsx or a .ts path at runtime', () => {
  // A distribution that reaches for tsx or a .ts specifier would break under
  // plain node. Spot-check the two entry points that pull the graph in.
  for (const f of ['bin.js', 'cli.js', 'index.js']) {
    const src = readFileSync(join(ROOT, 'dist', f), 'utf8');
    assert.ok(!/\btsx\b/.test(src), `${f} must not reference tsx`);
    assert.ok(!/from\s+['"][^'"]+\.ts['"]/.test(src), `${f} must not import a .ts path`);
  }
});

test('node dist/bin.js help prints usage and exits 0 — no tsx involved', () => {
  const res = runBin(['help']);
  assert.equal(res.error, undefined);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Usage: mattermark/);
  assert.match(res.stdout, /Commands:/);
});

test('node dist/bin.js with an unknown command exits 2 (usage error)', () => {
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
  assert.ok(!res.stderr.includes('\n    at '), 'no stack trace on an expected failure');
});
