# Capstan roadmap

Capstan aims to cover the full range of screen recording and video editing, within the stack rules in [TechStack.md](../TechStack.md): no installer, no admin rights, no network, compiled JS/CSS/WASM only. This page lists each feature area, how Capstan will build it, and the release it is planned for.

**Status key:** ✅ done · 🟡 partial · ⬜ planned

What each open row still needs, in what order, and how to tell it is done: [REMAINING-WORK.md](REMAINING-WORK.md).

## Releases

Each release ends with the editor usable and tested. Order is by what blocks the most real work.

| Release | Theme | Headline |
| --- | --- | --- |
| **0.1** ✅ | Foundation | Record, import, multi-track timeline, trim/split/move, transform, undo, autosave, MP4 export |
| **0.2** | Durable library | Media and projects as files under `%LOCALAPPDATA%\Capstan`; streaming export to disk; fast export via WASM demux; waveforms and filmstrips |
| **0.3** | Recorder | Native recorder with hotkeys and tray (from SnapShackle), region/window capture, webcam track, cursor data, countdown |
| **0.4** | Annotations | Callouts, text, shapes, arrows, highlight, blur/pixelate, keystroke callouts |
| **0.5** | Animation | Keyframes, zoom-n-pan, transitions, behaviors, easing |
| **0.6** | Cursor effects | Smoothing, highlight, click effects, magnify, spotlight, hide/replace cursor |
| **0.7** | Audio | Fades, volume points, noise removal, levelling, clip speed, ducking |
| **0.8** | Visual effects | WebGL compositor: colour, chroma key, shadow, border, rounded corners, device frames, blend modes |
| **0.9** | Captions and markers | Captions editor, SRT/VTT, burned-in captions, speech-to-text, markers and chapters |
| **1.0** | Production | Export presets, GIF and audio-only export, batch export, templates, themes, asset library |
| **1.x** | Extras | Interactive quizzes/hotspots player, transcript-based editing, background removal |

## Feature matrix

### Recording

| Feature | Plan | Release | Status |
| --- | --- | --- | --- |
| Screen, window, tab recording | `getDisplayMedia` + `MediaRecorder` | 0.1 | ✅ |
| Choose tab / window / screen; refuse anything else | `displaySurface` hint, screens excluded from the picker, shared surface checked before recording | 0.1 | ✅ |
| Microphone and system audio, mixed | Web Audio mix into one track | 0.1 | ✅ |
| Pause / resume | `MediaRecorder.pause()` | 0.1 | ✅ |
| Global hotkeys, tray, studio not in the shot | Port SnapShackle's `RegisterHotKey` + tray (C# via `Add-Type`) | 0.3 | 🟡 (global hotkeys and a tray icon through the host are built and tested with synthetic events; keeping Capstan out of the shot is not possible from the host, so record a tab or a window; a real desktop run is outstanding) |
| Region and exact-window capture | SnapShackle's selection overlay drives a cropped capture | 0.3 | ✅ (region becomes a crop; window is the existing window choice) |
| Webcam as its own track | `getUserMedia` recorded in parallel, placed as a separate clip | 0.3 | ✅ |
| Separate mic / system audio tracks | Parallel recorders, one clip per source | 0.3 | ✅ |
| Cursor data (position, clicks, keys) | Low-level hooks in C# log cursor/clicks/keys with timestamps alongside the video; record with `cursor: 'never'` and re-draw it | 0.3 | 🟡 (capture through the host is built and tested with scripted input; a run on a real desktop is outstanding, see #23) |
| Countdown, recording limits, recording to disk | Chunks streamed to the host while recording | 0.3 | ✅ |
### Editing

