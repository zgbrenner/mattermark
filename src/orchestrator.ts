/**
 * orchestrator.ts — layered marking and detection.
 *
 * The single most important thing in this file is `assertComposable`.
 * Raz et al. §6.2 found that improper layer composition collapses Tier-3
 * recovery from 97% to 0%. Naive "embed it in every channel for redundancy"
 * makes the system WORSE. The rules below are the guard rail.
 */

import { Scheme, buildFrame, framesFromDigits, repeatFrameToDigits, ParsedFrame } from './frame.js';
import type { StegoCodec } from './codecs/types.js';
import { whitespaceCodec } from './codecs/whitespace.js';
import { zeroWidthCodec } from './codecs/zerowidth.js';
import { homoglyphCodec } from './codecs/homoglyph.js';
import type { CopyIdentity, Issuer } from './crypto.js';

export const CODECS: Record<string, StegoCodec> = {
  WS: whitespaceCodec,
  ZW: zeroWidthCodec,
  HG: homoglyphCodec,
};

/** Canonical encode order. Fixed for reproducibility of detection. */
const ORDER: Array<StegoCodec['id']> = ['WS', 'ZW', 'HG', 'LM'];

export class CompositionError extends Error {}

export interface ComposeOptions {
  /**
   * Permit a stack with NO Tier-2-surviving layer (i.e. no HG and no LM).
   * This is the deliberate, disclosed "search-safe" escape hatch: the operator
   * accepts a non-durable, Tier-1-only mark in exchange for NOT substituting
   * confusable glyphs into the text. See the homoglyph note in README.md.
   * Rules 1 and 2 (disjoint surfaces, WS-under-LM) still apply.
   */
  allowNonDurable?: boolean;
}

export function assertComposable(codecs: StegoCodec[], opts: ComposeOptions = {}): void {
  const ids = codecs.map((c) => c.id);

  if (new Set(ids).size !== ids.length) {
    throw new CompositionError(`duplicate codec in stack: ${ids.join('+')}`);
  }

  // Rule 1 — disjoint surfaces. Two codecs writing the same surface overwrite
  // each other's digits; the second decode returns the first codec's noise.
  const surfaces = codecs.map((c) => c.surface);
  if (new Set(surfaces).size !== surfaces.length) {
    throw new CompositionError(
      `codecs share an encoding surface (${surfaces.join(', ')}); this is the documented cross-layer interference failure`,
    );
  }

  // Rule 2 — never stack WS beneath LM. Sanitizers DELETE whitespace rather
  // than normalising it, which shifts the byte stream the linguistic decoder
  // depends on and irrecoverably corrupts it (paper §4.1, Mode B omits WS).
  if (ids.includes('WS') && ids.includes('LM')) {
    throw new CompositionError(
      'WS cannot be stacked with LM: whitespace deletion corrupts the linguistic byte stream',
    );
  }

  // Rule 3 — at least one Tier-2-surviving layer, or the mark is decorative.
  // Of the symbolic codecs only HG survives NFKC + whitespace collapse + Cf strip.
  //
  // HG is retained but OPTIONAL: because it substitutes confusable glyphs into
  // the text, it breaks exact-match search and can be disqualifying for
  // litigation work product (see README / SECURITY). An operator who cannot
  // accept that may opt out with `allowNonDurable`, in which case a WS/ZW-only
  // stack is permitted as an explicit, non-durable, search-preserving choice.
  if (!ids.includes('HG') && !ids.includes('LM') && !opts.allowNonDurable) {
    throw new CompositionError(
      'stack has no Tier-2-surviving layer (needs HG or LM); WS and ZW alone die ' +
        'to routine sanitization. Pass allowNonDurable to accept a search-preserving, ' +
        'Tier-1-only mark deliberately.',
    );
  }
}

