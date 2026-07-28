/**
 * workspace.ts — the product surface's shared operations layer (Slice 4).
 *
 * Everything a user-facing surface (CLI, local web UI) needs, behind one
 * narrow API, so the surfaces stay thin and the behaviour stays identical:
 *
 *   initWorkspace / openWorkspace  — a passphrase-sealed vault directory
 *   Workspace.protect              — mark a TXT/DOCX for a recipient, verify
 *                                    survival at issue time, record evidence
 *   Workspace.identify             — attribute a recovered TXT/DOCX/PDF
 *   Workspace.report               — evidence report for one protected copy
 *   Workspace.status / list        — ledger integrity and issued copies
 *
 * Vault layout (one directory):
 *   config.json   — non-secret metadata (version, org name, scheme)
 *   org.key       — the 32-byte org key, sealed (AES-256-GCM via vault.ts)
 *   registry.mmv  — the SecureRegistry event log, sealed + hash-chained
 *
 * The org key and the registry are sealed under the SAME passphrase: one
 * secret to manage, one prompt to answer. Losing the passphrase loses the
 * ability to attribute — say so loudly in every surface.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

import { mark, detect, MarkOptions, MarkResult, RecoveredToken } from './orchestrator.js';
import {
  CopyIdentity,
  Issuer,
  newCopyIdentity,
  hmacIssuer,
  ed25519Issuer,
  deriveEd25519,
  hmacToken,
  shortIdToken,
} from './crypto.js';
import { Scheme } from './frame.js';
import { CHAINS, applyChain, excerpt } from './transforms.js';
import {
  ProtectedCopy,
  InvestigationEvent,
  TransformTestResult,
  DeliveryMethod,
} from './registry.js';
import { SecureRegistry } from './ledger/index.js';
import { seal, unseal } from './ledger/vault.js';
import { markDocx, readDocxText, MarkDocxResult } from './formats/index.js';
import { extractPdfText } from './formats/pdf.js';

export const WORKSPACE_VERSION = 1;
export const CONFIG_FILE = 'config.json';
export const ORG_KEY_FILE = 'org.key';
export const REGISTRY_FILE = 'registry.mmv';

export type SchemeName = 'ed25519' | 'hmac';

export interface WorkspaceConfig {
  version: number;
  orgName: string;
  scheme: SchemeName;
  createdAt: string;
}

export type DocFormat = 'docx' | 'pdf' | 'text';

/** Cheap, reliable format sniffing by magic bytes. */
export function sniffFormat(bytes: Buffer): DocFormat {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'docx'; // "PK" zip
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return 'text';
}

/** Filesystem-safe slug for embedding a recipient in an output filename. */
export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'recipient'
  );
}

export function workspaceExists(dir: string): boolean {
  return existsSync(join(dir, CONFIG_FILE)) && existsSync(join(dir, REGISTRY_FILE));
}

export interface ProtectOptions {
  matter: string;
  recipient: string;
  version?: string;
  generatedBy?: string;
  deliveryMethod?: DeliveryMethod;
  deliveryNote?: string;
  /**
   * Search-safe mode: no homoglyph substitutions, so exact-match search,
   * spellcheck, and e-discovery keyword indexing are untouched — at the
   * documented price of a NON-DURABLE mark (dies to routine sanitization).
   */
  searchSafe?: boolean;
  /** Cap on homoglyph substitution density in [0,1]; ignored in searchSafe mode. */
  maxHomoglyphDensity?: number;
}

export interface ProtectOutcome {
  /** the marked artifact, ready to deliver */
  bytes: Buffer;
  /** suggested output filename, e.g. `brief--opposing-counsel.docx` */
  suggestedName: string;
  format: Extract<DocFormat, 'docx' | 'text'>;
  result: MarkResult;
  /** the evidence row as recorded in the sealed registry */
  copy: ProtectedCopy;
  /** issue-time survival check of THIS copy against the transform gauntlet */
  transformTests: TransformTestResult[];
  /** fraction of gauntlet chains this copy survived, in [0,1] */
  survivalRate: number;
}

export type MatchConfidence = 'confirmed' | 'corroborated' | 'unrecognized';

export interface IdentifyMatch {
  tokenHex: string;
  scheme: Scheme;
  short: boolean;
  channels: string[];
  frames: number;
  /**
   * confirmed     — full-strength token, cryptographically re-verified against
   *                 the registry row's identity (128-bit / Ed25519 signature)
   * corroborated  — short registry pointer, recomputed from the row's identity
   *                 (64-bit; corroborating evidence, not a standalone claim)
   * unrecognized  — a mark was recovered but no registry row resolves it
   */
  confidence: MatchConfidence;
  copy?: ProtectedCopy;
}

