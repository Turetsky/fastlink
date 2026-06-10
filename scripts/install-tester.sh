#!/usr/bin/env bash
# install-tester.sh — one-time FastLink tester setup for macOS + Linux. NO git,
# no Node, no root needed. This is the Unix port of scripts/install-tester.ps1
# (which registers a Windows Scheduled Task); it does the same job with the
# native per-OS scheduler instead.
#
# Run this ONCE. It:
#   (a) runs pull-extension.sh to download the current extension into --ext-dir;
#   (b) registers a RECURRING background job that re-runs pull-extension.sh at
#       login AND every few hours, so the folder keeps itself current:
#         • Linux  → a systemd USER timer (~/.config/systemd/user/), or a cron
#                    entry if systemd-user isn't available;
#         • macOS  → a launchd LaunchAgent plist (~/Library/LaunchAgents/) with
#                    RunAtLoad + StartInterval.
#   (c) prints the one-time "Load unpacked" steps for Chrome.
#
# ── How the no-click update works (why this is enough) ───────────────────────
#
#     [this job]   pull-extension.sh keeps the on-disk fast-ext files current.
#           |
#           v
#     [extension]  its update check sees the new manifest "version" and calls
#                  chrome.runtime.reload().
#           |
#           v
#     [Chrome]     reload() re-reads the folder from disk (now the new files),
#                  so the tester moves to the new build with ZERO clicks.
#
# The ONLY manual step is the very first Load-unpacked (step c) — Chrome has no
# API to load an unpacked extension for you. Everything after is automatic.
# (Same contract & flow as install-tester.ps1 / pull-extension.ps1 on Windows —
# keep the two platforms in sync if you change the behavior.)
#
# ── Usage ────────────────────────────────────────────────────────────────────
#   bash scripts/install-tester.sh
#   bash scripts/install-tester.sh --interval-hours 2
#   bash scripts/install-tester.sh --uninstall --remove-files
#
# ── Flags (mirror the PowerShell -Params) ────────────────────────────────────
#   --ext-dir DIR        Where the unpacked extension lives / will live (Load
#                        unpacked points here). Default: "$HOME/.fastlink/extension".
#   --interval-hours N   How often the background pull runs (besides at-login).
#                        Default: 4. Minimum: 1.
#   --zip-url URL        Override the download URL (e.g. a release zip). Passed
#                        through to pull-extension.sh.
#   --name NAME          Job identifier base. Default: 'fastlink-autoupdate'.
#   --uninstall          Remove the timer/agent/cron job, then exit.
#   --remove-files       Only with --uninstall: also delete --ext-dir.
#   -h | --help          Show usage.

set -u

# ── defaults (mirror install-tester.ps1) ─────────────────────────────────────
EXT_DIR="${HOME}/.fastlink/extension"
INTERVAL_HOURS=4
ZIP_URL='https://github.com/Turetsky/fastlink/archive/refs/heads/main.zip'
JOB_NAME='fastlink-autoupdate'
UNINSTALL=0
REMOVE_FILES=0

usage() {
  cat <<'EOF'
install-tester.sh — one-time FastLink tester setup (macOS + Linux), no git required.
Downloads the extension once, then schedules a recurring background auto-pull
(systemd user timer / cron on Linux, launchd LaunchAgent on macOS).

Usage:
  bash scripts/install-tester.sh
  bash scripts/install-tester.sh --interval-hours 2
  bash scripts/install-tester.sh --uninstall --remove-files

Flags:
  --ext-dir DIR        Where the unpacked extension lives. Default: $HOME/.fastlink/extension
  --interval-hours N   Background pull cadence (besides at-login). Default: 4. Min: 1.
  --zip-url URL        Override the download URL (passed to pull-extension.sh).
  --name NAME          Job identifier base. Default: fastlink-autoupdate
  --uninstall          Remove the timer/agent/cron job, then exit.
  --remove-files       With --uninstall: also delete --ext-dir.
  -h | --help          Show this help.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ext-dir)        EXT_DIR="${2:-}"; shift 2 ;;
    --ext-dir=*)      EXT_DIR="${1#*=}"; shift ;;
    --interval-hours) INTERVAL_HOURS="${2:-}"; shift 2 ;;
    --interval-hours=*) INTERVAL_HOURS="${1#*=}"; shift ;;
    --zip-url)        ZIP_URL="${2:-}"; shift 2 ;;
    --zip-url=*)      ZIP_URL="${1#*=}"; shift ;;
    --name)           JOB_NAME="${2:-}"; shift 2 ;;
    --name=*)         JOB_NAME="${1#*=}"; shift ;;
    --uninstall)      UNINSTALL=1; shift ;;
    --remove-files)   REMOVE_FILES=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "install-tester.sh: unknown arg '$1' (try --help)" >&2; exit 1 ;;
  esac
done

# Clamp the interval like the PS installer does.
case "$INTERVAL_HOURS" in
  ''|*[!0-9]*) INTERVAL_HOURS=4 ;;
