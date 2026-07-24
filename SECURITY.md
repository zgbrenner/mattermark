# Security model

Read this before deploying Mattermark against anything that matters.

## What the cryptography guarantees

Tokens are minted with HMAC-SHA256 (128-bit) or Ed25519 (~128-bit). An
adversary cannot forge a token that resolves to a different recipient without
the organisation key. Attribution, when a token is recovered, is sound.

`SHORT_ID` is the exception and is weaker by design: 64-bit forgery resistance
and no self-verification. It resolves only against the registry, and it is only
ever issued alongside a full-strength frame in a higher-capacity channel. Do
not deploy a configuration that carries SHORT_ID alone.

## What the steganography does NOT guarantee

**This is not a covert channel against a motivated adversary.** Measured
survival, with this repo's own harness:

| Adversary capability | Result |
|---|---|
| Benign handling (copy-paste, reflow, smart quotes) | survives |
| Platform sanitization (NFKC, whitespace collapse, Cf strip) | survives, via homoglyph channel only |
| Targeted stripping (zero-width removal + confusable folding + non-ASCII strip) | **total loss** |
| LLM paraphrase | **assume total loss** (not measured) |

Anyone who suspects a document is marked and runs three generic normalisation
passes defeats every channel in this repo. That is inherent to symbolic
steganography and is documented in the source paper. The mitigation is a
linguistic layer, which is not implemented.

## This repository is public

The exact codepoint alphabets are in `src/codecs/`. Publishing them means a
recipient who reads this repo can detect and strip a mark. Weigh that against
the value of open review before adding real deployments.

Note that Raz et al. §3.2 assume an adversary who knows the method *families*
but not the specific parameters. A public repo with hardcoded alphabets does
not satisfy that assumption. Key-deriving the alphabets from `k_org` would
partially restore it — though only partially, since blanket transforms (T08,
T09, T10) do not care which specific codepoints were chosen. Treat this as a
known limitation, not a solved problem.

## Operational cautions

- **Registry files are evidence.** They contain recipient identities, matter
  references, and token material. `.gitignore` excludes them. Encrypt at rest.
  Append investigation events; never mutate rows in place.
- **Homoglyph marking breaks exact-match search, and it is optional.** Cyrillic
  substitutions replace Latin letters in place: they defeat Ctrl-F, spellcheck,
  and some e-discovery keyword indexing while looking identical on screen. For
  litigation work product this can be **disqualifying**, because keyword search
  over the marked copy is central to the practice and a silently corrupted index
  is worse than an absent mark. HG is therefore a disclosed choice, not a
  mandate: `mark()` surfaces the search-impact warning in its `warnings[]`
  whenever HG is active; `maxHomoglyphDensity` caps the substitution rate; and
  `allowNonDurable` permits a search-preserving `WS+ZW` mark that keeps every
  visible letter intact, at the cost of durability (it dies to Tier-2
  sanitization). Pick per matter with the trade in view. See the homoglyph
  section in `README.md`.
- **Active canaries are not implemented and should not be added casually.**
  Embedding a callback in a document sent to a third party raises professional
  responsibility questions distinct from anything technical in this repo. The
  `activeCanary.disclosedToRecipient` field exists to force that decision;
  it is not legal advice and does not substitute for an ethics opinion.
- **Dual use.** A covert document-marking tool is also a covert tracking tool.
  The MIT licence places no restriction on downstream use.

## Reporting

Open a private security advisory via the repository's Security tab rather than
a public issue.
