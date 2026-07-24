/**
 * whitespace.ts — WS codec. Base-4 substitution over space codepoints.
 *
 * Alphabet index 0 is the ORDINARY space (U+0020). That is intentional:
 * unmarked spaces past the payload region decode as digit 0 and simply append
 * harmless trailing bytes, which frame-scanning discards. It also means the
 * marked text contains no unusual characters wherever a 0 digit lands.
 *
 * Known failure mode (Tier 2): every alphabet member NFKC-normalises to
 * U+0020, so T05 flattens the channel to all-zeros. This is expected and is
 * precisely why WS must never be the only layer.
 *
 * Capacity: 2 bits per eligible space.
 */

import type { StegoCodec } from './types.js';

// All render at or near normal space width; all are NFKC-equivalent to U+0020.
const ALPHABET = ['\u0020', '\u2004', '\u2005', '\u2008'];
const INDEX = new Map(ALPHABET.map((c, i) => [c, i]));

export const whitespaceCodec: StegoCodec = {
  id: 'WS',
  name: 'Whitespace substitution',
  surface: 'space-codepoints',
  base: 4,
  additive: false,

  capacityDigits(text: string): number {
    let n = 0;
    for (const ch of text) if (INDEX.has(ch)) n++;
    return n;
  },

  encode(text: string, digits: number[]): string | null {
    const chars = Array.from(text);
    const positions: number[] = [];
    for (let i = 0; i < chars.length; i++) if (INDEX.has(chars[i])) positions.push(i);
    if (positions.length < digits.length) return null;
    // head-first selection (paper §4.4, Figure 4a)
    for (let i = 0; i < digits.length; i++) {
      chars[positions[i]] = ALPHABET[digits[i] & 3];
    }
    return chars.join('');
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
