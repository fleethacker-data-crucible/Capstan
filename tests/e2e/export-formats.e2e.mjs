// Export formats, validated with ffprobe / ffmpeg: single-frame PNG, range export, animated GIF, WAV and
// M4A, presets, streaming to a file (OPFS stands in for the save picker), fast WebCodecs decoding, and
// the real export dialog (format, range, presets, batch, Save to file). Tiny exports only.
// Usage: node tests/e2e/run-all.mjs export-formats   (needs `bun run build` and the harness build)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
const out = 'tests/e2e/.out/formats';
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
const countFrames = (file) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]).toString().trim());
const decodeErrors = (file) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
};
/** RGB of one pixel of the frame at `t` seconds. */
const pixelAt = (file, t, x, y) => {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [b[0], b[1], b[2]];
};
/** The card's flat blue (33,101,203), sampled where the card is, away from the video's own blues. */
const isBlue = ([r, g, b]) => Math.abs(r - 33) < 30 && Math.abs(g - 101) < 30 && Math.abs(b - 203) < 30;
const CARD = [60, 20];
const volume = (file, from, len) => {
  const r = spawnSync('ffmpeg', ['-ss', String(from), '-t', String(len), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const m = /mean_volume: (-?[\d.]+|-inf)/.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  return m ? Number(m[1].replace('-inf', '-999')) : -999;
};

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.error('[browser]', m.text()));
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`${base}/harness`);
await page.waitForFunction(() => document.title === 'harness-ready');

async function run(job, name) {
  const t0 = Date.now();
  const r = await page.evaluate((j) => window.runFormat(j), job);
  const file = `${out}/${name}`;
  writeFileSync(file, Buffer.from(r.base64, 'base64'));
  console.log(`exported ${name} in ${Date.now() - t0} ms`, JSON.stringify({ ...r.info, ms: undefined }));
  return { file, ...r };
}

// ---- single frame as PNG ----------------------------------------------------------------
{
  const card = await run({ request: { settings: { format: 'png', size: 'project' }, time: 1.5 } }, 'frame-card.png');
  const s = probe(card.file).streams[0];
  check('[png] is a 320x180 PNG', s.codec_name === 'png' && s.width === 320 && s.height === 180, `${s.codec_name} ${s.width}x${s.height}`);
  const px = pixelAt(card.file, 0, ...CARD);
  check('[png] the frame at 1.5 s shows the blue card', isBlue(px), `rgb(${px})`);
  const video = await run({ request: { settings: { format: 'png', size: 'project' }, time: 0.4 } }, 'frame-video.png');
  const px2 = pixelAt(video.file, 0, ...CARD);
  check('[png] the frame at 0.4 s is the video, not the card', !isBlue(px2) && px2[0] + px2[1] + px2[2] > 30, `rgb(${px2})`);
  const small = await run({ request: { settings: { format: 'png', size: 90 }, time: 1.5 } }, 'frame-small.png');
  const ss = probe(small.file).streams[0];
  check('[png] size option scales the picture', ss.width === 160 && ss.height === 90, `${ss.width}x${ss.height}`);
}

// ---- range ------------------------------------------------------------------------------
{
  const r = await run({ request: { settings: { format: 'mp4', quality: 'small' }, range: { start: 0.5, end: 1.5 } } }, 'range.mp4');
  const pr = probe(r.file);
  const v = pr.streams.find((s) => s.codec_type === 'video');
  const a = pr.streams.find((s) => s.codec_type === 'audio');
  const dur = Number(pr.format.duration);
  check('[range] 0.5 s to 1.5 s exports 1.0 s', Math.abs(dur - 1) < 0.12, `${dur}s`);
  check('[range] 15 frames at 15 fps', countFrames(r.file) === 15, String(countFrames(r.file)));
  check('[range] has audio of about the same length', !!a && Math.abs(Number(a.duration) - 1) < 0.15, `${a?.duration}`);
  check('[range] times are rebased: the card (1.0 s in the project) is on screen from 0.5 s', isBlue(pixelAt(r.file, 0.75, ...CARD)) && !isBlue(pixelAt(r.file, 0.25, ...CARD)));
  check('[range] clean decode', decodeErrors(r.file) === '', decodeErrors(r.file).slice(0, 150));
  check('[range] the tone from the project start is audible', volume(r.file, 0.1, 0.8) > -40, `${volume(r.file, 0.1, 0.8)} dB`);
  // The whole-timeline export of the same project for comparison.
  const bad = await page.evaluate(() => window.runFormat({ request: { settings: { format: 'mp4' }, range: { start: 5, end: 6 } } }).then(() => 'no error', (e) => e.message));
  check('[range] marks past the end are refused', /cover nothing/.test(bad), bad);
}

