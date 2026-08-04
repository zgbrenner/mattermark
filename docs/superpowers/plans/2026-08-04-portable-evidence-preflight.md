# Portable Evidence and Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add offline-verifiable signed evidence bundles, copy-specific ledger inclusion proofs, key pinning, a no-write preflight analyzer, and truthful OpenTimestamps status language.

**Architecture:** New focused modules own Merkle inclusion proofs, evidence envelopes, and preflight analysis. `SecureRegistry` exposes only the copy-event proof needed by the evidence layer. `Workspace` dispatches document formats and supplies the sealed organization key, while CLI commands remain thin wrappers. Existing vault, token, frame, and document formats stay unchanged.

**Tech Stack:** TypeScript 7, Node.js 20+ built-ins (`node:crypto`, `node:fs`), `node:test`, existing MarkItYours codecs and document adapters. No runtime dependencies.

## Global Constraints

- Keep Node.js 20 as the minimum runtime.
- Keep zero runtime dependencies.
- Preserve workspace version 1 and existing vault readability.
- Preserve existing CLI and library APIs.
- Never describe an OpenTimestamps proof as Bitcoin-confirmed without trusted block-header verification.
- Verification must bind the signature, statement subject digest, copy event, Merkle root, anchor digest, expected key fingerprint, and optional supplied artifact.
- Preflight must not write files or append ledger events.

---

## File map

**Create**

- `src/ledger/merkle-proof.ts`: generation and verification for the repository's existing duplicate-last Merkle tree.
- `src/evidence.ts`: DSSE-style envelope, in-toto-shaped statement, evidence signing, strict offline verification, key fingerprints.
- `src/preflight.ts`: profile analysis and sliding-window excerpt measurements over already-marked text.
- `test/merkle-proof.test.ts`: Merkle proof tests.
- `test/evidence.test.ts`: envelope, tamper, pinning, ledger, and artifact tests.
- `test/preflight.test.ts`: preflight behavior and no-write tests.

**Modify**

- `src/ledger/hashchain.ts`: export event/hash types already used by proof code.
- `src/ledger/index.ts`: expose `proveCopy` and historical prefix roots.
- `src/registry.ts`: add optional source/protected filenames for new evidence subjects.
- `src/workspace.ts`: populate names, expose evidence key/export and preflight operations.
- `src/cli.ts`: add `preflight`, `key`, `export`, and vault-free `verify` commands.
- `src/index.ts`: export the new public APIs.
- `src/ledger/opentimestamps.ts`: correct confirmation language and add `bitcoinAttestation` metadata.
- `test/opentimestamps.test.ts`, `test/workspace.test.ts`, `test/cli.test.ts`: integration and regression coverage.
- `package.json`: bump to `0.2.0` and add a release verification script.
- `README.md`, `SECURITY.md`, `NOTICE.md`: document portable proof, key trust, privacy, preflight, and corrected timestamp semantics.

---

### Task 1: Merkle inclusion proofs

**Files:**
- Create: `src/ledger/merkle-proof.ts`
- Create: `test/merkle-proof.test.ts`

**Interfaces:**
- Consumes: `sha256hex(data: string | Buffer): string` from `src/ledger/hashchain.ts`.
- Produces:

```ts
export interface MerkleProofStep {
  side: 'left' | 'right';
  hash: string;
}

export interface MerkleInclusionProof {
  leafIndex: number;
  treeSize: number;
  leafHash: string;
  root: string;
  path: MerkleProofStep[];
}

export function createMerkleProof(hashes: string[], leafIndex: number): MerkleInclusionProof;
export function verifyMerkleProof(proof: MerkleInclusionProof): boolean;
```

- [ ] **Step 1: Write failing tests for every leaf in even and odd trees**

