// Recorded cursor data and the effects drawn from it: smoothing, highlight, magnify, spotlight,
// click rings, key callouts. Owned by the cursor area. Positions are fractions of the recorded frame.
//
// Where the data comes from: a browser cannot read the OS cursor or the keyboard while another app
// is being recorded, so Capstan does not capture it itself. The data is loaded from a sidecar file
// (`<name>.cursor.json`, see docs/cursor-data.md) written by a low-level hook host. Until that host
// exists the file can be produced by any tool that follows the format. Nothing here invents data.
import { type KeyCallout, drawKeyCallouts, keyCallouts } from './cursorkeys';
import { drawCursorShape } from './cursorshapes';

export interface CursorSample {
  t: number;
  x: number;
  y: number;
}

export type CursorButton = 'left' | 'right' | 'middle';

export interface CursorClick {
  t: number;
  button: CursorButton;
  down: boolean;
}

export interface CursorKey {
  t: number;
  key: string;
  down: boolean;
}

/** Cursor activity recorded alongside a screen recording; times are seconds into that media. */
export interface CursorData {
  samples: CursorSample[];
  clicks: CursorClick[];
  keys: CursorKey[];
}

export type CursorShape = 'arrow' | 'hand' | 'pointer';
export const CURSOR_SHAPES: CursorShape[] = ['arrow', 'hand', 'pointer'];

/** How the cursor is re-drawn over the recording. Sizes are fractions of the clip's height. */
export interface CursorFx {
  /** Master switch: off keeps every setting but draws nothing. */
  enabled: boolean;
  /** Draw a cursor over the recording (turn off to hide it). */
  showCursor: boolean;
  shape: CursorShape;
  /** 0.5..4 times the normal cursor size. */
  size: number;
  /** Fill colour of the built-in shapes. */
  color: string;
  /** 0 = follow the samples exactly, 1 = very smooth. */
  smoothing: number;
  /** Replacement cursor picture (PNG, SVG, WebP or JPEG as a data URL), or undefined for the built-in shapes. */
  image?: string;
  /** Where the image's click point is, as fractions of its width and height. */
  imageHotX: number;
  imageHotY: number;
  highlight: boolean;
  highlightSize: number;
  highlightColor: string;
  highlightOpacity: number;
  magnify: boolean;
  magnifyZoom: number;
  magnifySize: number;
  spotlight: boolean;
  spotlightSize: number;
  spotlightDim: number;
  clickRings: boolean;
  clickColor: string;
  clickSize: number;
  clickDuration: number;
  clickSound: boolean;
  clickVolume: number;
  keys: boolean;
  /** Seconds a key bubble stays after the last key. */
  keysHold: number;
  keysSize: number;
}

export const DEFAULT_CURSOR_FX: CursorFx = {
  enabled: true,
  showCursor: false,
  shape: 'arrow',
  size: 1,
  color: '#ffffff',
  smoothing: 0.35,
  imageHotX: 0,
  imageHotY: 0,
  highlight: false,
  highlightSize: 0.07,
  highlightColor: '#ffd400',
  highlightOpacity: 0.35,
  magnify: false,
  magnifyZoom: 2,
  magnifySize: 0.12,
  spotlight: false,
  spotlightSize: 0.2,
  spotlightDim: 0.6,
  clickRings: false,
  clickColor: '#3ea6ff',
  clickSize: 0.06,
  clickDuration: 0.6,
  clickSound: false,
  clickVolume: 0.5,
  keys: false,
  keysHold: 1.5,
  keysSize: 1,
};

export const CURSOR_LIMITS = {
  samples: 120_000,
  clicks: 20_000,
  keys: 50_000,
  /** Latest time accepted (seconds): 24 hours. */
  seconds: 86_400,
  /** Largest sidecar file read, in characters. */
  sidecarChars: 24 * 1024 * 1024,
  keyName: 24,
  /** Largest replacement cursor image, as data URL characters (about 256 KB of file). */
  imageChars: 350_000,
};

