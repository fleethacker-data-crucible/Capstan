// Captions and markers through the real UI: import an SRT and a VTT, edit text and see it on the preview
// canvas, drag a caption in its lane, split and merge, markers with M (add, rename, jump, drag, delete),
// SRT and VTT export through the download event, undo, and an MP4 export checked with ffprobe for chapters.
// Usage: node tests/e2e/captions-markers.e2e.mjs   (or via run-all.mjs captions)
import { execFileSync } from 'node:child_process';
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

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const downloads = [];
page.on('download', (d) => downloads.push(d));

const timecode = async () => (await page.locator('.timecode .now').textContent()).trim();
const seek = async (t) => {
  await page.locator('.ruler').click({ position: { x: t * 60, y: 8 } });
  await page.waitForTimeout(150);
};
const blurFocus = () => page.locator('.transport .timecode').click();
const laneItems = () => page.locator('.overlay-lane .overlay-item.kind-captions');
const flags = () => page.locator('.marker-flag');
/** Count of near-white pixels in the lower third of the preview: the caption's text. */
const whitePixels = () =>
  page.evaluate(() => {
    const c = document.querySelector('.preview-canvas');
    const d = c.getContext('2d').getImageData(0, Math.floor(c.height * 0.66), c.width, Math.floor(c.height * 0.34)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) n++;
    return n;
  });
const readDownload = async (d) => readFileSync(await d.path(), 'utf8');

await page.goto(base + '/');
await page.getByRole('button', { name: 'Go to the editor' }).click();
await page.waitForSelector('.media-bin');
await page.setInputFiles('.bin-actions input[type=file]', ['tests/fixtures/card.png']);
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 1, null, { timeout: 20000 });
await page.locator('.bin-item').dblclick();
await page.waitForSelector('.clip');
// Trim the 5 s card to 3 s so the export at the end stays small.
const card = page.locator('.clip.kind-image');
const cb = await card.boundingBox();
await page.mouse.move(cb.x + cb.width - 2, cb.y + cb.height / 2);
await page.mouse.down();
await page.mouse.move(cb.x + cb.width - 62, cb.y + cb.height / 2, { steps: 6 });
await page.mouse.move(cb.x + cb.width - 122, cb.y + cb.height / 2, { steps: 6 });
await page.mouse.up();
check('the card clip is trimmed to about 3 s', Math.abs((await card.boundingBox()).width - 180) <= 3);

// ---- the Captions tab ----
await page.getByRole('tab', { name: 'Captions' }).click();
await page.waitForSelector('.captions-panel');
check('the Captions tab shows an empty state with the add and import buttons', (await page.getByRole('button', { name: 'Add caption at playhead' }).count()) === 1 && (await page.locator('.captions-panel .bin-empty').count()) === 1);
check('no caption lane while there are no captions', (await laneItems().count()) === 0);

// Import an SRT.
await page.setInputFiles('.captions-panel input[type=file]', ['tests/fixtures/captions-sample.srt']);
await page.waitForFunction(() => document.querySelectorAll('.caption-row').length === 3);
check('SRT import lists 3 captions with their text', (await page.locator('.caption-row textarea').nth(1).inputValue()) === 'Second line\nwith a break');
check('captions get a lane under the tracks', (await laneItems().count()) === 3);

// Import a WebVTT file: replaces them, entities and voice tags handled.
await page.setInputFiles('.captions-panel input[type=file]', ['tests/fixtures/captions-sample.vtt']);
await page.waitForFunction(() => document.querySelectorAll('.caption-row').length === 2);
check('VTT import reads cue settings, entities and voice tags', (await page.locator('.caption-row textarea').nth(0).inputValue()) === 'Hello & welcome' && (await page.locator('.caption-row textarea').nth(1).inputValue()) === 'Second cue');
await blurFocus();
await page.keyboard.press('Control+z');
await page.waitForFunction(() => document.querySelectorAll('.caption-row').length === 3);
check('undo brings the SRT captions back', (await page.locator('.caption-row').count()) === 3);

// ---- edit a caption's text and see it on the picture ----
await seek(1.0);
await page.waitForTimeout(250);
const before = await whitePixels();
check('the caption is drawn on the preview canvas at 1.0 s', before > 100, `${before} white px`);
const first = page.locator('.caption-row textarea').first();
await first.fill('Hi');
await page.waitForTimeout(250);
const shorter = await whitePixels();
check('editing the text changes the picture straight away', shorter > 20 && shorter < before * 0.6, `${before} -> ${shorter}`);
check('the lane label follows the text', (await laneItems().first().getAttribute('aria-label')).includes('Hi'));
await blurFocus();
await page.keyboard.press('Control+z');
await page.waitForTimeout(250);
check('one text edit is one undo step', (await first.inputValue()) === 'Hello from Capstan' && Math.abs((await whitePixels()) - before) < before * 0.05);

