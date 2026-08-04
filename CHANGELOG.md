# Changelog

## 0.2.0 - 2026-08-04

### Added

- No-write preflight analysis for durable and search-safe marking profiles.
- Sliding-window excerpt recovery measurements at 10%, 20%, 33%, and 50%.
- Portable signed evidence bundles using DSSE-style pre-authentication encoding and an in-toto-shaped Statement.
- Copy-specific Merkle inclusion proofs for current and anchored historical ledger roots.
- Offline bundle verification without a Mattermark vault or passphrase.
- Explicit evidence-key fingerprints and optional key pinning.
- Optional recovered-artifact hashing and mark rechecking.
- Public library APIs for evidence bundles, artifact checks, preflight, and Merkle proofs.
- Release verification script covering tests, builds, corpus measurements, demos, and package inspection.

### Correctness and security

- OpenTimestamps calendar promises are explicitly labeled pending.
- Bitcoin block-height attestations are no longer described as independently confirmed without trusted block-header verification.
- Embedded evidence keys are explicitly distinguished from organizational identity.
- HMAC watermark tokens disclose that they are not publicly self-verifying.
- Evidence bundles disclose sensitive matter and recipient metadata.
- Historical anchors that predate a copy are omitted with an explicit explanation.
- Investigation history is labeled as a signed export-time snapshot rather than a separately proven event set.
- Evidence export does not append investigation events or alter the registry.

### Compatibility

- Workspace format remains version 1.
- Existing vaults and registry events remain readable.
- Existing watermark frame and token formats are unchanged.
- Existing TXT, DOCX, PDF identification, CLI, local UI, and library behavior remains available.
- Node.js 20, 22, and 24 are covered by the verification matrix.
