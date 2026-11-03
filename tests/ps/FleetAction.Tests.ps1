<#
  Pester 5 tests for Capstan's Fleet actions. Windows PowerShell 5.1.
  Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests\ps\FleetAction.Tests.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

Import-Module (Join-Path $root 'vendor/FleetAction/FleetAction.psm1') -Force
Import-Module (Join-Path $root 'actions/Capstan.Actions.psm1') -Force
# Pester 5 is vendored as script plus base64. Materialise the assembly, then import once.
if (-not (Get-Module Pester)) {
    & (Join-Path $root 'vendor/Pester/Restore.ps1')
    Import-Module (Join-Path $root 'vendor/Pester/Pester.psd1')
}

# Discovery reads this list when it builds one test per action. BeforeAll registers again for the run.
Register-CapstanActions
$script:actions = @((Get-FleetCommandsDocument).actions)

Describe 'Fleet action registry' {
    BeforeAll {
        Register-CapstanActions
        $script:root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
        $script:doc = Get-FleetCommandsDocument
        $script:actions = @($script:doc.actions)
        function script:New-SampleArgs($Schema) {
            $props = Get-FleetProp $Schema 'properties'
            $names = @()
            $required = Get-FleetProp $Schema 'required'
            if ($null -ne $required) { $names = @($required) }
            $atLeast = Get-FleetProp $Schema 'atLeastOne'
            if ($null -ne $atLeast) {
                foreach ($name in @($atLeast)) {
                    $seen = $false
                    foreach ($have in $names) { if ($have -eq $name) { $seen = $true } }
                    if (-not $seen) { $names += $name }
                }
            }
            $sample = @{}
            foreach ($name in $names) {
                if ([string]::IsNullOrEmpty([string]$name)) { continue }
                $spec = Get-FleetProp $props ([string]$name)
                $type = [string](Get-FleetProp $spec 'type')
                if ($type -eq 'number' -or $type -eq 'integer') {
                    $min = Get-FleetProp $spec 'minimum'
                    $max = Get-FleetProp $spec 'maximum'
                    $n = 1.0
                    if ($null -ne $min) { $n = [double]$min }
                    if ($null -ne $max -and $n -gt [double]$max) { $n = [double]$max }
                    if ($null -ne $min -and $n -lt [double]$min) { $n = [double]$min }
                    if ($type -eq 'integer') { $sample[[string]$name] = [int][Math]::Round($n) } else { $sample[[string]$name] = $n }
                } elseif ($type -eq 'boolean') {
                    $sample[[string]$name] = $true
                } elseif ($type -eq 'array') {
                    $sample[[string]$name] = @('id_example')
                } elseif ($type -eq 'object') {
                    $sample[[string]$name] = '{}'
                } elseif ($null -ne (Get-FleetProp $spec 'enum')) {
                    $sample[[string]$name] = [string](@(Get-FleetProp $spec 'enum')[0])
                } else {
                    $sample[[string]$name] = 'id_example'
                }
            }
            return $sample
        }
    }

    It 'uses the fleet commands document' {
        $script:doc.schema | Should -Be 'fleet.commands/1'
        $script:doc.app | Should -Be 'capstan'
        $script:actions.Count | Should -BeGreaterThan 100
    }

    It 'gives every action an app.noun.verb id' {
        foreach ($row in $script:actions) {
            $row.id | Should -Match '^capstan\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$'
            ('capstan.' + $row.noun + '.' + $row.verb) | Should -Be $row.id
        }
    }

    It 'lists every action from commands --json and from help --json' {
        $exe = if ($PSVersionTable.PSEdition -eq 'Desktop') { 'powershell.exe' } else { 'pwsh' }
        $cli = Join-Path $script:root 'capstan.ps1'
        $commands = & $exe -NoProfile -NonInteractive -File $cli commands --json
        $help = & $exe -NoProfile -NonInteractive -File $cli help --json
        $LASTEXITCODE | Should -Be 0
        $fromCommands = $commands | ConvertFrom-Json
        $fromHelp = $help | ConvertFrom-Json
        @($fromCommands.actions).Count | Should -Be $script:actions.Count
        @($fromHelp.actions).Count | Should -Be $script:actions.Count
        $listed = @{}
        foreach ($row in @($fromHelp.actions)) { $listed[[string]$row.id] = $true }
        foreach ($row in $script:actions) { $listed.Contains([string]$row.id) | Should -BeTrue }
    }

    It 'rejects an unknown argument for <id>' -ForEach $script:actions {
        $env = Invoke-FleetAction -Id $_.id -Arguments @{ definitelyNotAField = 1 }
        $env.ok | Should -BeFalse
        $env.errorType | Should -Be 'usage'
        (Get-FleetExitCode $env) | Should -Be 2
    }

    It 'asks before a destructive action <id>' -ForEach @($script:actions | Where-Object { $_.destructive }) {
        $sample = New-SampleArgs $_.schema
        $env = Invoke-FleetAction -Id $_.id -Arguments $sample
        $env.ok | Should -BeFalse
        $env.errorType | Should -Be 'needs-confirm'
        (Get-FleetExitCode $env) | Should -Be 2
    }

    It 'dry-runs a page action <id> without changing anything' -ForEach @($script:actions | Where-Object { $_.needs -eq 'page' }) {
        $sample = New-SampleArgs $_.schema
        $env = Invoke-FleetAction -Id $_.id -Arguments $sample -DryRun
        $env.ok | Should -BeTrue
        $env.dryRun | Should -BeTrue
    }

    It 'tells the truth when a page action <id> is run headless' -ForEach @($script:actions | Where-Object { $_.needs -eq 'page' }) {
        $sample = New-SampleArgs $_.schema
        $env = Invoke-FleetAction -Id $_.id -Arguments $sample -Confirmed
        $env.ok | Should -BeFalse
        $env.errorType | Should -Be 'needs-browser'
        (Get-FleetExitCode $env) | Should -Be 1
    }
}

