# Attribution and prior art

## Source paper

The layered encode/transport/decode architecture, the four-tier
transport-transform taxonomy, the dual HMAC/EdDSA verification schemes, and the
cross-layer composition findings are taken from:

> Md Raz, Venkata Sai Charan Putrevu, Meet Udeshi, Prashanth Krishnamurthy,
> Farshad Khorrami, and Ramesh Karri.
> *Safeguarding LLMs Against Misuse and AI-Driven Malware Using Steganographic
> Canaries.* arXiv:2603.28655v1 [cs.CR], 30 March 2026.
> Department of Electrical and Computer Engineering, Tandon School of
> Engineering, New York University.
> https://arxiv.org/abs/2603.28655

Released under the arXiv.org perpetual non-exclusive license. This is an
independent implementation from the published description; no code from the
authors was used, and none appears to have been released.

**Mattermark repurposes the architecture.** The paper builds a vendor-side
ingestion tripwire for detecting unauthorised LLM processing. Mattermark uses
the same primitives for recipient attribution of outbound work product. The
registry, which the paper places explicitly out of scope (§3.5), is the core of
this implementation.

## Deviations from the paper

Documented in `README.md`. Summary: magic-sync framing for excerpt recovery,
per-channel payload sizing with a SHORT_ID fallback, and attribution-derived
copy identity.

## Corrections to the paper

Our harness measures the zero-width channel dying at **T07 (Tier 2, format
character strip)** rather than Tier 3 as indicated in the paper's Table 4. All
four zero-width alphabet members are Unicode general category `Cf`. Either the
paper's Cf strip was narrower than ours or the table is in error. Reported here
in case it is useful to the authors.

## Prior art deliberately NOT used

**Fraunhofer ISST Innamark** is the closest production-oriented invisible
text-watermarking implementation, and its underlying algorithm is associated
with patent applications. Nothing in this repository derives from Innamark.
The whitespace, zero-width, and homoglyph codecs here are implemented from the
paper's descriptions and from Unicode primitives directly. Freedom-to-operate
review is required before borrowing from that implementation.

Homoglyph mappings are drawn from the confusables data in Unicode Technical
Standard #39 (Davis and Suignard), which is published under the Unicode
Terms of Use.

## Name

"Mattermark" was also the name of a startup-data company founded in 2012,
acquired by FullContact in December 2017 and subsequently shut down. Unrelated.
See `README.md` for the naming discussion.
