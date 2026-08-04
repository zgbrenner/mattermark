/**
 * workspace-evidence.ts — bridge a sealed Workspace to portable evidence.
 *
 * Kept separate from workspace.ts so the evidence format and verifier can
 * evolve without turning the core document operations layer into a monolith.
 * Exporting evidence is read-only: it never adds an investigation event or
 * changes a previously issued ledger row.
 */

import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

import { deriveEd25519 } from './crypto.js';
import { Scheme } from './frame.js';
import {
  createEvidenceStatement,
  evidenceKeyInfo,
  signEvidenceStatement,
  type EvidenceArtifactObservation,
  type EvidenceKeyInfo,
  type EvidenceStatementInput,
  type MattermarkEvidenceBundle,
} from './evidence.js';
import type { SecureRegistry } from './ledger/index.js';
import type { ProtectedCopy } from './registry.js';
import {
  Workspace,
  slug,
  sniffFormat,
  type ProtectOptions,
  type ProtectOutcome,
} from './workspace.js';

interface WorkspaceInternals {
  orgKey: Buffer;
  registry: SecureRegistry;
}

function internals(ws: Workspace): WorkspaceInternals {
  // TypeScript `private` protects callers at compile time, but these fields are
  // ordinary properties at runtime. The narrow bridge keeps that coupling in
  // one reviewed file rather than spreading casts through CLI and UI code.
  return ws as unknown as WorkspaceInternals;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/* ----------------------- issuance filename compatibility ------------------ */

/**
 * Workspace v1 predates portable evidence filenames. Intercept the registry
 * write at issuance time so new rows persist the exact source and suggested
 * protected names without changing the vault format or rewriting old rows.
 *
 * The wrapper is installed once whenever the package library or extended CLI
 * loads this module. Existing rows remain readable and fall back to token-based
 * subject names.
 */
const PATCH = Symbol.for('mattermark.workspace-evidence.filename-patch');
type PatchablePrototype = typeof Workspace.prototype & { [PATCH]?: boolean };
const prototype = Workspace.prototype as PatchablePrototype;
if (!prototype[PATCH]) {
  const originalProtect = prototype.protect;
  prototype.protect = function patchedProtect(
    input: { name: string; bytes: Buffer },
    opts: ProtectOptions,
  ): ProtectOutcome {
    const registry = internals(this).registry as SecureRegistry & {
      add(copy: ProtectedCopy, at?: string): void;
    };
    const originalAdd = registry.add;
    const format = sniffFormat(input.bytes);
    const stem = basename(input.name, extname(input.name)) || 'document';
    const extension =
      format === 'docx'
        ? '.docx'
        : format === 'pdf'
          ? '.pdf'
          : extname(input.name) || '.txt';
    const protectedName = `${stem}--${slug(opts.recipient)}${extension}`;

    registry.add = function addNamedCopy(copy: ProtectedCopy, at?: string): void {
      copy.sourceName = input.name;
      copy.protectedName = protectedName;
      originalAdd.call(registry, copy, at);
    };
    try {
      return originalProtect.call(this, input, opts);
    } finally {
      registry.add = originalAdd;
    }
  };
  prototype[PATCH] = true;
}

export function evidenceKeyForWorkspace(ws: Workspace): EvidenceKeyInfo {
  const kp = deriveEd25519(internals(ws).orgKey);
  return evidenceKeyInfo(kp.publicKeyRaw);
}

export interface ExportWorkspaceEvidenceOptions {
  artifact?: { name: string; bytes: Buffer };
}

export function exportWorkspaceEvidence(
  ws: Workspace,
  tokenOrShortId: string,
  opts: ExportWorkspaceEvidenceOptions = {},
): MattermarkEvidenceBundle {
  const { orgKey, registry } = internals(ws);
  const copy = ws.resolve(tokenOrShortId);
  if (!copy) throw new Error(`no protected copy resolves ${tokenOrShortId}`);
  if (!registry.verify()) throw new Error('cannot export evidence: registry hash chain is broken');

  const currentEvents = registry.eventCount();
  const currentRoot = registry.merkleRoot();
  const currentInclusion = registry.proveCopy(copy.tokenHex);

  const anchors: EvidenceStatementInput['ledger']['anchors'] = [];
  const disclosures: string[] = [
    'This bundle contains sensitive matter and recipient metadata. Handle it as evidence, not as a public receipt.',
    'The embedded public key proves internal consistency, not organizational identity. Pin its SHA-256 fingerprint through a trusted channel.',
    'Investigation history in the protected-copy record is a signed snapshot at export time; those later investigation entries are not separately proven by the copy-issuance Merkle path.',
  ];

  for (const stored of ws.listAnchors()) {
    try {
      if (!Number.isInteger(stored.events) || stored.events < 1 || stored.events > currentEvents) {
        disclosures.push(`Skipped malformed ${stored.proof.anchor} anchor with event count ${stored.events}.`);
        continue;
      }
      const historicalRoot = registry.rootAt(stored.events);
      if (historicalRoot !== stored.merkleRoot || stored.proof.digest !== stored.merkleRoot) {
        disclosures.push(`Skipped ${stored.proof.anchor} anchor because its stored root does not match the ledger prefix.`);
        continue;
      }
      const inclusion = registry.proveCopy(copy.tokenHex, stored.events);
      anchors.push({ stored, inclusion });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/predates the copy/i.test(message)) {
        disclosures.push(
          `The ${stored.proof.anchor} anchor recorded at ${stored.recordedAt} predates this copy and therefore cannot prove this issuance.`,
        );
      } else {
        disclosures.push(`Skipped ${stored.proof.anchor} anchor: ${message}`);
      }
    }
  }

  let observation: EvidenceArtifactObservation | undefined;
  if (opts.artifact) {
    const found = ws.identify(opts.artifact);
    if (!found.attribution?.copy) {
      throw new Error(`artifact ${opts.artifact.name} does not attribute to a protected copy in this workspace`);
    }
    if (found.attribution.copy.tokenHex !== copy.tokenHex) {
      throw new Error(`artifact ${opts.artifact.name} attributes to a different protected copy`);
    }
    observation = {
      name: opts.artifact.name,
      format: found.format,
      sha256: sha256(opts.artifact.bytes),
      recoveredToken: found.attribution.tokenHex,
      confidence: found.attribution.confidence === 'confirmed' ? 'confirmed' : 'corroborated',
      channels: found.attribution.channels,
      frames: found.attribution.frames,
      publicTokenVerification: copy.scheme === Scheme.ED25519,
    };
  }

  const statement = createEvidenceStatement({
    generatedAt: new Date().toISOString(),
    workspace: { orgName: ws.config.orgName, scheme: ws.config.scheme },
    copy,
    ledger: {
      chainVerifiedAtExport: true,
      current: {
        eventCount: currentEvents,
        root: currentRoot,
        inclusion: currentInclusion,
      },
      anchors,
    },
    observation,
    disclosures,
  });

  return signEvidenceStatement(statement, deriveEd25519(orgKey));
}