```ts
for (const size of [1, 2, 3, 4, 5, 7, 8]) {
  test(`proofs verify for every leaf in a ${size}-leaf tree`, () => {
    const leaves = Array.from({ length: size }, (_, i) => sha256hex(`leaf-${i}`));
    for (let i = 0; i < leaves.length; i++) {
      const proof = createMerkleProof(leaves, i);
      assert.equal(proof.root, merkleRoot(leaves));
      assert.equal(verifyMerkleProof(proof), true);
    }
  });
}
```

Add separate rejection tests for a changed leaf, path hash, side, root, index, tree size, invalid hex, empty tree, and out-of-range index.

- [ ] **Step 2: Push the test-only commit and verify CI fails because the module is missing**

Expected failure: TypeScript cannot resolve `../src/ledger/merkle-proof.js`.

- [ ] **Step 3: Implement proof generation with the exact duplicate-last rule**

At each level, record the actual sibling. For an odd final node, the sibling is the node itself and `side` is `right`. Hash parents with `sha256hex(left + right)`, matching `merkleRoot`.

- [ ] **Step 4: Implement strict proof verification**

Reject malformed SHA-256 hex, non-integer or invalid indices, impossible path shapes, and any computed root mismatch. Recompute the expected number of levels from `treeSize` and require the supplied path length to match.

- [ ] **Step 5: Run targeted and full tests**

```bash
node --import tsx --test test/merkle-proof.test.ts
npm test
```

Expected: all tests pass.

---

### Task 2: Copy-event proofs from the sealed registry

**Files:**
- Modify: `src/ledger/index.ts`
- Modify: `test/ledger.test.ts`

**Interfaces:**
- Consumes: `createMerkleProof` and `MerkleInclusionProof` from Task 1.
- Produces:

```ts
export interface LedgerEventInclusion {
  event: ChainedEvent;
  proof: MerkleInclusionProof;
}

SecureRegistry.rootAt(eventCount: number): string;
SecureRegistry.proveCopy(tokenHex: string, eventCount?: number): LedgerEventInclusion;
```

- [ ] **Step 1: Write failing tests**

Tests must prove:

- a full token and short ID resolve to the same original copy event;
- a current proof verifies;
- a historical prefix proof root equals `rootAt(eventCount)`;
- an anchor prefix before the copy is rejected;
- event counts `0`, negative, fractional, and greater than current count are rejected;
- an unknown token is rejected;
- the event payload stores an empty investigation list even after later investigation events.

- [ ] **Step 2: Verify the test-only commit fails because `rootAt` and `proveCopy` do not exist**

- [ ] **Step 3: Implement `rootAt`**

Validate the count and call `merkleRoot(this.events.slice(0, eventCount).map(e => e.hash))`.

- [ ] **Step 4: Implement `proveCopy`**

Resolve short IDs to the full row, locate the original `copy` event by `payload.copy.tokenHex`, ensure its index is within the requested prefix, and build a proof over that prefix.

- [ ] **Step 5: Run ledger and full tests**

```bash
node --import tsx --test test/ledger.test.ts test/merkle-proof.test.ts
npm test
```

---

### Task 3: DSSE-style evidence envelope and strict verifier

**Files:**
- Create: `src/evidence.ts`
- Create: `test/evidence.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `stableStringify`, `eventHash`, `verifyMerkleProof`, `ProtectedCopy`, `StoredAnchor`, `AnchorProof`, `detect`, and public document extraction helpers.
- Produces:

```ts
export const EVIDENCE_MEDIA_TYPE = 'application/vnd.mattermark.evidence-bundle.v1+json';
export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const PREDICATE_TYPE = 'https://mattermark.dev/attestations/evidence/v1';
export const DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json';

export interface EvidenceKeyInfo {
  algorithm: 'ed25519';
  publicKeyRaw: string;
  keyid: string;
}

