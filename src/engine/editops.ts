// Clip-editing operations (pure, like ops.ts): multi-clip move, copy/paste, grouping and linking,
// magnetic tracks and gap removal, clip speed, freeze and extend frame, crop, detach audio.
// ops.ts keeps the single-clip primitives; this file builds on them so the two areas never collide.
import { type Keys, shiftKeys } from './anim';
import { deleteClips, fitOnTrack, isLocked, splitClip, touch, trackClips, trimEnd, trimStart } from './ops';
import {
  type Clip,
  type Crop,
  type MediaItem,
  type Project,
  type Track,
  MAX_SPEED,
  MIN_CLIP_SECONDS,
  MIN_SPEED,
  clipEnd,
  clipSpeed,
  createTrack,
  findMedia,
  newId,
  normaliseCrop,
  sourceSpan,
  sourceTimeAt,
} from './project';

const EPS = 1e-6;

// ---------------------------------------------------------------------------------------------
// Bundles: which clips travel together
// ---------------------------------------------------------------------------------------------

/**
 * Every clip that edits to `ids` must also touch: the clips themselves plus anything sharing a
 * group id or a link id with them (a video and the audio detached from it, or a user group).
 */
export function bundleIds(project: Project, ids: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const id of ids) if (project.clips.some((c) => c.id === id)) found.add(id);
  for (let changed = true; changed; ) {
    changed = false;
    const groups = new Set<string>();
    const links = new Set<string>();
    for (const c of project.clips) {
      if (!found.has(c.id)) continue;
      if (c.groupId) groups.add(c.groupId);
      if (c.linkId) links.add(c.linkId);
    }
    for (const c of project.clips) {
      if (found.has(c.id)) continue;
      if ((c.groupId && groups.has(c.groupId)) || (c.linkId && links.has(c.linkId))) {
        found.add(c.id);
        changed = true;
      }
    }
  }
  return project.clips.filter((c) => found.has(c.id)).map((c) => c.id);
}

/**
 * The selection a click should produce: selecting one clip of a group selects the whole group.
 * Ids that are not clips (blur regions, annotations) pass through.
 */
export function expandSelection(project: Project, ids: string[]): string[] {
  const groups = new Set<string>();
  for (const id of ids) {
    const g = project.clips.find((c) => c.id === id)?.groupId;
    if (g) groups.add(g);
  }
  if (!groups.size) return ids;
  const out = [...ids];
  for (const c of project.clips) if (c.groupId && groups.has(c.groupId) && !out.includes(c.id)) out.push(c.id);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Moving several clips at once
// ---------------------------------------------------------------------------------------------

interface Slot {
  trackId: string;
  start: number;
  duration: number;
}

/** Does a block of slots (each already on its target track) fit among `others` without overlapping? */
function blockFits(others: Clip[], slots: Slot[]): boolean {
  for (const s of slots) {
    if (s.start < -EPS) return false;
    for (const o of others) {
      if (o.trackId !== s.trackId) continue;
      if (s.start < clipEnd(o) - EPS && o.start < s.start + s.duration - EPS) return false;
    }
  }
  return true;
}

/**
 * The shift nearest to `wanted` (seconds) at which the whole block of slots fits among `others`,
 * or null when none does. Candidates are the wanted shift plus every shift that lines a slot's
 * edge up with a neighbour's edge (or with time zero), so the block lands in the closest free gap.
 */
function nearestShift(others: Clip[], slots: Slot[], wanted: number, exact: boolean): number | null {
  const test = (d: number) => blockFits(others, slots.map((s) => ({ ...s, start: s.start + d })));
  if (exact) return test(wanted) ? wanted : null;
  const candidates = new Set<number>([wanted]);
  const minStart = Math.min(...slots.map((s) => s.start));
  candidates.add(-minStart);
  for (const s of slots) {
    for (const o of others) {
      if (o.trackId !== s.trackId) continue;
      candidates.add(clipEnd(o) - s.start);
      candidates.add(o.start - (s.start + s.duration));
    }
  }
  const ordered = [...candidates].filter((d) => Number.isFinite(d)).sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted));
  for (const d of ordered) if (test(d)) return d;
  return null;
}

