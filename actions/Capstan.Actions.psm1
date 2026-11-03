<#
  Capstan actions. Each action is one function. The editor's command registry is loaded from
  actions/editor-catalog.json; those actions run in the page. Host actions (files, captures,
  the session) run in this module. Windows PowerShell 5.1.
#>

$script:CapstanRoot = Split-Path -Parent $PSScriptRoot
$script:CapstanInListener = $false

function Set-CapstanInListener {
    param([bool]$Enabled)
    $script:CapstanInListener = [bool]$Enabled
}

function Get-CapstanProp {
    param($Object, [string]$Name)
    if ($null -eq $Object -or [string]::IsNullOrEmpty($Name)) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Test-CapstanProp {
    param($Object, [string]$Name)
    if ($null -eq $Object -or [string]::IsNullOrEmpty($Name)) { return $false }
    if ($Object -is [System.Collections.IDictionary]) { return $Object.Contains($Name) }
    return $null -ne $Object.PSObject.Properties[$Name]
}

function Get-CapstanArg {
    param($Arguments, [string]$Name)
    return (Get-CapstanProp $Arguments $Name)
}

function Invoke-CapstanIsolated {
    # An unbound scriptblock, so dot-sourcing a host module cannot replace functions in this module.
    param([string]$Code, [object[]]$ArgumentList)
    $sb = [scriptblock]::Create($Code)
    return (& $sb @ArgumentList)
}

function Read-CapstanProjectDocument {
    param([string]$File)
    if ([string]::IsNullOrWhiteSpace($File)) {
        return @{ Ok = $false; ErrorType = 'usage'; Error = 'Missing required argument "file".' }
    }
    if ($File -notmatch '\.capstan\z') {
        return @{ Ok = $false; ErrorType = 'failed'; Error = 'The file must be a .capstan project file.' }
    }
    $full = $null
    try { $full = [IO.Path]::GetFullPath($File) } catch {
        return @{ Ok = $false; ErrorType = 'failed'; Error = 'That project path is not valid.' }
    }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        return @{ Ok = $false; ErrorType = 'failed'; Error = 'That project file was not found.' }
    }
    $item = Get-Item -LiteralPath $full -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        return @{ Ok = $false; ErrorType = 'failed'; Error = 'That project path is not a plain file.' }
    }
    if ($item.Length -gt 33554432) {
        return @{ Ok = $false; ErrorType = 'failed'; Error = 'That project file is too large to read here.' }
    }
    try { $text = [IO.File]::ReadAllText($full) } catch {
        return @{ Ok = $false; ErrorType = 'failed'; Error = 'That project file could not be read.' }
    }
    try { $doc = $text | ConvertFrom-Json } catch {
        return @{ Ok = $false; ErrorType = 'failed'; Error = 'That project file is not JSON.' }
    }
    $version = Get-CapstanProp $doc 'version'
    if ($version -ne 1) {
        return @{ Ok = $false; ErrorType = 'failed'; Error = 'That project file is not a version 1 Capstan project.' }
    }
    return @{ Ok = $true; Project = $doc; Path = $full }
}

function Get-CapstanProjectList {
    param($Project, [string]$Name)
    if (-not (Test-CapstanProp $Project $Name)) { return @() }
    $value = Get-CapstanProp $Project $Name
    if ($null -eq $value) { return @() }
    return @($value)
}

function Format-CapstanStamp {
    param([double]$Time)
    $ms = [Math]::Max(0, [int][Math]::Round($Time * 1000))
    $h = [Math]::Floor($ms / 3600000)
    $m = [Math]::Floor($ms / 60000) % 60
    $s = [Math]::Floor($ms / 1000) % 60
    $milli = $ms % 1000
    return ('{0:00}:{1:00}:{2:00},{3:000}' -f [int]$h, [int]$m, [int]$s, [int]$milli)
}

function Format-CapstanCueText {
    param([string]$Text)
    $lines = $Text -replace "`r`n", "`n" -replace "`r", "`n"
    $kept = @()
    foreach ($line in @($lines.Split("`n"))) {
        $trim = $line.Trim()
        if ($trim.Length -gt 0) { $kept += $trim }
    }
    return ($kept -join "`n")
}

