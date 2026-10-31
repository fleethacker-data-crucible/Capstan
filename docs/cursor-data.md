# Cursor data (`<name>.cursor.json`)

Capstan draws cursor effects (smoothed cursor, halo, loupe, spotlight, click rings, click sounds, keystroke callouts) and suggests zooms from **cursor data attached to a recording**.

A browser cannot read the mouse or keyboard while another app is being recorded, so Capstan does not capture this data itself yet. It is loaded from a sidecar file: a small JSON file made by a low-level input hook (planned for the PowerShell/C# host, release 0.3) or by any other tool that follows this format. Nothing in Capstan invents cursor data.

Attach a file with the keyboard icon on a video in the Media bin, or with **Attach cursor data** in the Cursor tab. The data is stored in the project, so the file is not needed afterwards. The suggested file name is the media name with `.cursor.json` (`talk.webm` becomes `talk.cursor.json`).

## Format, version 1

```json
{
  "format": "capstan-cursor",
  "version": 1,
  "samples": [[0.0, 0.25, 0.30], [0.033, 0.25, 0.31]],
  "clicks":  [{ "t": 0.5, "button": "left", "down": true }, { "t": 0.58, "button": "left", "down": false }],
  "keys":    [{ "t": 2.4, "key": "Control", "down": true }, { "t": 2.45, "key": "c", "down": true }]
}
```

- `t` is seconds from the start of the recording. `x` and `y` are fractions of the recorded frame (0,0 top left; 1,1 bottom right), so the data does not depend on the recording's pixel size.
- `samples`: `[t, x, y]` triples (or `{ "t", "x", "y" }` objects). Record at 30 to 60 Hz; at least 10 Hz is needed for pause detection.
- `clicks`: `button` is `left`, `right` or `middle` (default `left`); `down` is `true` for a press and `false` for a release (default `true`). Rings and click sounds fire on presses.
- `keys`: `key` is a `KeyboardEvent.key` style name of 1 to 24 characters (`"c"`, `"Control"`, `"Shift"`, `"Alt"`, `"Meta"`, `"Enter"`, `"Escape"`, `"ArrowLeft"`, `"F5"`, `" "`). Send a press and a release for every key; repeated presses of a held key count once.
- `format` is optional; `version` must be `1`. `clicks` and `keys` are optional. At least one list must have entries.
- Lists are sorted by time on load. A file with any invalid entry is refused, and the message names the first problems.

## Limits

| What | Limit |
| --- | --- |
| Samples | 120,000 |
| Click events | 20,000 |
| Key events | 50,000 |
| Time | 0 to 86,400 s |
| File size | 24 MB of text |
| Replacement cursor image | PNG, SVG, WebP or JPEG up to 256 KB |

## What the effects do with it

- **Smoothing**: a cubic spline through the samples, averaged with a Gaussian window of up to 0.6 s centred on the frame being drawn. The whole recording is known, so the cursor does not lag. It is a pure function of time, so scrubbing, preview and export agree.
- **Hide / draw the cursor**: switches the cursor Capstan draws. A cursor already present in the recorded video cannot be removed.
- **Click rings**: a ring expands from each press over the chosen duration (a right click also draws an inner ring).
- **Keystroke callouts**: `Ctrl+C` style combos (Ctrl, Alt, Shift, Win held with a key), typed text joined into one bubble while keys are less than 0.8 s apart, and single bubbles for Enter, Esc, the arrows and similar.
- **Smart focus**: click clusters (clicks within 2 s and 20% of the frame of each other) and pauses (the cursor within 3% of the frame for 1.2 s) become suggested zoom regions. They are only added to the project when the user accepts them.
- Crop and rotation of the clip are followed. Playback speed is followed (the data is in source time).
