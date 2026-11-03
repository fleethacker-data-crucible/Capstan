<#
  Fleet action routes on Capstan's existing loopback listener.
  The editor session token is checked by Start-Capstan.ps1 before this runs.
  Bodies use the FleetAction 1.0.1 fields args, confirmed, and dryRun.
#>

function Get-CapstanFleetProp {
    param($Object, [string]$Name)
    if ($null -eq $Object -or [string]::IsNullOrEmpty($Name)) { return $null }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Get-CapstanFleetStatus {
    param($Envelope)
    if ($Envelope.ok -eq $true) { return 200 }
    $code = ''
    if ($null -ne $Envelope.error) { $code = [string]$Envelope.error.code }
    if ($code -eq 'E_ARGS') { return 400 }
    if ($code -eq 'E_NOT_FOUND') { return 404 }
    if ($code -eq 'E_CONFIRM') { return 409 }
    if ($code -eq 'E_AUTH') { return 401 }
    return 500
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

function Send-CapstanFleetEnvelope {
    param($Context, $Envelope)
    $text = ConvertTo-Json -InputObject $Envelope -Depth 40 -Compress
    Send-Response $Context ([Text.Encoding]::UTF8.GetBytes($text)) 'application/json; charset=utf-8' (Get-CapstanFleetStatus $Envelope)
}

function Invoke-CapstanFleetRoute {
    param($Context, [string]$Method, [string]$Path)
    $document = $false
    $actionId = $null
    $job = $false
    if ($Method -eq 'GET' -and ($Path -eq '/api/commands' -or $Path -eq '/api/help')) { $document = $true }
    elseif ($Path.StartsWith('/api/actions/')) { $actionId = $Path.Substring('/api/actions/'.Length) }
    elseif ($Path -eq '/api/jobs') { $job = $true }
    else { return $false }

    if ($document) {
        if ($Method -ne 'GET') {
            Send-CapstanFleetEnvelope $Context @{ v = 1; ok = $false; error = @{ code = 'E_ARGS'; message = 'Use GET.' } }
            return $true
        }
        $actions = @(Get-FleetAction -App 'capstan')
        $result = New-Object System.Management.Automation.PSObject
        $result | Add-Member -MemberType NoteProperty -Name 'app' -Value 'capstan'
        $result | Add-Member -MemberType NoteProperty -Name 'actions' -Value $actions
        $envelope = New-Object System.Management.Automation.PSObject
        $envelope | Add-Member -MemberType NoteProperty -Name 'v' -Value 1
        $envelope | Add-Member -MemberType NoteProperty -Name 'ok' -Value $true
        $envelope | Add-Member -MemberType NoteProperty -Name 'result' -Value $result
        Send-CapstanFleetEnvelope $Context $envelope
        return $true
    }
    if ($Method -ne 'POST') {
        Send-CapstanFleetEnvelope $Context @{ v = 1; ok = $false; error = @{ code = 'E_ARGS'; message = 'Use POST.' } }
        return $true
    }
    $body = Read-CapstanFleetBody $Context.Request
    if ($body -eq 'TOO_LARGE') {
        Send-CapstanFleetEnvelope $Context @{ v = 1; ok = $false; error = @{ code = 'E_ARGS'; message = 'The request body is too large.' } }
        return $true
    }
    if ($body -eq 'BAD') {
        Send-CapstanFleetEnvelope $Context @{ v = 1; ok = $false; error = @{ code = 'E_ARGS'; message = 'The request body is not JSON.' } }
        return $true
    }
    $confirmed = (Get-CapstanFleetProp $body 'confirmed') -eq $true
    $dry = (Get-CapstanFleetProp $body 'dryRun') -eq $true
    Set-CapstanInListener -Enabled $true
    try {
        if ($job) {
            $envelope = Invoke-FleetJob -Job $body -Confirmed:$confirmed -DryRun:$dry
        } else {
            $parts = $actionId.Split('.')
            if ($parts.Length -ne 3) {
                Send-CapstanFleetEnvelope $Context @{ v = 1; ok = $false; error = @{ code = 'E_ARGS'; message = 'That action id is not app.noun.verb.' } }
                return $true
            }
            $argsObj = Get-CapstanFleetProp $body 'args'
            $envelope = Invoke-FleetAction -App $parts[0] -Noun $parts[1] -Verb $parts[2] -Arguments $argsObj -Confirmed:$confirmed -DryRun:$dry
        }
    } finally {
        Set-CapstanInListener -Enabled $false
    }
    Send-CapstanFleetEnvelope $Context $envelope
    if ($envelope.ok -eq $true -and $null -ne $envelope.result) {
        $stopping = Get-CapstanFleetProp $envelope.result 'stopping'
        if ($stopping -eq $true) {
            $script:CapstanStopReason = 'End session was chosen in the Capstan window.'
        }
    }
    return $true
}
