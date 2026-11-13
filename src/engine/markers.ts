// Timeline markers, exported as chapters. Pure edits like ops.ts: each takes a project and returns a new one.
import { touch } from './ops';
import { type Project, newId } from './project';

export interface Marker {
  id: string;
  /** Seconds on the timeline. */
  time: number;
  name: string;
  /** Written to the exported file as a chapter. */
  chapter: boolean;
}

export const MAX_MARKERS = 500;
export const MAX_MARKER_NAME = 80;

const cleanName = (s: unknown, fallback: string): string => {
  const t = typeof s === 'string' ? s.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_MARKER_NAME) : '';
  return t || fallback;
};

const byTime = (a: Marker, b: Marker) => a.time - b.time || a.name.localeCompare(b.name);

/** Reads markers from saved JSON. Anything malformed is dropped, ids are made unique, the list is sorted. */
export function parseMarkers(input: unknown): Marker[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: Marker[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    const time = typeof m.time === 'number' ? m.time : Number.NaN;
    if (!Number.isFinite(time) || time < 0) continue;
    let id = typeof m.id === 'string' && m.id ? m.id.slice(0, 64) : newId('mrk');
    if (seen.has(id)) id = newId('mrk');
    seen.add(id);
    out.push({ id, time, name: cleanName(m.name, `Marker ${out.length + 1}`), chapter: m.chapter === true });
    if (out.length >= MAX_MARKERS) break;
  }
  return out.sort(byTime);
}

/** Adds a marker at `time`. The name defaults to "Marker N". */
export function addMarker(project: Project, time: number, name?: string, chapter = false): { project: Project; id: string } {
  const marker: Marker = {
    id: newId('mrk'),
    time: Math.max(0, Number.isFinite(time) ? time : 0),
    name: cleanName(name, `Marker ${project.markers.length + 1}`),
    chapter,
  };
  if (project.markers.length >= MAX_MARKERS) return { project, id: '' };
  return { project: touch(project, { markers: [...project.markers, marker].sort(byTime) }), id: marker.id };
}

function change(project: Project, id: string, patch: Partial<Omit<Marker, 'id'>>): Project {
  const current = project.markers.find((m) => m.id === id);
  if (!current) return project;
  const next = { ...current, ...patch };
  if (next.time === current.time && next.name === current.name && next.chapter === current.chapter) return project;
  return touch(project, { markers: project.markers.map((m) => (m.id === id ? next : m)).sort(byTime) });
}

/** Not trimmed, so a name can be typed with spaces; an empty name shows as "Marker" and exports as "Chapter". */
export const renameMarker = (project: Project, id: string, name: string): Project => change(project, id, { name: name.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_MARKER_NAME) });
export const moveMarker = (project: Project, id: string, time: number): Project => change(project, id, { time: Math.max(0, Number.isFinite(time) ? time : 0) });
export const setMarkerChapter = (project: Project, id: string, chapter: boolean): Project => change(project, id, { chapter });

export function toggleMarkerChapter(project: Project, id: string): Project {
  const m = project.markers.find((x) => x.id === id);
  return m ? change(project, id, { chapter: !m.chapter }) : project;
}

export function removeMarker(project: Project, id: string): Project {
  if (!project.markers.some((m) => m.id === id)) return project;
  return touch(project, { markers: project.markers.filter((m) => m.id !== id) });
}

/** The first marker strictly after (dir 1) or before (dir -1) `time`. */
export function neighbourMarker(project: Project, time: number, dir: 1 | -1): Marker | undefined {
  const eps = 1e-3;
  const sorted = [...project.markers].sort(byTime);
  return dir === 1 ? sorted.find((m) => m.time > time + eps) : [...sorted].reverse().find((m) => m.time < time - eps);
}

// ---- chapters ----

export interface Chapter {
  time: number;
  name: string;
}

/** The markers flagged as chapters, in time order, only those inside the timeline when `duration` is given. */
export function chapterList(markers: Marker[], duration?: number): Chapter[] {
  return markers
    .filter((m) => m.chapter && (duration === undefined || m.time < duration))
    .sort(byTime)
    .map((m) => ({ time: m.time, name: m.name.trim() || 'Chapter' }));
}

function clock(t: number, minutes: 'short' | 'long'): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h || minutes === 'long' ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

/**
 * YouTube-style chapter list, one "m:ss Title" per line. YouTube wants the first chapter at 0:00,
 * so a starting "Start" line is added when the first chapter is later.
 */
export function formatChaptersText(chapters: Chapter[]): string {
  if (!chapters.length) return '';
  const list = chapters[0].time >= 1 ? [{ time: 0, name: 'Start' }, ...chapters] : chapters;
  const long = list.some((c) => c.time >= 3600);
  return `${list.map((c) => `${clock(c.time, long ? 'long' : 'short')} ${c.name}`).join('\n')}\n`;
}

function vttStamp(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
}

/**
 * WebVTT chapters track (`kind="chapters"`): each chapter runs until the next one, the last until `duration`.
 * `&`, `<` and `>` are escaped, so a title cannot close a tag or end an HTML comment (`-->` or `--!>`).
 */
export function formatChaptersVtt(chapters: Chapter[], duration: number): string {
  const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cues = chapters.map((c, i) => {
    const end = i + 1 < chapters.length ? chapters[i + 1].time : Math.max(duration, c.time + 1);
    const title = escape(c.name);
    return `${i + 1}\n${vttStamp(c.time)} --> ${vttStamp(Math.max(end, c.time + 0.001))}\n${title}\n`;
  });
  return `WEBVTT\n\n${cues.join('\n')}`;
}