// ---- GIF --------------------------------------------------------------------------------
{
  const r = await run({ request: { settings: { format: 'gif', fps: 10, gifColors: 64, gifOptimize: true, gifDither: false } } }, 'anim.gif');
  const s = probe(r.file).streams[0];
  check('[gif] is a GIF of 320x180', s.codec_name === 'gif' && s.width === 320 && s.height === 180, `${s.codec_name} ${s.width}x${s.height}`);
  check('[gif] 20 frames for 2 s at 10 fps', countFrames(r.file) === 20, String(countFrames(r.file)));
  check('[gif] clean decode', decodeErrors(r.file) === '', decodeErrors(r.file).slice(0, 150));
  const d = Number(probe(r.file).format.duration);
  check('[gif] plays for about 2 s', Math.abs(d - 2) < 0.25, `${d}s`);
  check('[gif] card is blue at 1.5 s, not at 0.3 s', isBlue(pixelAt(r.file, 1.5, ...CARD)) && !isBlue(pixelAt(r.file, 0.3, ...CARD)));
  const head = Buffer.from(r.base64, 'base64');
  check('[gif] has the loop extension', head.includes(Buffer.from('NETSCAPE2.0')));
  const ranged = await run({ request: { settings: { format: 'gif', fps: 10, gifColors: 32, gifDither: true }, range: { start: 1, end: 2 } } }, 'range.gif');
  check('[gif] range + dither: 10 frames', countFrames(ranged.file) === 10 && decodeErrors(ranged.file) === '', String(countFrames(ranged.file)));
}

// ---- audio only -------------------------------------------------------------------------
{
  const w = await run({ request: { settings: { format: 'wav' } } }, 'audio.wav');
  const pr = probe(w.file);
  const a = pr.streams[0];
  check('[wav] 16-bit PCM, 48 kHz, stereo', a.codec_name === 'pcm_s16le' && a.sample_rate === '48000' && a.channels === 2, `${a.codec_name} ${a.sample_rate} ${a.channels}`);
  check('[wav] 2.0 s long', Math.abs(Number(pr.format.duration) - 2) < 0.02, pr.format.duration);
  check('[wav] not silent', volume(w.file, 0.2, 1) > -40, `${volume(w.file, 0.2, 1)} dB`);
  check('[wav] no video stream', !pr.streams.some((s) => s.codec_type === 'video'));
  const m = await run({ request: { settings: { format: 'm4a' } } }, 'audio.m4a');
  const mp = probe(m.file);
  const ma = mp.streams.find((s) => s.codec_type === 'audio');
  check('[m4a] one AAC stream, 48 kHz stereo, no video', mp.streams.length === 1 && ma?.codec_name === 'aac' && ma.sample_rate === '48000' && ma.channels === 2, `${ma?.codec_name} ${ma?.sample_rate} ${ma?.channels}`);
  check('[m4a] about 2 s long', Math.abs(Number(mp.format.duration) - 2) < 0.1, mp.format.duration);
  check('[m4a] clean decode and audible', decodeErrors(m.file) === '' && volume(m.file, 0.2, 1) > -40, decodeErrors(m.file).slice(0, 120));
  check('[m4a] major brand M4A', mp.format.format_name.includes('mp4') && Buffer.from(m.base64, 'base64').subarray(8, 12).toString() === 'M4A ');
  const wr = await run({ request: { settings: { format: 'wav' }, range: { start: 0.5, end: 1.0 } } }, 'range.wav');
  check('[wav] range 0.5 s long', Math.abs(Number(probe(wr.file).format.duration) - 0.5) < 0.02, probe(wr.file).format.duration);
}

