// Pure timeline edits. Every function takes a Project and returns a new one (or the same
// object when nothing changed), so undo/redo is just a stack of snapshots.
import {
  type Caption,
  type Clip,
  type ClipProps,
  type MediaItem,
  type Project,
  type Redaction,
  DEFAULT_IMAGE_SECONDS,
  MAX_CAPTION_CHARS,
  MIN_CLIP_SECONDS,
  normaliseRedaction,
  clipEnd,
  createTrack,
  defaultProps,
  findMedia,
  maxSourceDuration,
  newId,
} from './project';

const EPS = 1e-6;

function touch(project: Project, patch: Partial<Project>): Project {
  return { ...project, ...patch, updatedAt: Date.now() };
}

function trackClips(project: Project, trackId: string, ignore?: Set<string>): Clip[] {
  return project.clips
    .filter((c) => c.trackId === trackId && !(ignore && ignore.has(c.id)))
    .sort((a, b) => a.start - b.start);
}

function isLocked(project: Project, trackId: string): boolean {
  return !!project.tracks.find((t) => t.id === trackId)?.locked;
}

/** Free gaps on a track, as [start, end) pairs; the last gap is open-ended. */
export function freeGaps(project: Project, trackId: string, ignore?: Set<string>): Array<[number, number]> {
  const gaps: Array<[number, number]> = [];
  let cursor = 0;
  for (const c of trackClips(project, trackId, ignore)) {
    if (c.start - cursor > EPS) gaps.push([cursor, c.start]);
    cursor = Math.max(cursor, clipEnd(c));
  }
  gaps.push([cursor, Number.POSITIVE_INFINITY]);
  return gaps;
}

/**
 * The start time nearest to `wanted` at which a clip of `duration` fits on the track without
 * overlapping anything, or null if the track is locked. Clips never overlap on one track.
 */
export function fitOnTrack(
  project: Project,
  trackId: string,
  wanted: number,
  duration: number,
  ignore?: Set<string>,
): number | null {
  if (isLocked(project, trackId)) return null;
  wanted = Math.max(0, wanted);
  let best: number | null = null;
  for (const [gs, ge] of freeGaps(project, trackId, ignore)) {
    if (ge - gs + EPS < duration) continue;
    const candidate = Math.min(Math.max(wanted, gs), ge - duration);
    if (best === null || Math.abs(candidate - wanted) < Math.abs(best - wanted)) best = candidate;
  }
  return best;
}

export function addMedia(project: Project, media: MediaItem): Project {
  if (project.media.some((m) => m.id === media.id)) return project;
  return touch(project, { media: [...project.media, media] });
}

/** Removes a media item and every clip that uses it. */
export function removeMedia(project: Project, mediaId: string): Project {
  return touch(project, {
    media: project.media.filter((m) => m.id !== mediaId),
    clips: project.clips.filter((c) => c.mediaId !== mediaId),
  });
}

export interface PlaceResult {
  project: Project;
  clipId: string | null;
}

/**
 * Places media on the timeline at `start`. If the requested track has no room there, the
 * clip goes on the first track with room, and a new track is added when none has.
 */
export function addClip(project: Project, mediaId: string, start: number, trackId?: string): PlaceResult {
  const media = findMedia(project, mediaId);
  if (!media) return { project, clipId: null };
  const duration = media.kind === 'image' ? DEFAULT_IMAGE_SECONDS : Math.max(MIN_CLIP_SECONDS, media.duration);
  const order = trackId
    ? [trackId, ...project.tracks.map((t) => t.id).filter((id) => id !== trackId)]
    : [...project.tracks].reverse().map((t) => t.id);
  let tracks = project.tracks;
  let chosenTrack: string | null = null;
  let chosenStart = 0;
  for (const id of order) {
    const at = fitOnTrack(project, id, start, duration);
    if (at !== null && Math.abs(at - start) < EPS) {
      chosenTrack = id;
      chosenStart = at;
      break;
    }
  }
  if (!chosenTrack) {
    const track = createTrack(tracks.length);
    tracks = [...tracks, track];
    chosenTrack = track.id;
    chosenStart = Math.max(0, start);
  }
  const clip: Clip = {
    id: newId('clp'),
    trackId: chosenTrack,
    mediaId,
    start: chosenStart,
    in: 0,
    duration,
    props: defaultProps(project),
  };
  return { project: touch(project, { tracks, clips: [...project.clips, clip] }), clipId: clip.id };
}

