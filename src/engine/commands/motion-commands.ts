// Motion commands: zoom-n-pan regions, keyframes, transitions and behaviors.
import { type AnimProp, EASE_NAMES, type EaseName } from '../anim';
import { addClipKey, clearClipKeys, keyAt, localTime, removeClipKey, setClipBehavior, setClipTransition, setKeyEase } from '../animate';
import { type Behavior, EMPHASIS_TYPES, ENTER_TYPES, EXIT_TYPES } from '../behaviors';
import { addZoomRegions } from '../cursorops';
import { suggestZooms } from '../cursorfocus';
import { findMedia, newId } from '../project';
import { TRANSITION_TYPES } from '../transitions';
import { MAX_ZOOM, addZoom, duplicateZoom, normaliseZoom, removeZoom, updateZoom, zoomRect } from '../zoom';
import type { ZoomRegion } from '../zoom';
import { type CommandDef, changed, fail, json, needClip, num, oneOf, pick, ref, seconds, usage } from './define';

/** Properties a keyframe command can set. Volume points belong to the audio commands. */
const KEY_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;
const EDGES = ['in', 'out', 'both'] as const;
const STAGES = ['enter', 'emphasis', 'exit'] as const;
const BEHAVIOR_TYPES = [...new Set<string>([...ENTER_TYPES, ...EMPHASIS_TYPES, ...EXIT_TYPES])];
const STAGE_TYPES: Record<(typeof STAGES)[number], readonly string[]> = { enter: ENTER_TYPES, emphasis: EMPHASIS_TYPES, exit: EXIT_TYPES };

function needZoom(p: { zooms: ZoomRegion[] }, id: string): ZoomRegion {
  return p.zooms.find((z) => z.id === id) ?? fail(`No zoom region with id "${id}"`);
}

/** The clip, which must carry a picture (transitions, behaviors and keyframes do not apply to bare audio). */
function pictureClip(p: Parameters<typeof needClip>[0], id: string) {
  const clip = needClip(p, id);
  if (findMedia(p, clip.mediaId)?.kind === 'audio') fail('That clip is audio only; this applies to pictures');
  return clip;
}

const EASE_INPUT = (optional: boolean) => oneOf('ease', EASE_NAMES, 'Easing curve.', { optional });

