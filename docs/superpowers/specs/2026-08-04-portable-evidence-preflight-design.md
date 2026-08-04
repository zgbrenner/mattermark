# Portable Evidence and Preflight Design

**Date:** 2026-08-04

## Purpose

Mattermark already creates recipient-specific marked copies, records them in an encrypted append-only ledger, attributes recovered documents, and can anchor ledger roots. The next release closes two product gaps:

1. A third party cannot verify an exported Markdown report without trusting the live Mattermark vault that produced it.
2. An operator learns the practical durability and search cost of a mark only after issuing the copy.

This design adds portable evidence bundles that verify offline, plus a no-write preflight analyzer that shows the expected trade-offs before issuance. It also fixes an OpenTimestamps wording bug that currently describes the presence of a Bitcoin attestation as confirmation without checking a trusted block header.

## Constraints

- Keep Node.js 20 as the minimum supported runtime.
- Keep zero runtime dependencies. Use only Node built-ins and existing project modules.
- Preserve existing workspace version 1 and open existing vaults without migration.
- Preserve the existing TXT, DOCX, and PDF behavior.
- Do not weaken the existing composition guard or survival-test disclosures.
- Never describe an OpenTimestamps proof as Bitcoin-confirmed unless it has been checked against a caller-supplied trusted block-header source.
- Keep all new commands local-first and network-free. Existing explicit anchoring remains the only networked operation.
- Make JSON output stable enough for scripts while keeping the default CLI output understandable to non-specialists.

## Approaches considered

### A. Error-correction-first release

Add Reed-Solomon or BCH coding to every watermark frame. This could improve recovery after partial symbol corruption, but it increases frame size and therefore reduces repetition and excerpt resilience. It also requires a new frame version, careful backward-compatible decoding, and a larger empirical corpus before the defaults could be trusted. It remains a strong future direction, not the safest immediate release.

### B. Batch-issuance-first release

Add CSV import, recipient fan-out, output folders, and manifests. This would improve daily throughput, but it would not close the evidentiary trust gap. It also raises atomicity and rollback questions because a failed batch must not leave ledger rows for artifacts that were never written or delivered.

### C. Portable-evidence-first release, recommended

Add standards-shaped signed evidence bundles, copy-specific Merkle inclusion proofs, key pinning, offline artifact rechecking, and preflight analysis. This improves both the legal defensibility and the everyday operator experience without changing the marking algorithm or vault format. It also creates a stable foundation for later batch issuance because every generated copy can receive a portable receipt.

## Standards and open-source patterns adopted

The bundle uses a narrow subset of three established patterns:

- **DSSE-style envelope:** sign the payload type and exact payload bytes through pre-authentication encoding, avoiding JSON canonicalization as a security dependency.
- **in-toto Statement shape:** bind claims to one immutable subject digest and identify the claim schema with a predicate URI.
- **Sigstore-style bundle principle:** place the signature, public verification material, statement, ledger proof, and optional artifact observation in one inspectable JSON file so verification is possible offline.

Mattermark does not adopt Sigstore identity, Fulcio, Rekor, TUF, or a public service. The workspace keeps its existing deterministic Ed25519 key. A self-contained public key proves internal consistency only. Real organizational identity comes from pinning or publishing the displayed key fingerprint through a trusted channel.

## Evidence bundle format

The file is transparent JSON, conventionally named `<token-prefix>.mattermark.json`.

Top-level shape:

```ts
interface MattermarkEvidenceBundle {
  mediaType: 'application/vnd.mattermark.evidence-bundle.v1+json';
  verificationMaterial: {
    publicKey: {
      algorithm: 'ed25519';
      raw: string;      // base64, 32 bytes
      keyid: string;    // sha256:<lowercase hex of raw key>
    };
  };
  envelope: {
    payloadType: 'application/vnd.in-toto+json';
    payload: string;    // base64 encoded UTF-8 Statement JSON
    signatures: Array<{ keyid: string; sig: string }>;
  };
}
```

The envelope signs DSSE pre-authentication encoding:

```text
DSSEv1 <type-byte-length> <type> <payload-byte-length> <payload>
```

The payload is an in-toto v1 Statement:

```ts
interface MattermarkEvidenceStatement {
  _type: 'https://in-toto.io/Statement/v1';
  subject: [{ name: string; digest: { sha256: string } }];
  predicateType: 'https://mattermark.dev/attestations/evidence/v1';
  predicate: MattermarkEvidencePredicate;
}
```

