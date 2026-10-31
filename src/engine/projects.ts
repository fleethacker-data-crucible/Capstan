// Multi-project helpers (pure): summaries for the Projects list, copies with fresh ids, and
// "is this project worth keeping". Storage lives in storage.ts.
import { type Project, newId } from './project';

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  width: number;
  height: number;
  mediaCount: number;
  clipCount: number;
  /** Sum of the media files' sizes: what the project occupies in browser storage. */
  mediaBytes: number;
  /** Timeline length in seconds. */
  duration: number;
}

export function summariseProject(p: Project): ProjectSummary {
  return {
    id: p.id,
    name: p.name,
    updatedAt: p.updatedAt,
    width: p.width,
    height: p.height,
    mediaCount: p.media.length,
    clipCount: p.clips.length,
    mediaBytes: p.media.reduce((sum, m) => sum + (Number.isFinite(m.bytes) ? m.bytes : 0), 0),
    duration: p.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0),
  };
}

/** A project nobody has put anything into: not worth a place in the list or in storage. */
export function isEmptyProject(p: Project): boolean {
  return (
    p.media.length === 0 &&
    p.clips.length === 0 &&
    p.annotations.length === 0 &&
    p.captions.length === 0 &&
    p.redactions.length === 0 &&
    p.zooms.length === 0 &&
    p.markers.length === 0
  );
}

/**
 * A copy with a new project id and new media ids, so it owns its own media Blobs and deleting one
 * project can never remove another's media. `idMap` maps old media id to new, for copying the Blobs.
 * Clips are re-pointed; anything else that names a media id would need re-pointing here too.
 */
export function cloneProject(p: Project, name?: string): { project: Project; idMap: Map<string, string> } {
  const idMap = new Map(p.media.map((m) => [m.id, newId('med')]));
  const project: Project = {
    ...p,
    id: newId('prj'),
    name: (name ?? p.name).slice(0, 120),
    media: p.media.map((m) => ({ ...m, id: idMap.get(m.id) as string })),
    clips: p.clips.map((c) => ({ ...c, mediaId: idMap.get(c.mediaId) ?? c.mediaId })),
    updatedAt: Date.now(),
  };
  return { project, idMap };
}

/** "Name (copy)", "Name (copy 2)", ... the first one not already taken. */
export function copyName(name: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  const base = name.replace(/ \(copy(?: \d+)?\)$/, '');
  let candidate = `${base} (copy)`;
  for (let n = 2; names.has(candidate); n++) candidate = `${base} (copy ${n})`;
  return candidate.slice(0, 120);
}
