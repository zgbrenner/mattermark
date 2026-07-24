# Mattermark

[![CI](https://github.com/zgbrenner/mattermark/actions/workflows/ci.yml/badge.svg)](https://github.com/zgbrenner/mattermark/actions/workflows/ci.yml)

**Recipient attribution and work-product fingerprinting. Slice 1: the engine.**

Local-first work-product fingerprinting. Marks a per-recipient copy of a
document with a cryptographically derived identifier embedded across
independent character surfaces, and attributes a recovered leak back to a
specific recipient, matter, and version.

Architecturally anchored to Raz et al., *Safeguarding LLMs Against Misuse and
AI-Driven Malware Using Steganographic Canaries*, arXiv:2603.28655v1 (NYU
Tandon, 30 Mar 2026), Mode A. Zero runtime dependencies — Node built-in crypto
only. Runs entirely on-device.

```bash
npm install
npm run demo         # full walkthrough: mint -> mark -> transform -> attribute
npm run matrix       # survival matrix across the real 16-document corpus/
npm run docx-demo    # Slice 2: mark a real DOCX/PDF, attribute it back
npm run ledger-demo  # Slice 3: encrypted, tamper-evident, anchored registry
npm test             # typecheck + the node:test suite
```

Read [`SECURITY.md`](SECURITY.md) before deploying this against anything real.
It states plainly what the marks do and do not survive.

## What this is not

The paper builds a **vendor-side ingestion tripwire**: a cooperating AI vendor
runs a pre-ingestion filter and blocks canary-bearing uploads. That requires
vendor cooperation we do not have.

This is the **leak-attribution** repurposing of the same primitives: mark
outbound copies, and when a document surfaces where it should not, prove which
recipient's copy it was. The registry — which the paper puts explicitly out of
scope (§3.5) — is therefore the core of the product, not an accessory.

## Naming

The repository and product are **Mattermark**; the marking/detection engine
inside it is **MarkItYours**.

Two things to settle before this gets any traction:

- **Mattermark was a real company** (startup-data platform, 2012–2017, acquired
  by FullContact in a fire sale and shut down). Different industry, long dead,
  and `matter` + `mark` is close to a perfect semantic fit for legal document
  marking. But a decade of TechCrunch, Crunchbase, and PitchBook results own
  the search term, and Crunchbase still lists "Mattermark Holding Co" as an
  active entity. Trademark abandonment is presumed after three consecutive
  years of non-use under 15 U.S.C. § 1127, and it has been about eight — but
  presumed is not cleared. Someone should check for live registrations and
  whether FullContact retained the mark before this goes on a landing page.
- **The licence is MIT and the repo is public.** For a leak-attribution engine
  that means anyone can fork it commercially, and any recipient of a marked
  document can read `src/codecs/` and strip the mark. That may be the right
  call — open review is worth a lot for a security primitive — but it is a
  deliberate one. Decide it deliberately; git history is permanent.

## Layout

| File | Role |
|---|---|
| `src/frame.ts` | Payload framing, base-b digits, magic-sync resynchronisation |
| `src/crypto.ts` | HMAC-SHA256, Ed25519, and SHORT_ID token schemes |
| `src/codecs/*.ts` | WS / ZW / HG codecs behind one swappable interface |
| `src/orchestrator.ts` | Composition guard, per-channel payload sizing, `mark()` / `detect()` |
| `src/transforms.ts` | Transport-transform taxonomy T01–T11 and composite chains |
| `src/registry.ts` | Attribution ledger and evidence schema (prototype JSON store) |
| `src/harness.ts` | Survival matrix engine (`runMatrix`) |
| `src/corpus.ts` | Corpus manifest and loader |
| `src/matrix.ts` | Runs the survival matrix across `corpus/` |
| `src/formats/zip.ts` | Zero-dependency ZIP reader/writer (`node:zlib` + CRC-32) |
| `src/formats/docx.ts` | DOCX text extract / reinject across all text-bearing parts |
| `src/formats/pdf.ts` | PDF text extraction for detection + a demo PDF writer |
| `src/formats/index.ts` | `markDocx()` / `detectDocx()` — the Slice 2 document API |
| `src/ledger/*.ts` | Slice 3: encrypted, hash-chained, anchored `SecureRegistry` |
| `corpus/` | 16 synthetic legal documents, 200 → 55k chars ([corpus/README.md](corpus/README.md)) |

## Three deliberate deviations from the paper

**1. Magic-sync framing.** The paper frames payloads as `len(BE16) || token`
and relies on head-first selection so decoding always starts at digit 0. That
breaks on excerpts, which is the dominant legal-leak shape — nobody leaks the
whole file, they paste three paragraphs. We prepend `0xA5 0x5A || version ||
scheme` and repeat the frame, and the decoder brute-forces every sub-byte digit
alignment. 6 bytes of overhead buys excerpt attribution.

**2. Per-channel payload sizing (SHORT_ID).** Measurement, not theory: the
74-byte Ed25519 frame fits **exactly once** in the homoglyph channel of a
1.5k-char memo. One head-first copy means any excerpt clipping the front of the
document loses the only durable mark. So each channel now picks the largest
frame it can repeat at least 3 times, falling back to a 12-byte registry
pointer (`copy_uuid(4) || HMAC(k_org, id)[:8]`). High-capacity fragile channels
carry the full self-verifying signature; low-capacity durable channels carry
the repeated pointer.

Stated plainly: SHORT_ID is 64-bit forgery resistance, not 128-bit, and it is
**not self-verifying** — it resolves only against the registry. It is only ever
issued alongside a full-strength frame in another channel. Never ship it alone.

**3. Attribution-derived identity.** `copy_id` is derived from
`(matter, recipient, version, timestamp, nonce)` rather than a file path,
because the question is *which recipient*, not *was a canary ingested*.

## Composition guard

The most important empirical result in the paper is a failure mode: improper
layer composition drops Tier-3 recovery **from 97% to 0%** via cross-layer
interference (§6.2). Naive "embed it everywhere for redundancy" makes the
system worse. `assertComposable` enforces:

1. **Disjoint surfaces** — two codecs on the same surface overwrite each other.
2. **Never WS beneath LM** — sanitizers *delete* whitespace rather than
   normalising it, shifting the byte stream the linguistic decoder depends on.
3. **At least one Tier-2 survivor** — a WS-only or ZW-only mark is decorative;
   it dies to routine platform sanitization. The stack is rejected outright.

## Measured results

The reference case: 1,522-char privileged memo, WS+ZW+HG, both schemes. `Y` =
token recovered and attributed. This is the one document the original numbers
were measured on — `npm run matrix` runs the same measurement across the whole
[corpus](corpus/README.md) (see "Across the corpus" below).

| stack | T0 | T1 | T2 | T3 | T1+2 | T1+2+3 | T11 | 50% excerpt | 20% excerpt |
|---|---|---|---|---|---|---|---|---|---|
| HG | Y | Y | Y | . | Y | . | . | Y | . |
| ZW+HG | Y | Y | Y | . | Y | . | . | Y | Y* |
| WS+ZW+HG | Y | Y | Y | . | Y | . | Y | Y | Y* |

\* HMAC only; Ed25519 loses the 20% excerpt case.

Channel survival, per measurement:

- **WS** dies at T05 (NFKC folds every alphabet member to U+0020). Survives
  T11, which is its one distinctive contribution.
- **ZW** dies at T07 (Cf strip) — that is **Tier 2**, not Tier 3 as the paper's
  Table 4 indicates. All four alphabet members are general category Cf. If the
  paper's Cf strip preserved some of them, their implementation differs from
  ours; we report what we measured.
- **HG** is the only Tier-2 survivor and carries the whole "full coverage
  through Tier 2" claim. Dies at T09/T10.
- **Tier 3 defeats everything.** A steganography-aware adversary who folds
  confusables and strips non-ASCII wins against a symbolic-only stack. This is
  expected and matches the paper. Only a linguistic layer changes it.
- **T12 (LLM paraphrase) is NOT MEASURED.** It needs a model, and faking it
  with a synonym shuffle would produce a dishonest number.

### Across the corpus

Survival on one 1.5k memo is not survival on a 40-page brief with tables,
citations, and footnotes. `corpus/` holds 16 synthetic legal documents spanning
200 → 55,103 characters (notice, emails, memo, letters, NDA, deposition, motion,
MSA, expert report, settlement, complaint, appellate brief, regulatory comment).
`npm run matrix` runs the full matrix over all of them. Measured on this repo's
harness, WS+ZW+HG, both schemes:

- **Durably markable: 15 of 16.** Only the 200-char filing notice falls below
  the durability floor — and durability is document-*dependent*, not a length
  cutoff: the 390-char scheduling email clears it because it is letter-dense,
  while a same-length number/table block would not.
- **Attributable from a 50% excerpt: 15 of 16. From a 20% excerpt: 13 of 16.**
  Excerpt resilience rises with document size; deep excerpts of the brief, the
  MSA, and the expert report stay attributable where the smaller documents do
  not.
- **Tier 3 still defeats every document.** Size buys durability and excerpt
  resilience; it does not buy resistance to a steganography-aware adversary.
  That result is uniform across the corpus, exactly as on the memo.

The point is that a single number on a single memo hid all of this. The corpus
makes the matrix mean something.

## Known limits

- **Minimum document size ~400 characters.** A 280-char document cannot fit
  even a short frame in the homoglyph channel; it marks at Tier 1 and dies at
  Tier 2. Short documents are not durably markable. The engine reports this
  rather than silently degrading.
- **Excerpt threshold.** Attribution needs a window containing two consecutive
  frame lengths of eligible positions — roughly 45–50% of a 1.5k document,
  falling as document length rises. Below that, no recovery.
- **HG breaks exact-match search — kept, but as an explicit option.** Cyrillic
  substitutions replace Latin letters in place, so they defeat naive Ctrl-F,
  spellcheck, and some e-discovery keyword indexing, and the altered words look
  identical on screen. For litigation work product that is a real operational
  cost and **may be disqualifying** — e-discovery keyword search over the
  marked copy is central to the practice, and a silently corrupted index is
  worse than no mark. See ["The homoglyph channel"](#the-homoglyph-channel-a-disclosed-option) below.
- **No Reed-Solomon yet.** Frame repetition handles excerpting; RS would handle
  *partial character corruption* within a frame. The version byte reserves
  space for it.

## The homoglyph channel: a disclosed option

**Decision: keep HG, but make it an option, and disclose the cost.**

HG is the only symbolic channel that survives Tier-2 sanitization, so it is what
makes a mark *durable*. It earns that durability by substituting Cyrillic
look-alikes for Latin letters — which is exactly what breaks exact-match search,
spellcheck, and e-discovery keyword indexing on the marked copy. For a litigator
whose workflow depends on keyword search over produced documents, a silently
corrupted index can be **disqualifying**. We are not going to pretend that cost
away, and we are not going to force it on every user.

So the engine treats HG as a deliberate, disclosed choice:

- **It is on by default** (default stack `WS+ZW+HG`), because durability is the
  point of the product — but `mark()` now returns a `warnings[]` array, and
  whenever HG actually substitutes glyphs it carries a plain-language notice
  that exact-match / e-discovery search is broken and *may be disqualifying for
  litigation work product*. The demo and the matrix print it.
- **It can be turned down** with `maxHomoglyphDensity` (cap the fraction of
  eligible glyphs altered, trading excerpt resilience for searchability).
- **It can be turned off** — pass `allowNonDurable: true` and a stack without
  HG (e.g. `WS+ZW`). The composition guard then accepts a **search-preserving,
  Tier-1-only, non-durable** mark instead of rejecting it. The visible letters
  of every word stay intact (zero homoglyph substitutions), so keyword search is
  not corrupted; the trade is that the mark dies to routine platform
  sanitization. `mark()` flags the result non-durable and says so in
  `warnings[]`. Never silently degrade — report.

```ts
// durable, but breaks search (default):
mark(text, id, issuer);                        // WS+ZW+HG; warnings[] carries the HG notice

// search-preserving, but non-durable (deliberate opt-out):
mark(text, id, issuer, { codecs: ['WS', 'ZW'], allowNonDurable: true });
```

`npm run matrix` quantifies the trade on real documents: on the 1.5k memo the
durable stack makes ~240 homoglyph substitutions and the appellate brief ~8,600;
the search-safe stack makes zero. Choose per matter, with the cost in view.

## Document formats (Slice 2)

The engine marks strings; legal work product is DOCX. `src/formats/` does the
extract → mark → reinject round-trip on a real DOCX **in place**:

```ts
import { markDocx, detectDocx } from './src/formats/index.js';

const { bytes, result } = markDocx(docxBuffer, identity, issuer, { codecs: ['WS', 'ZW', 'HG'] });
// deliver `bytes`; later, on a recovered copy:
const found = detectDocx(recoveredBuffer, ['WS', 'ZW', 'HG']);
```

- A DOCX is a ZIP of OOXML parts. `src/formats/zip.ts` reads and writes ZIP with
  **no dependencies** — Node's built-in `zlib` for DEFLATE and a hand-rolled
  CRC-32 — so the "Node built-ins only" promise still holds.
- **Every text-bearing part is marked** — body, footnotes, endnotes, headers,
  footers, comments. Their text is concatenated in a fixed order, marked as one
  payload, and redistributed back across all their runs; all non-text parts are
  preserved byte-for-byte. The redistribution is lossless, accounting for the
  zero-width codec's inserted characters.
- `npm run docx-demo` builds DOCX copies of the memo and the 40-page appellate
  brief, marks them, and attributes them back — surviving Tier 1–2 and deep
  excerpting, exactly as the plain-text harness measures.

**PDF: detection yes, marking no — and that split is not a shortcut.** A PDF
cannot be *marked* in place with these codecs: a PDF positions glyphs, so a
zero-width insertion, a wider space, or a confusable with different metrics needs
the glyph to exist in the (usually subsetted) embedded font and shifts the
visible layout. That is a font/layout problem, a separate slice. But a document
marked as text (or as a DOCX) and then *exported* to PDF keeps its marks in the
PDF's text layer, so a leaked PDF is still attributable:

```ts
import { detectPdf } from './src/formats/pdf.js';
const found = detectPdf(recoveredPdfBuffer, ['WS', 'ZW', 'HG']);
```

`src/formats/pdf.ts` reads the common, well-defined subset — classic `xref`
objects, FlateDecode or unfiltered content streams, and text shown with Tj/TJ
decoded through the font's ToUnicode CMap (Latin-1 fallback). **Out of
envelope, and reported rather than silently mangled:** object-stream / xref-stream
full-compression (PDF 1.5+), encryption, and scanned image PDFs with no text
layer. It is validated against spec-compliant PDFs, not the full wild variety;
`npm run docx-demo` shows a marked memo carried through a PDF text layer and
recovered.

## Registry: encrypted, tamper-evident, anchored (Slice 3)

`src/registry.ts` is the plaintext prototype store. `src/ledger/` is the durable
version — a single file, encrypted at rest, append-only and tamper-evident, with
a Merkle root you can anchor:

```ts
import { SecureRegistry, localAttestationAnchor } from './src/ledger/index.js';

const reg = SecureRegistry.openOrCreate('matter.reg', passphrase);
reg.add(protectedCopy);                       // appends a hash-chained event, re-seals the file
reg.recordInvestigation(tokenHex, event);     // append-only; the copy row's hash never changes
const proof = reg.anchor(localAttestationAnchor(orgKeyPair));
```

- **Encryption at rest** — AES-256-GCM under a scrypt-derived key. GCM's auth tag
  doubles as an integrity check: a wrong passphrase or a flipped byte fails to
  open rather than decrypting to garbage. Nothing (recipient, matter, token)
  sits on disk in plaintext.
- **Tamper-evident** — every event (a copy, or an investigation) commits to the
  previous event's hash. An insider who has the passphrase, edits a past row, and
  re-encrypts is still caught: recomputing the chain no longer reproduces the
  stored head. State (rows, short-id index, investigations) is *replayed* from
  the immutable event log.
- **Anchoring, honestly** — the chain proves order and integrity *within* the
  ledger. Proving a row is prior to a date *to a skeptic* needs a timestamp from
  a party they trust. The `Anchor` interface is where OpenTimestamps, Rekor, or
  an RFC 3161 TSA plug in; the built-in `localAttestationAnchor` signs the Merkle
  root with the org key (non-repudiable as to the org, but `thirdPartyTime:
  false` — its timestamp is self-asserted). Swap the anchor to change the trust
  root; the mechanism is identical.

**On SQLite:** the roadmap named SQLite. A real SQLite backend needs a native
dependency or `node:sqlite` (Node 22.5+), both of which break the
zero-dependency + Node-20 stance. The store is a sealed single file today, and
the interface is narrow enough that a SQLite backend slots in behind it unchanged
when those constraints relax — what SQLite was wanted for (a durable, single-file,
encrypted, evidentiary store) is delivered.

## Roadmap

- **Slice 2 (done)** — DOCX extract-mark-reinject across all text-bearing parts,
  plus PDF *detection* via text extraction (`src/formats/`, `npm run docx-demo`).
  Remaining, and genuinely hard: PDF *marking*, a glyph-layout problem as above.
- **Slice 3 (done)** — encrypted, tamper-evident, anchored `SecureRegistry`
  (`src/ledger/`, `npm run ledger-demo`). Remaining: an external anchor
  integration (OpenTimestamps / Rekor) behind the `Anchor` interface, and a
  SQLite backend once the dependency constraints allow.
- **Slice 4 (research)** — linguistic layer for Tier-4 resistance. Note the
  paper's own constraint: encoder and decoder must run an *identical* model,
  and their choice of GPT-2 124M was for portability, not quality. This is a
  research track, not a feature.

## Two non-technical blockers before this ships

**Active canaries are an ethics question, not a feature question.** The spec's
item 3 (tracked resource / verification link) embeds a callback in a document
sent to a third party. For the attorney market that is plausibly surreptitious
tracking of opposing counsel, and several state bars have addressed undisclosed
tracking bugs in email under the anti-deception and third-party-communication
rules. The passive steganographic layer has no such problem — nothing phones
home; detection happens only when *you* run the detector on a recovered
artifact. Build passive-first; gate any active canary behind an explicit
disclosure workflow (`ProtectedCopy.activeCanary.disclosedToRecipient` exists
for exactly this) and get a real ethics memo before it appears in a demo.

**Innamark is patent-encumbered.** Fraunhofer ISST's underlying algorithm is
associated with patent applications. Nothing in this codebase derives from it —
WS/ZW/HG here are implemented from the paper's descriptions and from Unicode
primitives — but keep it that way, and run freedom-to-operate before borrowing
anything from that implementation.