export const motionCommands: CommandDef[] = [
  {
    name: 'zoom add',
    summary: 'Add a zoom-n-pan region: the camera zooms in on part of the canvas for a stretch of the timeline.',
    inputs: [
      seconds('start', 'Timeline start in seconds.'),
      num('duration', 'Length in seconds (default 3).', { optional: true, min: 1 / 30, max: 86400 }),
      num('level', 'Magnification, 1.1 to 20 (default 2).', { optional: true, min: 1.1, max: MAX_ZOOM }),
      num('focusX', 'Canvas pixel the zoom is centred on (default: the middle).', { optional: true }),
      num('focusY', 'Canvas pixel the zoom is centred on (default: the middle).', { optional: true }),
      num('easeIn', 'Seconds to zoom in (default 0.5).', { optional: true, min: 0, max: 600 }),
      num('easeOut', 'Seconds to zoom back out (default 0.5).', { optional: true, min: 0, max: 600 }),
      EASE_INPUT(true),
    ],
    result: 'Object with the new zoom region id.',
    needs: 'project',
    run: (p, a) => {
      const centre = a.focusX !== undefined || a.focusY !== undefined ? { x: a.focusX ?? p.width / 2, y: a.focusY ?? p.height / 2 } : undefined;
      const patch: Partial<Omit<ZoomRegion, 'id'>> = { ...zoomRect(p, a.level ?? 2, centre), ...pick(a, ['duration', 'easeIn', 'easeOut', 'ease']) };
      const r = addZoom(p, a.start, patch);
      return { project: r.project, result: { zoom: r.id } };
    },
  },
  {
    name: 'zoom update',
    summary: 'Change a zoom region’s timing, rectangle, magnification or easing.',
    inputs: [
      ref('zoom', 'Zoom region id.'),
      seconds('start', 'Timeline start in seconds.', { optional: true }),
      num('duration', 'Length in seconds.', { optional: true, min: 1 / 30, max: 86400 }),
      num('level', 'Magnification, 1.1 to 20; resizes the rectangle about its centre.', { optional: true, min: 1.1, max: MAX_ZOOM }),
      num('x', 'Left edge of the rectangle, canvas pixels.', { optional: true }),
      num('y', 'Top edge of the rectangle, canvas pixels.', { optional: true }),
      num('width', 'Rectangle width, canvas pixels.', { optional: true, min: 1 }),
      num('height', 'Rectangle height, canvas pixels.', { optional: true, min: 1 }),
      num('easeIn', 'Seconds to zoom in.', { optional: true, min: 0, max: 600 }),
      num('easeOut', 'Seconds to zoom back out.', { optional: true, min: 0, max: 600 }),
      EASE_INPUT(true),
    ],
    result: 'Object with the zoom region as it is now.',
    needs: 'project',
    atLeastOne: ['start', 'duration', 'level', 'x', 'y', 'width', 'height', 'easeIn', 'easeOut', 'ease'],
    run: (p, a) => {
      const z = needZoom(p, a.zoom);
      const patch: Partial<Omit<ZoomRegion, 'id'>> = pick(a, ['start', 'duration', 'x', 'y', 'width', 'height', 'easeIn', 'easeOut', 'ease']);
      if (a.level !== undefined) Object.assign(patch, zoomRect(p, a.level, { x: z.x + z.width / 2, y: z.y + z.height / 2 }));
      const next = updateZoom(p, a.zoom, patch);
      return { project: next, result: { zoom: next.zooms.find((x) => x.id === a.zoom) } };
    },
  },
  {
    name: 'zoom remove',
    summary: 'Remove a zoom region.',
    inputs: [ref('zoom', 'Zoom region id.')],
    result: 'Object with the zoom region id.',
    needs: 'project',
    run: (p, a) => {
      needZoom(p, a.zoom);
      return { project: removeZoom(p, a.zoom), result: { zoom: a.zoom } };
    },
  },
  {
    name: 'zoom duplicate',
    summary: 'Copy a zoom region to start right after the original.',
    inputs: [ref('zoom', 'Zoom region id.')],
    result: 'Object with the new zoom region id.',
    needs: 'project',
    run: (p, a) => {
      needZoom(p, a.zoom);
      const r = duplicateZoom(p, a.zoom);
      return { project: r.project, result: { zoom: r.id } };
    },
  },
  {
    name: 'zoom suggest',
    summary: 'Suggest zoom regions from recorded cursor activity (clicks, clusters, dwells). Nothing is added.',
    inputs: [
      num('level', 'Magnification of the suggestions (default 2).', { optional: true, min: 1.1, max: MAX_ZOOM }),
      num('max', 'Most suggestions to return (default 40).', { optional: true, min: 1, max: 200, integer: true }),
    ],
    result: 'Object with regions: the suggested zoom regions, each with its own id.',
    needs: 'project',
    run: (p, a) => ({ project: p, result: { regions: suggestZooms(p, pick(a, ['level', 'max'])) } }),
  },
  {
    name: 'zoom accept',
    summary: 'Add zoom regions, for example ones returned by zoom suggest.',
    inputs: [json('regions', 'Array of zoom regions (start, duration, x, y, width, height, and optionally easeIn, easeOut, ease).')],
    result: 'Object with the ids added.',
    needs: 'project',
    run: (p, a) => {
      if (!Array.isArray(a.regions)) usage('regions must be an array');
      const regions = a.regions.map((raw: unknown) => {
        if (!raw || typeof raw !== 'object') return usage('each region must be an object');
        const r = raw as Record<string, unknown>;
        for (const k of ['start', 'duration', 'x', 'y', 'width', 'height']) if (typeof r[k] !== 'number') usage(`each region needs a number for "${k}"`);
        return normaliseZoom({ ...(r as unknown as ZoomRegion), id: typeof r.id === 'string' ? r.id : newId('zom') }, p);
      });
      const next = changed(p, addZoomRegions(p, regions), 'Nothing to add');
      return { project: next, result: { zooms: regions.map((z: ZoomRegion) => z.id) } };
    },
  },
  // ---- keyframes ----
  {
    name: 'keyframe set',
    summary: 'Set a keyframe on a clip property at a time (replaces a key at the same time). Without a value, the property’s current value is keyed.',
    inputs: [
      ref('clip', 'Clip id.'),
      oneOf('prop', KEY_PROPS, 'Which property.'),
      seconds('time', 'Timeline position in seconds (clamped into the clip).'),
      num('value', 'Value to key (default: the value at that time).', { optional: true }),
      EASE_INPUT(true),
    ],
    result: 'Object with the keys on that property after the change.',
    needs: 'project',
    run: (p, a) => {
      pictureClip(p, a.clip);
      const next = changed(p, addClipKey(p, a.clip, a.prop as AnimProp, a.time, a.value, a.ease as EaseName | undefined), 'The clip is on a locked track');
      return { project: next, result: { clip: a.clip, prop: a.prop, keys: next.clips.find((c) => c.id === a.clip)?.keys?.[a.prop as AnimProp] ?? [] } };
    },
  },
  {
    name: 'keyframe remove',
    summary: 'Remove the keyframe on a clip property at a time.',
    inputs: [ref('clip', 'Clip id.'), oneOf('prop', KEY_PROPS, 'Which property.'), seconds('time', 'Timeline position of the key, in seconds.')],
    result: 'Object with the keys left on that property.',
    needs: 'project',
    run: (p, a) => {
      const clip = pictureClip(p, a.clip);
      const local = localTime(clip, a.time);
      if (!keyAt(clip, a.prop as AnimProp, local)) fail(`No ${a.prop} keyframe at ${a.time} s on that clip`);
      const next = changed(p, removeClipKey(p, a.clip, a.prop as AnimProp, local), 'The clip is on a locked track');
      return { project: next, result: { clip: a.clip, prop: a.prop, keys: next.clips.find((c) => c.id === a.clip)?.keys?.[a.prop as AnimProp] ?? [] } };
    },
  },
  {
    name: 'keyframe ease',
    summary: 'Change the easing used from a keyframe to the next one.',
    inputs: [ref('clip', 'Clip id.'), oneOf('prop', KEY_PROPS, 'Which property.'), seconds('time', 'Timeline position of the key, in seconds.'), EASE_INPUT(false)],
    result: 'Object with the keys on that property.',
    needs: 'project',
    run: (p, a) => {
      const clip = pictureClip(p, a.clip);
      if (!keyAt(clip, a.prop as AnimProp, localTime(clip, a.time))) fail(`No ${a.prop} keyframe at ${a.time} s on that clip`);
      const next = changed(p, setKeyEase(p, a.clip, a.prop as AnimProp, localTime(clip, a.time), a.ease as EaseName), 'The key already has that easing, or the track is locked');
      return { project: next, result: { clip: a.clip, prop: a.prop, keys: next.clips.find((c) => c.id === a.clip)?.keys?.[a.prop as AnimProp] ?? [] } };
    },
  },
  {
    name: 'keyframe clear',
    summary: 'Remove every keyframe on a clip, or on one property.',
    inputs: [ref('clip', 'Clip id.'), oneOf('prop', KEY_PROPS, 'Only this property (default: all).', { optional: true })],
    result: 'Object with changed: true when keys were removed.',
    needs: 'project',
    run: (p, a) => {
      pictureClip(p, a.clip);
      const next = clearClipKeys(p, a.clip, a.prop as AnimProp | undefined);
      return { project: next, result: { clip: a.clip, changed: next !== p } };
    },
  },
  // ---- transitions ----
  {
    name: 'transition set',
    summary: 'Give a clip a transition at its start, its end or both.',
    inputs: [
      ref('clip', 'Clip id.'),
      oneOf('edge', EDGES, 'Where: in (start), out (end) or both.'),
      oneOf('type', TRANSITION_TYPES, 'Transition preset.'),
      num('duration', 'Seconds (default 0.5; never more than half the clip).', { optional: true, min: 0.05, max: 10 }),
    ],
    result: 'Object with the clip’s transitions after the change.',
    needs: 'project',
    run: (p, a) => {
      pictureClip(p, a.clip);
      const t = { type: a.type as string, duration: a.duration ?? 0.5 };
      let next = p;
      if (a.edge !== 'out') next = setClipTransition(next, a.clip, 'in', t);
      if (a.edge !== 'in') next = setClipTransition(next, a.clip, 'out', t);
      next = changed(p, next, 'The clip is on a locked track');
      const c = next.clips.find((x) => x.id === a.clip);
      return { project: next, result: { clip: a.clip, transitionIn: c?.transitionIn ?? null, transitionOut: c?.transitionOut ?? null } };
    },
  },
  {
    name: 'transition clear',
    summary: 'Remove a clip’s transition at its start, its end or both.',
    inputs: [ref('clip', 'Clip id.'), oneOf('edge', EDGES, 'Where: in (start), out (end) or both.')],
    result: 'Object with the clip’s transitions after the change.',
    needs: 'project',
    run: (p, a) => {
      pictureClip(p, a.clip);
      let next = p;
      if (a.edge !== 'out') next = setClipTransition(next, a.clip, 'in', undefined);
      if (a.edge !== 'in') next = setClipTransition(next, a.clip, 'out', undefined);
      const c = next.clips.find((x) => x.id === a.clip);
      return { project: next, result: { clip: a.clip, transitionIn: c?.transitionIn ?? null, transitionOut: c?.transitionOut ?? null } };
    },
  },
  // ---- behaviors ----
  {
    name: 'behavior set',
    summary: 'Give a clip an entrance, emphasis or exit animation.',
    inputs: [
      ref('clip', 'Clip id.'),
      oneOf('stage', STAGES, 'enter, emphasis or exit.'),
      oneOf('type', BEHAVIOR_TYPES, 'Preset: fade, slide-*, pop, spin for enter and exit; pulse or wobble for emphasis.'),
      num('duration', 'Seconds (default 0.5; emphasis 1).', { optional: true, min: 0.05, max: 10 }),
    ],
    result: 'Object with the clip’s behavior after the change.',
    needs: 'project',
    run: (p, a) => {
      pictureClip(p, a.clip);
      const stage = a.stage as keyof Behavior;
      if (!STAGE_TYPES[stage].includes(a.type)) usage(`"${a.type}" is not a ${stage} preset; use one of ${STAGE_TYPES[stage].join(', ')}`);
      const next = changed(p, setClipBehavior(p, a.clip, stage, { type: a.type, duration: a.duration ?? (stage === 'emphasis' ? 1 : 0.5) }), 'The clip is on a locked track');
      return { project: next, result: { clip: a.clip, behavior: next.clips.find((c) => c.id === a.clip)?.behavior ?? null } };
    },
  },
  {
    name: 'behavior clear',
    summary: 'Remove a clip’s entrance, emphasis or exit animation.',
    inputs: [ref('clip', 'Clip id.'), oneOf('stage', STAGES, 'enter, emphasis or exit.')],
    result: 'Object with the clip’s behavior after the change.',
    needs: 'project',
    run: (p, a) => {
      pictureClip(p, a.clip);
      const next = setClipBehavior(p, a.clip, a.stage as keyof Behavior, undefined);
      return { project: next, result: { clip: a.clip, behavior: next.clips.find((c) => c.id === a.clip)?.behavior ?? null } };
    },
  },
];