| Feature | Plan | Release | Status |
| --- | --- | --- | --- |
| Multi-track timeline, add/remove tracks | Engine `ops.ts` | 0.1 | ✅ |
| Move, trim, split, delete, ripple delete, duplicate | Engine `ops.ts` | 0.1 | ✅ |
| Snapping, zoom, track hide/mute/lock | Timeline UI | 0.1 | ✅ |
| Undo / redo | Immutable snapshots | 0.1 | ✅ |
| Position, scale, rotation, opacity, volume | Clip props + compositor | 0.1 | ✅ |
| Canvas presets and frame rate | Project settings | 0.1 | ✅ |
| Copy/paste, multi-clip drag, grouping | Engine ops on selections; groups as nested timelines | 0.4 | ✅ |
| Magnetic tracks, gap removal | Ripple logic per track | 0.4 | ✅ |
| Clip speed, freeze frame, extend frame | Time remap in clip model | 0.7 | ✅ |
| Crop | Source rectangle in clip props | 0.4 | ✅ |
| Markers | Timeline markers, exported as chapters | 0.9 | ✅ (also written to MP4 as chapters) |
| Detach audio from video | Split one media into linked video + audio clips | 0.7 | ✅ |
### Annotations and text

| Feature | Plan | Release | Status |
| --- | --- | --- | --- |
| Text and callouts (speech bubbles, labels) | Vector "generated" clips drawn by the compositor | 0.4 | ✅ (text and callouts with an aimable tail) |
| Arrows, lines, shapes | Same generated-clip system | 0.4 | ✅ |
| Highlight, spotlight, blur and pixelate regions | Compositor effects over lower tracks | 0.4 | ✅ |
| Keystroke callouts | From recorded key data (0.3) | 0.4 | 🟡 (from key data in the sidecar; needs the capture host) |
| Sketch motion (animated drawing) | Path-length animation | 0.5 | ✅ (arrows, lines and shapes draw themselves on) |
| Text styles, fonts | Bundled fonts only (no web fonts) | 0.4 | ✅ (system font stacks (sans, serif, mono, display); no web fonts) |
### Animation and transitions

| Feature | Plan | Release | Status |
| --- | --- | --- | --- |
| Keyframed properties with easing | Per-prop keyframe tracks, evaluated per frame | 0.5 | ✅ |
| Zoom-n-pan | Keyframes on the canvas camera | 0.5 | ✅ |
| Transitions (fade, slide, wipe, …) | Two-clip compositor ops at cut points | 0.5 | ✅ (two touching clips on one track fade through the background; use two tracks for a cross-dissolve) |
| Behaviors (text/clip entrance, emphasis, exit) | Keyframe presets | 0.5 | ✅ |
| Smart focus (auto zoom on activity) | From cursor data (0.3) | 0.6 | 🟡 (suggests zoom regions from cursor data; needs the capture host) |
### Cursor effects (needs cursor data from 0.3)

| Feature | Plan | Release | Status |
| --- | --- | --- | --- |
| Cursor smoothing, size, hide, replace image | Re-drawn cursor from recorded positions | 0.6 | 🟡 (works from cursor data; needs the capture host) |
| Highlight, magnify, spotlight | Compositor effects centred on the cursor | 0.6 | 🟡 (works from cursor data; needs the capture host) |
| Click effects (rings, ripples) and click sounds | From recorded click events | 0.6 | 🟡 (works from cursor data; needs the capture host) |
### Audio

| Feature | Plan | Release | Status |
| --- | --- | --- | --- |
| Clip volume, track mute | Web Audio gain | 0.1 | ✅ |
| Fades, volume points | Gain automation in preview and export | 0.7 | ✅ |
| Waveforms on the timeline | Peaks computed in a worker (WASM) | 0.2 | ✅ (computed on the main thread, not in a worker) |
| Noise removal | Rust → WASM denoiser in an `AudioWorklet` | 0.7 | ✅ (spectral gating in TypeScript, applied as a bake to a new audio file; no WASM denoiser) |
| Volume levelling, compressor | Web Audio `DynamicsCompressor` + loudness analysis | 0.7 | ✅ (applied as a bake) |
| Audio ducking under narration | Side-chain gain automation | 0.7 | ✅ |
### Visual effects

