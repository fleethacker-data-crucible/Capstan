<#
  Fleet action framework for Windows PowerShell 5.1.

  One action is app.noun.verb. Discovery is "commands --json"; "help --json" is the same document.
  Destructive actions refuse to run unless -Confirmed is set (the CLI flag is --yes). A dry run
  never asks for confirmation and never calls a handler in a way that changes state: handlers
  receive -DryRun and must not write.

  JSON from ConvertFrom-Json is read only through PSObject.Properties. ConvertTo-Json always
  gets -Depth. Nothing here writes a token, password, or session secret to the log.

  This copy is vendored. See LOCK.json for the pin and the note about the baseline repository.
#>

$script:FleetActions = @{}
$script:FleetHostMode = $false
$script:FleetJobDepth = 0

function Get-FleetProp {
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

function Test-FleetProp {
    param($Object, [string]$Name)
    if ($null -eq $Object -or [string]::IsNullOrEmpty($Name)) { return $false }
    if ($Object -is [System.Collections.IDictionary]) { return $Object.Contains($Name) }
    return $null -ne $Object.PSObject.Properties[$Name]
}

function Get-FleetKeys {
    # One name at a time so the caller can collect them.
    # $table.Keys is wrong when a key is named "keys": PowerShell is case-insensitive and
    # returns that entry instead of the dictionary's key collection. The interface property does not.
    param($Object)
    if ($null -eq $Object) { return }
    if ($Object -is [System.Collections.IDictionary]) {
        $names = [System.Collections.IDictionary].GetProperty('Keys').GetValue($Object)
        foreach ($key in $names) { Write-Output ([string]$key) }
        return
    }
    foreach ($prop in $Object.PSObject.Properties) { Write-Output ([string]$prop.Name) }
}

function ConvertTo-FleetJson {
    param($Value)
    return (ConvertTo-Json -InputObject $Value -Depth 40 -Compress)
}

function Protect-FleetLogText {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $safe = [regex]::Replace($Text, '(?i)(token|secret|password|session)\s*[:=]\s*\S+', '$1=(redacted)')
    $safe = [regex]::Replace($safe, '\b[0-9a-fA-F]{32,}\b', '(redacted)')
    return $safe
}

function Write-FleetNote {
    param([string]$Message)
    Write-Verbose (Protect-FleetLogText $Message)
}

function Reset-FleetActions {
    $script:FleetActions = @{}
    $script:FleetHostMode = $false
    $script:FleetJobDepth = 0
}

function Set-FleetHostMode {
    param([bool]$Enabled)
    $script:FleetHostMode = $Enabled
}

function Get-FleetHostMode {
    return [bool]$script:FleetHostMode
}

function ConvertFrom-FleetFlagName {
    param([string]$Name)
    $parts = $Name.ToLowerInvariant().Split('-')
    $out = ''
    $first = $true
    foreach ($part in $parts) {
        if ([string]::IsNullOrEmpty($part)) { continue }
        if ($first) { $out = $part; $first = $false }
        else { $out += $part.Substring(0, 1).ToUpperInvariant() + $part.Substring(1) }
    }
    return $out
}

function Register-FleetAction {
    param(
        [Parameter(Mandatory = $true)][string]$App,
        [Parameter(Mandatory = $true)][string]$Noun,
        [Parameter(Mandatory = $true)][string]$Verb,
        [Parameter(Mandatory = $true)][string]$Summary,
        [Parameter(Mandatory = $true)]$Schema,
        [Parameter(Mandatory = $true)][scriptblock]$Handler,
        [switch]$Destructive,
        [ValidateSet('host', 'page')][string]$Needs = 'host'
    )
    $id = $App + '.' + $Noun + '.' + $Verb
    if ($id -notmatch '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2}$') {
        throw ('Action id "' + $id + '" is not app.noun.verb')
    }
    $script:FleetActions[$id] = @{
        id          = $id
        app         = $App
        noun        = $Noun
        verb        = $Verb
        summary     = $Summary
        schema      = $Schema
        destructive = [bool]$Destructive
        needs       = $Needs
        handler     = $Handler
    }
}

function Get-FleetAction {
    param([Parameter(Mandatory = $true)][string]$Id)
    if (-not $script:FleetActions.Contains($Id)) { return $null }
    return $script:FleetActions[$Id]
}

function Get-FleetCommandsDocument {
    $rows = @()
    foreach ($id in @($script:FleetActions.Keys | Sort-Object)) {
        $a = $script:FleetActions[$id]
        $rows += @{
            id          = $a.id
            app         = $a.app
            noun        = $a.noun
            verb        = $a.verb
            summary     = $a.summary
            destructive = [bool]$a.destructive
            needs       = $a.needs
            schema      = $a.schema
        }
    }
    $app = 'capstan'
    if ($rows.Count -gt 0) { $app = [string]$rows[0].app }
    return @{
        schema  = 'fleet.commands/1'
        app     = $app
        actions = $rows
    }
}

function New-FleetEnvelope {
    param(
        [string]$Action,
        [bool]$Ok,
        $Result,
        [string]$ErrorType,
        [string]$Error,
        [bool]$DryRun
    )
    $env = @{
        schema = 'fleet.result/1'
        action = $Action
        ok     = $Ok
    }
    if ($DryRun) { $env['dryRun'] = $true }
    if ($null -ne $Result) { $env['result'] = $Result }
    if (-not $Ok) {
        $env['errorType'] = $ErrorType
        $env['error'] = $Error
    }
    return $env
}

function Get-FleetExitCode {
    param($Envelope)
    if ((Get-FleetProp $Envelope 'ok') -eq $true) { return 0 }
    $kind = [string](Get-FleetProp $Envelope 'errorType')
    if ($kind -eq 'usage' -or $kind -eq 'needs-confirm') { return 2 }
    return 1
}

function Test-FleetNumber {
    param($Value)
    if ($null -eq $Value) { return $false }
    return ($Value -is [byte] -or $Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal] -or $Value -is [float] -or $Value -is [single])
}

