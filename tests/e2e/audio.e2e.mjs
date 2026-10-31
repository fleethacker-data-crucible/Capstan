// Audio area in the real UI (headless Chromium): waveform on the timeline, a fade-in that shows up in the mix the
// exporter builds, noise removal on a synthetic noisy WAV, undo, the volume line and ducking switch.
// Usage: node tests/e2e/audio.e2e.mjs   (CAPSTAN_URL points at a served dist/, run-all.mjs does that)
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
const out = 'tests/e2e/.out';
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- synthetic fixture: 4 s of white noise with a 440 Hz tone in the middle 2 s ------------------------------
function noisyWav() {
  const sr = 48000;
  const n = sr * 4;
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + n * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sr, 24);
  data.writeUInt32LE(sr * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const tone = t >= 1 && t < 3 ? 0.3 * Math.sin(2 * Math.PI * 440 * t) : 0;
    const noise = 0.03 * Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, tone + noise)) * 32767), 44 + i * 2);
  }
  return data;
}
writeFileSync(`${out}/noisy.wav`, noisyWav());

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(base + '/');
await page.waitForSelector('.welcome');
await page.getByRole('button', { name: 'Go to the editor' }).click();
await page.waitForSelector('.media-bin');
await page.setInputFiles('.bin-actions input[type=file]', ['tests/fixtures/tone.wav', `${out}/noisy.wav`]);
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 2, null, { timeout: 20000 });

// The Audio tab is there.
check('the toolbox has an Audio tab', (await page.getByRole('tab', { name: 'Audio' }).count()) === 1);

// ---- waveform ----------------------------------------------------------------------------------------------
await page.locator('.bin-item', { hasText: 'tone.wav' }).dblclick();
await page.waitForSelector('.clip');
await page.waitForSelector('.clip-waveform');
const waveStats = () =>
  page.evaluate(() => {
    const c = document.querySelector('.clip-waveform');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    let top = c.height;
    let bottom = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] > 0) {
          lit++;
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }
    return { width: c.width, height: c.height, lit, top, bottom };
  });
await page.waitForFunction(
  () => {
    const c = document.querySelector('.clip-waveform');
    if (!c) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  },
  null,
  { timeout: 15000 },
);
const wave = await waveStats();
await page.screenshot({ path: `${out}/audio-01-waveform.png` });
check('the waveform canvas of tone.wav has drawn pixels', wave.lit > 200, `${wave.lit} lit of ${wave.width}x${wave.height}`);
check('the waveform spans the clip width (2 s at 60 px/s)', Math.abs(wave.width - 120) <= 2, `${wave.width}px`);
check('the tone fills a band around the middle, not the whole height', wave.top > 2 && wave.bottom < wave.height - 2 && wave.bottom - wave.top >= 4, `rows ${wave.top}..${wave.bottom} of ${wave.height}`);

// ---- fade in -----------------------------------------------------------------------------------------------
await page.locator('.clip.kind-audio').click({ position: { x: 40, y: 20 } });
await page.waitForSelector('#audio-heading');
check('the Inspector shows the Audio section', await page.isVisible('#audio-heading'));
const fadeIn = page.locator('#f-fade-in');
await fadeIn.fill('1');
await fadeIn.press('Enter');
await page.waitForSelector('.clip-volume .line');
check('a fade draws the volume line on the clip', (await page.locator('.clip-volume .line').count()) === 1);
await page.waitForTimeout(900); // autosave

const harness = await context.newPage();
await harness.goto(`${base}/harness`);
await harness.waitForFunction(() => document.title === 'harness-ready');
const fadeLevels = await harness.evaluate(() => window.mixSaved([[0, 0.2], [0.4, 0.6], [1.2, 1.6], [1.6, 1.99]]));
console.log('mix levels (dBFS) at 0-0.2, 0.4-0.6, 1.2-1.6, 1.6-2.0 s:', fadeLevels?.map((v) => v.toFixed(1)).join(', '));
check('the mixed audio starts quiet with a 1 s fade-in', !!fadeLevels && fadeLevels[0] < fadeLevels[2] - 15, `${fadeLevels?.[0].toFixed(1)} vs ${fadeLevels?.[2].toFixed(1)} dB`);
check('the mix rises through the fade', !!fadeLevels && fadeLevels[0] < fadeLevels[1] && fadeLevels[1] < fadeLevels[2]);
check('after the fade the level is steady and full', !!fadeLevels && Math.abs(fadeLevels[2] - fadeLevels[3]) < 1 && fadeLevels[2] > -25, `${fadeLevels?.[2].toFixed(1)} / ${fadeLevels?.[3].toFixed(1)} dB`);