The subject is the protected artifact recorded at issuance. Its digest must equal `copy.protectedHash`.

The predicate contains:

- bundle schema version and generation time;
- workspace organization name and token scheme;
- the complete `ProtectedCopy` record;
- the copy-issuance ledger event;
- an inclusion proof for that event in the current ledger root;
- inclusion proofs against every stored anchor root whose event count includes the copy and whose stored root exactly matches the recomputed historical prefix root;
- an optional recovered-artifact observation;
- explicit trust-boundary disclosures.

The bundle includes recipient and matter data. CLI output must warn that an evidence bundle is sensitive and should not be published casually.

## Copy-specific Merkle proofs

The current ledger exposes only a root. The release adds a proof object:

```ts
interface MerkleInclusionProof {
  leafIndex: number;
  treeSize: number;
  leafHash: string;
  root: string;
  path: Array<{ side: 'left' | 'right'; hash: string }>;
}
```

The proof algorithm must reproduce the repository's existing Merkle rule exactly, including duplicating the final node on an odd level. Verification starts with `leafHash`, combines every path node in its recorded order, and requires the computed hash to equal `root`.

`SecureRegistry.proveCopy(tokenHex, eventCount?)` resolves a full token or short ID, finds the original copy event, limits the tree to `eventCount` when proving against an older anchor, and returns the chained event plus inclusion proof. It refuses event counts outside `1..currentEventCount` and refuses an anchor prefix that predates the copy event.

The verifier separately recomputes the chained event hash from `prevHash` and the event core. This proves that the exported copy event is the leaf included in the stated root. It does not claim to reveal or independently replay the rest of the private ledger.

## Evidence signing and key identity

Every workspace derives its existing Ed25519 key from the sealed organization key. The evidence signer reuses that key rather than creating a second untracked secret.

`Workspace.evidenceKey()` returns:

```ts
interface EvidenceKeyInfo {
  algorithm: 'ed25519';
  publicKeyRaw: string;
  keyid: string;
}
```

The CLI command `mattermark key` displays the fingerprint and explains that organizations should publish or exchange it through a trusted channel. `--json` emits only structured data.

The verifier supports `--expect-key sha256:<hex>`. Verification without this option can prove that the bundle is internally consistent and signed by the embedded key, but not who controls that key. Verification with a matching expected fingerprint is key-pinned. A mismatch is a hard failure.

## Optional recovered-artifact observation

`mattermark export <token> --artifact <file>` runs the existing detector without recording a new investigation event. The command refuses to export an observation unless the best attribution resolves to the requested protected copy.

The observation stores:

- artifact name, format, and SHA-256;
- recovered token, confidence, channels, and frame count;
- whether the copy token is publicly verifiable (`true` only for Ed25519);
- the detector version represented by the bundle schema.

During `mattermark verify <bundle> --artifact <file>`, the verifier hashes the supplied file, reruns the public detector, and requires the recovered token to match the statement's copy. This check needs no vault or secret. For an HMAC workspace, the bundle signature and a pinned evidence key authenticate the organization’s mapping; the HMAC token itself is not publicly verifiable and the result must say so.

## Verification result and trust grades

Verification returns structured checks rather than one ambiguous boolean:

```ts
interface EvidenceVerificationResult {
  valid: boolean;
  trust: 'invalid' | 'self-contained' | 'key-pinned' | 'key-pinned-and-externally-anchored';
  keyid: string;
  keyPinned?: boolean;
  signatureValid: boolean;
  statementValid: boolean;
  subjectValid: boolean;
  currentLedgerProofValid: boolean;
  anchorResults: Array<{
    anchor: string;
    inclusionValid: boolean;
    proofStatus: 'local-valid' | 'ots-pending' | 'ots-bitcoin-attestation-unconfirmed' | 'invalid' | 'unsupported';
  }>;
  artifact?: {
    supplied: boolean;
    digestMatches: boolean;
    markMatches: boolean;
  };
  errors: string[];
  warnings: string[];
}
```

Trust rules:

