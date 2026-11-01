<#
  Windows-only checks for the global hotkeys and tray module (modules/Hotkeys.ps1). Plain PowerShell 5.1,
  no Pester needed: each check prints PASS/FAIL and the script exits 1 if any failed.
  Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests\ps\Hotkeys.Tests.ps1

  SYNTHETIC INPUT ONLY. This script never registers a real global hotkey, never creates a tray icon and
  never sends a key press. The C# is compiled and exercised through:
    - the pure parts (binding validation, the event queue),
    - a service with a fake registrar and no thread (the CAPSTAN_TEST_HOTKEYS=1 seam),
    - a service with a fake registrar on its real worker thread and message-only window (no key, no icon),
    - the real PowerShell host started with CAPSTAN_TEST_HOTKEYS=1 and called over HTTP.
#>
[CmdletBinding()]
param([int]$Port = 18890)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $root 'modules/LocalHttp.ps1')
. (Join-Path $root 'modules/Lifecycle.ps1')
. (Join-Path $root 'modules/Hotkeys.ps1')
[Net.ServicePointManager]::Expect100Continue = $false

$script:failures = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) { Write-Host ('PASS  ' + $Name) -ForegroundColor Green }
    else { Write-Host ('FAIL  ' + $Name + '  ' + $Detail) -ForegroundColor Red; $script:failures++ }
}

# ---- Scripts parse under Windows PowerShell 5.1, and the C# compiled ----
foreach ($f in @('Start-Capstan.ps1', 'modules/Hotkeys.ps1', 'modules/LocalHttp.ps1', 'tests/ps/Hotkeys.Tests.ps1')) {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $f), [ref]$tokens, [ref]$errors)
    Check ($f + ' parses') ($errors.Count -eq 0) (($errors | ForEach-Object { $_.Message }) -join '; ')
}
Check 'the C# compiles (Add-Type, inbox compiler)' ([bool]('Capstan.Hotkeys.HotkeyService' -as [type]))

# ---- Binding validation: the same corpus the TypeScript client and the Node mirror are tested with ----
$corpus = [IO.File]::ReadAllText((Join-Path $root 'tests/fixtures/hotkey-bindings.json')) | ConvertFrom-Json
$names = @([Capstan.Hotkeys.Chords]::KeyNames())
Check 'allowed key names match the shared list' (($names -join ',') -eq (@($corpus.keys) -join ',')) ($names -join ',')
Check 'modifiers are Ctrl, Alt, Shift' ((@([Capstan.Hotkeys.Chords]::ModifierNames()) -join ',') -eq 'Ctrl,Alt,Shift')
$bad = @()
foreach ($c in $corpus.cases) {
    $chord = $null; $err = $null
    $ok = [Capstan.Hotkeys.Chords]::TryParse([string]$c.input, [ref]$chord, [ref]$err)
    if ($ok -ne [bool]$c.ok) { $bad += ('"' + $c.input + '" ok=' + $ok); continue }
    if ($ok -and $chord.Text -ne [string]$c.normalized) { $bad += ('"' + $c.input + '" -> ' + $chord.Text) }
    if (-not $ok -and [string]::IsNullOrEmpty($err)) { $bad += ('"' + $c.input + '" gave no reason') }
}
Check ('binding validation agrees with the shared corpus (' + @($corpus.cases).Count + ' cases)') ($bad.Count -eq 0) ($bad -join '; ')
$chord = $null; $err = $null
[void][Capstan.Hotkeys.Chords]::TryParse('Ctrl+Shift+F9', [ref]$chord, [ref]$err)
Check 'Ctrl+Shift+F9 maps to MOD_CONTROL|MOD_SHIFT and VK_F9' (($chord.Modifiers -eq 6) -and ($chord.KeyCode -eq 0x78))
[void][Capstan.Hotkeys.Chords]::TryParse('Alt+A', [ref]$chord, [ref]$err)
Check 'Alt+A maps to MOD_ALT and VK_A' (($chord.Modifiers -eq 1) -and ($chord.KeyCode -eq 0x41))
$null = [Capstan.Hotkeys.Chords]::TryParse('Ctrl+Shift+F9; calc', [ref]$chord, [ref]$err)
Check 'a rejection reason never echoes the rejected text' (-not ([string]$err).Contains('calc'))

