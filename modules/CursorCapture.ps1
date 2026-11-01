<#
  Capstan cursor and shortcut capture (docs/cursor-data.md, "Capture"). Dot-sourced by Start-Capstan.ps1
  and tests/ps/CursorCapture.Tests.ps1. Windows PowerShell 5.1, C# 5 as source through Add-Type, no DLLs.

  What it does: between a start and a stop request from the Capstan page, a sampler thread reads the
  cursor position about 60 times a second (GetCursorPos) and the mouse buttons (GetAsyncKeyState), and,
  only when the page switched key capture on for THIS recording, a small set of key presses: function
  keys, and any key while Ctrl, Alt or the Windows key is held, as names such as "Ctrl+C". Plain typed
  letters, digits and punctuation are never recorded (Capstan.Cursor.KeyNames.Name returns null for them),
  and Shift alone does not count. The result is written as <recordingId>.cursor.json under
  %LOCALAPPDATA%\Capstan\recordings and returned to the page.

  Test seam: when the host starts with CAPSTAN_TEST_INPUT=1, the devices are not read at all. Events come
  from a script given to POST /api/cursor/test-inject and are replayed on a virtual clock, so a test is
  deterministic and never touches the real mouse or keyboard. Without that variable the route is a 404.
#>
if (-not ('Capstan.Cursor.Recorder' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace Capstan.Cursor {
    // Where input comes from. The real one asks Windows; the scripted one follows a script (tests).
    public abstract class InputSource {
        public abstract bool TryGetCursor(out int x, out int y);
        public abstract bool IsDown(int vk);
        // Scripted sources follow the session clock; real devices ignore it.
        public virtual void SetTime(double t) { }
    }

    public sealed class Win32Input : InputSource {
        [StructLayout(LayoutKind.Sequential)]
        struct POINT { public int X; public int Y; }
        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        // Makes GetCursorPos on the calling thread report physical pixels (not scaled ones), so the
        // positions match the pixels of the captured screen. Only this thread is affected.
        public static void PrepareThread() {
            try { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
            catch (EntryPointNotFoundException) { try { SetProcessDPIAware(); } catch (Exception) { } }
            catch (DllNotFoundException) { }
        }
        public override bool TryGetCursor(out int x, out int y) {
            POINT p;
            if (!GetCursorPos(out p)) { x = 0; y = 0; return false; }
            x = p.X; y = p.Y;
            return true;
        }
        public override bool IsDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
    }

    // A cursor path (straight lines between waypoints) and held keys or buttons, by time.
    public sealed class ScriptedInput : InputSource {
        readonly List<double[]> moves = new List<double[]>();
        readonly List<double[]> holds = new List<double[]>();
        double now = 0;
        double explicitDuration = 0;
        public int MoveCount { get { return moves.Count; } }
        public int HoldCount { get { return holds.Count; } }
        public double Duration {
            get {
                double d = explicitDuration;
                foreach (double[] m in moves) if (m[0] > d) d = m[0];
                foreach (double[] h in holds) if (h[2] > d) d = h[2];
                return d;
            }
            set { explicitDuration = value < 0 ? 0 : value; }
        }
        static int ByTime(double[] a, double[] b) { return a[0].CompareTo(b[0]); }
        public void Clear() { moves.Clear(); holds.Clear(); explicitDuration = 0; now = 0; }
        public void CopyFrom(ScriptedInput other) {
            Clear();
            foreach (double[] m in other.moves) moves.Add(new double[] { m[0], m[1], m[2] });
            foreach (double[] h in other.holds) holds.Add(new double[] { h[0], h[1], h[2] });
            explicitDuration = other.explicitDuration;
        }
        public void AddMove(double t, int x, int y) { moves.Add(new double[] { t, x, y }); moves.Sort(ByTime); }
        // The key or button with virtual-key code vk is down from `from` up to (not including) `to`.
        public void AddHold(int vk, double from, double to) { holds.Add(new double[] { vk, from, to }); }
        public override void SetTime(double t) { now = t; }
        public override bool TryGetCursor(out int x, out int y) {
            x = 0; y = 0;
            if (moves.Count == 0) return false;
            double[] first = moves[0];
            double[] last = moves[moves.Count - 1];
            if (now <= first[0]) { x = (int)first[1]; y = (int)first[2]; return true; }
            if (now >= last[0]) { x = (int)last[1]; y = (int)last[2]; return true; }
            for (int i = 1; i < moves.Count; i++) {
                double[] b = moves[i];
                if (now <= b[0]) {
                    double[] a = moves[i - 1];
                    double span = b[0] - a[0];
                    double u = span <= 0 ? 1 : (now - a[0]) / span;
                    x = (int)Math.Round(a[1] + (b[1] - a[1]) * u);
                    y = (int)Math.Round(a[2] + (b[2] - a[2]) * u);
                    return true;
                }
            }
            return true;
        }
        static bool Match(int vk, int held) {
            if (vk == held) return true;
            // Like Windows: the generic Shift, Ctrl and Alt keys are down when either side is.
            if (vk == 0x10) return held == 0xA0 || held == 0xA1;
            if (vk == 0x11) return held == 0xA2 || held == 0xA3;
            if (vk == 0x12) return held == 0xA4 || held == 0xA5;
            return false;
        }
        public override bool IsDown(int vk) {
            foreach (double[] h in holds) {
                if (now >= h[1] && now < h[2] && Match(vk, (int)h[0])) return true;
            }
            return false;
        }
    }

    // The key filter. This is the privacy rule in one place: it decides what may be written down.
    public static class KeyNames {
        static int[] candidates;
        public static bool IsModifier(int vk) {
            return vk == 0x10 || vk == 0x11 || vk == 0x12 || vk == 0x5B || vk == 0x5C || (vk >= 0xA0 && vk <= 0xA5);
        }
        public static bool IsFunctionKey(int vk) { return vk >= 0x70 && vk <= 0x87; }
        // The text of a key as it is written on the key cap, or null for a key that is never recorded.
        public static string Label(int vk) {
            if (vk >= 0x41 && vk <= 0x5A) return ((char)vk).ToString();
            if (vk >= 0x30 && vk <= 0x39) return ((char)vk).ToString();
            if (IsFunctionKey(vk)) return "F" + (vk - 0x6F).ToString(CultureInfo.InvariantCulture);
            if (vk >= 0x60 && vk <= 0x69) return "Num" + (vk - 0x60).ToString(CultureInfo.InvariantCulture);
            switch (vk) {
                case 0x08: return "Backspace";
                case 0x09: return "Tab";
                case 0x0D: return "Enter";
                case 0x1B: return "Esc";
                case 0x20: return "Space";
                case 0x21: return "PgUp";
                case 0x22: return "PgDn";
                case 0x23: return "End";
                case 0x24: return "Home";
                case 0x25: return "Left";
                case 0x26: return "Up";
                case 0x27: return "Right";
                case 0x28: return "Down";
                case 0x2C: return "PrtSc";
                case 0x2D: return "Ins";
                case 0x2E: return "Del";
                case 0x5D: return "Menu";
                case 0x6A: return "Num*";
                case 0x6B: return "Num+";
                case 0x6D: return "Num-";
                case 0x6E: return "Num.";
                case 0x6F: return "Num/";
                case 0xBA: return ";";
                case 0xBB: return "=";
                case 0xBC: return ",";
                case 0xBD: return "-";
                case 0xBE: return ".";
                case 0xBF: return "/";
                case 0xC0: return "`";
                case 0xDB: return "[";
                case 0xDC: return "\\";
                case 0xDD: return "]";
                case 0xDE: return "'";
            }
            return null;
        }
        // The name to record for a key press, or null when it must NOT be recorded. Recorded: function
        // keys, and any key while Ctrl, Alt or the Windows key is held. Never recorded: a plain letter,
        // digit, punctuation key, Enter, Space and so on, with or without Shift. AltGr (Ctrl+Alt made by
        // the right Alt key) types characters on many keyboards, so it never counts as a modifier. Alt
        // with number-pad digits (Alt codes) types characters, so that is not recorded either.
        public static string Name(int vk, bool ctrl, bool alt, bool shift, bool win, bool altGr) {
            if (altGr || IsModifier(vk)) return null;
            string label = Label(vk);
            if (label == null) return null;
            bool command = ctrl || alt || win;
            if (!command && !IsFunctionKey(vk)) return null;
            if (alt && !ctrl && !win && vk >= 0x60 && vk <= 0x69) return null;
            StringBuilder sb = new StringBuilder();
            if (ctrl) sb.Append("Ctrl+");
            if (alt) sb.Append("Alt+");
            if (shift) sb.Append("Shift+");
            if (win) sb.Append("Win+");
            sb.Append(label);
            // The cursor file allows names of up to 24 characters.
            return sb.Length > 24 ? null : sb.ToString();
        }
        // Every key that can ever be named (the only ones polled).
        public static int[] Candidates {
            get {
                if (candidates == null) {
                    List<int> list = new List<int>();
                    for (int vk = 8; vk < 255; vk++) if (!IsModifier(vk) && Label(vk) != null) list.Add(vk);
                    candidates = list.ToArray();
                }
                return candidates;
            }
        }
    }

    // File names and the recordings folder. One root, ids from a strict pattern, nothing from a request.
    public static class CursorStore {
        static readonly Regex IdPattern = new Regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\\z", RegexOptions.CultureInvariant);
        static readonly string[] Reserved = new string[] {
            "CON","PRN","AUX","NUL","COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9",
            "LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"
        };
        public const string Suffix = ".cursor.json";
        public static bool ValidId(string id) {
            if (id == null || !IdPattern.IsMatch(id)) return false;
            foreach (string r in Reserved) if (string.Equals(r, id, StringComparison.OrdinalIgnoreCase)) return false;
            return true;
        }
        static bool IsReparse(string path) {
            try { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; }
            catch (Exception) { return true; }
        }
        // The full path of the sidecar for an id, or null when the id is not valid or the root cannot be
        // trusted (not a normal folder, or a link to somewhere else). Creates the root if it is missing.
        public static string Resolve(string root, string id) {
            if (!ValidId(id) || string.IsNullOrEmpty(root)) return null;
            string full;
            string rootFull;
            try {
                rootFull = Path.GetFullPath(root).TrimEnd('\\');
                Directory.CreateDirectory(rootFull);
                full = Path.GetFullPath(Path.Combine(rootFull, id + Suffix));
            } catch (Exception) { return null; }
            if (IsReparse(rootFull)) return null;
            string parent = Path.GetDirectoryName(rootFull);
            if (!string.IsNullOrEmpty(parent) && IsReparse(parent)) return null;
            if (!string.Equals(Path.GetDirectoryName(full), rootFull, StringComparison.OrdinalIgnoreCase)) return null;
            if (!string.Equals(Path.GetFileName(full), id + Suffix, StringComparison.OrdinalIgnoreCase)) return null;
            return full;
        }
        public static bool Exists(string root, string id) {
            string p = Resolve(root, id);
            return p != null && File.Exists(p);
        }
        // Writes the file next to its final name first and moves it into place, never over an existing file.
        public static bool Write(string root, string id, string json) {
            string path = Resolve(root, id);
            if (path == null || File.Exists(path)) return false;
            string temp = path + ".tmp";
            try {
                using (FileStream fs = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None, 65536)) {
                    using (StreamWriter w = new StreamWriter(fs, new UTF8Encoding(false), 65536)) {
                        for (int i = 0; i < json.Length; i += 32768) w.Write(json.Substring(i, Math.Min(32768, json.Length - i)));
                    }
                }
                File.Move(temp, path);
                return true;
            } catch (Exception) {
                try { if (File.Exists(temp)) File.Delete(temp); } catch (Exception) { }
                return false;
            }
        }
    }

    // One recording's worth of cursor data. Tick(t) is one poll at session time t (seconds).
    public sealed class CursorSession {
        public const int MaxSamples = 120000;
        public const int MaxClicks = 20000;
        public const int MaxKeys = 50000;
        public const double MaxTime = 86400.0;
        const double BaseInterval = 0.015;
        const double HoldInterval = 0.08;
        static readonly int[] ButtonVk = new int[] { 0x01, 0x02, 0x04 };
        static readonly string[] ButtonName = new string[] { "left", "right", "middle" };

        public readonly string RecordingId;
        public readonly bool KeysEnabled;
        readonly double bx, by, bw, bh;
        readonly InputSource src;
        List<double> st = new List<double>(), sx = new List<double>(), sy = new List<double>();
        readonly List<double> ct = new List<double>();
        readonly List<int> cb = new List<int>();
        readonly List<bool> cd = new List<bool>();
        readonly List<double> kt = new List<double>();
        readonly List<string> kn = new List<string>();
        readonly List<bool> kd = new List<bool>();
        double interval = BaseInterval, hold = HoldInterval;
        bool haveSample = false, primed = false;
        int lastPx, lastPy;
        double lastT = 0, now = 0;
        readonly bool[] btnPrev = new bool[3];
        readonly bool[] btnLogged = new bool[3];
        readonly bool[] keyPrev = new bool[256];
        readonly string[] keyLogged = new string[256];

        public int SampleCount { get { return st.Count; } }
        public int ClickCount { get { return ct.Count; } }
        public int KeyCount { get { return kt.Count; } }
        public double Time { get { return now; } }

        public CursorSession(string recordingId, double x, double y, double width, double height, bool keys, InputSource source) {
            RecordingId = recordingId; bx = x; by = y; bw = width; bh = height; KeysEnabled = keys; src = source;
        }

        double Frac(double v, double size) { return Math.Min(1.0, Math.Max(0.0, v / size)); }

        // One poll. recording=false (paused) only tracks button and key state, and closes presses that
        // were already recorded; it records no positions and no new presses.
        public void Tick(double t, bool recording) {
            if (t < now) t = now;
            if (t > MaxTime) t = MaxTime;
            now = t;
            int px = 0, py = 0;
            bool have = src.TryGetCursor(out px, out py);
            bool inside = have && px >= bx && py >= by && px < bx + bw && py < by + bh;
            if (recording && have) AddSample(t, px, py);
            for (int i = 0; i < 3; i++) {
                bool down = src.IsDown(ButtonVk[i]);
                if (primed) {
                    if (down && !btnPrev[i]) {
                        btnLogged[i] = recording && inside && ct.Count < MaxClicks - 4;
                        if (btnLogged[i]) AddClick(t, i, true);
                    } else if (!down && btnPrev[i] && btnLogged[i]) {
                        btnLogged[i] = false;
                        AddClick(t, i, false);
                    }
                }
                btnPrev[i] = down;
            }
            if (KeysEnabled) PollKeys(t, recording);
            primed = true;
        }

        void PollKeys(double t, bool recording) {
            bool ctrl = src.IsDown(0x11), alt = src.IsDown(0x12), shift = src.IsDown(0x10);
            bool win = src.IsDown(0x5B) || src.IsDown(0x5C);
            bool altGr = src.IsDown(0xA5) && src.IsDown(0xA2) && !src.IsDown(0xA3);
            int[] list = KeyNames.Candidates;
            for (int j = 0; j < list.Length; j++) {
                int vk = list[j];
                bool down = src.IsDown(vk);
                if (primed) {
                    if (down && !keyPrev[vk]) {
                        string name = null;
                        if (recording && kt.Count < MaxKeys - 16) name = KeyNames.Name(vk, ctrl, alt, shift, win, altGr);
                        keyLogged[vk] = name;
                        if (name != null) AddKey(t, name, true);
                    } else if (!down && keyPrev[vk] && keyLogged[vk] != null) {
                        AddKey(t, keyLogged[vk], false);
                        keyLogged[vk] = null;
                    }
                }
                keyPrev[vk] = down;
            }
        }

        void AddSample(double t, int px, int py) {
            bool moved = haveSample && (px != lastPx || py != lastPy);
            double since = t - lastT;
            if (haveSample && !(moved && since >= interval) && !(!moved && since >= hold)) return;
            if (st.Count >= MaxSamples) Thin();
            st.Add(t); sx.Add(Frac(px - bx, bw)); sy.Add(Frac(py - by, bh));
            lastPx = px; lastPy = py; lastT = t; haveSample = true;
        }

        // At the sample limit every second sample goes and the sampling rate halves, so a very long
        // recording still fits the file limit (with fewer positions per second).
        void Thin() {
            List<double> nt = new List<double>(), nx = new List<double>(), ny = new List<double>();
            for (int i = 0; i < st.Count; i += 2) { nt.Add(st[i]); nx.Add(sx[i]); ny.Add(sy[i]); }
            int last = st.Count - 1;
            if (last % 2 == 1) { nt.Add(st[last]); nx.Add(sx[last]); ny.Add(sy[last]); }
            st = nt; sx = nx; sy = ny;
            interval *= 2; hold *= 2;
        }

        void AddClick(double t, int button, bool down) { ct.Add(t); cb.Add(button); cd.Add(down); }
        void AddKey(double t, string name, bool down) { kt.Add(t); kn.Add(name); kd.Add(down); }

        static string Num(double v, string format) {
            if (v < 0) v = 0;
            return v.ToString(format, CultureInfo.InvariantCulture);
        }
        static void Quote(StringBuilder sb, string s) {
            sb.Append('"');
            foreach (char c in s) {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < 0x20 || c > 0x7E) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                else sb.Append(c);
            }
            sb.Append('"');
        }

        // The version-1 file of docs/cursor-data.md: positions as fractions of the bounds, seconds from the start.
        public string ToJson() {
            StringBuilder sb = new StringBuilder(64 + st.Count * 24 + ct.Count * 48 + kt.Count * 56);
            sb.Append("{\"format\":\"capstan-cursor\",\"version\":1,\"samples\":[");
            for (int i = 0; i < st.Count; i++) {
                if (i > 0) sb.Append(',');
                sb.Append('[').Append(Num(st[i], "0.####")).Append(',').Append(Num(sx[i], "0.#####")).Append(',').Append(Num(sy[i], "0.#####")).Append(']');
            }
            sb.Append("],\"clicks\":[");
            for (int i = 0; i < ct.Count; i++) {
                if (i > 0) sb.Append(',');
                sb.Append("{\"t\":").Append(Num(ct[i], "0.####")).Append(",\"button\":\"").Append(ButtonName[cb[i]]).Append("\",\"down\":").Append(cd[i] ? "true" : "false").Append('}');
            }
            sb.Append("],\"keys\":[");
            for (int i = 0; i < kt.Count; i++) {
                if (i > 0) sb.Append(',');
                sb.Append("{\"t\":").Append(Num(kt[i], "0.####")).Append(",\"key\":");
                Quote(sb, kn[i]);
                sb.Append(",\"down\":").Append(kd[i] ? "true" : "false").Append('}');
            }
            sb.Append("]}");
            return sb.ToString();
        }
    }

    // What a call returns. Ok=false carries a short Code (bad-request, busy, exists, not-found) and a
    // fixed Message; messages never contain paths or exception text.
    public sealed class Reply {
        public bool Ok;
        public string Code;
        public string Message;
        public string Handle;
        public string RecordingId;
        public string Json;
        public bool Saved;
        public string Reason;
        public double HostElapsedMs;
        public long OriginEpochMs;
        public double MaxSeconds;
        public bool Keys;
        public bool TestInput;
        public static Reply Fail(string code, string message) { Reply r = new Reply(); r.Ok = false; r.Code = code; r.Message = message; return r; }
    }

    public sealed class StatusInfo {
        public bool Active;
        public bool Paused;
        public bool Keys;
        public string RecordingId;
        public double Seconds;
        public int Samples;
        public int Clicks;
        public int KeyEvents;
        public double MaxSeconds;
        public bool TestInput;
        public string LastReason;
        public bool LastSaved;
    }

    // Owns the one session, its clock and its sampler thread.
    public sealed class Recorder : IDisposable {
        static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        public const double DefaultMaxSeconds = 14400.0;
        readonly object gate = new object();
        readonly string root;
        public readonly bool TestMode;
        public readonly ScriptedInput TestInput = new ScriptedInput();
        CursorSession session;
        InputSource source;
        string handle;
        Stopwatch watch;
        bool paused;
        double pausedTotal, pauseStart, maxSeconds;
        bool threaded;
        Thread thread;
        Reply last;
        string lastReason;
        bool lastSaved;

        public Recorder(string recordingsRoot, bool testMode) { root = recordingsRoot; TestMode = testMode; }

        double Now() {
            double e = paused ? pauseStart : watch.Elapsed.TotalSeconds;
            return e - pausedTotal;
        }

        static bool Finite(double v) { return !double.IsNaN(v) && !double.IsInfinity(v); }

        // sourceOverride is for tests that run the real-time thread against a ScriptedInput. In test mode the
        // injected script is used and no thread runs.
        public Reply Start(string recordingId, double x, double y, double width, double height, bool keys, double maxSecs, InputSource sourceOverride) {
            if (!CursorStore.ValidId(recordingId)) return Reply.Fail("bad-request", "The recording id is not valid.");
            if (!Finite(x) || !Finite(y) || !Finite(width) || !Finite(height) || width < 1 || height < 1 || width > 100000 || height > 100000 || Math.Abs(x) > 1000000 || Math.Abs(y) > 1000000)
                return Reply.Fail("bad-request", "The capture bounds are not valid.");
            if (!Finite(maxSecs) || maxSecs <= 0) maxSecs = DefaultMaxSeconds;
            if (maxSecs > CursorSession.MaxTime) maxSecs = CursorSession.MaxTime;
            lock (gate) {
                if (session != null) return Reply.Fail("busy", "A cursor session is already running.");
                if (CursorStore.Resolve(root, recordingId) == null) return Reply.Fail("unavailable", "The recordings folder cannot be used.");
                if (CursorStore.Exists(root, recordingId)) return Reply.Fail("exists", "A cursor file for this recording already exists.");
                last = null;
                threaded = !TestMode;
                source = TestMode ? (InputSource)TestInput : (sourceOverride != null ? sourceOverride : new Win32Input());
                session = new CursorSession(recordingId, x, y, width, height, keys, source);
                handle = Guid.NewGuid().ToString("N");
                maxSeconds = maxSecs;
                paused = false; pausedTotal = 0; pauseStart = 0;
                DateTime origin = DateTime.UtcNow;
                watch = Stopwatch.StartNew();
                if (threaded) {
                    source.SetTime(0);
                    session.Tick(0, true);
                    thread = new Thread(new ParameterizedThreadStart(Run));
                    thread.IsBackground = true;
                    thread.Name = "Capstan cursor sampler";
                    thread.Start(session);
                }
                Reply r = new Reply();
                r.Ok = true; r.Handle = handle; r.RecordingId = recordingId; r.Keys = keys; r.MaxSeconds = maxSeconds; r.TestInput = TestMode;
                r.OriginEpochMs = (long)(origin - Epoch).TotalMilliseconds;
                r.HostElapsedMs = watch.Elapsed.TotalMilliseconds;
                return r;
            }
        }

        // The sampler. It belongs to one session and ends as soon as that session is no longer the current one.
        void Run(object state) {
            CursorSession mine = (CursorSession)state;
            bool prepared = false;
            while (true) {
                lock (gate) {
                    if (session != mine) return;
                    if (!prepared) { if (source is Win32Input) Win32Input.PrepareThread(); prepared = true; }
                    double t = Now();
                    source.SetTime(t);
                    if (t >= maxSeconds) { FinishLocked("max-duration", false); return; }
                    session.Tick(t, !paused);
                }
                Thread.Sleep(2);
            }
        }

        // Ends the session (gate held): final poll, JSON, file.
        Reply FinishLocked(string reason, bool discard) {
            CursorSession s = session;
            double t = Now();
            if (!threaded) {
                // Test mode: replay the script on a virtual clock, 60 polls a second, no sleeping.
                double dur = Math.Min(TestInput.Duration, maxSeconds);
                if (TestInput.Duration > maxSeconds) reason = "max-duration";
                int steps = (int)Math.Ceiling(dur * 60.0);
                for (int i = 0; i <= steps; i++) {
                    double ts = Math.Min(dur, i / 60.0);
                    TestInput.SetTime(ts);
                    s.Tick(ts, true);
                }
            } else {
                if (t > maxSeconds) t = maxSeconds;
                source.SetTime(t);
                s.Tick(t, !paused);
            }
            Reply r = new Reply();
            r.Ok = true; r.Handle = handle; r.RecordingId = s.RecordingId; r.Reason = reason; r.Keys = s.KeysEnabled; r.TestInput = TestMode;
            r.Json = s.ToJson();
            r.Saved = !discard && CursorStore.Write(root, s.RecordingId, r.Json);
            r.HostElapsedMs = watch.Elapsed.TotalMilliseconds;
            session = null;
            paused = false;
            lastReason = reason; lastSaved = r.Saved;
            last = discard ? null : r;
            return r;
        }

        public Reply Pause(string h) {
            lock (gate) {
                if (session == null || h != handle) return Reply.Fail("not-found", "There is no such cursor session.");
                if (!paused) { pauseStart = watch.Elapsed.TotalSeconds; paused = true; }
                Reply r = new Reply(); r.Ok = true; r.Handle = handle; return r;
            }
        }

        public Reply Resume(string h) {
            lock (gate) {
                if (session == null || h != handle) return Reply.Fail("not-found", "There is no such cursor session.");
                if (paused) { pausedTotal += watch.Elapsed.TotalSeconds - pauseStart; paused = false; }
                Reply r = new Reply(); r.Ok = true; r.Handle = handle; return r;
            }
        }

        // Finishes the session and returns its JSON. A session that already stopped by itself (the
        // maximum duration) hands over its result once. discard=true throws the data away and writes nothing.
        public Reply Stop(string h, bool discard) {
            Thread t = null;
            Reply r;
            lock (gate) {
                if (session != null && h == handle) {
                    t = thread;
                    r = FinishLocked(discard ? "discarded" : "stopped", discard);
                    last = null;   // only an automatic stop leaves a result behind for a later Stop call
                } else if (last != null && h == last.Handle) {
                    r = last;
                    last = null;
                } else {
                    return Reply.Fail("not-found", "There is no such cursor session.");
                }
            }
            if (t != null && t != Thread.CurrentThread) t.Join(1000);
            return r;
        }

        public StatusInfo Status() {
            lock (gate) {
                StatusInfo s = new StatusInfo();
                s.TestInput = TestMode;
                s.LastReason = lastReason; s.LastSaved = lastSaved;
                if (session != null) {
                    s.Active = true; s.Paused = paused; s.Keys = session.KeysEnabled; s.RecordingId = session.RecordingId;
                    s.Seconds = Now(); s.Samples = session.SampleCount; s.Clicks = session.ClickCount; s.KeyEvents = session.KeyCount; s.MaxSeconds = maxSeconds;
                }
                return s;
            }
        }

        // Called when the host stops: the session is finished and written like a normal stop.
        public void Shutdown() {
            Thread t = null;
            lock (gate) {
                if (session != null) { t = thread; FinishLocked("host-stopped", false); }
                last = null;
            }
            if (t != null && t != Thread.CurrentThread) t.Join(1000);
        }

        public void Dispose() { Shutdown(); }
    }
}
'@
}

