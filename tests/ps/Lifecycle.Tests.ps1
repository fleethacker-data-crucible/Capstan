<#
  Windows-only checks for the host lifecycle (TechStack.md, "Lifecycle rules"). Plain PowerShell 5.1,
  no Pester needed: each check prints PASS/FAIL and the script exits 1 if any failed.
  Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests\ps\Lifecycle.Tests.ps1
  CI runs it on windows-latest (.github/workflows/tests.yml).
#>
[CmdletBinding()]
param([int]$Port = 18790)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $root 'modules/LocalHttp.ps1')
. (Join-Path $root 'modules/Lifecycle.ps1')
# The host rejects Expect: 100-continue, which Windows PowerShell's Invoke-WebRequest sends on POST by default.
[Net.ServicePointManager]::Expect100Continue = $false

$script:failures = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) { Write-Host ('PASS  ' + $Name) -ForegroundColor Green }
    else { Write-Host ('FAIL  ' + $Name + '  ' + $Detail) -ForegroundColor Red; $script:failures++ }
}

# ---- Scripts parse under Windows PowerShell 5.1 ----
foreach ($f in @('Start-Capstan.ps1', 'Stop-Capstan.ps1', 'modules/Lifecycle.ps1', 'modules/LocalHttp.ps1')) {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $f), [ref]$tokens, [ref]$errors)
    Check ($f + ' parses') ($errors.Count -eq 0) (($errors | ForEach-Object { $_.Message }) -join '; ')
}

# ---- Presence rule, with simulated time (no 20 s sleeps) ----
$t0 = [DateTime]::UtcNow
function At([double]$Seconds) { return $t0.AddSeconds($Seconds) }

$p = New-Object Capstan.Lifecycle.Presence -ArgumentList $true
Check 'never stops before any page has connected' (-not $p.ShouldStop((At 600)))
$p.Beat('a', $false, $false, (At 0))
Check 'alive 19 s after the last heartbeat' (-not $p.ShouldStop((At 19)))
Check 'stops 20 s after the last heartbeat' ($p.ShouldStop((At 20)))

$p = New-Object Capstan.Lifecycle.Presence -ArgumentList $true
$p.Beat('a', $false, $false, (At 0))
$p.Leaving('a', (At 1))
Check 'alive 4 s after a leaving signal' (-not $p.ShouldStop((At 5)))
Check 'stops 5 s after a leaving signal with no new heartbeat' ($p.ShouldStop((At 6)))

# A reload: the old page leaves, the new page (new id) beats inside the grace period.
$p = New-Object Capstan.Lifecycle.Presence -ArgumentList $true
$p.Beat('old', $false, $false, (At 0))
$p.Leaving('old', (At 1))
$p.Beat('new', $false, $false, (At 2))
Check 'a reload does not stop the host' (-not $p.ShouldStop((At 10)))
Check 'the reloaded page is the only live one' ($p.LiveTabs((At 10)) -eq 1)

# Two windows: closing one keeps the host; closing both stops it.
$p = New-Object Capstan.Lifecycle.Presence -ArgumentList $true
$p.Beat('a', $false, $false, (At 0)); $p.Beat('b', $false, $false, (At 0))
$p.Leaving('a', (At 1))
$p.Beat('b', $false, $false, (At 5))
Check 'one of two windows closed: still running' (-not $p.ShouldStop((At 8)))
$p.Leaving('b', (At 9))
Check 'both windows closed: stops' ($p.ShouldStop((At 15)))

# A host-side job blocks the stop; the next tick after it ends stops.
$p = New-Object Capstan.Lifecycle.Presence -ArgumentList $true
$p.Beat('a', $false, $false, (At 0))
$p.BeginJob()
Check 'waits while a host job runs' (-not $p.ShouldStop((At 120)))
$p.EndJob()
Check 'stops on the next tick after the job ends' ($p.ShouldStop((At 121)))