# ---- Event queue ----
$q = New-Object Capstan.Hotkeys.EventQueue
Check 'a new queue is empty at id 0' (($q.LastId -eq 0) -and @($q.Since(0)).Count -eq 0)
$a = $q.Add('start-stop'); $b = $q.Add('marker'); $c3 = $q.Add('tray-open')
Check 'event ids increase by one' (($a.Id -eq 1) -and ($b.Id -eq 2) -and ($c3.Id -eq 3))
Check 'Since returns only newer events, in order' ((@($q.Since(1)) | ForEach-Object { $_.Name }) -join ',' -eq 'marker,tray-open')
Check 'Since the last id returns nothing' (@($q.Since(3)).Count -eq 0)
$threw = $false
try { [void]$q.Add('format-c') } catch { $threw = $true }
Check 'an unknown event name is refused' $threw
$threw = $false
try { [void]$q.Add($null) } catch { $threw = $true }
Check 'a null event name is refused' $threw
for ($i = 0; $i -lt 150; $i++) { [void]$q.Add('marker') }
Check 'the queue keeps at most 100 events' (@($q.Since(0)).Count -eq 100)
Check 'ids keep increasing past the cap' ($q.LastId -eq 153)

# ---- Service without a thread (the seam): registering, releasing and a clash ----
$svc = New-Object Capstan.Hotkeys.HotkeyService -ArgumentList 'http://127.0.0.1:1/', $false, $false, $false
Check 'a service before Start has no results' (@($svc.Results()).Count -eq 0)
Check 'Start succeeds' $svc.Start()
Check 'the seam is marked simulated and not threaded' ($svc.Simulated -and -not $svc.Threaded)
$res = @($svc.Results())
Check 'defaults: Ctrl+Shift+F9, F10 and F11 are registered' ((($res | ForEach-Object { $_.Binding + '=' + $_.Registered }) -join ',') -eq 'Ctrl+Shift+F9=True,Ctrl+Shift+F10=True,Ctrl+Shift+F11=True')
Check 'three keys are held after registering' ($svc.HeldKeys -eq 3)
$wanted = New-Object 'System.Collections.Generic.Dictionary[string,string]'
$wanted['marker'] = 'ctrl + alt + m'
$r = $svc.Configure($wanted)
Check 'a valid change is accepted and normalised' ($r.Ok -and $svc.BindingText('marker') -eq 'Ctrl+Alt+M')
Check 'a change releases the old key and registers the new one (still three held)' ($svc.HeldKeys -eq 3)
$wanted = New-Object 'System.Collections.Generic.Dictionary[string,string]'
$wanted['marker'] = 'F5'
$r = $svc.Configure($wanted)
Check 'an invalid binding is refused with the field and a reason' ((-not $r.Ok) -and $r.Field -eq 'marker' -and $r.Error)
Check 'a refused change leaves the bindings alone' ($svc.BindingText('marker') -eq 'Ctrl+Alt+M')
$wanted = New-Object 'System.Collections.Generic.Dictionary[string,string]'
$wanted['marker'] = 'Ctrl+Shift+F9'
$r = $svc.Configure($wanted)
Check 'two actions cannot share a combination' ((-not $r.Ok) -and $r.Field -eq 'marker')
$wanted = New-Object 'System.Collections.Generic.Dictionary[string,string]'
$wanted['launch-missiles'] = 'Ctrl+Alt+L'
$r = $svc.Configure($wanted)
Check 'an unknown action is refused' (-not $r.Ok)
Check 'SimulateClash refuses an invalid combination' (-not $svc.SimulateClash('F9'))
Check 'SimulateClash marks a combination as taken' ($svc.SimulateClash('Ctrl+Shift+F10'))
$res = @($svc.Results())
$pause = $res | Where-Object { $_.Action -eq 'pause-resume' }
$start = $res | Where-Object { $_.Action -eq 'start-stop' }
Check 'a clash is reported for that key with a reason' ((-not $pause.Registered) -and $pause.Reason -match 'Another program')
Check 'the other keys stay registered (a clash is not fatal)' ($start.Registered -and $svc.HeldKeys -eq 2)
Check 'the service still runs after a clash' $svc.Running
Check 'SetState accepts idle, recording and paused' ($svc.SetState('recording') -and $svc.State -eq 'recording' -and $svc.SetState('paused') -and $svc.SetState('idle'))
Check 'SetState refuses anything else' ((-not $svc.SetState('exploding')) -and $svc.State -eq 'idle')
$item = $svc.Inject('pause-resume')
Check 'Inject queues an event with an id' ($item.Id -eq 1 -and $svc.Events.LastId -eq 1)
$svc.Stop(); $svc.Stop()
Check 'Stop is safe twice and releases every key' ((-not $svc.Running) -and $svc.HeldKeys -eq 0)
$wanted = New-Object 'System.Collections.Generic.Dictionary[string,string]'
$wanted['marker'] = 'Ctrl+Alt+M'
Check 'a stopped service refuses a change' (-not $svc.Configure($wanted).Ok)
$threw = $false
try { [void](New-Object Capstan.Hotkeys.HotkeyService -ArgumentList '', $true, $true, $false) } catch { $threw = $true }
Check 'real keys without the worker thread are refused' $threw

