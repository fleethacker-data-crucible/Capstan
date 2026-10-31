# Capstan walkthrough

Record or import footage, cut it on a multi-track timeline, add notes, motion, effects, captions and audio, and export a video, GIF or audio file, all on this computer.

> **Screenshots:** captured with demo data and scanned by the Chief of Staff (team directive 10).

## Before you start

- Windows PowerShell 5.1 (part of Windows). No administrator rights and no installer.
- Microsoft Edge or Google Chrome.
- Launch: Double-click `Launch-Capstan.bat` (opens an Edge app window on `127.0.0.1`, port 8790 or the next free one).
- Microsoft Edge, or Chrome with `-DefaultBrowser`.

## Steps

### 1. First launch

Capstan opens on its welcome screen, *Haul in your footage*.

![Capstan welcome screen, Haul in your footage, with the Record screen, Import media and Open project buttons.](../assets/walkthrough/01-first-launch.png)

### 2. Import media

Select **Import media**, or drop files anywhere in the window. They land in the media bin.

![Capstan editor with demo-clip.webm and demo-title.png imported into the media bin and the timeline still empty.](../assets/walkthrough/02-import-media.png)

### 3. Edit on the timeline

Drag clips onto tracks, trim their edges and press **S** to split at the playhead. The demo clip used here is a short recording of Capstan's own welcome screen.

![Capstan editor with the demo clip, a recording of Capstan's welcome screen, split at 0:00:05;00 on Track 1 and the title card on Track 2.](../assets/walkthrough/03-timeline-edit.png)

### 4. Adjust a clip

Select a clip. The **Inspector** sets its position, scale, rotation, opacity and, for clips with sound, volume, and goes on to crop, speed, effects and keyframes. Here the playhead is at 0:00:01;15, over the title card.

![Capstan Inspector for the selected demo-title.png title card, showing scale, position, rotation and opacity, with the playhead at 0:00:01;15.](../assets/walkthrough/04-clip-properties.png)

### 5. Record your screen

**Record screen** first asks what to record: a browser tab, a window or the entire screen. For a tab or a window, your browser's picker does not offer screens, and if anything else is shared Capstan stops before recording a frame. Options cover the microphone, computer sound, a webcam on its own track, a countdown, saving to disk while recording and adding the recording to the end of the timeline.

![Capstan Record screen dialog with "A window" chosen under What to record, and sound, webcam, countdown, save-to-disk and add-to-timeline options below it.](../assets/walkthrough/05-record-dialog.png)

### 6. Blur personal details

With no clip selected, the Inspector lists **Blur regions**; the **Notes** tab has the same blur and a pixelate region. **Add blur region at playhead** puts a box over every track for three seconds; drag it in the preview, resize it from the corner, and set blur or pixelate, the strength and the timing.

![Capstan with a blur region selected over the word demo on the title card, its Inspector showing effect, strength, start, length and position, and a Blur row under the tracks.](../assets/walkthrough/06-blur-and-captions.png)

### 7. Export

**Export video** opens the export dialog. Pick a preset or set the format, range, size, frame rate and quality yourself, choose whether to include audio and, when the project has captions, whether to burn them in. An MP4 (H.264) is written to your Downloads folder, or straight to a file you choose.

![Capstan Export video dialog for an MP4 (H.264) of just under 10 seconds with the whole project, the project size, 30 fps, Standard quality and Include audio selected.](../assets/walkthrough/07-export-dialog.png)

### 8. Add callouts and arrows

Open the **Notes** tab to add text, callouts, shapes, arrows, highlights or a spotlight at the playhead; each gets its own row under the tracks, and the Inspector sets its text, font, colours and timing.

![Capstan with the Notes tab open, a cream Start here callout and a red arrow over the title card, the callout selected with its text and font in the Inspector, and a Notes row under the tracks.](../assets/walkthrough/08-annotations.png)

### 9. Zoom, pan and transitions

On the **Motion** tab, **Add zoom at playhead** magnifies part of the picture for a while and zooms back out, and the transition presets fade or slide the selected clip in and out.

![Capstan with the Motion tab open, the title card selected with a fade at its end, a Zoom 1 region on its own Zoom row, and the preview magnified on part of the title text.](../assets/walkthrough/09-motion.png)

### 10. Style a clip with effects

The **Effects** tab applies one-click looks, such as a rounded card with a shadow or a laptop frame, and the Inspector fine-tunes colour, shadow, corners, blend mode and device frame.

![Capstan with the Effects tab open, the title card as a rounded card with a shadow beside the recording in a laptop frame, and the Inspector showing the Device frame set to Laptop.](../assets/walkthrough/10-effects.png)

### 11. Captions and chapter markers

Add captions or import an SRT or WebVTT file on the **Captions** tab and edit each one in the Inspector, and press **M** to drop a marker on the ruler that can also be a chapter.

![Capstan with the Captions tab listing three imported captions, the second selected with its text and timing in the Inspector and shown over the picture, a Captions row under the tracks, and Intro and Details markers on the ruler.](../assets/walkthrough/11-captions-markers.png)

### 12. Work with audio

Audio clips draw their waveform on the timeline, the **Audio** tab offers quick fades, levelling and noise removal, and the Inspector sets the volume and fade lengths.

![Capstan with the Audio tab open and a green demo-voice.wav clip on Track 3 showing its waveform, selected, with the Inspector showing volume, speed and a one-second fade in.](../assets/walkthrough/12-audio.png)

### 13. Export a part, or another format

Mark a range with **I** and **O** on the timeline, then choose it under Range, and pick another format such as an animated GIF, a PNG of one frame, or WAV or M4A audio only.

![Capstan Export video dialog with the format set to Animated GIF and the range set to In to out, 0:01.50 to 0:04.50, with colours, dither, loop and burn-in captions options.](../assets/walkthrough/13-export-formats.png)

## About these images

Images live in [`docs/assets/walkthrough/`](../assets/walkthrough/), named `NN-<screen>.png` after the step they belong to. They are 1440x900 at 100% scale in the Night watch (dark) theme, and show demo data only.
