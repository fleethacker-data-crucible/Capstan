<#
  Windows-only checks for the read-only SnapShackle captures routes (modules/Captures.ps1, issue #26).
  Plain PowerShell 5.1, no Pester needed: each check prints PASS/FAIL and the script exits 1 if any failed.
  Synthetic data only, in a temporary folder; the real SnapShackle folders are never read (the folder is
  chosen with the test-only CAPSTAN_TEST_CAPTURES variable, or a fake LOCALAPPDATA).
  Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests\ps\Captures.Tests.ps1
  CI runs it on the windows-host job (.github/workflows/tests.yml).
#>
[CmdletBinding()]
param([int]$Port = 18890)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $root 'modules/Captures.ps1')

$script:failures = 0
$script:skipped = @()
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) { Write-Host ('PASS  ' + $Name) -ForegroundColor Green }
    else { Write-Host ('FAIL  ' + $Name + '  ' + $Detail) -ForegroundColor Red; $script:failures++ }
}
function Skip([string]$Name, [string]$Why) { Write-Host ('SKIP  ' + $Name + '  ' + $Why) -ForegroundColor Yellow; $script:skipped += $Name }

foreach ($f in @('modules/Captures.ps1', 'modules/LocalHttp.ps1', 'Start-Capstan.ps1', 'tests/ps/Captures.Tests.ps1')) {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $f), [ref]$tokens, [ref]$errors)
    Check ($f + ' parses') ($errors.Count -eq 0) (($errors | ForEach-Object { $_.Message }) -join '; ')
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('capstan-captures-' + [guid]::NewGuid().ToString('N'))
$captures = Join-Path $tmp 'Captures'
[void](New-Item -ItemType Directory -Path $captures -Force)
$png = [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
$t0 = [DateTime]::UtcNow.AddDays(-1)
function Add-Capture([string]$Dir, [string]$Name, [byte[]]$Bytes, [double]$AgeMinutes, [string]$Sidecar = $null) {
    $p = Join-Path $Dir $Name
    [IO.File]::WriteAllBytes($p, $Bytes)
    [IO.File]::SetLastWriteTimeUtc($p, $t0.AddMinutes(-$AgeMinutes))
    if ($null -ne $Sidecar) { [IO.File]::WriteAllText(($p + '.meta.json'), $Sidecar, (New-Object Text.UTF8Encoding -ArgumentList $false)) }
}
function Meta([string]$Ocr) { return (ConvertTo-Json -InputObject ([ordered]@{ tags = @('t'); note = ''; ocr = $Ocr }) -Compress) }

$savedTest = $env:CAPSTAN_TEST_CAPTURES
$savedLocal = $env:LOCALAPPDATA
try {
    # ---- Names ----
    $good = @('SnapShackle-20260101-120000-123-abcd1234.png', 'a.png', 'My Shot (2).JPG', 'x_y-z+1.webp', 'clip.mp4', 'clip.WEBM', 'a.b.gif', 'c.jpeg', ('a' * 116 + '.png'))
    foreach ($n in $good) { Check ('accepted name: ' + $n.Substring(0, [Math]::Min(30, $n.Length))) (Test-CapstanCaptureName $n) }
    $hostile = [ordered]@{
        'dot dot backslash'       = '..\x.png'
        'dot dot percent 5c'      = '..%5cx.png'
        'dot dot slash'           = '../x.png'
        'inner double dot'        = 'a..b.png'
        'forward slash'           = 'a/b.png'
        'backslash'               = 'a\b.png'
        'drive path'              = 'C:\x.png'
        'drive relative'          = 'C:x.png'
        'UNC'                     = '\\server\share\x.png'
        'device con'              = 'con.png'
        'device CON upper'        = 'CON.PNG'
        'device nul'              = 'nul.png'
        'device com1'             = 'com1.png'
        'device lpt9'             = 'LPT9.webp'
        'device with space'       = 'con .png'
        'device extra extension'  = 'aux.x.png'
        'alternate data stream'   = 'x.png:stream'
        'ads default stream'      = 'x.png::$DATA'
        'trailing dot'            = 'x.png.'
        'trailing space'          = 'x.png '
        'leading space'           = ' x.png'
        'only a dot'              = '.'
        'only two dots'           = '..'
        'empty'                   = ''
        'no stem'                 = '.png'
        'no extension'            = 'x'
        'extension not allowed'   = 'x.exe'
        'svg'                     = 'x.svg'
        'html'                    = 'x.html'
        'bmp'                     = 'x.bmp'
        'sidecar read directly'   = 'x.png.meta.json'
        'json'                    = 'x.json'
        'png then exe'            = 'x.png.exe'
        'percent sign'            = 'x%2e.png'
        'short name tilde'        = 'CAPTUR~1.PNG'
        'newline'                 = ("x.png`n")
        'newline inside'          = ("x`n.png")
        'nul char'                = ("x.png" + [char]0)
        'tab'                     = "x`t.png"
        'wildcard'                = 'x*.png'
        'question mark'           = 'x?.png'
        'quote'                   = 'x".png'
        'angle'                   = 'x<.png'
        'unicode'                 = ('x' + [char]0x00e9 + '.png')
        'fullwidth dot'           = ('x' + [char]0xFF0E + 'png')
        '121 characters'          = ('a' * 117 + '.png')
    }
    foreach ($k in $hostile.Keys) { Check ('refused name: ' + $k) (-not (Test-CapstanCaptureName $hostile[$k])) }
    Check 'a non-string is refused' (-not (Test-CapstanCaptureName $null))
    Check 'a number is refused' (-not (Test-CapstanCaptureName 5))

    # ---- Route parsing keeps the name as the client sent it ----
    $r = Split-CapstanCaptureRoute '/api/snapshackle/captures'
    Check 'route: the list' ($r.kind -eq 'list')
    $r = Split-CapstanCaptureRoute '/api/snapshackle/captures?x=1'
    Check 'route: the list with a query' ($r.kind -eq 'list')
    $r = Split-CapstanCaptureRoute '/api/snapshackle/captures/My%20Shot%20(2).png'
    Check 'route: a percent-encoded space is decoded once' (($r.kind -eq 'file') -and $r.valid -and $r.name -eq 'My Shot (2).png')
    $r = Split-CapstanCaptureRoute '/api/snapshackle/captures/..%5cx.png'
    Check 'route: ..%5c is refused' (($r.kind -eq 'file') -and -not $r.valid)
    $r = Split-CapstanCaptureRoute '/api/snapshackle/captures/%252e%252e%255cx.png'
    Check 'route: double encoding is refused' (($r.kind -eq 'file') -and -not $r.valid)
    $r = Split-CapstanCaptureRoute '/api/snapshackle/captures/a%2fb.png'
    Check 'route: an encoded slash is refused' (($r.kind -eq 'file') -and -not $r.valid)
    $r = Split-CapstanCaptureRoute '/api/snapshackle/captures/a/b.png'
    Check 'route: a second path segment is refused' (($r.kind -eq 'file') -and -not $r.valid)
    $r = Split-CapstanCaptureRoute '/api/snapshackle/captures/%zz.png'
    Check 'route: a broken escape does not throw and is refused' (($r.kind -eq 'file') -and -not $r.valid)
    $r = Split-CapstanCaptureRoute '/api/snapshackle/capturesx'
    Check 'route: a longer word is not this route' ($r.kind -eq 'none')

    # ---- Folder choice ----
    $fake = Join-Path $tmp 'localappdata'
    [void](New-Item -ItemType Directory -Path $fake)
    $env:LOCALAPPDATA = $fake
    $env:CAPSTAN_TEST_CAPTURES = $null
    Check 'no captures folder: none found' ($null -eq (Get-CapstanCapturesRoot))
    [void](New-Item -ItemType Directory -Path (Join-Path $fake 'Lasso\Captures') -Force)
    Check 'only Lasso: Lasso is used' ((Get-CapstanCapturesRoot) -eq (Join-Path $fake 'Lasso\Captures'))
    [void](New-Item -ItemType Directory -Path (Join-Path $fake 'CutterMk\Captures') -Force)
    Check 'CutterMk wins over Lasso' ((Get-CapstanCapturesRoot) -eq (Join-Path $fake 'CutterMk\Captures'))
    [void](New-Item -ItemType Directory -Path (Join-Path $fake 'SnapShackle\Captures') -Force)
    Check 'SnapShackle wins over both' ((Get-CapstanCapturesRoot) -eq (Join-Path $fake 'SnapShackle\Captures'))
    $env:CAPSTAN_TEST_CAPTURES = (Join-Path $tmp 'does-not-exist')
    Check 'the test variable is the only candidate when set (a missing folder means none)' ($null -eq (Get-CapstanCapturesRoot))
    $env:CAPSTAN_TEST_CAPTURES = $captures
    Check 'the test variable points at its folder' ((Get-CapstanCapturesRoot) -eq $captures)
    $env:CAPSTAN_TEST_CAPTURES = ''
    Check 'an empty test variable is ignored' ((Get-CapstanCapturesRoot) -eq (Join-Path $fake 'SnapShackle\Captures'))
    $env:CAPSTAN_TEST_CAPTURES = '..\Captures'
    Check 'a relative test path is refused' ($null -eq (Get-CapstanCapturesRoot))
    $env:CAPSTAN_TEST_CAPTURES = '\\localhost\c$\Windows'
    Check 'a UNC test path is refused' ($null -eq (Get-CapstanCapturesRoot))
    $env:CAPSTAN_TEST_CAPTURES = $null
    $env:LOCALAPPDATA = $null
    Check 'no LOCALAPPDATA: none found, no error' ($null -eq (Get-CapstanCapturesRoot))
    $env:LOCALAPPDATA = $savedLocal

    # Folder that is itself a junction (no admin rights needed to make one).
    $junction = Join-Path $tmp 'rootlink'
    $made = $false
    try { cmd /c mklink /J ('"' + $junction + '"') ('"' + $captures + '"') 2>&1 | Out-Null; $made = Test-Path -LiteralPath $junction } catch { $made = $false }
    if ($made) {
        $env:CAPSTAN_TEST_CAPTURES = $junction
        Check 'a captures folder that is a junction is refused' ($null -eq (Get-CapstanCapturesRoot))
        $env:CAPSTAN_TEST_CAPTURES = $null
        cmd /c rmdir ('"' + $junction + '"') | Out-Null
    } else { Skip 'a captures folder that is a junction is refused' 'could not create a junction here' }

    # ---- Resolve ----
    $env:CAPSTAN_TEST_CAPTURES = $captures
    $rootNow = Get-CapstanCapturesRoot
    Add-Capture $captures 'one.png' $png 5
    [IO.File]::WriteAllBytes((Join-Path $tmp 'secret.png'), $png)
    Check 'resolves a plain file in the folder' ((Resolve-CapstanCapturePath $rootNow 'one.png') -eq (Join-Path $captures 'one.png'))
    Check 'a missing file resolves to nothing' ($null -eq (Resolve-CapstanCapturePath $rootNow 'missing.png'))
    Check 'a file outside the folder is never resolved' ($null -eq (Resolve-CapstanCapturePath $rootNow '..\secret.png'))
    Check 'a name with a drive is never resolved' ($null -eq (Resolve-CapstanCapturePath $rootNow ((Join-Path $tmp 'secret.png'))))
    Check 'only .meta.json is accepted as a suffix' ($null -eq (Resolve-CapstanCapturePath $rootNow 'one.png' '.exe'))
    [IO.Directory]::CreateDirectory((Join-Path $captures 'folder.png')) | Out-Null
    Check 'a folder named like an image is not a file' ($null -eq (Resolve-CapstanCapturePath $rootNow 'folder.png'))
    $dirJunction = Join-Path $captures 'junc.png'
    $made = $false
    try { cmd /c mklink /J ('"' + $dirJunction + '"') ('"' + $tmp + '"') 2>&1 | Out-Null; $made = Test-Path -LiteralPath $dirJunction } catch { $made = $false }
    if ($made) {
        Check 'a junction named like an image is refused' ($null -eq (Resolve-CapstanCapturePath $rootNow 'junc.png'))
        cmd /c rmdir ('"' + $dirJunction + '"') | Out-Null
    } else { Skip 'a junction named like an image is refused' 'could not create a junction here' }
    $link = Join-Path $captures 'link.png'
    $linked = $false
    try { New-Item -ItemType SymbolicLink -Path $link -Target (Join-Path $tmp 'secret.png') -ErrorAction Stop | Out-Null; $linked = Test-Path -LiteralPath $link } catch { $linked = $false }
    if ($linked) {
        Check 'a file symlink out of the folder is refused' ($null -eq (Resolve-CapstanCapturePath $rootNow 'link.png'))
        $names = @((Get-CapstanCaptureList $rootNow).captures | ForEach-Object { $_.name })
        Check 'a file symlink is not listed' ($names -notcontains 'link.png')
        Remove-Item -LiteralPath $link -Force
    } else { Skip 'a file symlink out of the folder is refused' 'creating a file symlink needs admin rights or Developer Mode on this machine' }
    Remove-Item -LiteralPath (Join-Path $captures 'folder.png') -Force -Recurse
    Remove-Item -LiteralPath (Join-Path $captures 'one.png') -Force

    # ---- Listing ----
    $empty = Get-CapstanCaptureList $rootNow
    Check 'an empty folder lists nothing' (@($empty.captures).Count -eq 0 -and $empty.total -eq 0)
    Add-Capture $captures 'old.png' $png 300 (Meta 'first line of old' )
    Add-Capture $captures 'new.png' $png 1 (Meta ("Invoice 4711`r`nsecond line"))
    Add-Capture $captures 'mid.jpg' $png 60
    Add-Capture $captures 'clip.mp4' $png 30
    Add-Capture $captures 'broken.gif' $png 100 '{ not json'
    Add-Capture $captures 'wrongtype.webp' $png 110 '{"ocr": 5}'
    Add-Capture $captures 'blank.webm' $png 120 (Meta '   ')
    [IO.File]::WriteAllText((Join-Path $captures 'notes.txt'), 'x')
    [IO.File]::WriteAllText((Join-Path $captures 'run.exe'), 'x')
    [IO.File]::WriteAllText((Join-Path $captures 'drawing.svg'), '<svg/>')
    [IO.File]::WriteAllText((Join-Path $captures 'orphan.png.meta.json'), (Meta 'orphan'))
    [IO.Directory]::CreateDirectory((Join-Path $captures 'sub')) | Out-Null
    Add-Capture (Join-Path $captures 'sub') 'inside.png' $png 1
    $list = Get-CapstanCaptureList $rootNow
    $names = @($list.captures | ForEach-Object { $_.name })
    Check 'listed newest first' (($names -join ',') -eq 'new.png,clip.mp4,mid.jpg,broken.gif,wrongtype.webp,blank.webm,old.png') ($names -join ',')
    Check 'only allowlisted names are listed (no txt, exe, svg, sidecars, subfolders)' ($names.Count -eq 7)
    Check 'total counts the usable files' ($list.total -eq 7 -and $list.limit -eq 500)
    $new = $list.captures[0]
    Check 'an item has name, size, modified, kind, hasOcr, ocr and nothing else' ((@($new.Keys) -join ',') -eq 'name,size,modified,kind,hasOcr,ocr') (@($new.Keys) -join ',')
    Check 'size is the file size' ($new.size -eq $png.Length)
    Check 'modified is UTC ISO 8601' (($new.modified -match '\A\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\z') -and [Math]::Abs(([DateTime]::Parse($new.modified).ToUniversalTime() - $t0.AddMinutes(-1)).TotalSeconds) -lt 1)
    Check 'an image is kind image' ($new.kind -eq 'image')
    Check 'a video is kind video' (($list.captures | Where-Object { $_.name -eq 'clip.mp4' }).kind -eq 'video')
    Check 'OCR text comes from the sidecar' (($new.hasOcr) -and $new.ocr.StartsWith('Invoice 4711'))
    Check 'no sidecar: no OCR' ((-not ($list.captures | Where-Object { $_.name -eq 'mid.jpg' }).hasOcr) -and (($list.captures | Where-Object { $_.name -eq 'mid.jpg' }).ocr -eq ''))
    Check 'a sidecar that is not JSON: no OCR' (-not ($list.captures | Where-Object { $_.name -eq 'broken.gif' }).hasOcr)
    Check 'a sidecar whose ocr is not text: no OCR' (-not ($list.captures | Where-Object { $_.name -eq 'wrongtype.webp' }).hasOcr)
    Check 'blank OCR text counts as none' (-not ($list.captures | Where-Object { $_.name -eq 'blank.webm' }).hasOcr)
    $json = ConvertTo-Json -InputObject $list -Depth 6 -Compress
    Check 'the list serialises with an array of captures' ($json.StartsWith('{"captures":['))
    Remove-Item -Path (Join-Path $captures '*') -Include *.png, *.jpg, *.mp4, *.gif, *.webp, *.webm, *.json -Force
    Add-Capture $captures 'solo.png' $png 1
    $solo = ConvertTo-Json -InputObject (Get-CapstanCaptureList $rootNow) -Depth 6 -Compress
    Check 'a single capture is still a JSON array' ($solo.StartsWith('{"captures":[{')) $solo

    # OCR cap
    $big = ('word ' * 8000)
    Add-Capture $captures 'ocr-big.png' $png 0.5 (Meta $big)
    $utf8 = New-Object Text.UTF8Encoding -ArgumentList $false
    $bigItem = (Get-CapstanCaptureList $rootNow).captures | Where-Object { $_.name -eq 'ocr-big.png' }
    Check 'OCR text is capped at 20 KB' ($utf8.GetByteCount($bigItem.ocr) -le 20480 -and $bigItem.ocr.Length -gt 20000) ([string]$utf8.GetByteCount($bigItem.ocr))
    $wide = ([string][char]0x20AC) * 9000
    Add-Capture $captures 'ocr-wide.png' $png 0.4 (Meta $wide)
    $wideItem = (Get-CapstanCaptureList $rootNow).captures | Where-Object { $_.name -eq 'ocr-wide.png' }
    Check 'the cap counts bytes, not characters' ($utf8.GetByteCount($wideItem.ocr) -le 20480 -and $wideItem.ocr.Length -gt 6000) ([string]$utf8.GetByteCount($wideItem.ocr))
    $pairs = ([string][char]0xD83D + [char]0xDE00) * 6000
    Add-Capture $captures 'ocr-pairs.png' $png 0.3 (Meta $pairs)
    $pairItem = (Get-CapstanCaptureList $rootNow).captures | Where-Object { $_.name -eq 'ocr-pairs.png' }
    Check 'the cap never leaves half a surrogate pair' (($utf8.GetByteCount($pairItem.ocr) -le 20480) -and ($pairItem.ocr.Length % 2 -eq 0)) ([string]$pairItem.ocr.Length)
    $huge = New-Object byte[] 600000
    for ($i = 0; $i -lt $huge.Length; $i++) { $huge[$i] = 32 }
    $prefix = $utf8.GetBytes('{"ocr":"secret"}')
    [Array]::Copy($prefix, $huge, $prefix.Length)
    $hp = Join-Path $captures 'ocr-huge.png'
    [IO.File]::WriteAllBytes($hp, $png)
    [IO.File]::WriteAllBytes(($hp + '.meta.json'), $huge)
    $hugeItem = (Get-CapstanCaptureList $rootNow).captures | Where-Object { $_.name -eq 'ocr-huge.png' }
    Check 'a sidecar over 512 KB is not read' (-not $hugeItem.hasOcr)

    # 500 limit and order over a larger folder
    $many = Join-Path $tmp 'Many'
    [void](New-Item -ItemType Directory -Path $many)
    for ($i = 1; $i -le 520; $i++) { Add-Capture $many ('cap-{0:0000}.png' -f $i) $png (600 - $i) }
    $env:CAPSTAN_TEST_CAPTURES = $many
    $manyRoot = Get-CapstanCapturesRoot
    $ml = Get-CapstanCaptureList $manyRoot
    Check 'the list stops at 500' (@($ml.captures).Count -eq 500 -and $ml.total -eq 520)
    Check 'the 500 are the newest' (($ml.captures[0].name -eq 'cap-0520.png') -and ($ml.captures[499].name -eq 'cap-0021.png'))
    $times = @($ml.captures | ForEach-Object { [DateTime]::Parse($_.modified) })
    $sorted = $true
    for ($i = 1; $i -lt $times.Count; $i++) { if ($times[$i] -gt $times[$i - 1]) { $sorted = $false; break } }
    Check 'modified times never increase down the list' $sorted
    # equal times: name order is stable
    $tie = Join-Path $tmp 'Tie'
    [void](New-Item -ItemType Directory -Path $tie)
    foreach ($n in @('b.png', 'a.png', 'c.png')) { Add-Capture $tie $n $png 10 }
    $env:CAPSTAN_TEST_CAPTURES = $tie
    $tl = Get-CapstanCaptureList (Get-CapstanCapturesRoot)
    Check 'equal times fall back to name order' ((@($tl.captures | ForEach-Object { $_.name }) -join ',') -eq 'a.png,b.png,c.png')

    # ---- The real host over HTTP ----
    # Add-Type compiles the transport in this process only when a test needs it; the host is its own process.
    $env:CAPSTAN_TEST_CAPTURES = $captures
    Remove-Item -Path (Join-Path $captures '*') -Recurse -Force
    Add-Capture $captures 'shot one.png' $png 10 (Meta "Hello world`nline two")
    Add-Capture $captures 'shot-two.PNG' $png 5 (Meta 'Totally different words')
    Add-Capture $captures 'video.mp4' $png 20
    Add-Capture $captures 'clip.webm' $png 21
    Add-Capture $captures 'pic.jpg' $png 22
    Add-Capture $captures 'pic2.jpeg' $png 23
    Add-Capture $captures 'pic.webp' $png 24
    Add-Capture $captures 'anim.gif' $png 25
    [IO.File]::WriteAllText((Join-Path $captures 'virus.exe'), 'MZ')
    [IO.File]::WriteAllText((Join-Path $captures 'shot one.png.meta.json.bak'), 'x')
    $rnd = New-Object Random 42
    $bigBytes = New-Object byte[] 5767168   # 5.5 MiB, not a multiple of the 1 MiB buffer
    $rnd.NextBytes($bigBytes)
    Add-Capture $captures 'big.webm' $bigBytes 1
    $exactBytes = New-Object byte[] 2097152
    $rnd.NextBytes($exactBytes)
    Add-Capture $captures 'exact.mp4' $exactBytes 2
    [IO.File]::WriteAllBytes((Join-Path $tmp 'secret.png'), [Text.Encoding]::ASCII.GetBytes('OUTSIDE-THE-FOLDER'))

    function Invoke-Raw([int]$P, [string]$Target, [string]$Token, [string]$Method = 'GET', [hashtable]$Extra = @{}) {
        $c = New-Object Net.Sockets.TcpClient
        try {
            $c.Connect('127.0.0.1', $P)
            $c.ReceiveTimeout = 30000
            $ns = $c.GetStream()
            $h = $Method + ' ' + $Target + " HTTP/1.1`r`nHost: 127.0.0.1:" + $P + "`r`n"
            if ($Token) { $h += "X-Capstan-Token: " + $Token + "`r`n" }
            foreach ($k in $Extra.Keys) { $h += $k + ': ' + $Extra[$k] + "`r`n" }
            if ($Method -ne 'GET') { $h += "Content-Length: 0`r`n" }
            $h += "`r`n"
            $req = [Text.Encoding]::ASCII.GetBytes($h)
            $ns.Write($req, 0, $req.Length)
            $ms = New-Object IO.MemoryStream
            $buf = New-Object byte[] 65536
            try { while (($n = $ns.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n) } } catch { }
            $all = $ms.ToArray()
            $head = [Text.Encoding]::ASCII.GetString($all, 0, [Math]::Min($all.Length, 8192))
            $end = $head.IndexOf("`r`n`r`n")
            $status = 0
            if ($head -match '\AHTTP/1\.1 (\d{3}) ') { $status = [int]$Matches[1] }
            $body = New-Object byte[] 0
            if ($end -ge 0) {
                $body = New-Object byte[] ($all.Length - $end - 4)
                [Array]::Copy($all, $end + 4, $body, 0, $body.Length)
            }
            return [pscustomobject]@{ Status = $status; Head = $(if ($end -ge 0) { $head.Substring(0, $end) } else { $head }); Body = $body; Text = [Text.Encoding]::UTF8.GetString($body) }
        } finally { $c.Dispose() }
    }
    function Get-Sha([byte[]]$Bytes) { return [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($Bytes)) }

    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $hostArgs = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $root 'Start-Capstan.ps1') + '"'), '-NoBrowser', '-Port', $Port, '--replace', '--stay')
    $proc = $null
    $proc2 = $null
    try {
        $logs = Join-Path $root 'logs'
        $proc = Start-Process -FilePath $ps -ArgumentList $hostArgs -PassThru -WindowStyle Hidden
        $runtime = Join-Path $logs ('capstan-server-' + $proc.Id + '.json')
        $deadline = (Get-Date).AddSeconds(40)
        while (-not (Test-Path $runtime) -and (Get-Date) -lt $deadline -and -not $proc.HasExited) { Start-Sleep -Milliseconds 200 }
        Check 'the host starts with a captures folder' (Test-Path $runtime)
        if (Test-Path $runtime) {
            $info = [IO.File]::ReadAllText($runtime) | ConvertFrom-Json
            $url = [string]$info.url
            $hp = [int]$info.port
            $page = (Invoke-WebRequest -Uri $url -UseBasicParsing).Content
            $token = ([regex]'name="capstan-session" content="([0-9a-f]+)"').Match($page).Groups[1].Value
            Check 'got the session token' ([bool]$token)

            $health = Invoke-Raw $hp '/api/health' $token
            Check 'health reports snapshackle: true when the folder exists' (($health.Status -eq 200) -and ($health.Text -match '"snapshackle":true')) $health.Text

            $noTok = Invoke-Raw $hp '/api/snapshackle/captures' $null
            Check 'the list needs the session token' ($noTok.Status -eq 403)
            $badTok = Invoke-Raw $hp '/api/snapshackle/captures' 'nope'
            Check 'the list refuses a wrong token' ($badTok.Status -eq 403)
            $noTokFile = Invoke-Raw $hp '/api/snapshackle/captures/shot-two.PNG' $null
            Check 'a file needs the session token' ($noTokFile.Status -eq 403)
            $origin = Invoke-Raw $hp '/api/snapshackle/captures' $token 'GET' @{ Origin = 'http://evil.example' }
            Check 'a foreign Origin is refused' ($origin.Status -eq 403)
            $site = Invoke-Raw $hp '/api/snapshackle/captures' $token 'GET' @{ 'Sec-Fetch-Site' = 'cross-site' }
            Check 'a cross-site fetch is refused' ($site.Status -eq 403)

            $lst = Invoke-Raw $hp '/api/snapshackle/captures' $token
            Check 'GET list: 200 JSON' (($lst.Status -eq 200) -and ($lst.Head -match 'Content-Type: application/json'))
            Check 'GET list: no CORS headers' ($lst.Head -notmatch 'Access-Control')
            $obj = $lst.Text | ConvertFrom-Json
            $got = @($obj.captures | ForEach-Object { $_.name })
            Check 'list: newest first and only allowlisted files' (($got -join ',') -eq 'big.webm,exact.mp4,shot-two.PNG,shot one.png,video.mp4,clip.webm,pic.jpg,pic2.jpeg,pic.webp,anim.gif') ($got -join ',')
            Check 'list: OCR text and flags' ((($obj.captures | Where-Object { $_.name -eq 'shot one.png' }).ocr -eq "Hello world`nline two") -and (($obj.captures | Where-Object { $_.name -eq 'shot one.png' }).hasOcr -eq $true) -and (($obj.captures | Where-Object { $_.name -eq 'video.mp4' }).hasOcr -eq $false))
            Check 'list: never echoes the folder path' ($lst.Text.IndexOf($tmp, [StringComparison]::OrdinalIgnoreCase) -lt 0)
            $q = Invoke-Raw $hp '/api/snapshackle/captures?x=%2e%2e%5c' $token
            Check 'list: a query string is ignored' ($q.Status -eq 200)
            $post = Invoke-Raw $hp '/api/snapshackle/captures' $token 'POST'
            Check 'list: POST is refused with 405 and Allow: GET' (($post.Status -eq 405) -and ($post.Head -match 'Allow: GET'))
            $del = Invoke-Raw $hp '/api/snapshackle/captures/shot-two.PNG' $token 'DELETE'
            Check 'file: DELETE is refused with 405' ($del.Status -eq 405)
            Check 'file: DELETE removed nothing' (Test-Path (Join-Path $captures 'shot-two.PNG'))
            $put = Invoke-Raw $hp '/api/snapshackle/captures/new.png' $token 'PUT'
            Check 'file: PUT is refused and writes nothing' (($put.Status -eq 405) -and -not (Test-Path (Join-Path $captures 'new.png')))

            $f1 = Invoke-Raw $hp '/api/snapshackle/captures/shot-two.PNG' $token
            Check 'file: 200 with the image bytes' (($f1.Status -eq 200) -and ((Get-Sha $f1.Body) -eq (Get-Sha $png)))
            Check 'file: content type from the extension' ($f1.Head -match 'Content-Type: image/png')
            Check 'file: nosniff and no-store' (($f1.Head -match 'X-Content-Type-Options: nosniff') -and ($f1.Head -match 'Cache-Control: no-store'))
            $f2 = Invoke-Raw $hp '/api/snapshackle/captures/shot%20one.png' $token
            Check 'file: a percent-encoded space finds the file' (($f2.Status -eq 200) -and ($f2.Body.Length -eq $png.Length))
            $types = [ordered]@{ 'video.mp4' = 'video/mp4'; 'clip.webm' = 'video/webm'; 'pic.jpg' = 'image/jpeg'; 'pic2.jpeg' = 'image/jpeg'; 'pic.webp' = 'image/webp'; 'anim.gif' = 'image/gif' }
            foreach ($n in $types.Keys) {
                $r = Invoke-Raw $hp ('/api/snapshackle/captures/' + $n) $token
                Check ('file: ' + $n + ' is served as ' + $types[$n]) (($r.Status -eq 200) -and ($r.Head -match ('Content-Type: ' + [regex]::Escape($types[$n])))) $r.Head
            }
            $fb = Invoke-Raw $hp '/api/snapshackle/captures/big.webm' $token
            Check 'file: a 5.5 MB file streams intact' (($fb.Status -eq 200) -and ($fb.Body.Length -eq $bigBytes.Length) -and ((Get-Sha $fb.Body) -eq (Get-Sha $bigBytes))) ('status ' + $fb.Status + ', ' + $fb.Body.Length + ' bytes')
            Check 'file: Content-Length matches' ($fb.Head -match ('Content-Length: ' + $bigBytes.Length))
            $fe = Invoke-Raw $hp '/api/snapshackle/captures/exact.mp4' $token
            Check 'file: a file of exactly two buffers streams intact' (($fe.Status -eq 200) -and ((Get-Sha $fe.Body) -eq (Get-Sha $exactBytes)))
            $fmissing = Invoke-Raw $hp '/api/snapshackle/captures/absent.png' $token
            Check 'file: a missing capture is 404 and says nothing about paths' (($fmissing.Status -eq 404) -and ($fmissing.Text.IndexOf($tmp, [StringComparison]::OrdinalIgnoreCase) -lt 0))

            $targets = [ordered]@{
                'dot dot backslash'     = '..\secret.png'
                'dot dot percent 5c'    = '..%5csecret.png'
                'dot dot upper hex 5C' = '..%5Csecret.png'
                'dot dot slash'         = '../secret.png'
                'dot dot encoded slash' = '..%2fsecret.png'
                'encoded dots'          = '%2e%2e%2fsecret.png'
                'double encoded'        = '..%255csecret.png'
                'a slash b'             = 'a/b.png'
                'drive path'            = 'C:\x.png'
                'encoded drive path'    = 'C%3a%5cx.png'
                'absolute with drive'   = ($tmp.Replace('\', '%5c') + '%5csecret.png')
                'con'                   = 'con.png'
                'CON upper'             = 'CON.PNG'
                'nul'                   = 'nul.png'
                'com1'                  = 'com1.png'
                'alternate data stream' = 'shot-two.PNG:stream'
                'encoded stream'        = 'shot-two.PNG%3astream'
                'default stream'        = 'shot-two.PNG::$DATA'
                'trailing dot'          = 'shot-two.PNG.'
                'trailing space'        = 'shot-two.PNG%20'
                'nul byte'              = 'shot-two.PNG%00'
                'dot dot'               = '..'
                'single dot'            = '.'
                'extension exe'         = 'virus.exe'
                'sidecar directly'      = 'shot%20one.png.meta.json'
                'svg'                   = 'x.svg'
                'too long'              = (('a' * 117) + '.png')
            }
            foreach ($k in $targets.Keys) {
                $r = Invoke-Raw $hp ('/api/snapshackle/captures/' + $targets[$k]) $token
                $leaked = $r.Text.Contains('OUTSIDE-THE-FOLDER') -or $r.Text.Contains('MZ')
                Check ('hostile name refused over HTTP: ' + $k) (($r.Status -ne 200) -and (-not $leaked)) ('status ' + $r.Status)
            }
            $r = Invoke-Raw $hp '/api/snapshackle/captures/con.png' $token
            Check 'a device name is a 400, not a hang' ($r.Status -eq 400)
            $r = Invoke-Raw $hp '/api/snapshackle/captures/..%5csecret.png' $token
            Check '..%5c is a 400 with the stable error shape' (($r.Status -eq 400) -and ($r.Text -eq '{"error":"Invalid capture name"}')) $r.Text
            $r = Invoke-Raw $hp '/api/snapshackle/captures/virus.exe' $token
            Check 'a file outside the extension allowlist is a 400 even though it exists' ($r.Status -eq 400)

            # A symlink swapped in after listing is refused when it is fetched.
            $swap = Join-Path $captures 'swap.png'
            $swapped = $false
            try { New-Item -ItemType SymbolicLink -Path $swap -Target (Join-Path $tmp 'secret.png') -ErrorAction Stop | Out-Null; $swapped = Test-Path -LiteralPath $swap } catch { $swapped = $false }
            if ($swapped) {
                $r = Invoke-Raw $hp '/api/snapshackle/captures/swap.png' $token
                Check 'a symlink inside the folder is not followed' (($r.Status -ne 200) -and -not $r.Text.Contains('OUTSIDE-THE-FOLDER'))
                Remove-Item -LiteralPath $swap -Force
            } else { Skip 'a symlink inside the folder is not followed (HTTP)' 'creating a file symlink needs admin rights or Developer Mode on this machine' }

            $r = Invoke-Raw $hp '/api/snapshackle/other' $token
            Check 'a sibling path is the generic 404' ($r.Status -eq 404)
            $r = Invoke-Raw $hp '/api/snapshackle/capturesx' $token
            Check 'a longer word is not the captures route' ($r.Status -eq 404)

            $r = Invoke-Raw $hp '/api/session/stop' $token 'POST'
            Check 'host stops on End session' ($r.Status -eq 200)
            $deadline = (Get-Date).AddSeconds(10)
            while (-not $proc.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
        }

        # No folder: health says false, the routes say so.
        $env:CAPSTAN_TEST_CAPTURES = (Join-Path $tmp 'nothing-here')
        $proc2 = Start-Process -FilePath $ps -ArgumentList $hostArgs -PassThru -WindowStyle Hidden
        $runtime2 = Join-Path $logs ('capstan-server-' + $proc2.Id + '.json')
        $deadline = (Get-Date).AddSeconds(40)
        while (-not (Test-Path $runtime2) -and (Get-Date) -lt $deadline -and -not $proc2.HasExited) { Start-Sleep -Milliseconds 200 }
        if (Test-Path $runtime2) {
            $info2 = [IO.File]::ReadAllText($runtime2) | ConvertFrom-Json
            $page2 = (Invoke-WebRequest -Uri ([string]$info2.url) -UseBasicParsing).Content
            $token2 = ([regex]'name="capstan-session" content="([0-9a-f]+)"').Match($page2).Groups[1].Value
            $h2 = Invoke-Raw ([int]$info2.port) '/api/health' $token2
            Check 'health reports snapshackle: false when there is no folder' (($h2.Status -eq 200) -and ($h2.Text -match '"snapshackle":false')) $h2.Text
            $l2 = Invoke-Raw ([int]$info2.port) '/api/snapshackle/captures' $token2
            Check 'the list without a folder is a 404 with a clear error' (($l2.Status -eq 404) -and ($l2.Text -eq '{"error":"No SnapShackle captures folder found"}')) $l2.Text
            $f3 = Invoke-Raw ([int]$info2.port) '/api/snapshackle/captures/x.png' $token2
            Check 'a file without a folder is a 404' ($f3.Status -eq 404)
            [void](Invoke-Raw ([int]$info2.port) '/api/session/stop' $token2 'POST')
        } else { Check 'the host without a folder started' $false }
    } finally {
        foreach ($x in @($proc, $proc2)) { if ($x -and -not $x.HasExited) { try { $x.Kill() } catch { } } }
    }
} finally {
    $env:CAPSTAN_TEST_CAPTURES = $savedTest
    $env:LOCALAPPDATA = $savedLocal
    # cmd rmdir first: Remove-Item must never follow a junction left by a failed check.
    foreach ($leftover in @((Join-Path $tmp 'rootlink'), (Join-Path $captures 'junc.png'))) {
        if (Test-Path -LiteralPath $leftover) { cmd /c rmdir ('"' + $leftover + '"') | Out-Null }
    }
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($script:skipped.Count -gt 0) { Write-Host ('' + $script:skipped.Count + ' check(s) skipped: ' + ($script:skipped -join '; ')) -ForegroundColor Yellow }
if ($script:failures -gt 0) { Write-Host ('' + $script:failures + ' captures check(s) failed') -ForegroundColor Red; exit 1 }
Write-Host 'All captures checks passed' -ForegroundColor Green