# ---- Service on its real worker thread and message-only window, with a fake registrar (no key, no icon) ----
$t = New-Object Capstan.Hotkeys.HotkeyService -ArgumentList 'http://127.0.0.1:1/', $false, $false, $true
$sw = [Diagnostics.Stopwatch]::StartNew()
Check 'the worker thread starts' $t.Start() $t.StartError
Check 'the thread is alive and the service is running' ($t.ThreadAlive -and $t.Running)
Check 'no tray icon is created without showTray' (-not $t.TrayVisible)
Check 'the keys were registered on the worker thread' ($t.HeldKeys -eq 3 -and @($t.Results() | Where-Object { $_.Registered }).Count -eq 3)
$wanted = New-Object 'System.Collections.Generic.Dictionary[string,string]'
$wanted['start-stop'] = 'Ctrl+Alt+F8'
Check 'a change is marshalled to the worker thread' ($t.Configure($wanted).Ok -and $t.BindingText('start-stop') -eq 'Ctrl+Alt+F8' -and $t.HeldKeys -eq 3)
Check 'a clash is reported from the worker thread' ($t.SimulateClash('Ctrl+Alt+F8') -and (@($t.Results() | Where-Object { -not $_.Registered }).Count -eq 1) -and $t.HeldKeys -eq 2)
Check 'SetState on the worker thread does not fail' ($t.SetState('recording') -and $t.SetState('idle'))
$t.Stop()
Check 'Stop ends the worker thread' (-not $t.ThreadAlive)
Check 'Stop released every key' ($t.HeldKeys -eq 0)
Check 'start, change, clash and stop took under 5 s' ($sw.Elapsed.TotalSeconds -lt 5) ([string]$sw.Elapsed.TotalSeconds)

# A service that is never stopped must not keep a process alive: the thread is a background thread.
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$childScript = '. "' + (Join-Path $root 'modules/Hotkeys.ps1') + '"; $s = New-Object Capstan.Hotkeys.HotkeyService -ArgumentList "", $false, $false, $true; if (-not $s.Start()) { exit 3 }; exit 0'
$child = Start-Process -FilePath $ps -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ('"' + $childScript.Replace('"', '\"') + '"')) -PassThru -WindowStyle Hidden
$exited = $child.WaitForExit(30000)
Check 'a process whose service was never stopped still exits (background thread)' ($exited -and $child.ExitCode -eq 0) ('exited=' + $exited)
if (-not $exited) { try { $child.Kill() } catch { } }

