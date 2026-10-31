<#
  Windows-only checks for the speech-to-text endpoint (modules/Speech.ps1, issue #24). Plain PowerShell 5.1,
  no Pester needed: each check prints PASS/FAIL and the script exits 1 if any failed.
  Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests\ps\Speech.Tests.ps1
  Everything but the last section uses the test-only fake engine (CAPSTAN_SPEECH_ENGINE=fake): no audio is
  recognised, no microphone is touched. The last section only calls the real engine's status.
#>
[CmdletBinding()]
param([int]$Port = 18791)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $root 'modules/Speech.ps1')
[Net.ServicePointManager]::Expect100Continue = $false

$script:failures = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) { Write-Host ('PASS  ' + $Name) -ForegroundColor Green }
    else { Write-Host ('FAIL  ' + $Name + '  ' + $Detail) -ForegroundColor Red; $script:failures++ }
}

foreach ($f in @('Start-Capstan.ps1', 'modules/Speech.ps1')) {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $f), [ref]$tokens, [ref]$errors)
    Check ($f + ' parses') ($errors.Count -eq 0) (($errors | ForEach-Object { $_.Message }) -join '; ')
}

# A WAV of silence with a little noise (the fake engine never reads it; the format check does).
function New-TestWav([double]$Seconds = 2, [int]$Rate = 16000, [int]$Channels = 1, [int]$Bits = 16, [int]$Format = 1) {
    $bytesPerSample = $Bits / 8
    $data = [int]($Seconds * $Rate * $Channels * $bytesPerSample)
    $ms = New-Object IO.MemoryStream
    $w = New-Object IO.BinaryWriter($ms)
    $w.Write([Text.Encoding]::ASCII.GetBytes('RIFF')); $w.Write([uint32](36 + $data)); $w.Write([Text.Encoding]::ASCII.GetBytes('WAVE'))
    $w.Write([Text.Encoding]::ASCII.GetBytes('fmt ')); $w.Write([uint32]16); $w.Write([uint16]$Format); $w.Write([uint16]$Channels)
    $w.Write([uint32]$Rate); $w.Write([uint32]($Rate * $Channels * $bytesPerSample)); $w.Write([uint16]($Channels * $bytesPerSample)); $w.Write([uint16]$Bits)
    $w.Write([Text.Encoding]::ASCII.GetBytes('data')); $w.Write([uint32]$data)
    $w.Write((New-Object byte[] $data))
    $w.Flush()
    return , $ms.ToArray()
}

function Invoke-Speech([string]$Method, [string]$Path, [string]$Query = '', [string]$Type = '', $Bytes = $null, [long]$Length = -1) {
    $body = $null
    if ($null -ne $Bytes) { $body = [IO.MemoryStream]::new([byte[]]$Bytes, $false); if ($Length -lt 0) { $Length = $Bytes.Length } }
    return (Invoke-CapstanSpeechRoute -Method $Method -Path $Path -Query $Query -ContentType $Type -ContentLength $Length -Body $body)
}

function Wait-SpeechJob([string]$Id, [int]$Seconds = 15) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        $r = Invoke-Speech 'GET' ('/api/speech/' + $Id)
        if ($r.Body.state -ne 'running') { return $r }
        Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $deadline)
    return $r
}

function Get-SpeechTempFiles {
    $dir = Join-Path $env:LOCALAPPDATA 'Capstan\tmp'
    if (-not (Test-Path -LiteralPath $dir)) { return @() }
    return @(Get-ChildItem -LiteralPath $dir -Filter 'speech-*.wav' -File)
}

