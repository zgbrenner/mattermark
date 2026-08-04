/**
 * preflight.ts — explain the marking trade-offs before issuing a copy.
 *
 * Preflight mints temporary in-memory tokens only to measure real capacities.
 * It never calls SecureRegistry.add(), writes an artifact, or changes the vault.
 */

import { mark, detect, type MarkOptions, type MarkResult } from './orchestrator.js';
import { newCopyIdentity } from './crypto.js';
import { CHAINS, applyChain } from './transforms.js';
import type { LayerReport } from './orchestrator.js';
import type { TransformTestResult } from './registry.js';
import type { DocFormat, Workspace } from './workspace.js';
import { sniffFormat } from './workspace.js';
import { markDocx, readDocxText } from './formats/index.js';
import { extractPdfText } from './formats/pdf.js';
import { markPdf } from './formats/pdf-mark.js';

export interface ExcerptRecoveryResult {
  fraction: number;
  windows: number;
  recovered: number;
  rate: number;
  allWindowsRecover: boolean;
}

export interface PreflightProfile {
  profile: 'durable' | 'search-safe';
  markable: boolean;
  durable: boolean;
  exactSearchPreserved: boolean;
  layers: LayerReport[];
  transformTests: TransformTestResult[];
  survivalRate: number;
  excerpts: ExcerptRecoveryResult[];
  warnings: string[];
  error?: string;
}

export interface PreflightOutcome {
  name: string;
  format: DocFormat;
  sourceBytes: number;
  sourceCharacters: number;
  profiles: PreflightProfile[];
  recommendation: string;
  blockedReason?: string;
}

export interface PreflightOptions {
  maxHomoglyphDensity?: number;
  rebuildPdf?: boolean;
}

const FRACTIONS = [0.1, 0.2, 0.33, 0.5];

function matchToken(result: MarkResult, text: string): { recovered: boolean; channels: string[] } {
  const found = detect(text).tokens.find(
    (token) => token.tokenHex === result.tokenHex || token.tokenHex === result.shortIdHex,
  );
  return { recovered: Boolean(found), channels: found?.channels ?? [] };
}

function transformTests(result: MarkResult): TransformTestResult[] {
  return CHAINS.map((chain) => {
    const hit = matchToken(result, applyChain(chain, result.text));
    return {
      chain: chain.name,
      recovered: hit.recovered,
      survivingChannels: hit.channels,
    };
  });
}

/** Up to seven evenly spaced windows, always including document start and end. */
export function excerptRecovery(result: MarkResult, fraction: number): ExcerptRecoveryResult {
  const chars = Array.from(result.text);
  if (chars.length === 0) {
    return { fraction, windows: 0, recovered: 0, rate: 0, allWindowsRecover: false };
  }
  const window = Math.max(1, Math.min(chars.length, Math.floor(chars.length * fraction)));
  const maxStart = chars.length - window;
  const desired = Math.min(7, maxStart + 1);
  const starts = new Set<number>();
  if (desired === 1) starts.add(0);
  else {
    for (let i = 0; i < desired; i++) {
      starts.add(Math.round((maxStart * i) / (desired - 1)));
    }
  }
  let recovered = 0;
  for (const start of starts) {
    if (matchToken(result, chars.slice(start, start + window).join('')).recovered) recovered += 1;
  }
  return {
    fraction,
    windows: starts.size,
    recovered,
    rate: starts.size === 0 ? 0 : recovered / starts.size,
    allWindowsRecover: starts.size > 0 && recovered === starts.size,
  };
}

function failedProfile(
  profile: PreflightProfile['profile'],
  exactSearchPreserved: boolean,
  error: unknown,
): PreflightProfile {
  const message = error instanceof Error ? error.message : String(error);
  return {
    profile,
    markable: false,
    durable: false,
    exactSearchPreserved,
    layers: [],
    transformTests: [],
    survivalRate: 0,
    excerpts: FRACTIONS.map((fraction) => ({
      fraction, windows: 0, recovered: 0, rate: 0, allWindowsRecover: false,
    })),
    warnings: [message],
    error: message,
  };
}

