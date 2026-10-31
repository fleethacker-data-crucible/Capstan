// Recording sources: webcam track, separate mic / system audio tracks, countdown, maximum length,
// recording to disk (OPFS) with crash recovery, and region selection. Usage:
//   node tests/e2e/run-all.mjs recording-sources
//
// Same rules as record.e2e.mjs: getDisplayMedia is replaced by a synthetic canvas stream before the
// page loads, and the fake-UI flag is NOT passed (on Windows it shares the real desktop). The webcam
// and microphone come from Chromium's built-in fake devices, which show a synthetic test pattern.
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// The default headless shell has no media devices at all (getUserMedia fails with NotSupportedError);
// the full Chromium in new headless mode has the built-in fake camera and microphone.
// --disable-gpu: with the GPU process the fake camera track ends within 200 ms on some machines.
const launchArgs = { args: ['--use-fake-device-for-media-stream', '--disable-gpu'] };
const browser = await chromium.launch({ channel: 'chromium', ...launchArgs }).catch(() => chromium.launch(launchArgs));
const pages = [];
const errors = [];

async function freshContext(viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport });
  await context.grantPermissions(['microphone', 'camera'], { origin: base });
  await context.addInitScript(() => {
    window.__streams = [];
    window.__displayCalls = [];
    navigator.mediaDevices.getDisplayMedia = async (options) => {
      window.__displayCalls.push(JSON.parse(JSON.stringify(options ?? {})));
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const g = canvas.getContext('2d');
      let n = 0;
      const draw = () => {
        g.fillStyle = `hsl(${(n * 9) % 360} 55% 40%)`;
        g.fillRect(0, 0, 640, 360);
        g.fillStyle = '#fff';
        g.font = '64px sans-serif';
        g.fillText(String(n++), 40, 200);
      };
      draw();
      const timer = setInterval(draw, 33);
      const stream = canvas.captureStream(30);
      if (options?.audio) {
        // Synthetic "computer sound".
        const ac = new AudioContext();
        const osc = ac.createOscillator();
        const dest = ac.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
      }
      const track = stream.getVideoTracks()[0];
      const surface = options?.video?.displaySurface ?? 'monitor';
      const real = track.getSettings.bind(track);
      track.getSettings = () => ({ ...real(), displaySurface: surface, width: 640, height: 360 });
      track.addEventListener('ended', () => clearInterval(timer));
      const stop = track.stop.bind(track);
      track.stop = () => {
        clearInterval(timer);
        stop();
      };
      window.__streams.push(stream);
      return stream;
    };
  });
  return context;
}

async function openPage(context) {
  const page = await context.newPage();
  pages.push(page);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/');
  return page;
}

/** A fresh browser profile with the Record dialog open on the editor. */
async function startSession(viewport) {
  const context = await freshContext(viewport);
  const page = await openPage(context);
  await page.getByRole('button', { name: 'Go to the editor' }).click();
  await page.waitForSelector('.media-bin');
  await openRecordDialog(page);
  return { context, page };
}

async function openRecordDialog(page) {
  await page.getByRole('region', { name: 'Media' }).getByRole('button', { name: 'Record screen' }).click();
  await page.getByRole('dialog', { name: 'Record screen' }).waitFor();
}

const box = (page, name, on) => page.getByRole('checkbox', { name }).setChecked(on);

/** Sets the dialog's options. Anything left out keeps the value it has. */
async function options(page, o) {
  if (o.surface) await page.getByRole('radio', { name: o.surface }).check();
  if (o.mic !== undefined) await box(page, 'Record my microphone', o.mic);
  if (o.system !== undefined) await box(page, /^Record computer sound/, o.system);
  if (o.separate !== undefined) await box(page, /^Record audio on separate tracks/, o.separate);
  if (o.webcam !== undefined) await box(page, 'Record my webcam on its own track', o.webcam);
  if (o.pip !== undefined) await box(page, /^Show it as a small picture/, o.pip);
  if (o.region !== undefined) await box(page, /^Select a region first/, o.region);
  if (o.disk !== undefined) await box(page, /^Save to disk while recording/, o.disk);
  if (o.countdown !== undefined) await page.getByLabel('Countdown').selectOption(String(o.countdown));
  if (o.max !== undefined) await page.getByLabel(/^Maximum length/).fill(String(o.max));
}

