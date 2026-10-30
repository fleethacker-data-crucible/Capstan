// Annotations: text, callouts, shapes, arrows, highlights and spotlights drawn over the picture.
// Owned by the annotations area. They are timed overlay items, like blur regions.
import type { Animated } from './anim';

export interface Annotation extends Animated {
  id: string;
  kind: string;
  start: number;
  duration: number;
  /** Bounding box in canvas pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
}

export interface AnnotationHost {
  annotations: Annotation[];
  width: number;
  height: number;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawAnnotations(_ctx: Ctx2D, _project: AnnotationHost, _time: number): void {}

export function parseAnnotations(_input: unknown, _canvas: { width: number; height: number }): Annotation[] {
  return [];
}

export function rescaleAnnotations(annotations: Annotation[], _kx: number, _ky: number): Annotation[] {
  return annotations;
}