function analyze(
  ws: Workspace,
  input: { name: string; bytes: Buffer },
  format: DocFormat,
  profile: PreflightProfile['profile'],
  opts: PreflightOptions,
): PreflightProfile {
  const searchSafe = profile === 'search-safe';
  const identity = newCopyIdentity('PREFLIGHT', 'preflight-only', 'analysis');
  const markOpts: MarkOptions = searchSafe
    ? { codecs: ['WS', 'ZW'], allowNonDurable: true }
    : { codecs: ['WS', 'ZW', 'HG'], maxHomoglyphDensity: opts.maxHomoglyphDensity };
  try {
    let result: MarkResult;
    if (format === 'docx') {
      result = markDocx(input.bytes, identity, ws.issuer, markOpts).result;
    } else if (format === 'pdf') {
      result = markPdf(input.bytes, identity, ws.issuer, { codecs: ['WS', 'ZW'] }).result;
    } else {
      result = mark(input.bytes.toString('utf8'), identity, ws.issuer, markOpts);
    }
    const tests = transformTests(result);
    const survived = tests.filter((test) => test.recovered).length;
    return {
      profile,
      markable: result.layers.some((layer) => layer.embedded),
      durable: result.durable,
      exactSearchPreserved: searchSafe || !result.layers.some((layer) => layer.codec === 'HG' && layer.embedded),
      layers: result.layers,
      transformTests: tests,
      survivalRate: tests.length ? survived / tests.length : 0,
      excerpts: FRACTIONS.map((fraction) => excerptRecovery(result, fraction)),
      warnings: result.warnings,
    };
  } catch (error) {
    return failedProfile(profile, searchSafe, error);
  }
}

export function preflightWorkspaceDocument(
  ws: Workspace,
  input: { name: string; bytes: Buffer },
  opts: PreflightOptions = {},
): PreflightOutcome {
  if (
    opts.maxHomoglyphDensity !== undefined &&
    (!Number.isFinite(opts.maxHomoglyphDensity) || opts.maxHomoglyphDensity < 0 || opts.maxHomoglyphDensity > 1)
  ) {
    throw new Error('maxHomoglyphDensity must be between 0 and 1');
  }
  const format = sniffFormat(input.bytes);
  const text = format === 'docx'
    ? readDocxText(input.bytes)
    : format === 'pdf'
      ? extractPdfText(input.bytes)
      : input.bytes.toString('utf8');

  if (format === 'pdf' && !opts.rebuildPdf) {
    return {
      name: input.name,
      format,
      sourceBytes: input.bytes.length,
      sourceCharacters: Array.from(text).length,
      profiles: [],
      blockedReason:
        'Direct PDF marking is blocked because it would rebuild the text layer and discard layout. Mark the DOCX/text source instead, or explicitly request rebuilt-PDF analysis.',
      recommendation: 'Mark the editable source document and then export it to PDF.',
    };
  }

  const profiles = format === 'pdf'
    ? [analyze(ws, input, format, 'search-safe', opts)]
    : [
        analyze(ws, input, format, 'durable', opts),
        analyze(ws, input, format, 'search-safe', opts),
      ];

  const durable = profiles.find((profile) => profile.profile === 'durable');
  let recommendation: string;
  if (format === 'pdf') {
    recommendation = 'The rebuilt PDF route is normalized and non-durable. Prefer marking the source document.';
  } else if (durable?.markable && durable.durable) {
    recommendation = 'Use the durable profile unless exact keyword search and spellcheck fidelity are more important than routine-sanitization survival.';
  } else if (profiles.some((profile) => profile.markable)) {
    recommendation = 'This document cannot carry a durable symbolic mark reliably. Use search-safe marking only with the non-durability warning, or enlarge/restructure the document.';
  } else {
    recommendation = 'This document is too small or structurally unsuitable for the available marking channels.';
  }

  return {
    name: input.name,
    format,
    sourceBytes: input.bytes.length,
    sourceCharacters: Array.from(text).length,
    profiles,
    recommendation,
  };
}
