// Annotations: text, callouts, shapes, arrows, lines, highlights and spotlights drawn over the picture.
// They are timed overlay items, like blur regions, and are drawn after them (later items on top).
//
// Geometry. An annotation owns an axis-aligned box (x, y = top-left corner, width, height) in canvas
// pixels. Arrows and lines keep their two end points as fractions of that box (`line`), and a callout
// keeps the tip of its speech-bubble tail as fractions of the box (`tail`), so moving or resizing the
// box carries them along.
//
// Animation. Annotations are `Animated`: keyframes and behaviors resolve through `resolveProps`, with
//   x, y      -> the CENTRE of the box in canvas pixels (like a clip's position)
//   scale     -> uniform scale about the centre (base 1; scales stroke widths too)
//   rotation  -> degrees about the centre
//   opacity   -> 0..1
// `volume` does not apply. Keyframe times are seconds from the annotation's own start.
import { type Animated, parseKeys, resolveProps } from './anim';
import { parseBehavior } from './behaviors';
import { wrapCaption } from './captions';

export type AnnotationKind = 'text' | 'callout' | 'rect' | 'ellipse' | 'arrow' | 'line' | 'highlight' | 'spotlight';
export const ANNOTATION_KINDS: AnnotationKind[] = ['text', 'callout', 'rect', 'ellipse', 'arrow', 'line', 'highlight', 'spotlight'];
export const KIND_LABELS: Record<AnnotationKind, string> = {
  text: 'Text',
  callout: 'Callout',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  arrow: 'Arrow',
  line: 'Line',
  highlight: 'Highlight',
  spotlight: 'Spotlight',
};

export type FontKey = 'sans' | 'serif' | 'mono' | 'display';
export const FONT_KEYS: FontKey[] = ['sans', 'serif', 'mono', 'display'];
/** Bundled / system stacks only: nothing is fetched from the network. */
export const FONT_STACKS: Record<FontKey, string> = {
  sans: '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  mono: 'Consolas, "Cascadia Mono", "Courier New", monospace',
  display: 'Impact, "Arial Black", "Segoe UI Black", "Segoe UI", sans-serif',
};
export const FONT_LABELS: Record<FontKey, string> = { sans: 'Sans (Segoe UI)', serif: 'Serif', mono: 'Mono (Consolas)', display: 'Display (Impact)' };

export type TextAlign = 'left' | 'center' | 'right';
export type BoxShape = 'rect' | 'ellipse';

export interface AnnotationStyle {
  /** '#rrggbb', or '' for no fill. For a spotlight this is the dimming colour. */
  fill: string;
  /** 0..1, applied to the fill only. */
  fillAlpha: number;
  /** '#rrggbb', or '' for no outline. */
  stroke: string;
  /** Outline width in canvas pixels, 0..40. */
  strokeWidth: number;
  /** Text colour. */
  color: string;
  font: FontKey;
  /** Font size in canvas pixels. */
  size: number;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  /** Corner radius in canvas pixels (rect, text background, callout, highlight, spotlight). */
  radius: number;
  /** Soft drop shadow behind the whole item. */
  shadow: boolean;
  /** Spotlight: how much the outside is dimmed, 0..1. */
  dim: number;
  /** Spotlight: width of the soft edge in canvas pixels. */
  feather: number;
}

export interface Annotation extends Animated {
  id: string;
  kind: AnnotationKind;
  /** Seconds on the timeline. */
  start: number;
  duration: number;
  /** Bounding box in canvas pixels (top-left corner and size, before rotation and scale). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees about the box centre. */
  rotation: number;
  /** 0..1 */
  opacity: number;
  /** Text and callout only. */
  text: string;
  style: AnnotationStyle;
  /** Highlight and spotlight: the shape of the lit area. */
  shape: BoxShape;
  /** Callout: tip of the tail as fractions of the box (outside 0..1 points beyond it). */
  tail: { x: number; y: number };
  /** Arrow and line: end points as fractions of the box. Arrows have the head at (x2, y2). */
  line: { x1: number; y1: number; x2: number; y2: number };
  /** Seconds an arrow, line, rectangle or ellipse takes to draw itself on from its start. 0 = off. */
  sketch: number;
}