const recordingNow = (page, timeout = 15000) =>
  page
    .waitForSelector('.rec-status.recording', { timeout })
    .then(() => true)
    .catch(() => false);

/** The saved project, read back from IndexedDB once `ready(project)` holds. */
async function savedProject(page, ready = () => true, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const open = indexedDB.open('capstan');
          open.onerror = () => resolve(null);
          open.onsuccess = () => {
            const db = open.result;
            const t = db.transaction(['meta', 'projects']);
            const id = t.objectStore('meta').get('lastProjectId');
            id.onsuccess = () => {
              const q = id.result ? t.objectStore('projects').get(id.result) : null;
              if (!q) return resolve(null);
              q.onsuccess = () => resolve(q.result ?? null);
            };
          };
        }),
    );
    if (last && ready(last)) return last;
    await page.waitForTimeout(250);
  }
  return last;
}

/** Files in the recordings folder of the browser's private file system. */
const opfs = (page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    let dir;
    try {
      dir = await root.getDirectoryHandle('capstan-recordings');
    } catch {
      return { names: [], bytes: 0 };
    }
    const names = [];
    let bytes = 0;
    for await (const [name, handle] of dir.entries()) {
      names.push(name);
      if (!name.endsWith('.json')) bytes += (await handle.getFile()).size;
    }
    return { names: names.sort(), bytes };
  });

const mediaNames = (page) => page.locator('.bin-name').allTextContents();

// ====================================================================================
// 1. Webcam on its own track, picture-in-picture
// ====================================================================================
{
  const { context, page } = await startSession();
  await options(page, { surface: 'A window', mic: false, system: false, webcam: true, countdown: 0 });
  check('camera list offers the default camera and the fake device', (await page.getByLabel('Camera').locator('option').count()) >= 1);
  await page.getByLabel('Resolution').selectOption('480');
  await page.getByRole('button', { name: 'Start recording' }).click();
  const started = await recordingNow(page);
  check('webcam: recording starts', started, started ? '' : await page.locator('.modal .error').textContent().catch(() => ''));
  if (started) {
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Stop and save' }).click();
    await page.waitForSelector('.clip', { timeout: 20000 });
    const p = await savedProject(page, (pr) => pr.clips.length >= 2);
    check('webcam: two media items', p.media.length === 2, JSON.stringify(p.media.map((m) => m.name)));
    check('webcam: two clips on two tracks', p.clips.length === 2 && new Set(p.clips.map((c) => c.trackId)).size === 2);
    const cam = p.media.find((m) => m.name.startsWith('Webcam '));
    const screen = p.media.find((m) => m.name.startsWith('Recording '));
    check('webcam: files named Webcam … and Recording …', !!cam && !!screen);
    check('webcam: the webcam is a video item with a picture size', cam?.kind === 'video' && cam.width > 0 && cam.height > 0, cam ? `${cam.width}x${cam.height}` : '');
    const camClip = p.clips.find((c) => c.mediaId === cam?.id);
    const screenClip = p.clips.find((c) => c.mediaId === screen?.id);
    check('webcam: both clips start together', camClip && screenClip && Math.abs(camClip.start - screenClip.start) < 1e-6);
    const order = (c) => p.tracks.findIndex((t) => t.id === c.trackId);
    check('webcam: its track is above the screen track', order(camClip) > order(screenClip));
    check('webcam: its track is named', p.tracks.find((t) => t.id === camClip.trackId)?.name === 'Webcam');
    check('webcam: picture-in-picture at 0.25 in the lower right', camClip.props.scale === 0.25 && camClip.props.x > p.width / 2 && camClip.props.y > p.height / 2, JSON.stringify(camClip.props));
    check('webcam: the screen clip is untouched (full frame, no crop)', screenClip.props.scale === 1 && !screenClip.crop);
    check('webcam: both lengths match', Math.abs(camClip.duration - screenClip.duration) < 0.3, `${camClip.duration} vs ${screenClip.duration}`);
  }
  await context.close();
}

