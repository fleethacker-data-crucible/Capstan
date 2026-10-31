// Cursor capture from the page's side: clock alignment, bounds, the host client (with a fake fetch, no
// network and no real input), and the recording-flow settings. The host itself is covered by
// tests/ps/CursorCapture.Tests.ps1.
import { expect, test } from 'bun:test';
import { CURSOR_LIMITS, type CursorData, parseSidecar } from '../../src/engine/cursor';
import {
  CursorCapture,
  CursorHostError,
  HOST_MISSING,
  RECORDING_ID,
  alignCursor,
  clockOrigin,
  monitorBounds,
  newRecordingId,
  sidecarShift,
} from '../../src/engine/cursor-capture';
import { attachCaptured, captureLabel, captureRequest, defaultSettings, toRecordOptions } from '../../src/engine/recording-flow';
import { type MediaItem, createProject } from '../../src/engine/project';
import { syntheticSidecar } from '../helpers/cursor-host-mirror.mjs';

const DEFAULT_PROJECT_SIZE = { width: 1920, height: 1080, fps: 30 };

// ---- ids and bounds --------------------------------------------------------------------------------

test('a new recording id matches the strict pattern the host enforces', () => {
  const id = newRecordingId(new Date(2026, 9, 31, 14, 30, 12), () => 0.5);
  expect(id).toBe('rec-20261031-143012-iiiiiiii');
  expect(RECORDING_ID.test(id)).toBe(true);
  expect(RECORDING_ID.test(newRecordingId())).toBe(true);
  for (const bad of ['', '.hidden', '../x', 'a/b', 'a\\b', 'a:b', 'a b', 'x'.repeat(65), 'rec\n']) expect(RECORDING_ID.test(bad)).toBe(false);
});