export interface MarkOptions {
  codecs?: Array<StegoCodec['id']>;
  /**
   * Cap on the fraction of eligible glyphs the HG channel may alter, in [0,1].
   * Protects searchability at the price of excerpt resilience: fewer confusable
   * substitutions means fewer keyword hits are corrupted, but also fewer
   * repeated frames survive an excerpt. `0` disables homoglyph substitution
   * entirely while leaving HG nominally in the stack (it will simply embed
   * nothing and the mark will not be durable).
   */
  maxHomoglyphDensity?: number;
  /**
   * Minimum repeated copies required before a channel is considered
   * excerpt-resilient. Below this, the channel falls back to a SHORT_ID
   * frame. Default 3: an excerpt must contain ~1/3 of the document to be
   * worth attributing anyway.
   */
  minCopies?: number;
  /** disable the short-ID fallback (full frames only) */
  noShortFallback?: boolean;
  /**
   * Deliberately accept a non-durable, search-preserving mark: permit a stack
   * with no Tier-2-surviving layer (no HG/LM). Without this, such a stack is
   * rejected by the composition guard. See the homoglyph note in README.md.
   */
  allowNonDurable?: boolean;
}

export interface LayerReport {
  codec: StegoCodec['id'];
  capacityDigits: number;
  requiredDigits: number;
  copiesEmbedded: number;
  embedded: boolean;
  /** which frame variant this channel actually carries */
  payload?: 'full' | 'short';
  reason?: string;
}

export interface MarkResult {
  text: string;
  scheme: Scheme;
  tokenHex: string;
  shortIdHex: string;
  layers: LayerReport[];
  /** true if at least one Tier-2-surviving layer actually fit */
  durable: boolean;
  /**
   * Operator-facing advisories surfaced at mark time. Notably, whenever the
   * homoglyph channel is active this carries the search-impact disclosure
   * (exact-match / e-discovery keyword search is broken), and whenever the
   * mark is non-durable this says so. Never silently degrade — report.
   */
  warnings: string[];
}

export function mark(
  text: string,
  identity: CopyIdentity,
  issuer: Issuer,
  opts: MarkOptions = {},
): MarkResult {
  const ids = opts.codecs ?? ['WS', 'ZW', 'HG'];
  const codecs = ORDER.filter((id) => ids.includes(id)).map((id) => CODECS[id]).filter(Boolean);
  assertComposable(codecs, { allowNonDurable: opts.allowNonDurable });

  const minCopies = opts.minCopies ?? 3;

  const token = issuer.mint(identity);
  const fullFrame = buildFrame(token, issuer.scheme);
  const shortToken = issuer.mintShort(identity);
  const shortFrame = buildFrame(shortToken, Scheme.SHORT_ID);

  let out = text;
  const layers: LayerReport[] = [];

  for (const codec of codecs) {
    let capacity = codec.capacityDigits(out);
    if (codec.id === 'HG' && opts.maxHomoglyphDensity !== undefined) {
      capacity = Math.floor(capacity * opts.maxHomoglyphDensity);
    }

    // Per-channel payload sizing: prefer the full self-verifying frame, but if
    // it cannot be repeated enough times to survive excerpting, downgrade this
    // channel to a repeated short registry pointer instead. A high-capacity
    // channel elsewhere still carries full cryptographic strength.
    const candidates: Array<{ frame: Uint8Array; kind: 'full' | 'short' }> = [
      { frame: fullFrame, kind: 'full' },
    ];
    if (!opts.noShortFallback) candidates.push({ frame: shortFrame, kind: 'short' });

    let picked: { frame: Uint8Array; kind: 'full' | 'short'; digits: number[]; perCopy: number } | null = null;
    for (const c of candidates) {
      const perCopy = (c.frame.length * 8) / Math.log2(codec.base);
      const digits = repeatFrameToDigits(c.frame, codec.base, capacity);
      const copies = digits.length / perCopy;
      if (digits.length === 0) continue;
      picked = { ...c, digits, perCopy };
      if (copies >= minCopies) break; // good enough, stop downgrading
    }

    if (!picked) {
      layers.push({
        codec: codec.id,
        capacityDigits: capacity,
        requiredDigits: (shortFrame.length * 8) / Math.log2(codec.base),
        copiesEmbedded: 0,
        embedded: false,
        reason: `insufficient capacity: ${capacity} digits available`,
      });
      continue;
    }

    const next = codec.encode(out, picked.digits);
    if (next === null) {
      layers.push({
        codec: codec.id,
        capacityDigits: capacity,
        requiredDigits: picked.perCopy,
        copiesEmbedded: 0,
        embedded: false,
        reason: 'encoder rejected (capacity race)',
      });
      continue;
    }
    out = next;
    layers.push({
      codec: codec.id,
      capacityDigits: capacity,
      requiredDigits: picked.perCopy,
      copiesEmbedded: picked.digits.length / picked.perCopy,
      embedded: true,
      payload: picked.kind,
    });
  }

  const durable = layers.some((l) => l.embedded && (l.codec === 'HG' || l.codec === 'LM'));

  const warnings: string[] = [];
  const hgActive = layers.some((l) => l.codec === 'HG' && l.embedded);
  if (hgActive) {
    warnings.push(
      'HOMOGLYPH CHANNEL ACTIVE: Cyrillic confusable substitutions replace Latin ' +
        'letters in place. This breaks exact-match search (Ctrl-F), spellcheck, and ' +
        'e-discovery keyword indexing, and the altered words look identical on screen. ' +
        'For litigation work product this may be DISQUALIFYING. Mitigations: cap the ' +
        'substitution rate with maxHomoglyphDensity, or omit HG and pass ' +
        'allowNonDurable for a search-preserving (Tier-1-only, non-durable) mark.',
    );
  }
  if (!durable) {
    warnings.push(
      'NON-DURABLE MARK: no Tier-2-surviving channel was embedded. This mark ' +
        'survives only benign copy-paste handling (Tier 1) and is destroyed by ' +
        'routine platform sanitization (NFKC normalization, whitespace collapse, ' +
        'format-character strip). Do not rely on it against a motivated recipient.',
    );
  }

  return {
    text: out,
    scheme: issuer.scheme,
    tokenHex: Buffer.from(token).toString('hex'),
    shortIdHex: Buffer.from(shortToken).toString('hex'),
    layers,
    durable,
    warnings,
  };
}

