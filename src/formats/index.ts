/**
 * formats/index.ts — document-format adapters (Slice 2).
 *
 * The marking engine works on strings. Real legal work product is DOCX. These
 * adapters do the extract -> mark -> reinject round-trip on a DOCX in place:
 * only `word/document.xml`'s run text changes; every other part of the archive
 * is preserved. Detection runs the same extraction and hands the text to the
 * engine's detector.
 *
 * PDF is deliberately not here yet. Faithful PDF reinjection is a layout
 * problem, not a text problem — a PDF positions glyphs, so inserting a
 * zero-width marker or swapping a letter for a wider/narrower confusable can
 * shift the visible layout. That needs a real PDF engine and is its own slice;
 * shipping a broken one would violate this repo's "report what we measured"
 * rule. See README Roadmap.
 */

import { mark, detect, MarkOptions, MarkResult, DetectResult } from '../orchestrator.js';
import type { CopyIdentity, Issuer } from '../crypto.js';
import type { StegoCodec } from '../codecs/types.js';
import { readZip, writeZip, ZipEntry } from './zip.js';
import {
  DOCUMENT_PART,
  containsZeroWidth,
  buildDocumentXml,
  docxParts,
  isTextPart,
  sortTextParts,
  extractTextParts,
  reinjectTextParts,
  TextPart,
} from './docx.js';

/** The text-bearing parts of a DOCX (body, footnotes, endnotes, headers,
 *  footers, comments), in canonical order. Throws if it is not a DOCX. */
function textParts(entries: ZipEntry[]): Array<{ entry: ZipEntry; part: TextPart }> {
  const matched = entries.filter((e) => isTextPart(e.name));
  if (!matched.some((e) => e.name === DOCUMENT_PART)) {
    throw new Error(`not a DOCX: missing ${DOCUMENT_PART}`);
  }
  return sortTextParts(matched).map((e) => ({
    entry: e,
    part: { name: e.name, xml: e.data.toString('utf8') },
  }));
}

/** The concatenated visible text of a DOCX, across every text-bearing part. */
export function readDocxText(bytes: Buffer): string {
  return extractTextParts(textParts(readZip(bytes)).map((x) => x.part));
}

export interface MarkDocxResult {
  /** the marked DOCX, ready to deliver */
  bytes: Buffer;
  /** the engine's mark result for the extracted text */
  result: MarkResult;
  /** the text-bearing parts that were marked, in order */
  markedParts: string[];
}

/**
 * Mark a DOCX for a recipient. Concatenates the text of every text-bearing part
 * (body, footnotes, endnotes, headers, footers, comments), marks it as one
 * payload, and reinjects the marked text back across those parts' runs. All
 * other parts of the archive are left byte-for-byte untouched.
 */
export function markDocx(
  bytes: Buffer,
  identity: CopyIdentity,
  issuer: Issuer,
  opts: MarkOptions = {},
): MarkDocxResult {
  const entries = readZip(bytes);
  const tp = textParts(entries);
  const text = extractTextParts(tp.map((x) => x.part));

  const result = mark(text, identity, issuer, opts);

  if (containsZeroWidth(text)) {
    result.warnings.unshift(
      'SOURCE ALREADY CONTAINS ZERO-WIDTH CHARACTERS: run-boundary distribution ' +
        'may be imprecise. Detection still re-concatenates all runs, so recovery ' +
        'is unaffected, but consider stripping pre-existing zero-width characters ' +
        'before marking.',
    );
  }

  const rewritten = reinjectTextParts(tp.map((x) => x.part), result.text);
  const byName = new Map(rewritten.map((p) => [p.name, p.xml]));
  const out = entries.map((e) =>
    byName.has(e.name) ? { name: e.name, data: Buffer.from(byName.get(e.name)!, 'utf8') } : e,
  );
  return { bytes: writeZip(out), result, markedParts: tp.map((x) => x.part.name) };
}

/** Detect a mark in a DOCX by extracting its text and running the detector. */
export function detectDocx(bytes: Buffer, codecIds?: Array<StegoCodec['id']>): DetectResult {
  return detect(readDocxText(bytes), codecIds);
}

/** Build a minimal, valid DOCX from plain text (one paragraph per line). */
export function textToDocx(text: string): Buffer {
  const paragraphs = text.split('\n').map((line) => (line.length ? line : []));
  const parts = docxParts(buildDocumentXml(paragraphs));
  return writeZip(parts.map((p) => ({ name: p.name, data: Buffer.from(p.text, 'utf8') })));
}
