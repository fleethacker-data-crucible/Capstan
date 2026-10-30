<#
  Capstan process lifecycle (see TechStack.md, "Lifecycle rules"). Dot-sourced by Start-Capstan.ps1,
  Stop-Capstan.ps1 and tests/ps/Lifecycle.Tests.ps1.

  - Capstan.Lifecycle.Presence: the "tab owns the server" rule. Each open Capstan page sends a
    heartbeat every 5 s and a leaving beacon on pagehide; the host stops once no page is alive.
  - Runtime files logs\capstan-server-<pid>.json (pid, port, url, startedAt; never the session
    token) so Stop-Capstan.ps1 and the launcher can find running hosts without knowing PIDs.
#>
if (-not ('Capstan.Lifecycle.Presence' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;

namespace Capstan.Lifecycle {
    // Times are passed in (UTC) so tests can simulate them instead of sleeping.
    public sealed class Presence {
        sealed class Tab { public DateTime LastBeat; public DateTime? LeavingAt; public bool Patient; }
        readonly object gate = new object();
        readonly Dictionary<string, Tab> tabs = new Dictionary<string, Tab>(StringComparer.Ordinal);
        int jobs = 0;
        bool seen = false;
        public readonly bool Enabled;
        // No heartbeat from a visible page for this long: the page is gone.
        public TimeSpan HeartbeatTimeout = TimeSpan.FromSeconds(20);
        // After a leaving beacon with no new heartbeat: gone. A reload's new page beats well inside it.
        public TimeSpan LeavingGrace = TimeSpan.FromSeconds(5);
        // A hidden (minimised) page, or one exporting or recording: Edge/Chrome throttle hidden timers to
        // about once a minute, and a long render can delay a beat, so it gets longer before it counts
        // as gone. Closing it still sends the leaving beacon, which is honoured after LeavingGrace.
        public TimeSpan PatientTimeout = TimeSpan.FromSeconds(90);

        public Presence(bool enabled) { Enabled = enabled; }

        static string Key(string tab) {
            if (String.IsNullOrEmpty(tab)) return "default";
            return tab.Length > 64 ? tab.Substring(0, 64) : tab;
        }

        // busy: the page is exporting or recording (that work runs in the browser, so the page's
        // heartbeat is what keeps the host alive while it runs).
        public void Beat(string tab, bool hidden, bool busy, DateTime now) {
            lock (gate) {
                Tab t;
                if (!tabs.TryGetValue(Key(tab), out t)) { t = new Tab(); tabs[Key(tab)] = t; }
                t.LastBeat = now; t.LeavingAt = null; t.Patient = hidden || busy;
                seen = true;
                Prune(now);
            }
        }

        public void Leaving(string tab, DateTime now) {
            lock (gate) {
                Tab t;
                if (!tabs.TryGetValue(Key(tab), out t)) { t = new Tab(); t.LastBeat = now; tabs[Key(tab)] = t; }
                t.LeavingAt = now;
                seen = true;
            }
        }

        // Host-side background writes (none in v0.1; the v0.2 on-disk media library will use these).
        // Request handlers run on the server loop thread, so a write inside a request is never cut off.
        public void BeginJob() { lock (gate) { jobs++; } }
        public void EndJob() { lock (gate) { if (jobs > 0) jobs--; } }
        public int JobsRunning { get { lock (gate) { return jobs; } } }

        bool Gone(Tab t, DateTime now) {
            if (t.LeavingAt.HasValue && now - t.LeavingAt.Value >= LeavingGrace) return true;
            return now - t.LastBeat >= (t.Patient ? PatientTimeout : HeartbeatTimeout);
        }

        void Prune(DateTime now) {
            List<string> dead = new List<string>();
            foreach (KeyValuePair<string, Tab> kv in tabs) if (Gone(kv.Value, now)) dead.Add(kv.Key);
            foreach (string k in dead) tabs.Remove(k);
        }

        public int LiveTabs(DateTime now) {
            lock (gate) { Prune(now); return tabs.Count; }
        }

        // True when the host should stop itself now: auto-stop is on, a page connected at some point,
        // none is alive any more, and no host-side job is running.
        public bool ShouldStop(DateTime now) {
            lock (gate) {
                if (!Enabled || !seen || jobs > 0) return false;
                Prune(now);
                return tabs.Count == 0;
            }
        }
    }
}
'@
}

function Test-CapstanAutoStop {
    # CAPSTAN_AUTO_STOP=0 (or false/no/off) keeps the host running after its window closes.
    $v = $env:CAPSTAN_AUTO_STOP
    if ($null -eq $v) { return $true }
    return -not ($v.Trim() -match '^(0|false|no|off)$')
}

function Get-CapstanLogDirectory {
    param([Parameter(Mandatory = $true)][string]$Root)
    return (Join-Path $Root 'logs')
}

function Write-CapstanRuntimeFile {
    <# Writes logs\capstan-server-<pid>.json and returns its path. Never includes the session token. #>
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][int]$Port, [Parameter(Mandatory = $true)][string]$Url)
    $logs = Get-CapstanLogDirectory -Root $Root
    if (-not (Test-Path -LiteralPath $logs)) { [void](New-Item -ItemType Directory -Path $logs -Force) }
    $file = Join-Path $logs ('capstan-server-' + $PID + '.json')
    $info = [ordered]@{ pid = $PID; port = $Port; url = $Url; startedAt = (Get-Date).ToUniversalTime().ToString('o') }
    [IO.File]::WriteAllText($file, (ConvertTo-Json -InputObject $info -Compress))
    return $file
}

