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
  extractText,
  reinjectText,
  containsZeroWidth,
  buildDocumentXml,
  docxParts,
} from './docx.js';

function documentPart(entries: ZipEntry[]): ZipEntry {
  const part = entries.find((e) => e.name === DOCUMENT_PART);
  if (!part) throw new Error(`not a DOCX: missing ${DOCUMENT_PART}`);
  return part;
}

/** The concatenated visible text of a DOCX. */
export function readDocxText(bytes: Buffer): string {
  return extractText(documentPart(readZip(bytes)).data.toString('utf8'));
}

export interface MarkDocxResult {
  /** the marked DOCX, ready to deliver */
  bytes: Buffer;
  /** the engine's mark result for the extracted text */
  result: MarkResult;
}

/**
 * Mark a DOCX for a recipient. Extracts the document text, marks it, and
 * reinjects the marked text across the original runs, leaving all other parts
 * of the archive untouched.
 */
export function markDocx(
  bytes: Buffer,
  identity: CopyIdentity,
  issuer: Issuer,
  opts: MarkOptions = {},
): MarkDocxResult {
  const entries = readZip(bytes);
  const part = documentPart(entries);
  const xml = part.data.toString('utf8');
  const text = extractText(xml);

  const result = mark(text, identity, issuer, opts);

  if (containsZeroWidth(text)) {
    result.warnings.unshift(
      'SOURCE ALREADY CONTAINS ZERO-WIDTH CHARACTERS: run-boundary distribution ' +
        'may be imprecise. Detection still re-concatenates all runs, so recovery ' +
        'is unaffected, but consider stripping pre-existing zero-width characters ' +
        'before marking.',
    );
  }

  const marked = reinjectText(xml, result.text);
  const out = entries.map((e) =>
    e.name === DOCUMENT_PART ? { name: e.name, data: Buffer.from(marked, 'utf8') } : e,
  );
  return { bytes: writeZip(out), result };
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
