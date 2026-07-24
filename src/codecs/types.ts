/**
 * types.ts — the module interface from Raz et al. §4.4.1.
 *
 * Any codec conforming to this contract can be slotted into the stack.
 * `surface` is load-bearing: the orchestrator refuses to stack two codecs
 * that write to the same character surface, which is the documented cause
 * of the 97% -> 0% cross-layer interference collapse (§6.2).
 */

export type Surface = 'space-codepoints' | 'inter-char-gaps' | 'confusable-glyphs' | 'token-sequence';

export interface StegoCodec {
  readonly id: 'WS' | 'ZW' | 'HG' | 'LM';
  readonly name: string;
  readonly surface: Surface;
  readonly base: number;
  /** true if the codec adds characters rather than substituting them */
  readonly additive: boolean;

  /** how many base-`base` digits this text can carry */
  capacityDigits(text: string): number;

  /** embed a digit stream; returns null if capacity is insufficient */
  encode(text: string, digits: number[]): string | null;

  /** recover the digit stream (may include garbage — framing filters it) */
  decode(text: string): number[];
}
