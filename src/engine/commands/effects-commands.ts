// Commands for clip effects (colour, green screen, shadow, border, corners, mask, blend, device
// frame) and for the cursor effects drawn over screen recordings.
import {
  CURSOR_LIMITS,
  CURSOR_SHAPES,
  type CursorFx,
  CursorFormatError,
  DEFAULT_CURSOR_FX,
  parseSidecar,
} from '../cursor';
import { attachCursorData, clearCursorFx, removeCursorData, setCursorFx } from '../cursorops';
import { EFFECT_PRESETS, mergeEffects } from '../fx';
import { updateClipEffects } from '../fx-ops';
import { findMedia } from '../project';
import { type CommandDef, type InputSpec, bool, changed, fail, json, needClip, needMedia, num, oneOf, ref, str, usage } from './define';

const HEX = /^#[0-9a-f]{6}$/i;

/** Clips that can carry effects: not bare audio. Fails for an unknown id. */
function effectTargets(p: Parameters<typeof needClip>[0], ids: string[]): string[] {
  for (const id of ids) {
    const clip = needClip(p, id);
    if (findMedia(p, clip.mediaId)?.kind === 'audio') fail(`Clip "${id}" is audio only; effects apply to pictures`);
  }
  return ids;
}

// ---- cursor settings: one typed input per field of CursorFx ----

/** Ranges as parseCursorFx clamps them. A test checks the two agree. */
export const CURSOR_RANGES: Record<string, [number, number]> = {
  size: [0.5, 4],
  smoothing: [0, 1],
  imageHotX: [0, 1],
  imageHotY: [0, 1],
  highlightSize: [0.02, 0.25],
  highlightOpacity: [0.05, 1],
  magnifyZoom: [1.25, 6],
  magnifySize: [0.05, 0.3],
  spotlightSize: [0.05, 0.6],
  spotlightDim: [0, 0.95],
  clickSize: [0.02, 0.2],
  clickDuration: [0.2, 2],
  clickVolume: [0, 1],
  keysHold: [0.3, 6],
  keysSize: [0.5, 2],
};

const CURSOR_COLOURS = ['color', 'highlightColor', 'clickColor'];

const cursorInputs: InputSpec[] = (Object.keys(DEFAULT_CURSOR_FX) as Array<keyof CursorFx>).map((key) => {
  const d = DEFAULT_CURSOR_FX[key];
  const description = `Cursor effect setting "${key}" (default ${JSON.stringify(d)}).`;
  if (typeof d === 'boolean') return bool(key, description, { optional: true });
  if (key === 'shape') return oneOf(key, CURSOR_SHAPES, description, { optional: true });
  if (typeof d === 'string') return str(key, `${description} A colour as #rrggbb.`, { optional: true });
  const [min, max] = CURSOR_RANGES[key] ?? [];
  return num(key, description, { optional: true, min, max });
});
const CURSOR_FIELDS = cursorInputs.map((i) => i.name);

