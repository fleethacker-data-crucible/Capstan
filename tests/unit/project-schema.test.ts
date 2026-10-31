// docs/project.schema.json against the code: projects built with the editor's operations validate, what
// parseProject returns for messy files validates, broken projects do not, and every list, limit and
// field in the schema is one that parseProject really keeps.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EASE_NAMES } from '../../src/engine/anim';
import { addClipKey, setClipBehavior, setClipTransition } from '../../src/engine/animate';
import { ANNOTATION_KINDS, FONT_KEYS, MAX_ANNOTATIONS, MAX_ANNOTATION_SECONDS, MAX_ANNOTATION_TEXT, MAX_SKETCH_SECONDS } from '../../src/engine/annotations';
import { addAnnotation } from '../../src/engine/annotationOps';
import { MAX_FADE_SECONDS } from '../../src/engine/audiofx';
import { updateClipAudio } from '../../src/engine/audioops';
import { EMPHASIS_TYPES, ENTER_TYPES, EXIT_TYPES, MAX_STEP_SECONDS, MIN_STEP_SECONDS } from '../../src/engine/behaviors';
import { addCaptionAt } from '../../src/engine/captionops';
import { CURSOR_LIMITS, CURSOR_SHAPES } from '../../src/engine/cursor';
import { setCursorFx } from '../../src/engine/cursorops';
import { detachAudio, freezeFrame, groupClips, setClipCrop, setClipSpeed, setTrackMagnetic } from '../../src/engine/editops';
import { BLEND_MODES, FRAME_KINDS } from '../../src/engine/fx';
import { updateClipEffects } from '../../src/engine/fx-ops';
import { MAX_MARKERS, MAX_MARKER_NAME, addMarker } from '../../src/engine/markers';
import { addClip, addMedia, addRedaction, addTrack, updateProject } from '../../src/engine/ops';
import {
  type MediaItem,
  MAX_CAPTION_CHARS,
  MAX_SPEED,
  MIN_CLIP_SECONDS,
  MIN_REDACTION_PX,
  MIN_SPEED,
  type Project,
  createProject,
  parseProject,
} from '../../src/engine/project';
import { MIN_RANGE_SECONDS, setRange } from '../../src/engine/range';
import { MAX_TRANSITION_SECONDS, MIN_TRANSITION_SECONDS, TRANSITION_TYPES } from '../../src/engine/transitions';
import { MAX_ZOOMS, addZoom } from '../../src/engine/zoom';
import { sample } from './helpers/command-sample';
import { type Schema, validate } from './helpers/json-schema';

const root = join(import.meta.dir, '..', '..');
const schemaText = readFileSync(join(root, 'docs', 'project.schema.json'), 'utf8');
const schema = JSON.parse(schemaText) as Schema;
const defs = schema.$defs as Record<string, Schema>;
const props = (s: Schema): Record<string, Schema> => (s.properties ?? {}) as Record<string, Schema>;
const json = (p: unknown): unknown => JSON.parse(JSON.stringify(p));
const problems = (value: unknown): string[] => validate(schema, json(value));

// ---------------------------------------------------------------------------------------------
// A project that uses everything, built with createProject and the editor's operations
// ---------------------------------------------------------------------------------------------

const media = (id: string, kind: MediaItem['kind'], extra: Partial<MediaItem> = {}): MediaItem => ({
  id,
  name: `${id}.${kind === 'video' ? 'webm' : kind === 'audio' ? 'wav' : 'png'}`,
  kind,
  mime: kind === 'video' ? 'video/webm' : kind === 'audio' ? 'audio/wav' : 'image/png',
  bytes: 4096,
  duration: kind === 'image' ? 0 : 20,
  width: kind === 'audio' ? 0 : 1280,
  height: kind === 'audio' ? 0 : 720,
  hasAudio: kind !== 'image',
  createdAt: 1_700_000_000_000,
  description: `Sample description for ${id}`,
  ...extra,
});

const CURSOR = {
  samples: Array.from({ length: 20 }, (_, i) => ({ t: i * 0.25, x: 0.2 + i * 0.02, y: 0.3 })),
  clicks: [
    { t: 1, button: 'left' as const, down: true },
    { t: 1.1, button: 'left' as const, down: false },
    { t: 2, button: 'right' as const, down: true },
  ],
  keys: [{ t: 3, key: 'Enter', down: true }],
};

