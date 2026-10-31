// Node mirror of modules/Speech.ps1 for the browser e2e tests (tests/serve.mjs hands /api/speech/* here).
// Same paths, status codes and JSON shapes as the PowerShell host, with the fake engine only. Nothing here
// recognises speech: it returns the same deterministic segments as Capstan.Speech.FakeRecogniser.
import { randomBytes } from 'node:crypto';

const MAX_BYTES = 30_000_000;
const state = { cultures: ['en-US', 'en-GB'], delayMs: 0, jobs: new Map(), requests: [] };

const send = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));
const fail = (res, status, code, error) => send(res, status, { error, code });

/** Same checks as Capstan.Speech.Wav.Check: mono, 16 kHz, 16-bit PCM with audio in it. */
function checkWav(buf) {
  const wrong = 'Send a mono 16 kHz 16-bit PCM WAV file.';
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return { problem: wrong };
  let format = false;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + size > buf.length) return { problem: wrong };
      if (buf.readUInt16LE(body) !== 1 || buf.readUInt16LE(body + 2) !== 1 || buf.readUInt32LE(body + 4) !== 16000 || buf.readUInt16LE(body + 14) !== 16) return { problem: wrong };
      format = true;
    } else if (id === 'data') {
      if (!format) return { problem: wrong };
      if (size < 3200) return { problem: 'The WAV file holds less than 0.1 seconds of audio.' };
      if (body + size > buf.length) return { problem: 'The WAV file is cut short.' };
      return { seconds: size / 32000 };
    }
    at = body + size + (size & 1);
  }
  return { problem: wrong };
}

const fakeSegments = (seconds) => {
  const words = ['This is the first fake caption.', 'This is the second fake caption.', 'This is the third fake caption.'];
  const count = seconds >= 0.6 ? 3 : 1;
  const part = seconds / count;
  const round2 = (n) => Math.round(n * 100) / 100;
  return Array.from({ length: count }, (_, i) => ({ start: round2(i * part), end: round2((i + 1) * part - (count > 1 ? 0.1 : 0)), text: words[i], confidence: 0.9 }));
};

function view(job) {
  const now = Date.now();
  if (job.state === 'running') {
    job.progress = Math.min(0.99, job.delayMs ? (now - job.started) / job.delayMs : 0);
    if (now - job.started >= job.delayMs) {
      job.state = 'done';
      job.progress = 1;
    }
  }
  const out = { job: job.id, state: job.state, progress: job.progress, engine: 'fake', culture: job.culture };
  if (job.state === 'done') out.segments = fakeSegments(job.seconds);
  if (job.state === 'cancelled') Object.assign(out, { code: 'cancelled', error: 'Transcription was cancelled.' });
  return out;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Returns true when the request was an /api/speech/ or /api/test/speech one and has been answered. */
export async function handleSpeech(req, res, url) {
  if (url.pathname === '/api/test/speech') {
    // Test-only: set the installed cultures and a fake delay; GET returns what the page sent so far.
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (Array.isArray(body.cultures)) state.cultures = body.cultures;
      if (typeof body.delayMs === 'number') state.delayMs = body.delayMs;
      state.requests.length = 0;
    }
    send(res, 200, { cultures: state.cultures, delayMs: state.delayMs, requests: state.requests });
    return true;
  }
  if (!url.pathname.startsWith('/api/speech/')) return false;
  if (req.headers['x-capstan-token'] !== 'test-token') return send(res, 403, { error: 'Invalid session' }), true;
  const { pathname } = url;
  if (pathname === '/api/speech/status' && req.method === 'GET') {
    send(res, 200, { engine: 'fake', available: true, cultures: state.cultures, maxBytes: MAX_BYTES });
    return true;
  }
  if (pathname === '/api/speech/transcribe' && req.method === 'POST') {
    const body = await readBody(req);
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(type)) return fail(res, 400, 'unsupported-type', 'Send the audio as a WAV file (Content-Type: audio/wav).'), true;
    if (body.length > MAX_BYTES) return fail(res, 413, 'too-big', 'This audio is too big for one request (30 MB, about 15 minutes).'), true;
    const culture = url.searchParams.get('culture') || 'en-US';
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(culture)) return fail(res, 400, 'bad-culture', 'The language must look like en-US.'), true;
    const installed = state.cultures.find((c) => c.toLowerCase() === culture.toLowerCase()) ?? state.cultures.find((c) => c.split('-')[0].toLowerCase() === culture.split('-')[0].toLowerCase());
    if (!installed) return fail(res, 501, 'no-recogniser', `No Windows speech recogniser is installed for ${culture}. Add the language in Settings > Time & language > Language & region, include its Speech recognition feature, then start Capstan again.`), true;
    const checked = checkWav(body);
    if (checked.problem) return fail(res, 400, 'unsupported-format', checked.problem), true;
    if ([...state.jobs.values()].some((j) => view(j).state === 'running')) return fail(res, 409, 'busy', 'Another transcription is still running. Wait for it or cancel it.'), true;
    const job = { id: randomBytes(16).toString('hex'), state: 'running', progress: 0, culture: installed, seconds: checked.seconds, delayMs: state.delayMs, started: Date.now() };
    state.jobs.set(job.id, job);
    state.requests.push({ culture, bytes: body.length, seconds: checked.seconds });
    send(res, 200, view(job));
    return true;
  }
  const m = /^\/api\/speech\/([0-9a-f]{32})$/.exec(pathname);
  if (m && (req.method === 'GET' || req.method === 'DELETE')) {
    const job = state.jobs.get(m[1]);
    if (!job) return fail(res, 404, 'not-found', 'There is no such transcription.'), true;
    if (req.method === 'GET') return send(res, 200, view(job)), true;
    if (view(job).state === 'running') job.state = 'cancelled';
    else state.jobs.delete(job.id);
    send(res, 200, { ok: true, job: job.id, state: job.state });
    return true;
  }
  fail(res, 404, 'not-found', 'Route not found');
  return true;
}
