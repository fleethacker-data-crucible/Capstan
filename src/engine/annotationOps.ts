// Pure edits on project.annotations. Each takes a project and returns the next one (or the same one
// when nothing applies), like the rest of ops.ts. Kept apart from annotations.ts so the model file
// does not depend on ops.ts, which itself imports annotations.ts.
import { type Keys, shiftKeys } from './anim';
import {
  type Annotation,
  type AnnotationKind,
  type AnnotationStyle,
  MAX_ANNOTATIONS,
  type StylePreset,
  defaultAnnotation,
  normaliseAnnotation,
} from './annotations';
import { touch } from './ops';
import { type Project, newId } from './project';

export type AnnotationPatch = Partial<Omit<Annotation, 'id' | 'kind' | 'style'>> & { style?: Partial<AnnotationStyle> };

/** Adds a new annotation of `kind` at `start`, on top of the others. `patch` overrides the defaults. */
export function addAnnotation(project: Project, kind: AnnotationKind, start: number, patch: AnnotationPatch = {}): { project: Project; id: string } {
  if (project.annotations.length >= MAX_ANNOTATIONS) return { project, id: '' };
  const base = defaultAnnotation(kind, project, start, newId('ann'));
  const next = normaliseAnnotation({ ...base, ...patch, style: { ...base.style, ...patch.style }, id: base.id, kind }, project);
  return { project: touch(project, { annotations: [...project.annotations, next] }), id: next.id };
}

/** Applies a change to one annotation; every value is validated again. Keyframes and behavior are kept as they are unless the patch replaces them. */
export function updateAnnotation(project: Project, id: string, patch: AnnotationPatch): Project {
  const current = project.annotations.find((a) => a.id === id);
  if (!current) return project;
  const merged = { ...current, ...patch, style: { ...current.style, ...patch.style }, id: current.id, kind: current.kind };
  const next = normaliseAnnotation(merged, project);
  // normaliseAnnotation reads keys and behavior as if from a file; an edit that does not mention them keeps what the item holds.
  if (!('keys' in patch)) {
    if (current.keys) next.keys = current.keys;
    else delete next.keys;
  }
  if (!('behavior' in patch)) {
    if (current.behavior) next.behavior = current.behavior;
    else delete next.behavior;
  }
  return touch(project, { annotations: project.annotations.map((a) => (a.id === id ? next : a)) });
}

export function updateAnnotationStyle(project: Project, id: string, style: Partial<AnnotationStyle>): Project {
  return updateAnnotation(project, id, { style });
}

export function applyStylePreset(project: Project, id: string, preset: StylePreset): Project {
  return updateAnnotation(project, id, { style: preset.patch });
}

/**
 * Moves or trims an annotation in time. Trimming the start (start and duration both change) shifts
 * its keyframes so they stay at the same moments of the timeline; moving it leaves them alone,
 * because keyframe times are relative to the item.
 */
export function setAnnotationTiming(project: Project, id: string, patch: { start?: number; duration?: number }): Project {
  const current = project.annotations.find((a) => a.id === id);
  if (!current) return project;
  const next = updateAnnotation(project, id, patch);
  const moved = next.annotations.find((a) => a.id === id)!;
  if (patch.start !== undefined && patch.duration !== undefined && moved.start !== current.start && moved.duration !== current.duration) {
    const keys: Keys | undefined = shiftKeys(moved.keys, -(moved.start - current.start));
    return touch(next, { annotations: next.annotations.map((a) => (a.id === id ? withKeys(a, keys) : a)) });
  }
  return next;
}

function withKeys(a: Annotation, keys: Keys | undefined): Annotation {
  const { keys: _old, ...rest } = a;
  return keys ? { ...rest, keys } : rest;
}

/** Moves the box by (dx, dy) canvas pixels, taking any x / y keyframes with it so an animated item moves as a whole. */
export function moveAnnotation(project: Project, id: string, dx: number, dy: number): Project {
  const current = project.annotations.find((a) => a.id === id);
  if (!current || (dx === 0 && dy === 0)) return project;
  const keys: Keys | undefined = current.keys && {
    ...current.keys,
    x: current.keys.x?.map((k) => ({ ...k, v: k.v + dx })),
    y: current.keys.y?.map((k) => ({ ...k, v: k.v + dy })),
  };
  if (keys) {
    if (!keys.x) delete keys.x;
    if (!keys.y) delete keys.y;
  }
  return updateAnnotation(project, id, { x: current.x + dx, y: current.y + dy, ...(keys ? { keys } : {}) });
}

export function removeAnnotation(project: Project, id: string): Project {
  if (!project.annotations.some((a) => a.id === id)) return project;
  return touch(project, { annotations: project.annotations.filter((a) => a.id !== id) });
}

/** A copy just above the original, nudged down and right so it can be told apart. */
export function duplicateAnnotation(project: Project, id: string): { project: Project; id: string } {
  const i = project.annotations.findIndex((a) => a.id === id);
  if (i < 0 || project.annotations.length >= MAX_ANNOTATIONS) return { project, id: '' };
  const src = project.annotations[i];
  const nudge = Math.round(project.height * 0.03);
  const copy = normaliseAnnotation({ ...src, id: newId('ann'), x: src.x + nudge, y: src.y + nudge }, project);
  if (src.keys) copy.keys = src.keys;
  if (src.behavior) copy.behavior = src.behavior;
  const list = [...project.annotations];
  list.splice(i + 1, 0, copy);
  return { project: touch(project, { annotations: list }), id: copy.id };
}

export type ReorderMove = 'front' | 'back' | 'forward' | 'backward';

/** Changes the drawing order: later items draw on top of earlier ones. */
export function reorderAnnotation(project: Project, id: string, move: ReorderMove): Project {
  const list = [...project.annotations];
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return project;
  const to = move === 'front' ? list.length - 1 : move === 'back' ? 0 : move === 'forward' ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
  if (to === i) return project;
  const [item] = list.splice(i, 1);
  list.splice(to, 0, item);
  return touch(project, { annotations: list });
}