# ---------------------------------------------------------------------------------------------
# HTTP-free route logic. Start-Capstan.ps1 checks the token, Host, Origin and body size, then calls
# Invoke-CapstanCursorApi, which returns @{ Status; Text } (Text is JSON). Tests call it directly.
# ---------------------------------------------------------------------------------------------
$script:CursorBodyLimit = 4096
$script:CursorInjectLimit = 2000000

function Get-CapstanCursorRoot {
    # The one folder the cursor files go in. CAPSTAN_TEST_RECORDINGS moves it, but only in test-input mode.
    if ($env:CAPSTAN_TEST_INPUT -eq '1' -and $env:CAPSTAN_TEST_RECORDINGS) { return $env:CAPSTAN_TEST_RECORDINGS }
    if (-not $env:LOCALAPPDATA) { return $null }
    return (Join-Path $env:LOCALAPPDATA 'Capstan\recordings')
}

function New-CapstanCursorRecorder {
    param([string]$Root = (Get-CapstanCursorRoot), [bool]$TestInput = ($env:CAPSTAN_TEST_INPUT -eq '1'))
    if (-not $Root) { return $null }
    return (New-Object Capstan.Cursor.Recorder -ArgumentList $Root, $TestInput)
}

function Get-CursorMaxSeconds {
    $v = 0.0
    if ($env:CAPSTAN_TEST_INPUT -eq '1' -and $env:CAPSTAN_CURSOR_MAX_SECONDS -and [double]::TryParse($env:CAPSTAN_CURSOR_MAX_SECONDS, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$v) -and $v -gt 0) { return $v }
    return [Capstan.Cursor.Recorder]::DefaultMaxSeconds
}

