/**
 * evidence.ts — portable, signed evidence that can be checked without a vault.
 *
 * The bundle deliberately combines three mature patterns without importing
 * their service infrastructure:
 *
 *   - DSSE pre-authentication encoding binds the payload type and exact bytes.
 *   - An in-toto Statement-shaped payload binds claims to one artifact digest.
 *   - A Sigstore-style self-contained JSON bundle carries the statement,
 *     signature, public verification material, ledger inclusion proofs, and
 *     optional external anchors together.
 *
 * Trust boundary: an embedded public key proves internal consistency, not the
 * real-world identity of the key holder. Consumers should pin the displayed
 * `sha256:<fingerprint>` through a trusted channel. OpenTimestamps proofs are
 * also described precisely: a block-height attestation is not independently
 * confirmed until checked against a trusted Bitcoin block-header source.
 */

import {
  createHash,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';

import {
  ed25519MatchesIdentity,
  ed25519VerifyToken,
  type EdKeyPair,
} from './crypto.js';
import { Scheme } from './frame.js';
import type { ProtectedCopy } from './registry.js';
import {
  eventHash,
  stableStringify,
  type ChainedEvent,
  type EventCore,
} from './ledger/hashchain.js';
import {
  verifyMerkleProof,
  type MerkleInclusionProof,
} from './ledger/merkle-proof.js';
import type { LedgerEventInclusion } from './ledger/index.js';
import type { AnchorProof } from './ledger/anchor.js';
import { deserializeDetached, summarize } from './ledger/ots.js';

export const EVIDENCE_MEDIA_TYPE = 'application/vnd.mattermark.evidence-bundle.v1+json' as const;
export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1' as const;
export const PREDICATE_TYPE = 'https://mattermark.dev/attestations/evidence/v1' as const;
export const DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json' as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const KEY_ID = /^sha256:[0-9a-f]{64}$/;
const HEX_64_BYTES = /^[0-9a-f]{128}$/;
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface EvidenceKeyInfo {
  algorithm: 'ed25519';
  /** raw 32-byte Ed25519 public key, base64 encoded */
  publicKeyRaw: string;
  /** SHA-256 fingerprint of the raw public key */
  keyid: string;
}

export interface EvidenceStoredAnchor {
  proof: AnchorProof;
  merkleRoot: string;
  events: number;
  recordedAt: string;
  thirdPartyTime: boolean;
  describe?: string;
}

export interface EvidenceAnchorInput {
  stored: EvidenceStoredAnchor;
  inclusion: LedgerEventInclusion;
}

export interface EvidenceArtifactObservation {
  name: string;
  format: 'text' | 'docx' | 'pdf';
  sha256: string;
  recoveredToken: string;
  confidence: 'confirmed' | 'corroborated';
  channels: string[];
  frames: number;
  publicTokenVerification: boolean;
}

export interface EvidenceStatementInput {
  generatedAt: string;
  workspace: {
    orgName: string;
    scheme: 'ed25519' | 'hmac';
  };
  copy: ProtectedCopy;
  ledger: {
    chainVerifiedAtExport: boolean;
    current: {
      eventCount: number;
      root: string;
      inclusion: LedgerEventInclusion;
    };
    anchors: EvidenceAnchorInput[];
  };
  observation?: EvidenceArtifactObservation;
  disclosures: string[];
}

export interface EvidenceCopyEvent extends Omit<ChainedEvent, 'type' | 'payload'> {
  type: 'copy';
  payload: { copy: ProtectedCopy };
}

export interface EvidenceCopyInclusion {
  event: EvidenceCopyEvent;
  proof: MerkleInclusionProof;
}

export interface EvidenceAnchorRecord {
  stored: EvidenceStoredAnchor;
  inclusion: EvidenceCopyInclusion;
}

export interface MattermarkEvidencePredicate {
  schemaVersion: 1;
  generatedAt: string;
  workspace: EvidenceStatementInput['workspace'];
  copy: ProtectedCopy;
  ledger: {
    chainVerifiedAtExport: boolean;
    current: {
      eventCount: number;
      root: string;
      inclusion: EvidenceCopyInclusion;
    };
    anchors: EvidenceAnchorRecord[];
  };
  observation?: EvidenceArtifactObservation;
  disclosures: string[];
}

export interface MattermarkEvidenceStatement {
  _type: typeof STATEMENT_TYPE;
  subject: [{ name: string; digest: { sha256: string } }];
  predicateType: typeof PREDICATE_TYPE;
  predicate: MattermarkEvidencePredicate;
}

export interface MattermarkEvidenceBundle {
  mediaType: typeof EVIDENCE_MEDIA_TYPE;
  verificationMaterial: {
    publicKey: {
      algorithm: 'ed25519';
      raw: string;
      keyid: string;
    };
  };
  envelope: {
    payloadType: typeof DSSE_PAYLOAD_TYPE;
    payload: string;
    signatures: Array<{ keyid: string; sig: string }>;
  };
}

export type AnchorProofStatus =
  | 'local-valid'
  | 'ots-pending'
  | 'ots-bitcoin-attestation-unconfirmed'
  | 'invalid'
  | 'unsupported';

export interface EvidenceAnchorVerification {
  anchor: string;
  inclusionValid: boolean;
  proofStatus: AnchorProofStatus;
}

export interface VerifyEvidenceOptions {
  expectedKeyid?: string;
}

export interface EvidenceVerificationResult {
  valid: boolean;
  trust: 'invalid' | 'self-contained' | 'key-pinned';
  keyid: string;
  keyPinned?: boolean;
  signatureValid: boolean;
  statementValid: boolean;
  subjectValid: boolean;
  currentLedgerProofValid: boolean;
  anchorResults: EvidenceAnchorVerification[];
  artifact?: {
    supplied: boolean;
    digestMatches: boolean;
    markMatches: boolean;
  };
  errors: string[];
  warnings: string[];
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function requireInteger(value: unknown, label: string, min = Number.MIN_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || (value as number) < min) {
    throw new Error(`${label} must be an integer${min > Number.MIN_SAFE_INTEGER ? ` >= ${min}` : ''}`);
  }
  return value as number;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function requireSha256(value: unknown, label: string): string {
  const s = requireString(value, label);
  if (!SHA256_HEX.test(s)) throw new Error(`${label} must be a lowercase SHA-256 hex string`);
  return s;
}

function decodeCanonicalBase64(value: unknown, label: string): Buffer {
  const s = requireString(value, label);
  if (s.length === 0 || s.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) {
    throw new Error(`${label} must be canonical base64`);
  }
  const out = Buffer.from(s, 'base64');
  if (out.toString('base64') !== s) throw new Error(`${label} must be canonical base64`);
  return out;
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('evidence public key must be exactly 32 bytes');
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function copyEventName(copy: ProtectedCopy): string {
  return copy.protectedName ?? copy.sourceName ?? `copy-${copy.tokenHex.slice(0, 16)}`;
}

function asEvidenceInclusion(input: LedgerEventInclusion, label: string): EvidenceCopyInclusion {
  const cloned = structuredClone(input);
  if (cloned.event.type !== 'copy') throw new Error(`${label} must contain a copy event`);
  const payload = requireRecord(cloned.event.payload, `${label}.event.payload`);
  if (!isRecord(payload.copy)) throw new Error(`${label}.event.payload.copy must be an object`);
  return cloned as EvidenceCopyInclusion;
}

/** SHA-256 fingerprint of a raw Ed25519 public key. */
export function evidenceKeyInfo(publicKeyRaw: Buffer): EvidenceKeyInfo {
  if (publicKeyRaw.length !== 32) throw new Error('evidence public key must be exactly 32 bytes');
  return {
    algorithm: 'ed25519',
    publicKeyRaw: publicKeyRaw.toString('base64'),
    keyid: `sha256:${sha256(publicKeyRaw)}`,
  };
}

/** DSSE v1 pre-authentication encoding over the exact payload bytes. */
export function dssePAE(payloadType: string, payload: Buffer): Buffer {
  const typeBytes = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${typeBytes.length} `, 'utf8'),
    typeBytes,
    Buffer.from(` ${payload.length} `, 'utf8'),
    payload,
  ]);
}

/** Build the transparent in-toto-shaped statement before signing it. */
export function createEvidenceStatement(input: EvidenceStatementInput): MattermarkEvidenceStatement {
  const currentInclusion = asEvidenceInclusion(input.ledger.current.inclusion, 'current inclusion');
  const anchors: EvidenceAnchorRecord[] = input.ledger.anchors.map((anchor, i) => ({
    stored: structuredClone(anchor.stored),
    inclusion: asEvidenceInclusion(anchor.inclusion, `anchor ${i} inclusion`),
  }));
  const copy = structuredClone(input.copy);

  return {
    _type: STATEMENT_TYPE,
    subject: [{
      name: copyEventName(copy),
      digest: { sha256: copy.protectedHash },
    }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      schemaVersion: 1,
      generatedAt: input.generatedAt,
      workspace: structuredClone(input.workspace),
      copy,
      ledger: {
        chainVerifiedAtExport: input.ledger.chainVerifiedAtExport,
        current: {
          eventCount: input.ledger.current.eventCount,
          root: input.ledger.current.root,
          inclusion: currentInclusion,
        },
        anchors,
      },
      observation: input.observation === undefined ? undefined : structuredClone(input.observation),
      disclosures: input.disclosures.slice(),
    },
  };
}

/** Sign an exact Statement byte string in a DSSE-style envelope. */
export function signEvidenceStatement(
  statement: MattermarkEvidenceStatement,
  keyPair: EdKeyPair,
): MattermarkEvidenceBundle {
  const payload = Buffer.from(stableStringify(statement), 'utf8');
  const info = evidenceKeyInfo(keyPair.publicKeyRaw);
  const sig = edSign(null, dssePAE(DSSE_PAYLOAD_TYPE, payload), keyPair.privateKey);
  return {
    mediaType: EVIDENCE_MEDIA_TYPE,
    verificationMaterial: {
      publicKey: {
        algorithm: info.algorithm,
        raw: info.publicKeyRaw,
        keyid: info.keyid,
      },
    },
    envelope: {
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: payload.toString('base64'),
      signatures: [{ keyid: info.keyid, sig: sig.toString('base64') }],
    },
  };
}

function assertBundleShell(value: unknown): MattermarkEvidenceBundle {
  const bundle = requireRecord(value, 'Mattermark evidence bundle');
  if (bundle.mediaType !== EVIDENCE_MEDIA_TYPE) {
    throw new Error(`not a Mattermark evidence bundle (${EVIDENCE_MEDIA_TYPE})`);
  }
  const verificationMaterial = requireRecord(bundle.verificationMaterial, 'verificationMaterial');
  const publicKey = requireRecord(verificationMaterial.publicKey, 'verificationMaterial.publicKey');
  if (publicKey.algorithm !== 'ed25519') throw new Error('evidence public key algorithm must be ed25519');
  requireString(publicKey.raw, 'verificationMaterial.publicKey.raw');
  requireString(publicKey.keyid, 'verificationMaterial.publicKey.keyid');

  const envelope = requireRecord(bundle.envelope, 'envelope');
  requireString(envelope.payloadType, 'envelope.payloadType');
  requireString(envelope.payload, 'envelope.payload');
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) {
    throw new Error('version 1 envelope.signatures must contain exactly one signature');
  }
  for (let i = 0; i < envelope.signatures.length; i++) {
    const signature = requireRecord(envelope.signatures[i], `envelope.signatures[${i}]`);
    requireString(signature.keyid, `envelope.signatures[${i}].keyid`);
    requireString(signature.sig, `envelope.signatures[${i}].sig`);
  }
  return value as MattermarkEvidenceBundle;
}

/** Parse JSON and establish that it is at least a Mattermark bundle envelope. */
export function parseEvidenceBundle(text: string): MattermarkEvidenceBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('evidence bundle is not valid JSON');
  }
  try {
    return assertBundleShell(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Mattermark evidence bundle/i.test(msg)) throw err;
    throw new Error(`not a valid Mattermark evidence bundle: ${msg}`);
  }
}

function copyForIssuanceEvent(copy: ProtectedCopy): ProtectedCopy {
  return { ...structuredClone(copy), investigations: [] };
}

function sameCanonical(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function validateCopyShape(value: unknown): value is ProtectedCopy {
  if (!isRecord(value)) return false;
  if (typeof value.tokenHex !== 'string' || !/^[0-9a-f]+$/.test(value.tokenHex)) return false;
  if (typeof value.shortIdHex !== 'string' || !/^[0-9a-f]+$/.test(value.shortIdHex)) return false;
  if (value.scheme !== Scheme.HMAC_SHA256 && value.scheme !== Scheme.ED25519) return false;
  if (!isRecord(value.identity)) return false;
  for (const key of ['matterRef', 'recipientId', 'version', 'issuedAt', 'nonce']) {
    if (typeof value.identity[key] !== 'string') return false;
  }
  if (typeof value.originalHash !== 'string' || !SHA256_HEX.test(value.originalHash)) return false;
  if (typeof value.protectedHash !== 'string' || !SHA256_HEX.test(value.protectedHash)) return false;
  if (value.sourceName !== undefined && typeof value.sourceName !== 'string') return false;
  if (value.protectedName !== undefined && typeof value.protectedName !== 'string') return false;
  if (typeof value.generatedBy !== 'string' || typeof value.generatedAt !== 'string') return false;
  if (!Array.isArray(value.channels) || !Array.isArray(value.transformTests) || !Array.isArray(value.investigations)) return false;
  if (typeof value.deliveryMethod !== 'string') return false;
  return true;
}

function validateCopyEvent(
  inclusionRaw: unknown,
  expectedCopy: ProtectedCopy,
  expectedRoot: string,
  expectedSize: number,
): { valid: boolean; inclusion?: EvidenceCopyInclusion; error?: string } {
  try {
    const inclusion = requireRecord(inclusionRaw, 'ledger inclusion');
    const event = requireRecord(inclusion.event, 'ledger inclusion event');
    const proof = requireRecord(inclusion.proof, 'ledger inclusion proof') as unknown as MerkleInclusionProof;

    if (event.type !== 'copy') throw new Error('ledger inclusion event must be a copy event');
    const seq = requireInteger(event.seq, 'copy event sequence', 0);
    const at = requireString(event.at, 'copy event time');
    const prevHash = requireSha256(event.prevHash, 'copy event previous hash');
    const hash = requireSha256(event.hash, 'copy event hash');
    const payload = requireRecord(event.payload, 'copy event payload');
    if (!validateCopyShape(payload.copy)) throw new Error('copy event payload has an invalid protected copy');

    const typedEvent: EvidenceCopyEvent = {
      seq,
      type: 'copy',
      at,
      payload: { copy: payload.copy },
      prevHash,
      hash,
    };
    const core: EventCore = { seq, type: 'copy', at, payload: typedEvent.payload };
    if (eventHash(prevHash, core) !== hash) throw new Error('copy event hash does not reproduce');
    if (!sameCanonical(typedEvent.payload.copy, copyForIssuanceEvent(expectedCopy))) {
      throw new Error('copy event does not bind the statement protected copy');
    }
    if (proof.root !== expectedRoot) throw new Error('inclusion root does not match the stated ledger root');
    if (proof.treeSize !== expectedSize) throw new Error('inclusion tree size does not match the stated event count');
    if (proof.leafHash !== hash) throw new Error('inclusion leaf does not match the copy event hash');
    if (!verifyMerkleProof(proof)) throw new Error('Merkle inclusion proof is invalid');
    return { valid: true, inclusion: { event: typedEvent, proof } };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function classifyAnchor(
  raw: unknown,
  expectedCopy: ProtectedCopy,
  publicKey: KeyObject,
): { result: EvidenceAnchorVerification; warning?: string } {
  let anchorName = 'unknown';
  try {
    const record = requireRecord(raw, 'anchor record');
    const stored = requireRecord(record.stored, 'stored anchor');
    const proof = requireRecord(stored.proof, 'anchor proof');
    anchorName = requireString(proof.anchor, 'anchor proof name');
    const digest = requireSha256(proof.digest, 'anchor digest');
    const at = requireString(proof.at, 'anchor time');
    const material = requireRecord(proof.proof, 'anchor proof material');
    const merkleRoot = requireSha256(stored.merkleRoot, 'stored anchor root');
    const events = requireInteger(stored.events, 'stored anchor event count', 1);
    requireString(stored.recordedAt, 'stored anchor recorded time');
    requireBoolean(stored.thirdPartyTime, 'stored anchor third-party-time flag');

    const inclusion = validateCopyEvent(record.inclusion, expectedCopy, merkleRoot, events);
    const inclusionValid = inclusion.valid && digest === merkleRoot;
    if (!inclusionValid) {
      return {
        result: { anchor: anchorName, inclusionValid: false, proofStatus: 'invalid' },
        warning: `Anchor ${anchorName} was ignored because its copy inclusion or digest binding is invalid.`,
      };
    }

    if (anchorName === 'local-ed25519-attestation') {
      const sigHex = requireString(material.sig, 'local anchor signature');
      if (!HEX_64_BYTES.test(sigHex)) {
        return { result: { anchor: anchorName, inclusionValid: true, proofStatus: 'invalid' } };
      }
      const message = Buffer.from(`markityours-anchor|${digest}|${at}`, 'utf8');
      const valid = edVerify(null, message, publicKey, Buffer.from(sigHex, 'hex'));
      return {
        result: {
          anchor: anchorName,
          inclusionValid: true,
          proofStatus: valid ? 'local-valid' : 'invalid',
        },
        warning: valid ? undefined : 'The local ledger attestation signature is invalid.',
      };
    }

    if (anchorName === 'opentimestamps') {
      const otsBytes = decodeCanonicalBase64(material.ots, 'OpenTimestamps proof');
      const detached = deserializeDetached(otsBytes);
      if (detached.fileDigest.toString('hex') !== digest) {
        throw new Error('OpenTimestamps file digest does not match the anchor digest');
      }
      const summary = summarize(detached);
      if (summary.bitcoin.length > 0) {
        const heights = summary.bitcoin.map((item) => item.height).join(', ');
        return {
          result: {
            anchor: anchorName,
            inclusionValid: true,
            proofStatus: 'ots-bitcoin-attestation-unconfirmed',
          },
          warning:
            `OpenTimestamps carries a Bitcoin attestation for block ${heights}, but it is not independently confirmed. ` +
            'Check the commitment against a trusted Bitcoin block header before claiming confirmation.',
        };
      }
      if (summary.pending.length > 0) {
        return {
          result: { anchor: anchorName, inclusionValid: true, proofStatus: 'ots-pending' },
          warning: 'OpenTimestamps is still a pending calendar promise and does not yet prove priority.',
        };
      }
      return {
        result: { anchor: anchorName, inclusionValid: true, proofStatus: 'invalid' },
        warning: 'OpenTimestamps proof contains no recognized pending or Bitcoin attestation.',
      };
    }

    return {
      result: { anchor: anchorName, inclusionValid: true, proofStatus: 'unsupported' },
      warning: `Anchor ${anchorName} is carried in the bundle but is not understood by this verifier.`,
    };
  } catch (err) {
    return {
      result: { anchor: anchorName, inclusionValid: false, proofStatus: 'invalid' },
      warning: `Anchor ${anchorName} is invalid: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function invalidResult(errors: string[], warnings: string[] = [], keyid = ''): EvidenceVerificationResult {
  return {
    valid: false,
    trust: 'invalid',
    keyid,
    signatureValid: false,
    statementValid: false,
    subjectValid: false,
    currentLedgerProofValid: false,
    anchorResults: [],
    errors,
    warnings,
  };
}

/**
 * Verify a bundle without a Mattermark vault. The result keeps independent
 * checks visible so callers cannot mistake "signature valid" for "identity
 * pinned", or an OTS block-height attestation for header-confirmed Bitcoin.
 */
export function verifyEvidenceBundle(
  value: unknown,
  opts: VerifyEvidenceOptions = {},
): EvidenceVerificationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let bundle: MattermarkEvidenceBundle;
  try {
    bundle = assertBundleShell(value);
  } catch (err) {
    return invalidResult([err instanceof Error ? err.message : String(err)]);
  }

  let rawKey: Buffer;
  let publicKey: KeyObject;
  let keyid = '';
  try {
    const material = bundle.verificationMaterial.publicKey;
    rawKey = decodeCanonicalBase64(material.raw, 'evidence public key');
    if (rawKey.length !== 32) throw new Error('evidence public key must be exactly 32 bytes');
    keyid = `sha256:${sha256(rawKey)}`;
    if (!KEY_ID.test(material.keyid) || material.keyid !== keyid) {
      throw new Error('embedded key ID does not match the evidence public key');
    }
    publicKey = publicKeyFromRaw(rawKey);
  } catch (err) {
    return invalidResult([err instanceof Error ? err.message : String(err)], warnings, keyid);
  }

  let keyPinned: boolean | undefined;
  if (opts.expectedKeyid !== undefined) {
    if (!KEY_ID.test(opts.expectedKeyid)) {
      errors.push('expected key ID must have the form sha256:<64 lowercase hex characters>');
      keyPinned = false;
    } else {
      keyPinned = opts.expectedKeyid === keyid;
      if (!keyPinned) errors.push(`expected key ${opts.expectedKeyid} does not match bundle key ${keyid}`);
    }
  }

  let payload: ReturnType<typeof decodeCanonicalBase64> = Buffer.alloc(0) as ReturnType<typeof decodeCanonicalBase64>;
  let signatureValid = false;
  try {
    payload = decodeCanonicalBase64(bundle.envelope.payload, 'DSSE payload');
    const signatureRecord = bundle.envelope.signatures.find((item) => item.keyid === keyid);
    if (!signatureRecord) throw new Error(`no DSSE signature matches key ${keyid}`);
    const signature = decodeCanonicalBase64(signatureRecord.sig, 'DSSE signature');
    if (signature.length !== 64) throw new Error('DSSE Ed25519 signature must be exactly 64 bytes');
    signatureValid = edVerify(
      null,
      dssePAE(bundle.envelope.payloadType, payload),
      publicKey,
      signature,
    );
    if (!signatureValid) errors.push('DSSE signature verification failed');
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  let statementRaw: unknown;
  try {
    statementRaw = JSON.parse(payload.toString('utf8'));
    if (stableStringify(statementRaw) !== payload.toString('utf8')) {
      errors.push('signed evidence payload must use the canonical JSON encoding');
      const result = invalidResult(errors, warnings, keyid);
      result.signatureValid = signatureValid;
      result.keyPinned = keyPinned;
      return result;
    }
  } catch {
    errors.push('signed payload is not valid JSON');
    const result = invalidResult(errors, warnings, keyid);
    result.signatureValid = signatureValid;
    result.keyPinned = keyPinned;
    return result;
  }

  let statementValid = true;
  let subjectValid = true;
  let currentLedgerProofValid = true;
  let copy: ProtectedCopy | undefined;
  let anchorsRaw: unknown[] = [];

  try {
    const statement = requireRecord(statementRaw, 'evidence statement');
    if (statement._type !== STATEMENT_TYPE) {
      statementValid = false;
      errors.push(`statement _type must be ${STATEMENT_TYPE}`);
    }
    if (statement.predicateType !== PREDICATE_TYPE) {
      statementValid = false;
      errors.push(`predicateType must be ${PREDICATE_TYPE}`);
    }
    if (!Array.isArray(statement.subject) || statement.subject.length !== 1) {
      subjectValid = false;
      errors.push('statement must contain exactly one subject');
    }

    const predicate = requireRecord(statement.predicate, 'evidence predicate');
    if (predicate.schemaVersion !== 1) {
      statementValid = false;
      errors.push('evidence predicate schemaVersion must be 1');
    }
    requireString(predicate.generatedAt, 'evidence generation time');
    const workspace = requireRecord(predicate.workspace, 'evidence workspace');
    requireString(workspace.orgName, 'workspace organization name');
    if (workspace.scheme !== 'ed25519' && workspace.scheme !== 'hmac') {
      statementValid = false;
      errors.push('workspace token scheme must be ed25519 or hmac');
    }

    if (!validateCopyShape(predicate.copy)) {
      throw new Error('evidence predicate has an invalid protected copy');
    }
    copy = predicate.copy;
    if (
      (workspace.scheme === 'ed25519' && copy.scheme !== Scheme.ED25519) ||
      (workspace.scheme === 'hmac' && copy.scheme !== Scheme.HMAC_SHA256)
    ) {
      statementValid = false;
      errors.push('workspace token scheme does not match the protected copy');
    }

    if (copy.scheme === Scheme.ED25519) {
      const token = Buffer.from(copy.tokenHex, 'hex');
      if (
        token.length !== 68 ||
        !ed25519VerifyToken(publicKey, new Uint8Array(token)) ||
        !ed25519MatchesIdentity(copy.identity, new Uint8Array(token))
      ) {
        statementValid = false;
        errors.push('Ed25519 watermark token does not verify against the evidence key and copy identity');
      }
    } else {
      warnings.push(
        'HMAC watermark tokens are not publicly self-verifying. A pinned evidence signature authenticates the organization’s mapping, but independent token verification still requires the private vault key.',
      );
    }

    if (Array.isArray(statement.subject) && statement.subject.length === 1) {
      const subject = requireRecord(statement.subject[0], 'statement subject');
      const digest = requireRecord(subject.digest, 'statement subject digest');
      if (subject.name !== copyEventName(copy)) {
        subjectValid = false;
        errors.push('statement subject name does not match the protected copy');
      }
      if (digest.sha256 !== copy.protectedHash || !SHA256_HEX.test(String(digest.sha256))) {
        subjectValid = false;
        errors.push('statement subject digest does not match the protected copy SHA-256');
      }
    }

    const ledger = requireRecord(predicate.ledger, 'evidence ledger');
    if (ledger.chainVerifiedAtExport !== true) {
      statementValid = false;
      errors.push('ledger hash chain was not verified at export');
    }
    const current = requireRecord(ledger.current, 'current ledger proof');
    const eventCount = requireInteger(current.eventCount, 'current ledger event count', 1);
    const root = requireSha256(current.root, 'current ledger root');
    const currentCheck = validateCopyEvent(current.inclusion, copy, root, eventCount);
    currentLedgerProofValid = currentCheck.valid;
    if (!currentCheck.valid) {
      statementValid = false;
      errors.push(`current ledger proof is invalid: ${currentCheck.error ?? 'unknown error'}`);
    }

    if (!Array.isArray(ledger.anchors)) {
      statementValid = false;
      errors.push('ledger anchors must be an array');
    } else {
      anchorsRaw = ledger.anchors;
    }
    if (!Array.isArray(predicate.disclosures) || !predicate.disclosures.every((item) => typeof item === 'string')) {
      statementValid = false;
      errors.push('evidence disclosures must be an array of strings');
    }
  } catch (err) {
    statementValid = false;
    subjectValid = false;
    currentLedgerProofValid = false;
    errors.push(err instanceof Error ? err.message : String(err));
  }

  const anchorResults: EvidenceAnchorVerification[] = [];
  if (copy !== undefined) {
    for (const raw of anchorsRaw) {
      const classified = classifyAnchor(raw, copy, publicKey);
      anchorResults.push(classified.result);
      if (classified.warning) warnings.push(classified.warning);
    }
  }

  const coreValid =
    bundle.mediaType === EVIDENCE_MEDIA_TYPE &&
    bundle.envelope.payloadType === DSSE_PAYLOAD_TYPE &&
    signatureValid &&
    statementValid &&
    subjectValid &&
    currentLedgerProofValid &&
    (keyPinned !== false) &&
    errors.length === 0;
  if (bundle.envelope.payloadType !== DSSE_PAYLOAD_TYPE) {
    errors.push(`DSSE payload type must be ${DSSE_PAYLOAD_TYPE}`);
  }

  // A block-height attestation is useful evidence, but it is not an
  // independently confirmed external timestamp until a trusted block header
  // verifies the commitment. Do not upgrade the trust grade merely because
  // an unconfirmed attestation is present.
  let trust: EvidenceVerificationResult['trust'] = 'invalid';
  if (coreValid) {
    if (keyPinned === true) trust = 'key-pinned';
    else trust = 'self-contained';
  }

  if (keyPinned === undefined) {
    warnings.push(
      'The bundle is internally consistent, but the embedded public key is not an identity. Pin its SHA-256 fingerprint through a trusted organizational channel.',
    );
  }

  return {
    valid: coreValid,
    trust,
    keyid,
    keyPinned,
    signatureValid,
    statementValid,
    subjectValid,
    currentLedgerProofValid,
    anchorResults,
    errors,
    warnings,
  };
}
