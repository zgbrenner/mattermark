/**
 * formats/index.ts - document-format adapters (Slice 2).
 *
 * The marking engine works on strings. These adapters extract, mark, and
 * reinject DOCX text across every text-bearing OOXML part. PDF marking uses an
 * incremental update with an invisible Type 3 text carrier, preserving the
 * original bytes and visible glyph layout within a conservative safe subset.
 */

import { mark, detect } from '../orchestrator.js';
import type { MarkOptions, MarkResult, DetectResult } from '../orchestrator.js';
import type { CopyIdentity, Issuer } from '../crypto.js';
import type { StegoCodec } from '../codecs/types.js';
import { readZip, writeZip } from './zip.js';
import type { ZipEntry } from './zip.js';
import {
  DOCUMENT_PART,
  containsZeroWidth,
  buildDocumentXml,
  docxParts,
  isTextPart,
  sortTextParts,
  extractTextParts,
  reinjectTextParts,
} from './docx.js';
import type { TextPart } from './docx.js';

/** The text-bearing parts of a DOCX, in canonical order. */
function textParts(entries: ZipEntry[]): Array<{ entry: ZipEntry; part: TextPart }> {
  const matched = entries.filter((entry) => isTextPart(entry.name));
  if (!matched.some((entry) => entry.name === DOCUMENT_PART)) {
    throw new Error(`not a DOCX: missing ${DOCUMENT_PART}`);
  }
  return sortTextParts(matched).map((entry) => ({
    entry,
    part: { name: entry.name, xml: entry.data.toString('utf8') },
  }));
}

/** The concatenated visible text of a DOCX across every text-bearing part. */
export function readDocxText(bytes: Buffer): string {
  return extractTextParts(textParts(readZip(bytes)).map((item) => item.part));
}

export interface MarkDocxResult {
  /** the marked DOCX, ready to deliver */
  bytes: Buffer;
  /** the engine's mark result for the extracted text */
  result: MarkResult;
  /** the text-bearing parts that were marked, in order */
  markedParts: string[];
}

/** Mark body, footnotes, endnotes, headers, footers, and comments as one payload. */
export function markDocx(
  bytes: Buffer,
  identity: CopyIdentity,
  issuer: Issuer,
  opts: MarkOptions = {},
): MarkDocxResult {
  const entries = readZip(bytes);
  const parts = textParts(entries);
  const text = extractTextParts(parts.map((item) => item.part));
  const result = mark(text, identity, issuer, opts);

  if (containsZeroWidth(text)) {
    result.warnings.unshift(
      'SOURCE ALREADY CONTAINS ZERO-WIDTH CHARACTERS: run-boundary distribution ' +
        'may be imprecise. Detection still re-concatenates all runs, so recovery ' +
        'is unaffected, but consider stripping pre-existing zero-width characters ' +
        'before marking.',
    );
  }

  const rewritten = reinjectTextParts(
    parts.map((item) => item.part),
    result.text,
  );
  const byName = new Map(rewritten.map((part) => [part.name, part.xml]));
  const output = entries.map((entry) =>
    byName.has(entry.name)
      ? { name: entry.name, data: Buffer.from(byName.get(entry.name)!, 'utf8') }
      : entry,
  );

  return {
    bytes: writeZip(output),
    result,
    markedParts: parts.map((item) => item.part.name),
  };
}

/** Detect a mark in a DOCX by extracting its text and running the detector. */
export function detectDocx(
  bytes: Buffer,
  codecIds?: Array<StegoCodec['id']>,
): DetectResult {
  return detect(readDocxText(bytes), codecIds);
}

/** Build a minimal, valid DOCX from plain text, one paragraph per line. */
export function textToDocx(text: string): Buffer {
  const paragraphs = text.split('\n').map((line) => (line.length ? line : []));
  const parts = docxParts(buildDocumentXml(paragraphs));
  return writeZip(
    parts.map((part) => ({ name: part.name, data: Buffer.from(part.text, 'utf8') })),
  );
}

export {
  appendMattermarkPdfCarrier,
  buildTextPdf,
  detectPdf,
  extractMattermarkPdfCarrier,
  extractPdfText,
  markPdf,
} from './pdf.js';
export type { AppendPdfCarrierResult, MarkPdfResult } from './pdf.js';
