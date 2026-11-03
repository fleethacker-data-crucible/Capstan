<#
  Fleet action routes on the existing loopback listener. The session token is checked by
  Start-Capstan.ps1 before this runs. The token is never written to the response or the log.
#>

function Get-CapstanFleetStatus {
    param($Envelope)
    if ((Get-FleetProp $Envelope 'ok') -eq $true) { return 200 }
    $kind = [string](Get-FleetProp $Envelope 'errorType')
    $message = [string](Get-FleetProp $Envelope 'error')
    if ($kind -eq 'usage' -and $message.StartsWith('Unknown action')) { return 404 }
    if ($kind -eq 'usage') { return 400 }
    if ($kind -eq 'needs-confirm') { return 409 }
    if ($kind -eq 'needs-browser') { return 422 }
    return 422
}

function Read-CapstanFleetBody {
    param($Request)
    if ($Request.ContentLength64 -lt 0) { return 'BAD' }
    if ($Request.ContentLength64 -eq 0) { return $null }
    if ($Request.ContentLength64 -gt 1048576) { return 'TOO_LARGE' }
    $reader = New-Object System.IO.StreamReader -ArgumentList $Request.InputStream, ([Text.Encoding]::UTF8)
    try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if ([string]::IsNullOrEmpty($text)) { return $null }
    try { return ($text | ConvertFrom-Json) } catch { return 'BAD' }
}

function Invoke-CapstanFleetRoute {
    param($Context, [string]$Method, [string]$Path)
    $handled = $false
    $document = $false
    if ($Method -eq 'GET' -and ($Path -eq '/api/commands' -or $Path -eq '/api/help')) {
        $handled = $true
        $document = $true
    }
    $actionId = $null
    if ($Path.StartsWith('/api/actions/')) {
        $actionId = $Path.Substring('/api/actions/'.Length)
        $handled = $true
    }
    $job = $false
    if ($Path -eq '/api/jobs') { $handled = $true; $job = $true }
    if (-not $handled) { return $false }

    if ($document) {
        if ($Method -ne 'GET') { Send-Json $Context @{ schema = 'fleet.result/1'; action = 'capstan.commands.list'; ok = $false; errorType = 'usage'; error = 'Use GET.' } 405; return $true }
        Send-Json $Context (Get-FleetCommandsDocument) 200
        return $true
    }
    if ($Method -ne 'POST') { Send-Json $Context @{ schema = 'fleet.result/1'; action = 'capstan.commands.list'; ok = $false; errorType = 'usage'; error = 'Use POST.' } 405; return $true }

    $body = Read-CapstanFleetBody $Context.Request
    if ($body -eq 'TOO_LARGE') { Send-Json $Context @{ schema = 'fleet.result/1'; ok = $false; errorType = 'usage'; error = 'The request body is too large.' } 413; return $true }
    if ($body -eq 'BAD') { Send-Json $Context @{ schema = 'fleet.result/1'; ok = $false; errorType = 'usage'; error = 'The request body is not JSON.' } 400; return $true }

    $confirmed = (Get-FleetProp $body 'confirmed') -eq $true
    $dry = (Get-FleetProp $body 'dryRun') -eq $true
    Set-FleetHostMode -Enabled $true
    try {
        if ($job) {
            $schema = [string](Get-FleetProp $body 'schema')
            if ($schema -ne 'fleet.job/1') {
                Send-Json $Context @{ schema = 'fleet.result/1'; action = 'capstan.job.run'; ok = $false; errorType = 'usage'; error = 'A job needs "schema": "fleet.job/1".' } 400
                return $true
            }
            $temp = Join-Path ([IO.Path]::GetTempPath()) ('capstan-job-' + [guid]::NewGuid().ToString('N') + '.json')
            $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
            [IO.File]::WriteAllText($temp, (ConvertTo-FleetJson $body), $utf8)
            try { $envelope = Invoke-FleetJob -Path $temp -Confirmed:$confirmed -DryRun:$dry }
            finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
        } else {
            if ($actionId -notmatch '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2}$') {
                Send-Json $Context @{ schema = 'fleet.result/1'; action = [string]$actionId; ok = $false; errorType = 'usage'; error = 'That action id is not app.noun.verb.' } 400
                return $true
            }
            $argsObj = Get-FleetProp $body 'args'
            if ($null -eq $argsObj) { $argsObj = @{} }
            $envelope = Invoke-FleetAction -Id $actionId -Arguments $argsObj -Confirmed:$confirmed -DryRun:$dry
        }
    } finally {
        Set-FleetHostMode -Enabled $false
    }
    Send-Json $Context $envelope (Get-CapstanFleetStatus $envelope)
    if ((Get-FleetProp $envelope 'ok') -eq $true) {
        $result = Get-FleetProp $envelope 'result'
        if ((Get-FleetProp $result 'stopping') -eq $true) {
            $script:CapstanStopReason = 'End session was chosen in the Capstan window.'
        }
    }
    return $true
}
