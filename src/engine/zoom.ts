// Zoom-n-pan: the camera that looks at part of the canvas. Owned by the animation area.
import type { EaseName } from './anim';

/** A stretch of the timeline during which the camera is zoomed onto a rectangle of the canvas. */
export interface ZoomRegion {
  id: string;
  start: number;
  duration: number;
  /** The part of the canvas that fills the picture, in canvas pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Seconds taken to zoom in and to zoom back out. */
  easeIn: number;
  easeOut: number;
  ease: EaseName;
}

/** The camera at one moment: the canvas point at the centre of the picture, and the magnification (1 = whole canvas). */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface ZoomHost {
  zooms: ZoomRegion[];
  width: number;
  height: number;
}

/** The camera at `time`, or null when the whole canvas is shown. */
export function cameraAt(_project: ZoomHost, _time: number): Camera | null {
  return null;
}

export function parseZooms(_input: unknown, _canvas: { width: number; height: number }): ZoomRegion[] {
  return [];
}

export function rescaleZooms(zooms: ZoomRegion[], _kx: number, _ky: number): ZoomRegion[] {
  return zooms;
}
