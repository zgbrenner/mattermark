#!/usr/bin/env bash
# Pushes this slice to github.com/zgbrenner/mattermark, preserving the
# existing LICENSE commit as the root of history.
#
#   chmod +x push-to-github.sh && ./push-to-github.sh
#
# Requires: git, and push access (gh auth login, a PAT, or an SSH key).
set -euo pipefail

REPO="https://github.com/zgbrenner/mattermark.git"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> cloning $REPO"
git clone --quiet "$REPO" "$WORK/repo"
cd "$WORK/repo"

echo "==> copying slice 1 (LICENSE and .git left untouched)"
tar -C "$SRC" -cf - \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='push-to-github.sh' \
  --exclude='LICENSE' \
  . | tar -C . -xf -

echo "==> verifying before commit"
npm ci --silent
npm run typecheck
npm run demo > /dev/null
echo "    typecheck + harness pass"

git add -A
if git diff --cached --quiet; then
  echo "==> nothing to commit; repo already up to date"
  exit 0
fi

git commit -q -F - <<'MSG'
Slice 1: Tolaria marking and attribution engine

Implements Mode A of Raz et al. (arXiv:2603.28655v1) repurposed for
recipient attribution rather than vendor-side ingestion detection.

- Dual token schemes: HMAC-SHA256 (128-bit) and Ed25519 (~128-bit)
- Three symbolic codecs on disjoint surfaces: whitespace (base-4),
  zero-width (base-4), homoglyph (1-bit), behind one swappable interface
- Composition guard enforcing the paper's stacking rules, which prevent
  the documented 97% -> 0% cross-layer interference collapse
- Transport-transform taxonomy T01-T11 with composite chains
- Registry as evidence schema: recipient, matter, version, hashes,
  channels, delivery, append-only investigation log

Three deviations from the paper, all measurement-driven:
- Magic-sync framing, so excerpts (the real leak shape) resynchronise
- Per-channel payload sizing with a 12-byte SHORT_ID fallback, after
  measuring that the 74-byte Ed25519 frame fits exactly once in the
  homoglyph channel of a 1.5k document and dies to any head-clipping excerpt
- Copy identity derived from (matter, recipient, version), not file path

Measured: survives Tier 1 and Tier 2, total loss at Tier 3. Minimum
durable document size ~400 chars. See SECURITY.md.

Zero runtime dependencies. Typechecks clean on Node 20/22/24.
MSG

echo "==> pushing to main"
git push origin main
echo "==> done: https://github.com/zgbrenner/mattermark"
