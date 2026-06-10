#!/usr/bin/env bash
#
# release.sh — cut a FastLink release so the in-extension "Update available"
# banner fires for everyone running an older copy.
#
# WHAT IT DOES
#   1. Reads the current version from fast-ext/manifest.json.
#   2. Computes the NEXT version from your arg:
#        - a bump level: patch | minor | major   (default: patch)
#        - or an explicit version: X.Y.Z          (e.g. 0.5.0)
#   3. Writes the new version back into fast-ext/manifest.json.
#   4. Commits "Release vX.Y.Z", creates an ANNOTATED tag vX.Y.Z, and pushes
#      the commit + tag:  git push origin <branch> --follow-tags
#   5. If the GitHub CLI `gh` is installed AND authenticated, also publishes a
#      GitHub Release for the tag (so updateCheck.js's PRIMARY Releases-API path
#      lights up). If `gh` is missing, the pushed tag + raw-manifest fallback
#      still drive the banner — the script prints which path will be used.
#
# WHY IT MATTERS
#   The extension's updateCheck.js compares the RUNNING manifest version against
#   the latest published version (~every 6h). No version bump on `main` => the
#   banner can never detect anything. This script is the bump.
#
# SAFETY
#   - Refuses to run if the working tree is dirty, unless you pass --allow-dirty.
#   - Refuses to reuse an existing tag.
#   - Echoes every step; makes no network change until the push.
#
# USAGE
#   scripts/release.sh                 # default: patch bump (0.4.0 -> 0.4.1)
#   scripts/release.sh patch
#   scripts/release.sh minor           # 0.4.0 -> 0.5.0
#   scripts/release.sh major           # 0.4.0 -> 1.0.0
#   scripts/release.sh 0.6.2           # explicit version
#   scripts/release.sh minor --allow-dirty
#
set -euo pipefail

# ---- locate repo + manifest -------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST="$REPO_ROOT/fast-ext/manifest.json"

cd "$REPO_ROOT"

if [[ ! -f "$MANIFEST" ]]; then
  echo "ERROR: manifest not found at $MANIFEST" >&2
  exit 1
fi

# ---- parse args -------------------------------------------------------------
BUMP_OR_VERSION="patch"
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    patch|minor|major) BUMP_OR_VERSION="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP_OR_VERSION="$arg" ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "ERROR: unrecognized argument '$arg' (want patch|minor|major|X.Y.Z|--allow-dirty)" >&2
      exit 1 ;;
  esac
done

# ---- read current version ---------------------------------------------------
# Prefer node (robust JSON parse); fall back to grep/sed if node is absent.
read_current_version() {
  if command -v node >/dev/null 2>&1; then
    node -e 'const m=require(process.argv[1]); process.stdout.write(String(m.version||""));' "$MANIFEST"
  else
    grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$MANIFEST" \
      | head -n1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
  fi
}

CURRENT="$(read_current_version)"
if [[ -z "$CURRENT" ]]; then
  echo "ERROR: could not read current version from $MANIFEST" >&2
  exit 1
fi
echo "Current version: $CURRENT"

# ---- compute the next version ----------------------------------------------
if [[ "$BUMP_OR_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEXT="$BUMP_OR_VERSION"
else
  # split CURRENT into major.minor.patch (missing segments -> 0)
  IFS='.' read -r MAJ MIN PAT <<<"$CURRENT"
  MAJ=${MAJ:-0}; MIN=${MIN:-0}; PAT=${PAT:-0}
  case "$BUMP_OR_VERSION" in
    patch) PAT=$((PAT + 1)) ;;
    minor) MIN=$((MIN + 1)); PAT=0 ;;
    major) MAJ=$((MAJ + 1)); MIN=0; PAT=0 ;;
  esac
  NEXT="$MAJ.$MIN.$PAT"
fi

if [[ "$NEXT" == "$CURRENT" ]]; then
  echo "ERROR: next version ($NEXT) equals current — nothing to release." >&2
  exit 1
fi

TAG="v$NEXT"
echo "Next version:    $NEXT   (tag: $TAG)"

# ---- preflight checks -------------------------------------------------------
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "Branch:          $BRANCH"

if [[ "$ALLOW_DIRTY" -eq 0 ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree is dirty. Commit/stash first, or pass --allow-dirty." >&2
  git status --short >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "ERROR: tag $TAG already exists. Pick a different version." >&2
  exit 1
fi

# ---- 1. bump the manifest version ------------------------------------------
# Replace ONLY the first "version": "..." line so the rest of the JSON
# (including the "manifest_version" key) is untouched and formatting is kept.
echo "[1/5] Bumping $MANIFEST: $CURRENT -> $NEXT"
TMP="$(mktemp)"
awk -v nv="$NEXT" '
  bumped==0 && /"version"[[:space:]]*:[[:space:]]*"/ && $0 !~ /manifest_version/ {
    sub(/"version"[[:space:]]*:[[:space:]]*"[^"]+"/, "\"version\": \"" nv "\"");
    bumped=1;
  }
  { print }
' "$MANIFEST" >"$TMP"
mv "$TMP" "$MANIFEST"

# verify the write took
WROTE="$(read_current_version)"
if [[ "$WROTE" != "$NEXT" ]]; then
  echo "ERROR: manifest version is '$WROTE' after edit, expected '$NEXT'. Aborting." >&2
  git checkout -- "$MANIFEST" 2>/dev/null || true
  exit 1
fi
echo "      manifest.json now at $WROTE"

# NOTE: fast-dxt/manifest.json carries an INDEPENDENT version on a different
# scheme (the MCP server / .mcpb), and the update banner does NOT read it, so we
# deliberately leave it alone. Bump it by hand if you cut an MCP-server release.

# ---- 2. commit --------------------------------------------------------------
echo "[2/5] Committing 'Release $TAG'"
git add "$MANIFEST"
git commit -m "Release $TAG"

# ---- 3. annotated tag -------------------------------------------------------
echo "[3/5] Creating annotated tag $TAG"
git tag -a "$TAG" -m "FastLink $TAG"

# ---- 4. push commit + tag ---------------------------------------------------
echo "[4/5] Pushing $BRANCH + tags to origin"
git push origin "$BRANCH" --follow-tags

# ---- 5. GitHub Release (optional, lights up the PRIMARY check path) ---------
echo "[5/5] Publishing GitHub Release (if gh is available)"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if gh release create "$TAG" \
       --title "$TAG" \
       --notes "FastLink $TAG. Reload the extension at chrome://extensions to update."; then
    echo "      Published GitHub Release $TAG — updateCheck.js Releases-API path will fire."
  else
    echo "      WARNING: 'gh release create' failed. The pushed tag + raw-manifest"
    echo "      fallback still drive the banner; you can create the release later in the UI."
  fi
else
  echo "      gh not installed/authed — skipped the GitHub Release."
  echo "      That's fine: updateCheck.js falls back to the raw main manifest"
  echo "      (raw.githubusercontent.com/.../fast-ext/manifest.json), so the banner"
  echo "      still detects $NEXT. (Install + 'gh auth login' to also tag a Release.)"
fi

echo ""
echo "Done. Released $TAG. Clients will see the banner within ~6h of their next check."