export function evidenceKeyInfo(publicKeyRaw: Buffer): EvidenceKeyInfo;
export function dssePAE(payloadType: string, payload: Buffer): Buffer;
export function signEvidenceStatement(statement: MattermarkEvidenceStatement, keyPair: EdKeyPair): MattermarkEvidenceBundle;
export function verifyEvidenceBundle(bundle: unknown, opts?: VerifyEvidenceOptions): EvidenceVerificationResult;
export function parseEvidenceBundle(text: string): MattermarkEvidenceBundle;
```

- [ ] **Step 1: Write failing unit tests for DSSE type binding**

Sign one payload, then prove that changing the payload bytes, payload type, signature, public key, key ID, statement type, predicate type, or subject digest fails verification.

- [ ] **Step 2: Write failing pinning tests**

A bundle verified without `expectedKeyid` must return `self-contained`. A matching expected key must return `key-pinned`; a mismatch must make `valid` false and include a specific error.

- [ ] **Step 3: Write failing ledger-binding tests**

Create a real `ChainedEvent` and inclusion proof. Verify the bundle passes, then independently tamper the event payload, `prevHash`, event hash, path, root, copy token, and protected hash. Each mutation must fail the corresponding structural check.

- [ ] **Step 4: Verify RED through CI**

Expected failure: evidence exports and verifier functions are missing.

- [ ] **Step 5: Implement exact-byte DSSE signing**

Serialize the Statement once with UTF-8 `stableStringify`, base64 that exact byte sequence, sign `dssePAE(payloadType, payload)`, and never parse/re-serialize before signature verification.

- [ ] **Step 6: Implement strict parsing and verification**

Validate every required literal and field type. Import the raw Ed25519 public key with the SPKI prefix `302a300506032b6570032100`. Require the key ID to equal `sha256:<hash of raw 32-byte key>`. Verify exactly one matching signature. Recompute the event hash and Merkle proof. Bind `subject[0].digest.sha256`, `predicate.copy.protectedHash`, and the copy event payload.

- [ ] **Step 7: Implement anchor classification without overclaiming**

For local anchors, verify the signature with the embedded Ed25519 key and return `local-valid`. For OpenTimestamps, parse and structurally summarize the detached proof. Return `ots-pending` when only calendar promises exist and `ots-bitcoin-attestation-unconfirmed` when block-height attestations exist. Never emit `confirmed`.

- [ ] **Step 8: Export public evidence APIs and run tests**

```bash
node --import tsx --test test/evidence.test.ts
npm test
npm run build
```

---

### Task 4: Workspace evidence key and export

**Files:**
- Modify: `src/registry.ts`
- Modify: `src/workspace.ts`
- Modify: `test/workspace.test.ts`

**Interfaces:**
- Consumes: Task 2 registry proofs and Task 3 evidence signing.
- Produces:

```ts
ProtectedCopy.sourceName?: string;
ProtectedCopy.protectedName?: string;

Workspace.evidenceKey(): EvidenceKeyInfo;
Workspace.exportEvidence(tokenHex: string, opts?: {
  artifact?: { name: string; bytes: Buffer };
}): MattermarkEvidenceBundle;
```

- [ ] **Step 1: Write failing workspace tests**

Tests must show:

- new copies record source and protected names;
- old-style rows with missing names still export;
- export contains a current copy inclusion proof;
- each eligible anchor carries a historical inclusion proof whose root matches the anchor digest;
- anchors predating the copy or carrying an inconsistent root are omitted and produce a disclosure warning;
- exporting with an artifact succeeds only when the best attribution resolves to the requested copy;
- artifact export does not append an investigation event;
- a different copy, unmarked artifact, or foreign-vault artifact is rejected;
- exported bundles verify without opening a vault.

- [ ] **Step 2: Verify RED through CI**

- [ ] **Step 3: Populate optional filenames in `protect`**

Set `sourceName: input.name` and `protectedName: suggestedName`. Compute the suggested name before constructing the registry row so both the returned outcome and stored evidence use the same value.

- [ ] **Step 4: Implement `evidenceKey`**

Derive the existing workspace Ed25519 key and return its raw public key and fingerprint. This works for both Ed25519 and HMAC token workspaces because it is the evidence-signing identity, not the watermark token scheme.

- [ ] **Step 5: Implement `exportEvidence`**

Resolve the copy, obtain current and eligible historical proofs, filter anchors by exact event count/root binding, optionally identify and bind the recovered artifact, construct the statement, and sign it. Do not mutate the ledger.

- [ ] **Step 6: Run workspace, evidence, and full tests**

```bash
node --import tsx --test test/workspace.test.ts test/evidence.test.ts
npm test
```

---

### Task 5: No-write preflight and sliding-window analysis

**Files:**
- Create: `src/preflight.ts`
- Create: `test/preflight.test.ts`
- Modify: `src/workspace.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces:

