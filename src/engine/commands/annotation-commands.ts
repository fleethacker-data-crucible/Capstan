// Annotation and blur-region commands: text, callouts, shapes, arrows, highlights, spotlights, and
// the regions that blur or pixelate everything beneath them.
import {
  type AnnotationPatch,
  type ReorderMove,
  addAnnotation,
  applyStylePreset,
  duplicateAnnotation,
  moveAnnotation,
  removeAnnotation,
  reorderAnnotation,
  setAnnotationTiming,
  updateAnnotation,
} from '../annotationOps';
import { ANNOTATION_KINDS, MAX_ANNOTATION_TEXT, STYLE_PRESETS } from '../annotations';
import { addRedaction, removeRedaction, updateRedaction } from '../ops';
import type { Project, Redaction } from '../project';
import { type CommandDef, type Args, changed, fail, json, num, oneOf, pick, ref, seconds, str, usage } from './define';

function needAnnotation(p: Project, id: string) {
  return p.annotations.find((a) => a.id === id) ?? fail(`No annotation with id "${id}"`);
}

const GEOMETRY = [
  seconds('start', 'Timeline start in seconds.', { optional: true }),
  num('duration', 'Length in seconds.', { optional: true, min: 1 / 30, max: 3600 }),
  num('x', 'Left edge of the box, canvas pixels.', { optional: true }),
  num('y', 'Top edge of the box, canvas pixels.', { optional: true }),
  num('width', 'Box width, canvas pixels.', { optional: true, min: 1 }),
  num('height', 'Box height, canvas pixels.', { optional: true, min: 1 }),
  num('rotation', 'Degrees about the box centre.', { optional: true, min: -360, max: 360 }),
  num('opacity', '0 to 1.', { optional: true, min: 0, max: 1 }),
];

const FIELDS = [
  ...GEOMETRY,
  str('text', `Text of a text item or callout (up to ${MAX_ANNOTATION_TEXT} characters).`, { optional: true }),
  num('sketch', 'Seconds an arrow, line, rectangle or ellipse takes to draw itself on (0 = off).', { optional: true, min: 0, max: 60 }),
  json('style', 'Style fields to change: fill, fillAlpha, stroke, strokeWidth, color, font, size, bold, italic, align, radius, shadow, dim, feather.', { optional: true }),
];

/** The annotation patch the given arguments describe. */
function patchOf(a: Args): AnnotationPatch {
  const patch: AnnotationPatch = pick(a, ['start', 'duration', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'text', 'sketch']);
  if (a.style !== undefined) {
    if (!a.style || typeof a.style !== 'object' || Array.isArray(a.style)) usage('style must be an object');
    patch.style = a.style;
  }
  return patch;
}

const ANNOTATION_STYLE_PRESETS = STYLE_PRESETS.map((s) => s.id);

