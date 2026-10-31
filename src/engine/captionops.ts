// Caption edits: add, edit, retime, split, merge, nudge, delete. Pure, like ops.ts.
import { touch } from './ops';
import { type Caption, MAX_CAPTION_CHARS, type Project, newId } from './project';

/** Shortest a caption can be, seconds. */
export const MIN_CAPTION_SECONDS = 0.05;
export const DEFAULT_CAPTION_SECONDS = 2;
export const NEW_CAPTION_TEXT = 'New caption';

const byStart = (a: Caption, b: Caption) => a.start - b.start || a.end - b.end;

function replace(project: Project, captions: Caption[]): Project {
  return touch(project, { captions: [...captions].sort(byStart) });
}

/**
 * Adds a caption at `time`. If a caption is already showing there the new one starts when it ends,
 * and it stops where the next caption begins.
 */
export function addCaptionAt(project: Project, time: number, text = NEW_CAPTION_TEXT, seconds = DEFAULT_CAPTION_SECONDS): { project: Project; id: string } {
  let start = Math.max(0, Number.isFinite(time) ? time : 0);
  const covering = project.captions.find((c) => start >= c.start && start < c.end);
  if (covering) start = covering.end;
  let end = start + seconds;
  const next = project.captions.filter((c) => c.start >= start).sort(byStart)[0];
  if (next && next.start - start >= MIN_CAPTION_SECONDS) end = Math.min(end, next.start);
  const cap: Caption = { id: newId('cap'), start, end, text: text.slice(0, MAX_CAPTION_CHARS) };
  return { project: replace(project, [...project.captions, cap]), id: cap.id };
}

/** Sets the text. Empty text is allowed while someone is typing; the picture shows nothing for it. */
export function updateCaptionText(project: Project, id: string, text: string): Project {
  const c = project.captions.find((x) => x.id === id);
  const next = text.replace(/\r\n?/g, '\n').slice(0, MAX_CAPTION_CHARS);
  if (!c || c.text === next) return project;
  return touch(project, { captions: project.captions.map((x) => (x.id === id ? { ...x, text: next } : x)) });
}

/** Changes start and/or end. The end stays at least MIN_CAPTION_SECONDS after the start (the start wins). */
export function retimeCaption(project: Project, id: string, patch: { start?: number; end?: number }): Project {
  const c = project.captions.find((x) => x.id === id);
  if (!c) return project;
  const start = Math.max(0, Number.isFinite(patch.start) ? (patch.start as number) : c.start);
  const end = Math.max(start + MIN_CAPTION_SECONDS, Number.isFinite(patch.end) ? (patch.end as number) : c.end);
  if (start === c.start && end === c.end) return project;
  return replace(project, project.captions.map((x) => (x.id === id ? { ...x, start, end } : x)));
}

/** Moves a caption to a new start, keeping its length. */
export function moveCaption(project: Project, id: string, start: number): Project {
  const c = project.captions.find((x) => x.id === id);
  if (!c) return project;
  const s = Math.max(0, start);
  return retimeCaption(project, id, { start: s, end: s + (c.end - c.start) });
}

/** Cuts the text in two near the same proportion as the time is cut, at a line break or a space. */
export function splitText(text: string, fraction: number): [string, string] {
  const lines = text.split('\n');
  const f = Math.min(0.95, Math.max(0.05, fraction));
  if (lines.length > 1) {
    // Choose the line break closest to the fraction of the characters.
    const total = lines.reduce((n, l) => n + l.length, 0) || 1;
    let best = 1;
    let bestGap = Infinity;
    let used = 0;
    for (let i = 1; i < lines.length; i++) {
      used += lines[i - 1].length;
      const gap = Math.abs(used / total - f);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    return [lines.slice(0, best).join('\n'), lines.slice(best).join('\n')];
  }
  const target = text.length * f;
  let cut = -1;
  for (let i = 0; i < text.length; i++) if (text[i] === ' ' && (cut < 0 || Math.abs(i - target) < Math.abs(cut - target))) cut = i;
  if (cut < 0) return [text, ''];
  return [text.slice(0, cut).trimEnd(), text.slice(cut + 1).trimStart()];
}

/**
 * Splits the caption showing at `time` (or the one with `id`, if it contains `time`) into two that
 * meet at `time`. Returns the new ids [first, second], or none if the time is not inside a caption.
 */
export function splitCaption(project: Project, time: number, id?: string): { project: Project; ids: string[] } {
  const c = project.captions.find((x) => (id ? x.id === id : true) && time > x.start + MIN_CAPTION_SECONDS && time < x.end - MIN_CAPTION_SECONDS);
  if (!c) return { project, ids: [] };
  const [a, b] = splitText(c.text, (time - c.start) / (c.end - c.start));
  const first: Caption = { id: newId('cap'), start: c.start, end: time, text: a || c.text };
  const second: Caption = { id: newId('cap'), start: time, end: c.end, text: b || c.text };
  return { project: replace(project, [...project.captions.filter((x) => x.id !== c.id), first, second]), ids: [first.id, second.id] };
}

/** Joins a caption with the one after it: the text on separate lines, the time from the first start to the last end. */
export function mergeWithNext(project: Project, id: string): { project: Project; id: string } {
  const sorted = [...project.captions].sort(byStart);
  const i = sorted.findIndex((c) => c.id === id);
  if (i < 0 || i + 1 >= sorted.length) return { project, id: '' };
  const [a, b] = [sorted[i], sorted[i + 1]];
  const merged: Caption = { id: newId('cap'), start: a.start, end: Math.max(a.end, b.end), text: `${a.text}\n${b.text}`.slice(0, MAX_CAPTION_CHARS) };
  return { project: replace(project, sorted.filter((c) => c !== a && c !== b).concat(merged)), id: merged.id };
}

/** Shifts every caption (or just `ids`) by `delta` seconds. Nothing is moved before 0: the shift stops at the earliest caption. */
export function nudgeCaptions(project: Project, delta: number, ids?: string[]): Project {
  if (!project.captions.length || !Number.isFinite(delta) || delta === 0) return project;
  const chosen = project.captions.filter((c) => !ids || ids.includes(c.id));
  if (!chosen.length) return project;
  const earliest = Math.min(...chosen.map((c) => c.start));
  const d = Math.max(delta, -earliest);
  if (d === 0) return project;
  const set = new Set(chosen.map((c) => c.id));
  return replace(project, project.captions.map((c) => (set.has(c.id) ? { ...c, start: c.start + d, end: c.end + d } : c)));
}

export function removeCaption(project: Project, id: string): Project {
  if (!project.captions.some((c) => c.id === id)) return project;
  return touch(project, { captions: project.captions.filter((c) => c.id !== id) });
}

export function captionIndex(project: Project, id: string): number {
  return project.captions.findIndex((c) => c.id === id);
}
