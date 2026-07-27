/**
 * Public PDF facade. Parsing, incremental writing, and fixture generation are
 * split into focused modules while this file preserves the existing API.
 */

import { detect } from '../orchestrator.js';
import type { DetectResult } from '../orchestrator.js';
import type { StegoCodec } from '../codecs/types.js';
import {
  extractMattermarkPdfCarrier,
  extractPdfText,
} from './pdf-reader.js';

export { extractMattermarkPdfCarrier, extractPdfText } from './pdf-reader.js';
export {
  appendMattermarkPdfCarrier,
  markPdf,
  type AppendPdfCarrierResult,
  type MarkPdfResult,
} from './pdf-marker.js';
export { buildTextPdf } from './pdf-fixture.js';

/** Detect marks in ordinary text plus the dedicated hidden carrier. */
export function detectPdf(
  bytes: Buffer,
  codecIds?: Array<StegoCodec['id']>,
): DetectResult {
  return detect(`${extractPdfText(bytes)}${extractMattermarkPdfCarrier(bytes)}`, codecIds);
}
