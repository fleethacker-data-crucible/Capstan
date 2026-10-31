// Project templates: a project's settings and layout without its media. A template keeps the canvas
// size, frame rate, background, the track layout, timed annotations, zoom regions, markers and cursor
// style; it leaves out media, clips, captions and blur regions, which belong to one piece of footage.
// Everything is rebuilt through parseProject on use, so a template made by an older build, or edited
// by hand in storage, can only ever produce a valid project.
import type { Annotation } from './annotations';
import type { CursorFx } from './cursor';
import type { Marker } from './markers';
import { type Project, type Track, createTrack, newId, parseProject } from './project';
import type { ZoomRegion } from './zoom';

export interface TemplateBody {
  width: number;
  height: number;
  fps: number;
  background: string;
  tracks: Array<Pick<Track, 'name' | 'muted' | 'hidden' | 'locked'>>;
  annotations: Annotation[];
  zooms: ZoomRegion[];
  markers: Marker[];
  cursorFx?: CursorFx;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  createdAt: number;
  /** A theme id from themes.ts, shown with the template. */
  themeId?: string;
  body: TemplateBody;
}

export function createTemplate(project: Project, name: string, description = ''): ProjectTemplate {
  return {
    id: newId('tpl'),
    name: name.trim().slice(0, 80) || 'Untitled template',
    description: description.trim().slice(0, 200),
    builtin: false,
    createdAt: Date.now(),
    body: {
      width: project.width,
      height: project.height,
      fps: project.fps,
      background: project.background,
      tracks: project.tracks.map((t) => ({ name: t.name, muted: t.muted, hidden: t.hidden, locked: t.locked })),
      annotations: structuredClone(project.annotations),
      zooms: structuredClone(project.zooms),
      markers: structuredClone(project.markers),
      ...(project.cursorFx ? { cursorFx: structuredClone(project.cursorFx) } : {}),
    },
  };
}

/** A new, empty project laid out like the template. */
export function instantiateTemplate(template: ProjectTemplate, name?: string): Project {
  const b = template.body;
  const layout = b.tracks.length ? b.tracks : [{ name: 'Track 1', muted: false, hidden: false, locked: false }];
  const tracks = layout.map((t, i) => ({
    ...createTrack(i),
    name: t.name,
    muted: !!t.muted,
    hidden: !!t.hidden,
    locked: !!t.locked,
  }));
  return parseProject({
    version: 1,
    id: newId('prj'),
    name: (name ?? template.name).slice(0, 120),
    width: b.width,
    height: b.height,
    fps: b.fps,
    background: b.background,
    tracks,
    clips: [],
    media: [],
    redactions: [],
    captions: [],
    annotations: structuredClone(b.annotations),
    zooms: structuredClone(b.zooms),
    markers: structuredClone(b.markers),
    ...(b.cursorFx ? { cursorFx: structuredClone(b.cursorFx) } : {}),
    updatedAt: Date.now(),
  });
}

/** Validates a template read from storage; null if it is unusable. */
export function parseTemplate(input: unknown): ProjectTemplate | null {
  const t = input as Partial<ProjectTemplate> | null;
  if (!t || typeof t.id !== 'string' || !t.body || typeof t.body !== 'object' || !Array.isArray(t.body.tracks)) return null;
  const candidate: ProjectTemplate = {
    id: t.id,
    name: String(t.name ?? 'Untitled template').slice(0, 80),
    description: String(t.description ?? '').slice(0, 200),
    builtin: false,
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0,
    ...(typeof t.themeId === 'string' ? { themeId: t.themeId } : {}),
    body: {
      ...t.body,
      tracks: t.body.tracks.filter((x) => x && typeof x.name === 'string'),
      annotations: Array.isArray(t.body.annotations) ? t.body.annotations : [],
      zooms: Array.isArray(t.body.zooms) ? t.body.zooms : [],
      markers: Array.isArray(t.body.markers) ? t.body.markers : [],
    },
  };
  try {
    instantiateTemplate(candidate);
    return candidate;
  } catch {
    return null;
  }
}

const track = (name: string) => ({ name, muted: false, hidden: false, locked: false });

/** The templates that ship with Capstan. Tracks run bottom to top, as in a project. */
export const BUILTIN_TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: 'builtin-tutorial-16x9',
    name: 'Tutorial, 16:9',
    description: '1920 x 1080 at 30 fps. Music and narration underneath, the screen recording and a camera layer, with separate intro and outro tracks on top.',
    builtin: true,
    createdAt: 0,
    themeId: 'night-watch',
    body: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: '#0f1b2d',
      tracks: [track('Music'), track('Narration'), track('Screen'), track('Camera'), track('Outro'), track('Intro')],
      annotations: [],
      zooms: [],
      markers: [],
    },
  },
  {
    id: 'builtin-vertical-9x16',
    name: 'Vertical, 9:16',
    description: '1080 x 1920 at 30 fps for phone-first video. Audio, footage and an overlay track.',
    builtin: true,
    createdAt: 0,
    themeId: 'slate',
    body: {
      width: 1080,
      height: 1920,
      fps: 30,
      background: '#20242b',
      tracks: [track('Audio'), track('Footage'), track('Overlay')],
      annotations: [],
      zooms: [],
      markers: [],
    },
  },
  {
    id: 'builtin-square-1x1',
    name: 'Square, 1:1',
    description: '1080 x 1080 at 30 fps for feeds. Audio, footage and an overlay track.',
    builtin: true,
    createdAt: 0,
    themeId: 'clean-white',
    body: {
      width: 1080,
      height: 1080,
      fps: 30,
      background: '#ffffff',
      tracks: [track('Audio'), track('Footage'), track('Overlay')],
      annotations: [],
      zooms: [],
      markers: [],
    },
  },
  {
    id: 'builtin-quick-720p',
    name: 'Quick demo, 720p',
    description: '1280 x 720 at 30 fps. Small and fast to export: one screen track, one audio track.',
    builtin: true,
    createdAt: 0,
    body: {
      width: 1280,
      height: 720,
      fps: 30,
      background: '#000000',
      tracks: [track('Audio'), track('Screen')],
      annotations: [],
      zooms: [],
      markers: [],
    },
  },
];