- `invalid`: any required structural, signature, subject, or current-inclusion check fails.
- `self-contained`: all required checks pass using the public key embedded in the bundle, but no expected key was supplied.
- `key-pinned`: all required checks pass and `--expect-key` matches.
- `key-pinned-and-externally-anchored`: key-pinned plus at least one valid copy inclusion proof against a structurally valid OpenTimestamps proof containing a Bitcoin attestation. The wording must still say that the Bitcoin attestation is **not independently confirmed** until checked against a trusted block header. This trust grade means the bundle carries an external anchor path, not that Mattermark performed full Bitcoin consensus verification.

A pending calendar promise never upgrades the trust grade.

## Preflight analyzer

`mattermark preflight <file>` analyzes the file without writing an output artifact and without appending a registry event. It evaluates two profiles:

1. `durable`: WS + ZW + HG, using the requested homoglyph-density cap.
2. `search-safe`: WS + ZW only, explicitly non-durable.

For each profile it reports:

- whether the format can be marked under the selected PDF policy;
- per-channel capacity, payload type, and repetitions;
- durable or non-durable classification;
- exact-search impact;
- transform-chain survival;
- sliding-window excerpt recovery at 10%, 20%, 33%, and 50% of the text;
- a concise recommendation and every warning that issuance would surface.

Sliding-window tests sample up to seven evenly spaced contiguous windows per fraction, including the start and end. They report both the pass rate and whether every sampled window recovered. This replaces the false comfort of testing only a centered excerpt.

PDF behavior remains honest. A normal PDF preflight reports that direct marking is blocked and recommends marking the source document. `--rebuild-pdf` analyzes the existing normalized text-layer path and labels it non-durable and layout-destructive.

The analyzer may create a temporary in-memory identity to obtain correctly sized tokens, but it must never call `registry.add`, write a protected artifact, or mutate the vault.

## CLI surface

New commands:

```text
mattermark preflight <file> [--rebuild-pdf] [--homoglyph-density <0..1>] [--json]
mattermark key [--json]
mattermark export <token> --out <file> [--artifact <file>] [--json]
mattermark verify <bundle> [--artifact <file>] [--expect-key <sha256:...>] [--json]
```

`verify` does not require `--vault` or `MATTERMARK_PASSPHRASE`. The other three commands open a workspace.

Existing `report` remains the human-readable Markdown report. `export` produces the portable signed evidence bundle.

Exit codes follow the existing convention:

- `0`: operation or verification succeeded;
- `1`: operational failure or invalid evidence;
- `2`: usage error.

## OpenTimestamps correctness fix

`openTimestampsAnchor.describe()` currently says a proof is “confirmed in Bitcoin block …” when the proof merely contains a Bitcoin block-height attestation. The fix changes that text to “contains a Bitcoin attestation for block …; verify against a trusted block header before calling it confirmed.”

The serialized compatibility field currently named `confirmed` is retained for backward compatibility but no new user-facing code may treat it as independent confirmation. A new `bitcoinAttestation` boolean is emitted on upgrade.

## Backward compatibility

- Workspace version remains 1.
- Existing registry events and anchor files remain readable.
- `ProtectedCopy.sourceName` and `ProtectedCopy.protectedName` are optional. New copies populate them; old copies fall back to token-based bundle subject names.
- Existing CLI commands and library exports continue to work.
- No frame or token format changes occur in this release.

## Testing

The release adds tests for:

- Merkle proof generation and every leaf position in even and odd trees;
- tampered leaf, path, root, index, and tree-size rejection;
- DSSE payload-type binding and signature tamper rejection;
- key fingerprint pinning and mismatch failure;
- subject digest, copy event, and anchor-prefix binding;
- evidence export and offline verification with and without a recovered artifact;
- HMAC trust-boundary wording;
- preflight’s no-write guarantee;
- sliding-window excerpt coverage;
- blocked PDF and opt-in rebuilt PDF behavior;
- CLI human and JSON modes;
- corrected OpenTimestamps wording.

The full existing test suite, build, package test, demos, and corpus matrix must pass on Node 20, 22, and 24 before merge.

## Deferred follow-on work

The following remain valuable but are deliberately outside this release:

- Reed-Solomon or BCH frame version 2, after capacity and corruption measurements;
- transactional CSV batch issuance with staging and rollback;
- encrypted, tested vault backup and passphrase rotation;
- Word/Outlook integration;
- model-backed semantic watermarking and honest T12 paraphrase testing;
- RFC 3161 or Rekor anchors;
- external Bitcoin-header providers or bundled light-client verification.
