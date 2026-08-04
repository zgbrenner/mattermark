# Mattermark

[![CI](https://github.com/zgbrenner/mattermark/actions/workflows/ci.yml/badge.svg)](https://github.com/zgbrenner/mattermark/actions/workflows/ci.yml)

**Local-first recipient attribution, durability preflight, and portable signed evidence for sensitive documents.**

Mattermark creates a distinct marked copy for each recipient, records the issuance in an encrypted append-only ledger, identifies which copy later surfaced, and exports a signed evidence bundle that another person can verify without your vault.

It runs on-device, has zero runtime dependencies, and supports Node.js 20 or newer.

## What is new in 0.2

- **Preflight before issuance.** Compare durable and search-safe profiles using the actual document, including channel capacity, transform survival, and sliding-window excerpt recovery.
- **Portable evidence bundles.** Export a transparent signed JSON bundle with the protected-copy record, original issuance event, artifact digest, Merkle inclusion proof, key fingerprint, and eligible historical anchors.
- **Vault-free verification.** Verify a bundle and recovered artifact on another machine without the Mattermark passphrase or vault.
- **Explicit key pinning.** An embedded public key proves internal consistency, not organizational identity. `--expect-key` makes that distinction operational.
- **Copy-specific ledger proofs.** A bundle proves that the issuance event belongs to a stated ledger root without disclosing the rest of the private ledger.
- **Truthful OpenTimestamps language.** A pending calendar promise is not a timestamp, and a Bitcoin block-height attestation is not called independently confirmed until checked against a trusted block header.

## Install

```bash
npx mattermark --help
# or
npm install -g mattermark
mattermark --help
```

From a source checkout:

```bash
npm install
npm run cli -- help
```

## End-to-end workflow

```bash
# 1. Create a sealed local vault.
mattermark init --org "Devlin & Cole LLP"

# 2. Measure the actual document before issuing a copy.
mattermark preflight brief.docx

# 3. Create one marked copy for one recipient.
mattermark protect brief.docx \
  --matter M-2026-014 \
  --recipient jane.doe@example.com \
  --delivery email \
  --out brief--jane.docx

# 4. A document later surfaces somewhere it should not.
mattermark identify recovered.pdf \
  --record \
  --by g.devlin \
  --source "posted to a forum"

# 5. Display the evidence-key fingerprint. Exchange or publish this through a trusted channel.
mattermark key

# 6. Export a portable signed bundle, optionally binding the recovered artifact.
mattermark export <short-id> \
  --artifact recovered.pdf \
  --out recovered.mattermark.json

# 7. Verify elsewhere. No vault or passphrase is needed.
mattermark verify recovered.mattermark.json \
  --artifact recovered.pdf \
  --expect-key sha256:<fingerprint>
```

The point-and-click local interface remains available through:

```bash
mattermark ui
```

It binds to localhost and should never be exposed through a tunnel or reverse proxy.

## Commands

| Command | Purpose |
| --- | --- |
| `init` | Create a passphrase-sealed workspace vault |
| `preflight` | Compare marking profiles without writing a copy or changing the ledger |
| `protect` | Create and record one recipient-specific copy |
| `identify` | Recover marks and resolve them against the vault |
| `list` | Show protected copies, optionally filtered by matter |
| `report` | Produce a human-readable evidence report from the live vault |
| `key` | Display the evidence signing-key fingerprint |
| `export` | Create a portable signed evidence bundle |
| `verify` | Verify a bundle and optional artifact without a vault |
| `anchor` | Commit the ledger root locally or through OpenTimestamps |
| `status` | Verify the vault ledger and show its current root |
| `ui` | Start the local point-and-click interface |

Use `mattermark help <command>` for command-specific options.

## Preflight profiles

### Durable

Uses three independent symbolic channels:

- whitespace structure (`WS`)
- zero-width format characters (`ZW`)
- visually similar Unicode substitutions (`HG`)

The homoglyph channel is the only included symbolic channel expected to survive routine Unicode and format-character sanitization. It can also interfere with exact-match search, spellcheck, and some e-discovery keyword indexing. Mattermark surfaces this cost rather than hiding it.

### Search-safe

Uses `WS + ZW` only. Visible letters stay unchanged, which protects exact search behavior, but routine sanitization can destroy the mark. Mattermark labels this profile **non-durable**.

### What preflight measures

For each available profile, Mattermark reports:

- which channels fit and how many frame repetitions were embedded;
- whether the result is durable under the project’s stated transform model;
- survival through benign handling, platform normalization, and targeted stripping simulations;
- recovery across multiple contiguous windows at 10%, 20%, 33%, and 50% of the document;
- every issuance warning and a plain-language recommendation.

Preflight mints temporary in-memory tokens solely to measure real capacity. It does not append a ledger event or write a marked artifact.

## Attribution confidence

- **Confirmed:** a recovered full token cryptographically re-verifies against the protected-copy identity.
- **Corroborated:** a shorter registry pointer resolves and recomputes correctly, but is supporting evidence rather than standalone proof.
- **Unrecognized:** a mark was recovered but does not belong to the open vault.

A match identifies which copy surfaced. It does not prove who personally disclosed it. Forwarding, a compromised device, shared access, and later custody can all produce the same result.

Absence of a mark proves nothing. A stripped mark is indistinguishable from a document that was never marked.

## Portable evidence

A `.mattermark.json` bundle contains:

- a DSSE-style signed envelope over exact payload bytes;
- an in-toto-shaped Statement bound to the protected artifact SHA-256;
- the protected-copy record and original copy-issuance event;
- a compact copy-specific Merkle inclusion proof;
- eligible historical anchor paths;
- the raw Ed25519 verification key and SHA-256 fingerprint;
- an optional observation of a recovered artifact.

Verification produces separate checks for the signature, statement shape, subject digest, event hash, Merkle path, key pin, anchors, and supplied artifact. It does not collapse these different claims into a misleading single cryptographic slogan.

Read [Portable evidence and preflight](docs/PORTABLE-EVIDENCE.md) for the detailed trust model.

### Key identity

The key embedded in a bundle proves that one key signed that bundle. It does not prove which organization controls the key. Use `mattermark key`, then exchange or publish the fingerprint through a channel the verifier already trusts.

### HMAC workspaces

HMAC watermark tokens require the private organization key to verify. A pinned evidence-bundle signature can still authenticate the organization’s signed mapping between a token and its protected-copy record, but the token itself is not publicly self-verifying. Mattermark reports that limitation.

### Privacy

Bundles include recipient, matter, issuance, delivery, and potentially investigation metadata. Treat them as sensitive evidence. Do not publish them merely to prove that Mattermark is installed.

## Ledger and anchoring

The encrypted registry is append-only and hash-chained. Editing or reordering a historical event breaks verification. Its Merkle root compactly commits to the full event sequence.

- `anchor --local` signs the root with the workspace key. The signature is real, but the time is self-asserted.
- `anchor --opentimestamps` submits the root to public calendars. A fresh result is pending. An upgraded proof can carry a Bitcoin attestation, but independent confirmation still requires checking its commitment against a trusted Bitcoin block header.

The public library exports `confirmProofAgainstBitcoin` for that final caller-supplied check.

## Document formats

- **TXT and other UTF-8 text:** marked directly.
- **DOCX:** marks text-bearing XML parts while preserving the package structure.
- **PDF identification:** reads marks from an accessible text layer.
- **Direct PDF marking:** blocked by default. `--rebuild-pdf` creates a normalized text-layer PDF, discarding original layout, fonts, images, and positioning. It is intentionally non-durable. Mark the source document whenever possible.

## Threat model

Mattermark is designed for routine handling, accidental redistribution, and later attribution. It is not an unstrippable covert channel.

| Handling or adversary | Expected result |
| --- | --- |
| Copy-paste, line reflow, quote changes | generally survives |
| Routine Unicode and format sanitization | survives only when a durable channel remains |
| Zero-width removal plus confusable folding plus non-ASCII stripping | total symbolic-channel loss |
| Full rewrite, retyping, or LLM paraphrase | assume total loss |

The alphabets and algorithms are public. A recipient who suspects marking can remove the included symbolic channels with generic normalization. Read [SECURITY.md](SECURITY.md) before using Mattermark with real matters.

## Library API

```ts
import {
  initWorkspace,
  openWorkspace,
  preflightWorkspaceDocument,
  exportWorkspaceEvidence,
  verifyEvidenceBundle,
  verifyEvidenceArtifact,
  createMerkleProof,
  verifyMerkleProof,
} from 'mattermark';
```

No CLI module is imported through the library entry point.

## Development and release verification

```bash
npm ci
npm test
npm run build
npm run demo
npm run matrix
npm run docx-demo
npm run ledger-demo
npm run anchor-demo
npm pack --dry-run

# Run the complete release gate:
npm run verify-release
```

The CI matrix covers Node.js 20, 22, and 24. The test suite exercises framing, codecs, document formats, attribution, encrypted ledger replay, tamper detection, Merkle proofs, evidence-envelope verification, preflight analysis, CLI behavior, the local UI, and the compiled package.

## Research and design lineage

Mattermark’s symbolic marking architecture is based on the Mode A framing in Raz et al., *Safeguarding LLMs Against Misuse and AI-Driven Malware Using Steganographic Canaries* (2026).

The portable evidence format adopts narrow, local-first patterns from DSSE, in-toto Statements, Sigstore bundles, and OpenTimestamps. Mattermark does not depend on their hosted identity or transparency services, and does not claim their broader trust guarantees.

## License

MIT. See [NOTICE.md](NOTICE.md) for research and standards acknowledgments.