/** Moves a clip, keeping it on its own gap. Returns the project unchanged if it cannot move. */
export function moveClip(project: Project, clipId: string, start: number, trackId?: string): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || isLocked(project, clip.trackId)) return project;
  const target = trackId ?? clip.trackId;
  const at = fitOnTrack(project, target, start, clip.duration, new Set([clipId]));
  if (at === null) return project;
  if (Math.abs(at - clip.start) < EPS && target === clip.trackId) return project;
  return touch(project, {
    clips: project.clips.map((c) => (c.id === clipId ? { ...c, start: at, trackId: target } : c)),
  });
}

/** Moves the clip's left edge to `newStart`, revealing or hiding source media. */
export function trimStart(project: Project, clipId: string, newStart: number): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || isLocked(project, clip.trackId)) return project;
  const end = clipEnd(clip);
  const prev = trackClips(project, clip.trackId, new Set([clipId])).filter((c) => clipEnd(c) <= clip.start + EPS);
  const floor = Math.max(0, prev.length ? clipEnd(prev[prev.length - 1]) : 0, clip.start - clip.in);
  const start = Math.min(Math.max(newStart, floor), end - MIN_CLIP_SECONDS);
  if (Math.abs(start - clip.start) < EPS) return project;
  const delta = start - clip.start;
  return touch(project, {
    clips: project.clips.map((c) =>
      c.id === clipId ? { ...c, start, in: c.in + delta, duration: c.duration - delta } : c,
    ),
  });
}

/** Moves the clip's right edge to `newEnd`. */
export function trimEnd(project: Project, clipId: string, newEnd: number): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  const media = clip && findMedia(project, clip.mediaId);
  if (!clip || !media || isLocked(project, clip.trackId)) return project;
  const next = trackClips(project, clip.trackId, new Set([clipId])).find((c) => c.start >= clipEnd(clip) - EPS);
  const ceiling = Math.min(
    next ? next.start : Number.POSITIVE_INFINITY,
    clip.start + (maxSourceDuration(media) - clip.in),
  );
  const end = Math.max(Math.min(newEnd, ceiling), clip.start + MIN_CLIP_SECONDS);
  if (Math.abs(end - clipEnd(clip)) < EPS) return project;
  return touch(project, {
    clips: project.clips.map((c) => (c.id === clipId ? { ...c, duration: end - c.start } : c)),
  });
}

/** Splits one clip in two at `time`. Returns the ids of both halves. */
export function splitClip(project: Project, clipId: string, time: number): { project: Project; ids: string[] } {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || isLocked(project, clip.trackId)) return { project, ids: [] };
  if (time <= clip.start + MIN_CLIP_SECONDS || time >= clipEnd(clip) - MIN_CLIP_SECONDS) {
    return { project, ids: [] };
  }
  const leftDuration = time - clip.start;
  const left: Clip = { ...clip, duration: leftDuration };
  const right: Clip = {
    ...clip,
    id: newId('clp'),
    start: time,
    in: clip.in + leftDuration,
    duration: clip.duration - leftDuration,
    props: { ...clip.props },
  };
  const clips = project.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c]));
  return { project: touch(project, { clips }), ids: [left.id, right.id] };
}

/**
 * Splits at the playhead: the given clips if any of them sit under it, otherwise every clip
 * under it on unlocked tracks.
 */
export function splitAt(project: Project, time: number, clipIds: string[] = []): Project {
  const under = project.clips.filter((c) => time > c.start && time < clipEnd(c));
  const chosen = under.filter((c) => clipIds.includes(c.id));
  let next = project;
  for (const c of chosen.length ? chosen : under) next = splitClip(next, c.id, time).project;
  return next;
}

/** Deletes clips. With `ripple`, later clips on the same tracks close the gap. */
export function deleteClips(project: Project, clipIds: string[], ripple = false): Project {
  const doomed = project.clips.filter((c) => clipIds.includes(c.id) && !isLocked(project, c.trackId));
  if (!doomed.length) return project;
  const ids = new Set(doomed.map((c) => c.id));
  let clips = project.clips.filter((c) => !ids.has(c.id));
  if (ripple) {
    clips = clips.map((c) => {
      const shift = doomed
        .filter((d) => d.trackId === c.trackId && clipEnd(d) <= c.start + EPS)
        .reduce((sum, d) => sum + d.duration, 0);
      return shift > 0 ? { ...c, start: Math.max(0, c.start - shift) } : c;
    });
  }
  return touch(project, { clips });
}