// ---- presets ----------------------------------------------------------------------------
{
  const r = await run({ request: { preset: 'Small 720p', settings: { size: 180 } } }, 'preset.mp4');
  const v = probe(r.file).streams.find((s) => s.codec_type === 'video');
  check('[preset] "Small 720p" with a size override: H.264 320x180 at 30 fps', v.codec_name === 'h264' && v.width === 320 && v.r_frame_rate === '30/1', `${v.width}x${v.height} ${v.r_frame_rate}`);
  check('[preset] 60 frames', countFrames(r.file) === 60, String(countFrames(r.file)));
  const gif = await run({ request: { preset: 'gif 480', settings: { size: 180, fps: 5 } } }, 'preset.gif');
  check('[preset] "GIF 480" (name is case-insensitive) makes a GIF', probe(gif.file).streams[0].codec_name === 'gif' && countFrames(gif.file) === 10, String(countFrames(gif.file)));
  const err = await page.evaluate(() => window.runFormat({ request: { preset: 'Nope' } }).then(() => 'no error', (e) => e.message));
  check('[preset] an unknown preset name is an error', /No export preset/.test(err), err);
}

// ---- streaming to a file (OPFS) ---------------------------------------------------------
{
  const r = await run({ request: { settings: { format: 'mp4' } }, stream: 'stream.mp4' }, 'streamed.mp4');
  const pr = probe(r.file);
  const v = pr.streams.find((s) => s.codec_type === 'video');
  const total = r.info.size;
  check('[stream] result says it was streamed, with no Blob', r.info.streamed === true && r.info.bytes === total);
  check('[stream] the sink got many writes, none of them the whole file', r.log.writes.length > 20 && Math.max(...r.log.writes) < total / 2, `${r.log.writes.length} writes, largest ${Math.max(...r.log.writes)} of ${total}`);
  check('[stream] most of the file was written before the last frame was rendered', r.log.bytesBeforeLastFrame > total * 0.4, `${r.log.bytesBeforeLastFrame} of ${total}`);
  check('[stream] sink closed once, at the end', r.log.closed);
  check('[stream] streamed file is H.264 320x180 + audio, 2 s', v.codec_name === 'h264' && v.width === 320 && pr.streams.some((s) => s.codec_type === 'audio') && Math.abs(Number(pr.format.duration) - 2) < 0.15, `${pr.format.duration}s`);
  check('[stream] 30 decodable frames and a clean decode', countFrames(r.file) === 30 && decodeErrors(r.file) === '', String(countFrames(r.file)));
  check('[stream] card is blue at 1.5 s', isBlue(pixelAt(r.file, 1.5, ...CARD)));
  const g = await run({ request: { settings: { format: 'gif', fps: 10 } }, stream: 'stream.gif' }, 'streamed.gif');
  check('[stream] a GIF streams too', countFrames(g.file) === 20 && g.log.writes.length >= 20 && decodeErrors(g.file) === '', `${g.log.writes.length} writes`);
  const a = await run({ request: { settings: { format: 'm4a' } }, stream: 'stream.m4a' }, 'streamed.m4a');
  check('[stream] M4A streams and decodes', probe(a.file).streams[0].codec_name === 'aac' && decodeErrors(a.file) === '');
}

// ---- fast export ------------------------------------------------------------------------
{
  const fast = await run({ request: { settings: { format: 'mp4', fast: true, includeAudio: false } } }, 'fast.mp4');
  const slow = await run({ request: { settings: { format: 'mp4', fast: false, includeAudio: false } } }, 'slow.mp4');
  check('[fast] the sequential decoder supplied the VP9 frames', fast.info.decode.fast > 0 && fast.info.decode.seek === 0, JSON.stringify(fast.info.decode));
  check('[fast] with Fast off every picture is seeked', slow.info.decode.fast === 0 && slow.info.decode.seek > 0, JSON.stringify(slow.info.decode));
  check('[fast] both exports are valid with 30 frames', countFrames(fast.file) === 30 && countFrames(slow.file) === 30 && decodeErrors(fast.file) === '');
  console.log(`      export time: fast ${fast.info.ms} ms, seek ${slow.info.ms} ms`);
  for (const [name, times] of [
    ['clip.webm', [0, 0.2, 0.9, 1.0333, 1.5, 0.5, 2.8]],
    ['h264-bframes.mp4', [0, 0.2, 0.9, 1.0333, 1.5, 0.5, 1.9]],
    ['h264-bt709.mp4', [0, 0.3, 0.9, 0.1]],
  ]) {
    const c = await page.evaluate(([n, t]) => window.compareDecode(n, t), [name, times]);
    const worst = Math.max(...c.out.map((o) => o.same));
    const exact = c.out.every((o) => o.same < 3 && o.same <= o.neighbour);
    check(`[fast] ${name}: decoded frames match the seeked frames (incl. backward jumps)`, exact && c.stats.fast === times.length && c.stats.seek === 0, `worst mean diff ${worst.toFixed(2)}, stats ${JSON.stringify(c.stats)}`);
    console.log(`      px fast/seek ${JSON.stringify(c.out[0].px)}`);
    console.log(`      ${name}: fast ${c.fastMs.toFixed(0)} ms, seek ${c.slowMs.toFixed(0)} ms for ${times.length} frames; diffs ${c.out.map((o) => `${o.same.toFixed(1)}/${o.neighbour.toFixed(1)}`).join(' ')}`);
  }
}
await page.close();

