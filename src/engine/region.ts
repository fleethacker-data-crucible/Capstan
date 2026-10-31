// Geometry for the "Select region" step: a rectangle in source pixels that can be moved, resized
// from eight handles (optionally keeping an aspect ratio) and turned into a clip crop.
import { type Crop, normaliseCrop } from './project';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Bounds {
  width: number;
  height: number;
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const MIN_REGION = 16;

export interface AspectPreset {
  id: string;
  label: string;
  /** width / height; null = free. */
  ratio: number | null;
}

export const ASPECT_PRESETS: AspectPreset[] = [
  { id: 'free', label: 'Free', ratio: null },
  { id: 'canvas', label: 'Project canvas', ratio: -1 }, // resolved by aspectRatio()
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '1:1', label: 'Square 1:1', ratio: 1 },
  { id: '9:16', label: 'Vertical 9:16', ratio: 9 / 16 },
];

/** The ratio for a preset id; 'canvas' follows the project's own size. Null when free. */
export function aspectRatio(id: string, canvas: Bounds): number | null {
  const preset = ASPECT_PRESETS.find((p) => p.id === id);
  if (!preset || preset.ratio === null) return null;
  return preset.ratio < 0 ? canvas.width / canvas.height : preset.ratio;
}

const round = (n: number) => Math.round(n);

export function fullRect(bounds: Bounds): Rect {
  return { x: 0, y: 0, width: bounds.width, height: bounds.height };
}

/** Keeps a rectangle inside the bounds and at least MIN_REGION in each direction, in whole pixels. */
export function clampRect(r: Rect, bounds: Bounds): Rect {
  const minW = Math.min(MIN_REGION, bounds.width);
  const minH = Math.min(MIN_REGION, bounds.height);
  const width = Math.min(bounds.width, Math.max(minW, round(r.width)));
  const height = Math.min(bounds.height, Math.max(minH, round(r.height)));
  const x = Math.min(bounds.width - width, Math.max(0, round(r.x)));
  const y = Math.min(bounds.height - height, Math.max(0, round(r.y)));
  return { x, y, width, height };
}

export function moveRect(r: Rect, dx: number, dy: number, bounds: Bounds): Rect {
  return clampRect({ ...r, x: r.x + dx, y: r.y + dy }, bounds);
}

/**
 * Drags one handle by (dx, dy) from the rectangle `r` as it was when the drag began. With `aspect`
 * (width / height) the shape is kept: corners grow from the opposite corner, edges from the middle
 * of the opposite side.
 */
export function resizeRect(r: Rect, handle: Handle, dx: number, dy: number, bounds: Bounds, aspect: number | null = null): Rect {
  const right = r.x + r.width;
  const bottom = r.y + r.height;
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');

  if (!aspect) {
    let left = west ? r.x + dx : r.x;
    let rt = east ? right + dx : right;
    let top = north ? r.y + dy : r.y;
    let bt = south ? bottom + dy : bottom;
    left = Math.max(0, Math.min(left, rt - MIN_REGION));
    rt = Math.min(bounds.width, Math.max(rt, left + MIN_REGION));
    top = Math.max(0, Math.min(top, bt - MIN_REGION));
    bt = Math.min(bounds.height, Math.max(bt, top + MIN_REGION));
    return clampRect({ x: left, y: top, width: rt - left, height: bt - top }, bounds);
  }

  const corner = (west || east) && (north || south);
  // The fixed point: the opposite corner, or the middle of the opposite edge.
  const anchorX = west ? right : east ? r.x : r.x + r.width / 2;
  const anchorY = north ? bottom : south ? r.y : r.y + r.height / 2;
  let w = r.width;
  let h = r.height;
  if (corner) {
    const wFromX = r.width + (west ? -dx : dx);
    const hFromY = r.height + (north ? -dy : dy);
    w = Math.max(wFromX, hFromY * aspect);
  } else if (west || east) {
    w = r.width + (west ? -dx : dx);
  } else {
    w = (r.height + (north ? -dy : dy)) * aspect;
  }
  // Room for the rectangle on each side of the anchor.
  const roomW = west ? anchorX : east ? bounds.width - anchorX : 2 * Math.min(anchorX, bounds.width - anchorX);
  const roomH = north ? anchorY : south ? bounds.height - anchorY : 2 * Math.min(anchorY, bounds.height - anchorY);
  const edgeX = corner || west || east;
  const edgeY = corner || north || south;
  const maxW = Math.min(edgeX ? roomW : Infinity, edgeY ? roomH * aspect : Infinity, bounds.width, bounds.height * aspect);
  const minW = Math.max(MIN_REGION, MIN_REGION * aspect);
  w = Math.max(minW, Math.min(w, maxW));
  h = w / aspect;
  const x = west ? anchorX - w : east ? anchorX : anchorX - w / 2;
  const y = north ? anchorY - h : south ? anchorY : anchorY - h / 2;
  return clampRect({ x, y, width: w, height: h }, bounds);
}

/** Reshapes `r` to `aspect`, keeping its middle and not growing past the original rectangle. */
export function fitAspect(r: Rect, aspect: number | null, bounds: Bounds): Rect {
  if (!aspect) return clampRect(r, bounds);
  let w = r.width;
  let h = r.height;
  if (w / h > aspect) w = h * aspect;
  else h = w / aspect;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  return clampRect({ x: cx - w / 2, y: cy - h / 2, width: w, height: h }, bounds);
}

/** Sets one numeric field (as typed in the fields beside the picture), keeping the aspect if locked. */
export function setRectField(r: Rect, field: keyof Rect, value: number, bounds: Bounds, aspect: number | null = null): Rect {
  if (!Number.isFinite(value)) return r;
  if (field === 'x' || field === 'y') return clampRect({ ...r, [field]: value }, bounds);
  if (!aspect) return clampRect({ ...r, [field]: value }, bounds);
  if (field === 'width') {
    const w = Math.min(value, bounds.width, bounds.height * aspect);
    return clampRect({ ...r, width: w, height: w / aspect }, bounds);
  }
  const h = Math.min(value, bounds.height, bounds.width / aspect);
  return clampRect({ ...r, width: h * aspect, height: h }, bounds);
}

/** The region as a clip crop (fractions of the frame); undefined when it covers the whole frame. */
export function rectToCrop(r: Rect, bounds: Bounds): Crop | undefined {
  if (bounds.width <= 0 || bounds.height <= 0) return undefined;
  const q = (n: number) => Math.round(n * 10000) / 10000;
  return normaliseCrop({ x: q(r.x / bounds.width), y: q(r.y / bounds.height), width: q(r.width / bounds.width), height: q(r.height / bounds.height) });
}

export function cropToRect(crop: Crop | undefined, bounds: Bounds): Rect {
  if (!crop) return fullRect(bounds);
  return clampRect({ x: crop.x * bounds.width, y: crop.y * bounds.height, width: crop.width * bounds.width, height: crop.height * bounds.height }, bounds);
}