export interface IdentifyOutcome {
  format: DocFormat;
  anyRecovered: boolean;
  /** best-first: confirmed > corroborated > unrecognized, then corroboration */
  matches: IdentifyMatch[];
  /** the single best attribution, if any resolved to a registry row */
  attribution?: IdentifyMatch;
}

export interface WorkspaceStatus {
  config: WorkspaceConfig;
  copies: number;
  events: number;
  chainOk: boolean;
  head: string;
  merkleRoot: string;
}

export function initWorkspace(
  dir: string,
  passphrase: string,
  opts: { orgName?: string; scheme?: SchemeName } = {},
): Workspace {
  if (workspaceExists(dir)) throw new Error(`a workspace already exists at ${dir}`);
  if (passphrase.length < 8) {
    throw new Error('passphrase must be at least 8 characters — it protects the org key and the registry');
  }
  mkdirSync(dir, { recursive: true });

  const config: WorkspaceConfig = {
    version: WORKSPACE_VERSION,
    orgName: opts.orgName ?? 'unnamed-org',
    scheme: opts.scheme ?? 'ed25519',
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config, null, 2) + '\n', 'utf8');

  const orgKey = randomBytes(32);
  writeFileSync(join(dir, ORG_KEY_FILE), seal(orgKey, passphrase));

  const registry = SecureRegistry.create(join(dir, REGISTRY_FILE), passphrase);
  return new Workspace(dir, config, orgKey, registry);
}

export function openWorkspace(dir: string, passphrase: string): Workspace {
  if (!workspaceExists(dir)) {
    throw new Error(`no workspace at ${dir} — run init first`);
  }
  const config = JSON.parse(readFileSync(join(dir, CONFIG_FILE), 'utf8')) as WorkspaceConfig;
  if (config.version !== WORKSPACE_VERSION) {
    throw new Error(`workspace version ${config.version} is not supported by this build`);
  }
  const orgKey = unseal(readFileSync(join(dir, ORG_KEY_FILE)), passphrase);
  const registry = SecureRegistry.open(join(dir, REGISTRY_FILE), passphrase);
  return new Workspace(dir, config, orgKey, registry);
}

export class Workspace {
  readonly issuer: Issuer;

  constructor(
    readonly dir: string,
    readonly config: WorkspaceConfig,
    private readonly orgKey: Buffer,
    private readonly registry: SecureRegistry,
  ) {
    this.issuer =
      config.scheme === 'hmac'
        ? hmacIssuer(orgKey, (hex) => this.registry.has(hex))
        : ed25519Issuer(deriveEd25519(orgKey), orgKey);
  }

  /* ------------------------------- protect ------------------------------- */

  protect(input: { name: string; bytes: Buffer }, opts: ProtectOptions): ProtectOutcome {
    const format = sniffFormat(input.bytes);
    if (format === 'pdf') {
      throw new Error(
        'PDF marking is not supported: faithful reinjection is a glyph-layout problem ' +
          '(see README). Mark the DOCX source instead — a marked DOCX exported to PDF ' +
          'keeps its marks in the PDF text layer, and identify reads them back.',
      );
    }
    if (!opts.matter.trim() || !opts.recipient.trim()) {
      throw new Error('matter and recipient are required — they are what a recovered mark resolves to');
    }

    const identity = newCopyIdentity(opts.matter.trim(), opts.recipient.trim(), opts.version?.trim() || 'v1');
    const markOpts: MarkOptions = opts.searchSafe
      ? { codecs: ['WS', 'ZW'], allowNonDurable: true }
      : { codecs: ['WS', 'ZW', 'HG'], maxHomoglyphDensity: opts.maxHomoglyphDensity };

    let bytes: Buffer;
    let result: MarkResult;
    let originalText: string;
    if (format === 'docx') {
      originalText = readDocxText(input.bytes);
      const marked: MarkDocxResult = markDocx(input.bytes, identity, this.issuer, markOpts);
      bytes = marked.bytes;
      result = marked.result;
    } else {
      originalText = input.bytes.toString('utf8');
      result = mark(originalText, identity, this.issuer, markOpts);
      bytes = Buffer.from(result.text, 'utf8');
    }

    // Issue-time verification: run THIS copy's marked text through the
    // transform gauntlet and record what actually survived. Numbers, not hope.
    const transformTests = this.gauntlet(result);
    const survived = transformTests.filter((t) => t.recovered).length;

    const copy: ProtectedCopy = {
      tokenHex: result.tokenHex,
      shortIdHex: result.shortIdHex,
      scheme: result.scheme,
      identity,
      originalHash: sha256Hex(format === 'docx' ? input.bytes : Buffer.from(originalText, 'utf8')),
      protectedHash: sha256Hex(bytes),
      generatedBy: opts.generatedBy ?? 'unknown',
      generatedAt: identity.issuedAt,
      channels: result.layers,
      deliveryMethod: opts.deliveryMethod ?? 'unknown',
      deliveryNote: opts.deliveryNote,
      transformTests,
      investigations: [],
    };
    this.registry.add(copy);

    const stem = basename(input.name, extname(input.name)) || 'document';
    const ext = format === 'docx' ? '.docx' : extname(input.name) || '.txt';
    return {
      bytes,
      suggestedName: `${stem}--${slug(opts.recipient)}${ext}`,
      format,
      result,
      copy,
      transformTests,
      survivalRate: transformTests.length ? survived / transformTests.length : 0,
    };
  }