esac
[ "$INTERVAL_HOURS" -lt 1 ] && INTERVAL_HOURS=1
INTERVAL_SECONDS=$(( INTERVAL_HOURS * 3600 ))

# pull-extension.sh sits next to this installer.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PULL_SCRIPT="${SCRIPT_DIR}/pull-extension.sh"

OS="$(uname -s)"

# ── per-OS resource locations ────────────────────────────────────────────────
SYSTEMD_DIR="${HOME}/.config/systemd/user"
SERVICE_UNIT="${JOB_NAME}.service"
TIMER_UNIT="${JOB_NAME}.timer"
PLIST_LABEL="com.fastlink.${JOB_NAME}"
PLIST_PATH="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"
CRON_TAG="# ${JOB_NAME} (FastLink auto-update)"
LOG_PARENT="$(dirname "$EXT_DIR")"

step() { printf '\033[36m%s\033[0m\n' "$1"; }   # cyan, like Write-Step

have_systemd_user() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user show-environment >/dev/null 2>&1
}

# ── uninstall path ───────────────────────────────────────────────────────────
remove_cron() {
  command -v crontab >/dev/null 2>&1 || return 0
  # Drop our tag line and the command line that follows it.
  local cur
  cur="$(crontab -l 2>/dev/null)" || return 0
  printf '%s\n' "$cur" | grep -q -F "$CRON_TAG" || return 0
  printf '%s\n' "$cur" | grep -v -F "$CRON_TAG" | grep -v -F "$PULL_SCRIPT" | crontab - 2>/dev/null || true
  echo "  Removed cron entries tagged '$JOB_NAME'."
}

if [ "$UNINSTALL" -eq 1 ]; then
  step "Uninstalling FastLink auto-update ..."
  case "$OS" in
    Darwin)
      if [ -f "$PLIST_PATH" ]; then
        launchctl unload -w "$PLIST_PATH" 2>/dev/null || true
        rm -f "$PLIST_PATH"
        echo "  Removed LaunchAgent: $PLIST_PATH"
      else
        echo "  No LaunchAgent found at: $PLIST_PATH"
      fi
      ;;
    *)
      systemd_removed=0
      if [ -e "${SYSTEMD_DIR}/${TIMER_UNIT}" ] || [ -e "${SYSTEMD_DIR}/${SERVICE_UNIT}" ]; then
        if have_systemd_user; then
          systemctl --user disable --now "$TIMER_UNIT" 2>/dev/null || true
        fi
        rm -f "${SYSTEMD_DIR}/${TIMER_UNIT}" "${SYSTEMD_DIR}/${SERVICE_UNIT}"
        have_systemd_user && systemctl --user daemon-reload 2>/dev/null || true
        echo "  Removed systemd user timer + service '$JOB_NAME'."
        systemd_removed=1
      fi
      # Always also try cron, in case it was the fallback path used at install.
      remove_cron
      [ "$systemd_removed" -eq 0 ] && echo "  (No systemd user timer was present.)"
      ;;
  esac
  if [ "$REMOVE_FILES" -eq 1 ]; then
    if [ -d "$EXT_DIR" ]; then
      rm -rf "$EXT_DIR"
      echo "  Deleted extension folder: $EXT_DIR"
    fi
  else
    echo "  Left the extension folder in place: $EXT_DIR"
    echo "  (Re-run with --remove-files to delete it too.)"
  fi
  echo ""
  printf '\033[33m%s\033[0m\n' "Also remove FastLink from chrome://extensions to finish uninstalling."
  exit 0
fi

# ── preflight ────────────────────────────────────────────────────────────────
if [ ! -f "$PULL_SCRIPT" ]; then
  echo "ERROR: cannot find pull-extension.sh next to this installer (looked at '$PULL_SCRIPT'). Keep the two scripts together." >&2
  exit 1
fi
chmod +x "$PULL_SCRIPT" 2>/dev/null || true

echo ""
printf '\033[32m%s\033[0m\n' "FastLink tester setup"
echo "  Extension folder : $EXT_DIR"
echo "  Schedule         : at login + every ${INTERVAL_HOURS}h"
echo "  Worker script    : $PULL_SCRIPT"
echo "  OS               : $OS"
echo ""

# ── (a) populate the folder once ─────────────────────────────────────────────
step "[1/3] Downloading the extension for the first time ..."
bash "$PULL_SCRIPT" --ext-dir "$EXT_DIR" --zip-url "$ZIP_URL"
PULL_EXIT=$?
if [ "$PULL_EXIT" -ne 0 ] || [ ! -f "${EXT_DIR}/manifest.json" ]; then
  echo "ERROR: first download failed (pull-extension.sh exit $PULL_EXIT). Check your internet connection and re-run. The background job was NOT created." >&2
  exit 1
fi
echo "      Done — extension is in $EXT_DIR"
echo ""

