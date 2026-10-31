<#
  Capstan speech-to-text (issue #24). Windows PowerShell 5.1, .NET Framework 4.x, no installs, no network.
  The recogniser is System.Speech.Recognition.SpeechRecognitionEngine with a dictation grammar, reading
  a WAV file (WinRT SpeechRecognizer cannot read a file). It runs offline with the desktop recogniser of
  the installed Windows speech language. Quality depends on that language pack; this will not match a
  cloud service on noisy audio or on languages that have no Windows pack.

  Routes (called from Start-Capstan.ps1 after the session token check):
    GET    /api/speech/status                        engine, installed recogniser cultures
    POST   /api/speech/transcribe?culture=en-US      mono 16 kHz 16-bit PCM WAV body, at most 30 MB -> { job }
    GET    /api/speech/<job>                         state, progress, and the segments once done
    DELETE /api/speech/<job>                         cancel a running job, or forget a finished one

  Recognition runs on a worker thread (Capstan.Speech.Job), so the host loop is never blocked for long.
  The request WAV is written under %LOCALAPPDATA%\Capstan\tmp with a random name derived from the job id
  (never from the request) and deleted when the job ends. One job at a time.

  Test seam, OFF unless the environment says so: CAPSTAN_SPEECH_ENGINE=fake selects a deterministic
  fake recogniser (and /api/speech/status then says "fake"). CAPSTAN_SPEECH_FAKE_CULTURES (comma list,
  "none" for none) and CAPSTAN_SPEECH_FAKE_DELAY_MS only matter with the fake engine.
#>

$script:SpeechMaxBytes = 30000000
$script:SpeechJobs = @{}
$script:SpeechSwept = $false
$script:SpeechTypeError = $null

function Initialize-CapstanSpeech {
    # Compiles the C# on first use, so a host that never transcribes pays nothing. Returns $false (and
    # keeps the reason) when System.Speech is missing.
    if ('Capstan.Speech.Job' -as [type]) { return $true }
    if ($script:SpeechTypeError) { return $false }
    try {
        Add-Type -AssemblyName System.Speech
        $speechAssembly = [System.Speech.Recognition.SpeechRecognitionEngine].Assembly.Location
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Speech.Recognition;
using System.Text;
using System.Threading;

namespace Capstan.Speech {
    public sealed class Segment {
        public double Start;
        public double End;
        public string Text;
        public double Confidence;
    }

    public sealed class JobFailure : Exception {
        public readonly string Code;
        public JobFailure(string code, string message) : base(message) { Code = code; }
    }

    public static class Wav {
        static string Tag(BinaryReader r) { return Encoding.ASCII.GetString(r.ReadBytes(4)); }

        // Returns null when the stream is a mono 16 kHz 16-bit PCM WAV with audio in it, otherwise a
        // message for the user. seconds is the length of the audio.
        public static string Check(Stream s, out double seconds) {
            seconds = 0;
            const string Wrong = "Send a mono 16 kHz 16-bit PCM WAV file.";
            if (s.Length < 44) return Wrong;
            s.Position = 0;
            BinaryReader r = new BinaryReader(s);
            if (Tag(r) != "RIFF") return Wrong;
            r.ReadUInt32();
            if (Tag(r) != "WAVE") return Wrong;
            bool format = false;
            while (s.Position + 8 <= s.Length) {
                string id = Tag(r);
                uint size = r.ReadUInt32();
                long body = s.Position;
                if (id == "fmt ") {
                    if (size < 16 || body + size > s.Length) return Wrong;
                    ushort kind = r.ReadUInt16();
                    ushort channels = r.ReadUInt16();
                    uint rate = r.ReadUInt32();
                    r.ReadUInt32();
                    r.ReadUInt16();
                    ushort bits = r.ReadUInt16();
                    if (kind != 1 || channels != 1 || rate != 16000 || bits != 16) return Wrong;
                    format = true;
                } else if (id == "data") {
                    if (!format) return Wrong;
                    if (size < 3200) return "The WAV file holds less than 0.1 seconds of audio.";
                    if (body + size > s.Length) return "The WAV file is cut short.";
                    seconds = size / 32000.0;
                    return null;
                }
                long next = body + size + (size & 1);
                if (next > s.Length) return Wrong;
                s.Position = next;
            }
            return Wrong;
        }
    }

    public abstract class Recogniser {
        public abstract void Run(Job job);
    }

    public sealed class Job {
        readonly object gate = new object();
        readonly Recogniser engine;
        readonly List<Segment> segments = new List<Segment>();
        Thread thread;
        string state = "running";
        string code = "";
        string message = "";
        double progress;
        volatile bool cancel;
        DateTime finished = DateTime.MaxValue;
        public readonly string Id;
        public readonly string EngineName;
        public readonly string Culture;
        public readonly string WavPath;
        public readonly double Seconds;

        public Job(string id, string engineName, Recogniser recogniser, string culture, string wavPath, double seconds) {
            Id = id; EngineName = engineName; engine = recogniser; Culture = culture; WavPath = wavPath; Seconds = seconds;
        }

        public bool CancelRequested { get { return cancel; } }
        public string State { get { lock (gate) { return state; } } }
        public string Code { get { lock (gate) { return code; } } }
        public string Message { get { lock (gate) { return message; } } }
        public double Progress { get { lock (gate) { return progress; } } }
        public DateTime Finished { get { lock (gate) { return finished; } } }
        public bool Alive { get { return thread != null && thread.IsAlive; } }

        public Segment[] Segments() { lock (gate) { return segments.ToArray(); } }

        public void SetProgress(double fraction) {
            lock (gate) { if (state == "running") progress = Math.Max(progress, Math.Min(0.99, Math.Max(0, fraction))); }
        }

        public void Add(Segment segment) {
            lock (gate) { if (segments.Count < 20000) segments.Add(segment); }
        }

        public void Start() {
            thread = new Thread(Work);
            thread.IsBackground = true;
            thread.Start();
        }

        // The job reads as cancelled at once; the worker stops at its next look and cleans up.
        public void Cancel() {
            cancel = true;
            lock (gate) {
                if (state == "running") { state = "cancelled"; code = "cancelled"; message = "Transcription was cancelled."; finished = DateTime.UtcNow; }
            }
        }

        public bool Join(int milliseconds) { return thread == null || thread.Join(milliseconds); }

        void Work() {
            string failCode = "";
            string failMessage = "";
            try {
                engine.Run(this);
            } catch (JobFailure f) {
                failCode = f.Code; failMessage = f.Message;
            } catch (Exception) {
                // The exception text can carry paths; the user gets a fixed message.
                failCode = "recogniser-failed"; failMessage = "The Windows speech recogniser failed on this audio.";
            }
            // The audio is gone before the job reads as finished.
            try { if (File.Exists(WavPath)) File.Delete(WavPath); } catch (Exception) { }
            lock (gate) {
                if (state != "running") return;
                finished = DateTime.UtcNow;
                if (cancel) { state = "cancelled"; code = "cancelled"; message = "Transcription was cancelled."; }
                else if (failCode.Length > 0) { state = "error"; code = failCode; message = failMessage; }
                else { state = "done"; progress = 1; }
            }
        }
    }

    // Test seam: deterministic segments, no audio is read. Only built when CAPSTAN_SPEECH_ENGINE=fake.
    public sealed class FakeRecogniser : Recogniser {
        readonly int delayMs;
        public FakeRecogniser(int delay) { delayMs = Math.Max(0, Math.Min(60000, delay)); }

        public override void Run(Job job) {
            int steps = delayMs / 50;
            for (int i = 0; i < steps; i++) {
                if (job.CancelRequested) return;
                Thread.Sleep(50);
                job.SetProgress((i + 1.0) / (steps + 1.0));
            }
            string[] words = new string[] { "This is the first fake caption.", "This is the second fake caption.", "This is the third fake caption." };
            int count = job.Seconds >= 0.6 ? 3 : 1;
            double part = job.Seconds / count;
            for (int i = 0; i < count; i++) {
                Segment s = new Segment();
                s.Start = Math.Round(i * part, 2);
                s.End = Math.Round((i + 1) * part - (count > 1 ? 0.1 : 0.0), 2);
                s.Text = words[i];
                s.Confidence = 0.9;
                job.Add(s);
            }
        }
    }

    public sealed class WindowsRecogniser : Recogniser {
        static bool Usable(RecognizerInfo info) {
            return info.Id.IndexOf("Kinect", StringComparison.OrdinalIgnoreCase) < 0;
        }

        public static string[] Cultures() {
            List<string> names = new List<string>();
            foreach (RecognizerInfo info in SpeechRecognitionEngine.InstalledRecognizers()) {
                if (Usable(info) && !names.Contains(info.Culture.Name)) names.Add(info.Culture.Name);
            }
            return names.ToArray();
        }

        static RecognizerInfo Find(string culture) {
            RecognizerInfo sameLanguage = null;
            string language = culture.Split('-')[0];
            foreach (RecognizerInfo info in SpeechRecognitionEngine.InstalledRecognizers()) {
                if (!Usable(info)) continue;
                if (string.Equals(info.Culture.Name, culture, StringComparison.OrdinalIgnoreCase)) return info;
                if (sameLanguage == null && string.Equals(info.Culture.TwoLetterISOLanguageName, language, StringComparison.OrdinalIgnoreCase)) sameLanguage = info;
            }
            return sameLanguage;
        }

        // The installed culture that serves `culture` (exact, else the same language), or null.
        public static string Resolve(string culture) {
            RecognizerInfo info = Find(culture);
            return info == null ? null : info.Culture.Name;
        }

        public override void Run(Job job) {
            RecognizerInfo info = Find(job.Culture);
            if (info == null) throw new JobFailure("no-recogniser", "No Windows speech recogniser is installed for this language.");
            using (SpeechRecognitionEngine engine = new SpeechRecognitionEngine(info)) {
                new Session(job, engine).Go();
            }
        }

        sealed class Session {
            readonly Job job;
            readonly SpeechRecognitionEngine engine;
            readonly ManualResetEvent done = new ManualResetEvent(false);
            double lastEnd;
            bool failed;

            public Session(Job j, SpeechRecognitionEngine e) { job = j; engine = e; }

            void OnRecognized(object sender, SpeechRecognizedEventArgs e) {
                string text = e.Result.Text == null ? "" : e.Result.Text.Trim();
                if (text.Length == 0) return;
                double start = lastEnd;
                double length = 0;
                if (e.Result.Audio != null) {
                    start = e.Result.Audio.AudioPosition.TotalSeconds;
                    length = e.Result.Audio.Duration.TotalSeconds;
                }
                double end = start + length;
                if (length <= 0) end = Math.Max(start + 0.2, SafePosition());
                start = Math.Max(0, Math.Min(job.Seconds, start));
                end = Math.Max(start, Math.Min(job.Seconds, end));
                lastEnd = end;
                Segment s = new Segment();
                s.Start = Math.Round(start, 3);
                s.End = Math.Round(end, 3);
                s.Text = text;
                s.Confidence = Math.Round(e.Result.Confidence, 3);
                job.Add(s);
            }

            void OnCompleted(object sender, RecognizeCompletedEventArgs e) {
                if (e.Error != null) failed = true;
                done.Set();
            }

            double SafePosition() {
                try { return engine.AudioPosition.TotalSeconds; } catch (Exception) { return lastEnd; }
            }

            public void Go() {
                try {
                    engine.LoadGrammar(new DictationGrammar());
                } catch (Exception) {
                    throw new JobFailure("no-recogniser", "The installed Windows speech recogniser has no dictation support.");
                }
                engine.SetInputToWaveFile(job.WavPath);
                engine.EndSilenceTimeout = TimeSpan.FromMilliseconds(600);
                engine.EndSilenceTimeoutAmbiguous = TimeSpan.FromMilliseconds(900);
                engine.SpeechRecognized += OnRecognized;
                engine.RecognizeCompleted += OnCompleted;
                engine.RecognizeAsync(RecognizeMode.Multiple);
                double seen = -1;
                DateTime moved = DateTime.UtcNow;
                while (!done.WaitOne(150)) {
                    if (job.CancelRequested) {
                        try { engine.RecognizeAsyncCancel(); } catch (Exception) { }
                        done.WaitOne(3000);
                        return;
                    }
                    double now = SafePosition();
                    job.SetProgress(now / Math.Max(0.1, job.Seconds));
                    if (now > seen) { seen = now; moved = DateTime.UtcNow; }
                    else if ((DateTime.UtcNow - moved).TotalSeconds > 90) {
                        try { engine.RecognizeAsyncCancel(); } catch (Exception) { }
                        throw new JobFailure("recogniser-failed", "The Windows speech recogniser stopped responding.");
                    }
                }
                if (failed) throw new JobFailure("recogniser-failed", "The Windows speech recogniser failed on this audio.");
            }
        }
    }
}
'@ -ReferencedAssemblies $speechAssembly
        return $true
    } catch {
        $script:SpeechTypeError = 'The Windows speech recognition component (System.Speech) could not be loaded.'
        return $false
    }
}

function Get-CapstanSpeechEngineName {
    if ($env:CAPSTAN_SPEECH_ENGINE -eq 'fake') { return 'fake' }
    return 'windows'
}

function Get-CapstanSpeechFakeCultures {
    $raw = $env:CAPSTAN_SPEECH_FAKE_CULTURES
    if (-not $raw) { $raw = 'en-US,en-GB' }
    if ($raw -eq 'none') { return @() }
    return @($raw.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Resolve-CapstanSpeechCulture([string]$Culture) {
    # The installed culture that serves the requested one, or $null.
    if ((Get-CapstanSpeechEngineName) -eq 'fake') {
        foreach ($c in (Get-CapstanSpeechFakeCultures)) { if ($c -ieq $Culture) { return $c } }
        $language = $Culture.Split('-')[0]
        foreach ($c in (Get-CapstanSpeechFakeCultures)) { if ($c.Split('-')[0] -ieq $language) { return $c } }
        return $null
    }
    if (-not (Initialize-CapstanSpeech)) { return $null }
    try { return [Capstan.Speech.WindowsRecogniser]::Resolve($Culture) } catch { return $null }
}

function Get-CapstanSpeechStatus {
    $engine = Get-CapstanSpeechEngineName
    if ($engine -eq 'fake') {
        return @{ engine = 'fake'; available = $true; cultures = @(Get-CapstanSpeechFakeCultures); maxBytes = $script:SpeechMaxBytes }
    }
    if (-not (Initialize-CapstanSpeech)) {
        return @{ engine = 'none'; available = $false; cultures = @(); maxBytes = $script:SpeechMaxBytes; reason = $script:SpeechTypeError }
    }
    $cultures = @()
    try { $cultures = @([Capstan.Speech.WindowsRecogniser]::Cultures()) } catch { $cultures = @() }
    return @{ engine = 'windows'; available = $true; cultures = $cultures; maxBytes = $script:SpeechMaxBytes }
}

function Get-CapstanSpeechTempRoot {
    # %LOCALAPPDATA%\Capstan\tmp, created on demand. Neither folder may be a reparse point.
    $base = $env:LOCALAPPDATA
    if (-not $base) { throw 'No local application data folder.' }
    $capstan = Join-Path $base 'Capstan'
    $tmp = Join-Path $capstan 'tmp'
    foreach ($dir in @($capstan, $tmp)) {
        if (-not (Test-Path -LiteralPath $dir)) { [void][IO.Directory]::CreateDirectory($dir) }
        if ((Get-Item -LiteralPath $dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe folder.' }
    }
    return [IO.Path]::GetFullPath($tmp).TrimEnd('\')
}

function Get-CapstanSpeechTempPath([string]$Id) {
    # The name comes from a job id the host made (32 hex digits), never from the request.
    if ($Id -cnotmatch '^[0-9a-f]{32}$') { throw 'Bad job id.' }
    $root = Get-CapstanSpeechTempRoot
    $path = [IO.Path]::GetFullPath((Join-Path $root ('speech-' + $Id + '.wav')))
    if (-not $path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped the folder.' }
    return $path
}

function Clear-CapstanSpeechTemp {
    # Files left by a host that was killed mid-job. Skips files that belong to a job running now.
    try {
        $root = Get-CapstanSpeechTempRoot
        $live = @($script:SpeechJobs.Values | Where-Object { $_.Alive } | ForEach-Object { $_.WavPath })
        foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter 'speech-*.wav' -File -Force -ErrorAction SilentlyContinue)) {
            if ($file.Name -cnotmatch '^speech-[0-9a-f]{32}\.wav$') { continue }
            if ($live -contains $file.FullName) { continue }
            if (((Get-Date) - $file.LastWriteTime).TotalMinutes -lt 2) { continue }
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
        }
    } catch { }
}

function Clear-CapstanSpeechJobs {
    # Finished jobs are kept for 15 minutes (or until forgotten); at most 16.
    $now = [DateTime]::UtcNow
    foreach ($id in @($script:SpeechJobs.Keys)) {
        $job = $script:SpeechJobs[$id]
        if ($job.State -ne 'running' -and -not $job.Alive -and ($now - $job.Finished).TotalMinutes -gt 15) { $script:SpeechJobs.Remove($id) }
    }
    while ($script:SpeechJobs.Count -gt 16) {
        $oldest = $script:SpeechJobs.Values | Where-Object { $_.State -ne 'running' } | Sort-Object { $_.Finished } | Select-Object -First 1
        if ($null -eq $oldest) { break }
        $script:SpeechJobs.Remove($oldest.Id)
    }
}

function Stop-CapstanSpeech {
    # Host shutdown: cancel what runs, wait briefly, remove any audio still on disk.
    foreach ($job in @($script:SpeechJobs.Values)) {
        try { $job.Cancel(); [void]$job.Join(3000) } catch { }
        try { if (Test-Path -LiteralPath $job.WavPath) { Remove-Item -LiteralPath $job.WavPath -Force -ErrorAction SilentlyContinue } } catch { }
    }
}

function New-CapstanSpeechResult([int]$Status, $Body) { return @{ Status = $Status; Body = $Body } }

function New-CapstanSpeechError([int]$Status, [string]$Code, [string]$Message) {
    return (New-CapstanSpeechResult $Status @{ error = $Message; code = $Code })
}

function Get-CapstanSpeechQueryValue([string]$Query, [string]$Name) {
    foreach ($pair in $Query.TrimStart('?').Split('&')) {
        $eq = $pair.IndexOf('=')
        if ($eq -lt 1) { continue }
        if ([Uri]::UnescapeDataString($pair.Substring(0, $eq)) -ceq $Name) { return [Uri]::UnescapeDataString($pair.Substring($eq + 1).Replace('+', ' ')) }
    }
    return $null
}

function ConvertTo-CapstanSpeechJob($Job) {
    $out = @{ job = $Job.Id; state = $Job.State; progress = [math]::Round($Job.Progress, 3); engine = $Job.EngineName; culture = $Job.Culture }
    if ($out.state -eq 'done') {
        $out.segments = @($Job.Segments() | ForEach-Object { @{ start = $_.Start; end = $_.End; text = $_.Text; confidence = $_.Confidence } })
    } elseif ($out.state -eq 'error' -or $out.state -eq 'cancelled') {
        $out.code = $Job.Code
        $out.error = $Job.Message
    }
    return $out
}

function Start-CapstanSpeechJob($Body, [string]$ContentType, [long]$ContentLength, [string]$Query) {
    $type = ''
    if ($ContentType) { $type = $ContentType.Split(';')[0].Trim().ToLowerInvariant() }
    if ($type -notin @('audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave')) {
        return (New-CapstanSpeechError 400 'unsupported-type' 'Send the audio as a WAV file (Content-Type: audio/wav).')
    }
    if ($ContentLength -gt $script:SpeechMaxBytes -or $Body.Length -gt $script:SpeechMaxBytes) {
        return (New-CapstanSpeechError 413 'too-big' 'This audio is too big for one request (30 MB, about 15 minutes). Capstan sends long audio in pieces; send a shorter piece.')
    }
    $culture = Get-CapstanSpeechQueryValue $Query 'culture'
    if (-not $culture) { $culture = 'en-US' }
    if ($culture -cnotmatch '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$') {
        return (New-CapstanSpeechError 400 'bad-culture' 'The language must look like en-US.')
    }
    $engineName = Get-CapstanSpeechEngineName
    if ($engineName -eq 'windows' -and -not (Initialize-CapstanSpeech)) {
        return (New-CapstanSpeechError 501 'no-engine' 'Windows speech recognition (System.Speech) is not available on this computer.')
    }
    $installed = Resolve-CapstanSpeechCulture $culture
    if (-not $installed) {
        return (New-CapstanSpeechError 501 'no-recogniser' ('No Windows speech recogniser is installed for ' + $culture + '. Add the language in Settings > Time & language > Language & region, include its Speech recognition feature, then start Capstan again.'))
    }
    $seconds = 0.0
    if (-not (Initialize-CapstanSpeech)) { return (New-CapstanSpeechError 501 'no-engine' 'Windows speech recognition (System.Speech) is not available on this computer.') }
    $problem = [Capstan.Speech.Wav]::Check($Body, [ref]$seconds)
    if ($problem) { return (New-CapstanSpeechError 400 'unsupported-format' $problem) }

    Clear-CapstanSpeechJobs
    if (-not $script:SpeechSwept) { $script:SpeechSwept = $true; Clear-CapstanSpeechTemp }
    if (@($script:SpeechJobs.Values | Where-Object { $_.State -eq 'running' }).Count -gt 0) {
        return (New-CapstanSpeechError 409 'busy' 'Another transcription is still running. Wait for it or cancel it.')
    }

    $id = [guid]::NewGuid().ToString('N')
    $path = Get-CapstanSpeechTempPath $id
    $stream = $null
    try {
        $stream = New-Object IO.FileStream -ArgumentList $path, ([IO.FileMode]::CreateNew), ([IO.FileAccess]::Write), ([IO.FileShare]::None)
        $Body.Position = 0
        $buffer = New-Object byte[] 1048576
        while (($read = $Body.Read($buffer, 0, $buffer.Length)) -gt 0) { $stream.Write($buffer, 0, $read) }
        $stream.Dispose(); $stream = $null
    } catch {
        if ($stream) { $stream.Dispose() }
        try { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } } catch { }
        return (New-CapstanSpeechError 500 'failed' 'The audio could not be prepared for recognition.')
    }

    if ($engineName -eq 'fake') {
        $delay = 0
        if ($env:CAPSTAN_SPEECH_FAKE_DELAY_MS) { [void][int]::TryParse($env:CAPSTAN_SPEECH_FAKE_DELAY_MS, [ref]$delay) }
        $recogniser = New-Object Capstan.Speech.FakeRecogniser -ArgumentList $delay
    } else {
        $recogniser = New-Object Capstan.Speech.WindowsRecogniser
    }
    $job = New-Object Capstan.Speech.Job -ArgumentList $id, $engineName, $recogniser, $installed, $path, $seconds
    $script:SpeechJobs[$id] = $job
    $job.Start()
    return (New-CapstanSpeechResult 200 (ConvertTo-CapstanSpeechJob $job))
}

function Invoke-CapstanSpeechRoute {
    # Returns @{ Status; Body } for any /api/speech/... request. Error bodies are { error, code } and
    # never carry paths or exception text.
    param([string]$Method, [string]$Path, [string]$Query = '', [string]$ContentType = '', [long]$ContentLength = 0, $Body = $null)
    try {
        if ($Path -ceq '/api/speech/status' -and $Method -eq 'GET') { return (New-CapstanSpeechResult 200 (Get-CapstanSpeechStatus)) }
        if ($Path -ceq '/api/speech/transcribe' -and $Method -eq 'POST') {
            if ($null -eq $Body) { return (New-CapstanSpeechError 400 'unsupported-format' 'Send a mono 16 kHz 16-bit PCM WAV file.') }
            return (Start-CapstanSpeechJob $Body $ContentType $ContentLength $Query)
        }
        if ($Path -cmatch '^/api/speech/([0-9a-f]{32})$' -and ($Method -eq 'GET' -or $Method -eq 'DELETE')) {
            $id = $Matches[1]
            $job = $script:SpeechJobs[$id]
            if ($null -eq $job) { return (New-CapstanSpeechError 404 'not-found' 'There is no such transcription.') }
            if ($Method -eq 'GET') { return (New-CapstanSpeechResult 200 (ConvertTo-CapstanSpeechJob $job)) }
            if ($job.State -eq 'running') { $job.Cancel() } else { $script:SpeechJobs.Remove($id) }
            return (New-CapstanSpeechResult 200 @{ ok = $true; job = $id; state = $job.State })
        }
        return (New-CapstanSpeechError 404 'not-found' 'Route not found')
    } catch {
        return (New-CapstanSpeechError 500 'failed' 'The speech request failed.')
    }
}
