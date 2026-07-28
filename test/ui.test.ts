import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

import { startUi } from '../src/ui/server.js';
import { initWorkspace, Workspace } from '../src/workspace.js';
import { buildTextPdf } from '../src/formats/pdf.js';
import { SAMPLE } from './helpers.js';

const PASS = 'correct horse battery staple';

function tmpDir(): string {
  return join(tmpdir(), 'miy-ui-' + randomBytes(8).toString('hex'));
}

interface UiCtx {
  ws: Workspace;
  base: string;
  token: string;
  url: string;
}

/** Start a UI server on an ephemeral port over a fresh workspace; always clean up. */
async function withUi(fn: (ctx: UiCtx) => Promise<void>): Promise<void> {
  const dir = tmpDir();
  const ws = initWorkspace(dir, PASS, { orgName: 'Test LLP' });
  const ui = await startUi(ws, { port: 0 });
  try {
    const u = new URL(ui.url);
    const token = u.searchParams.get('k');
    assert.ok(token, 'startup URL carries the k token');
    assert.equal(u.hostname, '127.0.0.1');
    await fn({ ws, base: u.origin, token: token!, url: ui.url });
  } finally {
    await ui.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function post(ctx: UiCtx, path: string, body: unknown): Promise<Response> {
  return fetch(`${ctx.base}${path}?k=${ctx.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('requests without the token are refused with 403', async () => {
  await withUi(async (ctx) => {
    const page = await fetch(`${ctx.base}/`);
    assert.equal(page.status, 403);
    const body = (await page.json()) as { error: string };
    assert.ok(body.error.length > 0);

    const wrong = await fetch(`${ctx.base}/api/status?k=not-the-token`);
    assert.equal(wrong.status, 403);
  });
});

test('the page and status endpoints serve with the token', async () => {
  await withUi(async (ctx) => {
    const page = await fetch(ctx.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();
    assert.ok(html.includes('Mattermark'));

    const st = await fetch(`${ctx.base}/api/status?k=${ctx.token}`);
    assert.equal(st.status, 200);
    const status = (await st.json()) as { chainOk: boolean; copies: number; config: { orgName: string } };
    assert.equal(status.chainOk, true);
    assert.equal(status.copies, 0);
    assert.equal(status.config.orgName, 'Test LLP');
  });
});

test('protect -> identify -> report round-trip over HTTP', async () => {
  await withUi(async (ctx) => {
    const protectRes = await post(ctx, '/api/protect', {
      name: 'memo.txt',
      dataBase64: Buffer.from(SAMPLE, 'utf8').toString('base64'),
      matter: 'M-100',
      recipient: 'alice@example.com',
      delivery: 'email',
      note: 'sent under protective order',
      by: 'paralegal',
    });
    assert.equal(protectRes.status, 200);
    const protectOut = (await protectRes.json()) as {
      suggestedName: string;
      dataBase64: string;
      format: string;
      durable: boolean;
      survivalRate: number;
      warnings: string[];
      tokenHex: string;
      copy: { identity: { recipientId: string } };
    };
    assert.equal(protectOut.durable, true);
    assert.equal(protectOut.format, 'text');
    assert.equal(protectOut.suggestedName, 'memo--alice-example-com.txt');
    assert.ok(protectOut.survivalRate > 0);
    assert.ok(protectOut.warnings.some((w) => w.includes('HOMOGLYPH')));

    // base64 roundtrip: the marked bytes decode and differ from the input
    const marked = Buffer.from(protectOut.dataBase64, 'base64');
    assert.ok(marked.length > 0);
    assert.notEqual(marked.toString('utf8'), SAMPLE);

    // identify the marked bytes → confirmed attribution
    const identifyRes = await post(ctx, '/api/identify', {
      name: 'leak.txt',
      dataBase64: protectOut.dataBase64,
      record: true,
      by: 'investigator',
      source: 'posted to pastebin',
    });
    assert.equal(identifyRes.status, 200);
    const found = (await identifyRes.json()) as {
      anyRecovered: boolean;
      attribution?: { confidence: string; copy?: { identity: { recipientId: string } } };
    };
    assert.equal(found.anyRecovered, true);
    assert.equal(found.attribution?.confidence, 'confirmed');
    assert.equal(found.attribution?.copy?.identity.recipientId, 'alice@example.com');

    // evidence report renders and names the recipient
    const reportRes = await post(ctx, '/api/report', { token: protectOut.tokenHex });
    assert.equal(reportRes.status, 200);
    const report = (await reportRes.json()) as { markdown: string; report: { copy: { tokenHex: string } } };
    assert.ok(report.markdown.includes('alice@example.com'));
    assert.equal(report.report.copy.tokenHex, protectOut.tokenHex);

    // the copies listing reflects the issued copy
    const copiesRes = await fetch(`${ctx.base}/api/copies?k=${ctx.token}`);
    assert.equal(copiesRes.status, 200);
    const copies = (await copiesRes.json()) as { copies: Array<{ identity: { recipientId: string } }> };
    assert.equal(copies.copies.length, 1);
    assert.equal(copies.copies[0].identity.recipientId, 'alice@example.com');
  });
});

test('identify on an unmarked document recovers nothing', async () => {
  await withUi(async (ctx) => {
    const res = await post(ctx, '/api/identify', {
      name: 'clean.txt',
      dataBase64: Buffer.from(SAMPLE, 'utf8').toString('base64'),
    });
    assert.equal(res.status, 200);
    const found = (await res.json()) as { anyRecovered: boolean; matches: unknown[] };
    assert.equal(found.anyRecovered, false);
    assert.equal(found.matches.length, 0);
  });
});

test('protecting a PDF fails with 400 and an actionable message', async () => {
  await withUi(async (ctx) => {
    const res = await post(ctx, '/api/protect', {
      name: 'brief.pdf',
      dataBase64: buildTextPdf('hello there').toString('base64'),
      matter: 'M-1',
      recipient: 'r@x.com',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /mark the DOCX\/text source|rebuildPdf/i);
  });
});

test('validation and routing errors are JSON with proper statuses', async () => {
  await withUi(async (ctx) => {
    // missing required field
    const missing = await post(ctx, '/api/protect', { name: 'x.txt', dataBase64: 'aGk=', matter: 'M-1' });
    assert.equal(missing.status, 400);
    assert.match(((await missing.json()) as { error: string }).error, /recipient/);

    // malformed JSON body
    const bad = await fetch(`${ctx.base}/api/identify?k=${ctx.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /JSON/);

    // unknown API path
    const nope = await fetch(`${ctx.base}/api/nope?k=${ctx.token}`);
    assert.equal(nope.status, 404);
    assert.ok(((await nope.json()) as { error: string }).error.length > 0);

    // wrong method on a known path
    const wrongMethod = await fetch(`${ctx.base}/api/status?k=${ctx.token}`, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
  });
});

test('search-safe protect over HTTP is non-durable and says so', async () => {
  await withUi(async (ctx) => {
    const res = await post(ctx, '/api/protect', {
      name: 'm.txt',
      dataBase64: Buffer.from(SAMPLE, 'utf8').toString('base64'),
      matter: 'M-1',
      recipient: 'a@x.com',
      searchSafe: true,
    });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { durable: boolean; warnings: string[]; dataBase64: string };
    assert.equal(out.durable, false);
    assert.ok(out.warnings.some((w) => w.includes('NON-DURABLE')));

    // the mark still recovers from the untransformed copy
    const found = await post(ctx, '/api/identify', { name: 'l.txt', dataBase64: out.dataBase64 });
    const outcome = (await found.json()) as { attribution?: { confidence: string } };
    assert.equal(outcome.attribution?.confidence, 'confirmed');
  });
});