function Format-CapstanSrt {
    param($Captions)
    $blocks = @()
    $i = 1
    foreach ($c in @($Captions)) {
        $start = [double](Get-CapstanProp $c 'start')
        $end = [double](Get-CapstanProp $c 'end')
        $body = Format-CapstanCueText ([string](Get-CapstanProp $c 'text'))
        if ([string]::IsNullOrEmpty($body)) { continue }
        $blocks += ($i.ToString() + "`n" + (Format-CapstanStamp $start) + ' --> ' + (Format-CapstanStamp $end) + "`n" + $body + "`n")
        $i = $i + 1
    }
    return ($blocks -join "`n")
}

function Format-CapstanVttEscape {
    param([string]$Text)
    return (($Text -replace '&', '&amp;') -replace '<', '&lt;') -replace '>', '&gt;'
}

function Format-CapstanVtt {
    param($Captions)
    $blocks = @()
    $i = 1
    foreach ($c in @($Captions)) {
        $start = (Format-CapstanStamp ([double](Get-CapstanProp $c 'start'))).Replace(',', '.')
        $end = (Format-CapstanStamp ([double](Get-CapstanProp $c 'end'))).Replace(',', '.')
        $body = Format-CapstanVttEscape (Format-CapstanCueText ([string](Get-CapstanProp $c 'text')))
        if ([string]::IsNullOrEmpty($body)) { continue }
        $blocks += ($i.ToString() + "`n" + $start + ' --> ' + $end + "`n" + $body + "`n")
        $i = $i + 1
    }
    return ("WEBVTT`n`n" + ($blocks -join "`n"))
}

function Get-CapstanChapters {
    param($Project)
    # A List of pscustomobjects, sorted by hand. Windows PowerShell 5.1 sorts a hashtable's
    # time of 0 as if it were empty, and appending a hashtable to an array unwraps it.
    $rows = New-Object System.Collections.Generic.List[object]
    foreach ($m in @(Get-CapstanProjectList $Project 'markers')) {
        if ((Get-CapstanProp $m 'chapter') -ne $true) { continue }
        $name = [string](Get-CapstanProp $m 'name')
        if ([string]::IsNullOrWhiteSpace($name)) { $name = 'Chapter' }
        $rows.Add([pscustomobject]@{ time = [double](Get-CapstanProp $m 'time'); name = $name.Trim() })
    }
    for ($i = 0; $i -lt $rows.Count; $i++) {
        for ($j = $i + 1; $j -lt $rows.Count; $j++) {
            $swap = $false
            $ti = [double]$rows[$i].time
            $tj = [double]$rows[$j].time
            if ($tj -lt $ti) { $swap = $true }
            elseif ($tj -eq $ti -and [string]$rows[$j].name -lt [string]$rows[$i].name) { $swap = $true }
            if ($swap) {
                $tmp = $rows[$i]
                $rows[$i] = $rows[$j]
                $rows[$j] = $tmp
            }
        }
    }
    $out = @()
    foreach ($row in $rows) { $out += $row }
    return $out
}

function Format-CapstanClock {
    param([double]$Time, [bool]$Long)
    $s = [Math]::Max(0, [int][Math]::Floor($Time))
    $h = [Math]::Floor($s / 3600)
    $m = [Math]::Floor(($s % 3600) / 60)
    $sec = $s % 60
    if ($h -or $Long) { return ('{0}:{1:00}:{2:00}' -f [int]$h, [int]$m, [int]$sec) }
    return ('{0}:{1:00}' -f [int]$m, [int]$sec)
}

function Format-CapstanChaptersText {
    param($Chapters)
    $list = @($Chapters)
    if ($list.Count -eq 0) { return '' }
    if ([double]$list[0].time -ge 1) {
        $withStart = New-Object System.Collections.Generic.List[object]
        $withStart.Add([pscustomobject]@{ time = 0.0; name = 'Start' })
        foreach ($c in $list) { $withStart.Add($c) }
        $list = @($withStart)
    }
    $long = $false
    foreach ($c in $list) { if ([double]$c.time -ge 3600) { $long = $true } }
    $lines = @()
    foreach ($c in $list) { $lines += ((Format-CapstanClock ([double]$c.time) $long) + ' ' + [string]$c.name) }
    return (($lines -join "`n") + "`n")
}

