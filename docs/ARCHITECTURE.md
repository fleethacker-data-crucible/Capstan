# OpenTape architecture

```
OpenTape.bat ──► Start-OpenTape.ps1 (PowerShell 5.1)
                  └─ modules/LocalHttp.ps1  TcpListener on 127.0.0.1, port fallback
                       serves dist/ (allowlist) + /api/health (session token)
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

## Export pipeline

1. Pick the best supported H.264 profile/level for the size and frame rate, preferring the hardware encoder.
2. Mix audio: decode each audible media once, schedule every clip in an `OfflineAudioContext` at its timeline position with its volume, render to one stereo buffer, encode in 1024-sample `AudioData` chunks (AAC, or Opus where AAC is unavailable).
3. For each output frame: seek every active video clip's element to the exact source time, draw the frame, encode it (keyframe every 2 s).
4. Mux: `Mp4Muxer` writes `ftyp`, `moov` (sample tables, H.264 `avcC`, AAC `esds` or Opus `dOps`) and an interleaved `mdat`. Sample data is not copied again; the result is a `Blob` downloaded to the user.

`tests/e2e/export.e2e.mjs` exports a fixture timeline and checks it with ffprobe and a full ffmpeg decode: codec, size, duration, exact frame count, audio presence and level, and picture content at known times.

## Storage

IndexedDB database `opentape`: store `media` (Blob per media id), `projects` (project JSON by id) and `meta` (`lastProjectId`). The project autosaves 400 ms after each change. Because browser storage is per origin and the origin includes the port, the 0.2 release moves the library to files on disk through the host.

## Security

- Host: loopback only; rejects wrong `Host`, foreign `Origin`, and cross-site `Sec-Fetch-Site`; fixed file allowlist; per-launch session token for API routes; strict CSP with no inline script and no remote origins; `media-src blob:` for local playback.
- The editor makes no network requests. `tests/unit/host.test.ts` checks that the bundle references no CDN and that the PowerShell host and the test server send the same CSP.

## Testing

| Suite | Runs | Covers |
| --- | --- | --- |
| `tests/unit/*.test.ts` | `bun test tests/unit` | Edit operations, history, project parsing, timecodes, host/launcher/dist consistency, `dist/` freshness |
| `tests/e2e/export.e2e.mjs` | Headless Chromium + ffprobe | MP4 validity and content, with and without audio |
| `tests/e2e/editor.e2e.mjs` | Headless Chromium | Import, drag to timeline, move with snapping, split, undo/redo, trim, inspector, playback, reload persistence, export from the dialog |
| `tests/e2e/record.e2e.mjs` | Headless Chromium, fake capture devices | Record, pause/resume, stop; recording lands in the bin and timeline with the pause excluded |

PowerShell itself does not run in CI (Linux). `tests/serve.mjs` mirrors the host's routing and headers; the real host still needs a Windows run (`OpenTape.bat -Diagnostics`, then a normal launch).
