/**
 * index.ts — the library entry point for `import ... from 'mattermark'`.
 *
 * The CLI (src/cli.ts, shipped as the `mattermark` bin) is the primary
 * surface, but the same operations layer is usable programmatically. This
 * module re-exports the public workspace API so downstream code can do:
 *
 *   import { openWorkspace, initWorkspace } from 'mattermark';
 *
 * Everything substantive lives in workspace.ts; this file only widens its
 * surface to package consumers. It deliberately does not pull in cli.ts,
 * whose top-level code runs the command line on import.
 */

export * from './workspace.js';

// Anchors: the local (offline) attestation and the OpenTimestamps (Bitcoin)
// anchor, plus the interfaces so downstream code can supply its own.
export {
  localAttestationAnchor,
  openTimestampsAnchor,
  confirmProofAgainstBitcoin,
  isAsyncAnchor,
} from './ledger/index.js';
export type { Anchor, AsyncAnchor, AnchorProof, HttpTransport } from './ledger/index.js';

// Document-format marking beyond the workspace's file dispatch.
export { markDocx, detectDocx, readDocxText, textToDocx } from './formats/index.js';
export { markPdf } from './formats/pdf-mark.js';
export { extractPdfText, detectPdf, buildTextPdf } from './formats/pdf.js';