# ---- The API function with synthetic requests (no sockets) ----
function New-FakeRequest([string]$Method, [string]$PathAndQuery, [string]$Token, [string]$Body = '', [string]$ContentType = 'application/json') {
    $uri = [Uri]('http://127.0.0.1:' + $Port + $PathAndQuery)
    $qs = New-Object System.Collections.Specialized.NameValueCollection
    foreach ($pair in $uri.Query.TrimStart('?').Split('&')) {
        if ($pair) { $kv = $pair.Split([char[]]@('='), 2); $qs.Add($kv[0], $kv[1]) }
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
    $headers = New-Object System.Collections.Specialized.NameValueCollection
    if ($Token) { $headers.Add('X-Capstan-Token', $Token) }
    if ($Method -ne 'GET') { $headers.Add('Content-Type', $ContentType) }
    return [pscustomobject]@{ Url = $uri; HttpMethod = $Method; QueryString = $qs; Headers = $headers; InputStream = (New-Object IO.MemoryStream -ArgumentList (, $bytes)); ContentLength64 = [long]$bytes.Length }
}
$token = 'abc123def456abc123def456abc123def456'
$api = New-Object Capstan.Hotkeys.HotkeyService -ArgumentList '', $false, $false, $false
[void]$api.Start()
function Api($Request) { return Invoke-CapstanHotkeyApi -Service $api -Request $Request -SessionToken $token }

Check 'constant-time compare: equal tokens match' (Test-CapstanTokenEqual -Given $token -Expected $token)
Check 'constant-time compare: a longer or shorter token does not match' ((-not (Test-CapstanTokenEqual -Given ($token + 'x') -Expected $token)) -and (-not (Test-CapstanTokenEqual -Given $token.Substring(1) -Expected $token)))
Check 'constant-time compare: an empty or null token does not match' ((-not (Test-CapstanTokenEqual -Given '' -Expected $token)) -and (-not (Test-CapstanTokenEqual -Given $null -Expected $token)))

foreach ($route in @('/api/hotkeys/status', '/api/hotkeys/events', '/api/hotkeys/config', '/api/hotkeys/state')) {
    $m = if ($route -eq '/api/hotkeys/config') { 'PUT' } elseif ($route -eq '/api/hotkeys/state') { 'POST' } else { 'GET' }
    $body = if ($m -eq 'GET') { '' } else { '{}' }
    $res = Api (New-FakeRequest $m $route '' $body)
    Check ($route + ' without a token is refused') ($res.Status -eq 403)
    $res = Api (New-FakeRequest $m $route 'wrong' $body)
    Check ($route + ' with a wrong token is refused') ($res.Status -eq 403)
}

$res = Api (New-FakeRequest 'GET' '/api/hotkeys/status' $token)
Check 'status: 200 with registered, failed, bindings and the allowlist' (($res.Status -eq 200) -and @($res.Payload.registered).Count -eq 3 -and @($res.Payload.failed).Count -eq 0 -and $res.Payload.bindings['start-stop'] -eq 'Ctrl+Shift+F9' -and @($res.Payload.allowed.keys).Count -eq $names.Count)
Check 'status says why Capstan cannot be kept out of a capture' (($res.Payload.captureExclusion.possible -eq $false) -and ([string]$res.Payload.captureExclusion.reason).Contains('belong to that program'))
Check 'status says it is a simulated host' ($res.Payload.test -eq $true -and $res.Payload.available -eq $true)
Check 'status: POST is 405' ((Api (New-FakeRequest 'POST' '/api/hotkeys/status' $token '{}')).Status -eq 405)
Check 'an unknown hotkeys route is 404' ((Api (New-FakeRequest 'GET' '/api/hotkeys/nothing' $token)).Status -eq 404)
Check 'routes are case sensitive' ((Api (New-FakeRequest 'GET' '/API/HOTKEYS/STATUS' $token)).Status -eq 404)

# config
$ok = Api (New-FakeRequest 'PUT' '/api/hotkeys/config' $token '{"bindings":{"marker":"Ctrl+Alt+M","pause-resume":"alt+f7"}}')
Check 'config: valid bindings are applied and the new status returned' (($ok.Status -eq 200) -and $ok.Payload.bindings['marker'] -eq 'Ctrl+Alt+M' -and $ok.Payload.bindings['pause-resume'] -eq 'Alt+F7')
$r = Api (New-FakeRequest 'PUT' '/api/hotkeys/config' $token '{"bindings":{"marker":"F5"}}')
Check 'config: a binding without Ctrl or Alt is 400 with the field' (($r.Status -eq 400) -and $r.Payload.field -eq 'marker' -and $r.Payload.error)
$r = Api (New-FakeRequest 'PUT' '/api/hotkeys/config' $token '{"bindings":{"marker":"Ctrl+Alt+Win+M"}}')
Check 'config: a key outside the allowlist is 400' ($r.Status -eq 400)
$r = Api (New-FakeRequest 'PUT' '/api/hotkeys/config' $token '{"bindings":{"marker":7}}')
Check 'config: a non-text binding is 400' ($r.Status -eq 400)
$r = Api (New-FakeRequest 'PUT' '/api/hotkeys/config' $token '{"bindings":{"rm -rf":"Ctrl+Alt+M"}}')
Check 'config: an unknown action is 400' ($r.Status -eq 400)
$r = Api (New-FakeRequest 'PUT' '/api/hotkeys/config' $token '{"bindings":{}}')
Check 'config: an empty set is 400' ($r.Status -eq 400)
$r = Api (New-FakeRequest 'PUT' '/api/hotkeys/config' $token '{"bindings":"Ctrl+Alt+M"}')
Check 'config: bindings that are not an object are 400' ($r.Status -eq 400)
$r = Api (New-FakeRequest 'PUT' '/api/hotkeys/config' $token '[1,2]')
Check 'config: a JSON array body is 400' ($r.Status -eq 400)
$r = Api (New-FakeRequest 'PUT' '/api/hotkeys/config' $token 'not json')
Check 'config: invalid JSON is 400' ($r.Status -eq 400)
$r = Api (New-FakeRequest 'PUT' '/api/hotkeys/config' $token '{"bindings":{"marker":"Ctrl+Alt+M"}}' 'text/plain')
Check 'config: a wrong content type is 415' ($r.Status -eq 415)
$r = Api (New-FakeRequest 'PUT' '/api/hotkeys/config' $token ('{"bindings":{"marker":"' + ('x' * 5000) + '"}}'))
Check 'config: a body over 4 KB is 413' ($r.Status -eq 413)
$r = Api (New-FakeRequest 'PUT' '/api/hotkeys/config' $token '')
Check 'config: an empty body is 400' ($r.Status -eq 400)
$r = Api (New-FakeRequest 'POST' '/api/hotkeys/config' $token '{}')
Check 'config: POST is 405' ($r.Status -eq 405)
Check 'refused config calls left the bindings alone' ($api.BindingText('marker') -eq 'Ctrl+Alt+M')

# state
$r = Api (New-FakeRequest 'POST' '/api/hotkeys/state' $token '{"state":"recording"}')
Check 'state: recording is accepted' (($r.Status -eq 200) -and $api.State -eq 'recording')
$r = Api (New-FakeRequest 'POST' '/api/hotkeys/state' $token '{"state":"idle"}')
Check 'state: idle is accepted' (($r.Status -eq 200) -and $api.State -eq 'idle')
$r = Api (New-FakeRequest 'POST' '/api/hotkeys/state' $token '{"state":"rebooting"}')
Check 'state: anything else is 400' ($r.Status -eq 400)
$r = Api (New-FakeRequest 'POST' '/api/hotkeys/state' $token '{"state":5}')
Check 'state: a non-text state is 400' ($r.Status -eq 400)

# events
$saved = $env:CAPSTAN_TEST_HOTKEYS
try {
    $env:CAPSTAN_TEST_HOTKEYS = $null
    $r = Api (New-FakeRequest 'POST' '/api/hotkeys/test-inject' $token '{"event":"start-stop"}')
    Check 'test-inject does not exist without CAPSTAN_TEST_HOTKEYS=1' ($r.Status -eq 404)
    Check 'and injected nothing' ($api.Events.LastId -eq 0)
    $env:CAPSTAN_TEST_HOTKEYS = '1'
    $r = Api (New-FakeRequest 'POST' '/api/hotkeys/test-inject' $token '{"event":"start-stop"}')
    Check 'test-inject queues an event when CAPSTAN_TEST_HOTKEYS=1' (($r.Status -eq 200) -and $api.Events.LastId -eq 1)
    $r = Api (New-FakeRequest 'POST' '/api/hotkeys/test-inject' $token '{"event":"reboot"}')
    Check 'test-inject refuses an event name that is not on the list' ($r.Status -eq 400)
    $r = Api (New-FakeRequest 'POST' '/api/hotkeys/test-inject' $token '{"event":"marker"}')
    $r = Api (New-FakeRequest 'POST' '/api/hotkeys/test-inject' $token '{"clash":"Ctrl+Alt+M"}')
    Check 'test-inject can simulate a clash on a combination' (($r.Status -eq 200) -and @($r.Payload.failed).Count -eq 1)
    $r = Api (New-FakeRequest 'POST' '/api/hotkeys/test-inject' $token '{"clash":"F1"}')
    Check 'test-inject refuses a clash for an invalid combination' ($r.Status -eq 400)
    $r = Api (New-FakeRequest 'GET' '/api/hotkeys/test-inject' $token)
    Check 'test-inject: GET is 405' ($r.Status -eq 405)
} finally { $env:CAPSTAN_TEST_HOTKEYS = $saved }

$r = Api (New-FakeRequest 'GET' '/api/hotkeys/events?since=0' $token)
Check 'events: everything after since=0, with increasing ids' (($r.Status -eq 200) -and ((@($r.Payload.events) | ForEach-Object { $_.id }) -join ',') -eq '1,2' -and ((@($r.Payload.events) | ForEach-Object { $_.name }) -join ',') -eq 'start-stop,marker' -and $r.Payload.last -eq 2)
$r = Api (New-FakeRequest 'GET' '/api/hotkeys/events?since=1' $token)
Check 'events: since=1 returns only the newer one' (@($r.Payload.events).Count -eq 1 -and $r.Payload.events[0].id -eq 2)
$r = Api (New-FakeRequest 'GET' '/api/hotkeys/events?since=2' $token)
Check 'events: nothing new and no wait is an immediate empty answer' (($r.Status -eq 200) -and (-not $r.Park) -and @($r.Payload.events).Count -eq 0 -and $r.Payload.last -eq 2)
$r = Api (New-FakeRequest 'GET' '/api/hotkeys/events?since=2&wait=10' $token)
Check 'events: nothing new and a wait parks the poll for that long' (($r.Park -eq $true) -and $r.Seconds -eq 10 -and $r.Since -eq 2)
$r = Api (New-FakeRequest 'GET' '/api/hotkeys/events?since=2&wait=999' $token)
Check 'events: a wait over 25 s is cut to 25 s' (($r.Park -eq $true) -and $r.Seconds -eq 25)
$r = Api (New-FakeRequest 'GET' '/api/hotkeys/events?since=1&wait=20' $token)
Check 'events: with an event waiting the answer is immediate even with a wait' ((-not $r.Park) -and @($r.Payload.events).Count -eq 1)
foreach ($badQuery in @('since=-1', 'since=abc', 'since=1e3', 'wait=-5', 'wait=x', 'since=99999999999999999999', 'wait=1000')) {
    $r = Api (New-FakeRequest 'GET' ('/api/hotkeys/events?' + $badQuery) $token)
    Check ('events: ?' + $badQuery + ' is 400') ($r.Status -eq 400)
}
$r = Api (New-FakeRequest 'POST' '/api/hotkeys/events' $token '{}')
Check 'events: POST is 405' ($r.Status -eq 405)
$api.Stop()

# No service at all (hotkeys turned off or failed to start).
$r = Invoke-CapstanHotkeyApi -Service $null -Request (New-FakeRequest 'GET' '/api/hotkeys/status' $token) -SessionToken $token
Check 'without a service, status says available=false and still lists the defaults' (($r.Status -eq 200) -and $r.Payload.available -eq $false -and $r.Payload.bindings['marker'] -eq 'Ctrl+Shift+F11')
$r = Invoke-CapstanHotkeyApi -Service $null -Request (New-FakeRequest 'GET' '/api/hotkeys/events?since=0&wait=5' $token) -SessionToken $token
Check 'without a service, events is 409' ($r.Status -eq 409)
$r = Invoke-CapstanHotkeyApi -Service $null -Request (New-FakeRequest 'PUT' '/api/hotkeys/config' $token '{"bindings":{"marker":"Ctrl+Alt+M"}}') -SessionToken $token
Check 'without a service, config is 409' ($r.Status -eq 409)
$saved = $env:CAPSTAN_TEST_HOTKEYS
try {
    $env:CAPSTAN_TEST_HOTKEYS = '1'
    $r = Invoke-CapstanHotkeyApi -Service $null -Request (New-FakeRequest 'POST' '/api/hotkeys/test-inject' $token '{"event":"marker"}') -SessionToken $token
    Check 'without a service, test-inject is 404 even with the variable' ($r.Status -eq 404)
} finally { $env:CAPSTAN_TEST_HOTKEYS = $saved }
$saved = $env:CAPSTAN_HOTKEYS
try {
    $env:CAPSTAN_HOTKEYS = '0'
    Check 'CAPSTAN_HOTKEYS=0 turns the feature off' ((-not (Test-CapstanHotkeysEnabled)) -and $null -eq (New-CapstanHotkeyService))
    $env:CAPSTAN_HOTKEYS = $null
    Check 'the feature is on by default' (Test-CapstanHotkeysEnabled)
} finally { $env:CAPSTAN_HOTKEYS = $saved }

# The title matcher that brings an existing Capstan window forward.
Check 'an Edge window titled Capstan is Capstan' ([Capstan.Hotkeys.WindowFinder]::IsCapstanWindow('Capstan', 'msedge'))
Check 'a Chrome window titled "Capstan - Profile" is Capstan' ([Capstan.Hotkeys.WindowFinder]::IsCapstanWindow('Capstan - Work', 'chrome'))
Check 'a File Explorer window for a folder called Capstan is not' (-not [Capstan.Hotkeys.WindowFinder]::IsCapstanWindow('Capstan - File Explorer', 'explorer'))
Check 'another page that merely starts with Capstan is not' (-not [Capstan.Hotkeys.WindowFinder]::IsCapstanWindow('Capstanology', 'msedge'))

# ---- The real host, started with the seam on, called over HTTP ----
function Call([string]$Url, [string]$Method = 'GET', [string]$Tok = '', $Body = $null, [hashtable]$Headers = @{}, [string]$ContentType = 'application/json') {
    $req = [Net.HttpWebRequest]::Create($Url)
    $req.Method = $Method; $req.Timeout = 20000; $req.KeepAlive = $false
    if ($Tok) { $req.Headers.Add('X-Capstan-Token', $Tok) }
    foreach ($k in $Headers.Keys) { $req.Headers.Add($k, $Headers[$k]) }
    if ($null -ne $Body) {
        $bytes = [Text.Encoding]::UTF8.GetBytes([string]$Body)
        $req.ContentType = $ContentType; $req.ContentLength = $bytes.Length
        $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
    } elseif ($Method -ne 'GET') { $req.ContentLength = 0 }
    try { $resp = $req.GetResponse() } catch [Net.WebException] { $resp = $_.Exception.Response; if ($null -eq $resp) { throw } }
    $reader = New-Object IO.StreamReader -ArgumentList $resp.GetResponseStream()
    $hdrs = $resp.Headers
    try { $raw = $reader.ReadToEnd() } finally { $reader.Dispose(); $resp.Close() }
    $json = $null
    try { $json = $raw | ConvertFrom-Json } catch { }
    return @{ Status = [int]$resp.StatusCode; Raw = $raw; Json = $json; Headers = $hdrs }
}
function Start-Host([string]$Which) {
    $hostArgs = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $root 'Start-Capstan.ps1') + '"'), '-NoBrowser', '-Port', $Port, '--replace')
    $p = Start-Process -FilePath $ps -ArgumentList $hostArgs -PassThru -WindowStyle Hidden
    $logs = Join-Path $root 'logs'
    $runtime = Join-Path $logs ('capstan-server-' + $p.Id + '.json')
    $deadline = (Get-Date).AddSeconds(40)
    while (-not (Test-Path $runtime) -and (Get-Date) -lt $deadline -and -not $p.HasExited) { Start-Sleep -Milliseconds 200 }
    if (-not (Test-Path $runtime)) { return @{ Process = $p; Url = $null; Token = $null; Runtime = $runtime } }
    $url = [string](([IO.File]::ReadAllText($runtime) | ConvertFrom-Json).url)
    $page = (Call $url).Raw
    $tok = ([regex]'name="capstan-session" content="([0-9a-f]+)"').Match($page).Groups[1].Value
    return @{ Process = $p; Url = $url; Token = $tok; Runtime = $runtime }
}

