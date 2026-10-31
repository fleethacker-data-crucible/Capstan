// Transitions: how a clip appears at its start and leaves at its end.
//
// A transition acts on one clip's own layer (opacity, offset, size, a clipping window), so it is
// drawn the same way in the preview and the export. Two touching clips on one track therefore fade
// "through" the background (A fades out, then B fades in) rather than cross-dissolving: clips never
// overlap on a track and only the active clip's media is decoded, so the outgoing picture is not
// available while the incoming one starts. Put the clips on two tracks with the top one fading in
// for a true cross-dissolve.
import { ease } from './anim';

export interface Transition {
  /** Preset name: 'fade', 'slide-left' ..., 'wipe-left' ..., 'zoom' or 'pop'. */
  type: string;
  /** Seconds the transition takes, inside the clip's own length. */
  duration: number;
}

/** What a transition does to a clip's layer at one moment. The compositor applies it. */
export interface LayerMod {
  /** Multiplies the clip's opacity (1 = unchanged). */
  alpha: number;
  /** Offset of the layer in canvas pixels. */
  dx: number;
  dy: number;
  /** Multiplies the clip's scale (1 = unchanged). */
  scale: number;
  /** Visible part of the layer as fractions of its own box (a wipe), or undefined for all of it. */
  wipe?: { x0: number; y0: number; x1: number; y1: number };
}

export interface TransitionHost {
  start: number;
  duration: number;
  transitionIn?: Transition;
  transitionOut?: Transition;
}

export const TRANSITION_TYPES = ['fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down', 'zoom', 'pop'] as const;

export const TRANSITION_LABELS: Record<string, string> = {
  fade: 'Fade',
  'slide-left': 'Slide from the left',
  'slide-right': 'Slide from the right',
  'slide-up': 'Slide from the top',
  'slide-down': 'Slide from the bottom',
  'wipe-left': 'Wipe to the left',
  'wipe-right': 'Wipe to the right',
  'wipe-up': 'Wipe upwards',
  'wipe-down': 'Wipe downwards',
  zoom: 'Zoom',
  pop: 'Pop',
};

export const MIN_TRANSITION_SECONDS = 0.05;
export const MAX_TRANSITION_SECONDS = 10;

/** The transition's length as it plays: never more than half the clip, so the two ends never meet. */
export function effectiveTransitionSeconds(t: Transition | undefined, clipDuration: number): number {
  if (!t) return 0;
  return Math.max(0, Math.min(t.duration, clipDuration / 2));
}

const NONE: LayerMod = { alpha: 1, dx: 0, dy: 0, scale: 1 };

/**
 * The layer modification at progress `p` (0 = hidden, 1 = fully shown). When `leaving`, the motion
 * carries on in the same direction instead of reversing.
 */
function modAt(type: string, p: number, leaving: boolean, canvas: { width: number; height: number }): LayerMod | null {
  const e = ease('inOut', p);
  const hide = 1 - e;
  switch (type) {
    case 'fade':
      return { ...NONE, alpha: e };
    case 'slide-left':
      return { ...NONE, dx: -canvas.width * hide };
    case 'slide-right':
      return { ...NONE, dx: canvas.width * hide };
    case 'slide-up':
      return { ...NONE, dy: -canvas.height * hide };
    case 'slide-down':
      return { ...NONE, dy: canvas.height * hide };
    case 'wipe-right': // the edge sweeps to the right
      return { ...NONE, wipe: leaving ? { x0: 1 - p, y0: 0, x1: 1, y1: 1 } : { x0: 0, y0: 0, x1: p, y1: 1 } };
    case 'wipe-left':
      return { ...NONE, wipe: leaving ? { x0: 0, y0: 0, x1: p, y1: 1 } : { x0: 1 - p, y0: 0, x1: 1, y1: 1 } };
    case 'wipe-down':
      return { ...NONE, wipe: leaving ? { x0: 0, y0: 1 - p, x1: 1, y1: 1 } : { x0: 0, y0: 0, x1: 1, y1: p } };
    case 'wipe-up':
      return { ...NONE, wipe: leaving ? { x0: 0, y0: 0, x1: 1, y1: p } : { x0: 0, y0: 1 - p, x1: 1, y1: 1 } };
    case 'zoom':
      return { ...NONE, alpha: e, scale: 0.5 + 0.5 * e };
    case 'pop':
      return { ...NONE, alpha: Math.min(1, p * 4), scale: Math.max(0.001, ease('back', p)) };
    default:
      return null;
  }
}

/** The layer modification for `clip` at `time`, or null when no transition is running. */
export function transitionMod(clip: TransitionHost, time: number, canvas: { width: number; height: number }): LayerMod | null {
  const inLen = effectiveTransitionSeconds(clip.transitionIn, clip.duration);
  const outLen = effectiveTransitionSeconds(clip.transitionOut, clip.duration);
  const local = time - clip.start;
  if (clip.transitionIn && inLen > 0 && local < inLen) {
    return modAt(clip.transitionIn.type, Math.max(0, local / inLen), false, canvas);
  }
  if (clip.transitionOut && outLen > 0 && clip.duration - local < outLen) {
    return modAt(clip.transitionOut.type, Math.max(0, (clip.duration - local) / outLen), true, canvas);
  }
  return null;
}

export function parseTransition(input: unknown): Transition | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const { type, duration } = input as Record<string, unknown>;
  if (typeof type !== 'string' || !(TRANSITION_TYPES as readonly string[]).includes(type)) return undefined;
  const d = typeof duration === 'number' && Number.isFinite(duration) ? duration : 0.5;
  return { type, duration: Math.min(MAX_TRANSITION_SECONDS, Math.max(MIN_TRANSITION_SECONDS, d)) };
}
