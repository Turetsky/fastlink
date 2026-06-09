#!/usr/bin/env bash
# package.sh — build an uploadable Chrome Web Store zip for the FastLink extension.
#
# Produces dist/fastlink-<version>.zip containing ONLY the files Chrome needs to
# run the extension. Dev files (docs, build scripts, .wrangler, node_modules,
# editing-source images, unused large icons) are excluded.
#
# Usage:
#   bash scripts/package.sh            # build dist/fastlink-<version>.zip
#   bash scripts/package.sh --keep     # also leave the staged tree in dist/staging
#
# Run from anywhere; paths resolve relative to the extension root.

set -euo pipefail

# --- resolve the extension root (parent of this script's dir) ----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

# --- read version from manifest.json -----------------------------------------
VERSION="$(node -p "require('./manifest.json').version" 2>/dev/null || true)"
if [[ -z "$VERSION" ]]; then
  echo "ERROR: could not read version from manifest.json" >&2
  exit 1
fi

DIST="$ROOT/dist"
STAGE="$DIST/staging"
OUT="$DIST/fastlink-$VERSION.zip"

# --- validate the manifest before packaging ----------------------------------
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))" \
  || { echo "ERROR: manifest.json is not valid JSON" >&2; exit 1; }

# --- the allowlist of paths that go into the package -------------------------
# Runtime entrypoints, all source modules, the HTML pages, and the icons the
# manifest actually references (the colored state icons are used at runtime).
INCLUDE=(
  manifest.json
  background.js
  popup.html
  popup.js
  options.html
  options.js
  onboarding.html
  onboarding.js
  sidepanel.html
  sidepanel.js
  src
  icons/icon-16.png
  icons/icon-32.png
  icons/icon-48.png
  icons/icon-128.png
  icons/icon-green-16.png
  icons/icon-green-32.png
  icons/icon-green-48.png
  icons/icon-green-128.png
  icons/icon-yellow-16.png
  icons/icon-yellow-32.png
  icons/icon-yellow-48.png
  icons/icon-yellow-128.png
  icons/icon-red-16.png
  icons/icon-red-32.png
  icons/icon-red-48.png
  icons/icon-red-128.png
)

# --- stage a clean tree ------------------------------------------------------
rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE/icons"

for path in "${INCLUDE[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "ERROR: expected file/dir not found: $path" >&2
    exit 1
  fi
  # copy preserving directory structure
  mkdir -p "$STAGE/$(dirname "$path")"
  cp -R "$path" "$STAGE/$(dirname "$path")/"
done

# --- belt-and-suspenders: drop anything that should never ship ---------------
find "$STAGE" \( -name '*.md' -o -name '*.sh' -o -name '.DS_Store' \) -delete 2>/dev/null || true

# --- syntax-check every JS file that will ship -------------------------------
JS_ERR=0
while IFS= read -r -d '' f; do
  node --check "$f" || { echo "ERROR: syntax check failed: $f" >&2; JS_ERR=1; }
done < <(find "$STAGE" -name '*.js' -print0)
[[ "$JS_ERR" == 0 ]] || exit 1

# --- zip ---------------------------------------------------------------------
( cd "$STAGE" && zip -r -q -X "$OUT" . )

# --- report ------------------------------------------------------------------
SIZE="$(du -h "$OUT" | cut -f1)"
COUNT="$(cd "$STAGE" && find . -type f | wc -l | tr -d ' ')"
echo "✅ Built $OUT"
echo "   version: $VERSION   files: $COUNT   size: $SIZE"
echo
echo "Contents:"
( cd "$STAGE" && find . -type f | sort | sed 's/^\./   /' )

if [[ "$KEEP" == 0 ]]; then
  rm -rf "$STAGE"
else
  echo
  echo "Staged tree kept at: $STAGE  (load unpacked from here to test)"
fi
