/**
 * zerowidth.ts — ZW codec. Base-4 insertion into inter-character gaps.
 *
 * Highest-capacity channel (~2 bits per gap) and completely length-preserving
 * in the visual sense, but it is the first thing any steganography-aware
 * sanitizer strips. Note that all four alphabet members are Unicode general
 * category Cf, so T07 (format-character strip, Tier 2) destroys this channel
 * — NOT Tier 3 as the paper's Table 4 suggests. The harness measures this.
 *
 * Insertion is stride-interleaved so that an excerpt from anywhere in the
 * document still contains complete repeated frames.
 */

import type { StegoCodec } from './types.js';

const ALPHABET = ['\u200b', '\u200c', '\u200d', '\u2060'];
const INDEX = new Map(ALPHABET.map((c, i) => [c, i]));

/** Gaps are only opened inside words, never adjacent to a space, so that
 *  whitespace-collapsing transforms cannot swallow an inserted marker. */
function eligibleGaps(chars: string[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < chars.length; i++) {
    const a = chars[i - 1];
    const b = chars[i];
    if (/\s/u.test(a) || /\s/u.test(b)) continue;
    if (INDEX.has(a) || INDEX.has(b)) continue;
    gaps.push(i);
  }
  return gaps;
}

export const zeroWidthCodec: StegoCodec = {
  id: 'ZW',
  name: 'Zero-width insertion',
  surface: 'inter-char-gaps',
  base: 4,
  additive: true,

  capacityDigits(text: string): number {
    return eligibleGaps(Array.from(text)).length;
  },

  encode(text: string, digits: number[]): string | null {
    const chars = Array.from(text);
    const gaps = eligibleGaps(chars);
    if (gaps.length < digits.length) return null;

    // stride-interleave: spread the payload evenly across the whole document
    const stride = Math.max(1, Math.floor(gaps.length / digits.length));
    const chosen: number[] = [];
    for (let i = 0; i < digits.length; i++) chosen.push(gaps[i * stride]);

    const insertAt = new Map<number, string>();
    for (let i = 0; i < digits.length; i++) {
      insertAt.set(chosen[i], ALPHABET[digits[i] & 3]);
    }
    const out: string[] = [];
    for (let i = 0; i < chars.length; i++) {
      const marker = insertAt.get(i);
      if (marker !== undefined) out.push(marker);
      out.push(chars[i]);
    }
    return out.join('');
  },

  decode(text: string): number[] {
    const out: number[] = [];
    for (const ch of text) {
      const d = INDEX.get(ch);
      if (d !== undefined) out.push(d);
    }
    return out;
  },
};
