// Global hotkeys, the page side: binding rules (one corpus shared with the PowerShell host and the Node mirror),
// the long-poll client against a fake host, the Record flow decisions, markers taken during a recording, and
// static checks on the host code (C# 5, the test seam, wiring). Nothing here registers a key or touches Windows.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  HOTKEY_ACTIONS,
  type HotkeyEvent,
  HotkeyClient,
  KEY_NAMES,
  MARKER_MIN_GAP,
  acceptMarkerTime,
  applyRecordingMarkers,
  decideHotkey,
  defaultBindings,
  formatBinding,
  parseBinding,
  parseEvents,
  parseStatus,
  parseStoredBindings,
  trayStateFor,
  validateBindings,
} from '../../src/engine/hotkeys-host';
import { createProject } from '../../src/engine/project';
import { LAST_USED_KEY, parseLastUsed } from '../../src/engine/recording-flow';
import { CAPTURE_EXCLUSION, createHotkeyMirror, KEYS as MIRROR_KEYS, parseBinding as mirrorParse } from '../hotkeys-mirror.mjs';

const root = join(import.meta.dir, '../..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const corpus = JSON.parse(read('tests/fixtures/hotkey-bindings.json')) as { keys: string[]; cases: Array<{ input: string; ok: boolean; normalized?: string }> };

describe('binding rules (shared corpus)', () => {
  test('the page, the mirror and the corpus agree on the allowed keys', () => {
    expect([...KEY_NAMES]).toEqual(corpus.keys);
    expect(MIRROR_KEYS).toEqual(corpus.keys);
  });

  test('every corpus case is accepted or refused the same way by the page and the mirror', () => {
    for (const c of corpus.cases) {
      const page = parseBinding(c.input);
      const mirror = mirrorParse(c.input);
      expect(page.ok).toBe(c.ok);
      expect(mirror.ok).toBe(c.ok);
      if (c.ok && page.ok) {
        expect(page.text).toBe(c.normalized);
        expect(mirror.text).toBe(c.normalized);
      }
      if (!c.ok && !page.ok) expect(page.reason.length).toBeGreaterThan(0);
    }
  });

  test('a refusal never echoes text that was not a plain key name', () => {
    const r = parseBinding('Ctrl+Shift+F9; calc');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain('calc');
    const nonString = parseBinding({ toString: () => 'Ctrl+F9' });
    expect(nonString.ok).toBe(false);
  });

  test('formatBinding builds the canonical order and parses back', () => {
    expect(formatBinding(['Shift', 'Ctrl'], 'F9')).toBe('Ctrl+Shift+F9');
    expect(parseBinding(formatBinding(['Alt'], 'Q')).ok).toBe(true);
  });

  test('validateBindings checks each binding and refuses two actions sharing one', () => {
    const ok = validateBindings({ marker: 'alt+m' });
    expect(ok.ok && ok.bindings.marker).toBe('Alt+M');
    expect(ok.ok && ok.bindings['start-stop']).toBe('Ctrl+Shift+F9');
    const bad = validateBindings({ marker: 'F5' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.action).toBe('marker');
    const dup = validateBindings({ marker: 'ctrl+shift+f9' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.action).toBe('marker');
  });

  test('stored bindings: valid ones are kept, anything else means defaults', () => {
    expect(parseStoredBindings(null)).toBeNull();
    expect(parseStoredBindings('not json')).toBeNull();
    expect(parseStoredBindings('[]')).toBeNull();
    expect(parseStoredBindings(JSON.stringify({ marker: 'F5' }))).toBeNull();
    expect(parseStoredBindings(JSON.stringify({ marker: 'ctrl+alt+m' }))?.marker).toBe('Ctrl+Alt+M');
    expect(parseStoredBindings(JSON.stringify({ marker: 'Ctrl+Shift+F9' }))).toBeNull();
  });

  test('defaults match the host: Ctrl+Shift+F9, F10, F11', () => {
    expect(defaultBindings()).toEqual({ 'start-stop': 'Ctrl+Shift+F9', 'pause-resume': 'Ctrl+Shift+F10', marker: 'Ctrl+Shift+F11' });
    expect(HOTKEY_ACTIONS.map((a) => a.defaultBinding)).toEqual(Object.values(defaultBindings()));
    const hostSource = read('modules/Hotkeys.ps1');
    expect(hostSource).toContain('"Ctrl+Shift+F9", "Ctrl+Shift+F10", "Ctrl+Shift+F11"');
  });
});

describe('Record flow decisions', () => {
  test('start or stop', () => {
    expect(decideHotkey('setup', 'start-stop', true)).toBe('start');
    expect(decideHotkey('setup', 'start-stop', false)).toBe('need-click');
    expect(decideHotkey('armed', 'start-stop', false)).toBe('go');
    expect(decideHotkey('countdown', 'start-stop', false)).toBe('go');
    expect(decideHotkey('recording', 'start-stop', false)).toBe('stop');
    expect(decideHotkey('paused', 'start-stop', false)).toBe('stop');
    expect(decideHotkey('saving', 'start-stop', true)).toBe('ignore');
    expect(decideHotkey('region', 'start-stop', true)).toBe('ignore');
  });
  test('pause or resume and markers only act on a recording', () => {
    expect(decideHotkey('recording', 'pause-resume', false)).toBe('pause');
    expect(decideHotkey('paused', 'pause-resume', false)).toBe('resume');
    expect(decideHotkey('setup', 'pause-resume', true)).toBe('ignore');
    expect(decideHotkey('recording', 'marker', false)).toBe('marker');
    expect(decideHotkey('paused', 'marker', false)).toBe('marker');
    expect(decideHotkey('armed', 'marker', false)).toBe('ignore');
  });
  test('the tray follows the recorder', () => {
    expect(trayStateFor('recording')).toBe('recording');
    expect(trayStateFor('paused')).toBe('paused');
    for (const p of ['setup', 'region', 'armed', 'countdown', 'saving'] as const) expect(trayStateFor(p)).toBe('idle');
  });
});

describe('markers taken during a recording', () => {
  test('presses closer than the minimum gap count once', () => {
    expect(acceptMarkerTime([], 1.2)).toBe(true);
    expect(acceptMarkerTime([1.2], 1.2 + MARKER_MIN_GAP / 2)).toBe(false);
    expect(acceptMarkerTime([1.2], 1.2 + MARKER_MIN_GAP * 2)).toBe(true);
    expect(acceptMarkerTime([], -1)).toBe(false);
    expect(acceptMarkerTime([], Number.NaN)).toBe(false);
  });
  test('markers land at the recording start plus their time', () => {
    const p = createProject();
    const next = applyRecordingMarkers(p, 10, [1.5, 4, 0]);
    expect(next.markers.map((m) => m.time)).toEqual([10, 11.5, 14]);
    expect(applyRecordingMarkers(p, 5, [])).toBe(p);
  });
});

describe('remembered record settings', () => {
  test('only well-formed values are read back', () => {
    expect(parseLastUsed(null)).toEqual({});
    expect(parseLastUsed('nope')).toEqual({});
    expect(parseLastUsed(JSON.stringify({ surface: 'monitor', microphone: false, armFirst: true, cameraId: 'abc', webcam: 'yes', hideCursor: 1 }))).toEqual({
      surface: 'monitor',
      microphone: false,
      armFirst: true,
      cameraId: 'abc',
    });
    expect(parseLastUsed(JSON.stringify({ surface: 'desktop' }))).toEqual({});
    expect(LAST_USED_KEY).toBe('capstan-record-last');
  });
});

describe('host answers', () => {
  test('status is read defensively', () => {
    expect(parseStatus(null)).toBeNull();
    expect(parseStatus({})).toBeNull();
    const s = parseStatus({
      available: true,
      running: true,
      test: true,
      state: 'recording',
      last: 4,
      keys: [
        { action: 'start-stop', binding: 'Ctrl+Shift+F9', registered: true, reason: '' },
        { action: 'marker', binding: 'Ctrl+Shift+F11', registered: false, reason: 'Another program already uses this key combination. Pick a different one.' },
        { action: 'evil', binding: 'x', registered: true, reason: '' },
      ],
    });
    expect(s?.registered).toEqual(['start-stop']);
    expect(s?.failed[0]?.action).toBe('marker');
    expect(s?.state).toBe('recording');
    expect(parseStatus({ available: false })?.available).toBe(false);
  });
  test('events keep only the fixed names, in id order', () => {
    const got = parseEvents({
      events: [
        { id: 3, name: 'marker', at: 1 },
        { id: 2, name: 'launch-missiles', at: 1 },
        { id: 1, name: 'start-stop', at: 1 },
      ],
      last: 3,
    });
    expect(got?.events.map((e) => e.id)).toEqual([1, 3]);
    expect(parseEvents({ events: 'x', last: 1 })).toBeNull();
    expect(parseEvents(null)).toBeNull();
  });
});

// ---- the long-poll client against a fake host ----
type Handle = { json: unknown; status?: number };
function makeHost() {
  const queue: Array<{ id: number; name: string; at: number }> = [];
  let last = 0;
  let available = true;
  let running = true;
  let state = 'idle';
  const calls: Array<{ url: string; method: string; token: string | null; body: string | null }> = [];
  const waiters = new Set<() => void>();
  let eventsStatus = 200;
  let failNext = 0;
  const statusBody = () => ({
    available,
    running,
    test: true,
    state,
    last,
    trayVisible: false,
    reason: available ? '' : 'off',
    registered: ['start-stop', 'pause-resume', 'marker'],
    failed: [],
    bindings: defaultBindings(),
    keys: HOTKEY_ACTIONS.map((a) => ({ action: a.action, binding: a.defaultBinding, registered: true, reason: '' })),
    allowed: { modifiers: ['Ctrl', 'Alt', 'Shift'], keys: [...KEY_NAMES] },
  });
  const reply = ({ json, status = 200 }: Handle) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? 'GET', token: headers.get('X-Capstan-Token'), body: typeof init?.body === 'string' ? init.body : null });
    if (failNext > 0) {
      failNext--;
      throw new TypeError('network down');
    }
    if (url === '/api/hotkeys/status') return reply({ json: statusBody() });
    if (url === '/api/hotkeys/state') {
      state = JSON.parse(String(init?.body)).state;
      return reply({ json: { ok: true, state } });
    }
    if (url === '/api/hotkeys/config') {
      const b = JSON.parse(String(init?.body)).bindings as Record<string, string>;
      if (b.marker === 'Ctrl+Alt+Z') return reply({ status: 400, json: { error: 'Nope.', field: 'marker' } });
      return reply({ json: { ...statusBody(), bindings: b } });
    }
    if (url.startsWith('/api/hotkeys/events')) {
      if (eventsStatus !== 200) return reply({ status: eventsStatus, json: { error: 'x' } });
      const since = Number(new URL(url, 'http://x').searchParams.get('since'));
      const take = () => queue.filter((e) => e.id > since);
      if (take().length) return reply({ json: { events: take(), last } });
      return await new Promise<Response>((resolve, reject) => {
        const done = () => {
          waiters.delete(done);
          if (take().length) resolve(reply({ json: { events: take(), last } }));
        };
        waiters.add(done);
        init?.signal?.addEventListener('abort', () => {
          waiters.delete(done);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    return reply({ status: 404, json: { error: 'Route not found' } });
  }) as typeof fetch;
  return {
    fetchImpl,
    calls,
    push(name: string) {
      last++;
      queue.push({ id: last, name, at: 0 });
      for (const w of [...waiters]) w();
    },
    setAvailable(v: boolean) {
      available = v;
    },
    setRunning(v: boolean) {
      running = v;
    },
    setEventsStatus(v: number) {
      eventsStatus = v;
    },
    failNext(n: number) {
      failNext = n;
    },
    restart() {
      queue.length = 0;
      last = 0;
    },
    get state() {
      return state;
    },
    get pollsWaiting() {
      return waiters.size;
    },
    get eventCalls() {
      return calls.filter((c) => c.url.startsWith('/api/hotkeys/events'));
    },
  };
}
const until = async (pred: () => boolean, ms = 1500) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 4));
  }
  return pred();
};
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function makeClient(host: ReturnType<typeof makeHost>, extra: Partial<ConstructorParameters<typeof HotkeyClient>[0]> = {}) {
  const got: HotkeyEvent[] = [];
  const view = { visible: true, keep: false };
  const client = new HotkeyClient({
    token: 'tok',
    fetchImpl: host.fetchImpl,
    onEvent: (e) => got.push(e),
    isVisible: () => view.visible,
    keepAlive: () => view.keep,
    retryMs: 10,
    ...extra,
  });
  return { client, got, view };
}

