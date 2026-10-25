# Tech stack for local web apps

Local web apps: PowerShell 5.1 serves a browser UI on `127.0.0.1` (Edge/Chrome).

## Use

| Layer | Choice |
| --- | --- |
| Launcher | `.bat` → `powershell.exe -File` |
| Local server | PowerShell 5.1 + `TcpListener` on `127.0.0.1` |
| UI | React 19 + TypeScript, or Svelte 5 |
| Styling | Tailwind CSS 4 + shadcn-style (CVA, Radix, Lucide) |
| Charts / diagrams / motion | Apache ECharts, React Flow, Motion |
| Browser compute | Rust → WebAssembly |
| Storage | IndexedDB (data), localStorage (settings) |
| Offline | Service workers, Web Workers |
| Encryption | Web Crypto (AES-GCM) in browser; DPAPI from PowerShell for secrets at rest |
| Native Windows | C# via `Add-Type` (.NET 4.8.1); WinForms/WPF from PowerShell if needed |

## Build rules

- Build off-workstation; ship compiled JS/CSS/WASM only
- Bundle all deps — no CDNs or runtime network calls
- No admin, installers, or services on the workstation

## Capstan: how it applies

| Area | Capstan choice | Why |
| --- | --- | --- |
| UI framework | React 19 + TypeScript, bundled with Bun into `dist/` | Panels, dialogs and the timeline are React; shares the stack with SnapShackle and Lazarette |
| Rendering engine | Framework-free TypeScript (`src/engine/`) on Canvas 2D | One compositor draws both the preview and every exported frame. React never runs per frame. |
| Video encode | **WebCodecs** `VideoEncoder` (H.264) and `AudioEncoder` (AAC, Opus fallback) | Built into Edge/Chrome; uses the GPU encoder where available. No FFmpeg, nothing to install. |
| MP4 container | Own muxer (`src/engine/mp4/muxer.ts`) | WebCodecs only produces encoded frames; the muxer writes standards-compliant MP4 (validated with ffprobe in CI) |
| Audio mix | Web Audio `OfflineAudioContext` | Sample-accurate mixdown of every clip with its volume |
| Recording | `getDisplayMedia` + `MediaRecorder` | Browser permission prompt, no native hooks needed for v0.1. Native cursor/hotkey capture (C# via `Add-Type`) comes later, as in SnapShackle. |
| Storage | IndexedDB: media as Blobs, projects as JSON | Per the stack. **Planned exception (v0.2):** media library as files under `%LOCALAPPDATA%\Capstan`, like SnapShackle's captures, so recordings survive browser resets and port changes. |
| CSP | `script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; media-src 'self' blob:` | WASM and workers are ready for the Rust compute phase; `blob:` media lets the editor play local files |
| Native | Edge `--app` window when Edge is present | Feels like a desktop app without installing one |

### Current deviations (to close)

- **Styling is plain CSS with design tokens, not Tailwind 4 + Radix yet.** The first build was made in an environment without package-registry access. Move to Tailwind/Radix once the build runs where `npm install` works (CI already installs packages).
- **No Rust → WASM yet.** Planned for the heavy lifting the browser cannot do natively: MP4/WebM demuxing for fast export, noise removal, waveform analysis and GIF quantisation (shared with SnapShackle's `lasso-core`).
- **Bundler is Bun.** It is only used off the workstation to produce `dist/`; nothing about it ships.