// ---- the real export dialog -------------------------------------------------------------
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
// A stand-in for the native save picker: hands out OPFS files, so Save to file is testable headless.
await context.addInitScript(() => {
  window.__saved = [];
  window.showSaveFilePicker = async (opts) => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(opts?.suggestedName ?? 'picked.bin', { create: true });
    window.__saved.push(handle.name);
    const orig = handle.createWritable.bind(handle);
    handle.createWritable = async (o) => {
      const w = await orig(o);
      const write = w.write.bind(w);
      window.__writes = 0;
      w.write = (d) => {
        window.__writes++;
        return write(d);
      };
      return w;
    };
    return handle;
  };
});
const ui = await context.newPage();
const errors = [];
ui.on('pageerror', (e) => errors.push(e.message));
ui.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await ui.goto(base + '/');
await ui.waitForSelector('.welcome');
await ui.getByRole('button', { name: 'Go to the editor' }).click();
await ui.waitForSelector('.media-bin');
await ui.setInputFiles('.bin-actions input[type=file]', ['tests/fixtures/clip.webm', 'tests/fixtures/card.png', 'tests/fixtures/tone.wav']);
await ui.waitForFunction(() => document.querySelectorAll('.bin-item').length === 3, null, { timeout: 20000 });
await ui.locator('.bin-item', { hasText: 'clip.webm' }).dblclick();
await ui.waitForFunction(() => document.querySelectorAll('.clip').length === 1);
await ui.locator('.bin-item', { hasText: 'tone.wav' }).dblclick();
await ui.waitForFunction(() => document.querySelectorAll('.clip').length === 2);

// Marks: click the ruler at 0.5 s and press I, at 1.5 s and press O (60 px per second).
const ruler = ui.locator('.ruler');
await ruler.click({ position: { x: 30, y: 8 } });
await ui.keyboard.press('i');
await ruler.click({ position: { x: 90, y: 8 } });
await ui.keyboard.press('o');
const shade = await ui.locator('.range-shade').boundingBox();
check('[ui] I and O mark a shaded span about 1 s wide (60 px)', !!shade && Math.abs(shade.width - 60) < 4, `${shade?.width}px`);
await ui.screenshot({ path: `${out}/ui-marks.png` });

// Dragging in the strip under the ruler labels sets the range too.
const strip = await ui.locator('.range-strip').boundingBox();
await ui.mouse.move(strip.x + 120, strip.y + 4);
await ui.mouse.down();
await ui.mouse.move(strip.x + 180, strip.y + 4, { steps: 6 });
await ui.mouse.up();
const dragged = await ui.locator('.range-shade').boundingBox();
check('[ui] dragging in the ruler strip sets the range (1 s at 60 px)', !!dragged && Math.abs(dragged.width - 60) < 8 && Math.abs(dragged.x - shade.x - 90) < 8, `${dragged?.width}px at ${dragged?.x}`);
await ui.keyboard.press('Alt+x');
check('[ui] Alt+X clears the marks', (await ui.locator('.range-shade').count()) === 0);
await ui.keyboard.press('Control+z');
check('[ui] clearing the marks can be undone', (await ui.locator('.range-shade').count()) === 1);
// Back to 0.5 .. 1.5 s for the exports below.
await ui.keyboard.press('Control+z');
await ui.waitForTimeout(100);
const back = await ui.locator('.range-shade').boundingBox();
check('[ui] undo brings back the earlier marks', !!back && Math.abs(back.x - shade.x) < 2 && Math.abs(back.width - 60) < 4, `${back?.x} ${back?.width}`);

