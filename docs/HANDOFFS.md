# Hand-off formats: what Capstan writes and reads

The files that move between Capstan and the other Fleet apps. Each hand-off is a plain file, so no app needs to know another's internals. This is the Capstan side of the accepted Fleet relationship contracts (the "work flows" part); the other apps' sides are tracked in their own repositories.

## What Capstan writes

| File | Made by | Used by | Notes |
| --- | --- | --- | --- |
| MP4 (H.264 video, AAC audio, Opus where AAC is unavailable) | Export, format MP4 | Scrimshaw (course video), any player | Chapters from markers are written inside the file (a Nero `chpl` box); captions can be burned in. |
| WebVTT (`<name>.vtt`) and SRT (`<name>.srt`) | Captions tab, Save | Scrimshaw (captions track), any player | UTF-8. Times are seconds from the start of the project. |
| `<name> chapters.txt` and `<name> chapters.vtt` | Export, "Also save chapters files" | YouTube-style chapter lists; players that read a chapters track | Only markers marked as chapters. The first chapter is at 0:00. |
| PNG, GIF, WAV, M4A | Export, other formats | Job aids (PNG), short loops (GIF), narration or sound-only (WAV, M4A) | PNG is the frame under the playhead. |
| `.capstanz` | Project menu, Save package | Another computer running Capstan; archive | A zip with `manifest.json`, `project.json` and `media/<id>-<name>`. The portable form of a project. |
| `.capstan` | Toolbar, Save project file | Scripts and tools that read or generate projects | Plain JSON, the edit only, no media. Schema: `docs/project.schema.json` once it is merged (issue #34). |
| `<recording>.cursor.json` | Recording with cursor capture on | Capstan itself (cursor effects) | Format: [cursor-data.md](cursor-data.md). |

Media is named from the project name with characters Windows does not allow removed.

## What Capstan reads

| File | From | How it gets in | Notes |
| --- | --- | --- | --- |
| Video, audio, images (MP4, WebM, MOV, MP3, WAV, M4A, Ogg, PNG, JPEG and anything else the browser decodes) | Any app | Import media, or drop it in the window | A TalkForge voiceover is a WAV file imported this way; keep each sentence short (see [DEMO-RECIPE.md](DEMO-RECIPE.md)). |
| SRT, WebVTT | A script, another tool | Captions tab, Import captions | Cue settings, entities and voice tags are handled; NOTE and STYLE blocks are skipped. |
| PNG or video with a `.meta.json` OCR sidecar | SnapShackle | Project menu, Import from SnapShackle captures (host route) or the folder picker | The OCR text is kept with the media as its description. |
| `<name>.cursor.json` | The capture host, or any tool that follows the format | Cursor tab, Attach cursor data | Positions are fractions of the recorded frame. |
| `.capstanz`, `.capstan` | Capstan | Open project file | |

## Rules for the other apps

- **Scrimshaw**: take the MP4 (or the WebM recording), the `.vtt`, and the chapter list; Capstan does not need anything back. Scrimshaw's own roadmap lists the missing MP4 handling.
- **Gangplank**: publish whatever a person drops into a repository; Capstan only produces files and does not push to Git.
- **Bowerbird**: rename screenshots from the OCR text in SnapShackle's `.meta.json`; Capstan does not rename.
- **Semaphore**: Capstan does not export dashboards data; none is planned.
- **TalkForge**: write one WAV per sentence, 16-bit PCM; Capstan imports it like any audio file.

Changing a format here is a breaking change for those apps: add a field, do not rename one, and list the change in the pull request.
