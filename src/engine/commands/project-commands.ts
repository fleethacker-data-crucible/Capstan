// Commands for the project itself, its tracks and its media list, plus the history and session
// controls that only the live page can run.
import { addTrack, removeMedia, addMedia, removeTrack, resizeCanvas, updateProject, updateTrack } from '../ops';
import { setTrackMagnetic } from '../editops';
import { type MediaItem, type Project, createProject, newId, parseProject, projectDuration } from '../project';
import { BUILTIN_TEMPLATES, instantiateTemplate } from '../templates';
import { THEMES, applyThemeToProject, getTheme } from '../themes';
import { type CommandDef, bool, browserCommand, changed, fail, json, needMedia, needTrack, num, oneOf, ref, str, usage } from './define';

const HEX = /^#[0-9a-f]{6}$/i;

/** Counts for `project show` and the dry-run summary. */
export function projectSummary(p: Project) {
  return {
    id: p.id,
    name: p.name,
    width: p.width,
    height: p.height,
    fps: p.fps,
    background: p.background,
    duration: projectDuration(p),
    counts: {
      tracks: p.tracks.length,
      clips: p.clips.length,
      media: p.media.length,
      redactions: p.redactions.length,
      captions: p.captions.length,
      annotations: p.annotations.length,
      zooms: p.zooms.length,
      markers: p.markers.length,
    },
  };
}

