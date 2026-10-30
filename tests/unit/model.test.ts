import { describe, expect, test } from 'bun:test';
import { fittedSize, clipRect } from '../../src/engine/compositor';
import { addClip, addMedia, resizeCanvas, splitClip, trimEnd, trimStart } from '../../src/engine/ops';
import { setKey } from '../../src/engine/anim';
import {
  type MediaItem,
  type Project,
  clipSpeed,
  createProject,
  croppedSize,
  normaliseCrop,
  parseProject,
  sourceSpan,
  sourceTimeAt,
} from '../../src/engine/project';

function video(id = 'v', duration = 10): MediaItem {
  return { id, name: id, kind: 'video', mime: '', bytes: 0, duration, width: 1280, height: 720, hasAudio: true, createdAt: 0 };
}

function withClip(): { p: Project; clipId: string } {
  let p = createProject('t');
  p = addMedia(p, video());
  const r = addClip(p, 'v', 0, p.tracks[0].id);
  return { p: r.project, clipId: r.clipId! };
}

function patchClip(p: Project, clipId: string, patch: object): Project {
  return { ...p, clips: p.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) };
}

describe('speed and freeze', () => {
  test('source time follows the speed', () => {
    const c = { start: 2, in: 1, speed: 2, freeze: false };
    expect(sourceTimeAt(c, 2)).toBe(1);
    expect(sourceTimeAt(c, 4)).toBe(5);
    expect(sourceSpan({ duration: 3, speed: 2, freeze: false })).toBe(6);
  });

  test('a freeze frame stays on one source frame and uses no source', () => {
    const c = { start: 0, in: 4, speed: 3, freeze: true };
    expect(sourceTimeAt(c, 2.5)).toBe(4);
    expect(sourceSpan({ duration: 2, speed: 3, freeze: true })).toBe(0);
  });

  test('speed is clamped to a sane range', () => {
    expect(clipSpeed({ speed: 100 })).toBe(8);
    expect(clipSpeed({ speed: 0 })).toBe(0.1);
    expect(clipSpeed({})).toBe(1);
    expect(clipSpeed({ speed: Number.NaN })).toBe(1);
  });

  test('splitting a fast clip splits the source at the right place', () => {
    const { p, clipId } = withClip();
    const fast = patchClip(p, clipId, { speed: 2, duration: 5 });
    const { project, ids } = splitClip(fast, clipId, 2);
    const [left, right] = ids.map((id) => project.clips.find((c) => c.id === id)!);
    expect(left.duration).toBe(2);
    expect(right.in).toBe(4);
    expect(right.duration).toBe(3);
  });

  test('trimming the start of a fast clip moves the source offset by delta * speed', () => {
    const { p, clipId } = withClip();
    const fast = patchClip(patchClip(p, clipId, { speed: 2, duration: 5 }), clipId, { start: 1 });
    const t = trimStart(fast, clipId, 2);
    const c = t.clips[0];
    expect(c.start).toBe(2);
    expect(c.in).toBe(2);
    expect(c.duration).toBe(4);
  });

  test('a fast clip cannot be trimmed longer than the source allows', () => {
    const { p, clipId } = withClip();
    const fast = patchClip(p, clipId, { speed: 2, duration: 2 });
    const t = trimEnd(fast, clipId, 100);
    expect(t.clips[0].duration).toBe(5);
  });

  test('a freeze frame can be trimmed as long as you like', () => {
    const { p, clipId } = withClip();
    const frozen = patchClip(p, clipId, { freeze: true, duration: 1 });
    expect(trimEnd(frozen, clipId, 60).clips[0].duration).toBe(60);
  });
});

describe('keyframes travel with the clip', () => {
  test('splitting shifts the right half keyframes', () => {
    const { p, clipId } = withClip();
    const keys = setKey(undefined, 'opacity', { t: 6, v: 0.2, ease: 'linear' });
    const { project, ids } = splitClip(patchClip(p, clipId, { keys }), clipId, 4);
    const right = project.clips.find((c) => c.id === ids[1])!;
    expect(right.keys!.opacity![0].t).toBe(2);
  });

  test('trimming the start keeps a key at the same moment on the timeline', () => {
    const { p, clipId } = withClip();
    const keys = setKey(undefined, 'x', { t: 5, v: 100, ease: 'linear' });
    const t = trimStart(patchClip(p, clipId, { keys }), clipId, 2);
    expect(t.clips[0].keys!.x![0].t).toBe(3);
  });

  test('changing the canvas scales positional keys', () => {
    const { p, clipId } = withClip();
    const keys = setKey(setKey(undefined, 'x', { t: 0, v: 960, ease: 'linear' }), 'y', { t: 0, v: 540, ease: 'linear' });
    const r = resizeCanvas(patchClip(p, clipId, { keys }), 960, 540);
    expect(r.clips[0].keys!.x![0].v).toBe(480);
    expect(r.clips[0].keys!.y![0].v).toBe(270);
  });
});

describe('crop', () => {
  test('crop narrows the picture the clip fits to the canvas', () => {
    const half = croppedSize({ width: 1280, height: 720 }, { x: 0, y: 0, width: 0.5, height: 1 });
    expect(half).toEqual({ width: 640, height: 720 });
    const { p, clipId } = withClip();
    const cropped = patchClip(p, clipId, { crop: { x: 0.25, y: 0, width: 0.5, height: 1 } });
    const r = clipRect(cropped, cropped.clips[0]);
    const fit = fittedSize(half, cropped);
    expect(r.width).toBeCloseTo(fit.width, 6);
    expect(r.height).toBeCloseTo(fit.height, 6);
  });

  test('normaliseCrop keeps the frame inside the source and drops a full-frame crop', () => {
    expect(normaliseCrop({ x: 0.9, y: 0, width: 0.5, height: 1 })).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
    expect(normaliseCrop({ x: 0, y: 0, width: 1, height: 1 })).toBeUndefined();
    expect(normaliseCrop({ x: 0, y: 0, width: 0, height: 0 })!.width).toBe(0.02);
    expect(normaliseCrop('no')).toBeUndefined();
  });
});

describe('loading projects', () => {
  test('an older project gets empty annotation, zoom and marker lists', () => {
    const old = { ...createProject('old') } as Record<string, unknown>;
    delete old.annotations;
    delete old.zooms;
    delete old.markers;
    const p = parseProject(old);
    expect(p.annotations).toEqual([]);
    expect(p.zooms).toEqual([]);
    expect(p.markers).toEqual([]);
  });

  test('clip extras survive a round trip and junk is dropped', () => {
    const { p, clipId } = withClip();
    const keys = setKey(undefined, 'scale', { t: 1, v: 2, ease: 'out' });
    const full = patchClip(p, clipId, { speed: 2, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, keys, linkId: 'L', groupId: 'G', freeze: true });
    const back = parseProject(JSON.parse(JSON.stringify(full)));
    const c = back.clips[0];
    expect(c.speed).toBe(2);
    expect(c.crop).toEqual({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 });
    expect(c.keys!.scale![0].v).toBe(2);
    expect(c.linkId).toBe('L');
    expect(c.groupId).toBe('G');
    expect(c.freeze).toBe(true);

    const junk = JSON.parse(JSON.stringify(full));
    junk.clips[0].speed = 'fast';
    junk.clips[0].crop = 5;
    junk.clips[0].keys = { x: 'no' };
    const clean = parseProject(junk).clips[0];
    expect(clean.speed).toBeUndefined();
    expect(clean.crop).toBeUndefined();
    expect(clean.keys).toBeUndefined();
  });
});
