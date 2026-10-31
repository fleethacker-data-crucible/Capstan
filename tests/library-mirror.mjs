// Test-only mirror of the PowerShell host's /api/files routes (modules/Library.ps1): same paths, status
// codes and JSON shapes, files in a temp folder that lives as long as the test server. Not shipped.
// A browser context with cleared IndexedDB but the same server still finds its media here, which is what
// tests/e2e/library-host.e2e.mjs checks.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHUNK_MAX = 8 * 1024 * 1024;
const CHUNK_MIN = 65536;
const MAX_BYTES = Number(process.env.CAPSTAN_LIBRARY_MAX_BYTES ?? 16 * 1024 ** 3);
const MAX_UPLOADS = 4;
const ID = /^[a-z0-9_-]{1,80}$/;
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', 'conin', 'conout', 'clock', ...Array.from({ length: 10 }, (_, i) => `com${i}`), ...Array.from({ length: 10 }, (_, i) => `lpt${i}`)]);

const dir = join(tmpdir(), `capstan-test-library-${process.pid}-${randomBytes(3).toString('hex')}`);
const uploads = join(dir, '.uploads');
await mkdir(uploads, { recursive: true });
process.on('exit', () => void rm(dir, { recursive: true, force: true }).catch(() => undefined));
const active = new Map();
// Test hook: the next N chunk uploads answer 500 (checks that the page reports a failed copy and keeps working).
let failNext = 0;
export function failNextChunks(n) {
  failNext = n;
}

/** Test hook: empties the library, so a test is not affected by what earlier tests on the same server stored. */
export async function resetLibrary() {
  failNext = 0;
  active.clear();
  for (const name of await readdir(dir)) if (name !== '.uploads') await rm(join(dir, name), { recursive: true, force: true });
  for (const name of await readdir(uploads)) await rm(join(uploads, name), { recursive: true, force: true });
}

const validId = (id) => ID.test(id) && !RESERVED.has(id);
const json = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(text);
};
const error = (res, status, code, message, headers) => json(res, status, { error: message, code }, headers);
async function readJson(req, res) {
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > 4096) {
    req.resume();
    error(res, 413, 'body_too_large', 'Request body too large');
    return undefined;
  }
  if (length === 0) return null;
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    req.resume();
    error(res, 415, 'content_type', 'Content-Type must be application/json');
    return undefined;
  }
  let raw = '';
  for await (const c of req) raw += c;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {
    /* falls through */
  }
  error(res, 400, 'bad_json', 'The body must be a JSON object');
  return undefined;
}
async function drop(id) {
  const u = active.get(id);
  if (!u) return false;
  active.delete(id);
  await rm(u.temp, { force: true });
  return true;
}
async function sha256(file) {
  const h = createHash('sha256');
  for await (const c of createReadStream(file)) h.update(c);
  return h.digest('hex');
}
function parseRange(header, length) {
  const m = /^bytes=(\d{0,18})-(\d{0,18})$/.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n <= 0 || length <= 0) return null;
    const start = Math.max(0, length - n);
    return { start, end: length - 1 };
  }
  const start = Number(m[1]);
  if (start >= length) return null;
  const end = m[2] === '' ? length - 1 : Math.min(Number(m[2]), length - 1);
  return end < start ? null : { start, end };
}

