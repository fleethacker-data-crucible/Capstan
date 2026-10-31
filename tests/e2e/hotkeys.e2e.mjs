// Global hotkeys through the real UI, with SYNTHETIC input only: no real key is registered or pressed and no tray icon
// exists. This test starts its own copy of tests/serve.mjs with CAPSTAN_TEST_HOTKEYS=1 (the mirror of the host's test
// seam) and injects the events a hotkey press would queue through POST /api/hotkeys/test-inject. The recorder is the
// synthetic getDisplayMedia stub from record.e2e.mjs; no fake-UI flag, so the real desktop is never shared.
// Usage: node tests/e2e/hotkeys.e2e.mjs   (or via run-all.mjs hotkeys)
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = await new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['tests/serve.mjs', String(port)], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, CAPSTAN_TEST_HOTKEYS: '1' } });
process.on('exit', () => server.kill());
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(100);
}

const api = async (path, init = {}) => {
  const res = await fetch(base + path, { ...init, headers: { 'X-Capstan-Token': 'test-token', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const inject = (event) => api('/api/hotkeys/test-inject', { method: 'POST', body: JSON.stringify({ event }) });

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.grantPermissions(['microphone'], { origin: base });
await context.addInitScript(() => {
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
let eventRequests = 0;
page.on('request', (r) => {
  if (r.url().includes('/api/hotkeys/events')) eventRequests++;
});

await page.goto(base + '/');
await page.getByRole('button', { name: 'Go to the editor' }).click();
await page.waitForSelector('.media-bin');
const media = page.getByRole('region', { name: 'Media' });
const openRecord = async () => {
  await media.getByRole('button', { name: 'Record screen' }).click();
  await page.getByRole('dialog', { name: 'Record screen' }).waitFor();
};
const closeRecord = async () => {
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
};
const rowState = (action) => page.locator(`[data-testid="hotkey-state-${action}"]`).textContent();

// ---- the Hotkeys group ----
await openRecord();
const panel = page.locator('.hotkeys-panel');
await panel.waitFor();
await page.locator('[data-testid="hotkey-state-start-stop"]').waitFor();
check('three hotkey rows, one per action', (await panel.locator('.hotkey-row').count()) === 3);
check('default keys: Ctrl+Shift+F9 is the start or stop key', (await page.getByRole('combobox', { name: 'Start or stop recording key' }).inputValue()) === 'F9');
check('every key reports its state', /Simulated|Active/.test(await rowState('start-stop')), await rowState('start-stop'));
const text = await panel.textContent();
check('the UI says plainly that the share picker is still needed', /still needs the browser.s share picker/.test(text ?? ''), text?.slice(0, 120));
check('the UI explains how to keep Capstan out of the shot', /record a browser tab or a single window/.test(text ?? ''));
check('the "not in the shot" help names the real limit', /Windows only lets a program hide windows that belong to that program/.test(text ?? ''));
check('test mode is announced', /Test mode/.test(text ?? ''));
await closeRecord();

// ---- a key another program holds is reported per key, not fatally ----
const clash = await api('/api/hotkeys/test-inject', { method: 'POST', body: JSON.stringify({ clash: 'Ctrl+Shift+F11' }) });
check('the host reports one failed key and two registered', clash.json?.failed?.length === 1 && clash.json?.registered?.length === 2, JSON.stringify(clash.json?.failed));
await openRecord();
await page.locator('[data-testid="hotkey-state-marker"]').waitFor();
await page.waitForFunction(() => /Not active/.test(document.querySelector('[data-testid="hotkey-state-marker"]')?.textContent ?? ''));
const bad = await rowState('marker');
check('the taken key says another program uses it', /Not active: Another program already uses this key combination/.test(bad), bad);
check('the other keys still show as active', /Simulated|Active/.test(await rowState('start-stop')) && /Simulated|Active/.test(await rowState('pause-resume')));

// ---- change a binding: invalid is refused in the UI, valid is applied ----
const markerRow = page.getByRole('group', { name: 'Add a marker hotkey' });
await markerRow.getByRole('checkbox', { name: 'Ctrl' }).uncheck();
await markerRow.getByRole('checkbox', { name: 'Shift' }).uncheck();
await page.getByRole('combobox', { name: 'Add a marker key' }).selectOption('M');
check('a draft without Ctrl or Alt is marked as not applied', /Not applied yet/.test(await rowState('marker')));
await page.getByRole('button', { name: 'Apply hotkeys' }).click();
await page.waitForFunction(() => /Include Ctrl or Alt/.test(document.querySelector('[data-testid="hotkey-state-marker"]')?.textContent ?? ''));
check('a binding without Ctrl or Alt is refused with the reason', true);
check('nothing was sent to the host for it', (await api('/api/hotkeys/status')).json.bindings.marker === 'Ctrl+Shift+F11');
await markerRow.getByRole('checkbox', { name: 'Ctrl' }).check();
await markerRow.getByRole('checkbox', { name: 'Alt' }).check();
await page.getByRole('button', { name: 'Apply hotkeys' }).click();
await page.waitForFunction(() => /Hotkeys updated/.test(document.querySelector('[data-testid="hotkey-message"]')?.textContent ?? ''));
check('a valid binding is applied by the host', (await api('/api/hotkeys/status')).json.bindings.marker === 'Ctrl+Alt+M');
check('and shows as active', /Simulated|Active/.test(await rowState('marker')), await rowState('marker'));
const remembered = await page.evaluate(() => window.localStorage.getItem('capstan-hotkeys'));
check('the choice is remembered in this browser', remembered?.includes('Ctrl+Alt+M') === true, remembered ?? '');
check('the host rejects a free-form binding sent directly', (await api('/api/hotkeys/config', { method: 'PUT', body: JSON.stringify({ bindings: { marker: 'Ctrl+Alt+Win+M; calc' } }) })).status === 400);
await closeRecord();

// ---- idle, no click in Capstan: the start key cannot open the browser's picker, and says so ----
await page.waitForFunction(() => !navigator.userActivation.isActive, null, { timeout: 15000 });
await inject('start-stop');
// No Playwright call in between: its own evaluations count as user activation in the page and would hide what this checks.
await sleep(1500);
await page.getByRole('dialog', { name: 'Record screen' }).waitFor({ timeout: 5000 });
const needClick = await page.locator('.modal .error').textContent({ timeout: 5000 }).catch(() => '');
check('start key with no recent click opens the dialog and explains the click', /only after a click inside Capstan/.test(needClick ?? ''), needClick ?? '');
check('no screen was requested without a click', (await page.evaluate(() => window.__displayCalls.length)) === 0);
check('nothing is recording', (await page.locator('.rec-status').count()) === 0);

// ---- share first, then start, mark, pause, resume and stop with the keys ----
await page.locator('#rec-countdown').selectOption('0');
await page.getByRole('radio', { name: 'A browser tab' }).check();
await page.getByRole('checkbox', { name: 'Choose what to share now, then start with the hotkey' }).check();
await page.getByRole('button', { name: 'Start recording' }).click();
await page.waitForSelector('.rec-status.armed', { timeout: 8000 });
check('the browser picker was used once and the dialog is armed', (await page.evaluate(() => window.__displayCalls.length)) === 1);
check('armed, nothing is recording yet', (await page.locator('.rec-status.recording').count()) === 0);
check('armed step names the start key', /Ctrl\+Shift\+F9/.test((await page.locator('.modal-text').first().textContent()) ?? ''));
const state1 = (await api('/api/hotkeys/status')).json.state;
check('the tray state is idle while armed', state1 === 'idle', state1);

await inject('start-stop');
await page.waitForSelector('.rec-status.recording', { timeout: 8000 });
check('the start key starts the armed recording', true);
check('the tray state follows the recorder: recording', await page.waitForFunction(async () => (await (await fetch('/api/hotkeys/status', { headers: { 'X-Capstan-Token': document.querySelector('meta[name="capstan-session"]').content } })).json()).state === 'recording', null, { timeout: 5000 }).then(() => true, () => false));
check('the dialog lists what each key does', /Ctrl\+Shift\+F9 stops/.test((await page.locator('.record-meta').first().textContent()) ?? ''));

// While recording, the window is "hidden": the keys must still work, because polling goes on during a recording.
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});
await sleep(1400);
await inject('marker');
await page.locator('[data-testid="marker-flash"]').waitFor({ timeout: 5000 });
check('a marker key press while Capstan is hidden is still received', /Marker 1 added/.test((await page.locator('[data-testid="marker-flash"]').textContent()) ?? ''));
await sleep(1000);
await inject('marker');
await page.waitForFunction(() => /Marker 2 added/.test(document.querySelector('[data-testid="marker-flash"]')?.textContent ?? ''), null, { timeout: 5000 });
check('a second marker is added later in the recording', true);
await inject('marker'); // a double tap is one marker
await sleep(150);
check('a repeat within a quarter second is ignored', /Marker 2 added/.test((await page.locator('[data-testid="marker-flash"]').textContent()) ?? ''));
await inject('pause-resume');
await page.waitForSelector('.rec-status.paused', { timeout: 5000 });
check('the pause key pauses', true);
const paused = (await api('/api/hotkeys/status')).json.state;
await sleep(700);
await inject('pause-resume');
await page.waitForSelector('.rec-status.recording', { timeout: 5000 });
check('the tray state said paused while paused', paused === 'paused', paused);
await sleep(700);
await inject('start-stop');
await page.waitForSelector('.clip', { timeout: 20000 });
check('the start/stop key stops and saves: the recording is on the timeline', (await page.locator('.clip').count()) === 1);
await page.evaluate(() => {
  delete document.visibilityState;
  document.dispatchEvent(new Event('visibilitychange'));
});
const dur = await page.locator('.timecode .total').textContent();
const [, , s, f] = dur.split(/[:;]/).map(Number);
const seconds = s + f / 30;
check('recorded length excludes the pause', seconds > 2.6 && seconds < 5, dur);
check('two marker flags landed on the ruler', (await page.locator('.marker-flag').count()) === 2);
const clipBox = await page.locator('.clip').first().boundingBox();
const flagBoxes = [];
for (const i of [0, 1]) flagBoxes.push(await page.locator('.marker-flag').nth(i).boundingBox());
const r1 = (flagBoxes[0].x - clipBox.x) / clipBox.width;
const r2 = (flagBoxes[1].x - clipBox.x) / clipBox.width;
check('the first marker sits about 1.4 s into the recording', Math.abs(r1 * seconds - 1.4) < 0.7, `${(r1 * seconds).toFixed(2)} s`);
check('the second marker sits about 1 s after the first', Math.abs((r2 - r1) * seconds - 1.0) < 0.5, `${((r2 - r1) * seconds).toFixed(2)} s apart`);
check('the markers are inside the recording', r1 > 0 && r2 < 1.02);
check('the tray state is idle again', (await api('/api/hotkeys/status')).json.state === 'idle');
check('the markers are named in order', (await page.locator('.marker-flag .marker-label').allTextContents()).join(',') === 'Marker 1,Marker 2', (await page.locator('.marker-flag .marker-label').allTextContents()).join(','));

// ---- hidden and idle: the page stops polling, then picks up again ----
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});
await sleep(400);
const before = eventRequests;
await inject('marker'); // pressed while Capstan is hidden and idle
await sleep(1200);
check('a hidden idle page makes no hotkey requests', eventRequests === before, `${eventRequests - before} new`);
await page.evaluate(() => {
  delete document.visibilityState;
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForFunction(() => document.visibilityState === 'visible');
await sleep(800);
check('it polls again when shown', eventRequests > before);
check('and the press made while hidden is not replayed', (await page.locator('.marker-flag').count()) === 2);

// ---- idle with a fresh click: the start key starts with the last used settings ----
const callsBefore = await page.evaluate(() => window.__displayCalls.length);
await page.mouse.click(5, 5);
await inject('start-stop');
// The last used settings include "share first, then start with the hotkey", so the key opens the picker and arms.
await page.waitForSelector('.rec-status.armed', { timeout: 8000 });
const lastAsk = await page.evaluate(() => window.__displayCalls.at(-1));
check('the start key opened the dialog and asked for the screen once', (await page.evaluate(() => window.__displayCalls.length)) === callsBefore + 1);
check('with the last used settings (a browser tab)', lastAsk?.video?.displaySurface === 'browser', JSON.stringify(lastAsk?.video?.displaySurface));
await inject('start-stop');
await page.waitForSelector('.rec-status.recording', { timeout: 8000 });
await sleep(900);
await inject('start-stop');
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 2, null, { timeout: 20000 });
check('the same key stops it and the second recording is saved', true);
check('a marker pressed with nothing recording is added at the playhead by the editor', await (async () => {
  const n = await page.locator('.marker-flag').count();
  await inject('marker');
  await page.waitForFunction((c) => document.querySelectorAll('.marker-flag').length === c + 1, n, { timeout: 5000 }).catch(() => {});
  return (await page.locator('.marker-flag').count()) === n + 1;
})());

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll hotkey checks passed');
process.exit(failures ? 1 : 0);
