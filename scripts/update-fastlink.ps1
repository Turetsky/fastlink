<#
.SYNOPSIS
  FastLink updater — pulls the latest code in the WSL repo, syncs the Chrome
  extension to its Windows copy, and restarts WSL + the broker.

.DESCRIPTION
  Run this from WINDOWS PowerShell (NOT inside WSL). The Node broker / MCP server
  lives in WSL; the update is driven from the Windows side because it restarts the
  whole WSL distro (mirrors restart-wsl.bat).

  Steps:
    1. git pull --ff-only in the WSL repo.
    2. npm install for fast-dxt if its package*.json changed (best-effort).
    3. Sync fast-ext/ -> the Windows extension copy (robocopy /MIR).
    4. Restart WSL (wsl --shutdown, brief wait, relaunch).
    5. Print reminders to reload the extension + run `claude --resume`.

  All paths are PARAMETERIZED with sensible, non-personal defaults — nothing here
  hardcodes a username or home directory.

.PARAMETER RepoPath
  WSL path to the FastLink repo. Default: auto-detected from this script's own
  location, falling back to '~/code/Fastlink'. (Avoid paths with spaces, or pass
  an already-expanded absolute path.)

.PARAMETER ExtDest
  Windows directory Chrome loads the unpacked extension from.
  Default: "$env:USERPROFILE\FastLink\extension".

.PARAMETER Distro
  WSL distro name (passed to `wsl -d`). Default: the system default distro.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\update-fastlink.ps1

.EXAMPLE
  .\update-fastlink.ps1 -RepoPath '~/code/Fastlink' -ExtDest 'D:\FastLink\extension'
#>
param(
  [string]$RepoPath = '',
  [string]$ExtDest  = (Join-Path $env:USERPROFILE 'FastLink\extension'),
  [string]$Distro   = ''
)

$ErrorActionPreference = 'Continue'

# Optional `-d <distro>` prefix for every wsl call.
$DistroArgs = @()
if ($Distro) { $DistroArgs = @('-d', $Distro) }

# Run a bash command in the WSL repo's distro (login shell so node/npm are on PATH).
function Invoke-Wsl([string]$BashCommand) {
  & wsl @DistroArgs -e bash -lc $BashCommand
}

# ---- Resolve the repo path -------------------------------------------------
if (-not $RepoPath) {
  try {
    # The repo root is this script's parent dir; convert that Windows-visible path
    # to a WSL path when possible (works when run from the \\wsl.localhost share).
    $winParent = Split-Path -Parent $PSScriptRoot
    if ($winParent) {
      $cand = (& wsl @DistroArgs wslpath -u "$winParent" 2>$null)
      if ($LASTEXITCODE -eq 0 -and $cand) { $RepoPath = ($cand | Select-Object -First 1).Trim() }
    }
  } catch { }
  if (-not $RepoPath) { $RepoPath = '~/code/Fastlink' }
}

# Expand (~) + canonicalize to an absolute WSL path so later quoting is safe.
$RepoAbs = (Invoke-Wsl "cd $RepoPath 2>/dev/null && pwd")
if ($LASTEXITCODE -ne 0 -or -not $RepoAbs) {
  Write-Error "Could not find the FastLink repo at '$RepoPath'. Pass -RepoPath <wsl path>."
  exit 1
}
$RepoAbs = ($RepoAbs | Select-Object -First 1).Trim()
Write-Host "Repo (WSL):       $RepoAbs"
Write-Host "Extension (Win):  $ExtDest"
Write-Host ""

# ---- 1. git pull -----------------------------------------------------------
$before = (Invoke-Wsl "cd '$RepoAbs' && git rev-parse HEAD 2>/dev/null")
if ($before) { $before = ($before | Select-Object -First 1).Trim() }
Write-Host "[1/5] Pulling latest ..."
Invoke-Wsl "cd '$RepoAbs' && git pull --ff-only"
$after = (Invoke-Wsl "cd '$RepoAbs' && git rev-parse HEAD 2>/dev/null")
if ($after) { $after = ($after | Select-Object -First 1).Trim() }

# ---- 2. npm install for fast-dxt (only if its deps changed) -----------------
Write-Host "[2/5] Checking fast-dxt dependencies ..."
$depsChanged = $false
if ($before -and $after -and $before -ne $after) {
  $changed = (Invoke-Wsl "cd '$RepoAbs' && git diff --name-only '$before' '$after' -- fast-dxt/package.json fast-dxt/package-lock.json")
  if ($changed) { $depsChanged = $true }
}
if ($depsChanged) {
  Write-Host "      Dependencies changed — running npm install (best-effort) ..."
  try { Invoke-Wsl "cd '$RepoAbs/fast-dxt' && npm install --no-audit --no-fund" }
  catch { Write-Warning "npm install failed (continuing): $_" }
} else {
  Write-Host "      Unchanged — skipping npm install."
}

# ---- 3. Sync fast-ext/ -> the Windows extension copy ------------------------
Write-Host "[3/5] Syncing extension to Windows ..."
$ExtSrcWin = (Invoke-Wsl "wslpath -w '$RepoAbs/fast-ext'")
if ($LASTEXITCODE -ne 0 -or -not $ExtSrcWin) {
  Write-Error "Could not resolve a Windows path for '$RepoAbs/fast-ext'."
  exit 1
}
$ExtSrcWin = ($ExtSrcWin | Select-Object -First 1).Trim()
if (-not (Test-Path $ExtDest)) { New-Item -ItemType Directory -Path $ExtDest -Force | Out-Null }
# /MIR makes the dest an exact mirror of the source (clean reload).
robocopy $ExtSrcWin $ExtDest /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Warning "robocopy reported errors (exit $LASTEXITCODE)." }
$global:LASTEXITCODE = 0   # robocopy uses 0-7 for success; normalize so $? is clean

# ---- 4. Restart WSL + broker -----------------------------------------------
Write-Host "[4/5] Restarting WSL ..."
& wsl --shutdown
Start-Sleep -Seconds 8
& wsl @DistroArgs -e true   # bring the distro back up

# ---- 5. Reminders ----------------------------------------------------------
Write-Host ""
Write-Host "[5/5] Done. Next steps:" -ForegroundColor Green
Write-Host "  1. Reload the FastLink extension at chrome://extensions (click the reload arrow)."
Write-Host "  2. Reopen your WSL terminal and run: claude --resume   (the broker auto-starts)."
Write-Host ""