export interface ChannelRecovery {
  codec: StegoCodec['id'];
  framesFound: number;
  tokens: string[];
}

export interface RecoveredToken {
  tokenHex: string;
  scheme: Scheme;
  channels: StegoCodec['id'][];
  frames: number;
  /** true if this is a SHORT_ID pointer (registry-resolvable, not self-verifying) */
  short: boolean;
}

export interface DetectResult {
  /** distinct tokens recovered, most-corroborated first */
  tokens: RecoveredToken[];
  channels: ChannelRecovery[];
  anyRecovered: boolean;
}

export function detect(text: string, codecIds?: Array<StegoCodec['id']>): DetectResult {
  const ids = codecIds ?? ['WS', 'ZW', 'HG'];
  const channels: ChannelRecovery[] = [];
  const agg = new Map<string, { scheme: Scheme; channels: Set<StegoCodec['id']>; frames: number }>();

  for (const id of ids) {
    const codec = CODECS[id];
    if (!codec) continue;
    const digits = codec.decode(text);
    const frames: ParsedFrame[] = framesFromDigits(digits, codec.base);
    const tokens = frames.map((f) => Buffer.from(f.token).toString('hex'));
    channels.push({ codec: codec.id, framesFound: frames.length, tokens });

    for (const f of frames) {
      const hex = Buffer.from(f.token).toString('hex');
      const entry = agg.get(hex) ?? { scheme: f.scheme, channels: new Set(), frames: 0 };
      entry.channels.add(codec.id);
      entry.frames += 1;
      agg.set(hex, entry);
    }
  }

  const tokens = [...agg.entries()]
    .map(([tokenHex, v]) => ({
      tokenHex,
      scheme: v.scheme,
      channels: [...v.channels],
      frames: v.frames,
      short: v.scheme === Scheme.SHORT_ID,
    }))
    // full self-verifying frames outrank short pointers; then corroboration
    // across independent channels; then raw frame count
    .sort(
      (a, b) =>
        Number(a.short) - Number(b.short) ||
        b.channels.length - a.channels.length ||
        b.frames - a.frames,
    );

  return { tokens, channels, anyRecovered: tokens.length > 0 };
}
