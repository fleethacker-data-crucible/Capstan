# Demo recipe: a short video with Capstan, a TalkForge voiceover, captions and blur

The exact steps for making a demo video of one of the Fleet apps. The recipe is covered by an automated test (`tests/e2e/demo-recipe.e2e.mjs`): a synthetic screen recording, a voiceover file, a blur region and captions go through the editor and out as an MP4, and the file is checked with ffprobe and ffmpeg (video, audio, length, burned-in captions, blur). The test also runs the export with the hardware encoder failing, to prove the software fallback gives the same good file.

**Rules for demo content.** Use synthetic or demo data only: no real names, hostnames, mail, or personal information on screen. Blur anything you are not sure about (step 4), and look at the finished video before it goes anywhere.

## Before you start

- Windows PC with Microsoft Edge or Chrome. Double-click `Launch-Capstan.bat` and keep the console window open.
- The app you are demonstrating, set up with demo data, on a screen you can share (a window or a browser tab).
- The script, written down, with each sentence short (one idea per line). You will use it for the voiceover and for the captions.

## 1. Record the screen

1. In Capstan, choose **Record screen**.
2. Under **What to record**, pick **A browser tab** for a web app, or **A window** for a desktop app. Avoid **The entire screen**: it shows everything on the desktop, notifications included.
3. Leave the microphone off if the voiceover will come from TalkForge. Set **Countdown** to 3 s so you can get the demo into position.
4. Press **Start recording**, choose what to share in the browser's picker, and walk through the demo slowly, pausing a second at each step. Use **Pause** for a mistake and carry on.
5. Press **Stop and save** (or use the browser's **Stop sharing** bar). The recording appears in the media bin and on the timeline.

Optional: **Select a region first** crops the recording to part of the screen. **Webcam** adds a picture-in-picture track.

## 2. Make the voiceover with TalkForge

1. Open TalkForge, paste one sentence of the script at a time, and save each as a WAV file named in order (`01.wav`, `02.wav`, ...).
2. In Capstan choose **Import media** and add the WAV files. Drag each to the audio track at the point in the video it describes, or double-click it to add it at the playhead.
3. If a sentence is too long for its step, split the recording (select it, put the playhead where you want the cut, press **S**) and slide the later part along.

TalkForge cannot be driven from Capstan yet, so the voiceover is a file hand-off. If a long text comes out as a damaged WAV, make the sentences shorter (a known TalkForge issue with joined chunks).

## 3. Cut and tidy

- Drag clip edges to trim dead time. **Shift+Delete** removes a stretch and closes the gap.
- Click a clip, then use the **Inspector** to set speed (for a long wait), crop, or volume. Set the voiceover volume so it is clearly louder than any recorded sound.
- Optional: the **Notes** tab adds a callout, arrow or highlight; the **Motion** tab adds a zoom-n-pan onto the part of the screen being described, and transitions between clips.

## 4. Blur what must not show

1. Put the playhead where the sensitive detail first appears.
2. With nothing selected, press **Add blur region at playhead** in the Inspector (or use the **Notes** tab's blur and pixelate buttons).
3. Drag the box over the detail in the preview and resize it with its corner handle. Set **Length** to cover every moment it is visible. Use **Pixelate** for text that must be unreadable at any size.
4. Scrub through the whole video once with the region on. A blur only hides what is under it for its length.

## 5. Captions

1. Write the script as an SRT file (a number, a time range like `00:00:01,000 --> 00:00:03,500`, the text, a blank line). Keep each caption to two short lines.
2. Open the **Captions** tab, choose **Import captions**, and pick the file.
3. Adjust any caption in the list or drag it in the captions lane under the timeline until its timing matches the voiceover.

Speech-to-text is not built yet, so captions come from your own script.

## 6. Export

1. Choose **Export video**. Leave the format on **MP4**. For a small file leave the size on the project size; for a long video tick **Save to file as it renders** so memory stays flat.
2. Leave **Include audio** and **Burn in captions** ticked. Choose **Export video** again to start and wait for the "Saved" message. A 3-minute 1080p video takes a few minutes on the build PC.
3. If you only need a short part, mark it with **I** and **O** on the timeline and choose that range in the dialog. **PNG** exports one frame and **GIF** a short animation.

## 7. Check the result before you share it

- Play the exported file from start to end in a normal player.
- The voiceover is audible and in sync; the captions show at the right times and are not cut off.
- The blur covers every sensitive detail for the whole time it is on screen.
- Nothing from the real desktop is visible (notification pop-ups, other windows, the taskbar).
- The file opens and plays on another computer.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| "Nothing was recorded" or the share picker offers the wrong thing | Cancel, choose **A browser tab** or **A window** again, and pick the window itself. Capstan refuses to record anything other than what you asked for. |
| The recording is empty or very short | Edge's H.264 recorder can write nothing for screen capture. Capstan checks this when you press Start and records WebM instead; just record again. |
| Capstan was in the background when you stopped | The recording is still saved. If import fails, the dialog offers **Save recording file**; keep that file and import it. |
| Edge crashed during a recording | Reopen Capstan: it offers the recording back (**Import** or **Discard**). |
| Export seems stuck | If the hardware video encoder is silent for 10 seconds, Capstan restarts the export with the software encoder and says so in the result. It is slower but gives the same picture. |
| Export fails with a message about memory | Tick **Save to file as it renders** and export again, or export a shorter range. |
| The export has no audio | Check **Include audio** is ticked, the audio track is not muted, and the voiceover clip's volume is not 0. If the browser cannot encode AAC the audio is Opus; it still plays in any current player. |
| Captions are missing from the video | Tick **Burn in captions** in the export dialog. |
| The blur is missing at some moment | Select the blur region and extend its **Length**, or add another region for the later part. |
| The video looks wrong only in the preview | Preview and export use the same renderer; if only the preview is slow, close other windows and lower the canvas size in the Inspector. |

If it still fails, note the message and what you did, and open an issue in the Capstan repository. Hand-test items that automated tests cannot cover (a real window, microphone and webcam) are tracked in the hand-test checklist issue.