export const effectsCommands: CommandDef[] = [
  {
    name: 'effects set',
    summary: 'Apply effects to clips. Each group you give (colour, chroma, shadow, border, radius, mask, blend, frame) replaces that group; the others stay.',
    inputs: [
      ref('clips', 'Clip ids.', { many: true }),
      json('effects', 'Object with any of: colour, chroma, shadow, border, radius, mask, blend, frame.'),
    ],
    result: 'Object with the clips that changed.',
    needs: 'project',
    run: (p, a) => {
      if (!a.effects || typeof a.effects !== 'object' || Array.isArray(a.effects)) usage('effects must be an object');
      const ids = effectTargets(p, a.clips);
      const next = changed(p, updateClipEffects(p, ids, (cur) => mergeEffects(cur, a.effects)), 'The effects did not change (locked track, or they are already like that)');
      return { project: next, result: { clips: ids } };
    },
  },
  {
    name: 'effects preset',
    summary: 'Apply a one-click look (green screen, rounded card, device frames, colour looks, blend modes) on top of the current effects.',
    inputs: [ref('clips', 'Clip ids.', { many: true }), oneOf('preset', EFFECT_PRESETS.map((e) => e.id), 'Preset id.')],
    result: 'Object with the clips that changed and the preset used.',
    needs: 'project',
    run: (p, a) => {
      const preset = EFFECT_PRESETS.find((e) => e.id === a.preset) ?? fail(`No effect preset "${a.preset}"`);
      const ids = effectTargets(p, a.clips);
      const next = changed(p, updateClipEffects(p, ids, (cur) => mergeEffects(cur, preset.build(p.height))), 'The effects did not change (locked track, or they are already like that)');
      return { project: next, result: { clips: ids, preset: preset.id } };
    },
  },
  {
    name: 'effects clear',
    summary: 'Remove every effect from clips.',
    inputs: [ref('clips', 'Clip ids.', { many: true })],
    result: 'Object with the clips that were cleared.',
    needs: 'project',
    run: (p, a) => {
      const ids = effectTargets(p, a.clips);
      const next = changed(p, updateClipEffects(p, ids, () => undefined), 'None of those clips has effects (or they are on locked tracks)');
      return { project: next, result: { clips: ids } };
    },
  },
  {
    name: 'cursor settings',
    summary: 'Change how the recorded cursor is drawn: shape, size, smoothing, highlight, magnify, spotlight, click rings and sounds, keystroke callouts.',
    inputs: [
      ...cursorInputs,
      str('image', 'Replacement cursor picture as a data URL (PNG, SVG, WebP or JPEG, up to about 256 KB).', { optional: true }),
      bool('clearImage', 'Go back to the built-in cursor shapes.', { optional: true }),
    ],
    result: 'Object with the cursor settings after the change.',
    needs: 'project',
    atLeastOne: [...CURSOR_FIELDS, 'image', 'clearImage'],
    run: (p, a) => {
      const patch: Partial<CursorFx> = {};
      for (const key of CURSOR_FIELDS) if (a[key] !== undefined) (patch as Record<string, unknown>)[key] = a[key];
      for (const key of CURSOR_COLOURS) if (a[key] !== undefined && !HEX.test(a[key])) usage(`${key} must look like #rrggbb`);
      if (a.image !== undefined) {
        if (a.image.length > CURSOR_LIMITS.imageChars) usage('image is too large (about 256 KB at most)');
        patch.image = a.image;
      }
      if (a.clearImage) patch.image = undefined;
      const next = setCursorFx(p, patch);
      return { project: next, result: { cursorFx: next.cursorFx ?? null } };
    },
  },
  {
    name: 'cursor reset',
    summary: 'Remove every cursor effect setting from the project.',
    inputs: [],
    result: 'Object with changed: true when there were settings.',
    needs: 'project',
    cliOnly: true,
    run: (p) => {
      const next = clearCursorFx(p);
      return { project: next, result: { changed: next !== p } };
    },
  },
  {
    name: 'cursor attach',
    summary: 'Attach recorded cursor, click and key data (the text of a .cursor.json file) to a media item.',
    inputs: [ref('media', 'Media id.'), str('sidecar', 'The text of the .cursor.json file.')],
    result: 'Object with the counts of positions, clicks and key events attached.',
    needs: 'project',
    run: (p, a) => {
      needMedia(p, a.media);
      if (a.sidecar.length > CURSOR_LIMITS.sidecarChars) fail('The cursor file is too large (limit 24 MB)');
      let data;
      try {
        data = parseSidecar(a.sidecar);
      } catch (e) {
        return e instanceof CursorFormatError ? fail(e.message) : fail('The cursor data could not be read');
      }
      const next = setCursorFx(attachCursorData(p, a.media, data), {});
      return { project: next, result: { media: a.media, samples: data.samples.length, clicks: data.clicks.length, keys: data.keys.length } };
    },
  },
  {
    name: 'cursor detach',
    summary: 'Remove the cursor data from a media item.',
    inputs: [ref('media', 'Media id.')],
    result: 'Object with the media id.',
    needs: 'project',
    run: (p, a) => {
      needMedia(p, a.media);
      const next = changed(p, removeCursorData(p, a.media), 'That media has no cursor data');
      return { project: next, result: { media: a.media } };
    },
  },
];