// Clearing the text must not break the picture.
await first.fill('');
await page.waitForTimeout(200);
check('empty caption text draws nothing and does not throw', (await whitePixels()) < 20);
await first.fill('Hello from Capstan');
await blurFocus();
await page.keyboard.press('Control+z');

// ---- the caption editor in the inspector ----
await laneItems().first().click({ position: { x: 20, y: 10 } });
await page.waitForSelector('#caption-text');
check('selecting a caption in its lane opens the caption editor', (await page.locator('#caption-text').inputValue()) === 'Hello from Capstan');
check('timing is shown in frames', (await page.locator('#caption-start-frame').inputValue()) === '12' && (await page.locator('#caption-end-frame').inputValue()) === '42');
await page.locator('#caption-start-frame').fill('15');
await page.locator('#caption-start-frame').press('Enter');
check('the start frame field retimes the caption', Math.abs(Number(await page.locator('#f-start').inputValue()) - 0.5) < 0.01);
await blurFocus();
await page.keyboard.press('Control+z');
check('and undoes', (await page.locator('#caption-start-frame').inputValue()) === '12');

// ---- drag a caption in its lane ----
const startField = async () => Number(await page.locator('#f-start').inputValue());
const endField = async () => Number(await page.locator('#f-end').inputValue());
const s0 = await startField();
const e0 = await endField();
const item = laneItems().first();
let ib = await item.boundingBox();
await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2);
await page.mouse.down();
await page.mouse.move(ib.x + ib.width / 2 + 30, ib.y + ib.height / 2, { steps: 5 });
await page.mouse.move(ib.x + ib.width / 2 + 60, ib.y + ib.height / 2, { steps: 5 });
await page.mouse.up();
const s1 = await startField();
const e1 = await endField();
check('dragging a caption in its lane moves it by about a second, keeping its length', Math.abs(s1 - s0 - 1) < 0.2 && Math.abs(e1 - e0 - (s1 - s0)) < 0.02, `${s0}-${e0} -> ${s1}-${e1}`);
await page.keyboard.press('Control+z');
check('the drag is one undo step', Math.abs((await startField()) - s0) < 0.01);

// Trim the end by its right edge.
ib = await laneItems().first().boundingBox();
await page.mouse.move(ib.x + ib.width - 2, ib.y + ib.height / 2);
await page.mouse.down();
await page.mouse.move(ib.x + ib.width + 20, ib.y + ib.height / 2, { steps: 5 });
await page.mouse.move(ib.x + ib.width + 30, ib.y + ib.height / 2, { steps: 5 });
await page.mouse.up();
check('dragging the right edge changes only the end', Math.abs((await startField()) - s0) < 0.01 && (await endField()) > e0 + 0.3, `end ${e0} -> ${await endField()}`);
await page.keyboard.press('Control+z');

// ---- split, merge, delete ----
await seek(0.9);
await laneItems().first().click({ position: { x: 20, y: 10 } });
await page.getByRole('button', { name: 'Split at playhead', exact: true }).click();
await page.waitForFunction(() => document.querySelectorAll('.caption-row').length === 4);
const texts = await page.locator('.caption-row textarea').evaluateAll((els) => els.slice(0, 2).map((e) => e.value));
check('split at the playhead makes two captions that keep all the words', `${texts[0]} ${texts[1]}` === 'Hello from Capstan' && texts[0] && texts[1], JSON.stringify(texts));
await page.getByRole('button', { name: 'Merge with next' }).click();
await page.waitForFunction(() => document.querySelectorAll('.caption-row').length === 3);
check('merge with next joins them again', (await page.locator('.caption-row textarea').first().inputValue()).replace('\n', ' ') === 'Hello from Capstan');
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Delete caption 3' }).click();
check('the list delete button removes a caption', (await page.locator('.caption-row').count()) === 2);
await blurFocus();
await page.keyboard.press('Control+z');
check('delete undoes', (await page.locator('.caption-row').count()) === 3);

// Select by lane, delete with the Delete key.
await laneItems().nth(2).click({ position: { x: 4, y: 10 } });
await page.keyboard.press('Delete');
check('Delete removes the selected caption', (await laneItems().count()) === 2);
await page.keyboard.press('Control+z');
check('and undoes', (await laneItems().count()) === 3);