function Get-CapstanProjectDuration {
    param($Project)
    $end = 0.0
    foreach ($c in @(Get-CapstanProjectList $Project 'clips')) {
        $span = [double](Get-CapstanProp $c 'start') + [double](Get-CapstanProp $c 'duration')
        if ($span -gt $end) { $end = $span }
    }
    foreach ($c in @(Get-CapstanProjectList $Project 'captions')) {
        $span = [double](Get-CapstanProp $c 'end')
        if ($span -gt $end) { $end = $span }
    }
    foreach ($m in @(Get-CapstanProjectList $Project 'markers')) {
        $span = [double](Get-CapstanProp $m 'time')
        if ($span -gt $end) { $end = $span }
    }
    if ($end -le 0) { $end = 1 }
    return $end
}

function Format-CapstanChaptersVtt {
    param($Chapters, [double]$Duration)
    $list = @($Chapters)
    $blocks = @()
    for ($i = 0; $i -lt $list.Count; $i++) {
        $c = $list[$i]
        $start = [double]$c.time
        $end = $Duration
        if ($i + 1 -lt $list.Count) { $end = [double]$list[$i + 1].time }
        if ($end -lt ($start + 0.001)) { $end = $start + 0.001 }
        $stamp = {
            param([double]$Time)
            $ms = [Math]::Max(0, [int][Math]::Round($Time * 1000))
            $h = [Math]::Floor($ms / 3600000)
            $m = [Math]::Floor($ms / 60000) % 60
            $s = [Math]::Floor($ms / 1000) % 60
            $milli = $ms % 1000
            return ('{0:00}:{1:00}:{2:00}.{3:000}' -f [int]$h, [int]$m, [int]$s, [int]$milli)
        }
        $title = ([string]$c.name).Replace('&', '&amp;').Replace('<', '&lt;').Replace('-->', '--&gt;')
        $blocks += (($i + 1).ToString() + "`n" + (& $stamp $start) + ' --> ' + (& $stamp $end) + "`n" + $title + "`n")
    }
    return ("WEBVTT`n`n" + ($blocks -join "`n"))
}

function Convert-CapstanSummary {
    param($Project)
    $chapters = @(Get-CapstanChapters $Project)
    $counts = @{
        tracks      = @(Get-CapstanProjectList $Project 'tracks').Count
        clips       = @(Get-CapstanProjectList $Project 'clips').Count
        media       = @(Get-CapstanProjectList $Project 'media').Count
        captions    = @(Get-CapstanProjectList $Project 'captions').Count
        markers     = @(Get-CapstanProjectList $Project 'markers').Count
        chapters    = $chapters.Count
        annotations = @(Get-CapstanProjectList $Project 'annotations').Count
    }
    return @{
        name     = [string](Get-CapstanProp $Project 'name')
        width    = Get-CapstanProp $Project 'width'
        height   = Get-CapstanProp $Project 'height'
        fps      = Get-CapstanProp $Project 'fps'
        counts   = $counts
        chapters = $chapters
    }
}

function Invoke-CapstanHostShow {
    param($Arguments)
    $version = ''
    $versionFile = Join-Path $script:CapstanRoot 'VERSION'
    if (Test-Path -LiteralPath $versionFile) { $version = ([IO.File]::ReadAllText($versionFile)).Trim() }
    return @{ app = 'Capstan'; version = $version; offline = $true; listen = '127.0.0.1'; ps = [string]$PSVersionTable.PSVersion }
}

