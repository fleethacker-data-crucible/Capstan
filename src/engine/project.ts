// Capstan project model. Plain, serialisable data: the timeline is the source of truth,
// and every edit is a pure function from one Project to the next (see ops.ts).

export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaItem {
  id: string;
  name: string;
  kind: MediaKind;
  mime: string;
  bytes: number;
  /** Source duration in seconds. Images use DEFAULT_IMAGE_SECONDS when placed. */
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Small JPEG data URL for the media bin. */
  thumb?: string;
  createdAt: number;
}

export interface ClipProps {
  /** Centre of the clip on the canvas, in canvas pixels. */
  x: number;
  y: number;
  /** 1 = fit inside the canvas. */
  scale: number;
  /** Degrees. */
  rotation: number;
  /** 0..1 */
  opacity: number;
  /** 0..2 (1 = unchanged). */
  volume: number;
}

export interface Clip {
  id: string;
  trackId: string;
  mediaId: string;
  /** Timeline position in seconds. */
  start: number;
  /** Offset into the source media, in seconds. */
  in: number;
  /** Length on the timeline, in seconds. */
  duration: number;
  props: ClipProps;
}

export interface Track {
  id: string;
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
}

export type RedactMode = 'blur' | 'pixelate';

/** A rectangle obscured on every layer beneath it for a stretch of the timeline. */
export interface Redaction {
  id: string;
  start: number;
  duration: number;
  /** Top-left corner and size, in canvas pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  mode: RedactMode;
  /** 1..100; scales the blur radius or the pixel block size with the canvas. */
  strength: number;
}

/** One timed caption, drawn over everything when captions are shown. */
export interface Caption {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  background: string;
  /** Rendered bottom-to-top: tracks[0] is the bottom layer, the last track is on top. */
  tracks: Track[];
  clips: Clip[];
  media: MediaItem[];
  /** Applied after all tracks, so they obscure every layer. */
  redactions: Redaction[];
  /** Sorted by start time. */
  captions: Caption[];
  updatedAt: number;
}

