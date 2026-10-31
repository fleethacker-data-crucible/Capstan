// Behaviors: ready-made entrance, emphasis and exit animations for clips and annotations.
// A behavior is applied on top of the keyframed values, so the two can be combined.
import { type AnimProp, ease } from './anim';

export interface BehaviorStep {
  /** Preset name, such as 'fade', 'slide-left', 'pop', 'pulse'. */
  type: string;
  /** Seconds the step takes (for emphasis: the length of one pulse or wobble). */
  duration: number;
}

export interface Behavior {
  enter?: BehaviorStep;
  emphasis?: BehaviorStep;
  exit?: BehaviorStep;
}

/** Presets that bring an item in. The exit list is the same set played backwards. */
export const ENTER_TYPES = ['fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'pop', 'spin'] as const;
export const EXIT_TYPES = ENTER_TYPES;
export const EMPHASIS_TYPES = ['pulse', 'wobble'] as const;

export const BEHAVIOR_LABELS: Record<string, string> = {
  fade: 'Fade',
  'slide-left': 'Slide from the left',
  'slide-right': 'Slide from the right',
  'slide-up': 'Slide from the top',
  'slide-down': 'Slide from the bottom',
  pop: 'Pop',
  spin: 'Spin',
  pulse: 'Pulse',
  wobble: 'Wobble',
};

export const MIN_STEP_SECONDS = 0.05;
export const MAX_STEP_SECONDS = 10;

type Props = Partial<Record<AnimProp, number>>;
type Canvas = { width: number; height: number };

function slideOffset(type: string, canvas: Canvas): { dx: number; dy: number } {
  switch (type) {
    case 'slide-left':
      return { dx: -canvas.width, dy: 0 };
    case 'slide-right':
      return { dx: canvas.width, dy: 0 };
    case 'slide-up':
      return { dx: 0, dy: -canvas.height };
    case 'slide-down':
      return { dx: 0, dy: canvas.height };
    default:
      return { dx: 0, dy: 0 };
  }
}

/**
 * Applies an entrance (or, played backwards, an exit) preset. `u` is progress 0 (hidden) .. 1 (at rest).
 * Exits use the same maths with the progress counted down from the end, so they mirror the entrance.
 */
function applyStep(props: Record<string, number | undefined>, type: string, u: number, canvas: Canvas): void {
  if (u >= 1) return;
  const e = ease('out', u);
  const mul = (key: string, factor: number) => {
    if (typeof props[key] === 'number') props[key] = (props[key] as number) * factor;
  };
  const add = (key: string, delta: number) => {
    if (typeof props[key] === 'number') props[key] = (props[key] as number) + delta;
  };
  switch (type) {
    case 'fade':
      mul('opacity', e);
      break;
    case 'slide-left':
    case 'slide-right':
    case 'slide-up':
    case 'slide-down': {
      const { dx, dy } = slideOffset(type, canvas);
      add('x', dx * (1 - e));
      add('y', dy * (1 - e));
      break;
    }
    case 'pop':
      mul('scale', Math.max(0, ease('back', u)));
      mul('opacity', Math.min(1, u * 4));
      break;
    case 'spin':
      add('rotation', -360 * (1 - e));
      mul('scale', Math.max(0.001, e));
      mul('opacity', Math.min(1, u * 3));
      break;
    default:
      break;
  }
}

/** The emphasis preset: a gentle repeating motion between the entrance and the exit. */
function applyEmphasis(props: Record<string, number | undefined>, type: string, since: number, period: number): void {
  if (since < 0 || period <= 0) return;
  const phase = (since % period) / period;
  if (type === 'pulse') {
    if (typeof props.scale === 'number') props.scale *= 1 + 0.12 * Math.sin(Math.PI * phase);
  } else if (type === 'wobble') {
    if (typeof props.rotation === 'number') props.rotation += 6 * Math.sin(2 * Math.PI * phase);
  }
}

/** Applies the preset to already-keyframed values. `localT` is seconds since the item started. */
export function applyBehavior<P extends Props>(props: P, behavior: Behavior, localT: number, duration: number, canvas: Canvas): P {
  const out: Props = { ...props };
  const enter = behavior.enter && behavior.enter.duration > 0 ? behavior.enter : undefined;
  const exit = behavior.exit && behavior.exit.duration > 0 ? behavior.exit : undefined;
  // Neither step may take more than half the item, so a short item never plays both at once.
  const half = Math.max(0, duration / 2);
  if (enter) applyStep(out, enter.type, Math.min(1, localT / Math.min(enter.duration, half || enter.duration)), canvas);
  if (exit) applyStep(out, exit.type, Math.min(1, (duration - localT) / Math.min(exit.duration, half || exit.duration)), canvas);
  if (behavior.emphasis) {
    const from = enter ? Math.min(enter.duration, half) : 0;
    const to = duration - (exit ? Math.min(exit.duration, half) : 0);
    if (localT >= from && localT <= to) applyEmphasis(out, behavior.emphasis.type, localT - from, behavior.emphasis.duration);
  }
  return out as P;
}

function parseStep(input: unknown, allowed: readonly string[]): BehaviorStep | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const { type, duration } = input as Record<string, unknown>;
  if (typeof type !== 'string' || !allowed.includes(type)) return undefined;
  const d = typeof duration === 'number' && Number.isFinite(duration) ? duration : 0.5;
  return { type, duration: Math.min(MAX_STEP_SECONDS, Math.max(MIN_STEP_SECONDS, d)) };
}

export function parseBehavior(input: unknown): Behavior | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const out: Behavior = {};
  const enter = parseStep(raw.enter, ENTER_TYPES);
  const emphasis = parseStep(raw.emphasis, EMPHASIS_TYPES);
  const exit = parseStep(raw.exit, EXIT_TYPES);
  if (enter) out.enter = enter;
  if (emphasis) out.emphasis = emphasis;
  if (exit) out.exit = exit;
  return enter || emphasis || exit ? out : undefined;
}

/** Sets or clears one stage of a behavior. Returns undefined when nothing is left. */
export function setBehaviorStep(behavior: Behavior | undefined, stage: keyof Behavior, step: BehaviorStep | undefined): Behavior | undefined {
  const next: Behavior = { ...behavior };
  if (step) next[stage] = { type: step.type, duration: Math.min(MAX_STEP_SECONDS, Math.max(MIN_STEP_SECONDS, step.duration)) };
  else delete next[stage];
  return next.enter || next.emphasis || next.exit ? next : undefined;
}