export interface MoveOptions {
  /** Move exactly `delta` or not at all, instead of finding the nearest shift that fits. */
  exact?: boolean;
  /** Also move clips linked or grouped with `ids` (default true). */
  bundle?: boolean;
}

/**
 * Moves clips together by `delta` seconds, keeping their offsets from each other, and `trackShift`
 * lanes (positive = toward higher track numbers). All-or-nothing: if any clip would land on a
 * locked or missing track or on top of another clip, nothing moves. Unless `exact`, the shift is
 * adjusted to the nearest one at which the whole block fits.
 */
export function moveClips(project: Project, ids: string[], delta: number, trackShift = 0, opts: MoveOptions = {}): Project {
  const wanted = opts.bundle === false ? ids : bundleIds(project, ids);
  const moving = project.clips.filter((c) => wanted.includes(c.id));
  if (!moving.length) return project;
  const order = project.tracks.map((t) => t.id);
  const slots: Slot[] = [];
  for (const c of moving) {
    const from = order.indexOf(c.trackId);
    const to = from + trackShift;
    if (from < 0 || to < 0 || to >= order.length) return project;
    if (isLocked(project, c.trackId) || isLocked(project, order[to])) return project;
    slots.push({ trackId: order[to], start: c.start, duration: c.duration });
  }
  const movingIds = new Set(moving.map((c) => c.id));
  const others = project.clips.filter((c) => !movingIds.has(c.id));
  const d = nearestShift(others, slots, delta, !!opts.exact);
  if (d === null) return project;
  if (Math.abs(d) < EPS && trackShift === 0) return project;
  return touch(project, {
    clips: project.clips.map((c) => {
      const i = moving.indexOf(c);
      return i < 0 ? c : { ...c, start: Math.max(0, c.start + d), trackId: slots[i].trackId };
    }),
  });
}

// ---------------------------------------------------------------------------------------------
// Copy, paste, duplicate
// ---------------------------------------------------------------------------------------------

/** A deep copy of the clips (keyframes, effects and all) for the clipboard. Bundles come along. */
export function snapshotClips(project: Project, ids: string[]): Clip[] {
  const wanted = bundleIds(project, ids);
  return project.clips.filter((c) => wanted.includes(c.id)).map((c) => structuredClone(c));
}

/** First unlocked track, adding one if every track is locked. */
function spareTrack(project: Project): { project: Project; trackId: string } {
  const open = project.tracks.find((t) => !t.locked);
  if (open) return { project, trackId: open.id };
  const track = createTrack(project.tracks.length);
  return { project: touch(project, { tracks: [...project.tracks, track] }), trackId: track.id };
}

export interface PasteResult {
  project: Project;
  ids: string[];
}

/**
 * Pastes clip snapshots so the earliest one starts at `time`. Offsets between them and their tracks
 * are kept; clips whose track is gone or locked go to the first open track. The block slides to the
 * nearest place where all of it fits. New ids throughout; a link or group survives only when every
 * member of it was copied (under new ids).
 */
export function pasteClips(project: Project, items: Clip[], time: number): PasteResult {
  const usable = items.filter((c) => findMedia(project, c.mediaId));
  if (!usable.length) return { project, ids: [] };
  let next = project;
  const trackOf = (c: Clip): string => {
    const t = next.tracks.find((x) => x.id === c.trackId);
    if (t && !t.locked) return t.id;
    const spare = spareTrack(next);
    next = spare.project;
    return spare.trackId;
  };
  const tracks = usable.map(trackOf);
  const origin = Math.min(...usable.map((c) => c.start));
  const slots: Slot[] = usable.map((c, i) => ({ trackId: tracks[i], start: c.start, duration: c.duration }));
  const delta = nearestShift(next.clips, slots, Math.max(0, time) - origin, false);
  if (delta === null) return { project, ids: [] };
  const count = (key: 'groupId' | 'linkId') => {
    const n = new Map<string, number>();
    for (const c of usable) if (c[key]) n.set(c[key]!, (n.get(c[key]!) ?? 0) + 1);
    return n;
  };
  const groups = count('groupId');
  const links = count('linkId');
  const fresh = new Map<string, string>();
  const remap = (kind: string, id: string | undefined, uses: Map<string, number>): string | undefined => {
    if (!id || (uses.get(id) ?? 0) < 2) return undefined;
    const key = `${kind}:${id}`;
    if (!fresh.has(key)) fresh.set(key, newId(kind));
    return fresh.get(key);
  };
  const made: Clip[] = usable.map((c, i) => {
    const { groupId: _g, linkId: _l, ...rest } = structuredClone(c);
    const copy: Clip = { ...rest, id: newId('clp'), trackId: tracks[i], start: Math.max(0, c.start + delta) };
    const g = remap('grp', c.groupId, groups);
    const l = remap('lnk', c.linkId, links);
    if (g) copy.groupId = g;
    if (l) copy.linkId = l;
    return copy;
  });
  return { project: touch(next, { clips: [...next.clips, ...made] }), ids: made.map((c) => c.id) };
}