export interface AnnotationHost {
  annotations: Annotation[];
  width: number;
  height: number;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Canvas2 = { width: number; height: number };

export const MAX_ANNOTATIONS = 500;
export const MAX_ANNOTATION_TEXT = 1000;
export const MIN_ANNOTATION_PX = 8;
export const MIN_ANNOTATION_SECONDS = 1 / 30;
export const MAX_ANNOTATION_SECONDS = 3600;
export const MAX_SKETCH_SECONDS = 60;
export const DEFAULT_ANNOTATION_SECONDS = 4;

const HEX = /^#[0-9a-f]{6}$/i;
const finite = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const colour = (v: unknown, d: string, allowNone: boolean): string => {
  if (typeof v === 'string') {
    if (HEX.test(v)) return v.toLowerCase();
    if (allowNone && v === '') return '';
  }
  return d;
};

export function isLineKind(kind: AnnotationKind): boolean {
  return kind === 'arrow' || kind === 'line';
}
export function hasText(kind: AnnotationKind): boolean {
  return kind === 'text' || kind === 'callout';
}
/** Kinds that can draw themselves on (sketch motion). */
export function canSketch(kind: AnnotationKind): boolean {
  return kind === 'arrow' || kind === 'line' || kind === 'rect' || kind === 'ellipse';
}

const BASE_STYLE: AnnotationStyle = {
  fill: '',
  fillAlpha: 1,
  stroke: '',
  strokeWidth: 0,
  color: '#ffffff',
  font: 'sans',
  size: 48,
  bold: false,
  italic: false,
  align: 'center',
  radius: 0,
  shadow: false,
  dim: 0.65,
  feather: 40,
};

/** Style defaults per kind, at a 1080-pixel-high canvas (the sizes scale with the canvas height). */
export function defaultStyle(kind: AnnotationKind, canvasHeight = 1080): AnnotationStyle {
  const k = canvasHeight / 1080;
  const s = (px: number) => Math.round(px * k);
  const base = { ...BASE_STYLE };
  switch (kind) {
    case 'text':
      return { ...base, size: s(56), bold: true, shadow: true };
    case 'callout':
      return { ...base, fill: '#fff7cc', stroke: '#1f2937', strokeWidth: s(3), color: '#111827', size: s(40), radius: s(24) };
    case 'rect':
    case 'ellipse':
      return { ...base, stroke: '#ff3b30', strokeWidth: s(6), radius: kind === 'rect' ? s(8) : 0 };
    case 'arrow':
    case 'line':
      return { ...base, stroke: '#ff3b30', strokeWidth: s(8) };
    case 'highlight':
      return { ...base, fill: '#ffe14a', fillAlpha: 0.35, radius: s(6) };
    case 'spotlight':
      return { ...base, fill: '#000000', radius: s(24), dim: 0.65, feather: s(40) };
  }
}

/** A new annotation of `kind`, centred on the canvas, sized for it. */
export function defaultAnnotation(kind: AnnotationKind, canvas: Canvas2, start: number, id: string): Annotation {
  const k = canvas.height / 1080;
  let w = 420 * k;
  let h = 260 * k;
  let text = '';
  switch (kind) {
    case 'text':
      w = 640 * k;
      h = 120 * k;
      text = 'Your text';
      break;
    case 'callout':
      w = 460 * k;
      h = 150 * k;
      text = 'Callout';
      break;
    case 'arrow':
      w = 360 * k;
      h = 200 * k;
      break;
    case 'line':
      w = 420 * k;
      h = 1;
      break;
    case 'highlight':
      w = 520 * k;
      h = 90 * k;
      break;
    case 'spotlight':
      w = 560 * k;
      h = 340 * k;
      break;
    default:
      break;
  }
  w = Math.min(w, canvas.width);
  h = Math.min(Math.max(h, 1), canvas.height);
  return {
    id,
    kind,
    start: Math.max(0, start),
    duration: DEFAULT_ANNOTATION_SECONDS,
    x: Math.round((canvas.width - w) / 2),
    y: Math.round((canvas.height - h) / 2),
    width: Math.round(w),
    height: Math.max(1, Math.round(h)),
    rotation: 0,
    opacity: 1,
    text,
    style: defaultStyle(kind, canvas.height),
    shape: kind === 'spotlight' ? 'ellipse' : 'rect',
    tail: { x: 0.22, y: 1.5 },
    line: kind === 'arrow' ? { x1: 0, y1: 1, x2: 1, y2: 0 } : { x1: 0, y1: 0.5, x2: 1, y2: 0.5 },
    sketch: 0,
  };
}

export interface StylePreset {
  id: string;
  label: string;
  /** Kinds it suits; the patch is applied to any annotation, but the panel offers it for these. */
  kinds: AnnotationKind[];
  patch: Partial<AnnotationStyle>;
}

export const STYLE_PRESETS: StylePreset[] = [
  { id: 'title', label: 'Title', kinds: ['text'], patch: { color: '#ffffff', fill: '', font: 'sans', bold: true, italic: false, size: 72, shadow: true, align: 'center' } },
  { id: 'lower-third', label: 'Lower third', kinds: ['text'], patch: { color: '#ffffff', fill: '#0b1b33', fillAlpha: 0.85, font: 'sans', bold: true, size: 44, radius: 10, shadow: false, align: 'left' } },
  { id: 'code', label: 'Code', kinds: ['text', 'callout'], patch: { color: '#e6edf3', fill: '#0d1117', fillAlpha: 0.9, font: 'mono', bold: false, size: 36, radius: 8, shadow: false, align: 'left' } },
  { id: 'note', label: 'Yellow note', kinds: ['text', 'callout'], patch: { color: '#111827', fill: '#fff7cc', fillAlpha: 1, stroke: '#1f2937', strokeWidth: 3, font: 'sans', bold: false, radius: 24 } },
  { id: 'warning', label: 'Red warning', kinds: ['text', 'callout', 'rect', 'ellipse', 'arrow', 'line'], patch: { color: '#ffffff', fill: '#d92d20', fillAlpha: 1, stroke: '#d92d20', strokeWidth: 6, bold: true } },
  { id: 'accent', label: 'Brass outline', kinds: ['rect', 'ellipse', 'arrow', 'line', 'highlight'], patch: { stroke: '#e0a92e', strokeWidth: 6, fill: '' } },
  { id: 'marker', label: 'Marker yellow', kinds: ['highlight'], patch: { fill: '#ffe14a', fillAlpha: 0.35, stroke: '', strokeWidth: 0 } },
  { id: 'marker-green', label: 'Marker green', kinds: ['highlight'], patch: { fill: '#39d98a', fillAlpha: 0.35, stroke: '', strokeWidth: 0 } },
  { id: 'serif-quote', label: 'Serif quote', kinds: ['text'], patch: { color: '#ffffff', font: 'serif', italic: true, bold: false, size: 56, shadow: true } },
];

/** Style for `kind` with `input` laid over its defaults, every field validated. */
export function normaliseStyle(input: unknown, kind: AnnotationKind, canvasHeight = 1080): AnnotationStyle {
  const d = defaultStyle(kind, canvasHeight);
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    fill: colour(i.fill, d.fill, true),
    fillAlpha: clamp(finite(i.fillAlpha, d.fillAlpha), 0, 1),
    stroke: colour(i.stroke, d.stroke, true),
    strokeWidth: clamp(finite(i.strokeWidth, d.strokeWidth), 0, 40),
    color: colour(i.color, d.color, false),
    font: FONT_KEYS.includes(i.font as FontKey) ? (i.font as FontKey) : d.font,
    size: clamp(finite(i.size, d.size), 6, 400),
    bold: typeof i.bold === 'boolean' ? i.bold : d.bold,
    italic: typeof i.italic === 'boolean' ? i.italic : d.italic,
    align: i.align === 'left' || i.align === 'right' || i.align === 'center' ? i.align : d.align,
    radius: clamp(finite(i.radius, d.radius), 0, 400),
    shadow: typeof i.shadow === 'boolean' ? i.shadow : d.shadow,
    dim: clamp(finite(i.dim, d.dim), 0, 1),
    feather: clamp(finite(i.feather, d.feather), 0, 300),
  };
}