// ---- ducking in the export mixer -------------------------------------------------------------------------------
const plain = await harness.evaluate(() => window.duckMix(false));
const ducked = await harness.evaluate(() => window.duckMix(true));
console.log('200 Hz music level before / during / after the narration, no ducking:', plain.map((v) => v.toFixed(1)).join(', '), ' ducking:', ducked.map((v) => v.toFixed(1)).join(', '));
check('without ducking the music stays level', plain.length === 3 && Math.abs(plain[0] - plain[1]) < 0.5 && Math.abs(plain[1] - plain[2]) < 0.5);
check('with ducking the music dips about 12 dB under the narration', ducked.length === 3 && Math.abs(ducked[0] - plain[0]) < 0.5 && Math.abs(plain[1] - ducked[1] - 12) < 1.5, `${(plain[1] - ducked[1]).toFixed(1)} dB`);
check('and recovers once the narration has stopped', ducked.length === 3 && Math.abs(ducked[2] - plain[2]) < 0.5, `${(ducked[2] - plain[2]).toFixed(2)} dB`);

// ---- volume point: add at the playhead, drag on the timeline ------------------------------------------------
await page.locator('.ruler').click({ position: { x: 90, y: 10 } }); // 1.5 s
await page.locator('.clip.kind-audio').click({ position: { x: 20, y: 20 } }); // the ruler click cleared the selection
await page.getByRole('button', { name: 'Add point at playhead' }).click();
await page.waitForSelector('.clip-volume circle.point');
check('Add point at playhead lists a point and draws it on the clip', (await page.locator('.audio-points li').count()) === 1 && (await page.locator('.clip-volume circle.point').count()) === 1);
const dot = await page.locator('.clip-volume circle.point').boundingBox();
await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
await page.mouse.down();
await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2 + 12, { steps: 6 });
await page.mouse.up();
const pointValue = await page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const db = await new Promise((res) => {
    const rq = indexedDB.open('capstan');
    rq.onsuccess = () => res(rq.result);
  });
  const id = await new Promise((res) => {
    const rq = db.transaction('meta').objectStore('meta').get('lastProjectId');
    rq.onsuccess = () => res(rq.result);
  });
  const project = await new Promise((res) => {
    const rq = db.transaction('projects').objectStore('projects').get(id);
    rq.onsuccess = () => res(rq.result);
  });
  const clip = project.clips.find((c) => c.keys?.volume);
  return clip?.keys.volume.map((k) => [Math.round(k.t * 100) / 100, k.v]);
});
check('dragging the point down lowers its value', Array.isArray(pointValue) && pointValue.length === 1 && pointValue[0][1] < 0.95 && pointValue[0][1] > 0.2, JSON.stringify(pointValue));
await page.screenshot({ path: `${out}/audio-02-points.png` });
await page.getByRole('button', { name: 'Clear points' }).click();
check('Clear points removes them', (await page.locator('.clip-volume circle.point').count()) === 0);

