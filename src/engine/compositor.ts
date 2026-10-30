// Draws one frame of the timeline onto a 2D canvas. Used by both preview and export, so
// what you see is exactly what gets encoded.
import { wrapCaption } from './captions';
import { type Clip, type Project, type Redaction, activeClipsAt, activeRedactionsAt, captionAt, findMedia } from './project';

export type FrameSource = CanvasImageSource & { readonly width?: number; readonly height?: number };

export interface SourceSize {
  width: number;
  height: number;
}

/** Size of a clip on the canvas at scale 1: the media fitted inside the canvas, aspect kept. */
export function fittedSize(media: SourceSize, canvas: SourceSize): SourceSize {
  if (media.width <= 0 || media.height <= 0) return { width: canvas.width, height: canvas.height };
  const k = Math.min(canvas.width / media.width, canvas.height / media.height);
  return { width: media.width * k, height: media.height * k };
}

/** The clip's on-canvas rectangle before rotation, centred on props.x / props.y. */
export function clipRect(project: Project, clip: Clip): { x: number; y: number; width: number; height: number } {
  const media = findMedia(project, clip.mediaId);
  const base = fittedSize(media ?? project, project);
  const width = base.width * clip.props.scale;
  const height = base.height * clip.props.scale;
  return { x: clip.props.x - width / 2, y: clip.props.y - height / 2, width, height };
}

export type SourceLookup = (clip: Clip) => CanvasImageSource | null;

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface DrawOptions {
  /** Draw the caption active at this time (default true). */
  captions?: boolean;
}

/** Blur radius / pixel block in canvas pixels: strength 100 is 4% (blur) or 5% (blocks) of the canvas height. */
export function redactionAmount(r: Pick<Redaction, 'mode' | 'strength'>, canvasHeight: number): number {
  const k = r.mode === 'pixelate' ? 0.05 : 0.04;
  return Math.max(4, Math.round((r.strength / 100) * k * canvasHeight));
}

let scratch: OffscreenCanvas | HTMLCanvasElement | null = null;
function scratchCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (!scratch) scratch = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  if (scratch.width < w) scratch.width = w;
  if (scratch.height < h) scratch.height = h;
  return scratch;
}

const filterSupported = new WeakMap<object, boolean>();
function canFilter(ctx: Ctx2D): boolean {
  let ok = filterSupported.get(ctx);
  if (ok === undefined) {
    // Without native support, `filter` would just become a plain property and blur nothing.
    ok = 'filter' in Object.getPrototypeOf(ctx);
    if (ok) {
      const before = ctx.filter;
      ctx.filter = 'blur(2px)';
      ok = ctx.filter === 'blur(2px)';
      ctx.filter = before;
    }
    filterSupported.set(ctx, ok);
  }
  return ok;
}

function pixelate(ctx: Ctx2D, x: number, y: number, w: number, h: number, block: number): void {
  const sw = Math.max(1, Math.ceil(w / block));
  const sh = Math.max(1, Math.ceil(h / block));
  const s = scratchCanvas(sw, sh);
  const sctx = s.getContext('2d') as Ctx2D;
  sctx.imageSmoothingEnabled = true;
  sctx.clearRect(0, 0, sw, sh);
  sctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, sw, sh);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(s, 0, 0, sw, sh, x, y, w, h);
  ctx.restore();
}

/** Obscures a region of what has been drawn so far. Never leaves it untouched. */
export function applyRedaction(ctx: Ctx2D, r: Redaction, canvasHeight: number): void {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const w = Math.min(ctx.canvas.width - x, Math.ceil(r.width));
  const h = Math.min(ctx.canvas.height - y, Math.ceil(r.height));
  if (w <= 0 || h <= 0) return;
  const amount = redactionAmount(r, canvasHeight);
  if (r.mode === 'pixelate' || !canFilter(ctx)) {
    pixelate(ctx, x, y, w, h, r.mode === 'pixelate' ? amount : redactionAmount({ mode: 'pixelate', strength: r.strength }, canvasHeight));
    return;
  }
  // Blur a copy of the region (plus a margin, so the edges blur too) back into it, twice.
  const m = amount * 2;
  const sx = Math.max(0, x - m);
  const sy = Math.max(0, y - m);
  const sw = Math.min(ctx.canvas.width, x + w + m) - sx;
  const sh = Math.min(ctx.canvas.height, y + h + m) - sy;
  const s = scratchCanvas(sw, sh);
  const sctx = s.getContext('2d') as Ctx2D;
  for (let pass = 0; pass < 2; pass++) {
    sctx.clearRect(0, 0, sw, sh);
    sctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.filter = `blur(${amount}px)`;
    ctx.drawImage(s, 0, 0, sw, sh, sx, sy, sw, sh);
    ctx.restore();
  }
}

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawCaption(ctx: Ctx2D, project: Pick<Project, 'width' | 'height'>, text: string): void {
  const size = Math.max(12, Math.round(project.height * 0.042));
  ctx.save();
  ctx.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapCaption(text, (s) => ctx.measureText(s).width, project.width * 0.8);
  const lineH = Math.round(size * 1.28);
  const padX = Math.round(size * 0.55);
  const padY = Math.round(size * 0.3);
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const h = lines.length * lineH + padY * 2;
  const x = (project.width - w) / 2;
  const y = project.height - Math.round(project.height * 0.05) - h;
  ctx.fillStyle = 'rgba(10, 18, 34, 0.86)';
  roundRect(ctx, x, y, w, h, Math.round(size * 0.25));
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  lines.forEach((l, i) => ctx.fillText(l, project.width / 2, y + padY + lineH * (i + 0.5)));
  ctx.restore();
}

export function drawFrame(ctx: Ctx2D, project: Project, time: number, lookup: SourceLookup, options: DrawOptions = {}): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = project.background;
  ctx.fillRect(0, 0, project.width, project.height);
  const hidden = new Set(project.tracks.filter((t) => t.hidden).map((t) => t.id));
  for (const clip of activeClipsAt(project, time)) {
    if (hidden.has(clip.trackId)) continue;
    const media = findMedia(project, clip.mediaId);
    if (!media || media.kind === 'audio') continue;
    const source = lookup(clip);
    if (!source) continue;
    // A recording can change size part-way (the shared window was resized, or the browser added its
    // "sharing this tab" bar): fit each frame by its own size so it is never stretched.
    const frame = typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement && source.videoWidth > 0 ? source : null;
    const r = frame ? clipRect({ ...project, media: project.media.map((m) => (m.id === media.id ? { ...m, width: frame.videoWidth, height: frame.videoHeight } : m)) }, clip) : clipRect(project, clip);
    ctx.save();
    ctx.globalAlpha = clip.props.opacity;
    ctx.translate(clip.props.x, clip.props.y);
    if (clip.props.rotation) ctx.rotate((clip.props.rotation * Math.PI) / 180);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, -r.width / 2, -r.height / 2, r.width, r.height);
    ctx.restore();
  }
  for (const r of activeRedactionsAt(project, time)) applyRedaction(ctx, r, project.height);
  if (options.captions !== false) {
    const caption = captionAt(project, time);
    if (caption) drawCaption(ctx, project, caption.text);
  }
  ctx.restore();
}