/** Copies the clips (and their bundles) to just after the selection, on the same tracks. */
export function duplicateClips(project: Project, ids: string[]): PasteResult {
  const items = snapshotClips(project, ids);
  if (!items.length) return { project, ids: [] };
  return pasteClips(project, items, Math.max(...items.map(clipEnd)));
}

// ---------------------------------------------------------------------------------------------
// Groups and links
// ---------------------------------------------------------------------------------------------

/** Puts the clips (and any groups they already belong to) in one new group. Needs two or more clips. */
export function groupClips(project: Project, ids: string[]): { project: Project; groupId: string | null } {
  const picked = new Set(expandSelection(project, ids).filter((id) => project.clips.some((c) => c.id === id)));
  if (picked.size < 2) return { project, groupId: null };
  const groupId = newId('grp');
  return { project: touch(project, { clips: project.clips.map((c) => (picked.has(c.id) ? { ...c, groupId } : c)) }), groupId };
}

/** Dissolves the groups of the given clips. */
export function ungroupClips(project: Project, ids: string[]): Project {
  const picked = new Set(expandSelection(project, ids));
  if (!project.clips.some((c) => picked.has(c.id) && c.groupId)) return project;
  return touch(project, {
    clips: project.clips.map((c) => {
      if (!picked.has(c.id) || !c.groupId) return c;
      const { groupId: _g, ...rest } = c;
      return rest;
    }),
  });
}

/** Breaks the picture/audio link of the given clips. */
export function unlinkClips(project: Project, ids: string[]): Project {
  const picked = new Set(bundleIds(project, ids));
  if (!project.clips.some((c) => picked.has(c.id) && c.linkId)) return project;
  return touch(project, {
    clips: project.clips.map((c) => {
      if (!picked.has(c.id) || !c.linkId) return c;
      const { linkId: _l, ...rest } = c;
      return rest;
    }),
  });
}

// ---------------------------------------------------------------------------------------------
// Edits that carry their bundle along: delete, trim, split
// ---------------------------------------------------------------------------------------------

/** Deletes clips together with everything linked or grouped with them, then closes gaps on magnetic tracks. */
export function deleteBundle(project: Project, ids: string[], ripple = false): Project {
  const doomed = bundleIds(project, ids);
  if (!doomed.length) return project;
  const next = deleteClips(project, doomed, ripple);
  return next === project ? project : magnetize(next);
}

/**
 * Trims one edge of a clip. Clips linked or grouped with it that share the same edge time follow by
 * the same amount (the largest amount all of them can manage), so a video and its audio stay in step.
 */
export function trimBundle(project: Project, clipId: string, edge: 'start' | 'end', time: number): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const trim = edge === 'start' ? trimStart : trimEnd;
  const edgeOf = (c: Clip) => (edge === 'start' ? c.start : clipEnd(c));
  const e0 = edgeOf(clip);
  const team = bundleIds(project, [clipId])
    .map((id) => project.clips.find((c) => c.id === id)!)
    .filter((c) => c.id === clipId || (Math.abs(edgeOf(c) - e0) < 1e-3 && !isLocked(project, c.trackId)));
  if (team.length === 1) return trim(project, clipId, time);
  let delta = time - e0;
  for (const c of team) {
    const reached = edgeOf(trim(project, c.id, edgeOf(c) + delta).clips.find((x) => x.id === c.id)!) - edgeOf(c);
    if (Math.abs(reached) < Math.abs(delta)) delta = reached;
  }
  if (Math.abs(delta) < EPS) return project;
  let next = project;
  for (const c of team) next = trim(next, c.id, edgeOf(c) + delta);
  return next;
}

