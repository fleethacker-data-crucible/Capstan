// Smart focus: reads cursor activity (click clusters, dwells) and suggests zoom regions. Nothing is
// applied here: the user reviews the suggestions and adds the ones they want to project.zooms.
import { clipRect } from './compositor';
import { type CursorData, positionAt } from './cursor';
import { type Clip, type MediaItem, type Project, clipEnd, clipSpeed, findMedia, newId, sourceSpan } from './project';
import type { ZoomRegion } from './zoom';

export interface FocusEvent {
  /** Seconds into the media. */
  start: number;
  end: number;
  /** Centre and extent of the activity, as fractions of the frame. */
  x: number;
  y: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  kind: 'clicks' | 'dwell';
  clicks: number;
}

export interface FocusOptions {
  /** Clicks further apart than this (seconds) start a new cluster. */
  clusterGap: number;
  /** Clicks further than this from the cluster (fraction of the frame width) start a new cluster. */
  clusterRadius: number;
  /** Cursor resting within `dwellRadius` for this long is a dwell. */
  dwellSeconds: number;
  dwellRadius: number;
}

export const DEFAULT_FOCUS: FocusOptions = { clusterGap: 2, clusterRadius: 0.2, dwellSeconds: 1.2, dwellRadius: 0.03 };

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Click clusters and dwells in the cursor data, in time order. Dwells that overlap a click cluster are left out. */
export function findFocusEvents(data: CursorData, options: Partial<FocusOptions> = {}): FocusEvent[] {
  const o = { ...DEFAULT_FOCUS, ...options };
  const events: FocusEvent[] = [];

  // Click clusters.
  let cluster: { pts: Array<{ t: number; x: number; y: number }>; cx: number; cy: number } | null = null;
  const close = () => {
    if (!cluster) return;
    const xs = cluster.pts.map((p) => p.x);
    const ys = cluster.pts.map((p) => p.y);
    events.push({
      start: cluster.pts[0].t,
      end: cluster.pts[cluster.pts.length - 1].t,
      x: cluster.cx,
      y: cluster.cy,
      x0: Math.min(...xs),
      x1: Math.max(...xs),
      y0: Math.min(...ys),
      y1: Math.max(...ys),
      kind: 'clicks',
      clicks: cluster.pts.length,
    });
    cluster = null;
  };
  for (const c of data.clicks) {
    if (!c.down) continue;
    const p = positionAt(data.samples, c.t);
    if (!p) continue;
    const last = cluster?.pts[cluster.pts.length - 1];
    if (cluster && last && c.t - last.t <= o.clusterGap && dist(p, { x: cluster.cx, y: cluster.cy }) <= o.clusterRadius) {
      cluster.pts.push({ t: c.t, ...p });
      cluster.cx = cluster.pts.reduce((s, q) => s + q.x, 0) / cluster.pts.length;
      cluster.cy = cluster.pts.reduce((s, q) => s + q.y, 0) / cluster.pts.length;
    } else {
      close();
      cluster = { pts: [{ t: c.t, ...p }], cx: p.x, cy: p.y };
    }
  }
  close();

  // Dwells: the cursor stays inside a small circle around where the stay began.
  const s = data.samples;
  const clusters = events.slice();
  for (let i = 0; i < s.length; ) {
    let j = i + 1;
    while (j < s.length && dist(s[j], s[i]) <= o.dwellRadius) j++;
    const last = s[j - 1];
    if (last.t - s[i].t >= o.dwellSeconds) {
      const span = s.slice(i, j);
      const x = span.reduce((a, q) => a + q.x, 0) / span.length;
      const y = span.reduce((a, q) => a + q.y, 0) / span.length;
      const covered = clusters.some((c) => c.start - 0.5 < last.t && c.end + 0.5 > s[i].t);
      if (!covered) events.push({ start: s[i].t, end: last.t, x, y, x0: x, x1: x, y0: y, y1: y, kind: 'dwell', clicks: 0 });
      i = j;
    } else i++;
  }
  return events.sort((a, b) => a.start - b.start);
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The zoom window for a box of activity (canvas pixels): `level` times magnification, grown to fit
 * the box plus a margin, in the canvas's aspect ratio and kept inside it. Null when the window
 * would be bigger than 80% of the canvas, where zooming adds little.
 */
export function fitZoomRect(box: { x0: number; y0: number; x1: number; y1: number }, canvas: { width: number; height: number }, level: number, margin: number, maxShare = 0.8): Rect | null {
  const aspect = canvas.width / canvas.height;
  const w = Math.max(canvas.width / Math.max(1.05, level), box.x1 - box.x0 + 2 * margin, (box.y1 - box.y0 + 2 * margin) * aspect);
  if (w > canvas.width * maxShare) return null;
  const h = w / aspect;
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  return { x: Math.min(canvas.width - w, Math.max(0, cx - w / 2)), y: Math.min(canvas.height - h, Math.max(0, cy - h / 2)), width: w, height: h };
}

export interface SuggestOptions extends Partial<FocusOptions> {
  /** Magnification of each suggested zoom (default 2). */
  level: number;
  /** Seconds before the first click that the zoom starts. */
  lead: number;
  /** Seconds the zoom is held after the last click. */
  tail: number;
  /** Shortest region, seconds. */
  minDuration: number;
  /** Regions closer than this are merged or trimmed. */
  minGap: number;
  max: number;
}

/** Two nearby suggestions are merged only if one window can hold both at this magnification or more. */
const MIN_MERGED_LEVEL = 1.5;

export const DEFAULT_SUGGEST: SuggestOptions = { level: 2, lead: 0.7, tail: 1, minDuration: 1.5, minGap: 0.4, max: 40 };

function usable(project: Project, clip: Clip, media: MediaItem | undefined): media is MediaItem & { cursor: CursorData } {
  const track = project.tracks.find((t) => t.id === clip.trackId);
  return !!media?.cursor && media.kind === 'video' && !clip.freeze && !track?.hidden;
}

/**
 * Suggested zoom regions for the whole project: one per click cluster or dwell of every clip that has
 * cursor data, placed in timeline time and canvas pixels. Overlapping suggestions are merged when one
 * window can hold both, otherwise the earlier one is trimmed; anything that would overlap a zoom
 * already in the project is left out.
 */
export function suggestZooms(project: Project, options: Partial<SuggestOptions> = {}): ZoomRegion[] {
  const o = { ...DEFAULT_SUGGEST, ...options };
  const canvas = { width: project.width, height: project.height };
  const margin = canvas.width * 0.08;
  interface Draft {
    start: number;
    end: number;
    box: { x0: number; y0: number; x1: number; y1: number };
  }
  const drafts: Draft[] = [];
  for (const clip of project.clips) {
    const media = findMedia(project, clip.mediaId);
    if (!usable(project, clip, media)) continue;
    const rect = clipRect(project, clip);
    const crop = clip.crop;
    const speed = clipSpeed(clip);
    const toCanvas = (x: number, y: number) => ({
      x: rect.x + (crop ? (x - crop.x) / crop.width : x) * rect.width,
      y: rect.y + (crop ? (y - crop.y) / crop.height : y) * rect.height,
    });
    const to = clip.in + sourceSpan(clip);
    for (const e of findFocusEvents(media.cursor, o)) {
      if (e.start < clip.in || e.start >= to) continue;
      const a = toCanvas(e.x0, e.y0);
      const b = toCanvas(e.x1, e.y1);
      const start = Math.max(clip.start, clip.start + (e.start - clip.in) / speed - o.lead);
      let end = Math.min(clipEnd(clip), clip.start + (Math.min(e.end, to) - clip.in) / speed + o.tail);
      if (end - start < o.minDuration) end = Math.min(clipEnd(clip), start + o.minDuration);
      if (end - start < 0.5) continue;
      drafts.push({ start, end, box: { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) } });
    }
  }
  drafts.sort((a, b) => a.start - b.start);

  // Resolve overlaps.
  const kept: Draft[] = [];
  for (const d of drafts) {
    const prev = kept[kept.length - 1];
    if (prev && d.start < prev.end + o.minGap) {
      const union = { x0: Math.min(prev.box.x0, d.box.x0), y0: Math.min(prev.box.y0, d.box.y0), x1: Math.max(prev.box.x1, d.box.x1), y1: Math.max(prev.box.y1, d.box.y1) };
      if (fitZoomRect(union, canvas, o.level, margin, 1 / MIN_MERGED_LEVEL)) {
        prev.box = union;
        prev.end = Math.max(prev.end, d.end);
        continue;
      }
      prev.end = Math.max(prev.start, d.start - o.minGap);
      if (prev.end - prev.start < 0.5) kept.pop();
    }
    kept.push(d);
  }

  const out: ZoomRegion[] = [];
  for (const d of kept) {
    const rect = fitZoomRect(d.box, canvas, o.level, margin);
    if (!rect) continue;
    const duration = d.end - d.start;
    if (duration < 0.5) continue;
    if (project.zooms.some((z) => d.start < z.start + z.duration && d.end > z.start)) continue;
    out.push({
      id: newId('zoom'),
      start: d.start,
      duration,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      easeIn: Math.min(0.5, duration * 0.3),
      easeOut: Math.min(0.6, duration * 0.3),
      ease: 'inOut',
    });
    if (out.length >= o.max) break;
  }
  return out;
}
