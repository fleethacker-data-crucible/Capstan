<#
 Capstan local host. Windows PowerShell 5.1, no elevated privileges, installers, services
 or network access. Serves the prebuilt editor in dist/ on 127.0.0.1 only. Editing,
 recording and export all run inside the browser; media never leaves this computer.
#>
[CmdletBinding(PositionalBinding=$false)]
param(
    [ValidateRange(1024,65535)][int]$Port=8790,
    [switch]$NoBrowser,
    [ValidateRange(1,500)][int]$PortScanCount=100,
    [switch]$Diagnostics,
    # Open in the default browser instead of an Edge app window.
    [switch]$DefaultBrowser,
    # Keep running after the Capstan window closes (by default the host stops itself once no
    # Capstan page is open). Also: --stay, or CAPSTAN_AUTO_STOP=0.
    [switch]$Stay,
    # If Capstan is already running, stop it and start fresh without asking. Also: --replace
    [switch]$Replace,
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest
)
$ErrorActionPreference = 'Stop'
foreach ($a in @($Rest)) {
    switch -Regex ($a) {
        '^--?stay$' { $Stay = $true }
        '^--?replace$' { $Replace = $true }
        '^--?no-browser$' { $NoBrowser = $true }
        '^--?default-browser$' { $DefaultBrowser = $true }
        '^--?diagnostics$' { $Diagnostics = $true }
        default { if ($a) { Write-Warning ('Ignoring unknown option ' + $a) } }
    }
}
if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
    throw 'Capstan requires Windows. On other systems, see tests/serve.mjs for the development server.'
}
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root 'dist'
. (Join-Path $root 'modules/LocalHttp.ps1')
. (Join-Path $root 'modules/Lifecycle.ps1')
# Cursor and shortcut capture for effects (docs/cursor-data.md). If it cannot be compiled here, the routes
# answer 503 and recording works as before.
$cursorHost = $null
try {
    . (Join-Path $root 'modules/CursorCapture.ps1')
    $cursorHost = New-CapstanCursorRecorder
} catch {
    Write-Warning 'Cursor capture is not available on this computer; recording works without it.'
}
. (Join-Path $root 'modules/Captures.ps1')
. (Join-Path $root 'modules/Library.ps1')
. (Join-Path $root 'modules/Speech.ps1')
$CapstanVersion = ([IO.File]::ReadAllText((Join-Path $root 'VERSION'))).Trim()

# Only these compiled files are ever served. Anything else is a 404.
$StaticFiles = @{
    '/'                = @{ File='index.html';       Type='text/html; charset=utf-8' }
    '/assets/app.js'   = @{ File='assets/app.js';    Type='application/javascript; charset=utf-8' }
    '/assets/app.css'  = @{ File='assets/app.css';   Type='text/css; charset=utf-8' }
    '/assets/icon.svg' = @{ File='assets/icon.svg';  Type='image/svg+xml' }
    # The emblem (backdrop made transparent, one per theme) and the icon cut from its circle.
    '/assets/emblem-dark.png'  = @{ File='assets/emblem-dark.png';  Type='image/png' }
    '/assets/emblem-light.png' = @{ File='assets/emblem-light.png'; Type='image/png' }
    '/assets/icon-256.png'     = @{ File='assets/icon-256.png';     Type='image/png' }
    '/favicon.ico'             = @{ File='assets/favicon.ico';      Type='image/x-icon' }
}
foreach ($entry in $StaticFiles.Values) {
    if (-not (Test-Path -LiteralPath (Join-Path $dist $entry.File))) {
        throw ("Capstan is incomplete: dist/" + $entry.File + " is missing. Extract the whole release archive, including the dist folder.")
    }
}

function Find-CapstanEdge {
    $candidates = @()
    foreach ($dir in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
        if ($dir) { $candidates += (Join-Path $dir 'Microsoft\Edge\Application\msedge.exe') }
    }
    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
    return $null
}

if ($Diagnostics) {
    Write-Host ('Capstan ' + $CapstanVersion + ' launcher and host diagnostics') -ForegroundColor Cyan
    Write-Host ('PowerShell: ' + $PSVersionTable.PSVersion.ToString())
    Write-Host ('Process policy: ' + (Get-ExecutionPolicy -Scope Process))
    Write-Host ('Effective policy: ' + (Get-ExecutionPolicy))
    Write-Host 'Machine policy and application-control rules remain in force.'
    $testServer = [Capstan.Transport.Server]::new($Port,$PortScanCount)
    try { Write-Host ('Loopback socket bind: PASS (http://127.0.0.1:' + $testServer.Port + '/)') }
    finally { $testServer.Dispose() }
    $edge = Find-CapstanEdge
    Write-Host ('Microsoft Edge: ' + $(if ($edge) { $edge } else { 'not found (the default browser will be used)' }))
    Write-Host 'Diagnostics passed. No long-running server was started.' -ForegroundColor Green
    return
}