export const SIDECAR_FORMAT = 'capstan-cursor';
export const SIDECAR_SUFFIX = '.cursor.json';

export class CursorFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorFormatError';
  }
}

// ---- parsing --------------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const BUTTONS: CursorButton[] = ['left', 'right', 'middle'];

interface Read {
  data: CursorData;
  problems: string[];
}

function readList<T>(input: unknown, label: string, cap: number, problems: string[], one: (v: unknown) => T | string): T[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    problems.push(`${label} must be a list`);
    return [];
  }
  if (input.length > cap) {
    problems.push(`${label}: ${input.length} entries is more than the limit of ${cap}`);
    return [];
  }
  const out: T[] = [];
  let bad = 0;
  input.forEach((v, i) => {
    const r = one(v);
    if (typeof r === 'string') {
      if (bad++ < 3) problems.push(`${label}[${i}]: ${r}`);
    } else out.push(r);
  });
  if (bad > 3) problems.push(`${label}: ${bad - 3} more invalid entries`);
  return out;
}

const time = (v: unknown): number | string => (isNum(v) && v >= 0 && v <= CURSOR_LIMITS.seconds ? v : 'time must be a number of seconds from 0 to 86400');
const byTime = <T extends { t: number }>(a: T[]): T[] => (a.every((v, i) => i === 0 || a[i - 1].t <= v.t) ? a : [...a].sort((p, q) => p.t - q.t));