function fullProject(): { p: Project; clipIds: string[] } {
  let p = createProject('Every field', 1280, 720, 24);
  p = updateProject(p, { background: '#1A2b3C' });
  p = addMedia(p, media('m_vid', 'video', { thumb: 'data:image/jpeg;base64,/9j/4AAQ', cursor: CURSOR }));
  p = addMedia(p, media('m_aud', 'audio'));
  p = addMedia(p, media('m_img', 'image'));
  const [t0, t1, t2] = p.tracks.map((t) => t.id);

  const placed = (mediaId: string, start: number, track: string): string => {
    const r = addClip(p, mediaId, start, track);
    p = r.project;
    return r.clipId as string;
  };
  const a = placed('m_vid', 0, t0);
  const b = placed('m_vid', 2, t1);
  const voice = placed('m_aud', 0, t2);
  const still = placed('m_img', 25, t0);

  // b carries as many optional fields as a clip can: everything but the flags that exclude each other.
  p = setClipSpeed(p, b, 2);
  p = setClipCrop(p, b, { x: 0.1, y: 0.1, width: 0.5, height: 0.6 });
  p = addClipKey(p, b, 'x', 1, 300, 'out');
  p = addClipKey(p, b, 'x', 3, 900, 'bounce');
  p = addClipKey(p, b, 'opacity', 0, 0.2, 'linear');
  p = addClipKey(p, b, 'volume', 2, 0.5, 'hold');
  p = setClipBehavior(p, b, 'enter', { type: 'pop', duration: 0.5 });
  p = setClipBehavior(p, b, 'emphasis', { type: 'wobble', duration: 1 });
  p = setClipBehavior(p, b, 'exit', { type: 'slide-down', duration: 0.4 });
  p = setClipTransition(p, b, 'in', { type: 'wipe-left', duration: 0.5 });
  p = setClipTransition(p, b, 'out', { type: 'zoom', duration: 0.3 });
  p = updateClipEffects(p, [b], () => ({
    colour: { on: true, brightness: 10, contrast: -5, saturation: 20, hue: 45, tint: '#D9A441', tintAmount: 30 },
    chroma: { on: false, key: '#00ff00', tolerance: 40, softness: 12, spill: 60 },
    shadow: { on: true, blur: 40, dx: 0, dy: 16, colour: '#000000', opacity: 50 },
    border: { on: true, width: 6, colour: '#ffffff' },
    radius: 24,
    mask: 'ellipse',
    blend: 'screen',
    frame: { on: true, kind: 'laptop', tone: 'light' },
  }));
  p = updateClipAudio(p, b, {
    fadeIn: 1,
    fadeOut: 2,
    fadeCurve: 'smooth',
    duck: { thresholdDb: -40, reductionDb: 12, attack: 0.05, release: 0.5, hold: 0.2 },
    silent: true,
  });
  p = groupClips(p, [a, b]).project; // groupId
  const frozen = freezeFrame(p, a, 3, 1); // a clip with freeze
  p = frozen.project;
  const detached = detachAudio(p, a); // linkId, audioOnly, muteAudio
  p = detached.project;

  // Tracks, overlays, and the project-level settings
  p = addTrack(p);
  p = setTrackMagnetic(p, p.tracks[p.tracks.length - 1].id, true);
  for (const [i, kind] of ANNOTATION_KINDS.entries()) {
    p = addAnnotation(p, kind, i, {
      ...(kind === 'arrow' ? { sketch: 1.5 } : {}),
      ...(kind === 'text'
        ? {
            text: 'Hello',
            keys: { x: [{ t: 0, v: 300, ease: 'inOut' as const }, { t: 2, v: 600, ease: 'linear' as const }] },
            behavior: { enter: { type: 'fade', duration: 0.4 } },
          }
        : {}),
    }).project;
  }
  p = addZoom(p, 5, { easeIn: 0.3, easeOut: 0.6, ease: 'back' }).project;
  p = addMarker(p, 4, 'Chapter one', true).project;
  p = addMarker(p, 9, 'Plain marker', false).project;
  p = addCaptionAt(p, 1, 'First caption', 2).project;
  p = addCaptionAt(p, 5, 'Second caption', 2).project;
  p = addRedaction(p, 2, { mode: 'pixelate', strength: 40 }).project;
  p = setRange(p, { start: 1, end: 9 });
  p = setCursorFx(p, {
    showCursor: true,
    shape: 'hand',
    size: 2,
    highlight: true,
    clickRings: true,
    keys: true,
    image: 'data:image/png;base64,iVBORw0KGgo=',
    imageHotX: 0.5,
    imageHotY: 0.25,
  });
  return { p, clipIds: [a, b, voice, still, frozen.clipId as string, detached.audioClipId as string] };
}

// ---------------------------------------------------------------------------------------------
// The schema document
// ---------------------------------------------------------------------------------------------