# An export or recording in the page (busy) or a minimised window gets the longer timeout.
$p = New-Object Capstan.Lifecycle.Presence -ArgumentList $true
$p.Beat('a', $false, $true, (At 0))
Check 'a busy page is not given up on after 20 s' (-not $p.ShouldStop((At 30)))
Check 'a busy page that stops beating is gone after 90 s' ($p.ShouldStop((At 90)))
$p = New-Object Capstan.Lifecycle.Presence -ArgumentList $true
$p.Beat('a', $true, $false, (At 0))
Check 'a hidden page is not given up on after 20 s' (-not $p.ShouldStop((At 60)))

# Off switch.
$p = New-Object Capstan.Lifecycle.Presence -ArgumentList $false
$p.Beat('a', $false, $false, (At 0)); $p.Leaving('a', (At 1))
Check 'auto-stop off: never stops' (-not $p.ShouldStop((At 3600)))
$saved = $env:CAPSTAN_AUTO_STOP
try {
    $env:CAPSTAN_AUTO_STOP = '0'; Check 'CAPSTAN_AUTO_STOP=0 turns auto-stop off' (-not (Test-CapstanAutoStop))
    $env:CAPSTAN_AUTO_STOP = $null; Check 'auto-stop is on by default' (Test-CapstanAutoStop)
} finally { $env:CAPSTAN_AUTO_STOP = $saved }

# ---- Transport: TryAccept returns to the loop when nobody connects ----
$srv = New-Object Capstan.Transport.Server -ArgumentList ($Port + 50), 20
try {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $none = $srv.TryAccept(200)
    Check 'TryAccept times out with no connection' (($null -eq $none) -and $sw.ElapsedMilliseconds -lt 2000)
} finally { $srv.Dispose() }

# ---- Runtime files: stale ones are removed on sight ----
$logs = Join-Path $root 'logs'
if (-not (Test-Path $logs)) { [void](New-Item -ItemType Directory -Path $logs) }
$stale = Join-Path $logs 'capstan-server-999999.json'
[IO.File]::WriteAllText($stale, '{"pid":999999,"port":1,"url":"http://127.0.0.1:1/","startedAt":"2020-01-01T00:00:00Z"}')
[void](Get-CapstanProcesses -Root $root)
Check 'a runtime file with a dead pid is removed' (-not (Test-Path $stale))