// Shift all.
await page.keyboard.press('Escape');
const startOf = () => page.locator('.caption-jump').first().textContent();
const t0 = await startOf();
await page.locator('#caption-shift').fill('0.5');
await page.getByRole('button', { name: 'Later' }).click();
check('shift all moves every caption', (await startOf()) !== t0, `${t0.trim()} -> ${(await startOf()).trim()}`);
await page.keyboard.press('Control+z');

// Add at the playhead.
await seek(2.7);
await page.getByRole('button', { name: 'Add caption at playhead' }).click();
await page.waitForFunction(() => document.querySelectorAll('.caption-row').length === 4);
check('Add caption at playhead selects the new caption', (await page.locator('#caption-text').inputValue()) === 'New caption');
await blurFocus();
await page.keyboard.press('Control+z');
check('and undoes', (await page.locator('.caption-row').count()) === 3);

// ---- export SRT and VTT ----
const dSrt = page.waitForEvent('download');
await page.getByRole('button', { name: 'Export .srt' }).click();
const srt = await readDownload(await dSrt);
check('Export .srt downloads a numbered SRT', srt.startsWith('1\n00:00:00,400 --> 00:00:01,400\nHello from\nCapstan\n') && srt.includes('Second line\nwith a break'), JSON.stringify(srt.slice(0, 60)));
const dVtt = page.waitForEvent('download');
await page.getByRole('button', { name: 'Export .vtt' }).click();
const vttDownload = await dVtt;
const vtt = await readDownload(vttDownload);
check('Export .vtt downloads WebVTT with dotted times', vtt.startsWith('WEBVTT\n\n1\n00:00:00.400 --> 00:00:01.400\nHello from\nCapstan\n') && vtt.includes('00:00:02.500 --> 00:00:02.900'), JSON.stringify(vtt.slice(0, 70)));
check('the exported file is named after the project', vttDownload.suggestedFilename().endsWith('.vtt'));
// The exported VTT imports back to the same captions.
await page.setInputFiles('.captions-panel input[type=file]', { name: 'roundtrip.vtt', mimeType: 'text/vtt', buffer: Buffer.from(vtt) });
await page.waitForTimeout(300);
check('the exported VTT imports back unchanged', (await page.locator('.caption-row').count()) === 3 && (await page.locator('.caption-row textarea').nth(1).inputValue()) === 'Second line\nwith a break');

// ---- markers ----
await blurFocus();
await seek(1.0);
await page.keyboard.press('m');
check('M adds a marker flag on the ruler at the playhead', (await flags().count()) === 1);
await page.waitForSelector('#marker-name');
check('the new marker is selected and its panel is open', (await page.locator('#marker-name').inputValue()) === 'Marker 1');
await page.locator('#marker-name').fill('Intro');
await page.locator('#marker-name').blur();
check('renaming shows on the ruler', (await flags().first().getAttribute('aria-label')).includes('Intro'));
await page.getByLabel('Chapter: written to the exported video and offered as a chapters file').check();
check('the chapter checkbox marks it as a chapter', (await flags().first().getAttribute('aria-label')).startsWith('Chapter'));
// typing an m in a text field must not add a marker
await page.locator('#marker-name').click();
await page.keyboard.type('m');
await page.locator('#marker-name').fill('Intro');
await blurFocus();
check('M typed into a field does not add a marker', (await flags().count()) === 1);
await seek(2.0);
await page.keyboard.press('m');
await page.waitForSelector('#marker-name');
await page.locator('#marker-name').fill('Demo');
await page.locator('#marker-name').blur();
await page.getByLabel('Chapter: written to the exported video and offered as a chapters file').check();
check('a second marker is added in time order', (await flags().count()) === 2);

await blurFocus();
// The list in the project panel: jump, rename, chapter toggle, delete.
await page.keyboard.press('Escape');
await page.waitForSelector('.marker-list');
check('the project panel lists both markers', (await page.locator('.marker-row').count()) === 2);
await page.locator('.marker-jump').first().click();
await page.waitForTimeout(150);
check('the list jump button seeks to the marker', (await timecode()) === '0:00:01;00', await timecode());
await page.locator('.marker-name').nth(1).fill('Demo part');
await page.locator('.marker-name').nth(1).blur();
check('renaming in the list updates the ruler flag', (await flags().nth(1).getAttribute('aria-label')).includes('Demo part'));
await page.getByLabel('Chapter: Demo part').uncheck();
check('the list chapter toggle updates the flag', (await flags().nth(1).getAttribute('aria-label')).startsWith('Marker'));
await page.getByLabel('Chapter: Demo part').check();