$savedEngine = $env:CAPSTAN_SPEECH_ENGINE
$savedCultures = $env:CAPSTAN_SPEECH_FAKE_CULTURES
$savedDelay = $env:CAPSTAN_SPEECH_FAKE_DELAY_MS
try {
    # ---- the fake engine is off unless the environment asks for it ----
    $env:CAPSTAN_SPEECH_ENGINE = $null
    Check 'the fake engine is not selected by default' ((Get-CapstanSpeechEngineName) -eq 'windows')
    $env:CAPSTAN_SPEECH_ENGINE = 'on'
    Check 'only the value "fake" selects the fake engine' ((Get-CapstanSpeechEngineName) -eq 'windows')

    # ---- status ----
    $env:CAPSTAN_SPEECH_ENGINE = 'fake'
    $env:CAPSTAN_SPEECH_FAKE_CULTURES = $null
    $env:CAPSTAN_SPEECH_FAKE_DELAY_MS = $null
    $r = Invoke-Speech 'GET' '/api/speech/status'
    Check 'status: 200, engine says fake, available' (($r.Status -eq 200) -and ($r.Body.engine -eq 'fake') -and $r.Body.available)
    Check 'status: lists the installed cultures' ((@($r.Body.cultures) -join ',') -eq 'en-US,en-GB')
    Check 'status: states the size limit' ($r.Body.maxBytes -eq 30000000)
    Check 'status: is JSON that round-trips' ((ConvertTo-Json -InputObject $r.Body -Compress | ConvertFrom-Json).engine -eq 'fake')
    Check 'status: POST is not a route' ((Invoke-Speech 'POST' '/api/speech/status').Status -eq 404)

    # ---- transcribe ----
    $before = (Get-SpeechTempFiles).Count
    $env:CAPSTAN_SPEECH_FAKE_DELAY_MS = '1200'
    $wav = New-TestWav 2
    $r = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=en-US' 'audio/wav' $wav
    Check 'transcribe: 200 with a job id, running' (($r.Status -eq 200) -and ($r.Body.job -cmatch '^[0-9a-f]{32}$') -and ($r.Body.state -eq 'running'))
    $id = [string]$r.Body.job
    $path = $script:SpeechJobs[$id].WavPath
    $tmpRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Capstan\tmp'))
    Check 'transcribe: the audio is under %LOCALAPPDATA%\Capstan\tmp with a name made from the job id' (($path -eq (Join-Path $tmpRoot ('speech-' + $id + '.wav'))))
    Check 'transcribe: the audio is on disk while the job runs' (Test-Path -LiteralPath $path)
    Check 'transcribe: the file on disk is the WAV that was sent' ((Get-Item -LiteralPath $path).Length -eq $wav.Length)
    $busy = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=en-US' 'audio/wav' $wav
    Check 'transcribe: a second job while one runs is refused (409 busy)' (($busy.Status -eq 409) -and ($busy.Body.code -eq 'busy'))
    $done = Wait-SpeechJob $id
    Check 'transcribe: the job ends done' ($done.Body.state -eq 'done') ($done.Body.state)
    $segments = @($done.Body.segments)
    Check 'transcribe: three segments with start, end, text and confidence' (($segments.Count -eq 3) -and ($segments[0].text -eq 'This is the first fake caption.') -and ($segments[2].end -gt $segments[2].start) -and ($segments[1].confidence -gt 0))
    Check 'transcribe: segments are in order and inside the audio' (($segments[0].start -ge 0) -and ($segments[1].start -ge $segments[0].end) -and ($segments[2].end -le 2.0001))
    Check 'transcribe: the answer names the engine and culture' (($done.Body.engine -eq 'fake') -and ($done.Body.culture -eq 'en-US'))
    Check 'transcribe: the temp WAV is deleted when the job ends' (-not (Test-Path -LiteralPath $path))
    Check 'transcribe: no speech files are left behind' ((Get-SpeechTempFiles).Count -eq $before)
    Check 'transcribe: the finished job is identical on a second look (JSON)' ((ConvertTo-Json -InputObject (Invoke-Speech 'GET' ('/api/speech/' + $id)).Body -Depth 6 -Compress) -eq (ConvertTo-Json -InputObject $done.Body -Depth 6 -Compress))
    $gone = Invoke-Speech 'DELETE' ('/api/speech/' + $id)
    Check 'a finished job is forgotten by DELETE' (($gone.Status -eq 200) -and ((Invoke-Speech 'GET' ('/api/speech/' + $id)).Status -eq 404))

    $env:CAPSTAN_SPEECH_FAKE_DELAY_MS = $null
    $r = Invoke-Speech 'POST' '/api/speech/transcribe' '' 'audio/x-wav; charset=binary' $wav
    $d = Wait-SpeechJob ([string]$r.Body.job)
    Check 'transcribe: the language defaults to en-US and a content type with parameters is fine' (($d.Body.state -eq 'done') -and ($d.Body.culture -eq 'en-US'))
    $r = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=en' 'audio/wav' $wav
    $d = Wait-SpeechJob ([string]$r.Body.job)
    Check 'transcribe: a bare language picks an installed culture of it' (($d.Body.state -eq 'done') -and ($d.Body.culture -eq 'en-US'))
    $short = New-TestWav 0.3
    $r = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=en-US' 'audio/wav' $short
    $d = Wait-SpeechJob ([string]$r.Body.job)
    Check 'transcribe: very short audio gives one segment' (@($d.Body.segments).Count -eq 1)

    # ---- refusals ----
    $r = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=en-US' 'application/json' $wav
    Check 'refuses another content type (400 unsupported-type)' (($r.Status -eq 400) -and ($r.Body.code -eq 'unsupported-type'))
    $r = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=en-US' '' $wav
    Check 'refuses a missing content type' ($r.Status -eq 400)
    $r = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=en-US' 'audio/wav' ([Text.Encoding]::ASCII.GetBytes('this is not a wav file, not even close, no sir' * 3))
    Check 'refuses bytes that are not a WAV (400 unsupported-format)' (($r.Status -eq 400) -and ($r.Body.code -eq 'unsupported-format'))
    foreach ($case in @(
            @{ Name = 'stereo'; Wav = (New-TestWav 1 16000 2) },
            @{ Name = '44.1 kHz'; Wav = (New-TestWav 1 44100 1) },
            @{ Name = '8-bit'; Wav = (New-TestWav 1 16000 1 8) },
            @{ Name = 'float'; Wav = (New-TestWav 1 16000 1 32 3) })) {
        $r = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=en-US' 'audio/wav' $case.Wav
        Check ('refuses a ' + $case.Name + ' WAV (400 unsupported-format)') (($r.Status -eq 400) -and ($r.Body.code -eq 'unsupported-format')) ('' + $r.Status)
    }
    $cut = New-Object byte[] 1000; [Array]::Copy($wav, $cut, 1000)
    $r = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=en-US' 'audio/wav' $cut
    Check 'refuses a WAV that is cut short' (($r.Status -eq 400) -and ($r.Body.code -eq 'unsupported-format'))
    $r = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=en-US' 'audio/wav' $wav 30000001
    Check 'refuses audio over 30 MB (413 too-big)' (($r.Status -eq 413) -and ($r.Body.code -eq 'too-big'))
    $r = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=en-US%2F..' 'audio/wav' $wav
    Check 'refuses a malformed language (400)' (($r.Status -eq 400) -and ($r.Body.code -eq 'bad-culture'))
    $r = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=de-DE' 'audio/wav' $wav
    Check 'a language with no recogniser is refused (501 no-recogniser) and says how to add one' (($r.Status -eq 501) -and ($r.Body.code -eq 'no-recogniser') -and ($r.Body.error -match 'Language & region') -and ($r.Body.error -match 'Speech recognition'))
    $env:CAPSTAN_SPEECH_FAKE_CULTURES = 'none'
    $r = Invoke-Speech 'GET' '/api/speech/status'
    Check 'status lists no cultures when none are installed' (@($r.Body.cultures).Count -eq 0)
    $r = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=en-US' 'audio/wav' $wav
    Check 'with no recogniser installed, transcribe is refused (501 no-recogniser)' (($r.Status -eq 501) -and ($r.Body.code -eq 'no-recogniser'))
    $env:CAPSTAN_SPEECH_FAKE_CULTURES = $null
    Check 'refused requests leave no speech files behind' ((Get-SpeechTempFiles).Count -eq $before)
    $texts = ($r.Body | ConvertTo-Json -Compress)
    Check 'error text never carries the user folder' ($texts -notmatch [regex]::Escape($env:LOCALAPPDATA) -and $texts -notmatch [regex]::Escape($env:USERNAME))

    # ---- poll and cancel ----
    foreach ($bad in @('/api/speech/nope', ('/api/speech/' + ('0' * 31)), ('/api/speech/' + ('0' * 33)), '/api/speech/..%2F..', ('/api/speech/' + ('A' * 32)), ('/api/speech/' + ('0' * 32) + '/x'), '/api/other')) {
        Check ('unknown or malformed route ' + $bad + ' is a 404') ((Invoke-Speech 'GET' $bad).Status -eq 404)
    }
    Check 'an unknown job id is a 404 not-found' ((Invoke-Speech 'GET' ('/api/speech/' + ('0' * 32))).Body.code -eq 'not-found')
    Check 'PUT on a job is not a route' ((Invoke-Speech 'PUT' ('/api/speech/' + ('0' * 32))).Status -eq 404)

    $env:CAPSTAN_SPEECH_FAKE_DELAY_MS = '8000'
    $r = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=en-US' 'audio/wav' $wav
    $id = [string]$r.Body.job
    $path = $script:SpeechJobs[$id].WavPath
    Start-Sleep -Milliseconds 300
    $mid = Invoke-Speech 'GET' ('/api/speech/' + $id)
    Check 'progress is reported while a job runs' (($mid.Body.state -eq 'running') -and ($mid.Body.progress -gt 0) -and ($mid.Body.progress -lt 1)) ($mid.Body.progress)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $c = Invoke-Speech 'DELETE' ('/api/speech/' + $id)
    Check 'DELETE cancels a running job at once' (($c.Status -eq 200) -and ($c.Body.state -eq 'cancelled'))
    $after = Invoke-Speech 'GET' ('/api/speech/' + $id)
    Check 'the cancelled job reads as cancelled with a message' (($after.Body.state -eq 'cancelled') -and ($after.Body.code -eq 'cancelled') -and $after.Body.error)
    Check 'a cancelled job has no segments' ($null -eq $after.Body.segments)
    $deadline = (Get-Date).AddSeconds(5)
    while ((Test-Path -LiteralPath $path) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }
    Check 'the temp WAV is deleted after a cancel' (-not (Test-Path -LiteralPath $path)) ('' + $sw.ElapsedMilliseconds + ' ms')
    Check 'the worker stops promptly after a cancel' ($script:SpeechJobs[$id].Join(3000))
    $env:CAPSTAN_SPEECH_FAKE_DELAY_MS = $null
    $r = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=en-US' 'audio/wav' $wav
    Check 'after a cancel the next job can start' (($r.Status -eq 200) -and ((Wait-SpeechJob ([string]$r.Body.job)).Body.state -eq 'done'))

    # A stale file left by a killed host is swept (files younger than 2 minutes are left alone).
    $stale = Join-Path $tmpRoot ('speech-' + ('ab' * 16) + '.wav')
    [IO.File]::WriteAllBytes($stale, [byte[]](1, 2, 3))
    (Get-Item -LiteralPath $stale).LastWriteTime = (Get-Date).AddMinutes(-10)
    $other = Join-Path $tmpRoot 'not-ours.wav'
    [IO.File]::WriteAllBytes($other, [byte[]](1))
    (Get-Item -LiteralPath $other).LastWriteTime = (Get-Date).AddMinutes(-10)
    Clear-CapstanSpeechTemp
    Check 'an old speech-<id>.wav left by a killed host is removed' (-not (Test-Path -LiteralPath $stale))
    Check 'files that are not ours are never touched' (Test-Path -LiteralPath $other)
    Remove-Item -LiteralPath $other -Force

    # Host shutdown cancels running jobs and clears their audio.
    $env:CAPSTAN_SPEECH_FAKE_DELAY_MS = '8000'
    $r = Invoke-Speech 'POST' '/api/speech/transcribe' '?culture=en-US' 'audio/wav' $wav
    $path = $script:SpeechJobs[[string]$r.Body.job].WavPath
    Stop-CapstanSpeech
    Check 'Stop-CapstanSpeech cancels the job and removes its audio' ((-not (Test-Path -LiteralPath $path)) -and ($script:SpeechJobs[[string]$r.Body.job].State -eq 'cancelled'))
    $env:CAPSTAN_SPEECH_FAKE_DELAY_MS = $null
} catch {
    Check 'in-process checks ran without an error' $false $_.Exception.Message
}

