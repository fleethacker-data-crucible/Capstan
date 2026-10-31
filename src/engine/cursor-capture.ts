// Cursor and shortcut capture from the page's side: the client for the host's /api/cursor routes, and the
// pure clock and bounds arithmetic around it. The host (modules/CursorCapture.ps1) does the capturing;
// this file starts and stops it around a recording and lines its clock up with the video's.
// What is captured and what never is: docs/cursor-data.md ("Capture").
import { type CursorData, CursorFormatError, parseSidecar } from './cursor';

export interface CaptureBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The file name rule the host enforces: a letter or digit, then up to 63 letters, digits, `_` or `-`. */
export const RECORDING_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** `rec-20261031-143012-a1b2c3d4`: sorts by time and cannot collide with another recording. */
export function newRecordingId(date: Date = new Date(), random: () => number = Math.random): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  let tail = '';
  while (tail.length < 8) tail += Math.floor(random() * 36).toString(36);
  return `rec-${stamp}-${tail}`;
}

/** The parts of `window.screen` this needs (the position fields are Chromium extras). */
export interface ScreenLike {
  width: number;
  height: number;
  availLeft?: number;
  availTop?: number;
  isExtended?: boolean;
}

/**
 * The shared monitor in screen pixels, assuming it is the one the Capstan window is on: its size is
 * `screen` times the device pixel ratio, and with several screens its origin is `availLeft/availTop`.
 * Null when the size is unknown. A browser cannot say where a shared WINDOW or TAB is, so capture is
 * only offered for the entire screen.
 */
export function monitorBounds(screen: ScreenLike, dpr: number): CaptureBounds | null {
  if (!(screen.width > 0) || !(screen.height > 0)) return null;
  const k = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const left = screen.isExtended && Number.isFinite(screen.availLeft) ? (screen.availLeft as number) : 0;
  const top = screen.isExtended && Number.isFinite(screen.availTop) ? (screen.availTop as number) : 0;
  return { x: Math.round(left * k), y: Math.round(top * k), width: Math.round(screen.width * k), height: Math.round(screen.height * k) };
}

// ---- clock alignment -----------------------------------------------------------------------------

/**
 * Where the host's session clock started, on the page's `performance.now()` clock (milliseconds).
 * The page sent the start request at `sentAt` and had the answer at `receivedAt`; the host built the
 * answer `hostElapsedMs` after its clock started. Assuming the request and the answer took equally
 * long, the answer was built at the midpoint, so the host's origin is `hostElapsedMs` before that.
 */
export function clockOrigin(sentAt: number, receivedAt: number, hostElapsedMs: number): number {
  return (sentAt + receivedAt) / 2 - hostElapsedMs;
}

/**
 * Seconds to subtract from a host time to get the time on the recording. The host started at
 * `hostOrigin` and the recording at `mediaStart` (both `performance.now()` values, milliseconds);
 * positive when the host started first, which is the normal case.
 */
export function sidecarShift(hostOrigin: number, mediaStart: number): number {
  return (mediaStart - hostOrigin) / 1000;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/**
 * Moves host times onto the recording's timeline (`t - shift`) and cuts them to 0..duration. A sample
 * pair that straddles a cut gets a new sample on the cut, so the cursor is where it was at that moment.
 * Null when nothing is left.
 */
export function alignCursor(data: CursorData, shift: number, duration: number): CursorData | null {
  const end = Number.isFinite(duration) && duration >= 0 ? duration : Infinity;
  const moved = data.samples.map((s) => ({ t: s.t - shift, x: s.x, y: s.y }));
  const samples: CursorData['samples'] = [];
  for (let i = 0; i < moved.length; i++) {
    const s = moved[i];
    if (s.t < 0) {
      const next = moved[i + 1];
      if (next && next.t > 0) {
        const u = -s.t / (next.t - s.t);
        samples.push({ t: 0, x: lerp(s.x, next.x, u), y: lerp(s.y, next.y, u) });
      }
      continue;
    }
    if (s.t > end) {
      const prev = moved[i - 1];
      if (prev && prev.t < end) {
        const u = (end - prev.t) / (s.t - prev.t);
        samples.push({ t: end, x: lerp(prev.x, s.x, u), y: lerp(prev.y, s.y, u) });
      }
      break;
    }
    samples.push(s);
  }
  const within = <T extends { t: number }>(list: T[]): T[] =>
    list.map((e) => ({ ...e, t: e.t - shift })).filter((e) => e.t >= 0 && e.t <= end);
  const clicks = within(data.clicks);
  const keys = within(data.keys);
  if (!samples.length && !clicks.length && !keys.length) return null;
  return { samples, clicks, keys };
}

// ---- the host client -----------------------------------------------------------------------------

export class CursorHostError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = '',
  ) {
    super(message);
    this.name = 'CursorHostError';
  }
}

export interface CursorClientOptions {
  /** The per-launch session token (`sessionToken()` in ui/lifecycle.ts). Empty when no host serves the page. */
  token: string;
  fetch?: typeof fetch;
  /** Milliseconds on the page's monotonic clock; `performance.now` by default. */
  now?: () => number;
}