function Convert-FleetScalar {
    param($Spec, $Raw, [string]$Name)
    $type = [string](Get-FleetProp $Spec 'type')
    if ([string]::IsNullOrEmpty($type)) { $type = 'string' }
    $xJson = (Get-FleetProp $Spec 'xJson') -eq $true

    if ($type -eq 'boolean') {
        if ($Raw -is [bool]) { return @{ ok = $true; value = [bool]$Raw } }
        if ($Raw -is [string]) {
            $t = $Raw.Trim().ToLowerInvariant()
            if ($t -eq 'true') { return @{ ok = $true; value = $true } }
            if ($t -eq 'false') { return @{ ok = $true; value = $false } }
        }
        return @{ ok = $false; error = ('"' + $Name + '" must be true or false') }
    }

    if ($type -eq 'integer' -or $type -eq 'number') {
        $n = $null
        if (Test-FleetNumber $Raw) { $n = [double]$Raw }
        elseif ($Raw -is [string] -and $Raw.Trim() -match '^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$') { $n = [double]$Raw.Trim() }
        else { return @{ ok = $false; error = ('"' + $Name + '" must be a number') } }
        if ([double]::IsNaN($n) -or [double]::IsInfinity($n)) { return @{ ok = $false; error = ('"' + $Name + '" must be a finite number') } }
        if ($type -eq 'integer' -and [Math]::Abs($n - [Math]::Round($n)) -gt 0.0000001) {
            return @{ ok = $false; error = ('"' + $Name + '" must be a whole number') }
        }
        $min = Get-FleetProp $Spec 'minimum'
        $max = Get-FleetProp $Spec 'maximum'
        if ($null -ne $min -and $n -lt [double]$min) { return @{ ok = $false; error = ('"' + $Name + '" must be at least ' + $min) } }
        if ($null -ne $max -and $n -gt [double]$max) { return @{ ok = $false; error = ('"' + $Name + '" must be at most ' + $max) } }
        if ($type -eq 'integer') { return @{ ok = $true; value = [int][Math]::Round($n) } }
        return @{ ok = $true; value = $n }
    }

    if ($type -eq 'array') {
        $list = $null
        if ($Raw -is [System.Collections.IEnumerable] -and $Raw -isnot [string]) { $list = @($Raw) }
        elseif ($Raw -is [string]) { $list = @($Raw.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }) }
        else { return @{ ok = $false; error = ('"' + $Name + '" must be a list') } }
        if ($list.Count -eq 0) { return @{ ok = $false; error = ('"' + $Name + '" needs at least one value') } }
        $items = @()
        foreach ($item in $list) {
            if ($item -isnot [string] -or [string]::IsNullOrWhiteSpace($item)) {
                return @{ ok = $false; error = ('"' + $Name + '" must be a list of strings') }
            }
            $items += $item.Trim()
        }
        return @{ ok = $true; value = $items }
    }

    $enum = Get-FleetProp $Spec 'enum'
    if ($null -ne $enum) {
        $text = $null
        if ($Raw -is [string]) { $text = $Raw }
        elseif (Test-FleetNumber $Raw -or $Raw -is [bool]) { $text = [string]$Raw }
        $allowed = @($enum)
        $match = $false
        foreach ($item in $allowed) { if ([string]$item -eq $text) { $match = $true } }
        if (-not $match) {
            return @{ ok = $false; error = ('"' + $Name + '" must be one of: ' + ($allowed -join ', ')) }
        }
        return @{ ok = $true; value = $text }
    }

    if ($xJson -or $type -eq 'object') {
        if ($Raw -is [string]) {
            try {
                $parsed = $Raw | ConvertFrom-Json
                return @{ ok = $true; value = $parsed }
            } catch {
                return @{ ok = $false; error = ('"' + $Name + '" must be JSON') }
            }
        }
        if ($null -ne $Raw -and ($Raw -is [System.Collections.IDictionary] -or $Raw.PSObject)) {
            return @{ ok = $true; value = $Raw }
        }
        return @{ ok = $false; error = ('"' + $Name + '" must be JSON') }
    }

    if ($Raw -isnot [string]) { return @{ ok = $false; error = ('"' + $Name + '" must be a string') } }
    $minLen = Get-FleetProp $Spec 'minLength'
    if ($null -ne $minLen -and $Raw.Length -lt [int]$minLen) {
        return @{ ok = $false; error = ('"' + $Name + '" must not be empty') }
    }
    return @{ ok = $true; value = $Raw }
}

