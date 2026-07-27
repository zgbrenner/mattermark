# Tier-4 Linguistic Layer Research

**Status:** research decision record plus initial scaffold, 2026-07-27
**Decision:** do not register an `LM` codec in the production stack yet. Build a separate, reproducible generation-and-detection harness for synthetic canaries first. The versioned manifest, compatibility gate, generator contract, and minimum attack matrix now live in `src/research/linguistic/`.

## Executive finding

Mattermark's current symbolic channels can survive benign handling and routine sanitization, but a motivated recipient can remove them with generic normalization. A linguistic layer is the correct research direction for paraphrase resistance, but it is not a drop-in fourth text codec.

The reference paper's linguistic mode uses GPT-2 124M with arithmetic coding and requires the encoder and decoder to run an identical model. It reports strong survival through its Tier 3 transforms. The same paper treats Tier 4 semantic rewriting as the level that defeats all tested methods. Mattermark therefore must describe this work as **toward Tier-4 resistance**, not as a solved Tier-4 guarantee.

The most important product distinction is:

- **Existing legal work product:** silently rewriting clauses, facts, defined terms, quotations, citations, or negotiated language creates unacceptable fidelity risk. No semantic rewriter should touch a lawyer-authored document without an explicit review workflow.
- **Synthetic canaries and generated cover text:** generation-time linguistic marking is technically and operationally plausible because the system controls the text from the first token.

## What must be preserved

A Mattermark mark is not merely a statistical indication that text came from some model. It carries a recipient-specific cryptographic token or a registry-resolvable short identifier. Many language-model watermark papers optimize binary detection of “watermarked versus unwatermarked” text and do not directly provide a high-capacity arbitrary-payload channel.

Any candidate must therefore be measured on four separate properties:

1. **Attribution payload:** recover the intended recipient token, not only a positive watermark score.
2. **False attribution:** never decode one recipient as another.
3. **Transformation survival:** recover after paraphrase, translation, sentence reordering, summarization, and excerpting.
4. **Text fidelity:** preserve legal meaning, citations, defined terms, quotations, numbers, and negation.

A method that performs well on statistical detection but cannot carry a recipient-specific payload is a useful signal layer, not a replacement for Mattermark framing.

## Candidate families

