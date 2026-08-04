import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  DSSE_PAYLOAD_TYPE,
  EVIDENCE_MEDIA_TYPE,
  PREDICATE_TYPE,
  STATEMENT_TYPE,
  createEvidenceStatement,
  dssePAE,
  evidenceKeyInfo,
  parseEvidenceBundle,
  signEvidenceStatement,
  verifyEvidenceBundle,
  type EvidenceStatementInput,
  type MattermarkEvidenceBundle,
  type MattermarkEvidenceStatement,
} from '../src/evidence.js';
import {
  deriveEd25519,
  ed25519Token,
  shortIdToken,
  type CopyIdentity,
  type EdKeyPair,
} from '../src/crypto.js';
import { Scheme } from '../src/frame.js';
import { GENESIS, eventHash, type ChainedEvent, type EventCore } from '../src/ledger/hashchain.js';
import { createMerkleProof } from '../src/ledger/merkle-proof.js';
import { localAttestationAnchor, type AnchorProof } from '../src/ledger/anchor.js';
import { detachedFromAttestations, serializeDetached } from '../src/ledger/ots.js';
import type { ProtectedCopy } from '../src/registry.js';

const ORG_KEY = Buffer.alloc(32, 7);
const GENERATED_AT = '2026-08-04T09:00:00.000Z';

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

interface Fixture {
  keyPair: EdKeyPair;
  copy: ProtectedCopy;
  event: ChainedEvent;
  input: EvidenceStatementInput;
  statement: MattermarkEvidenceStatement;
  bundle: MattermarkEvidenceBundle;
}

function fixture(opts: { scheme?: 'ed25519' | 'hmac'; anchors?: EvidenceStatementInput['ledger']['anchors'] } = {}): Fixture {
  const keyPair = deriveEd25519(ORG_KEY);
  const identity: CopyIdentity = {
    matterRef: 'M-2042',
    recipientId: 'alice@example.com',
    version: 'final',
    issuedAt: '2026-08-04T08:00:00.000Z',
    nonce: '0123456789abcdef',
  };
  const scheme = opts.scheme ?? 'ed25519';
  const tokenHex = scheme === 'ed25519'
    ? Buffer.from(ed25519Token(keyPair, identity)).toString('hex')
    : createHash('sha256').update('synthetic-hmac-token').digest('hex').slice(0, 32);
  const copy: ProtectedCopy = {
    tokenHex,
    shortIdHex: Buffer.from(shortIdToken(ORG_KEY, identity)).toString('hex'),
    scheme: scheme === 'ed25519' ? Scheme.ED25519 : Scheme.HMAC_SHA256,
    identity,
    originalHash: sha256('unmarked source'),
    protectedHash: sha256('marked artifact'),
    sourceName: 'brief.docx',
    protectedName: 'brief--alice-example-com.docx',
    generatedBy: 'K. Reyes',
    generatedAt: identity.issuedAt,
    channels: [],
    deliveryMethod: 'email',
    transformTests: [],
    investigations: [{ at: GENERATED_AT, actor: 'later', kind: 'note', detail: 'not in copy event' }],
  };
  const storedCopy: ProtectedCopy = { ...copy, investigations: [] };
  const core: EventCore = {
    seq: 0,
    type: 'copy',
    at: identity.issuedAt,
    payload: { copy: storedCopy },
  };
  const event: ChainedEvent = {
    ...core,
    prevHash: GENESIS,
    hash: eventHash(GENESIS, core),
  };
  const inclusion = { event, proof: createMerkleProof([event.hash], 0) };
  const input: EvidenceStatementInput = {
    generatedAt: GENERATED_AT,
    workspace: { orgName: 'Test LLP', scheme },
    copy,
    ledger: {
      chainVerifiedAtExport: true,
      current: { eventCount: 1, root: inclusion.proof.root, inclusion },
      anchors: opts.anchors ?? [],
    },
    disclosures: ['The embedded key must be pinned through a trusted channel.'],
  };
  const statement = createEvidenceStatement(input);
  const bundle = signEvidenceStatement(statement, keyPair);
  return { keyPair, copy, event, input, statement, bundle };
}

function resign(statement: MattermarkEvidenceStatement, keyPair: EdKeyPair): MattermarkEvidenceBundle {
  return signEvidenceStatement(structuredClone(statement), keyPair);
}

test('DSSE pre-authentication encoding binds type and exact payload bytes', () => {
  assert.equal(
    dssePAE('text/plain', Buffer.from('abc', 'utf8')).toString('utf8'),
    'DSSEv1 10 text/plain 3 abc',
  );
  assert.notDeepEqual(
    dssePAE('text/plain', Buffer.from('abc', 'utf8')),
    dssePAE('application/json', Buffer.from('abc', 'utf8')),
  );
});

test('evidence key fingerprint is deterministic and binds the raw Ed25519 key', () => {
  const kp = deriveEd25519(ORG_KEY);
  const info = evidenceKeyInfo(kp.publicKeyRaw);
  assert.equal(info.algorithm, 'ed25519');
  assert.equal(Buffer.from(info.publicKeyRaw, 'base64').length, 32);
  assert.equal(info.keyid, `sha256:${createHash('sha256').update(kp.publicKeyRaw).digest('hex')}`);
});