function Test-FleetArguments {
    param($Schema, $Arguments)
    if ($null -eq $Arguments) { $Arguments = @{} }
    $isObj = $false
    if ($Arguments -is [System.Collections.IDictionary]) { $isObj = $true }
    elseif ($null -ne $Arguments.PSObject -and $Arguments -isnot [string] -and $Arguments -isnot [System.Array]) { $isObj = $true }
    if (-not $isObj) { return @{ ok = $false; error = 'The arguments must be an object of name and value pairs' } }

    $props = Get-FleetProp $Schema 'properties'
    if ($null -eq $props) { $props = @{} }
    $known = @(Get-FleetKeys $props)
    $problems = @()
    foreach ($key in @(Get-FleetKeys $Arguments)) {
        $knownHit = $false
        foreach ($name in $known) { if ($name -eq $key) { $knownHit = $true } }
        if (-not $knownHit) {
            if ($known.Count -eq 0) { $problems += ('Unknown argument "' + $key + '" (this action takes no arguments)') }
            else { $problems += ('Unknown argument "' + $key + '" (this action takes: ' + ($known -join ', ') + ')') }
        }
    }

    $coerced = @{}
    $requiredRaw = Get-FleetProp $Schema 'required'
    $required = @()
    if ($null -ne $requiredRaw) { $required = @($requiredRaw) }
    foreach ($name in $required) {
        if ([string]::IsNullOrEmpty([string]$name)) { continue }
        $present = $false
        foreach ($key in @(Get-FleetKeys $Arguments)) { if ($key -eq [string]$name) { $present = $true } }
        if (-not $present) { $problems += ('Missing required argument "' + $name + '"') }
    }

    foreach ($name in $known) {
        $present = $false
        foreach ($key in @(Get-FleetKeys $Arguments)) { if ($key -eq $name) { $present = $true } }
        if (-not $present) { continue }
        $raw = Get-FleetProp $Arguments $name
        if ($null -eq $raw) { continue }
        $spec = Get-FleetProp $props $name
        $one = Convert-FleetScalar -Spec $spec -Raw $raw -Name $name
        if (-not $one.ok) { $problems += [string]$one.error }
        else { $coerced[$name] = $one.value }
    }

    $atLeastRaw = Get-FleetProp $Schema 'atLeastOne'
    $atLeast = @()
    if ($null -ne $atLeastRaw) { $atLeast = @($atLeastRaw) }
    if ($problems.Count -eq 0 -and $atLeast.Count -gt 0) {
        $any = $false
        foreach ($name in $atLeast) {
            if ($coerced.Contains([string]$name)) { $any = $true }
        }
        if (-not $any) { $problems += ('Give at least one of: ' + ($atLeast -join ', ')) }
    }

    if ($problems.Count -gt 0) { return @{ ok = $false; error = ($problems -join '; ') } }
    return @{ ok = $true; args = $coerced }
}

