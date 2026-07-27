import type { ManifestValue } from './types.js';

export type Tier4AttackId =
  | 'instruction-paraphrase'
  | 'sentence-rewrite'
  | 'document-rewrite'
  | 'summarize-reexpand'
  | 'translate-backtranslate'
  | 'reorder-merge-split'
  | 'excerpt'
  | 'human-edit';

export interface Tier4AttackDefinition {
  id: Tier4AttackId;
  label: string;
  purpose: string;
  parameters: Record<string, ManifestValue>;
}

/**
 * Minimum research matrix. It defines evidence requirements only; model-backed
 * transforms belong in the experiment harness and must record provider/model
 * identifiers, prompts, seeds, and raw outputs for reproducibility.
 */
const ATTACKS: Tier4AttackDefinition[] = [
  {
    id: 'instruction-paraphrase',
    label: 'Instruction-following paraphrase',
    purpose: 'Rewrite while preserving meaning under multiple model families and prompts.',
    parameters: { modelFamilies: 3, promptsPerFamily: 3 },
  },
  {
    id: 'sentence-rewrite',
    label: 'Sentence-by-sentence rewrite',
    purpose: 'Destroy local token choices while retaining sentence boundaries.',
    parameters: { modelFamilies: 3 },
  },
  {
    id: 'document-rewrite',
    label: 'Full-document rewrite',
    purpose: 'Allow global restructuring, vocabulary changes, and discourse edits.',
    parameters: { modelFamilies: 3 },
  },
  {
    id: 'summarize-reexpand',
    label: 'Summarize and re-expand',
    purpose: 'Test survival after lossy semantic compression and regeneration.',
    parameters: { compressionRatios: [0.25, 0.5, 0.75] },
  },
  {
    id: 'translate-backtranslate',
    label: 'Translation and back-translation',
    purpose: 'Test semantic preservation through language-dependent surface replacement.',
    parameters: { languagePaths: 5 },
  },
  {
    id: 'reorder-merge-split',
    label: 'Sentence reorder and paragraph merge/split',
    purpose: 'Break positional assumptions while preserving most propositions.',
    parameters: { deterministic: true, llmVariants: true },
  },
  {
    id: 'excerpt',
    label: 'Excerpt retention',
    purpose: 'Measure payload recovery as semantic units are removed.',
    parameters: { retainedFractions: [0.1, 0.25, 0.5, 0.75] },
  },
  {
    id: 'human-edit',
    label: 'Tracked human edit simulation',
    purpose: 'Measure ordinary grammar, tone, and legal-precision editing.',
    parameters: { trackedChangesRequired: true },
  },
];

export const TIER4_ATTACKS: readonly Tier4AttackDefinition[] =
  Object.freeze(ATTACKS);
