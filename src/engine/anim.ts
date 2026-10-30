// Keyframe animation core: easing curves, per-property keyframe tracks and their evaluation.
// Keyframe times are seconds from the start of the item that owns them (a clip or an annotation),
// so keyframes travel with the item when it is moved.
import { applyBehavior, type Behavior } from './behaviors';

export type EaseName = 'linear' | 'in' | 'out' | 'inOut' | 'hold' | 'back' | 'bounce';
export const EASE_NAMES: EaseName[] = ['linear', 'in', 'out', 'inOut', 'hold', 'back', 'bounce'];

/** The properties that can be animated. `volume` doubles as the audio volume points. */
export type AnimProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'volume';
export const ANIM_PROPS: AnimProp[] = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'];

export interface Keyframe {
  /** Seconds from the start of the owning item. */
  t: number;
  v: number;
  /** Easing used from this key to the next one. */
  ease: EaseName;
}

export type Keys = Partial<Record<AnimProp, Keyframe[]>>;

/** What an item needs to be animated: keyframes and an optional entrance / emphasis / exit preset. */
export interface Animated {
  keys?: Keys;
  behavior?: Behavior;
}

/** Maps linear progress 0..1 to eased progress. `back` overshoots slightly, `bounce` settles like a ball. */
export function ease(name: EaseName, u: number): number {
  const x = Math.min(1, Math.max(0, u));
  switch (name) {
    case 'hold':
      return x >= 1 ? 1 : 0;
    case 'in':
      return x * x * x;
    case 'out':
      return 1 - (1 - x) ** 3;
    case 'inOut':
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
    case 'back': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
    }
    case 'bounce': {
      const n1 = 7.5625;
      const d1 = 2.75;
      if (x < 1 / d1) return n1 * x * x;
      if (x < 2 / d1) return n1 * (x - 1.5 / d1) * (x - 1.5 / d1) + 0.75;
      if (x < 2.5 / d1) return n1 * (x - 2.25 / d1) * (x - 2.25 / d1) + 0.9375;
      return n1 * (x - 2.625 / d1) * (x - 2.625 / d1) + 0.984375;
    }
    default:
      return x;
  }
}

/** Value of one keyframe track at `t`. Without keys the fallback is returned; outside them the end values hold. */
export function evalTrack(keys: Keyframe[] | undefined, t: number, fallback: number): number {
  if (!keys || keys.length === 0) return fallback;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  const u = span > 0 ? (t - a.t) / span : 1;
  return a.v + (b.v - a.v) * ease(a.ease, u);
}

/** The properties an item shows at `localT` (seconds since its own start): its base values overlaid with keyframes, then the behavior preset. */
export function resolveProps<P extends Partial<Record<AnimProp, number>>>(
  base: P,
  item: Animated,
  localT: number,
  duration: number,
  canvas: { width: number; height: number },
): P {
  const out: P = { ...base };
  if (item.keys) {
    for (const prop of ANIM_PROPS) {
      const track = item.keys[prop];
      if (track && track.length && prop in base) (out as Record<string, number>)[prop] = evalTrack(track, localT, base[prop] as number);
    }
  }
  return item.behavior ? applyBehavior(out, item.behavior, localT, duration, canvas) : out;
}

const KEY_EPS = 1e-3;

/** Adds a keyframe, replacing any at (nearly) the same time. Tracks stay sorted by time. */
export function setKey(keys: Keys | undefined, prop: AnimProp, key: Keyframe): Keys {
  const track = (keys?.[prop] ?? []).filter((k) => Math.abs(k.t - key.t) > KEY_EPS);
  track.push({ t: Math.max(0, key.t), v: key.v, ease: key.ease });
  track.sort((a, b) => a.t - b.t);
  return { ...keys, [prop]: track };
}

export function removeKey(keys: Keys | undefined, prop: AnimProp, t: number): Keys | undefined {
  const track = keys?.[prop];
  if (!keys || !track) return keys;
  const next = track.filter((k) => Math.abs(k.t - t) > KEY_EPS);
  const out: Keys = { ...keys };
  if (next.length) out[prop] = next;
  else delete out[prop];
  return Object.keys(out).length ? out : undefined;
}

/** Moves every keyframe by `dt` seconds, dropping empty tracks. Used when the start of an item moves. */
export function shiftKeys(keys: Keys | undefined, dt: number): Keys | undefined {
  if (!keys || dt === 0) return keys;
  const out: Keys = {};
  for (const prop of ANIM_PROPS) {
    const track = keys[prop];
    if (track?.length) out[prop] = track.map((k) => ({ ...k, t: k.t + dt }));
  }
  return Object.keys(out).length ? out : undefined;
}

export function hasKeys(keys: Keys | undefined): boolean {
  return !!keys && Object.values(keys).some((t) => t && t.length > 0);
}

/** Validates keyframes read from a project file. Returns undefined when there are none worth keeping. */
export function parseKeys(input: unknown): Keys | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const out: Keys = {};
  for (const prop of ANIM_PROPS) {
    const raw = (input as Record<string, unknown>)[prop];
    if (!Array.isArray(raw)) continue;
    const track: Keyframe[] = [];
    for (const k of raw) {
      if (!k || typeof k !== 'object') continue;
      const { t, v, ease: e } = k as Record<string, unknown>;
      if (typeof t !== 'number' || typeof v !== 'number' || !Number.isFinite(t) || !Number.isFinite(v)) continue;
      track.push({ t: Math.max(0, t), v, ease: EASE_NAMES.includes(e as EaseName) ? (e as EaseName) : 'linear' });
    }
    track.sort((a, b) => a.t - b.t);
    if (track.length) out[prop] = track;
  }
  return Object.keys(out).length ? out : undefined;
}
