import { createHash } from 'node:crypto';
import {
  MANIFEST_FORMAT,
  type ManifestValue,
  type ModelManifest,
} from './types.js';

const SHA256_HEX = /^[0-9a-f]{64}$/i;

function requiredText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`linguistic manifest: ${field} must be a non-empty string`);
  }
  return value;
}

function normalizedSha256(value: string, field: string): string {
  if (!SHA256_HEX.test(value)) {
    throw new Error(
      `linguistic manifest: ${field} must be a SHA-256 digest encoded as 64 hex characters`,
    );
  }
  return value.toLowerCase();
}

function decodingRecord(value: unknown): Record<string, ManifestValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('linguistic manifest: decoding must be an object');
  }
  return value as Record<string, ManifestValue>;
}

function canonicalValue(value: ManifestValue, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`linguistic manifest: ${path} contains a non-finite number`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => canonicalValue(item, `${path}[${index}]`))
      .join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, ManifestValue>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalValue(record[key], `${path}.${key}`)}`,
      )
      .join(',')}}`;
  }
  throw new Error(`linguistic manifest: unsupported value at ${path}`);
}

/** Canonical, validated JSON used for evidence hashes and compatibility gates. */
export function canonicalModelManifest(manifest: ModelManifest): string {
  if (manifest.format !== MANIFEST_FORMAT) {
    throw new Error(`linguistic manifest: unsupported format ${String(manifest.format)}`);
  }

  const normalized: ModelManifest = {
    format: MANIFEST_FORMAT,
    algorithm: {
      id: requiredText(manifest.algorithm.id, 'algorithm.id'),
      version: requiredText(manifest.algorithm.version, 'algorithm.version'),
    },
    model: {
      id: requiredText(manifest.model.id, 'model.id'),
      weightsSha256: normalizedSha256(
        manifest.model.weightsSha256,
        'model.weightsSha256',
      ),
    },
    tokenizer: {
      id: requiredText(manifest.tokenizer.id, 'tokenizer.id'),
      filesSha256: normalizedSha256(
        manifest.tokenizer.filesSha256,
        'tokenizer.filesSha256',
      ),
    },
    runtime: {
      name: requiredText(manifest.runtime.name, 'runtime.name'),
      version: requiredText(manifest.runtime.version, 'runtime.version'),
    },
    quantization: requiredText(manifest.quantization, 'quantization'),
    promptTemplateSha256: normalizedSha256(
      manifest.promptTemplateSha256,
      'promptTemplateSha256',
    ),
    decoding: decodingRecord(manifest.decoding),
  };

  return canonicalValue(
    normalized as unknown as { [key: string]: ManifestValue },
    'manifest',
  );
}

export function hashModelManifest(manifest: ModelManifest): string {
  return createHash('sha256')
    .update(canonicalModelManifest(manifest), 'utf8')
    .digest('hex');
}

export class ModelManifestMismatchError extends Error {
  readonly expectedHash: string;
  readonly actualHash: string;

  constructor(expectedHash: string, actualHash: string) {
    super(
      `linguistic model manifest mismatch: expected ${expectedHash}, received ${actualHash}`,
    );
    this.name = 'ModelManifestMismatchError';
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/** Fail closed unless the complete model, tokenizer, runtime, and settings match. */
export function assertModelManifestHash(
  expectedHash: string,
  actual: ModelManifest,
): string {
  const expected = normalizedSha256(expectedHash, 'expected manifest hash');
  const actualHash = hashModelManifest(actual);
  if (expected !== actualHash) {
    throw new ModelManifestMismatchError(expected, actualHash);
  }
  return actualHash;
}

export function assertModelManifestCompatible(
  expected: ModelManifest,
  actual: ModelManifest,
): string {
  return assertModelManifestHash(hashModelManifest(expected), actual);
}