function Invoke-FleetAction {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        $Arguments,
        [switch]$Confirmed,
        [switch]$DryRun
    )
    $action = Get-FleetAction -Id $Id
    if ($null -eq $action) {
        return (New-FleetEnvelope -Action $Id -Ok $false -ErrorType 'usage' -Error ('Unknown action "' + $Id + '". Run commands --json to list actions.') -DryRun:$DryRun)
    }
    $checked = Test-FleetArguments -Schema $action.schema -Arguments $Arguments
    if (-not $checked.ok) {
        return (New-FleetEnvelope -Action $Id -Ok $false -ErrorType 'usage' -Error ([string]$checked.error) -DryRun:$DryRun)
    }
    if ($action.destructive -and -not $DryRun -and -not $Confirmed) {
        $msg = '"' + $action.noun + ' ' + $action.verb + '" discards or replaces data. Run it again with -Confirmed (on a command line, --yes), or preview it with --dry-run.'
        return (New-FleetEnvelope -Action $Id -Ok $false -ErrorType 'needs-confirm' -Error $msg -DryRun:$false)
    }
    if ($script:FleetJobDepth -gt 0 -and $Id -eq 'capstan.job.run') {
        return (New-FleetEnvelope -Action $Id -Ok $false -ErrorType 'failed' -Error 'A job cannot start another job.' -DryRun:$DryRun)
    }
    try {
        $produced = & $action.handler -Arguments $checked.args -Confirmed:$Confirmed -DryRun:$DryRun
    } catch {
        Write-FleetNote ('Action ' + $Id + ' failed.')
        return (New-FleetEnvelope -Action $Id -Ok $false -ErrorType 'failed' -Error 'The action failed before it could finish.' -DryRun:$DryRun)
    }
    if ($null -eq $produced) {
        return (New-FleetEnvelope -Action $Id -Ok $false -ErrorType 'failed' -Error 'The action returned nothing.' -DryRun:$DryRun)
    }
    $ok = (Get-FleetProp $produced 'Ok')
    if ($null -eq $ok) { $ok = Get-FleetProp $produced 'ok' }
    if ($ok -eq $true) {
        $result = Get-FleetProp $produced 'Result'
        if ($null -eq $result) { $result = Get-FleetProp $produced 'result' }
        if ($null -eq $result) { $result = @{} }
        return (New-FleetEnvelope -Action $Id -Ok $true -Result $result -DryRun:$DryRun)
    }
    $errorType = [string](Get-FleetProp $produced 'ErrorType')
    if ([string]::IsNullOrEmpty($errorType)) { $errorType = [string](Get-FleetProp $produced 'errorType') }
    if ([string]::IsNullOrEmpty($errorType)) { $errorType = 'failed' }
    $error = [string](Get-FleetProp $produced 'Error')
    if ([string]::IsNullOrEmpty($error)) { $error = [string](Get-FleetProp $produced 'error') }
    if ([string]::IsNullOrEmpty($error)) { $error = 'The action could not be completed.' }
    return (New-FleetEnvelope -Action $Id -Ok $false -ErrorType $errorType -Error $error -DryRun:$DryRun)
}