/**
 * Splits at `time`: the selected clips under it (or every clip under it when none of the selection
 * is). Clips linked or grouped with a split clip are split too, and the right halves form new links
 * and groups of their own.
 */
export function splitBundle(project: Project, time: number, selection: string[] = []): Project {
  const under = project.clips.filter((c) => time > c.start && time < clipEnd(c));
  const chosen = under.filter((c) => selection.includes(c.id));
  const base = (chosen.length ? chosen : under).map((c) => c.id);
  const ids = new Set(bundleIds(project, base).filter((id) => under.some((c) => c.id === id)));
  const fresh = new Map<string, string>();
  let next = project;
  for (const id of ids) {
    const r = splitClip(next, id, time);
    if (r.ids.length !== 2) continue;
    next = r.project;
    const original = project.clips.find((c) => c.id === id)!;
    const patch: Partial<Clip> = {};
    for (const [key, kind] of [['groupId', 'grp'], ['linkId', 'lnk']] as const) {
      const old = original[key];
      if (!old) continue;
      if (!fresh.has(`${kind}:${old}`)) fresh.set(`${kind}:${old}`, newId(kind));
      patch[key] = fresh.get(`${kind}:${old}`);
    }
    if (patch.groupId || patch.linkId) next = touch(next, { clips: next.clips.map((c) => (c.id === r.ids[1] ? { ...c, ...patch } : c)) });
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// Gaps and magnetic tracks
// ---------------------------------------------------------------------------------------------

export interface Gap {
  start: number;
  end: number;
}

/** The empty stretches before and between a track's clips (the open end after the last clip is not a gap). */
export function trackGaps(project: Project, trackId: string): Gap[] {
  const gaps: Gap[] = [];
  let cursor = 0;
  for (const c of trackClips(project, trackId)) {
    if (c.start - cursor > 1e-4) gaps.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, clipEnd(c));
  }
  return gaps;
}

/**
 * Closes the gap at `time` on a track: every clip after it (and whatever is linked or grouped with
 * those) moves earlier by the gap's length. Does nothing if `time` is not in a gap, the track is
 * locked, or a linked clip on another track would have nowhere to go.
 */
export function removeGapAt(project: Project, trackId: string, time: number): Project {
  if (isLocked(project, trackId)) return project;
  const gap = trackGaps(project, trackId).find((g) => time >= g.start - EPS && time < g.end);
  if (!gap) return project;
  const later = trackClips(project, trackId).filter((c) => c.start >= gap.end - EPS);
  return moveClips(project, later.map((c) => c.id), -(gap.end - gap.start), 0, { exact: true });
}

/** Closes every gap on a track, from the start of the timeline. */
export function closeGaps(project: Project, trackId: string): Project {
  const skipped = new Set<string>();
  let next = project;
  for (let guard = 0; guard < 1000; guard++) {
    const gap = trackGaps(next, trackId).find((g) => !skipped.has(g.end.toFixed(4)));
    if (!gap) break;
    const moved = removeGapAt(next, trackId, gap.start);
    if (moved === next) skipped.add(gap.end.toFixed(4));
    else next = moved;
  }
  return next;
}

/** Closes the gaps on every magnetic track (or just those listed). */
export function magnetize(project: Project, only?: string[]): Project {
  let next = project;
  for (const t of project.tracks) {
    if (!t.magnetic || t.locked || (only && !only.includes(t.id))) continue;
    next = closeGaps(next, t.id);
  }
  return next;
}

/** Turns a track's magnetic mode on or off. Turning it on closes its gaps straight away. */
export function setTrackMagnetic(project: Project, trackId: string, on: boolean): Project {
  if (!project.tracks.some((t) => t.id === trackId)) return project;
  const patch = (t: Track): Track => {
    if (t.id !== trackId) return t;
    if (on) return { ...t, magnetic: true };
    const { magnetic: _m, ...rest } = t;
    return rest;
  };
  const marked = touch(project, { tracks: project.tracks.map(patch) });
  return on ? closeGaps(marked, trackId) : marked;
}

// ---------------------------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------------------------

function scaleKeys(keys: Keys | undefined, k: number): Keys | undefined {
  if (!keys || k === 1) return keys;
  const out: Keys = {};
  for (const [prop, track] of Object.entries(keys)) if (track?.length) out[prop as keyof Keys] = track.map((key) => ({ ...key, t: key.t * k }));
  return out;
}

/** Moves every clip on a track that starts at or after `from` by `by` seconds (never before zero). */
function shiftLater(project: Project, trackId: string, from: number, by: number, ignore: Set<string>): Project {
  if (Math.abs(by) < EPS) return project;
  return touch(project, {
    clips: project.clips.map((c) => (c.trackId === trackId && !ignore.has(c.id) && c.start >= from - EPS ? { ...c, start: Math.max(0, c.start + by) } : c)),
  });
}

export function speedClamp(speed: number): number {
  return Number.isFinite(speed) ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)) : 1;
}