[void](Stop-CapstanProcesses -Root $root)
$savedTest = $env:CAPSTAN_TEST_HOTKEYS; $savedOff = $env:CAPSTAN_HOTKEYS
$h1 = $null; $h2 = $null
try {
    # Seam on: the host registers no key and shows no icon.
    $env:CAPSTAN_TEST_HOTKEYS = '1'; $env:CAPSTAN_HOTKEYS = $null
    $h1 = Start-Host 'seam'
    Check 'host with CAPSTAN_TEST_HOTKEYS=1 starts' ([bool]$h1.Url) 'no runtime file'
    if ($h1.Url) {
        $u = $h1.Url; $tk = $h1.Token
        $r = Call ($u + 'api/hotkeys/status')
        Check 'real host: status without a token is 403' ($r.Status -eq 403)
        $r = Call ($u + 'api/hotkeys/status') -Tok $tk -Headers @{ Origin = 'http://evil.example' }
        Check 'real host: status from another origin is 403' ($r.Status -eq 403)
        $r = Call ($u + 'api/hotkeys/status') 'GET' $tk
        Check 'real host: status is 200 JSON, simulated, three keys registered' (($r.Status -eq 200) -and $r.Json.test -eq $true -and @($r.Json.registered).Count -eq 3 -and $r.Json.trayVisible -eq $false) $r.Raw
        Check 'real host: the response carries no CORS header and is not cacheable' (($null -eq $r.Headers['Access-Control-Allow-Origin']) -and $r.Headers['Cache-Control'] -eq 'no-store')
        $r = Call ($u + 'api/hotkeys/test-inject') 'POST' $tk '{"event":"start-stop"}'
        Check 'real host: test-inject queues an event' (($r.Status -eq 200) -and $r.Json.id -eq 1) $r.Raw
        $r = Call ($u + 'api/hotkeys/test-inject') -Method 'POST' -Tok $tk -Body '{"event":"start-stop"}' -ContentType 'text/plain'
        Check 'real host: test-inject with a wrong content type is 415' ($r.Status -eq 415)
        $r = Call ($u + 'api/hotkeys/events?since=0') 'GET' $tk
        Check 'real host: events returns the queued event at once' (($r.Status -eq 200) -and @($r.Json.events).Count -eq 1 -and $r.Json.events[0].name -eq 'start-stop' -and $r.Json.last -eq 1) $r.Raw

        # Long poll timing: empty answer after the wait.
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $r = Call ($u + 'api/hotkeys/events?since=1&wait=2') 'GET' $tk
        $sec = $sw.Elapsed.TotalSeconds
        Check 'real host: a long poll with no event answers empty after about the wait' (($r.Status -eq 200) -and @($r.Json.events).Count -eq 0 -and $sec -ge 1.7 -and $sec -lt 5) ([string]$sec)

        # Long poll answered by an event injected while it waits; other requests are not blocked meanwhile.
        $req = [Net.HttpWebRequest]::Create($u + 'api/hotkeys/events?since=1&wait=20')
        $req.Headers.Add('X-Capstan-Token', $tk); $req.Timeout = 30000; $req.KeepAlive = $false
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $ar = $req.BeginGetResponse($null, $null)
        Start-Sleep -Milliseconds 700
        $sw2 = [Diagnostics.Stopwatch]::StartNew()
        $health = Call ($u + 'api/health') 'GET' $tk
        Check 'real host: other requests are answered while a long poll waits' (($health.Status -eq 200) -and $sw2.Elapsed.TotalSeconds -lt 1.5) ([string]$sw2.Elapsed.TotalSeconds)
        $r = Call ($u + 'api/hotkeys/test-inject') 'POST' $tk '{"event":"marker"}'
        $resp = $req.EndGetResponse($ar)
        $reader = New-Object IO.StreamReader -ArgumentList $resp.GetResponseStream()
        $raw = $reader.ReadToEnd(); $reader.Dispose(); $resp.Close()
        $j = $raw | ConvertFrom-Json
        $sec = $sw.Elapsed.TotalSeconds
        Check 'real host: an injected event answers the waiting poll within about a second' (@($j.events).Count -eq 1 -and $j.events[0].name -eq 'marker' -and $j.events[0].id -eq 2 -and $sec -lt 3.5) ($raw + ' ' + $sec)

        # Config and state through the real transport.
        $r = Call ($u + 'api/hotkeys/config') 'PUT' $tk '{"bindings":{"marker":"Ctrl+Alt+M"}}'
        Check 'real host: PUT config applies a binding' (($r.Status -eq 200) -and $r.Json.bindings.marker -eq 'Ctrl+Alt+M') $r.Raw
        $r = Call ($u + 'api/hotkeys/config') 'PUT' $tk '{"bindings":{"marker":"F5"}}'
        Check 'real host: PUT config with a bad binding is 400' ($r.Status -eq 400)
        $r = Call ($u + 'api/hotkeys/config') 'POST' $tk '{}'
        Check 'real host: POST config is 405' ($r.Status -eq 405)
        $r = Call ($u + 'api/hotkeys/state') 'POST' $tk '{"state":"recording"}'
        $s = Call ($u + 'api/hotkeys/status') 'GET' $tk
        Check 'real host: POST state is reflected in status' (($r.Status -eq 200) -and $s.Json.state -eq 'recording')
        $r = Call ($u + 'api/hotkeys/test-inject') 'POST' $tk '{"clash":"Ctrl+Shift+F10"}'
        Check 'real host: a simulated clash shows up as a failed key with a reason' (($r.Status -eq 200) -and @($r.Json.failed).Count -eq 1 -and $r.Json.failed[0].reason -match 'Another program') $r.Raw

        # Never keeps the host alive: a long poll is waiting and the page leaves; the host still stops itself.
        $req2 = [Net.HttpWebRequest]::Create($u + 'api/hotkeys/events?since=99&wait=25')
        $req2.Headers.Add('X-Capstan-Token', $tk); $req2.Timeout = 60000; $req2.KeepAlive = $false
        $ar2 = $req2.BeginGetResponse($null, $null)
        Start-Sleep -Milliseconds 500
        $null = Call ($u + 'api/heartbeat') 'POST' $tk '{"tab":"t1"}'
        $null = Call ($u + 'api/heartbeat') 'POST' '' ('{"tab":"t1","leaving":true,"session":"' + $tk + '"}')
        $deadline = (Get-Date).AddSeconds(20)
        while (-not $h1.Process.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
        Check 'real host: stops itself after the leaving beacon even with a long poll waiting' $h1.Process.HasExited
        Check 'real host: the runtime file is removed' (-not (Test-Path $h1.Runtime))
        try { $resp2 = $req2.EndGetResponse($ar2); $resp2.Close() } catch { }
    }

    # Hotkeys turned off: the routes say so, and test-inject does not exist.
    $env:CAPSTAN_TEST_HOTKEYS = '1'; $env:CAPSTAN_HOTKEYS = '0'
    $h2 = Start-Host 'off'
    Check 'host with CAPSTAN_HOTKEYS=0 starts' ([bool]$h2.Url)
    if ($h2.Url) {
        $r = Call ($h2.Url + 'api/hotkeys/status') 'GET' $h2.Token
        Check 'hotkeys off: status says available=false with a reason' (($r.Status -eq 200) -and $r.Json.available -eq $false -and $r.Json.reason) $r.Raw
        $r = Call ($h2.Url + 'api/hotkeys/events?since=0&wait=1') 'GET' $h2.Token
        Check 'hotkeys off: events is 409' ($r.Status -eq 409)
        $r = Call ($h2.Url + 'api/hotkeys/test-inject') 'POST' $h2.Token '{"event":"marker"}'
        Check 'hotkeys off: test-inject is 404' ($r.Status -eq 404)
        $null = Call ($h2.Url + 'api/session/stop') 'POST' $h2.Token '{}'
        $deadline = (Get-Date).AddSeconds(10)
        while (-not $h2.Process.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
        Check 'hotkeys off: End session stops the host' $h2.Process.HasExited
    }
} finally {
    $env:CAPSTAN_TEST_HOTKEYS = $savedTest; $env:CAPSTAN_HOTKEYS = $savedOff
    foreach ($x in @($h1, $h2)) { if ($x -and $x.Process -and -not $x.Process.HasExited) { try { $x.Process.Kill() } catch { } } }
}

if ($script:failures -gt 0) { Write-Host ('' + $script:failures + ' hotkey check(s) failed') -ForegroundColor Red; exit 1 }
Write-Host 'All hotkey checks passed' -ForegroundColor Green