export const annotationCommands: CommandDef[] = [
  {
    name: 'annotation add',
    summary: 'Add a text, callout, shape, arrow, line, highlight or spotlight at a time.',
    inputs: [oneOf('kind', ANNOTATION_KINDS, 'What to add.'), seconds('start', 'Timeline start in seconds.'), ...FIELDS.slice(1)],
    result: 'Object with the new annotation id.',
    needs: 'project',
    run: (p, a) => {
      const { start: _s, ...patch } = patchOf(a);
      const r = addAnnotation(p, a.kind, a.start, patch);
      if (!r.id) return fail('Too many annotations in this project');
      return { project: r.project, result: { annotation: r.id } };
    },
  },
  {
    name: 'annotation update',
    summary: 'Change an annotation’s text, timing, box, opacity or style. Keyframes and behavior are kept.',
    inputs: [ref('annotation', 'Annotation id.'), ...FIELDS],
    result: 'Object with the annotation as it is now.',
    needs: 'project',
    atLeastOne: FIELDS.map((f) => f.name),
    run: (p, a) => {
      needAnnotation(p, a.annotation);
      // Timing goes through setAnnotationTiming so trimming the start carries the keyframes along, as the timeline does.
      const { start, duration, ...rest } = patchOf(a);
      let next = Object.keys(rest).length ? updateAnnotation(p, a.annotation, rest) : p;
      if (start !== undefined || duration !== undefined) next = setAnnotationTiming(next, a.annotation, { start, duration });
      return { project: next, result: { annotation: next.annotations.find((x) => x.id === a.annotation) } };
    },
  },
  {
    name: 'annotation remove',
    summary: 'Remove an annotation.',
    inputs: [ref('annotation', 'Annotation id.')],
    result: 'Object with the annotation id.',
    needs: 'project',
    run: (p, a) => {
      needAnnotation(p, a.annotation);
      return { project: removeAnnotation(p, a.annotation), result: { annotation: a.annotation } };
    },
  },
  {
    name: 'annotation duplicate',
    summary: 'Copy an annotation just above the original, nudged down and right.',
    inputs: [ref('annotation', 'Annotation id.')],
    result: 'Object with the new annotation id.',
    needs: 'project',
    run: (p, a) => {
      needAnnotation(p, a.annotation);
      const r = duplicateAnnotation(p, a.annotation);
      if (!r.id) return fail('Too many annotations in this project');
      return { project: r.project, result: { annotation: r.id } };
    },
  },
  {
    name: 'annotation move',
    summary: 'Move an annotation’s box by a distance in canvas pixels; x and y keyframes move with it.',
    inputs: [ref('annotation', 'Annotation id.'), num('dx', 'Pixels to the right (negative: left).'), num('dy', 'Pixels down (negative: up).')],
    result: 'Object with the new left and top.',
    needs: 'project',
    run: (p, a) => {
      needAnnotation(p, a.annotation);
      const next = changed(p, moveAnnotation(p, a.annotation, a.dx, a.dy), 'The annotation did not move (dx and dy are both 0)');
      const now = next.annotations.find((x) => x.id === a.annotation);
      return { project: next, result: { annotation: a.annotation, x: now?.x, y: now?.y } };
    },
  },
  {
    name: 'annotation reorder',
    summary: 'Change the drawing order: later annotations draw on top.',
    inputs: [ref('annotation', 'Annotation id.'), oneOf('order', ['front', 'back', 'forward', 'backward'], 'Where to move it.')],
    result: 'Object with the annotation’s position in the order (0 = bottom).',
    needs: 'project',
    run: (p, a) => {
      needAnnotation(p, a.annotation);
      const next = reorderAnnotation(p, a.annotation, a.order as ReorderMove);
      return { project: next, result: { annotation: a.annotation, index: next.annotations.findIndex((x) => x.id === a.annotation) } };
    },
  },
  {
    name: 'annotation preset',
    summary: 'Apply a ready-made style (title, lower third, code, note, warning ...) to an annotation.',
    inputs: [ref('annotation', 'Annotation id.'), oneOf('preset', ANNOTATION_STYLE_PRESETS, 'Style preset id.')],
    result: 'Object with the annotation id and the preset used.',
    needs: 'project',
    run: (p, a) => {
      needAnnotation(p, a.annotation);
      const preset = STYLE_PRESETS.find((s) => s.id === a.preset) ?? fail(`No style preset "${a.preset}"`);
      return { project: applyStylePreset(p, a.annotation, preset), result: { annotation: a.annotation, preset: preset.id } };
    },
  },
  // ---- blur and pixelate regions ----
  {
    name: 'redaction add',
    summary: 'Add a region that blurs or pixelates every layer beneath it for a stretch of the timeline.',
    inputs: [
      seconds('start', 'Timeline start in seconds.'),
      num('duration', 'Length in seconds (default 3).', { optional: true, min: 1 / 30, max: 86400 }),
      oneOf('mode', ['blur', 'pixelate'], 'Effect (default blur).', { optional: true }),
      num('strength', '1 to 100 (default 60).', { optional: true, min: 1, max: 100 }),
      num('x', 'Left edge, canvas pixels (default: centred).', { optional: true }),
      num('y', 'Top edge, canvas pixels (default: centred).', { optional: true }),
      num('width', 'Width, canvas pixels (default: a quarter of the canvas).', { optional: true, min: 8 }),
      num('height', 'Height, canvas pixels (default: an eighth of the canvas).', { optional: true, min: 8 }),
    ],
    result: 'Object with the new region id.',
    needs: 'project',
    run: (p, a) => {
      const r = addRedaction(p, a.start, pick(a, ['duration', 'mode', 'strength', 'x', 'y', 'width', 'height']) as Partial<Omit<Redaction, 'id'>>);
      return { project: r.project, result: { redaction: r.id } };
    },
  },
  {
    name: 'redaction update',
    summary: 'Change a blur or pixelate region.',
    inputs: [
      ref('redaction', 'Region id.'),
      seconds('start', 'Timeline start in seconds.', { optional: true }),
      num('duration', 'Length in seconds.', { optional: true, min: 1 / 30, max: 86400 }),
      oneOf('mode', ['blur', 'pixelate'], 'Effect.', { optional: true }),
      num('strength', '1 to 100.', { optional: true, min: 1, max: 100 }),
      num('x', 'Left edge, canvas pixels.', { optional: true }),
      num('y', 'Top edge, canvas pixels.', { optional: true }),
      num('width', 'Width, canvas pixels.', { optional: true, min: 8 }),
      num('height', 'Height, canvas pixels.', { optional: true, min: 8 }),
    ],
    result: 'Object with the region as it is now.',
    needs: 'project',
    atLeastOne: ['start', 'duration', 'mode', 'strength', 'x', 'y', 'width', 'height'],
    run: (p, a) => {
      if (!p.redactions.some((r) => r.id === a.redaction)) fail(`No blur region with id "${a.redaction}"`);
      const next = updateRedaction(p, a.redaction, pick(a, ['start', 'duration', 'mode', 'strength', 'x', 'y', 'width', 'height']) as Partial<Omit<Redaction, 'id'>>);
      return { project: next, result: { redaction: next.redactions.find((r) => r.id === a.redaction) } };
    },
  },
  {
    name: 'redaction remove',
    summary: 'Remove a blur or pixelate region.',
    inputs: [ref('redaction', 'Region id.')],
    result: 'Object with the region id.',
    needs: 'project',
    run: (p, a) => {
      const next = changed(p, removeRedaction(p, a.redaction), `No blur region with id "${a.redaction}"`);
      return { project: next, result: { redaction: a.redaction } };
    },
  },
];
