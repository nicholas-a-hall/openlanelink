<#
.SYNOPSIS
Makes firmware/lib/lanelink visible to the Arduino IDE so every openlanelink
sketch can #include <lanelink_protocol.h>.

.DESCRIPTION
The Arduino IDE only finds libraries inside your sketchbook's libraries\
folder, so this links (never copies) this repo's lanelink library into it
using a directory junction. Linking rather than copying is the whole point:
edit the header in the repo and every sketch picks it up on the next compile,
with no copy to forget.

A junction needs neither administrator rights nor Developer Mode, unlike a
real symbolic link.

.PARAMETER Check
Verify only -- report whether the library is installed and current, change
nothing. Exits 1 if it isn't.

.PARAMETER Sketchbook
Your Arduino sketchbook folder. Defaults to <Documents>\Arduino. Only needed
if you moved it (Arduino IDE: File > Preferences > Sketchbook location).

.EXAMPLE
powershell -ExecutionPolicy Bypass -File firmware\tools\install_lanelink_library.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File firmware\tools\install_lanelink_library.ps1 -Check
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [string]$Sketchbook
)

$ErrorActionPreference = 'Stop'

$firmwareDir = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $firmwareDir 'lib\lanelink'

if (-not (Test-Path (Join-Path $sourceDir 'library.properties'))) {
    Write-Host "FAIL cannot find the lanelink library at $sourceDir" -ForegroundColor Red
    exit 1
}

if ([string]::IsNullOrWhiteSpace($Sketchbook)) {
    # [Environment]::GetFolderPath follows a redirected Documents folder
    # (OneDrive, a moved profile); $env:USERPROFILE\Documents does not.
    $documents = [Environment]::GetFolderPath('MyDocuments')
    if ([string]::IsNullOrWhiteSpace($documents)) { $documents = Join-Path $env:USERPROFILE 'Documents' }
    $Sketchbook = Join-Path $documents 'Arduino'
}

$libDir = Join-Path $Sketchbook 'libraries'
$target = Join-Path $libDir 'lanelink'

function Test-InstalledAndCurrent {
    # Compare file CONTENT, not paths: junctions, symlinks, and drive-letter
    # casing all differ textually while pointing at the same bytes.
    $markers = @('library.properties', 'src\lanelink_protocol.h', 'src\lanelink_rs485.h')
    foreach ($marker in $markers) {
        $mine = Join-Path $sourceDir $marker
        $theirs = Join-Path $target $marker
        if (-not (Test-Path $theirs)) { return $false }
        $a = Get-FileHash -Path $mine -Algorithm SHA256
        $b = Get-FileHash -Path $theirs -Algorithm SHA256
        if ($a.Hash -ne $b.Hash) { return $false }
    }
    return $true
}

function Remove-ExistingTarget {
    param([string]$Path)

    $item = Get-Item -LiteralPath $Path -Force
    $isReparsePoint = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0

    if ($isReparsePoint) {
        # CRITICAL: Remove-Item -Recurse on a junction in Windows PowerShell
        # 5.1 can follow it and delete the TARGET's contents -- which here is
        # this repo's own source of truth. Directory.Delete removes only the
        # link itself and never touches what it points at.
        [System.IO.Directory]::Delete($Path, $false)
    } else {
        # A real directory: a hand-made copy from a previous install. Safe to
        # recurse, since there's no link to follow.
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

if ($Check) {
    if (Test-InstalledAndCurrent) {
        Write-Host "OK   lanelink library installed and current" -ForegroundColor Green
        Write-Host "     $target -> $sourceDir"
        exit 0
    }
    if (Test-Path $target) {
        Write-Host "FAIL $target exists but does not match $sourceDir" -ForegroundColor Red
        Write-Host "     A stale copy will compile happily and misparse on the wire."
        Write-Host "     Re-run without -Check to repair."
    } else {
        Write-Host "FAIL lanelink library is not installed ($target missing)" -ForegroundColor Red
        Write-Host "     Sketches will fail with: lanelink_protocol.h: No such file or directory"
        Write-Host "     Re-run without -Check to install."
    }
    exit 1
}

if (Test-InstalledAndCurrent) {
    Write-Host "OK   lanelink library already installed at $target" -ForegroundColor Green
    exit 0
}

if (-not (Test-Path $libDir)) {
    New-Item -ItemType Directory -Path $libDir -Force | Out-Null
}

if (Test-Path $target) {
    Write-Host "     removing stale $target"
    Remove-ExistingTarget -Path $target
}

try {
    New-Item -ItemType Junction -Path $target -Value $sourceDir -ErrorAction Stop | Out-Null
} catch {
    Write-Host "FAIL could not create junction $target -> $sourceDir" -ForegroundColor Red
    Write-Host "     $($_.Exception.Message)"
    Write-Host "     Fall back to copying it by hand:"
    Write-Host "       Copy-Item -Recurse '$sourceDir' '$target'"
    Write-Host "     (a copy works, but you must re-copy after every protocol edit)"
    exit 1
}

if (Test-InstalledAndCurrent) {
    Write-Host "OK   lanelink library installed" -ForegroundColor Green
    Write-Host "     $target -> $sourceDir"
    Write-Host "     Sketches can now #include <lanelink_protocol.h>."
    Write-Host "     Restart the Arduino IDE if it was already open."
    exit 0
}

Write-Host "FAIL junction created but content does not match -- unexpected" -ForegroundColor Red
exit 1
