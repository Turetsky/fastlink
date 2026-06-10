<#
.SYNOPSIS
  FastLink AV-SAFE updater (Windows) — pure `git pull`, nothing else.

.DESCRIPTION
  WHY THIS EXISTS
  ---------------
  On machines with endpoint protection (Bitdefender, Microsoft Defender, other
  EDR), the standard tester auto-update path — scripts\pull-extension.ps1 — gets
  blocked or quarantined. That script does exactly the things AV heuristics flag:
  it downloads a zip from the internet (Invoke-WebRequest), swaps files into a
  browser-extension folder, and the installer registers a Scheduled Task. To an
  EDR that pattern reads like a dropper/persistence chain.

  `git`, by contrast, is a signed, whitelisted, trusted developer tool. A plain
  `git pull` over HTTPS does NOT trip AV. So for locked-down machines we use a
  different shape entirely:

      - Chrome loads the extension UNPACKED straight from this repo's `fast-ext`
        folder (Load unpacked -> ...\fastlink\fast-ext), so the on-disk files
        Chrome reads ARE the repo's files.
      - `git pull --ff-only` updates those files IN PLACE — no zip, no download
        of an archive, no copy/swap, no Scheduled Task. AV has nothing to flag.
      - On the next release version bump the extension self-reloads (that's
        Chrome's own runtime.reload() behavior, triggered from inside the
        service worker — it is AV-immune; no external process touches Chrome).

  So this script does ONLY a fast-forward git pull and then prints a short
  reminder. That is the whole point: keep the footprint to a single trusted
  command. It pairs with docs\INSTALL-MANAGED-MACHINE.md.

  It is deliberately MORE minimal than update-fastlink-windows.ps1 — no npm
  step, no WSL, no version compare. Pure git, so it can also be dropped into an
  existing login script or `claude` wrapper via the -Quiet flag.

.PARAMETER RepoPath
  Path to the cloned FastLink repo. Default: the repo this script lives in (the
  parent of the scripts\ folder). Override if you run the script from elsewhere.

.PARAMETER Quiet
  Suppress normal output (errors still print). Lets this drop into a login
  script / `claude` wrapper without adding noise.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\update-extension-git.ps1

.EXAMPLE
  .\update-extension-git.ps1 -RepoPath 'C:\Users\dad\fastlink' -Quiet

.NOTES
  Pure git. No download, no file-swap, no Invoke-WebRequest, no Scheduled Task.
  See docs\INSTALL-MANAGED-MACHINE.md.
#>
param(
  [string]$RepoPath = '',
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

# Quiet-aware writer. Errors/warnings always print; normal lines obey -Quiet.
function Say {
  param([string]$Message, [string]$Color = '')
  if ($Quiet) { return }
  if ($Color) { Write-Host $Message -ForegroundColor $Color }
  else { Write-Host $Message }
}

# ---- Resolve the repo path --------------------------------------------------
if (-not $RepoPath) {
  # This script is at <repo>\scripts\update-extension-git.ps1, so the repo root
  # is the parent of $PSScriptRoot.
  if ($PSScriptRoot) { $RepoPath = Split-Path -Parent $PSScriptRoot }
}
if (-not $RepoPath -or -not (Test-Path $RepoPath)) {
  Write-Error "FastLink repo not found at '$RepoPath'. Pass -RepoPath <path to the clone>."
  exit 1
}
$RepoPath = (Resolve-Path $RepoPath).Path

if (-not (Test-Path (Join-Path $RepoPath '.git'))) {
  Write-Error "'$RepoPath' is not a git clone (no .git). Pass -RepoPath <path to the clone>."
  exit 1
}

# git itself must be present — that's the entire (trusted) toolchain here.
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Error "git is not installed / not on PATH. Install Git for Windows, then re-run."
  exit 1
}

$ExtPath = Join-Path $RepoPath 'fast-ext'
Say "Repo:       $RepoPath"
Say "Extension:  $ExtPath  (Chrome should load THIS folder unpacked)"
Say ""

# ---- Fail gracefully on a dirty tree (don't clobber local changes) ----------
# A fast-forward pull would fail on a dirty tree anyway; detect it first so we
# can print a clear message instead of a raw git error.
$status = (& git -C $RepoPath status --porcelain 2>$null)
if ($LASTEXITCODE -eq 0 -and $status) {
  Write-Warning "The repo has local changes (dirty working tree) at $RepoPath."
  Write-Warning "Refusing to pull so your changes aren't clobbered."
  Write-Warning "Commit/stash them (or 'git -C `"$RepoPath`" checkout -- .' to discard), then re-run."
  exit 1
}

# ---- git pull (fast-forward only) -------------------------------------------
Say "Pulling latest (fast-forward only) ..."
$before = (& git -C $RepoPath rev-parse HEAD 2>$null)

& git -C $RepoPath pull --ff-only
if ($LASTEXITCODE -ne 0) {
  Write-Warning "git pull --ff-only failed."
  Write-Warning "Likely a diverged branch (local commits the remote doesn't have)."
  Write-Warning "Resolve by hand: cd '$RepoPath'; git status; git log --oneline -5"
  exit 1
}

$after = (& git -C $RepoPath rev-parse HEAD 2>$null)

if ($before -eq $after) {
  Say "Already up to date ($after)."
} else {
  Say "Updated: $before -> $after"
}

# ---- Reminder ---------------------------------------------------------------
Say ""
Say "Done." 'Green'
Say "The extension files are now current: Chrome loads unpacked straight from"
Say "  $ExtPath"
Say "so this pull updated them in place. To apply now, open chrome://extensions"
Say "and click the reload arrow on FastLink. Otherwise it self-reloads on the"
Say "next release version bump."
Say ""
exit 0