/** Handles /api/files and /api/files/<id>[/complete]. The server checks nothing before this except the path. */
export async function handleLibrary(req, res, url, { port, token }) {
  if (req.headers['x-capstan-token'] !== token) return error(res, 403, 'forbidden', 'Invalid session');
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}`) return error(res, 403, 'forbidden', 'Origin is not authorized');
  const m = /^\/api\/files(?:\/([^/]*?)(?:\/(complete))?)?$/.exec(url.pathname);
  if (!m) return error(res, 404, 'not_found', 'Route not found');
  const [, id, complete] = m;
  const method = req.method;
  if (id === undefined) {
    if (method === 'GET') {
      const files = [];
      for (const name of await readdir(dir)) {
        if (!validId(name)) continue;
        const s = await stat(join(dir, name));
        if (s.isFile()) files.push({ id: name, size: s.size, modified: s.mtime.toISOString() });
      }
      files.sort((a, b) => b.modified.localeCompare(a.modified));
      return json(res, 200, { files, count: files.length });
    }
    if (method === 'POST') return start(req, res);
    return error(res, 405, 'method', 'Method not allowed');
  }
  if (!validId(id)) {
    req.resume();
    return error(res, 400, 'bad_id', 'The id must be 1 to 80 characters of a-z, 0-9, _ or -');
  }
  if (complete) return method === 'POST' ? finish(req, res, id) : error(res, 405, 'method', 'Method not allowed');
  if (method === 'PUT') return part(req, res, id, url);
  if (method === 'GET') return download(req, res, id);
  if (method === 'DELETE') {
    const uploadOnly = url.searchParams.get('upload') !== null && url.searchParams.get('upload') !== '';
    let removed = await drop(id);
    if (!uploadOnly) {
      try {
        await rm(join(dir, id));
        removed = true;
      } catch {
        /* not stored */
      }
    }
    return removed ? json(res, 200, { ok: true, id }) : error(res, 404, 'not_found', 'Nothing to remove for this id');
  }
  return error(res, 405, 'method', 'Method not allowed');
}

async function start(req, res) {
  const body = await readJson(req, res);
  if (body === undefined) return;
  if (body === null) return error(res, 400, 'bad_json', 'The body must be a JSON object');
  const { id, size, sha256: sum, chunkSize } = body;
  if (typeof id !== 'string' || !validId(id)) return error(res, 400, 'bad_id', 'The id must be 1 to 80 characters of a-z, 0-9, _ or -');
  if (!Number.isInteger(size) || size < 1) return error(res, 400, 'bad_size', 'The size must be a whole number of bytes, at least 1');
  if (size > MAX_BYTES) return error(res, 413, 'too_large', 'The file is larger than the library accepts');
  if (sum !== undefined && sum !== null && !(typeof sum === 'string' && /^[0-9a-fA-F]{64}$/.test(sum))) return error(res, 400, 'bad_sha256', 'sha256 must be 64 hexadecimal characters');
  const chunk = chunkSize ?? CHUNK_MAX;
  if (!Number.isInteger(chunk) || chunk < CHUNK_MIN || chunk > CHUNK_MAX) return error(res, 400, 'bad_chunk', `chunkSize must be between ${CHUNK_MIN} and ${CHUNK_MAX}`);
  const parts = Math.ceil(size / chunk);
  const hash = typeof sum === 'string' ? sum.toLowerCase() : null;
  const existing = active.get(id);
  if (existing) {
    if (existing.size !== size || existing.chunk !== chunk || (hash && existing.sha && existing.sha !== hash)) return error(res, 409, 'upload_exists', 'An upload of this id is under way with different settings; delete it first');
    if (hash && !existing.sha) existing.sha = hash;
    existing.last = Date.now();
    return json(res, 200, { id, size, chunkSize: chunk, parts, received: [...existing.received].sort((a, b) => a - b), resumed: true });
  }
  if (active.size >= MAX_UPLOADS) return error(res, 429, 'too_many_uploads', 'Too many uploads are under way; try again shortly');
  const temp = join(uploads, `${id}.part`);
  await (await open(temp, 'w')).close();
  active.set(id, { id, size, chunk, parts, sha: hash, temp, received: new Set(), last: Date.now() });
  return json(res, 200, { id, size, chunkSize: chunk, parts, received: [], resumed: false });
}

async function part(req, res, id, url) {
  const u = active.get(id);
  const refuse = (...args) => {
    req.resume();
    return error(res, ...args);
  };
  if (!u) return refuse(404, 'no_upload', 'No upload is under way for this id');
  if (!/^application\/octet-stream\b/i.test(req.headers['content-type'] ?? '')) return refuse(415, 'content_type', 'Content-Type must be application/octet-stream');
  const text = url.searchParams.get('part') ?? '';
  if (!/^[0-9]{1,9}$/.test(text) || Number(text) >= u.parts) return refuse(400, 'bad_part', 'part must be a number below the part count');
  const n = Number(text);
  const length = Number(req.headers['content-length'] ?? -1);
  if (length > CHUNK_MAX) return refuse(413, 'chunk_too_large', 'A chunk is at most 8 MB');
  const expected = n < u.parts - 1 ? u.chunk : u.size - n * u.chunk;
  if (length !== expected) return refuse(400, 'bad_part_length', 'The chunk has the wrong length for this part');
  if (failNext > 0) {
    failNext--;
    return refuse(500, 'failed', 'The library request failed');
  }
  u.last = Date.now();
  const file = await open(u.temp, 'r+');
  let pos = n * u.chunk;
  let got = 0;
  try {
    for await (const c of req) {
      await file.write(c, 0, c.length, pos);
      pos += c.length;
      got += c.length;
    }
  } catch {
    got = -1;
  } finally {
    await file.close();
  }
  if (got !== expected) return error(res, 400, 'upload_interrupted', 'The chunk did not arrive completely; send this part again');
  u.received.add(n);
  return json(res, 200, { ok: true, part: n, received: u.received.size, parts: u.parts });
}

async function finish(req, res, id) {
  const u = active.get(id);
  if (!u) {
    req.resume();
    return error(res, 404, 'no_upload', 'No upload is under way for this id');
  }
  const body = await readJson(req, res);
  if (body === undefined) return;
  const given = body?.sha256;
  if (given !== undefined && given !== null) {
    if (typeof given !== 'string' || !/^[0-9a-fA-F]{64}$/.test(given)) return error(res, 400, 'bad_sha256', 'sha256 must be 64 hexadecimal characters');
    if (u.sha && u.sha !== given.toLowerCase()) return error(res, 400, 'bad_sha256', 'sha256 differs from the one given at the start');
    u.sha = given.toLowerCase();
  }
  if (u.received.size !== u.parts) {
    const missing = [];
    for (let i = 0; i < u.parts && missing.length < 100; i++) if (!u.received.has(i)) missing.push(i);
    return json(res, 409, { error: 'Parts are missing', code: 'incomplete', missing });
  }
  if ((await stat(u.temp)).size !== u.size) {
    await drop(id);
    return error(res, 409, 'size_mismatch', 'The stored size does not match the announced size; start the upload again');
  }
  let actual;
  if (u.sha) {
    actual = await sha256(u.temp);
    if (actual !== u.sha) {
      await drop(id);
      return error(res, 422, 'checksum_mismatch', 'The file does not match its SHA-256; it was discarded');
    }
  }
  await rename(u.temp, join(dir, id));
  active.delete(id);
  return json(res, 200, { ok: true, id, size: u.size, ...(actual ? { sha256: actual } : {}) });
}

async function download(req, res, id) {
  let size;
  try {
    const s = await stat(join(dir, id));
    if (!s.isFile()) throw new Error('not a file');
    size = s.size;
  } catch {
    return error(res, 404, 'not_found', 'No such file in the library');
  }
  let start = 0;
  let end = size - 1;
  let status = 200;
  const headers = { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes', 'content-disposition': `attachment; filename="${id}"` };
  const range = req.headers.range;
  if (range) {
    const r = parseRange(range, size);
    if (!r) return error(res, 416, 'bad_range', 'The requested range cannot be served', { 'content-range': `bytes */${size}` });
    ({ start, end } = r);
    status = 206;
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['content-length'] = String(Math.max(0, end - start + 1));
  res.writeHead(status, headers);
  if (size === 0) return res.end();
  createReadStream(join(dir, id), { start, end, highWaterMark: 1024 * 1024 }).pipe(res);
}