export const DEFAULT_IMAGE_SECONDS = 5;
export const MIN_REDACTION_PX = 8;
export const MAX_CAPTION_CHARS = 500;
export const MIN_CLIP_SECONDS = 1 / 30;

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${random}`;
}

export function defaultProps(project: Pick<Project, 'width' | 'height'>): ClipProps {
  return { x: project.width / 2, y: project.height / 2, scale: 1, rotation: 0, opacity: 1, volume: 1 };
}

export function createTrack(index: number): Track {
  return { id: newId('trk'), name: `Track ${index + 1}`, muted: false, hidden: false, locked: false };
}

export function createProject(name = 'Untitled project', width = 1920, height = 1080, fps = 30): Project {
  return {
    version: 1,
    id: newId('prj'),
    name,
    width,
    height,
    fps,
    background: '#000000',
    tracks: [createTrack(0), createTrack(1), createTrack(2)],
    clips: [],
    media: [],
    redactions: [],
    captions: [],
    updatedAt: Date.now(),
  };
}

/** Keeps a redaction inside the canvas, at least MIN_REDACTION_PX each way, with sane timing. */
export function normaliseRedaction(r: Redaction, canvas: Pick<Project, 'width' | 'height'>): Redaction {
  const finite = (v: number, d: number) => (Number.isFinite(v) ? v : d);
  const width = Math.round(Math.min(canvas.width, Math.max(MIN_REDACTION_PX, finite(r.width, canvas.width / 4))));
  const height = Math.round(Math.min(canvas.height, Math.max(MIN_REDACTION_PX, finite(r.height, canvas.height / 8))));
  return {
    id: String(r.id),
    start: Math.max(0, finite(r.start, 0)),
    duration: Math.max(MIN_CLIP_SECONDS, finite(r.duration, 3)),
    x: Math.round(Math.min(canvas.width - width, Math.max(0, finite(r.x, 0)))),
    y: Math.round(Math.min(canvas.height - height, Math.max(0, finite(r.y, 0)))),
    width,
    height,
    mode: r.mode === 'pixelate' ? 'pixelate' : 'blur',
    strength: Math.round(Math.min(100, Math.max(1, finite(r.strength, 60)))),
  };
}

export function activeRedactionsAt(project: Project, time: number): Redaction[] {
  return project.redactions.filter((r) => time >= r.start && time < r.start + r.duration);
}

export function captionAt(project: Project, time: number): Caption | undefined {
  return project.captions.find((c) => time >= c.start && time < c.end);
}

export function clipEnd(clip: Clip): number {
  return clip.start + clip.duration;
}

export function projectDuration(project: Project): number {
  return project.clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
}

export function findMedia(project: Project, id: string): MediaItem | undefined {
  return project.media.find((m) => m.id === id);
}

/** Longest a clip of this media may be, measured from its current source offset. */
export function maxSourceDuration(media: MediaItem): number {
  return media.kind === 'image' ? Number.POSITIVE_INFINITY : media.duration;
}

/** Clips visible at `time`, bottom track first (the order they must be drawn in). */
export function activeClipsAt(project: Project, time: number): Clip[] {
  const order = new Map(project.tracks.map((t, i) => [t.id, i]));
  return project.clips
    .filter((c) => time >= c.start && time < clipEnd(c))
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0));
}

/** Validates and normalises a project loaded from disk or IndexedDB. */
export function parseProject(input: unknown): Project {
  const p = input as Partial<Project> | null;
  if (!p || p.version !== 1 || !Array.isArray(p.tracks) || !Array.isArray(p.clips) || !Array.isArray(p.media)) {
    throw new Error('Not an Capstan project file');
  }
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const width = Math.round(Math.min(7680, Math.max(16, num(p.width, 1920))));
  const height = Math.round(Math.min(4320, Math.max(16, num(p.height, 1080))));
  const tracks = p.tracks.map((t, i) => ({
    id: String(t.id),
    name: String(t.name ?? `Track ${i + 1}`).slice(0, 60),
    muted: !!t.muted,
    hidden: !!t.hidden,
    locked: !!t.locked,
  }));
  const trackIds = new Set(tracks.map((t) => t.id));
  const media = p.media.map((m) => ({ ...m, id: String(m.id), name: String(m.name).slice(0, 200) }));
  const mediaIds = new Set(media.map((m) => m.id));
  const base = defaultProps({ width, height });
  const clips = p.clips
    .filter((c) => trackIds.has(c.trackId) && mediaIds.has(c.mediaId))
    .map((c) => ({
      id: String(c.id),
      trackId: c.trackId,
      mediaId: c.mediaId,
      start: Math.max(0, num(c.start, 0)),
      in: Math.max(0, num(c.in, 0)),
      duration: Math.max(MIN_CLIP_SECONDS, num(c.duration, 1)),
      props: { ...base, ...(c.props ?? {}) },
    }));
  // Projects saved before redactions and captions existed have neither array.
  const redactions = (Array.isArray(p.redactions) ? p.redactions : [])
    .filter((r) => r && typeof r === 'object')
    .map((r) => normaliseRedaction({ ...r, id: String(r.id ?? newId('red')) }, { width, height }));
  const captions = (Array.isArray(p.captions) ? p.captions : [])
    .filter((c) => c && typeof c.text === 'string' && num(c.end, 0) > num(c.start, 0))
    .map((c) => ({ id: String(c.id ?? newId('cap')), start: Math.max(0, num(c.start, 0)), end: num(c.end, 0), text: c.text.slice(0, MAX_CAPTION_CHARS) }))
    .sort((a, b) => a.start - b.start);
  return {
    version: 1,
    id: String(p.id ?? newId('prj')),
    name: String(p.name ?? 'Untitled project').slice(0, 120),
    width,
    height,
    fps: Math.min(60, Math.max(1, Math.round(num(p.fps, 30)))),
    background: typeof p.background === 'string' && /^#[0-9a-f]{6}$/i.test(p.background) ? p.background : '#000000',
    tracks,
    clips,
    media,
    redactions,
    captions,
    updatedAt: num(p.updatedAt, Date.now()),
  };
}
