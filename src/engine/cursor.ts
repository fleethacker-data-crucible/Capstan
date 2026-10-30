// Recorded cursor data and the effects drawn from it: smoothing, highlight, magnify, spotlight,
// click rings, key callouts. Owned by the cursor area. Positions are fractions of the recorded frame.

export interface CursorSample {
  t: number;
  x: number;
  y: number;
}

export interface CursorClick {
  t: number;
  button: 'left' | 'right' | 'middle';
  down: boolean;
}

export interface CursorKey {
  t: number;
  key: string;
  down: boolean;
}

/** Cursor activity recorded alongside a screen recording; times are seconds into that media. */
export interface CursorData {
  samples: CursorSample[];
  clicks: CursorClick[];
  keys: CursorKey[];
}

/** How the cursor is re-drawn over the recording. */
export interface CursorFx {
  [key: string]: unknown;
}

export interface CursorLayer {
  data: CursorData;
  /** Source time (seconds into the media) for the frame being drawn. */
  sourceTime: number;
  /** The clip's on-canvas rectangle before rotation. */
  rect: { x: number; y: number; width: number; height: number };
  canvas: { width: number; height: number };
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawCursorFx(_ctx: Ctx2D, _fx: CursorFx, _layer: CursorLayer): void {}

export function parseCursorData(_input: unknown): CursorData | undefined {
  return undefined;
}

export function parseCursorFx(_input: unknown): CursorFx | undefined {
  return undefined;
}