# ---- The real host: runtime file, heartbeat auth, leaving beacon, self-stop ----
[void](Stop-CapstanProcesses -Root $root)
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$hostArgs = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $root 'Start-Capstan.ps1') + '"'), '-NoBrowser', '-Port', $Port, '--replace')
$proc = Start-Process -FilePath $ps -ArgumentList $hostArgs -PassThru -WindowStyle Hidden
try {
    $runtime = Join-Path $logs ('capstan-server-' + $proc.Id + '.json')
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path $runtime) -and (Get-Date) -lt $deadline -and -not $proc.HasExited) { Start-Sleep -Milliseconds 200 }
    Check 'host writes logs\capstan-server-<pid>.json' (Test-Path $runtime)
    if (Test-Path $runtime) {
        $info = [IO.File]::ReadAllText($runtime) | ConvertFrom-Json
        $url = [string]$info.url
        Check 'runtime file has pid, port, url and startedAt' (($info.pid -eq $proc.Id) -and $info.port -and $url -and $info.startedAt)
        $page = (Invoke-WebRequest -Uri $url -UseBasicParsing).Content
        $token = ([regex]'name="capstan-session" content="([0-9a-f]+)"').Match($page).Groups[1].Value
        Check 'runtime file never holds the session token' ($token -and ([IO.File]::ReadAllText($runtime) -notmatch $token))
        $found = @(Get-CapstanProcesses -Root $root | Where-Object { $_.Pid -eq $proc.Id })
        Check 'Get-CapstanProcesses finds the host' ($found.Count -eq 1)

        $status = 0
        try { Invoke-WebRequest -Uri ($url + 'api/heartbeat') -Method Post -Body '{"tab":"x"}' -ContentType 'application/json' -UseBasicParsing | Out-Null; $status = 200 }
        catch { $status = [int]$_.Exception.Response.StatusCode }
        Check 'heartbeat without a token is refused' ($status -eq 403) ('HTTP ' + $status)
        $status = 0
        try { Invoke-WebRequest -Uri ($url + 'api/heartbeat') -Method Post -Headers @{ 'X-Capstan-Token' = $token; 'Origin' = 'http://evil.example' } -Body '{"tab":"x","leaving":true}' -ContentType 'application/json' -UseBasicParsing | Out-Null; $status = 200 }
        catch { $status = [int]$_.Exception.Response.StatusCode }
        Check 'heartbeat from another origin is refused' ($status -eq 403) ('HTTP ' + $status)
        $status = 0
        try { Invoke-WebRequest -Uri ($url + 'api/session/stop') -Method Post -Body ('{"session":"' + $token + '"}') -ContentType 'application/json' -UseBasicParsing | Out-Null; $status = 200 }
        catch { $status = [int]$_.Exception.Response.StatusCode }
        Check 'End session does not accept the token in the body' ($status -eq 403) ('HTTP ' + $status)

        $r = Invoke-WebRequest -Uri ($url + 'api/heartbeat') -Method Post -Headers @{ 'X-Capstan-Token' = $token } -Body '{"tab":"t1"}' -ContentType 'application/json' -UseBasicParsing
        Check 'heartbeat with the session header is accepted' ($r.StatusCode -eq 200)
        # The beacon: token in the body, no header.
        $r = Invoke-WebRequest -Uri ($url + 'api/heartbeat') -Method Post -Body ('{"tab":"t1","leaving":true,"session":"' + $token + '"}') -ContentType 'application/json' -UseBasicParsing
        Check 'leaving beacon with the token in the body is accepted' ($r.StatusCode -eq 200)
        Start-Sleep -Seconds 2
        Check 'host is still running inside the 5 s grace' (-not $proc.HasExited)
        $deadline = (Get-Date).AddSeconds(15)
        while (-not $proc.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
        Check 'host stops itself after the leaving grace' $proc.HasExited
        Check 'host deletes its runtime file on stop' (-not (Test-Path $runtime))
    }

    # End session and Stop-Capstan.ps1.
    $proc2 = Start-Process -FilePath $ps -ArgumentList $hostArgs -PassThru -WindowStyle Hidden
    $runtime2 = Join-Path $logs ('capstan-server-' + $proc2.Id + '.json')
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path $runtime2) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
    if (Test-Path $runtime2) {
        $url2 = [string](([IO.File]::ReadAllText($runtime2) | ConvertFrom-Json).url)
        $token2 = ([regex]'name="capstan-session" content="([0-9a-f]+)"').Match((Invoke-WebRequest -Uri $url2 -UseBasicParsing).Content).Groups[1].Value
        Invoke-WebRequest -Uri ($url2 + 'api/session/stop') -Method Post -Headers @{ 'X-Capstan-Token' = $token2 } -Body '{}' -ContentType 'application/json' -UseBasicParsing | Out-Null
        $deadline = (Get-Date).AddSeconds(10)
        while (-not $proc2.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
        Check 'End session stops the host' $proc2.HasExited
        Check 'End session removes the runtime file' (-not (Test-Path $runtime2))
    } else { Check 'second host started' $false }

    $proc3 = Start-Process -FilePath $ps -ArgumentList $hostArgs -PassThru -WindowStyle Hidden
    $runtime3 = Join-Path $logs ('capstan-server-' + $proc3.Id + '.json')
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path $runtime3) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
    $out = & $ps -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'Stop-Capstan.ps1') | Out-String
    Start-Sleep -Milliseconds 500
    Check 'Stop-Capstan.ps1 stops the host without a PID' ($proc3.HasExited) $out
    Check 'Stop-Capstan.ps1 says what it stopped' ($out -match ('PID ' + $proc3.Id)) $out
    Check 'Stop-Capstan.ps1 removes the runtime file' (-not (Test-Path $runtime3))
} finally {
    foreach ($x in @($proc, $proc2, $proc3)) { if ($x -and -not $x.HasExited) { try { $x.Kill() } catch { } } }
}

if ($script:failures -gt 0) { Write-Host ('' + $script:failures + ' lifecycle check(s) failed') -ForegroundColor Red; exit 1 }
Write-Host 'All lifecycle checks passed' -ForegroundColor Green
