/**
 * frame.ts — payload framing and base-b digit conversion.
 *
 * Deviation from Raz et al. (arXiv:2603.28655v1) §4.2:
 * The paper frames payloads as [len(BE16) || token] and relies on head-first
 * positional selection so that decoding always starts at digit 0. That breaks
 * if the recovered artifact is an EXCERPT (the dominant legal-leak scenario:
 * someone pastes three paragraphs, not the whole file). We therefore prepend a
 * 2-byte magic sync marker and a version/scheme byte, and repeat the frame
 * across available capacity. The decoder resynchronises at any digit offset.
 *
 * Frame layout (big-endian):
 *   [0..1]  MAGIC   0xA5 0x5A
 *   [2]     VERSION 0x01
 *   [3]     SCHEME  0x01 = HMAC-SHA256, 0x02 = Ed25519
 *   [4..5]  LENGTH  uint16 BE, byte length of TOKEN
 *   [6..]   TOKEN
 *
 * Overhead: 6 bytes. HMAC frame = 22 bytes. Ed25519 frame = 74 bytes.
 */

export const MAGIC = Uint8Array.from([0xa5, 0x5a]);
export const FRAME_VERSION = 0x01;

export enum Scheme {
  HMAC_SHA256 = 0x01,
  ED25519 = 0x02,
  /**
   * SHORT_ID — 12-byte registry pointer: copy_uuid(4) || HMAC(k_org, id)[:8].
   *
   * Not in the paper. Added because measurement showed the 74-byte Ed25519
   * frame fits exactly ONCE in the homoglyph channel of a 1.5k-char memo, so
   * any excerpt that clips the head of the document loses the only durable
   * copy. A 12-byte token frames to 18 bytes and repeats 4+ times in the same
   * space.
   *
   * Trade-off, stated plainly: 64-bit forgery resistance instead of 128-bit,
   * and it is NOT self-verifying — it resolves only against the registry.
   * That is acceptable here because a short ID is only ever used ALONGSIDE a
   * full-strength frame in a higher-capacity channel; it is a corroborating
   * pointer, not a standalone cryptographic claim. Never ship it alone.
   */
  SHORT_ID = 0x03,
}

export function isShort(s: Scheme): boolean {
  return s === Scheme.SHORT_ID;
}

export const HEADER_BYTES = 6;

export function buildFrame(token: Uint8Array, scheme: Scheme): Uint8Array {
  if (token.length > 0xffff) throw new Error('token too long');
  const out = new Uint8Array(HEADER_BYTES + token.length);
  out[0] = MAGIC[0];
  out[1] = MAGIC[1];
  out[2] = FRAME_VERSION;
  out[3] = scheme;
  out[4] = (token.length >> 8) & 0xff;
  out[5] = token.length & 0xff;
  out.set(token, HEADER_BYTES);
  return out;
}

export interface ParsedFrame {
  scheme: Scheme;
  version: number;
  token: Uint8Array;
  /** byte offset in the scanned buffer where this frame started */
  offset: number;
}

/** Scan a byte buffer for every well-formed frame. */
export function scanFrames(buf: Uint8Array): ParsedFrame[] {
  const found: ParsedFrame[] = [];
  for (let i = 0; i + HEADER_BYTES <= buf.length; i++) {
    if (buf[i] !== MAGIC[0] || buf[i + 1] !== MAGIC[1]) continue;
    const version = buf[i + 2];
    const scheme = buf[i + 3];
    if (version !== FRAME_VERSION) continue;
    if (
      scheme !== Scheme.HMAC_SHA256 &&
      scheme !== Scheme.ED25519 &&
      scheme !== Scheme.SHORT_ID
    ) {
      continue;
    }
    const len = (buf[i + 4] << 8) | buf[i + 5];
    if (len === 0 || len > 512) continue;
    const end = i + HEADER_BYTES + len;
    if (end > buf.length) continue;
    found.push({
      scheme,
      version,
      token: buf.slice(i + HEADER_BYTES, end),
      offset: i,
    });
    i = end - 1; // non-overlapping
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* base-b digit conversion (b must be a power of two, 2..16)           */
/* ------------------------------------------------------------------ */

export function digitsPerByte(base: number): number {
  const bits = Math.log2(base);
  if (!Number.isInteger(bits) || 8 % bits !== 0) {
    throw new Error(`base ${base} must be a power of two dividing 8 bits`);
  }
  return 8 / bits;
}

/**
 * Per-byte grouping (NOT bignum). This is deliberate: it makes the digit
 * stream position-independent, so trailing garbage digits (e.g. ordinary
 * U+0020 spaces after the payload region) append harmless extra bytes
 * instead of corrupting the numeric value of the whole payload.
 */
export function bytesToDigits(bytes: Uint8Array, base: number): number[] {
  const dpb = digitsPerByte(base);
  const bits = 8 / dpb;
  const out: number[] = [];
  for (const byte of bytes) {
    for (let k = dpb - 1; k >= 0; k--) {
      out.push((byte >> (k * bits)) & (base - 1));
    }
  }
  return out;
}

export function digitsToBytes(digits: number[], base: number): Uint8Array {
  const dpb = digitsPerByte(base);
  const bits = 8 / dpb;
  const n = Math.floor(digits.length / dpb);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let byte = 0;
    for (let k = 0; k < dpb; k++) {
      byte = (byte << bits) | (digits[i * dpb + k] & (base - 1));
    }
    out[i] = byte;
  }
  return out;
}

/**
 * Recover frames from a digit stream, trying every sub-byte alignment.
 * Excerpting can slice the stream at a non-byte boundary, so alignment
 * must be brute-forced. Cost is at most `digitsPerByte` passes.
 */
export function framesFromDigits(digits: number[], base: number): ParsedFrame[] {
  const dpb = digitsPerByte(base);
  const seen = new Set<string>();
  const results: ParsedFrame[] = [];
  for (let shift = 0; shift < dpb; shift++) {
    const bytes = digitsToBytes(digits.slice(shift), base);
    for (const f of scanFrames(bytes)) {
      const key = `${f.scheme}:${Buffer.from(f.token).toString('hex')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(f);
    }
  }
  return results;
}

/** Repeat a frame to fill `capacityDigits`, returning the digit stream. */
export function repeatFrameToDigits(
  frame: Uint8Array,
  base: number,
  capacityDigits: number,
): number[] {
  const one = bytesToDigits(frame, base);
  if (one.length > capacityDigits) return [];
  const out: number[] = [];
  while (out.length + one.length <= capacityDigits) out.push(...one);
  return out;
}