/** Can this clip's speed change? Pictures and holds have no source time to speed up. */
export function canChangeSpeed(project: Project, clip: Clip): boolean {
  const media = findMedia(project, clip.mediaId);
  return !!media && media.kind !== 'image' && !clip.freeze;
}

/**
 * Changes a clip's playback speed while it keeps showing the same stretch of source, so its length
 * on the timeline changes: twice as fast is half as long. A clip linked to it (its detached audio)
 * follows. Without `ripple`, a longer clip stops at the next clip on its track (showing less of
 * the source); with `ripple`, later clips on that track move to make room or close up.
 */
export function setClipSpeed(project: Project, clipId: string, speed: number, opts: { ripple?: boolean } = {}): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const target = speedClamp(speed);
  const team = (clip.linkId ? project.clips.filter((c) => c.linkId === clip.linkId) : [clip]).filter(
    (c) => canChangeSpeed(project, c) && !isLocked(project, c.trackId),
  );
  if (!team.some((c) => c.id === clipId)) return project;
  const changing = team.filter((c) => Math.abs(clipSpeed(c) - target) > 1e-9);
  if (!changing.length) return project;
  const plan = changing.map((c) => ({ clip: c, nominal: Math.max(MIN_CLIP_SECONDS, sourceSpan(c) / target) }));
  let ratio = 1;
  if (!opts.ripple) {
    const members = new Set(changing.map((c) => c.id));
    for (const p of plan) {
      if (p.nominal <= p.clip.duration) continue;
      const next = trackClips(project, p.clip.trackId, members).find((o) => o.start >= clipEnd(p.clip) - EPS);
      const room = next ? next.start - p.clip.start : Number.POSITIVE_INFINITY;
      ratio = Math.min(ratio, Math.max(0, room) / p.nominal);
    }
    if (plan.some((p) => p.nominal * ratio < MIN_CLIP_SECONDS)) return project;
  }
  let next = project;
  if (opts.ripple) {
    const members = new Set(changing.map((c) => c.id));
    for (const p of plan) next = shiftLater(next, p.clip.trackId, clipEnd(p.clip), p.nominal - p.clip.duration, members);
  }
  const byId = new Map(plan.map((p) => [p.clip.id, p]));
  return touch(next, {
    clips: next.clips.map((c) => {
      const p = byId.get(c.id);
      if (!p) return c;
      const { speed: _s, ...rest } = c;
      const out: Clip = { ...rest, duration: p.nominal * ratio, keys: scaleKeys(c.keys, p.nominal / c.duration) };
      if (Math.abs(target - 1) > 1e-9) out.speed = target;
      if (!out.keys) delete out.keys;
      return out;
    }),
  });
}

// ---------------------------------------------------------------------------------------------
// Freeze frame and extend frame
// ---------------------------------------------------------------------------------------------

function lastFrameSource(media: MediaItem, t: number, fps: number): number {
  return Math.max(0, Math.min(t, media.duration - 1 / fps));
}

function holdClip(from: Clip, patch: { start: number; in: number; duration: number }): Clip {
  const { speed: _s, keys: _k, behavior: _b, transitionIn: _ti, transitionOut: _to, linkId: _l, audioOnly: _a, muteAudio: _m, audio: _au, ...rest } = from;
  return { ...rest, ...patch, id: newId('clp'), props: { ...from.props }, freeze: true };
}

