// Node mirror of the host's /api/hotkeys/* routes (modules/Hotkeys.ps1), used by tests/serve.mjs so the browser
// tests can run anywhere. Same paths, status codes and JSON shapes as the PowerShell host in its
// CAPSTAN_TEST_HOTKEYS=1 mode: nothing is registered with the OS and there is no tray icon.
// Without CAPSTAN_TEST_HOTKEYS=1 it behaves like a host whose hotkeys are off (available: false).
// Binding rules are shared with the host and the page through tests/fixtures/hotkey-bindings.json.

const TOKEN = 'test-token';
export const EVENT_NAMES = ['start-stop', 'pause-resume', 'marker', 'tray-open'];
export const ACTIONS = ['start-stop', 'pause-resume', 'marker'];
export const DEFAULTS = { 'start-stop': 'Ctrl+Shift+F9', 'pause-resume': 'Ctrl+Shift+F10', marker: 'Ctrl+Shift+F11' };
export const MODIFIERS = ['Ctrl', 'Alt', 'Shift'];
export const KEYS = [
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`).filter((k) => k !== 'F12'),
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
  'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Pause', 'PrintScreen', 'ScrollLock',
];
const keyByLower = new Map(KEYS.map((k) => [k.toLowerCase(), k]));
export const CAPTURE_EXCLUSION = {
  possible: false,
  reason:
    "Capstan cannot hide its own window from a screen capture. Windows only lets a program hide windows that belong to that program, and Capstan's window belongs to your browser. To keep Capstan out of the recording, record a browser tab or a single window (the default here) instead of the entire screen.",
};
const RESERVED_REASON = 'Another program already uses this key combination. Pick a different one.';

export function parseBinding(text) {
  if (typeof text !== 'string') return { ok: false, error: 'Choose a key combination.' };
  const t = text.trim();
  if (!t) return { ok: false, error: 'Choose a key combination.' };
  if (t.length > 40) return { ok: false, error: 'That key combination is too long.' };
  if (!/^[A-Za-z0-9+ ]+$/.test(t)) return { ok: false, error: 'Use only modifier and key names, such as Ctrl+Shift+F9.' };
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key = null;
  for (const raw of t.split('+')) {
    const p = raw.trim();
    if (!p) return { ok: false, error: 'Each + needs a key or modifier on both sides.' };
    const l = p.toLowerCase();
    const flag = l === 'ctrl' || l === 'control' ? 'ctrl' : l === 'alt' ? 'alt' : l === 'shift' ? 'shift' : '';
    if (flag) {
      if ((flag === 'ctrl' && ctrl) || (flag === 'alt' && alt) || (flag === 'shift' && shift)) return { ok: false, error: 'A modifier is listed twice.' };
      if (flag === 'ctrl') ctrl = true;
      else if (flag === 'alt') alt = true;
      else shift = true;
      continue;
    }
    const k = keyByLower.get(l);
    if (!k) return { ok: false, error: `'${p}' is not a key Capstan can use.` };
    if (key) return { ok: false, error: 'Use one key plus modifiers.' };
    key = k;
  }
  if (!key) return { ok: false, error: 'Add a key after the modifiers.' };
  if (!ctrl && !alt) return { ok: false, error: 'Include Ctrl or Alt, so the key still works when you type in other programs.' };
  if (ctrl && alt && key === 'Delete') return { ok: false, error: 'Windows keeps Ctrl+Alt+Delete for itself.' };
  return { ok: true, text: [ctrl && 'Ctrl', alt && 'Alt', shift && 'Shift', key].filter(Boolean).join('+') };
}

export function createHotkeyMirror({ enabled = process.env.CAPSTAN_TEST_HOTKEYS === '1' } = {}) {
  const events = [];
  let last = 0;
  let state = 'idle';
  let bindings = { ...DEFAULTS };
  let results = [];
  const taken = new Set();
  const waiters = new Set();

  const apply = () => {
    results = ACTIONS.map((action) => {
      const binding = bindings[action];
      const clash = taken.has(binding);
      return { action, binding, registered: !clash, reason: clash ? RESERVED_REASON : '' };
    });
  };
  apply();

  const status = () => {
    if (!enabled) {
      return {
        available: false, running: false, test: false, state: 'idle', last: 0, trayVisible: false,
        reason: 'Hotkeys are turned off (CAPSTAN_HOTKEYS=0 or -no-hotkeys).',
        registered: [], failed: [], bindings: { ...DEFAULTS }, keys: [], captureExclusion: CAPTURE_EXCLUSION, allowed: { modifiers: MODIFIERS, keys: KEYS },
      };
    }
    return {
      available: true, running: true, test: true, state, last, trayVisible: false, reason: '',
      registered: results.filter((r) => r.registered).map((r) => r.action),
      failed: results.filter((r) => !r.registered).map((r) => ({ action: r.action, binding: r.binding, reason: r.reason })),
      bindings: { ...bindings },
      keys: results.map((r) => ({ ...r })),
      captureExclusion: CAPTURE_EXCLUSION,
      allowed: { modifiers: MODIFIERS, keys: KEYS },
    };
  };
  const eventsPayload = (since) => ({ events: events.filter((e) => e.id > since), last });
  const add = (name) => {
    last++;
    const item = { id: last, name, at: Date.now() };
    events.push(item);
    while (events.length > 100) events.shift();
    for (const wake of [...waiters]) wake();
    return item;
  };

  const send = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));

  const readBody = async (req) => {
    const type = String(req.headers['content-type'] ?? '');
    if (!/^application\/json\s*(;.*)?$/.test(type)) return { status: 415, error: 'Send application/json' };
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > 4096) return { status: 413, error: 'Request body too large' };
    if (declared <= 0) return { status: 400, error: 'A JSON body is required' };
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const body = JSON.parse(raw);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'The body must be a JSON object' };
      return { body };
    } catch {
      return { status: 400, error: 'The body is not valid JSON' };
    }
  };

  /** Handles a /api/hotkeys/* request. */
  async function handle(req, res, url) {
    if (req.headers['x-capstan-token'] !== TOKEN) return send(res, 403, { error: 'Invalid session' });
    const m = req.method;
    const wrong = () => send(res, 405, { error: 'Method not allowed' });
    const none = () => send(res, 409, { error: 'Hotkeys are not available in this host' });
    switch (url.pathname) {
      case '/api/hotkeys/status':
        return m === 'GET' ? send(res, 200, status()) : wrong();
      case '/api/hotkeys/events': {
        if (m !== 'GET') return wrong();
        if (!enabled) return none();
        const sinceText = url.searchParams.get('since') ?? '';
        const waitText = url.searchParams.get('wait') ?? '';
        let since = 0;
        let wait = 0;
        if (sinceText !== '') {
          if (!/^[0-9]{1,15}$/.test(sinceText)) return send(res, 400, { error: 'since must be a whole number' });
          since = Number(sinceText);
        }
        if (waitText !== '') {
          if (!/^[0-9]{1,3}$/.test(waitText)) return send(res, 400, { error: 'wait must be a whole number of seconds' });
          wait = Math.min(Number(waitText), 25);
        }
        if (eventsPayload(since).events.length || wait <= 0) return send(res, 200, eventsPayload(since));
        await new Promise((resolve) => {
          let timer;
          const done = () => {
            clearTimeout(timer);
            waiters.delete(check);
            req.off('close', done);
            resolve();
          };
          const check = () => {
            if (events.some((e) => e.id > since)) done();
          };
          timer = setTimeout(done, wait * 1000);
          waiters.add(check);
          req.on('close', done);
        });
        if (res.writableEnded || res.destroyed) return;
        return send(res, 200, eventsPayload(since));
      }
      case '/api/hotkeys/config': {
        if (m !== 'PUT') return wrong();
        if (!enabled) return none();
        const r = await readBody(req);
        if (!r.body) return send(res, r.status, { error: r.error });
        const given = r.body.bindings;
        if (!given || typeof given !== 'object' || Array.isArray(given)) return send(res, 400, { error: 'Send {"bindings": {"start-stop": "Ctrl+Shift+F9"}}' });
        const entries = Object.entries(given);
        if (!entries.length) return send(res, 400, { error: 'No bindings were given' });
        const merged = { ...bindings };
        for (const [action, value] of entries) {
          if (typeof value !== 'string') return send(res, 400, { error: 'Each binding must be text', field: '' });
          if (!ACTIONS.includes(action)) return send(res, 400, { error: 'Unknown hotkey action.', field: '' });
          const p = parseBinding(value);
          if (!p.ok) return send(res, 400, { error: p.error, field: action });
          merged[action] = p.text;
        }
        for (let i = 0; i < ACTIONS.length; i++) {
          for (let j = i + 1; j < ACTIONS.length; j++) {
            if (merged[ACTIONS[i]].toLowerCase() === merged[ACTIONS[j]].toLowerCase()) {
              return send(res, 400, { error: 'Two Capstan actions cannot share a key combination.', field: ACTIONS[j] in given ? ACTIONS[j] : ACTIONS[i] });
            }
          }
        }
        bindings = merged;
        apply();
        return send(res, 200, status());
      }
      case '/api/hotkeys/state': {
        if (m !== 'POST') return wrong();
        if (!enabled) return none();
        const r = await readBody(req);
        if (!r.body) return send(res, r.status, { error: r.error });
        if (!['idle', 'recording', 'paused'].includes(r.body.state)) return send(res, 400, { error: 'state must be idle, recording or paused' });
        state = r.body.state;
        return send(res, 200, { ok: true, state });
      }
      case '/api/hotkeys/test-inject': {
        // The test seam: this route exists only when CAPSTAN_TEST_HOTKEYS=1.
        if (!enabled) return send(res, 404, { error: 'Route not found' });
        if (m !== 'POST') return wrong();
        const r = await readBody(req);
        if (!r.body) return send(res, r.status, { error: r.error });
        if ('clash' in r.body) {
          const p = parseBinding(r.body.clash);
          if (!p.ok) return send(res, 400, { error: 'clash must be a valid key combination' });
          taken.add(p.text);
          apply();
          return send(res, 200, status());
        }
        if (typeof r.body.event !== 'string' || !EVENT_NAMES.includes(r.body.event)) {
          return send(res, 400, { error: 'event must be start-stop, pause-resume, marker or tray-open' });
        }
        const item = add(r.body.event);
        return send(res, 200, { ok: true, id: item.id, name: item.name });
      }
      default:
        return send(res, 404, { error: 'Route not found' });
    }
  }

  return { handle, status, add };
}
