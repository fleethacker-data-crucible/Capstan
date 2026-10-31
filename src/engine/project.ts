// Capstan project model. Plain, serialisable data: the timeline is the source of truth,
// and every edit is a pure function from one Project to the next (see ops.ts).
import { type Animated, parseKeys } from './anim';
import { type Annotation, parseAnnotations } from './annotations';
import { type ClipAudio, parseClipAudio } from './audiofx';
import { parseBehavior } from './behaviors';
import { type CursorData, type CursorFx, parseCursorData, parseCursorFx } from './cursor';
import { type ClipEffects, parseEffects } from './fx';
import { type Marker, parseMarkers } from './markers';
import { parseRange } from './range';
import { type Transition, parseTransition } from './transitions';
import { type ZoomRegion, parseZooms } from './zoom';

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
  /** Cursor, click and key activity recorded with a screen recording (times are seconds into this media). */
  cursor?: CursorData;
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

/** The part of the source picture a clip shows, as fractions (0..1) of the source frame. */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Clip extends Animated {
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
  /** Playback speed (1 = normal). The clip consumes `duration * speed` seconds of source. */
  speed?: number;
  /** Holds the frame at `in` for the whole clip (a freeze frame). Silent. */
  freeze?: boolean;
  crop?: Crop;
  effects?: ClipEffects;
  audio?: ClipAudio;
  transitionIn?: Transition;
  transitionOut?: Transition;
  /** Clips sharing a link id move together (a video and the audio detached from it). */
  linkId?: string;
  /** Clips sharing a group id are selected and moved as one. */
  groupId?: string;
  /** Plays only the sound of its media: never drawn. Made by detaching audio from a video clip. */
  audioOnly?: boolean;
  /** The clip's own sound is silenced (preview and export); volume stays as the user set it. Set on the picture clip when its audio is detached. */
  muteAudio?: boolean;
}

export interface Track {
  id: string;
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  /** Magnetic: clips on this track close up, so it never has gaps (delete and trim ripple). */
  magnetic?: boolean;
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
  /** Text, shapes, arrows, highlights drawn above the tracks. Later items draw on top. */
  annotations: Annotation[];
  /** Zoom-n-pan: stretches of the timeline where the camera looks at part of the canvas. */
  zooms: ZoomRegion[];
  markers: Marker[];
  /** How the recorded cursor is re-drawn on screen recordings that have cursor data. */
  cursorFx?: CursorFx;
  /** The in and out marks (seconds): the part of the timeline an "In to out" export covers. */
  range?: { start: number; end: number };
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
    annotations: [],
    zooms: [],
    markers: [],
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

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 8;

export function clipSpeed(clip: Pick<Clip, 'speed'>): number {
  const s = clip.speed ?? 1;
  return Number.isFinite(s) ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, s)) : 1;
}

/** Position in the source media (seconds) shown at timeline `time`. */
export function sourceTimeAt(clip: Pick<Clip, 'start' | 'in' | 'speed' | 'freeze'>, time: number): number {
  return clip.freeze ? clip.in : clip.in + (time - clip.start) * clipSpeed(clip);
}

/** Seconds of source media the clip consumes. */
export function sourceSpan(clip: Pick<Clip, 'duration' | 'speed' | 'freeze'>): number {
  return clip.freeze ? 0 : clip.duration * clipSpeed(clip);
}

/** The size of what a clip shows of its media: the cropped part of the source frame. */
export function croppedSize(media: { width: number; height: number }, crop: Crop | undefined): { width: number; height: number } {
  return crop ? { width: media.width * crop.width, height: media.height * crop.height } : { width: media.width, height: media.height };
}

/** Keeps a crop rectangle inside the frame, at least 2% each way. */
export function normaliseCrop(input: unknown): Crop | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const c = input as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const width = Math.min(1, Math.max(0.02, n(c.width, 1)));
  const height = Math.min(1, Math.max(0.02, n(c.height, 1)));
  const x = Math.min(1 - width, Math.max(0, n(c.x, 0)));
  const y = Math.min(1 - height, Math.max(0, n(c.y, 0)));
  return x === 0 && y === 0 && width === 1 && height === 1 ? undefined : { x, y, width, height };
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
    ...(t.magnetic ? { magnetic: true } : {}),
  }));
  const trackIds = new Set(tracks.map((t) => t.id));
  const media = p.media.map((m) => {
    const cursor = parseCursorData((m as { cursor?: unknown }).cursor);
    const { cursor: _dropped, ...rest } = m;
    return { ...rest, id: String(m.id), name: String(m.name).slice(0, 200), ...(cursor ? { cursor } : {}) };
  });
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
      ...parseClipExtras(c as unknown as Record<string, unknown>),
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
    annotations: parseAnnotations(p.annotations, { width, height }),
    zooms: parseZooms(p.zooms, { width, height }),
    markers: parseMarkers(p.markers),
    ...(parseCursorFx(p.cursorFx) ? { cursorFx: parseCursorFx(p.cursorFx) } : {}),
    ...(parseRange(p.range) ? { range: parseRange(p.range) } : {}),
    updatedAt: num(p.updatedAt, Date.now()),
  };
}

/** The optional per-clip fields, validated. Unknown or malformed values are dropped. */
function parseClipExtras(c: Record<string, unknown>): Partial<Clip> {
  const out: Partial<Clip> = {};
  const speed = c.speed;
  if (typeof speed === 'number' && Number.isFinite(speed) && speed !== 1) out.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  if (c.freeze === true) out.freeze = true;
  const crop = normaliseCrop(c.crop);
  if (crop) out.crop = crop;
  const keys = parseKeys(c.keys);
  if (keys) out.keys = keys;
  const behavior = parseBehavior(c.behavior);
  if (behavior) out.behavior = behavior;
  const effects = parseEffects(c.effects);
  if (effects) out.effects = effects;
  const audio = parseClipAudio(c.audio);
  if (audio) out.audio = audio;
  const transitionIn = parseTransition(c.transitionIn);
  if (transitionIn) out.transitionIn = transitionIn;
  const transitionOut = parseTransition(c.transitionOut);
  if (transitionOut) out.transitionOut = transitionOut;
  if (typeof c.linkId === 'string') out.linkId = c.linkId.slice(0, 80);
  if (typeof c.groupId === 'string') out.groupId = c.groupId.slice(0, 80);
  if (c.audioOnly === true) out.audioOnly = true;
  if (c.muteAudio === true) out.muteAudio = true;
  return out;
}
