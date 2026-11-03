# Reusable FleetAction conformance suite.
# Point FLEET_MANIFEST, FLEET_CLI, and FLEET_MODULE at the app under test.
# FLEET_GUI is optional. When it is unset, a gui directory beside the CLI is used.

BeforeAll {
    Set-StrictMode -Version 3.0
    $pester = Get-Module Pester
    if ($null -eq $pester -or $pester.Version.Major -ne 5) {
        throw 'Pester 5 is required.'
    }

    $script:SuiteRoot = Split-Path -Parent $PSScriptRoot
    if ([string]::IsNullOrEmpty($env:FLEET_MODULE)) {
        $zipModule = Join-Path $script:SuiteRoot 'FleetAction.psd1'
        $repoModule = Join-Path $script:SuiteRoot (Join-Path 'src' (Join-Path 'FleetAction' 'FleetAction.psd1'))
        if (Test-Path -LiteralPath $repoModule) {
            $env:FLEET_MODULE = $repoModule
        }
        elseif (Test-Path -LiteralPath $zipModule) {
            $env:FLEET_MODULE = $zipModule
        }
    }
    if ([string]::IsNullOrEmpty($env:FLEET_MANIFEST)) {
        $env:FLEET_MANIFEST = Join-Path $script:SuiteRoot (Join-Path 'examples' 'example-manifest.json')
    }
    if ([string]::IsNullOrEmpty($env:FLEET_CLI)) {
        $env:FLEET_CLI = Join-Path $script:SuiteRoot (Join-Path 'examples' (Join-Path 'widget-app' 'widget.ps1'))
    }
    if ([string]::IsNullOrEmpty($env:FLEET_GUI)) {
        $beside = Join-Path (Split-Path -Parent $env:FLEET_CLI) 'gui'
        if (Test-Path -LiteralPath $beside) {
            $env:FLEET_GUI = $beside
        }
    }
    if (-not (Test-Path -LiteralPath $env:FLEET_MODULE)) { throw 'FLEET_MODULE was not found.' }
    if (-not (Test-Path -LiteralPath $env:FLEET_MANIFEST)) { throw 'FLEET_MANIFEST was not found.' }
    if (-not (Test-Path -LiteralPath $env:FLEET_CLI)) { throw 'FLEET_CLI was not found.' }
    Import-Module $env:FLEET_MODULE -Force
    $script:Manifest = Get-Content -Raw -LiteralPath $env:FLEET_MANIFEST | ConvertFrom-Json
    $script:Exe = (Get-Process -Id $PID).Path

    function Invoke-ConformanceCli {
    param([string[]]$Arguments)
    $output = & $script:Exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $env:FLEET_CLI @Arguments
    return @{
        ExitCode = $LASTEXITCODE
        Text     = (@($output) -join "`n")
    }
}

function Send-ConformanceRaw {
    param([int]$Port, [string]$RequestText)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.ReceiveTimeout = 5000
        $client.SendTimeout = 5000
        try {
            $client.Connect('127.0.0.1', $Port)
        }
        catch {
            return ''
        }
        $stream = $client.GetStream()
        $stream.ReadTimeout = 5000
        $stream.WriteTimeout = 5000
        $bytes = [System.Text.Encoding]::ASCII.GetBytes($RequestText)
        $stream.Write($bytes, 0, $bytes.Length)
        try { $client.Client.Shutdown([System.Net.Sockets.SocketShutdown]::Send) } catch { }
        $memory = New-Object System.IO.MemoryStream
        $buffer = New-Object byte[] 2048
        try {
            while ($true) {
                $count = $stream.Read($buffer, 0, $buffer.Length)
                if ($count -le 0) { break }
                $memory.Write($buffer, 0, $count)
            }
        }
        catch { }
        return [System.Text.Encoding]::UTF8.GetString($memory.ToArray())
    }
    finally {
        $client.Close()
    }
    }
}

