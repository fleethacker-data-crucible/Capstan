// Edits for the animation area: keyframes on a clip, transitions, behaviors, and auto-key.
// Pure functions from one Project to the next, like ops.ts.
import { ANIM_PROPS, type AnimProp, type EaseName, type Keyframe, evalTrack, hasKeys, removeKey, setKey } from './anim';
import { type Behavior, type BehaviorStep, setBehaviorStep } from './behaviors';
import { isLocked, touch, updateClipProps } from './ops';
import type { Clip, ClipProps, Project } from './project';
import type { Transition } from './transitions';

/** Properties that auto-key. Volume points belong to the audio area and are never keyed from here. */
export const AUTO_KEY_PROPS: AnimProp[] = ['x', 'y', 'scale', 'rotation', 'opacity'];

/** Default easing for a key the user adds. */
export const DEFAULT_KEY_EASE: EaseName = 'inOut';

/** Seconds from the clip's start, clamped into the clip. */
export function localTime(clip: Pick<Clip, 'start' | 'duration'>, time: number): number {
  return Math.min(clip.duration, Math.max(0, time - clip.start));
}

/** The clip's values at `time` with keyframes applied but no behavior preset: what an editor control should show. */
export function keyedProps(clip: Pick<Clip, 'props' | 'keys' | 'start' | 'duration'>, time: number): ClipProps {
  if (!clip.keys) return clip.props;
  const t = localTime(clip, time);
  const out: ClipProps = { ...clip.props };
  for (const prop of ANIM_PROPS) {
    const track = clip.keys[prop];
    if (track?.length) out[prop] = evalTrack(track, t, clip.props[prop]);
  }
  return out;
}

/** True when the clip has keyframes on `prop`. */
export function isKeyed(clip: Pick<Clip, 'keys'>, prop: AnimProp): boolean {
  return !!clip.keys?.[prop]?.length;
}

/** The key at (nearly) local time `t`, if there is one. */
export function keyAt(clip: Pick<Clip, 'keys'>, prop: AnimProp, t: number): Keyframe | undefined {
  return clip.keys?.[prop]?.find((k) => Math.abs(k.t - t) <= 1e-3);
}

function withClip(project: Project, clipId: string, change: (clip: Clip) => Clip): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || isLocked(project, clip.trackId)) return project;
  const next = change(clip);
  if (next === clip) return project;
  return touch(project, { clips: project.clips.map((c) => (c.id === clipId ? next : c)) });
}

/** Sets a key on one property at `time` (timeline seconds) to `value`, or to the property's current value. */
export function addClipKey(project: Project, clipId: string, prop: AnimProp, time: number, value?: number, ease?: EaseName): Project {
  return withClip(project, clipId, (clip) => {
    const t = localTime(clip, time);
    const v = value ?? keyedProps(clip, time)[prop];
    const existing = keyAt(clip, prop, t);
    return { ...clip, keys: setKey(clip.keys, prop, { t, v, ease: ease ?? existing?.ease ?? DEFAULT_KEY_EASE }) };
  });
}

export function removeClipKey(project: Project, clipId: string, prop: AnimProp, t: number): Project {
  return withClip(project, clipId, (clip) => {
    if (!clip.keys?.[prop]) return clip;
    const keys = removeKey(clip.keys, prop, t);
    return { ...clip, keys };
  });
}

/** Changes the easing used from one key to the next. */
export function setKeyEase(project: Project, clipId: string, prop: AnimProp, t: number, ease: EaseName): Project {
  return withClip(project, clipId, (clip) => {
    const key = keyAt(clip, prop, t);
    if (!key || key.ease === ease) return clip;
    return { ...clip, keys: setKey(clip.keys, prop, { ...key, ease }) };
  });
}

/** Moves a key to a new local time (the value and easing stay). */
export function moveClipKey(project: Project, clipId: string, prop: AnimProp, t: number, newT: number): Project {
  return withClip(project, clipId, (clip) => {
    const key = keyAt(clip, prop, t);
    if (!key) return clip;
    const without = removeKey(clip.keys, prop, t);
    return { ...clip, keys: setKey(without, prop, { ...key, t: Math.min(clip.duration, Math.max(0, newT)) }) };
  });
}

/** Drops every keyframe on one property (or all of them). */
export function clearClipKeys(project: Project, clipId: string, prop?: AnimProp): Project {
  return withClip(project, clipId, (clip) => {
    if (!hasKeys(clip.keys)) return clip;
    if (!prop) return { ...clip, keys: undefined };
    const keys = { ...clip.keys };
    delete keys[prop];
    return { ...clip, keys: hasKeys(keys) ? keys : undefined };
  });
}

/**
 * Edits clip properties with auto-key: a property that already has keyframes gets a key at `time`
 * instead of a new base value, so dragging a keyed clip in the preview or typing in the inspector
 * animates it. Properties without keyframes change as before.
 */
export function updateClipPropsAt(project: Project, clipId: string, patch: Partial<ClipProps>, time: number): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || !hasKeys(clip.keys)) return updateClipProps(project, clipId, patch);
  const keyed: Partial<ClipProps> = {};
  const plain: Partial<ClipProps> = {};
  for (const prop of Object.keys(patch) as Array<keyof ClipProps>) {
    if ((AUTO_KEY_PROPS as string[]).includes(prop) && isKeyed(clip, prop as AnimProp)) keyed[prop] = patch[prop];
    else plain[prop] = patch[prop];
  }
  let next = Object.keys(plain).length ? updateClipProps(project, clipId, plain) : project;
  for (const prop of Object.keys(keyed) as AnimProp[]) {
    next = addClipKey(next, clipId, prop, time, clampProp(prop, keyed[prop as keyof ClipProps] as number));
  }
  return next;
}

function clampProp(prop: AnimProp, v: number): number {
  if (prop === 'opacity') return Math.min(1, Math.max(0, v));
  if (prop === 'scale') return Math.min(20, Math.max(0.01, v));
  return v;
}

/** Sets or clears a clip's transition at its start (`in`) or end (`out`). */
export function setClipTransition(project: Project, clipId: string, edge: 'in' | 'out', transition: Transition | undefined): Project {
  return withClip(project, clipId, (clip) => (edge === 'in' ? { ...clip, transitionIn: transition } : { ...clip, transitionOut: transition }));
}

/** Sets or clears one stage of a clip's behavior. */
export function setClipBehavior(project: Project, clipId: string, stage: keyof Behavior, step: BehaviorStep | undefined): Project {
  return withClip(project, clipId, (clip) => ({ ...clip, behavior: setBehaviorStep(clip.behavior, stage, step) }));
}
