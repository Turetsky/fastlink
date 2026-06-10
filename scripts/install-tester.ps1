<#
.SYNOPSIS
  One-time FastLink tester setup — populates the extension folder and schedules a
  background auto-pull so it stays current. NO git, no Node, no admin needed.

.DESCRIPTION
  Run this ONCE. It:

    (a) runs pull-extension.ps1 to download the current extension into -ExtDir;
    (b) registers a Windows Scheduled Task that re-runs pull-extension.ps1 at
        logon AND every few hours, so the folder keeps itself current in the
        background;
    (c) prints the one-time "Load unpacked" steps for Chrome.

  HOW THE NO-CLICK UPDATE WORKS (why this is enough):

      [this task]   pull-extension.ps1 keeps the on-disk fast-ext files current.
            |
            v
      [extension]   its update check sees the new manifest "version" and calls
                    chrome.runtime.reload().
            |
            v
      [Chrome]      reload() re-reads the folder from disk (now the new files),
                    so the tester moves to the new build with ZERO clicks.

  The ONLY manual step is the very first Load-unpacked (step c) — Chrome has no
  API to load an unpacked extension for you. Everything after is automatic.

.PARAMETER ExtDir
  Where the unpacked extension lives / will live. This is the folder you point
  Chrome's "Load unpacked" at. Default: "$env:USERPROFILE\FastLink\extension".

.PARAMETER TaskName
  Scheduled Task name. Default: 'FastLink Auto-Update'.

.PARAMETER IntervalHours
  How often the background pull runs (in addition to at-logon). Default: 4.

.PARAMETER ZipUrl
  Override the download URL (e.g. a release zip). Passed through to
  pull-extension.ps1. Default: the repo's main-branch zip.

.PARAMETER Uninstall
  Remove the Scheduled Task (and, with -RemoveFiles, the extension folder too),
  then exit. Use this to undo everything this installer set up.

.PARAMETER RemoveFiles
  Only meaningful with -Uninstall: also delete -ExtDir.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-tester.ps1

.EXAMPLE
  .\install-tester.ps1 -IntervalHours 2

.EXAMPLE
  .\install-tester.ps1 -Uninstall -RemoveFiles

.NOTES
  Runs as the current user with the Interactive logon type, so no password is
  stored and no admin elevation is required. See docs\TESTER-INSTALL.md.
#>
param(
  [string]$ExtDir        = (Join-Path $env:USERPROFILE 'FastLink\extension'),
  [string]$TaskName      = 'FastLink Auto-Update',
  [int]$IntervalHours    = 4,
  [string]$ZipUrl        = 'https://github.com/Turetsky/fastlink/archive/refs/heads/main.zip',
  [switch]$Uninstall,
  [switch]$RemoveFiles
)

$ErrorActionPreference = 'Stop'

# pull-extension.ps1 sits next to this installer.
$PullScript = Join-Path $PSScriptRoot 'pull-extension.ps1'

function Write-Step { param([string]$Msg) Write-Host $Msg -ForegroundColor Cyan }

# ---- Uninstall path ---------------------------------------------------------
if ($Uninstall) {
  Write-Step "Uninstalling FastLink auto-update ..."
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "  Removed Scheduled Task '$TaskName'."
  } else {
    Write-Host "  No Scheduled Task named '$TaskName' was found."
  }
  if ($RemoveFiles) {
    if (Test-Path $ExtDir) {
      Remove-Item -Path $ExtDir -Recurse -Force -ErrorAction SilentlyContinue
      Write-Host "  Deleted extension folder: $ExtDir"
    }
  } else {
    Write-Host "  Left the extension folder in place: $ExtDir"
    Write-Host "  (Re-run with -RemoveFiles to delete it too.)"
  }
  Write-Host ""
  Write-Host "Also remove FastLink from chrome://extensions to finish uninstalling." -ForegroundColor Yellow
  exit 0
}

# ---- Preflight --------------------------------------------------------------
if (-not (Test-Path $PullScript)) {
  Write-Error "Cannot find pull-extension.ps1 next to this installer (looked at '$PullScript'). Keep the two scripts together."
  exit 1
}
if ($IntervalHours -lt 1) { $IntervalHours = 1 }

# Full path to Windows PowerShell so the task doesn't depend on PATH.
$PowerShellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $PowerShellExe)) { $PowerShellExe = 'powershell.exe' }

Write-Host ""
Write-Host "FastLink tester setup" -ForegroundColor Green
Write-Host "  Extension folder : $ExtDir"
Write-Host "  Scheduled Task   : $TaskName  (at logon + every $IntervalHours h)"
Write-Host "  Worker script    : $PullScript"
Write-Host ""

# ---- (a) populate the folder once ------------------------------------------
Write-Step "[1/3] Downloading the extension for the first time ..."
& $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $PullScript -ExtDir $ExtDir -ZipUrl $ZipUrl
$pullExit = $LASTEXITCODE
if ($pullExit -ne 0 -or -not (Test-Path (Join-Path $ExtDir 'manifest.json'))) {
  Write-Error "First download failed (pull-extension.ps1 exit $pullExit). Check your internet connection and re-run. The Scheduled Task was NOT created."
  exit 1
}
Write-Host "      Done — extension is in $ExtDir"
Write-Host ""

# ---- (b) register the background Scheduled Task -----------------------------
Write-Step "[2/3] Registering the background auto-update task ..."

# The task runs the worker hidden, with no profile, bypassing execution policy.
$argLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -ExtDir "{1}" -ZipUrl "{2}"' -f `
  $PullScript, $ExtDir, $ZipUrl
$action = New-ScheduledTaskAction -Execute $PowerShellExe -Argument $argLine

# Two triggers: once at logon, and a repeating timer every $IntervalHours.
$trigLogon = New-ScheduledTaskTrigger -AtLogOn
$trigRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
                -RepetitionInterval (New-TimeSpan -Hours $IntervalHours) `
                -RepetitionDuration (New-TimeSpan -Days 3650)

# Run as the current user, only when logged on — no stored password, no admin.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
               -LogonType Interactive -RunLevel Limited

# Survive battery/sleep, run a missed instance when the PC wakes, never pile up.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
              -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action `
  -Trigger @($trigLogon, $trigRepeat) -Principal $principal -Settings $settings `
  -Description 'Keeps the unpacked FastLink Chrome extension current from GitHub (no git required).' `
  -Force | Out-Null

Write-Host "      Registered '$TaskName' (at logon + every $IntervalHours h)."
Write-Host ""

# ---- (c) one-time Load-unpacked instructions --------------------------------
Write-Step "[3/3] ONE-TIME manual step — load the extension in Chrome:"
Write-Host ""
Write-Host "  1. Open Chrome and go to:  chrome://extensions"
Write-Host "  2. Turn ON 'Developer mode' (toggle, top-right)."
Write-Host "  3. Click 'Load unpacked'."
Write-Host "  4. Select this folder:"
Write-Host "       $ExtDir" -ForegroundColor White
Write-Host ""
Write-Host "  That's it. Chrome shows a 'Developer mode extensions' note because the"
Write-Host "  extension isn't from the Web Store — that's expected and harmless."
Write-Host ""
Write-Host "You're done. From now on updates download in the background and the" -ForegroundColor Green
Write-Host "extension reloads itself — you never touch chrome://extensions again." -ForegroundColor Green
Write-Host ""
Write-Host "To undo everything later:  .\install-tester.ps1 -Uninstall -RemoveFiles"