function Remove-CapstanRuntimeFile {
    param([string]$Path)
    if ($Path) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
}

function Test-CapstanProcessCommandLine {
    param([string]$CommandLine, [string]$Root)
    if (-not $CommandLine) { return $false }
    if ($CommandLine -match '-EncodedCommand\s+(\S+)') {
        try { $CommandLine += ' ' + [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1])) } catch { }
    }
    $scriptPath = [IO.Path]::GetFullPath((Join-Path $Root 'Start-Capstan.ps1')).Replace('/', '\')
    $normalized = $CommandLine.Replace('/', '\')
    return [regex]::IsMatch($normalized, '(?:^|[\s''"])' + [regex]::Escape($scriptPath) + '(?:$|[\s''"])', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function Get-CapstanProcesses {
    <#
    .SYNOPSIS
      Running Capstan hosts (Pid, Port, Url, Started, RuntimeFile): from the runtime files under logs\,
      then any PowerShell whose command line runs Start-Capstan.ps1. Stale runtime files are removed.
      The calling process is never included.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Root)
    $found = @{}
    $logs = Get-CapstanLogDirectory -Root $Root
    if (Test-Path -LiteralPath $logs) {
        foreach ($f in @(Get-ChildItem -LiteralPath $logs -Filter 'capstan-server-*.json' -ErrorAction SilentlyContinue)) {
            $keep = $false
            try {
                $info = [IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json
                $id = [int]$info.pid
                $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
                if ($id -eq $PID) { $keep = $true }
                elseif ($proc -and $proc.ProcessName -match '^(powershell|pwsh)$') {
                    $keep = $true
                    $identity = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
                    if ($identity -and (Test-CapstanProcessCommandLine -CommandLine $identity.CommandLine -Root $Root)) {
                        $found[$id] = [pscustomobject]@{ Pid = $id; Port = $info.port; Url = $info.url; Started = $info.startedAt; RuntimeFile = $f.FullName }
                    }
                }
            } catch { $keep = $false }
            if (-not $keep) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue }
        }
    }
    # A host whose runtime file is missing (deleted logs\, or a build from before runtime files).
    try {
        Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop |
            Where-Object { $_.ProcessId -ne $PID -and (Test-CapstanProcessCommandLine -CommandLine $_.CommandLine -Root $Root) } |
            ForEach-Object {
                $id = [int]$_.ProcessId
                if (-not $found.ContainsKey($id)) {
                    $found[$id] = [pscustomobject]@{ Pid = $id; Port = $null; Url = $null; Started = $_.CreationDate; RuntimeFile = $null }
                }
            }
    } catch { }
    return @($found.Values | Sort-Object Pid)
}

function Stop-CapstanProcesses {
    <#
    .SYNOPSIS
      Stops every running Capstan host and returns what was stopped (the Get-CapstanProcesses
      objects). A host started from an elevated window is reported, not thrown.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Root)
    $stopped = @()
    foreach ($p in @(Get-CapstanProcesses -Root $Root)) {
        try {
            Stop-Process -Id $p.Pid -Force -ErrorAction Stop
            # A killed host cannot run its own cleanup.
            Remove-CapstanRuntimeFile -Path $p.RuntimeFile
            $stopped += $p
        } catch {
            if (-not (Get-Process -Id $p.Pid -ErrorAction SilentlyContinue)) {
                Remove-CapstanRuntimeFile -Path $p.RuntimeFile
                $stopped += $p
            } else {
                Write-Warning ('Could not stop Capstan PID ' + $p.Pid + ': ' + $_.Exception.Message + ' Close its console window, or stop it from the window it was started in.')
            }
        }
    }
    # Let Windows release the port before a new host binds it.
    if ($stopped.Count -gt 0) { Start-Sleep -Milliseconds 500 }
    return $stopped
}

function Format-CapstanProcess {
    param($Process)
    if ($Process.Url) { return ($Process.Url + ' (PID ' + $Process.Pid + ')') }
    return ('PID ' + $Process.Pid)
}
