// Node mirror of the host's /api/cursor/* routes (modules/CursorCapture.ps1), for tests/serve.mjs, so the
// browser side can be tested on any machine. Same paths, status codes and JSON shapes. It never reads a real
// mouse or keyboard: the data it returns is synthetic and deterministic for a given duration:
//   - a circle around the middle of the bounds, one turn every 2 s (fractions of the bounds),
//   - two left clicks, at 0.5 s and 1.2 s (each held 0.08 s),
//   - with keys on: Ctrl+C at 0.8 s (held 0.1 s).
// Test-only extras: GET /api/test/cursor-calls lists every request the page made to /api/cursor/*, so a test can
// check that no host call happens when the option is off.
import { randomBytes } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const TOKEN = 'test-token';
export const calls = [];
let session = null; // { handle, id, bounds, keys, startedAt, pausedTotal, pausedAt }
const written = new Set(); // ids that have a file in the mirror's imaginary folder

const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(typeof body === 'string' ? body : JSON.stringify(body));
const fail = (res, status, code, error) => json(res, status, { error, code });
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const r5 = (n) => Math.round(n * 1e5) / 1e5;

const elapsed = (s) => ((s.pausedAt || performance.now()) - s.startedAt - s.pausedTotal) / 1000;

/** The deterministic file for a session that ran `seconds`. */
export function syntheticSidecar(seconds, keys) {
  const samples = [];
  for (let i = 0; i <= Math.floor(seconds * 60); i++) {
    const t = i / 60;
    samples.push([r4(t), r5(0.5 + 0.3 * Math.cos(Math.PI * t)), r5(0.5 + 0.3 * Math.sin(Math.PI * t))]);
  }
  const clicks = [];
  for (const t of [0.5, 1.2]) if (t + 0.08 <= seconds) clicks.push({ t, button: 'left', down: true }, { t: r4(t + 0.08), button: 'left', down: false });
  const out = { format: 'capstan-cursor', version: 1, samples, clicks, keys: [] };
  if (keys && seconds >= 0.9) out.keys.push({ t: 0.8, key: 'Ctrl+C', down: true }, { t: 0.9, key: 'Ctrl+C', down: false });
  return out;
}

/** Handles one /api/cursor/* request. Returns true when it did. */
export async function handleCursor(req, res, url) {
  const path = url.pathname.replace(/\/$/, '');
  calls.push({ method: req.method, path });
  if (req.headers['x-capstan-token'] !== TOKEN) return json(res, 403, { error: 'Invalid session' }), true;
  const known = ['/api/cursor/start', '/api/cursor/stop', '/api/cursor/pause', '/api/cursor/resume', '/api/cursor/status', '/api/cursor/test-inject'];
  if (!known.includes(path)) return fail(res, 404, 'not-found', 'Route not found.'), true;
  if (path === '/api/cursor/status') {
    if (req.method !== 'GET') return fail(res, 405, 'method', 'Use GET.'), true;
    const s = session;
    return json(res, 200, { ok: true, available: true, active: !!s, paused: !!s?.pausedAt, keys: !!s?.keys, recordingId: s?.id ?? null, seconds: s ? r4(elapsed(s)) : 0, maxSeconds: s ? 14400 : 0, testInput: true }), true;
  }
  if (req.method !== 'POST') return fail(res, 405, 'method', 'Use POST.'), true;
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return fail(res, 415, 'content-type', 'Send application/json.'), true;
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) return fail(res, 413, 'too-large', 'The request is too large.'), true;
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'bad-request', 'The request body must be a JSON object.'), true;

  if (path === '/api/cursor/test-inject') {
    return json(res, 200, { ok: true, moves: Array.isArray(body.moves) ? body.moves.length : 0, holds: Array.isArray(body.holds) ? body.holds.length : 0 }), true;
  }
  if (path === '/api/cursor/start') {
    const b = body.bounds;
    if (typeof body.recordingId !== 'string' || !ID.test(body.recordingId) || RESERVED.test(body.recordingId)) return fail(res, 400, 'bad-request', 'The recording id is not valid.'), true;
    if (!b || !num(b.x) || !num(b.y) || !num(b.width) || !num(b.height) || b.width < 1 || b.height < 1) return fail(res, 400, 'bad-request', 'The capture bounds are not valid.'), true;
    if (body.keys !== undefined && typeof body.keys !== 'boolean') return fail(res, 400, 'bad-request', 'keys must be true or false.'), true;
    if (session) return fail(res, 409, 'busy', 'A cursor session is already running.'), true;
    if (written.has(body.recordingId)) return fail(res, 409, 'exists', 'A cursor file for this recording already exists.'), true;
    session = { handle: randomBytes(16).toString('hex'), id: body.recordingId, bounds: b, keys: body.keys === true, startedAt: performance.now(), pausedTotal: 0, pausedAt: 0 };
    return json(res, 200, { ok: true, session: session.handle, recordingId: session.id, keys: session.keys, originEpochMs: Date.now(), hostElapsedMs: r4(performance.now() - session.startedAt), maxSeconds: 14400, testInput: true }), true;
  }
  // pause, resume, stop name the session.
  if (typeof body.session !== 'string' || !body.session || body.session.length > 64) return fail(res, 400, 'bad-request', 'session is required.'), true;
  if (!session || body.session !== session.handle) return fail(res, 404, 'not-found', 'There is no such cursor session.'), true;
  if (path === '/api/cursor/pause') {
    if (!session.pausedAt) session.pausedAt = performance.now();
    return json(res, 200, { ok: true, paused: true }), true;
  }
  if (path === '/api/cursor/resume') {
    if (session.pausedAt) {
      session.pausedTotal += performance.now() - session.pausedAt;
      session.pausedAt = 0;
    }
    return json(res, 200, { ok: true, paused: false }), true;
  }
  const s = session;
  session = null;
  if (body.discard === true) return json(res, 200, { ok: true, discarded: true }), true;
  written.add(s.id);
  return json(res, 200, JSON.stringify(syntheticSidecar(elapsed(s), s.keys))), true;
}
