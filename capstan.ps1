<#
  Capstan action CLI. Windows PowerShell 5.1.

  capstan.ps1 commands --json
  capstan.ps1 help --json
  capstan.ps1 <noun> <verb> [--json] [--out FILE] [--yes] [--dry-run] [--option value]
  capstan.ps1 job run --file <job.json> [--json] [--yes] [--dry-run]

  No CmdletBinding: --out would otherwise clash with the common -OutVariable parameter.
#>
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$Rest = @($args)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $root 'vendor/FleetAction/FleetAction.psm1') -Force
Import-Module (Join-Path $root 'actions/Capstan.Actions.psm1') -Force
Register-CapstanActions
$ran = Invoke-FleetCli -Arguments @($Rest)
if ($ran.OutFile) {
    $jsonText = ConvertTo-FleetJson $ran.Json
    $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [IO.File]::WriteAllText([string]$ran.OutFile, $jsonText + "`n", $utf8)
}
Write-Output $ran.Stdout
exit $ran.ExitCode