# ---- through the real host: token, Host and Origin checks, then the whole round trip ----
# Lifecycle.ps1 and LocalHttp.ps1 give Stop-CapstanProcesses, to clear a stray host of this checkout first.
. (Join-Path $root 'modules/LocalHttp.ps1')
. (Join-Path $root 'modules/Lifecycle.ps1')
[void](Stop-CapstanProcesses -Root $root)
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$hostArgs = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $root 'Start-Capstan.ps1') + '"'), '-NoBrowser', '-Port', $Port, '--replace', '--stay')
$env:CAPSTAN_SPEECH_ENGINE = 'fake'
$env:CAPSTAN_SPEECH_FAKE_CULTURES = $null
$env:CAPSTAN_SPEECH_FAKE_DELAY_MS = '600'
$proc = Start-Process -FilePath $ps -ArgumentList $hostArgs -PassThru -WindowStyle Hidden
try {
    $logs = Join-Path $root 'logs'
    $runtime = Join-Path $logs ('capstan-server-' + $proc.Id + '.json')
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path $runtime) -and (Get-Date) -lt $deadline -and -not $proc.HasExited) { Start-Sleep -Milliseconds 200 }
    if (-not (Test-Path $runtime)) { Check 'the host started' $false }
    else {
        $url = [string](([IO.File]::ReadAllText($runtime) | ConvertFrom-Json).url)
        $token = ([regex]'name="capstan-session" content="([0-9a-f]+)"').Match((Invoke-WebRequest -Uri $url -UseBasicParsing).Content).Groups[1].Value
        function Send-Host([string]$Method, [string]$Path, $Headers = @{}, $Body = $null, [string]$Type = 'audio/wav') {
            try {
                $args2 = @{ Uri = ($url.TrimEnd('/') + $Path); Method = $Method; Headers = $Headers; UseBasicParsing = $true }
                if ($null -ne $Body) { $args2.Body = $Body; $args2.ContentType = $Type }
                $resp = Invoke-WebRequest @args2
                return @{ Status = [int]$resp.StatusCode; Json = ($resp.Content | ConvertFrom-Json) }
            } catch {
                $code = 0; $json = $null
                if ($_.Exception.Response) {
                    $code = [int]$_.Exception.Response.StatusCode
                    try { $json = $_.ErrorDetails.Message | ConvertFrom-Json } catch { }
                }
                return @{ Status = $code; Json = $json }
            }
        }
        $good = @{ 'X-Capstan-Token' = $token }
        Check 'host: status without the session token is refused (403)' ((Send-Host 'GET' '/api/speech/status').Status -eq 403)
        Check 'host: transcribe without the session token is refused (403)' ((Send-Host 'POST' '/api/speech/transcribe?culture=en-US' @{} (New-TestWav 1)).Status -eq 403)
        Check 'host: a wrong token is refused (403)' ((Send-Host 'GET' '/api/speech/status' @{ 'X-Capstan-Token' = ('0' * 64) }).Status -eq 403)
        Check 'host: the token in the query string does not count' ((Send-Host 'GET' ('/api/speech/status?token=' + $token)).Status -eq 403)
        Check 'host: another origin is refused (403)' ((Send-Host 'GET' '/api/speech/status' @{ 'X-Capstan-Token' = $token; 'Origin' = 'http://evil.example' }).Status -eq 403)
        $st = Send-Host 'GET' '/api/speech/status' $good
        Check 'host: status with the token says fake (the environment asked for it)' (($st.Status -eq 200) -and ($st.Json.engine -eq 'fake'))
        $wav = New-TestWav 2
        $start = Send-Host 'POST' '/api/speech/transcribe?culture=en-US' $good $wav
        Check 'host: transcribe starts a job' (($start.Status -eq 200) -and ($start.Json.job -cmatch '^[0-9a-f]{32}$')) ('' + $start.Status)
        $deadline = (Get-Date).AddSeconds(15)
        do { Start-Sleep -Milliseconds 150; $poll = Send-Host 'GET' ('/api/speech/' + $start.Json.job) $good } while ($poll.Json.state -eq 'running' -and (Get-Date) -lt $deadline)
        Check 'host: polling returns the three segments' (($poll.Json.state -eq 'done') -and (@($poll.Json.segments).Count -eq 3) -and ($poll.Json.segments[0].text -eq 'This is the first fake caption.'))
        Check 'host: polling without the token is refused' ((Send-Host 'GET' ('/api/speech/' + $start.Json.job)).Status -eq 403)
        Check 'host: not a WAV is a 400 with a code' ((Send-Host 'POST' '/api/speech/transcribe?culture=en-US' $good ([byte[]](1..200))).Json.code -eq 'unsupported-format')
        Check 'host: DELETE forgets the job' (((Send-Host 'DELETE' ('/api/speech/' + $start.Json.job) $good).Status -eq 200) -and ((Send-Host 'GET' ('/api/speech/' + $start.Json.job) $good).Status -eq 404))
        Check 'host: a speech route that does not exist is a 404' ((Send-Host 'GET' '/api/speech/other' $good).Status -eq 404)
    }
} finally {
    if ($proc -and -not $proc.HasExited) { try { $proc.Kill() } catch { } }
    $env:CAPSTAN_SPEECH_ENGINE = $savedEngine
    $env:CAPSTAN_SPEECH_FAKE_CULTURES = $savedCultures
    $env:CAPSTAN_SPEECH_FAKE_DELAY_MS = $savedDelay
}

# ---- the real engine: only that its status call does not throw ----
$env:CAPSTAN_SPEECH_ENGINE = $null
$haveSpeech = $false
try { Add-Type -AssemblyName System.Speech; $haveSpeech = $true } catch { }
if ($haveSpeech) {
    $threw = $null
    $real = $null
    try { $real = Get-CapstanSpeechStatus } catch { $threw = $_.Exception.Message }
    Check 'real engine: the status call does not throw when System.Speech is present' ($null -eq $threw) $threw
    Check 'real engine: status names the windows engine and lists cultures (possibly none)' (($real.engine -eq 'windows') -and ($null -ne $real.cultures))
    Check 'real engine: status is never reported as fake' ($real.engine -ne 'fake')
} else {
    Write-Host 'SKIP  real engine status (System.Speech is not available on this machine)' -ForegroundColor Yellow
}
$env:CAPSTAN_SPEECH_ENGINE = $savedEngine

if ($script:failures -gt 0) { Write-Host ('' + $script:failures + ' speech check(s) failed') -ForegroundColor Red; exit 1 }
Write-Host 'All speech checks passed' -ForegroundColor Green
