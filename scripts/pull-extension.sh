#!/usr/bin/env bash
# pull-extension.sh — FastLink tester auto-pull (macOS + Linux), NO git required.
# This is the Unix port of scripts/pull-extension.ps1 (Windows). It is the WORKER
# that the background scheduler (systemd timer / cron / launchd LaunchAgent,
# registered by install-tester.sh) runs on a timer.
#
# ── How the no-click update works (the pairing) ──────────────────────────────
#
#     [this job]   pull-extension.sh downloads the latest fast-ext from GitHub
#                  and ATOMICALLY swaps it into the loaded extension folder.
#           |
#           v
#     [extension]  updateCheck.js (inside the service worker) notices the new
#                  manifest "version" on its periodic check and calls
#                  chrome.runtime.reload().
#           |
#           v
#     [Chrome]     reload() re-reads the extension folder from disk — which now
#                  holds the new files this job just wrote — so the tester ends
#                  up on the new build with ZERO clicks.
#
# So this script never touches Chrome. Its ONLY job is to make the on-disk files
# current and intact. The extension + Chrome do the reload. (Same contract as the
# Windows pull-extension.ps1 — keep the two in sync if you change the behavior.)
#
# ── What it does ─────────────────────────────────────────────────────────────
#   1. Download the repo zip from GitHub (curl, falling back to wget) to a temp file.
#   2. Unzip it to a temp dir and locate `fast-ext` (the dir holding manifest.json).
#   3. Compare the downloaded manifest "version" with what's already installed.
#      If they match (and --force isn't given), SKIP the swap — nothing changed.
#   4. Otherwise ATOMICALLY swap the new fast-ext into --ext-dir: stage the new
#      files in a sibling folder on the SAME volume, then rename old out / new in
#      (a sub-second directory rename), so Chrome never sees a half-written folder.
#   5. Log everything to a file. Any network/extract failure leaves the existing
#      extension folder completely intact.
#
# ── Usage ────────────────────────────────────────────────────────────────────
#   bash scripts/pull-extension.sh
#   bash scripts/pull-extension.sh --ext-dir "$HOME/.fastlink/extension" --force
#   bash scripts/pull-extension.sh --zip-url '.../tags/v0.5.0.zip'
#
# ── Flags (mirror the PowerShell -Params) ────────────────────────────────────
#   --ext-dir  DIR   Unpacked-extension folder Chrome loads (Load unpacked → here).
#                    Default: "$HOME/.fastlink/extension" (cross-platform).
#   --zip-url  URL   Repo zip to download. Default: the main-branch zipball. Can
#                    point at a release zip instead.
#   --log-file FILE  Where to append run logs. Default: "<ext-dir's parent>/pull-extension.log".
#   --force          Swap even if the downloaded version matches the installed one.
#   -h | --help      Show usage.
#
# No git, no Node, no admin/root required — just bash + curl|wget + unzip|tar.
# Exit codes mirror the PS worker: 0 ok/up-to-date, 1 bad args/unexpected,
# 2 download fail, 3 extract fail, 4 no fast-ext, 5 no version, 6 bad stage, 7 swap fail.

set -u

# ── defaults (mirror pull-extension.ps1) ─────────────────────────────────────
EXT_DIR="${HOME}/.fastlink/extension"
ZIP_URL='https://github.com/Turetsky/fastlink/archive/refs/heads/main.zip'
LOG_FILE=''
FORCE=0

usage() {
  cat <<'EOF'
pull-extension.sh — FastLink tester auto-pull (macOS + Linux), no git required.

Usage:
  bash scripts/pull-extension.sh
  bash scripts/pull-extension.sh --ext-dir "$HOME/.fastlink/extension" --force
  bash scripts/pull-extension.sh --zip-url '.../tags/v0.5.0.zip'

Flags:
  --ext-dir  DIR   Unpacked-extension folder Chrome loads. Default: $HOME/.fastlink/extension
  --zip-url  URL   Repo zip to download. Default: the main-branch zipball.
  --log-file FILE  Append run logs here. Default: <ext-dir's parent>/pull-extension.log
  --force          Swap even if the downloaded version matches the installed one.
  -h | --help      Show this help.
EOF
}

# ── parse args (long flags, BSD/GNU-portable — no getopt) ─────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --ext-dir)   EXT_DIR="${2:-}"; shift 2 ;;
    --ext-dir=*) EXT_DIR="${1#*=}"; shift ;;
    --zip-url)   ZIP_URL="${2:-}"; shift 2 ;;
    --zip-url=*) ZIP_URL="${1#*=}"; shift ;;
    --log-file)  LOG_FILE="${2:-}"; shift 2 ;;
    --log-file=*) LOG_FILE="${1#*=}"; shift ;;
    --force)     FORCE=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "pull-extension.sh: unknown arg '$1' (try --help)" >&2; exit 1 ;;
  esac
