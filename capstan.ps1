#requires -Version 5.1
<#
  Capstan action CLI. Windows PowerShell 5.1.

  capstan.ps1 commands --json
  capstan.ps1 help --json
  capstan.ps1 <noun> <verb> [--json] [--out FILE] [--yes] [--dry-run] [--option value]
  capstan.ps1 job run --file <job.json> [--json] [--yes] [--dry-run]

  No CmdletBinding: --out would otherwise clash with the common -OutVariable parameter.
  The FleetAction engine reads the app name as the first token, so this script adds it.
#>
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $root 'vendor/FleetAction/FleetAction.psm1') -Force
Import-Module (Join-Path $root 'actions/Capstan.Actions.psm1') -Force
Register-CapstanActions
$tokens = New-Object System.Collections.Generic.List[string]
$tokens.Add('capstan')
foreach ($token in @($args)) {
    if ($null -ne $token) { $tokens.Add([string]$token) }
}
$ran = Invoke-FleetCli -Arguments $tokens.ToArray()
if ($ran.EmitJson) { Write-Output $ran.Json }
else { Write-Output $ran.Text }
exit $ran.ExitCode
