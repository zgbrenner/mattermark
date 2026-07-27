/**
 * anchor.ts - anchoring the ledger's Merkle root so a protected-copy record is
 * provably prior to a point in time.
 *
 * The hash chain proves order and integrity inside the ledger. A skeptical
 * third party also needs an external trust root for time. This module keeps the
 * original synchronous Anchor contract, provides a local Ed25519 attestation,
 * and adds an OpenTimestamps adapter backed by the official `ots` CLI.
 */

import { sign, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { EdKeyPair } from '../crypto.js';

export interface AnchorProof {
  /** which anchor produced this proof */
  anchor: string;
  /** the digest (Merkle root) that was anchored */
  digest: string;
  /** request time; trusted only as far as the anchor is */
  at: string;
  /** anchor-specific proof material */
  proof: Record<string, unknown>;
}

export interface Anchor {
  readonly name: string;
  /** whether this anchor can attest time through an independent trust root */
  readonly thirdPartyTime: boolean;
  commit(digest: string, at: string): AnchorProof;
  verify(proof: AnchorProof): boolean;
}

export type AnchorStatus = 'verified' | 'pending' | 'invalid' | 'unavailable';

/** Rich verification result for anchors whose proofs mature over time. */
export interface AnchorInspection {
  status: AnchorStatus;
  /** true only when the proof currently verifies */
  valid: boolean;
  /** true only when the verified proof carries independently attested time */
  thirdPartyTime: boolean;
  detail: string;
  blockHeight?: number;
  attestedAt?: string;
}

export interface RefreshableAnchor extends Anchor {
  inspect(proof: AnchorProof): AnchorInspection;
  /** Return a refreshed proof without mutating the caller's proof object. */
  refresh(proof: AnchorProof): AnchorProof;
}

/**
 * A local, offline anchor. The organisation signs the digest and claimed time
 * with its Ed25519 key. This is non-repudiable as to the organisation, but the
 * time is self-asserted, so thirdPartyTime is false.
 */
export function localAttestationAnchor(kp: EdKeyPair): Anchor {
  const message = (digest: string, at: string) =>
    Buffer.from(`markityours-anchor|${digest}|${at}`, 'utf8');

  return {
    name: 'local-ed25519-attestation',
    thirdPartyTime: false,
    commit(digest, at) {
      const sig = sign(null, message(digest, at), kp.privateKey).toString('hex');
      return { anchor: 'local-ed25519-attestation', digest, at, proof: { sig } };
    },
    verify(p) {
      if (p.anchor !== 'local-ed25519-attestation' || typeof p.proof.sig !== 'string') {
        return false;
      }
      try {
        return verify(
          null,
          message(p.digest, p.at),
          kp.publicKey,
          Buffer.from(p.proof.sig, 'hex'),
        );
      } catch {
        return false;
      }
    },
  };
}

/* -------------------------- OpenTimestamps anchor ------------------------- */

const OTS_ANCHOR_NAME = 'opentimestamps-bitcoin-v1';
const OTS_FORMAT = 'opentimestamps-file-v1';
const OTS_TARGET_FILE = 'mattermark-anchor.json';

export interface OtsCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Injectable command runner. Tests use this instead of network calendars. */
export type OtsRunner = (args: string[], cwd: string) => OtsCommandResult;

export interface OpenTimestampsOptions {
  /** CLI executable name or absolute path. Default: `ots`. */
  command?: string;
  /** Test or host integration seam. Default: synchronous child process. */
  runner?: OtsRunner;
}

interface OtsMaterial {
  format: string;
  statement: string;
  ots: string;
}

interface ValidatedOtsProof {
  statement: string;
  bytes: Buffer;
}

function canonicalStatement(digest: string, at: string): string {
  return JSON.stringify({
    domain: 'mattermark.anchor.v1',
    digest,
    requestedAt: at,
  });
}

function defaultRunner(command: string): OtsRunner {
  return (args, cwd) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error,
    };
  };
}

function cleanDetail(output: string): string {
  return output.trim().replace(/\s+/g, ' ');
}

function commandUnavailable(result: OtsCommandResult): boolean {
  return result.status === null || Boolean(result.error);
}

function commandError(command: string, result: OtsCommandResult): Error {
  const detail = cleanDetail(
    [result.error?.message, result.stderr, result.stdout].filter(Boolean).join('\n'),
  );
  return new Error(
    `OpenTimestamps CLI (${command}) unavailable or failed${detail ? `: ${detail}` : ''}`,
  );
}

function invalidInspection(detail: string): AnchorInspection {
  return {
    status: 'invalid',
    valid: false,
    thirdPartyTime: false,
    detail,
  };
}

function normalizeDigest(digest: string): string {
  if (!/^[0-9a-f]{64}$/i.test(digest)) {
    throw new Error(
      'OpenTimestamps anchor requires a 32-byte SHA-256 digest encoded as 64 hex characters',
    );
  }
  return digest.toLowerCase();
}

function isMaterial(value: Record<string, unknown>): value is Record<string, unknown> & OtsMaterial {
  return (
    value.format === OTS_FORMAT &&
    typeof value.statement === 'string' &&
    typeof value.ots === 'string'
  );
}