/**
 * Splits `clip` at `time` and clears `seconds` of timeline after it on its track. With `ripple`
 * everything after moves later; without it the clip's right half is trimmed from its start (the
 * hold overwrites the picture it replaces).
 */
function carve(project: Project, clipId: string, time: number, seconds: number, ripple: boolean): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const end = clipEnd(clip);
  const hasLeft = time > clip.start + MIN_CLIP_SECONDS;
  const hasRight = time < end - MIN_CLIP_SECONDS;
  const at = hasLeft ? time : clip.start;
  const cut = at - clip.start;
  const speed = clip.freeze ? 0 : clipSpeed(clip);
  const parts: Clip[] = [];
  if (hasLeft) parts.push({ ...clip, duration: cut, transitionOut: hasRight ? undefined : clip.transitionOut });
  if (hasRight || !hasLeft) {
    const rest = end - at;
    const right: Clip = {
      ...clip,
      id: hasLeft ? newId('clp') : clip.id,
      start: at + seconds,
      in: clip.in + cut * speed,
      duration: rest,
      props: { ...clip.props },
      keys: shiftKeys(clip.keys, -cut),
      transitionIn: hasLeft ? undefined : clip.transitionIn,
    };
    if (!ripple) {
      right.in += seconds * speed;
      right.duration = rest - seconds;
      right.keys = shiftKeys(right.keys, -seconds);
      right.transitionIn = undefined;
    }
    if (right.duration >= MIN_CLIP_SECONDS) parts.push(right);
  }
  const ids = new Set(parts.map((p) => p.id));
  let next = touch(project, { clips: project.clips.flatMap((c) => (c.id === clipId ? parts : [c])) });
  if (ripple) next = shiftLater(next, clip.trackId, end, seconds, ids);
  return next;
}

export interface HoldResult {
  project: Project;
  clipId: string | null;
}

/** Seconds of room after `time` on the clip's track (own right half plus free space up to the next clip). */
function roomAfter(project: Project, clip: Clip, time: number): number {
  const next = trackClips(project, clip.trackId, new Set([clip.id])).find((o) => o.start >= clipEnd(clip) - EPS);
  return (next ? next.start : Number.POSITIVE_INFINITY) - time;
}

/**
 * Freeze frame: holds the picture at `time` for `seconds`. The clip is split there and a still clip
 * is put between the halves. With `ripple` the rest of the track moves later by `seconds`; without
 * it the hold overwrites the following picture. A linked clip (detached audio) is split and moved
 * in step, so sound stays aligned and is silent during the hold.
 */
export function freezeFrame(project: Project, clipId: string, time: number, seconds: number, opts: { ripple?: boolean } = {}): HoldResult {
  const clip = project.clips.find((c) => c.id === clipId);
  const media = clip && findMedia(project, clip.mediaId);
  if (!clip || !media || media.kind !== 'video' || clip.audioOnly || clip.freeze || isLocked(project, clip.trackId)) return { project, clipId: null };
  if (time < clip.start - EPS || time > clipEnd(clip) + EPS) return { project, clipId: null };
  const ripple = !!opts.ripple;
  const at = Math.min(clipEnd(clip), Math.max(clip.start, time));
  const wanted = Math.max(MIN_CLIP_SECONDS, seconds);
  const hold = ripple ? wanted : Math.min(wanted, roomAfter(project, clip, at));
  if (hold < MIN_CLIP_SECONDS) return { project, clipId: null };
  const source = lastFrameSource(media, sourceTimeAt(clip, at), project.fps);
  const partners = clip.linkId ? project.clips.filter((c) => c.linkId === clip.linkId && c.id !== clip.id && !isLocked(project, c.trackId)) : [];
  let next = carve(project, clipId, at, hold, ripple);
  for (const p of partners) if (at > p.start && at < clipEnd(p)) next = carve(next, p.id, at, hold, ripple);
  const made = holdClip(clip, { start: at <= clip.start + MIN_CLIP_SECONDS ? clip.start : at, in: source, duration: hold });
  return { project: touch(next, { clips: [...next.clips, made] }), clipId: made.id };
}