interface StartAnswer {
  session: string;
  hostElapsedMs: number;
  originEpochMs: number;
}

export const HOST_MISSING = 'Cursor capture needs the Capstan host (start Capstan with Launch-Capstan.bat), so the pointer was recorded normally.';

/** Talks to /api/cursor/* for one recording. */
export class CursorCapture {
  private readonly token: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private session = '';
  private hostOrigin = NaN;
  private mediaStart = NaN;
  private stopping = false;

  constructor(opts: CursorClientOptions) {
    this.token = opts.token;
    this.doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = opts.now ?? (() => performance.now());
  }

  get active(): boolean {
    return this.session !== '';
  }

  /** The host's clock origin on the page clock, once started (milliseconds). */
  get origin(): number {
    return this.hostOrigin;
  }

  private async call(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Response> {
    if (!this.token) throw new CursorHostError(HOST_MISSING);
    let res: Response;
    try {
      res = await this.doFetch(path, {
        method,
        headers: { 'X-Capstan-Token': this.token, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
    } catch {
      throw new CursorHostError('The Capstan host did not answer.');
    }
    if (res.ok) return res;
    let message = `The Capstan host refused the request (${res.status}).`;
    let code = '';
    try {
      const j = (await res.json()) as { error?: string; code?: string };
      if (typeof j.error === 'string') message = j.error;
      if (typeof j.code === 'string') code = j.code;
    } catch {
      /* keep the generic message */
    }
    throw new CursorHostError(message, res.status, code);
  }

  /** Null when capture can be used, otherwise a sentence saying why not. */
  async probe(): Promise<string | null> {
    try {
      const res = await this.call('/api/cursor/status', 'GET');
      const j = (await res.json()) as { available?: boolean; active?: boolean };
      if (j.available !== true) return 'Cursor capture is not available on this computer, so the pointer was recorded normally.';
      if (j.active) return 'Another cursor capture is still running. Stop it first, or restart Capstan.';
      return null;
    } catch (e) {
      return e instanceof CursorHostError && e.message !== HOST_MISSING ? `${e.message} The pointer was recorded normally.` : HOST_MISSING;
    }
  }

  /**
   * Starts the host session and works out where its clock is on the page's. Call it just before the
   * recorder starts (the exact moment the recorder starts is given to `mediaStarted`).
   */
  async start(recordingId: string, bounds: CaptureBounds, keys: boolean): Promise<void> {
    if (this.session) throw new CursorHostError('Cursor capture is already running.');
    const sentAt = this.now();
    const res = await this.call('/api/cursor/start', 'POST', { recordingId, bounds, keys });
    const receivedAt = this.now();
    const j = (await res.json()) as Partial<StartAnswer>;
    if (typeof j.session !== 'string' || typeof j.hostElapsedMs !== 'number') throw new CursorHostError('The Capstan host gave an unexpected answer.');
    this.session = j.session;
    this.hostOrigin = clockOrigin(sentAt, receivedAt, j.hostElapsedMs);
  }

  /** The recorder started at this `performance.now()` value. */
  mediaStarted(at: number): void {
    this.mediaStart = at;
  }

  /** Pause and resume the host's sampling together with the recording. Failures are not fatal: the data just keeps running. */
  async pause(): Promise<void> {
    if (this.session) await this.call('/api/cursor/pause', 'POST', { session: this.session }).catch(() => undefined);
  }

  async resume(): Promise<void> {
    if (this.session) await this.call('/api/cursor/resume', 'POST', { session: this.session }).catch(() => undefined);
  }

  /** Stops the host session now and returns the sidecar text it produced. Call `collect` with it once the recording length is known. */
  async stop(): Promise<string> {
    if (!this.session) throw new CursorHostError('Cursor capture is not running.');
    const session = this.session;
    this.stopping = true;
    try {
      const res = await this.call('/api/cursor/stop', 'POST', { session });
      return await res.text();
    } finally {
      this.session = '';
      this.stopping = false;
    }
  }

  /** Gives up: the host stops and writes nothing. */
  async cancel(): Promise<void> {
    if (!this.session || this.stopping) return;
    const session = this.session;
    this.session = '';
    await this.call('/api/cursor/stop', 'POST', { session, discard: true }).catch(() => undefined);
  }

  /** Reads the sidecar text and puts it on the recording's clock. Throws a readable error when it is unusable. */
  collect(text: string, seconds: number): CursorData {
    let data: CursorData;
    try {
      data = parseSidecar(text);
    } catch (e) {
      throw new CursorHostError(e instanceof CursorFormatError ? `The cursor data was not usable: ${e.message}` : 'The cursor data was not usable.');
    }
    const shift = Number.isFinite(this.mediaStart) && Number.isFinite(this.hostOrigin) ? sidecarShift(this.hostOrigin, this.mediaStart) : 0;
    const aligned = alignCursor(data, shift, seconds);
    if (!aligned) throw new CursorHostError('No cursor activity was captured during the recording.');
    return aligned;
  }
}