describe('the schema document', () => {
  test('is draft 2020-12 JSON without a byte order mark, with an id, a title and a version constant', () => {
    expect(schemaText.charCodeAt(0)).not.toBe(0xfeff);
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('https://github.com/fleethacker-data-crucible/Capstan/docs/project.schema.json');
    expect(typeof schema.title).toBe('string');
    expect(props(schema).version).toMatchObject({ const: createProject().version });
  });

  test('every $ref points at a definition that exists', () => {
    const refs = [...schemaText.matchAll(/"\$ref":\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(20);
    for (const ref of refs) expect(defs[ref.replace('#/$defs/', '')]).toBeDefined();
  });

  test('every object says what parseProject does with fields it does not list', () => {
    const objects: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      const s = node as Schema;
      if (s.type === 'object') objects.push(path);
      if (s.type === 'object') expect(['kept', 'dropped']).toContain(s['x-extra-fields'] as string);
      for (const [k, v] of Object.entries(s)) if (k !== 'enum' && k !== 'const') walk(v, `${path}/${k}`);
    };
    walk(schema, '');
    expect(objects.length).toBeGreaterThan(30);
  });

  test('its lists and limits are the ones in the code', () => {
    const values = (s: Schema) => s.enum as string[];
    expect(values(defs.easeName)).toEqual(EASE_NAMES);
    expect(values(props(defs.enterStep).type)).toEqual([...ENTER_TYPES]);
    expect(values(props(defs.enterStep).type)).toEqual([...EXIT_TYPES]);
    expect(values(props(defs.emphasisStep).type)).toEqual([...EMPHASIS_TYPES]);
    expect(values(props(defs.transition).type)).toEqual([...TRANSITION_TYPES]);
    expect(values(props(defs.effects).blend)).toEqual(BLEND_MODES.map((b) => b.id).filter((id) => id !== 'normal'));
    expect(values(props(defs.frameFx).kind)).toEqual(FRAME_KINDS.map((f) => f.kind));
    expect(values(props(defs.annotation).kind)).toEqual(ANNOTATION_KINDS);
    expect(values(props(defs.annotationStyle).font)).toEqual(FONT_KEYS);
    expect(values(props(defs.cursorFx).shape)).toEqual(CURSOR_SHAPES);

    expect(props(schema).annotations.maxItems).toBe(MAX_ANNOTATIONS);
    expect(props(schema).zooms.maxItems).toBe(MAX_ZOOMS);
    expect(props(schema).markers.maxItems).toBe(MAX_MARKERS);
    expect(props(defs.marker).name.maxLength).toBe(MAX_MARKER_NAME);
    expect(props(defs.caption).text.maxLength).toBe(MAX_CAPTION_CHARS);
    expect(props(defs.annotation).text.maxLength).toBe(MAX_ANNOTATION_TEXT);
    expect(props(defs.annotation).duration.maximum).toBe(MAX_ANNOTATION_SECONDS);
    expect(props(defs.annotation).sketch.maximum).toBe(MAX_SKETCH_SECONDS);
    expect(props(defs.annotation).duration.minimum).toBe(MIN_CLIP_SECONDS);
    expect(props(defs.clip).duration.minimum).toBe(MIN_CLIP_SECONDS);
    expect(props(defs.clip).speed).toMatchObject({ minimum: MIN_SPEED, maximum: MAX_SPEED });
    expect(props(defs.redaction).width.minimum).toBe(MIN_REDACTION_PX);
    expect(props(defs.redaction).duration.minimum).toBe(MIN_CLIP_SECONDS);
    expect(props(defs.zoom).duration.minimum).toBe(MIN_CLIP_SECONDS);
    expect(props(defs.clipAudio).fadeIn.maximum).toBe(MAX_FADE_SECONDS);
    expect(props(defs.enterStep).duration).toMatchObject({ minimum: MIN_STEP_SECONDS, maximum: MAX_STEP_SECONDS });
    expect(props(defs.transition).duration).toMatchObject({ minimum: MIN_TRANSITION_SECONDS, maximum: MAX_TRANSITION_SECONDS });
    expect(MIN_RANGE_SECONDS).toBeCloseTo(1 / 60, 12);
    const cursor = props(defs.cursorData);
    expect(cursor.samples.maxItems).toBe(CURSOR_LIMITS.samples);
    expect(cursor.clicks.maxItems).toBe(CURSOR_LIMITS.clicks);
    expect(cursor.keys.maxItems).toBe(CURSOR_LIMITS.keys);
    expect(props(defs.cursorFx).image.maxLength).toBe(CURSOR_LIMITS.imageChars);
    expect(((cursor.samples.items as Schema).properties as Record<string, Schema>).t.maximum).toBe(CURSOR_LIMITS.seconds);
  });
});

// ---------------------------------------------------------------------------------------------
// (a) Projects the editor makes validate
// ---------------------------------------------------------------------------------------------

describe('projects built with the editor operations', () => {
  test('a new project validates', () => {
    expect(problems(createProject())).toEqual([]);
  });

  test('a project that uses every kind of item and every optional clip field validates', () => {
    const { p } = fullProject();
    expect(problems(p)).toEqual([]);

    // The test project really does use everything it claims to.
    const clipFields = new Set(p.clips.flatMap((c) => Object.keys(c).filter((k) => (c as unknown as Record<string, unknown>)[k] !== undefined)));
    for (const name of Object.keys(props(defs.clip))) expect(clipFields.has(name)).toBe(true);
    expect(p.annotations.map((a) => a.kind).sort()).toEqual([...ANNOTATION_KINDS].sort());
    expect(p.tracks.some((t) => t.magnetic)).toBe(true);
    for (const list of [p.zooms, p.markers, p.captions, p.redactions]) expect(list.length).toBeGreaterThan(0);
    expect(p.range).toBeDefined();
    expect(p.cursorFx?.image).toBeDefined();
    expect(p.media.find((m) => m.id === 'm_vid')?.cursor?.samples.length).toBe(20);
    expect(Object.keys(p.clips.find((c) => c.effects)?.effects ?? {}).sort()).toEqual(Object.keys(props(defs.effects)).sort());
    expect(Object.keys(p.clips.find((c) => c.audio)?.audio ?? {}).sort()).toEqual(Object.keys(props(defs.clipAudio)).sort());
    expect(Object.keys(p.clips.find((c) => c.behavior)?.behavior ?? {}).sort()).toEqual(['emphasis', 'enter', 'exit']);
    expect(Object.keys(p.clips.find((c) => c.keys)?.keys ?? {}).sort()).toEqual(['opacity', 'volume', 'x']);
  });

  test('a project is not changed by loading it (the schema describes the loaded form)', () => {
    const { p } = fullProject();
    const saved = json(p) as Project;
    expect(json(parseProject(saved))).toEqual(saved);
  });

  test('the sample project the command tests use validates', () => {
    expect(problems(sample().p)).toEqual([]);
  });

  test('a project file as the editor writes it (indented text) validates', () => {
    const { p } = fullProject();
    expect(validate(schema, JSON.parse(JSON.stringify(p, null, 2)))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// (b) What parseProject returns for messy input validates
// ---------------------------------------------------------------------------------------------

const vid = media('m1', 'video');
const base = { version: 1, tracks: [{ id: 't1', name: 'Track 1', muted: false, hidden: false, locked: false }], clips: [], media: [vid] };
const clipOf = (extra: Record<string, unknown>) => ({ id: 'c1', trackId: 't1', mediaId: 'm1', start: 0, in: 0, duration: 4, props: {}, ...extra });

const messy: Record<string, unknown> = {
  'the least a file needs': { version: 1, tracks: [], clips: [], media: [] },
  'a project from before redactions, captions, annotations, zooms and markers': {
    ...base,
    id: 'old',
    name: 'Old',
    width: 1280,
    height: 720,
    fps: 25,
    background: '#102030',
    clips: [clipOf({})],
  },
  'junk dimensions, rate and colour': { ...base, width: 99999, height: 3, fps: 1000, background: 'red', name: 'x'.repeat(500), updatedAt: 'later', id: 7 },
  'non-numeric dimensions': { ...base, width: 'wide', height: null, fps: '30' },
  'tracks with missing and junk fields': {
    ...base,
    tracks: [{ id: 5 }, { id: 't1', name: 'n'.repeat(300), muted: 1, hidden: 'yes', locked: 0, magnetic: 'x', extra: true }],
  },
  'junk in every optional clip field': {
    ...base,
    clips: [
      clipOf({
        speed: 'fast',
        freeze: 'yes',
        crop: { x: 5, width: -2 },
        keys: { x: [{ t: 'a', v: 1 }, null, { t: 1, v: 2, ease: 'wobbly' }, { t: -4, v: 5, ease: 'out' }], volume: 'loud', nope: [] },
        behavior: { enter: { type: 'explode' }, emphasis: { type: 'pulse', duration: 'long' } },
        effects: {
          colour: { brightness: 9999, tint: 'blue' },
          chroma: 'on',
          shadow: { blur: -3, dx: 1e9 },
          border: { width: 'thick' },
          radius: -4,
          mask: 'star',
          blend: 'normal',
          frame: { kind: 'toaster' },
        },
        audio: { fadeIn: -3, fadeOut: 9999, fadeCurve: 'wavy', duck: { thresholdDb: 'a' }, silent: 'yes' },
        transitionIn: { type: 'fade', duration: 'x' },
        transitionOut: { type: 'teleport' },
        linkId: 5,
        groupId: 'g'.repeat(500),
        audioOnly: 1,
        muteAudio: 'true',
        extra: 'dropped',
      }),
    ],
  },
  'valid optional clip fields at their limits': {
    ...base,
    clips: [
      clipOf({
        speed: 20,
        freeze: true,
        crop: { x: 0, y: 0, width: 0.001, height: 0.5 },
        audio: { fadeIn: 0, fadeOut: 0, fadeCurve: 'linear', duck: { thresholdDb: 5, reductionDb: 99, attack: 0, release: 99 } },
        transitionIn: { type: 'pop', duration: 99 },
        behavior: { exit: { type: 'spin', duration: 0 } },
        audioOnly: true,
        muteAudio: true,
        linkId: 'l1',
        groupId: 'g1',
      }),
    ],
  },
  'clips with no track, no media, or nothing else': {
    ...base,
    clips: [clipOf({ trackId: 'gone' }), clipOf({ id: 'c2', mediaId: 'gone' }), clipOf({ id: 'c3', start: 'soon', in: -3, duration: 'long', props: undefined })],
  },
  'redactions': { ...base, width: 640, height: 360, redactions: [{}, null, 'x', { x: 'a', width: 1e9, height: 2, mode: 'sparkle', strength: 5000, start: -1, duration: 0 }] },
  'captions': {
    ...base,
    captions: [{ text: 5 }, { text: 'backwards', start: 4, end: 1 }, { text: 'long '.repeat(300), start: 2, end: 3, id: 9 }, { id: 'late', text: 'b', start: 8, end: 9 }, { id: 'early', text: 'a', start: 1, end: 2 }],
  },
  'annotations': {
    ...base,
    annotations: [
      null,
      { kind: 'sparkle' },
      { kind: 'text', id: 'a', x: 'far', width: -5, height: 1e9, style: { fill: 'blue', font: 'comic', size: 'big', align: 'middle' }, text: 'ok' },
      { kind: 'text', id: 'a', start: -4, duration: 1e9, rotation: 1e6, opacity: 7 },
      { kind: 'callout', text: 'c'.repeat(5000), tail: { x: 99, y: 'x' } },
      { kind: 'arrow', line: { x1: -5, y2: 'a' }, sketch: 500, keys: { opacity: [{ t: 0, v: 1, ease: 'in' }] }, behavior: { exit: { type: 'fade', duration: 1 } } },
      { kind: 'rect', shape: 'blob', sketch: 2 },
      { kind: 'spotlight', shape: 'ellipse', style: { fill: '', stroke: '#ABCDEF', dim: 5, feather: -1 } },
    ],
  },
  'zooms': {
    ...base,
    zooms: [{ start: 1 }, null, { start: 1, duration: 2, width: 10, height: 10 }, { id: 'z', start: 'x', duration: 2, width: 5, height: 5 }, { id: 'z2', start: 5, duration: 0, x: 1e9, y: -4, width: 1e9, height: 1e9, easeIn: 99, easeOut: -1, ease: 'wiggle' }],
  },
  'markers': {
    ...base,
    markers: [{ time: -1 }, { time: 'x' }, null, { time: 2, id: 'm' }, { time: 3, id: 'm', name: '\n\n' }, { time: 1, id: 'q'.repeat(200), name: 'n'.repeat(500), chapter: 'yes' }],
  },
  'cursor effects and the marks': { ...base, cursorFx: { shape: 'laser', size: 99, color: 'red', image: 'http://example.test/a.png', smoothing: 'lots', keysHold: -1 }, range: { start: -3, end: 10 } },
  'a range of no length': { ...base, range: { start: 5, end: 5 }, cursorFx: [] },
  'cursor data with bad entries': {
    ...base,
    media: [
      {
        ...vid,
        cursor: {
          samples: [[0, 0.5, 0.5], [1, 2, -1], 'x', { t: 0.5, x: 0.1, y: 0.2 }],
          clicks: [{ t: 1, button: 'wheel' }, { t: 2 }, { t: 3, button: 'middle', down: false }],
          keys: [{ t: 1, key: '' }, { t: 2, key: 'A' }],
        },
      },
    ],
  },
  'cursor data that is not usable': { ...base, media: [{ ...vid, cursor: { samples: 'many' } }, media('m2', 'audio', { cursor: { samples: [], clicks: [], keys: [] } } as never)] },
  'media with a number for a name': { ...base, media: [{ ...vid, id: 12, name: 3.5 }], clips: [] },
  'the project with every field, loaded again': fullProject().p,
};

describe('what parseProject returns for messy files', () => {
  for (const [name, input] of Object.entries(messy)) {
    test(name, () => {
      const loaded = parseProject(json(input));
      expect(problems(loaded)).toEqual([]);
    });
  }

  test('junk in optional clip fields is dropped, not kept', () => {
    const loaded = parseProject(json(messy['junk in every optional clip field']));
    const clip = loaded.clips[0];
    for (const field of ['speed', 'freeze', 'transitionOut', 'linkId', 'audioOnly', 'muteAudio', 'extra']) {
      expect(field in clip).toBe(false);
    }
    expect(clip.transitionIn).toEqual({ type: 'fade', duration: 0.5 }); // a known type with a bad length keeps the default length
    expect(clip.crop).toEqual({ x: 0.98, y: 0, width: 0.02, height: 1 }); // a crop is pulled inside the frame, not dropped
    expect(clip.groupId?.length).toBe(80);
    expect(clip.keys?.x?.map((k) => k.ease)).toEqual(['out', 'linear']);
  });
});

// ---------------------------------------------------------------------------------------------
// (c) Broken projects do not validate
// ---------------------------------------------------------------------------------------------

describe('projects the schema refuses', () => {
  const good = (): Record<string, any> => json(fullProject().p) as Record<string, any>;
  const withChange = (change: (p: Record<string, any>) => void): string[] => {
    const p = good();
    change(p);
    return validate(schema, p);
  };

  test('the starting point is valid', () => {
    expect(validate(schema, good())).toEqual([]);
  });

  test('a wrong version', () => {
    expect(withChange((p) => (p.version = 2)).join('\n')).toContain('/version');
    expect(withChange((p) => (p.version = '1')).length).toBeGreaterThan(0);
    expect(withChange((p) => delete p.version).join('\n')).toContain('missing required "version"');
  });

  test('a clip with a string duration', () => {
    const errors = withChange((p) => (p.clips[0].duration = '5'));
    expect(errors.join('\n')).toContain('/clips/0/duration: expected number, got string');
  });

  test('a negative width (and the other canvas limits)', () => {
    expect(withChange((p) => (p.width = -1280)).join('\n')).toContain('/width');
    expect(withChange((p) => (p.width = 7681)).length).toBeGreaterThan(0);
    expect(withChange((p) => (p.width = 1280.5)).length).toBeGreaterThan(0);
    expect(withChange((p) => (p.height = 15)).length).toBeGreaterThan(0);
    expect(withChange((p) => (p.height = 4321)).length).toBeGreaterThan(0);
    expect(withChange((p) => (p.fps = 0)).length).toBeGreaterThan(0);
    expect(withChange((p) => (p.fps = 61)).length).toBeGreaterThan(0);
    expect(withChange((p) => (p.fps = 29.97)).length).toBeGreaterThan(0);
  });

  test('missing lists and wrong shapes', () => {
    for (const list of ['tracks', 'clips', 'media', 'redactions', 'captions', 'annotations', 'zooms', 'markers']) {
      expect(withChange((p) => delete p[list]).join('\n')).toContain(`missing required "${list}"`);
      expect(withChange((p) => (p[list] = {})).length).toBeGreaterThan(0);
    }
    expect(validate(schema, [])).not.toEqual([]);
    expect(validate(schema, null)).not.toEqual([]);
    expect(validate(schema, 'a project')).not.toEqual([]);
  });

  test('values outside their ranges or lists', () => {
    const cases: Array<[string, (p: Record<string, any>) => void]> = [
      ['background that is not #rrggbb', (p) => (p.background = 'red')],
      ['a name over 120 characters', (p) => (p.name = 'n'.repeat(121))],
      ['a track flag that is not a boolean', (p) => (p.tracks[0].muted = 'yes')],
      ['a track named with a number', (p) => (p.tracks[0].name = 3)],
      ['magnetic: false', (p) => (p.tracks[0].magnetic = false)],
      ['a media kind that does not exist', (p) => (p.media[0].kind = 'film')],
      ['a negative clip start', (p) => (p.clips[0].start = -1)],
      ['a clip shorter than a frame', (p) => (p.clips[0].duration = 0.001)],
      ['a speed of exactly 1 (not stored)', (p) => (p.clips.find((c: any) => c.speed).speed = 1)],
      ['a speed above 8', (p) => (p.clips.find((c: any) => c.speed).speed = 9)],
      ['freeze: false (not stored)', (p) => (p.clips.find((c: any) => c.freeze).freeze = false)],
      ['a clip without props', (p) => delete p.clips[0].props],
      ['a prop that is text', (p) => (p.clips[0].props.opacity = 'half')],
      ['a crop outside the frame', (p) => (p.clips.find((c: any) => c.crop).crop.x = 2)],
      ['a keyframe without an ease', (p) => delete p.clips.find((c: any) => c.keys).keys.x[0].ease],
      ['an empty keyframe track', (p) => (p.clips.find((c: any) => c.keys).keys.x = [])],
      ['a blend mode of normal (not stored)', (p) => (p.clips.find((c: any) => c.effects).effects.blend = 'normal')],
      ['an empty effects object', (p) => (p.clips.find((c: any) => c.effects).effects = {})],
      ['a tint that is not a colour', (p) => (p.clips.find((c: any) => c.effects).effects.colour.tint = 'gold')],
      ['an unknown transition', (p) => (p.clips.find((c: any) => c.transitionIn).transitionIn.type = 'teleport')],
      ['a transition longer than 10 s', (p) => (p.clips.find((c: any) => c.transitionIn).transitionIn.duration = 11)],
      ['a fade of 0 (not stored)', (p) => (p.clips.find((c: any) => c.audio).audio.fadeIn = 0)],
      ['a linear fade curve (not stored)', (p) => (p.clips.find((c: any) => c.audio).audio.fadeCurve = 'linear')],
      ['a duck without a threshold', (p) => delete p.clips.find((c: any) => c.audio).audio.duck.thresholdDb],
      ['an annotation of an unknown kind', (p) => (p.annotations[0].kind = 'blob')],
      ['an annotation text over 1000 characters', (p) => (p.annotations.find((a: any) => a.kind === 'text').text = 'x'.repeat(1001))],
      ['an annotation without a style', (p) => delete p.annotations[0].style],
      ['an annotation style colour that is not a colour', (p) => (p.annotations[0].style.color = 'white')],
      ['an annotation font that is not bundled', (p) => (p.annotations[0].style.font = 'comic')],
      ['an annotation line point beyond the box', (p) => (p.annotations[0].line.x1 = 2)],
      ['too many annotations', (p) => (p.annotations = Array.from({ length: 501 }, () => p.annotations[0]))],
      ['a zoom with an unknown ease', (p) => (p.zooms[0].ease = 'wiggle')],
      ['a marker without a time', (p) => delete p.markers[0].time],
      ['a marker time below 0', (p) => (p.markers[0].time = -1)],
      ['a marker name over 80 characters', (p) => (p.markers[0].name = 'm'.repeat(81))],
      ['a caption text over 500 characters', (p) => (p.captions[0].text = 'c'.repeat(501))],
      ['a redaction mode that does not exist', (p) => (p.redactions[0].mode = 'smudge')],
      ['a redaction strength of 0', (p) => (p.redactions[0].strength = 0)],
      ['a fractional redaction size', (p) => (p.redactions[0].width = 100.5)],
      ['a cursor shape that does not exist', (p) => (p.cursorFx.shape = 'laser')],
      ['a cursor size out of range', (p) => (p.cursorFx.size = 99)],
      ['a cursor image that is not a data URL', (p) => (p.cursorFx.image = 'http://example.test/c.png')],
      ['a cursor sample outside the frame', (p) => (p.media[0].cursor.samples[0].x = 3)],
      ['a cursor click with an unknown button', (p) => (p.media[0].cursor.clicks[0].button = 'wheel')],
      ['a cursor key name longer than 24 characters', (p) => (p.media[0].cursor.keys[0].key = 'k'.repeat(25))],
      ['a range without an end', (p) => delete p.range.end],
    ];
    for (const [name, change] of cases) {
      const errors = withChange(change);
      if (errors.length === 0) throw new Error(`The schema accepted: ${name}`);
    }
  });

  test('fields the schema does not list never make a file invalid', () => {
    expect(
      withChange((p) => {
        p.somethingNew = { a: 1 };
        p.clips[0].extra = true;
        p.media[0].future = 'kept';
        p.annotations[0].future = 1;
      }),
    ).toEqual([]);
  });

  test('every refusal names where it happened', () => {
    const errors = withChange((p) => {
      p.clips[0].duration = 'x';
      p.annotations[0].style.size = 1;
    });
    expect(errors.some((e) => e.startsWith('/clips/0/duration:'))).toBe(true);
    expect(errors.some((e) => e.startsWith('/annotations/0/style/size:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// (d) The schema and parseProject name the same fields
// ---------------------------------------------------------------------------------------------

describe('the schema lists what parseProject keeps', () => {
  const source = readFileSync(join(root, 'src', 'engine', 'project.ts'), 'utf8');
  const loader = source.slice(source.indexOf('export function parseProject'));

  test('every property the schema lists for a clip is read by the clip builder or parseClipExtras', () => {
    const names = Object.keys(props(defs.clip));
    expect(names.length).toBe(20);
    for (const name of names) expect(new RegExp(`\\bc\\.${name}\\b`).test(loader)).toBe(true);
  });

  test('every property of the clip is one the schema lists, and every listed one survives loading', () => {
    const allFields = {
      id: 'c1',
      trackId: 't1',
      mediaId: 'm1',
      start: 1,
      in: 2,
      duration: 3,
      props: { x: 1, y: 2, scale: 1, rotation: 0, opacity: 1, volume: 1 },
      speed: 2,
      freeze: true,
      crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      keys: { x: [{ t: 0, v: 1, ease: 'linear' }] },
      behavior: { enter: { type: 'fade', duration: 0.5 } },
      effects: { radius: 4 },
      audio: { fadeIn: 1 },
      transitionIn: { type: 'fade', duration: 0.5 },
      transitionOut: { type: 'fade', duration: 0.5 },
      linkId: 'l1',
      groupId: 'g1',
      audioOnly: true,
      muteAudio: true,
      notAClipField: 'dropped',
    };
    const loaded = parseProject({ ...base, clips: [allFields] }).clips[0] as unknown as Record<string, unknown>;
    const listed = Object.keys(props(defs.clip)).sort();
    expect(Object.keys(loaded).sort()).toEqual(listed);
    expect(validate(schema, json(parseProject({ ...base, clips: [allFields] })))).toEqual([]);
  });

  test('the same holds for the project, tracks, media, annotations, zooms, markers, captions, redactions, range and cursor settings', () => {
    const { p } = fullProject();
    const loaded = json(parseProject(json(p))) as Record<string, any>;
    const same = (value: Record<string, unknown>, def: Schema, what: string) => {
      expect([what, Object.keys(value).sort()]).toEqual([what, Object.keys(props(def)).sort()]);
    };
    same(loaded, schema, 'project');
    same(loaded.tracks.find((t: any) => t.magnetic), defs.track, 'track');
    same(loaded.media.find((m: any) => m.cursor && m.thumb), defs.media, 'media');
    same(loaded.media[0].cursor, defs.cursorData, 'cursor data');
    same(loaded.annotations.find((a: any) => a.keys && a.behavior), defs.annotation, 'annotation');
    same(loaded.annotations[0].style, defs.annotationStyle, 'annotation style');
    same(loaded.zooms[0], defs.zoom, 'zoom');
    same(loaded.markers[0], defs.marker, 'marker');
    same(loaded.captions[0], defs.caption, 'caption');
    same(loaded.redactions[0], defs.redaction, 'redaction');
    same(loaded.range, defs.range, 'range');
    same(loaded.cursorFx, defs.cursorFx, 'cursor settings');
  });

  test('media and clip props keep fields the schema does not list; the rest drop them', () => {
    const loaded = parseProject({
      ...base,
      media: [{ ...vid, future: 'kept' }],
      clips: [clipOf({ props: { future: 'kept' } })],
      annotations: [{ kind: 'text', id: 'a', future: 'dropped' }],
      markers: [{ time: 1, future: 'dropped' }],
      future: 'dropped',
    }) as unknown as Record<string, any>;
    expect(loaded.media[0].future).toBe('kept');
    expect(loaded.clips[0].props.future).toBe('kept');
    expect(loaded.annotations[0].future).toBeUndefined();
    expect(loaded.markers[0].future).toBeUndefined();
    expect(loaded.future).toBeUndefined();
    expect(defs.media['x-extra-fields']).toBe('kept');
    expect(defs.clipProps['x-extra-fields']).toBe('kept');
    expect(schema['x-extra-fields']).toBe('dropped');
    for (const name of ['track', 'clip', 'annotation', 'zoom', 'marker', 'caption', 'redaction', 'range', 'cursorFx', 'cursorData']) {
      expect(defs[name]['x-extra-fields']).toBe('dropped');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The small validator the tests rely on
// ---------------------------------------------------------------------------------------------

describe('the test validator', () => {
  const ok = (s: Schema, v: unknown) => expect(validate(s, v)).toEqual([]);
  const bad = (s: Schema, v: unknown) => expect(validate(s, v).length).toBeGreaterThan(0);

  test('types, enum and const', () => {
    ok({ type: 'integer' }, 3);
    bad({ type: 'integer' }, 3.5);
    bad({ type: 'number' }, '3');
    bad({ type: 'number' }, null);
    ok({ type: ['string', 'null'] }, null);
    bad({ type: 'object' }, []);
    bad({ type: 'array' }, {});
    ok({ enum: ['a', 2, { b: [1] }] }, { b: [1] });
    bad({ enum: ['a', 'b'] }, 'c');
    ok({ const: true }, true);
    bad({ const: true }, 1);
  });

  test('numbers, strings and arrays', () => {
    ok({ minimum: 1, maximum: 2 }, 2);
    bad({ minimum: 1 }, 0.5);
    bad({ maximum: 1 }, 2);
    bad({ exclusiveMinimum: 0 }, 0);
    ok({ exclusiveMinimum: 0 }, 0.1);
    bad({ exclusiveMaximum: 1 }, 1);
    ok({ minLength: 1, maxLength: 3, pattern: '^a' }, 'abc');
    bad({ minLength: 1 }, '');
    bad({ maxLength: 2 }, 'abc');
    bad({ pattern: '^a' }, 'ba');
    ok({ items: { type: 'number' }, minItems: 1, maxItems: 2 }, [1, 2]);
    bad({ items: { type: 'number' } }, [1, 'x']);
    bad({ minItems: 1 }, []);
    bad({ maxItems: 1 }, [1, 2]);
  });

  test('objects: properties, required, additionalProperties, minProperties', () => {
    const s = { type: 'object', required: ['a'], properties: { a: { type: 'number' } } };
    ok(s, { a: 1, extra: 'allowed' });
    bad(s, {});
    bad(s, { a: 'x' });
    bad({ ...s, additionalProperties: false }, { a: 1, extra: 1 });
    ok({ ...s, additionalProperties: { type: 'string' } }, { a: 1, extra: 'x' });
    bad({ ...s, additionalProperties: { type: 'string' } }, { a: 1, extra: 2 });
    bad({ minProperties: 1 }, {});
  });

  test('oneOf, anyOf, allOf, not and $ref', () => {
    ok({ anyOf: [{ type: 'string' }, { type: 'number' }] }, 1);
    bad({ anyOf: [{ type: 'string' }, { type: 'number' }] }, true);
    ok({ oneOf: [{ type: 'number' }, { type: 'string' }] }, 'x');
    bad({ oneOf: [{ type: 'number' }, { minimum: 0 }] }, 3);
    ok({ allOf: [{ minimum: 1 }, { maximum: 3 }] }, 2);
    bad({ allOf: [{ minimum: 1 }, { maximum: 3 }] }, 4);
    bad({ not: { const: 1 } }, 1);
    const s = { $defs: { n: { type: 'number', minimum: 0 } }, type: 'array', items: { $ref: '#/$defs/n' } };
    ok(s, [0, 1]);
    bad(s, [-1]);
    expect(() => validate({ $ref: '#/$defs/missing' }, 1)).toThrow();
    expect(() => validate({ $ref: 'https://example.test/other.json' }, 1)).toThrow();
  });

  test('a keyword it does not implement throws rather than being skipped', () => {
    expect(() => validate({ format: 'date' }, 'x')).toThrow(/Unsupported schema keyword "format"/);
    expect(() => validate({ patternProperties: {} }, {})).toThrow();
    expect(() => validate({ if: {} }, 1)).toThrow();
    expect(() => validate({ 'x-note': 'fine', description: 'fine' }, 1)).not.toThrow();
  });
});