  private gauntlet(result: MarkResult): TransformTestResult[] {
    const tests: TransformTestResult[] = CHAINS.map((chain) => {
      const res = detect(applyChain(chain, result.text));
      const hit = res.tokens.find(
        (t) => t.tokenHex === result.tokenHex || t.tokenHex === result.shortIdHex,
      );
      return {
        chain: chain.name,
        recovered: Boolean(hit),
        survivingChannels: hit ? hit.channels : [],
      };
    });
    for (const f of [0.5, 0.2]) {
      const res = detect(excerpt(result.text, f));
      const hit = res.tokens.find(
        (t) => t.tokenHex === result.tokenHex || t.tokenHex === result.shortIdHex,
      );
      tests.push({
        chain: `excerpt-${Math.round(f * 100)}%`,
        recovered: Boolean(hit),
        survivingChannels: hit ? hit.channels : [],
      });
    }
    return tests;
  }

  /* ------------------------------ identify ------------------------------- */

  identify(
    input: { name: string; bytes: Buffer },
    opts: { actor?: string; sourceDescription?: string; record?: boolean } = {},
  ): IdentifyOutcome {
    const format = sniffFormat(input.bytes);
    const text =
      format === 'docx'
        ? readDocxText(input.bytes)
        : format === 'pdf'
          ? extractPdfText(input.bytes)
          : input.bytes.toString('utf8');

    const detected = detect(text);
    const matches = detected.tokens
      .map((t) => this.gradeToken(t))
      .sort(
        (a, b) =>
          rankConfidence(a.confidence) - rankConfidence(b.confidence) ||
          b.channels.length - a.channels.length ||
          b.frames - a.frames,
      );

    const attribution = matches.find((m) => m.confidence !== 'unrecognized');

    if (opts.record && attribution?.copy) {
      this.registry.recordInvestigation(attribution.copy.tokenHex, {
        at: new Date().toISOString(),
        actor: opts.actor ?? 'unknown',
        kind: 'detection',
        detail:
          `identify(${input.name}): ${attribution.confidence} match via ` +
          `${attribution.channels.join('+')} (${attribution.frames} frame(s), format ${format})`,
        survivingChannels: attribution.channels,
        sourceDescription: opts.sourceDescription,
      });
    }

    return { format, anyRecovered: detected.anyRecovered, matches, attribution };
  }

  private gradeToken(t: RecoveredToken): IdentifyMatch {
    const base: Omit<IdentifyMatch, 'confidence'> = {
      tokenHex: t.tokenHex,
      scheme: t.scheme,
      short: t.short,
      channels: t.channels,
      frames: t.frames,
    };
    const copy = this.registry.resolve(t.tokenHex);
    if (!copy) return { ...base, confidence: 'unrecognized' };

    // Never trust the registry lookup alone: recompute the token from the
    // row's identity so a corrupted or misfiled row cannot mis-attribute.
    const token = Buffer.from(t.tokenHex, 'hex');
    let confidence: MatchConfidence = 'unrecognized';
    if (t.short) {
      const expected = Buffer.from(shortIdToken(this.orgKey, copy.identity));
      if (expected.length === token.length && timingSafeEqual(expected, token)) {
        confidence = 'corroborated';
      }
    } else if (t.scheme === Scheme.HMAC_SHA256) {
      const expected = Buffer.from(hmacToken(this.orgKey, copy.identity));
      if (expected.length === token.length && timingSafeEqual(expected, token)) {
        confidence = 'confirmed';
      }
    } else if (t.scheme === Scheme.ED25519) {
      if (this.issuer.scheme === Scheme.ED25519 && this.issuer.verify(new Uint8Array(token))) {
        confidence = 'confirmed';
      }
    }
    return { ...base, confidence, copy: confidence === 'unrecognized' ? undefined : copy };
  }

  /* ----------------------------- read / audit ---------------------------- */

  list(): ProtectedCopy[] {
    return this.registry.all();
  }

  byMatter(matterRef: string): ProtectedCopy[] {
    return this.registry.byMatter(matterRef);
  }

