/** Offline artifact checks for a signed Mattermark evidence bundle. */

import { createHash } from 'node:crypto';
import { detect } from './orchestrator.js';
import { sniffFormat } from './workspace.js';
import { readDocxText } from './formats/index.js';
import { extractPdfText } from './formats/pdf.js';
import type { MattermarkEvidenceBundle } from './evidence.js';

export interface EvidenceArtifactCheck {
  supplied: true;
  digestMatches: boolean;
  markMatches: boolean;
  artifactSha256: string;
  expectedSha256?: string;
  recoveredTokens: string[];
}

export function verifyEvidenceArtifact(
  bundle: MattermarkEvidenceBundle,
  artifact: { name: string; bytes: Buffer },
): EvidenceArtifactCheck {
  const statement = JSON.parse(Buffer.from(bundle.envelope.payload, 'base64').toString('utf8')) as {
    predicate?: {
      copy?: { tokenHex?: string; shortIdHex?: string; protectedHash?: string };
      observation?: { sha256?: string };
    };
  };
  const copy = statement.predicate?.copy;
  if (!copy?.tokenHex || !copy.shortIdHex) {
    throw new Error('evidence statement does not contain a protected copy token');
  }
  const format = sniffFormat(artifact.bytes);
  const text = format === 'docx'
    ? readDocxText(artifact.bytes)
    : format === 'pdf'
      ? extractPdfText(artifact.bytes)
      : artifact.bytes.toString('utf8');
  const recoveredTokens = detect(text).tokens.map((token) => token.tokenHex);
  const artifactSha256 = createHash('sha256').update(artifact.bytes).digest('hex');
  const expectedSha256 = statement.predicate?.observation?.sha256 ?? copy.protectedHash;
  return {
    supplied: true,
    digestMatches: typeof expectedSha256 === 'string' && artifactSha256 === expectedSha256,
    markMatches: recoveredTokens.includes(copy.tokenHex) || recoveredTokens.includes(copy.shortIdHex),
    artifactSha256,
    expectedSha256,
    recoveredTokens,
  };
}
