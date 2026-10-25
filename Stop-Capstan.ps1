<#
.SYNOPSIS
  Stops every running Capstan host on this computer.
.DESCRIPTION
  Capstan normally stops by itself when its window closes, or from "End session" in the window.
  This is the fallback: it reads the runtime files each host writes under logs\ (one per process),
  stops those processes, then looks for any other PowerShell still running Start-Capstan.ps1.
  No PIDs needed. scripts/build.ts and tests/serve.mjs call it on Windows before they start.
.PARAMETER Quiet
  Print nothing unless something was stopped.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Stop-Capstan.ps1
#>
[CmdletBinding()]
param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'modules/Lifecycle.ps1')
$stopped = @(Stop-CapstanProcesses -Root $root)
if ($stopped.Count -gt 0) {
    foreach ($p in $stopped) { Write-Host ('Stopped Capstan ' + (Format-CapstanProcess $p) + '.') -ForegroundColor Yellow }
} elseif (-not $Quiet) {
    Write-Host 'Capstan is not running.' -ForegroundColor DarkGray
}
