# Cursor data (`<name>.cursor.json`)

Capstan draws cursor effects (smoothed cursor, halo, loupe, spotlight, click rings, click sounds, keystroke callouts) and suggests zooms from **cursor data attached to a recording**.

A browser cannot read the mouse or keyboard while another app is being recorded, so the data comes from a sidecar file: a small JSON file made by Capstan's own host while you record (see [Capture](#capture-in-the-record-dialog)) or by any other tool that follows this format. Nothing in Capstan invents cursor data.

A capture attaches its file to the new recording by itself. Any other file is attached with the keyboard icon on a video in the Media bin, or with **Attach cursor data** in the Cursor tab. The data is stored in the project, so the file is not needed afterwards. The suggested file name is the media name with `.cursor.json` (`talk.webm` becomes `talk.cursor.json`).

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
- `keys`: `key` is a `KeyboardEvent.key` style name of 1 to 24 characters (`"c"`, `"Control"`, `"Shift"`, `"Alt"`, `"Meta"`, `"Enter"`, `"Escape"`, `"ArrowLeft"`, `"F5"`, `" "`), or a whole shortcut written the way it is shown (`"Ctrl+C"`, `"Ctrl+Shift+Esc"`, `"Alt+Tab"`, `"Win+E"`, `"F5"`). Send a press and a release for every key; repeated presses of a held key count once. The host's capture writes whole shortcuts only, so a file it made never contains a lone modifier or a typed character.
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

## Capture (in the Record dialog)

Choose **Capture cursor and keys for effects** in the Record dialog. It is off every time the dialog opens, and it needs **The entire screen**: a browser cannot tell where a shared window or tab is on the screen. A second box, **Include keyboard shortcuts**, is separate and also off. While you record, the recording bar shows **Capturing cursor** or **Capturing cursor and shortcuts**, and **Cursor capture paused** while the recording is paused. The pointer is left out of the video (`cursor: 'never'`) and Capstan draws it again from the data, with the drawn cursor switched on for the new recording. If the host cannot capture, the dialog says so, the pointer stays in the video, and the recording is made as usual.

### What is captured

- The pointer position about 60 times a second (a pointer that stays still is written about 12 times a second), as fractions of the captured screen, clamped to 0 to 1. Times are seconds from the start of the recording; a pause does not count.
- Left, right and middle button presses and releases, only while the pointer is over the captured screen.
- With **Include keyboard shortcuts** on: function keys (`F5`, `Shift+F5`), and any key pressed while Ctrl, Alt or the Windows key is held, written as one name (`Ctrl+C`, `Alt+Tab`, `Win+E`, `Ctrl+/`). Modifier order is Ctrl, Alt, Shift, Win.

### What is never captured

- Typed letters, digits, punctuation, Enter, Space, Backspace and the arrow keys, with or without Shift. Shift on its own is not a shortcut. The key filter (`Capstan.Cursor.KeyNames.Name`) gives these no name, so they cannot reach the file; `tests/ps/CursorCapture.Tests.ps1` checks every letter and digit.
- Keys while AltGr is held (it types characters on many keyboards), and Alt with number-pad digits (Alt codes).
- Window titles, screenshots, the clipboard, other processes, and which app has focus.
- Any key at all, unless that recording asked for shortcuts. Without it the keyboard is not read.

### Where it goes

The host writes `%LOCALAPPDATA%\Capstan\recordings\<recording id>.cursor.json` (the id is `rec-<date>-<time>-<random>`; nothing else is ever used as a file name, and an existing file is never overwritten), returns the same text to the page, and the page attaches it to the project. It is not sent anywhere else. You can delete the file whenever you like; the project keeps its own copy. A capture that is cancelled writes nothing.

### Limits and known gaps

- After about 33 minutes of constant movement the position rate is halved as often as needed to stay under 120,000 samples. 20,000 click events and 50,000 key events are the other caps; the host stops adding events past them. A capture ends by itself after 4 hours, and when the host stops.
- Buttons and keys are polled, so a tap shorter than one poll (about 16 ms) can be missed.
- Positions are read in physical screen pixels. The page works out the screen size from the browser (`screen` times the device pixel ratio), which is right for the screen Capstan is on at 100% browser zoom. With several screens of different scaling, or a zoomed page, the drawn cursor can be off; share the screen Capstan is on.
- Clock alignment: the host session starts just before the recorder. The page measures how long the start request took and places the host's clock at the middle of it, then shifts the data by the gap between that and the moment the recorder started, so the data lines up with the video to within a frame or two. Each pause or resume adds the delay of one request (a few milliseconds).
