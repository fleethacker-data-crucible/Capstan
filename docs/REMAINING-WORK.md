# Remaining work

What is left after the roadmap reached 57.5 of 67 rows (85.8%). [ROADMAP.md](ROADMAP.md) has the row-by-row status; this page says what each open row needs, in what order, and how to tell it is done. A row is ticked only when code and a passing test back it.

Score if each group lands: Group A takes the roadmap to **61.5 of 67 (91.8%)**; Group B takes it to **67 of 67**.

## Group A: host-side capture and hotkeys (+4.0 rows, reaches 90%)

A browser cannot read the cursor or the keyboard while it records another app, and it cannot register a global hotkey. The PowerShell host can, with C# compiled from source through `Add-Type` (no DLLs, no installs, no admin rights; see [TechStack.md](../TechStack.md)). SnapShackle already has the `RegisterHotKey` and tray code to port.

| Row | Now | Needed | Done when |
| --- | --- | --- | --- |
| Global hotkeys, tray, studio not in the shot | not built | Host component: global start, stop and pause hotkeys, a tray icon, and keeping the Capstan window out of a screen or window capture. Hotkeys are configurable and fail clearly if another program holds them. | Pester tests in `tests/ps` for registration and release; the record e2e starts and stops through the host's endpoint with the synthetic capture stub; hand test on a real desktop. |
| Cursor data (position, clicks, keys) | file format and import only | Host component: while a recording runs, log the cursor position about 60 times a second, button events and key events with timestamps, and write `<recording>.cursor.json` ([format](cursor-data.md)). Started and stopped by the recorder through a token-checked host endpoint. Recording then asks the browser to hide the OS cursor (`cursor: 'never'`, already an option) so Capstan re-draws it. | Unit tests for the writer and for clock alignment with the recording; a Pester test with synthetic input injected by the test; the recorder attaches the file to the media automatically; hand test on a real desktop. |
| Cursor smoothing, highlight, magnify, click effects (3 rows), smart focus, keystroke callouts | work from a cursor file | Nothing new to build once cursor data exists; re-check each against real capture and tick them. | Each row's own e2e still passes, and a recording with real captured data shows the effects aligned within one frame. |

Privacy: key capture must be opt-in per recording, show a visible indicator while it runs, record key names only for the shortcut and key-callout feature (not typed text streams), and never write outside the recording's own folder. The Researcher reviews the host listener and the hook before it ships.

## Group B: the last 5.5 rows

| Row | Rows | Needed | Notes |
| --- | --- | --- | --- |
| Speech-to-text | 1.0 | Windows speech recognition through WinRT from PowerShell, as SnapShackle does OCR; a host endpoint that takes a media file and returns timed text; a "Transcribe" action that creates captions. Optional later: a bundled WASM model. | Needs no network. Quality depends on the installed Windows speech pack: say so in the UI. |
| Library on disk | 0.5 | Token-checked, chunked file transfer in `modules/LocalHttp.ps1` (today it reads whole request bodies into memory with a 30 MB cap, one request at a time), then move the media library to `%LOCALAPPDATA%\Capstan` so it survives port changes and browser resets. | Needs Pester coverage and the Researcher's verdict. |
| Import SnapShackle captures | 0.5 | Host read access to `%LOCALAPPDATA%\SnapShackle\Captures` (older installs: `CutterMk`, `Lasso`), listed and imported on request. | Same host work as the library. |
| Project file (`.capstan`) | 0.5 | Decide: either the plain file stays edit-only and `.capstanz` is the portable form (then document it and tick), or `.capstan` references the on-disk library. | A decision, not much code. |
| Fast export | 0.5 | Fragmented MP4, AV1 and HEVC demux and decode. | Low value: H.264 in MP4 and VP8/VP9 in WebM already take the fast path. |
| WebGL2 compositor | 0.5 | Replace the Canvas 2D compositor with WebGL2 when effects are on, same API. | Low value: effects already work through a WebGL2 pass. |
| Background removal (webcam) | 1.0 | An on-device segmentation model run as WASM; settle the model file size and licence first. | Skip until after the event. |
| Interactive player (quizzes, hotspots, TOC) | 1.0 | A static HTML player bundle. | Overlaps Scrimshaw; decide where it lives before building. |

## Command-line and API parity (not a roadmap row)

The Fleet CLI parity proposal in the comms repo asks that every GUI action is also a `capstan <noun> <verb>` command with `--json`, `--out`, `--yes`, `--dry-run`, `commands --json` and exit codes 0, 1 and 2, as in PacketRat's and Bowerbird's `docs/CLI.md`.

Capstan's engine is TypeScript that runs in the browser, and the Windows PC has no Node or Bun, so the design is a command bridge:

1. **Command registry** in `src/engine`: each GUI action becomes a named function over plain data. The existing editing operations are already pure functions of a project, and the recording, export and package code was written with plain-data requests so they can be wrapped. UI handlers call the registry, and a unit test fails if a UI file calls an operation directly.
2. **File-based projects.** CLI work uses `.capstan` and `.capstanz` files with a published JSON schema and version, not the browser's IndexedDB.
3. **Host bridge.** `Capstan-CLI.bat` runs a PowerShell script that talks to the loopback host; the host hands each command to a Capstan page (a hidden Edge window when none is open) and returns the result. Needs chunked file transfer (shared with the library work), a per-session token file under `%LOCALAPPDATA%\Capstan` with a current-user ACL, Host and Origin checks, no CORS, and `confirm` for destructive commands.
4. **Limits to state plainly.** Screen capture needs the browser's share picker, so a CLI `record` depends on Edge's capture-selection options and a hand test; everything that works on files (edit, effects, captions, export, package) can run without a person.
5. **Parity test in CI** that fails when a GUI action has no command or a command has no test, and a Pester suite for the CLI.
6. **Docs:** `docs/CLI.md` with the command table and the schema.

## Before any of this ships

- Hand tests listed in each of the open pull requests: real microphone, system audio and webcam; a real window, tab and screen share; detached audio in a real export; the WebGL2 path on real GPU hardware; the native Save and folder pickers; long exports for flat memory; killing the browser mid-recording to check recovery; both themes.
- Researcher review for every new listener or hook (host endpoints, key capture).
- Release timing: the team code freeze is Nov 4, 2026 at 12:00 ET; after that, changes to existing repos need the Chief of Staff's approval.

## Suggested order

1. Merge the open pull requests (#16 to #20) after CI and the hand tests.
2. Command registry and the CLI bridge, because the demo pipeline wants to drive Capstan from scripts.
3. Group A (hotkeys and cursor capture).
4. Speech-to-text, then the library and SnapShackle import together.
5. Leave background removal and the interactive player until after the event.
