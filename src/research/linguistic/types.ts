/**
 * Research-only contracts for generation-time linguistic marking.
 *
 * These types are intentionally separate from StegoCodec. A linguistic
 * generator controls token generation and requires a pinned model/runtime
 * manifest; it is not an in-place character substitution over legal text.
 */

export const MANIFEST_FORMAT = 'mattermark-linguistic-model-manifest-v1' as const;

export type ManifestPrimitive = string | number | boolean | null;
export type ManifestValue =
  | ManifestPrimitive
  | ManifestValue[]
  | { [key: string]: ManifestValue };

export interface ModelManifest {
  format: typeof MANIFEST_FORMAT;
  algorithm: {
    id: string;
    version: string;
  };
  model: {
    id: string;
    weightsSha256: string;
  };
  tokenizer: {
    id: string;
    filesSha256: string;
  };
  runtime: {
    name: string;
    version: string;
  };
  quantization: string;
  promptTemplateSha256: string;
  decoding: Record<string, ManifestValue>;
}

export interface LinguisticArtifactMetadata {
  manifestHash: string;
  frameVersion: number;
  generatedAt: string;
}

export interface LinguisticGenerationResult {
  text: string;
  metadata: LinguisticArtifactMetadata;
}

export interface LinguisticRecoveryResult {
  payloads: Uint8Array[];
  confidence?: number;
  erasures?: number;
}

export interface LinguisticGenerator {
  readonly id: string;
  generate(
    prompt: string,
    payload: Uint8Array,
    manifest: ModelManifest,
  ): Promise<LinguisticGenerationResult>;
  recover(
    text: string,
    manifest: ModelManifest,
  ): Promise<LinguisticRecoveryResult>;
}
