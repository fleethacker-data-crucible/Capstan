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
$script:actions = @(Get-FleetAction -App 'capstan')
$script:hostIds = @()
$hostDoc = [IO.File]::ReadAllText((Join-Path $root 'actions/host-catalog.json')) | ConvertFrom-Json
foreach ($row in @($hostDoc.actions)) {
    if ([string]$row.id -ne 'capstan.job.run') { $script:hostIds += [string]$row.id }
}

Describe 'Fleet action registry' {
    BeforeAll {
        Register-CapstanActions
        $script:root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
        $script:actions = @(Get-FleetAction -App 'capstan')
        function script:New-SampleArgs($Action) {
            $sample = @{}
            foreach ($parameter in @($Action.parameters)) {
                if (-not [bool]$parameter.required) { continue }
                if ([string]$parameter.type -eq 'number') { $sample[[string]$parameter.name] = 1 }
                elseif ([string]$parameter.type -eq 'boolean') { $sample[[string]$parameter.name] = $true }
                else { $sample[[string]$parameter.name] = 'id_example' }
            }
            return $sample
        }
        function script:Get-CapstanExitCode($Envelope) {
            if ($Envelope.ok) { return 0 }
            switch ([string]$Envelope.error.code) {
                'E_ARGS' { return 2 }
                'E_NOT_FOUND' { return 3 }
                'E_CONFIRM' { return 4 }
                'E_AUTH' { return 5 }
                default { return 1 }
            }
        }
    }

    It 'uses the fleet commands document' {
        $script:actions.Count | Should -BeGreaterThan 100
        $script:actions[0].app | Should -Be 'capstan'
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
        $fromCommands.v | Should -Be 1
        @($fromCommands.result.actions).Count | Should -Be $script:actions.Count
        @($fromHelp.result.actions).Count | Should -Be $script:actions.Count
        $listed = @{}
        foreach ($row in @($fromHelp.result.actions)) { $listed[[string]$row.id] = $true }
        foreach ($row in $script:actions) { $listed.Contains([string]$row.id) | Should -BeTrue }
    }

    It 'rejects an unknown argument for <id>' -ForEach $script:actions {
        $env = Invoke-FleetAction -App 'capstan' -Noun $_.noun -Verb $_.verb -Arguments @{ definitelyNotAField = 1 }
        $env.ok | Should -BeFalse
        $env.error.code | Should -Be 'E_ARGS'
        (Get-CapstanExitCode $env) | Should -Be 2
    }

    It 'asks before a destructive action <id>' -ForEach @($script:actions | Where-Object { $_.destructive }) {
        $sample = New-SampleArgs $_
        $env = Invoke-FleetAction -App 'capstan' -Noun $_.noun -Verb $_.verb -Arguments $sample
        $env.ok | Should -BeFalse
        $env.error.code | Should -Be 'E_CONFIRM'
        (Get-CapstanExitCode $env) | Should -Be 4
    }

    It 'dry-runs <id> without calling the handler' -ForEach $script:actions {
        $sample = New-SampleArgs $_
        $env = Invoke-FleetAction -App 'capstan' -Noun $_.noun -Verb $_.verb -Arguments $sample -DryRun
        $env.ok | Should -BeTrue
        $env.result.dryRun | Should -BeTrue
        $env.result.actionId | Should -Be $_.id
    }

    It 'tells the truth when a page action <id> is run headless' -ForEach @($script:actions | Where-Object { $script:hostIds -notcontains $_.id }) {
        $sample = New-SampleArgs $_
        $env = Invoke-FleetAction -App 'capstan' -Noun $_.noun -Verb $_.verb -Arguments $sample -Confirmed
        $env.ok | Should -BeFalse
        $env.error.code | Should -Be 'E_ARGS'
        $env.error.message | Should -Match 'Capstan page'
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
        $env = Invoke-FleetAction -App 'capstan' -Noun 'file' -Verb 'show' -Arguments @{ path = $script:lesson }
        $env.ok | Should -BeTrue
        $env.result.name | Should -Be 'Training lesson'
        $env.result.counts.chapters | Should -Be 2
    }

    It 'exports chapters and captions' {
        $chapters = Invoke-FleetAction -App 'capstan' -Noun 'handoff' -Verb 'chapters' -Arguments @{ path = $script:lesson; format = 'text' }
        $chapters.ok | Should -BeTrue
        $chapters.result.text | Should -Be "0:00 Open`n0:12 Show the capture`n"
        $captions = Invoke-FleetAction -App 'capstan' -Noun 'handoff' -Verb 'captions' -Arguments @{ path = $script:lesson; format = 'srt' }
        $captions.result.text | Should -Match 'Welcome to the lesson'
    }

    It 'runs the training-to-course job' {
        $env = Invoke-FleetJob -Path $script:job
        $env.ok | Should -BeTrue
        @($env.result.steps).Count | Should -Be 4
    }

    It 'refuses a job that is not a version 1 job' {
        $env = Invoke-FleetJob -Path $script:lesson
        $env.ok | Should -BeFalse
        $env.error.code | Should -Be 'E_ARGS'
    }

    It 'does not stop the server on a dry run' {
        $env = Invoke-FleetAction -App 'capstan' -Noun 'session' -Verb 'end' -DryRun
        $env.ok | Should -BeTrue
        $env.result.dryRun | Should -BeTrue
        $env.result.confirmationRequired | Should -BeTrue
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
            $found = $false
            foreach ($action in @(Get-FleetAction -App 'capstan')) {
                if ([string]$action.id -eq $id) { $found = $true }
            }
            $found | Should -BeTrue -Because $id
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
            $doc.v | Should -Be 1
            $doc.result.app | Should -Be 'capstan'
        } finally {
            Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
        }
    }
}
