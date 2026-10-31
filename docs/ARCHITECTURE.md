# Capstan architecture

```
Launch-Capstan.bat ──► Start-Capstan.ps1 (PowerShell 5.1)
                  └─ modules/LocalHttp.ps1  TcpListener on 127.0.0.1, port fallback
                       serves dist/ (allowlist) + /api/health, /api/heartbeat,
                       /api/session/stop (session token)
                  └─ modules/Lifecycle.ps1  presence rule, runtime file, Stop-Capstan.ps1
                  └─ modules/Hotkeys.ps1    global hotkeys + tray icon on their own thread,
                       /api/hotkeys/* (status, config, events long poll, state)
                                │
                                ▼
                 Edge app window: dist/assets/app.js (React 19)
  ┌───────────────────────────────────────────────────────────────────────┐
  │ src/ui/      React panels: media bin, preview, inspector, timeline,    │
  │              record and export dialogs. Never renders per frame.       │
  │                                │ pure edits                            │
  │ src/engine/  project.ts  data model (tracks, clips, media)             │
  │              ops.ts      move / trim / split / delete … (pure)         │
  │              history.ts  undo/redo snapshots                           │
  │              compositor.ts  draws one frame of the timeline            │
  │              player.ts   preview clock + media element sync            │
  │              export.ts   frame-by-frame render → WebCodecs encoders    │
  │              mp4/muxer.ts  ISO-BMFF writer (H.264 + AAC/Opus)          │
  │              recorder.ts getDisplayMedia + MediaRecorder               │
  │              media.ts    import probing, thumbnails                    │
  │              storage.ts  IndexedDB: media Blobs, project JSON          │
  └───────────────────────────────────────────────────────────────────────┘
```

## Principles

- **The project is plain data, and every edit is a pure function.** `ops.ts` takes a project and returns a new one. Undo is a stack of references, edits are unit-tested without a browser, and the same model can later be saved to disk or shared.
- **One compositor for preview and export.** `drawFrame()` renders the timeline at a time `t`. The preview calls it on every animation frame; export calls it once per output frame after seeking each video to that exact time. What you see is what you get.
- **React drives panels, not pixels.** Dragging a clip calls `editor.preview()` (no undo entry); letting go calls `editor.commit()` once. Playback runs in `Player` on `requestAnimationFrame`.
- **Clips never overlap on a track.** Moves and trims are clamped to free gaps (`fitOnTrack`). Layering is done with tracks: the last track is drawn on top.
- **Blur regions and captions sit above every track.** `project.redactions` and `project.captions` are plain lists; `drawFrame()` applies active regions after all clips (blur with the canvas filter, or pixelate, which is also the fallback where canvas filters are missing, so a region is never left clear) and draws the active caption last. Export takes `captions: false` to leave them out.

## Extension points

Each feature area plugs into the same few places, so areas can be built side by side.

| Area | Model (`src/engine`) | Drawn by | Edited in |
| --- | --- | --- | --- |
| Keyframes, behaviors | `anim.ts` (`Keys`, `resolveProps`), `behaviors.ts` | `compositor.ts` resolves every clip and annotation | `inspector/AnimationSection`, `decor/KeyframeMarks` |
| Annotations | `annotations.ts` (`project.annotations`) | `drawAnnotations` after blur regions | `tools/annotationTool`, `inspector/AnnotationPanel`, `panels/AnnotationsPanel`, `lanes/annotationLane` |
| Zoom-n-pan | `zoom.ts` (`project.zooms`, `cameraAt`) | `drawFrame` renders the content, then the camera's window of it | `tools/zoomTool`, `inspector/ZoomPanel`, `lanes/zoomLane` |
| Transitions | `transitions.ts` (`clip.transitionIn/Out`, `transitionMod`) | `drawClip` applies the `LayerMod` | `inspector/AnimationSection` |
| Clip effects | `fx.ts` (`clip.effects`, `drawWithEffects`) | `drawClip` draws through the effects | `inspector/EffectsSection`, `panels/EffectsPanel` |
| Crop, speed, freeze | `project.ts` (`clip.crop`, `speed`, `freeze`, `sourceTimeAt`) | `drawClip`, `Player.sync`, export seek and audio mix | `inspector/EditSection`, `tools/cropTool` |
| Cursor data and effects | `cursor.ts` (`media.cursor`, `project.cursorFx`) | `drawClip` calls `drawCursorFx` | `inspector/CursorSection`, `panels/CursorPanel` |
| Audio | `audiofx.ts` (`clip.audio`, `keys.volume`) | `Player.sync` and `mixAudio` | `inspector/AudioSection`, `decor/Waveform` |
| Markers, captions | `markers.ts`, `captions.ts` | ruler, `drawCaption` | `inspector/MarkerPanel`, `CaptionPanel`, `lanes/captionLane` |

