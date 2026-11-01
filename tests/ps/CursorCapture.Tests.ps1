<#
  Windows-only checks for cursor and shortcut capture (modules/CursorCapture.ps1). Plain PowerShell 5.1, no
  Pester needed: each check prints PASS/FAIL and the script exits 1 if any failed.
  Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests\ps\CursorCapture.Tests.ps1

  SYNTHETIC INPUT ONLY. Nothing here reads the real mouse or keyboard: sessions run on Capstan.Cursor.ScriptedInput
  (a script of positions and held keys), the host is started with CAPSTAN_TEST_INPUT=1, and Win32Input, the one
  class that calls GetCursorPos and GetAsyncKeyState, is never constructed. Files go to a temporary folder.
#>
[CmdletBinding()]
param([int]$Port = 18890)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $root 'modules/LocalHttp.ps1')
. (Join-Path $root 'modules/Lifecycle.ps1')
. (Join-Path $root 'modules/CursorCapture.ps1')
[Net.ServicePointManager]::Expect100Continue = $false

$script:failures = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) { Write-Host ('PASS  ' + $Name) -ForegroundColor Green }
    else { Write-Host ('FAIL  ' + $Name + '  ' + $Detail) -ForegroundColor Red; $script:failures++ }
}
function Near([double]$A, [double]$B, [double]$Tolerance = 0.02) { return ([math]::Abs($A - $B) -le $Tolerance) }

$work = Join-Path ([IO.Path]::GetTempPath()) ('capstan-cursor-tests-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $work)
$savedEnv = @{ T = $env:CAPSTAN_TEST_INPUT; R = $env:CAPSTAN_TEST_RECORDINGS; M = $env:CAPSTAN_CURSOR_MAX_SECONDS }
$procs = @()
try {

# ---- the scripts parse under Windows PowerShell 5.1 ----
foreach ($f in @('modules/CursorCapture.ps1', 'tests/ps/CursorCapture.Tests.ps1', 'Start-Capstan.ps1')) {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $f), [ref]$tokens, [ref]$errors)
    Check ($f + ' parses') ($errors.Count -eq 0) (($errors | ForEach-Object { $_.Message }) -join '; ')
}