await ui.locator('.toolbar .button.export').click();
await ui.waitForSelector('#export-title');
check('[ui] dialog offers preset, format and range', (await ui.locator('#export-preset').count()) === 1 && (await ui.locator('#export-format').count()) === 1 && (await ui.locator('#export-range').count()) === 1);
check('[ui] dialog keeps a marked spot for extra options', (await ui.content()).length > 0 && (await ui.locator('.export-options').count()) === 1);
const formats = await ui.locator('#export-format option').allTextContents();
check('[ui] formats: MP4, GIF, M4A, WAV, PNG', formats.length === 5 && /MP4/.test(formats[0]) && /GIF/.test(formats[1]) && /M4A/.test(formats[2]) && /WAV/.test(formats[3]) && /PNG/.test(formats[4]), formats.join(' | '));
const presetNames = await ui.locator('#export-preset option').allTextContents();
check('[ui] built-in presets are listed', ['YouTube 1080p', 'Small 720p', 'GIF 480', 'Audio only'].every((n) => presetNames.includes(n)), presetNames.join(' | '));
await ui.screenshot({ path: `${out}/ui-dialog.png` });

// 1. MP4 of the marked range, tiny.
await ui.selectOption('#export-size', '180');
await ui.selectOption('#export-fps', '15');
await ui.selectOption('#export-range', 'marks');
let dl = ui.waitForEvent('download', { timeout: 120000 });
await ui.locator('.modal-actions .button.primary').click();
let file = `${out}/ui-range.mp4`;
await (await dl).saveAs(file);
await ui.waitForSelector('.modal .success');
{
  const pr = probe(file);
  const v = pr.streams.find((s) => s.codec_type === 'video');
  check('[ui] MP4 of the marked range: 320x180, 1 s', v.width === 320 && v.height === 180 && Math.abs(Number(pr.format.duration) - 1) < 0.15, `${v.width}x${v.height} ${pr.format.duration}s`);
}

// 2. PNG at the playhead (the playhead is where the last ruler click left it: 1.5 s).
await ui.selectOption('#export-format', 'png');
dl = ui.waitForEvent('download', { timeout: 60000 });
await ui.locator('.modal-actions .button.primary').click();
file = `${out}/ui-frame.png`;
await (await dl).saveAs(file);
{
  const s = probe(file).streams[0];
  check('[ui] PNG of the playhead frame: 320x180 PNG', s.codec_name === 'png' && s.width === 320 && s.height === 180, `${s.width}x${s.height}`);
}

// 3. Presets and batch: save a GIF preset, add it and "Audio only" to the batch, run both.
await ui.selectOption('#export-format', 'gif');
await ui.selectOption('#export-fps', '10');
await ui.selectOption('#export-range', 'marks');
await ui.getByRole('button', { name: 'Save as preset' }).click();
await ui.getByLabel('Preset name').fill('Tiny GIF');
await ui.getByLabel('Preset name').press('Enter');
check('[ui] saving a preset selects it', (await ui.locator('#export-preset option:checked').textContent()) === 'Tiny GIF');
const stored = await ui.evaluate(() => localStorage.getItem('capstan.export.presets.v1'));
check('[ui] user preset is kept in localStorage', !!stored && stored.includes('Tiny GIF') && stored.includes('"format":"gif"'));
await ui.getByRole('button', { name: 'Add these settings to the batch' }).click();
await ui.selectOption('#export-preset', { label: 'Audio only' });
await ui.getByRole('button', { name: 'Add these settings to the batch' }).click();
const items = await ui.locator('.export-queue .export-item-name').allTextContents();
check('[ui] the batch lists both items by preset name', items.join('|') === 'Tiny GIF|Audio only', items.join('|'));
await ui.screenshot({ path: `${out}/ui-batch.png` });
const downloads = [];
ui.on('download', (d) => downloads.push(d));
await ui.getByRole('button', { name: /Run batch \(2\)/ }).click();
await ui.waitForFunction(() => document.querySelectorAll('.export-item.status-done').length === 2, null, { timeout: 120000 });
await ui.waitForFunction(() => true);
await ui.waitForTimeout(300);
check('[ui] both batch items finished and say where they went', (await ui.locator('.export-item-status').allTextContents()).every((t) => /^Done: .+\.(gif|m4a)/.test(t)));
check('[ui] the batch downloaded two files', downloads.length === 2, `${downloads.length}`);
for (const d of downloads) await d.saveAs(`${out}/ui-batch-${d.suggestedFilename().replace(/[^\w.-]+/g, '_')}`);
const gifName = downloads.find((d) => d.suggestedFilename().endsWith('.gif'))?.suggestedFilename();
const m4aName = downloads.find((d) => d.suggestedFilename().endsWith('.m4a'))?.suggestedFilename();
check('[ui] batch file names carry the project and preset names', !!gifName && /Tiny GIF/.test(gifName) && !!m4aName && /Audio only/.test(m4aName), `${gifName} | ${m4aName}`);
if (gifName && m4aName) {
  const g = probe(`${out}/ui-batch-${gifName.replace(/[^\w.-]+/g, '_')}`);
  check('[ui] batch GIF: 320x180 (from the saved preset: marked 1 s, 10 fps = 10 frames)', g.streams[0].codec_name === 'gif' && g.streams[0].width === 320 && countFrames(`${out}/ui-batch-${gifName.replace(/[^\w.-]+/g, '_')}`) === 10, `${g.streams[0].width}x${g.streams[0].height}`);
  const m = probe(`${out}/ui-batch-${m4aName.replace(/[^\w.-]+/g, '_')}`);
  check('[ui] batch M4A has an AAC stream', m.streams.some((s) => s.codec_name === 'aac'));
}

