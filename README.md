# Mattermark

[![CI](https://github.com/zgbrenner/mattermark/actions/workflows/ci.yml/badge.svg)](https://github.com/zgbrenner/mattermark/actions/workflows/ci.yml)

**Recipient attribution and work-product fingerprinting.**

Local-first work-product fingerprinting. Marks a per-recipient copy of a
document with a cryptographically derived identifier embedded across
independent character surfaces, and attributes a recovered leak back to a
specific recipient, matter, and version.

Architecturally anchored to Raz et al., *Safeguarding LLMs Against Misuse and
AI-Driven Malware Using Steganographic Canaries*, arXiv:2603.28655v1 (NYU
Tandon, 30 Mar 2026), Mode A. Zero runtime dependencies — Node built-in crypto
only. Runs entirely on-device.

## Sixty seconds, end to end

Every command runs as `npm run cli -- <command>`; alias it if you prefer
(`alias mattermark='npx tsx src/cli.ts'`).

```bash
npm install

# 1. Create a vault. One passphrase seals the org key and the registry.
npm run cli -- init --org "Devlin & Cole LLP"
#   Passphrase (min 8 chars): ********
#   Vault created at ./mattermark-vault (scheme: ed25519)
#   Losing this passphrase loses the ability to attribute. There is no recovery.

# 2. Mark a per-recipient copy on the way out.
npm run cli -- protect brief.docx --matter M-2026-014 \
  --recipient jane.doe@example.com --delivery email
#   -> brief--jane-doe-example-com.docx
#   channels WS+ZW+HG · issue-time survival: 6/9 transform tests (Tier 3 lost, as always)
#   note: homoglyph marking breaks exact-match search on this copy (see SECURITY.md)

# 3. A copy surfaces where it should not.
npm run cli -- identify leaked.pdf --record --by g.devlin --source "posted to a forum"
#   CONFIRMED — matter M-2026-014, recipient jane.doe@example.com, v1
#   (Ed25519 token re-verified against the registry row; investigation recorded)

# 4. Produce the evidence report.
npm run cli -- report 9b3f2ac48e11d07c55aa61f0 --out evidence.md
#   -> evidence.md: identity, hashes, issue-time survival, ledger integrity
```

Prefer a point-and-click UI? `npm run ui` serves a local web UI —
localhost-only, drag-and-drop protect/identify, the copies table, and evidence
reports. Nothing ever leaves the machine. See
["Product surface (Slice 4)"](#product-surface-slice-4).

Read [`SECURITY.md`](SECURITY.md) before deploying this against anything real.
It states plainly what the marks do and do not survive.

### Development

The engine-level demos and the measurement harness still run directly:

```bash
npm run demo         # full walkthrough: mint -> mark -> transform -> attribute
npm run matrix       # survival matrix across the real 16-document corpus/
npm run docx-demo    # Slice 2: mark a real DOCX/PDF, attribute it back
npm run ledger-demo  # Slice 3: encrypted, tamper-evident, anchored registry
npm test             # typecheck + the node:test suite
```

## Install

Once published to a registry, Mattermark runs as a plain CLI with no clone and
no `tsx` at runtime:

```bash
npx mattermark init --org "Devlin & Cole LLP"   # run without installing
npm install -g mattermark && mattermark --help  # or install globally
```

`npm run build` compiles the TypeScript to plain-ESM `dist/` (`tsc -p
tsconfig.build.json`); the base `tsconfig` stays `noEmit`, so `npm run typecheck`
and `npm test` are unaffected. The `bin` (`mattermark` → `dist/bin.js`, with a
`#!/usr/bin/env node` shebang) runs under plain `node`. `prepack` builds before
pack/publish, so the published tarball ships a fresh `dist/`; `files` whitelists
`dist` plus LICENSE/README/SECURITY/NOTICE. The library is exposed via `exports`:

```ts
import { openWorkspace } from 'mattermark';
```

`dist/` is gitignored and the build runs on `prepack` (not `prepare`), so
**installing straight from a git ref would not build** — registry install or
`npx mattermark` is the supported path. In a clone, dev still runs through `tsx`:
`npm run cli -- <command>`.

## How attribution works

In plain terms, for readers who do not need the internals:

When a document goes out, Mattermark makes a distinct copy for each recipient
and works an invisible identifier into the text itself — character spacing,
zero-width characters, look-alike letters — not metadata, so it travels with
the words, even through copy-paste. Every recipient's copy is unique, and the
identifier is recorded next to the recipient's name in a sealed, append-only
ledger that never leaves your machine.

If a copy later surfaces where it should not, you feed it back in. Mattermark
reads the surviving identifier out of the text and resolves it against the
ledger: this was the copy issued to this recipient, for this matter, on this
date — with an evidence report you can hand to someone else.

What it does not do: survive deliberate removal. Someone who suspects a mark
and strips invisible characters and look-alike letters removes it entirely,
and a full rewrite or LLM paraphrase defeats it too. The marks survive routine
handling, not a determined adversary — [`SECURITY.md`](SECURITY.md) states
exactly what was measured.

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
| `src/formats/pdf-mark.ts` | Opt-in PDF marking by rebuilding the text layer (WS+ZW, non-durable) |
| `src/formats/index.ts` | `markDocx()` / `detectDocx()` — the Slice 2 document API |
| `src/ledger/*.ts` | Slice 3: encrypted, hash-chained, anchored `SecureRegistry` |
| `src/workspace.ts` | Slice 4: the shared operations layer — vault, `protect` / `identify` / `report` |
| `src/cli.ts` | Slice 4: the CLI (`npm run cli`) |
| `src/ui/` | Slice 4: local web UI (`npm run ui`) — localhost-only, zero-dependency |
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

**PDF: detection always; marking only by rebuilding the text layer, opt-in.** A
PDF cannot be *marked in place* with these codecs: a PDF positions glyphs, so a
zero-width insertion, a wider space, or a confusable with different metrics needs
the glyph to exist in the (usually subsetted) embedded font and shifts the
visible layout. That in-place, arbitrary-font/layout problem is still out of
scope. But a document marked as text (or as a DOCX) and then *exported* to PDF
keeps its marks in the PDF's text layer, so a leaked PDF is still attributable:

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

**Marking a PDF directly (`src/formats/pdf-mark.ts`, opt-in).** When a
text-layer PDF is all you have, `markPdf` will mark it — but honestly about how.
It extracts the text layer, marks it, and **rebuilds a fresh single-page PDF**
whose text layer is the marked text, using its own font and ToUnicode CMap. The
text layer round-trips exactly (`extractPdfText(markPdf(...).bytes)` returns the
marked text; `detectPdf` recovers the token), but the original pagination,
fonts, images, and glyph positioning are **discarded**. The output is an
*attributable text-layer artifact, not a pixel-faithful copy* of the source —
surfaced in `result.warnings`, never silently.

```ts
import { markPdf, detectPdf } from './src/formats/pdf-mark.js';
const { bytes, result } = markPdf(pdfBuffer, identity, issuer); // WS+ZW; result.warnings carries the normalized-layer notice
```

The channel profile is **WS+ZW only**: search-preserving and therefore
**non-durable** (Tier-1 — survives benign copy-paste, dies to routine
sanitization). **HG is refused**, not silently dropped — the rebuilt
non-embedded font has no guaranteed Cyrillic/confusable coverage, so a homoglyph
would render as a missing-glyph box. For durability, mark the DOCX/text source.
`markPdf` throws (emitting no PDF) on: non-PDF input; out-of-envelope PDFs
(encrypted / object-stream / full-compression); no extractable text layer
(scanned/image PDFs); an HG or LM request; or marked text with more than 255
distinct characters (the rebuild font's limit). It inherits `extractPdfText`'s
envelope exactly.

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
  a party they trust. Two anchors ship today (`localAttestationAnchor`,
  `openTimestampsAnchor`); see ["Proving priority"](#proving-priority-anchoring)
  below. Swap the anchor to change the trust root; the mechanism is identical.

**On SQLite:** the roadmap named SQLite. A real SQLite backend needs a native
dependency or `node:sqlite` (Node 22.5+), both of which break the
zero-dependency + Node-20 stance. The store is a sealed single file today, and
the interface is narrow enough that a SQLite backend slots in behind it unchanged
when those constraints relax — what SQLite was wanted for (a durable, single-file,
encrypted, evidentiary store) is delivered.

### Proving priority (anchoring)

The hash chain proves the ledger's internal **order and integrity** — no row can
be altered or reordered without detection. It does *not* prove to a skeptic that
a row existed before a given date: that needs a timestamp from a party the
skeptic trusts. An **anchor** over the ledger's Merkle root fixes its state to a
clock, and because the root commits to every event, **every anchor commits to
every protected copy issued up to that moment**. Two anchors ship:

- **`--local`** (`localAttestationAnchor`) — the vault's Ed25519 key signs the
  digest. Instant and offline, non-repudiable *as to the firm*, but the time is
  **self-asserted** (`thirdPartyTime: false`) — it proves nothing about priority
  to someone who does not take the firm's word for the clock.
- **`--opentimestamps`** (`openTimestampsAnchor`) — submits the Merkle root to
  the public OpenTimestamps Bitcoin calendars (`thirdPartyTime: true`). The proof
  stored is a **real, standard `.ots` `DetachedTimestampFile`**, interoperable
  with any OpenTimestamps tool.

**Pending is not confirmed.** A fresh OpenTimestamps proof is **pending** — a
calendar promise, not yet in Bitcoin. Priority becomes provable to a third party
only after the calendar upgrades the proof and the Bitcoin block confirms
(minutes to hours). Our `verify()` is **offline and structural**: it confirms the
proof is well-formed and commits to your digest — it does **not** reach Bitcoin.
Confirming a Bitcoin attestation needs a block-header source
(`confirmProofAgainstBitcoin`, with a trust root the caller supplies). Never read
"well-formed" as "confirmed".

```bash
mattermark anchor --opentimestamps   # third-party time (needs network); proof is PENDING until Bitcoin confirms
mattermark anchor --local            # instant, offline, self-asserted time
mattermark anchor --list             # anchors recorded for this vault
```

```ts
import { openTimestampsAnchor, localAttestationAnchor, confirmProofAgainstBitcoin } from './src/ledger/index.js';
```

Anchor proofs are stored as plaintext `anchors.json` in the vault — they are
**meant to be shareable**, which is the point of an anchor. `npm run anchor-demo`
runs the full flow against a hermetic calendar (offline, deterministic); the real
`--opentimestamps` needs outbound network, but the demo and every test use an
injected transport. The `AsyncAnchor` interface is ready for a Rekor or RFC 3161
anchor to slot in behind the same contract later — that is an interface, not a
shipped anchor.

## Product surface (Slice 4)

`src/workspace.ts` is the shared operations layer; the CLI (`src/cli.ts`) and
the local web UI (`src/ui/`) are thin surfaces over it, so both behave
identically.

### The vault

`init` creates a vault directory — default `./mattermark-vault`, overridable
with `--vault <dir>` or the `MATTERMARK_VAULT` environment variable — holding
three files:

| File | Contents |
|---|---|
| `config.json` | Non-secret metadata: version, org name, token scheme |
| `org.key` | The 32-byte org key, sealed with AES-256-GCM under a scrypt-derived key |
| `registry.mmv` | The `SecureRegistry`: encrypted, append-only, hash-chained event log with a Merkle root |

One passphrase (minimum 8 characters) seals both the org key and the registry:
one secret to manage, one prompt to answer. Supply it via the
`MATTERMARK_PASSPHRASE` environment variable or the hidden prompt.

**Losing the passphrase loses the ability to attribute. There is no recovery
path — no escrow, no reset.** Every copy ever issued from that vault becomes
unresolvable. Treat the passphrase like the org's signing key, because it is.

The default token scheme is `ed25519` (self-verifying tokens); `hmac` is
available at init time (`--scheme hmac`).

### CLI

```
init     [--org <name>] [--scheme ed25519|hmac]
protect  <file> --matter <ref> --recipient <id> [--version <v>] [--out <path>]
         [--delivery email|secure-link|physical|portal|other] [--note <text>]
         [--by <who>] [--search-safe] [--homoglyph-density <0..1>] [--rebuild-pdf]
identify <file> [--record] [--by <who>] [--source <description>] [--json]
list     [--matter <ref>] [--json]
report   <token-or-short-id> [--out <file.md>] [--json]
anchor   (--opentimestamps | --local) [--json]
anchor   --list [--json]
status   [--json]
ui       [--port <n>] [--no-open]
```

All commands accept `--vault <dir>`.

- **`protect`** takes TXT or DOCX and writes a marked copy (suggested name
  `doc--recipient-slug.ext`). At issue time it runs the marked copy through the
  transform gauntlet — every composite chain in the taxonomy plus 50% and 20%
  excerpts — and records the measured survival in the registry row. The number
  in the evidence report is what *this* copy survived, not a corpus average.
  **PDF input is refused by default** with guidance: mark the DOCX source instead
  — a marked DOCX exported to PDF keeps its marks in the PDF text layer, and
  `identify` reads them back. That remains best practice.
- **`--rebuild-pdf`** opts in to marking a PDF directly, by **rebuilding its text
  layer** (WS+ZW only). The rebuilt PDF keeps the marked text but **discards the
  original pagination, fonts, images, and layout**, and the mark is non-durable;
  it is a text-layer artifact, not a faithful copy. `protect` surfaces the
  normalized-layer warning. Use it only when a text-layer PDF is all you have.
- **`--search-safe`** marks with WS+ZW only, no homoglyphs: exact-match search,
  spellcheck, and e-discovery indexing are untouched, and the mark is
  explicitly **non-durable** (it dies to routine platform sanitization). The
  default mode includes HG and surfaces the search-impact disclosure at protect
  time. `--homoglyph-density` caps the substitution rate in between.
- **`identify`** takes TXT, DOCX, or PDF and grades any match:
  - `confirmed` — the full token was cryptographically re-verified against the
    registry row's identity (Ed25519 signature or HMAC recompute);
  - `corroborated` — a 12-byte short registry pointer recomputed from the row
    identity (64-bit; corroborating evidence, not a standalone claim);
  - `unrecognized` — a mark was recovered but no registry row resolves it.

  Tokens are re-derived from the row identity rather than trusting the lookup,
  so a corrupted or misfiled row cannot mis-attribute. `--record` appends an
  investigation event to the hash-chained ledger.
- **`report`** produces the evidence report (Markdown or JSON): identity,
  original and protected SHA-256 hashes, embedded channels, issue-time survival
  tests, investigation history, ledger integrity (chain head, Merkle root), and
  any recorded external anchors, framed for authentication under FRE 901(b)(9).
- **`anchor`** timestamps the ledger's Merkle root. `--local` signs it with the
  vault key (instant, offline, self-asserted time); `--opentimestamps` submits it
  to the OpenTimestamps Bitcoin calendars (third-party time, needs network, proof
  starts **pending**). `--list` shows the anchors on record. See ["Proving
  priority"](#proving-priority-anchoring).

### Local web UI

`npm run ui` starts a zero-dependency server bound to `127.0.0.1` only; a
random URL token minted at startup is required on every request. Drag-and-drop
protect and identify, the copies table, and evidence reports. Nothing ever
leaves the machine. It is single-user by design — see the UI threat model in
[`SECURITY.md`](SECURITY.md) before doing anything clever with it (in
particular: do not port-forward it).

## Roadmap

- **Slice 2 (done)** — DOCX extract-mark-reinject across all text-bearing parts,
  PDF *detection* via text extraction, and PDF *marking* within the extractor
  envelope by rebuilding the text layer (`src/formats/`, `npm run docx-demo`).
  Remaining, and genuinely hard: general *in-place* PDF marking for arbitrary
  fonts and layout, the glyph-layout problem above — the rebuild is a text-layer
  artifact, not a faithful copy.
- **Slice 3 (done)** — encrypted, tamper-evident, anchored `SecureRegistry`
  (`src/ledger/`, `npm run ledger-demo`), now with an external anchor:
  OpenTimestamps (Bitcoin calendars) behind the `Anchor`/`AsyncAnchor` interface
  (`npm run anchor-demo`). Remaining: Rekor and RFC 3161 anchors, which slot into
  the same `AsyncAnchor` contract, and a SQLite backend once the dependency
  constraints allow.
- **Slice 4 (done)** — the product surface: a passphrase-sealed workspace
  vault (`src/workspace.ts`), the CLI (`npm run cli`), and the local web UI
  (`npm run ui`). One passphrase seals the org key and the registry;
  protect/identify/report behave identically in both surfaces.
- **Packaging (done)** — `npm run build` compiles to plain-ESM `dist/`, the
  `mattermark` bin runs under plain `node` (no `tsx` at runtime), and `prepack`
  ships a fresh `dist/`, so `npx mattermark` works once published. See
  ["Install"](#install).
- **Research** — linguistic layer for Tier-4 resistance. Note the
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