# ---- the key filter: what may be written down ----
# vk codes: letters 0x41-0x5A, digits 0x30-0x39, F5 0x74, Enter 0x0D, Space 0x20, Esc 0x1B, Tab 0x09, Del 0x2E
function KeyName([int]$Vk, [bool]$Ctrl = $false, [bool]$Alt = $false, [bool]$Shift = $false, [bool]$Win = $false, [bool]$AltGr = $false) {
    return [Capstan.Cursor.KeyNames]::Name($Vk, $Ctrl, $Alt, $Shift, $Win, $AltGr)
}
$leaks = @()
foreach ($vk in (0x41..0x5A + 0x30..0x39)) {
    if ($null -ne (KeyName $vk)) { $leaks += $vk }
    if ($null -ne (KeyName $vk $false $false $true)) { $leaks += $vk }
}
Check 'plain letters and digits are refused, with or without Shift' ($leaks.Count -eq 0) ($leaks -join ',')
$punct = @(0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF, 0xC0, 0xDB, 0xDC, 0xDD, 0xDE, 0x20, 0x0D, 0x08, 0x09, 0x1B, 0x2E, 0x25, 0x26, 0x27, 0x28, 0x60, 0x6B)
$leaks = @($punct | Where-Object { $null -ne (KeyName $_) -or $null -ne (KeyName $_ $false $false $true) })
Check 'plain punctuation, Enter, Space, Esc, Backspace, Tab, Delete, arrows and number pad are refused' ($leaks.Count -eq 0) ($leaks -join ',')
Check 'Shift alone is never a key' ($null -eq (KeyName 0x10 $false $false $true) -and $null -eq (KeyName 0xA0 $false $false $true) -and $null -eq (KeyName 0x41 $false $false $true))
Check 'a modifier key on its own is refused' ($null -eq (KeyName 0x11 $true) -and $null -eq (KeyName 0x12 $false $true) -and $null -eq (KeyName 0x5B $false $false $false $true) -and $null -eq (KeyName 0xA2 $true))
Check 'a letter with Ctrl is named Ctrl+C' ((KeyName 0x43 $true) -eq 'Ctrl+C')
Check 'a letter with Alt is named Alt+F' ((KeyName 0x46 $false $true) -eq 'Alt+F')
Check 'a letter with the Windows key is named Win+E' ((KeyName 0x45 $false $false $false $true) -eq 'Win+E')
Check 'modifiers come in the order Ctrl, Alt, Shift, Win' ((KeyName 0x1B $true $false $true) -eq 'Ctrl+Shift+Esc' -and (KeyName 0x2E $true $true) -eq 'Ctrl+Alt+Del' -and (KeyName 0x09 $false $true) -eq 'Alt+Tab')
Check 'a function key is named with or without a modifier' ((KeyName 0x74) -eq 'F5' -and (KeyName 0x74 $false $false $true) -eq 'Shift+F5' -and (KeyName 0x87) -eq 'F24')
Check 'punctuation with Ctrl keeps the key cap' ((KeyName 0xBF $true) -eq 'Ctrl+/' -and (KeyName 0xDC $true) -eq 'Ctrl+\')
Check 'AltGr (right Alt, which types characters) never counts as a modifier' ($null -eq (KeyName 0x51 $true $true $false $false $true) -and $null -eq (KeyName 0x74 $true $true $false $false $true))
Check 'Alt codes (Alt with number-pad digits) are refused' ($null -eq (KeyName 0x62 $false $true) -and $null -ne (KeyName 0x62 $true $true))
Check 'a name that would not fit the 24-character limit is refused' ($null -eq (KeyName 0x08 $true $true $true $true))
$longest = @([Capstan.Cursor.KeyNames]::Candidates | ForEach-Object { KeyName $_ $true $true $true $false } | Where-Object { $_ } | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum
Check 'every name that is produced fits 24 characters' ($longest -le 24) ('longest ' + $longest)

# ---- a validator for the version-1 rules of docs/cursor-data.md (the same rules as parseSidecar) ----
function Get-SidecarProblems([string]$Text) {
    $p = New-Object System.Collections.Generic.List[string]
    try { $o = $Text | ConvertFrom-Json } catch { return @('not valid JSON') }
    if ($o.format -ne 'capstan-cursor') { $p.Add('format') }
    if ($o.version -ne 1) { $p.Add('version') }
    $last = -1.0
    foreach ($s in @($o.samples)) {
        $v = @($s)
        if ($v.Count -ne 3) { $p.Add('sample is not a triple'); break }
        if ($v[0] -lt 0 -or $v[0] -gt 86400 -or $v[0] -lt $last) { $p.Add('sample time ' + $v[0]) }
        if ($v[1] -lt 0 -or $v[1] -gt 1 -or $v[2] -lt 0 -or $v[2] -gt 1) { $p.Add('sample outside 0..1: ' + ($v -join ',')) }
        $last = $v[0]
    }
    foreach ($c in @($o.clicks)) {
        if (@('left', 'right', 'middle') -notcontains $c.button) { $p.Add('button ' + $c.button) }
        if ($c.down -isnot [bool]) { $p.Add('click down is not a boolean') }
        if ($c.t -lt 0 -or $c.t -gt 86400) { $p.Add('click time') }
    }
    foreach ($k in @($o.keys)) {
        if ($k.key -isnot [string] -or $k.key.Length -lt 1 -or $k.key.Length -gt 24) { $p.Add('key name') }
        if ($k.down -isnot [bool]) { $p.Add('key down is not a boolean') }
        if ($k.t -lt 0 -or $k.t -gt 86400) { $p.Add('key time') }
    }
    if (@($o.samples).Count -gt 120000 -or @($o.clicks).Count -gt 20000 -or @($o.keys).Count -gt 50000) { $p.Add('over the limits') }
    if (@($o.samples).Count + @($o.clicks).Count + @($o.keys).Count -eq 0) { $p.Add('empty') }
    return @($p)
}
$bun = Get-Command bun -ErrorAction SilentlyContinue
function Check-WithParser([string]$Name, [string]$File) {
    # The real parser from src/engine/cursor.ts, when bun is installed (the CI runner has it).
    if (-not $bun) { Write-Host ('SKIP  ' + $Name + ' (bun not found)') -ForegroundColor DarkGray; return }
    $out = & $bun.Source (Join-Path $root 'tests/helpers/validate-sidecar.ts') $File 2>&1 | Out-String
    Check $Name ($LASTEXITCODE -eq 0) $out
}

# ---- the writer, on a scripted session ----
# Bounds: x 100..900, y 100..500 (800 x 400). The path goes across it, then outside it, then to the top left.
function New-Script {
    $in = New-Object Capstan.Cursor.ScriptedInput
    $in.AddMove(0, 100, 100); $in.AddMove(1, 900, 500); $in.AddMove(1.5, 1300, 900); $in.AddMove(2, -50, -50)
    $in.AddHold(0x41, 0.10, 0.20)   # plain A
    $in.AddHold(0x02, 0.20, 0.30)   # right button, inside the bounds
    $in.AddHold(0x10, 0.30, 0.40); $in.AddHold(0x41, 0.32, 0.38)   # Shift+A
    $in.AddHold(0x01, 0.50, 0.60)   # left button, inside
    $in.AddHold(0x11, 0.70, 0.90); $in.AddHold(0x43, 0.75, 0.85)   # Ctrl+C
    $in.AddHold(0x74, 1.00, 1.10)   # F5
    $in.AddHold(0x0D, 1.20, 1.30)   # Enter
    $in.AddHold(0x01, 1.70, 1.80)   # left button while the cursor is outside the bounds
    $in.Duration = 2
    return $in
}
function Run-Session($Session, $In, [double]$Seconds) {
    for ($i = 0; $i -le [int][math]::Ceiling($Seconds * 60); $i++) {
        $t = [math]::Min($Seconds, $i / 60.0)
        $In.SetTime($t)
        $Session.Tick($t, $true)
    }
}
$in = New-Script
$s = New-Object Capstan.Cursor.CursorSession -ArgumentList 'rec-test', 100, 100, 800, 400, $true, $in
Run-Session $s $in 2
$json = $s.ToJson()
$problems = Get-SidecarProblems $json
Check 'the writer output follows the version-1 rules' ($problems.Count -eq 0) ($problems -join '; ')
$file = Join-Path $work 'writer.cursor.json'
[IO.File]::WriteAllText($file, $json)
Check-WithParser 'the writer output is accepted by the real cursor parser' $file
$o = $json | ConvertFrom-Json
$samples = @($o.samples)
$mid = @($samples | Where-Object { (Near $_[0] 1.0 0.005) })[0]
Check 'positions are fractions of the bounds' ((Near $samples[0][1] 0 0.001) -and (Near $samples[0][2] 0 0.001) -and (Near $mid[1] 1 0.001) -and (Near $mid[2] 1 0.001))
Check 'positions outside the bounds are clamped to 0..1' (@($samples | Where-Object { $_[1] -lt 0 -or $_[1] -gt 1 -or $_[2] -lt 0 -or $_[2] -gt 1 }).Count -eq 0 -and (@($samples | Where-Object { $_[1] -eq 1 -and $_[2] -eq 1 }).Count -gt 0) -and (@($samples | Where-Object { $_[0] -gt 1.9 -and $_[1] -eq 0 -and $_[2] -eq 0 }).Count -gt 0))
Check 'about 60 samples a second on the session clock' ($samples.Count -ge 100 -and $samples.Count -le 125) ('' + $samples.Count)
Check 'times run from 0 and never go backwards' ($samples[0][0] -eq 0 -and (Near $samples[$samples.Count - 1][0] 2 0.001))
$clicks = @($o.clicks)
Check 'a press and a release are two events for the same button' ($clicks.Count -eq 4 -and $clicks[0].button -eq 'right' -and $clicks[0].down -eq $true -and $clicks[1].down -eq $false -and $clicks[2].button -eq 'left' -and $clicks[3].down -eq $false)
Check 'click times follow the script' ((Near $clicks[0].t 0.20) -and (Near $clicks[1].t 0.30) -and (Near $clicks[2].t 0.50) -and (Near $clicks[3].t 0.60))
Check 'a click while the cursor is outside the captured bounds is not recorded' (@($clicks | Where-Object { $_.t -gt 1.6 }).Count -eq 0)
$keys = @($o.keys)
Check 'only Ctrl+C and F5 are recorded, as presses and releases' (($keys | ForEach-Object { $_.key }) -join ',' -eq 'Ctrl+C,Ctrl+C,F5,F5')
Check 'plain A, Shift+A and Enter leave no trace anywhere in the file' ($json -notmatch '"key":"(A|Shift\+A|Enter|Shift)"' -and $keys.Count -eq 4)
Check 'key times follow the script' ((Near $keys[0].t 0.75) -and (Near $keys[1].t 0.85) -and (Near $keys[2].t 1.0) -and (Near $keys[3].t 1.1))

$in = New-Script
$s = New-Object Capstan.Cursor.CursorSession -ArgumentList 'rec-nokeys', 100, 100, 800, 400, $false, $in
Run-Session $s $in 2
$o = $s.ToJson() | ConvertFrom-Json
Check 'with key capture off, no key is recorded at all (clicks still are)' (@($o.keys).Count -eq 0 -and @($o.clicks).Count -eq 4)

# A key that is already held when capture starts is not a press.
$in = New-Object Capstan.Cursor.ScriptedInput
$in.AddMove(0, 10, 10); $in.AddHold(0x11, 0, 1); $in.AddHold(0x43, 0, 0.5); $in.AddHold(0x01, 0, 0.5)
$s = New-Object Capstan.Cursor.CursorSession -ArgumentList 'rec-held', 0, 0, 100, 100, $true, $in
Run-Session $s $in 1
Check 'keys and buttons held down at the start are not recorded as presses' ($s.KeyCount -eq 0 -and $s.ClickCount -eq 0)

# Key names with characters JSON must escape.
$in = New-Object Capstan.Cursor.ScriptedInput
$in.AddMove(0, 10, 10); $in.AddHold(0x11, 0.1, 0.5); $in.AddHold(0xDC, 0.2, 0.3); $in.AddHold(0xDE, 0.3, 0.4)
$s = New-Object Capstan.Cursor.CursorSession -ArgumentList 'rec-esc', 0, 0, 100, 100, $true, $in
Run-Session $s $in 1
$o = $s.ToJson() | ConvertFrom-Json
Check 'a backslash and a quote in a key name are escaped' ((@($o.keys) | Select-Object -First 1).key -eq 'Ctrl+\' -and (@($o.keys) | Where-Object { $_.key -eq "Ctrl+'" }))

# Pausing: no positions and no new presses while paused, but a press that was recorded is closed.
$in = New-Object Capstan.Cursor.ScriptedInput
$in.AddMove(0, 0, 0); $in.AddMove(1, 100, 100); $in.AddHold(0x01, 0.1, 0.5); $in.AddHold(0x02, 0.3, 0.4)
$s = New-Object Capstan.Cursor.CursorSession -ArgumentList 'rec-pause', 0, 0, 100, 100, $false, $in
foreach ($t in @(0, 0.05, 0.2)) { $in.SetTime($t); $s.Tick($t, $true) }
$before = $s.SampleCount
foreach ($t in @(0.3, 0.35, 0.6)) { $in.SetTime($t); $s.Tick($t, $false) }
Check 'a paused session records no positions' ($s.SampleCount -eq $before)
$o = $s.ToJson() | ConvertFrom-Json
Check 'a press recorded before the pause is released during it, and a press during the pause is not recorded' (@($o.clicks).Count -eq 2 -and @($o.clicks)[0].button -eq 'left' -and @($o.clicks)[1].down -eq $false -and @($o.clicks)[1].t -ge 0.6 - 0.001)

# A still cursor keeps 10 samples a second (pause detection needs them) instead of 60 identical ones.
$in = New-Object Capstan.Cursor.ScriptedInput
$in.AddMove(0, 50, 50)
$s = New-Object Capstan.Cursor.CursorSession -ArgumentList 'rec-still', 0, 0, 100, 100, $false, $in
Run-Session $s $in 5
Check 'a cursor that does not move is sampled at least 10 times a second, but not 60' ($s.SampleCount -ge 50 -and $s.SampleCount -le 65) ('' + $s.SampleCount)

# The sample limit: a long recording is thinned, not refused.
$in = New-Object Capstan.Cursor.ScriptedInput
$in.AddMove(0, 0, 0); $in.AddMove(2400, 100000, 50000)
$s = New-Object Capstan.Cursor.CursorSession -ArgumentList 'rec-long', 0, 0, 100000, 50000, $false, $in
$sw = [Diagnostics.Stopwatch]::StartNew()
for ($i = 0; $i -le 144000; $i++) { $t = $i / 60.0; $in.SetTime($t); $s.Tick($t, $true) }
$longJson = $s.ToJson()
Check 'a 40 minute recording stays within the 120,000 sample limit' ($s.SampleCount -le 120000 -and $s.SampleCount -ge 60000) ('' + $s.SampleCount + ' samples, ' + $sw.Elapsed.TotalSeconds + ' s')
$longFile = Join-Path $work 'long.cursor.json'
[IO.File]::WriteAllText($longFile, $longJson)
Check-WithParser 'the thinned long recording is accepted by the real cursor parser' $longFile
$tail = $longJson.Substring($longJson.IndexOf('],"clicks"') - 40)
Check 'a thinned recording still ends where it ended' ($tail -match '\[(2399\.9\d*|2400),[0-9.]+,1\]\],"clicks"') $tail

# ---- bounds checks ----
$rec = New-Object Capstan.Cursor.Recorder -ArgumentList (Join-Path $work 'bounds'), $true
$bad = @(
    @('zero width', 0, 0, 0, 100), @('zero height', 0, 0, 100, 0), @('negative width', 0, 0, -5, 100), @('half a pixel', 0, 0, 0.5, 100),
    @('NaN', [double]::NaN, 0, 100, 100), @('infinite', 0, 0, [double]::PositiveInfinity, 100), @('too wide', 0, 0, 200000, 100), @('origin far away', 5000000, 0, 100, 100)
)
foreach ($b in $bad) {
    $r = $rec.Start('bounds-test', $b[1], $b[2], $b[3], $b[4], $false, 10, $null)
    Check ('bounds refused: ' + $b[0]) ((-not $r.Ok) -and $r.Code -eq 'bad-request') ('' + $r.Ok + ' ' + $r.Code)
}
$r = $rec.Start('bounds-test', -1920, -200, 1920, 1080, $false, 10, $null)
Check 'a screen left of or above the primary one (negative origin) is accepted' ($r.Ok)
[void]$rec.Stop($r.Handle, $true)

# ---- ids and the recordings folder ----
$ok = @('rec-20261031-143012-abcd1234', 'a', 'A1', 'x_y-z', ('a' * 64))
$invalid = @($null, '', '.', '..', '../x', '..\x', 'a/b', 'a\b', 'C:x', 'C:\x', '\\server\share', 'a:stream', 'a.b', 'a.', 'a ', ' a', '-a', '_a', ('a' * 65), "a`n", "a`r`n", 'CON', 'con', 'NUL', 'Prn', 'aux', 'COM1', 'lpt9', 'a*', 'a?', 'a<b', 'a|b', 'a"b', [string][char]0x00E9)
Check 'ids from the strict pattern are accepted' (@($ok | Where-Object { -not [Capstan.Cursor.CursorStore]::ValidId($_) }).Count -eq 0)
$leaks = @($invalid | Where-Object { [Capstan.Cursor.CursorStore]::ValidId($_) })
Check 'ids with path parts, drive or UNC prefixes, streams, device names, dots, spaces or odd characters are refused' ($leaks.Count -eq 0) ($leaks -join ' | ')
$rootDir = Join-Path $work 'recordings'
$resolved = [Capstan.Cursor.CursorStore]::Resolve($rootDir, 'rec-1')
Check 'a file name is the id plus .cursor.json inside the root' ($resolved -eq (Join-Path $rootDir 'rec-1.cursor.json') -and (Test-Path $rootDir))
Check 'an invalid id never resolves to a path' ($null -eq [Capstan.Cursor.CursorStore]::Resolve($rootDir, '..\evil') -and $null -eq [Capstan.Cursor.CursorStore]::Resolve($rootDir, 'a/b'))
Check 'the writer writes the file and does not overwrite an existing one' ([Capstan.Cursor.CursorStore]::Write($rootDir, 'rec-1', '{"a":1}') -and -not [Capstan.Cursor.CursorStore]::Write($rootDir, 'rec-1', '{"a":2}') -and ([IO.File]::ReadAllText($resolved) -eq '{"a":1}'))
Check 'the file has no byte order mark and no temporary file is left behind' (([IO.File]::ReadAllBytes($resolved)[0]) -eq 0x7B -and @(Get-ChildItem $rootDir -Filter '*.tmp').Count -eq 0)
Check 'a bad id writes nothing' (-not [Capstan.Cursor.CursorStore]::Write($rootDir, '..\evil', '{}') -and @(Get-ChildItem $rootDir).Count -eq 1 -and -not (Test-Path (Join-Path $work 'evil.cursor.json')))
# A folder that is a junction to somewhere else is not trusted.
$target = Join-Path $work 'elsewhere'
[void](New-Item -ItemType Directory -Path $target)
$link = Join-Path $work 'linked'
cmd.exe /c mklink /J "$link" "$target" | Out-Null
if (Test-Path $link) {
    Check 'a recordings folder that is a junction is refused' ($null -eq [Capstan.Cursor.CursorStore]::Resolve($link, 'rec-1') -and -not [Capstan.Cursor.CursorStore]::Write($link, 'rec-1', '{}') -and @(Get-ChildItem $target).Count -eq 0)
} else { Write-Host 'SKIP  junction test (the junction could not be made)' -ForegroundColor DarkGray }

# ---- routes, without HTTP (the same function the host calls after its own checks) ----
$env:CAPSTAN_TEST_INPUT = '1'
$dir = Join-Path $work 'api'
$rec = New-CapstanCursorRecorder -Root $dir -TestInput $true
function Api($Method, $Path, $Body = $null, $Type = 'application/json') {
    $text = if ($null -eq $Body) { '' } elseif ($Body -is [string]) { $Body } else { ConvertTo-Json -InputObject $Body -Depth 6 -Compress }
    $r = Invoke-CapstanCursorApi -Recorder $rec -Method $Method -Path $Path -ContentType $Type -BodyText $text
    $parsed = $null
    try { $parsed = $r.Text | ConvertFrom-Json } catch { }
    return [pscustomobject]@{ Status = $r.Status; Text = $r.Text; Json = $parsed }
}
$bounds = @{ x = 0; y = 0; width = 1000; height = 500 }
$script1 = @{
    duration = 1
    moves = @(@{ t = 0; x = 0; y = 0 }, @{ t = 1; x = 1000; y = 500 })
    holds = @(@{ vk = 1; from = 0.2; to = 0.3 }, @{ vk = 17; from = 0.5; to = 0.7 }, @{ vk = 67; from = 0.55; to = 0.65 }, @{ vk = 65; from = 0.8; to = 0.9 })
}
$r = Api GET '/api/cursor/status'
Check 'status before anything: available, idle' ($r.Status -eq 200 -and $r.Json.available -eq $true -and $r.Json.active -eq $false -and $r.Json.testInput -eq $true)
Check 'status refuses POST' ((Api POST '/api/cursor/status' '{}').Status -eq 405)
Check 'an unknown cursor route is a 404' ((Api GET '/api/cursor/nope').Status -eq 404)
Check 'start refuses GET' ((Api GET '/api/cursor/start').Status -eq 405)
Check 'start refuses a body that is not application/json' ((Api POST '/api/cursor/start' '{}' 'text/plain').Status -eq 415 -and (Api POST '/api/cursor/start' '{}' '').Status -eq 415)
Check 'start accepts application/json with a charset' ((Api POST '/api/cursor/start' '{}' 'application/json; charset=utf-8').Status -eq 400)
Check 'start refuses a body that is not a JSON object' ((Api POST '/api/cursor/start' 'not json').Status -eq 400 -and (Api POST '/api/cursor/start' '[1,2]').Status -eq 400 -and (Api POST '/api/cursor/start' '').Status -eq 400)
Check 'start refuses a body over 4 KB' ((Api POST '/api/cursor/start' ('{"recordingId":"' + ('a' * 5000) + '"}')).Status -eq 413)
Check 'start refuses an invalid recording id' ((Api POST '/api/cursor/start' @{ recordingId = '..\x'; bounds = $bounds; keys = $false }).Status -eq 400 -and (Api POST '/api/cursor/start' @{ recordingId = 5; bounds = $bounds }).Status -eq 400 -and (Api POST '/api/cursor/start' @{ bounds = $bounds }).Status -eq 400)
Check 'start refuses missing, zero or non-numeric bounds' ((Api POST '/api/cursor/start' @{ recordingId = 'rec-x' }).Status -eq 400 -and (Api POST '/api/cursor/start' @{ recordingId = 'rec-x'; bounds = @{ x = 0; y = 0; width = 0; height = 10 } }).Status -eq 400 -and (Api POST '/api/cursor/start' @{ recordingId = 'rec-x'; bounds = @{ x = '0'; y = 0; width = 10; height = 10 } }).Status -eq 400)
Check 'start refuses keys that is not true or false' ((Api POST '/api/cursor/start' @{ recordingId = 'rec-x'; bounds = $bounds; keys = 'yes' }).Status -eq 400)
Check 'a refused start leaves nothing running' ((Api GET '/api/cursor/status').Json.active -eq $false)
Check 'test-inject refuses a bad script' ((Api POST '/api/cursor/test-inject' @{ moves = @(@{ t = 'x'; x = 1; y = 1 }) }).Status -eq 400 -and (Api POST '/api/cursor/test-inject' @{ holds = @(@{ vk = 999; from = 0; to = 1 }) }).Status -eq 400)
Check 'test-inject accepts a script' ((Api POST '/api/cursor/test-inject' $script1).Status -eq 200)

$r = Api POST '/api/cursor/start' @{ recordingId = 'rec-api-1'; bounds = $bounds; keys = $true }
$handle = [string]$r.Json.session
Check 'start returns a session handle, the host clock origin and the limits' ($r.Status -eq 200 -and $handle.Length -ge 16 -and $r.Json.originEpochMs -gt 1700000000000 -and $r.Json.hostElapsedMs -ge 0 -and $r.Json.hostElapsedMs -lt 1000 -and $r.Json.maxSeconds -eq 14400 -and $r.Json.keys -eq $true)
Check 'the origin is the current time' ([math]::Abs($r.Json.originEpochMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -lt 5000)
Check 'status shows the running session' ((Api GET '/api/cursor/status').Json.active -eq $true -and (Api GET '/api/cursor/status').Json.recordingId -eq 'rec-api-1')
$second = Api POST '/api/cursor/start' @{ recordingId = 'rec-api-2'; bounds = $bounds }
Check 'only one session at a time (a second start is a 409)' ($second.Status -eq 409 -and $second.Json.code -eq 'busy')
Check 'pausing and resuming name the session' ((Api POST '/api/cursor/pause' @{ session = $handle }).Status -eq 200 -and (Api GET '/api/cursor/status').Json.paused -eq $true -and (Api POST '/api/cursor/resume' @{ session = $handle }).Status -eq 200 -and (Api GET '/api/cursor/status').Json.paused -eq $false)
Check 'pause, resume and stop with a wrong or missing session are refused' ((Api POST '/api/cursor/pause' @{ session = 'nope' }).Status -eq 404 -and (Api POST '/api/cursor/resume' @{ }).Status -eq 400 -and (Api POST '/api/cursor/stop' @{ session = 'nope' }).Status -eq 404 -and (Api POST '/api/cursor/stop' @{ session = 5 }).Status -eq 400)
$stop = Api POST '/api/cursor/stop' @{ session = $handle }
$path = Join-Path $dir 'rec-api-1.cursor.json'
Check 'stop returns the cursor file and writes it to the recordings folder' ($stop.Status -eq 200 -and (Test-Path $path) -and ([IO.File]::ReadAllText($path) -eq $stop.Text))
$problems = Get-SidecarProblems $stop.Text
Check 'the returned file follows the version-1 rules' ($problems.Count -eq 0) ($problems -join '; ')
Check-WithParser 'the returned file is accepted by the real cursor parser' $path
$o = $stop.Json
Check 'positions follow the script as fractions of the bounds' ((Near $o.samples[0][1] 0 0.001) -and (Near @($o.samples)[-1][1] 1 0.001) -and (Near @($o.samples)[-1][2] 1 0.001))
Check 'the scripted click and Ctrl+C are in the file, the plain A is not' (@($o.clicks).Count -eq 2 -and (@($o.keys | ForEach-Object { $_.key }) -join ',') -eq 'Ctrl+C,Ctrl+C')
Check 'the folder holds only that file' (@(Get-ChildItem $dir).Count -eq 1)
Check 'the session is over: status idle, a second stop is a 404' ((Api GET '/api/cursor/status').Json.active -eq $false -and (Api POST '/api/cursor/stop' @{ session = $handle }).Status -eq 404)
$again = Api POST '/api/cursor/start' @{ recordingId = 'rec-api-1'; bounds = $bounds }
Check 'an id that already has a file is refused (a 409), never overwritten' ($again.Status -eq 409 -and $again.Json.code -eq 'exists' -and ([IO.File]::ReadAllText($path) -eq $stop.Text))

$r = Api POST '/api/cursor/start' @{ recordingId = 'rec-api-3'; bounds = $bounds; keys = $false }
$noKeys = Api POST '/api/cursor/stop' @{ session = $r.Json.session }
Check 'a recording started with keys off has no key events even though Ctrl+C is in the script' (@($noKeys.Json.keys).Count -eq 0 -and @($noKeys.Json.clicks).Count -eq 2)
$r = Api POST '/api/cursor/start' @{ recordingId = 'rec-api-4'; bounds = $bounds; keys = $true }
$gone = Api POST '/api/cursor/stop' @{ session = $r.Json.session; discard = $true }
Check 'stopping with discard writes nothing' ($gone.Status -eq 200 -and $gone.Json.discarded -eq $true -and -not (Test-Path (Join-Path $dir 'rec-api-4.cursor.json')))

# The maximum duration, in test mode through the environment, cuts the replay short.
$env:CAPSTAN_CURSOR_MAX_SECONDS = '0.5'
$r = Api POST '/api/cursor/start' @{ recordingId = 'rec-api-5'; bounds = $bounds; keys = $true }
$cut = Api POST '/api/cursor/stop' @{ session = $r.Json.session }
$env:CAPSTAN_CURSOR_MAX_SECONDS = $null
Check 'the maximum duration is reported by start' ($r.Json.maxSeconds -eq 0.5)
Check 'a session that runs past the maximum duration ends there' ($cut.Status -eq 200 -and (@($cut.Json.samples)[-1][0]) -le 0.5 -and (Api GET '/api/cursor/status').Json.lastReason -eq 'max-duration')

# Without CAPSTAN_TEST_INPUT the injection route does not exist.
$plain = New-Object Capstan.Cursor.Recorder -ArgumentList (Join-Path $work 'plain'), $false
$r = Invoke-CapstanCursorApi -Recorder $plain -Method POST -Path '/api/cursor/test-inject' -ContentType 'application/json' -BodyText '{}'
Check 'test-inject is a 404 when the host is not in test-input mode' ($r.Status -eq 404)
$r = Invoke-CapstanCursorApi -Recorder $null -Method GET -Path '/api/cursor/status'
Check 'with no recorder (the module could not load) the routes answer 503' ($r.Status -eq 503)
Check 'error answers never contain a path or exception text' (-not ((Api POST '/api/cursor/start' @{ recordingId = '..\..\Windows'; bounds = $bounds }).Text -match '[A-Za-z]:\\|Exception|\\\\'))

# ---- the real-time sampler (a script drives it, not the devices) ----
$rtDir = Join-Path $work 'realtime'
$rt = New-Object Capstan.Cursor.Recorder -ArgumentList $rtDir, $false
$mover = New-Object Capstan.Cursor.ScriptedInput
$mover.AddMove(0, 0, 0); $mover.AddMove(1.0, 1000, 500); $mover.AddMove(2.0, 0, 0)
$r = $rt.Start('rt-1', 0, 0, 1000, 500, $false, 10, $mover)
Check 'a real-time session starts' ($r.Ok -and $r.Handle)
$busy = $rt.Start('rt-2', 0, 0, 1000, 500, $false, 10, $mover)
Check 'a second real-time session is refused while one runs' ((-not $busy.Ok) -and $busy.Code -eq 'busy')
Start-Sleep -Milliseconds 1000
$st = $rt.Status()
Check 'the sampler runs at about 60 positions a second' ($st.Active -and $st.Samples -ge 30 -and $st.Samples -le 75) ('' + $st.Samples + ' samples in about 1 s')
$rt.Pause($r.Handle) | Out-Null
Start-Sleep -Milliseconds 100
$atPause = $rt.Status().Samples
Start-Sleep -Milliseconds 600
$during = $rt.Status()
Check 'pausing stops the sampling' ($during.Paused -and $during.Samples -eq $atPause) ('' + $atPause + ' -> ' + $during.Samples)
Check 'the session clock does not advance while paused' (($during.Seconds -lt 1.4) -and ($during.Seconds -gt 0.9)) ('' + $during.Seconds)
$rt.Resume($r.Handle) | Out-Null
Start-Sleep -Milliseconds 300
Check 'resuming continues the sampling' ($rt.Status().Samples -gt $atPause + 5)
$done = $rt.Stop($r.Handle, $false)
$o = $done.Json | ConvertFrom-Json
Check 'stop returns the file; the paused 0.6 s is not in it' ($done.Ok -and (@($o.samples)[-1][0]) -lt 1.75 -and (@($o.samples)[-1][0]) -gt 1.1) ('last sample at ' + (@($o.samples)[-1][0]))
Check 'the real-time file is on disk and follows the rules' ((Test-Path (Join-Path $rtDir 'rt-1.cursor.json')) -and (Get-SidecarProblems $done.Json).Count -eq 0)
Check 'after stop the sampler thread is gone' (-not $rt.Status().Active)

# Auto-stop after the maximum duration: the file is written by itself and stop hands it over once.
$r = $rt.Start('rt-auto', 0, 0, 1000, 500, $true, 0.5, $mover)
Start-Sleep -Milliseconds 1400
Check 'a session stops by itself at the maximum duration' ((-not $rt.Status().Active) -and $rt.Status().LastReason -eq 'max-duration' -and $rt.Status().LastSaved)
$autoPath = Join-Path $rtDir 'rt-auto.cursor.json'
$autoSamples = @()
if (Test-Path $autoPath) { $autoSamples = @(([IO.File]::ReadAllText($autoPath) | ConvertFrom-Json).samples) }
Check 'the auto-stopped file is on disk and ends by the limit' ((Test-Path $autoPath) -and $autoSamples.Count -gt 5 -and $autoSamples[$autoSamples.Count - 1][0] -le 0.55)
$late = $rt.Stop($r.Handle, $false)
Check 'stop after an auto-stop returns the same file, once' ($late.Ok -and $late.Json -eq [IO.File]::ReadAllText((Join-Path $rtDir 'rt-auto.cursor.json')) -and -not $rt.Stop($r.Handle, $false).Ok)

# Stopping the host finishes a running session.
$r = $rt.Start('rt-host', 0, 0, 1000, 500, $false, 10, $mover)
Start-Sleep -Milliseconds 200
$rt.Shutdown()
Check 'stopping the host stops a running session and writes its file' ((-not $rt.Status().Active) -and (Test-Path (Join-Path $rtDir 'rt-host.cursor.json')) -and $rt.Status().LastReason -eq 'host-stopped')
$r = $rt.Start('rt-again', 0, 0, 1000, 500, $false, 10, $mover)
Check 'a new session can start after the old one is finished' ($r.Ok)
$rt.Dispose()

# ---- the real host over HTTP, in test-input mode ----
$env:CAPSTAN_TEST_INPUT = '1'
$hostRecordings = Join-Path $work 'host-recordings'
$env:CAPSTAN_TEST_RECORDINGS = $hostRecordings
[void](Stop-CapstanProcesses -Root $root)
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$hostArgs = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $root 'Start-Capstan.ps1') + '"'), '-NoBrowser', '-Stay', '-Port', $Port, '--replace')
$proc = Start-Process -FilePath $ps -ArgumentList $hostArgs -PassThru -WindowStyle Hidden
$procs += $proc
$logs = Join-Path $root 'logs'
$runtime = Join-Path $logs ('capstan-server-' + $proc.Id + '.json')
$deadline = (Get-Date).AddSeconds(40)
while (-not (Test-Path $runtime) -and (Get-Date) -lt $deadline -and -not $proc.HasExited) { Start-Sleep -Milliseconds 200 }
Check 'the host starts with the cursor module' (Test-Path $runtime)
if (Test-Path $runtime) {
    $url = [string](([IO.File]::ReadAllText($runtime) | ConvertFrom-Json).url)
    $token = ([regex]'name="capstan-session" content="([0-9a-f]+)"').Match((Invoke-WebRequest -Uri $url -UseBasicParsing).Content).Groups[1].Value
    function Http([string]$Method, [string]$Route, $Body = $null, [hashtable]$Headers = @{}, [string]$Type = 'application/json', [bool]$Auth = $true) {
        $h = @{} + $Headers
        if ($Auth) { $h['X-Capstan-Token'] = $token }
        $args2 = @{ Uri = ($url + $Route.TrimStart('/')); Method = $Method; Headers = $h; UseBasicParsing = $true }
        if ($Method -eq 'POST') { $args2['Body'] = $(if ($null -eq $Body) { '{}' } elseif ($Body -is [string]) { $Body } else { ConvertTo-Json -InputObject $Body -Depth 6 -Compress }); $args2['ContentType'] = $Type }
        try { $r = Invoke-WebRequest @args2; return [pscustomobject]@{ Status = [int]$r.StatusCode; Text = $r.Content } }
        catch { $resp = $_.Exception.Response; $text = ''; if ($resp) { $text = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() }; return [pscustomobject]@{ Status = $(if ($resp) { [int]$resp.StatusCode } else { 0 }); Text = $text } }
    }
    Check 'cursor routes without the session token are refused (403)' ((Http GET 'api/cursor/status' $null @{} 'application/json' $false).Status -eq 403 -and (Http POST 'api/cursor/start' @{ recordingId = 'h1'; bounds = $bounds } @{} 'application/json' $false).Status -eq 403)
    Check 'the token in the body does not count on cursor routes' ((Http POST 'api/cursor/start' @{ recordingId = 'h1'; bounds = $bounds; session = $token } @{} 'application/json' $false).Status -eq 403)
    Check 'cursor routes from another origin are refused (403)' ((Http GET 'api/cursor/status' $null @{ Origin = 'http://evil.example' }).Status -eq 403)
    Check 'cursor routes from another site are refused (403)' ((Http GET 'api/cursor/status' $null @{ 'Sec-Fetch-Site' = 'cross-site' }).Status -eq 403)
    $st = Http GET 'api/cursor/status'
    Check 'status with the token: available, idle, test-input mode' ($st.Status -eq 200 -and ($st.Text | ConvertFrom-Json).available -eq $true -and ($st.Text | ConvertFrom-Json).testInput -eq $true)
    Check 'a non-JSON content type is refused (415)' ((Http POST 'api/cursor/start' '{}' @{} 'text/plain').Status -eq 415)
    $inj = Http POST 'api/cursor/test-inject' $script1
    Check 'test-inject works in test-input mode' ($inj.Status -eq 200)
    $st1 = Http POST 'api/cursor/start' @{ recordingId = 'host-1'; bounds = $bounds; keys = $true }
    $h1 = [string](($st1.Text | ConvertFrom-Json).session)
    Check 'start over HTTP returns a session' ($st1.Status -eq 200 -and $h1)
    Check 'a second start over HTTP is a 409' ((Http POST 'api/cursor/start' @{ recordingId = 'host-2'; bounds = $bounds }).Status -eq 409)
    Check 'GET on stop is a 405' ((Http GET 'api/cursor/stop').Status -eq 405)
    $sp = Http POST 'api/cursor/stop' @{ session = $h1 }
    $hostFile = Join-Path $hostRecordings 'host-1.cursor.json'
    Check 'stop over HTTP returns the file, which is also on disk' ($sp.Status -eq 200 -and (Test-Path $hostFile) -and ([IO.File]::ReadAllText($hostFile) -eq $sp.Text))
    Check 'the answer follows the version-1 rules' ((Get-SidecarProblems $sp.Text).Count -eq 0)
    # A session still running when the host stops is finished and written.
    $st2 = Http POST 'api/cursor/start' @{ recordingId = 'host-3'; bounds = $bounds; keys = $false }
    Check 'start for the shutdown check' ($st2.Status -eq 200)
    [void](Http POST 'api/session/stop' '{}')
    $deadline = (Get-Date).AddSeconds(15)
    while (-not $proc.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    Check 'End session stops the host' $proc.HasExited
    Check 'a session running when the host stopped has been written' (Test-Path (Join-Path $hostRecordings 'host-3.cursor.json'))
    Check 'the host left nothing but cursor files in the recordings folder' (@(Get-ChildItem $hostRecordings | Where-Object { $_.Name -notlike '*.cursor.json' }).Count -eq 0)
}

} finally {
    foreach ($x in $procs) { if ($x -and -not $x.HasExited) { try { $x.Kill() } catch { } } }
    $env:CAPSTAN_TEST_INPUT = $savedEnv.T; $env:CAPSTAN_TEST_RECORDINGS = $savedEnv.R; $env:CAPSTAN_CURSOR_MAX_SECONDS = $savedEnv.M
    Start-Sleep -Milliseconds 300
    # cmd rmdir removes a junction without following it.
    if (Test-Path (Join-Path $work 'linked')) { cmd.exe /c rmdir "$(Join-Path $work 'linked')" | Out-Null }
    try { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}

if ($script:failures -gt 0) { Write-Host ('' + $script:failures + ' cursor capture check(s) failed') -ForegroundColor Red; exit 1 }
Write-Host 'All cursor capture checks passed' -ForegroundColor Green
