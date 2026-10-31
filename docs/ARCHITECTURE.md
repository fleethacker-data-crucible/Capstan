# Capstan architecture

```
Launch-Capstan.bat ──► Start-Capstan.ps1 (PowerShell 5.1)
                  └─ modules/LocalHttp.ps1  TcpListener on 127.0.0.1, port fallback
                       serves dist/ (allowlist) + /api/health, /api/heartbeat,
                       /api/session/stop (session token)
                  └─ modules/Lifecycle.ps1  presence rule, runtime file, Stop-Capstan.ps1
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

Hand-off files between Capstan and the other Fleet apps are listed in [HANDOFFS.md](HANDOFFS.md).

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

IndexedDB database `capstan`: store `media` (Blob per media id), `projects` (project JSON by id) and `meta` (`lastProjectId`). Version 2 adds `library` (reusable assets with their metadata, independent of any project) and `templates` (the user's own). Every project owns its media Blobs under its own media ids (`cloneProject` re-ids on duplicate and on opening a package of a project that already exists), so deleting a project never removes another's media. The project autosaves 400 ms after each change. Because browser storage is per origin and the origin includes the port, the host also keeps a copy of every media file on disk (next paragraph), so a project opened on another port, or after the browser data was cleared, still finds its media.

**Packages.** `engine/zip.ts` is a pure-TypeScript zip writer (streaming, data descriptors, store or deflate-raw through `CompressionStream`) and reader (central directory, safe-name, entry-count, size and ratio caps, CRC-32 verified on read). `engine/package.ts` writes a `.capstanz`: `manifest.json`, `project.json` and `media/<id>-<name>`. Opening verifies everything before storing anything. Save streams to a file with `showSaveFilePicker` where it exists, else downloads.

**Library on disk.** `modules/Library.ps1` keeps media under `%LOCALAPPDATA%\Capstan\library\<id>` (`CAPSTAN_LIBRARY_ROOT` moves it to another local folder, `CAPSTAN_LIBRARY=0` turns it off). `GET /api/health` says `"library": true` when it is on. Routes, all behind the session token and the Host/Origin checks: `GET /api/files` (index: id, size, modified), `POST /api/files` (start or resume an upload: `{id, size, sha256?, chunkSize?}`; the answer lists the parts already received), `PUT /api/files/<id>?part=N` (one raw chunk of at most 8 MB, written at `N * chunkSize` into a temp file in `library\.uploads`), `POST /api/files/<id>/complete` (every part present, size equal, SHA-256 equal when given, then the file is moved into place), `GET /api/files/<id>` (streamed in 1 MB buffers, one `Range: bytes=a-b` supported), `DELETE /api/files/<id>` (drops an upload and the stored file; `?upload=1` only the upload). The transport gives these requests an unread, length-bounded body stream and the response a file stream (`LocalHttp.ps1`: `BodyStream`, `Response.SetFile`), so nothing larger than a 1 MB buffer is held in memory. `src/engine/library-host.ts` is the page client (chunked resumable upload, ranged download into a Blob, list, delete, progress, abort) and `src/engine/library-mirror.ts` wraps it: `putMediaBlob` stores in IndexedDB and then copies to the host in the background, one file at a time; `getMediaBlob` reads IndexedDB and asks the host only when the media is not there (and keeps the copy it got); a media file IndexedDB has but the host lacks is copied when it is next read. A failed copy is a status-bar message and a "last copy failed" mark on the "Library on disk" line; an edit never waits for the host. IndexedDB remains the only store when the host has no library. The reusable-assets "Library" dialog (`library` object store) is separate and unchanged.

## Lifecycle

The window owns the host (TechStack.md, "Lifecycle rules"). `src/ui/lifecycle.ts` sends `POST /api/heartbeat` every 5 s with a per-page id, and a `navigator.sendBeacon` leaving signal on `pagehide`. The beacon cannot set headers, so that one route also accepts the session token in the JSON body. The host loop wakes at least once a second (`TryAccept(1000)`) and asks `Capstan.Lifecycle.Presence` whether any page is alive: a page is gone 20 s after its last heartbeat, or 5 s after its leaving signal with no new heartbeat. A reload is a new page that beats at once, so it never stops the host. Export and recording run in the page, so while they run the heartbeat says `busy` (and a minimised window says `hidden`); such a page gets 90 s before a missing heartbeat counts, because browsers throttle timers in hidden windows. Host-side jobs (`BeginJob`/`EndJob`: the library's checksum re-read and file downloads) also hold the stop. Requests are handled one at a time on the loop thread, so a stop never cuts one off.

The host writes `logs\capstan-server-<pid>.json` and deletes it in a `finally` (Ctrl+C included). `Stop-Capstan.ps1` reads these, removes stale ones, and also scans for PowerShell processes running `Start-Capstan.ps1`. The launcher uses the same lookup to offer *stop it and start fresh?*; `--replace` answers yes and `--stay` (or `CAPSTAN_AUTO_STOP=0`) turns auto-stop off. `bun run build` and `tests/serve.mjs` call `Stop-Capstan.ps1` on Windows before they start.

## Security

- Host: loopback only; rejects wrong `Host`, foreign `Origin`, and cross-site `Sec-Fetch-Site`; fixed file allowlist; per-launch session token for API routes; strict CSP with no inline script and no remote origins; `media-src blob:` for local playback.
- The editor makes no network requests beyond its own host. `tests/unit/host.test.ts` checks that the bundle references no CDN and that the PowerShell host and the test server send the same CSP.

### Security notes: library on disk (`/api/files`)

- **What is exposed.** Six routes on the existing loopback listener (no new listener, no new port). They read and write files in one folder, `%LOCALAPPDATA%\Capstan\library`, and nowhere else. `/api/health` adds `library`, `libraryMaxBytes` and `libraryChunkBytes`, never the folder.
- **Who can call it.** Only a request that carries the per-launch session token in `X-Capstan-Token` (compared in constant time) and passes the existing loopback, `Host: 127.0.0.1:<port>`, `Origin` and `Sec-Fetch-Site` checks. The token is not accepted in a query string or body on these routes. No CORS headers.
- **File names.** The name comes from an id matching `^[a-z0-9_-]{1,80}\z` only, never from a path in a request; Windows device names (`con`, `nul`, `com1`...) are refused; the resolved path must be a direct child of the root; a stored file or temp file that is a reparse point is refused; `:` (alternate streams), dots, spaces, separators and upper case cannot occur. The root must be a local drive-letter path (no UNC, no device path).
- **Limits.** Chunk at most 8 MB (413 above it; the host drops the unread body so the answer arrives); exact length per part; JSON bodies at most 4 KB; stored file at most 16 GiB by default (`CAPSTAN_LIBRARY_MAX_BYTES`); the free space of the drive minus 256 MiB and the other open uploads must cover the file (507); at most 4 uploads at once (429); an upload idle for 30 minutes is removed, and every temp upload is removed when the host starts and when it stops. All reads and writes use buffers of at most 1 MB.
- **Integrity.** The announced size must match the bytes received; a given SHA-256 is verified (kept running while parts arrive in order, otherwise the temp file is re-read in 1 MB buffers while a host job holds off auto-stop) and a mismatch discards the upload (422).
- **Errors.** `{"error": "...", "code": "..."}` built from fixed text; no path and no exception message ever leaves the host. Failures are logged by exception type only.
- **Deliberately not done.** No listing outside the root, no rename or copy, no multiple ranges, no `HEAD`, no encryption or per-project quota, no sync between computers, no content checks on the bytes (the page sniffs the type on read), and the page does not hash files over 64 MiB (Web Crypto cannot stream; the size is still checked). The library is a convenience copy: deleting media in the page removes its copy, but files stay until then. Requests are handled one at a time on the loop thread, which is why the page reads big files in 8 MB ranges and why a host job holds off auto-stop while a download or a checksum runs.
- **Tests.** `tests/ps/Library.Tests.ps1` runs the real host on a test port with a temp folder: hostile ids, token/Host/Origin refusals, size and chunk limits, multi-chunk upload and download with a hash, `Range`, a cut-off and a cancelled upload leaving nothing behind, the stale timeout, a second host on another port finding the same file. `tests/unit/host.test.ts` pins the wiring; `tests/unit/library-host.test.ts` tests the client against a fake fetch.

## Testing

| Suite | Runs | Covers |
| --- | --- | --- |
| `tests/unit/*.test.ts` | `bun test tests/unit` | Edit operations, history, project parsing, timecodes, host/launcher/dist consistency, `dist/` freshness |
| `tests/e2e/export.e2e.mjs` | Headless Chromium + ffprobe | MP4 validity and content, with and without audio |
| `tests/e2e/editor.e2e.mjs` | Headless Chromium | Import, drag to timeline, move with snapping, split, undo/redo, trim, inspector, playback, reload persistence, export from the dialog |
| `tests/e2e/record.e2e.mjs` | Headless Chromium, synthetic capture stream | A tab request that gets a screen is refused with nothing recorded; picker options exclude screens and cap the size; record, pause/resume, stop; recording lands in the bin and timeline with the pause excluded. No fake capture UI: on a Windows runner it shares the real desktop |
| `tests/e2e/lifecycle.e2e.mjs` | Headless Chromium | Heartbeat with the session header, leaving beacon with the token in the body, new page id after reload, one id per window, End session |
| `tests/unit/library-host.test.ts` | `bun test tests/unit` | Library client against a fake fetch: chunking, resume, retry, abort, ranged download, type sniffing; the write-through and fallback layer |
| `tests/e2e/library-host.e2e.mjs` | Headless Chromium against the mirror in `tests/serve.mjs` | Import copies to the host; a new browser profile opens the saved project and finds its media; a failing host is reported and never blocks an edit; backfill |
| `tests/ps/Library.Tests.ps1` | Windows PowerShell 5.1 (CI `windows-host` job) | The `/api/files` routes on the real host: path rules, token/Host/Origin, limits, multi-chunk with hash, Range, cancelled and stale uploads |
| `tests/ps/Lifecycle.Tests.ps1` | Windows PowerShell 5.1 (CI `windows-host` job) | Presence rule with simulated time (timeouts, reload, two windows, jobs, busy/hidden, off switch); real host: runtime file without token, heartbeat auth, self-stop after the beacon, End session, `Stop-Capstan.ps1` |

PowerShell runs in CI only for the two Windows host checks above (lifecycle and library). `tests/serve.mjs` mirrors the host's routing and headers; the real host still needs a Windows run (`Launch-Capstan.bat -Diagnostics`, then a normal launch).
