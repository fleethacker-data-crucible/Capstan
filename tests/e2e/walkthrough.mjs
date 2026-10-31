// Captures the walkthrough screenshots (docs/walkthrough/README.md) from the current build, 1440x900,
// Night watch theme, by driving the real UI. The demo media is made here, so no real recording or
// project ends up in docs/: demo-title.png is a plain title card, demo-clip.webm is a 10-second
// recording of Capstan's own welcome screen, demo-captions.srt is a few made-up caption lines, and
// the audio is a synthetic six-second tone shaped like spoken phrases (demo-voice.wav).
//   node tests/serve.mjs 8790   (in another window)
//   node tests/e2e/walkthrough.mjs            (CAPSTAN_URL overrides the address)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
const out = 'docs/assets/walkthrough';
const demo = 'tests/e2e/.out/demo';
rmSync(demo, { recursive: true, force: true });
mkdirSync(demo, { recursive: true });
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();

// Demo media.
{
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent(
    `<body style="margin:0;width:1920px;height:1080px;display:grid;place-items:center;background:#101c44;color:#fff;font:bold 200px sans-serif">Capstan demo</body>`,
  );
  await page.screenshot({ path: `${demo}/demo-title.png` });
  await ctx.close();
}
{
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    colorScheme: 'dark',
    recordVideo: { dir: `${demo}/raw`, size: { width: 1280, height: 720 } },
  });
  const page = await ctx.newPage();
  await page.goto(base + '/');
  await page.waitForSelector('.welcome');
  await page.waitForTimeout(9_800);
  await ctx.close();
  const [raw] = readdirSync(`${demo}/raw`);
  renameSync(join(demo, 'raw', raw), `${demo}/raw.webm`);
  // The recorder writes no duration; remux so the clip is a steady 10 seconds in the editor (best effort).
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', `${demo}/raw.webm`, '-t', '10', '-c', 'copy', `${demo}/demo-clip.webm`]);
  } catch {
    renameSync(`${demo}/raw.webm`, `${demo}/demo-clip.webm`);
  }
}
writeFileSync(
  `${demo}/demo-captions.srt`,
  [
    '1',
    '00:00:00,500 --> 00:00:02,500',
    'Welcome to the demo',
    '',
    '2',
    '00:00:03,000 --> 00:00:05,000',
    'Pick a clip on the timeline',
    '',
    '3',
    '00:00:05,500 --> 00:00:08,000',
    'Then trim, style and export it',
    '',
  ].join('\n'),
);

// demo-voice.wav: a 220 Hz tone shaped into phrase-like bursts, so the timeline waveform has some shape.
{
  const rate = 22050;
  const n = rate * 6;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const phrase = Math.max(0, Math.sin(Math.PI * ((t * 0.55) % 1))) ** 0.6; // slow swell per phrase
    const syllable = 0.55 + 0.45 * Math.abs(Math.sin(Math.PI * t * 3.2)); // faster ripple inside it
    const v = Math.sin(2 * Math.PI * 220 * t) * 0.8 * phrase * syllable;
    buf.writeInt16LE(Math.round(v * 20000), 44 + i * 2);
  }
  writeFileSync(`${demo}/demo-voice.wav`, buf);
}

const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const shot = async (name) => {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`saved ${out}/${name}.png`);
};
/** Moves the playhead to a time in seconds (the timeline is 60 px per second). */
const seek = async (t) => {
  await page.locator('.ruler').click({ position: { x: 60 * t, y: 10 } });
  await page.waitForTimeout(250);
};
const setField = async (id, v) => {
  const el = page.locator(`#${id}`);
  await el.fill(String(v));
  await el.press('Enter');
};
/** Scrolls the Inspector back to its top, since editing a field near the bottom scrolls it. */
const inspectorTop = () => page.evaluate(() => document.querySelectorAll('.inspector').forEach((e) => (e.scrollTop = 0)));
const defocus = () => page.locator('.transport .timecode').click(); // takes focus out of any field