test('signed evidence verifies as self-contained and upgrades only with a pinned key', () => {
  const { bundle, keyPair } = fixture();
  assert.equal(bundle.mediaType, EVIDENCE_MEDIA_TYPE);
  assert.equal(bundle.envelope.payloadType, DSSE_PAYLOAD_TYPE);

  const selfContained = verifyEvidenceBundle(bundle);
  assert.equal(selfContained.valid, true, selfContained.errors.join('; '));
  assert.equal(selfContained.trust, 'self-contained');
  assert.equal(selfContained.signatureValid, true);
  assert.equal(selfContained.statementValid, true);
  assert.equal(selfContained.subjectValid, true);
  assert.equal(selfContained.currentLedgerProofValid, true);
  assert.equal(selfContained.keyPinned, undefined);

  const keyid = evidenceKeyInfo(keyPair.publicKeyRaw).keyid;
  const pinned = verifyEvidenceBundle(bundle, { expectedKeyid: keyid });
  assert.equal(pinned.valid, true, pinned.errors.join('; '));
  assert.equal(pinned.trust, 'key-pinned');
  assert.equal(pinned.keyPinned, true);

  const mismatch = verifyEvidenceBundle(bundle, { expectedKeyid: `sha256:${'00'.repeat(32)}` });
  assert.equal(mismatch.valid, false);
  assert.equal(mismatch.trust, 'invalid');
  assert.equal(mismatch.keyPinned, false);
  assert.ok(mismatch.errors.some((e) => /expected key/i.test(e)));
});

test('the signed statement uses the in-toto shape and immutable subject digest', () => {
  const { bundle, copy } = fixture();
  const parsed = parseEvidenceBundle(JSON.stringify(bundle));
  const payload = JSON.parse(Buffer.from(parsed.envelope.payload, 'base64').toString('utf8'));
  assert.equal(payload._type, STATEMENT_TYPE);
  assert.equal(payload.predicateType, PREDICATE_TYPE);
  assert.equal(payload.subject.length, 1);
  assert.equal(payload.subject[0].name, copy.protectedName);
  assert.equal(payload.subject[0].digest.sha256, copy.protectedHash);
});

test('signature verification rejects payload, payload-type, signature, key, and key-id tampering', () => {
  const { bundle } = fixture();

  const payload = structuredClone(bundle);
  const bytes = Buffer.from(payload.envelope.payload, 'base64');
  bytes[bytes.length - 1] ^= 1;
  payload.envelope.payload = bytes.toString('base64');
  assert.equal(verifyEvidenceBundle(payload).signatureValid, false);

  const payloadType = structuredClone(bundle);
  payloadType.envelope.payloadType = 'application/json' as typeof DSSE_PAYLOAD_TYPE;
  assert.equal(verifyEvidenceBundle(payloadType).signatureValid, false);

  const signature = structuredClone(bundle);
  const sig = Buffer.from(signature.envelope.signatures[0].sig, 'base64');
  sig[0] ^= 1;
  signature.envelope.signatures[0].sig = sig.toString('base64');
  assert.equal(verifyEvidenceBundle(signature).signatureValid, false);

  const key = structuredClone(bundle);
  const raw = Buffer.from(key.verificationMaterial.publicKey.raw, 'base64');
  raw[0] ^= 1;
  key.verificationMaterial.publicKey.raw = raw.toString('base64');
  assert.equal(verifyEvidenceBundle(key).valid, false);

  const keyid = structuredClone(bundle);
  keyid.verificationMaterial.publicKey.keyid = `sha256:${'11'.repeat(32)}`;
  assert.equal(verifyEvidenceBundle(keyid).valid, false);
});

test('a newly signed but semantically altered subject is rejected', () => {
  const { statement, keyPair } = fixture();

  const wrongSubject = structuredClone(statement);
  wrongSubject.subject[0].digest.sha256 = sha256('different artifact');
  const result = verifyEvidenceBundle(resign(wrongSubject, keyPair));
  assert.equal(result.signatureValid, true);
  assert.equal(result.subjectValid, false);
  assert.equal(result.valid, false);

  const wrongType = structuredClone(statement);
  wrongType._type = 'https://example.invalid/Statement/v1' as typeof STATEMENT_TYPE;
  assert.equal(verifyEvidenceBundle(resign(wrongType, keyPair)).statementValid, false);

  const wrongPredicate = structuredClone(statement);
  wrongPredicate.predicateType = 'https://example.invalid/evidence/v1' as typeof PREDICATE_TYPE;
  assert.equal(verifyEvidenceBundle(resign(wrongPredicate, keyPair)).statementValid, false);
});