describe('HotkeyClient', () => {
  test('polls with the session token, skips the backlog and delivers events in order', async () => {
    const host = makeHost();
    host.push('start-stop'); // pressed before this page was listening
    const { client, got } = makeClient(host);
    client.start();
    expect(await until(() => host.eventCalls.length >= 1)).toBe(true);
    expect(host.eventCalls[0].url).toContain('since=1');
    expect(host.eventCalls[0].url).toMatch(/wait=20/);
    expect(host.calls.every((c) => c.token === 'tok')).toBe(true);
    host.push('marker');
    host.push('pause-resume');
    expect(await until(() => got.length === 2)).toBe(true);
    expect(got.map((e) => e.name)).toEqual(['marker', 'pause-resume']);
    expect(got.map((e) => e.id)).toEqual([2, 3]);
    expect(await until(() => host.eventCalls.some((c) => c.url.includes('since=3')))).toBe(true);
    client.stop();
  });

  test('pauses while hidden and drops what was pressed meanwhile', async () => {
    const host = makeHost();
    const { client, got, view } = makeClient(host);
    client.start();
    expect(await until(() => host.pollsWaiting === 1)).toBe(true);
    view.visible = false;
    client.wake();
    expect(await until(() => host.pollsWaiting === 0)).toBe(true);
    const before = host.eventCalls.length;
    host.push('start-stop');
    await settle();
    expect(host.eventCalls.length).toBe(before);
    expect(got.length).toBe(0);
    view.visible = true;
    client.wake();
    expect(await until(() => host.pollsWaiting === 1)).toBe(true);
    expect(got.length).toBe(0); // the stale press is not replayed
    host.push('marker');
    expect(await until(() => got.length === 1)).toBe(true);
    expect(got[0].name).toBe('marker');
    client.stop();
  });

  test('keeps polling while hidden when a recording is running', async () => {
    const host = makeHost();
    const { client, got, view } = makeClient(host);
    client.start();
    expect(await until(() => host.pollsWaiting === 1)).toBe(true);
    view.keep = true;
    view.visible = false;
    client.wake();
    await settle();
    expect(host.pollsWaiting).toBe(1);
    host.push('start-stop');
    expect(await until(() => got.length === 1)).toBe(true);
    client.stop();
  });

  test('does not poll when the host reports no hotkeys, and picks up once it does', async () => {
    const host = makeHost();
    host.setAvailable(false);
    const { client, got } = makeClient(host);
    client.start();
    expect(await until(() => host.calls.some((c) => c.url === '/api/hotkeys/status'))).toBe(true);
    await settle();
    expect(host.eventCalls.length).toBe(0);
    host.setAvailable(true);
    client.wake();
    expect(await until(() => host.pollsWaiting === 1)).toBe(true);
    host.push('marker');
    expect(await until(() => got.length === 1)).toBe(true);
    client.stop();
  });

  test('does not poll after the tray was closed (running = false)', async () => {
    const host = makeHost();
    host.setRunning(false);
    const { client } = makeClient(host);
    client.start();
    await settle();
    expect(host.eventCalls.length).toBe(0);
    client.stop();
  });

  test('stops for good on 403 (a restarted host has a new session)', async () => {
    const host = makeHost();
    host.setEventsStatus(403);
    const { client } = makeClient(host);
    client.start();
    expect(await until(() => host.eventCalls.length >= 1)).toBe(true);
    await settle(80);
    expect(host.eventCalls.length).toBe(1);
    expect(client.status).toBeNull();
    client.stop();
  });

  test('retries after a network failure', async () => {
    const host = makeHost();
    const { client, got } = makeClient(host);
    client.start();
    expect(await until(() => host.pollsWaiting === 1)).toBe(true);
    host.failNext(2);
    host.push('marker');
    expect(await until(() => got.length === 1, 2000)).toBe(true);
    client.stop();
  });

  test('a host that restarted (ids start again) is followed', async () => {
    const host = makeHost();
    host.push('marker');
    host.push('marker');
    const { client, got } = makeClient(host);
    client.start();
    expect(await until(() => host.pollsWaiting === 1)).toBe(true);
    host.restart();
    client.wake(); // not hidden, so the poll continues; force a resync by hiding and showing
    client.stop();
    const again = makeClient(host);
    again.client.start();
    expect(await until(() => host.pollsWaiting >= 1)).toBe(true);
    host.push('start-stop');
    expect(await until(() => again.got.length === 1)).toBe(true);
    expect(got.length).toBe(0);
    again.client.stop();
  });

  test('a handler that throws does not stop the loop', async () => {
    const host = makeHost();
    const seen: string[] = [];
    const { client } = makeClient(host, {
      onEvent: (e) => {
        seen.push(e.name);
        throw new Error('boom');
      },
    });
    client.start();
    expect(await until(() => host.pollsWaiting === 1)).toBe(true);
    host.push('marker');
    host.push('start-stop');
    expect(await until(() => seen.length === 2)).toBe(true);
    client.stop();
  });

  test('setState tells the host, configure validates first and reports a refusal', async () => {
    const host = makeHost();
    const { client } = makeClient(host);
    await client.refresh();
    client.setState('recording');
    expect(await until(() => host.state === 'recording')).toBe(true);

    const local = await client.configure({ marker: 'F5' });
    expect(local.ok).toBe(false);
    expect(host.calls.filter((c) => c.url === '/api/hotkeys/config').length).toBe(0); // refused before any request

    const refused = await client.configure({ marker: 'Ctrl+Alt+Z' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toBe('Nope.');
      expect(refused.action).toBe('marker');
    }

    const ok = await client.configure({ marker: 'alt+m' });
    expect(ok.ok).toBe(true);
    const put = host.calls.filter((c) => c.url === '/api/hotkeys/config').at(-1)!;
    expect(put.method).toBe('PUT');
    expect(JSON.parse(put.body!).bindings.marker).toBe('Alt+M');
  });
});

describe('Node mirror of the host routes', () => {
  const run = (enabled: boolean) => {
    const mirror = createHotkeyMirror({ enabled });
    const server = createServer((req, res) => void mirror.handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1')));
    return { mirror, server };
  };
  let on: ReturnType<typeof run>;
  let off: ReturnType<typeof run>;
  let onBase = '';
  let offBase = '';
  beforeAll(async () => {
    on = run(true);
    off = run(false);
    await Promise.all(
      [on, off].map((s) => new Promise<void>((r) => s.server.listen(0, '127.0.0.1', () => r()))),
    );
    onBase = `http://127.0.0.1:${(on.server.address() as AddressInfo).port}`;
    offBase = `http://127.0.0.1:${(off.server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    on.server.close();
    off.server.close();
  });
  const call = (base: string, path: string, init: RequestInit = {}, token: string | null = 'test-token') =>
    fetch(base + path, { ...init, headers: { ...(token ? { 'X-Capstan-Token': token } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) } });

  test('every route needs the token', async () => {
    for (const path of ['/api/hotkeys/status', '/api/hotkeys/events', '/api/hotkeys/config', '/api/hotkeys/state', '/api/hotkeys/test-inject']) {
      expect((await call(onBase, path, {}, null)).status).toBe(403);
      expect((await call(onBase, path, {}, 'wrong')).status).toBe(403);
    }
  });

  test('status, events and the long poll behave like the host', async () => {
    const status = await (await call(onBase, '/api/hotkeys/status')).json();
    expect(status.available).toBe(true);
    expect(status.registered).toEqual(['start-stop', 'pause-resume', 'marker']);
    expect(status.bindings['start-stop']).toBe('Ctrl+Shift+F9');
    expect(parseStatus(status)?.allowed.keys).toEqual(corpus.keys);

    const t0 = Date.now();
    const empty = await (await call(onBase, '/api/hotkeys/events?since=0&wait=1')).json();
    expect(empty.events).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);

    const pending = call(onBase, '/api/hotkeys/events?since=0&wait=20').then((r) => r.json());
    await settle(100);
    const inj = await call(onBase, '/api/hotkeys/test-inject', { method: 'POST', body: JSON.stringify({ event: 'marker' }) });
    expect(inj.status).toBe(200);
    const got = await pending;
    expect(got.events.map((e: { name: string }) => e.name)).toEqual(['marker']);
    expect(Date.now() - t0).toBeLessThan(5000);

    expect((await call(onBase, '/api/hotkeys/events?since=abc')).status).toBe(400);
    expect((await call(onBase, '/api/hotkeys/events?wait=-1')).status).toBe(400);
    expect((await call(onBase, '/api/hotkeys/events', { method: 'POST', body: '{}' })).status).toBe(405);
  });

  test('config validates against the allowlist, state accepts three values, a clash is reported per key', async () => {
    const put = (b: unknown, ct = 'application/json') =>
      call(onBase, '/api/hotkeys/config', { method: 'PUT', body: typeof b === 'string' ? b : JSON.stringify(b), headers: { 'Content-Type': ct } });
    expect((await put({ bindings: { marker: 'F5' } })).status).toBe(400);
    expect((await put({ bindings: { marker: 'Ctrl+Alt+Win+M' } })).status).toBe(400);
    expect((await put({ bindings: { 'rm -rf': 'Ctrl+Alt+M' } })).status).toBe(400);
    expect((await put({ bindings: {} })).status).toBe(400);
    expect((await put({ bindings: { marker: 7 } })).status).toBe(400);
    expect((await put('[1]')).status).toBe(400);
    expect((await put('{"bindings":{"marker":"Ctrl+Alt+M"}}', 'text/plain')).status).toBe(415);
    expect((await put({ bindings: { marker: 'x'.repeat(5000) } })).status).toBe(413);
    const ok = await put({ bindings: { marker: 'ctrl+alt+m' } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).bindings.marker).toBe('Ctrl+Alt+M');

    expect((await call(onBase, '/api/hotkeys/state', { method: 'POST', body: '{"state":"recording"}' })).status).toBe(200);
    expect((await call(onBase, '/api/hotkeys/state', { method: 'POST', body: '{"state":"melting"}' })).status).toBe(400);

    const clash = await call(onBase, '/api/hotkeys/test-inject', { method: 'POST', body: JSON.stringify({ clash: 'Ctrl+Shift+F10' }) });
    const after = await clash.json();
    expect(after.failed).toHaveLength(1);
    expect(after.failed[0].action).toBe('pause-resume');
    expect(after.failed[0].reason).toContain('Another program');
    expect(after.registered).toContain('start-stop');
  });

  test('test-inject only takes the fixed event names', async () => {
    expect((await call(onBase, '/api/hotkeys/test-inject', { method: 'POST', body: '{"event":"reboot"}' })).status).toBe(400);
  });

  test('without CAPSTAN_TEST_HOTKEYS=1 hotkeys are off and test-inject does not exist', async () => {
    const status = await (await call(offBase, '/api/hotkeys/status')).json();
    expect(status.available).toBe(false);
    expect((await call(offBase, '/api/hotkeys/events?since=0&wait=1')).status).toBe(409);
    expect((await call(offBase, '/api/hotkeys/test-inject', { method: 'POST', body: '{"event":"marker"}' })).status).toBe(404);
  });
});

// ---- static checks on the host code ----
const hostCs = read('modules/Hotkeys.ps1');
const csharp = (/Add-Type[^\n]*-TypeDefinition @'([\s\S]*?)'@/.exec(hostCs) ?? [])[1] ?? '';

describe('host code', () => {
  test('the C# block was found and is not trivial', () => {
    expect(csharp.length).toBeGreaterThan(5000);
    expect(csharp).toContain('RegisterHotKey');
    expect(csharp).toContain('NotifyIcon');
  });

  test('the C# stays within C# 5 (Windows PowerShell 5.1 inbox compiler)', () => {
    const code = csharp
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""') // string literals
      .replace(/'(?:[^'\\\n]|\\.)'/g, "''") // char literals
      .replace(/\/\/.*$/gm, ''); // comments
    expect(code).not.toMatch(/\?\./); // null-conditional
    expect(code).not.toMatch(/\?\[/); // null-conditional index
    expect(csharp).not.toMatch(/\$"|\$@"|@\$"/); // interpolated strings
    expect(code).not.toMatch(/\bnameof\b/);
    expect(code).not.toMatch(/=>/); // lambdas and expression-bodied members: use delegate { } and plain methods
    expect(code).not.toMatch(/\bout\s+var\b/);
    expect(code).not.toMatch(/\bawait\b|\basync\b/);
    expect(code).not.toMatch(/\bwhen\s*\(/); // exception filters
    expect(code).not.toMatch(/\busing\s+static\b/);
    expect(code).not.toMatch(/\{\s*get;\s*(?:private\s+|internal\s+)?set;\s*\}\s*=/); // auto-property initialisers
    expect(code).not.toMatch(/\bis\s+(?:not\b|\w+\s+\w+\s*[)&])/); // pattern matching
    expect(code).not.toMatch(/\bdefault\s*[;,)]/); // default literal
    expect(code).not.toMatch(/\b\d[\d_]*_\d/); // digit separators
    expect(code).not.toMatch(/0b[01]/); // binary literals
    expect(code).not.toMatch(/\bnull!/);
    // Only framework assemblies, only OS DLLs.
    const dlls = [...csharp.matchAll(/DllImport\("([^"]+)"/g)].map((m) => m[1]);
    expect(dlls.length).toBeGreaterThan(0);
    for (const d of dlls) expect(d).toBe('user32.dll');
    expect(hostCs).not.toMatch(/Add-Type\s+-Path|Assembly\.Load|LoadFrom|LoadFile/i);
  });

  test('inline out declarations are not used at call sites', () => {
    // C# 7 allows a typed `out string x` at a call site; C# 5 does not. A typed out is only valid in a declaration.
    for (const line of csharp.split('\n')) {
      if (!/\bout\s+[A-Za-z_][\w<>[\]]*\s+\w+/.test(line)) continue;
      expect(/^\s*(public|private|internal|protected|static)\b|\bextern\b/.test(line)).toBe(true);
    }
  });

  test('threads are background threads, registration is on the worker thread, and a failure to register is not fatal', () => {
    expect(csharp).toContain('thread.IsBackground = true');
    expect(csharp).toContain('SetApartmentState(ApartmentState.STA)');
    expect(csharp).toContain('cp.Parent = new IntPtr(-3)'); // HWND_MESSAGE: a message-only window
    expect(csharp).toContain('MOD_NOREPEAT');
    expect(csharp).toContain('GetLastWin32Error');
    expect(csharp).toContain('1409');
    expect(csharp).toContain('UnregisterHotKey');
    expect(csharp).toContain('Application.ExitThread');
    expect(csharp).toContain('tray.Visible = false');
  });

  test('tray icons come from the FleetHacker tray kit, not GetHicon', () => {
    expect(csharp).not.toContain('GetHicon');
    expect(csharp).not.toContain('DestroyIcon');
    expect(csharp).toContain('foreach (string state in TrayIcons.States) icons[state] = TrayIcons.Copy(state);');
    expect(hostCs).toContain("'vendor/fleet-tray/FleetTray.ps1'");
    expect(hostCs).toContain("@(@('idle', ''), @('recording', 'bad'), @('paused', 'busy'))");
    expect(hostCs).toContain('Get-FleetTrayIcon -App capstan');
    expect(hostCs).toMatch(/if \(\$real\) \{ try \{ Set-CapstanTrayIcons \}/);
    expect(read('vendor/fleet-tray/VERSION').trim()).toBe('edge-ops ui-kit/tray v1.0.0, commit 2f90369');
    expect(read('vendor/fleet-tray/FleetTrayArt.cs')).toContain('namespace FleetTray');
    expect(read('vendor/fleet-tray/FleetTrayArt.cs')).not.toContain('GetHicon(');
  });

  test('the menu is Start or Stop, Pause, Open Capstan and Quit tray', () => {
    for (const label of ['"Start recording"', '"Stop recording"', '"Pause"', '"Resume"', '"Open Capstan"', '"Quit tray"']) expect(csharp).toContain(label);
  });

  test('event names are a fixed list and no key content is queued', () => {
    expect(csharp).toContain('"start-stop", "pause-resume", "marker", "tray-open"');
    expect(csharp).not.toMatch(/GetAsyncKeyState|SetWindowsHookEx|GetKeyboardState|ToUnicode|WH_KEYBOARD/);
  });

  test('the test seam exists only behind CAPSTAN_TEST_HOTKEYS=1', () => {
    expect(hostCs).toContain("$env:CAPSTAN_TEST_HOTKEYS -eq '1'");
    expect(hostCs).toMatch(/'\/api\/hotkeys\/test-inject' \{[\s\S]*?if \(-not \(Test-CapstanHotkeyTestMode\)/);
    const mirror = read('tests/hotkeys-mirror.mjs');
    expect(mirror).toContain("process.env.CAPSTAN_TEST_HOTKEYS === '1'");
    expect(mirror).toMatch(/case '\/api\/hotkeys\/test-inject': \{[\s\S]*?if \(!enabled\) return send\(res, 404/);
  });

  test('Start-Capstan.ps1 wires the module in and tears it down in finally', () => {
    const host = read('Start-Capstan.ps1');
    expect(host).toContain("modules/Hotkeys.ps1");
    expect(host).toContain("$path.StartsWith('/api/hotkeys/')");
    expect(host).toContain('Invoke-CapstanHotkeyApi');
    expect(host).toMatch(/finally \{[\s\S]*Stop-CapstanHotkeyService[\s\S]*Remove-CapstanRuntimeFile/);
    expect(host).toContain('Complete-CapstanParkedPolls');
    // The hotkey routes sit behind the shared session token check.
    expect(host.indexOf("'/api/hotkeys/'")).toBeGreaterThan(host.indexOf("$request.Headers['X-Capstan-Token'] -ne $sessionToken"));
    expect(host).not.toMatch(/QueryString/);
    // The module checks the token itself too, in constant time, and the long poll is capped at 25 s.
    expect(hostCs).toContain('Test-CapstanTokenEqual');
    expect(hostCs).toContain('$script:CapstanLongPollMaxSeconds = 25');
  });

  test('the host says plainly why Capstan cannot be kept out of a capture, and does not pretend to', () => {
    const reason = /possible = \$false\s+reason = '([^\r\n]*)'/.exec(hostCs)?.[1]?.replaceAll("''", "'");
    expect(reason).toBeTruthy();
    expect(reason).toBe(CAPTURE_EXCLUSION.reason);
    expect(reason).toContain('record a browser tab or a single window');
    expect(CAPTURE_EXCLUSION.possible).toBe(false);
    // SetWindowDisplayAffinity only works on a process's own windows, so it is deliberately not called.
    expect(csharp).not.toContain('SetWindowDisplayAffinity');
    expect(csharp).not.toContain('WDA_EXCLUDEFROMCAPTURE');
    expect(parseStatus({ available: true, captureExclusion: CAPTURE_EXCLUSION })?.captureExclusion).toEqual(CAPTURE_EXCLUSION);
    expect(parseStatus({ available: true })?.captureExclusion).toBeNull();
  });

  test('the mirror and the host serve the same hotkey routes', () => {
    const routes = [...hostCs.matchAll(/^\s*'(\/api\/hotkeys\/[a-z-]+)' \{/gm)].map((m) => m[1]).sort();
    const mirror = read('tests/hotkeys-mirror.mjs');
    const mirrorRoutes = [...mirror.matchAll(/case '(\/api\/hotkeys\/[a-z-]+)'/g)].map((m) => m[1]).sort();
    expect(routes).toEqual(['/api/hotkeys/config', '/api/hotkeys/events', '/api/hotkeys/state', '/api/hotkeys/status', '/api/hotkeys/test-inject']);
    expect(mirrorRoutes).toEqual(routes);
    expect(read('tests/serve.mjs')).toContain("url.pathname.startsWith('/api/hotkeys/')");
  });

  test('new files are ASCII (Windows PowerShell 5.1 reads BOM-less files as ANSI)', () => {
    for (const f of ['modules/Hotkeys.ps1', 'tests/ps/Hotkeys.Tests.ps1']) expect(/[^\x00-\x7f]/.test(read(f))).toBe(false);
    expect(existsSync(join(root, 'tests/ps/Hotkeys.Tests.ps1'))).toBe(true);
  });

  test('the built bundle polls the host with the fixed event routes only', () => {
    const js = read('dist/assets/app.js');
    expect(js).toContain('/api/hotkeys/events');
    expect(js).toContain('/api/hotkeys/status');
    expect(js).not.toContain('/api/hotkeys/test-inject');
  });
});
