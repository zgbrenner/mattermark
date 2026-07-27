# Mattermark

[![CI](https://github.com/zgbrenner/mattermark/actions/workflows/ci.yml/badge.svg)](https://github.com/zgbrenner/mattermark/actions/workflows/ci.yml)

**Recipient attribution and work-product fingerprinting.**

Mattermark marks each recipient's copy of a document with a cryptographically
derived identifier embedded across independent text surfaces. When a copy
surfaces where it should not, Mattermark recovers the identifier and resolves it
to the recipient, matter, and version recorded in the registry.

The marking and detection engine is **MarkItYours**. The repository and product
are **Mattermark**.

The design begins with Mode A in Raz et al., *Safeguarding LLMs Against Misuse
and AI-Driven Malware Using Steganographic Canaries*, arXiv:2603.28655v1, then
changes the identity, framing, document adapters, and registry for recipient
attribution. The production package has zero runtime npm dependencies and runs
locally with Node.js built-ins.

```bash
npm install
npm run demo         # mint -> mark -> transform -> attribute
npm run matrix       # survival matrix across the 16-document corpus
npm run docx-demo    # mark and recover DOCX and supported PDF files
npm run ledger-demo  # encrypted, tamper-evident registry
npm test             # typecheck + node:test suite
```

Read [`SECURITY.md`](SECURITY.md) before using Mattermark against real work
product. The limitations are part of the product contract.

## What this is, and what it is not

The source paper describes a vendor-side ingestion tripwire. A cooperating AI
vendor detects a canary before training or ingestion. Mattermark does not assume
that cooperation.

Mattermark instead marks outbound copies for **later leak attribution**. The
registry, which the paper leaves out of scope, is therefore central: a recovered
full token is cryptographically verified, and a recovered short identifier is
resolved against the protected-copy ledger.

Mattermark is not digital rights management, a guarantee that a document cannot
be copied, or a covert channel that survives a knowledgeable adversary. A
motivated recipient can remove the symbolic marks. The linguistic research track
is intended to raise that cost, not to make absolute claims.

## Current slices

| Slice | Status | Result |
|---|---|---|
| 1. Marking engine | Implemented | WS, ZW, and HG channels; framed recipient tokens; excerpt resynchronization |
| 2. Document formats | Implemented for a conservative envelope | DOCX extract/mark/reinject; PDF invisible incremental carrier; PDF detection |
| 3. Evidentiary registry | Implemented | Encrypted single-file store, append-only hash chain, versioned anchor checkpoints, local and OpenTimestamps anchors |
| 4. Linguistic layer | Research scaffold | Versioned model manifests, deterministic hashing, fail-closed compatibility checks, Tier-4 attack definitions, and release gates |

## Repository layout

| File | Role |
|---|---|
| `src/frame.ts` | Payload framing, base-b digits, magic-sync resynchronization |
| `src/crypto.ts` | HMAC-SHA256, Ed25519, and SHORT_ID token schemes |
| `src/codecs/*.ts` | WS, ZW, and HG codecs behind one interface |
| `src/orchestrator.ts` | Composition guard, payload sizing, `mark()` and `detect()` |
| `src/transforms.ts` | Transform taxonomy T01-T11 and composite chains |
| `src/formats/docx.ts` | DOCX text extraction and reinjection across text-bearing parts |
| `src/formats/pdf.ts` | Public PDF facade for extraction, marking, detection, and fixtures |
| `src/formats/pdf-reader.ts` | Visible-text and Mattermark-carrier extraction |
| `src/formats/pdf-xref.ts` | Classic xref parsing and incremental-update primitives |
| `src/formats/pdf-marker.ts` | Conservative invisible carrier insertion and `markPdf()` |
| `src/formats/pdf-fixture.ts` | Spec-compliant PDF fixture writer for tests and demos |
| `src/formats/index.ts` | DOCX and PDF document API |
| `src/ledger/*.ts` | Encrypted, hash-chained `SecureRegistry`, historical checkpoints, and anchor providers |
| `corpus/` | 16 synthetic legal documents, 200 to 55,103 characters |
| `src/research/linguistic/` | Research-only model manifest, generator contracts, and Tier-4 attack matrix |
| `docs/research/tier4-linguistic-layer.md` | Slice 4 research decision record |

## Deliberate deviations from the source paper

### 1. Magic-sync framing

The paper frames a payload as `length || token` and assumes decoding starts at
position zero. That fails when a leak is an excerpt. Mattermark prepends a magic
marker, version, and scheme, repeats frames through available capacity, and
brute-forces sub-byte alignment during recovery.

Frame layout:

```text
magic(2) | version(1) | scheme(1) | length(2) | token(N)
```

The six-byte overhead buys position-independent resynchronization.

### 2. Per-channel payload sizing

A full Ed25519 frame may fit only once in the durable homoglyph channel of a
short memo. Mattermark lets each channel select the largest frame it can repeat
enough times for excerpt recovery:

- full HMAC or Ed25519 token where capacity permits;
- `SHORT_ID` where repeated full frames do not fit.

`SHORT_ID` is a 12-byte registry pointer:

```text
copy_uuid(4) | HMAC(k_org, copy_identity)[0:8]
```

It has 64-bit forgery resistance and is not self-verifying. It is a corroborating
registry pointer and must not be deployed as the only identity channel.

### 3. Recipient-derived copy identity

The copy identity is derived from:

```text
matter | recipient | version | issued_at | nonce
```

The product question is which recipient received the leaked copy, not whether a
particular path was ingested.

## Composition guard

Naively placing the same payload in every channel can make recovery worse.
`assertComposable()` enforces:

1. disjoint character surfaces;
2. no whitespace channel beneath a future linguistic channel;
3. at least one Tier-2 survivor unless the caller explicitly accepts a
   search-preserving, non-durable mark.

The default stack is `WS + ZW + HG`.

## Measured symbolic survival

Reference case: 1,522-character privileged memo, both token schemes. `Y` means a
token was recovered and attributed.

| Stack | T0 | T1 | T2 | T3 | T1+2 | T1+2+3 | T11 | 50% excerpt | 20% excerpt |
|---|---|---|---|---|---|---|---|---|---|
| HG | Y | Y | Y | . | Y | . | . | Y | . |
| ZW+HG | Y | Y | Y | . | Y | . | . | Y | Y* |
| WS+ZW+HG | Y | Y | Y | . | Y | . | Y | Y | Y* |

`*` HMAC only; Ed25519 loses the 20% excerpt case in the reference memo.

Channel behavior:

- **WS** dies when NFKC folds its space alphabet to ordinary spaces.
- **ZW** dies when format characters are stripped.
- **HG** is the symbolic Tier-2 survivor and dies when confusables are folded or
  non-ASCII characters are removed.
- **Tier 3 defeats the symbolic stack.** This is expected, measured, and not
  hidden behind an aggregate score.
- **LLM paraphrase is not assigned a synthetic number.** Slice 4 defines the
  real evaluation required for that claim.

Across the 16-document corpus, the current stack durably marks 15 of 16 fixtures.
The 200-character filing notice is below the durable capacity floor. Fifteen are
attributable from a 50% excerpt and thirteen from a 20% excerpt. Larger documents
improve repetition and excerpt recovery, but do not defeat a steganography-aware
sanitizer.

Run `npm run matrix` for the complete per-document output.

## The homoglyph channel is a disclosed choice

HG substitutes Cyrillic confusables for Latin letters. The page looks unchanged,
but exact-match search, spellcheck, and some e-discovery indexing can break. For
litigation work product, that may be disqualifying.

The engine therefore reports the trade:

```ts
// Durable symbolic stack. warnings[] discloses search impact.
mark(text, identity, issuer);

// Search-preserving, Tier-1-only stack.
mark(text, identity, issuer, {
  codecs: ['WS', 'ZW'],
  allowNonDurable: true,
});
```

`maxHomoglyphDensity` can cap substitutions, trading excerpt resilience for less
search disruption.

PDF marking behaves differently: the ordinary visible text is untouched. The
homoglyphs exist only in a separate invisible carrier. Ordinary visible-text
search still has the original glyphs, although a text extractor can expose the
hidden carrier.

## Document formats

### DOCX

Mattermark marks all recognized text-bearing OOXML parts as one payload:

- document body;
- footnotes and endnotes;
- headers and footers;
- comments.

```ts
import { markDocx, detectDocx } from './src/formats/index.js';

const marked = markDocx(docxBuffer, identity, issuer, {
  codecs: ['WS', 'ZW', 'HG'],
});

const detection = detectDocx(recoveredDocx, ['WS', 'ZW', 'HG']);
```

The DOCX adapter is a zero-dependency ZIP and OOXML implementation. Non-text
parts are preserved, and marked text is redistributed across the original runs.

### PDF marking

PDFs position glyphs and frequently embed subset fonts, so editing existing text
operators is unsafe. Mattermark does not mutate those operators. It appends an
incremental revision containing:

- a blank Type 3 glyph program;
- zero glyph widths;
- a `ToUnicode` CMap carrying the marked Unicode text;
- text rendering mode 3, which renders no pixels;
- one shared carrier stream referenced by each page.

```ts
import { markPdf, detectPdf, extractPdfText } from './src/formats/index.js';

const marked = markPdf(pdfBuffer, identity, issuer, {
  codecs: ['WS', 'ZW', 'HG'],
});

const visibleText = extractPdfText(marked.bytes); // ordinary carrier excluded
const detection = detectPdf(marked.bytes, ['WS', 'ZW', 'HG']);
```

Properties within the supported envelope:

- every original byte is an exact prefix of the marked file;
- existing page content and embedded fonts are not edited;
- ordinary text extraction excludes the Mattermark carrier;
- carrier-aware detection recovers from the dedicated hidden stream;
- all directly addressable pages reference the shared carrier;
- unsupported structures fail closed.

The implementation has been checked with independent PDF parsing and Ghostscript
rendering on controlled fixtures. The original and marked fixture rendered to
pixel-identical images.

**Supported marking envelope:** classic xref tables and their `/Prev` revision
chains, directly addressable page objects, direct or indirect page resources,
direct or indirect font resource dictionaries, and `Contents` as an indirect
reference or reference array. Marking follows indexed objects rather than
object-like bytes that happen to appear inside streams or trailing data.

**Rejected rather than repaired:** encryption, xref streams, hybrid-reference
files, object streams, signed or certified PDFs, inherited or missing page
resources, unsupported resource/content shapes, image-only PDFs with no
extractable text, more than 255 distinct carrier characters, and a second
Mattermark carrier.

**Structure-dependence warning:** printing, rasterization, flattening, OCR
replacement, optimization, or removal of invisible text can destroy the PDF
carrier. Generic extraction, copy/paste, and assistive technology may expose or
read the hidden text. PDF marking is file-level attribution, not print-level
watermarking.

## Registry and anchoring

`src/registry.ts` remains the plaintext prototype. Use `SecureRegistry` for real
evaluation:

```ts
import {
  SecureRegistry,
  localAttestationAnchor,
} from './src/ledger/index.js';

const registry = SecureRegistry.openOrCreate('matter.reg', passphrase);
registry.add(protectedCopy);
registry.recordInvestigation(tokenHex, investigationEvent);

const localCheckpoint = registry.anchorCheckpoint(
  localAttestationAnchor(orgKeyPair),
);
```

The durable registry provides:

- AES-256-GCM encryption under a scrypt-derived key;
- an append-only event log;
- a hash chain binding each event to its predecessor;
- replay-derived copy rows and investigation history;
- a Merkle root suitable for external anchoring.

### OpenTimestamps external anchor

The local Ed25519 anchor proves what the organization signed, but its time is
self-asserted. `openTimestampsCliAnchor()` creates a detached OpenTimestamps proof
that can mature into a Bitcoin-attested time proof.

The adapter uses the official `ots` command as an optional external executable.
It adds no npm runtime dependency.

```ts
import {
  SecureRegistry,
  openTimestampsCliAnchor,
} from './src/ledger/index.js';

const registry = SecureRegistry.open('matter.reg', passphrase);
const anchor = openTimestampsCliAnchor();

// Usually pending immediately after submission.
let checkpoint = registry.anchorCheckpoint(anchor);
let status = anchor.inspect(checkpoint.proof);

// Later, after calendar attestations can be upgraded into a Bitcoin proof.
checkpoint = {
  ...checkpoint,
  proof: anchor.refresh(checkpoint.proof),
};
status = anchor.inspect(checkpoint.proof);

if (
  status.status === 'verified' &&
  registry.verifyAnchorCheckpoint(anchor, checkpoint)
) {
  console.log(status.blockHeight, status.attestedAt);
}
```

Proof lifecycle:

1. `anchorCheckpoint()` records a versioned package containing the event count,
   chain head, Merkle root, and provider proof.
2. `commit()` writes a canonical statement binding the Merkle root and local
   request time, then runs `ots stamp`.
3. The detached `.ots` bytes are stored in `AnchorProof` as base64.
4. A pending proof is not valid and does not yet claim third-party time.
5. `refresh()` runs `ots upgrade` and returns a new proof object.
6. `inspect()` runs `ots verify` and returns `verified` only for an explicit
   successful Bitcoin block attestation.
7. `verifyAnchorCheckpoint()` recomputes the recorded ledger prefix, so the
   checkpoint remains usable after later events move the current root.

The `AnchorProof.at` value remains the local request time. Only
`AnchorInspection.attestedAt` on a verified proof is independently attested.
Proof binding is checked before the external verifier runs, so changing the root
or request time invalidates the proof locally. Store the complete checkpoint,
not only the `.ots` bytes. A bare proof identifies a root, while the checkpoint
identifies the exact ledger prefix that produced it.

Rekor v1 was not selected as the first provider because its signed integrated
time is not independently verifiable as a trusted timestamp. Rekor v2 uses a
separate timestamp authority and can be added behind the same interface when its
public-instance lifecycle is stable for this use case.

OpenTimestamps references:

- <https://github.com/opentimestamps/opentimestamps-client>
- <https://opentimestamps.org/>

## Slice 4: linguistic resistance research

The production codec registry still contains only `WS`, `ZW`, and `HG`. The
linguistic layer remains a research track because generation-time watermarking
has a different contract, and because modifying existing legal language creates
fidelity risk. `src/research/linguistic/` now provides a research-only
`LinguisticGenerator` contract, a versioned `ModelManifest`, deterministic
manifest hashing, fail-closed compatibility checks, and the minimum Tier-4
attack matrix. It does not generate or rewrite text yet.

The research decision record covers:

- exact-model arithmetic coding as a reproducibility baseline;
- SemStamp, k-SemStamp, SemaMark, PostMark, SWAN, DEW, and SAMark;
- recipient-specific payload recovery versus statistical watermark detection;
- model/tokenizer/runtime manifests and fail-closed compatibility;
- error correction and sentence-level interleaving;
- a Tier-4 paraphrase, translation, summarization, reorder, and excerpt suite;
- legal redline gates for numbers, dates, parties, citations, quotations,
  defined terms, modality, and negation.

See [`docs/research/tier4-linguistic-layer.md`](docs/research/tier4-linguistic-layer.md).

The recommended first implementation is generated synthetic canary text with a
pinned model manifest and recoverable Mattermark frame. In-place rewriting of
lawyer-authored work product is not a production feature.

## Roadmap

- **Slice 1:** implemented and measured.
- **Slice 2:** DOCX and conservative PDF marking/detection implemented. Expand
  PDF coverage only with parser-backed fixtures and fail-closed handling.
- **Slice 3:** encrypted registry and OpenTimestamps provider implemented.
  Consider RFC 3161 and Rekor v2 providers; revisit SQLite when the Node 20 and
  zero-dependency constraints change.
- **Slice 4:** connect the research scaffold to an isolated experiment harness,
  reproduce the arithmetic-coding baseline, add error correction, and measure
  recipient-payload recovery under the documented Tier-4 suite.

## Non-technical blockers before production

### Name clearance

Mattermark was previously used by a startup-data company. The semantic fit does
not substitute for trademark clearance. Check live registrations and retained
rights before public commercial use.

### Public implementation

This repository is MIT-licensed and public. A recipient can read the codec
alphabets and strip a mark. Open review has security value, but this is a
conscious product decision, not an accidental one.

### Active canaries

Mattermark currently uses passive marks. Adding a callback or tracked resource
to a document sent to a third party raises professional-responsibility and
anti-deception questions. Keep active canaries gated behind explicit disclosure
and a real ethics analysis.

### Freedom to operate

Do not copy patent-encumbered implementations. The current WS, ZW, HG, DOCX,
PDF, and ledger code is implemented from public specifications and research
ideas, not from a proprietary marking product.
