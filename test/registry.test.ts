import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry, sha256, ProtectedCopy } from '../src/registry.js';
import { Scheme } from '../src/frame.js';
import { newCopyIdentity } from '../src/crypto.js';

function row(tokenHex: string, shortIdHex: string, matter = 'MATTER-2026-0001'): ProtectedCopy {
  return {
    tokenHex,
    shortIdHex,
    scheme: Scheme.HMAC_SHA256,
    identity: newCopyIdentity(matter, 'r@example.com', 'v1'),
    originalHash: sha256('original'),
    protectedHash: sha256('protected-' + tokenHex),
    generatedBy: 'tester',
    generatedAt: '2026-07-24T00:00:00.000Z',
    channels: [],
    deliveryMethod: 'email',
    transformTests: [],
    investigations: [],
  };
}

test('sha256 is stable', () => {
  assert.equal(sha256('x'), sha256('x'));
  assert.notEqual(sha256('x'), sha256('y'));
});

test('add + resolve by full token and by short id', () => {
  const reg = new Registry();
  reg.add(row('aa11', 'bb22'));
  assert.ok(reg.resolve('aa11'), 'resolves by full token');
  assert.ok(reg.resolve('bb22'), 'resolves by short-id pointer');
  assert.equal(reg.resolve('missing'), undefined);
});

test('duplicate token or short-id is refused (evidence rows are append-only)', () => {
  const reg = new Registry();
  reg.add(row('aa11', 'bb22'));
  assert.throws(() => reg.add(row('aa11', 'cc33')), /token collision/);
  assert.throws(() => reg.add(row('dd44', 'bb22')), /short-ID collision/);
});

test('byMatter groups the copies issued for a matter', () => {
  const reg = new Registry();
  reg.add(row('a1', 's1', 'M-A'));
  reg.add(row('a2', 's2', 'M-A'));
  reg.add(row('b1', 's3', 'M-B'));
  assert.equal(reg.byMatter('M-A').length, 2);
  assert.equal(reg.byMatter('M-B').length, 1);
});

test('recordInvestigation appends and is reflected on resolve', () => {
  const reg = new Registry();
  reg.add(row('aa11', 'bb22'));
  reg.recordInvestigation('aa11', {
    at: '2026-07-24T01:00:00.000Z',
    actor: 'tester',
    kind: 'detection',
    detail: 'recovered from a public forum',
    survivingChannels: ['HG'],
  });
  assert.equal(reg.resolve('aa11')!.investigations.length, 1);
  assert.throws(() => reg.recordInvestigation('nope', {
    at: '2026-07-24T01:00:00.000Z',
    actor: 'tester',
    kind: 'note',
    detail: 'x',
  }), /no registry row/);
});