/** Validates one annotation (also used by edits): every number clamped, every string capped. */
export function normaliseAnnotation(input: Partial<Annotation> & { id: string; kind: AnnotationKind }, canvas: Canvas2): Annotation {
  const kind = input.kind;
  const d = defaultAnnotation(kind, canvas, 0, input.id);
  const lineKind = isLineKind(kind);
  const minSize = lineKind ? 1 : MIN_ANNOTATION_PX;
  const width = clamp(finite(input.width, d.width), minSize, Math.max(minSize, canvas.width * 4));
  const height = clamp(finite(input.height, d.height), minSize, Math.max(minSize, canvas.height * 4));
  const line = (input.line && typeof input.line === 'object' ? input.line : d.line) as Annotation['line'];
  const tail = (input.tail && typeof input.tail === 'object' ? input.tail : d.tail) as Annotation['tail'];
  const out: Annotation = {
    id: String(input.id),
    kind,
    start: clamp(finite(input.start, 0), 0, 1e6),
    duration: clamp(finite(input.duration, d.duration), MIN_ANNOTATION_SECONDS, MAX_ANNOTATION_SECONDS),
    x: clamp(finite(input.x, d.x), -canvas.width * 2, canvas.width * 2),
    y: clamp(finite(input.y, d.y), -canvas.height * 2, canvas.height * 2),
    width,
    height,
    rotation: clamp(finite(input.rotation, 0), -3600, 3600),
    opacity: clamp(finite(input.opacity, 1), 0, 1),
    text: hasText(kind) && typeof input.text === 'string' ? input.text.slice(0, MAX_ANNOTATION_TEXT) : hasText(kind) ? d.text : '',
    style: normaliseStyle(input.style, kind, canvas.height),
    shape: input.shape === 'ellipse' || input.shape === 'rect' ? input.shape : d.shape,
    tail: { x: clamp(finite(tail.x, d.tail.x), -5, 6), y: clamp(finite(tail.y, d.tail.y), -5, 6) },
    line: {
      x1: clamp(finite(line.x1, d.line.x1), 0, 1),
      y1: clamp(finite(line.y1, d.line.y1), 0, 1),
      x2: clamp(finite(line.x2, d.line.x2), 0, 1),
      y2: clamp(finite(line.y2, d.line.y2), 0, 1),
    },
    sketch: canSketch(kind) ? clamp(finite(input.sketch, 0), 0, MAX_SKETCH_SECONDS) : 0,
  };
  const keys = parseKeys(input.keys);
  if (keys) out.keys = keys;
  const behavior = parseBehavior(input.behavior);
  if (behavior) out.behavior = behavior;
  return out;
}