/** Reads the three lists, collecting problems instead of throwing. Times come out sorted. */
function readCursor(input: unknown): Read {
  const problems: string[] = [];
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  if (!o) return { data: { samples: [], clicks: [], keys: [] }, problems: ['cursor data must be an object'] };
  const samples = readList<CursorSample>(o.samples, 'samples', CURSOR_LIMITS.samples, problems, (v) => {
    const [t, x, y] = Array.isArray(v) ? v : v && typeof v === 'object' ? [(v as CursorSample).t, (v as CursorSample).x, (v as CursorSample).y] : [];
    const tt = time(t);
    if (typeof tt === 'string') return tt;
    if (!isNum(x) || !isNum(y)) return 'x and y must be numbers (fractions of the frame)';
    return { t: tt, x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
  });
  const clicks = readList<CursorClick>(o.clicks, 'clicks', CURSOR_LIMITS.clicks, problems, (v) => {
    if (!v || typeof v !== 'object') return 'must be an object';
    const c = v as Record<string, unknown>;
    const tt = time(c.t);
    if (typeof tt === 'string') return tt;
    const button = c.button === undefined ? 'left' : c.button;
    if (!BUTTONS.includes(button as CursorButton)) return 'button must be left, right or middle';
    if (c.down !== undefined && typeof c.down !== 'boolean') return 'down must be true or false';
    return { t: tt, button: button as CursorButton, down: c.down !== false };
  });
  const keys = readList<CursorKey>(o.keys, 'keys', CURSOR_LIMITS.keys, problems, (v) => {
    if (!v || typeof v !== 'object') return 'must be an object';
    const k = v as Record<string, unknown>;
    const tt = time(k.t);
    if (typeof tt === 'string') return tt;
    if (typeof k.key !== 'string' || !k.key || k.key.length > CURSOR_LIMITS.keyName) return `key must be a name of 1 to ${CURSOR_LIMITS.keyName} characters`;
    if (k.down !== undefined && typeof k.down !== 'boolean') return 'down must be true or false';
    return { t: tt, key: k.key, down: k.down !== false };
  });
  return { data: { samples: byTime(samples), clicks: byTime(clicks), keys: byTime(keys) }, problems };
}

/** Validates stored cursor data. Invalid entries are dropped; undefined when nothing usable is left or a cap is exceeded. */
export function parseCursorData(input: unknown): CursorData | undefined {
  const { data, problems } = readCursor(input);
  if (problems.some((p) => p.includes('limit of') || p.includes('must be a list') || p.includes('must be an object'))) return undefined;
  return data.samples.length || data.clicks.length || data.keys.length ? data : undefined;
}

/** Reads a `.cursor.json` sidecar. Throws CursorFormatError naming the first problems; any invalid entry rejects the file. */
export function parseSidecar(text: string): CursorData {
  if (text.length > CURSOR_LIMITS.sidecarChars) throw new CursorFormatError('The cursor file is too large (limit 24 MB)');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CursorFormatError('The cursor file is not valid JSON');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new CursorFormatError('The cursor file must contain a JSON object');
  const o = json as Record<string, unknown>;
  if (o.format !== undefined && o.format !== SIDECAR_FORMAT) throw new CursorFormatError(`Unknown format "${String(o.format)}" (expected "${SIDECAR_FORMAT}")`);
  if (o.version !== 1) throw new CursorFormatError(`Unsupported cursor file version ${JSON.stringify(o.version)} (this build reads version 1)`);
  const { data, problems } = readCursor(o);
  if (problems.length) throw new CursorFormatError(problems.slice(0, 4).join('; '));
  if (!data.samples.length && !data.clicks.length && !data.keys.length) throw new CursorFormatError('The cursor file has no samples, clicks or keys');
  return data;
}

/** The sidecar text for some cursor data: samples as compact [t, x, y] triples. */
export function serializeSidecar(data: CursorData): string {
  const r = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
  return JSON.stringify({
    format: SIDECAR_FORMAT,
    version: 1,
    samples: data.samples.map((s) => [r(s.t, 4), r(s.x, 5), r(s.y, 5)]),
    clicks: data.clicks.map((c) => ({ t: r(c.t, 4), button: c.button, down: c.down })),
    keys: data.keys.map((k) => ({ t: r(k.t, 4), key: k.key, down: k.down })),
  });
}

export function isSidecarName(name: string): boolean {
  return name.toLowerCase().endsWith(SIDECAR_SUFFIX);
}

/** `talk.webm` -> `talk.cursor.json` */
export function sidecarName(mediaName: string): string {
  return mediaName.replace(/\.[^./\\]+$/, '') + SIDECAR_SUFFIX;
}

const COLOR = /^#[0-9a-f]{6}$/i;
const IMAGE_URL = /^data:image\/(png|svg\+xml|webp|jpeg);base64,[A-Za-z0-9+/=]+$/;

/** Validates stored cursor effect settings: every field is clamped or defaulted, unknown fields are dropped. */
export function parseCursorFx(input: unknown): CursorFx | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const o = input as Record<string, unknown>;
  const d = DEFAULT_CURSOR_FX;
  const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  const num = (v: unknown, def: number, lo: number, hi: number) => (isNum(v) ? clamp(v, lo, hi) : def);
  const col = (v: unknown, def: string) => (typeof v === 'string' && COLOR.test(v) ? v.toLowerCase() : def);
  const image = typeof o.image === 'string' && o.image.length <= CURSOR_LIMITS.imageChars && IMAGE_URL.test(o.image) ? o.image : undefined;
  return {
    enabled: bool(o.enabled, d.enabled),
    showCursor: bool(o.showCursor, d.showCursor),
    shape: CURSOR_SHAPES.includes(o.shape as CursorShape) ? (o.shape as CursorShape) : d.shape,
    size: num(o.size, d.size, 0.5, 4),
    color: col(o.color, d.color),
    smoothing: num(o.smoothing, d.smoothing, 0, 1),
    ...(image ? { image } : {}),
    imageHotX: num(o.imageHotX, d.imageHotX, 0, 1),
    imageHotY: num(o.imageHotY, d.imageHotY, 0, 1),
    highlight: bool(o.highlight, d.highlight),
    highlightSize: num(o.highlightSize, d.highlightSize, 0.02, 0.25),
    highlightColor: col(o.highlightColor, d.highlightColor),
    highlightOpacity: num(o.highlightOpacity, d.highlightOpacity, 0.05, 1),
    magnify: bool(o.magnify, d.magnify),
    magnifyZoom: num(o.magnifyZoom, d.magnifyZoom, 1.25, 6),
    magnifySize: num(o.magnifySize, d.magnifySize, 0.05, 0.3),
    spotlight: bool(o.spotlight, d.spotlight),
    spotlightSize: num(o.spotlightSize, d.spotlightSize, 0.05, 0.6),
    spotlightDim: num(o.spotlightDim, d.spotlightDim, 0, 0.95),
    clickRings: bool(o.clickRings, d.clickRings),
    clickColor: col(o.clickColor, d.clickColor),
    clickSize: num(o.clickSize, d.clickSize, 0.02, 0.2),
    clickDuration: num(o.clickDuration, d.clickDuration, 0.2, 2),
    clickSound: bool(o.clickSound, d.clickSound),
    clickVolume: num(o.clickVolume, d.clickVolume, 0, 1),
    keys: bool(o.keys, d.keys),
    keysHold: num(o.keysHold, d.keysHold, 0.3, 6),
    keysSize: num(o.keysSize, d.keysSize, 0.5, 2),
  };
}

