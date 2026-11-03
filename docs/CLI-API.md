# Capstan CLI and API

Capstan actions follow the Fleet action framework. An action id is `capstan.<noun>.<verb>`. The CLI, the local API, and the buttons marked `data-action` name the same action. Host actions run in Windows PowerShell 5.1. Editor actions run in the open Capstan page, because they need the project, the media bytes, or a browser encoder.

Discovery is `capstan.ps1 commands --json`. `capstan.ps1 help --json` prints the same document (`fleet.commands/1`).

```powershell
capstan.ps1 commands --json
capstan.ps1 help --json
capstan.ps1 <noun> <verb> [--json] [--out FILE] [--yes] [--dry-run] [--option value]
capstan.ps1 job run --file examples/training-to-course.job.json --json
```

`--yes` maps to the parameter `-Confirmed`. A destructive action does nothing without it. `--dry-run` does not change anything and does not need `--yes`. `--out FILE` writes the JSON document as UTF-8 without a BOM. `--json` prints one JSON object on standard output.

Exit codes: `0` the action ran, `1` it could not do the work or it needs the open page (`needs-browser`), `2` the options were wrong or a destructive action had no `--yes` (`needs-confirm`).

Job files are JSON only (`fleet.job/1`, extension `.json`).

The API is on the same loopback listener as the editor, `http://127.0.0.1:<port>/` (8790 unless that port is taken). Send the session token in the `X-Capstan-Token` header. Do not put it in the URL, the command line, a job file, or HTML. The examples below use `$CAPSTAN_TOKEN` for that header.

| Method | Path |
| --- | --- |
| GET | `/api/commands` |
| GET | `/api/help` |
| POST | `/api/actions/<app.noun.verb>` |
| POST | `/api/jobs` |

A POST body is `{ "args": { }, "confirmed": false, "dryRun": false }`.

## Training to course

SnapShackle writes captures. Capstan reads them and a `.capstan` project, then writes the chapter list and captions Scrimshaw can attach to the lesson. The job is [examples/training-to-course.job.json](../examples/training-to-course.job.json). Run it from the repository root.

```powershell
capstan.ps1 job run --file examples/training-to-course.job.json --json
```

```json
{
  "schema": "fleet.job/1",
  "name": "training-to-course",
  "actions": [
    {
      "action": "capstan.captures.list",
      "args": {}
    },
    {
      "action": "capstan.file.show",
      "args": { "file": "examples/training-lesson.capstan" }
    },
    {
      "action": "capstan.handoff.chapters",
      "args": { "file": "examples/training-lesson.capstan", "format": "text" }
    },
    {
      "action": "capstan.handoff.captions",
      "args": { "file": "examples/training-lesson.capstan", "format": "vtt" }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/jobs -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data @examples/training-to-course.job.json
```

## Actions (140)

Page actions answer `needs-browser` when nothing is editing. Pass `--dry-run` to check the options. Destructive actions need `--yes`.

### capstan.annotation.add

Add a text, callout, shape, arrow, line, highlight or spotlight at a time. Runs in the open editor.

```powershell
capstan.ps1 annotation add --kind text --start 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.annotation.add",
      "args": {
        "kind": "text",
        "start": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.annotation.add -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"kind":"text","start":0},"dryRun":true,"confirmed":false}'
```

### capstan.annotation.duplicate

Copy an annotation just above the original, nudged down and right. Runs in the open editor.

```powershell
capstan.ps1 annotation duplicate --annotation id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.annotation.duplicate",
      "args": {
        "annotation": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.annotation.duplicate -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"annotation":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.annotation.move

Move an annotation’s box by a distance in canvas pixels; x and y keyframes move with it. Runs in the open editor.

```powershell
capstan.ps1 annotation move --annotation id_example --dx 1 --dy 1 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.annotation.move",
      "args": {
        "annotation": "id_example",
        "dx": 1,
        "dy": 1
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.annotation.move -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"annotation":"id_example","dx":1,"dy":1},"dryRun":true,"confirmed":false}'
```

### capstan.annotation.preset

Apply a ready-made style (title, lower third, code, note, warning ...) to an annotation. Runs in the open editor.

```powershell
capstan.ps1 annotation preset --annotation id_example --preset title --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.annotation.preset",
      "args": {
        "annotation": "id_example",
        "preset": "title"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.annotation.preset -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"annotation":"id_example","preset":"title"},"dryRun":true,"confirmed":false}'