```ts
export interface ExcerptRecoveryResult {
  fraction: number;
  windows: number;
  recovered: number;
  rate: number;
  allWindowsRecover: boolean;
}

export interface PreflightProfile {
  profile: 'durable' | 'search-safe';
  markable: boolean;
  durable: boolean;
  exactSearchPreserved: boolean;
  layers: LayerReport[];
  transformTests: TransformTestResult[];
  survivalRate: number;
  excerpts: ExcerptRecoveryResult[];
  warnings: string[];
}

export interface PreflightOutcome {
  name: string;
  format: DocFormat;
  sourceBytes: number;
  sourceCharacters: number;
  profiles: PreflightProfile[];
  recommendation: string;
  blockedReason?: string;
}

Workspace.preflight(input: { name: string; bytes: Buffer }, opts?: {
  maxHomoglyphDensity?: number;
  rebuildPdf?: boolean;
}): PreflightOutcome;
```

- [ ] **Step 1: Write failing sliding-window tests**

Use a marked string where the centered 20% excerpt recovers but a start or end window does not. Require the analyzer to report a partial rate rather than `allWindowsRecover: true`. Test fractions `0.1`, `0.2`, `0.33`, and `0.5`, and require start/end inclusion.

- [ ] **Step 2: Write failing workspace preflight tests**

Record `ws.status()` and the registry file bytes before preflight. Run preflight and require status and bytes to remain identical. Check durable and search-safe profiles, PDF blocked behavior, rebuilt PDF warnings, density validation, and short-document recommendations.

- [ ] **Step 3: Verify RED through CI**

- [ ] **Step 4: Implement window sampling**

For each fraction, convert text to code points, compute the window length, generate up to seven evenly spaced start offsets from `0` through `total-window`, deduplicate offsets, run `detect` on each slice, and count matches to either full or short token.

- [ ] **Step 5: Implement profile analysis**

Reuse the existing `mark`/DOCX/PDF adapters with a temporary in-memory identity. Evaluate both profiles and the existing transform chains. Do not call `registry.add` or write output bytes.

- [ ] **Step 6: Implement workspace format dispatch and recommendation**

Normal PDFs return a blocked outcome. Rebuilt PDFs analyze the normalized text-layer route. Recommend the durable profile only when it actually embeds a Tier-2 survivor; otherwise state that the document is too small or structurally unsuitable for durable symbolic marking.

- [ ] **Step 7: Run targeted and full tests**

```bash
node --import tsx --test test/preflight.test.ts test/workspace.test.ts
npm test
```

---

