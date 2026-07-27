import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANIFEST_FORMAT,
  ModelManifestMismatchError,
  TIER4_ATTACKS,
  assertModelManifestCompatible,
  assertModelManifestHash,
  hashModelManifest,
  type ModelManifest,
} from '../src/research/linguistic/index.js';
import { CODECS } from '../src/orchestrator.js';

const H = (byte: string): string => byte.repeat(64);

function manifest(overrides: Partial<ModelManifest> = {}): ModelManifest {
  return {
    format: MANIFEST_FORMAT,
    algorithm: { id: 'arithmetic-gpt2-baseline', version: '0.1.0' },
    model: { id: 'openai-community/gpt2', weightsSha256: H('a') },
    tokenizer: { id: 'gpt2', filesSha256: H('b') },
    runtime: { name: 'transformers.js', version: '4.0.0' },
    quantization: 'q8',
    promptTemplateSha256: H('c'),
    decoding: {
      temperature: 0,
      topK: 0,
      nested: { alpha: true, beta: [1, 'two'] },
    },
    ...overrides,
  };
}

test('linguistic research remains outside the production codec registry', () => {
  assert.equal(CODECS.LM, undefined);
});

test('model manifest hashing is deterministic across object-key order', () => {
  const first = manifest();
  const second = manifest({
    decoding: {
      nested: { beta: [1, 'two'], alpha: true },
      topK: 0,
      temperature: 0,
    },
  });

  assert.equal(hashModelManifest(first), hashModelManifest(second));
});

test('model compatibility fails closed when any reproducibility input changes', () => {
  const expected = manifest();
  const changed = manifest({
    tokenizer: { id: 'gpt2', filesSha256: H('d') },
  });

  assert.throws(
    () => assertModelManifestCompatible(expected, changed),
    ModelManifestMismatchError,
  );
  assert.throws(
    () => assertModelManifestHash(hashModelManifest(expected), changed),
    ModelManifestMismatchError,
  );
});

test('model manifests reject malformed cryptographic digests', () => {
  assert.throws(
    () => hashModelManifest(manifest({ promptTemplateSha256: 'not-a-digest' })),
    /SHA-256/i,
  );
});

test('model manifests reject non-object decoding settings', () => {
  const invalid = manifest() as unknown as Record<string, unknown>;
  invalid.decoding = null;
  assert.throws(
    () => hashModelManifest(invalid as unknown as ModelManifest),
    /decoding/i,
  );
});

test('Tier-4 research matrix covers semantic rewrite, translation, reordering, and excerpts', () => {
  const ids = new Set(TIER4_ATTACKS.map((attack) => attack.id));
  for (const required of [
    'instruction-paraphrase',
    'sentence-rewrite',
    'document-rewrite',
    'summarize-reexpand',
    'translate-backtranslate',
    'reorder-merge-split',
    'excerpt',
    'human-edit',
  ] as const) {
    assert.ok(ids.has(required), `missing Tier-4 attack ${required}`);
  }

  const excerpt = TIER4_ATTACKS.find((attack) => attack.id === 'excerpt');
  assert.deepEqual(excerpt?.parameters.retainedFractions, [0.1, 0.25, 0.5, 0.75]);
});