// ---- noise removal -----------------------------------------------------------------------------------------
await page.locator('.bin-item', { hasText: 'noisy.wav' }).dblclick();
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 2);
const noisyClip = page.locator('.clip', { hasText: 'noisy.wav' });
await noisyClip.click({ position: { x: 30, y: 20 } });
await page.waitForSelector('#audio-heading');
await page.getByRole('button', { name: 'Remove noise' }).last().click();
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 3, null, { timeout: 30000 });
await page.waitForSelector('.clip:has-text("denoised")', { timeout: 15000 });
await page.screenshot({ path: `${out}/audio-03-denoised.png` });
check('a new "(denoised)" WAV appears in the media bin', (await page.locator('.bin-item', { hasText: 'noisy (denoised).wav' }).count()) === 1);
check('the clip now plays the denoised media', (await page.locator('.clip', { hasText: 'noisy (denoised).wav' }).count()) === 1 && (await page.locator('.clip', { hasText: 'noisy.wav' }).count()) === 0);
await page.waitForTimeout(900);
const windows = [[0.2, 0.9], [3.1, 3.9], [1.5, 2.5]];
const before = await harness.evaluate((w) => window.mediaLevels('noisy.wav', w), windows);
const after = await harness.evaluate((w) => window.mediaLevels('noisy (denoised).wav', w), windows);
console.log('noise-only / noise-only / tone levels before:', before?.map((v) => v.toFixed(1)).join(', '), 'after:', after?.map((v) => v.toFixed(1)).join(', '));
check('noise-only parts drop by at least 12 dB', !!before && !!after && before[0] - after[0] >= 12 && before[1] - after[1] >= 12, `${(before?.[0] - after?.[0]).toFixed(1)} / ${(before?.[1] - after?.[1]).toFixed(1)} dB`);
check('the tone part stays within 1.5 dB', !!before && !!after && Math.abs(before[2] - after[2]) < 1.5, `${(after?.[2] - before?.[2]).toFixed(2)} dB`);

// Undo goes back to the original media (the processed file stays in the bin).
await page.keyboard.press('Control+z');
await page.waitForFunction(() => !!document.querySelector('.clip') && document.querySelectorAll('.clip').length === 2);
check('undo switches the clip back to the original media', (await page.locator('.clip', { hasText: 'noisy.wav' }).count()) === 1);
await page.keyboard.press('Control+y');
await page.waitForSelector('.clip:has-text("denoised")');
check('redo applies it again', (await page.locator('.clip', { hasText: 'noisy (denoised).wav' }).count()) === 1);

// ---- levelling and ducking switch -------------------------------------------------------------------------
await page.locator('.clip', { hasText: 'tone.wav' }).click({ position: { x: 30, y: 20 } });
await page.waitForSelector('#audio-heading');
await page.getByRole('button', { name: 'Level volume' }).last().click();
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 4, null, { timeout: 30000 });
check('Level volume adds a "(levelled)" WAV to the bin', (await page.locator('.bin-item', { hasText: 'tone (levelled).wav' }).count()) === 1);
await page.waitForSelector('.clip:has-text("levelled")');
await page.waitForTimeout(900);
const levelled = await harness.evaluate(() => window.mediaLevels('tone (levelled).wav', [[0.2, 1.8]]));
check('the levelled clip lands near the -18 dB target', !!levelled && Math.abs(levelled[0] + 18) < 1.5, `${levelled?.[0].toFixed(1)} dB`);

await page.locator('.clip', { hasText: 'denoised' }).click({ position: { x: 30, y: 20 } });
await page.waitForSelector('#audio-duck');
await page.locator('#audio-duck').check();
await page.waitForSelector('#f-speaking-above');
check('switching on ducking shows its settings', await page.isVisible('#f-lower-others-by'));
await page.waitForTimeout(900);
const duckSaved = await harness.evaluate(async () => {
  const rq = indexedDB.open('capstan');
  const db = await new Promise((res) => (rq.onsuccess = () => res(rq.result)));
  const id = await new Promise((res) => {
    const r = db.transaction('meta').objectStore('meta').get('lastProjectId');
    r.onsuccess = () => res(r.result);
  });
  const project = await new Promise((res) => {
    const r = db.transaction('projects').objectStore('projects').get(id);
    r.onsuccess = () => res(r.result);
  });
  return project.clips.filter((c) => c.audio?.duck).length;
});
check('the ducking setting is saved on the narration clip', duckSaved === 1, String(duckSaved));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll audio checks passed');
process.exit(failures ? 1 : 0);