done

if [ -z "$EXT_DIR" ]; then
  echo "pull-extension.sh: --ext-dir cannot be empty" >&2
  exit 1
fi

# ── workspace + swap target paths ────────────────────────────────────────────
# Resolve the parent ("dirname"). Used both for the sibling staging folders (so
# the final swap is a same-volume rename) and for the default log location.
EXT_PARENT="$(dirname "$EXT_DIR")"
EXT_LEAF="$(basename "$EXT_DIR")"

if [ -z "$LOG_FILE" ]; then
  LOG_FILE="${EXT_PARENT}/pull-extension.log"
fi
# Make sure the log's directory exists so the first write can't fail.
LOG_DIR="$(dirname "$LOG_FILE")"
mkdir -p "$LOG_DIR" 2>/dev/null || true

log() {
  # $1 = message, $2 = level (default INFO). Format matches the PS worker:
  #   YYYY-MM-DD HH:MM:SS [LEVEL] message
  local level="${2:-INFO}"
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') [${level}] $1"
  echo "$line"
  printf '%s\n' "$line" >>"$LOG_FILE" 2>/dev/null || true
}

# Read the "version" field from a manifest.json without jq/node. Portable sed
# (works with BSD sed on macOS and GNU sed on Linux). Empty output = unreadable.
manifest_version() {
  local mf="$1"
  [ -f "$mf" ] || { printf ''; return 0; }
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$mf" 2>/dev/null | head -n 1
}

# Unique temp workspace for this run (cleaned up by the trap). Portable mktemp
# template works on both BSD (macOS) and GNU (Linux).
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fastlink-pull-XXXXXX" 2>/dev/null)" || TMP_ROOT=''
if [ -z "$TMP_ROOT" ] || [ ! -d "$TMP_ROOT" ]; then
  log "Could not create a temp workspace — aborting." 'ERROR'
  exit 1
fi
ZIP_PATH="${TMP_ROOT}/repo.zip"
UNZIP_DIR="${TMP_ROOT}/unzipped"

# Sibling staging + backup folders live NEXT TO $EXT_DIR (same volume) so the
# final swap is a fast directory rename rather than a cross-volume copy. $$ keeps
# concurrent runs from colliding.
STAGING="${EXT_PARENT}/${EXT_LEAF}.new-$$"
BACKUP="${EXT_PARENT}/${EXT_LEAF}.old-$$"

EXIT_CODE=1
cleanup() {
  # Always remove the temp workspace + any leftover staging/backup folders.
  rm -rf "$TMP_ROOT" "$STAGING" "$BACKUP" 2>/dev/null || true
  log "=== pull-extension end (exit $EXIT_CODE) ==="
}
trap cleanup EXIT