// Start from an empty project with the default (collapsed) sidebar and theme.
await page.goto(base + '/');
await page.evaluate(async () => {
  try {
    window.localStorage.clear();
  } catch {}
  for (const db of (await indexedDB.databases?.()) ?? []) if (db.name) indexedDB.deleteDatabase(db.name);
});
await page.reload();
await page.waitForSelector('.welcome');
await shot('01-first-launch');

// 2. Import media.
await page.getByRole('button', { name: 'Go to the editor' }).click();
await page.waitForSelector('.media-bin');
await page.setInputFiles('.bin-actions input[type=file]', [`${demo}/demo-clip.webm`, `${demo}/demo-title.png`]);
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 2);
await shot('02-import-media');

// 3. Clip on track 1 at 0s, title card on track 2 at 0s, then split the clip at 5s.
const lanes = page.locator('.lane');
const count = await lanes.count();
await page.locator('.bin-item', { hasText: 'demo-clip.webm' }).dragTo(lanes.nth(count - 1), { targetPosition: { x: 2, y: 20 } });
await page.locator('.bin-item', { hasText: 'demo-title.png' }).dragTo(lanes.nth(count - 2), { targetPosition: { x: 2, y: 20 } });
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 2);
await seek(5);
await page.locator('.clip.kind-video').click({ position: { x: 20, y: 12 } });
await page.keyboard.press('s');
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 3);
await page.locator('.clip.kind-video').first().click({ position: { x: 20, y: 12 } });
await shot('03-timeline-edit');

// 4. Select the title card with the playhead at 1.5s.
await seek(1.5);
await page.locator('.clip.kind-image').click({ position: { x: 150, y: 12 } });
await shot('04-clip-properties');

// 5. Record dialog.
await page.locator('.bin-actions button', { hasText: 'Record screen' }).click();
await page.waitForSelector('[aria-labelledby="record-title"]');
await shot('05-record-dialog');
await page.getByRole('button', { name: 'Cancel' }).click();

// 6. A blur region over the preview, selected, with its Inspector.
await seek(1.5);
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Add blur region at playhead' }).click();
await page.waitForSelector('.region-box');
await setField('f-left', 1000);
await setField('f-top', 390);
await setField('f-width', 540);
await setField('f-height', 300);
await defocus();
await inspectorTop();
await shot('06-blur-and-captions');

// 7. Export dialog (nothing selected behind it).
await page.getByRole('button', { name: 'Delete region' }).click();
await page.locator('.toolbar .button.export').click();
await page.waitForSelector('[aria-labelledby="export-title"]');
await shot('07-export-dialog');
await page.getByRole('button', { name: 'Cancel' }).click();

// 8. Annotations: a callout and an arrow on the picture, the Notes tab open, the callout in the Inspector.
await seek(2);
await page.getByRole('tab', { name: 'Notes' }).click();
await page.getByRole('button', { name: 'Arrow', exact: true }).click();
await setField('f-left', 560);
await setField('f-top', 650);
await setField('f-box-width', 340);
await setField('f-box-height', 170);
await page.getByRole('button', { name: 'Callout', exact: true }).click();
await page.locator('#ann-text').fill('Start here');
await page.locator('#ann-text').press('Tab');
await setField('f-left', 1180);
await setField('f-top', 140);
await defocus();
await inspectorTop();
await shot('08-annotations');

// 9. Motion: a zoom-n-pan region on its timeline lane and a fade on the title card, playhead mid-zoom.
await page.getByRole('tab', { name: 'Motion' }).click();
await seek(1);
await page.getByRole('button', { name: 'Add zoom at playhead' }).click();
await page.waitForSelector('.zoom-box');
await page.locator('.clip.kind-image').click({ position: { x: 150, y: 12 } });
await page.getByRole('group', { name: 'Transition presets' }).getByRole('button', { name: 'Fade', exact: true }).click();
await page.waitForSelector('.transition-mark');
// Seek with the keyboard to 2:15 (inside the zoom): a ruler click would clear the selection.
await page.locator('.transport .timecode').click();
await page.keyboard.press('Home');
for (let i = 0; i < 2; i++) await page.keyboard.press('Shift+ArrowRight');
for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowRight');
await page.waitForTimeout(300);
await inspectorTop();
await shot('09-motion');

