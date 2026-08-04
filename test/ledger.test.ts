import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import {
  stableStringify,
  merkleRoot,
  eventHash,
  verifyChain,
  GENESIS,
  ChainedEvent,
  EventCore,
} from '../src/ledger/hashchain.js';
import { verifyMerkleProof } from '../src/ledger/merkle-proof.js';
import { seal, unseal } from '../src/ledger/vault.js';
import { localAttestationAnchor } from '../src/ledger/anchor.js';
import { SecureRegistry } from '../src/ledger/index.js';
import { deriveEd25519 } from '../src/crypto.js';
import { Scheme } from '../src/frame.js';
import type { ProtectedCopy } from '../src/registry.js';

function tmp(): string {
  return join(tmpdir(), 'miy-test-' + randomBytes(8).toString('hex') + '.reg');
}

function row(tok: string, sid: string, matter = 'M-1'): ProtectedCopy {
  return {
    tokenHex: tok,
    shortIdHex: sid,
    scheme: Scheme.HMAC_SHA256,
    identity: { matterRef: matter, recipientId: `${tok}@example.com`, version: 'v1', issuedAt: '2026-07-24T00:00:00Z', nonce: 'n' + tok },
    originalHash: 'oh' + tok,
    protectedHash: 'ph' + tok,
    generatedBy: 'tester',
    generatedAt: '2026-07-24T00:00:00Z',
    channels: [],
    deliveryMethod: 'email',
    transformTests: [],
    investigations: [],
  };
}

/* ------------------------------- hashchain ------------------------------- */

test('stableStringify is key-order independent and drops undefined', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableStringify({ a: 1, b: undefined }), stableStringify({ a: 1 }));
});

test('merkleRoot is deterministic and sensitive to any change', () => {
  const a = merkleRoot(['00', '11', '22']);
  assert.equal(a, merkleRoot(['00', '11', '22']));
  assert.notEqual(a, merkleRoot(['00', '11', '23']));
  assert.equal(merkleRoot([]), GENESIS);
});

test('verifyChain accepts an intact chain and rejects a tampered one', () => {
  const build = (payloads: unknown[]): ChainedEvent[] => {
    const events: ChainedEvent[] = [];
    let prev = GENESIS;
    payloads.forEach((payload, seq) => {
      const core: EventCore = { seq, type: 'copy', at: `t${seq}`, payload };
      const hash = eventHash(prev, core);
      events.push({ ...core, prevHash: prev, hash });
      prev = hash;
    });
    return events;
  };
  const events = build([{ x: 1 }, { x: 2 }, { x: 3 }]);
  assert.equal(verifyChain(events).ok, true);

  const tampered = structuredClone(events);
  (tampered[1].payload as { x: number }).x = 99; // edit a past row without fixing hashes
  assert.equal(verifyChain(tampered).ok, false);

  const reordered = [events[1], events[0], events[2]];
  assert.equal(verifyChain(reordered).ok, false);
});

/* --------------------------------- vault --------------------------------- */

test('vault seal/unseal round-trips and rejects wrong passphrase and tampering', () => {
  const data = Buffer.from('recipient identities and token material', 'utf8');
  const sealed = seal(data, 'pass');
  assert.ok(unseal(sealed, 'pass').equals(data));
  assert.ok(!sealed.toString('latin1').includes('recipient')); // encrypted at rest
  assert.throws(() => unseal(sealed, 'wrong'), /decryption failed/);
  const t = Buffer.from(sealed);
  t[t.length - 1] ^= 0x01;
  assert.throws(() => unseal(t, 'pass'), /decryption failed/);
  assert.throws(() => unseal(Buffer.from('nope'), 'pass'), /not a MarkItYours/);
});

/* -------------------------------- anchor --------------------------------- */

test('local attestation anchor verifies its own proof and rejects forgeries', () => {
  const kp = deriveEd25519(Buffer.alloc(32, 3));
  const anchor = localAttestationAnchor(kp);
  const proof = anchor.commit('deadbeef', '2026-07-24T00:00:00Z');
  assert.equal(anchor.verify(proof), true);
  assert.equal(anchor.thirdPartyTime, false); // honest about self-asserted time
  assert.equal(anchor.verify({ ...proof, digest: 'feedface' }), false);
  assert.equal(anchor.verify({ ...proof, at: 'later' }), false);
});

/* ---------------------------- SecureRegistry ----------------------------- */

test('SecureRegistry: add, resolve by token and short-id, byMatter, investigations', () => {
  const path = tmp();
  try {
    const reg = SecureRegistry.create(path, 'pw');
    reg.add(row('aa', 'bb', 'M-1'));
    reg.add(row('cc', 'dd', 'M-2'));
    reg.recordInvestigation('aa', { at: 't', actor: 'x', kind: 'note', detail: 'seen' });
    assert.equal(reg.resolve('aa')?.identity.matterRef, 'M-1');
    assert.equal(reg.resolve('dd')?.identity.matterRef, 'M-2'); // by short-id
    assert.equal(reg.byMatter('M-1').length, 1);
    assert.equal(reg.resolve('aa')?.investigations.length, 1);
    assert.throws(() => reg.add(row('aa', 'ee')), /token collision/);
    assert.throws(() => reg.add(row('ff', 'bb')), /short-ID collision/);
    assert.throws(() => reg.recordInvestigation('zz', { at: 't', actor: 'x', kind: 'note', detail: 'x' }), /no registry row/);
  } finally {
    rmSync(path, { force: true });
  }
});

