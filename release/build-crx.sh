#!/usr/bin/env bash
# Pack a signed FastLink .crx (CRX3) for the self-hosted auto-update channel.
# Usage: release/build-crx.sh <version>   e.g. release/build-crx.sh 0.4.3
# Output: $BUILD/fastlink-<version>.crx  (a Windows-visible path, ready for `gh release`).
#
# Staging lives on a Windows path because chrome.exe (the packer) can't read WSL
# paths. The signing key preserves the stable extension ID — never lose it.
set -euo pipefail

VERSION="${1:?usage: build-crx.sh <version>}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
EXT_SRC="$REPO/fast-ext"
KEY="$REPO/fastlink-extension-signing-key.pem"
BUILD="/mnt/c/Users/yjtur/FastLink/build"
CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"

# Sanity: staged manifest version must equal the requested version.
MANV="$(grep -oP '"version":\s*"\K[^"]+' "$EXT_SRC/manifest.json")"
[ "$MANV" = "$VERSION" ] || { echo "manifest version ($MANV) != requested ($VERSION) — bump fast-ext/manifest.json first"; exit 1; }

rm -rf "$BUILD"; mkdir -p "$BUILD/ext"
cp -r "$EXT_SRC/." "$BUILD/ext/"
rm -rf "$BUILD/ext/dist"          # drop the build-staging duplicate
cp "$KEY" "$BUILD/key.pem"

"$CHROME" --pack-extension='C:\Users\yjtur\FastLink\build\ext' \
          --pack-extension-key='C:\Users\yjtur\FastLink\build\key.pem' \
          --user-data-dir='C:\Users\yjtur\FastLink\build\pack-profile' \
          --no-message-box --no-first-run 2>/dev/null || true
for _ in $(seq 1 20); do [ -f "$BUILD/ext.crx" ] && break; sleep 0.5; done
[ -f "$BUILD/ext.crx" ] || { echo "pack failed — no ext.crx produced"; exit 1; }
mv "$BUILD/ext.crx" "$BUILD/fastlink-$VERSION.crx"
echo "built: $BUILD/fastlink-$VERSION.crx"
sha256sum "$BUILD/fastlink-$VERSION.crx"