// ---- positions ------------------------------------------------------------------------------

/** Index of the first sample with time > t (binary search). */
export function upperBound(list: ReadonlyArray<{ t: number }>, t: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Where the cursor is at `t`: a cubic Hermite spline through the samples (held before the first and after the last). */
export function positionAt(samples: ReadonlyArray<CursorSample>, t: number): { x: number; y: number } | null {
  const n = samples.length;
  if (!n) return null;
  const j = upperBound(samples, t); // samples[j-1].t <= t < samples[j].t
  if (j === 0) return { x: samples[0].x, y: samples[0].y };
  if (j === n) return { x: samples[n - 1].x, y: samples[n - 1].y };
  const a = samples[j - 1];
  const b = samples[j];
  const h = b.t - a.t;
  if (h < 1e-9) return { x: b.x, y: b.y };
  const p0 = samples[Math.max(0, j - 2)];
  const p3 = samples[Math.min(n - 1, j + 1)];
  const u = (t - a.t) / h;
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  const slope = (prev: CursorSample, next: CursorSample, axis: 'x' | 'y') => {
    const dt = next.t - prev.t;
    return dt < 1e-9 ? 0 : (next[axis] - prev[axis]) / dt;
  };
  const at = (axis: 'x' | 'y') => {
    const ma = slope(p0, b, axis) * h;
    const mb = slope(a, p3, axis) * h;
    return clamp(h00 * a[axis] + h10 * ma + h01 * b[axis] + h11 * mb, 0, 1);
  };
  return { x: at('x'), y: at('y') };
}

/** Longest smoothing window: strength 1 averages over about 0.6 s (sigma 0.3 s). */
export const MAX_SMOOTHING_SIGMA = 0.3;

/**
 * Smoothed cursor position: the spline path averaged with a Gaussian window of width
 * `strength * 0.3 s`. The whole recording is known, so the window is centred on `t` and the cursor
 * does not lag behind the motion. Strength 0 returns the spline itself, which passes through every
 * sample. A pure function of its inputs, so scrubbing and export always agree.
 */
export function smoothedPositionAt(samples: ReadonlyArray<CursorSample>, t: number, strength: number): { x: number; y: number } | null {
  const sigma = clamp(strength, 0, 1) * MAX_SMOOTHING_SIGMA;
  if (sigma < 1e-3) return positionAt(samples, t);
  const taps = 6;
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let i = -taps; i <= taps; i++) {
    const u = (i / taps) * 2 * sigma;
    const p = positionAt(samples, t + u);
    if (!p) return null;
    const w = Math.exp(-(u * u) / (2 * sigma * sigma));
    sx += p.x * w;
    sy += p.y * w;
    sw += w;
  }
  return { x: sx / sw, y: sy / sw };
}

/** True while any mouse button is held at `t` (looks at the latest event of each button). */
export function pressedAt(clicks: ReadonlyArray<CursorClick>, t: number): boolean {
  const seen = new Set<CursorButton>();
  for (let i = upperBound(clicks, t) - 1, steps = 0; i >= 0 && steps < 64 && seen.size < 3; i--, steps++) {
    const c = clicks[i];
    if (seen.has(c.button)) continue;
    if (c.down) return true;
    seen.add(c.button);
  }
  return false;
}