function proofMaterial(
  proof: AnchorProof,
): { ok: true; value: ValidatedOtsProof } | { ok: false; error: string } {
  if (!proof || proof.anchor !== OTS_ANCHOR_NAME) {
    return { ok: false, error: 'wrong anchor type' };
  }
  if (typeof proof.digest !== 'string' || typeof proof.at !== 'string') {
    return { ok: false, error: 'missing digest or requested time' };
  }
  try {
    normalizeDigest(proof.digest);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (!proof.proof || typeof proof.proof !== 'object' || !isMaterial(proof.proof)) {
    return { ok: false, error: 'missing or unsupported OpenTimestamps proof material' };
  }

  const expected = canonicalStatement(proof.digest.toLowerCase(), proof.at);
  if (proof.proof.statement !== expected) {
    return {
      ok: false,
      error: 'proof statement is not bound to the supplied digest and requested time',
    };
  }

  const compact = proof.proof.ots.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    return { ok: false, error: 'malformed base64 OpenTimestamps proof' };
  }
  const bytes = Buffer.from(compact, 'base64');
  const canonicalInput = compact.replace(/=+$/, '');
  const canonicalOutput = bytes.toString('base64').replace(/=+$/, '');
  if (bytes.length === 0 || canonicalInput !== canonicalOutput) {
    return { ok: false, error: 'malformed base64 OpenTimestamps proof' };
  }

  return {
    ok: true,
    value: { statement: proof.proof.statement, bytes },
  };
}

function withProofFiles<T>(
  proof: AnchorProof,
  fn: (paths: { dir: string; target: string; ots: string }) => T,
): { ok: true; value: T } | { ok: false; error: string } {
  const material = proofMaterial(proof);
  if (!material.ok) return material;

  const dir = mkdtempSync(join(tmpdir(), 'mattermark-ots-'));
  try {
    const target = join(dir, OTS_TARGET_FILE);
    const ots = `${target}.ots`;
    writeFileSync(target, material.value.statement, 'utf8');
    writeFileSync(ots, material.value.bytes);
    return { ok: true, value: fn({ dir, target, ots }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * OpenTimestamps external anchor, backed by the official `ots` CLI.
 *
 * `commit` normally creates a pending detached proof. Call `refresh` after a
 * Bitcoin confirmation, then use `inspect` or `verify`. The proof's `at` field
 * remains the local request time. Only `inspection.attestedAt` on a verified
 * proof is independently attested.
 */
export function openTimestampsCliAnchor(
  options: OpenTimestampsOptions = {},
): RefreshableAnchor {
  const command = options.command ?? 'ots';
  const run = options.runner ?? defaultRunner(command);

  const inspect = (proof: AnchorProof): AnchorInspection => {
    const material = proofMaterial(proof);
    if (!material.ok) return invalidInspection(material.error);

    const verification = withProofFiles(proof, ({ dir, ots }) =>
      run(['verify', basename(ots)], dir),
    );
    if (!verification.ok) return invalidInspection(verification.error);

    const result = verification.value;
    if (commandUnavailable(result)) {
      return {
        status: 'unavailable',
        valid: false,
        thirdPartyTime: false,
        detail: cleanDetail(result.error?.message ?? 'OpenTimestamps CLI unavailable'),
      };
    }

    const output = cleanDetail(`${result.stdout}\n${result.stderr}`);
    const success = /Success!\s+Bitcoin block\s+(\d+)\s+attests existence as of\s+(.+?)\s*$/i.exec(
      output,
    );
    if (result.status === 0 && success) {
      return {
        status: 'verified',
        valid: true,
        thirdPartyTime: true,
        detail: success[0],
        blockHeight: Number(success[1]),
        attestedAt: success[2].trim(),
      };
    }

    if (/Pending confirmation in Bitcoin blockchain/i.test(output)) {
      return {
        status: 'pending',
        valid: false,
        thirdPartyTime: false,
        detail: 'Pending confirmation in Bitcoin blockchain',
      };
    }

    return invalidInspection(
      output || `OpenTimestamps verification exited with status ${result.status}`,
    );
  };

  return {
    name: OTS_ANCHOR_NAME,
    thirdPartyTime: true,

    commit(digest, at) {
      const normalizedDigest = normalizeDigest(digest);
      const statement = canonicalStatement(normalizedDigest, at);
      const dir = mkdtempSync(join(tmpdir(), 'mattermark-ots-'));
      try {
        const target = join(dir, OTS_TARGET_FILE);
        writeFileSync(target, statement, 'utf8');
        const result = run(['stamp', basename(target)], dir);
        if (commandUnavailable(result) || result.status !== 0) {
          throw commandError(command, result);
        }

        const proofPath = `${target}.ots`;
        if (!existsSync(proofPath)) {
          throw new Error('OpenTimestamps CLI completed without creating a .ots proof');
        }
        const ots = readFileSync(proofPath);
        if (ots.length === 0) {
          throw new Error('OpenTimestamps CLI created an empty .ots proof');
        }

        return {
          anchor: OTS_ANCHOR_NAME,
          digest: normalizedDigest,
          at,
          proof: {
            format: OTS_FORMAT,
            statement,
            ots: ots.toString('base64'),
          },
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    inspect,

    verify(proof) {
      return inspect(proof).valid;
    },

    refresh(proof) {
      const material = proofMaterial(proof);
      if (!material.ok) {
        throw new Error(`OpenTimestamps proof is invalid: ${material.error}`);
      }

      const upgraded = withProofFiles(proof, ({ dir, ots }) => {
        const result = run(['upgrade', basename(ots)], dir);
        if (commandUnavailable(result) || result.status !== 0) {
          throw commandError(command, result);
        }
        return readFileSync(ots);
      });
      if (!upgraded.ok) {
        throw new Error(`OpenTimestamps proof is invalid: ${upgraded.error}`);
      }

      return {
        ...proof,
        proof: {
          ...proof.proof,
          ots: upgraded.value.toString('base64'),
        },
      };
    },
  };
}
