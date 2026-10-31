// Acceptance test for the demo recipe (docs/DEMO-RECIPE.md): a synthetic screen recording, a voiceover
// file, a blur region and captions go through the real UI and out as an MP4 whose picture, captions,
// blur and audio are checked with ffmpeg and ffprobe. The export runs twice: once normally, and once with
// the hardware video encoder made to fail, to prove the software-encoder fallback still produces a good file.
//
// Synthetic data only: getDisplayMedia is replaced by a canvas stream before the page loads, and no
// fake-UI flag is used (on Windows that flag shares the real desktop).
// Usage: node tests/e2e/demo-recipe.e2e.mjs   (or via run-all.mjs demo-recipe)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
const out = 'tests/e2e/.out';
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const W = 1280;
const H = 720;
const cues = [...readFileSync('tests/fixtures/captions-sample.srt', 'utf8').replace(/\r/g, '').matchAll(/(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)/g)].map((m) => ({
  start: +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000,
  end: +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000,
}));
const tIn = (cues[0].start + cues[0].end) / 2; // inside the first caption
const tGap = (cues[0].end + cues[1].start) / 2; // between captions
const tClean = cues[cues.length - 1].end + 0.3; // after the last caption

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await context.addInitScript(() => {
  // A synthetic "screen": sharp 8 px black and white stripes (so blur is measurable) and a moving block.
  navigator.mediaDevices.getDisplayMedia = async (options) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext('2d');
    let n = 0;
    const draw = () => {
      for (let x = 0; x < 640; x += 8) {
        g.fillStyle = (x / 8) % 2 ? '#101010' : '#f0f0f0';
        g.fillRect(x, 0, 8, 360);
      }
      g.fillStyle = `hsl(${(n * 9) % 360} 70% 50%)`;
      g.fillRect(20 + ((n * 4) % 200), 20, 60, 40);
      n++;
    };
    draw();
    const timer = setInterval(draw, 33);
    const stream = canvas.captureStream(30);
    const track = stream.getVideoTracks()[0];
    const surface = options?.video?.displaySurface ?? 'monitor';
    const real = track.getSettings.bind(track);
    track.getSettings = () => ({ ...real(), displaySurface: surface, width: 640, height: 360 });
    track.addEventListener('ended', () => clearInterval(timer));
    return stream;
  };
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(base + '/');
await page.getByRole('button', { name: 'Go to the editor' }).click();
await page.waitForSelector('.media-bin');

// ---- 1. record the synthetic screen ----
await page.getByRole('region', { name: 'Media' }).getByRole('button', { name: 'Record screen' }).click();
await page.getByRole('radio', { name: 'A browser tab' }).check();
await page.getByRole('button', { name: 'Start recording' }).click();
await page.waitForSelector('.rec-status.recording', { timeout: 10000 });
await page.waitForTimeout(3300);
await page.getByRole('button', { name: 'Stop and save' }).click();
await page.waitForSelector('.clip', { timeout: 20000 });
check('the recording lands on the timeline', (await page.locator('.clip').count()) === 1);

// ---- 2. a 720p canvas keeps the software export quick ----
await page.locator('.transport .timecode').click();
await page.keyboard.press('Escape');
await page.selectOption('#project-size', { label: '720p (1280×720)' });

// ---- 3. the voiceover (stands in for a TalkForge narration file) ----
await page.setInputFiles('.bin-actions input[type=file]', ['tests/fixtures/tone.wav']);
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 2, null, { timeout: 20000 });
await page.locator('.bin-item', { hasText: 'tone.wav' }).dblclick();
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 2);
check('the voiceover is on its own track', (await page.locator('.clip.kind-audio').count()) === 1);

// ---- 4. a blur region at the start ----
await page.locator('.transport .timecode').click();
await page.keyboard.press('Home');
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Add blur region at playhead' }).click();
await page.waitForSelector('.region-box');
check('a blur region is on the timeline', (await page.locator('.overlay-lane .overlay-item').count()) >= 1);
const regionBox = {
  left: Number(await page.locator('#f-left').inputValue()),
  top: Number(await page.locator('#f-top').inputValue()),
  width: Number(await page.locator('#f-width').inputValue()),
  height: Number(await page.locator('#f-height').inputValue()),
};

// ---- 5. captions from a subtitle file ----
await page.getByRole('tab', { name: 'Captions' }).click();
await page.setInputFiles('.captions-panel input[type=file]', ['tests/fixtures/captions-sample.srt']);
await page.waitForFunction(() => document.querySelectorAll('.caption-row').length === 3);
check('three captions imported', (await page.locator('.caption-row').count()) === 3);
const total = (await page.locator('.timecode .total').textContent()).trim();
const [, , ts, tf] = total.split(/[:;]/).map(Number);
const timelineSeconds = ts + tf / 30;

