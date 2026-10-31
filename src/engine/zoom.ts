// Zoom-n-pan: the camera that looks at part of the canvas.
//
// The compositor draws the whole picture, then shows the camera's window of it. A region zooms in
// from the full canvas over `easeIn` seconds, holds on its rectangle, and zooms back out over
// `easeOut` seconds. Where regions overlap the later one wins, and it starts from wherever the
// earlier one had the camera, so two regions in a row pan from one to the other.
import { EASE_NAMES, type EaseName, ease } from './anim';
import { MIN_CLIP_SECONDS, type Project, newId } from './project';

/** A stretch of the timeline during which the camera is zoomed onto a rectangle of the canvas. */
export interface ZoomRegion {
  id: string;
  start: number;
  duration: number;
  /** The part of the canvas that fills the picture, in canvas pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Seconds taken to zoom in and to zoom back out. */
  easeIn: number;
  easeOut: number;
  ease: EaseName;
}

/** The camera at one moment: the canvas point at the centre of the picture, and the magnification (1 = whole canvas). */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface ZoomHost {
  zooms: ZoomRegion[];
  width: number;
  height: number;
}

type Canvas = { width: number; height: number };

/** The most the camera may magnify. */
export const MAX_ZOOM = 20;
export const MAX_ZOOMS = 500;

/** The camera when it rests on a region: the region's centre, as large as still shows all of it. */
export function regionCamera(z: Pick<ZoomRegion, 'x' | 'y' | 'width' | 'height'>, canvas: Canvas): Camera {
  const scale = Math.min(MAX_ZOOM, Math.max(1, Math.min(canvas.width / Math.max(1, z.width), canvas.height / Math.max(1, z.height))));
  return clampCamera({ x: z.x + z.width / 2, y: z.y + z.height / 2, scale }, canvas);
}

/** Keeps the camera's window inside the canvas. */
export function clampCamera(c: Camera, canvas: Canvas): Camera {
  const scale = Math.max(1, c.scale);
  const halfW = canvas.width / scale / 2;
  const halfH = canvas.height / scale / 2;
  return { scale, x: Math.min(canvas.width - halfW, Math.max(halfW, c.x)), y: Math.min(canvas.height - halfH, Math.max(halfH, c.y)) };
}

/** The part of the canvas the camera shows, in canvas pixels. */
export function cameraWindow(c: Camera, canvas: Canvas): { x: number; y: number; width: number; height: number } {
  const k = clampCamera(c, canvas);
  const width = canvas.width / k.scale;
  const height = canvas.height / k.scale;
  return { x: k.x - width / 2, y: k.y - height / 2, width, height };
}

function lerpCamera(a: Camera, b: Camera, u: number): Camera {
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, scale: a.scale + (b.scale - a.scale) * u };
}

/** Seconds the zoom in and out take, shrunk together if they would not fit in the region. */
export function zoomEases(z: Pick<ZoomRegion, 'duration' | 'easeIn' | 'easeOut'>): { easeIn: number; easeOut: number } {
  const total = z.easeIn + z.easeOut;
  const k = total > z.duration && total > 0 ? z.duration / total : 1;
  return { easeIn: z.easeIn * k, easeOut: z.easeOut * k };
}

/** Where one region puts the camera at `time`, coming from `from` (the camera just before it starts). */
function cameraOf(z: ZoomRegion, from: Camera, canvas: Canvas, time: number): Camera {
  const target = regionCamera(z, canvas);
  const full: Camera = { x: canvas.width / 2, y: canvas.height / 2, scale: 1 };
  const { easeIn, easeOut } = zoomEases(z);
  const local = time - z.start;
  if (easeIn > 0 && local < easeIn) return lerpCamera(from, target, ease(z.ease, local / easeIn));
  if (easeOut > 0 && z.duration - local < easeOut) return lerpCamera(full, target, ease(z.ease, (z.duration - local) / easeOut));
  return target;
}

/** Order regions are applied in: by start, ties by position in the list, so "later wins". */
function ordered(zooms: ZoomRegion[]): ZoomRegion[] {
  return zooms.map((z, i) => ({ z, i })).sort((a, b) => a.z.start - b.z.start || a.i - b.i).map((e) => e.z);
}

/** The camera at `time`, or null when the whole canvas is shown. */
export function cameraAt(project: ZoomHost, time: number): Camera | null {
  if (!project.zooms.length) return null;
  const canvas = { width: project.width, height: project.height };
  const list = ordered(project.zooms);
  const full: Camera = { x: canvas.width / 2, y: canvas.height / 2, scale: 1 };
  // The camera a region starts from: wherever the nearest earlier region that is still running leaves it.
  const cameraBefore = (index: number): Camera => {
    const z = list[index];
    for (let j = index - 1; j >= 0; j--) {
      const prev = list[j];
      if (prev.start + prev.duration >= z.start - 1e-9) return cameraOf(prev, cameraBefore(j), canvas, z.start);
    }
    return full;
  };
  for (let i = list.length - 1; i >= 0; i--) {
    const z = list[i];
    if (time >= z.start && time < z.start + z.duration) {
      const cam = clampCamera(cameraOf(z, cameraBefore(i), canvas, time), canvas);
      return cam.scale > 1.0001 ? cam : null;
    }
  }
  return null;
}

