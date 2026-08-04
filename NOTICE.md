# Attribution and prior art

## Source paper

The layered encode/transport/decode architecture, four-tier transport-transform taxonomy, dual HMAC/EdDSA verification schemes, and cross-layer composition findings are taken from:

> Md Raz, Venkata Sai Charan Putrevu, Meet Udeshi, Prashanth Krishnamurthy, Farshad Khorrami, and Ramesh Karri. *Safeguarding LLMs Against Misuse and AI-Driven Malware Using Steganographic Canaries.* arXiv:2603.28655v1 [cs.CR], 30 March 2026. New York University Tandon School of Engineering.

Mattermark is an independent implementation from the published description. No code from the authors was used.

**Mattermark repurposes the architecture.** The paper describes a vendor-side ingestion tripwire for detecting unauthorized LLM processing. Mattermark uses related primitives for recipient attribution of outbound work product. The recipient registry, issuance workflow, evidence ledger, preflight analyzer, and portable evidence format are Mattermark additions.

## Portable evidence design lineage

Mattermark 0.2 adopts narrow structural patterns from established open specifications and projects:

- **DSSE (Dead Simple Signing Envelope):** pre-authentication encoding binds a payload type and exact payload bytes before signing. Mattermark implements the small required encoding directly and does not import a DSSE library.
- **in-toto Statements:** the signed payload uses a Statement-shaped structure with one immutable subject digest and a Mattermark-specific predicate type.
- **Sigstore bundles:** the evidence file follows the useful principle of carrying the signed statement, verification material, and supporting proof data together for offline verification. Mattermark does not use Fulcio, Rekor, Sigstore identity, or Sigstore’s hosted trust infrastructure.
- **OpenTimestamps:** ledger roots can be submitted to compatible calendars and stored as standard detached `.ots` proof bytes. A pending calendar promise is not treated as a timestamp. A Bitcoin block-height attestation is not treated as independently confirmed until checked against a trusted block header.
- **Merkle inclusion proofs:** Mattermark exports compact copy-specific proofs against its existing duplicate-last binary Merkle tree. This is a project-specific tree shape, not a claim of Certificate Transparency compatibility.

These acknowledgments describe architectural influence and interoperability goals. They do not imply endorsement by the referenced projects or that Mattermark inherits their complete security or identity guarantees.

## Deviations and additions

Mattermark adds magic-sync framing for excerpt recovery, per-channel payload sizing with a short-ID fallback, attribution-derived copy identity, an encrypted append-only evidence ledger, historical prefix roots, copy-specific Merkle proofs, signed evidence bundles, key pinning, and no-write durability preflight.

## Correction identified by the harness

The Mattermark harness measures the zero-width channel dying at **T07 (Tier 2, format-character stripping)** rather than Tier 3 as indicated in the source paper’s Table 4. All included zero-width alphabet members have Unicode general category `Cf`. Either the paper’s strip was narrower or the table is inaccurate.

## Prior art deliberately not used

**Fraunhofer ISST Innamark** is a close production-oriented invisible text-watermarking implementation, and its underlying algorithm is associated with patent applications. Nothing in this repository derives from Innamark. The whitespace, zero-width, and homoglyph codecs are implemented from the paper’s descriptions and Unicode primitives directly. A freedom-to-operate review is required before borrowing from patented or patent-pending implementations.

Homoglyph mappings draw from confusable-character concepts documented in Unicode Technical Standard #39 and are subject to the Unicode Terms of Use.

## Name

“Mattermark” was also the name of an unrelated startup-data company founded in 2012, acquired by FullContact in 2017, and later shut down.
