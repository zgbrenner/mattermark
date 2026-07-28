/**
 * pdf-mark.ts — PDF *marking* for the class of PDFs pdf.ts can already extract.
 *
 * Read pdf.ts first. That module explains why a PDF cannot be marked *in place*
 * with the symbolic codecs: a PDF positions glyphs from an embedded, usually
 * subsetted font, so inserting a zero-width marker, widening a space, or
 * swapping in a confusable all require a glyph that may not exist in a font we
 * do not control. This module does NOT pretend to solve that.
 *
 * WHAT THIS DOES — and, just as important, what it does not.
 *
 *   markPdf produces a NORMALIZED TEXT-LAYER PDF. It does not edit the source
 *   bytes in place. It extracts the source's text layer with pdf.ts's extractor,
 *   marks that text with the engine, and REBUILDS a fresh PDF whose text layer
 *   is the marked text — using the same self-contained writer as buildTextPdf
 *   (our own 1-byte font + our own ToUnicode CMap, so we control every shown
 *   code and its Unicode mapping). Round-trip fidelity of the TEXT LAYER is
 *   therefore guaranteed: extractPdfText(markPdf(...).bytes) returns the marked
 *   text, and detectPdf recovers the token.
 *
 *   The honest cost: the output is NOT a visual re-render of the original.
 *   Original pagination, fonts, images, and glyph positioning are discarded and
 *   replaced by a single-page, undecorated text layer. It is an attributable
 *   text-layer artifact, not a pixel-faithful copy of the source. This is
 *   surfaced in result.warnings, never silently.
 *
 * CHANNEL PROFILE — WS + ZW only, deliberately.
 *
 *   ZW (zero-width) and WS (whitespace) live in the character stream. Because we
 *   own the rebuilt ToUnicode CMap and shown codes, both round-trip exactly.
 *
 *   HG (homoglyph) is REFUSED here, not silently dropped. HG substitutes a
 *   Cyrillic confusable for a Latin letter. The rebuilt text layer uses a
 *   standard non-embedded base font (Helvetica) with no guaranteed Cyrillic
 *   coverage, so an HG glyph would render as a missing-glyph box or an
 *   inconsistent viewer fallback — visually broken, even though the text layer
 *   would still extract. Emitting that would be exactly the "subtly broken"
 *   output this repo refuses to ship, so markPdf throws if HG (or the
 *   unimplemented LM) is requested. The default profile is WS+ZW, which is
 *   search-preserving and therefore NON-DURABLE (Tier-1 only): it survives
 *   benign copy-paste but dies to routine sanitization. The engine's
 *   non-durable warning is passed through unaltered. Do not read durability into
 *   this that is not there.
 *
 * SCOPE GUARD (reported, not mangled — mirrors extractPdfText's stance).
 *   markPdf throws a clear, actionable error, and emits NO PDF, when:
 *     - the input is not a PDF (missing %PDF header);
 *     - the input is outside the extractor's envelope (no classic objects:
 *       encrypted or object-stream / full-compression PDF) — extractPdfText's
 *       own error propagates;
 *     - the input has no extractable text layer (nothing to mark);
 *     - the marked text exceeds the rebuild writer's 1-byte-font limit
 *       (>255 distinct characters) — buildTextPdf's own error propagates.
 *
 * Zero runtime dependencies; ESM; strict TS. Mirrors markDocx's shape.
 */

import { extractPdfText, buildTextPdf, detectPdf } from './pdf.js';
import { mark, MarkOptions, MarkResult } from '../orchestrator.js';
import type { CopyIdentity, Issuer } from '../crypto.js';
import type { StegoCodec } from '../codecs/types.js';

/** Codecs markPdf can carry with guaranteed text-layer fidelity in the rebuilt
 *  PDF. HG and LM are excluded on purpose — see the module header. */
const PDF_SAFE_CODECS: ReadonlyArray<StegoCodec['id']> = ['WS', 'ZW'];