// ---- click effects --------------------------------------------------------------------------

export interface RingState {
  /** 0 at the click, 1 when the effect ends. */
  progress: number;
  /** 0..1 radius as a fraction of the full ring size (eased out). */
  radius: number;
  /** 0..1 opacity, fading to nothing. */
  alpha: number;
}

/** The ring a click at `clickTime` has at `t`, or null before the click and after `duration`. */
export function ringState(t: number, clickTime: number, duration: number): RingState | null {
  const dt = t - clickTime;
  if (dt < 0 || dt >= duration || duration <= 0) return null;
  const progress = dt / duration;
  return { progress, radius: 1 - (1 - progress) ** 3, alpha: (1 - progress) ** 1.5 };
}

/** Presses (not releases) whose ring is still showing at `t`. */
export function activeClicks(clicks: ReadonlyArray<CursorClick>, t: number, duration: number): CursorClick[] {
  const out: CursorClick[] = [];
  for (let i = upperBound(clicks, t) - 1; i >= 0 && clicks[i].t > t - duration; i--) if (clicks[i].down) out.unshift(clicks[i]);
  return out;
}

// ---- replacement cursor image ---------------------------------------------------------------

const images = new Map<string, HTMLImageElement | 'loading' | 'failed'>();

/** Starts decoding a replacement cursor image; resolves when it can be drawn (or has failed). */
export function loadCursorImage(url: string): Promise<boolean> {
  if (typeof Image === 'undefined') return Promise.resolve(false);
  const known = images.get(url);
  if (known && known !== 'loading') return Promise.resolve(known !== 'failed');
  return new Promise((resolve) => {
    const img = new Image();
    images.set(url, 'loading');
    img.onload = () => {
      images.set(url, img);
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(CURSOR_IMAGE_EVENT));
      resolve(true);
    };
    img.onerror = () => {
      images.set(url, 'failed');
      resolve(false);
    };
    img.src = url;
  });
}

/** Fired on `window` when a replacement cursor image finishes loading, so the preview can redraw. */
export const CURSOR_IMAGE_EVENT = 'capstan-cursor-image';

function cursorImage(url: string): HTMLImageElement | null {
  const known = images.get(url);
  if (known === undefined) void loadCursorImage(url);
  return known && known !== 'loading' && known !== 'failed' && known.naturalWidth > 0 ? known : null;
}

// ---- drawing --------------------------------------------------------------------------------