let idCounter = 0;
function fallbackId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `ann_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Validates annotations read from a project file: unknown kinds and non-objects are dropped, numbers clamped, text capped, ids made unique. */
export function parseAnnotations(input: unknown, canvas: Canvas2): Annotation[] {
  if (!Array.isArray(input)) return [];
  const out: Annotation[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (out.length >= MAX_ANNOTATIONS) break;
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (!ANNOTATION_KINDS.includes(r.kind as AnnotationKind)) continue;
    let id = typeof r.id === 'string' && r.id ? r.id.slice(0, 80) : fallbackId();
    if (seen.has(id)) id = fallbackId();
    seen.add(id);
    out.push(normaliseAnnotation({ ...(r as Partial<Annotation>), id, kind: r.kind as AnnotationKind }, canvas));
  }
  return out;
}

/** Scales annotations when the canvas changes size: positions by kx / ky, sizes and line widths by ky. */
export function rescaleAnnotations(annotations: Annotation[], kx: number, ky: number): Annotation[] {
  if (!annotations.length || (kx === 1 && ky === 1)) return annotations;
  return annotations.map((a) => ({
    ...a,
    x: a.x * kx,
    y: a.y * ky,
    width: a.width * kx,
    height: a.height * ky,
    style: { ...a.style, size: a.style.size * ky, strokeWidth: a.style.strokeWidth * ky, radius: a.style.radius * ky, feather: a.style.feather * ky },
    keys: a.keys && { ...a.keys, x: a.keys.x?.map((k) => ({ ...k, v: k.v * kx })), y: a.keys.y?.map((k) => ({ ...k, v: k.v * ky })) },
  }));
}

export function activeAnnotationsAt(project: Pick<AnnotationHost, 'annotations'>, time: number): Annotation[] {
  return project.annotations.filter((a) => time >= a.start && time < a.start + a.duration);
}

// ---------------------------------------------------------------- geometry

export interface ResolvedAnnotation {
  /** Centre of the box. */
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

/** Where the annotation is at timeline `time`: its own values overlaid with keyframes and its behavior. */
export function resolveAnnotation(a: Annotation, time: number, canvas: Canvas2): ResolvedAnnotation {
  return resolveProps(
    { x: a.x + a.width / 2, y: a.y + a.height / 2, scale: 1, rotation: a.rotation, opacity: a.opacity },
    a,
    time - a.start,
    a.duration,
    canvas,
  );
}

/** Canvas point -> the annotation's own frame (origin at the box centre, unrotated, unscaled). */
export function toLocal(r: ResolvedAnnotation, p: { x: number; y: number }): { x: number; y: number } {
  const rad = (-r.rotation * Math.PI) / 180;
  const dx = p.x - r.x;
  const dy = p.y - r.y;
  const s = r.scale || 1;
  return { x: (dx * Math.cos(rad) - dy * Math.sin(rad)) / s, y: (dx * Math.sin(rad) + dy * Math.cos(rad)) / s };
}

/** The annotation's own frame -> canvas point. */
export function fromLocal(r: ResolvedAnnotation, p: { x: number; y: number }): { x: number; y: number } {
  const rad = (r.rotation * Math.PI) / 180;
  const s = r.scale || 1;
  const lx = p.x * s;
  const ly = p.y * s;
  return { x: r.x + lx * Math.cos(rad) - ly * Math.sin(rad), y: r.y + lx * Math.sin(rad) + ly * Math.cos(rad) };
}

/** The end points of an arrow or line in the annotation's own frame. */
export function lineLocal(a: Annotation): { x1: number; y1: number; x2: number; y2: number } {
  const { line: l, width: w, height: h } = a;
  return { x1: (l.x1 - 0.5) * w, y1: (l.y1 - 0.5) * h, x2: (l.x2 - 0.5) * w, y2: (l.y2 - 0.5) * h };
}

/** End points of an arrow or line on the canvas at the resolved position. */
export function lineCanvas(a: Annotation, r: ResolvedAnnotation): { x1: number; y1: number; x2: number; y2: number } {
  const l = lineLocal(a);
  const p1 = fromLocal(r, { x: l.x1, y: l.y1 });
  const p2 = fromLocal(r, { x: l.x2, y: l.y2 });
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

/** A patch that makes a line / arrow run between two canvas points (rotation reset, box = their bounds). */
export function lineEndsPatch(x1: number, y1: number, x2: number, y2: number): Pick<Annotation, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'line'> {
  const minX = Math.min(x1, x2);
  const minY = Math.min(y1, y2);
  const width = Math.max(1, Math.abs(x2 - x1));
  const height = Math.max(1, Math.abs(y2 - y1));
  const fx = (x: number) => Math.min(1, Math.max(0, (x - minX) / width));
  const fy = (y: number) => Math.min(1, Math.max(0, (y - minY) / height));
  return { x: minX, y: minY, width, height, rotation: 0, line: { x1: fx(x1), y1: fy(y1), x2: fx(x2), y2: fy(y2) } };
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Tail tip on the canvas for a callout. */
export function tailCanvas(a: Annotation, r: ResolvedAnnotation): { x: number; y: number } {
  return fromLocal(r, { x: (a.tail.x - 0.5) * a.width, y: (a.tail.y - 0.5) * a.height });
}

/**
 * Whether a canvas point `p` grabs the annotation at `time`. `slop` is extra reach in canvas pixels.
 * Lines and unfilled outlines are grabbed on their stroke only; everything else inside its box
 * (a callout also by its tail, an ellipse-shaped highlight or spotlight inside the ellipse).
 */
export function hitTestAnnotation(a: Annotation, p: { x: number; y: number }, time: number, canvas: Canvas2, slop = 4): boolean {
  const r = resolveAnnotation(a, time, canvas);
  if (r.opacity <= 0) return false;
  const l = toLocal(r, p);
  const w = a.width;
  const h = a.height;
  const reach = slop / (r.scale || 1);
  if (isLineKind(a.kind)) {
    const e = lineLocal(a);
    return distToSegment(l.x, l.y, e.x1, e.y1, e.x2, e.y2) <= Math.max(a.style.strokeWidth / 2, 4) + reach + (a.kind === 'arrow' ? a.style.strokeWidth : 0);
  }
  const inBox = Math.abs(l.x) <= w / 2 + reach && Math.abs(l.y) <= h / 2 + reach;
  const inEllipse = (rx: number, ry: number) => (l.x / (rx + reach)) ** 2 + (l.y / (ry + reach)) ** 2 <= 1;
  switch (a.kind) {
    case 'ellipse':
      if (a.style.fill) return inEllipse(w / 2, h / 2);
      return inEllipse(w / 2 + a.style.strokeWidth / 2, h / 2 + a.style.strokeWidth / 2) && !inEllipse(w / 2 - a.style.strokeWidth / 2 - reach * 2, h / 2 - a.style.strokeWidth / 2 - reach * 2);
    case 'rect': {
      if (a.style.fill) return inBox;
      const sw = a.style.strokeWidth / 2 + reach;
      const outer = Math.abs(l.x) <= w / 2 + sw && Math.abs(l.y) <= h / 2 + sw;
      const inner = Math.abs(l.x) < w / 2 - sw && Math.abs(l.y) < h / 2 - sw;
      return outer && !inner;
    }
    case 'highlight':
    case 'spotlight':
      return a.shape === 'ellipse' ? inEllipse(w / 2, h / 2) : inBox;
    case 'callout': {
      if (inBox) return true;
      const tip = { x: (a.tail.x - 0.5) * w, y: (a.tail.y - 0.5) * h };
      return Math.hypot(l.x - tip.x, l.y - tip.y) <= 14 + reach;
    }
    default:
      return inBox;
  }
}

// ---------------------------------------------------------------- sketch motion

/** Length of the outline an annotation draws, in its own units (used by the sketch-on animation). */
export function outlineLength(a: Pick<Annotation, 'kind' | 'width' | 'height'> & { style: Pick<AnnotationStyle, 'radius'>; line: Annotation['line'] }): number {
  if (a.kind === 'arrow' || a.kind === 'line') {
    const l = a.line;
    return Math.hypot((l.x2 - l.x1) * a.width, (l.y2 - l.y1) * a.height);
  }
  if (a.kind === 'ellipse') {
    const rx = a.width / 2;
    const ry = a.height / 2;
    const h = ((rx - ry) / (rx + ry)) ** 2;
    return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  }
  const r = Math.min(a.style.radius, a.width / 2, a.height / 2);
  return 2 * (a.width - 2 * r) + 2 * (a.height - 2 * r) + 2 * Math.PI * r;
}

/** How much of an annotation is drawn at `time`, 0..1: always 1 when sketch motion is off or not supported by the kind. */
export function sketchProgress(a: Pick<Annotation, 'kind' | 'start' | 'sketch'>, time: number): number {
  if (!canSketch(a.kind) || !(a.sketch > 0)) return 1;
  return clamp((time - a.start) / a.sketch, 0, 1);
}

// ---------------------------------------------------------------- text layout

export function fontString(s: Pick<AnnotationStyle, 'bold' | 'italic' | 'size' | 'font'>): string {
  return `${s.italic ? 'italic ' : ''}${s.bold ? '700' : '400'} ${s.size}px ${FONT_STACKS[s.font]}`;
}

export function textPadding(s: Pick<AnnotationStyle, 'size'>): number {
  return Math.max(4, Math.round(s.size * 0.35));
}

export const LINE_HEIGHT = 1.25;

/** Wrapped lines of an annotation's text for its box width. */
export function layoutText(ctx: Ctx2D, a: Pick<Annotation, 'text' | 'width' | 'style'>): string[] {
  ctx.save();
  ctx.font = fontString(a.style);
  const lines = wrapCaption(a.text, (s) => ctx.measureText(s).width, Math.max(1, a.width - textPadding(a.style) * 2), 200);
  ctx.restore();
  return lines;
}

/** Box height that exactly fits the annotation's text at its box width. */
export function fitTextHeight(ctx: Ctx2D, a: Pick<Annotation, 'text' | 'width' | 'style'>): number {
  const lines = Math.max(1, layoutText(ctx, a).length);
  return Math.ceil(lines * a.style.size * LINE_HEIGHT + textPadding(a.style) * 2);
}

// ---------------------------------------------------------------- drawing

function roundedRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function shapePath(ctx: Ctx2D, shape: BoxShape, x: number, y: number, w: number, h: number, radius: number): void {
  if (shape === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
  } else roundedRectPath(ctx, x, y, w, h, radius);
}

/** A speech bubble: a rounded box with a triangular tail whose tip is at `tip` (all in the same frame). */
export function bubblePath(ctx: Ctx2D, x: number, y: number, w: number, h: number, radius: number, tip: { x: number; y: number }): void {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dx = (tip.x - cx) / (w / 2);
  const dy = (tip.y - cy) / (h / 2);
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
    roundedRectPath(ctx, x, y, w, h, radius);
    return;
  }
  const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top';
  const horizontal = side === 'top' || side === 'bottom';
  const len = horizontal ? w : h;
  let r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const half = Math.min(w, h) * 0.18;
  // Keep the tail base on the straight part of the edge (half is under 18% of the edge, so r can always shrink enough).
  if (len / 2 - r < half + 1) r = Math.max(0, len / 2 - half - 1);
  const lo = (horizontal ? x : y) + r + half;
  const hi = (horizontal ? x + w : y + h) - r - half;
  const t = Math.min(hi, Math.max(lo, horizontal ? tip.x : tip.y));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  if (side === 'top') {
    ctx.lineTo(t - half, y);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(t + half, y);
  }
  ctx.arcTo(x + w, y, x + w, y + h, r);
  if (side === 'right') {
    ctx.lineTo(x + w, t - half);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(x + w, t + half);
  }
  ctx.arcTo(x + w, y + h, x, y + h, r);
  if (side === 'bottom') {
    ctx.lineTo(t + half, y + h);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(t - half, y + h);
  }
  ctx.arcTo(x, y + h, x, y, r);
  if (side === 'left') {
    ctx.lineTo(x, t + half);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(x, t - half);
  }
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function withAlpha(ctx: Ctx2D, alpha: number, draw: () => void): void {
  const before = ctx.globalAlpha;
  ctx.globalAlpha = before * alpha;
  draw();
  ctx.globalAlpha = before;
}

function fillAndStroke(ctx: Ctx2D, s: AnnotationStyle, fillScale = 1): void {
  if (s.fill) {
    ctx.fillStyle = s.fill;
    withAlpha(ctx, s.fillAlpha * fillScale, () => ctx.fill());
  }
  if (s.stroke && s.strokeWidth > 0) {
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth = s.strokeWidth;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

function drawText(ctx: Ctx2D, a: Annotation, x: number, y: number, w: number, h: number): void {
  if (!a.text) return;
  const s = a.style;
  const lines = layoutText(ctx, a);
  const pad = textPadding(s);
  const lh = s.size * LINE_HEIGHT;
  ctx.save();
  ctx.font = fontString(s);
  ctx.fillStyle = s.color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = s.align;
  const tx = s.align === 'left' ? x + pad : s.align === 'right' ? x + w - pad : x + w / 2;
  const top = y + h / 2 - (lines.length * lh) / 2;
  lines.forEach((line, i) => ctx.fillText(line, tx, top + lh * (i + 0.5)));
  ctx.restore();
}

function dashedOutline(ctx: Ctx2D, length: number, p: number): void {
  if (p >= 1) {
    ctx.setLineDash([]);
    return;
  }
  // A dash as long as the drawn part, then a gap longer than the whole outline: path-length animation.
  ctx.setLineDash([Math.max(0.001, length * p), length * 2 + 10]);
  ctx.lineDashOffset = 0;
}

function drawArrowOrLine(ctx: Ctx2D, a: Annotation, p: number): void {
  const s = a.style;
  const l = lineLocal(a);
  const total = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
  if (total <= 0 || p <= 0) return;
  const ux = (l.x2 - l.x1) / total;
  const uy = (l.y2 - l.y1) / total;
  const reach = total * p;
  const colourName = s.stroke || s.fill || '#ff3b30';
  const width = Math.max(1, s.strokeWidth);
  ctx.strokeStyle = colourName;
  ctx.fillStyle = colourName;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  if (a.kind === 'line') {
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x1 + ux * reach, l.y1 + uy * reach);
    ctx.stroke();
    return;
  }
  const head = Math.min(width * 4 + 8, total * 0.9, Math.max(reach, 2));
  const shaft = Math.max(0, reach - head * 0.6);
  ctx.lineCap = 'butt';
  if (shaft > 0) {
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x1 + ux * shaft, l.y1 + uy * shaft);
    ctx.stroke();
  }
  const tipX = l.x1 + ux * reach;
  const tipY = l.y1 + uy * reach;
  const baseX = tipX - ux * head;
  const baseY = tipY - uy * head;
  const half = head * 0.5;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(baseX - uy * half, baseY + ux * half);
  ctx.lineTo(baseX + uy * half, baseY - ux * half);
  ctx.closePath();
  ctx.fill();
}

let spotScratch: OffscreenCanvas | HTMLCanvasElement | null = null;
function spotCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (!spotScratch) spotScratch = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  if (spotScratch.width < w) spotScratch.width = w;
  if (spotScratch.height < h) spotScratch.height = h;
  return spotScratch;
}

function drawSpotlight(ctx: Ctx2D, a: Annotation, r: ResolvedAnnotation, canvas: Canvas2): void {
  const s = a.style;
  const dim = s.dim * r.opacity;
  if (dim <= 0) return;
  const W = Math.ceil(canvas.width);
  const H = Math.ceil(canvas.height);
  const inset = s.feather / 2;
  const w = Math.max(2, a.width - inset * 2);
  const h = Math.max(2, a.height - inset * 2);
  const place = (c: Ctx2D) => {
    c.translate(r.x, r.y);
    if (r.rotation) c.rotate((r.rotation * Math.PI) / 180);
    if (r.scale !== 1) c.scale(r.scale, r.scale);
    shapePath(c, a.shape, -w / 2, -h / 2, w, h, Math.max(0, s.radius - inset));
  };
  const dimColour = s.fill || '#000000';
  const scratch = spotCanvas(W, H);
  const sc = scratch.getContext('2d') as Ctx2D;
  sc.save();
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.globalAlpha = 1;
  sc.globalCompositeOperation = 'source-over';
  sc.shadowBlur = 0;
  sc.clearRect(0, 0, scratch.width, scratch.height);
  sc.fillStyle = dimColour;
  sc.fillRect(0, 0, W, H);
  sc.globalCompositeOperation = 'destination-out';
  sc.fillStyle = '#000000';
  sc.shadowColor = '#000000';
  sc.shadowBlur = s.feather;
  place(sc);
  sc.fill();
  sc.restore();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= dim;
  ctx.drawImage(scratch, 0, 0, W, H, 0, 0, W, H);
  ctx.restore();
}

function drawBody(ctx: Ctx2D, a: Annotation, p: number): void {
  const s = a.style;
  const w = a.width;
  const h = a.height;
  const x = -w / 2;
  const y = -h / 2;
  switch (a.kind) {
    case 'text':
      if (s.fill || (s.stroke && s.strokeWidth > 0)) {
        roundedRectPath(ctx, x, y, w, h, s.radius);
        fillAndStroke(ctx, s);
      }
      drawText(ctx, a, x, y, w, h);
      break;
    case 'callout':
      bubblePath(ctx, x, y, w, h, s.radius, { x: x + a.tail.x * w, y: y + a.tail.y * h });
      fillAndStroke(ctx, s);
      drawText(ctx, a, x, y, w, h);
      break;
    case 'rect':
    case 'ellipse': {
      shapePath(ctx, a.kind, x, y, w, h, s.radius);
      const length = outlineLength(a);
      dashedOutline(ctx, length, p);
      if (s.fill) {
        // The fill fades in as the outline is drawn.
        ctx.fillStyle = s.fill;
        withAlpha(ctx, s.fillAlpha * p, () => ctx.fill());
      }
      if (s.stroke && s.strokeWidth > 0) {
        ctx.strokeStyle = s.stroke;
        ctx.lineWidth = s.strokeWidth;
        ctx.lineJoin = 'round';
        ctx.lineCap = p < 1 ? 'butt' : 'round';
        ctx.stroke();
      }
      ctx.setLineDash([]);
      break;
    }
    case 'arrow':
    case 'line':
      drawArrowOrLine(ctx, a, p);
      break;
    case 'highlight':
      shapePath(ctx, a.shape, x, y, w, h, s.radius);
      fillAndStroke(ctx, s);
      break;
    default:
      break;
  }
}

/** Draws every annotation active at `time`, in project order (later on top). Works on OffscreenCanvas too. */
export function drawAnnotations(ctx: Ctx2D, project: AnnotationHost, time: number): void {
  const canvas = { width: project.width, height: project.height };
  for (const a of project.annotations) {
    if (time < a.start || time >= a.start + a.duration) continue;
    const r = resolveAnnotation(a, time, canvas);
    if (r.opacity <= 0 || r.scale <= 0) continue;
    if (a.kind === 'spotlight') {
      drawSpotlight(ctx, a, r, canvas);
      continue;
    }
    ctx.save();
    ctx.globalAlpha *= Math.min(1, r.opacity);
    ctx.translate(r.x, r.y);
    if (r.rotation) ctx.rotate((r.rotation * Math.PI) / 180);
    if (r.scale !== 1) ctx.scale(r.scale, r.scale);
    if (a.style.shadow && a.kind !== 'highlight') {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = Math.max(2, a.style.size * 0.12);
      ctx.shadowOffsetY = Math.max(1, a.style.size * 0.04);
    }
    drawBody(ctx, a, sketchProgress(a, time));
    ctx.restore();
  }
}