test('SecureRegistry: reopen decrypts, verifies the chain, and replays state', () => {
  const path = tmp();
  try {
    const reg = SecureRegistry.create(path, 'pw');
    reg.add(row('aa', 'bb'));
    reg.recordInvestigation('aa', { at: 't', actor: 'x', kind: 'detection', detail: 'd', survivingChannels: ['HG'] });
    const root = reg.merkleRoot();

    const reopened = SecureRegistry.open(path, 'pw');
    assert.equal(reopened.verify(), true);
    assert.equal(reopened.merkleRoot(), root);
    assert.equal(reopened.resolve('aa')?.investigations.length, 1);
    assert.throws(() => SecureRegistry.open(path, 'nope'), /decryption failed/);
  } finally {
    rmSync(path, { force: true });
  }
});

test('SecureRegistry: an insider who edits a row and re-encrypts is caught by the chain', () => {
  const path = tmp();
  try {
    const reg = SecureRegistry.create(path, 'pw');
    reg.add(row('aa', 'bb', 'M-1'));
    reg.add(row('cc', 'dd', 'M-2'));

    // Decrypt, edit a past event's payload, re-encrypt with the SAME passphrase.
    const events = JSON.parse(unseal(readFileSync(path), 'pw').toString('utf8'));
    events[0].payload.copy.identity.recipientId = 'someone.else@example.com';
    writeFileSync(path, seal(Buffer.from(JSON.stringify(events)), 'pw'));

    // GCM is happy (valid key), but the hash chain no longer reproduces.
    assert.throws(() => SecureRegistry.open(path, 'pw'), /hash chain broken/);
  } finally {
    rmSync(path, { force: true });
  }
});

test('SecureRegistry: create refuses to clobber, openOrCreate is idempotent', () => {
  const path = tmp();
  try {
    SecureRegistry.create(path, 'pw');
    assert.ok(existsSync(path));
    assert.throws(() => SecureRegistry.create(path, 'pw'), /already exists/);
    const reg = SecureRegistry.openOrCreate(path, 'pw');
    assert.equal(reg.eventCount(), 0);
  } finally {
    rmSync(path, { force: true });
  }
});

test('SecureRegistry: anchor commits to the current root and verifies through the registry', () => {
  const path = tmp();
  try {
    const reg = SecureRegistry.create(path, 'pw');
    reg.add(row('aa', 'bb'));
    const anchor = localAttestationAnchor(deriveEd25519(Buffer.alloc(32, 5)));
    const proof = reg.anchor(anchor);
    assert.equal(reg.verifyAnchor(anchor, proof), true);
    reg.add(row('cc', 'dd')); // root moves on
    assert.equal(reg.verifyAnchor(anchor, proof), false); // stale proof no longer matches
  } finally {
    rmSync(path, { force: true });
  }
});

test('SecureRegistry: full token and short ID prove the same immutable copy event', () => {
  const path = tmp();
  try {
    const reg = SecureRegistry.create(path, 'pw');
    reg.add(row('aa', 'bb'));
    reg.recordInvestigation('aa', { at: 't1', actor: 'x', kind: 'note', detail: 'later note' });
    reg.add(row('cc', 'dd'));

    const full = reg.proveCopy('aa');
    const short = reg.proveCopy('bb');
    assert.deepEqual(short, full);
    assert.equal(full.event.type, 'copy');
    assert.equal(full.event.seq, 0);
    assert.equal((full.event.payload as { copy: ProtectedCopy }).copy.tokenHex, 'aa');
    assert.deepEqual((full.event.payload as { copy: ProtectedCopy }).copy.investigations, []);
    assert.equal(full.proof.treeSize, 3);
    assert.equal(full.proof.root, reg.merkleRoot());
    assert.equal(verifyMerkleProof(full.proof), true);
  } finally {
    rmSync(path, { force: true });
  }
});

test('SecureRegistry: historical prefix proofs bind to rootAt(eventCount)', () => {
  const path = tmp();
  try {
    const reg = SecureRegistry.create(path, 'pw');
    reg.add(row('aa', 'bb')); // event 1
    reg.recordInvestigation('aa', { at: 't1', actor: 'x', kind: 'note', detail: 'note' }); // event 2
    reg.add(row('cc', 'dd')); // event 3

    const one = reg.proveCopy('aa', 1);
    assert.equal(one.proof.treeSize, 1);
    assert.equal(one.proof.root, reg.rootAt(1));
    assert.equal(verifyMerkleProof(one.proof), true);

    const two = reg.proveCopy('aa', 2);
    assert.equal(two.proof.treeSize, 2);
    assert.equal(two.proof.root, reg.rootAt(2));
    assert.equal(verifyMerkleProof(two.proof), true);

    assert.notEqual(reg.rootAt(1), reg.rootAt(2));
    assert.notEqual(reg.rootAt(2), reg.rootAt(3));
    assert.equal(reg.rootAt(3), reg.merkleRoot());
  } finally {
    rmSync(path, { force: true });
  }
});

test('SecureRegistry: copy proofs reject invalid prefixes and unknown tokens', () => {
  const path = tmp();
  try {
    const reg = SecureRegistry.create(path, 'pw');
    reg.add(row('aa', 'bb'));
    reg.add(row('cc', 'dd'));

    assert.throws(() => reg.rootAt(0), /event count/i);
    assert.throws(() => reg.rootAt(-1), /event count/i);
    assert.throws(() => reg.rootAt(1.5), /event count/i);
    assert.throws(() => reg.rootAt(3), /event count/i);

    assert.throws(() => reg.proveCopy('cc', 1), /predates the copy/i);
    assert.throws(() => reg.proveCopy('missing'), /no registry row/i);
    assert.throws(() => reg.proveCopy('aa', 0), /event count/i);
    assert.throws(() => reg.proveCopy('aa', 3), /event count/i);
  } finally {
    rmSync(path, { force: true });
  }
});
