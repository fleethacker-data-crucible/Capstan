// Transitions: how a clip appears at its start and leaves at its end. Owned by the animation area.

export interface Transition {
  /** Preset name, such as 'fade', 'slide', 'wipe', 'zoom'. */
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

/** The layer modification for `clip` at `time`, or null when no transition is running. */
export function transitionMod(_clip: TransitionHost, _time: number, _canvas: { width: number; height: number }): LayerMod | null {
  return null;
}

export function parseTransition(_input: unknown): Transition | undefined {
  return undefined;
}
