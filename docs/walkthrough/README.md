# Capstan walkthrough

Record or import footage, cut it on a multi-track timeline and export an MP4, all on this computer.

> **Status: skeleton.** The screenshots below are placeholders. Zombie Admin captures them with demo data, and the Chief of Staff scans them for sensitive content before they are added (team directive 10). Until then the image links do not resolve.

## Before you start

- Windows PowerShell 5.1 (part of Windows). No administrator rights and no installer.
- Microsoft Edge or Google Chrome.
- Launch: Double-click `Launch-Capstan.bat` (opens an Edge app window on `127.0.0.1`, port 8790 or the next free one).
- Microsoft Edge, or Chrome with `-DefaultBrowser`.

## Steps

### 1. First launch

Capstan opens on its welcome screen, *Haul in your footage*.

![Capstan welcome screen, Haul in your footage, with the options to import media or record.](../assets/walkthrough/01-first-launch.png)

### 2. Import media

Select **Import media**, or drop files anywhere in the window. They land in the media bin.

![Capstan media bin with the demo clip and demo title card imported.](../assets/walkthrough/02-import-media.png)

### 3. Edit on the timeline

Drag clips onto tracks, trim their edges and press **S** to split at the playhead.

![Capstan editor with the demo clip on track 1 split at the playhead, and the title card on track 2.](../assets/walkthrough/03-timeline-edit.png)

### 4. Adjust a clip

The **Inspector** sets position, scale, rotation, opacity and volume for the selected clip.

![Capstan Inspector showing position, scale and opacity for the selected title card.](../assets/walkthrough/04-clip-properties.png)

### 5. Record your screen

**Record screen** records a screen, window or tab, with microphone and computer sound.

![Capstan Record screen dialog before a source is chosen, with the microphone and computer sound options.](../assets/walkthrough/05-record-dialog.png)

### 6. Export

**Export video** writes an MP4 at the project size, 1080p or 720p.

![Capstan Export video dialog with 1080p and the middle quality level selected.](../assets/walkthrough/06-export-dialog.png)

## About these images

Images live in [`docs/assets/walkthrough/`](../assets/walkthrough/), named `NN-<screen>.png` after the step they belong to. They are 1440x900 at 100% scale in the Night watch (dark) theme, and show demo data only.