# One instance: a second host would hold a second port, and the browser keeps projects per port.
$running = @(Get-CapstanProcesses -Root $root)
if ($running.Count -gt 0) {
    $where = ($running | ForEach-Object { Format-CapstanProcess $_ }) -join ', '
    Write-Host ('Capstan is already running: ' + $where) -ForegroundColor Yellow
    $answer = 'y'
    if (-not $Replace) { $answer = Read-Host 'Stop it and start fresh? [Y/n]' }
    if ($answer -eq '' -or $answer -match '^[Yy]') {
        foreach ($p in @(Stop-CapstanProcesses -Root $root)) { Write-Host ('  stopped ' + (Format-CapstanProcess $p)) -ForegroundColor DarkGray }
    } else {
        Write-Host 'Leaving the running Capstan alone. Use "End session" in its window, or Stop-Capstan.ps1.' -ForegroundColor DarkGray
        return
    }
}

$autoStop = (-not $Stay) -and (Test-CapstanAutoStop)
# The tab owns the server: each Capstan page sends a heartbeat every 5 s and a leaving beacon
# when it closes; once no page is alive the host stops itself (see modules/Lifecycle.ps1).
$presence = New-Object Capstan.Lifecycle.Presence -ArgumentList $autoStop
$script:CapstanStopReason = $null

$sessionToken = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
# Bind directly to 127.0.0.1: no HttpListener URL ACL and no admin rights. The socket is held
# from selection through shutdown, so there is no free-port check/bind race.
$server = [Capstan.Transport.Server]::new($Port,$PortScanCount)
$requestedPort = $Port
$Port = $server.Port
if ($requestedPort -ne $Port) {
    Write-Host ("Preferred port $requestedPort is unavailable; using free loopback port $Port instead.") -ForegroundColor Yellow
    # The browser keeps Capstan's media and projects per address, and the port is part of it.
    Write-Host ("Projects saved while Capstan ran on port $requestedPort will not show up on this port. Close whatever uses port $requestedPort and start Capstan again to get them back.") -ForegroundColor Yellow
}

$ContentSecurityPolicy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

# The on-disk media library (modules/Library.ps1): created before the first request, off if its folder is unusable.
[void](Initialize-CapstanLibrary)

function Set-CapstanResponseHeaders($response, [string]$ContentType, [int]$Status) {
    $response.StatusCode = $Status
    $response.ContentType = $ContentType
    $response.Headers.Add('Cache-Control','no-store')
    $response.Headers.Add('X-Content-Type-Options','nosniff')
    $response.Headers.Add('X-Frame-Options','DENY')
    $response.Headers.Add('Referrer-Policy','no-referrer')
    $response.Headers.Add('Cross-Origin-Opener-Policy','same-origin')
    $response.Headers.Add('Permissions-Policy','camera=(self), microphone=(self), display-capture=(self), geolocation=()')
    $response.Headers.Add('Content-Security-Policy',$ContentSecurityPolicy)
}
function Send-Response($Context, [byte[]]$Bytes, [string]$ContentType='application/json', [int]$Status=200) {
    $response = $Context.Response
    Set-CapstanResponseHeaders $response $ContentType $Status
    $response.ContentLength64 = $Bytes.Length
    try { $response.SetBody($Bytes) }
    finally { $response.Close() }
}
# Streams a file in 1 MB buffers (see Response.SetStream); the stream is closed whatever happens.
function Send-CapstanFile($Context, [IO.Stream]$Stream, [long]$Length, [string]$ContentType) {
    $response = $Context.Response
    try {
        Set-CapstanResponseHeaders $response $ContentType 200
        $response.ContentLength64 = $Length
        $response.SetStream($Stream, $Length)
    } catch { $Stream.Dispose(); throw }
    $response.Close()
}
function Send-Json($Context, $Payload, [int]$Status=200) {
    $text = ConvertTo-Json -InputObject $Payload -Depth 8 -Compress
    Send-Response $Context ([Text.Encoding]::UTF8.GetBytes($text)) 'application/json; charset=utf-8' $Status
}

function Read-CapstanJsonBody($Request) {
    # Small JSON bodies only (the lifecycle routes). Bodies are never logged.
    if ($Request.ContentLength64 -le 0) { return $null }
    $reader = New-Object System.IO.StreamReader -ArgumentList $Request.InputStream, ([Text.Encoding]::UTF8)
    try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
    try { return ($text | ConvertFrom-Json) } catch { return $null }
}