function Invoke-CapstanSessionShow {
    param($Arguments)
    $running = @()
    $logs = Join-Path $script:CapstanRoot 'logs'
    if (Test-Path -LiteralPath $logs) {
        foreach ($f in @(Get-ChildItem -LiteralPath $logs -Filter 'capstan-server-*.json' -ErrorAction SilentlyContinue)) {
            try {
                $info = [IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json
                $running += @{
                    pid       = Get-CapstanProp $info 'pid'
                    port      = Get-CapstanProp $info 'port'
                    url       = [string](Get-CapstanProp $info 'url')
                    startedAt = [string](Get-CapstanProp $info 'startedAt')
                }
            } catch { }
        }
    }
    return @{ count = $running.Count; running = $running }
}

function Invoke-CapstanSessionEnd {
    param($Arguments)
    if ($script:CapstanInListener) { return @{ stopping = $true } }
    $ids = @(Invoke-CapstanIsolated -ArgumentList @($script:CapstanRoot) -Code @'
param($Root)
. (Join-Path $Root 'modules/Lifecycle.ps1')
$stopped = @(Stop-CapstanProcesses -Root $Root)
$out = @()
foreach ($p in $stopped) { $out += [int]$p.Pid }
return ,$out
'@)
    return @{ stopped = @($ids) }
}

function Invoke-CapstanDiagnosticsRun {
    param($Arguments)
    return @{
            powershell   = [string]$PSVersionTable.PSVersion
            edition      = [string]$PSVersionTable.PSEdition
            listen       = '127.0.0.1'
            admin        = $false
            startedServer = $false
    }
}

function Invoke-CapstanCapturesList {
    param($Arguments)
    $result = Invoke-CapstanIsolated -ArgumentList @($script:CapstanRoot) -Code @'
param($Root)
. (Join-Path $Root 'modules/Captures.ps1')
$folder = Get-CapstanCapturesRoot
if (-not $folder) { return @{ found = $false; total = 0; captures = @() } }
$list = Get-CapstanCaptureList -Root $folder
$items = @()
foreach ($row in @($list.captures)) {
    $items += @{ name = [string]$row.name; size = [long]$row.size; kind = [string]$row.kind; hasOcr = [bool]$row.hasOcr }
}
return @{ found = $true; total = [int]$list.total; captures = $items }
'@
    return $result
}

function Invoke-CapstanLibraryList {
    param($Arguments)
    $candidate = $env:CAPSTAN_LIBRARY_ROOT
    if ([string]::IsNullOrEmpty($candidate) -and $env:LOCALAPPDATA) {
        $candidate = Join-Path $env:LOCALAPPDATA 'Capstan\library'
    }
    if ([string]::IsNullOrEmpty($candidate) -or $candidate -notmatch '^[A-Za-z]:\\') {
        return @{ library = $false; files = @() }
    }
    $result = Invoke-CapstanIsolated -ArgumentList @($script:CapstanRoot) -Code @'
param($Root)
. (Join-Path $Root 'modules/Library.ps1')
$on = $false
try { $on = [bool](Initialize-CapstanLibrary) } catch { $on = $false }
$files = @()
if ($on -and $script:CapstanLibrary) {
    $dir = [string]$script:CapstanLibrary.Root
    foreach ($f in @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue)) {
        if ($f.Name -match '^[a-z0-9_-]{1,80}$') { $files += @{ id = $f.Name; size = [long]$f.Length } }
    }
}
return @{ library = $on; files = $files }
'@
    return $result
}

function Invoke-CapstanSpeechShow {
    param($Arguments)
    $result = Invoke-CapstanIsolated -ArgumentList @($script:CapstanRoot) -Code @'
param($Root)
. (Join-Path $Root 'modules/Speech.ps1')
$status = Get-CapstanSpeechStatus
return @{ engine = [string]$status.engine; available = [bool]$status.available }
'@
    return $result
}

function Invoke-CapstanHotkeysShow {
    param($Arguments)
    try {
        $result = Invoke-CapstanIsolated -ArgumentList @($script:CapstanRoot) -Code @'
param($Root)
. (Join-Path $Root 'modules/Hotkeys.ps1')
$status = Get-CapstanHotkeyStatus -Service $null
return @{ available = [bool]$status.available; running = [bool]$status.running; reason = [string]$status.reason }
'@
        return $result
    } catch {
        return @{ available = $false; running = $false; reason = 'Global hotkeys are not available on this computer.' }
    }
}

function Invoke-CapstanCursorShow {
    param($Arguments)
    try {
        Invoke-CapstanIsolated -ArgumentList @($script:CapstanRoot) -Code @'
param($Root)
. (Join-Path $Root 'modules/CursorCapture.ps1')
return $true
'@ | Out-Null
        return @{ available = $true; reason = 'Cursor capture is part of the host. It records only while Capstan is running.' }
    } catch {
        return @{ available = $false; reason = 'Cursor capture is not available on this computer.' }
    }
}

function Invoke-CapstanFileShow {
    param($Arguments)
    $loaded = Read-CapstanProjectDocument -File ([string](Get-CapstanArg $Arguments 'path'))
    if (-not $loaded.Ok) { New-FleetErrorRecord -Code 'E_ARGS' -Message ([string]$loaded.Error) }
    return (Convert-CapstanSummary $loaded.Project)
}

function Invoke-CapstanHandoffChapters {
    param($Arguments)
    $loaded = Read-CapstanProjectDocument -File ([string](Get-CapstanArg $Arguments 'path'))
    if (-not $loaded.Ok) { New-FleetErrorRecord -Code 'E_ARGS' -Message ([string]$loaded.Error) }
    $format = [string](Get-CapstanArg $Arguments 'format')
    if ([string]::IsNullOrEmpty($format)) { $format = 'text' }
    $chapters = @(Get-CapstanChapters $loaded.Project)
    $text = ''
    if ($format -eq 'vtt') { $text = Format-CapstanChaptersVtt $chapters (Get-CapstanProjectDuration $loaded.Project) }
    else { $text = Format-CapstanChaptersText $chapters }
    return @{ format = $format; text = $text; chapters = $chapters.Count }
}

function Invoke-CapstanHandoffCaptions {
    param($Arguments)
    $loaded = Read-CapstanProjectDocument -File ([string](Get-CapstanArg $Arguments 'path'))
    if (-not $loaded.Ok) { New-FleetErrorRecord -Code 'E_ARGS' -Message ([string]$loaded.Error) }
    $format = [string](Get-CapstanArg $Arguments 'format')
    if ([string]::IsNullOrEmpty($format)) { $format = 'vtt' }
    $captions = @(Get-CapstanProjectList $loaded.Project 'captions')
    $text = ''
    if ($format -eq 'srt') { $text = Format-CapstanSrt $captions }
    else { $text = Format-CapstanVtt $captions }
    return @{ format = $format; text = $text; captions = $captions.Count }
}

function Get-CapstanHostHandler {
    param([string]$Id)
    switch ($Id) {
        'capstan.host.show' { return { param($Arguments) Invoke-CapstanHostShow -Arguments $Arguments } }
        'capstan.session.show' { return { param($Arguments) Invoke-CapstanSessionShow -Arguments $Arguments } }
        'capstan.session.end' { return { param($Arguments) Invoke-CapstanSessionEnd -Arguments $Arguments } }
        'capstan.diagnostics.run' { return { param($Arguments) Invoke-CapstanDiagnosticsRun -Arguments $Arguments } }
        'capstan.captures.list' { return { param($Arguments) Invoke-CapstanCapturesList -Arguments $Arguments } }
        'capstan.library.list' { return { param($Arguments) Invoke-CapstanLibraryList -Arguments $Arguments } }
        'capstan.speech.show' { return { param($Arguments) Invoke-CapstanSpeechShow -Arguments $Arguments } }
        'capstan.hotkeys.show' { return { param($Arguments) Invoke-CapstanHotkeysShow -Arguments $Arguments } }
        'capstan.cursor.show' { return { param($Arguments) Invoke-CapstanCursorShow -Arguments $Arguments } }
        'capstan.file.show' { return { param($Arguments) Invoke-CapstanFileShow -Arguments $Arguments } }
        'capstan.handoff.chapters' { return { param($Arguments) Invoke-CapstanHandoffChapters -Arguments $Arguments } }
        'capstan.handoff.captions' { return { param($Arguments) Invoke-CapstanHandoffCaptions -Arguments $Arguments } }
        default { throw ('No host handler for ' + $Id) }
    }
}

function New-CapstanPageHandler {
    param([string]$CommandName)
    $captured = $CommandName
    return {
        param($Arguments)
        New-FleetErrorRecord -Code 'E_ARGS' -Message ($captured + ' needs the running Capstan page. It uses the editor, media bytes, or a browser encoder, so this shell cannot do it headless.')
    }.GetNewClosure()
}

function Convert-CapstanParameters {
    param($Source)
    # FleetAction 1.0.1 parameters are scalars: string, number, or boolean. At most 32.
    $list = New-Object System.Collections.Generic.List[object]
    $props = Get-CapstanProp $Source 'properties'
    $requiredNames = @()
    $requiredRaw = Get-CapstanProp $Source 'required'
    if ($null -ne $requiredRaw) { $requiredNames = @($requiredRaw) }
    $names = @()
    if ($null -ne $props) { $names = @($props.PSObject.Properties.Name) }
    if ($names.Count -eq 0 -and $Source -is [System.Collections.IDictionary]) {
        $names = @((Get-CapstanProp $Source 'properties').Keys)
    }
    # Editor commands pass an inputs array instead of a JSON schema.
    $inputs = @(Get-CapstanProp $Source 'inputs')
    if ($inputs.Count -gt 0 -and $null -ne $inputs[0]) {
        foreach ($input in $inputs) {
            if ($list.Count -ge 32) { break }
            $name = [string](Get-CapstanProp $input 'name')
            if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_-]{0,63}$') { continue }
            $type = [string](Get-CapstanProp $input 'type')
            $scalar = 'string'
            if ($type -eq 'number') { $scalar = 'number' }
            elseif ($type -eq 'boolean') { $scalar = 'boolean' }
            $required = (Get-CapstanProp $input 'required') -eq $true
            $list.Add(@{ name = $name; type = $scalar; required = $required })
        }
        return @($list.ToArray())
    }
    foreach ($name in $names) {
        if ($list.Count -ge 32) { break }
        if ([string]$name -notmatch '^[A-Za-z_][A-Za-z0-9_-]{0,63}$') { continue }
        $spec = Get-CapstanProp $props ([string]$name)
        $typeName = [string](Get-CapstanProp $spec 'type')
        $scalar = 'string'
        if ($typeName -eq 'number' -or $typeName -eq 'integer') { $scalar = 'number' }
        elseif ($typeName -eq 'boolean') { $scalar = 'boolean' }
        $required = $false
        foreach ($need in $requiredNames) { if ([string]$need -eq [string]$name) { $required = $true } }
        $list.Add(@{ name = [string]$name; type = $scalar; required = $required })
    }
    return @($list.ToArray())
}

