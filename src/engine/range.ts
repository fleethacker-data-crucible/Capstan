// The in and out marks: a stretch of the timeline an export can be limited to. Pure helpers; the
// range itself lives on `project.range` and is edited with I / O, by dragging in the ruler, or here.
import type { Project } from './project';

export interface TimeRange {
  start: number;
  end: number;
}

/** Shortest range worth keeping: one frame at 60 fps. */
export const MIN_RANGE_SECONDS = 1 / 60;

/** Validates a range read from disk. Anything unusable becomes "no range". */
export function parseRange(input: unknown): TimeRange | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const r = input as Record<string, unknown>;
  if (typeof r.start !== 'number' || typeof r.end !== 'number' || !Number.isFinite(r.start) || !Number.isFinite(r.end)) return undefined;
  const start = Math.max(0, r.start);
  return r.end - start >= MIN_RANGE_SECONDS ? { start, end: r.end } : undefined;
}

/** Sorts the two ends and keeps the range at least MIN_RANGE_SECONDS long. */
export function makeRange(a: number, b: number): TimeRange {
  const start = Math.max(0, Math.min(a, b));
  const end = Math.max(a, b);
  return { start, end: Math.max(end, start + MIN_RANGE_SECONDS) };
}

/** Sets (or, with undefined, clears) the range. Returns the same project when nothing changed. */
export function setRange(project: Project, range: TimeRange | undefined): Project {
  const next = range ? makeRange(range.start, range.end) : undefined;
  const cur = project.range;
  if (!next && !cur) return project;
  if (next && cur && next.start === cur.start && next.end === cur.end) return project;
  const { range: _old, ...rest } = project;
  return { ...rest, ...(next ? { range: next } : {}), updatedAt: Date.now() };
}

/** I: the range now starts at `time`. An out mark at or before it is dropped to the end of the timeline. */
export function setRangeIn(project: Project, time: number, duration: number): Project {
  const end = project.range && project.range.end > time + MIN_RANGE_SECONDS ? project.range.end : duration;
  return duration > time + MIN_RANGE_SECONDS ? setRange(project, { start: time, end }) : project;
}

/** O: the range now ends at `time`. An in mark at or after it is dropped to the start. */
export function setRangeOut(project: Project, time: number): Project {
  const start = project.range && project.range.start < time - MIN_RANGE_SECONDS ? project.range.start : 0;
  return time > start + MIN_RANGE_SECONDS ? setRange(project, { start, end: time }) : project;
}

/**
 * The stretch an export covers: the marked range clipped to the timeline, or all of it. Returns
 * null when the timeline is empty or the range lies past its end.
 */
export function exportSpan(duration: number, range: TimeRange | undefined): TimeRange | null {
  if (!(duration > 0)) return null;
  if (!range) return { start: 0, end: duration };
  const start = Math.min(duration, Math.max(0, range.start));
  const end = Math.min(duration, range.end);
  return end - start >= MIN_RANGE_SECONDS ? { start, end } : null;
}

/**
 * Where a clip's audio plays inside the export window [from, to]: when to start it (seconds into the
 * export), how far into the source, and how much source to play. Null when the clip is outside.
 */
export function clipWindow(
  clip: { start: number; in: number; duration: number; speed?: number },
  from: number,
  to: number,
): { when: number; offset: number; duration: number } | null {
  const speed = Number.isFinite(clip.speed) && clip.speed ? clip.speed : 1;
  const lo = Math.max(clip.start, from);
  const hi = Math.min(clip.start + clip.duration, to);
  if (hi - lo <= 1e-6) return null;
  return { when: lo - from, offset: clip.in + (lo - clip.start) * speed, duration: (hi - lo) * speed };
}