// ---- 6. export twice: normal, then with the hardware encoder failing ----
const exportOnce = async (file) => {
  const downloadPromise = page.waitForEvent('download', { timeout: 240000 });
  await page.locator('.modal .modal-actions .button.primary').click();
  const download = await downloadPromise;
  await download.saveAs(file);
  await page.waitForSelector('.modal .success', { timeout: 240000 });
  return (await page.locator('.modal .success').textContent()) ?? '';
};
await page.locator('.toolbar .button.export').click();
await page.waitForSelector('#export-title');
check('the export dialog defaults to MP4', (await page.locator('#export-format').inputValue()) === 'mp4');
const fileA = `${out}/demo-recipe-normal.mp4`;
const noteA = await exportOnce(fileA);
check('a normal export does not mention the software fallback', !/encoded in software/.test(noteA), noteA.slice(0, 200));

// Make every encoder that is not the software one fail after its first frame, as a stalled or broken
// hardware encoder would. exportMp4 must notice and run again with the software encoder.
await page.evaluate(() => {
  const Real = window.VideoEncoder;
  window.VideoEncoder = class extends Real {
    constructor(init) {
      super(init);
      this.__init = init;
    }
    configure(cfg) {
      this.__hardware = cfg.hardwareAcceleration !== 'prefer-software';
      super.configure(cfg);
    }
    encode(frame, opts) {
      super.encode(frame, opts);
      if (this.__hardware && !this.__failed) {
        this.__failed = true;
        setTimeout(() => this.__init.error(new DOMException('Simulated hardware encoder failure', 'EncodingError')), 0);
      }
    }
  };
});
const fileB = `${out}/demo-recipe-software-fallback.mp4`;
const noteB = await exportOnce(fileB);
check('a failing hardware encoder falls back to software and says so', /encoded in software/.test(noteB), noteB.slice(0, 220));

// ---- 7. check both files ----
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
const rgb = (file, t) =>
  execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
/** Pixels in the bottom third that differ clearly between two frames: with static stripes, only a caption changes there. */
const changedInBottomThird = (a, b) => {
  let n = 0;
  for (let y = Math.floor(H * 0.66); y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 90) n++;
  }
  return n;
};
/** Mean absolute horizontal luminance step inside a box: stripes give a large value, blur a small one. */
const edgeEnergy = (buf, x0, y0, w, h) => {
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w - 1; x++) {
    const a = (y * W + x) * 3;
    const b = a + 3;
    sum += Math.abs(buf[a] * 0.3 + buf[a + 1] * 0.59 + buf[a + 2] * 0.11 - (buf[b] * 0.3 + buf[b + 1] * 0.59 + buf[b + 2] * 0.11));
    count++;
  }
  return sum / count;
};
const volume = (file) => {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr ?? '');
  return m ? Number(m[1]) : -Infinity;
};

for (const [label, file] of [['normal export', fileA], ['software fallback export', fileB]]) {
  const p = probe(file);
  const v = p.streams.find((s) => s.codec_type === 'video');
  const a = p.streams.find((s) => s.codec_type === 'audio');
  const dur = Number(p.format.duration);
  check(`${label}: H.264 video at ${W}x${H}`, v?.codec_name === 'h264' && v.width === W && v.height === H, `${v?.codec_name} ${v?.width}x${v?.height}`);
  check(`${label}: has an audio track`, !!a && ['aac', 'opus'].includes(a.codec_name), a ? a.codec_name : 'none');
  check(`${label}: as long as the timeline`, Math.abs(dur - timelineSeconds) < 0.35, `${dur.toFixed(2)} s vs ${timelineSeconds.toFixed(2)} s`);
  check(`${label}: the voiceover is audible`, volume(file) > -55, `${volume(file)} dB`);
  const captionFrame = rgb(file, tIn);
  const gapFrame = rgb(file, tGap);
  const cleanFrame = rgb(file, tClean);
  const withCaption = changedInBottomThird(captionFrame, cleanFrame);
  const between = changedInBottomThird(gapFrame, cleanFrame);
  check(`${label}: the caption is burned in at ${tIn.toFixed(1)} s`, withCaption > 2000 && between < 200, `${withCaption} changed px while captioned, ${between} between captions`);
  const inside = edgeEnergy(gapFrame, regionBox.left + 16, regionBox.top + 12, Math.max(8, regionBox.width - 32), Math.max(8, regionBox.height - 24));
  const outside = edgeEnergy(gapFrame, 60, 80, Math.max(8, regionBox.width - 32), Math.max(8, regionBox.height - 24));
  check(`${label}: the blur region softens the picture`, outside > 8 && inside < outside * 0.55, `edge energy ${inside.toFixed(1)} inside vs ${outside.toFixed(1)} outside`);
  const full = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  check(`${label}: decodes cleanly`, full.status === 0 && !(full.stderr ?? '').trim(), (full.stderr ?? '').slice(0, 160));
}

check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll demo recipe checks passed');
process.exit(failures ? 1 : 0);