- **Draw order** (`compositor.ts`): background, then each active clip on visible tracks (bottom to top: keyframed properties, crop, transition, effects, cursor effects), blur regions, annotations; with a zoom active that whole picture is drawn off-screen and the camera shows a window of it; captions last.
- **Keyframe times** are seconds from the start of the owning clip or annotation, so they move with it. Trimming the start and splitting shift them (`shiftKeys`).
- **Preview tools** (`ui/previewTools.ts`, `ui/tools/`): a tool claims presses on the picture and draws its own selection box and handles. A drag session must finish with `editor.getProject()`, never the project captured when the drag began.
- **Overlay lanes** (`ui/lanes/`): timed items that are not clips get a row under the tracks, with move and trim handled once in `Timeline`.
- **Toolbox tabs** (`ui/toolboxTabs.ts`): a tab shows when its panel module sets `enabled`.
- **Tests**: `tests/unit/*.test.ts` run with `bun test`; `tests/e2e/*.e2e.mjs` are picked up by `node tests/e2e/run-all.mjs [name fragments]`, which serves `dist/` on a free port.

## Commands

`src/engine/commands/` is the command registry from the Fleet CLI parity proposal: every GUI action is also a named command, `<noun> <verb>` (`clip split`, `marker add`, `annotation add`). A command is a typed wrapper over the pure operations in `src/engine` and runs over plain data, so it needs no browser. The editor does not import the registry, so the bundle is unchanged; the host bridge (issue #33) and the CLI (issue #34) are its first callers.

```ts
runCommand(project, 'clip split', { time: '2.5' }, { dryRun: false, confirm: false })
// ok:     { schema: 'capstan.result/1', command, ok: true, result, project }   (dryRun: no project, a `changes` summary instead)
// failed: { schema: 'capstan.result/1', command, ok: false, errorType, error }
```

- **Error types.** `usage` (unknown command, missing, unknown or badly typed argument; exit 2), `failed` (the arguments were fine but the work could not be done: no such clip, locked track; exit 1), `needs-confirm` (a `destructive` command without `confirm: true`, the API form of `--yes`; exit 2) and `needs-browser` (exit 1). `runCommand` never throws. Strings from a command line are coerced (`'2.5'` to a number, `'true'` to a boolean), ranges and enums are enforced, and `dryRun` skips the confirmation because it changes nothing.
- **Two kinds.** `needs: 'project'` commands are pure functions of a project. `needs: 'browser'` commands (export, recording, importing media bytes, packages, the library, saved templates and presets, noise removal) are registered with full typed inputs so the inventory is complete, and answer `needs-browser` until the host bridge implements them against the live page.
- **Describing.** `describeCommands()` returns `capstan.commands/1`: every command with each input's type (`string`, `number`, `boolean`, `enum`, `id`, `json`), required flag and allowed values or range. `bun scripts/commands.ts [--out FILE]` prints it, which is what `commands --json` shows. Inputs are camelCase; a command line maps `--ease-in` to `easeIn`.
- **Adding a command.** Write the definition in the area file (`clip-commands.ts`, `caption-commands.ts` ...) by wrapping an existing operation, never by reimplementing it: `name`, `summary`, `inputs` (use the builders in `define.ts`), `result`, `needs`, `destructive` if it replaces or discards more than it names, and a `run(project, args)` that returns `{ project, result }` or calls `fail(...)`. Use the same follow-ups the GUI does (for example `magnetize` after a move). Then list the GUI control that does the same in `inventory.ts`; a command with no GUI control is marked `cliOnly: true`. Add one valid call to `cases()` in `tests/unit/helpers/command-sample.ts`.
- **Parity.** `tests/unit/commands-parity.test.ts` fails if an inventory entry names a command that does not exist, or a command is neither in the inventory nor `cliOnly`.
- **The ratchet.** Most UI files still call the edit operations (`ops`, `editops`, `annotationOps` ...) directly, and moving every handler onto the registry is separate work. The same test counts, per file under `src/ui`, the operations imported from the engine's edit modules and compares them with `tests/unit/ui-direct-ops.allowlist.json`: a file that is not on the list, or whose count grows, fails with a message to call the registry instead. The list may only shrink; after moving a handler, lower its number (`UPDATE_UI_OPS_ALLOWLIST=1 bun test tests/unit/commands-parity.test.ts` does it).
- **CLI reference.** [CLI.md](CLI.md) lists every command, the flags, exit codes and result envelope; its table is generated from the registry (`bun scripts/gen-cli-doc.ts`) and a test fails when it drifts.
- **Project file.** [PROJECT-FILE.md](PROJECT-FILE.md) describes the `.capstan` file and its versioning; [project.schema.json](project.schema.json) is its JSON Schema, tested against `parseProject`.

## Recording

`recorder.ts` asks for the surface the user picked (`displaySurface`), leaves screens out of the picker for a tab or window (`monitorTypeSurfaces: 'exclude'`) and caps the size at the canvas. Before recording, the shared track's `displaySurface` must match a tab or window choice, or the stream is stopped. MP4 is used only after a two-second test recording of the actual track produces data: Edge's H.264 recorder can accept screen capture and write nothing. Otherwise WebM. An empty recording is an error, never a file. The recording is imported with the duration and size the recorder already knows, because probing a recorder WebM means seeking, and browsers suspend decoding of muted video in a hidden window (the usual state when the user stops sharing from the browser bar).

## Export pipeline

1. Pick the best supported H.264 profile/level for the size and frame rate, preferring the hardware encoder.
2. Mix audio: decode each audible media once, schedule every clip in an `OfflineAudioContext` at its timeline position with its volume, render to one stereo buffer, encode in 1024-sample `AudioData` chunks (AAC, or Opus where AAC is unavailable).
3. For each output frame: seek every active video clip's element to the exact source time, draw the frame, encode it (keyframe every 2 s).
4. Watchdog: if an encoder takes frames but produces nothing for 10 s (seen with a hardware H.264 encoder), or the video encoder reports an error, the export runs again with `hardwareAcceleration: 'prefer-software'`.
5. Mux: `Mp4Muxer` writes `ftyp`, `moov` (sample tables, H.264 `avcC`, AAC `esds` or Opus `dOps`) and an interleaved `mdat`. Sample data is not copied again; the result is a `Blob` downloaded to the user.

`tests/e2e/export.e2e.mjs` exports a fixture timeline and checks it with ffprobe and a full ffmpeg decode: codec, size, duration, exact frame count, audio presence and level, and picture content at known times.

## Storage

IndexedDB database `capstan`: store `media` (Blob per media id), `projects` (project JSON by id) and `meta` (`lastProjectId`). Version 2 adds `library` (reusable assets with their metadata, independent of any project) and `templates` (the user's own). Every project owns its media Blobs under its own media ids (`cloneProject` re-ids on duplicate and on opening a package of a project that already exists), so deleting a project never removes another's media. The project autosaves 400 ms after each change. Because browser storage is per origin and the origin includes the port, the 0.2 release moves the library to files on disk through the host.

**Packages.** `engine/zip.ts` is a pure-TypeScript zip writer (streaming, data descriptors, store or deflate-raw through `CompressionStream`) and reader (central directory, safe-name, entry-count, size and ratio caps, CRC-32 verified on read). `engine/package.ts` writes a `.capstanz`: `manifest.json`, `project.json` and `media/<id>-<name>`. Opening verifies everything before storing anything. Save streams to a file with `showSaveFilePicker` where it exists, else downloads. The host cannot yet hold a library on disk: `LocalHttp.ps1` buffers whole request bodies (30 MB cap, one request at a time, no chunked transfer), so large media would need chunked, token-checked PUT/GET endpoints with their own PowerShell tests first.

## Lifecycle

The window owns the host (TechStack.md, "Lifecycle rules"). `src/ui/lifecycle.ts` sends `POST /api/heartbeat` every 5 s with a per-page id, and a `navigator.sendBeacon` leaving signal on `pagehide`. The beacon cannot set headers, so that one route also accepts the session token in the JSON body. The host loop wakes at least once a second (`TryAccept(1000)`) and asks `Capstan.Lifecycle.Presence` whether any page is alive: a page is gone 20 s after its last heartbeat, or 5 s after its leaving signal with no new heartbeat. A reload is a new page that beats at once, so it never stops the host. Export and recording run in the page, so while they run the heartbeat says `busy` (and a minimised window says `hidden`); such a page gets 90 s before a missing heartbeat counts, because browsers throttle timers in hidden windows. Host-side jobs (`BeginJob`/`EndJob`, for the on-disk library planned in v0.2) also hold the stop. Requests are handled one at a time on the loop thread, so a stop never cuts one off.

The host writes `logs\capstan-server-<pid>.json` and deletes it in a `finally` (Ctrl+C included). `Stop-Capstan.ps1` reads these, removes stale ones, and also scans for PowerShell processes running `Start-Capstan.ps1`. The launcher uses the same lookup to offer *stop it and start fresh?*; `--replace` answers yes and `--stay` (or `CAPSTAN_AUTO_STOP=0`) turns auto-stop off. `bun run build` and `tests/serve.mjs` call `Stop-Capstan.ps1` on Windows before they start.

## Hotkeys and the tray

`modules/Hotkeys.ps1` compiles one C# 5 source (`Add-Type`, framework assemblies only, P/Invoke only into `user32.dll`) and starts `Capstan.Hotkeys.HotkeyService` when the host starts. The service owns a single worker thread: STA, **background** (so it can never keep the host alive), with a message-only window (`HWND_MESSAGE`) that calls `RegisterHotKey`, and a `NotifyIcon` with a menu (Start or Stop recording, Pause or Resume, Open Capstan, Quit tray). `Stop()` unregisters every key and removes the icon on that thread; `Start-Capstan.ps1` calls it in its `finally` block, so the tray goes away when the host stops (End session, the window closing, Ctrl+C, `Stop-Capstan.ps1` does a hard kill, which leaves Windows to drop the icon when the pointer passes over it). The service never takes part in the presence rule: only a page's heartbeat does.

**Keys.** Defaults are Ctrl+Shift+F9 (start or stop), Ctrl+Shift+F10 (pause or resume) and Ctrl+Shift+F11 (add a marker). Bindings are chosen from an allowlist, not typed free-form: modifiers Ctrl, Alt, Shift (Ctrl or Alt required, so the key keeps working when typing elsewhere) plus F1 to F24 without F12 (Windows reserves it for debuggers), A to Z, 0 to 9, Insert, Delete, Home, End, PageUp, PageDown, Pause, PrintScreen, ScrollLock. `tests/fixtures/hotkey-bindings.json` is one corpus that the C#, the TypeScript and the Node mirror are all tested against. A key that Windows will not register (another program holds it, error 1409) is reported per key with a reason and the other keys still work. The page remembers the user's bindings in `localStorage` and sends them once per page load; the host keeps no file.

**Routes** (all behind the session token and the Host/Origin checks; the module checks the token again in constant time):

| Route | What it does |
| --- | --- |
| `GET /api/hotkeys/status` | `available`, `running`, `test`, `state`, `last` (newest event id), `registered`, `failed` (with reasons), `bindings`, per-key `keys`, the `allowed` names, and `captureExclusion` |
| `PUT /api/hotkeys/config` | `{"bindings": {"marker": "Ctrl+Alt+M"}}`. Every name is checked against the allowlist, duplicates between actions are refused, and a refused change changes nothing |
| `GET /api/hotkeys/events?since=N&wait=S` | Long poll: events with ids above N, or an empty answer after at most 25 s. Events are only `start-stop`, `pause-resume`, `marker`, `tray-open` |
| `POST /api/hotkeys/state` | `{"state": "idle" or "recording" or "paused"}`, so the tray icon and menu text follow the recorder |
| `POST /api/hotkeys/test-inject` | Test seam, see below. Does not exist unless `CAPSTAN_TEST_HOTKEYS=1` |

The host handles one request at a time, so a long poll is **parked**: the loop keeps the connection open, answers it from its tick (every 100 ms while a poll is parked) and goes on serving other requests. At most 8 polls are parked (the oldest is answered empty first); a stopping host answers all of them.

**Page side.** `src/engine/hotkeys-host.ts` is the client (no DOM): it syncs its cursor to the host's newest id before polling, so a key pressed while the page was hidden is never replayed; it polls only while the page is visible, **or while a recording is running or waiting** (keys must work with Capstan hidden or minimised), and stops when the host reports `available: false` or the tray was closed. `src/ui/hotkeys.ts` is the page singleton; the Record dialog answers events while it is open and `App.tsx` is the fallback (start key opens the Record dialog; marker key adds a marker at the playhead).

**What a hotkey can and cannot do.** The browser opens its screen picker (`getDisplayMedia`) only after a click inside Capstan, so a key pressed in another program can never open it. Capstan therefore offers *Choose what to share now, then start with the hotkey*: the picker is used once, the dialog waits ("armed"), and the start key then begins the recording, the marker key adds markers at the recording time (pauses excluded; they land on the ruler offset by where the recording is placed), the pause key pauses and resumes, and the start key stops and saves, all with Capstan hidden. Without that step, the start key opens the Record dialog and starts with the last used settings only if the page happens to have a fresh click; otherwise it says what is needed. The last used choices (what to record, sound, webcam, cursor, add to timeline, share first) are remembered in `localStorage`.

**Keeping Capstan out of the shot is not possible from the host, and is not faked.** `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` only works on windows owned by the calling process. The host is `powershell.exe`; Capstan's window is an Edge window owned by `msedge.exe`, so the host cannot exclude it, and anything that would (injecting a DLL into the browser, hooking it) is both forbidden by the stack rules and fragile. The status route says so (`captureExclusion.possible: false` with the reason) and the Record dialog shows it under *Keeping Capstan out of the recording*. What works: record a browser tab or a single window, which is already the default (`selfBrowserSurface: 'exclude'` also keeps the Capstan tab out of the picker). Recording the entire screen includes whatever is on it, Capstan too.

**Test seam.** With `CAPSTAN_TEST_HOTKEYS=1` the host registers no key, creates no icon and starts no thread; `POST /api/hotkeys/test-inject` queues a named event (or marks a key combination as taken, to exercise the clash report). Without the variable that route returns 404. `tests/serve.mjs` mirrors every route through `tests/hotkeys-mirror.mjs` (same paths, status codes and JSON shapes) and only behaves as a hotkey host when the variable is set. Nothing in the tests registers a real key, shows a tray icon or sends a key press.

## Security

- Host: loopback only; rejects wrong `Host`, foreign `Origin`, and cross-site `Sec-Fetch-Site`; fixed file allowlist; per-launch session token for API routes; strict CSP with no inline script and no remote origins; `media-src blob:` for local playback.
- **Security notes: global hotkeys and the tray** (new listener and hook; needs the Researcher's verdict).
  - *What is exposed.* Four small JSON routes under `/api/hotkeys/` on the existing loopback listener, and one OS hook: `RegisterHotKey` on a message-only window in the host process. No new socket, no new port.
  - *Who can call it.* Only a page that has the per-launch session token (header `X-Capstan-Token`, never the query string, never the body), from `http://127.0.0.1:<port>`; foreign `Origin`, wrong `Host` and cross-site fetches are refused before routing, no CORS headers. The module repeats the token check with a constant-time compare. Methods and content types are strict (405, 415), bodies are at most 4 KB (413), and errors have the stable shape `{"error": ...}` without paths or exception text.
  - *What travels.* Hotkeys carry only the fixed event names `start-stop`, `pause-resume`, `marker`, `tray-open` (ids and a timestamp). **No key content is ever read or sent**: the host does not install a keyboard hook (`SetWindowsHookEx`, `GetAsyncKeyState` and similar are not used) and only learns that one registered combination was pressed. The page sends the binding names the user chose and the recorder state (`idle`, `recording`, `paused`).
  - *Limits.* Bindings come from an allowlist of modifier and key names (nothing free-form reaches `RegisterHotKey`); a long poll waits at most 25 s; at most 8 polls are parked; the event queue keeps 100 events; the tray menu can only queue those same events, bring an existing Capstan browser window forward (title `Capstan`, Edge or Chrome processes only) or open the host's own `http://127.0.0.1:<port>/` address.
  - *What is deliberately not done.* No global keyboard capture or keystroke logging, no key injection, no file written, no network. Capstan does not try to hide its window from a capture (see above). With `CAPSTAN_HOTKEYS=0` or `-no-hotkeys` the module is off and the routes answer `available: false`. The test seam (`CAPSTAN_TEST_HOTKEYS=1`) removes the OS hook instead of adding a bypass: the production code path is the real one when the variable is not set.
- The editor makes no network requests. `tests/unit/host.test.ts` checks that the bundle references no CDN and that the PowerShell host and the test server send the same CSP.

## Testing

| Suite | Runs | Covers |
| --- | --- | --- |
| `tests/unit/*.test.ts` | `bun test tests/unit` | Edit operations, history, project parsing, timecodes, host/launcher/dist consistency, `dist/` freshness |
| `tests/e2e/export.e2e.mjs` | Headless Chromium + ffprobe | MP4 validity and content, with and without audio |
| `tests/e2e/editor.e2e.mjs` | Headless Chromium | Import, drag to timeline, move with snapping, split, undo/redo, trim, inspector, playback, reload persistence, export from the dialog |
| `tests/e2e/record.e2e.mjs` | Headless Chromium, synthetic capture stream | A tab request that gets a screen is refused with nothing recorded; picker options exclude screens and cap the size; record, pause/resume, stop; recording lands in the bin and timeline with the pause excluded. No fake capture UI: on a Windows runner it shares the real desktop |
| `tests/e2e/lifecycle.e2e.mjs` | Headless Chromium | Heartbeat with the session header, leaving beacon with the token in the body, new page id after reload, one id per window, End session |
| `tests/unit/hotkeys.test.ts` | `bun test tests/unit` | Binding rules against one corpus shared with PowerShell and the Node mirror, the long-poll client against a fake host (cursor sync, hidden pause, keep-alive while recording, 403, retries), Record flow decisions, markers placed on the timeline, the mirror routes over real HTTP, and static checks that the C# stays within C# 5 and the seam exists only behind `CAPSTAN_TEST_HOTKEYS=1` |
| `tests/e2e/hotkeys.e2e.mjs` | Headless Chromium, its own mirror server with the seam on, synthetic capture stub | Hotkeys group in the Record dialog (status per key, a taken key, changing and refusing bindings), share first then start, marker, pause, resume and stop through injected events with the window "hidden", markers on the ruler at the recording time, the start key with and without a fresh click, polling paused while hidden and idle. No real key, no tray icon |
| `tests/ps/Hotkeys.Tests.ps1` | Windows PowerShell 5.1 (CI `windows-host` job) | The C# compiles; binding validation; the event queue; a service with a fake registrar (register, release, clash, change, stop) with and without its real worker thread and message-only window; a process that never stops its service still exits; every route with synthetic requests (token, method, content type, size, query validation, long-poll clamp); the real host with the seam on over HTTP (long poll timing, an injected event answering a waiting poll, other requests not blocked, host stops itself with a poll waiting). No real key, no icon |
| `tests/ps/Lifecycle.Tests.ps1` | Windows PowerShell 5.1 (CI `windows-host` job) | Presence rule with simulated time (timeouts, reload, two windows, jobs, busy/hidden, off switch); real host: runtime file without token, heartbeat auth, self-stop after the beacon, End session, `Stop-Capstan.ps1` |

PowerShell runs in CI only for the lifecycle job above. `tests/serve.mjs` mirrors the host's routing and headers; the real host still needs a Windows run (`Launch-Capstan.bat -Diagnostics`, then a normal launch).
