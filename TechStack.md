# Tech stack for local web apps

Local web apps: PowerShell 5.1 serves a browser UI on `127.0.0.1` (Edge/Chrome).

## Use

| Layer | Choice |
| --- | --- |
| Launcher | `.bat` → `powershell.exe -File` |
| Local server | PowerShell 5.1 + `TcpListener` on `127.0.0.1` (default), or `HttpListener` on loopback prefixes (see Local server note) |
| UI | React 19 + TypeScript, or Svelte 5 |
| Styling | Tailwind CSS 4 + shadcn-style (CVA, Radix, Lucide) |
| Charts / diagrams / motion | Apache ECharts, React Flow, Motion |
| Browser compute | Rust → WebAssembly |
| Storage | IndexedDB (data), localStorage (settings) |
| Offline | Service workers, Web Workers |
| Encryption | Web Crypto (AES-GCM) in browser; DPAPI from PowerShell for secrets at rest |
| Native Windows | C# via `Add-Type` (.NET 4.8.1); WinForms/WPF from PowerShell if needed |

## Local server note

Tested on the workstation with the Nautilus Test Suite (Windows 11 Enterprise 26200, Windows PowerShell 5.1, standard user): `TcpListener` on 2026-10-24, `HttpListener` on 2026-10-25.

- `TcpListener` on `127.0.0.1` is the default.
- `HttpListener` is allowed on `http://127.0.0.1:<port>/`, `http://localhost:<port>/` or both. All three passed with no admin rights or URL reservation. Never use `+`, `*` or a host name: those need admin. An app that uses `HttpListener` says so in its "how it applies" section.
- HTTP.sys does not filter the `Host` header on loopback, so every server checks `Host` and `Origin` itself, whichever listener it uses.
- Details: [LISTENER-EVALUATION.md](https://github.com/fleethacker-data-crucible/fleethacker-comms-data-crucible/blob/main/docs/LISTENER-EVALUATION.md) in the team repo.

## Build rules

- Build off-workstation; ship compiled JS/CSS/WASM only
- Bundle all deps — no CDNs or runtime network calls
- No admin, installers, or services on the workstation

## Lifecycle rules

A loopback app that keeps running after its tab closes is a defect: it hides, holds its DLLs and port, breaks the next build and burns CPU. Every app with a local server and a browser UI does all of these.

| Rule | Requirement |
| --- | --- |
| Tab owns the server | UI sends `POST /api/heartbeat` every 5 s and a `navigator.sendBeacon` "leaving" signal on `pagehide`. Server stops itself 20 s after the last heartbeat, or 5 s after a leaving signal with no new heartbeat. A reload sends a fresh heartbeat inside the grace period, so nothing happens. |
| Never stop mid-write | Auto-stop waits while a background job (save, export, sync, send) runs, then stops on the next tick. |
| Way out in the UI | An *End session* (or *Quit*) control in the main navigation stops the server cleanly. Tray apps also get *Exit* in the tray menu. |
| Way out from the shell | `Stop-<App>.ps1` finds and stops every running instance without knowing PIDs. |
| One instance | The launcher detects a running server and asks *stop it and start fresh?*. `--replace` answers yes; `--stay` keeps the server alive after the tab closes (long jobs, scheduled runs, tray/hotkey mode). |
| Build stops the app | Build/serve scripts call the stop logic first and say what they stopped. |
| Runtime file | On start write `logs\<app>-server-<pid>.json` (pid, port, url, start time; never the session token); delete it on stop. Stop scripts and launchers read these and delete stale ones (dead pid). |
| Off switch | `<APP>_AUTO_STOP=0` (env var or env file) disables auto-stop. |

Notes:

- The beacon cannot set headers, so the server accepts the session token in the JSON body on that one route only — never in the query string, never logged.
- A hidden PowerShell console counts: if the window is hidden or minimised, the user has no Ctrl+C.
- To find what holds a DLL, use the Windows Restart Manager (`RmRegisterResources` + `RmGetList`); `Process.Modules` misses .NET-mapped assemblies.
- Reference implementation: Halyard (formerly Cascade).

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
- **No Rust → WASM yet.** Planned for the heavy lifting the browser cannot do natively: MP4/WebM demuxing for fast export, noise removal, waveform analysis and GIF quantisation (potentially shared with SnapShackle's GIF code).
- **Bundler is Bun.** It is only used off the workstation to produce `dist/`; nothing about it ships.