const NORMALIZED_LAYER_WARNING =
  'NORMALIZED TEXT-LAYER PDF: markPdf does not edit the source in place. It ' +
  'extracts the text layer, marks it, and rebuilds a fresh single-page PDF whose ' +
  'text layer is the marked text (own font + ToUnicode CMap). The output is ' +
  'faithful for text extraction and detection, but it is NOT a visual re-render ' +
  'of the original: original pagination, fonts, images, and glyph positioning are ' +
  'NOT preserved. Deliver it as a text-layer artifact, not a pixel-faithful copy.';

export interface MarkPdfResult {
  /** the marked (rebuilt) PDF, ready to deliver as a text-layer artifact */
  bytes: Buffer;
  /** the engine's mark result for the extracted text */
  result: MarkResult;
  /** the marked text carried in the rebuilt PDF's text layer */
  markedText: string;
}

/**
 * Mark a PDF for a recipient by rebuilding its text layer.
 *
 * Extracts the source's text layer, marks it as one payload, and rebuilds a
 * normalized text-layer PDF whose extractable text is exactly the marked text.
 * Defaults to the search-preserving WS+ZW profile; HG/LM are refused (see the
 * module header). Throws — emitting no PDF — for any out-of-envelope input.
 */
export function markPdf(
  bytes: Buffer,
  identity: CopyIdentity,
  issuer: Issuer,
  opts: MarkOptions = {},
): MarkPdfResult {
  // Guard 1 — is it even a PDF? Give a crisp message before the extractor's.
  if (bytes.length < 5 || bytes.toString('latin1', 0, 5) !== '%PDF-') {
    throw new Error('markPdf: input is not a PDF (missing %PDF- header)');
  }

  // Guard 2 — channel reality. Refuse codecs we cannot render faithfully in the
  // rebuilt text layer, rather than emit a visually broken PDF.
  const codecs = opts.codecs ?? [...PDF_SAFE_CODECS];
  for (const id of codecs) {
    if (!PDF_SAFE_CODECS.includes(id)) {
      throw new Error(
        `markPdf: codec ${id} is not supported for PDF. The rebuilt text layer ` +
          `uses a standard non-embedded font with no guaranteed glyph coverage for ` +
          `confusable (HG) or token-sequence (LM) substitutions, so they would ` +
          `render as missing-glyph boxes. Use the default WS+ZW (search-preserving) ` +
          `profile; mark for durability in a DOCX/text source instead.`,
      );
    }
  }

  // Guard 3 — envelope + text layer. extractPdfText throws on no-objects
  // (encrypted / object-stream) inputs; an empty result means no text to mark.
  const sourceText = extractPdfText(bytes);
  if (sourceText.length === 0) {
    throw new Error(
      'markPdf: no extractable text layer (scanned/image-only PDF, or a text ' +
        'encoding outside the extractor envelope). Nothing to mark.',
    );
  }

  // WS+ZW alone carry no Tier-2-surviving layer, so the composition guard
  // requires the explicit non-durable opt-in. This IS a non-durable mark by
  // design; force the flag and let the engine's warning stand.
  const result = mark(sourceText, identity, issuer, { ...opts, codecs, allowNonDurable: true });

  // Rebuild the text layer. buildTextPdf throws if the marked text exceeds the
  // 1-byte-font limit; surface that as a markPdf scope error, not a bare throw.
  let out: Buffer;
  try {
    out = buildTextPdf(result.text);
  } catch (e) {
    throw new Error(
      `markPdf: cannot rebuild text layer — ${(e as Error).message}. The marked ` +
        `text has too many distinct characters for the single-byte rebuild font.`,
    );
  }

  // Surface the normalized-layout trade-off loudly, ahead of the engine's own
  // advisories. Never let the caller infer a faithful re-render.
  result.warnings.unshift(NORMALIZED_LAYER_WARNING);

  return { bytes: out, result, markedText: result.text };
}

// Re-export the detector so a caller marking and verifying a PDF has one import.
export { detectPdf };