Describe 'FleetAction conformance' {
    It 'validates the manifest and stable action ids' {
        $checked = Test-FleetDocument -Document $script:Manifest -SchemaName 'action-manifest.schema.json'
        $checked.Valid | Should -BeTrue
        foreach ($action in @($script:Manifest.actions)) {
            $action.id | Should -Be ($action.app + '.' + $action.noun + '.' + $action.verb)
            $action.app | Should -Be $script:Manifest.app
        }
    }

    It 'discovers the same actions from commands --json and help --json' {
        $commands = Invoke-ConformanceCli -Arguments @('commands', '--json')
        $help = Invoke-ConformanceCli -Arguments @('help', '--json')
        $commands.ExitCode | Should -Be 0
        $help.ExitCode | Should -Be 0
        $left = $commands.Text | ConvertFrom-Json
        $right = $help.Text | ConvertFrom-Json
        $left.v | Should -Be 1
        $left.ok | Should -BeTrue
        $discovered = @($left.result.actions)
        $expected = @($script:Manifest.actions)
        $discovered.Count | Should -Be $expected.Count
        foreach ($action in $expected) {
            $match = $null
            foreach ($item in $discovered) {
                if ($item.id -eq $action.id) { $match = $item }
            }
            $null -eq $match | Should -BeFalse
            $match.destructive | Should -Be $action.destructive
            @($match.parameters).Count | Should -Be @($action.parameters).Count
        }
        (@($right.result.actions) | ConvertTo-Json -Depth 30 -Compress) | Should -Be (@($left.result.actions) | ConvertTo-Json -Depth 30 -Compress)
    }

    It 'keeps the CLI entry on Windows PowerShell 5.1 syntax' {
        $text = [System.IO.File]::ReadAllText($env:FLEET_CLI)
        $text | Should -Match '#requires -Version 5\.1'
        $text | Should -Not -Match '#requires -Version 7'
        $tokens = $null
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($env:FLEET_CLI, [ref]$tokens, [ref]$errors)
        @($errors).Count | Should -Be 0
        foreach ($banned in @('ContainsKey', 'Invoke-Expression', 'ExpandString', '-AsHashtable', '-Parallel', '??', '?.')) {
            $text.IndexOf($banned) | Should -Be -1
        }
        [regex]::IsMatch($text, '-Confirm(?!ed)') | Should -BeFalse
        $moduleText = [System.IO.File]::ReadAllText((Join-Path (Split-Path -Parent $env:FLEET_MODULE) 'FleetAction.psm1'))
        $moduleText.IndexOf('ContainsKey') | Should -Be -1
        foreach ($line in ($moduleText -split "`n")) {
            if ($line.IndexOf('ConvertTo-Json') -ge 0) {
                $line | Should -Match '-Depth'
            }
        }
    }

    It 'dry-runs the first safe action and blocks a destructive action without --yes' {
        $target = $null
        $destructive = $null
        foreach ($action in @($script:Manifest.actions)) {
            if ((-not $action.destructive) -and $null -eq $target) { $target = $action }
            if ($action.destructive -and $null -eq $destructive) { $destructive = $action }
        }
        $null -eq $target | Should -BeFalse
        $cliArgs = @($target.noun, $target.verb, '--dry-run', '--json')
        foreach ($parameter in @($target.parameters)) {
            if ($parameter.required) {
                $sample = 'item-1'
                if ($parameter.type -eq 'number') { $sample = '1' }
                if ($parameter.type -eq 'boolean') { $sample = 'false' }
                $cliArgs += ('--' + $parameter.name)
                $cliArgs += $sample
            }
        }
        $dry = Invoke-ConformanceCli -Arguments $cliArgs
        $dry.ExitCode | Should -Be 0
        $body = $dry.Text | ConvertFrom-Json
        $body.ok | Should -BeTrue
        $body.result.dryRun | Should -BeTrue
        $body.result.actionId | Should -Be $target.id
        if ($null -ne $destructive) {
            $blockedArgs = @($destructive.noun, $destructive.verb, '--json')
            foreach ($parameter in @($destructive.parameters)) {
                if ($parameter.required) {
                    $sample = 'item-1'
                    if ($parameter.type -eq 'number') { $sample = '1' }
                    if ($parameter.type -eq 'boolean') { $sample = 'false' }
                    $blockedArgs += ('--' + $parameter.name)
                    $blockedArgs += $sample
                }
            }
            $blocked = Invoke-ConformanceCli -Arguments $blockedArgs
            $blocked.ExitCode | Should -Be 4
            ($blocked.Text | ConvertFrom-Json).error.code | Should -Be 'E_CONFIRM'
        }
    }

    It 'reports partial failure without running later steps' {
        $action = @($script:Manifest.actions)[0]
        $args = New-Object System.Management.Automation.PSObject
        foreach ($parameter in @($action.parameters)) {
            if ($parameter.required) {
                $sample = 'item-1'
                if ($parameter.type -eq 'number') { $sample = 1 }
                if ($parameter.type -eq 'boolean') { $sample = $false }
                $args | Add-Member -MemberType NoteProperty -Name $parameter.name -Value $sample
            }
        }
        $job = New-Object System.Management.Automation.PSObject
        $job | Add-Member -MemberType NoteProperty -Name 'version' -Value 1
        $first = New-Object System.Management.Automation.PSObject
        $first | Add-Member -MemberType NoteProperty -Name 'id' -Value 'first'
        $first | Add-Member -MemberType NoteProperty -Name 'app' -Value $action.app
        $first | Add-Member -MemberType NoteProperty -Name 'noun' -Value $action.noun
        $first | Add-Member -MemberType NoteProperty -Name 'verb' -Value $action.verb
        $first | Add-Member -MemberType NoteProperty -Name 'args' -Value $args
        $second = New-Object System.Management.Automation.PSObject
        $second | Add-Member -MemberType NoteProperty -Name 'id' -Value 'missing'
        $second | Add-Member -MemberType NoteProperty -Name 'app' -Value $action.app
        $second | Add-Member -MemberType NoteProperty -Name 'noun' -Value 'missing'
        $second | Add-Member -MemberType NoteProperty -Name 'verb' -Value 'missing'
        $steps = New-Object System.Collections.Generic.List[object]
        $steps.Add($first)
        $steps.Add($second)
        $job | Add-Member -MemberType NoteProperty -Name 'steps' -Value ($steps.ToArray())
        $path = Join-Path ([System.IO.Path]::GetTempPath()) ('fleet-job-' + [guid]::NewGuid().ToString() + '.json')
        $utf8 = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($path, (ConvertTo-Json -InputObject $job -Depth 30), $utf8)
        try {
            $ran = Invoke-ConformanceCli -Arguments @('job', 'run', '--file', $path, '--dry-run', '--json')
            $ran.ExitCode | Should -Be 3
            $body = $ran.Text | ConvertFrom-Json
            $body.ok | Should -BeFalse
            $body.error.code | Should -Be 'E_NOT_FOUND'
            $body.error.stepId | Should -Be 'missing'
            @($body.error.completed).Count | Should -Be 1
        }
        finally {
            Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        }
    }

    It 'checks GUI parity when a gui directory is present' {
        if ([string]::IsNullOrEmpty($env:FLEET_GUI)) {
            Set-ItResult -Skipped -Because 'This CLI has no gui directory'
            return
        }
        $parity = Test-FleetGuiParity -Path $env:FLEET_GUI
        @($parity.Gaps).Count | Should -Be 0
    }

    It 'serves /__fleethacker/id, enforces host order, and deletes the session token' {
        $app = [string]$script:Manifest.app
        InModuleScope FleetAction -Parameters @{ AppName = $app } {
            param($AppName)
            $token = '0123456789abcdef0123456789abcdef'
            $port = 8765
            $id = Invoke-FleetHttpPipeline -App $AppName -Port $port -Token $token -Method 'GET' -Path '/__fleethacker/id' -Headers @{ Host = '127.0.0.1:8765' }
            $id.StatusCode | Should -Be 200
            $id.Body | Should -Match $AppName
            $id.Body | Should -Not -Match $token
            $evil = Invoke-FleetHttpPipeline -App $AppName -Port $port -Token $token -Method 'GET' -Path '/__fleethacker/id' -Headers @{ Host = '127.0.0.1.evil.com' }
            $evil.StatusCode | Should -Be 401
            $evil.Body | Should -Match 'Host is not allowed'
            $reads = 0
            $open = { param($MaxBytes) $script:ConformanceReads = $script:ConformanceReads + 1; return '{}' }
            $script:ConformanceReads = 0
            $headers = @{
                Host          = '127.0.0.1:8765'
                Origin        = 'http://127.0.0.1:8765'
                Authorization = ('Bearer ' + $token)
            }
            $capped = Invoke-FleetHttpPipeline -App $AppName -Port $port -Token $token -Method 'POST' -Path '/api/v1/job' -Headers $headers -ContentLength 1048577 -OpenBody $open
            $capped.StatusCode | Should -Be 400
            $capped.Body | Should -Match '1 MB'
            $script:ConformanceReads | Should -Be 0
        }
        $old = $env:LOCALAPPDATA
        $env:LOCALAPPDATA = Join-Path ([System.IO.Path]::GetTempPath()) ('fleet-conf-' + [guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $env:LOCALAPPDATA -Force | Out-Null
        $tcp = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
        $tcp.Start()
        $port = ([System.Net.IPEndPoint]$tcp.LocalEndpoint).Port
        $tcp.Stop()
        $job = Start-Job -ScriptBlock {
            param($ModulePath, $Port, $App)
            Set-StrictMode -Version 3.0
            $ErrorActionPreference = 'Stop'
            Import-Module $ModulePath -Force
            Start-FleetServer -App $App -Port $Port
        } -ArgumentList $env:FLEET_MODULE, $port, $app
        try {
            $token = $null
            $deadline = [DateTime]::UtcNow.AddSeconds(20)
            while ([DateTime]::UtcNow -lt $deadline -and [string]::IsNullOrEmpty($token)) {
                try { $token = Read-FleetSessionToken -App $app } catch { Start-Sleep -Milliseconds 100 }
            }
            [string]::IsNullOrEmpty($token) | Should -BeFalse
        }
        finally {
            try { Stop-FleetServer -App $app -TimeoutSeconds 10 } catch { }
            Stop-Job $job -ErrorAction SilentlyContinue
            Remove-Job $job -Force -ErrorAction SilentlyContinue
            $tokenPath = Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'FleetHacker') $app) 'session.token'
            Test-Path -LiteralPath $tokenPath | Should -BeFalse
            if (-not [string]::IsNullOrEmpty($old)) { $env:LOCALAPPDATA = $old }
        }
    }
}
