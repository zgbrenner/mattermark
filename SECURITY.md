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

## The product surface (Slice 4)

The workspace vault, the CLI, and the local web UI add new trust boundaries.
Nothing below changes what the marks themselves survive — the table above
applies unchanged, and `protect` records issue-time survival per copy so the
evidence report carries measured numbers, not assumptions.

### The vault and the passphrase

`init` creates a vault directory holding `config.json` (non-secret metadata),
`org.key` (the 32-byte org key, sealed with AES-256-GCM under a scrypt-derived
key), and `registry.mmv` (the `SecureRegistry` event log, sealed the same
way). One passphrase — minimum 8 characters, via `MATTERMARK_PASSPHRASE` or a
hidden prompt — unlocks both.

- **The passphrase is the root of trust.** Minting tokens, re-verifying
  recovered ones, and reading the ledger all require it. Anyone who has the
  passphrase and the vault directory has the whole workspace.
- **There is no recovery.** No escrow, no reset, no back door. Losing the
  passphrase loses the ability to attribute every copy ever issued from that
  vault: the marked copies stay marked, but nothing can resolve or re-verify
  them. Store the passphrase under the same key-management discipline as an
  org signing key, and back up the vault directory — it is the evidence.
- **scrypt slows offline guessing; it does not defeat it.** Anyone who copies
  the vault can mount an unthrottled offline attack against the passphrase.
  Eight characters is a floor, not a recommendation — use a real passphrase.
- The vault contains recipient identities, matter references, and token
  material (encrypted). It is evidence; keep it out of version control and
  handle it accordingly.

### The local web UI

`npm run ui` binds to `127.0.0.1` only, and every request must carry a random
URL token minted at startup. That is the entire authentication model, and it
addresses exactly one threat: other local processes or pages in your browser
reaching the port. It is not multi-user software.

- **Do not port-forward, reverse-proxy, tunnel, or rebind it.** There is no
  TLS, no accounts, no session management, no rate limiting. Exposing the port
  exposes the unlocked workspace.
- Anyone on the machine who obtains the URL token has full workspace access
  for as long as the server runs.
- Documents dropped into the UI are processed in-process; nothing leaves the
  machine.

### What a confidence grade does and does not prove

`identify` grades every recovered mark:

- **confirmed** — the full token was cryptographically re-verified against the
  registry row's identity: the Ed25519 signature checked, or the HMAC
  recomputed from the org key. The token is re-derived from the row identity
  rather than trusted from the lookup, so a corrupted or misfiled registry row
  cannot mis-attribute. This proves the recovered mark is the one this vault
  minted for that recipient, matter, and version. It does **not** prove who
  released the document: a confirmed match says whose *copy* surfaced, not
  whose hands moved it — forwarding, a compromised recipient machine, and
  shared mailboxes all produce the same confirmed match.
- **corroborated** — a 12-byte short registry pointer recomputed from the row
  identity. 64-bit forgery resistance and not self-verifying: corroborating
  evidence only, never a standalone claim. Short IDs are only ever issued
  alongside a full-strength frame in another channel.
- **unrecognized** — a mark was recovered but no registry row resolves it:
  another organisation's workspace, or a vault that no longer exists.
- **Absence of a mark proves nothing.** A stripped mark is indistinguishable
  from a document that was never marked, and the survival table above lists
  exactly which handling strips one.

## Operational cautions

- **Registry files are evidence.** They contain recipient identities, matter
  references, and token material. `.gitignore` excludes the engine-level
  registry files, `*.mmv`, and the default `mattermark-vault/` directory; if
  you relocate the vault with `--vault`, keep it excluded yourself.
  `src/registry.ts` is a plaintext prototype store — do
  not deploy it against real matters. Use `SecureRegistry` (`src/ledger/`) —
  the workspace vault does this for you — a single file, encrypted at rest with
  AES-256-GCM under a scrypt-derived key, and append-only via a hash chain so an
  edited or reordered row is detectable by recomputation. Keep appending
  investigation events; never mutate rows in place. Note the honest anchoring
  limit: the built-in local attestation is non-repudiable as to the org but its
  timestamp is self-asserted — provable-prior-to-a-skeptic needs an external
  anchor (OpenTimestamps / Rekor / RFC 3161) behind the `Anchor` interface.
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
