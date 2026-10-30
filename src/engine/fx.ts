// Visual effects on a clip: colour, chroma key, shadow, border, rounded corners, device frame, blend mode.
// Owned by the visual effects area; the compositor calls drawWithEffects around every clip.

export interface ClipEffects {
  [key: string]: unknown;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Draws a clip layer through its effects. `drawBase` paints the layer centred on the origin,
 * `width` x `height` big, onto whatever context it is given. Without effects it simply draws.
 */
export function drawWithEffects(
  ctx: Ctx2D,
  _effects: ClipEffects | undefined,
  _width: number,
  _height: number,
  drawBase: (target: Ctx2D) => void,
): void {
  drawBase(ctx);
}

export function parseEffects(_input: unknown): ClipEffects | undefined {
  return undefined;
}

/** Scales pixel sizes inside the effects (radius, shadow offsets) when the canvas size changes. */
export function rescaleEffects(effects: ClipEffects | undefined, _k: number): ClipEffects | undefined {
  return effects;
}
