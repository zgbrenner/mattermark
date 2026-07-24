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
npm run demo       # full walkthrough: mint -> mark -> transform -> attribute
npm run matrix     # survival matrix across the real 16-document corpus/
npm run typecheck
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
inside it is **Tolaria**. Same pattern as Sonomos / Locke / Spliicer.

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
  call — open review is worth a lot for a security primitive, and it matches
  the AgentCounsel / PrivacyQuant posture. It is a different call from Spliicer.
  Decide deliberately; git history is permanent.

## Layout

| File | Role |
|---|---|
| `src/frame.ts` | Payload framing, base-b digits, magic-sync resynchronisation |
| `src/crypto.ts` | HMAC-SHA256, Ed25519, and SHORT_ID token schemes |
| `src/codecs/*.ts` | WS / ZW / HG codecs behind one swappable interface |
| `src/orchestrator.ts` | Composition guard, per-channel payload sizing, `mark()` / `detect()` |
| `src/transforms.ts` | Transport-transform taxonomy T01–T11 and composite chains |
| `src/registry.ts` | Attribution ledger and evidence schema |
| `src/harness.ts` | Survival matrix engine (`runMatrix`) |
| `src/corpus.ts` | Corpus manifest and loader |
| `src/matrix.ts` | Runs the survival matrix across `corpus/` |
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

## Roadmap

- **Slice 2** — DOCX/PDF extract-mark-reinject (python-docx / PyMuPDF, or Rust
  equivalents for the Locke core). *(The real corpus for the harness has landed
  — see [`corpus/`](corpus/README.md) and `npm run matrix`.)*
- **Slice 3** — SQLite-backed registry with encryption at rest; Rekor or
  OpenTimestamps anchoring so the protected-copy hash is provably prior.
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