/**
 * Extend frame: holds the clip's last picture for `seconds` after it, as a still clip. With `ripple`
 * later clips on the track (and on tracks of linked clips) move later; without it the hold stops at
 * the next clip. A still image or a hold is simply made longer.
 */
export function extendFrame(project: Project, clipId: string, seconds: number, opts: { ripple?: boolean } = {}): HoldResult {
  const clip = project.clips.find((c) => c.id === clipId);
  const media = clip && findMedia(project, clip.mediaId);
  if (!clip || !media || media.kind === 'audio' || clip.audioOnly || isLocked(project, clip.trackId)) return { project, clipId: null };
  const ripple = !!opts.ripple;
  const end = clipEnd(clip);
  const wanted = Math.max(MIN_CLIP_SECONDS, seconds);
  const hold = ripple ? wanted : Math.min(wanted, roomAfter(project, clip, end));
  if (hold < MIN_CLIP_SECONDS) return { project, clipId: null };
  let next = project;
  if (ripple) {
    const partners = clip.linkId ? project.clips.filter((c) => c.linkId === clip.linkId) : [clip];
    for (const t of new Set(partners.map((c) => c.trackId))) next = shiftLater(next, t, end, hold, new Set([clipId]));
  }
  if (media.kind === 'image' || clip.freeze) {
    return { project: touch(next, { clips: next.clips.map((c) => (c.id === clipId ? { ...c, duration: c.duration + hold } : c)) }), clipId };
  }
  const source = Math.max(clip.in, lastFrameSource(media, sourceTimeAt(clip, end) - 1 / project.fps, project.fps));
  const made = holdClip(clip, { start: end, in: source, duration: hold });
  return { project: touch(next, { clips: [...next.clips, made] }), clipId: made.id };
}

// ---------------------------------------------------------------------------------------------
// Crop
// ---------------------------------------------------------------------------------------------

/** Sets (or, with undefined or the full frame, clears) the crop of a clip. */
export function setClipCrop(project: Project, clipId: string, crop: Crop | undefined): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || isLocked(project, clip.trackId)) return project;
  const next = normaliseCrop(crop);
  const same = (a?: Crop, b?: Crop) => (!a && !b) || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
  if (same(next, clip.crop)) return project;
  return touch(project, {
    clips: project.clips.map((c) => {
      if (c.id !== clipId) return c;
      const { crop: _c, ...rest } = c;
      return next ? { ...rest, crop: next } : rest;
    }),
  });
}

/**
 * The largest crop of `aspect` (width / height, in source pixels) that fits the frame, centred on the
 * middle of `current` and nudged back inside when it would stick out.
 */
export function cropForAspect(media: { width: number; height: number }, current: Crop | undefined, aspect: number): Crop {
  const frame = media.width / media.height;
  let width = 1;
  let height = frame / aspect;
  if (height > 1) {
    height = 1;
    width = aspect / frame;
  }
  const cx = current ? current.x + current.width / 2 : 0.5;
  const cy = current ? current.y + current.height / 2 : 0.5;
  return { x: Math.min(1 - width, Math.max(0, cx - width / 2)), y: Math.min(1 - height, Math.max(0, cy - height / 2)), width, height };
}

export interface CropHandle {
  /** -1 = left edge, 0 = none, 1 = right edge. */
  hx: -1 | 0 | 1;
  /** -1 = top edge, 0 = none, 1 = bottom edge. */
  hy: -1 | 0 | 1;
}

const MIN_CROP = 0.02;

/**
 * Drags a crop handle by (`fx`, `fy`), given as fractions of the source frame. A corner moves two
 * edges, an edge one; hx = hy = 0 moves the whole rectangle. With `aspect` (width / height in source
 * pixels) the shape is kept: a corner follows the larger movement and an edge resizes the other side
 * about its centre. The result always stays inside the frame and at least 2% each way.
 */
