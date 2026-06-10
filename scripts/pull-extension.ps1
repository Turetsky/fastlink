<#
.SYNOPSIS
  FastLink tester auto-pull — keeps an unpacked extension folder current from
  GitHub, with NO git required. This is the WORKER that the Scheduled Task runs.

.DESCRIPTION
  This is the "keep the disk fresh" half of FastLink's no-click self-update.
  The pairing works like this:

      [this task]  pull-extension.ps1 downloads the latest fast-ext from GitHub
                   and atomically swaps it into the loaded extension folder.
            |
            v
      [extension]  updateCheck.js (inside the service worker) notices the new
                   manifest "version" on its periodic check and calls
                   chrome.runtime.reload().
            |
            v
      [Chrome]     reload() re-reads the extension folder from disk — which now
                   holds the new files this task just wrote — so the tester ends
                   up on the new build with ZERO clicks.

  So this script never touches Chrome. Its ONLY job is to make the on-disk files
  current and intact. The extension + Chrome do the reload.

  Steps:
    1. Download the repo zip from GitHub (Invoke-WebRequest) to a temp file.
    2. Expand it to a temp dir and locate `fast-ext` inside.
    3. Compare the downloaded manifest "version" with what's already installed.
       If they match (and -Force isn't given), SKIP the swap — nothing changed.
    4. Otherwise ATOMICALLY swap the new `fast-ext` into -ExtDir: stage the new
       files in a sibling folder, then rename old out / new in (a sub-second
       directory rename), so Chrome never sees a half-written folder.
    5. Log everything to a file. Any network/extract failure leaves the existing
       extension folder completely intact.

.PARAMETER ExtDir
  The unpacked-extension folder Chrome loads (Load unpacked points here).
  Default: "$env:USERPROFILE\FastLink\extension".

.PARAMETER ZipUrl
  The repo zip to download. Default: the `main` branch zipball. You can point this
  at a release zip instead, e.g.
  'https://github.com/Turetsky/fastlink/archive/refs/tags/v0.5.0.zip'.

.PARAMETER LogFile
  Where to append run logs. Default: "<ExtDir's parent>\pull-extension.log".

.PARAMETER Force
  Swap even if the downloaded version matches the installed one.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\pull-extension.ps1

.EXAMPLE
  .\pull-extension.ps1 -ExtDir 'D:\FastLink\extension' -Force

.NOTES
  No git, no Node, no admin rights required — just Windows PowerShell 5.1+
  (ships with Windows 10/11). See docs\TESTER-INSTALL.md.
#>
param(
  [string]$ExtDir  = (Join-Path $env:USERPROFILE 'FastLink\extension'),
  [string]$ZipUrl  = 'https://github.com/Turetsky/fastlink/archive/refs/heads/main.zip',
  [string]$LogFile = '',
  [switch]$Force
)

# Non-terminating errors stop so our try/catch blocks actually catch them; we
# handle every failure explicitly so a transient network blip can never corrupt
# the installed folder.
$ErrorActionPreference = 'Stop'

# ---- logging ----------------------------------------------------------------
if (-not $LogFile) {
  $parent = Split-Path -Parent $ExtDir
  if (-not $parent) { $parent = $env:TEMP }
  $LogFile = Join-Path $parent 'pull-extension.log'
}
# Make sure the log's directory exists so the first write can't fail.
$logDir = Split-Path -Parent $LogFile
if ($logDir -and -not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-Log {
  param([string]$Message, [string]$Level = 'INFO')
  $line = ('{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message)
  Write-Host $line
  try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
}

# Read the "version" field from a manifest.json without choking on a missing or
# malformed file. Returns $null when it can't be read.
function Get-ManifestVersion {
  param([string]$ManifestPath)
  if (-not (Test-Path $ManifestPath)) { return $null }
  try {
    $json = Get-Content -Path $ManifestPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    return [string]$json.version
  } catch {
    return $null
  }
}

# ---- workspace + swap target paths -----------------------------------------
# Unique temp workspace for this run (cleaned up in finally).
$tmpRoot  = Join-Path $env:TEMP ('fastlink-pull-' + [Guid]::NewGuid().ToString('N'))
$zipPath  = Join-Path $tmpRoot 'repo.zip'
$unzipDir = Join-Path $tmpRoot 'unzipped'

# Sibling staging + backup folders live NEXT TO $ExtDir (same volume) so the
# final swap is a fast directory rename rather than a cross-volume copy.
$ExtParent = Split-Path -Parent $ExtDir
$ExtLeaf   = Split-Path -Leaf $ExtDir
$staging   = if ($ExtParent) { Join-Path $ExtParent ($ExtLeaf + '.new-' + $PID) } else { $null }
$backup    = if ($ExtParent) { Join-Path $ExtParent ($ExtLeaf + '.old-' + $PID) } else { $null }

# Main worker. Returns a process exit code (0 = success/up-to-date).
function Invoke-Pull {
  Write-Log "=== pull-extension start ==="
  Write-Log "ExtDir : $ExtDir"
  Write-Log "ZipUrl : $ZipUrl"

  if (-not $ExtParent) {
    Write-Log "ExtDir '$ExtDir' has no parent directory — pass an absolute path." 'ERROR'
    return 1
  }

  New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null

  # ---- 1. download ----------------------------------------------------------
  Write-Log "[1/4] Downloading repo zip ..."
  try {
    # Force TLS 1.2 for older Windows PowerShell defaults; GitHub requires it.
    [Net.ServicePointManager]::SecurityProtocol = `
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }
  try {
    Invoke-WebRequest -Uri $ZipUrl -OutFile $zipPath -UseBasicParsing -ErrorAction Stop
  } catch {
    Write-Log "Download failed: $($_.Exception.Message)" 'ERROR'
    Write-Log "Leaving the existing extension folder untouched." 'WARN'
    return 2
  }
  $zipSize = (Get-Item $zipPath).Length
  Write-Log "      Downloaded $zipSize bytes."

  # ---- 2. extract + locate fast-ext -----------------------------------------
  Write-Log "[2/4] Extracting ..."
  try {
    Expand-Archive -Path $zipPath -DestinationPath $unzipDir -Force -ErrorAction Stop
  } catch {
    Write-Log "Extract failed (corrupt/partial download?): $($_.Exception.Message)" 'ERROR'
    Write-Log "Leaving the existing extension folder untouched." 'WARN'
    return 3
  }

  # The zip expands to a top folder like 'fastlink-main\'. Don't hardcode it —
  # find the first 'fast-ext' folder that actually carries a manifest.json.
  $newExt = Get-ChildItem -Path $unzipDir -Recurse -Directory -Filter 'fast-ext' -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName 'manifest.json') } |
            Select-Object -First 1
  if (-not $newExt) {
    Write-Log "No fast-ext/manifest.json found in the downloaded zip — aborting." 'ERROR'
    Write-Log "Leaving the existing extension folder untouched." 'WARN'
    return 4
  }
  $newExtPath = $newExt.FullName

  # ---- 3. version compare (skip if unchanged) -------------------------------
  $newVer = Get-ManifestVersion (Join-Path $newExtPath 'manifest.json')
  $curVer = Get-ManifestVersion (Join-Path $ExtDir     'manifest.json')
  $curShown = if ($curVer) { $curVer } else { '(none)' }
  $newShown = if ($newVer) { $newVer } else { '(unknown)' }
  Write-Log "[3/4] Installed version: $curShown | downloaded: $newShown"

  if (-not $newVer) {
    Write-Log "Downloaded manifest has no readable version — aborting to be safe." 'ERROR'
    return 5
  }
  if ($curVer -and ($curVer -eq $newVer) -and -not $Force) {
    Write-Log "Already up to date ($curVer) — skipping swap. (Use -Force to override.)"
    return 0
  }

  # ---- 4. atomic swap -------------------------------------------------------
  Write-Log "[4/4] Swapping in $newVer ..."

  # Make sure the parent exists (first-ever install) and clear stale temp dirs.
  if (-not (Test-Path $ExtParent)) { New-Item -ItemType Directory -Path $ExtParent -Force | Out-Null }
  foreach ($p in @($staging, $backup)) {
    if (Test-Path $p) { Remove-Item -Path $p -Recurse -Force -ErrorAction SilentlyContinue }
  }

  # Stage the new files in a sibling folder FIRST (Chrome never sees this name).
  Copy-Item -Path $newExtPath -Destination $staging -Recurse -Force -ErrorAction Stop

  # Guard: confirm the staged copy is sane before we touch the live folder.
  if (-not (Test-Path (Join-Path $staging 'manifest.json'))) {
    Write-Log "Staged copy is missing manifest.json — aborting swap (live folder untouched)." 'ERROR'
    return 6
  }

  # The swap below is a pair of directory renames — sub-second, so Chrome never
  # reads a partially written folder. On any failure we roll back.
  $hadOld = $false
  try {
    if (Test-Path $ExtDir) {
      Rename-Item -Path $ExtDir -NewName (Split-Path -Leaf $backup) -ErrorAction Stop
      $hadOld = $true
    }
    Rename-Item -Path $staging -NewName $ExtLeaf -ErrorAction Stop
  } catch {
    Write-Log "Swap failed mid-rename: $($_.Exception.Message)" 'ERROR'
    # Roll back: if we moved the old folder aside but couldn't put the new one
    # in place, restore the original so the tester is never left with nothing.
    if ($hadOld -and -not (Test-Path $ExtDir) -and (Test-Path $backup)) {
      try {
        Rename-Item -Path $backup -NewName $ExtLeaf -ErrorAction Stop
        Write-Log "Rolled back to the previous extension folder." 'WARN'
      } catch {
        Write-Log "ROLLBACK FAILED — previous folder is at: $backup" 'ERROR'
      }
    }
    return 7
  }

  # Success — drop the old copy.
  if (Test-Path $backup) { Remove-Item -Path $backup -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Log "Swapped to $newVer. The extension's update check will reload Chrome onto it."
  return 0
}

# ---- run + always clean up --------------------------------------------------
$exitCode = 1
try {
  $exitCode = Invoke-Pull
}
catch {
  Write-Log "Unexpected error: $($_.Exception.Message)" 'ERROR'
  $exitCode = 1
}
finally {
  # Always clean up the temp workspace + any leftover staging/backup folders.
  foreach ($p in @($tmpRoot, $staging, $backup)) {
    if ($p -and (Test-Path $p)) { Remove-Item -Path $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Write-Log "=== pull-extension end (exit $exitCode) ==="
}

exit $exitCode
