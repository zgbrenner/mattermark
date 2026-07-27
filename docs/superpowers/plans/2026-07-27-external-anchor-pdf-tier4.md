# External Anchor, PDF Marking, and Tier-4 Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independently verifiable OpenTimestamps anchoring, mark supported PDFs without changing visible layout, and define a rigorous research path for a Tier-4 linguistic layer.

**Architecture:** Preserve the existing synchronous `Anchor` and `SecureRegistry` APIs. Add a refreshable OpenTimestamps implementation through the official CLI, use a conservative incremental PDF revision with an invisible Type 3 text carrier, and keep linguistic work outside the production codec registry until recipient-payload and legal-fidelity gates are met.

**Tech Stack:** TypeScript, Node.js 20+ built-ins, OpenTimestamps CLI, classic PDF xref/incremental-update syntax, node:test.

## Global Constraints

- Keep zero production npm dependencies.
- Preserve Node.js 20 support.
- Reject unsupported PDF structures instead of attempting lossy repair.
- Do not alter ordinary visible PDF glyphs or existing PDF bytes.
- Treat pending OpenTimestamps proofs as unverified until a Bitcoin attestation verifies.
- Do not claim Tier-4 resistance as solved.

---

### Task 1: OpenTimestamps anchor

**Files:**
- Modify: `src/ledger/anchor.ts`
- Modify: `src/ledger/index.ts`
- Test: `test/opentimestamps.test.ts`

**Interfaces:**
- Consumes: existing `Anchor`, `AnchorProof`, and `SecureRegistry.anchor()` contracts.
- Produces: `openTimestampsCliAnchor(options): RefreshableAnchor`, `AnchorInspection`, `OtsRunner`, versioned `AnchorCheckpoint`, historical prefix verification, and `refresh()`.

- [x] **Step 1: Write a failing test for detached proof creation**

```ts
const anchor = openTimestampsCliAnchor({ runner });
const proof = anchor.commit('ab'.repeat(32), at);
assert.equal(proof.anchor, 'opentimestamps-bitcoin-v1');
assert.equal(Buffer.from(material(proof).ots, 'base64').toString(), 'pending-proof');
```

- [x] **Step 2: Run the test before implementation**

Run: `node --test /tmp/mattermark-work/anchor.test.mjs`
Expected: failure because the adapter module does not exist.

- [x] **Step 3: Implement canonical statement binding and CLI stamping**

```ts
const statement = JSON.stringify({
  domain: 'mattermark.anchor.v1',
  digest: normalizedDigest,
  requestedAt: at,
});
const result = run(['stamp', 'mattermark-anchor.json'], cwd);
```

Store the generated `.ots` bytes as base64 inside `AnchorProof.proof`.

- [x] **Step 4: Add pending, verified, invalid, and unavailable inspection states**

Parse only explicit `Success! Bitcoin block ... attests existence as of ...` output as verified. Pending proofs return `valid: false` and `thirdPartyTime: false`.

- [x] **Step 5: Add immutable proof refresh**

Run `ots upgrade`, read the upgraded detached proof, and return a cloned `AnchorProof`.

- [x] **Step 6: Verify adapter tests**

Run: `node --test /tmp/mattermark-compiled/test/opentimestamps.test.js`
Expected: adapter, binding, exit-status, registry, and historical-checkpoint tests pass.

### Task 2: Incremental PDF carrier

**Files:**
- Modify: `src/formats/pdf.ts`
- Create: `src/formats/pdf-reader.ts`
- Create: `src/formats/pdf-xref.ts`
- Create: `src/formats/pdf-marker.ts`
- Create: `src/formats/pdf-fixture.ts`
- Modify: `src/formats/index.ts`
- Modify: `src/formats/demo.ts`
- Test: `test/pdf-marking.test.ts`

**Interfaces:**
- Consumes: `mark()`, `detect()`, `CopyIdentity`, `Issuer`, and existing PDF extraction.
- Produces: `appendMattermarkPdfCarrier()`, `extractMattermarkPdfCarrier()`, `markPdf()`, and carrier-aware `detectPdf()`.

- [x] **Step 1: Write a failing test for invisible incremental marking**

```ts
const original = buildTextPdf(source);
const marked = appendMattermarkPdfCarrier(original, carrier);
assert.ok(marked.bytes.subarray(0, original.length).equals(original));
assert.equal(extractPdfText(marked.bytes), source);
assert.equal(extractMattermarkPdfCarrier(marked.bytes), carrier);
```

- [x] **Step 2: Run the test before implementation**