### Task 6: CLI commands and machine-readable output

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/cli.test.ts`

**Interfaces:**
- New commands:

```text
mattermark preflight <file> [--rebuild-pdf] [--homoglyph-density <0..1>] [--json]
mattermark key [--json]
mattermark export <token> --out <file> [--artifact <file>] [--json]
mattermark verify <bundle> [--artifact <file>] [--expect-key <sha256:...>] [--json]
```

- [ ] **Step 1: Write failing subprocess tests**

Tests must cover:

- `preflight` human output shows both profiles, excerpt windows, and a recommendation;
- `preflight --json` parses and leaves `list --json` unchanged;
- `key --json` returns a 64-hex SHA-256 fingerprint;
- `export` writes inspectable JSON and warns that it contains sensitive matter/recipient data;
- `verify` succeeds without `MATTERMARK_PASSPHRASE` or a vault;
- `verify --expect-key` succeeds for the displayed key and fails for another key;
- `verify --artifact` rechecks the marked file;
- a tampered bundle exits 1 with no stack trace;
- usage errors exit 2.

- [ ] **Step 2: Verify RED through CI**

- [ ] **Step 3: Add formatting helpers and commands**

Keep default output task-oriented. `--json` must print only JSON. `verify` must parse the bundle before any vault lookup and must not call `openVault`.

- [ ] **Step 4: Update help and examples**

Add all commands to `USAGE`, `GENERAL_HELP`, and `COMMAND_HELP`. Explain self-contained versus key-pinned verification in plain language. Correct the anchor help so an upgraded attestation is not called confirmed until block-header verification.

- [ ] **Step 5: Run CLI and full tests**

```bash
node --import tsx --test test/cli.test.ts
npm test
```

---

### Task 7: OpenTimestamps trust-language regression

**Files:**
- Modify: `src/ledger/opentimestamps.ts`
- Modify: `test/opentimestamps.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Upgraded proof metadata adds `bitcoinAttestation: boolean` while retaining legacy `confirmed` for compatibility.
- `describe` must use the phrase `Bitcoin attestation` and `not independently confirmed` for upgraded proofs.

- [ ] **Step 1: Change the existing test first**

Replace the assertion expecting `/Bitcoin block 815000/` with assertions that the text contains `Bitcoin attestation`, contains the block height, contains `not independently confirmed`, and does not match `/confirmed in Bitcoin/i`.

- [ ] **Step 2: Verify the changed test fails against current production code**

- [ ] **Step 3: Correct `upgrade` metadata and `describe` wording**

Set `bitcoinAttestation` from `summary.bitcoin.length > 0`. Retain `confirmed` but comment that it means an attestation is present, not header verification. Update every user-facing string accordingly.

- [ ] **Step 4: Run timestamp and full tests**

```bash
node --import tsx --test test/opentimestamps.test.ts
npm test
```

---

### Task 8: Documentation, packaging, and release readiness

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `NOTICE.md`
- Modify: `package.json`
- Modify: `test/packaging.test.ts`

- [ ] **Step 1: Add a packaging test before changing the package surface**

Require the packed module to export `verifyEvidenceBundle`, `parseEvidenceBundle`, `createMerkleProof`, and `verifyMerkleProof`, and require the compiled CLI help to list all four new commands.

- [ ] **Step 2: Verify the packaging test fails**

- [ ] **Step 3: Bump version to `0.2.0` and update docs**

README must include a quick workflow:

```bash
mattermark preflight brief.docx
mattermark protect brief.docx --matter M-14 --recipient alice@example.com
mattermark key
mattermark export <short-id> --out alice.mattermark.json --artifact recovered.pdf
mattermark verify alice.mattermark.json --artifact recovered.pdf --expect-key sha256:<fingerprint>
```

Document that the bundle contains sensitive matter/recipient data, an embedded key is not an identity, HMAC copy tokens are not publicly self-verifying, and an OTS block-height attestation is not confirmation until checked against a trusted header.

- [ ] **Step 4: Run every local verification command**

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
```

- [ ] **Step 5: Open the pull request and require the Node 20/22/24 matrix**

The PR description must list the new trust boundaries and the fixed OpenTimestamps overclaim. Do not merge if any matrix job, demo, package test, or corpus matrix fails.

- [ ] **Step 6: Review the final diff for secrets, generated artifacts, and accidental format changes**

Confirm no vault, marked document, evidence bundle, `dist/`, or passphrase entered the commit.

- [ ] **Step 7: Squash merge to `main` and create release `v0.2.0`**

Release notes must separate features, security/correctness fixes, compatibility, and verification evidence. Create the release only after the merged `main` commit is verified.
