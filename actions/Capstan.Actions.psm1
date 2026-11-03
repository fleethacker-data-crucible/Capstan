<#
  Capstan actions. Each action is one function. The editor's command registry is loaded from
  actions/editor-catalog.json; those actions run in the page. Host actions (files, captures,
  the session) run in this module. Windows PowerShell 5.1.
#>

$script:CapstanRoot = Split-Path -Parent $PSScriptRoot

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
    $version = Get-FleetProp $doc 'version'
    if ($version -ne 1) {
        return @{ Ok = $false; ErrorType = 'failed'; Error = 'That project file is not a version 1 Capstan project.' }
    }
    return @{ Ok = $true; Project = $doc; Path = $full }
}

function Get-CapstanProjectList {
    param($Project, [string]$Name)
    if (-not (Test-FleetProp $Project $Name)) { return @() }
    $value = Get-FleetProp $Project $Name
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
        $start = [double](Get-FleetProp $c 'start')
        $end = [double](Get-FleetProp $c 'end')
        $body = Format-CapstanCueText ([string](Get-FleetProp $c 'text'))
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
        $start = (Format-CapstanStamp ([double](Get-FleetProp $c 'start'))).Replace(',', '.')
        $end = (Format-CapstanStamp ([double](Get-FleetProp $c 'end'))).Replace(',', '.')
        $body = Format-CapstanVttEscape (Format-CapstanCueText ([string](Get-FleetProp $c 'text')))
        if ([string]::IsNullOrEmpty($body)) { continue }
        $blocks += ($i.ToString() + "`n" + $start + ' --> ' + $end + "`n" + $body + "`n")
        $i = $i + 1
    }
    return ("WEBVTT`n`n" + ($blocks -join "`n"))
}

function Get-CapstanChapters {
    param($Project)
    $rows = @()
    foreach ($m in @(Get-CapstanProjectList $Project 'markers')) {
        if ((Get-FleetProp $m 'chapter') -ne $true) { continue }
        $name = [string](Get-FleetProp $m 'name')
        if ([string]::IsNullOrWhiteSpace($name)) { $name = 'Chapter' }
        $rows += @{ time = [double](Get-FleetProp $m 'time'); name = $name.Trim() }
    }
    return @($rows | Sort-Object -Property time, name)
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
        $withStart = @(@{ time = 0.0; name = 'Start' }) + $list
        $list = $withStart
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
        $span = [double](Get-FleetProp $c 'start') + [double](Get-FleetProp $c 'duration')
        if ($span -gt $end) { $end = $span }
    }
    foreach ($c in @(Get-CapstanProjectList $Project 'captions')) {
        $span = [double](Get-FleetProp $c 'end')
        if ($span -gt $end) { $end = $span }
    }
    foreach ($m in @(Get-CapstanProjectList $Project 'markers')) {
        $span = [double](Get-FleetProp $m 'time')
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
        name     = [string](Get-FleetProp $Project 'name')
        width    = Get-FleetProp $Project 'width'
        height   = Get-FleetProp $Project 'height'
        fps      = Get-FleetProp $Project 'fps'
        counts   = $counts
        chapters = $chapters
    }
}

function Invoke-CapstanHostShow {
    param($Arguments, [switch]$Confirmed, [switch]$DryRun)
    $version = ''
    $versionFile = Join-Path $script:CapstanRoot 'VERSION'
    if (Test-Path -LiteralPath $versionFile) { $version = ([IO.File]::ReadAllText($versionFile)).Trim() }
    return @{ Ok = $true; Result = @{ app = 'Capstan'; version = $version; offline = $true; listen = '127.0.0.1'; ps = [string]$PSVersionTable.PSVersion } }
}