function Invoke-FleetJob {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$Confirmed,
        [switch]$DryRun
    )
    if ($Path -notmatch '\.json\z') {
        return (New-FleetEnvelope -Action 'capstan.job.run' -Ok $false -ErrorType 'usage' -Error 'Job files must be JSON (.json). Other formats are not accepted.' -DryRun:$DryRun)
    }
    $full = $null
    try { $full = [IO.Path]::GetFullPath($Path) } catch {
        return (New-FleetEnvelope -Action 'capstan.job.run' -Ok $false -ErrorType 'failed' -Error 'That job path is not valid.' -DryRun:$DryRun)
    }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        return (New-FleetEnvelope -Action 'capstan.job.run' -Ok $false -ErrorType 'failed' -Error 'That job file was not found.' -DryRun:$DryRun)
    }
    $item = Get-Item -LiteralPath $full -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        return (New-FleetEnvelope -Action 'capstan.job.run' -Ok $false -ErrorType 'failed' -Error 'That job path is not a plain file.' -DryRun:$DryRun)
    }
    if ($item.Length -gt 1048576) {
        return (New-FleetEnvelope -Action 'capstan.job.run' -Ok $false -ErrorType 'failed' -Error 'That job file is too large.' -DryRun:$DryRun)
    }
    try { $text = [IO.File]::ReadAllText($full) } catch {
        return (New-FleetEnvelope -Action 'capstan.job.run' -Ok $false -ErrorType 'failed' -Error 'That job file could not be read.' -DryRun:$DryRun)
    }
    try { $doc = $text | ConvertFrom-Json } catch {
        return (New-FleetEnvelope -Action 'capstan.job.run' -Ok $false -ErrorType 'usage' -Error 'That job file is not JSON.' -DryRun:$DryRun)
    }
    $schema = [string](Get-FleetProp $doc 'schema')
    if ($schema -ne 'fleet.job/1') {
        return (New-FleetEnvelope -Action 'capstan.job.run' -Ok $false -ErrorType 'usage' -Error 'A job file needs "schema": "fleet.job/1".' -DryRun:$DryRun)
    }
    $steps = @(Get-FleetProp $doc 'actions')
    if ($steps.Count -eq 0) {
        return (New-FleetEnvelope -Action 'capstan.job.run' -Ok $false -ErrorType 'usage' -Error 'A job file needs an actions list.' -DryRun:$DryRun)
    }
    $script:FleetJobDepth = $script:FleetJobDepth + 1
    $done = @()
    try {
        foreach ($step in $steps) {
            $stepId = [string](Get-FleetProp $step 'action')
            if ([string]::IsNullOrEmpty($stepId)) { $stepId = [string](Get-FleetProp $step 'id') }
            $stepArgs = Get-FleetProp $step 'args'
            if ($null -eq $stepArgs) { $stepArgs = @{} }
            $envelope = Invoke-FleetAction -Id $stepId -Arguments $stepArgs -Confirmed:$Confirmed -DryRun:$DryRun
            $done += $envelope
            if ((Get-FleetProp $envelope 'ok') -ne $true) {
                return (New-FleetEnvelope -Action 'capstan.job.run' -Ok $false -ErrorType ([string](Get-FleetProp $envelope 'errorType')) -Error ([string](Get-FleetProp $envelope 'error')) -Result @{ steps = $done } -DryRun:$DryRun)
            }
        }
    } finally {
        $script:FleetJobDepth = $script:FleetJobDepth - 1
    }
    return (New-FleetEnvelope -Action 'capstan.job.run' -Ok $true -Result @{ steps = $done } -DryRun:$DryRun)
}

function Get-FleetHelpText {
    $doc = Get-FleetCommandsDocument
    $lines = @()
    $lines += 'Capstan actions. Discovery: capstan.ps1 commands --json (help --json is the same list).'
    $lines += 'capstan.ps1 <noun> <verb> [--json] [--out FILE] [--yes] [--dry-run] [--option value]'
    $lines += 'capstan.ps1 job run --file <job.json> [--json] [--yes] [--dry-run]'
    $lines += ''
    foreach ($row in @($doc.actions)) {
        $mark = ''
        if ((Get-FleetProp $row 'destructive') -eq $true) { $mark = ' [destructive]' }
        $lines += ((Get-FleetProp $row 'id') + $mark + '  ' + (Get-FleetProp $row 'summary'))
    }
    return ($lines -join "`n")
}

