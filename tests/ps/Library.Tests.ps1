<#
  Windows-only checks for the on-disk media library (modules/Library.ps1, the /api/files routes).
  Plain PowerShell 5.1, no Pester needed: each check prints PASS/FAIL and the script exits 1 if any failed.
  Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests\ps\Library.Tests.ps1
  It starts the real host on a test port with the library in a temp folder (CAPSTAN_LIBRARY_ROOT), so it
  never touches %LOCALAPPDATA%\Capstan. All data is random bytes generated here.
#>
[CmdletBinding()]
param([int]$Port = 18792)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Add-Type -AssemblyName System.Net.Http

$script:failures = 0
$script:allText = New-Object System.Text.StringBuilder
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) { Write-Host ('PASS  ' + $Name) -ForegroundColor Green }
    else { Write-Host ('FAIL  ' + $Name + '  ' + $Detail) -ForegroundColor Red; $script:failures++ }
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('capstan-library-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
[void](New-Item -ItemType Directory -Path $work)
$libRoot = Join-Path $work 'library'
$uploadsDir = Join-Path $libRoot '.uploads'

# ---- Files parse under Windows PowerShell 5.1 and are ASCII ----
foreach ($f in @('modules/Library.ps1', 'modules/LocalHttp.ps1', 'Start-Capstan.ps1', 'tests/ps/Library.Tests.ps1')) {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $f), [ref]$tokens, [ref]$errors)
    Check ($f + ' parses') ($errors.Count -eq 0) (($errors | ForEach-Object { $_.Message }) -join '; ')
    Check ($f + ' is ASCII') (-not ([IO.File]::ReadAllText((Join-Path $root $f)) -match '[^\x00-\x7f]'))
}

# ---- Path rules, in this process ----
. (Join-Path $root 'modules/Library.ps1')
Check 'Initialize-CapstanLibrary prepares a local folder' (Initialize-CapstanLibrary -Root $libRoot)
Check 'the library folder and .uploads exist' ((Test-Path -LiteralPath $libRoot) -and (Test-Path -LiteralPath $uploadsDir))
$hostile = @('..', '.', '...', 'a/b', 'a\b', 'C:\x', 'C:x', '\\server\share\x', 'con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9', 'x:stream', 'abc:def',
    'ABC', 'Con', 'a b', 'a.', 'a ', 'a.txt', '../x', '..\x', '%2e%2e', 'a%2fb', '$MFT', 'a*', 'a?', ('a' * 81), "abc`n", "abc`0", '')
foreach ($id in $hostile) {
    $label = ($id -replace "[\x00-\x1f]", '?')
    if ($label.Length -gt 20) { $label = $label.Substring(0, 20) + '...' }
    Check ('id "' + $label + '" is refused') ((-not (Test-CapstanLibraryId $id)) -and ($null -eq (Resolve-CapstanLibraryFile $id)) -and ($null -eq (Resolve-CapstanLibraryTemp $id)))
}
foreach ($id in @('a', 'media_1-x', 'med_lq1x2y3z4a5b6c', ('a' * 80), '0', '-', '_')) {
    $p = Resolve-CapstanLibraryFile $id
    $label = $id; if ($label.Length -gt 20) { $label = $label.Substring(0, 20) + '...' }
    Check ('id "' + $label + '" resolves to a direct child of the root') (($null -ne $p) -and ([IO.Path]::GetDirectoryName($p) -eq $libRoot) -and ([IO.Path]::GetFileName($p) -eq $id))
}
$junctionTarget = Join-Path $work 'elsewhere'
[void](New-Item -ItemType Directory -Path $junctionTarget)
$junction = Join-Path $libRoot 'linked'
& cmd.exe /c ('mklink /J "' + $junction + '" "' + $junctionTarget + '"') | Out-Null
if (Test-Path -LiteralPath $junction) {
    Check 'an id that is a junction (reparse point) is refused' ($null -eq (Resolve-CapstanLibraryFile 'linked'))
    & cmd.exe /c ('rmdir "' + $junction + '"') | Out-Null
} else { Write-Host 'SKIP  junction check (mklink /J not available here)' -ForegroundColor Yellow }
Check 'a UNC root is refused' (-not (Initialize-CapstanLibrary -Root '\\localhost\c$\capstan-test'))
Check 'a relative root is refused' (-not (Initialize-CapstanLibrary -Root 'library'))
Check 'a device path root is refused' (-not (Initialize-CapstanLibrary -Root '\\.\C:\capstan-test'))
[void](Initialize-CapstanLibrary -Root $libRoot -ReserveBytes 100TB)
Check 'a file larger than the free space minus the reserve is refused' (-not (Test-CapstanLibraryRoom 1 ''))
[void](Initialize-CapstanLibrary -Root $libRoot -ReserveBytes 1MB)
Check 'a small file fits when there is room' (Test-CapstanLibraryRoom 1024 '')
Check 'a constant-time token compare accepts equal tokens' (Test-CapstanTokenEqual 'abc123' 'abc123')
Check 'a constant-time token compare refuses a different token, a prefix and empty' ((-not (Test-CapstanTokenEqual 'abc124' 'abc123')) -and (-not (Test-CapstanTokenEqual 'abc12' 'abc123')) -and (-not (Test-CapstanTokenEqual '' 'abc123')))
$r = Get-CapstanLibraryRange 'bytes=0-9' 100; Check 'Range 0-9 of 100' ($r.ok -and $r.start -eq 0 -and $r.count -eq 10)
$r = Get-CapstanLibraryRange 'bytes=90-' 100; Check 'Range 90- of 100' ($r.ok -and $r.start -eq 90 -and $r.count -eq 10)
$r = Get-CapstanLibraryRange 'bytes=-5' 100; Check 'Range -5 of 100' ($r.ok -and $r.start -eq 95 -and $r.count -eq 5)
$r = Get-CapstanLibraryRange 'bytes=0-9999' 100; Check 'Range past the end is clipped' ($r.ok -and $r.count -eq 100)
foreach ($bad in @('bytes=100-', 'bytes=9-3', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'items=0-1', 'bytes=a-b', 'bytes=0-1 ')) {
    Check ('Range "' + $bad + '" is unsatisfiable') (-not (Get-CapstanLibraryRange $bad 100).ok)
}

