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
  updatedAt: number;
}

export const DEFAULT_IMAGE_SECONDS = 5;
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
    updatedAt: Date.now(),
  };
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
    updatedAt: num(p.updatedAt, Date.now()),
  };
}