/** Keeps a zoom region inside the canvas with sane timing. Regions keep the shape they are given. */
export function normaliseZoom(z: ZoomRegion, canvas: Canvas): ZoomRegion {
  const finite = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const minW = canvas.width / MAX_ZOOM;
  const minH = canvas.height / MAX_ZOOM;
  const width = Math.min(canvas.width, Math.max(minW, finite(z.width, canvas.width / 2)));
  const height = Math.min(canvas.height, Math.max(minH, finite(z.height, canvas.height / 2)));
  const duration = Math.max(MIN_CLIP_SECONDS, finite(z.duration, 3));
  return {
    id: String(z.id),
    start: Math.max(0, finite(z.start, 0)),
    duration,
    x: Math.min(canvas.width - width, Math.max(0, finite(z.x, 0))),
    y: Math.min(canvas.height - height, Math.max(0, finite(z.y, 0))),
    width,
    height,
    easeIn: Math.min(duration, Math.max(0, finite(z.easeIn, 0.5))),
    easeOut: Math.min(duration, Math.max(0, finite(z.easeOut, 0.5))),
    ease: EASE_NAMES.includes(z.ease) ? z.ease : 'inOut',
  };
}

export function parseZooms(input: unknown, canvas: Canvas): ZoomRegion[] {
  if (!Array.isArray(input)) return [];
  const out: ZoomRegion[] = [];
  for (const raw of input.slice(0, MAX_ZOOMS)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.start !== 'number' || typeof r.duration !== 'number' || typeof r.width !== 'number' || typeof r.height !== 'number') continue;
    out.push(normaliseZoom({ ...(r as unknown as ZoomRegion), id: typeof r.id === 'string' ? r.id : newId('zom') }, canvas));
  }
  return out;
}

export function rescaleZooms(zooms: ZoomRegion[], kx: number, ky: number): ZoomRegion[] {
  if (kx === 1 && ky === 1) return zooms;
  return zooms.map((z) => ({ ...z, x: z.x * kx, y: z.y * ky, width: z.width * kx, height: z.height * ky }));
}

// ---------- edits ----------

function touch(project: Project, zooms: ZoomRegion[]): Project {
  return { ...project, zooms, updatedAt: Date.now() };
}

/** A rectangle with the canvas's shape that magnifies by `zoom` (2 = half the canvas), centred on a point. */
export function zoomRect(canvas: Canvas, zoom: number, centre?: { x: number; y: number }): { x: number; y: number; width: number; height: number } {
  const z = Math.min(MAX_ZOOM, Math.max(1, zoom));
  const width = canvas.width / z;
  const height = canvas.height / z;
  const cx = centre?.x ?? canvas.width / 2;
  const cy = centre?.y ?? canvas.height / 2;
  return { x: Math.min(canvas.width - width, Math.max(0, cx - width / 2)), y: Math.min(canvas.height - height, Math.max(0, cy - height / 2)), width, height };
}

/** Adds a zoom-n-pan region at `start`: 3 s long, 2x on the centre unless `patch` says otherwise. */
export function addZoom(project: Project, start: number, patch: Partial<Omit<ZoomRegion, 'id'>> = {}): { project: Project; id: string } {
  const z = normaliseZoom(
    { id: newId('zom'), start, duration: 3, ...zoomRect(project, 2), easeIn: 0.5, easeOut: 0.5, ease: 'inOut', ...patch },
    project,
  );
  return { project: touch(project, [...project.zooms, z]), id: z.id };
}

export function updateZoom(project: Project, id: string, patch: Partial<Omit<ZoomRegion, 'id'>>): Project {
  const cur = project.zooms.find((z) => z.id === id);
  if (!cur) return project;
  const next = normaliseZoom({ ...cur, ...patch }, project);
  return touch(project, project.zooms.map((z) => (z.id === id ? next : z)));
}

export function removeZoom(project: Project, id: string): Project {
  return project.zooms.some((z) => z.id === id) ? touch(project, project.zooms.filter((z) => z.id !== id)) : project;
}

/** Copies a region to start right after the original. */
export function duplicateZoom(project: Project, id: string): { project: Project; id: string | null } {
  const cur = project.zooms.find((z) => z.id === id);
  if (!cur) return { project, id: null };
  const copy = normaliseZoom({ ...cur, id: newId('zom'), start: cur.start + cur.duration }, project);
  return { project: touch(project, [...project.zooms, copy]), id: copy.id };
}