# ---- A live host with the library in a temp folder ----
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$leftover = Join-Path $uploadsDir 'leftover.part'
[IO.File]::WriteAllBytes($leftover, (New-Object byte[] 1024))
function Start-TestHost([int]$HostPort, [hashtable]$EnvVars) {
    $saved = @{}
    foreach ($k in $EnvVars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, [string]$EnvVars[$k]) }
    try {
        $args = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $root 'Start-Capstan.ps1') + '"'), '-NoBrowser', '-Stay', '-Port', $HostPort, '--replace')
        $proc = Start-Process -FilePath $ps -ArgumentList $args -PassThru -WindowStyle Hidden
    } finally { foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) } }
    $logs = Join-Path $root 'logs'
    $runtime = Join-Path $logs ('capstan-server-' + $proc.Id + '.json')
    $deadline = (Get-Date).AddSeconds(40)
    while (-not (Test-Path $runtime) -and (Get-Date) -lt $deadline -and -not $proc.HasExited) { Start-Sleep -Milliseconds 200 }
    if (-not (Test-Path $runtime)) { return $null }
    $url = [string](([IO.File]::ReadAllText($runtime) | ConvertFrom-Json).url)
    $page = (Invoke-WebRequest -Uri $url -UseBasicParsing).Content
    $token = ([regex]'name="capstan-session" content="([0-9a-f]+)"').Match($page).Groups[1].Value
    return @{ Proc = $proc; Url = $url; Token = $token; Runtime = $runtime }
}

$script:client = New-Object Net.Http.HttpClient
$script:client.Timeout = [TimeSpan]::FromSeconds(120)
$script:url = ''
$script:token = ''
function Call {
    param([string]$Method, [string]$Path, $Body = $null, [string]$Type = '', [hashtable]$Headers = @{}, [string]$Token = '<default>')
    if ($Token -eq '<default>') { $Token = $script:token }
    $req = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), ($script:url + $Path.TrimStart('/')))
    if ($null -ne $Body) {
        if ($Body -is [string]) { $Body = [Text.Encoding]::UTF8.GetBytes($Body) }
        $req.Content = [Net.Http.ByteArrayContent]::new([byte[]]$Body)
        if ($Type) { $req.Content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::Parse($Type) }
    }
    if ($Token) { [void]$req.Headers.TryAddWithoutValidation('X-Capstan-Token', $Token) }
    foreach ($k in $Headers.Keys) { [void]$req.Headers.TryAddWithoutValidation($k, [string]$Headers[$k]) }
    try {
        $resp = $script:client.SendAsync($req).GetAwaiter().GetResult()
        $bytes = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    } catch { return [pscustomobject]@{ Status = 0; Bytes = (New-Object byte[] 0); Text = ''; Json = $null; Resp = $null } }
    $text = ''
    if ($bytes.Length -lt 65536) { $text = [Text.Encoding]::UTF8.GetString($bytes) }
    [void]$script:allText.AppendLine($text)
    $json = $null
    try { if ($text.StartsWith('{')) { $json = $text | ConvertFrom-Json } } catch { }
    return [pscustomobject]@{ Status = [int]$resp.StatusCode; Bytes = $bytes; Text = $text; Json = $json; Resp = $resp }
}
function Get-RespHeader($Result, [string]$Name) {
    if ($null -eq $Result.Resp) { return '' }
    $values = $null
    if ($Result.Resp.Headers.TryGetValues($Name, [ref]$values)) { return ($values -join ',') }
    if ($Result.Resp.Content.Headers.TryGetValues($Name, [ref]$values)) { return ($values -join ',') }
    return ''
}
function Json($o) { return (ConvertTo-Json -InputObject $o -Compress) }
function Slice([byte[]]$Bytes, [long]$Offset, [long]$Count) {
    $out = New-Object byte[] $Count
    [Array]::Copy($Bytes, $Offset, $out, 0, $Count)
    return , $out
}
function Sha([byte[]]$Bytes) {
    $s = New-Object System.Security.Cryptography.SHA256CryptoServiceProvider
    try { return (ConvertTo-CapstanHex $s.ComputeHash($Bytes)) } finally { $s.Dispose() }
}
function RandomBytes([int]$Count) {
    $b = New-Object byte[] $Count
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    $rng.GetBytes($b); $rng.Dispose()
    return , $b
}
function Put-Part([string]$Id, [int]$Part, [byte[]]$All, [long]$Chunk) {
    $offset = [long]$Part * $Chunk
    $count = [Math]::Min($Chunk, $All.Length - $offset)
    return (Call 'PUT' ('/api/files/' + $Id + '?part=' + $Part) (Slice $All $offset $count) 'application/octet-stream')
}
function Raw([string]$Text, [byte[]]$Body = $null, [bool]$Truncate = $false) {
    # A hand-written request, for what an HTTP client library would normalise or refuse to send.
    $c = New-Object Net.Sockets.TcpClient
    try {
        $c.Connect('127.0.0.1', $script:rawPort)
        $c.ReceiveTimeout = 10000
        $s = $c.GetStream()
        $head = [Text.Encoding]::ASCII.GetBytes($Text)
        $s.Write($head, 0, $head.Length)
        if ($null -ne $Body) { $s.Write($Body, 0, $Body.Length) }
        $s.Flush()
        if ($Truncate) { return 0 }
        $buf = New-Object byte[] 4096
        $got = 0
        try { $got = $s.Read($buf, 0, $buf.Length) } catch { $got = 0 }
        if ($got -le 0) { return 0 }
        $line = [Text.Encoding]::ASCII.GetString($buf, 0, $got).Split("`r")[0]
        if ($line -match '^HTTP/1\.1 (\d{3})') { return [int]$Matches[1] }
        return 0
    } finally { $c.Close() }
}