function Get-CapstanBodyText($Body, [string]$Name) {
    if ($null -eq $Body -or -not $Body.PSObject.Properties[$Name]) { return '' }
    return [string]$Body.$Name
}

function Invoke-CapstanRequest($Context) {
    $request=$Context.Request; $path=$request.Url.AbsolutePath; $method=$request.HttpMethod
    if (-not [Net.IPAddress]::IsLoopback($request.RemoteEndPoint.Address)) { Send-Json $Context @{error='Local clients only'} 403;return }
    if ($request.Url.Host -ne '127.0.0.1' -or $request.Url.Port -ne $Port) { Send-Json $Context @{error='Invalid host'} 403;return }
    $fetchSite=$request.Headers['Sec-Fetch-Site']
    if ($fetchSite -and $fetchSite -notin @('same-origin','none')) { Send-Json $Context @{error='Cross-site requests denied'} 403;return }
    $origin=$request.Headers['Origin']
    if ($origin -and $origin -ne "http://127.0.0.1:$Port") { Send-Json $Context @{error='Origin is not authorized'} 403;return }

    if ($method -eq 'GET' -and $StaticFiles.ContainsKey($path)) {
        $entry=$StaticFiles[$path]
        $file=Join-Path $dist $entry.File
        if ($path -eq '/') {
            $html=[IO.File]::ReadAllText($file).Replace('__SESSION_TOKEN__',$sessionToken)
            Send-Response $Context ([Text.Encoding]::UTF8.GetBytes($html)) $entry.Type
        } else {
            Send-Response $Context ([IO.File]::ReadAllBytes($file)) $entry.Type
        }
        return
    }
    if ($path -eq '/favicon.ico') { Send-Response $Context ([byte[]]@()) 'image/x-icon' 404; return }

    # Lifecycle heartbeat. navigator.sendBeacon (the leaving signal) cannot set headers, so on THIS
    # route only the token may also come in the JSON body. Never in the query string; never logged.
    if ($path -eq '/api/heartbeat' -and $method -eq 'POST') {
        if ($request.ContentLength64 -gt 4096) { Send-Json $Context @{error='Request body too large'} 413;return }
        $body = Read-CapstanJsonBody $request
        $token = $request.Headers['X-Capstan-Token']
        if (-not $token) { $token = Get-CapstanBodyText $body 'session' }
        if ($token -ne $sessionToken) { Send-Json $Context @{error='Invalid session'} 403;return }
        $tab = Get-CapstanBodyText $body 'tab'
        $now = [DateTime]::UtcNow
        if ((Get-CapstanBodyText $body 'leaving') -eq 'True') { $presence.Leaving($tab, $now) }
        else { $presence.Beat($tab, ((Get-CapstanBodyText $body 'hidden') -eq 'True'), ((Get-CapstanBodyText $body 'busy') -eq 'True'), $now) }
        Send-Json $Context @{ok=$true;autoStop=$presence.Enabled;tabs=$presence.LiveTabs($now)};return
    }

    # Everything below needs the per-launch session token from index.html.
    if ($request.Headers['X-Capstan-Token'] -ne $sessionToken) { Send-Json $Context @{error='Invalid session'} 403;return }
    if ($path -eq '/api/session/stop' -and $method -eq 'POST') {
        # "End session" in the editor. The loop stops after this response is sent.
        Send-Json $Context @{ok=$true;stopping=$true}
        $script:CapstanStopReason = 'End session was chosen in the Capstan window.'
        return
    }
    if ($path.StartsWith('/api/cursor/')) {
        # The body is read as text with a hard cap; the module validates everything else.
        $bodyText = ''
        if ($request.ContentLength64 -gt 0) {
            if ($request.ContentLength64 -gt 2000000) { Send-Json $Context @{error='The request is too large.';code='too-large'} 413;return }
            $reader = New-Object System.IO.StreamReader -ArgumentList $request.InputStream, ([Text.Encoding]::UTF8)
            try { $bodyText = $reader.ReadToEnd() } finally { $reader.Dispose() }
        }
        $result = Invoke-CapstanCursorApi -Recorder $cursorHost -Method $method -Path $path -ContentType ([string]$request.Headers['Content-Type']) -BodyText $bodyText
        Send-Response $Context ([Text.Encoding]::UTF8.GetBytes($result.Text)) 'application/json; charset=utf-8' $result.Status
        return
    }
    if ($path -eq '/api/health' -and $method -eq 'GET') {
        $health = @{app='Capstan';version=$CapstanVersion;offline=$true;host='powershell';ps=$PSVersionTable.PSVersion.ToString();snapshackle=[bool](Get-CapstanCapturesRoot)}
        foreach ($entry in (Get-CapstanLibraryInfo).GetEnumerator()) { $health[$entry.Key] = $entry.Value }
        Send-Json $Context $health;return
    }
    # SnapShackle captures: read-only list and file (modules/Captures.ps1). The name is taken from the raw path.
    if ($path -eq '/api/snapshackle/captures' -or $path.StartsWith('/api/snapshackle/captures/',[StringComparison]::Ordinal)) {
        $raw = $request.Url.OriginalString
        $slash = $raw.IndexOf('/',8)
        Invoke-CapstanCaptureRoute $Context $method $(if ($slash -ge 0) { $raw.Substring($slash) } else { '/' })
        return
    }
    # Media library on disk: /api/files... (token, size, id and path rules live in modules/Library.ps1).
    if (Invoke-CapstanLibraryRoute -Context $Context -SessionToken $sessionToken) { return }
    if ($path.StartsWith('/api/speech/', [StringComparison]::Ordinal)) {
        # Speech-to-text (modules/Speech.ps1): status, transcribe a WAV, poll or cancel a job.
        $speech = Invoke-CapstanSpeechRoute -Method $method -Path $path -Query $request.Url.Query -ContentType $request.Headers['Content-Type'] -ContentLength $request.ContentLength64 -Body $request.InputStream
        Send-Json $Context $speech.Body $speech.Status;return
    }
    Send-Json $Context @{error='Route not found'} 404
}