function Test-CursorNumber($Value) {
    return ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal])
}

function New-CursorResult([int]$Status, $Payload) {
    return @{ Status = $Status; Text = (ConvertTo-Json -InputObject $Payload -Depth 6 -Compress) }
}

function New-CursorError([int]$Status, [string]$Code, [string]$Message) {
    return (New-CursorResult $Status @{ error = $Message; code = $Code })
}

function ConvertTo-CursorErrorResult($Reply) {
    $status = switch ($Reply.Code) { 'bad-request' { 400 } 'not-found' { 404 } 'busy' { 409 } 'exists' { 409 } 'unavailable' { 503 } default { 500 } }
    return (New-CursorError $status $Reply.Code $Reply.Message)
}

function Read-CursorBody([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    try { $o = $Text | ConvertFrom-Json } catch { return $null }
    if ($o -is [System.Management.Automation.PSCustomObject]) { return $o }
    return $null
}

function Get-CursorProp($Object, [string]$Name) {
    if ($null -eq $Object -or -not $Object.PSObject.Properties[$Name]) { return $null }
    return $Object.PSObject.Properties[$Name].Value
}

function Invoke-CapstanCursorApi {
    param(
        $Recorder,
        [string]$Method,
        [string]$Path,
        [string]$ContentType = '',
        [string]$BodyText = ''
    )
    if ($null -eq $Recorder) { return (New-CursorError 503 'unavailable' 'Cursor capture is not available on this computer.') }
    $route = $Path.TrimEnd('/')
    $known = @('/api/cursor/start', '/api/cursor/stop', '/api/cursor/pause', '/api/cursor/resume', '/api/cursor/status', '/api/cursor/test-inject')
    if ($known -notcontains $route -or ($route -eq '/api/cursor/test-inject' -and -not $Recorder.TestMode)) { return (New-CursorError 404 'not-found' 'Route not found.') }

    if ($route -eq '/api/cursor/status') {
        if ($Method -ne 'GET') { return (New-CursorError 405 'method' 'Use GET.') }
        $s = $Recorder.Status()
        return (New-CursorResult 200 @{
            ok = $true; available = $true; active = $s.Active; paused = $s.Paused; keys = $s.Keys; recordingId = $s.RecordingId
            seconds = [math]::Round($s.Seconds, 3); samples = $s.Samples; clicks = $s.Clicks; keyEvents = $s.KeyEvents
            maxSeconds = $s.MaxSeconds; testInput = $s.TestInput; lastReason = $s.LastReason; lastSaved = $s.LastSaved
        })
    }

    if ($Method -ne 'POST') { return (New-CursorError 405 'method' 'Use POST.') }
    if ($ContentType -notmatch '^application/json\s*(;|$)') { return (New-CursorError 415 'content-type' 'Send application/json.') }
    $limit = if ($route -eq '/api/cursor/test-inject') { $script:CursorInjectLimit } else { $script:CursorBodyLimit }
    if ($BodyText.Length -gt $limit) { return (New-CursorError 413 'too-large' 'The request is too large.') }
    $body = Read-CursorBody $BodyText
    if ($null -eq $body) { return (New-CursorError 400 'bad-request' 'The request body must be a JSON object.') }

    if ($route -eq '/api/cursor/start') {
        $id = Get-CursorProp $body 'recordingId'
        if ($id -isnot [string] -or -not [Capstan.Cursor.CursorStore]::ValidId($id)) { return (New-CursorError 400 'bad-request' 'The recording id is not valid.') }
        $b = Get-CursorProp $body 'bounds'
        $parts = @()
        foreach ($k in @('x', 'y', 'width', 'height')) {
            $v = Get-CursorProp $b $k
            if (-not (Test-CursorNumber $v)) { return (New-CursorError 400 'bad-request' 'The capture bounds are not valid.') }
            $parts += [double]$v
        }
        $keysValue = Get-CursorProp $body 'keys'
        if ($null -ne $keysValue -and $keysValue -isnot [bool]) { return (New-CursorError 400 'bad-request' 'keys must be true or false.') }
        $keys = ($keysValue -eq $true)
        $reply = $Recorder.Start($id, $parts[0], $parts[1], $parts[2], $parts[3], $keys, (Get-CursorMaxSeconds), $null)
        if (-not $reply.Ok) { return (ConvertTo-CursorErrorResult $reply) }
        return (New-CursorResult 200 @{
            ok = $true; session = $reply.Handle; recordingId = $reply.RecordingId; keys = $reply.Keys
            originEpochMs = $reply.OriginEpochMs; hostElapsedMs = [math]::Round($reply.HostElapsedMs, 3)
            maxSeconds = $reply.MaxSeconds; testInput = $reply.TestInput
        })
    }

    if ($route -eq '/api/cursor/test-inject') {
        $moves = @(Get-CursorProp $body 'moves')
        $holds = @(Get-CursorProp $body 'holds')
        if ($moves.Count -gt 20000 -or $holds.Count -gt 5000) { return (New-CursorError 413 'too-large' 'The script is too long.') }
        $probe = New-Object Capstan.Cursor.ScriptedInput
        foreach ($m in $moves) {
            if ($null -eq $m) { continue }
            $t = Get-CursorProp $m 't'; $x = Get-CursorProp $m 'x'; $y = Get-CursorProp $m 'y'
            if (-not ((Test-CursorNumber $t) -and (Test-CursorNumber $x) -and (Test-CursorNumber $y)) -or $t -lt 0) { return (New-CursorError 400 'bad-request' 'A move needs numbers t, x and y.') }
            $probe.AddMove([double]$t, [int][math]::Round([double]$x), [int][math]::Round([double]$y))
        }
        foreach ($h in $holds) {
            if ($null -eq $h) { continue }
            $vk = Get-CursorProp $h 'vk'; $from = Get-CursorProp $h 'from'; $to = Get-CursorProp $h 'to'
            if (-not ((Test-CursorNumber $vk) -and (Test-CursorNumber $from) -and (Test-CursorNumber $to)) -or $vk -lt 1 -or $vk -gt 254 -or $from -lt 0 -or $to -lt $from) { return (New-CursorError 400 'bad-request' 'A hold needs numbers vk (1 to 254), from and to.') }
            $probe.AddHold([int]$vk, [double]$from, [double]$to)
        }
        $duration = Get-CursorProp $body 'duration'
        if ($null -ne $duration) {
            if (-not (Test-CursorNumber $duration) -or $duration -lt 0 -or $duration -gt 86400) { return (New-CursorError 400 'bad-request' 'duration must be 0 to 86400 seconds.') }
            $probe.Duration = [double]$duration
        }
        $Recorder.TestInput.CopyFrom($probe)
        return (New-CursorResult 200 @{ ok = $true; moves = $Recorder.TestInput.MoveCount; holds = $Recorder.TestInput.HoldCount; duration = $Recorder.TestInput.Duration })
    }

    # pause, resume, stop all name the session they act on.
    $handle = Get-CursorProp $body 'session'
    if ($handle -isnot [string] -or $handle.Length -lt 1 -or $handle.Length -gt 64) { return (New-CursorError 400 'bad-request' 'session is required.') }
    if ($route -eq '/api/cursor/pause') {
        $reply = $Recorder.Pause($handle)
        if (-not $reply.Ok) { return (ConvertTo-CursorErrorResult $reply) }
        return (New-CursorResult 200 @{ ok = $true; paused = $true })
    }
    if ($route -eq '/api/cursor/resume') {
        $reply = $Recorder.Resume($handle)
        if (-not $reply.Ok) { return (ConvertTo-CursorErrorResult $reply) }
        return (New-CursorResult 200 @{ ok = $true; paused = $false })
    }
    # stop: the answer is the cursor file itself.
    $discard = ((Get-CursorProp $body 'discard') -eq $true)
    $reply = $Recorder.Stop($handle, $discard)
    if (-not $reply.Ok) { return (ConvertTo-CursorErrorResult $reply) }
    if ($discard) { return (New-CursorResult 200 @{ ok = $true; discarded = $true }) }
    return @{ Status = 200; Text = $reply.Json }
}