export interface CursorLayer {
  data: CursorData;
  /** Source time (seconds into the media) for the frame being drawn. */
  sourceTime: number;
  /** The clip's on-canvas rectangle before rotation. */
  rect: { x: number; y: number; width: number; height: number };
  canvas: { width: number; height: number };
  /** The part of the source frame the clip shows (fractions), when it is cropped. */
  crop?: { x: number; y: number; width: number; height: number };
  /** Clip rotation in degrees about the centre of `rect`. */
  rotation?: number;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const calloutCache = new WeakMap<CursorKey[], KeyCallout[]>();

/** Key bubbles for some key events, grouped once per data set. */
export function calloutsFor(keys: CursorKey[]): KeyCallout[] {
  let c = calloutCache.get(keys);
  if (!c) {
    c = keyCallouts(keys);
    calloutCache.set(keys, c);
  }
  return c;
}

/** Draws the cursor effects for one clip at one moment, on top of the clip's picture. Order: spotlight, halo, loupe, click rings, cursor, key bubbles. */
export function drawCursorFx(ctx: Ctx2D, fx: CursorFx, layer: CursorLayer): void {
  if (!fx.enabled) return;
  const { data, rect, crop } = layer;
  const t = layer.sourceTime;
  if (rect.width <= 0 || rect.height <= 0) return;
  const unit = rect.height;
  const cx0 = rect.x + rect.width / 2;
  const cy0 = rect.y + rect.height / 2;
  const rad = ((layer.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const turn = (x: number, y: number) => ({ x: cx0 + (x - cx0) * cos - (y - cy0) * sin, y: cy0 + (x - cx0) * sin + (y - cy0) * cos });
  const toCanvas = (p: { x: number; y: number }) => {
    const fx2 = crop ? (p.x - crop.x) / crop.width : p.x;
    const fy2 = crop ? (p.y - crop.y) / crop.height : p.y;
    return turn(rect.x + fx2 * rect.width, rect.y + fy2 * rect.height);
  };

  ctx.save();
  // Keep every effect inside the clip's picture.
  const corners = [turn(rect.x, rect.y), turn(rect.x + rect.width, rect.y), turn(rect.x + rect.width, rect.y + rect.height), turn(rect.x, rect.y + rect.height)];
  ctx.beginPath();
  corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
  ctx.closePath();
  ctx.clip();

  const raw = smoothedPositionAt(data.samples, t, fx.smoothing);
  const pos = raw ? toCanvas(raw) : null;

  if (pos && fx.spotlight && fx.spotlightDim > 0) {
    const r = fx.spotlightSize * unit;
    const g = ctx.createRadialGradient(pos.x, pos.y, r * 0.85, pos.x, pos.y, r);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${fx.spotlightDim})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
  }

  if (pos && fx.highlight) {
    const r = fx.highlightSize * unit;
    const [cr, cg, cb] = rgb(fx.highlightColor);
    const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, r);
    g.addColorStop(0, `rgba(${cr},${cg},${cb},${fx.highlightOpacity})`);
    g.addColorStop(0.7, `rgba(${cr},${cg},${cb},${fx.highlightOpacity})`);
    g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  if (pos && fx.magnify) {
    const r = fx.magnifySize * unit;
    const src = r / fx.magnifyZoom;
    ctx.save();
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    // The loupe magnifies what is already on the canvas under it.
    ctx.drawImage(ctx.canvas as CanvasImageSource, pos.x - src, pos.y - src, src * 2, src * 2, pos.x - r, pos.y - r, r * 2, r * 2);
    ctx.restore();
    ctx.lineWidth = Math.max(2, unit * 0.005);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, unit * 0.002);
    ctx.strokeStyle = 'rgba(15,23,42,0.7)';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r + ctx.lineWidth * 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (fx.clickRings && data.clicks.length) {
    const [cr, cg, cb] = rgb(fx.clickColor);
    for (const c of activeClicks(data.clicks, t, fx.clickDuration)) {
      const s = ringState(t, c.t, fx.clickDuration);
      const where = smoothedPositionAt(data.samples, c.t, fx.smoothing);
      if (!s || !where) continue;
      const p = toCanvas(where);
      const r = Math.max(1, fx.clickSize * unit * (0.15 + 0.85 * s.radius));
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${0.25 * s.alpha})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${s.alpha})`;
      ctx.lineWidth = Math.max(2, unit * 0.005) * (1 - s.progress * 0.5);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      if (c.button === 'right') {
        // A second, inner ring tells a right click from a left click without relying on colour.
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  if (pos && fx.showCursor) {
    const px = unit * 0.028 * fx.size * (pressedAt(data.clicks, t) ? 0.85 : 1);
    const img = fx.image ? cursorImage(fx.image) : null;
    if (img) {
      const h = px * 1.4;
      const w = (h * img.naturalWidth) / img.naturalHeight;
      ctx.drawImage(img, pos.x - fx.imageHotX * w, pos.y - fx.imageHotY * h, w, h);
    } else {
      drawCursorShape(ctx, fx.shape, pos.x, pos.y, px * 1.4, fx.color);
    }
  }

  if (fx.keys && data.keys.length) {
    const bottom = turn(cx0, rect.y + rect.height - unit * 0.07);
    drawKeyCallouts(ctx, calloutsFor(data.keys), t, { hold: fx.keysHold, size: fx.keysSize, unit, x: bottom.x, y: bottom.y });
  }
  ctx.restore();
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
