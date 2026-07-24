import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCorpus, MANIFEST } from '../src/corpus.js';
import { runMatrix } from '../src/harness.js';

const corpus = loadCorpus();

test('every manifest document loads and is non-empty', () => {
  assert.equal(corpus.length, MANIFEST.length);
  assert.ok(corpus.length >= 10, 'corpus should have 10-20 documents');
  for (const d of corpus) {
    assert.ok(d.text.length > 0, `${d.file} is non-empty`);
    assert.equal(d.chars, [...d.text].length);
  }
});

test('manifest files and labels are unique', () => {
  assert.equal(new Set(MANIFEST.map((m) => m.file)).size, MANIFEST.length);
  assert.equal(new Set(MANIFEST.map((m) => m.label)).size, MANIFEST.length);
});

test('every corpus document is a clean ASCII canvas', () => {
  for (const d of corpus) {
    for (const ch of d.text) {
      const c = ch.codePointAt(0) as number;
      const printable = c >= 0x20 && c <= 0x7e;
      const newline = c === 0x0a;
      assert.ok(printable || newline, `${d.file} has non-ASCII codepoint U+${c.toString(16)}`);
    }
  }
});

test('the corpus spans a wide size range (small to large)', () => {
  const sizes = corpus.map((d) => d.chars);
  assert.ok(Math.min(...sizes) < 400, 'has a sub-durability-floor document');
  assert.ok(Math.max(...sizes) > 40000, 'has a large brief-scale document');
});

test('durability tracks document shape, not a flat length cutoff', () => {
  const memo = corpus.find((d) => d.label === 'priv-memo')!;
  const notice = corpus.find((d) => d.label === 'filing-notice')!;
  const rows = runMatrix(
    [
      { label: memo.label, text: memo.text },
      { label: notice.label, text: notice.text },
    ],
    [['WS', 'ZW', 'HG']],
  );
  const memoRow = rows.find((r) => r.docLabel === 'priv-memo' && r.scheme === 'HMAC-SHA256')!;
  const noticeRow = rows.find((r) => r.docLabel === 'filing-notice' && r.scheme === 'HMAC-SHA256')!;
  assert.equal(memoRow.durable, true);
  assert.equal(memoRow.homoglyphActive, true);
  assert.equal(noticeRow.durable, false); // below the durability floor
});
