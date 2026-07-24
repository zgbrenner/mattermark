/**
 * homoglyph.ts — HG codec. 1-bit substitution over UTS-39 confusable glyphs.
 *
 * Lowest capacity (~0.35 b/char) but the ONLY symbolic channel that survives
 * Tier 2: NFKC does not fold confusables, whitespace collapse does not touch
 * letters, and Cf-stripping does not touch letters. HG is therefore the layer
 * that carries the "full coverage through Tier 2" claim for Mode A.
 *
 * Dies at T09 (confusable folding) and T10 (non-ASCII strip).
 *
 * OPERATIONAL WARNING: Cyrillic substitutions inside a document break naive
 * ctrl-F, spellcheck, and some e-discovery keyword search. For litigation work
 * product that is a real cost, not a theoretical one. Density is capped below.
 */

import type { StegoCodec } from './types.js';

// Latin -> Cyrillic confusables (UTS #39 intentional-confusable set).
const MAP: Record<string, string> = {
  a: '\u0430', c: '\u0441', e: '\u0435', o: '\u043e', p: '\u0440',
  x: '\u0445', y: '\u0443', i: '\u0456', j: '\u0458', s: '\u0455',
  A: '\u0410', B: '\u0412', C: '\u0421', E: '\u0415', H: '\u041d',
  K: '\u041a', M: '\u041c', O: '\u041e', P: '\u0420', T: '\u0422',
  X: '\u0425', Y: '\u0423',
};
const REVERSE: Record<string, string> = {};
for (const [latin, cyr] of Object.entries(MAP)) REVERSE[cyr] = latin;

export function foldConfusables(text: string): string {
  let out = '';
  for (const ch of text) out += REVERSE[ch] ?? ch;
  return out;
}

function eligiblePositions(chars: string[]): number[] {
  const pos: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (MAP[chars[i]] !== undefined || REVERSE[chars[i]] !== undefined) pos.push(i);
  }
  return pos;
}

export const homoglyphCodec: StegoCodec = {
  id: 'HG',
  name: 'Homoglyph substitution',
  surface: 'confusable-glyphs',
  base: 2,
  additive: false,

  capacityDigits(text: string): number {
    return eligiblePositions(Array.from(text)).length;
  },

  encode(text: string, digits: number[]): string | null {
    const chars = Array.from(text);
    const pos = eligiblePositions(chars);
    if (pos.length < digits.length) return null;
    for (let i = 0; i < digits.length; i++) {
      const idx = pos[i];
      const latin = REVERSE[chars[idx]] ?? chars[idx];
      chars[idx] = digits[i] & 1 ? MAP[latin] : latin;
    }
    return chars.join('');
  },

  decode(text: string): number[] {
    const out: number[] = [];
    for (const ch of text) {
      if (REVERSE[ch] !== undefined) out.push(1);
      else if (MAP[ch] !== undefined) out.push(0);
    }
    return out;
  },
};