export function updateClipProps(project: Project, clipId: string, patch: Partial<ClipProps>): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || isLocked(project, clip.trackId)) return project;
  const props = { ...clip.props, ...patch };
  props.opacity = Math.min(1, Math.max(0, props.opacity));
  props.volume = Math.min(2, Math.max(0, props.volume));
  props.scale = Math.min(20, Math.max(0.01, props.scale));
  return touch(project, { clips: project.clips.map((c) => (c.id === clipId ? { ...c, props } : c)) });
}

export function duplicateClip(project: Project, clipId: string): PlaceResult {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return { project, clipId: null };
  const at = fitOnTrack(project, clip.trackId, clipEnd(clip), clip.duration);
  if (at === null) return { project, clipId: null };
  const copy: Clip = { ...clip, id: newId('clp'), start: at, props: { ...clip.props } };
  return { project: touch(project, { clips: [...project.clips, copy] }), clipId: copy.id };
}

export function addTrack(project: Project): Project {
  return touch(project, { tracks: [...project.tracks, createTrack(project.tracks.length)] });
}

/** Removes a track and its clips. The last remaining track cannot be removed. */
export function removeTrack(project: Project, trackId: string): Project {
  if (project.tracks.length <= 1) return project;
  return touch(project, {
    tracks: project.tracks.filter((t) => t.id !== trackId),
    clips: project.clips.filter((c) => c.trackId !== trackId),
  });
}

export function updateTrack(
  project: Project,
  trackId: string,
  patch: Partial<Pick<Project['tracks'][number], 'name' | 'muted' | 'hidden' | 'locked'>>,
): Project {
  return touch(project, { tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) });
}

export function updateProject(
  project: Project,
  patch: Partial<Pick<Project, 'name' | 'width' | 'height' | 'fps' | 'background'>>,
): Project {
  return touch(project, patch);
}

/** Changes the canvas size, keeping clips and redactions in the same relative place. */
export function resizeCanvas(project: Project, width: number, height: number): Project {
  const kx = width / project.width;
  const ky = height / project.height;
  const canvas = { width, height };
  return touch(project, {
    width,
    height,
    clips: project.clips.map((c) => ({ ...c, props: { ...c.props, x: c.props.x * kx, y: c.props.y * ky } })),
    redactions: project.redactions.map((r) =>
      normaliseRedaction({ ...r, x: r.x * kx, y: r.y * ky, width: r.width * kx, height: r.height * ky }, canvas),
    ),
  });
}

/** Adds a blur region at `start` (3 s long, centred, a quarter of the canvas wide). */
export function addRedaction(project: Project, start: number, patch: Partial<Omit<Redaction, 'id'>> = {}): { project: Project; id: string } {
  const width = project.width / 4;
  const height = project.height / 8;
  const r = normaliseRedaction(
    { id: newId('red'), start, duration: 3, x: (project.width - width) / 2, y: (project.height - height) / 2, width, height, mode: 'blur', strength: 60, ...patch },
    project,
  );
  return { project: touch(project, { redactions: [...project.redactions, r] }), id: r.id };
}

export function updateRedaction(project: Project, id: string, patch: Partial<Omit<Redaction, 'id'>>): Project {
  const current = project.redactions.find((r) => r.id === id);
  if (!current) return project;
  const next = normaliseRedaction({ ...current, ...patch }, project);
  return touch(project, { redactions: project.redactions.map((r) => (r.id === id ? next : r)) });
}

export function removeRedaction(project: Project, id: string): Project {
  if (!project.redactions.some((r) => r.id === id)) return project;
  return touch(project, { redactions: project.redactions.filter((r) => r.id !== id) });
}

/** Replaces every caption (an imported subtitle file, or none). */
export function setCaptions(project: Project, captions: Caption[]): Project {
  const sorted = captions
    .filter((c) => c.end > c.start && c.text.trim())
    .map((c) => ({ ...c, start: Math.max(0, c.start), text: c.text.slice(0, MAX_CAPTION_CHARS) }))
    .sort((a, b) => a.start - b.start);
  return touch(project, { captions: sorted });
}

/**
 * Snaps `time` to the nearest clip edge or extra point (such as the playhead) within
 * `threshold` seconds. Returns `time` unchanged when nothing is close.
 */
export function snapTime(
  project: Project,
  time: number,
  threshold: number,
  ignore: Set<string> = new Set(),
  extra: number[] = [],
): number {
  let best = time;
  let bestDistance = threshold;
  const points = [0, ...extra];
  for (const c of project.clips) {
    if (ignore.has(c.id)) continue;
    points.push(c.start, clipEnd(c));
  }
  for (const p of points) {
    const d = Math.abs(p - time);
    if (d < bestDistance) {
      best = p;
      bestDistance = d;
    }
  }
  return best;
}
