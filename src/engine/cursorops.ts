// Pure edits for the cursor area, in the style of ops.ts: each takes a project and returns the next.
import { type CursorData, type CursorFx, DEFAULT_CURSOR_FX, parseCursorFx } from './cursor';
import { touch } from './ops';
import type { Project } from './project';
import type { ZoomRegion } from './zoom';

/** Attaches (or replaces) cursor data on a media item. */
export function attachCursorData(project: Project, mediaId: string, data: CursorData): Project {
  if (!project.media.some((m) => m.id === mediaId)) return project;
  return touch(project, { media: project.media.map((m) => (m.id === mediaId ? { ...m, cursor: data } : m)) });
}

/** Removes the cursor data from a media item. */
export function removeCursorData(project: Project, mediaId: string): Project {
  if (!project.media.some((m) => m.id === mediaId && m.cursor)) return project;
  return touch(project, {
    media: project.media.map((m) => {
      if (m.id !== mediaId) return m;
      const { cursor: _gone, ...rest } = m;
      return rest;
    }),
  });
}

/** Changes cursor effect settings; creates them from the defaults on first use. Values are validated and clamped. */
export function setCursorFx(project: Project, patch: Partial<CursorFx>): Project {
  const next = parseCursorFx({ ...DEFAULT_CURSOR_FX, ...project.cursorFx, ...patch });
  return touch(project, next ? { cursorFx: next } : {});
}

/** Removes every cursor effect setting. */
export function clearCursorFx(project: Project): Project {
  if (!project.cursorFx) return project;
  const { cursorFx: _gone, ...rest } = project;
  return touch(rest as Project, {});
}

/** Adds zoom regions (for example accepted smart-focus suggestions), keeping the list sorted by start. */
export function addZoomRegions(project: Project, regions: ZoomRegion[]): Project {
  if (!regions.length) return project;
  const have = new Set(project.zooms.map((z) => z.id));
  const fresh = regions.filter((r) => !have.has(r.id));
  return touch(project, { zooms: [...project.zooms, ...fresh].sort((a, b) => a.start - b.start) });
}

/** True when any media in the project carries cursor data. */
export function hasCursorData(project: Project): boolean {
  return project.media.some((m) => !!m.cursor);
}