test('monitor bounds are the screen in physical pixels, offset only when several screens exist', () => {
  expect(monitorBounds({ width: 1920, height: 1080 }, 1)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  expect(monitorBounds({ width: 1536, height: 864 }, 1.25)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  // A taskbar on the left moves availLeft, but that is not the monitor's origin on a single screen.
  expect(monitorBounds({ width: 1920, height: 1080, availLeft: 48 }, 1)?.x).toBe(0);
  expect(monitorBounds({ width: 1920, height: 1080, availLeft: 1920, availTop: -120, isExtended: true }, 1)).toEqual({ x: 1920, y: -120, width: 1920, height: 1080 });
  expect(monitorBounds({ width: 0, height: 1080 }, 1)).toBeNull();
  expect(monitorBounds({ width: 1920, height: 1080 }, Number.NaN)?.width).toBe(1920);
});

// ---- clock alignment -------------------------------------------------------------------------------

test('the host origin is placed at the middle of the start request, minus what the host says had elapsed', () => {
  // Sent at 1000 ms, answered at 1010 ms (10 ms round trip): the host built its answer at 1005, 0.5 ms after its origin.
  expect(clockOrigin(1000, 1010, 0.5)).toBeCloseTo(1004.5, 6);
  // A slow round trip is split evenly.
  expect(clockOrigin(1000, 1100, 0)).toBe(1050);
});

test('the shift is how much earlier the host started than the recorder, in seconds', () => {
  expect(sidecarShift(1004.5, 1054.5)).toBeCloseTo(0.05, 9);
  expect(sidecarShift(1054.5, 1004.5)).toBeCloseTo(-0.05, 9);
});

const sample = (t: number, x: number, y: number) => ({ t, x, y });

test('aligning moves times onto the recording and cuts at both ends with interpolated edges', () => {
  const data: CursorData = {
    samples: [sample(0, 0, 0), sample(0.1, 0.1, 0.2), sample(0.2, 0.2, 0.4), sample(1.0, 1, 1), sample(2.0, 1, 1)],
    clicks: [
      { t: 0.02, button: 'left', down: true },
      { t: 0.5, button: 'left', down: true },
      { t: 1.9, button: 'left', down: false },
    ],
    keys: [{ t: 0.3, key: 'Ctrl+C', down: true }],
  };
  // The host started 0.05 s before the recorder, which lasted 1.5 s.
  const a = alignCursor(data, 0.05, 1.5)!;
  expect(a.samples[0]).toEqual({ t: 0, x: expect.closeTo(0.05, 6), y: expect.closeTo(0.1, 6) });
  expect(a.samples.some((s) => s.t === 0.05 && Math.abs(s.x - 0.1) < 1e-9)).toBe(true);
  const last = a.samples[a.samples.length - 1];
  expect(last.t).toBeCloseTo(1.5, 9);
  expect(last.x).toBe(1);
  expect(a.samples.every((s, i, l) => s.t >= 0 && s.t <= 1.5 && (i === 0 || l[i - 1].t <= s.t))).toBe(true);
  // The click at 0.02 is before the recording began; the one at 1.9 is after it ended.
  expect(a.clicks.map((c) => c.t)).toEqual([0.45]);
  expect(a.keys[0].t).toBeCloseTo(0.25, 9);
});

test('a host that started after the recorder leaves the first positions at their new, later time', () => {
  const data: CursorData = { samples: [sample(0, 0.5, 0.5), sample(1, 0.6, 0.5)], clicks: [], keys: [] };
  const a = alignCursor(data, -0.2, 5)!;
  expect(a.samples.map((s) => s.t)).toEqual([0.2, 1.2]);
});

test('aligning returns null when nothing is left, and keeps everything for an unknown length', () => {
  expect(alignCursor({ samples: [sample(3, 0.5, 0.5)], clicks: [], keys: [] }, 0, 1)).toBeNull();
  expect(alignCursor({ samples: [sample(3, 0.5, 0.5)], clicks: [], keys: [] }, 0, Number.NaN)?.samples.length).toBe(1);
});

test('the synthetic host data is a valid version-1 file within the limits', () => {
  const data = parseSidecar(JSON.stringify(syntheticSidecar(2, true)));
  expect(data.samples.length).toBe(121);
  expect(data.clicks.filter((c) => c.down).length).toBe(2);
  expect(data.keys.map((k) => k.key)).toEqual(['Ctrl+C', 'Ctrl+C']);
  expect(data.samples.length).toBeLessThanOrEqual(CURSOR_LIMITS.samples);
  expect(parseSidecar(JSON.stringify(syntheticSidecar(2, false))).keys.length).toBe(0);
});

// ---- the host client -------------------------------------------------------------------------------

interface Seen {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeHost(handlers: Record<string, (body: Record<string, unknown>) => { status?: number; json?: unknown; text?: string }>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ path: input, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body });
    const h = handlers[input];
    if (!h) return new Response('{}', { status: 404 });
    const r = h(body ?? {});
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

test('start sends the token and the request, and works out the host clock from the round trip', async () => {
  const host = fakeHost({ '/api/cursor/start': () => ({ json: { ok: true, session: 'abc', hostElapsedMs: 0.5 } }) });
  const clock = [1000, 1010];
  const c = new CursorCapture({ token: 'tok', fetch: host.fetchImpl, now: () => clock.shift() ?? 0 });
  await c.start('rec-1', { x: 0, y: 0, width: 1920, height: 1080 }, true);
  expect(host.seen[0].headers['X-Capstan-Token']).toBe('tok');
  expect(host.seen[0].headers['Content-Type']).toBe('application/json');
  expect(host.seen[0].body).toEqual({ recordingId: 'rec-1', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, keys: true });
  expect(c.active).toBe(true);
  expect(c.origin).toBeCloseTo(1004.5, 6);
  await expect(c.start('rec-2', { x: 0, y: 0, width: 10, height: 10 }, false)).rejects.toThrow('already running');
});

test('stop returns the host text; collect lines it up with the recorder start and the recording length', async () => {
  const sidecar = JSON.stringify({ version: 1, samples: [[0, 0.1, 0.1], [1, 0.2, 0.2], [2, 0.3, 0.3]], clicks: [{ t: 1.5, button: 'left', down: true }] });
  const host = fakeHost({
    '/api/cursor/start': () => ({ json: { session: 's1', hostElapsedMs: 0 } }),
    '/api/cursor/stop': () => ({ text: sidecar }),
  });
  const clock = [500, 500];
  const c = new CursorCapture({ token: 'tok', fetch: host.fetchImpl, now: () => clock.shift() ?? 0 });
  await c.start('rec-1', { x: 0, y: 0, width: 100, height: 100 }, false);
  c.mediaStarted(1000); // the recorder started 500 ms after the host
  const text = await c.stop();
  expect(host.seen.at(-1)?.body).toEqual({ session: 's1' });
  expect(c.active).toBe(false);
  const data = c.collect(text, 1.2);
  // Shift 0.5 s: host time 1 s is 0.5 s into the recording; host time 0 is before it began.
  expect(data.samples[0].t).toBe(0);
  expect(data.samples.some((s) => Math.abs(s.t - 0.5) < 1e-9 && Math.abs(s.x - 0.2) < 1e-9)).toBe(true);
  expect(data.samples[data.samples.length - 1].t).toBeCloseTo(1.2, 9);
  expect(data.clicks[0].t).toBeCloseTo(1.0, 9);
});

test('collect explains an empty or invalid file instead of attaching nothing', () => {
  const c = new CursorCapture({ token: 't', fetch: fakeHost({}).fetchImpl });
  expect(() => c.collect('not json', 1)).toThrow(CursorHostError);
  expect(() => c.collect(JSON.stringify({ version: 1, samples: [[9, 0.5, 0.5]] }), 1)).toThrow('No cursor activity');
});

test('pause, resume and cancel call the host with the session; cancel asks it to write nothing', async () => {
  const host = fakeHost({
    '/api/cursor/start': () => ({ json: { session: 's9', hostElapsedMs: 0 } }),
    '/api/cursor/pause': () => ({ json: { ok: true } }),
    '/api/cursor/resume': () => ({ json: { ok: true } }),
    '/api/cursor/stop': () => ({ json: { ok: true, discarded: true } }),
  });
  const c = new CursorCapture({ token: 'tok', fetch: host.fetchImpl, now: () => 0 });
  await c.start('rec-9', { x: 0, y: 0, width: 10, height: 10 }, false);
  await c.pause();
  await c.resume();
  await c.cancel();
  expect(host.seen.map((s) => s.path)).toEqual(['/api/cursor/start', '/api/cursor/pause', '/api/cursor/resume', '/api/cursor/stop']);
  expect(host.seen[1].body).toEqual({ session: 's9' });
  expect(host.seen[3].body).toEqual({ session: 's9', discard: true });
  expect(c.active).toBe(false);
  // After cancelling, nothing more is sent.
  await c.cancel();
  await c.pause();
  expect(host.seen.length).toBe(4);
});

test('probe says why capture is not available and calls nothing without a token', async () => {
  const none = fakeHost({});
  expect(await new CursorCapture({ token: '', fetch: none.fetchImpl }).probe()).toBe(HOST_MISSING);
  expect(none.seen.length).toBe(0);
  const ok = fakeHost({ '/api/cursor/status': () => ({ json: { available: true, active: false } }) });
  expect(await new CursorCapture({ token: 't', fetch: ok.fetchImpl }).probe()).toBeNull();
  expect(ok.seen[0].method).toBe('GET');
  const busy = fakeHost({ '/api/cursor/status': () => ({ json: { available: true, active: true } }) });
  expect(await new CursorCapture({ token: 't', fetch: busy.fetchImpl }).probe()).toContain('still running');
  const off = fakeHost({ '/api/cursor/status': () => ({ status: 503, json: { error: 'Cursor capture is not available on this computer.', code: 'unavailable' } }) });
  expect(await new CursorCapture({ token: 't', fetch: off.fetchImpl }).probe()).toContain('not available');
  const down = new CursorCapture({
    token: 't',
    fetch: (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch,
  });
  expect(await down.probe()).toContain('did not answer');
});

test('a refused start surfaces the host message and leaves no session behind', async () => {
  const host = fakeHost({ '/api/cursor/start': () => ({ status: 409, json: { error: 'A cursor session is already running.', code: 'busy' } }) });
  const c = new CursorCapture({ token: 't', fetch: host.fetchImpl, now: () => 0 });
  await expect(c.start('rec-1', { x: 0, y: 0, width: 10, height: 10 }, false)).rejects.toMatchObject({ message: 'A cursor session is already running.', status: 409, code: 'busy' });
  expect(c.active).toBe(false);
});

// ---- recording flow --------------------------------------------------------------------------------

test('cursor capture and shortcut capture are both off by default and never leak into the remembered prefs', () => {
  const s = defaultSettings();
  expect(s.captureCursor).toBe(false);
  expect(s.captureKeys).toBe(false);
  expect(toRecordOptions(s, DEFAULT_PROJECT_SIZE, null).hideCursor).toBe(false);
});

test('capturing the cursor asks the browser to leave the pointer out, so Capstan can draw it again', () => {
  const s = { ...defaultSettings(), surface: 'monitor' as const, captureCursor: true };
  expect(toRecordOptions(s, DEFAULT_PROJECT_SIZE, null).hideCursor).toBe(true);
});

test('capture is requested only for the entire screen, and keys only when asked for', () => {
  const on = { ...defaultSettings(), captureCursor: true };
  expect(captureRequest({ ...on, surface: 'window' })).toBeNull();
  expect(captureRequest({ ...on, surface: 'browser' })).toBeNull();
  expect(captureRequest({ ...on, surface: 'monitor' })).toEqual({ keys: false });
  expect(captureRequest({ ...on, surface: 'monitor', captureKeys: true })).toEqual({ keys: true });
  expect(captureRequest({ ...defaultSettings(), surface: 'monitor' })).toBeNull();
});

test('the indicator says what is being captured', () => {
  expect(captureLabel(false, false)).toBe('Capturing cursor');
  expect(captureLabel(true, false)).toBe('Capturing cursor and shortcuts');
  expect(captureLabel(true, true)).toBe('Cursor capture paused');
});

test('attaching captured data creates effect settings that draw the cursor, and keeps existing settings', () => {
  const media: MediaItem = { id: 'm1', name: 'Recording', kind: 'video', mime: 'video/webm', bytes: 10, duration: 2, width: 640, height: 360, hasAudio: false, createdAt: 0 };
  const withMedia = { ...createProject('p'), media: [media] };
  const data: CursorData = { samples: [sample(0, 0.5, 0.5)], clicks: [], keys: [] };
  const a = attachCaptured(withMedia, 'm1', data);
  expect(a.media[0].cursor).toEqual(data);
  expect(a.cursorFx?.showCursor).toBe(true);
  const kept = attachCaptured({ ...a, cursorFx: { ...a.cursorFx!, showCursor: false } }, 'm1', data);
  expect(kept.cursorFx?.showCursor).toBe(false);
});