// 4. Cancel in the batch: add one, start, cancel all.
await ui.selectOption('#export-preset', { label: 'Tiny GIF' });
await ui.getByRole('button', { name: 'Add these settings to the batch' }).click();
const cancelBtn = ui.getByRole('button', { name: /^Cancel/ }).first();
check('[ui] a waiting batch item has its own Cancel button', (await cancelBtn.count()) === 1);
await cancelBtn.click();
await ui.waitForSelector('.export-item.status-cancelled');
check('[ui] cancelled items are listed as Cancelled', (await ui.locator('.export-item.status-cancelled .export-item-status').first().textContent()) === 'Cancelled');
await ui.getByRole('button', { name: 'Clear finished' }).click();
check('[ui] Clear finished empties the list', (await ui.locator('.export-item').count()) === 0);

// 5. Save to file (streaming) through the dialog.
await ui.selectOption('#export-preset', '');
await ui.selectOption('#export-format', 'mp4');
await ui.selectOption('#export-size', '180');
await ui.selectOption('#export-fps', '15');
await ui.selectOption('#export-range', 'whole');
const streamBox = ui.getByLabel(/Save to file as it renders/);
check('[ui] "Save to file" is offered where the browser has the file picker', (await streamBox.count()) === 1);
await streamBox.check();
let gotDownload = false;
const onDl = () => (gotDownload = true);
ui.on('download', onDl);
await ui.locator('.modal-actions .button.primary').click();
await ui.waitForSelector('.modal .success', { timeout: 120000 });
ui.off('download', onDl);
const saved = await ui.evaluate(() => window.__saved);
check('[ui] the picker was asked for an .mp4 and nothing was downloaded', saved.length === 1 && saved[0].endsWith('.mp4') && !gotDownload, `${saved} download=${gotDownload}`);
const writes = await ui.evaluate(() => window.__writes);
check('[ui] the dialog streamed in many writes', writes > 20, `${writes}`);
const b64 = await ui.evaluate(async (name) => {
  const root = await navigator.storage.getDirectory();
  const f = await (await root.getFileHandle(name)).getFile();
  const bytes = new Uint8Array(await f.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}, saved[0]);
file = `${out}/ui-streamed.mp4`;
writeFileSync(file, Buffer.from(b64, 'base64'));
{
  const pr = probe(file);
  const v = pr.streams.find((s) => s.codec_type === 'video');
  check('[ui] the streamed file is valid H.264 320x180 for the whole project (3 s)', v.codec_name === 'h264' && v.width === 320 && Math.abs(Number(pr.format.duration) - 3) < 0.2 && decodeErrors(file) === '', `${pr.format.duration}s`);
}
check('[ui] success line names the saved file', /Saved .+\.mp4/.test((await ui.locator('.modal .success').textContent()) ?? ''));
await ui.screenshot({ path: `${out}/ui-done.png` });
check('[ui] no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll export-format checks passed');
process.exit(failures ? 1 : 0);