| Family | Representative work | Strength | Mattermark limitation |
|---|---|---|---|
| Exact-model arithmetic coding | Reference paper Mode B | Carries arbitrary bytes and is reproducible with a fixed model | Encoder and decoder must match exactly; token-level choices are vulnerable to semantic rewriting |
| Sentence semantic partitioning | [SemStamp](https://aclanthology.org/2024.naacl-long.226/), [k-SemStamp](https://aclanthology.org/2024.findings-acl.98/), [SemaMark](https://aclanthology.org/2024.findings-naacl.40/) | Better paraphrase survival than token-only watermarks | Primarily statistical detection; payload capacity and deterministic recipient attribution need new work |
| Black-box post-generation marking | [PostMark](https://aclanthology.org/2024.emnlp-main.506/) | Does not require model logits and was evaluated across multiple models and paraphrasers | Rewrites generated text; legal fidelity and arbitrary-payload behavior are not established |
| Semantic-structure marking | [SWAN](https://aclanthology.org/2026.acl-long.1681/) | Encodes at the AMR level and reports up to 13.9 AUC-point improvement under paraphrasing | Uses statistical detection and an AMR parser; legal-domain stability and payload capacity remain open |
| Embedding-space signals | [DEW](https://arxiv.org/abs/2606.31602) | Recent dual-embedding approach reports paraphrase and translation robustness | Very recent preprint; replication, payload support, and local-runtime cost are unknown |
| Paragraph-order-independent semantics | [SAMark](https://arxiv.org/abs/2605.25796) | Targets paragraph-level paraphrase and sentence reordering | Very recent preprint; still oriented toward watermark detection rather than recipient-token recovery |

## Recommended architecture

Do not force the first linguistic experiment into `StegoCodec`. That interface assumes a deterministic text-in, digit-stream-in, text-out transform and a decoder that directly returns digits. Generation-time methods have different control flow and metadata requirements.

Start with a separate interface. The first scaffold is implemented in
`src/research/linguistic/` and records every input that can change deterministic
decoding:

```ts
export interface ModelManifest {
  format: 'mattermark-linguistic-model-manifest-v1';
  algorithm: { id: string; version: string };
  model: { id: string; weightsSha256: string };
  tokenizer: { id: string; filesSha256: string };
  runtime: { name: string; version: string };
  quantization: string;
  promptTemplateSha256: string;
  decoding: Record<string, ManifestValue>;
}

export interface LinguisticGenerator {
  readonly id: string;
  generate(prompt: string, payload: Uint8Array, manifest: ModelManifest): Promise<LinguisticGenerationResult>;
  recover(text: string, manifest: ModelManifest): Promise<LinguisticRecoveryResult>;
}
```

`hashModelManifest()` uses canonical key ordering and normalized SHA-256 fields.
`assertModelManifestCompatible()` and `assertModelManifestHash()` fail closed
when model weights, tokenizer files, runtime, quantization, prompt template, or
decoding settings differ. This is plumbing for experiments, not a claim that a
linguistic carrier exists.

The manifest is evidentiary, not convenience metadata. Arithmetic decoding can fail catastrophically when tokenizer files, model weights, quantization, runtime kernels, or generation settings differ. Store the manifest hash with every issued copy.

The generation layer should reuse Mattermark's existing frame format rather than inventing a second identity scheme:

1. Build the normal full or short frame.
2. Add an error-correcting code and interleave codewords across sentences or semantic units.
3. Generate marked text from those codewords.
4. Recover candidate codewords, decode ECC, then pass bytes to the existing frame scanner.
5. Require normal cryptographic or registry verification before attribution.

## Experimental program

### Phase A: reproduce the reference baseline

Implement GPT-2 124M arithmetic coding as a controlled baseline, not as the final model choice. Pin and hash:

- model weights;
- tokenizer vocabulary and merges;
- runtime and version;
- quantization format;
- sampling and arithmetic-coder settings;
- prompt template and payload framing version.

Success means two isolated environments with the same manifest generate and decode the same payload, while a deliberately altered tokenizer or model hash fails closed with a manifest mismatch instead of returning garbage.

### Phase B: add recipient-specific payloads to semantic methods

Prototype at least two semantic families:

- a sentence-space partition method based on SemStamp or k-SemStamp;
- a semantic-structure method based on SWAN or a comparable AMR representation.

For each method, test both:

- a statistical one-bit signal per unit;
- a keyed multi-region mapping that carries framed payload bits.

The detector must report confidence and erasures. It must not guess missing bits merely to produce a token.

### Phase C: adversarial evaluation

Extend the transform taxonomy with a Tier-4 suite:

| Attack | Minimum variants |
|---|---:|
| Instruction-following paraphrase | 3 model families, 3 prompts each |
| Sentence-by-sentence rewrite | 3 model families |
| Full-document rewrite | 3 model families |
| Summarization and re-expansion | 3 compression ratios |
| Translation and back-translation | 5 language paths |
| Sentence reorder and paragraph merge/split | deterministic plus LLM variants |
| Excerpting | 10%, 25%, 50%, and 75% retained |
| Human edit simulation | tracked edits for grammar, tone, and legal precision |

Measure:

- exact full-token recovery;
- exact short-ID recovery;
- false-positive and false-attribution rates;
- bit error and erasure rates before ECC;
- text quality and semantic similarity;
- legal-fidelity failures, especially numbers, negation, citations, quotations, defined terms, and obligations;
- generation and detection latency on the supported local hardware;
- storage cost of model manifests and auxiliary proofs.

### Phase D: legal-domain review

Before any method can rewrite existing work product, create a locked test set containing contracts, briefs, privileged memoranda, discovery responses, quotations, and citation-heavy passages. Review outputs with a redline, not only embedding similarity. Any change to a number, party, date, legal standard, defined term, quotation, citation, modality, or negation is an automatic failure.

## Go and no-go gates

A first experimental release may proceed for **synthetic canary generation** when all of the following hold:

- false attribution is zero in the published test set;
- token recovery is measured separately from statistical detection;
- every issued artifact stores a complete model manifest hash;
- decoding fails closed on model or tokenizer mismatch;
- results include multiple unseen paraphrasers and translation paths;
- the implementation runs locally within the documented hardware envelope.

Do not enable **in-place legal-document rewriting** unless a separate legal-fidelity evaluation shows no material changes and the workflow requires human redline approval. At present, that is a research target, not a production claim.

## Immediate implementation backlog

1. **Done:** add a research-only linguistic package outside the production codec registry.
2. **Done:** define a versioned `ModelManifest`, canonical hashing, fail-closed compatibility checks, `LinguisticGenerator`, and the minimum Tier-4 attack definitions.
3. Reproduce the GPT-2 124M arithmetic-coding baseline with deterministic fixtures.
4. Add Reed-Solomon or BCH error correction plus sentence-level interleaving.
5. Implement a SemStamp-family detector and measure payload capacity, not only detection AUC.
6. Implement an AMR-family detector and test semantic-unit stability on legal text.
7. Connect model-backed Tier-4 transforms to the attack definitions and publish raw per-document results.
8. Revisit production registration only after the go/no-go gates are met.

## Bottom line

The linguistic layer is worth pursuing, but the safe first product is a **generated-canary mode with a pinned model manifest and recoverable framed payload**. Treat semantic watermarks as candidate carriers or corroborating signals. Do not claim that any current method makes arbitrary legal work product immune to Tier-4 rewriting.