function Invoke-FleetCli {
    param([string[]]$Arguments)
    $json = $false
    $yes = $false
    $dry = $false
    $out = $null
    $positional = @()
    $flags = @{}
    $list = @($Arguments)
    for ($i = 0; $i -lt $list.Count; $i++) {
        $token = [string]$list[$i]
        if ($token -eq '--json') { $json = $true; continue }
        if ($token -eq '--yes') { $yes = $true; continue }
        if ($token -eq '--dry-run') { $dry = $true; continue }
        if ($token -eq '--help' -or $token -eq '-h') { $positional += 'help'; continue }
        if ($token -eq '--out' -or $token.StartsWith('--out=')) {
            $path = $null
            if ($token.StartsWith('--out=')) { $path = $token.Substring(6) }
            else {
                if ($i + 1 -ge $list.Count) {
                    $env = New-FleetEnvelope -Action 'capstan.commands.list' -Ok $false -ErrorType 'usage' -Error 'Missing the path after --out.' -DryRun:$false
                    return @{ ExitCode = 2; Stdout = $(if ($json) { (ConvertTo-FleetJson $env) } else { 'Missing the path after --out.' }); Json = $env }
                }
                $i = $i + 1
                $path = [string]$list[$i]
            }
            $out = $path
            continue
        }
        if ($token.StartsWith('--')) {
            $body = $token.Substring(2)
            $value = $true
            $name = $body
            if ($body.Contains('=')) {
                $eq = $body.IndexOf('=')
                $name = $body.Substring(0, $eq)
                $value = $body.Substring($eq + 1)
            } elseif ($i + 1 -lt $list.Count -and -not ([string]$list[$i + 1]).StartsWith('-')) {
                $i = $i + 1
                $value = [string]$list[$i]
            }
            $camel = ConvertFrom-FleetFlagName $name
            if ([string]::IsNullOrEmpty($camel)) {
                $env = New-FleetEnvelope -Action 'capstan.commands.list' -Ok $false -ErrorType 'usage' -Error ('Unknown option "--' + $name + '".') -DryRun:$false
                return @{ ExitCode = 2; Stdout = $(if ($json) { (ConvertTo-FleetJson $env) } else { [string]$env.error }); Json = $env }
            }
            $flags[$camel] = $value
            continue
        }
        $positional += $token
    }

    $first = ''
    if ($positional.Count -gt 0) { $first = [string]$positional[0] }

    if ($positional.Count -eq 0 -or $first -eq 'help' -or $first -eq 'commands') {
        if ($first -eq 'help' -and $positional.Count -ge 3 -and -not $json) {
            $id = 'capstan.' + $positional[1] + '.' + $positional[2]
            $one = Get-FleetAction -Id $id
            if ($null -eq $one) {
                $text = 'Unknown action "' + $id + '". Run: capstan.ps1 commands --json'
                return @{ ExitCode = 2; Stdout = $text; Json = (New-FleetEnvelope -Action $id -Ok $false -ErrorType 'usage' -Error $text -DryRun:$false); OutFile = $out }
            }
            $text = $one.id + "`n" + $one.summary
            if ($one.destructive) { $text += "`nDestructive: pass --yes (the parameter is -Confirmed)." }
            return @{ ExitCode = 0; Stdout = $text; Json = (Get-FleetCommandsDocument); OutFile = $out }
        }
        $doc = Get-FleetCommandsDocument
        if ($json -or $first -eq 'commands') {
            if ($json -or $true) {
                if ($first -eq 'commands' -and -not $json) {
                    return @{ ExitCode = 0; Stdout = (Get-FleetHelpText); Json = $doc; OutFile = $out }
                }
            }
        }
        if ($json -or ($first -eq 'commands' -and $json) -or ($first -eq 'help' -and $json) -or ($positional.Count -eq 0 -and $json)) {
            $payload = ConvertTo-FleetJson $doc
            return @{ ExitCode = 0; Stdout = $payload; Json = $doc; OutFile = $out }
        }
        if ($positional.Count -eq 0 -and -not $json) {
            return @{ ExitCode = 0; Stdout = (Get-FleetHelpText); Json = $doc; OutFile = $out }
        }
        if ($first -eq 'help' -and -not $json) {
            return @{ ExitCode = 0; Stdout = (Get-FleetHelpText); Json = $doc; OutFile = $out }
        }
        if ($first -eq 'commands' -and $json) {
            $payload = ConvertTo-FleetJson $doc
            return @{ ExitCode = 0; Stdout = $payload; Json = $doc; OutFile = $out }
        }
    }

    if ($json -and ($first -eq 'help' -or $first -eq 'commands' -or $positional.Count -eq 0)) {
        $doc = Get-FleetCommandsDocument
        return @{ ExitCode = 0; Stdout = (ConvertTo-FleetJson $doc); Json = $doc; OutFile = $out }
    }

    if ($first -eq 'job') {
        $verb = ''
        if ($positional.Count -gt 1) { $verb = [string]$positional[1] }
        if ($verb -ne 'run') {
            $env = New-FleetEnvelope -Action 'capstan.job.run' -Ok $false -ErrorType 'usage' -Error 'Use: capstan.ps1 job run --file <job.json>' -DryRun:$dry
            $text = $(if ($json) { ConvertTo-FleetJson $env } else { [string]$env.error })
            return @{ ExitCode = 2; Stdout = $text; Json = $env; OutFile = $out }
        }
        $file = [string]$flags['file']
        if ([string]::IsNullOrEmpty($file)) {
            $env = New-FleetEnvelope -Action 'capstan.job.run' -Ok $false -ErrorType 'usage' -Error 'Missing required argument "file".' -DryRun:$dry
            $text = $(if ($json) { ConvertTo-FleetJson $env } else { [string]$env.error })
            return @{ ExitCode = 2; Stdout = $text; Json = $env; OutFile = $out }
        }
        $env = Invoke-FleetJob -Path $file -Confirmed:$yes -DryRun:$dry
        $code = Get-FleetExitCode $env
        $text = $(if ($json) { ConvertTo-FleetJson $env } else { $(if ($env.ok) { 'capstan.job.run completed.' } else { [string]$env.error }) })
        return @{ ExitCode = $code; Stdout = $text; Json = $env; OutFile = $out }
    }

    if ($positional.Count -lt 2) {
        $env = New-FleetEnvelope -Action 'capstan.commands.list' -Ok $false -ErrorType 'usage' -Error 'Use: capstan.ps1 <noun> <verb>, or capstan.ps1 commands --json' -DryRun:$false
        $text = $(if ($json) { ConvertTo-FleetJson $env } else { [string]$env.error })
        return @{ ExitCode = 2; Stdout = $text; Json = $env; OutFile = $out }
    }

    $id = 'capstan.' + $positional[0] + '.' + $positional[1]
    if ($positional.Count -gt 2) {
        $env = New-FleetEnvelope -Action $id -Ok $false -ErrorType 'usage' -Error 'Unexpected extra words. Options look like --name value.' -DryRun:$dry
        $text = $(if ($json) { ConvertTo-FleetJson $env } else { [string]$env.error })
        return @{ ExitCode = 2; Stdout = $text; Json = $env; OutFile = $out }
    }

    $env = Invoke-FleetAction -Id $id -Arguments $flags -Confirmed:$yes -DryRun:$dry
    $code = Get-FleetExitCode $env
    if ($json) { $text = ConvertTo-FleetJson $env }
    elseif ($env.ok) { $text = ($id + ' completed.') }
    else { $text = [string]$env.error }
    return @{ ExitCode = $code; Stdout = $text; Json = $env; OutFile = $out }
}

Export-ModuleMember -Function Get-FleetProp, Test-FleetProp, Get-FleetKeys, ConvertTo-FleetJson, Protect-FleetLogText, Reset-FleetActions, Set-FleetHostMode, Get-FleetHostMode, ConvertFrom-FleetFlagName, Register-FleetAction, Get-FleetAction, Get-FleetCommandsDocument, Invoke-FleetAction, Invoke-FleetJob, Invoke-FleetCli, Get-FleetExitCode, Get-FleetHelpText