```

### capstan.annotation.remove

Remove an annotation. Runs in the open editor.

```powershell
capstan.ps1 annotation remove --annotation id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.annotation.remove",
      "args": {
        "annotation": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.annotation.remove -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"annotation":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.annotation.reorder

Change the drawing order: later annotations draw on top. Runs in the open editor.

```powershell
capstan.ps1 annotation reorder --annotation id_example --order front --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.annotation.reorder",
      "args": {
        "annotation": "id_example",
        "order": "front"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.annotation.reorder -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"annotation":"id_example","order":"front"},"dryRun":true,"confirmed":false}'
```

### capstan.annotation.update

Change an annotation’s text, timing, box, opacity or style. Keyframes and behavior are kept. Runs in the open editor.

```powershell
capstan.ps1 annotation update --annotation id_example --start 0 --duration 0.03333333333333333 --x 1 --y 1 --width 1 --height 1 --rotation -360 --opacity 0 --text example --sketch 0 --style {"example":true} --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.annotation.update",
      "args": {
        "annotation": "id_example",
        "start": 0,
        "duration": 0.03333333333333333,
        "x": 1,
        "y": 1,
        "width": 1,
        "height": 1,
        "rotation": -360,
        "opacity": 0,
        "text": "example",
        "sketch": 0,
        "style": {
          "example": true
        }
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.annotation.update -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"annotation":"id_example","start":0,"duration":0.03333333333333333,"x":1,"y":1,"width":1,"height":1,"rotation":-360,"opacity":0,"text":"example","sketch":0,"style":{"example":true}},"dryRun":true,"confirmed":false}'
```

### capstan.audio.denoise

Remove steady background noise from a clip. Decodes the sound, makes a new audio file in the bin and switches the clip to it. Runs in the open editor.

```powershell
capstan.ps1 audio denoise --clip id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.audio.denoise",
      "args": {
        "clip": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.audio.denoise -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.audio.duck

Make a narration clip pull the audio on the other tracks down while it speaks (or turn that off). Runs in the open editor.

```powershell
capstan.ps1 audio duck --clip id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.audio.duck",
      "args": {
        "clip": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.audio.duck -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.audio.fade

Set the fade in and fade out of a clip’s sound, in seconds (0 removes a fade). Runs in the open editor.

```powershell
capstan.ps1 audio fade --clip id_example --fade-in 0 --fade-out 0 --curve linear --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.audio.fade",
      "args": {
        "clip": "id_example",
        "fadeIn": 0,
        "fadeOut": 0,
        "curve": "linear"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.audio.fade -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","fadeIn":0,"fadeOut":0,"curve":"linear"},"dryRun":true,"confirmed":false}'
```

### capstan.audio.level

Even out loud and quiet parts and bring a clip to a target loudness. Decodes the sound, makes a new audio file in the bin and switches the clip to it. Runs in the open editor.

```powershell
capstan.ps1 audio level --clip id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.audio.level",
      "args": {
        "clip": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.audio.level -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.audio.point-remove

Remove the volume point at a time. Runs in the open editor.

```powershell
capstan.ps1 audio point-remove --clip id_example --time 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.audio.point-remove",
      "args": {
        "clip": "id_example",
        "time": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.audio.point-remove -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","time":0},"dryRun":true,"confirmed":false}'
```

### capstan.audio.point-set

Set a volume point on a clip at a time (replaces a point at the same time). Between points the volume ramps. Runs in the open editor.

```powershell
capstan.ps1 audio point-set --clip id_example --time 0 --value 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.audio.point-set",
      "args": {
        "clip": "id_example",
        "time": 0,
        "value": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.audio.point-set -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","time":0,"value":0},"dryRun":true,"confirmed":false}'
```

### capstan.audio.points-clear

Remove every volume point of a clip. Runs in the open editor.

```powershell
capstan.ps1 audio points-clear --clip id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.audio.points-clear",
      "args": {
        "clip": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.audio.points-clear -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.batch.add

Queue an export (a preset, or the current export settings) for the batch. Runs in the open editor.

```powershell
capstan.ps1 batch add --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.batch.add",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.batch.add -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.batch.cancel

Cancel a queued or running batch item. Runs in the open editor.

```powershell
capstan.ps1 batch cancel --item id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.batch.cancel",
      "args": {
        "item": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.batch.cancel -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"item":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.batch.clear

Remove the finished items from the batch queue. Runs in the open editor.

```powershell
capstan.ps1 batch clear --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.batch.clear",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.batch.clear -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.batch.remove

Remove one item from the batch queue. Runs in the open editor.

```powershell
capstan.ps1 batch remove --item id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.batch.remove",
      "args": {
        "item": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.batch.remove -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"item":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.batch.retry

Queue a failed or cancelled batch item again. Runs in the open editor.

```powershell
capstan.ps1 batch retry --item id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.batch.retry",
      "args": {
        "item": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.batch.retry -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"item":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.batch.run

Run every queued export in order. Runs in the open editor.

```powershell
capstan.ps1 batch run --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.batch.run",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.batch.run -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.behavior.clear

Remove a clip’s entrance, emphasis or exit animation. Runs in the open editor.

```powershell
capstan.ps1 behavior clear --clip id_example --stage enter --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.behavior.clear",
      "args": {
        "clip": "id_example",
        "stage": "enter"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.behavior.clear -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","stage":"enter"},"dryRun":true,"confirmed":false}'
```

### capstan.behavior.set

Give a clip an entrance, emphasis or exit animation. Runs in the open editor.

```powershell
capstan.ps1 behavior set --clip id_example --stage enter --type fade --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.behavior.set",
      "args": {
        "clip": "id_example",
        "stage": "enter",
        "type": "fade"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.behavior.set -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","stage":"enter","type":"fade"},"dryRun":true,"confirmed":false}'
```

### capstan.caption.add

Add a caption at a time (after a caption already showing there, and ending before the next one). Runs in the open editor.

```powershell
capstan.ps1 caption add --time 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.caption.add",
      "args": {
        "time": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.caption.add -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"time":0},"dryRun":true,"confirmed":false}'
```

### capstan.caption.clear

Remove every caption. Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 caption clear --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.caption.clear",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.caption.clear -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.caption.export-srt

Return the captions as SubRip (.srt) text. Runs in the open editor.

```powershell
capstan.ps1 caption export-srt --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.caption.export-srt",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.caption.export-srt -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.caption.export-vtt

Return the captions as WebVTT (.vtt) text. Runs in the open editor.

```powershell
capstan.ps1 caption export-vtt --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.caption.export-vtt",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.caption.export-vtt -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.caption.merge

Join a caption with the one after it: text on separate lines, time from the first start to the last end. Runs in the open editor.

```powershell
capstan.ps1 caption merge --caption id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.caption.merge",
      "args": {
        "caption": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.caption.merge -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"caption":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.caption.remove

Remove a caption. Runs in the open editor.

```powershell
capstan.ps1 caption remove --caption id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.caption.remove",
      "args": {
        "caption": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.caption.remove -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"caption":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.caption.set

Replace all captions with the cues in SRT or WebVTT text. Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 caption set --text example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.caption.set",
      "args": {
        "text": "example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.caption.set -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"text":"example"},"dryRun":true,"confirmed":false}'
```

### capstan.caption.shift

Move captions earlier or later by some seconds (never before 0). Runs in the open editor.

```powershell
capstan.ps1 caption shift --delta -86400 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.caption.shift",
      "args": {
        "delta": -86400
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.caption.shift -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"delta":-86400},"dryRun":true,"confirmed":false}'
```

### capstan.caption.split

Cut the caption showing at a time in two, splitting the text in proportion. Runs in the open editor.

```powershell
capstan.ps1 caption split --time 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.caption.split",
      "args": {
        "time": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.caption.split -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"time":0},"dryRun":true,"confirmed":false}'
```

### capstan.caption.update

Change a caption’s text or timing. Runs in the open editor.

```powershell
capstan.ps1 caption update --caption id_example --text example --start 0 --end 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.caption.update",
      "args": {
        "caption": "id_example",
        "text": "example",
        "start": 0,
        "end": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.caption.update -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"caption":"id_example","text":"example","start":0,"end":0},"dryRun":true,"confirmed":false}'
```

### capstan.captures.list

List SnapShackle captures the host can read (name, size, kind, and whether OCR text is stored). The newest 500. Runs in PowerShell.

```powershell
capstan.ps1 captures list --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.captures.list",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.captures.list -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":false,"confirmed":false}'
```

### capstan.clip.add

Put a media item on the timeline at a time, on a track with room (a new track is added when none has). Runs in the open editor.

```powershell
capstan.ps1 clip add --media id_example --start 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.add",
      "args": {
        "media": "id_example",
        "start": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.add -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"media":"id_example","start":0},"dryRun":true,"confirmed":false}'
```

### capstan.clip.close-gaps

Close every gap on a track, from the start. Runs in the open editor.

```powershell
capstan.ps1 clip close-gaps --track id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.close-gaps",
      "args": {
        "track": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.close-gaps -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"track":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.clip.crop

Show only part of the source picture. Fractions of the source frame; or an aspect ratio, or clear. Runs in the open editor.

```powershell
capstan.ps1 clip crop --clip id_example --x 0 --y 0 --width 0.02 --height 0.02 --aspect 0.1 --clear true --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.crop",
      "args": {
        "clip": "id_example",
        "x": 0,
        "y": 0,
        "width": 0.02,
        "height": 0.02,
        "aspect": 0.1,
        "clear": true
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.crop -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","x":0,"y":0,"width":0.02,"height":0.02,"aspect":0.1,"clear":true},"dryRun":true,"confirmed":false}'
```

### capstan.clip.delete

Delete clips together with the clips linked or grouped with them. Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 clip delete --clips id_a,id_b --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.delete",
      "args": {
        "clips": [
          "id_a",
          "id_b"
        ]
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.delete -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clips":["id_a","id_b"]},"dryRun":true,"confirmed":false}'
```

### capstan.clip.detach-audio

Split the sound off a video clip onto its own linked audio clip. Runs in the open editor.

```powershell
capstan.ps1 clip detach-audio --clip id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.detach-audio",
      "args": {
        "clip": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.detach-audio -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.clip.duplicate

Copy clips (with their groups and links) to just after the selection, or to a given time (copy and paste). Runs in the open editor.

```powershell
capstan.ps1 clip duplicate --clips id_a,id_b --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.duplicate",
      "args": {
        "clips": [
          "id_a",
          "id_b"
        ]
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.duplicate -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clips":["id_a","id_b"]},"dryRun":true,"confirmed":false}'
```

### capstan.clip.extend

Hold a clip’s last picture for some seconds after it ends. Runs in the open editor.

```powershell
capstan.ps1 clip extend --clip id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.extend",
      "args": {
        "clip": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.extend -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.clip.freeze

Hold the picture at a time for some seconds (a freeze frame). Runs in the open editor.

```powershell
capstan.ps1 clip freeze --clip id_example --time 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.freeze",
      "args": {
        "clip": "id_example",
        "time": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.freeze -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","time":0},"dryRun":true,"confirmed":false}'
```

### capstan.clip.group

Put two or more clips in a group that selects, moves, trims and deletes together. Runs in the open editor.

```powershell
capstan.ps1 clip group --clips id_a,id_b --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.group",
      "args": {
        "clips": [
          "id_a",
          "id_b"
        ]
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.group -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clips":["id_a","id_b"]},"dryRun":true,"confirmed":false}'
```

### capstan.clip.move

Move a clip (with its group or linked audio) to a start time, optionally on another track. It settles in the nearest free gap. Runs in the open editor.

```powershell
capstan.ps1 clip move --clip id_example --start 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.move",
      "args": {
        "clip": "id_example",
        "start": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.move -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","start":0},"dryRun":true,"confirmed":false}'
```

### capstan.clip.props

Set a clip’s position, size, rotation, opacity or volume. Runs in the open editor.

```powershell
capstan.ps1 clip props --clip id_example --x 1 --y 1 --scale 0.01 --rotation -360 --opacity 0 --volume 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.props",
      "args": {
        "clip": "id_example",
        "x": 1,
        "y": 1,
        "scale": 0.01,
        "rotation": -360,
        "opacity": 0,
        "volume": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.props -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","x":1,"y":1,"scale":0.01,"rotation":-360,"opacity":0,"volume":0},"dryRun":true,"confirmed":false}'
```

### capstan.clip.remove-gap

Close the gap at a time on a track: later clips move earlier by the gap’s length. Runs in the open editor.

```powershell
capstan.ps1 clip remove-gap --track id_example --time 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.remove-gap",
      "args": {
        "track": "id_example",
        "time": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.remove-gap -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"track":"id_example","time":0},"dryRun":true,"confirmed":false}'
```

### capstan.clip.speed

Change playback speed. The clip keeps showing the same stretch of source, so its length on the timeline changes. Runs in the open editor.

```powershell
capstan.ps1 clip speed --clip id_example --speed 0.1 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.speed",
      "args": {
        "clip": "id_example",
        "speed": 0.1
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.speed -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","speed":0.1},"dryRun":true,"confirmed":false}'
```

### capstan.clip.split

Cut clips in two at a time: the given clips under it, otherwise every clip under it. Linked and grouped clips split too. Runs in the open editor.

```powershell
capstan.ps1 clip split --time 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.split",
      "args": {
        "time": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.split -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"time":0},"dryRun":true,"confirmed":false}'
```

### capstan.clip.trim

Move one edge of a clip. Linked and grouped clips with the same edge follow. Runs in the open editor.

```powershell
capstan.ps1 clip trim --clip id_example --edge start --time 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.trim",
      "args": {
        "clip": "id_example",
        "edge": "start",
        "time": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.trim -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","edge":"start","time":0},"dryRun":true,"confirmed":false}'
```

### capstan.clip.ungroup

Dissolve the groups the given clips belong to. Runs in the open editor.

```powershell
capstan.ps1 clip ungroup --clips id_a,id_b --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.ungroup",
      "args": {
        "clips": [
          "id_a",
          "id_b"
        ]
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.ungroup -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clips":["id_a","id_b"]},"dryRun":true,"confirmed":false}'
```

### capstan.clip.unlink

Break the link between a video clip and the audio detached from it, so they move separately. Runs in the open editor.

```powershell
capstan.ps1 clip unlink --clips id_a,id_b --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.clip.unlink",
      "args": {
        "clips": [
          "id_a",
          "id_b"
        ]
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.clip.unlink -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clips":["id_a","id_b"]},"dryRun":true,"confirmed":false}'
```

### capstan.cursor.attach

Attach recorded cursor, click and key data (the text of a .cursor.json file) to a media item. Runs in the open editor.

```powershell
capstan.ps1 cursor attach --media id_example --sidecar example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.cursor.attach",
      "args": {
        "media": "id_example",
        "sidecar": "example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.cursor.attach -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"media":"id_example","sidecar":"example"},"dryRun":true,"confirmed":false}'
```

### capstan.cursor.detach

Remove the cursor data from a media item. Runs in the open editor.

```powershell
capstan.ps1 cursor detach --media id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.cursor.detach",
      "args": {
        "media": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.cursor.detach -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"media":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.cursor.reset

Remove every cursor effect setting from the project. Runs in the open editor.

```powershell
capstan.ps1 cursor reset --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.cursor.reset",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.cursor.reset -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.cursor.settings

Change how the recorded cursor is drawn: shape, size, smoothing, highlight, magnify, spotlight, click rings and sounds, keystroke callouts. Runs in the open editor.

```powershell
capstan.ps1 cursor settings --enabled true --show-cursor true --shape arrow --size 0.5 --color example --smoothing 0 --image-hot-x 0 --image-hot-y 0 --highlight true --highlight-size 0.02 --highlight-color example --highlight-opacity 0.05 --magnify true --magnify-zoom 1.25 --magnify-size 0.05 --spotlight true --spotlight-size 0.05 --spotlight-dim 0 --click-rings true --click-color example --click-size 0.02 --click-duration 0.2 --click-sound true --click-volume 0 --keys true --keys-hold 0.3 --keys-size 0.5 --image example --clear-image true --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.cursor.settings",
      "args": {
        "enabled": true,
        "showCursor": true,
        "shape": "arrow",
        "size": 0.5,
        "color": "example",
        "smoothing": 0,
        "imageHotX": 0,
        "imageHotY": 0,
        "highlight": true,
        "highlightSize": 0.02,
        "highlightColor": "example",
        "highlightOpacity": 0.05,
        "magnify": true,
        "magnifyZoom": 1.25,
        "magnifySize": 0.05,
        "spotlight": true,
        "spotlightSize": 0.05,
        "spotlightDim": 0,
        "clickRings": true,
        "clickColor": "example",
        "clickSize": 0.02,
        "clickDuration": 0.2,
        "clickSound": true,
        "clickVolume": 0,
        "keys": true,
        "keysHold": 0.3,
        "keysSize": 0.5,
        "image": "example",
        "clearImage": true
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.cursor.settings -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"enabled":true,"showCursor":true,"shape":"arrow","size":0.5,"color":"example","smoothing":0,"imageHotX":0,"imageHotY":0,"highlight":true,"highlightSize":0.02,"highlightColor":"example","highlightOpacity":0.05,"magnify":true,"magnifyZoom":1.25,"magnifySize":0.05,"spotlight":true,"spotlightSize":0.05,"spotlightDim":0,"clickRings":true,"clickColor":"example","clickSize":0.02,"clickDuration":0.2,"clickSound":true,"clickVolume":0,"keys":true,"keysHold":0.3,"keysSize":0.5,"image":"example","clearImage":true},"dryRun":true,"confirmed":false}'
```

### capstan.cursor.show

Show whether the host can record cursor and key data while a capture is running. Runs in PowerShell.

```powershell
capstan.ps1 cursor show --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.cursor.show",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.cursor.show -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":false,"confirmed":false}'
```

### capstan.diagnostics.run

Report the PowerShell host and that Capstan binds to 127.0.0.1 only. Does not start a server. Runs in PowerShell.

```powershell
capstan.ps1 diagnostics run --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.diagnostics.run",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.diagnostics.run -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":false,"confirmed":false}'
```

### capstan.effects.clear

Remove every effect from clips. Runs in the open editor.

```powershell
capstan.ps1 effects clear --clips id_a,id_b --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.effects.clear",
      "args": {
        "clips": [
          "id_a",
          "id_b"
        ]
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.effects.clear -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clips":["id_a","id_b"]},"dryRun":true,"confirmed":false}'
```

### capstan.effects.preset

Apply a one-click look (green screen, rounded card, device frames, colour looks, blend modes) on top of the current effects. Runs in the open editor.

```powershell
capstan.ps1 effects preset --clips id_a,id_b --preset green-screen --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.effects.preset",
      "args": {
        "clips": [
          "id_a",
          "id_b"
        ],
        "preset": "green-screen"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.effects.preset -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clips":["id_a","id_b"],"preset":"green-screen"},"dryRun":true,"confirmed":false}'
```

### capstan.effects.set

Apply effects to clips. Each group you give (colour, chroma, shadow, border, radius, mask, blend, frame) replaces that group; the others stay. Runs in the open editor.

```powershell
capstan.ps1 effects set --clips id_a,id_b --effects {"example":true} --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.effects.set",
      "args": {
        "clips": [
          "id_a",
          "id_b"
        ],
        "effects": {
          "example": true
        }
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.effects.set -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clips":["id_a","id_b"],"effects":{"example":true}},"dryRun":true,"confirmed":false}'
```

### capstan.export.cancel

Cancel the export that is running, or the whole batch. Runs in the open editor.

```powershell
capstan.ps1 export cancel --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.export.cancel",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.export.cancel -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.export.gif

Render the timeline to an animated GIF. Runs in the open editor.

```powershell
capstan.ps1 export gif --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.export.gif",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.export.gif -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.export.m4a

Mix the timeline’s sound to an AAC M4A file. Runs in the open editor.

```powershell
capstan.ps1 export m4a --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.export.m4a",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.export.m4a -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.export.mp4

Render the timeline to an H.264 MP4 with AAC (or Opus) sound. Runs in the open editor.

```powershell
capstan.ps1 export mp4 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.export.mp4",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.export.mp4 -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.export.png

Save one frame of the timeline as a PNG. Runs in the open editor.

```powershell
capstan.ps1 export png --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.export.png",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.export.png -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.export.wav

Mix the timeline’s sound to an uncompressed WAV file. Runs in the open editor.

```powershell
capstan.ps1 export wav --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.export.wav",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.export.wav -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.file.show

Read a .capstan project file and report its size, counts, chapters, and captions. Does not open the editor. Runs in PowerShell.

```powershell
capstan.ps1 file show --file examples/training-lesson.capstan --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.file.show",
      "args": {
        "file": "examples/training-lesson.capstan"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.file.show -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"file":"examples/training-lesson.capstan"},"dryRun":false,"confirmed":false}'
```

### capstan.handoff.captions

Write the captions from a .capstan file as SRT or WebVTT for Scrimshaw. Headless. Runs in PowerShell.

```powershell
capstan.ps1 handoff captions --file examples/training-lesson.capstan --format vtt --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.handoff.captions",
      "args": {
        "file": "examples/training-lesson.capstan",
        "format": "vtt"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.handoff.captions -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"file":"examples/training-lesson.capstan","format":"vtt"},"dryRun":false,"confirmed":false}'
```

### capstan.handoff.chapters

Write the chapter list from a .capstan file as text or WebVTT for Scrimshaw or a player. Headless. Runs in PowerShell.

```powershell
capstan.ps1 handoff chapters --file examples/training-lesson.capstan --format text --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.handoff.chapters",
      "args": {
        "file": "examples/training-lesson.capstan",
        "format": "text"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.handoff.chapters -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"file":"examples/training-lesson.capstan","format":"text"},"dryRun":false,"confirmed":false}'
```

### capstan.history.redo

Redo an undone edit in the open editor. Runs in the open editor.

```powershell
capstan.ps1 history redo --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.history.redo",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.history.redo -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.history.undo

Undo the last edit in the open editor. Runs in the open editor.

```powershell
capstan.ps1 history undo --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.history.undo",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.history.undo -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.host.show

Show the local Capstan host: name, version, and that it stays on this computer. Runs in PowerShell.

```powershell
capstan.ps1 host show --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.host.show",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.host.show -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":false,"confirmed":false}'
```

### capstan.hotkeys.show

Show whether global hotkeys and the tray icon are available. Runs in PowerShell.

```powershell
capstan.ps1 hotkeys show --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.hotkeys.show",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.hotkeys.show -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":false,"confirmed":false}'
```

### capstan.job.run

Run a JSON job file. Each step is an action. The file must be .json. Runs in PowerShell.

```powershell
capstan.ps1 job run --file examples/training-to-course.job.json --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.job.run",
      "args": {
        "file": "examples/training-to-course.job.json"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.job.run -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"file":"examples/training-to-course.job.json"},"dryRun":false,"confirmed":false}'
```

### capstan.keyframe.clear

Remove every keyframe on a clip, or on one property. Runs in the open editor.

```powershell
capstan.ps1 keyframe clear --clip id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.keyframe.clear",
      "args": {
        "clip": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.keyframe.clear -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.keyframe.ease

Change the easing used from a keyframe to the next one. Runs in the open editor.

```powershell
capstan.ps1 keyframe ease --clip id_example --prop x --time 0 --ease linear --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.keyframe.ease",
      "args": {
        "clip": "id_example",
        "prop": "x",
        "time": 0,
        "ease": "linear"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.keyframe.ease -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","prop":"x","time":0,"ease":"linear"},"dryRun":true,"confirmed":false}'
```

### capstan.keyframe.remove

Remove the keyframe on a clip property at a time. Runs in the open editor.

```powershell
capstan.ps1 keyframe remove --clip id_example --prop x --time 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.keyframe.remove",
      "args": {
        "clip": "id_example",
        "prop": "x",
        "time": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.keyframe.remove -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","prop":"x","time":0},"dryRun":true,"confirmed":false}'
```

### capstan.keyframe.set

Set a keyframe on a clip property at a time (replaces a key at the same time). Without a value, the property’s current value is keyed. Runs in the open editor.

```powershell
capstan.ps1 keyframe set --clip id_example --prop x --time 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.keyframe.set",
      "args": {
        "clip": "id_example",
        "prop": "x",
        "time": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.keyframe.set -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","prop":"x","time":0},"dryRun":true,"confirmed":false}'
```

### capstan.library.add

Add a file (logo, music, sting, short clip) to the library, which belongs to no project. Runs in the open editor.

```powershell
capstan.ps1 library add --file example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.library.add",
      "args": {
        "file": "example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.library.add -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"file":"example"},"dryRun":true,"confirmed":false}'
```

### capstan.library.list

List media files kept on disk by the local library (id and size only, never the folder path). Runs in PowerShell.

```powershell
capstan.ps1 library list --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.library.list",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.library.list -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":false,"confirmed":false}'
```

### capstan.library.remove

Remove an asset from the library. Projects that already use it keep their own copy. Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 library remove --asset id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.library.remove",
      "args": {
        "asset": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.library.remove -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"asset":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.library.save

Save a media item from this project to the library. Runs in the open editor.

```powershell
capstan.ps1 library save --media id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.library.save",
      "args": {
        "media": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.library.save -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"media":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.library.use

Add a library asset to this project’s media bin. Runs in the open editor.

```powershell
capstan.ps1 library use --asset id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.library.use",
      "args": {
        "asset": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.library.use -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"asset":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.marker.add

Add a marker on the timeline; a chapter marker is written to the exported video. Runs in the open editor.

```powershell
capstan.ps1 marker add --time 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.marker.add",
      "args": {
        "time": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.marker.add -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"time":0},"dryRun":true,"confirmed":false}'
```

### capstan.marker.chapter

Make a marker a chapter, or an ordinary marker again. Runs in the open editor.

```powershell
capstan.ps1 marker chapter --marker id_example --chapter true --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.marker.chapter",
      "args": {
        "marker": "id_example",
        "chapter": true
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.marker.chapter -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"marker":"id_example","chapter":true},"dryRun":true,"confirmed":false}'
```

### capstan.marker.export-chapters

Return the chapter markers as a YouTube-style list or a WebVTT chapters track. Runs in the open editor.

```powershell
capstan.ps1 marker export-chapters --format text --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.marker.export-chapters",
      "args": {
        "format": "text"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.marker.export-chapters -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"format":"text"},"dryRun":true,"confirmed":false}'
```

### capstan.marker.move

Move a marker to a time. Runs in the open editor.

```powershell
capstan.ps1 marker move --marker id_example --time 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.marker.move",
      "args": {
        "marker": "id_example",
        "time": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.marker.move -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"marker":"id_example","time":0},"dryRun":true,"confirmed":false}'
```

### capstan.marker.remove

Remove a marker. Runs in the open editor.

```powershell
capstan.ps1 marker remove --marker id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.marker.remove",
      "args": {
        "marker": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.marker.remove -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"marker":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.marker.rename

Rename a marker. Runs in the open editor.

```powershell
capstan.ps1 marker rename --marker id_example --name example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.marker.rename",
      "args": {
        "marker": "id_example",
        "name": "example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.marker.rename -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"marker":"id_example","name":"example"},"dryRun":true,"confirmed":false}'
```

### capstan.media.add

Add a media item to the project by its metadata. The bytes come from a media import; this registers a description of a file. Runs in the open editor.

```powershell
capstan.ps1 media add --name example --kind video --duration 0 --width 0 --height 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.media.add",
      "args": {
        "name": "example",
        "kind": "video",
        "duration": 0,
        "width": 0,
        "height": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.media.add -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"name":"example","kind":"video","duration":0,"width":0,"height":0},"dryRun":true,"confirmed":false}'
```

### capstan.media.import

Import media files (video, audio, images) into the project’s media bin. Runs in the open editor.

```powershell
capstan.ps1 media import --file example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.media.import",
      "args": {
        "file": "example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.media.import -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"file":"example"},"dryRun":true,"confirmed":false}'
```

### capstan.media.import-captures

Import the images and videos from a SnapShackle Captures folder. Runs in the open editor.

```powershell
capstan.ps1 media import-captures --folder example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.media.import-captures",
      "args": {
        "folder": "example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.media.import-captures -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"folder":"example"},"dryRun":true,"confirmed":false}'
```

### capstan.media.remove

Remove a media item and every clip that uses it. Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 media remove --media id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.media.remove",
      "args": {
        "media": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.media.remove -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"media":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.package.open

Open a .capstanz package: verify it, store its media, then open the project. A project already here opens as a copy. Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 package open --file example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.package.open",
      "args": {
        "file": "example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.package.open -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"file":"example"},"dryRun":true,"confirmed":false}'
```

### capstan.package.save

Save the project and all its media as one .capstanz package file. Runs in the open editor.

```powershell
capstan.ps1 package save --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.package.save",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.package.save -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.preset.remove

Delete a saved export preset. Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 preset remove --name example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.preset.remove",
      "args": {
        "name": "example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.preset.remove -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"name":"example"},"dryRun":true,"confirmed":false}'
```

### capstan.preset.save

Save export settings as a named preset in this browser. Runs in the open editor.

```powershell
capstan.ps1 preset save --name example --format mp4 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.preset.save",
      "args": {
        "name": "example",
        "format": "mp4"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.preset.save -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"name":"example","format":"mp4"},"dryRun":true,"confirmed":false}'
```

### capstan.project.from-template

Replace the project with an empty one laid out like a built-in template. Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 project from-template --template builtin-tutorial-16x9 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.project.from-template",
      "args": {
        "template": "builtin-tutorial-16x9"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.project.from-template -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"template":"builtin-tutorial-16x9"},"dryRun":true,"confirmed":false}'
```

### capstan.project.new

Replace the project with a new, empty one. Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 project new --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.project.new",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.project.new -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.project.open

Replace the project with one read from a .capstan file (the edit only; media bytes are not in it). Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 project open --project {"example":true} --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.project.open",
      "args": {
        "project": {
          "example": true
        }
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.project.open -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"project":{"example":true}},"dryRun":true,"confirmed":false}'
```

### capstan.project.resize

Change the canvas size; clips, annotations, zooms and blur regions keep their relative place. Runs in the open editor.

```powershell
capstan.ps1 project resize --width 16 --height 16 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.project.resize",
      "args": {
        "width": 16,
        "height": 16
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.project.resize -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"width":16,"height":16},"dryRun":true,"confirmed":false}'
```

### capstan.project.save

Write the project as .capstan file text (the edit only). The caller stores the text. Runs in the open editor.

```powershell
capstan.ps1 project save --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.project.save",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.project.save -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.project.set

Change the project name, frame rate or background colour. Runs in the open editor.

```powershell
capstan.ps1 project set --name example --fps 1 --background example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.project.set",
      "args": {
        "name": "example",
        "fps": 1,
        "background": "example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.project.set -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"name":"example","fps":1,"background":"example"},"dryRun":true,"confirmed":false}'
```

### capstan.project.show

Show the project: size, frame rate, length and how many of each item it holds. Runs in the open editor.

```powershell
capstan.ps1 project show --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.project.show",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.project.show -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.project.theme

Apply a theme to the project (today: the canvas background). Runs in the open editor.

```powershell
capstan.ps1 project theme --theme night-watch --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.project.theme",
      "args": {
        "theme": "night-watch"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.project.theme -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"theme":"night-watch"},"dryRun":true,"confirmed":false}'
```

### capstan.projects.delete

Delete a stored project and its media from this browser. Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 projects delete --project id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.projects.delete",
      "args": {
        "project": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.projects.delete -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"project":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.projects.duplicate

Copy a stored project, with its own copy of the media. Runs in the open editor.

```powershell
capstan.ps1 projects duplicate --project id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.projects.duplicate",
      "args": {
        "project": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.projects.duplicate -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"project":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.projects.list

List the projects stored in this browser. Runs in the open editor.

```powershell
capstan.ps1 projects list --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.projects.list",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.projects.list -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.projects.open

Open a project stored in this browser. Runs in the open editor.

```powershell
capstan.ps1 projects open --project id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.projects.open",
      "args": {
        "project": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.projects.open -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"project":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.projects.rename

Rename a stored project. Runs in the open editor.

```powershell
capstan.ps1 projects rename --project id_example --name example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.projects.rename",
      "args": {
        "project": "id_example",
        "name": "example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.projects.rename -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"project":"id_example","name":"example"},"dryRun":true,"confirmed":false}'
```

### capstan.range.clear

Clear the in and out marks. Runs in the open editor.

```powershell
capstan.ps1 range clear --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.range.clear",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.range.clear -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.range.mark-in

Mark the start of the part to export (the out mark moves to the end if it would fall before it). Runs in the open editor.

```powershell
capstan.ps1 range mark-in --time 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.range.mark-in",
      "args": {
        "time": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.range.mark-in -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"time":0},"dryRun":true,"confirmed":false}'
```

### capstan.range.mark-out

Mark the end of the part to export (the in mark moves to 0 if it would fall after it). Runs in the open editor.

```powershell
capstan.ps1 range mark-out --time 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.range.mark-out",
      "args": {
        "time": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.range.mark-out -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"time":0},"dryRun":true,"confirmed":false}'
```

### capstan.range.set

Set the in and out marks: the part of the timeline an "In to out" export covers. Runs in the open editor.

```powershell
capstan.ps1 range set --start 0 --end 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.range.set",
      "args": {
        "start": 0,
        "end": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.range.set -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"start":0,"end":0},"dryRun":true,"confirmed":false}'
```

### capstan.record.cancel

Abandon the recording without keeping it. Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 record cancel --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.record.cancel",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.record.cancel -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.record.discard

Throw away a recording left behind by a crash or a closed window. Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 record discard --session id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.record.discard",
      "args": {
        "session": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.record.discard -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"session":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.record.pause

Pause the running recording; the pause is left out of the footage. Runs in the open editor.

```powershell
capstan.ps1 record pause --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.record.pause",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.record.pause -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.record.recover

Import a recording left behind by a crash or a closed window. Runs in the open editor.

```powershell
capstan.ps1 record recover --session id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.record.recover",
      "args": {
        "session": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.record.recover -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"session":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.record.resume

Carry on a paused recording. Runs in the open editor.

```powershell
capstan.ps1 record resume --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.record.resume",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.record.resume -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.record.start

Start a screen recording (and optionally webcam and microphone). The browser asks the person which screen, window or tab to share. Runs in the open editor.

```powershell
capstan.ps1 record start --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.record.start",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.record.start -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.record.stop

Stop the recording and add it to the media bin (and the timeline). Runs in the open editor.

```powershell
capstan.ps1 record stop --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.record.stop",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.record.stop -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.redaction.add

Add a region that blurs or pixelates every layer beneath it for a stretch of the timeline. Runs in the open editor.

```powershell
capstan.ps1 redaction add --start 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.redaction.add",
      "args": {
        "start": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.redaction.add -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"start":0},"dryRun":true,"confirmed":false}'
```

### capstan.redaction.remove

Remove a blur or pixelate region. Runs in the open editor.

```powershell
capstan.ps1 redaction remove --redaction id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.redaction.remove",
      "args": {
        "redaction": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.redaction.remove -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"redaction":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.redaction.update

Change a blur or pixelate region. Runs in the open editor.

```powershell
capstan.ps1 redaction update --redaction id_example --start 0 --duration 0.03333333333333333 --mode blur --strength 1 --x 1 --y 1 --width 8 --height 8 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.redaction.update",
      "args": {
        "redaction": "id_example",
        "start": 0,
        "duration": 0.03333333333333333,
        "mode": "blur",
        "strength": 1,
        "x": 1,
        "y": 1,
        "width": 8,
        "height": 8
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.redaction.update -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"redaction":"id_example","start":0,"duration":0.03333333333333333,"mode":"blur","strength":1,"x":1,"y":1,"width":8,"height":8},"dryRun":true,"confirmed":false}'
```

### capstan.session.end

Stop the local Capstan server. Projects and media already saved in the browser stay saved. Destructive: pass `--yes`. Runs in PowerShell.

```powershell
capstan.ps1 session end --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.session.end",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.session.end -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":false,"confirmed":false}'
```

### capstan.session.show

Show whether a Capstan host is running (process id, port, and address). The session token is never included. Runs in PowerShell.

```powershell
capstan.ps1 session show --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.session.show",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.session.show -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":false,"confirmed":false}'
```

### capstan.speech.show

Show whether offline speech-to-text is available on this computer. Runs in PowerShell.

```powershell
capstan.ps1 speech show --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.speech.show",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.speech.show -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":false,"confirmed":false}'
```

### capstan.template.remove

Delete a template saved in this browser. Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 template remove --template id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.template.remove",
      "args": {
        "template": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.template.remove -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"template":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.template.save

Save the project’s layout (size, tracks, annotations, zooms, markers, cursor settings) as a template in this browser. Runs in the open editor.

```powershell
capstan.ps1 template save --name example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.template.save",
      "args": {
        "name": "example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.template.save -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"name":"example"},"dryRun":true,"confirmed":false}'
```

### capstan.template.use

Start a new project from a template saved in this browser. Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 template use --template id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.template.use",
      "args": {
        "template": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.template.use -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"template":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.track.add

Add a track on top of the others. Runs in the open editor.

```powershell
capstan.ps1 track add --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.track.add",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.track.add -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.track.remove

Remove a track and every clip on it. The last track cannot be removed. Destructive: pass `--yes`. Runs in the open editor.

```powershell
capstan.ps1 track remove --track id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.track.remove",
      "args": {
        "track": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.track.remove -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"track":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.track.update

Rename a track, mute, hide or lock it, or make it magnetic (clips close up, no gaps). Runs in the open editor.

```powershell
capstan.ps1 track update --track id_example --name example --muted true --hidden true --locked true --magnetic true --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.track.update",
      "args": {
        "track": "id_example",
        "name": "example",
        "muted": true,
        "hidden": true,
        "locked": true,
        "magnetic": true
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.track.update -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"track":"id_example","name":"example","muted":true,"hidden":true,"locked":true,"magnetic":true},"dryRun":true,"confirmed":false}'
```

### capstan.transition.clear

Remove a clip’s transition at its start, its end or both. Runs in the open editor.

```powershell
capstan.ps1 transition clear --clip id_example --edge in --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.transition.clear",
      "args": {
        "clip": "id_example",
        "edge": "in"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.transition.clear -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","edge":"in"},"dryRun":true,"confirmed":false}'
```

### capstan.transition.set

Give a clip a transition at its start, its end or both. Runs in the open editor.

```powershell
capstan.ps1 transition set --clip id_example --edge in --type fade --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.transition.set",
      "args": {
        "clip": "id_example",
        "edge": "in",
        "type": "fade"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.transition.set -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"clip":"id_example","edge":"in","type":"fade"},"dryRun":true,"confirmed":false}'
```

### capstan.zoom.accept

Add zoom regions, for example ones returned by zoom suggest. Runs in the open editor.

```powershell
capstan.ps1 zoom accept --regions {"example":true} --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.zoom.accept",
      "args": {
        "regions": {
          "example": true
        }
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.zoom.accept -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"regions":{"example":true}},"dryRun":true,"confirmed":false}'
```

### capstan.zoom.add

Add a zoom-n-pan region: the camera zooms in on part of the canvas for a stretch of the timeline. Runs in the open editor.

```powershell
capstan.ps1 zoom add --start 0 --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.zoom.add",
      "args": {
        "start": 0
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.zoom.add -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"start":0},"dryRun":true,"confirmed":false}'
```

### capstan.zoom.duplicate

Copy a zoom region to start right after the original. Runs in the open editor.

```powershell
capstan.ps1 zoom duplicate --zoom id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.zoom.duplicate",
      "args": {
        "zoom": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.zoom.duplicate -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"zoom":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.zoom.remove

Remove a zoom region. Runs in the open editor.

```powershell
capstan.ps1 zoom remove --zoom id_example --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.zoom.remove",
      "args": {
        "zoom": "id_example"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.zoom.remove -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"zoom":"id_example"},"dryRun":true,"confirmed":false}'
```

### capstan.zoom.suggest

Suggest zoom regions from recorded cursor activity (clicks, clusters, dwells). Nothing is added. Runs in the open editor.

```powershell
capstan.ps1 zoom suggest --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.zoom.suggest",
      "args": {}
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.zoom.suggest -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{},"dryRun":true,"confirmed":false}'
```

### capstan.zoom.update

Change a zoom region’s timing, rectangle, magnification or easing. Runs in the open editor.

```powershell
capstan.ps1 zoom update --zoom id_example --start 0 --duration 0.03333333333333333 --level 1.1 --x 1 --y 1 --width 1 --height 1 --ease-in 0 --ease-out 0 --ease linear --json
```

```json
{
  "schema": "fleet.job/1",
  "actions": [
    {
      "action": "capstan.zoom.update",
      "args": {
        "zoom": "id_example",
        "start": 0,
        "duration": 0.03333333333333333,
        "level": 1.1,
        "x": 1,
        "y": 1,
        "width": 1,
        "height": 1,
        "easeIn": 0,
        "easeOut": 0,
        "ease": "linear"
      }
    }
  ]
}
```

```bash
curl -sS -X POST http://127.0.0.1:8790/api/actions/capstan.zoom.update -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '{"args":{"zoom":"id_example","start":0,"duration":0.03333333333333333,"level":1.1,"x":1,"y":1,"width":1,"height":1,"easeIn":0,"easeOut":0,"ease":"linear"},"dryRun":true,"confirmed":false}'
```
