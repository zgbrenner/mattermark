# Security model

Read this before deploying Mattermark against anything that matters.

## What the cryptography guarantees

Tokens are minted with HMAC-SHA256 (128-bit truncated tag) or Ed25519
(approximately 128-bit security). An adversary cannot forge a token that
resolves to a different recipient without the organization key. Attribution,
when a token is recovered and verified, is sound.

`SHORT_ID` is weaker by design: 64-bit forgery resistance and no
self-verification. It resolves only against the registry and is intended to be
issued alongside a full-strength frame in another channel. Do not deploy a
configuration that carries SHORT_ID alone.

## What the steganography does not guarantee

**This is not a covert channel against a motivated adversary.** Measured
survival in this repository:

| Adversary capability | Result |
|---|---|
| Benign handling, copy/paste, reflow, smart quotes | survives |
| Platform sanitization, NFKC, whitespace collapse, format-character strip | survives through HG only |
| Targeted zero-width removal, confusable folding, non-ASCII strip | total symbolic loss |
| LLM paraphrase | assume loss until the Slice-4 benchmark measures otherwise |

Anyone who suspects a document is marked and runs generic normalization can
defeat the symbolic channels. The linguistic research track may improve
paraphrase resistance, but it is not implemented in the production codec stack
and must not be described as a Tier-4 guarantee.

See [`docs/research/tier4-linguistic-layer.md`](docs/research/tier4-linguistic-layer.md).

## This repository is public

The exact codepoint alphabets are in `src/codecs/`. A recipient can inspect and
strip them. The source paper assumes an adversary who knows method families but
not necessarily every parameter. A public implementation with hardcoded
alphabets does not fully satisfy that assumption.

Key-derived alphabets could reduce parameter disclosure, but blanket transforms
such as confusable folding and non-ASCII stripping do not depend on knowing the
alphabet. Treat open implementation as a known limitation.

## Registry and anchoring

Registry files are evidence. They contain recipient identities, matter
references, and token material. `.gitignore` excludes them.

Use `SecureRegistry` in `src/ledger/` rather than the plaintext prototype in
`src/registry.ts`. The durable store is encrypted with AES-256-GCM under a
scrypt-derived key and is append-only through a hash chain. Investigation
history must be appended as events, not edited into existing rows.

### Local attestation

`localAttestationAnchor` signs the Merkle root and claimed time with the
organization's Ed25519 key. It is non-repudiable as to the organization, but the
time is self-asserted. It does not prove priority to a skeptical third party.

### OpenTimestamps

`openTimestampsCliAnchor` uses the official `ots` CLI to create and verify a
detached proof. Operational requirements:

- Treat a newly stamped proof as pending and unverified.
- Preserve the entire versioned `AnchorCheckpoint`, including its event count,
  chain head, Merkle root, and base64 `.ots` bytes.
- Call `refresh()` later to upgrade calendar attestations.
- Treat time as independently attested only when `inspect()` returns
  `status: 'verified'` and a Bitcoin block height.
- Do not treat `AnchorProof.at` as trusted time. It remains the local request
  time. The verified `attestedAt` field is the external attestation.
- Use `verifyAnchorCheckpoint()` for historical evidence. It recomputes the
  recorded prefix even after later events move the registry's current root. A
  checkpoint never anchors events appended after its `eventCount`.
- Expect calendar and Bitcoin verification to require network access unless the
  operator supplies local verification infrastructure.

The adapter verifies that the canonical statement still binds the proof's root
and request time before invoking the CLI. A changed digest, time, proof format,
or malformed detached proof fails locally.

Rekor v1 is not used as the priority anchor because its integrated time is not
an independently verifiable trusted timestamp. A future Rekor v2 adapter should
validate the separate timestamp-authority material and discover active public
instances rather than hardcoding an endpoint.

## PDF marking cautions

PDF marking is deliberately fail-closed and supports only a conservative subset.
It appends an invisible Type 3 text carrier rather than editing existing glyph
operators or embedded fonts.

Within the supported envelope, the original file is an exact byte prefix and the
ordinary visible text layer is unchanged. That does not make the carrier
indestructible.

The PDF carrier can be removed by:

- printing or rasterization;
- flattening or PDF optimization;
- OCR replacement;
- removal of invisible text, unused fonts, or incremental revisions;
- deliberate deletion of `/MattermarkCarrier` objects;
- reconstruction of pages into a new PDF.

The implementation rejects encryption, xref streams, hybrid-reference files,
object streams, signed or certified documents, inherited page resources,
unsupported page resource/content shapes, image-only files, and already marked
files. Do not bypass those checks by rewriting the parser to
“best effort” an unknown PDF. Use a full PDF engine and independent render
comparison before broadening the envelope.

The hidden carrier can be exposed by generic text extraction, copy/paste, or
assistive technology. It is passive, but it is not invisible to forensic
inspection. Do not mark an already signed or certified PDF: any incremental
change can invalidate signature or certification evidence, so Mattermark rejects
those files.

## Homoglyph marking cautions

HG replaces Latin letters with Cyrillic confusables. In ordinary text and DOCX,
this can break exact-match search, spellcheck, and e-discovery indexing while
looking identical on screen. For litigation work product, that may be
disqualifying.

`mark()` returns a warning whenever HG is active. `maxHomoglyphDensity` caps the
substitution rate. `allowNonDurable` permits a search-preserving `WS + ZW` mark
that keeps visible letters intact but dies to routine sanitization.

PDF marking keeps the ordinary page glyphs untouched because HG is applied only
to the separate hidden carrier. The carrier itself may still appear in extracted
text and may be removed by sanitization.

## Operational cautions

- **Protect organization keys and passphrases.** A stolen HMAC key enables token
  forgery. A stolen registry passphrase exposes recipient and matter metadata.
- **Back up anchor checkpoints separately.** Losing the versioned checkpoint or
  detached OpenTimestamps proof loses the external priority evidence even if the
  ledger remains intact.
- **Record tool versions.** For evidentiary use, retain Mattermark version,
  runtime version, marking options, hashes, and verification output.
- **Do not mutate evidence.** Work from forensic copies and retain the original
  recovered artifact before running extraction or normalization.
- **Active canaries are not implemented and should not be added casually.** A
  callback in a document sent to a third party raises professional-responsibility
  questions. `activeCanary.disclosedToRecipient` forces the disclosure decision;
  it does not replace an ethics opinion.
- **Dual use.** A covert document-marking tool can also be used as a covert
  tracking tool. The MIT license does not restrict downstream use.

## Reporting

Open a private security advisory through the repository's Security tab rather
than a public issue.