  resolve(tokenHex: string): ProtectedCopy | undefined {
    return this.registry.resolve(tokenHex);
  }

  addNote(tokenHex: string, event: InvestigationEvent): void {
    this.registry.recordInvestigation(tokenHex, event);
  }

  status(): WorkspaceStatus {
    return {
      config: this.config,
      copies: this.registry.all().length,
      events: this.registry.eventCount(),
      chainOk: this.registry.verify(),
      head: this.registry.head(),
      merkleRoot: this.registry.merkleRoot(),
    };
  }

  /* ------------------------------- report -------------------------------- */

  /** Structured evidence report for one protected copy (FRE 901(b)(9) posture). */
  report(tokenHex: string): EvidenceReport {
    const copy = this.registry.resolve(tokenHex);
    if (!copy) throw new Error(`no protected copy resolves ${tokenHex}`);
    return {
      generatedAt: new Date().toISOString(),
      workspace: { orgName: this.config.orgName, scheme: this.config.scheme },
      copy,
      ledger: {
        chainOk: this.registry.verify(),
        head: this.registry.head(),
        merkleRoot: this.registry.merkleRoot(),
        events: this.registry.eventCount(),
      },
    };
  }
}

export interface EvidenceReport {
  generatedAt: string;
  workspace: { orgName: string; scheme: SchemeName };
  copy: ProtectedCopy;
  ledger: { chainOk: boolean; head: string; merkleRoot: string; events: number };
}

/** Render an evidence report as human-readable Markdown. */
export function renderReportMarkdown(r: EvidenceReport): string {
  const c = r.copy;
  const lines: string[] = [
    `# Mattermark evidence report`,
    ``,
    `Generated ${r.generatedAt} by ${r.workspace.orgName} (scheme: ${r.workspace.scheme}).`,
    ``,
    `## Protected copy`,
    ``,
    `| Field | Value |`,
    `| --- | --- |`,
    `| Token | \`${c.tokenHex}\` |`,
    `| Short ID | \`${c.shortIdHex}\` |`,
    `| Matter | ${c.identity.matterRef} |`,
    `| Recipient | ${c.identity.recipientId} |`,
    `| Version | ${c.identity.version} |`,
    `| Issued | ${c.identity.issuedAt} |`,
    `| Generated by | ${c.generatedBy} |`,
    `| Delivery | ${c.deliveryMethod}${c.deliveryNote ? ` — ${c.deliveryNote}` : ''} |`,
    `| Original SHA-256 | \`${c.originalHash}\` |`,
    `| Protected SHA-256 | \`${c.protectedHash}\` |`,
    ``,
    `## Embedded channels`,
    ``,
    `| Channel | Embedded | Payload | Copies |`,
    `| --- | --- | --- | --- |`,
    ...c.channels.map(
      (l) =>
        `| ${l.codec} | ${l.embedded ? 'yes' : `no (${l.reason ?? 'n/a'})`} | ${l.payload ?? '—'} | ${
          l.embedded ? l.copiesEmbedded.toFixed(1) : '—'
        } |`,
    ),
    ``,
    `## Issue-time survival tests`,
    ``,
    `| Transform chain | Recovered | Surviving channels |`,
    `| --- | --- | --- |`,
    ...c.transformTests.map(
      (t) => `| ${t.chain} | ${t.recovered ? 'yes' : 'no'} | ${t.survivingChannels.join(', ') || '—'} |`,
    ),
    ``,
    `## Investigation history`,
    ``,
  ];
  if (c.investigations.length === 0) {
    lines.push(`No investigation events recorded.`);
  } else {
    lines.push(
      `| At | Actor | Kind | Detail |`,
      `| --- | --- | --- | --- |`,
      ...c.investigations.map((e) => `| ${e.at} | ${e.actor} | ${e.kind} | ${e.detail} |`),
    );
  }
  lines.push(
    ``,
    `## Ledger integrity`,
    ``,
    `- Hash chain verified: **${r.ledger.chainOk ? 'yes' : 'NO — DO NOT RELY ON THIS LEDGER'}**`,
    `- Events: ${r.ledger.events}`,
    `- Chain head: \`${r.ledger.head}\``,
    `- Merkle root: \`${r.ledger.merkleRoot}\``,
    ``,
    `The registry is an append-only, hash-chained, encrypted event log. The`,
    `Merkle root above commits to every event; anchor it externally to prove`,
    `this record predates a dispute. This report is the artifact you would`,
    `authenticate under FRE 901(b)(9) (process or system producing an accurate`,
    `result).`,
    ``,
  );
  return lines.join('\n');
}

function rankConfidence(c: MatchConfidence): number {
  return c === 'confirmed' ? 0 : c === 'corroborated' ? 1 : 2;
}

function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}