// Click a flag: selects it and seeks. Drag it: moves it.
const f1 = await flags().first().boundingBox();
await page.mouse.click(f1.x + 1, f1.y + 14);
await page.waitForSelector('#marker-name');
check('clicking a flag selects the marker and seeks to it', (await page.locator('#marker-name').inputValue()) === 'Intro' && (await timecode()) === '0:00:01;00');
const time0 = Number(await page.locator('#f-time').inputValue());
await page.mouse.move(f1.x + 1, f1.y + 14);
await page.mouse.down();
await page.mouse.move(f1.x + 21, f1.y + 14, { steps: 4 });
await page.mouse.move(f1.x + 31, f1.y + 14, { steps: 4 });
await page.mouse.up();
const time1 = Number(await page.locator('#f-time').inputValue());
check('dragging a flag moves the marker', time1 > time0 + 0.3 && time1 < time0 + 0.7, `${time0} -> ${time1}`);
await page.keyboard.press('Control+z');
check('the drag is one undo step', Math.abs(Number(await page.locator('#f-time').inputValue()) - time0) < 0.01);
await page.getByRole('button', { name: 'Delete marker' }).click();
check('Delete marker removes it', (await flags().count()) === 1);
await page.keyboard.press('Control+z');
check('and undoes', (await flags().count()) === 2);
// Delete key on a selected flag.
const f2 = await flags().nth(1).boundingBox();
await page.mouse.click(f2.x + 1, f2.y + 14);
await page.keyboard.press('Delete');
check('the Delete key removes the selected marker', (await flags().count()) === 1);
await page.keyboard.press('Control+z');
check('and undoes', (await flags().count()) === 2);

// Markers and captions persist across a reload.
await page.waitForTimeout(700);
await page.reload();
await page.waitForFunction(() => document.querySelectorAll('.clip').length >= 1, null, { timeout: 15000 });
check('markers survive a reload', (await flags().count()) === 2);
await page.getByRole('tab', { name: 'Captions' }).click();
check('captions survive a reload', (await page.locator('.caption-row').count()) === 3);

// ---- export: chapters in the MP4 and the sidecar files ----
await page.screenshot({ path: `${out}/captions-markers.png` });
await page.locator('.toolbar .button.export').click();
await page.waitForSelector('#export-title');
await page.selectOption('#export-size', '720');
check('the export dialog offers the chapters files', (await page.getByLabel('Also save chapters files (.txt for YouTube, .vtt)').isChecked()));
downloads.length = 0;
await page.locator('.modal .button.primary').click();
await page.waitForSelector('.modal .success', { timeout: 240000 });
await page.waitForTimeout(500);
const names = downloads.map((d) => d.suggestedFilename());
const mp4 = downloads.find((d) => d.suggestedFilename().endsWith('.mp4'));
const txt = downloads.find((d) => d.suggestedFilename().endsWith('chapters.txt'));
const chVtt = downloads.find((d) => d.suggestedFilename().endsWith('chapters.vtt'));
check('export downloads the MP4 plus chapters.txt and chapters.vtt', !!mp4 && !!txt && !!chVtt, names.join(', '));
if (mp4) {
  const file = `${out}/captions-markers.mp4`;
  await mp4.saveAs(file);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_chapters', '-show_format', '-of', 'json', file]).toString());
  const ch = probe.chapters ?? [];
  check('ffprobe reads two chapters from the MP4', ch.length === 2, JSON.stringify(ch.map((c) => [c.start_time, c.tags?.title])));
  check('chapter titles and start times match the markers', ch[0]?.tags?.title === 'Intro' && Math.abs(Number(ch[0]?.start_time) - 1) < 0.05 && ch[1]?.tags?.title === 'Demo part' && Math.abs(Number(ch[1]?.start_time) - 2) < 0.05);
  check('the last chapter runs to the end of the file', Math.abs(Number(ch[1]?.end_time) - Number(probe.format.duration)) < 0.1, `${ch[1]?.end_time} vs ${probe.format.duration}`);
  let decode = '';
  try {
    decode = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    decode = String(e.stderr ?? e);
  }
  check('the MP4 with chapters decodes without errors', decode.trim() === '', decode.slice(0, 200));
}
if (txt) check('chapters.txt is a YouTube list starting at 0:00', (await readDownload(txt)) === '0:00 Start\n0:01 Intro\n0:02 Demo part\n', JSON.stringify(await readDownload(txt)));
if (chVtt) {
  const v = await readDownload(chVtt);
  check('chapters.vtt is a WebVTT chapters track', v.startsWith('WEBVTT\n\n') && v.includes('00:00:01.000 --> 00:00:02.000\nIntro') && v.includes('00:00:02.000 --> ') && v.includes('Demo part'));
}

check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll captions and markers checks passed');
process.exit(failures ? 1 : 0);