$base="http://127.0.0.1:$Port/"
$runtimeFile = $null
try {
    $runtimeFile = Write-CapstanRuntimeFile -Root $root -Port $Port -Url $base
    Write-Host "Capstan $CapstanVersion local server: $base" -ForegroundColor Yellow
    Write-Host 'Your media and projects stay in this browser profile on this computer.'
    if (Test-CapstanLibraryEnabled) { Write-Host 'A copy of each media file is kept in %LOCALAPPDATA%\Capstan\library, so projects survive a port change or a cleared browser.' }
    if ($autoStop) {
        Write-Host 'Capstan stops by itself when its window closes. To quit now: "End session" in the window, Ctrl+C here, or Stop-Capstan.ps1.'
    } else {
        Write-Host 'Auto-stop is off (-Stay or CAPSTAN_AUTO_STOP=0). To quit: "End session" in the window, Ctrl+C here, or Stop-Capstan.ps1.'
    }
    if (-not $NoBrowser) {
        try {
            $edge = if ($DefaultBrowser) { $null } else { Find-CapstanEdge }
            # An Edge app window has no tabs or address bar, so the editor feels like a desktop app.
            if ($edge) { Start-Process -FilePath $edge -ArgumentList @("--app=$base") }
            else { Start-Process $base }
        } catch {
            Write-Warning ('Browser did not open automatically: ' + $_.Exception.Message + '. Open ' + $base + ' manually.')
        }
    }
    while ($null -eq $script:CapstanStopReason) {
        if ($presence.ShouldStop([DateTime]::UtcNow)) {
            $script:CapstanStopReason = 'The Capstan window was closed (set CAPSTAN_AUTO_STOP=0 or use -Stay to keep it running).'
            break
        }
        Invoke-CapstanLibrarySweep
        $context=$null
        try {
            # Wake at least once a second for the lifecycle tick; this also lets Ctrl+C through.
            $context=$server.TryAccept(1000)
            if ($null -eq $context) { continue }
            Invoke-CapstanRequest $context
        } catch [System.IO.InvalidDataException] {
            Write-Warning ('Rejected malformed local HTTP request: ' + $_.Exception.Message)
        } catch {
            Write-Warning ('Local HTTP request failed: ' + $_.Exception.Message)
            if ($null -ne $context) {
                try { if ($context.Response.OutputStream.CanWrite) { Send-Json $context @{error='Request failed'} 500 } } catch {}
            }
        } finally {
            if ($null -ne $context) { $context.Dispose() }
        }
    }
    if ($script:CapstanStopReason) { Write-Host ('Capstan stopped: ' + $script:CapstanStopReason) -ForegroundColor Yellow }
} finally {
    # A cursor session that is still running is finished and written, then the sampler thread ends.
    if ($null -ne $cursorHost) { try { $cursorHost.Shutdown() } catch {} }
    $server.Dispose()
    Stop-CapstanSpeech
    # Also runs on Ctrl+C. An upload that was still open is not kept.
    Clear-CapstanLibraryUploads
    Remove-CapstanRuntimeFile -Path $runtimeFile
}