# ── (b) register the recurring background job ────────────────────────────────
step "[2/3] Registering the background auto-update job ..."

register_systemd() {
  mkdir -p "$SYSTEMD_DIR"
  # oneshot service that runs the worker once per trigger.
  cat >"${SYSTEMD_DIR}/${SERVICE_UNIT}" <<EOF
[Unit]
Description=FastLink tester auto-pull (keeps the unpacked extension current from GitHub; no git)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash ${PULL_SCRIPT} --ext-dir ${EXT_DIR} --zip-url ${ZIP_URL}
EOF
  # Timer: fire shortly after the user manager starts (≈ login) and then every
  # N hours. Persistent=true runs a missed pull after the machine wakes/boots.
  cat >"${SYSTEMD_DIR}/${TIMER_UNIT}" <<EOF
[Unit]
Description=FastLink auto-pull timer (login + every ${INTERVAL_HOURS}h)

[Timer]
OnStartupSec=5min
OnUnitActiveSec=${INTERVAL_HOURS}h
Persistent=true
Unit=${SERVICE_UNIT}

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$TIMER_UNIT"
  echo "      Registered systemd user timer '$TIMER_UNIT' (login + every ${INTERVAL_HOURS}h)."
  echo "      Tip: 'systemctl --user list-timers' shows the next run; logs: journalctl --user -u ${SERVICE_UNIT}"
  echo "      (If pulls should keep running while you're logged out: 'loginctl enable-linger \$USER'.)"
}

register_cron() {
  command -v crontab >/dev/null 2>&1 || return 1
  local cmd cur
  cmd="/usr/bin/env bash ${PULL_SCRIPT} --ext-dir ${EXT_DIR} --zip-url ${ZIP_URL}"
  cur="$(crontab -l 2>/dev/null || true)"
  # Strip any prior FastLink lines so re-running is idempotent.
  cur="$(printf '%s\n' "$cur" | grep -v -F "$CRON_TAG" | grep -v -F "$PULL_SCRIPT")"
  {
    printf '%s\n' "$cur" | sed '/^$/d'
    printf '%s\n' "$CRON_TAG"
    # @reboot ≈ "at login/boot"; the hourly line gives the every-N-hours cadence.
    printf '%s\n' "@reboot ${cmd}"
    printf '0 */%s * * * %s\n' "$INTERVAL_HOURS" "$cmd"
  } | crontab -
  echo "      Registered cron entries (@reboot + every ${INTERVAL_HOURS}h)."
  return 0
}

register_launchd() {
  mkdir -p "${HOME}/Library/LaunchAgents"
  # RunAtLoad fires at login; StartInterval repeats every N hours. launchd has no
  # cron-style "missed while asleep" replay, but it runs on the next wake.
  cat >"$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${PULL_SCRIPT}</string>
        <string>--ext-dir</string>
        <string>${EXT_DIR}</string>
        <string>--zip-url</string>
        <string>${ZIP_URL}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>${INTERVAL_SECONDS}</integer>
    <key>StandardOutPath</key>
    <string>${LOG_PARENT}/pull-extension.launchd.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_PARENT}/pull-extension.launchd.log</string>
</dict>
</plist>
EOF
  # Reload cleanly so re-running the installer updates an existing agent.
  launchctl unload -w "$PLIST_PATH" 2>/dev/null || true
  launchctl load -w "$PLIST_PATH"
  echo "      Registered LaunchAgent '$PLIST_LABEL' (login + every ${INTERVAL_HOURS}h)."
  echo "      Plist: $PLIST_PATH"
}

case "$OS" in
  Darwin)
    register_launchd
    ;;
  Linux|*)
    if have_systemd_user; then
      register_systemd
    elif register_cron; then
      :
    else
      echo "ERROR: neither a systemd user instance nor crontab is available — cannot schedule the background pull." >&2
      echo "       The extension folder was still downloaded; you can re-run pull-extension.sh manually or add your own scheduler." >&2
      exit 1
    fi
    ;;
esac
echo ""

# ── (c) one-time Load-unpacked instructions ──────────────────────────────────
step "[3/3] ONE-TIME manual step — load the extension in Chrome:"
echo ""
echo "  1. Open Chrome and go to:  chrome://extensions"
echo "  2. Turn ON 'Developer mode' (toggle, top-right)."
echo "  3. Click 'Load unpacked'."
echo "  4. Select this folder:"
echo "       $EXT_DIR"
echo ""
echo "  That's it. Chrome shows a 'Developer mode extensions' note because the"
echo "  extension isn't from the Web Store — that's expected and harmless."
echo ""
printf '\033[32m%s\033[0m\n' "You're done. From now on updates download in the background and the"
printf '\033[32m%s\033[0m\n' "extension reloads itself — you never touch chrome://extensions again."
echo ""
echo "To undo everything later:  bash scripts/install-tester.sh --uninstall --remove-files"
