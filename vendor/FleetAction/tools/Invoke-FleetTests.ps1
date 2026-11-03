[CmdletBinding()]
param(
    [string]$ResultsPath = 'test-results/pester.xml',
    [string]$Path = 'tests',
    [switch]$NoExit
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Module Pester)) {
    throw 'Pester is not loaded. Run tools/Install-PinnedPester.ps1 first.'
}
if ((Get-Module Pester).Version.Major -ne 5) {
    throw 'Pester 5 is required.'
}
$directory = Split-Path -Parent $ResultsPath
if (-not [string]::IsNullOrEmpty($directory) -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
}
$configuration = New-PesterConfiguration
$configuration.Run.Path = $Path
$configuration.Run.Exit = $false
$configuration.Run.PassThru = $true
$configuration.TestResult.Enabled = $true
$configuration.TestResult.OutputFormat = 'NUnitXml'
$configuration.TestResult.OutputPath = $ResultsPath
$configuration.Output.Verbosity = 'Detailed'
$result = Invoke-Pester -Configuration $configuration
Write-Output ('Passed=' + $result.PassedCount + ' Failed=' + $result.FailedCount + ' Skipped=' + $result.SkippedCount + ' Total=' + $result.TotalCount)
if ($result.FailedCount -gt 0) {
    if ($NoExit) {
        throw ('Pester failed: ' + $result.FailedCount)
    }
    exit $result.FailedCount
}