| Feature | Plan | Release | Status |
| --- | --- | --- | --- |
| WebGL2 compositor | Replaces Canvas 2D when effects are present; same API | 0.8 | 🟡 (the compositor stays Canvas 2D; colour and chroma key run in a WebGL2 pass with a CPU fallback) |
| Colour adjustment, colourise | Shader | 0.8 | ✅ |
| Remove a colour (green screen) | Chroma-key shader | 0.8 | ✅ |
| Drop shadow, border, rounded corners | Shader / 2D | 0.8 | ✅ |
| Device frames | Bundled frame images | 0.8 | ✅ (drawn as vector art: browser, laptop, phone, tablet, monitor) |
| Blend modes, clip masks | Shader | 0.8 | ✅ (circle and ellipse masks, 13 blend modes) |
| Background removal (webcam) | On-device segmentation model in WASM | 1.x | ⬜ |

### Captions

| Feature | Plan | Release | Status |
| --- | --- | --- | --- |
| Captions track and editor | Timed text clips | 0.9 | ✅ |
| SRT / VTT import and export | Parser/writer | 0.9 | ✅ |
| Burned-in captions | Compositor text | 0.9 | ✅ |
| Speech-to-text | Windows speech recognition via WinRT from PowerShell (as SnapShackle does OCR), with an optional bundled WASM model | 0.9 | ✅ (Windows System.Speech recogniser through a host endpoint, offline; Transcribe in the Captions tab; quality depends on the installed speech pack, and a hand test with a real voice is outstanding) |
### Export and sharing

| Feature | Plan | Release | Status |
| --- | --- | --- | --- |
| MP4 (H.264 + AAC/Opus), size and quality | WebCodecs + own muxer | 0.1 | ✅ |
| Streaming export straight to a file | Fragmented MP4 written through the host, flat memory use | 0.2 | ✅ (File System Access picker; memory stays flat) |
| Fast export (decode with WebCodecs, not seeking) | Rust → WASM MP4/WebM demuxer feeding `VideoDecoder` | 0.2 | 🟡 (H.264 in MP4 and VP8/VP9 in WebM; other sources seek) |
| Export part of the timeline, single frame as PNG | Range selection | 0.4 | ✅ |
| Animated GIF | Port SnapShackle's GIF encoder and quantiser | 1.0 | ✅ |
| Audio-only (M4A / WAV) | Muxer audio-only path | 1.0 | ✅ |
| Presets and batch export | Saved option sets, queue | 1.0 | ✅ |
| Interactive player (quizzes, hotspots, TOC) | Static HTML player bundle | 1.x | ⬜ (decided: not built in Capstan; it belongs in Scrimshaw, which already authors quizzes and publishes standalone HTML; Capstan hands over MP4, WebVTT and chapters, see HANDOFFS.md) |

### Projects and library

| Feature | Plan | Release | Status |
| --- | --- | --- | --- |
| Autosave and restore | IndexedDB | 0.1 | ✅ |
| Project file (`.capstan`) | JSON | 0.1 | ✅ (edit only by design; the portable form is the `.capstanz` package) |
| Library on disk, survives browser resets and port changes | Host endpoints under `%LOCALAPPDATA%\Capstan` | 0.2 | ✅ (media is also stored under %LOCALAPPDATA%\Capstan\library through the host, so a project opened on another port finds it; the browser store is still used first and alone when there is no host) |
| Self-contained project package | Zip with media | 0.2 | ✅ (`.capstanz`) |
| Templates, themes, reusable assets | Library collections | 1.0 | ✅ |
| Import SnapShackle captures | Read `%LOCALAPPDATA%\SnapShackle\Captures` (older installs: `CutterMk` or `Lasso`) | 0.2 | 🟡 (through a folder picker; no host access) |