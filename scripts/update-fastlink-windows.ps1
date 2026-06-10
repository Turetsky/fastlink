<#
.SYNOPSIS
  FastLink updater for a PURE-WINDOWS machine (no WSL) — "dad" setup.

.DESCRIPTION
  Use this when the FastLink repo is cloned on Windows and Chrome loads the
  extension DIRECTLY from the repo's `fast-ext` folder (Load unpacked ->
  ...\fastlink\fast-ext). Because Chrome reads that folder in place, a plain
  `git pull` is enough to update the extension files — you then just reload at
  chrome://extensions.

  This is DISTINCT from update-fastlink.ps1, which drives a WSL-hosted repo,
  mirrors fast-ext into a separate Windows copy, and restarts the WSL distro.
  This script touches NO WSL.

  Steps:
    1. git pull --ff-only in the repo (-RepoPath).
    2. If fast-dxt's package*.json changed in that pull, run `npm install` there
       (best-effort; skipped silently if npm or Node isn't installed).
    3. Print reminders to reload the extension at chrome://extensions and, if the
       MCP server runs standalone, to restart it / re-run `claude`.

.PARAMETER RepoPath
  Path to the cloned FastLink repo. Default: the repo this script lives in
  (its own parent-of-parent dir). Override if you run the script from elsewhere.

.PARAMETER SkipNpm
  Skip the fast-dxt `npm install` step entirely.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\update-fastlink-windows.ps1

.EXAMPLE
  .\update-fastlink-windows.ps1 -RepoPath 'C:\Users\dad\fastlink'

.NOTES
  Chrome cannot silently reload an unpacked extension — the manual reload in
  step 3 is required. See docs\AUTO-UPDATE.md.
#>
param(
  [string]$RepoPath = '',
  [switch]$SkipNpm
)

$ErrorActionPreference = 'Stop'

# ---- Resolve the repo path --------------------------------------------------
if (-not $RepoPath) {
  # This script is at <repo>\scripts\update-fastlink-windows.ps1, so the repo
  # root is the parent of $PSScriptRoot.
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

$ExtPath = Join-Path $RepoPath 'fast-ext'
$DxtPath = Join-Path $RepoPath 'fast-dxt'
Write-Host "Repo:       $RepoPath"
Write-Host "Extension:  $ExtPath  (Chrome should load THIS folder unpacked)"
Write-Host ""

# Helper: run git in the repo and surface failures.
function Invoke-Git {
  param([string[]]$GitArgs)
  & git -C $RepoPath @GitArgs
  if ($LASTEXITCODE -ne 0) {
    throw "git $($GitArgs -join ' ') failed (exit $LASTEXITCODE)."
  }
}

# ---- 1. git pull ------------------------------------------------------------
Write-Host "[1/3] Pulling latest (fast-forward only) ..."
$before = (& git -C $RepoPath rev-parse HEAD 2>$null)
try {
  Invoke-Git @('pull', '--ff-only')
} catch {
  Write-Error "git pull --ff-only failed. You may have local changes or a diverged branch.`n$_"
  exit 1
}
$after = (& git -C $RepoPath rev-parse HEAD 2>$null)

if ($before -eq $after) {
  Write-Host "      Already up to date ($after)."
} else {
  Write-Host "      Updated: $before -> $after"
}

# ---- 2. npm install for fast-dxt (only if its deps changed) -----------------
Write-Host "[2/3] Checking fast-dxt dependencies ..."
if ($SkipNpm) {
  Write-Host "      -SkipNpm given — skipping."
} elseif (-not (Test-Path $DxtPath)) {
  Write-Host "      No fast-dxt folder — skipping."
} else {
  $depsChanged = $false
  if ($before -and $after -and $before -ne $after) {
    $changed = (& git -C $RepoPath diff --name-only $before $after -- `
                  'fast-dxt/package.json' 'fast-dxt/package-lock.json')
    if ($changed) { $depsChanged = $true }
  }
  if (-not $depsChanged) {
    Write-Host "      Unchanged — skipping npm install."
  } elseif (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Warning "      Dependencies changed but npm isn't installed — skipping."
    Write-Warning "      If the MCP server runs here, install Node.js and run 'npm install' in $DxtPath."
  } else {
    Write-Host "      Dependencies changed — running npm install (best-effort) ..."
    Push-Location $DxtPath
    try {
      & npm install --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { Write-Warning "npm install exited $LASTEXITCODE (continuing)." }
    } catch {
      Write-Warning "npm install failed (continuing): $_"
    } finally {
      Pop-Location
    }
  }
}

# ---- 3. Reminders -----------------------------------------------------------
Write-Host ""
Write-Host "[3/3] Done. Next steps:" -ForegroundColor Green
Write-Host "  1. Open chrome://extensions and click the reload arrow on FastLink."
Write-Host "     (Chrome cannot reload an unpacked extension on its own.)"
Write-Host "  2. If the MCP server runs standalone here, restart it / re-run 'claude'"
Write-Host "     so it picks up the new server code."
Write-Host ""