test('copy event hashing, payload binding, and Merkle inclusion are independently checked', () => {
  const { statement, keyPair } = fixture();

  const changedPayload = structuredClone(statement);
  changedPayload.predicate.ledger.current.inclusion.event.payload.copy.identity.recipientId = 'mallory@example.com';
  let result = verifyEvidenceBundle(resign(changedPayload, keyPair));
  assert.equal(result.signatureValid, true);
  assert.equal(result.currentLedgerProofValid, false);
  assert.equal(result.valid, false);

  const rehashedPayload = structuredClone(statement);
  const e = rehashedPayload.predicate.ledger.current.inclusion.event;
  e.payload.copy.identity.recipientId = 'mallory@example.com';
  e.hash = eventHash(e.prevHash, { seq: e.seq, type: e.type, at: e.at, payload: e.payload });
  result = verifyEvidenceBundle(resign(rehashedPayload, keyPair));
  assert.equal(result.currentLedgerProofValid, false); // old Merkle leaf no longer binds

  const changedPath = structuredClone(statement);
  changedPath.predicate.ledger.current.inclusion.proof.root = sha256('other root');
  result = verifyEvidenceBundle(resign(changedPath, keyPair));
  assert.equal(result.currentLedgerProofValid, false);

  const changedCopy = structuredClone(statement);
  changedCopy.predicate.copy.identity.matterRef = 'M-OTHER';
  result = verifyEvidenceBundle(resign(changedCopy, keyPair));
  assert.equal(result.statementValid, false);
});

test('a local anchor is verified with the evidence public key', () => {
  const base = fixture();
  const local = localAttestationAnchor(base.keyPair).commit(base.input.ledger.current.root, GENERATED_AT);
  const withAnchor = fixture({
    anchors: [{
      stored: {
        proof: local,
        merkleRoot: base.input.ledger.current.root,
        events: 1,
        recordedAt: GENERATED_AT,
        thirdPartyTime: false,
      },
      inclusion: base.input.ledger.current.inclusion,
    }],
  });
  const result = verifyEvidenceBundle(withAnchor.bundle);
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.anchorResults[0].proofStatus, 'local-valid');
  assert.equal(result.anchorResults[0].inclusionValid, true);

  const tampered = structuredClone(withAnchor.statement);
  const anchor = tampered.predicate.ledger.anchors[0].stored.proof;
  anchor.proof.sig = '00';
  const invalid = verifyEvidenceBundle(resign(tampered, withAnchor.keyPair));
  assert.equal(invalid.valid, true); // supplemental anchor fails; core signed evidence remains valid
  assert.equal(invalid.anchorResults[0].proofStatus, 'invalid');
  assert.equal(invalid.trust, 'self-contained');
});

test('OpenTimestamps proofs are classified as pending or unconfirmed Bitcoin attestations', () => {
  const base = fixture();
  const root = Buffer.from(base.input.ledger.current.root, 'hex');
  const ots = (attestations: Parameters<typeof detachedFromAttestations>[1]): AnchorProof => ({
    anchor: 'opentimestamps',
    digest: root.toString('hex'),
    at: GENERATED_AT,
    proof: { ots: serializeDetached(detachedFromAttestations(root, attestations)).toString('base64') },
  });
  const make = (proof: AnchorProof) => fixture({
    anchors: [{
      stored: {
        proof,
        merkleRoot: base.input.ledger.current.root,
        events: 1,
        recordedAt: GENERATED_AT,
        thirdPartyTime: true,
      },
      inclusion: base.input.ledger.current.inclusion,
    }],
  });

  const pending = verifyEvidenceBundle(make(ots([{ kind: 'pending', uri: 'https://calendar.test' }])).bundle);
  assert.equal(pending.anchorResults[0].proofStatus, 'ots-pending');
  assert.equal(pending.trust, 'self-contained');

  const bitcoinFixture = make(ots([{ kind: 'bitcoin', height: 900_001 }]));
  const unpinned = verifyEvidenceBundle(bitcoinFixture.bundle);
  assert.equal(unpinned.anchorResults[0].proofStatus, 'ots-bitcoin-attestation-unconfirmed');
  assert.equal(unpinned.trust, 'self-contained');
  assert.ok(unpinned.warnings.some((w) => /trusted (?:Bitcoin )?block header/i.test(w)));

  const pinned = verifyEvidenceBundle(bitcoinFixture.bundle, {
    expectedKeyid: evidenceKeyInfo(bitcoinFixture.keyPair.publicKeyRaw).keyid,
  });
  assert.equal(pinned.trust, 'key-pinned-and-externally-anchored');
  assert.ok(pinned.warnings.some((w) => /not independently confirmed/i.test(w)));
});

test('HMAC copy tokens remain valid evidence but are disclosed as not publicly self-verifying', () => {
  const { bundle } = fixture({ scheme: 'hmac' });
  const result = verifyEvidenceBundle(bundle);
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.ok(result.warnings.some((w) => /HMAC/i.test(w) && /not publicly self-verifying/i.test(w)));
});

test('parseEvidenceBundle rejects invalid JSON and unrelated objects', () => {
  assert.throws(() => parseEvidenceBundle('{'), /valid JSON/i);
  assert.throws(() => parseEvidenceBundle('{}'), /Mattermark evidence bundle/i);
  assert.throws(() => parseEvidenceBundle('[]'), /Mattermark evidence bundle/i);
});
