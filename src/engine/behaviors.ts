// Behaviors: ready-made entrance, emphasis and exit animations for clips and annotations.
// Owned by the animation area; this is the hook the keyframe resolver calls.
import type { AnimProp } from './anim';

export interface BehaviorStep {
  /** Preset name, such as 'fade', 'slide-left', 'pop', 'pulse'. */
  type: string;
  /** Seconds the step takes. */
  duration: number;
}

export interface Behavior {
  enter?: BehaviorStep;
  emphasis?: BehaviorStep;
  exit?: BehaviorStep;
}

/** Applies the preset to already-keyframed values. `localT` is seconds since the item started. */
export function applyBehavior<P extends Partial<Record<AnimProp, number>>>(
  props: P,
  _behavior: Behavior,
  _localT: number,
  _duration: number,
  _canvas: { width: number; height: number },
): P {
  return props;
}

export function parseBehavior(_input: unknown): Behavior | undefined {
  return undefined;
}
