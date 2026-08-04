import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  createEvidenceStatement,
  dssePAE,
  evidenceKeyInfo,
  parseEvidenceBundle,
  signEvidenceStatement,
  verifyEvidenceBundle,
  type EvidenceStatementInput,
} from '../src/evidence.js';
import { deriveEd25519, ed25519Token, shortIdToken, type CopyIdentity } from '../src/crypto.js';
import { Scheme } from '../src/frame.js';
import { GENESIS, eventHash, type EventCore } from '../src/ledger/hashchain.js';
import { createMerkleProof } from '../src/ledger/merkle-proof.js';
import { detachedFromAttestations, serializeDetached } from '../src/ledger/ots.js';
import type { AnchorProof } from '../src/ledger/anchor.js';
import type { ProtectedCopy } from '../src/registry.js';

const KEY = Buffer.alloc(32, 7);
const NOW = '2026-08-04T09:00:00.000Z';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function makeInput(opts: { hmac?: boolean; anchor?: AnchorProof } = {}) {
  const kp = deriveEd25519(KEY);
  const identity: CopyIdentity = {
    matterRef: 'M-2042', recipientId: 'alice@example.com', version: 'final',
    issuedAt: NOW, nonce: '0123456789abcdef',
  };
  const tokenHex = opts.hmac
    ? sha256('hmac-token').slice(0, 32)
    : Buffer.from(ed25519Token(kp, identity)).toString('hex');
  const copy: ProtectedCopy = {
    tokenHex,
    shortIdHex: Buffer.from(shortIdToken(KEY, identity)).toString('hex'),
    scheme: opts.hmac ? Scheme.HMAC_SHA256 : Scheme.ED25519,
    identity,
    originalHash: sha256('source'),
    protectedHash: sha256('protected'),
    sourceName: 'brief.docx',
    protectedName: 'brief--alice.docx',
    generatedBy: 'tester', generatedAt: NOW, channels: [], deliveryMethod: 'email',
    transformTests: [], investigations: [],
  };
  const core: EventCore = { seq: 0, type: 'copy', at: NOW, payload: { copy } };
  const event = { ...core, prevHash: GENESIS, hash: eventHash(GENESIS, core) };
  const inclusion = { event, proof: createMerkleProof([event.hash], 0) };
  const input: EvidenceStatementInput = {
    generatedAt: NOW,
    workspace: { orgName: 'Test LLP', scheme: opts.hmac ? 'hmac' : 'ed25519' },
    copy,
    ledger: {
      chainVerifiedAtExport: true,
      current: { eventCount: 1, root: inclusion.proof.root, inclusion },
      anchors: opts.anchor ? [{
        stored: {
          proof: opts.anchor,
          merkleRoot: inclusion.proof.root,
          events: 1,
          recordedAt: NOW,
          thirdPartyTime: true,
        },
        inclusion,
      }] : [],
    },
    disclosures: ['Pin the key fingerprint through a trusted channel.'],
  };
  return { kp, input, copy };
}

function bundle(opts: { hmac?: boolean; anchor?: AnchorProof } = {}) {
  const f = makeInput(opts);
  return { ...f, bundle: signEvidenceStatement(createEvidenceStatement(f.input), f.kp) };
}

test('DSSE PAE binds payload type and exact bytes', () => {
  assert.equal(dssePAE('text/plain', Buffer.from('abc')).toString(), 'DSSEv1 10 text/plain 3 abc');
  assert.notDeepEqual(dssePAE('text/plain', Buffer.from('abc')), dssePAE('application/json', Buffer.from('abc')));
});

test('bundle verifies self-contained and with explicit key pinning', () => {
  const f = bundle();
  const self = verifyEvidenceBundle(f.bundle);
  assert.equal(self.valid, true, self.errors.join('; '));
  assert.equal(self.trust, 'self-contained');
  const keyid = evidenceKeyInfo(f.kp.publicKeyRaw).keyid;
  assert.equal(verifyEvidenceBundle(f.bundle, { expectedKeyid: keyid }).trust, 'key-pinned');
  const bad = verifyEvidenceBundle(f.bundle, { expectedKeyid: `sha256:${'00'.repeat(32)}` });
  assert.equal(bad.valid, false);
  assert.equal(bad.keyPinned, false);
});

test('signature and semantic tampering are rejected independently', () => {
  const f = bundle();
  const changedSig = structuredClone(f.bundle);
  const sig = Buffer.from(changedSig.envelope.signatures[0].sig, 'base64');
  sig[0] ^= 1;
  changedSig.envelope.signatures[0].sig = sig.toString('base64');
  assert.equal(verifyEvidenceBundle(changedSig).signatureValid, false);

  const statement = createEvidenceStatement(f.input);
  statement.subject[0].digest.sha256 = sha256('different');
  const resigned = signEvidenceStatement(statement, f.kp);
  const result = verifyEvidenceBundle(resigned);
  assert.equal(result.signatureValid, true);
  assert.equal(result.subjectValid, false);
  assert.equal(result.valid, false);
});

test('copy event and Merkle proof are bound to the statement copy', () => {
  const f = bundle();
  const statement = createEvidenceStatement(f.input);
  statement.predicate.ledger.current.inclusion.event.payload.copy.identity.recipientId = 'mallory@example.com';
  const result = verifyEvidenceBundle(signEvidenceStatement(statement, f.kp));
  assert.equal(result.currentLedgerProofValid, false);
  assert.equal(result.valid, false);
});

test('unconfirmed OpenTimestamps attestations do not upgrade the trust grade', () => {
  const base = makeInput();
  const root = Buffer.from(base.input.ledger.current.root, 'hex');
  const proof: AnchorProof = {
    anchor: 'opentimestamps', digest: root.toString('hex'), at: NOW,
    proof: { ots: serializeDetached(detachedFromAttestations(root, [{ kind: 'bitcoin', height: 900001 }])).toString('base64') },
  };
  const f = bundle({ anchor: proof });
  const result = verifyEvidenceBundle(f.bundle, { expectedKeyid: evidenceKeyInfo(f.kp.publicKeyRaw).keyid });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.trust, 'key-pinned');
  assert.equal(result.anchorResults[0].proofStatus, 'ots-bitcoin-attestation-unconfirmed');
  assert.ok(result.warnings.some((w) => /trusted (?:Bitcoin )?block header/i.test(w)));
  assert.ok(result.warnings.some((w) => /not independently confirmed/i.test(w)));
});

test('HMAC copy tokens disclose the public verification boundary', () => {
  const result = verifyEvidenceBundle(bundle({ hmac: true }).bundle);
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.ok(result.warnings.some((w) => /HMAC/i.test(w) && /not publicly self-verifying/i.test(w)));
});

test('parseEvidenceBundle rejects invalid or unrelated JSON', () => {
  assert.throws(() => parseEvidenceBundle('{'), /valid JSON/i);
  assert.throws(() => parseEvidenceBundle('{}'), /Mattermark evidence bundle/i);
});
