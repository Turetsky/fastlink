#!/usr/bin/env bash
# update-extension-git.sh — FastLink AV-SAFE updater (macOS + Linux): pure
# `git pull`, nothing else. Unix port of scripts/update-extension-git.ps1.
#
# ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
# On machines with endpoint protection (Bitdefender, Microsoft Defender, other
# EDR), the standard tester auto-update path — scripts/pull-extension.{sh,ps1} —
# gets blocked or quarantined. That worker does exactly what AV heuristics flag:
# it downloads a zip from the internet (curl/wget), swaps files into a browser-
# extension folder, and the installer registers a background job (cron / systemd
# timer / launchd). To an EDR that pattern reads like a dropper + persistence.
#
# `git`, by contrast, is a signed, whitelisted, trusted developer tool. A plain
# `git pull` over HTTPS does NOT trip AV. So for locked-down machines we use a
# different shape entirely:
#
#   - Chrome loads the extension UNPACKED straight from this repo's `fast-ext`
#     folder (Load unpacked -> .../fastlink/fast-ext), so the on-disk files
#     Chrome reads ARE the repo's files.
#   - `git pull --ff-only` updates those files IN PLACE — no zip, no archive
#     download, no copy/swap, no scheduled job. AV has nothing to flag.
#   - On the next release version bump the extension self-reloads (Chrome's own
#     runtime.reload() from inside the service worker — AV-immune; no external
#     process touches Chrome).
#
# So this script does ONLY a fast-forward git pull and prints a short reminder.
# That single trusted command IS the point. It pairs with
# docs/INSTALL-MANAGED-MACHINE.md.
#
# It is deliberately MORE minimal than the other updaters — no npm step, no
# version compare, no zip. Pure git, so it can drop into an existing login
# script / `claude` wrapper via --quiet.
#
# ── Usage ────────────────────────────────────────────────────────────────────
#   bash scripts/update-extension-git.sh
#   bash scripts/update-extension-git.sh --repo-dir "$HOME/fastlink"
#   bash scripts/update-extension-git.sh --quiet      # for login/claude wrapper
#
# ── Flags ────────────────────────────────────────────────────────────────────
#   --repo-dir DIR   Path to the cloned FastLink repo. Default: the repo this
#                    script lives in (the parent of scripts/).
#   --quiet          Suppress normal output (errors still print).
#   -h | --help      Show this help.
#
# Pure git. No download, no file-swap, no curl/wget, no cron/launchd/systemd.
# Exit codes: 0 ok/up-to-date, 1 bad args / not-a-clone / dirty / pull failed.

set -u

REPO_DIR=''
QUIET=0

usage() {
  cat <<'EOF'
update-extension-git.sh — FastLink AV-safe updater (macOS + Linux): pure git pull.

Usage:
  bash scripts/update-extension-git.sh
  bash scripts/update-extension-git.sh --repo-dir "$HOME/fastlink"
  bash scripts/update-extension-git.sh --quiet

Flags:
  --repo-dir DIR   Path to the cloned FastLink repo. Default: this script's repo root.
  --quiet          Suppress normal output (errors still print).
  -h | --help      Show this help.
EOF
}

# ── parse args ───────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --repo-dir) REPO_DIR="${2:-}"; shift 2 ;;
    --quiet)    QUIET=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Quiet-aware writer. Errors go straight to stderr elsewhere and ignore --quiet.
say() { [ "$QUIET" -eq 1 ] && return 0; printf '%s\n' "$*"; }

# ── resolve the repo path ────────────────────────────────────────────────────
if [ -z "$REPO_DIR" ]; then
  # This script is at <repo>/scripts/update-extension-git.sh, so the repo root
  # is the parent of the script's own directory.
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_DIR="$(dirname "$SCRIPT_DIR")"
fi

if [ ! -d "$REPO_DIR" ]; then
  echo "FastLink repo not found at '$REPO_DIR'. Pass --repo-dir <path to the clone>." >&2
  exit 1
fi
# Normalize to an absolute path.
REPO_DIR="$(cd "$REPO_DIR" && pwd)"

if [ ! -e "$REPO_DIR/.git" ]; then
  echo "'$REPO_DIR' is not a git clone (no .git). Pass --repo-dir <path to the clone>." >&2
  exit 1
fi

# git itself must be present — that's the entire (trusted) toolchain here.
if ! command -v git >/dev/null 2>&1; then
  echo "git is not installed / not on PATH. Install git, then re-run." >&2
  exit 1
fi

EXT_PATH="$REPO_DIR/fast-ext"
say "Repo:       $REPO_DIR"
say "Extension:  $EXT_PATH  (Chrome should load THIS folder unpacked)"
say ""

# ── fail gracefully on a dirty tree (don't clobber local changes) ────────────
# A fast-forward pull would fail on a dirty tree anyway; detect it first so we
# can print a clear message instead of a raw git error.
if [ -n "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null)" ]; then
  echo "The repo has local changes (dirty working tree) at $REPO_DIR." >&2
  echo "Refusing to pull so your changes aren't clobbered." >&2
  echo "Commit/stash them (or 'git -C \"$REPO_DIR\" checkout -- .' to discard), then re-run." >&2
  exit 1
fi

# ── git pull (fast-forward only) ─────────────────────────────────────────────
say "Pulling latest (fast-forward only) ..."
before="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)"

if ! git -C "$REPO_DIR" pull --ff-only; then
  echo "git pull --ff-only failed." >&2
  echo "Likely a diverged branch (local commits the remote doesn't have)." >&2
  echo "Resolve by hand: cd '$REPO_DIR'; git status; git log --oneline -5" >&2
  exit 1
fi

after="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)"

if [ "$before" = "$after" ]; then
  say "Already up to date ($after)."
else
  say "Updated: $before -> $after"
fi

# ── reminder ─────────────────────────────────────────────────────────────────
say ""
say "Done."
say "The extension files are now current: Chrome loads unpacked straight from"
say "  $EXT_PATH"
say "so this pull updated them in place. To apply now, open chrome://extensions"
say "and click the reload arrow on FastLink. Otherwise it self-reloads on the"
say "next release version bump."
say ""
exit 0