function Invoke-CapstanSessionShow {
    param($Arguments, [switch]$Confirmed, [switch]$DryRun)
    $running = @()
    $logs = Join-Path $script:CapstanRoot 'logs'
    if (Test-Path -LiteralPath $logs) {
        foreach ($f in @(Get-ChildItem -LiteralPath $logs -Filter 'capstan-server-*.json' -ErrorAction SilentlyContinue)) {
            try {
                $info = [IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json
                $running += @{
                    pid       = Get-FleetProp $info 'pid'
                    port      = Get-FleetProp $info 'port'
                    url       = [string](Get-FleetProp $info 'url')
                    startedAt = [string](Get-FleetProp $info 'startedAt')
                }
            } catch { }
        }
    }
    return @{ Ok = $true; Result = @{ count = $running.Count; running = $running } }
}

function Invoke-CapstanSessionEnd {
    param($Arguments, [switch]$Confirmed, [switch]$DryRun)
    if ($DryRun) { return @{ Ok = $true; Result = @{ would = 'stop the Capstan local server' } } }
    if (Get-FleetHostMode) { return @{ Ok = $true; Result = @{ stopping = $true } } }
    $ids = @(Invoke-CapstanIsolated -ArgumentList @($script:CapstanRoot) -Code @'
param($Root)
. (Join-Path $Root 'modules/Lifecycle.ps1')
$stopped = @(Stop-CapstanProcesses -Root $Root)
$out = @()
foreach ($p in $stopped) { $out += [int]$p.Pid }
return ,$out
'@)
    return @{ Ok = $true; Result = @{ stopped = @($ids) } }
}

function Invoke-CapstanDiagnosticsRun {
    param($Arguments, [switch]$Confirmed, [switch]$DryRun)
    return @{
        Ok     = $true
        Result = @{
            powershell   = [string]$PSVersionTable.PSVersion
            edition      = [string]$PSVersionTable.PSEdition
            listen       = '127.0.0.1'
            admin        = $false
            startedServer = $false
        }
    }
}

function Invoke-CapstanCapturesList {
    param($Arguments, [switch]$Confirmed, [switch]$DryRun)
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
    return @{ Ok = $true; Result = $result }
}

function Invoke-CapstanLibraryList {
    param($Arguments, [switch]$Confirmed, [switch]$DryRun)
    $candidate = $env:CAPSTAN_LIBRARY_ROOT
    if ([string]::IsNullOrEmpty($candidate) -and $env:LOCALAPPDATA) {
        $candidate = Join-Path $env:LOCALAPPDATA 'Capstan\library'
    }
    if ([string]::IsNullOrEmpty($candidate) -or $candidate -notmatch '^[A-Za-z]:\\') {
        return @{ Ok = $true; Result = @{ library = $false; files = @() } }
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
    return @{ Ok = $true; Result = $result }
}

function Invoke-CapstanSpeechShow {
    param($Arguments, [switch]$Confirmed, [switch]$DryRun)
    $result = Invoke-CapstanIsolated -ArgumentList @($script:CapstanRoot) -Code @'
param($Root)
. (Join-Path $Root 'modules/Speech.ps1')
$status = Get-CapstanSpeechStatus
return @{ engine = [string]$status.engine; available = [bool]$status.available }
'@
    return @{ Ok = $true; Result = $result }
}

function Invoke-CapstanHotkeysShow {
    param($Arguments, [switch]$Confirmed, [switch]$DryRun)
    try {
        $result = Invoke-CapstanIsolated -ArgumentList @($script:CapstanRoot) -Code @'
param($Root)
. (Join-Path $Root 'modules/Hotkeys.ps1')
$status = Get-CapstanHotkeyStatus -Service $null
return @{ available = [bool]$status.available; running = [bool]$status.running; reason = [string]$status.reason }
'@
        return @{ Ok = $true; Result = $result }
    } catch {
        return @{ Ok = $true; Result = @{ available = $false; running = $false; reason = 'Global hotkeys are not available on this computer.' } }
    }
}

function Invoke-CapstanCursorShow {
    param($Arguments, [switch]$Confirmed, [switch]$DryRun)
    try {
        Invoke-CapstanIsolated -ArgumentList @($script:CapstanRoot) -Code @'
param($Root)
. (Join-Path $Root 'modules/CursorCapture.ps1')
return $true
'@ | Out-Null
        return @{ Ok = $true; Result = @{ available = $true; reason = 'Cursor capture is part of the host. It records only while Capstan is running.' } }
    } catch {
        return @{ Ok = $true; Result = @{ available = $false; reason = 'Cursor capture is not available on this computer.' } }
    }
}

function Invoke-CapstanFileShow {
    param($Arguments, [switch]$Confirmed, [switch]$DryRun)
    $loaded = Read-CapstanProjectDocument -File ([string]$Arguments['file'])
    if (-not $loaded.Ok) { return $loaded }
    $summary = Convert-CapstanSummary $loaded.Project
    if ($DryRun) { $summary['would'] = 'read the project file' }
    return @{ Ok = $true; Result = $summary }
}

function Invoke-CapstanHandoffChapters {
    param($Arguments, [switch]$Confirmed, [switch]$DryRun)
    $loaded = Read-CapstanProjectDocument -File ([string]$Arguments['file'])
    if (-not $loaded.Ok) { return $loaded }
    $format = [string]$Arguments['format']
    if ([string]::IsNullOrEmpty($format)) { $format = 'text' }
    $chapters = @(Get-CapstanChapters $loaded.Project)
    $text = ''
    if ($format -eq 'vtt') { $text = Format-CapstanChaptersVtt $chapters (Get-CapstanProjectDuration $loaded.Project) }
    else { $text = Format-CapstanChaptersText $chapters }
    return @{ Ok = $true; Result = @{ format = $format; text = $text; chapters = $chapters.Count } }
}

function Invoke-CapstanHandoffCaptions {
    param($Arguments, [switch]$Confirmed, [switch]$DryRun)
    $loaded = Read-CapstanProjectDocument -File ([string]$Arguments['file'])
    if (-not $loaded.Ok) { return $loaded }
    $format = [string]$Arguments['format']
    if ([string]::IsNullOrEmpty($format)) { $format = 'vtt' }
    $captions = @(Get-CapstanProjectList $loaded.Project 'captions')
    $text = ''
    if ($format -eq 'srt') { $text = Format-CapstanSrt $captions }
    else { $text = Format-CapstanVtt $captions }
    return @{ Ok = $true; Result = @{ format = $format; text = $text; captions = $captions.Count } }
}

function Invoke-CapstanJobRun {
    param($Arguments, [switch]$Confirmed, [switch]$DryRun)
    $envelope = Invoke-FleetJob -Path ([string]$Arguments['file']) -Confirmed:$Confirmed -DryRun:$DryRun
    if ((Get-FleetProp $envelope 'ok') -eq $true) {
        return @{ Ok = $true; Result = (Get-FleetProp $envelope 'result') }
    }
    return @{
        Ok        = $false
        ErrorType = [string](Get-FleetProp $envelope 'errorType')
        Error     = [string](Get-FleetProp $envelope 'error')
    }
}

function Get-CapstanHostHandler {
    param([string]$Id)
    switch ($Id) {
        'capstan.host.show' { return { param($Arguments, [switch]$Confirmed, [switch]$DryRun) Invoke-CapstanHostShow -Arguments $Arguments -Confirmed:$Confirmed -DryRun:$DryRun } }
        'capstan.session.show' { return { param($Arguments, [switch]$Confirmed, [switch]$DryRun) Invoke-CapstanSessionShow -Arguments $Arguments -Confirmed:$Confirmed -DryRun:$DryRun } }
        'capstan.session.end' { return { param($Arguments, [switch]$Confirmed, [switch]$DryRun) Invoke-CapstanSessionEnd -Arguments $Arguments -Confirmed:$Confirmed -DryRun:$DryRun } }
        'capstan.diagnostics.run' { return { param($Arguments, [switch]$Confirmed, [switch]$DryRun) Invoke-CapstanDiagnosticsRun -Arguments $Arguments -Confirmed:$Confirmed -DryRun:$DryRun } }
        'capstan.captures.list' { return { param($Arguments, [switch]$Confirmed, [switch]$DryRun) Invoke-CapstanCapturesList -Arguments $Arguments -Confirmed:$Confirmed -DryRun:$DryRun } }
        'capstan.library.list' { return { param($Arguments, [switch]$Confirmed, [switch]$DryRun) Invoke-CapstanLibraryList -Arguments $Arguments -Confirmed:$Confirmed -DryRun:$DryRun } }
        'capstan.speech.show' { return { param($Arguments, [switch]$Confirmed, [switch]$DryRun) Invoke-CapstanSpeechShow -Arguments $Arguments -Confirmed:$Confirmed -DryRun:$DryRun } }
        'capstan.hotkeys.show' { return { param($Arguments, [switch]$Confirmed, [switch]$DryRun) Invoke-CapstanHotkeysShow -Arguments $Arguments -Confirmed:$Confirmed -DryRun:$DryRun } }
        'capstan.cursor.show' { return { param($Arguments, [switch]$Confirmed, [switch]$DryRun) Invoke-CapstanCursorShow -Arguments $Arguments -Confirmed:$Confirmed -DryRun:$DryRun } }
        'capstan.file.show' { return { param($Arguments, [switch]$Confirmed, [switch]$DryRun) Invoke-CapstanFileShow -Arguments $Arguments -Confirmed:$Confirmed -DryRun:$DryRun } }
        'capstan.handoff.chapters' { return { param($Arguments, [switch]$Confirmed, [switch]$DryRun) Invoke-CapstanHandoffChapters -Arguments $Arguments -Confirmed:$Confirmed -DryRun:$DryRun } }
        'capstan.handoff.captions' { return { param($Arguments, [switch]$Confirmed, [switch]$DryRun) Invoke-CapstanHandoffCaptions -Arguments $Arguments -Confirmed:$Confirmed -DryRun:$DryRun } }
        'capstan.job.run' { return { param($Arguments, [switch]$Confirmed, [switch]$DryRun) Invoke-CapstanJobRun -Arguments $Arguments -Confirmed:$Confirmed -DryRun:$DryRun } }
        default { throw ('No host handler for ' + $Id) }
    }
}

function New-CapstanPageHandler {
    param([string]$CommandName)
    $captured = $CommandName
    return {
        param($Arguments, [switch]$Confirmed, [switch]$DryRun)
        if ($DryRun) {
            return @{ Ok = $true; Result = @{ command = $captured; would = 'run on the open Capstan project in the page' } }
        }
        return @{ Ok = $false; ErrorType = 'needs-browser'; Error = ($captured + ' needs the running Capstan page. It uses the editor, media bytes, or a browser encoder, so this shell cannot do it headless.') }
    }.GetNewClosure()
}

function Convert-CapstanInputsToSchema {
    param($Command)
    $props = @{}
    $required = @()
    foreach ($input in @(Get-FleetProp $Command 'inputs')) {
        if ($null -eq $input) { continue }
        $name = [string](Get-FleetProp $input 'name')
        if ([string]::IsNullOrEmpty($name)) { continue }
        $type = [string](Get-FleetProp $input 'type')
        $spec = @{}
        $many = (Get-FleetProp $input 'many') -eq $true
        if ($type -eq 'number') {
            if ((Get-FleetProp $input 'integer') -eq $true) { $spec['type'] = 'integer' } else { $spec['type'] = 'number' }
            $min = Get-FleetProp $input 'min'
            $max = Get-FleetProp $input 'max'
            if ($null -ne $min) { $spec['minimum'] = $min }
            if ($null -ne $max) { $spec['maximum'] = $max }
        } elseif ($type -eq 'boolean') {
            $spec['type'] = 'boolean'
        } elseif ($type -eq 'enum') {
            $spec['type'] = 'string'
            $spec['enum'] = @(Get-FleetProp $input 'values')
        } elseif ($type -eq 'id' -and $many) {
            $spec['type'] = 'array'
            $spec['items'] = @{ type = 'string'; minLength = 1 }
        } elseif ($type -eq 'json') {
            $spec['type'] = 'object'
            $spec['xJson'] = $true
        } else {
            $spec['type'] = 'string'
            if ($type -eq 'id') { $spec['minLength'] = 1 }
        }
        $desc = Get-FleetProp $input 'description'
        if ($desc) { $spec['description'] = [string]$desc }
        $props[$name] = $spec
        if ((Get-FleetProp $input 'required') -eq $true) { $required += $name }
    }
    $schema = @{
        type                 = 'object'
        additionalProperties = $false
        properties           = $props
        required             = $required
    }
    $atLeast = @(Get-FleetProp $Command 'atLeastOne')
    if ($atLeast.Count -gt 0 -and -not [string]::IsNullOrEmpty([string]$atLeast[0])) {
        $schema['atLeastOne'] = $atLeast
    }
    return $schema
}

function Register-CapstanActions {
    Reset-FleetActions
    $hostPath = Join-Path $PSScriptRoot 'host-catalog.json'
    $hostDoc = [IO.File]::ReadAllText($hostPath) | ConvertFrom-Json
    foreach ($row in @(Get-FleetProp $hostDoc 'actions')) {
        $id = [string](Get-FleetProp $row 'id')
        $destructive = (Get-FleetProp $row 'destructive') -eq $true
        Register-FleetAction -App 'capstan' -Noun ([string](Get-FleetProp $row 'noun')) -Verb ([string](Get-FleetProp $row 'verb')) -Summary ([string](Get-FleetProp $row 'summary')) -Schema (Get-FleetProp $row 'schema') -Destructive:$destructive -Needs 'host' -Handler (Get-CapstanHostHandler $id)
    }
    $editorPath = Join-Path $PSScriptRoot 'editor-catalog.json'
    $editor = [IO.File]::ReadAllText($editorPath) | ConvertFrom-Json
    foreach ($cmd in @(Get-FleetProp $editor 'commands')) {
        $name = [string](Get-FleetProp $cmd 'name')
        if ($name -eq 'session end') { continue }
        $space = $name.IndexOf(' ')
        $noun = $name.Substring(0, $space)
        $verb = $name.Substring($space + 1)
        $destructive = (Get-FleetProp $cmd 'destructive') -eq $true
        Register-FleetAction -App 'capstan' -Noun $noun -Verb $verb -Summary ([string](Get-FleetProp $cmd 'summary')) -Schema (Convert-CapstanInputsToSchema $cmd) -Destructive:$destructive -Needs 'page' -Handler (New-CapstanPageHandler $name)
    }
}

Export-ModuleMember -Function Register-CapstanActions