$h = Start-TestHost $Port @{ CAPSTAN_LIBRARY_ROOT = $libRoot; CAPSTAN_LIBRARY_MAX_BYTES = 20971520; CAPSTAN_LIBRARY_MAX_UPLOADS = 3; CAPSTAN_LIBRARY_STALE_SECONDS = 4; CAPSTAN_LIBRARY_RESERVE_BYTES = 1048576 }
$proc = $null
$h2 = $null
try {
    Check 'the host started with the test library' (($null -ne $h) -and $h.Token)
    if ($null -eq $h) { throw 'host did not start' }
    $proc = $h.Proc
    $script:url = $h.Url; $script:token = $h.Token; $script:rawPort = $Port
    $hostHeader = '127.0.0.1:' + $Port

    Check 'an upload left by an earlier run is removed at start' (-not (Test-Path -LiteralPath $leftover))

    $r = Call 'GET' '/api/health'
    Check 'health says library: true and does not name the folder' (($r.Status -eq 200) -and ($r.Json.library -eq $true) -and ($r.Json.libraryMaxBytes -eq 20971520) -and ($r.Text -notmatch 'capstan-library-test'))

    # -- token, Host, Origin --
    foreach ($route in @(@('GET', '/api/files'), @('POST', '/api/files'), @('PUT', '/api/files/abc?part=0'), @('GET', '/api/files/abc'), @('DELETE', '/api/files/abc'), @('POST', '/api/files/abc/complete'))) {
        $body = $null; $type = ''
        if ($route[0] -ne 'GET' -and $route[0] -ne 'DELETE') { $body = '{}'; $type = 'application/json' }
        $r = Call $route[0] $route[1] $body $type -Token ''
        Check ($route[0] + ' ' + $route[1] + ' without a token is refused') ($r.Status -eq 403) ('HTTP ' + $r.Status)
        $r = Call $route[0] $route[1] $body $type -Token ($script:token.Substring(0, 63) + 'x')
        Check ($route[0] + ' ' + $route[1] + ' with a wrong token is refused') ($r.Status -eq 403) ('HTTP ' + $r.Status)
    }
    $r = Call 'GET' '/api/files' -Headers @{ Origin = 'http://evil.example' }
    Check 'a foreign Origin is refused' ($r.Status -eq 403) ('HTTP ' + $r.Status)
    $r = Call 'GET' '/api/files' -Headers @{ Origin = ('http://127.0.0.1:' + $Port) }
    Check 'the page Origin is accepted' ($r.Status -eq 200) ('HTTP ' + $r.Status)
    $r = Call 'GET' '/api/files' -Headers @{ 'Sec-Fetch-Site' = 'cross-site' }
    Check 'a cross-site request is refused' ($r.Status -eq 403) ('HTTP ' + $r.Status)
    $st = Raw ("GET /api/files HTTP/1.1`r`nHost: evil.example`r`nX-Capstan-Token: " + $script:token + "`r`n`r`n")
    Check 'a wrong Host header gets no answer' ($st -eq 0) ('HTTP ' + $st)
    $st = Raw ("GET /api/files HTTP/1.1`r`nHost: localhost:" + $Port + "`r`nX-Capstan-Token: " + $script:token + "`r`n`r`n")
    Check 'Host: localhost is refused too (only 127.0.0.1:port)' ($st -eq 0) ('HTTP ' + $st)
    $r = Call 'GET' '/api/files'
    Check 'the index starts empty' (($r.Status -eq 200) -and ($r.Json.count -eq 0))

    # -- hostile ids over the wire --
    foreach ($rawTarget in @('/api/files/con', '/api/files/x:stream', '/api/files/ABC', '/api/files/a.b', '/api/files/%2e%2e', '/api/files/..%2f..%2fx', '/api/files/a%5cb', '/api/files/C%3a%5cx', '/api/files/aux?part=0', ('/api/files/' + ('a' * 81)))) {
        foreach ($m in @('GET', 'DELETE')) {
            $st = Raw ($m + ' ' + $rawTarget + " HTTP/1.1`r`nHost: " + $hostHeader + "`r`nX-Capstan-Token: " + $script:token + "`r`n`r`n")
            $short = $rawTarget; if ($short.Length -gt 30) { $short = $short.Substring(0, 30) + '...' }
            Check ($m + ' ' + $short + ' is refused') (($st -eq 400) -or ($st -eq 404)) ('HTTP ' + $st)
        }
    }
    foreach ($rawTarget in @('/api/files/a/b', '/api/files/../x', '/api/files/C:\x', '/api/files//x')) {
        $st = Raw ('GET ' + $rawTarget + " HTTP/1.1`r`nHost: " + $hostHeader + "`r`nX-Capstan-Token: " + $script:token + "`r`n`r`n")
        Check ('GET ' + $rawTarget + ' is not a route') (($st -eq 400) -or ($st -eq 404) -or ($st -eq 0)) ('HTTP ' + $st)
    }
    $r = Call 'POST' '/api/files' (Json @{ id = 'con'; size = 10 }) 'application/json'
    Check 'init with id "con" is refused (400)' ($r.Status -eq 400) ('HTTP ' + $r.Status)
    $r = Call 'POST' '/api/files' (Json @{ id = '../escape'; size = 10 }) 'application/json'
    Check 'init with id "../escape" is refused (400)' ($r.Status -eq 400) ('HTTP ' + $r.Status)
    $r = Call 'POST' '/api/files' (Json @{ id = 'x:stream'; size = 10 }) 'application/json'
    Check 'init with id "x:stream" is refused (400)' ($r.Status -eq 400) ('HTTP ' + $r.Status)
    $r = Call 'POST' '/api/files' (Json @{ id = 'C:\x'; size = 10 }) 'application/json'
    Check 'init with id "C:\x" is refused (400)' ($r.Status -eq 400) ('HTTP ' + $r.Status)

    # -- init validation --
    $r = Call 'POST' '/api/files' (Json @{ id = 'okid'; size = 0 }) 'application/json'
    Check 'init with size 0 is refused' ($r.Status -eq 400) ('HTTP ' + $r.Status)
    $r = Call 'POST' '/api/files' '{"id":"okid","size":"12"}' 'application/json'
    Check 'init with a text size is refused' ($r.Status -eq 400) ('HTTP ' + $r.Status)
    $r = Call 'POST' '/api/files' '{"id":"okid","size":1.5}' 'application/json'
    Check 'init with a fractional size is refused' ($r.Status -eq 400) ('HTTP ' + $r.Status)
    $r = Call 'POST' '/api/files' (Json @{ id = 'okid'; size = 20971521 }) 'application/json'
    Check 'init above the maximum file size is refused (413)' (($r.Status -eq 413) -and ($r.Json.code -eq 'too_large')) ('HTTP ' + $r.Status)
    $r = Call 'POST' '/api/files' (Json @{ id = 'okid'; size = 10; sha256 = 'abc' }) 'application/json'
    Check 'init with a malformed sha256 is refused' ($r.Status -eq 400) ('HTTP ' + $r.Status)
    $r = Call 'POST' '/api/files' (Json @{ id = 'okid'; size = 10; chunkSize = 100 }) 'application/json'
    Check 'init with a chunk size below the minimum is refused' ($r.Status -eq 400) ('HTTP ' + $r.Status)
    $r = Call 'POST' '/api/files' (Json @{ id = 'okid'; size = 10; chunkSize = 8388609 }) 'application/json'
    Check 'init with a chunk size above 8 MB is refused' ($r.Status -eq 400) ('HTTP ' + $r.Status)
    $r = Call 'POST' '/api/files' (Json @{ id = 'okid'; size = 10 }) 'text/plain'
    Check 'init that is not JSON is refused (415)' ($r.Status -eq 415) ('HTTP ' + $r.Status)
    $r = Call 'POST' '/api/files' ('{"id":"okid","size":10,"pad":"' + ('x' * 5000) + '"}') 'application/json'
    Check 'init with a body over 4 KB is refused (413)' ($r.Status -eq 413) ('HTTP ' + $r.Status)
    $r = Call 'POST' '/api/files' '[1,2]' 'application/json'
    Check 'init with a JSON array is refused' ($r.Status -eq 400) ('HTTP ' + $r.Status)
    $r = Call 'PUT' '/api/files' '{}' 'application/json'
    Check 'PUT on the collection is 405' ($r.Status -eq 405) ('HTTP ' + $r.Status)
    $r = Call 'GET' '/api/files/abc/complete'
    Check 'GET on /complete is 405' ($r.Status -eq 405) ('HTTP ' + $r.Status)
    $r = Call 'PUT' '/api/files/nothere?part=0' (New-Object byte[] 10) 'application/octet-stream'
    Check 'a chunk for an upload that was never started is 404' ($r.Status -eq 404) ('HTTP ' + $r.Status)
    $r = Call 'GET' '/api/files'
    Check 'nothing was stored by the refused calls' (($r.Json.count -eq 0) -and (@(Get-ChildItem -LiteralPath $uploadsDir -Force).Count -eq 0))

    # -- multi-chunk upload out of order (hash is re-read), download, Range --
    $chunk = 8388608
    $size = 2 * $chunk + 4321
    $data = RandomBytes $size
    $sha = Sha $data
    $r = Call 'POST' '/api/files' (Json @{ id = 'big_one'; size = $size; sha256 = $sha }) 'application/json'
    Check 'init of a three-part upload' (($r.Status -eq 200) -and ($r.Json.parts -eq 3) -and ($r.Json.chunkSize -eq $chunk) -and ($r.Json.received.Count -eq 0)) $r.Text
    $r = Put-Part 'big_one' 0 $data $chunk
    Check 'part 0 accepted' (($r.Status -eq 200) -and ($r.Json.received -eq 1)) $r.Text
    $r = Call 'POST' '/api/files/big_one/complete' '{}' 'application/json'
    Check 'complete with parts missing is 409 and lists them' (($r.Status -eq 409) -and ($r.Json.code -eq 'incomplete') -and (@($r.Json.missing).Count -eq 2)) $r.Text
    $r = Call 'POST' '/api/files' (Json @{ id = 'big_one'; size = $size; sha256 = $sha }) 'application/json'
    Check 'init again resumes and reports what arrived' (($r.Status -eq 200) -and ($r.Json.resumed -eq $true) -and (@($r.Json.received).Count -eq 1) -and ($r.Json.received[0] -eq 0)) $r.Text
    $r = Call 'POST' '/api/files' (Json @{ id = 'big_one'; size = $size + 1 }) 'application/json'
    Check 'init again with a different size is 409' ($r.Status -eq 409) ('HTTP ' + $r.Status)
    $r = Put-Part 'big_one' 2 $data $chunk
    Check 'the last, short part is accepted before part 1' ($r.Status -eq 200) $r.Text
    $r = Put-Part 'big_one' 1 $data $chunk
    Check 'part 1 accepted' ($r.Status -eq 200) $r.Text
    $r = Put-Part 'big_one' 1 $data $chunk
    Check 'a part can be sent again' ($r.Status -eq 200) $r.Text
    $r = Call 'POST' '/api/files/big_one/complete' '{}' 'application/json'
    Check 'complete checks size and sha256 and stores the file' (($r.Status -eq 200) -and ($r.Json.sha256 -eq $sha) -and ($r.Json.size -eq $size)) $r.Text
    $stored = Join-Path $libRoot 'big_one'
    Check 'the file is at library\big_one with the right size' ((Test-Path -LiteralPath $stored) -and ((Get-Item -LiteralPath $stored).Length -eq $size))
    Check 'no temp file is left in .uploads' (@(Get-ChildItem -LiteralPath $uploadsDir -Force).Count -eq 0)
    $r = Call 'GET' '/api/files'
    Check 'the index lists id, size and modified' (($r.Json.count -eq 1) -and ($r.Json.files[0].id -eq 'big_one') -and ($r.Json.files[0].size -eq $size) -and ($r.Json.files[0].modified -match '^\d{4}-\d\d-\d\dT'))
    $r = Call 'GET' '/api/files/big_one'
    Check 'GET returns the whole file, byte for byte' (($r.Status -eq 200) -and ($r.Bytes.Length -eq $size) -and ((Sha $r.Bytes) -eq $sha))
    Check 'GET says Accept-Ranges, no-store and nosniff' (((Get-RespHeader $r 'Accept-Ranges') -eq 'bytes') -and ((Get-RespHeader $r 'Cache-Control') -eq 'no-store') -and ((Get-RespHeader $r 'X-Content-Type-Options') -eq 'nosniff'))
    $r = Call 'GET' '/api/files/big_one' -Headers @{ Range = 'bytes=5-9' }
    Check 'Range bytes=5-9 gives 206 and those 5 bytes' (($r.Status -eq 206) -and ($r.Bytes.Length -eq 5) -and ((Sha $r.Bytes) -eq (Sha (Slice $data 5 5))) -and ((Get-RespHeader $r 'Content-Range') -eq ('bytes 5-9/' + $size)))
    $r = Call 'GET' '/api/files/big_one' -Headers @{ Range = ('bytes=' + $chunk + '-' + ($chunk + 99)) }
    Check 'Range across the chunk boundary reads the right bytes' (($r.Status -eq 206) -and ((Sha $r.Bytes) -eq (Sha (Slice $data $chunk 100))))
    $r = Call 'GET' '/api/files/big_one' -Headers @{ Range = 'bytes=-4' }
    Check 'Range bytes=-4 gives the last 4 bytes' (($r.Status -eq 206) -and ((Sha $r.Bytes) -eq (Sha (Slice $data ($size - 4) 4))))
    $r = Call 'GET' '/api/files/big_one' -Headers @{ Range = ('bytes=' + ($size - 10) + '-') }
    Check 'Range bytes=a- gives the tail' (($r.Status -eq 206) -and ($r.Bytes.Length -eq 10))
    $r = Call 'GET' '/api/files/big_one' -Headers @{ Range = ('bytes=0-' + ($size + 1000)) }
    Check 'Range past the end is clipped to the file' (($r.Status -eq 206) -and ($r.Bytes.Length -eq $size))
    $r = Call 'GET' '/api/files/big_one' -Headers @{ Range = ('bytes=' + $size + '-') }
    Check 'Range starting at the end is 416 with Content-Range */size' (($r.Status -eq 416) -and ((Get-RespHeader $r 'Content-Range') -eq ('bytes */' + $size)))
    $r = Call 'GET' '/api/files/big_one' -Headers @{ Range = 'bytes=0-1,3-4' }
    Check 'two ranges are refused (416)' ($r.Status -eq 416) ('HTTP ' + $r.Status)
    $r = Call 'GET' '/api/files/big_one' -Headers @{ Range = 'bytes=9-3' }
    Check 'a backwards range is refused (416)' ($r.Status -eq 416) ('HTTP ' + $r.Status)
    $r = Call 'GET' '/api/files/does_not_exist'
    Check 'GET of an unknown id is 404' ($r.Status -eq 404) ('HTTP ' + $r.Status)

    # -- in-order upload with small chunks (running hash), replacing a stored id --
    $chunk2 = 1048576
    $size2 = 3 * $chunk2 + 7
    $data2 = RandomBytes $size2
    $sha2 = Sha $data2
    $r = Call 'POST' '/api/files' (Json @{ id = 'big_one'; size = $size2; sha256 = $sha2; chunkSize = $chunk2 }) 'application/json'
    Check 'init of a four-part upload over an existing id' (($r.Status -eq 200) -and ($r.Json.parts -eq 4)) $r.Text
    for ($i = 0; $i -lt 4; $i++) { $r = Put-Part 'big_one' $i $data2 $chunk2; if ($r.Status -ne 200) { break } }
    Check 'four in-order parts accepted' ($r.Status -eq 200) $r.Text
    $r = Call 'POST' '/api/files/big_one/complete' '{}' 'application/json'
    Check 'complete replaces the stored file' (($r.Status -eq 200) -and ((Get-Item -LiteralPath $stored).Length -eq $size2)) $r.Text
    $r = Call 'GET' '/api/files/big_one'
    Check 'the replaced file reads back' ((Sha $r.Bytes) -eq $sha2)

    # -- sha256 given only at complete; wrong sha256 discards --
    $r = Call 'POST' '/api/files' (Json @{ id = 'late_sum'; size = 100 }) 'application/json'
    $small = RandomBytes 100
    [void](Call 'PUT' '/api/files/late_sum?part=0' $small 'application/octet-stream')
    $r = Call 'POST' '/api/files/late_sum/complete' (Json @{ sha256 = (Sha $small) }) 'application/json'
    Check 'sha256 can be given at complete' (($r.Status -eq 200) -and ($r.Json.sha256 -eq (Sha $small))) $r.Text
    $r = Call 'POST' '/api/files' (Json @{ id = 'bad_sum'; size = 100; sha256 = ('0' * 64) }) 'application/json'
    [void](Call 'PUT' '/api/files/bad_sum?part=0' $small 'application/octet-stream')
    $r = Call 'POST' '/api/files/bad_sum/complete' '{}' 'application/json'
    Check 'a wrong sha256 is refused (422) ...' (($r.Status -eq 422) -and ($r.Json.code -eq 'checksum_mismatch')) $r.Text
    Check '... and nothing is stored or left behind' ((-not (Test-Path -LiteralPath (Join-Path $libRoot 'bad_sum'))) -and (@(Get-ChildItem -LiteralPath $uploadsDir -Force).Count -eq 0))

    # -- part and chunk limits --
    $r = Call 'POST' '/api/files' (Json @{ id = 'limits'; size = 3000000; chunkSize = 1048576 }) 'application/json'
    $three = RandomBytes 3000000
    $r = Call 'PUT' '/api/files/limits?part=0' (Slice $three 0 1000) 'application/octet-stream'
    Check 'a chunk of the wrong length is refused (400)' (($r.Status -eq 400) -and ($r.Json.code -eq 'bad_part_length')) $r.Text
    $r = Call 'PUT' '/api/files/limits?part=3' (Slice $three 0 1048576) 'application/octet-stream'
    Check 'a part number past the end is refused (400)' ($r.Status -eq 400) $r.Text
    $r = Call 'PUT' '/api/files/limits?part=-1' (Slice $three 0 1048576) 'application/octet-stream'
    Check 'a negative part number is refused (400)' ($r.Status -eq 400) $r.Text
    $r = Call 'PUT' '/api/files/limits?part=0x1' (Slice $three 0 1048576) 'application/octet-stream'
    Check 'a part number that is not decimal is refused (400)' ($r.Status -eq 400) $r.Text
    $r = Call 'PUT' '/api/files/limits' (Slice $three 0 1048576) 'application/octet-stream'
    Check 'a chunk without a part number is refused (400)' ($r.Status -eq 400) $r.Text
    $r = Call 'PUT' '/api/files/limits?part=0' (Slice $three 0 1048576) 'text/plain'
    Check 'a chunk with the wrong content type is refused (415)' ($r.Status -eq 415) $r.Text
    $big = RandomBytes (9 * 1048576)
    $r = Call 'PUT' '/api/files/limits?part=0' $big 'application/octet-stream'
    Check 'a chunk bigger than 8 MB is refused (413) and the answer arrives' (($r.Status -eq 413) -and ($r.Json.code -eq 'chunk_too_large')) ('HTTP ' + $r.Status)
    $r = Call 'POST' '/api/files/limits/complete' '{}' 'application/json'
    Check 'nothing of the refused chunks was kept (all three parts still missing)' (($r.Status -eq 409) -and (@($r.Json.missing).Count -eq 3)) $r.Text
    # A body cut short: the part must not count as received.
    $headText = "PUT /api/files/limits?part=0 HTTP/1.1`r`nHost: " + $hostHeader + "`r`nX-Capstan-Token: " + $script:token + "`r`nContent-Type: application/octet-stream`r`nContent-Length: 1048576`r`n`r`n"
    [void](Raw $headText (Slice $three 0 100000) $true)
    Start-Sleep -Milliseconds 800
    $r = Call 'POST' '/api/files/limits/complete' '{}' 'application/json'
    Check 'a connection cut mid-chunk leaves the part missing' (($r.Status -eq 409) -and (@($r.Json.missing).Count -eq 3)) $r.Text

    # -- cancelled upload leaves nothing behind --
    [void](Put-Part 'limits' 0 $three 1048576)
    Check 'a part is on disk in .uploads while the upload is open' (Test-Path -LiteralPath (Join-Path $uploadsDir 'limits.part'))
    $r = Call 'DELETE' '/api/files/limits'
    Check 'DELETE aborts the upload' ($r.Status -eq 200) $r.Text
    Check 'the aborted upload left no temp file and no stored file' ((@(Get-ChildItem -LiteralPath $uploadsDir -Force).Count -eq 0) -and (-not (Test-Path -LiteralPath (Join-Path $libRoot 'limits'))))
    $r = Put-Part 'limits' 1 $three 1048576
    Check 'a chunk for the aborted upload is 404' ($r.Status -eq 404) ('HTTP ' + $r.Status)
    $r = Call 'DELETE' '/api/files/limits'
    Check 'DELETE of something that does not exist is 404' ($r.Status -eq 404) ('HTTP ' + $r.Status)
    [void](Call 'POST' '/api/files' (Json @{ id = 'keepme'; size = 100 }) 'application/json')
    [void](Call 'PUT' '/api/files/keepme?part=0' $small 'application/octet-stream')
    [void](Call 'POST' '/api/files/keepme/complete' '{}' 'application/json')
    [void](Call 'POST' '/api/files' (Json @{ id = 'keepme'; size = 100 }) 'application/json')
    $r = Call 'DELETE' '/api/files/keepme?upload=1'
    Check 'DELETE ?upload=1 aborts the new upload only ...' ($r.Status -eq 200) $r.Text
    $r = Call 'GET' '/api/files/keepme'
    Check '... and the stored file is still there' (($r.Status -eq 200) -and ($r.Bytes.Length -eq 100))
    $r = Call 'DELETE' '/api/files/keepme?upload=1'
    Check 'DELETE ?upload=1 with no upload is 404 and does not touch the stored file' (($r.Status -eq 404) -and (Test-Path -LiteralPath (Join-Path $libRoot 'keepme')))
    $r = Call 'DELETE' '/api/files/keepme'
    Check 'DELETE removes a stored file' (($r.Status -eq 200) -and (-not (Test-Path -LiteralPath (Join-Path $libRoot 'keepme'))))
    $r = Call 'GET' '/api/files/keepme'
    Check 'the removed file is 404' ($r.Status -eq 404) ('HTTP ' + $r.Status)

    # -- parallel upload limit (3 here) --
    $statuses = @()
    foreach ($n in 1..4) { $statuses += (Call 'POST' '/api/files' (Json @{ id = ('par' + $n); size = 100 }) 'application/json').Status }
    Check 'at most N uploads in parallel (the 4th is 429)' (($statuses[0] -eq 200) -and ($statuses[2] -eq 200) -and ($statuses[3] -eq 429)) ($statuses -join ',')
    foreach ($n in 1..3) { [void](Call 'DELETE' ('/api/files/par' + $n)) }

    # -- stale uploads are removed after the timeout (4 s here) --
    [void](Call 'POST' '/api/files' (Json @{ id = 'stale1'; size = 100 }) 'application/json')
    [void](Call 'PUT' '/api/files/stale1?part=0' $small 'application/octet-stream')
    Check 'the stale-upload test has a temp file to start with' (Test-Path -LiteralPath (Join-Path $uploadsDir 'stale1.part'))
    Start-Sleep -Seconds 7
    [void](Call 'GET' '/api/files')
    Check 'an idle upload is removed after the timeout' (-not (Test-Path -LiteralPath (Join-Path $uploadsDir 'stale1.part')))
    $r = Call 'PUT' '/api/files/stale1?part=0' $small 'application/octet-stream'
    Check 'a chunk for the timed-out upload is 404' ($r.Status -eq 404) ('HTTP ' + $r.Status)

    # -- an upload still open when the host ends does not survive it --
    [void](Call 'POST' '/api/files' (Json @{ id = 'open_end'; size = 100 }) 'application/json')
    [void](Call 'PUT' '/api/files/open_end?part=0' $small 'application/octet-stream')
    $r = Call 'POST' '/api/session/stop' '{}' 'application/json'
    $deadline = (Get-Date).AddSeconds(15)
    while (-not $proc.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    Check 'the host stops on End session' $proc.HasExited
    Check 'an upload open at shutdown is not kept' (@(Get-ChildItem -LiteralPath $uploadsDir -Force).Count -eq 0)
    Check 'a stored file survives the host' (Test-Path -LiteralPath $stored)

    Check 'no answer named the library folder or the user profile' (($script:allText.ToString() -notmatch [regex]::Escape($work)) -and ($script:allText.ToString() -notmatch 'AppData') -and ($script:allText.ToString() -notmatch [regex]::Escape($env:USERNAME + '\')))

    # -- the same files are found by a second host on another port (the point of the library) --
    $h2 = Start-TestHost ($Port + 1) @{ CAPSTAN_LIBRARY_ROOT = $libRoot }
    Check 'a second host (other port) started' ($null -ne $h2)
    if ($null -ne $h2) {
        $script:url = $h2.Url; $script:token = $h2.Token; $script:rawPort = $Port + 1
        $r = Call 'GET' '/api/files/big_one'
        Check 'a host on another port serves the same stored file' (($r.Status -eq 200) -and ((Sha $r.Bytes) -eq $sha2))
        $r = Call 'GET' '/api/files'
        Check 'its index lists it' (@($r.Json.files | Where-Object { $_.id -eq 'big_one' }).Count -eq 1)
        [void](Call 'POST' '/api/session/stop' '{}' 'application/json')
        $deadline = (Get-Date).AddSeconds(15)
        while (-not $h2.Proc.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    }

    # -- library off --
    $h3 = Start-TestHost ($Port + 2) @{ CAPSTAN_LIBRARY = '0'; CAPSTAN_LIBRARY_ROOT = $libRoot }
    Check 'a host with CAPSTAN_LIBRARY=0 started' ($null -ne $h3)
    if ($null -ne $h3) {
        $script:url = $h3.Url; $script:token = $h3.Token; $script:rawPort = $Port + 2
        $r = Call 'GET' '/api/health'
        Check 'health says library: false when it is off' (($r.Status -eq 200) -and ($r.Json.library -eq $false))
        $r = Call 'GET' '/api/files'
        Check 'the routes answer 404 when the library is off' ($r.Status -eq 404) ('HTTP ' + $r.Status)
        [void](Call 'POST' '/api/session/stop' '{}' 'application/json')
        $deadline = (Get-Date).AddSeconds(15)
        while (-not $h3.Proc.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    }
} catch {
    Check 'the live checks ran to the end' $false $_.Exception.Message
} finally {
    foreach ($x in @($proc, $(if ($h2) { $h2.Proc }), $(if ($h3) { $h3.Proc }))) { if ($x -and -not $x.HasExited) { try { $x.Kill() } catch { } } }
    $script:client.Dispose()
    try { Remove-Item -LiteralPath $work -Recurse -Force } catch { }
}

if ($script:failures -gt 0) { Write-Host ('' + $script:failures + ' library check(s) failed') -ForegroundColor Red; exit 1 }
Write-Host 'All library checks passed' -ForegroundColor Green