// Without picture-in-picture the webcam stays full frame on its own track.
{
  const { context, page } = await startSession();
  await options(page, { surface: 'A window', mic: false, system: false, webcam: true, pip: false, countdown: 0 });
  await page.getByRole('button', { name: 'Start recording' }).click();
  if (await recordingNow(page)) {
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Stop and save' }).click();
    await page.waitForSelector('.clip', { timeout: 20000 });
    const p = await savedProject(page, (pr) => pr.clips.length >= 2);
    const cam = p.media.find((m) => m.name.startsWith('Webcam '));
    const camClip = p.clips.find((c) => c.mediaId === cam?.id);
    check('webcam without picture-in-picture: full frame on its own track', camClip?.props.scale === 1 && new Set(p.clips.map((c) => c.trackId)).size === 2);
  } else check('webcam without picture-in-picture: recording starts', false);
  await context.close();
}

// ====================================================================================
// 2. Separate mic / system audio tracks
// ====================================================================================
{
  const { context, page } = await startSession();
  await options(page, { surface: 'A window', mic: true, system: true, separate: true, countdown: 0 });
  await page.getByRole('button', { name: 'Start recording' }).click();
  const started = await recordingNow(page);
  check('separate audio: recording starts', started, started ? '' : await page.locator('.modal .error').textContent().catch(() => ''));
  if (started) {
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Stop and save' }).click();
    await page.waitForSelector('.clip', { timeout: 20000 });
    const p = await savedProject(page, (pr) => pr.clips.length >= 3);
    check('separate audio: three media items', p.media.length === 3, JSON.stringify(p.media.map((m) => m.name)));
    const mic = p.media.find((m) => m.name.startsWith('Microphone '));
    const sys = p.media.find((m) => m.name.startsWith('System audio '));
    const screen = p.media.find((m) => m.name.startsWith('Recording '));
    check('separate audio: microphone and system audio are audio items', mic?.kind === 'audio' && sys?.kind === 'audio');
    check('separate audio: the screen item is video', screen?.kind === 'video');
    check('separate audio: three clips on three tracks from the same moment', p.clips.length === 3 && new Set(p.clips.map((c) => c.trackId)).size === 3 && new Set(p.clips.map((c) => c.start.toFixed(4))).size === 1);
    const trackNames = p.clips.map((c) => p.tracks.find((t) => t.id === c.trackId)?.name);
    check('separate audio: tracks are named', trackNames.includes('Microphone') && trackNames.includes('System audio'), trackNames.join(', '));
    check('separate audio: audio items have a real length', mic?.duration > 1.5 && sys?.duration > 1.5, `${mic?.duration} ${sys?.duration}`);
  }
  await context.close();
}

// Mixed (the default) stays one item; separate with only a microphone gives two.
{
  const { context, page } = await startSession();
  await options(page, { surface: 'A window', mic: true, system: true, separate: false, countdown: 0 });
  await page.getByRole('button', { name: 'Start recording' }).click();
  if (await recordingNow(page)) {
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Stop and save' }).click();
    await page.waitForSelector('.clip', { timeout: 20000 });
    const p = await savedProject(page, (pr) => pr.clips.length >= 1);
    check('mixed audio (default): one media item and one clip', p.media.length === 1 && p.clips.length === 1);
  } else check('mixed audio: recording starts', false);
  await context.close();
}
{
  const { context, page } = await startSession();
  await options(page, { surface: 'A window', mic: true, system: false, separate: true, countdown: 0 });
  await page.getByRole('button', { name: 'Start recording' }).click();
  if (await recordingNow(page)) {
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Stop and save' }).click();
    await page.waitForSelector('.clip', { timeout: 20000 });
    const p = await savedProject(page, (pr) => pr.clips.length >= 2);
    check('separate audio with only a microphone: two items', p.media.length === 2 && p.clips.length === 2, JSON.stringify(p.media.map((m) => m.name)));
  } else check('separate audio (mic only): recording starts', false);
  await context.close();
}