// 10. Effects: the title card as a rounded card with a shadow, the recording in a laptop frame
// (a framed clip draws its own corners), on a lighter project background so the shadows show.
await page.keyboard.press('Escape');
await page.locator('#project-bg').fill('#3d5a80');
await page.locator('#project-bg').press('Tab');
await page.getByRole('tab', { name: 'Effects' }).click();
await seek(0.8);
await page.locator('.clip.kind-image').click({ position: { x: 150, y: 12 } });
await setField('f-scale', 42);
await setField('f-position-x', 520);
await page.getByRole('button', { name: /Rounded card with shadow/ }).click();
await page.locator('.clip.kind-video').first().click({ position: { x: 100, y: 12 } });
await setField('f-scale', 46);
await setField('f-position-x', 1390);
await page.getByRole('button', { name: /Laptop frame/ }).click();
await page.waitForTimeout(400);
await defocus();
await page.getByLabel('Drop shadow').check();
await page.waitForTimeout(300);
await page.locator('#fx-frame').scrollIntoViewIfNeeded();
await page.evaluate(() => document.querySelectorAll('.inspector').forEach((e) => (e.scrollTop += 120)));
await shot('10-effects');

// 11. Captions and markers: three captions in the Captions tab and on their lane, two chapter markers on the ruler.
await page.keyboard.press('Escape');
await defocus();
await seek(1);
await page.keyboard.press('m');
await page.waitForSelector('#marker-name');
await page.locator('#marker-name').fill('Intro');
await page.locator('#marker-name').blur();
await page.getByLabel('Chapter: written to the exported video and offered as a chapters file').check();
await defocus();
await seek(5);
await page.keyboard.press('m');
await page.waitForSelector('#marker-name');
await page.locator('#marker-name').fill('Details');
await page.locator('#marker-name').blur();
await page.getByLabel('Chapter: written to the exported video and offered as a chapters file').check();
await defocus();
await page.getByRole('tab', { name: 'Captions' }).click();
await page.setInputFiles('.captions-panel input[type=file]', [`${demo}/demo-captions.srt`]);
await page.waitForFunction(() => document.querySelectorAll('.caption-row').length === 3);
await seek(4.2);
await page.locator('.overlay-lane .overlay-item.kind-captions').nth(1).click();
await defocus();
await inspectorTop();
await shot('11-captions-markers');

// 12. Audio: a synthetic voice-like clip on its own track, waveform on the clip, a one-second fade in set in the Inspector.
await page.getByRole('tab', { name: 'Media' }).click();
await page.setInputFiles('.bin-actions input[type=file]', [`${demo}/demo-voice.wav`]);
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 3);
await defocus();
await page.keyboard.press('Home');
await page.locator('.bin-item', { hasText: 'demo-voice.wav' }).dblclick();
await page.waitForSelector('.clip.kind-audio');
await page.getByRole('tab', { name: 'Audio' }).click();
await seek(4.4);
await page.locator('.clip.kind-audio').click({ position: { x: 40, y: 20 } });
await page.waitForSelector('#f-fade-in');
await setField('f-fade-in', 1);
await page.waitForSelector('.clip-volume .line');
await defocus();
await page.locator('#f-fade-in').scrollIntoViewIfNeeded();
await shot('12-audio');

// 13. Export formats: a range marked on the ruler with I and O, the export dialog on GIF.
await page.keyboard.press('Escape');
await page.getByRole('tab', { name: 'Media' }).click();
await seek(1.5);
await page.keyboard.press('i');
await seek(4.5);
await page.keyboard.press('o');
await page.locator('.toolbar .button.export').click();
await page.waitForSelector('[aria-labelledby="export-title"]');
await page.selectOption('#export-format', 'gif');
await page.selectOption('#export-range', 'marks');
await page.waitForTimeout(300);
await shot('13-export-formats');
await page.getByRole('button', { name: 'Cancel' }).click();

await browser.close();
console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors');
