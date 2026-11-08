<#
  Capstan global hotkeys and tray icon (docs/ARCHITECTURE.md, "Hotkeys and the tray"). Dot-sourced by
  Start-Capstan.ps1 and tests/ps/Hotkeys.Tests.ps1.

  - Capstan.Hotkeys.* is C# source compiled by Add-Type (C# 5, framework assemblies only, P/Invoke only
    into user32). One HotkeyService owns a worker thread (STA, background) with a hidden message-only
    window that calls RegisterHotKey, a NotifyIcon tray icon with a menu, and a queue of fixed event
    names. The page long-polls the queue; no key content ever leaves the thread, only the event name.
  - The thread is a background thread, so it can never keep the host alive. Stop() unregisters every key
    and removes the icon; Start-Capstan.ps1 calls it in its finally block (Ctrl+C included).
  - CAPSTAN_TEST_HOTKEYS=1 is a test seam: no key is registered, no icon is created, no thread starts, and
    POST /api/hotkeys/test-inject becomes available. Without the variable that route does not exist.
  - CAPSTAN_HOTKEYS=0 (or -no-hotkeys) turns the whole feature off.
#>
if (-not ('Capstan.Hotkeys.HotkeyService' -as [type])) {
    Add-Type -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing') -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Capstan.Hotkeys {

    public sealed class Chord {
        public string Text { get; internal set; }
        public uint Modifiers { get; internal set; }
        public uint KeyCode { get; internal set; }
    }

    // The allowlist of modifier and key names. Nothing free-form ever reaches RegisterHotKey.
    public static class Chords {
        public const uint Alt = 1;
        public const uint Control = 2;
        public const uint Shift = 4;
        public const int MaxLength = 40;

        sealed class KeyDef { public string Name; public uint Code; }
        static readonly Dictionary<string, KeyDef> byName = new Dictionary<string, KeyDef>(StringComparer.OrdinalIgnoreCase);
        static readonly List<string> order = new List<string>();

        static void Add(string name, uint code) {
            KeyDef d = new KeyDef();
            d.Name = name;
            d.Code = code;
            byName[name] = d;
            order.Add(name);
        }

        static Chords() {
            // F12 is reserved by Windows for debuggers, so it is not offered.
            for (int i = 1; i <= 24; i++) {
                if (i == 12) continue;
                Add("F" + i.ToString(CultureInfo.InvariantCulture), (uint)(0x70 + i - 1));
            }
            for (char c = 'A'; c <= 'Z'; c++) Add(c.ToString(), (uint)c);
            for (char c = '0'; c <= '9'; c++) Add(c.ToString(), (uint)c);
            Add("Insert", 0x2D);
            Add("Delete", 0x2E);
            Add("Home", 0x24);
            Add("End", 0x23);
            Add("PageUp", 0x21);
            Add("PageDown", 0x22);
            Add("Pause", 0x13);
            Add("PrintScreen", 0x2C);
            Add("ScrollLock", 0x91);
        }

        public static string[] ModifierNames() { return new string[] { "Ctrl", "Alt", "Shift" }; }
        public static string[] KeyNames() { return order.ToArray(); }

        public static bool TryParse(string text, out Chord chord, out string error) {
            chord = null;
            error = null;
            if (text == null) { error = "Choose a key combination."; return false; }
            string t = text.Trim();
            if (t.Length == 0) { error = "Choose a key combination."; return false; }
            if (t.Length > MaxLength) { error = "That key combination is too long."; return false; }
            foreach (char c in t) {
                bool ok = (c < 128 && char.IsLetterOrDigit(c)) || c == '+' || c == ' ';
                if (!ok) { error = "Use only modifier and key names, such as Ctrl+Shift+F9."; return false; }
            }
            string[] parts = t.Split('+');
            uint mods = 0;
            KeyDef key = null;
            for (int i = 0; i < parts.Length; i++) {
                string p = parts[i].Trim();
                if (p.Length == 0) { error = "Each + needs a key or modifier on both sides."; return false; }
                string lower = p.ToLowerInvariant();
                uint bit = 0;
                if (lower == "ctrl" || lower == "control") bit = Control;
                else if (lower == "alt") bit = Alt;
                else if (lower == "shift") bit = Shift;
                if (bit != 0) {
                    if ((mods & bit) != 0) { error = "A modifier is listed twice."; return false; }
                    mods |= bit;
                    continue;
                }
                KeyDef def;
                if (!byName.TryGetValue(p, out def)) { error = "'" + p + "' is not a key Capstan can use."; return false; }
                if (key != null) { error = "Use one key plus modifiers."; return false; }
                key = def;
            }
            if (key == null) { error = "Add a key after the modifiers."; return false; }
            if ((mods & (Control | Alt)) == 0) { error = "Include Ctrl or Alt, so the key still works when you type in other programs."; return false; }
            if ((mods & Control) != 0 && (mods & Alt) != 0 && key.Name == "Delete") { error = "Windows keeps Ctrl+Alt+Delete for itself."; return false; }
            StringBuilder sb = new StringBuilder();
            if ((mods & Control) != 0) sb.Append("Ctrl+");
            if ((mods & Alt) != 0) sb.Append("Alt+");
            if ((mods & Shift) != 0) sb.Append("Shift+");
            sb.Append(key.Name);
            Chord result = new Chord();
            result.Text = sb.ToString();
            result.Modifiers = mods;
            result.KeyCode = key.Code;
            chord = result;
            return true;
        }
    }

    public sealed class EventItem {
        public long Id { get; internal set; }
        public string Name { get; internal set; }
        public long At { get; internal set; }
    }

    // Fixed event names with increasing ids. A page asks for everything after the last id it saw.
    public sealed class EventQueue {
        public static readonly string[] Names = new string[] { "start-stop", "pause-resume", "marker", "tray-open" };
        const int Max = 100;
        readonly object gate = new object();
        readonly List<EventItem> items = new List<EventItem>();
        long last = 0;

        public static bool IsName(string name) { return name != null && Array.IndexOf(Names, name) >= 0; }

        public EventItem Add(string name) {
            if (!IsName(name)) throw new ArgumentException("Unknown event name.");
            lock (gate) {
                last++;
                EventItem item = new EventItem();
                item.Id = last;
                item.Name = name;
                item.At = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                items.Add(item);
                while (items.Count > Max) items.RemoveAt(0);
                return item;
            }
        }

        public EventItem[] Since(long id) {
            lock (gate) {
                List<EventItem> found = new List<EventItem>();
                foreach (EventItem item in items) if (item.Id > id) found.Add(item);
                return found.ToArray();
            }
        }

        public long LastId { get { lock (gate) { return last; } } }
    }

    public sealed class KeyResult {
        public string Action { get; internal set; }
        public string Binding { get; internal set; }
        public bool Registered { get; internal set; }
        public string Reason { get; internal set; }
    }

    public sealed class ConfigResult {
        public bool Ok;
        public string Field;
        public string Error;
    }

    interface IKeyRegistrar {
        // Null when the key is now registered, otherwise the reason it is not.
        string Register(int id, Chord chord);
        void Unregister(int id);
    }

    static class Reasons {
        public const string Clash = "Another program already uses this key combination. Pick a different one.";
    }

    // Used by the test seam and the thread tests: remembers ids, refuses combinations marked as taken.
    sealed class FakeRegistrar : IKeyRegistrar {
        readonly object gate = new object();
        readonly HashSet<string> taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        readonly HashSet<int> held = new HashSet<int>();
        public void MarkTaken(string text) { lock (gate) { taken.Add(text); } }
        public int Held { get { lock (gate) { return held.Count; } } }
        public string Register(int id, Chord chord) {
            lock (gate) {
                if (taken.Contains(chord.Text)) return Reasons.Clash;
                held.Add(id);
                return null;
            }
        }
        public void Unregister(int id) { lock (gate) { held.Remove(id); } }
    }

    sealed class Win32Registrar : IKeyRegistrar {
        [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint vk);
        [DllImport("user32.dll", SetLastError = true)] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        const uint MOD_NOREPEAT = 0x4000;
        readonly IntPtr hwnd;
        public Win32Registrar(IntPtr handle) { hwnd = handle; }
        public string Register(int id, Chord chord) {
            if (RegisterHotKey(hwnd, id, chord.Modifiers | MOD_NOREPEAT, chord.KeyCode)) return null;
            int err = Marshal.GetLastWin32Error();
            if (err == 1409) return Reasons.Clash;
            return "Windows would not register this key combination (error " + err.ToString(CultureInfo.InvariantCulture) + ").";
        }
        public void Unregister(int id) { UnregisterHotKey(hwnd, id); }
    }

    // Brings an existing Capstan browser window to the front. Only Edge and Chrome windows whose title is
    // "Capstan" count, so a folder called Capstan in File Explorer is never touched.
    public static class WindowFinder {
        delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int command);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        public static bool IsCapstanWindow(string title, string processName) {
            if (title == null || processName == null) return false;
            bool browser = string.Equals(processName, "msedge", StringComparison.OrdinalIgnoreCase) || string.Equals(processName, "chrome", StringComparison.OrdinalIgnoreCase);
            if (!browser) return false;
            return title == "Capstan" || title.StartsWith("Capstan - ", StringComparison.Ordinal);
        }

        static IntPtr Find() {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr h, IntPtr l) {
                if (!IsWindowVisible(h)) return true;
                StringBuilder sb = new StringBuilder(256);
                GetWindowText(h, sb, sb.Capacity);
                string title = sb.ToString();
                if (!title.StartsWith("Capstan", StringComparison.Ordinal)) return true;
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                string name = null;
                try { name = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
                if (IsCapstanWindow(title, name)) { found = h; return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        // True when a window was brought forward. With launch, an http://127.0.0.1 address (given by the host
        // itself, never by a request) is opened in the default browser when no window was found.
        public static bool Activate(string url, bool launch) {
            try {
                IntPtr h = Find();
                if (h != IntPtr.Zero) {
                    if (IsIconic(h)) ShowWindow(h, 9);
                    SetForegroundWindow(h);
                    return true;
                }
                if (launch && url != null && url.StartsWith("http://127.0.0.1:", StringComparison.Ordinal)) {
                    ProcessStartInfo info = new ProcessStartInfo(url);
                    info.UseShellExecute = true;
                    Process.Start(info);
                }
            } catch (Exception) { }
            return false;
        }
    }

    // The tray icons come from the FleetHacker tray kit (vendor/fleet-tray): drawn at the tray's real size and
    // handed in by Set-CapstanTrayIcons before the service starts. Each tray gets its own copies. A state with no
    // icon handed in shows Windows' application icon.
    public static class TrayIcons {
        public static readonly string[] States = new string[] { "idle", "recording", "paused" };
        static readonly object gate = new object();
        static readonly Dictionary<string, Icon> supplied = new Dictionary<string, Icon>();

        // Keeps a copy of the icon; the caller still owns the one it passed.
        public static void Use(string state, Icon icon) {
            if (Array.IndexOf(States, state) < 0) throw new ArgumentException("Unknown tray state.");
            if (icon == null) throw new ArgumentNullException("icon");
            Icon copy = (Icon)icon.Clone();
            lock (gate) {
                Icon old;
                if (supplied.TryGetValue(state, out old)) old.Dispose();
                supplied[state] = copy;
            }
        }

        public static bool Has(string state) { lock (gate) { return supplied.ContainsKey(state); } }

        // A new icon the caller owns and disposes.
        public static Icon Copy(string state) {
            lock (gate) {
                Icon icon;
                if (supplied.TryGetValue(state, out icon)) return (Icon)icon.Clone();
            }
            return (Icon)SystemIcons.Application.Clone();
        }
    }

    // A message-only window (HWND_MESSAGE parent): never shown, never in the taskbar, never captured.
    sealed class MessageWindow : NativeWindow {
        const int WM_HOTKEY = 0x0312;
        public const int WM_WORK = 0x8001;
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        readonly UiThread owner;
        public MessageWindow(UiThread thread) {
            owner = thread;
            CreateParams cp = new CreateParams();
            cp.Caption = "CapstanHotkeys";
            cp.Parent = new IntPtr(-3);
            CreateHandle(cp);
        }
        public void Wake() { PostMessage(Handle, WM_WORK, IntPtr.Zero, IntPtr.Zero); }
        protected override void WndProc(ref Message m) {
            try {
                if (m.Msg == WM_HOTKEY) { owner.HotkeyPressed(m.WParam.ToInt32()); return; }
                if (m.Msg == WM_WORK) { owner.DrainWork(); return; }
            } catch (Exception) { }
            base.WndProc(ref m);
        }
    }

    sealed class WorkItem {
        public Action Run;
        public ManualResetEvent Done = new ManualResetEvent(false);
    }

    // The worker thread: STA, background, one message loop.
    sealed class UiThread {
        readonly HotkeyService owner;
        readonly bool showTray;
        readonly bool realKeys;
        readonly object workGate = new object();
        readonly Queue<WorkItem> work = new Queue<WorkItem>();
        readonly ManualResetEvent ready = new ManualResetEvent(false);
        readonly ManualResetEvent closed = new ManualResetEvent(false);
        Thread thread;
        MessageWindow window;
        public string Error;
        bool loopRunning = false;

        // Tray parts, touched only on the worker thread (and once, best effort, in Abandon).
        NotifyIcon tray;
        ContextMenuStrip menu;
        ToolStripMenuItem startItem, pauseItem, openItem, quitItem;
        readonly Dictionary<string, Icon> icons = new Dictionary<string, Icon>();

        public UiThread(HotkeyService svc, bool realKeys, bool showTray) {
            owner = svc;
            this.realKeys = realKeys;
            this.showTray = showTray;
        }

        public bool Alive { get { return thread != null && thread.IsAlive; } }

        public bool Start(int timeoutMs) {
            thread = new Thread(Run);
            thread.Name = "CapstanHotkeys";
            thread.IsBackground = true;
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            if (!ready.WaitOne(timeoutMs)) { Error = "The hotkey thread did not start in time."; return false; }
            return Error == null;
        }

        void Run() {
            try {
                window = new MessageWindow(this);
                IKeyRegistrar registrar = realKeys ? (IKeyRegistrar)new Win32Registrar(window.Handle) : owner.Fake();
                owner.AttachRegistrar(registrar);
                if (showTray) CreateTray();
                loopRunning = true;
                ready.Set();
                Application.Run();
            } catch (Exception ex) {
                Error = ex.GetType().Name + ": " + ex.Message;
                ready.Set();
            } finally {
                loopRunning = false;
                try { owner.UnregisterAll(); } catch (Exception) { }
                DisposeTray();
                try { if (window != null) window.DestroyHandle(); } catch (Exception) { }
                owner.ThreadEnded();
                // Anything still waiting for the loop is released.
                lock (workGate) { while (work.Count > 0) work.Dequeue().Done.Set(); }
                closed.Set();
            }
        }

        public void HotkeyPressed(int id) { owner.HotkeyPressed(id); }

        public void DrainWork() {
            while (true) {
                WorkItem item = null;
                lock (workGate) { if (work.Count > 0) item = work.Dequeue(); }
                if (item == null) return;
                try { item.Run(); } catch (Exception) { }
                item.Done.Set();
            }
        }

        // Runs on the worker thread and waits for it. False when the thread is gone or too slow.
        public bool Invoke(Action action, int timeoutMs) {
            WorkItem item = new WorkItem();
            item.Run = action;
            lock (workGate) {
                if (!loopRunning) return false;
                work.Enqueue(item);
            }
            window.Wake();
            return item.Done.WaitOne(timeoutMs);
        }

        public void Post(Action action) {
            WorkItem item = new WorkItem();
            item.Run = action;
            lock (workGate) {
                if (!loopRunning) return;
                work.Enqueue(item);
            }
            window.Wake();
        }

        // Called on the worker thread by the service to leave the message loop.
        public void Exit() { Application.ExitThread(); }

        public bool Shutdown(int timeoutMs) {
            if (!Alive) return true;
            Post(delegate { Exit(); });
            if (closed.WaitOne(timeoutMs)) return true;
            // The thread is stuck: take the icon away from here so Windows keeps no ghost.
            Abandon();
            return false;
        }

        public void Abandon() {
            try { if (tray != null) { tray.Visible = false; tray.Dispose(); } } catch (Exception) { }
        }

        // ---- tray ----
        void CreateTray() {
            foreach (string state in TrayIcons.States) icons[state] = TrayIcons.Copy(state);
            menu = new ContextMenuStrip();
            startItem = new ToolStripMenuItem("Start recording");
            pauseItem = new ToolStripMenuItem("Pause");
            openItem = new ToolStripMenuItem("Open Capstan");
            quitItem = new ToolStripMenuItem("Quit tray");
            startItem.Click += delegate { Guarded(delegate { owner.TrayStartStop(); }); };
            pauseItem.Click += delegate { Guarded(delegate { owner.TrayPauseResume(); }); };
            openItem.Click += delegate { Guarded(delegate { owner.TrayOpen(); }); };
            quitItem.Click += delegate { Guarded(delegate { owner.TrayQuit(); }); };
            menu.Items.Add(startItem);
            menu.Items.Add(pauseItem);
            menu.Items.Add(openItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(quitItem);
            tray = new NotifyIcon();
            tray.Icon = icons["idle"];
            tray.Text = "Capstan - idle";
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { Guarded(delegate { owner.TrayOpen(); }); };
            tray.Visible = true;
            ShowState(owner.State, owner.BindingText("start-stop"), owner.BindingText("pause-resume"));
        }

        static void Guarded(Action a) { try { a(); } catch (Exception) { } }

        public bool TrayVisible { get { return tray != null && tray.Visible; } }

        // Worker thread only.
        public void ShowState(string state, string startKeys, string pauseKeys) {
            if (tray == null) return;
            Icon icon;
            if (icons.TryGetValue(state, out icon)) tray.Icon = icon;
            tray.Text = "Capstan - " + state;
            bool active = state != "idle";
            startItem.Text = active ? "Stop recording" : "Start recording";
            startItem.ShortcutKeyDisplayString = startKeys;
            pauseItem.Text = state == "paused" ? "Resume" : "Pause";
            pauseItem.Enabled = active;
            pauseItem.ShortcutKeyDisplayString = pauseKeys;
        }

        void DisposeTray() {
            try { if (tray != null) { tray.Visible = false; tray.Dispose(); tray = null; } } catch (Exception) { }
            try { if (menu != null) { menu.Dispose(); menu = null; } } catch (Exception) { }
            foreach (Icon i in icons.Values) { try { i.Dispose(); } catch (Exception) { } }
            icons.Clear();
        }
    }

    public sealed class HotkeyService : IDisposable {
        public static readonly string[] Actions = new string[] { "start-stop", "pause-resume", "marker" };
        static readonly string[] DefaultBindings = new string[] { "Ctrl+Shift+F9", "Ctrl+Shift+F10", "Ctrl+Shift+F11" };

        public readonly EventQueue Events = new EventQueue();
        readonly object gate = new object();
        readonly string openUrl;
        readonly bool realKeys;
        readonly bool showTray;
        readonly bool useThread;
        readonly FakeRegistrar fake;
        IKeyRegistrar registrar;
        UiThread ui;
        Dictionary<string, string> bindings = new Dictionary<string, string>();
        List<KeyResult> results = new List<KeyResult>();
        // Ids registered with the registrar; touched only on the thread that owns it.
        readonly List<int> registeredIds = new List<int>();
        string state = "idle";
        bool started = false;
        bool running = false;
        bool stopped = false;
        string startError = null;
        string note = null;
        EventHandler exitHandler;

        // realKeys: call RegisterHotKey. showTray: create the NotifyIcon. useThread: run on a worker thread.
        // The host passes all three true, or all three false in the CAPSTAN_TEST_HOTKEYS=1 seam.
        // Tests use (false, false, true) to exercise the thread and message window without any real key or icon.
        public HotkeyService(string openUrl, bool realKeys, bool showTray, bool useThread) {
            if (realKeys && !useThread) throw new ArgumentException("Real keys need the worker thread.");
            if (showTray && !useThread) throw new ArgumentException("The tray icon needs the worker thread.");
            this.openUrl = openUrl;
            this.realKeys = realKeys;
            this.showTray = showTray;
            this.useThread = useThread;
            if (!realKeys) fake = new FakeRegistrar();
            for (int i = 0; i < Actions.Length; i++) bindings[Actions[i]] = DefaultBindings[i];
        }

        public static string DefaultBinding(string action) {
            int i = Array.IndexOf(Actions, action);
            return i < 0 ? null : DefaultBindings[i];
        }

        internal FakeRegistrar Fake() { return fake; }
        internal void AttachRegistrar(IKeyRegistrar r) { registrar = r; }

        // True in the CAPSTAN_TEST_HOTKEYS=1 seam and in thread tests: no real key is ever registered.
        public bool Simulated { get { return !realKeys; } }
        public bool Threaded { get { return useThread; } }
        public bool Running { get { lock (gate) { return running; } } }
        public string StartError { get { return startError; } }
        public string Note { get { lock (gate) { return note; } } }
        public string State { get { lock (gate) { return state; } } }
        public bool TrayVisible { get { UiThread u = ui; return u != null && u.TrayVisible; } }
        public int HeldKeys { get { return fake == null ? -1 : fake.Held; } }
        public bool ThreadAlive { get { UiThread u = ui; return u != null && u.Alive; } }

        public string BindingText(string action) {
            lock (gate) { string b; return bindings.TryGetValue(action, out b) ? b : ""; }
        }

        public bool Start() {
            lock (gate) {
                if (started) return running;
                started = true;
            }
            if (useThread) {
                UiThread u = new UiThread(this, realKeys, showTray);
                if (!u.Start(8000)) {
                    startError = u.Error ?? "The hotkey thread could not start.";
                    u.Shutdown(1000);
                    return false;
                }
                ui = u;
                lock (gate) { running = true; }
                exitHandler = new EventHandler(delegate(object s, EventArgs e) { QuickExit(); });
                AppDomain.CurrentDomain.ProcessExit += exitHandler;
            } else {
                lock (gate) { running = true; }
            }
            RunOwner(ApplyAll);
            return true;
        }

        // Runs on the thread that owns the registrar (inline when there is no worker thread).
        bool RunOwner(Action action) {
            UiThread u = ui;
            if (u == null) {
                if (useThread) return false;
                action();
                return true;
            }
            return u.Invoke(action, 5000);
        }

        void ApplyAll() {
            IKeyRegistrar r = registrar ?? fake;
            if (r == null) return;
            UnregisterAll();
            Dictionary<string, string> want;
            lock (gate) { want = new Dictionary<string, string>(bindings); }
            List<KeyResult> fresh = new List<KeyResult>();
            for (int i = 0; i < Actions.Length; i++) {
                KeyResult kr = new KeyResult();
                kr.Action = Actions[i];
                kr.Binding = want[Actions[i]];
                Chord chord;
                string error;
                if (!Chords.TryParse(kr.Binding, out chord, out error)) {
                    kr.Registered = false;
                    kr.Reason = error;
                } else {
                    string reason = r.Register(i + 1, chord);
                    kr.Registered = reason == null;
                    kr.Reason = reason ?? "";
                    if (reason == null) registeredIds.Add(i + 1);
                }
                if (kr.Reason == null) kr.Reason = "";
                fresh.Add(kr);
            }
            lock (gate) { results = fresh; }
            RefreshTray();
        }

        // Owner thread only.
        internal void UnregisterAll() {
            IKeyRegistrar r = registrar ?? fake;
            if (r != null) foreach (int id in registeredIds) { try { r.Unregister(id); } catch (Exception) { } }
            registeredIds.Clear();
        }

        public KeyResult[] Results() { lock (gate) { return results.ToArray(); } }

        // Validates every given binding, then applies them together. Anything invalid changes nothing.
        public ConfigResult Configure(IDictionary<string, string> wanted) {
            ConfigResult r = new ConfigResult();
            if (!Running) { r.Ok = false; r.Field = ""; r.Error = "Hotkeys are not running."; return r; }
            Dictionary<string, string> merged;
            lock (gate) { merged = new Dictionary<string, string>(bindings); }
            foreach (KeyValuePair<string, string> kv in wanted) {
                if (Array.IndexOf(Actions, kv.Key) < 0) { r.Ok = false; r.Field = ""; r.Error = "Unknown hotkey action."; return r; }
                Chord chord;
                string error;
                if (!Chords.TryParse(kv.Value, out chord, out error)) { r.Ok = false; r.Field = kv.Key; r.Error = error; return r; }
                merged[kv.Key] = chord.Text;
            }
            for (int i = 0; i < Actions.Length; i++) {
                for (int j = i + 1; j < Actions.Length; j++) {
                    if (string.Equals(merged[Actions[i]], merged[Actions[j]], StringComparison.OrdinalIgnoreCase)) {
                        r.Ok = false; r.Field = wanted.ContainsKey(Actions[j]) ? Actions[j] : Actions[i];
                        r.Error = "Two Capstan actions cannot share a key combination.";
                        return r;
                    }
                }
            }
            lock (gate) { bindings = merged; }
            RunOwner(ApplyAll);
            r.Ok = true;
            return r;
        }

        public bool SetState(string value) {
            if (value != "idle" && value != "recording" && value != "paused") return false;
            lock (gate) { state = value; }
            RefreshTray();
            return true;
        }

        void RefreshTray() {
            UiThread u = ui;
            if (u == null) return;
            string s = State;
            string a = BindingText("start-stop");
            string b = BindingText("pause-resume");
            u.Post(delegate { u.ShowState(s, a, b); });
        }

        // Test seam only: the host exposes this through /api/hotkeys/test-inject when CAPSTAN_TEST_HOTKEYS=1.
        public EventItem Inject(string name) { return Events.Add(name); }

        // Simulated mode only: pretend another program owns this combination, then register again.
        public bool SimulateClash(string text) {
            if (fake == null) return false;
            Chord chord;
            string error;
            if (!Chords.TryParse(text, out chord, out error)) return false;
            fake.MarkTaken(chord.Text);
            RunOwner(ApplyAll);
            return true;
        }

        // ---- worker-thread callbacks ----
        internal void HotkeyPressed(int id) {
            if (id < 1 || id > Actions.Length) return;
            Events.Add(Actions[id - 1]);
        }
        internal void TrayStartStop() {
            Events.Add("start-stop");
            // Starting needs a click in Capstan (the browser's share picker), so bring its window forward.
            if (State == "idle") WindowFinder.Activate(openUrl, false);
        }
        internal void TrayPauseResume() { Events.Add("pause-resume"); }
        internal void TrayOpen() {
            Events.Add("tray-open");
            WindowFinder.Activate(openUrl, true);
        }
        internal void TrayQuit() {
            lock (gate) { note = "The tray was closed from its menu. Restart Capstan to bring the hotkeys back."; running = false; }
            UiThread u = ui;
            if (u != null) u.Exit();
        }
        internal void ThreadEnded() { lock (gate) { running = false; } }

        void QuickExit() {
            UiThread u = ui;
            if (u != null) u.Abandon();
        }

        // Unregisters every key, removes the tray icon, ends the thread. Safe to call twice.
        public void Stop() {
            lock (gate) {
                if (stopped) return;
                stopped = true;
                running = false;
            }
            if (exitHandler != null) { try { AppDomain.CurrentDomain.ProcessExit -= exitHandler; } catch (Exception) { } }
            UiThread u = ui;
            if (u != null) u.Shutdown(4000);
            else UnregisterAll();
        }

        public void Dispose() { Stop(); }
    }
}
'@
}

# ---------------------------------------------------------------------------------------------
# Host side
# ---------------------------------------------------------------------------------------------
# Tray icons: the FleetHacker tray kit (vendor/fleet-tray, edge-ops ui-kit/tray) draws a C tile at the tray's
# size for this display, so the icon is crisp at 16, 20 or 24 px. Get-FleetTrayIcon compiles it on first use.
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'vendor/fleet-tray/FleetTray.ps1')
$script:CapstanTrayFallback = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets/brand/tray.ico'
$script:CapstanHotkeysNote = ''
$script:CapstanParkedPolls = New-Object System.Collections.ArrayList
$script:CapstanMaxParkedPolls = 8
$script:CapstanLongPollMaxSeconds = 25
# SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) only works on windows owned by the calling process, and the host
# is powershell.exe while the Capstan window belongs to Edge. So the host cannot keep Capstan out of a capture, and says so.
$script:CapstanCaptureExclusion = [ordered]@{
    possible = $false
    reason = 'Capstan cannot hide its own window from a screen capture. Windows only lets a program hide windows that belong to that program, and Capstan''s window belongs to your browser. To keep Capstan out of the recording, record a browser tab or a single window (the default here) instead of the entire screen.'
}

function Test-CapstanHotkeyTestMode {
    # CAPSTAN_TEST_HOTKEYS=1: no real key, no tray icon, no thread; test-inject is available.
    return ($env:CAPSTAN_TEST_HOTKEYS -eq '1')
}

function Test-CapstanHotkeysEnabled {
    # CAPSTAN_HOTKEYS=0 (or false/no/off) turns hotkeys and the tray off.
    $v = $env:CAPSTAN_HOTKEYS
    if ($null -eq $v) { return $true }
    return -not ($v.Trim() -match '^(0|false|no|off)$')
}

function Set-CapstanTrayIcons {
    <#
      Hands the kit's icons to the service: idle is the plain C tile, recording has a red badge and paused an
      amber one. If the kit cannot be compiled here, Capstan's own tray.ico is used for every state.
    #>
    foreach ($pair in @(@('idle', ''), @('recording', 'bad'), @('paused', 'busy'))) {
        $icon = Get-FleetTrayIcon -App capstan -Status $pair[1] -FallbackPath $script:CapstanTrayFallback
        try { [Capstan.Hotkeys.TrayIcons]::Use($pair[0], $icon) }
        finally { if (-not [object]::ReferenceEquals($icon, [System.Drawing.SystemIcons]::Application)) { $icon.Dispose() } }
    }
}

function New-CapstanHotkeyService {
    <# Starts the service. Returns $null (and sets $script:CapstanHotkeysNote) when hotkeys are off or cannot start. #>
    param([string]$OpenUrl = '')
    $script:CapstanHotkeysNote = ''
    if (-not (Test-CapstanHotkeysEnabled)) { $script:CapstanHotkeysNote = 'Hotkeys are turned off (CAPSTAN_HOTKEYS=0 or -no-hotkeys).'; return $null }
    try {
        $real = -not (Test-CapstanHotkeyTestMode)
        # A missing icon never stops the hotkeys: the tray then shows the application icon.
        if ($real) { try { Set-CapstanTrayIcons } catch { Write-Verbose ('Tray icons: ' + $_.Exception.Message) } }
        $svc = New-Object Capstan.Hotkeys.HotkeyService -ArgumentList $OpenUrl, $real, $real, $real
        if (-not $svc.Start()) {
            $script:CapstanHotkeysNote = 'The hotkey thread could not start.'
            Write-Warning ('Hotkeys unavailable: ' + $svc.StartError)
            return $null
        }
        return $svc
    } catch {
        $script:CapstanHotkeysNote = 'Hotkeys could not start on this computer.'
        Write-Warning ('Hotkeys unavailable: ' + $_.Exception.Message)
        return $null
    }
}

function Stop-CapstanHotkeyService {
    param($Service)
    # Parked long polls get an empty answer so the page does not wait on a dead socket.
    Complete-CapstanParkedPolls -Service $Service -Flush
    if ($null -ne $Service) { try { $Service.Stop() } catch { } }
}

function Write-CapstanHotkeySummary {
    param($Service)
    if ($null -eq $Service) {
        if ($script:CapstanHotkeysNote) { Write-Host ('Hotkeys: ' + $script:CapstanHotkeysNote) -ForegroundColor DarkGray }
        return
    }
    if ($Service.Simulated) { Write-Host 'Hotkeys: test mode (CAPSTAN_TEST_HOTKEYS=1). No key is registered and there is no tray icon.' -ForegroundColor Yellow; return }
    $labels = @{ 'start-stop' = 'start or stop'; 'pause-resume' = 'pause or resume'; 'marker' = 'marker' }
    foreach ($r in @($Service.Results())) {
        if ($r.Registered) { Write-Host ('Hotkey ' + $r.Binding + ': ' + $labels[$r.Action]) -ForegroundColor DarkGray }
        else { Write-Host ('Hotkey ' + $r.Binding + ' (' + $labels[$r.Action] + ') is not active: ' + $r.Reason) -ForegroundColor Yellow }
    }
}

function Test-CapstanTokenEqual {
    # Constant-time comparison, so the check does not leak how many leading characters matched.
    param([string]$Given, [string]$Expected)
    if ($null -eq $Given -or $null -eq $Expected) { return $false }
    $a = [Text.Encoding]::UTF8.GetBytes($Given)
    $b = [Text.Encoding]::UTF8.GetBytes($Expected)
    $diff = $a.Length -bxor $b.Length
    $n = [Math]::Max($a.Length, $b.Length)
    for ($i = 0; $i -lt $n; $i++) {
        $x = 0; $y = 0
        if ($i -lt $a.Length) { $x = $a[$i] }
        if ($i -lt $b.Length) { $y = $b[$i] }
        $diff = $diff -bor ($x -bxor $y)
    }
    return ($diff -eq 0)
}

function Get-CapstanHotkeyStatus {
    param($Service)
    $actions = @('start-stop', 'pause-resume', 'marker')
    if ($null -eq $Service) {
        $defaults = [ordered]@{}
        foreach ($a in $actions) { $defaults[$a] = [Capstan.Hotkeys.HotkeyService]::DefaultBinding($a) }
        return [ordered]@{
            available = $false; running = $false; test = $false; state = 'idle'; last = 0; trayVisible = $false
            reason = [string]$script:CapstanHotkeysNote
            registered = @(); failed = @(); bindings = $defaults; keys = @(); captureExclusion = $script:CapstanCaptureExclusion
            allowed = [ordered]@{ modifiers = @([Capstan.Hotkeys.Chords]::ModifierNames()); keys = @([Capstan.Hotkeys.Chords]::KeyNames()) }
        }
    }
    $bindings = [ordered]@{}
    $registered = New-Object System.Collections.ArrayList
    $failed = New-Object System.Collections.ArrayList
    $keys = New-Object System.Collections.ArrayList
    foreach ($r in @($Service.Results())) {
        $bindings[$r.Action] = $r.Binding
        [void]$keys.Add([ordered]@{ action = $r.Action; binding = $r.Binding; registered = [bool]$r.Registered; reason = [string]$r.Reason })
        if ($r.Registered) { [void]$registered.Add($r.Action) }
        else { [void]$failed.Add([ordered]@{ action = $r.Action; binding = $r.Binding; reason = [string]$r.Reason }) }
    }
    if ($bindings.Count -eq 0) { foreach ($a in $actions) { $bindings[$a] = $Service.BindingText($a) } }
    $reason = ''
    if (-not $Service.Running) { $reason = [string]$Service.Note }
    return [ordered]@{
        available = $true
        running = [bool]$Service.Running
        test = [bool]$Service.Simulated
        state = [string]$Service.State
        last = [long]$Service.Events.LastId
        trayVisible = [bool]$Service.TrayVisible
        reason = $reason
        registered = @($registered)
        failed = @($failed)
        bindings = $bindings
        keys = @($keys)
        captureExclusion = $script:CapstanCaptureExclusion
        allowed = [ordered]@{ modifiers = @([Capstan.Hotkeys.Chords]::ModifierNames()); keys = @([Capstan.Hotkeys.Chords]::KeyNames()) }
    }
}

function New-CapstanHotkeyEventsPayload {
    param($Service, [long]$Since)
    $list = New-Object System.Collections.ArrayList
    $last = [long]0
    if ($null -ne $Service) {
        foreach ($e in @($Service.Events.Since($Since))) { [void]$list.Add([ordered]@{ id = [long]$e.Id; name = [string]$e.Name; at = [long]$e.At }) }
        $last = [long]$Service.Events.LastId
    }
    return [ordered]@{ events = @($list); last = $last }
}

function Read-CapstanHotkeyBody {
    # Small JSON object bodies only (at most 4 KB). Returns @{ Ok; Body; Status; Error }.
    param($Request)
    $type = [string]$Request.Headers['Content-Type']
    if ($type -notmatch '^application/json\s*(;.*)?$') { return @{ Ok = $false; Status = 415; Error = 'Send application/json' } }
    if ($Request.ContentLength64 -gt 4096) { return @{ Ok = $false; Status = 413; Error = 'Request body too large' } }
    if ($Request.ContentLength64 -le 0) { return @{ Ok = $false; Status = 400; Error = 'A JSON body is required' } }
    $reader = New-Object System.IO.StreamReader -ArgumentList $Request.InputStream, ([Text.Encoding]::UTF8)
    try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
    try { $body = $text | ConvertFrom-Json } catch { return @{ Ok = $false; Status = 400; Error = 'The body is not valid JSON' } }
    if ($null -eq $body -or $body -isnot [pscustomobject]) { return @{ Ok = $false; Status = 400; Error = 'The body must be a JSON object' } }
    return @{ Ok = $true; Body = $body }
}

function Invoke-CapstanHotkeyApi {
    <#
      Handles /api/hotkeys/*. Returns @{ Status; Payload } for an immediate answer, or @{ Park = $true; Since; Seconds }
      for a long poll that has to wait: the host loop keeps that connection open and answers it later, so a wait of
      up to 25 s never blocks other requests (the host handles one request at a time).
      The caller has already done the Host, Origin and token checks; the token is checked again here in
      constant time, so these routes are safe on their own.
    #>
    param($Service, $Request, [string]$SessionToken)
    $path = $Request.Url.AbsolutePath
    $method = $Request.HttpMethod
    if (-not (Test-CapstanTokenEqual -Given ([string]$Request.Headers['X-Capstan-Token']) -Expected $SessionToken)) {
        return @{ Status = 403; Payload = @{ error = 'Invalid session' } }
    }
    $notFound = @{ Status = 404; Payload = @{ error = 'Route not found' } }
    $wrongMethod = @{ Status = 405; Payload = @{ error = 'Method not allowed' } }
    $noService = @{ Status = 409; Payload = @{ error = 'Hotkeys are not available in this host' } }

    switch -CaseSensitive ($path) {
        '/api/hotkeys/status' {
            if ($method -ne 'GET') { return $wrongMethod }
            return @{ Status = 200; Payload = (Get-CapstanHotkeyStatus -Service $Service) }
        }
        '/api/hotkeys/events' {
            if ($method -ne 'GET') { return $wrongMethod }
            if ($null -eq $Service) { return $noService }
            $q = $Request.QueryString
            $sinceText = [string]$q['since']
            $waitText = [string]$q['wait']
            [long]$since = 0
            $wait = 0
            if ($sinceText -ne '') {
                if ($sinceText -notmatch '^[0-9]{1,15}$') { return @{ Status = 400; Payload = @{ error = 'since must be a whole number' } } }
                $since = [long]$sinceText
            }
            if ($waitText -ne '') {
                if ($waitText -notmatch '^[0-9]{1,3}$') { return @{ Status = 400; Payload = @{ error = 'wait must be a whole number of seconds' } } }
                $wait = [Math]::Min([int]$waitText, $script:CapstanLongPollMaxSeconds)
            }
            $payload = New-CapstanHotkeyEventsPayload -Service $Service -Since $since
            if (@($payload.events).Count -gt 0 -or $wait -le 0 -or -not $Service.Running) {
                return @{ Status = 200; Payload = $payload }
            }
            return @{ Park = $true; Since = $since; Seconds = $wait }
        }
        '/api/hotkeys/config' {
            if ($method -ne 'PUT') { return $wrongMethod }
            if ($null -eq $Service) { return $noService }
            $read = Read-CapstanHotkeyBody -Request $Request
            if (-not $read.Ok) { return @{ Status = $read.Status; Payload = @{ error = $read.Error } } }
            $given = $read.Body.PSObject.Properties['bindings']
            if ($null -eq $given -or $given.Value -isnot [pscustomobject]) { return @{ Status = 400; Payload = @{ error = 'Send {"bindings": {"start-stop": "Ctrl+Shift+F9"}}' } } }
            $wanted = New-Object 'System.Collections.Generic.Dictionary[string,string]'
            foreach ($p in $given.Value.PSObject.Properties) {
                if ($p.Value -isnot [string]) { return @{ Status = 400; Payload = @{ error = 'Each binding must be text'; field = '' } } }
                $wanted[[string]$p.Name] = [string]$p.Value
            }
            if ($wanted.Count -eq 0) { return @{ Status = 400; Payload = @{ error = 'No bindings were given' } } }
            $result = $Service.Configure($wanted)
            if (-not $result.Ok) {
                $status = 400
                if (-not $Service.Running) { $status = 409 }
                return @{ Status = $status; Payload = @{ error = [string]$result.Error; field = [string]$result.Field } }
            }
            return @{ Status = 200; Payload = (Get-CapstanHotkeyStatus -Service $Service) }
        }
        '/api/hotkeys/state' {
            if ($method -ne 'POST') { return $wrongMethod }
            if ($null -eq $Service) { return $noService }
            $read = Read-CapstanHotkeyBody -Request $Request
            if (-not $read.Ok) { return @{ Status = $read.Status; Payload = @{ error = $read.Error } } }
            $value = $read.Body.PSObject.Properties['state']
            if ($null -eq $value -or $value.Value -isnot [string] -or -not $Service.SetState([string]$value.Value)) {
                return @{ Status = 400; Payload = @{ error = 'state must be idle, recording or paused' } }
            }
            return @{ Status = 200; Payload = @{ ok = $true; state = [string]$Service.State } }
        }
        '/api/hotkeys/test-inject' {
            # The test seam. Without CAPSTAN_TEST_HOTKEYS=1 this route does not exist.
            if (-not (Test-CapstanHotkeyTestMode) -or $null -eq $Service -or -not $Service.Simulated) { return $notFound }
            if ($method -ne 'POST') { return $wrongMethod }
            $read = Read-CapstanHotkeyBody -Request $Request
            if (-not $read.Ok) { return @{ Status = $read.Status; Payload = @{ error = $read.Error } } }
            $eventProp = $read.Body.PSObject.Properties['event']
            $clashProp = $read.Body.PSObject.Properties['clash']
            if ($null -ne $clashProp) {
                if ($clashProp.Value -isnot [string] -or -not $Service.SimulateClash([string]$clashProp.Value)) {
                    return @{ Status = 400; Payload = @{ error = 'clash must be a valid key combination' } }
                }
                return @{ Status = 200; Payload = (Get-CapstanHotkeyStatus -Service $Service) }
            }
            if ($null -eq $eventProp -or $eventProp.Value -isnot [string] -or -not [Capstan.Hotkeys.EventQueue]::IsName([string]$eventProp.Value)) {
                return @{ Status = 400; Payload = @{ error = 'event must be start-stop, pause-resume, marker or tray-open' } }
            }
            $item = $Service.Inject([string]$eventProp.Value)
            return @{ Status = 200; Payload = @{ ok = $true; id = [long]$item.Id; name = [string]$item.Name } }
        }
    }
    return $notFound
}

function Add-CapstanParkedPoll {
    <# Holds a long poll open. The caller must NOT dispose the context; Complete-CapstanParkedPolls does. #>
    param($Context, [long]$Since, [int]$Seconds)
    while ($script:CapstanParkedPolls.Count -ge $script:CapstanMaxParkedPolls) {
        # Too many (stale polls from closed pages): the oldest gets an empty answer now.
        $old = $script:CapstanParkedPolls[0]
        $script:CapstanParkedPolls.RemoveAt(0)
        Send-CapstanParkedPoll -Poll $old -Payload ([ordered]@{ events = @(); last = [long]0 })
    }
    [void]$script:CapstanParkedPolls.Add(@{ Context = $Context; Since = $Since; Deadline = [DateTime]::UtcNow.AddSeconds($Seconds) })
}

function Send-CapstanParkedPoll {
    # Needs Send-Json from Start-Capstan.ps1 (same script scope).
    param($Poll, $Payload)
    try { Send-Json $Poll.Context $Payload 200 } catch { } finally { try { $Poll.Context.Dispose() } catch { } }
}

function Complete-CapstanParkedPolls {
    <# Answers parked long polls that have events or ran out of time. -Flush answers all of them (host stopping). #>
    param($Service, [switch]$Flush)
    for ($i = $script:CapstanParkedPolls.Count - 1; $i -ge 0; $i--) {
        $poll = $script:CapstanParkedPolls[$i]
        $payload = New-CapstanHotkeyEventsPayload -Service $Service -Since $poll.Since
        $ready = (@($payload.events).Count -gt 0) -or ([DateTime]::UtcNow -ge $poll.Deadline) -or $Flush -or ($null -eq $Service) -or (-not $Service.Running)
        if ($ready) {
            $script:CapstanParkedPolls.RemoveAt($i)
            Send-CapstanParkedPoll -Poll $poll -Payload $payload
        }
    }
}