# ── main worker ──────────────────────────────────────────────────────────────
pull() {
  log "=== pull-extension start ==="
  log "ExtDir : $EXT_DIR"
  log "ZipUrl : $ZIP_URL"

  if [ -z "$EXT_PARENT" ] || [ "$EXT_PARENT" = "$EXT_DIR" ]; then
    log "ExtDir '$EXT_DIR' has no parent directory — pass an absolute path." 'ERROR'
    return 1
  fi

  mkdir -p "$UNZIP_DIR" 2>/dev/null || true

  # ── 1. download ────────────────────────────────────────────────────────────
  log "[1/4] Downloading repo zip ..."
  if command -v curl >/dev/null 2>&1; then
    # -f fail on HTTP error, -s silent, -S show errors, -L follow redirects.
    if ! curl -fsSL "$ZIP_URL" -o "$ZIP_PATH" 2>>"$LOG_FILE"; then
      log "Download failed (curl)." 'ERROR'
      log "Leaving the existing extension folder untouched." 'WARN'
      return 2
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget -q -O "$ZIP_PATH" "$ZIP_URL" 2>>"$LOG_FILE"; then
      log "Download failed (wget)." 'ERROR'
      log "Leaving the existing extension folder untouched." 'WARN'
      return 2
    fi
  else
    log "Neither curl nor wget is installed — cannot download." 'ERROR'
    return 2
  fi
  if [ ! -s "$ZIP_PATH" ]; then
    log "Downloaded zip is empty — aborting (live folder untouched)." 'ERROR'
    return 2
  fi
  # Portable byte count (BSD stat differs from GNU stat → use wc as a fallback).
  ZIP_SIZE="$(wc -c <"$ZIP_PATH" 2>/dev/null | tr -d ' ')"
  log "      Downloaded ${ZIP_SIZE:-?} bytes."

  # ── 2. extract + locate fast-ext ───────────────────────────────────────────
  log "[2/4] Extracting ..."
  if command -v unzip >/dev/null 2>&1; then
    if ! unzip -q -o "$ZIP_PATH" -d "$UNZIP_DIR" 2>>"$LOG_FILE"; then
      log "Extract failed (corrupt/partial download?)." 'ERROR'
      log "Leaving the existing extension folder untouched." 'WARN'
      return 3
    fi
  elif tar -xf "$ZIP_PATH" -C "$UNZIP_DIR" 2>>"$LOG_FILE"; then
    # macOS `tar` is bsdtar and can unpack zips; this is the no-unzip fallback.
    :
  else
    log "Could not extract the zip (no unzip, and tar failed)." 'ERROR'
    log "Leaving the existing extension folder untouched." 'WARN'
    return 3
  fi

  # The zip expands to a top folder like 'fastlink-main/'. Don't hardcode it —
  # find the first 'fast-ext' directory that actually carries a manifest.json.
  NEW_EXT=''
  while IFS= read -r d; do
    if [ -f "${d}/manifest.json" ]; then NEW_EXT="$d"; break; fi
  done <<EOF
$(find "$UNZIP_DIR" -type d -name 'fast-ext' 2>/dev/null)
EOF
  if [ -z "$NEW_EXT" ]; then
    log "No fast-ext/manifest.json found in the downloaded zip — aborting." 'ERROR'
    log "Leaving the existing extension folder untouched." 'WARN'
    return 4
  fi

  # ── 3. version compare (skip if unchanged) ─────────────────────────────────
  NEW_VER="$(manifest_version "${NEW_EXT}/manifest.json")"
  CUR_VER="$(manifest_version "${EXT_DIR}/manifest.json")"
  log "[3/4] Installed version: ${CUR_VER:-(none)} | downloaded: ${NEW_VER:-(unknown)}"

  if [ -z "$NEW_VER" ]; then
    log "Downloaded manifest has no readable version — aborting to be safe." 'ERROR'
    return 5
  fi
  if [ -n "$CUR_VER" ] && [ "$CUR_VER" = "$NEW_VER" ] && [ "$FORCE" -eq 0 ]; then
    log "Already up to date ($CUR_VER) — skipping swap. (Use --force to override.)"
    return 0
  fi

  # ── 4. atomic swap ─────────────────────────────────────────────────────────
  log "[4/4] Swapping in $NEW_VER ..."

  # Make sure the parent exists (first-ever install) and clear stale temp dirs.
  mkdir -p "$EXT_PARENT" 2>/dev/null || true
  rm -rf "$STAGING" "$BACKUP" 2>/dev/null || true

  # Stage the new files in a sibling folder FIRST (Chrome never sees this name).
  # cp -R is portable (BSD + GNU); avoid GNU-only flags.
  if ! cp -R "$NEW_EXT" "$STAGING" 2>>"$LOG_FILE"; then
    log "Failed to stage the new files — aborting swap (live folder untouched)." 'ERROR'
    return 7
  fi
  # Guard: confirm the staged copy is sane before we touch the live folder.
  if [ ! -f "${STAGING}/manifest.json" ]; then
    log "Staged copy is missing manifest.json — aborting swap (live folder untouched)." 'ERROR'
    return 6
  fi

  # The swap below is a pair of directory renames — sub-second, so Chrome never
  # reads a partially written folder. Note: we move the live folder OUT first so
  # `mv "$STAGING" "$EXT_DIR"` renames (not moves-inside) — this is the portable
  # stand-in for GNU `mv -T`, which BSD/macOS mv does not support.
  HAD_OLD=0
  if [ -e "$EXT_DIR" ]; then
    if ! mv "$EXT_DIR" "$BACKUP" 2>>"$LOG_FILE"; then
      log "Swap failed moving the live folder aside." 'ERROR'
      return 7
    fi
    HAD_OLD=1
  fi
  if ! mv "$STAGING" "$EXT_DIR" 2>>"$LOG_FILE"; then
    log "Swap failed moving the new folder into place." 'ERROR'
    # Roll back: restore the original so the tester is never left with nothing.
    if [ "$HAD_OLD" -eq 1 ] && [ ! -e "$EXT_DIR" ] && [ -e "$BACKUP" ]; then
      if mv "$BACKUP" "$EXT_DIR" 2>>"$LOG_FILE"; then
        log "Rolled back to the previous extension folder." 'WARN'
      else
        log "ROLLBACK FAILED — previous folder is at: $BACKUP" 'ERROR'
      fi
    fi
    return 7
  fi

  # Success — drop the old copy.
  rm -rf "$BACKUP" 2>/dev/null || true
  log "Swapped to $NEW_VER. The extension's update check will reload Chrome onto it."
  return 0
}

pull
EXIT_CODE=$?
exit $EXIT_CODE