Run: `node --test /tmp/mattermark-work/pdf.test.mjs`
Expected: failure because the marking module does not exist.

- [x] **Step 3: Implement conservative PDF parsing and rejection gates**

Accept classic xref files with directly addressable pages and patchable `Resources` and `Contents`. Follow indexed objects across `/Prev`; ignore object-like trailing bytes. Reject encryption, xref/hybrid streams, object streams, signed or certified files, inherited resources, scans, and pre-existing Mattermark carriers.

- [x] **Step 4: Append the invisible Type 3 carrier**

Create a blank glyph program, zero widths, `ToUnicode` CMap, rendering mode `3 Tr`, shared content stream, replacement page/resource dictionaries, and a trailer with `/Prev`.

- [x] **Step 5: Add high-level recipient marking**

```ts
const result = mark(pdfCarrierSource(visibleText), identity, issuer, opts);
const appended = appendMattermarkPdfCarrier(bytes, result.text);
return { bytes: appended.bytes, result, pagesMarked: appended.pagesMarked };
```

- [x] **Step 6: Verify structural, attribution, and render behavior**

Run: `node --test /tmp/mattermark-integration-js/test/pdf-marking.test.js`
Expected: structural, attribution, xref, signature, CMap, collision, and duplicate-carrier tests pass.

Run independent validation with Ghostscript and `pdfinfo`. Render the original and marked fixture at 144 DPI and require byte-identical PNG output.

### Task 3: Tier-4 research decision record

**Files:**
- Create: `docs/research/tier4-linguistic-layer.md`
- Create: `src/research/linguistic/types.ts`
- Create: `src/research/linguistic/manifest.ts`
- Create: `src/research/linguistic/benchmark.ts`
- Create: `src/research/linguistic/index.ts`
- Test: `test/linguistic-research.test.ts`

**Interfaces:**
- Consumes: current frame/token design and transformation taxonomy.
- Produces: proposed `ModelManifest` and `LinguisticGenerator` research contracts, experiment gates, and backlog.

- [x] **Step 1: Separate statistical watermark detection from recipient attribution**

Document that a positive watermark score is insufficient unless the method recovers a framed recipient token or short ID.

- [x] **Step 2: Compare current semantic watermark families**

Cover arithmetic coding, SemStamp, k-SemStamp, SemaMark, PostMark, SWAN, DEW, and SAMark, with explicit limits for payload capacity, reproducibility, and legal fidelity.

- [x] **Step 3: Define fail-closed reproducibility metadata**

Specify model, weights, tokenizer, runtime, quantization, and decoding hashes in `ModelManifest`.

- [x] **Step 4: Define the Tier-4 benchmark and release gates**

Measure exact token recovery, false attribution, bit erasure/error, paraphrase and translation survival, excerpting, latency, and legal redline fidelity.

- [x] **Step 5: Implement the research-only reproducibility scaffold**

Add canonical manifest hashing, fail-closed compatibility checks, generator contracts, minimum Tier-4 attack definitions, and tests. Do not register `LM` in `CODECS`.

### Task 4: Documentation, repository verification, and publication

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `src/ledger/demo.ts`

**Interfaces:**
- Produces: operator instructions, safe-envelope disclosures, and reviewable GitHub branch.

- [x] **Step 1: Update operator documentation**

Add OpenTimestamps stamp/refresh/verify lifecycle, PDF safe envelope, structure-dependence warning, and the Tier-4 research link.

- [x] **Step 2: Run local verification without hosted runners**

Run strict TypeScript checking over the integrated changed modules and execute the
compiled targeted suites for OpenTimestamps/checkpoints, PDF marking, and the
linguistic research scaffold. Validate a controlled PDF with `pdfinfo` and
Ghostscript at 144 DPI, including byte-identical rendered output. Do not trigger the
repository's GitHub Actions workflow.

Observed: 23 targeted tests pass, strict typecheck passes, and the independent
Ghostscript render comparison passes on Node 22. Node 20 and Node 24 remain part
of the repository's existing matrix but were not invoked through hosted runners.

- [x] **Step 3: Review the complete branch diff**

Compared `main...agent/external-anchor-pdf-tier4`. The implementation diff contains only source, tests, README/security documentation, and the research record. No `package.json`, lockfile, or workflow file changed, and the safe-envelope limitations are disclosed.

- [x] **Step 4: Publish the review branch without triggering hosted CI**

Published `agent/external-anchor-pdf-tier4`, inspected the GitHub compare, and left the branch ready for review. No pull request was opened, and the repository workflow was not invoked.
