# Portable evidence and preflight

Mattermark 0.2 adds two operator-facing capabilities:

1. **Preflight analysis** before issuing a marked copy.
2. **Portable signed evidence bundles** that can be verified without the original vault.

## Recommended workflow

```bash
# Analyze the source without writing a copy or changing the ledger.
mattermark preflight brief.docx

# Issue the recipient-specific copy.
mattermark protect brief.docx \
  --matter M-2026-014 \
  --recipient jane.doe@example.com \
  --out brief--jane.docx

# Publish or exchange this fingerprint through a trusted channel.
mattermark key

# Export a signed bundle, optionally binding a recovered artifact.
mattermark export <short-id> \
  --artifact recovered.pdf \
  --out recovered.mattermark.json

# Verify on another machine. No Mattermark vault or passphrase is required.
mattermark verify recovered.mattermark.json \
  --artifact recovered.pdf \
  --expect-key sha256:<fingerprint>
```

## Preflight profiles

`preflight` measures the actual document rather than applying a flat file-size rule.

- **Durable** uses whitespace, zero-width, and homoglyph channels. It is intended to survive ordinary handling and platform normalization, but homoglyph substitutions can affect exact-match search, spellcheck, and e-discovery keyword indexing.
- **Search-safe** avoids homoglyphs. It preserves exact visible-text search behavior but is deliberately classified as non-durable because routine sanitization can remove its remaining channels.

The analyzer reports channel capacity, transform-chain survival, and recovery across multiple sliding excerpt windows at 10%, 20%, 33%, and 50% of the document. It never appends a ledger event or writes a marked artifact.

PDF marking remains opt-in because Mattermark's direct PDF route rebuilds the text layer and discards original layout, fonts, and images. Prefer marking the editable source and exporting that marked source to PDF.

## What an evidence bundle contains

A `.mattermark.json` bundle contains:

- a DSSE-style signed envelope;
- an in-toto-shaped Statement bound to the protected artifact SHA-256;
- the protected-copy evidence row;
- the original copy-issuance ledger event;
- a compact Merkle inclusion proof against the current ledger root;
- copy-specific inclusion proofs against eligible historical anchor roots;
- the raw Ed25519 public verification key and its SHA-256 fingerprint;
- an optional observation of a recovered artifact.

The bundle is transparent JSON so counsel, investigators, auditors, and independent tools can inspect it.

## Trust levels

Mattermark reports separate checks instead of collapsing everything into one vague verdict.

- **Self-contained:** the signature and internal evidence relationships verify against the key embedded in the bundle.
- **Key-pinned:** the same checks pass and the verifier was given the expected `sha256:<fingerprint>` through `--expect-key`.
- **External anchor status:** reported separately from the identity trust grade. A Bitcoin block-height attestation does not upgrade `key-pinned` until the commitment is checked against a trusted block header.

An embedded key is not proof of organizational identity. The fingerprint must be exchanged or published through a trusted channel.

## OpenTimestamps wording

A pending calendar promise is not a Bitcoin timestamp. An upgraded `.ots` proof may contain a Bitcoin block-height attestation, but Mattermark does not call that independently confirmed until the commitment is checked against a trusted Bitcoin block header. This final check is available programmatically through `confirmProofAgainstBitcoin`.

## HMAC workspaces

HMAC watermark tokens are not publicly self-verifying because verification requires the private organization key. A pinned evidence-bundle signature still authenticates the organization's signed mapping between the recovered token and its protected-copy record, but the verifier reports this boundary explicitly.

## Privacy

Evidence bundles include recipient, matter, issuance, delivery, and investigation metadata. Treat them as sensitive evidence. Do not publish them merely to prove that Mattermark is installed or configured.