function Register-CapstanActions {
    Clear-FleetAction
    $hostPath = Join-Path $PSScriptRoot 'host-catalog.json'
    $hostDoc = [IO.File]::ReadAllText($hostPath) | ConvertFrom-Json
    foreach ($row in @(Get-CapstanProp $hostDoc 'actions')) {
        $id = [string](Get-CapstanProp $row 'id')
        if ($id -eq 'capstan.job.run') { continue }
        $destructive = (Get-CapstanProp $row 'destructive') -eq $true
        $parameters = @(Convert-CapstanParameters (Get-CapstanProp $row 'schema'))
        [void](Register-FleetAction -App 'capstan' -Noun ([string](Get-CapstanProp $row 'noun')) -Verb ([string](Get-CapstanProp $row 'verb')) -Description ([string](Get-CapstanProp $row 'summary')) -Parameters $parameters -Destructive:$destructive -Handler (Get-CapstanHostHandler $id))
    }
    $editorPath = Join-Path $PSScriptRoot 'editor-catalog.json'
    $editor = [IO.File]::ReadAllText($editorPath) | ConvertFrom-Json
    foreach ($cmd in @(Get-CapstanProp $editor 'commands')) {
        $name = [string](Get-CapstanProp $cmd 'name')
        if ($name -eq 'session end') { continue }
        $space = $name.IndexOf(' ')
        $noun = $name.Substring(0, $space)
        $verb = $name.Substring($space + 1)
        if ($noun -eq 'job' -or $noun -eq 'commands' -or $noun -eq 'help') { continue }
        $destructive = (Get-CapstanProp $cmd 'destructive') -eq $true
        $parameters = @(Convert-CapstanParameters $cmd)
        [void](Register-FleetAction -App 'capstan' -Noun $noun -Verb $verb -Description ([string](Get-CapstanProp $cmd 'summary')) -Parameters $parameters -Destructive:$destructive -Handler (New-CapstanPageHandler $name))
    }
}

Export-ModuleMember -Function Register-CapstanActions, Set-CapstanInListener
