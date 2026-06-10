#!/usr/bin/env bash
# watch-sync.sh — keep the Windows-loaded extension copy continuously in sync
# with the repo, so reloading FastLink at chrome://extensions ALWAYS loads the
# latest code (no manual copy step).
#
# It mirrors fast-ext/ -> the Windows extension folder on every change. Uses
# inotify (event-driven, instant) when available, else falls back to a light
# 2s rsync poll (rsync only transfers changed files, so it's cheap).
#
# Run it:   bash scripts/watch-sync.sh          (foreground, Ctrl-C to stop)
#   or:     setsid bash scripts/watch-sync.sh >/tmp/fastlink-watch-sync.log 2>&1 &   (detached)
#
# Paths are overridable:  SRC=... DEST=... bash scripts/watch-sync.sh
set -u

SRC="${SRC:-/home/yaakov/code/Fastlink/fast-ext/}"
DEST="${DEST:-/mnt/c/Users/yjtur/FastLink/extension/}"

# -rltD (no -pog): the Windows DrvFs mount can't represent Unix perms/owner/group,
# so syncing them makes rsync re-copy every file every cycle. Drop them → only
# real size/mtime changes transfer (no churn).
do_sync() { rsync -rltD --delete --no-perms --no-owner --no-group --exclude='.git' "$SRC" "$DEST" 2>/dev/null; }

stamp() { date '+%H:%M:%S'; }

if [ ! -d "$SRC" ]; then echo "[watch-sync] SRC not found: $SRC" >&2; exit 1; fi
mkdir -p "$DEST" 2>/dev/null || true

do_sync
echo "[watch-sync $(stamp)] initial mirror done: $SRC -> $DEST"

if command -v inotifywait >/dev/null 2>&1; then
  echo "[watch-sync $(stamp)] watching with inotify (instant). Ctrl-C to stop."
  # -m monitor, -r recursive, -q quiet; coalesce rapid bursts with a tiny settle.
  inotifywait -m -r -q -e modify,create,delete,move,close_write "$SRC" |
  while read -r _; do
    do_sync
    echo "[watch-sync $(stamp)] synced"
  done
else
  echo "[watch-sync $(stamp)] inotify not installed; polling every 2s. Ctrl-C to stop."
  echo "[watch-sync] (for instant sync: sudo apt-get install -y inotify-tools)"
  while true; do do_sync; sleep 2; done
fi