Describe 'Headless actions for the training chain' {
    BeforeAll {
        Register-CapstanActions
        $script:root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
        $script:lesson = Join-Path $script:root 'examples/training-lesson.capstan'
        $script:job = Join-Path $script:root 'examples/training-to-course.job.json'
    }

    It 'reads a project file' {
        $env = Invoke-FleetAction -Id 'capstan.file.show' -Arguments @{ file = $script:lesson }
        $env.ok | Should -BeTrue
        $env.result.name | Should -Be 'Training lesson'
        $env.result.counts.chapters | Should -Be 2
    }

    It 'exports chapters and captions' {
        $chapters = Invoke-FleetAction -Id 'capstan.handoff.chapters' -Arguments @{ file = $script:lesson; format = 'text' }
        $chapters.ok | Should -BeTrue
        $chapters.result.text | Should -Be "0:00 Open`n0:12 Show the capture`n"
        $captions = Invoke-FleetAction -Id 'capstan.handoff.captions' -Arguments @{ file = $script:lesson; format = 'srt' }
        $captions.result.text | Should -Match 'Welcome to the lesson'
    }

    It 'runs the training-to-course job' {
        $env = Invoke-FleetAction -Id 'capstan.job.run' -Arguments @{ file = $script:job }
        $env.ok | Should -BeTrue
        @($env.result.steps).Count | Should -Be 4
    }

    It 'refuses a job that is not JSON' {
        $env = Invoke-FleetAction -Id 'capstan.job.run' -Arguments @{ file = $script:lesson }
        $env.ok | Should -BeFalse
        $env.errorType | Should -Be 'usage'
    }

    It 'does not stop the server on a dry run' {
        $env = Invoke-FleetAction -Id 'capstan.session.end' -DryRun
        $env.ok | Should -BeTrue
        $env.result.would | Should -Match 'stop'
    }
}

Describe 'GUI parity' {
    BeforeAll {
        Register-CapstanActions
        $script:root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }

    It 'maps every data-action to a registered action' {
        $ids = @()
        $files = @(Get-ChildItem -Path (Join-Path $script:root 'src') -Recurse -Include *.tsx,*.html,*.jsx -File)
        $idRx = [regex]'capstan\.[a-z0-9-]+\.[a-z0-9-]+'
        foreach ($f in $files) {
            $text = [IO.File]::ReadAllText($f.FullName)
            $start = 0
            while (($at = $text.IndexOf('data-action', $start)) -ge 0) {
                $slice = $text.Substring($at, [Math]::Min(400, $text.Length - $at))
                foreach ($m in $idRx.Matches($slice)) { $ids += $m.Value }
                $start = $at + 11
            }
        }
        $ids.Count | Should -BeGreaterThan 10
        foreach ($id in $ids) {
            $action = Get-FleetAction -Id $id
            $action | Should -Not -BeNullOrEmpty -Because $id
        }
    }

    It 'writes --out as UTF-8 JSON without a BOM' {
        $exe = if ($PSVersionTable.PSEdition -eq 'Desktop') { 'powershell.exe' } else { 'pwsh' }
        $out = Join-Path ([IO.Path]::GetTempPath()) ('capstan-commands-' + [guid]::NewGuid().ToString('N') + '.json')
        try {
            & $exe -NoProfile -NonInteractive -File (Join-Path $script:root 'capstan.ps1') commands --json --out $out | Out-Null
            $LASTEXITCODE | Should -Be 0
            $bytes = [IO.File]::ReadAllBytes($out)
            $bytes[0] | Should -Not -Be 0xEF
            $text = [IO.File]::ReadAllText($out)
            $doc = $text | ConvertFrom-Json
            $doc.schema | Should -Be 'fleet.commands/1'
        } finally {
            Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
        }
    }
}
