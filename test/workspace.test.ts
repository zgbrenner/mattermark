import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import {
  initWorkspace,
  openWorkspace,
  workspaceExists,
  sniffFormat,
  slug,
  renderReportMarkdown,
  Workspace,
} from '../src/workspace.js';
import { textToDocx } from '../src/formats/index.js';
import { buildTextPdf } from '../src/formats/pdf.js';
import { SAMPLE } from './helpers.js';

const PASS = 'correct horse battery staple';

function tmpDir(): string {
  return join(tmpdir(), 'miy-ws-' + randomBytes(8).toString('hex'));
}

function withWorkspace(fn: (ws: Workspace, dir: string) => void): void {
  const dir = tmpDir();
  try {
    fn(initWorkspace(dir, PASS, { orgName: 'Test LLP' }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('sniffFormat distinguishes docx, pdf, and text', () => {
  assert.equal(sniffFormat(textToDocx('hello')), 'docx');
  assert.equal(sniffFormat(buildTextPdf('hello')), 'pdf');
  assert.equal(sniffFormat(Buffer.from('plain words', 'utf8')), 'text');
});

test('slug is filesystem-safe', () => {
  assert.equal(slug('Jane Q. Doe <jane@example.com>'), 'jane-q-doe-jane-example-com');
  assert.equal(slug('___'), 'recipient');
});

test('init refuses weak passphrases and double-init', () => {
  const dir = tmpDir();
  try {
    assert.throws(() => initWorkspace(dir, 'short'), /at least 8/);
    initWorkspace(dir, PASS);
    assert.ok(workspaceExists(dir));
    assert.throws(() => initWorkspace(dir, PASS), /already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('open fails cleanly on a wrong passphrase', () => {
  const dir = tmpDir();
  try {
    initWorkspace(dir, PASS);
    assert.throws(() => openWorkspace(dir, 'not-the-passphrase'), /decryption failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('protect -> identify round-trip on plain text, confirmed attribution', () => {
  withWorkspace((ws) => {
    const out = ws.protect(
      { name: 'memo.txt', bytes: Buffer.from(SAMPLE, 'utf8') },
      { matter: 'M-100', recipient: 'alice@example.com', deliveryMethod: 'email' },
    );
    assert.ok(out.result.durable);
    assert.equal(out.suggestedName, 'memo--alice-example-com.txt');
    assert.ok(out.survivalRate > 0);

    const found = ws.identify({ name: 'leak.txt', bytes: out.bytes });
    assert.ok(found.anyRecovered);
    assert.ok(found.attribution);
    assert.equal(found.attribution!.confidence, 'confirmed');
    assert.equal(found.attribution!.copy!.identity.recipientId, 'alice@example.com');
    assert.equal(found.attribution!.copy!.identity.matterRef, 'M-100');
  });
});

test('protect -> identify round-trip on DOCX', () => {
  withWorkspace((ws) => {
    const out = ws.protect(
      { name: 'brief.docx', bytes: textToDocx(SAMPLE) },
      { matter: 'M-200', recipient: 'bob@example.com' },
    );
    assert.equal(out.format, 'docx');
    assert.equal(sniffFormat(out.bytes), 'docx');

    const found = ws.identify({ name: 'recovered.docx', bytes: out.bytes });
    assert.equal(found.format, 'docx');
    assert.equal(found.attribution?.copy?.identity.recipientId, 'bob@example.com');
  });
});

test('two recipients of the same document attribute separately', () => {
  withWorkspace((ws) => {
    const src = Buffer.from(SAMPLE, 'utf8');
    const a = ws.protect({ name: 'd.txt', bytes: src }, { matter: 'M-1', recipient: 'a@x.com' });
    const b = ws.protect({ name: 'd.txt', bytes: src }, { matter: 'M-1', recipient: 'b@x.com' });
    assert.notEqual(a.copy.tokenHex, b.copy.tokenHex);

    assert.equal(ws.identify({ name: 'l', bytes: a.bytes }).attribution?.copy?.identity.recipientId, 'a@x.com');
    assert.equal(ws.identify({ name: 'l', bytes: b.bytes }).attribution?.copy?.identity.recipientId, 'b@x.com');
    assert.equal(ws.byMatter('M-1').length, 2);
  });
});

test('search-safe mode embeds no homoglyphs and reports non-durable', () => {
  withWorkspace((ws) => {
    const out = ws.protect(
      { name: 'm.txt', bytes: Buffer.from(SAMPLE, 'utf8') },
      { matter: 'M-1', recipient: 'a@x.com', searchSafe: true },
    );
    assert.equal(out.result.durable, false);
    assert.ok(out.result.warnings.some((w) => w.includes('NON-DURABLE')));
    assert.ok(!out.result.layers.some((l) => l.codec === 'HG' && l.embedded));
    // marks must still recover from the untransformed copy
    assert.equal(ws.identify({ name: 'l', bytes: out.bytes }).attribution?.confidence, 'confirmed');
  });
});

test('protect refuses PDFs with an actionable message', () => {
  withWorkspace((ws) => {
    assert.throws(
      () => ws.protect({ name: 'x.pdf', bytes: buildTextPdf('hello') }, { matter: 'M', recipient: 'r' }),
      /Mark the DOCX source/,
    );
  });
});

test('identify reads marks out of a PDF text layer', () => {
  withWorkspace((ws) => {
    const out = ws.protect(
      { name: 'm.txt', bytes: Buffer.from(SAMPLE, 'utf8') },
      { matter: 'M-PDF', recipient: 'carol@x.com' },
    );
    // simulate "marked DOCX exported to PDF": marked text carried into a PDF
    const pdf = buildTextPdf(out.result.text);
    const found = ws.identify({ name: 'leak.pdf', bytes: pdf });
    assert.equal(found.format, 'pdf');
    assert.equal(found.attribution?.copy?.identity.recipientId, 'carol@x.com');
  });
});

test('identify on an unmarked document recovers nothing', () => {
  withWorkspace((ws) => {
    const found = ws.identify({ name: 'clean.txt', bytes: Buffer.from(SAMPLE, 'utf8') });
    assert.equal(found.anyRecovered, false);
    assert.equal(found.matches.length, 0);
    assert.equal(found.attribution, undefined);
  });
});

test('a mark from a foreign workspace is unrecognized, not misattributed', () => {
  const dirA = tmpDir();
  const dirB = tmpDir();
  try {
    const a = initWorkspace(dirA, PASS);
    const b = initWorkspace(dirB, PASS);
    const out = a.protect(
      { name: 'm.txt', bytes: Buffer.from(SAMPLE, 'utf8') },
      { matter: 'M-A', recipient: 'a@x.com' },
    );
    const found = b.identify({ name: 'l', bytes: out.bytes });
    assert.ok(found.anyRecovered);
    assert.equal(found.attribution, undefined);
    assert.ok(found.matches.every((m) => m.confidence === 'unrecognized'));
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('identify with record=true appends an investigation event that persists', () => {
  const dir = tmpDir();
  try {
    const ws = initWorkspace(dir, PASS);
    const out = ws.protect(
      { name: 'm.txt', bytes: Buffer.from(SAMPLE, 'utf8') },
      { matter: 'M-1', recipient: 'a@x.com' },
    );
    ws.identify(
      { name: 'leak.txt', bytes: out.bytes },
      { record: true, actor: 'investigator', sourceDescription: 'posted to pastebin' },
    );

    const reopened = openWorkspace(dir, PASS);
    const row = reopened.resolve(out.copy.tokenHex);
    assert.equal(row?.investigations.length, 1);
    assert.equal(row?.investigations[0].kind, 'detection');
    assert.equal(row?.investigations[0].actor, 'investigator');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hmac-scheme workspace also round-trips with confirmed attribution', () => {
  const dir = tmpDir();
  try {
    const ws = initWorkspace(dir, PASS, { scheme: 'hmac' });
    const out = ws.protect(
      { name: 'm.txt', bytes: Buffer.from(SAMPLE, 'utf8') },
      { matter: 'M-1', recipient: 'a@x.com' },
    );
    const found = ws.identify({ name: 'l', bytes: out.bytes });
    assert.equal(found.attribution?.confidence, 'confirmed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status and report expose a verified ledger and render to markdown', () => {
  withWorkspace((ws) => {
    const out = ws.protect(
      { name: 'm.txt', bytes: Buffer.from(SAMPLE, 'utf8') },
      { matter: 'M-1', recipient: 'a@x.com' },
    );
    const st = ws.status();
    assert.equal(st.copies, 1);
    assert.ok(st.chainOk);

    const rep = ws.report(out.copy.tokenHex);
    assert.equal(rep.copy.tokenHex, out.copy.tokenHex);
    const md = renderReportMarkdown(rep);
    assert.ok(md.includes('a@x.com'));
    assert.ok(md.includes('Hash chain verified: **yes**'));
    assert.ok(md.includes(out.copy.tokenHex));

    // short-ID also resolves to the same report
    assert.equal(ws.report(out.copy.shortIdHex).copy.tokenHex, out.copy.tokenHex);
    assert.throws(() => ws.report('deadbeef'), /no protected copy/);
  });
});