// ====================================================================================
// 3. Countdown, cancel, maximum length
// ====================================================================================
{
  const { context, page } = await startSession();
  await options(page, { surface: 'A window', mic: false, system: false, countdown: 3 });
  await page.evaluate(() => {
    window.__counts = [];
    new MutationObserver(() => {
      const el = document.querySelector('.countdown-number');
      if (el && window.__counts.at(-1) !== el.textContent) window.__counts.push(el.textContent);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.waitForSelector('.countdown-number', { timeout: 8000 });
  check('countdown: the overlay is announced as a timer', (await page.getByRole('timer').count()) === 1);
  const started = await recordingNow(page, 10000);
  const took = (Date.now() - t0) / 1000;
  check('countdown: recording starts after about 3 s', started && took > 2.8 && took < 6, `${took.toFixed(2)} s`);
  const counts = await page.evaluate(() => window.__counts);
  check('countdown: shows 3, 2, 1 in order', counts.slice(0, 3).join(',') === '3,2,1', counts.join(','));
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Stop and save' }).click();
  await page.waitForSelector('.clip', { timeout: 20000 });
  await context.close();
}
{
  // Cancel during the countdown: nothing recorded, the shared screen is released.
  const { context, page } = await startSession();
  await options(page, { surface: 'A window', mic: false, system: false, countdown: 5 });
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.waitForSelector('.countdown-number', { timeout: 8000 });
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Start recording' }).waitFor({ timeout: 3000 });
  check('countdown cancel: back to setup, nothing recording', (await page.locator('.rec-status').count()) === 0);
  const ended = await page.evaluate(() => window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')));
  check('countdown cancel: the shared screen is released', ended);
  await page.waitForTimeout(500);
  check('countdown cancel: no recording started later', (await page.locator('.rec-status').count()) === 0 && (await page.locator('.clip').count()) === 0);
  // Esc cancels too.
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.waitForSelector('.countdown-number', { timeout: 8000 });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Start recording' }).waitFor({ timeout: 3000 });
  check('countdown cancel: Esc backs out too', (await page.locator('.rec-status').count()) === 0);
  await context.close();
}
{
  // Maximum length: 0.1 minute = 6 s. A warning shows, then it stops and saves by itself.
  const { context, page } = await startSession();
  await options(page, { surface: 'A window', mic: false, system: false, countdown: 0, max: '0.1' });
  await page.getByRole('button', { name: 'Start recording' }).click();
  const started = await recordingNow(page);
  const t0 = Date.now();
  let warned = false;
  if (started) {
    warned = await page
      .waitForSelector('.record-warning', { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
  }
  const warnedAt = (Date.now() - t0) / 1000;
  check('max length: a warning shows shortly before the limit', warned && warnedAt > 2 && warnedAt < 5.5, `${warnedAt.toFixed(1)} s`);
  const warning = warned ? await page.locator('.record-warning').textContent() : '';
  check('max length: the warning says how long is left', /stops and saves in \d+ s/.test(warning ?? ''), warning ?? '');
  const saved = await page
    .waitForSelector('.clip', { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  const total = (Date.now() - t0) / 1000;
  check('max length: it stops and saves by itself', saved && total > 5 && total < 12, `${total.toFixed(1)} s`);
  if (saved) {
    const p = await savedProject(page, (pr) => pr.clips.length >= 1);
    const d = p.clips[0].duration;
    check('max length: the clip is about the limit long', d > 5 && d < 8, `${d.toFixed(2)} s`);
  }
  check('max length: the dialog closed', (await page.getByRole('dialog', { name: 'Record screen' }).count()) === 0);
  await context.close();
}

// ====================================================================================
// 4. Recording to disk (OPFS) and crash recovery
// ====================================================================================
{
  const { context, page } = await startSession();
  await options(page, { surface: 'A window', mic: false, system: false, countdown: 0, disk: true });
  await page.getByRole('button', { name: 'Start recording' }).click();
  const started = await recordingNow(page);
  check('disk: recording starts', started);
  if (started) {
    await page.waitForTimeout(3200);
    const a = await opfs(page);
    await page.waitForTimeout(2500);
    const b = await opfs(page);
    check('disk: chunks are on disk while still recording', a.bytes > 0, `${a.bytes} bytes`);
    check('disk: the files keep growing before Stop', b.bytes > a.bytes, `${a.bytes} -> ${b.bytes}`);
    check('disk: a manifest and segment files exist', b.names.some((n) => n.endsWith('.manifest.json')) && b.names.some((n) => /\.screen\.\d{6}\.(webm|mp4)$/.test(n)), b.names.slice(0, 3).join(' '));
    const status = await page.getByTestId('disk-status').textContent();
    check('disk: the dialog shows the bytes saved', /saved/.test(status ?? ''), status ?? '');
    await page.getByRole('button', { name: 'Stop and save' }).click();
    await page.waitForSelector('.clip', { timeout: 20000 });
    const p = await savedProject(page, (pr) => pr.clips.length >= 1);
    const item = p.media[0];
    check('disk: the recording imports from disk with the right length', item && item.duration > 4 && item.duration < 8, item ? `${item.duration.toFixed(2)} s, ${item.bytes} bytes` : '');
    check('disk: the imported file is as large as what was written', item.bytes >= b.bytes * 0.9, `${item.bytes} vs ${b.bytes}`);
    // After import the footage is only kept until the next start; then it is swept.
    await page.reload();
    await page.waitForSelector('.media-bin');
    await page.waitForTimeout(1200);
    const after = await opfs(page);
    check('disk: imported footage is cleaned up at the next start', after.names.length === 0, after.names.join(' '));
    check('disk: nothing to recover after a clean recording', (await page.getByRole('dialog', { name: 'Recover recordings' }).count()) === 0);
  }
  await context.close();
}
{
  // Crash: the window closes mid-recording. The next start offers the footage.
  const context = await freshContext();
  const first = await openPage(context);
  await first.getByRole('button', { name: 'Go to the editor' }).click();
  await first.waitForSelector('.media-bin');
  await openRecordDialog(first);
  await options(first, { surface: 'A window', mic: false, system: false, countdown: 0, disk: true });
  await first.getByRole('button', { name: 'Start recording' }).click();
  const started = await recordingNow(first);
  check('recovery: recording starts', started);
  if (started) {
    await first.waitForTimeout(4200);
    const written = await opfs(first);
    check('recovery: footage is on disk before the "crash"', written.bytes > 0, `${written.bytes} bytes`);
    await first.close();

    const second = await openPage(context);
    const dialog = second.getByRole('dialog', { name: 'Recover recordings' });
    const shown = await dialog
      .waitFor({ timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    check('recovery: the leftover recording is offered at startup', shown);
    if (shown) {
      const text = (await dialog.textContent()) ?? '';
      check('recovery: it says the recording was interrupted and how big it is', /Interrupted/.test(text) && /MB/.test(text), text.slice(0, 200));
      await dialog.getByRole('button', { name: /^Import Recording/ }).click();
      await second.waitForSelector('.clip', { timeout: 20000 });
      const p = await savedProject(second, (pr) => pr.clips.length >= 1);
      check('recovery: Import puts the footage in the project and on the timeline', p.media.length === 1 && p.clips.length === 1 && p.media[0].duration > 1, p.media[0] ? `${p.media[0].duration.toFixed(2)} s` : '');
      check('recovery: the offer is gone after importing', (await dialog.count()) === 0);
    }
    // Second crash: discard this time.
    await openRecordDialog(second);
    await options(second, { surface: 'A window', mic: false, system: false, countdown: 0, disk: true });
    await second.getByRole('button', { name: 'Start recording' }).click();
    if (await recordingNow(second)) {
      await second.waitForTimeout(4200);
      await second.close();
      const third = await openPage(context);
      const d2 = third.getByRole('dialog', { name: 'Recover recordings' });
      const again = await d2
        .waitFor({ timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      check('recovery: a second leftover is offered', again);
      if (again) {
        await d2.getByRole('button', { name: /^Discard Recording/ }).click();
        await third.waitForTimeout(500);
        check('recovery: Discard removes it', (await d2.count()) === 0);
        const left = await opfs(third);
        check('recovery: Discard deletes the files from disk', left.names.every((n) => !/\.screen\./.test(n)), left.names.join(' '));
      }
    } else check('recovery: second recording starts', false);
  }
  await context.close();
}
{
  // No OPFS: the recording still works, held in memory.
  const context = await freshContext();
  await context.addInitScript(() => {
    Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined, configurable: true });
  });
  const page = await openPage(context);
  await page.getByRole('button', { name: 'Go to the editor' }).click();
  await page.waitForSelector('.media-bin');
  await openRecordDialog(page);
  await options(page, { surface: 'A window', mic: false, system: false, countdown: 0, disk: true });
  await page.getByRole('button', { name: 'Start recording' }).click();
  if (await recordingNow(page)) {
    await page.waitForTimeout(1500);
    check('no OPFS: no disk readout', (await page.getByTestId('disk-status').count()) === 0);
    await page.getByRole('button', { name: 'Stop and save' }).click();
    const ok = await page
      .waitForSelector('.clip', { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check('no OPFS: falls back to memory and still records', ok);
  } else check('no OPFS: recording starts', false, await page.locator('.modal .error').textContent().catch(() => ''));
  await context.close();
}

// ====================================================================================
// 5. Region selection
// ====================================================================================
{
  const { context, page } = await startSession();
  await options(page, { surface: 'A window', mic: false, system: false, countdown: 0, region: true });
  await page.getByRole('button', { name: 'Start recording' }).click();
  const step = await page
    .getByRole('heading', { name: 'Select region' })
    .waitFor({ timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check('region: the select-region step opens with the shared screen', step);
  if (step) {
    const still = page.getByRole('img', { name: 'Frame from the shared screen' });
    check('region: a still frame is shown', (await still.count()) === 1 && (await still.evaluate((i) => i.naturalWidth)) > 0);
    check('region: nothing is recording yet', (await page.locator('.rec-status').count()) === 0);
    const field = (name) => page.getByLabel(`${name} (px)`);
    check('region: starts as the whole screen', (await field('Width').inputValue()) === '640' && (await field('Height').inputValue()) === '360');

    // Numeric fields.
    await field('Width').fill('320');
    await field('Height').fill('180');
    await field('Left').fill('160');
    await field('Top').fill('90');
    check('region: numeric fields set the rectangle', (await field('Left').inputValue()) === '160' && (await field('Width').inputValue()) === '320');

    // Dragging the rectangle moves it; dragging a handle resizes it.
    const rect = page.getByRole('group', { name: /^Region:/ });
    const rb = await rect.boundingBox();
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(rb.x + rb.width / 2 + 40, rb.y + rb.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
    const movedLeft = Number(await field('Left').inputValue());
    const movedTop = Number(await field('Top').inputValue());
    check('region: dragging the rectangle moves it', movedLeft > 160 && movedTop > 90 && (await field('Width').inputValue()) === '320', `${movedLeft}, ${movedTop}`);
    const rb2 = await rect.boundingBox();
    const handle = rect.locator('[data-handle="se"]');
    const hb = await handle.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + 30, hb.y + hb.height / 2 + 20, { steps: 5 });
    await page.mouse.up();
    const rb3 = await rect.boundingBox();
    check('region: dragging a handle resizes it', rb3.width > rb2.width + 10 && rb3.x === rb2.x, `${rb2.width} -> ${rb3.width}`);

    // Aspect presets keep the shape.
    await page.getByLabel('Shape').selectOption('4:3');
    const w = Number(await field('Width').inputValue());
    const h = Number(await field('Height').inputValue());
    check('region: the 4:3 preset reshapes the rectangle', Math.abs(w / h - 4 / 3) < 0.03, `${w}x${h}`);
    await page.getByLabel('Shape').selectOption('canvas');
    const w2 = Number(await field('Width').inputValue());
    const h2 = Number(await field('Height').inputValue());
    check('region: the project-canvas preset matches 16:9', Math.abs(w2 / h2 - 16 / 9) < 0.03, `${w2}x${h2}`);
    // Typing a width keeps the locked shape.
    await field('Width').fill('400');
    check('region: a locked shape follows the typed width', Math.abs(Number(await field('Height').inputValue()) - 225) <= 1);

    // Final exact region: free shape, a quarter of the frame.
    await page.getByLabel('Shape').selectOption('free');
    await field('Left').fill('0');
    await field('Top').fill('0');
    await field('Width').fill('320');
    await field('Height').fill('180');
    await field('Left').fill('160');
    await field('Top').fill('90');
    await page.getByRole('button', { name: 'Use region and record' }).click();
    const started = await recordingNow(page);
    check('region: recording starts after the region is confirmed', started);
    if (started) {
      await page.waitForTimeout(1800);
      await page.getByRole('button', { name: 'Stop and save' }).click();
      await page.waitForSelector('.clip', { timeout: 20000 });
      const p = await savedProject(page, (pr) => pr.clips.length >= 1);
      const clip = p.clips[0];
      const media = p.media[0];
      const near = (a, b) => Math.abs(a - b) < 0.002;
      check(
        'region: the clip is cropped to the expected fractions',
        clip.crop && near(clip.crop.x, 0.25) && near(clip.crop.y, 0.25) && near(clip.crop.width, 0.5) && near(clip.crop.height, 0.5),
        JSON.stringify(clip.crop),
      );
      check('region: the media keeps the full frame', media.width === 640 && media.height === 360, `${media.width}x${media.height}`);
      check('region: the cropped picture fills the canvas (16:9 at scale 1)', clip.props.scale === 1 && clip.props.x === p.width / 2 && clip.props.y === p.height / 2);
    }
  }
  await context.close();
}
{
  // Cancelling the region step releases the screen; sharing ended during it returns to setup.
  const { context, page } = await startSession();
  await options(page, { surface: 'A window', mic: false, system: false, countdown: 0, region: true });
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('heading', { name: 'Select region' }).waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Start recording' }).waitFor({ timeout: 3000 });
  check('region: Esc cancels and releases the screen', await page.evaluate(() => window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))));
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('heading', { name: 'Select region' }).waitFor({ timeout: 10000 });
  await page.evaluate(() => window.__streams.at(-1).getVideoTracks()[0].dispatchEvent(new Event('ended')));
  const back = await page
    .getByRole('button', { name: 'Start recording' })
    .waitFor({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  check('region: sharing ended during the step returns to setup with a message', back && /sharing ended/.test((await page.locator('.modal .error').textContent().catch(() => '')) ?? ''));
  await context.close();
}

// ====================================================================================
// 6. Small windows
// ====================================================================================
{
  const { context, page } = await startSession({ width: 1000, height: 480 });
  await options(page, { webcam: true });
  const start = await page.getByRole('button', { name: 'Start recording' }).boundingBox();
  const dialog = await page.getByRole('dialog', { name: 'Record screen' }).boundingBox();
  check('small height: the dialog fits the window', dialog.y >= 0 && dialog.y + dialog.height <= 480, `${dialog.y}..${dialog.y + dialog.height}`);
  check('small height: Start recording stays on screen', start.y >= 0 && start.y + start.height <= 480, `${start.y + start.height}`);
  const scrolls = await page.locator('.record-body').evaluate((el) => el.scrollHeight > el.clientHeight);
  check('small height: the options scroll inside the dialog', scrolls);
  await context.close();
}

// ====================================================================================
// 7. Pointer hiding is off by default and asked for on request
// ====================================================================================
{
  const { context, page } = await startSession();
  await options(page, { surface: 'A window', mic: false, system: false, countdown: 0 });
  await page.getByRole('button', { name: 'Start recording' }).click();
  if (await recordingNow(page)) {
    const calls = await page.evaluate(() => window.__displayCalls);
    check('cursor: not requested by default', calls.at(-1)?.video?.cursor === undefined, JSON.stringify(calls.at(-1)?.video));
    await page.getByRole('button', { name: 'Stop and save' }).click();
    await page.waitForSelector('.clip', { timeout: 20000 });
  } else check('cursor: recording starts', false);
  await openRecordDialog(page);
  await box(page, /^Hide the mouse pointer/, true);
  await page.getByRole('button', { name: 'Start recording' }).click();
  if (await recordingNow(page)) {
    const calls = await page.evaluate(() => window.__displayCalls);
    check("cursor: 'never' is requested when the pointer is hidden", calls.at(-1)?.video?.cursor === 'never', JSON.stringify(calls.at(-1)?.video));
    await page.getByRole('button', { name: 'Stop and save' }).click();
    await page.waitForSelector('.rec-status', { state: 'detached', timeout: 20000 });
  } else check('cursor: second recording starts', false);
  await context.close();
}

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll recording-source checks passed');
process.exit(failures ? 1 : 0);