const fileSafe = (name: string): string => name.replace(/[\\/:*?"<>|]+/g, '').trim().replace(/\s+/g, ' ').slice(0, 80) || 'project';

export const projectCommands: CommandDef[] = [
  {
    name: 'project show',
    summary: 'Show the project: size, frame rate, length and how many of each item it holds.',
    inputs: [],
    result: 'Object with id, name, width, height, fps, background, duration (seconds) and counts per kind of item.',
    needs: 'project',
    cliOnly: true,
    run: (p) => ({ project: p, result: projectSummary(p) }),
  },
  {
    name: 'project new',
    summary: 'Replace the project with a new, empty one.',
    inputs: [
      str('name', 'Project name.', { optional: true }),
      num('width', 'Canvas width in pixels.', { optional: true, min: 16, max: 7680, integer: true }),
      num('height', 'Canvas height in pixels.', { optional: true, min: 16, max: 4320, integer: true }),
      num('fps', 'Frame rate.', { optional: true, min: 1, max: 60, integer: true }),
    ],
    result: 'The new project summary.',
    destructive: true,
    needs: 'project',
    run: (_p, a) => {
      const next = createProject(a.name ?? 'Untitled project', a.width ?? 1920, a.height ?? 1080, a.fps ?? 30);
      return { project: next, result: projectSummary(next) };
    },
  },
  {
    name: 'project from-template',
    summary: 'Replace the project with an empty one laid out like a built-in template.',
    inputs: [
      oneOf('template', BUILTIN_TEMPLATES.map((t) => t.id), 'Built-in template id.'),
      str('name', 'Project name (default: the template name).', { optional: true }),
    ],
    result: 'The new project summary.',
    destructive: true,
    needs: 'project',
    run: (_p, a) => {
      const template = BUILTIN_TEMPLATES.find((t) => t.id === a.template) ?? fail(`No built-in template "${a.template}"`);
      const next = instantiateTemplate(template, a.name);
      return { project: next, result: projectSummary(next) };
    },
  },
  {
    name: 'project open',
    summary: 'Replace the project with one read from a .capstan file (the edit only; media bytes are not in it).',
    inputs: [json('project', 'The project: an object, or the text of a .capstan file.')],
    result: 'The opened project summary.',
    destructive: true,
    needs: 'project',
    run: (_p, a) => {
      let next: Project;
      try {
        next = parseProject(a.project);
      } catch (e) {
        return fail((e as Error).message);
      }
      return { project: next, result: projectSummary(next) };
    },
  },
  {
    name: 'project save',
    summary: 'Write the project as .capstan file text (the edit only). The caller stores the text.',
    inputs: [],
    result: 'Object with fileName and text (the JSON of the project).',
    needs: 'project',
    run: (p) => ({ project: p, result: { fileName: `${fileSafe(p.name)}.capstan`, text: JSON.stringify(p, null, 2) } }),
  },
  {
    name: 'project set',
    summary: 'Change the project name, frame rate or background colour.',
    inputs: [
      str('name', 'Project name (up to 120 characters).', { optional: true }),
      num('fps', 'Frame rate.', { optional: true, min: 1, max: 60, integer: true }),
      str('background', 'Canvas background as #rrggbb.', { optional: true }),
    ],
    result: 'The project summary.',
    needs: 'project',
    atLeastOne: ['name', 'fps', 'background'],
    run: (p, a) => {
      if (a.background !== undefined && !HEX.test(a.background)) usage('background must look like #rrggbb');
      const patch: Parameters<typeof updateProject>[1] = {};
      if (a.name !== undefined) patch.name = String(a.name).slice(0, 120);
      if (a.fps !== undefined) patch.fps = a.fps;
      if (a.background !== undefined) patch.background = String(a.background).toLowerCase();
      const next = updateProject(p, patch);
      return { project: next, result: projectSummary(next) };
    },
  },
  {
    name: 'project resize',
    summary: 'Change the canvas size; clips, annotations, zooms and blur regions keep their relative place.',
    inputs: [
      num('width', 'Canvas width in pixels.', { min: 16, max: 7680, integer: true }),
      num('height', 'Canvas height in pixels.', { min: 16, max: 4320, integer: true }),
    ],
    result: 'The project summary.',
    needs: 'project',
    run: (p, a) => {
      const next = resizeCanvas(p, a.width, a.height);
      return { project: next, result: projectSummary(next) };
    },
  },
  {
    name: 'project theme',
    summary: 'Apply a theme to the project (today: the canvas background).',
    inputs: [oneOf('theme', THEMES.map((t) => t.id), 'Theme id.')],
    result: 'Object with the theme id and the background now in use.',
    needs: 'project',
    run: (p, a) => {
      const theme = getTheme(a.theme) ?? fail(`No theme "${a.theme}"`);
      const next = applyThemeToProject(p, theme);
      return { project: next, result: { theme: theme.id, background: next.background } };
    },
  },
  {
    name: 'track add',
    summary: 'Add a track on top of the others.',
    inputs: [str('name', 'Track name (default "Track N").', { optional: true })],
    result: 'Object with the new track id.',
    needs: 'project',
    run: (p, a) => {
      let next = addTrack(p);
      const track = next.tracks[next.tracks.length - 1];
      if (a.name !== undefined) next = updateTrack(next, track.id, { name: String(a.name).slice(0, 60) });
      return { project: next, result: { track: track.id } };
    },
  },
  {
    name: 'track remove',
    summary: 'Remove a track and every clip on it. The last track cannot be removed.',
    inputs: [ref('track', 'Track id.')],
    result: 'Object with the track id and how many clips went with it.',
    destructive: true,
    needs: 'project',
    run: (p, a) => {
      needTrack(p, a.track);
      const next = changed(p, removeTrack(p, a.track), 'The last track cannot be removed');
      return { project: next, result: { track: a.track, clipsRemoved: p.clips.length - next.clips.length } };
    },
  },
  {
    name: 'track update',
    summary: 'Rename a track, mute, hide or lock it, or make it magnetic (clips close up, no gaps).',
    inputs: [
      ref('track', 'Track id.'),
      str('name', 'Track name.', { optional: true }),
      bool('muted', 'Silence the track.', { optional: true }),
      bool('hidden', 'Hide the track from the picture.', { optional: true }),
      bool('locked', 'Lock the track against edits.', { optional: true }),
      bool('magnetic', 'Keep the track free of gaps; turning it on closes its gaps now.', { optional: true }),
    ],
    result: 'Object with the track as it is now.',
    needs: 'project',
    atLeastOne: ['name', 'muted', 'hidden', 'locked', 'magnetic'],
    run: (p, a) => {
      needTrack(p, a.track);
      let next = p;
      const plain: Parameters<typeof updateTrack>[2] = {};
      if (a.name !== undefined) plain.name = String(a.name).slice(0, 60);
      if (a.muted !== undefined) plain.muted = a.muted;
      if (a.hidden !== undefined) plain.hidden = a.hidden;
      if (a.locked !== undefined) plain.locked = a.locked;
      if (Object.keys(plain).length) next = updateTrack(next, a.track, plain);
      if (a.magnetic !== undefined) next = setTrackMagnetic(next, a.track, a.magnetic);
      return { project: next, result: { track: next.tracks.find((t) => t.id === a.track) } };
    },
  },
  {
    name: 'media add',
    summary: 'Add a media item to the project by its metadata. The bytes come from a media import; this registers a description of a file.',
    inputs: [
      str('name', 'File name shown in the media bin.'),
      oneOf('kind', ['video', 'audio', 'image'], 'What the media is.'),
      num('duration', 'Length in seconds (0 for an image).', { min: 0, max: 86400 }),
      num('width', 'Width in pixels (0 for audio).', { min: 0, max: 16384, integer: true }),
      num('height', 'Height in pixels (0 for audio).', { min: 0, max: 16384, integer: true }),
      bool('hasAudio', 'The media has a sound track (default: true for video, false for an image; audio always has).', { optional: true }),
      str('mime', 'MIME type.', { optional: true }),
      num('bytes', 'Size in bytes.', { optional: true, min: 0, integer: true }),
      str('id', 'Media id to use (default: a new one).', { optional: true }),
    ],
    result: 'Object with the media id.',
    needs: 'project',
    cliOnly: true,
    run: (p, a) => {
      if (a.kind !== 'image' && !(a.duration > 0)) usage('duration must be above 0 for video and audio');
      if (a.kind !== 'audio' && !(a.width > 0 && a.height > 0)) usage('width and height must be above 0 for video and images');
      const item: MediaItem = {
        id: a.id ?? newId('med'),
        name: String(a.name).slice(0, 200),
        kind: a.kind,
        mime: a.mime ?? '',
        bytes: a.bytes ?? 0,
        duration: a.kind === 'image' ? 0 : a.duration,
        width: a.kind === 'audio' ? 0 : a.width,
        height: a.kind === 'audio' ? 0 : a.height,
        hasAudio: a.kind === 'audio' ? true : a.kind === 'image' ? false : (a.hasAudio ?? true),
        createdAt: Date.now(),
      };
      const next = changed(p, addMedia(p, item), `Media id "${item.id}" is already in the project`);
      return { project: next, result: { media: item.id } };
    },
  },
  {
    name: 'media remove',
    summary: 'Remove a media item and every clip that uses it.',
    inputs: [ref('media', 'Media id.')],
    result: 'Object with the media id and how many clips went with it.',
    destructive: true,
    needs: 'project',
    run: (p, a) => {
      needMedia(p, a.media);
      const next = removeMedia(p, a.media);
      return { project: next, result: { media: a.media, clipsRemoved: p.clips.length - next.clips.length } };
    },
  },
  browserCommand({
    name: 'history undo',
    summary: 'Undo the last edit in the open editor.',
    inputs: [num('steps', 'How many edits to undo (default 1).', { optional: true, min: 1, max: 200, integer: true })],
    result: 'Object with how many edits were undone.',
  }),
  browserCommand({
    name: 'history redo',
    summary: 'Redo an undone edit in the open editor.',
    inputs: [num('steps', 'How many edits to redo (default 1).', { optional: true, min: 1, max: 200, integer: true })],
    result: 'Object with how many edits were redone.',
  }),
  browserCommand({
    name: 'projects list',
    summary: 'List the projects stored in this browser.',
    inputs: [],
    result: 'Array of project summaries (id, name, size, clips, updated).',
  }),
  browserCommand({
    name: 'projects open',
    summary: 'Open a project stored in this browser.',
    inputs: [ref('project', 'Stored project id.')],
    result: 'The opened project summary and the names of any media missing from this browser.',
  }),
  browserCommand({
    name: 'projects rename',
    summary: 'Rename a stored project.',
    inputs: [ref('project', 'Stored project id.'), str('name', 'New name.')],
    result: 'Object with the project id and its new name.',
  }),
  browserCommand({
    name: 'projects duplicate',
    summary: 'Copy a stored project, with its own copy of the media.',
    inputs: [ref('project', 'Stored project id.')],
    result: 'Object with the new project id.',
  }),
  browserCommand({
    name: 'projects delete',
    summary: 'Delete a stored project and its media from this browser.',
    inputs: [ref('project', 'Stored project id.')],
    result: 'Object with the deleted project id.',
    destructive: true,
  }),
  browserCommand({
    name: 'session end',
    summary: 'End the Capstan session: the local server stops once the window closes.',
    inputs: [],
    result: 'Object with ended: true.',
    destructive: true,
  }),
];
