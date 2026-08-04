/**
 * index.ts — the library entry point for `import ... from 'mattermark'`.
 *
 * The CLI is the primary surface, but every substantive operation is also
 * available programmatically without importing a module that executes a
 * command line at load time.
 */

export * from './workspace.js';
export * from './workspace-evidence.js';
export * from './evidence.js';
export * from './evidence-artifact.js';
export * from './preflight.js';

// Anchors and copy-specific Merkle proofs.
export {
  localAttestationAnchor,
  openTimestampsAnchor,
  confirmProofAgainstBitcoin,
  isAsyncAnchor,
  createMerkleProof,
  verifyMerkleProof,
} from './ledger/index.js';
export type {
  Anchor,
  AsyncAnchor,
  AnchorProof,
  HttpTransport,
  MerkleInclusionProof,
  MerkleProofStep,
  LedgerEventInclusion,
} from './ledger/index.js';

// Document-format marking beyond the workspace's file dispatch.
export { markDocx, detectDocx, readDocxText, textToDocx } from './formats/index.js';
export { markPdf } from './formats/pdf-mark.js';
export { extractPdfText, detectPdf, buildTextPdf } from './formats/pdf.js';
