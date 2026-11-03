[CmdletBinding()]
param(
    [string]$Destination
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}
catch { }
$Version = '5.9.1'
$Sha256 = '8DD4060FC3BC895F05BD655E4AB82ABE346DE54A4E6415DFB727CC8378672B69'
if ([string]::IsNullOrEmpty($Destination)) {
    $tempRoot = $env:TEMP
    if ([string]::IsNullOrEmpty($tempRoot)) {
        $tempRoot = [System.IO.Path]::GetTempPath()
    }
    $Destination = Join-Path $tempRoot ('Pester-' + $Version)
}
if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Path $Destination | Out-Null
}
$nupkg = Join-Path $Destination ('Pester.' + $Version + '.nupkg')
if (-not (Test-Path -LiteralPath $nupkg)) {
    $url = 'https://www.powershellgallery.com/api/v2/package/Pester/' + $Version
    $client = New-Object System.Net.WebClient
    $client.Headers['User-Agent'] = 'FleetAction'
    $client.DownloadFile($url, $nupkg)
}
$actual = (Get-FileHash -Algorithm SHA256 -Path $nupkg).Hash.ToUpperInvariant()
if ($actual -ne $Sha256) {
    throw ('Pester package hash mismatch. Expected ' + $Sha256 + ' actual ' + $actual)
}
$extract = Join-Path $Destination 'module'
if (Test-Path -LiteralPath $extract) {
    Remove-Item -LiteralPath $extract -Recurse -Force
}
New-Item -ItemType Directory -Path $extract | Out-Null
$zip = Join-Path $Destination 'pester.zip'
Copy-Item -LiteralPath $nupkg -Destination $zip -Force
Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
Import-Module (Join-Path $extract 'Pester.psd1') -Force
$loaded = Get-Module Pester
if ($loaded.Version.ToString() -ne $Version) {
    throw 'Pester version mismatch after import.'
}
if ($loaded.Version.Major -ne 5) {
    throw 'Pester 5 is required.'
}
Write-Output ('Pester ' + $loaded.Version.ToString())