export function dragCrop(start: Crop, handle: CropHandle, fx: number, fy: number, frame: { width: number; height: number }, aspect?: number): Crop {
  const { hx, hy } = handle;
  if (hx === 0 && hy === 0) {
    return { ...start, x: Math.min(1 - start.width, Math.max(0, start.x + fx)), y: Math.min(1 - start.height, Math.max(0, start.y + fy)) };
  }
  const cx = start.x + start.width / 2;
  const cy = start.y + start.height / 2;
  const roomW = hx < 0 ? start.x + start.width : hx > 0 ? 1 - start.x : 2 * Math.min(cx, 1 - cx);
  const roomH = hy < 0 ? start.y + start.height : hy > 0 ? 1 - start.y : 2 * Math.min(cy, 1 - cy);
  let w = hx === 0 ? start.width : start.width + hx * fx;
  let h = hy === 0 ? start.height : start.height + hy * fy;
  if (aspect && aspect > 0) {
    const k = frame.width / (frame.height * aspect); // height = width * k
    if (hx !== 0 && hy !== 0) {
      if (Math.abs(w - start.width) >= Math.abs(h / k - start.width)) h = w * k;
      else w = h / k;
    } else if (hx !== 0) h = w * k;
    else w = h / k;
    const s = Math.min(1, roomW / Math.max(w, 1e-9), roomH / Math.max(h, 1e-9));
    w *= s;
    h *= s;
    if (w < MIN_CROP) {
      w = MIN_CROP;
      h = w * k;
    }
    if (h < MIN_CROP) {
      h = MIN_CROP;
      w = h / k;
    }
  } else {
    w = Math.min(roomW, Math.max(MIN_CROP, w));
    h = Math.min(roomH, Math.max(MIN_CROP, h));
  }
  const x = hx < 0 ? start.x + start.width - w : hx > 0 ? start.x : cx - w / 2;
  const y = hy < 0 ? start.y + start.height - h : hy > 0 ? start.y : cy - h / 2;
  return { x: Math.min(1 - w, Math.max(0, x)), y: Math.min(1 - h, Math.max(0, y)), width: w, height: h };
}

// ---------------------------------------------------------------------------------------------
// Detach audio
// ---------------------------------------------------------------------------------------------

/** Can the sound of this clip be split off its picture? */
export function canDetachAudio(project: Project, clip: Clip): boolean {
  const media = findMedia(project, clip.mediaId);
  return !!media && media.kind === 'video' && media.hasAudio && !clip.audioOnly && !clip.freeze && !clip.muteAudio && !isLocked(project, clip.trackId);
}

function carriesOnlySound(project: Project, trackId: string): boolean {
  return project.clips.filter((c) => c.trackId === trackId).every((c) => c.audioOnly || findMedia(project, c.mediaId)?.kind === 'audio');
}

/**
 * Splits the sound off a video clip. A new audio-only clip of the same media, timing and speed is
 * placed on a free track (a new "Audio" track when none has room), and the two share a link id so
 * they move, trim, split and delete together. The picture clip's own sound is silenced with
 * `muteAudio` rather than by zeroing its volume, so the user's volume setting is untouched and the
 * player and the export mixer can both tell "silenced" from "quiet".
 */
export function detachAudio(project: Project, clipId: string): { project: Project; audioClipId: string | null } {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || !canDetachAudio(project, clip)) return { project, audioClipId: null };
  let tracks = project.tracks;
  let trackId = tracks.find((t) => {
    if (t.id === clip.trackId || t.locked || !carriesOnlySound(project, t.id)) return false;
    const at = fitOnTrack(project, t.id, clip.start, clip.duration);
    return at !== null && Math.abs(at - clip.start) < EPS;
  })?.id;
  if (!trackId) {
    const track = { ...createTrack(tracks.length), name: 'Audio' };
    tracks = [...tracks, track];
    trackId = track.id;
  }
  const linkId = clip.linkId ?? newId('lnk');
  const { crop: _crop, effects: _fx, behavior: _b, transitionIn: _ti, transitionOut: _to, keys, ...rest } = clip;
  const audioClip: Clip = {
    ...rest,
    id: newId('clp'),
    trackId,
    props: { ...clip.props },
    linkId,
    audioOnly: true,
    ...(keys?.volume ? { keys: { volume: structuredClone(keys.volume) } } : {}),
  };
  const clips = project.clips.map((c) => (c.id === clipId ? { ...c, muteAudio: true, linkId } : c));
  return { project: touch(project, { tracks, clips: [...clips, audioClip] }), audioClipId: audioClip.id };
}
