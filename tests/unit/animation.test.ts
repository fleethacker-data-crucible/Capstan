import { describe, expect, test } from 'bun:test';
import { addClipKey, clearClipKeys, keyedProps, moveClipKey, removeClipKey, setClipBehavior, setClipTransition, setKeyEase, updateClipPropsAt } from '../../src/engine/animate';
import { resolveProps, setKey } from '../../src/engine/anim';
import { applyBehavior, parseBehavior } from '../../src/engine/behaviors';
import { addClip, addMedia, resizeCanvas, updateClipProps } from '../../src/engine/ops';
import { type MediaItem, createProject, parseProject } from '../../src/engine/project';
import { effectiveTransitionSeconds, parseTransition, transitionMod } from '../../src/engine/transitions';
import { addZoom, cameraAt, cameraWindow, duplicateZoom, parseZooms, removeZoom, rescaleZooms, updateZoom, zoomRect } from '../../src/engine/zoom';

const canvas = { width: 1920, height: 1080 };
const base = { x: 960, y: 540, scale: 1, rotation: 0, opacity: 1, volume: 1 };

const media: MediaItem = { id: 'm1', name: 'a.webm', kind: 'video', mime: 'video/webm', bytes: 1, duration: 10, width: 1920, height: 1080, hasAudio: false, createdAt: 0 };

function withClip() {
  let p = addMedia(createProject('t', 1920, 1080), media);
  const r = addClip(p, 'm1', 2);
  p = r.project;
  return { p, id: r.clipId! };
}

describe('behaviors: entrance and exit', () => {
  const duration = 4;
  test('fade ramps opacity in over its duration and back out at the end', () => {
    const b = { enter: { type: 'fade', duration: 1 }, exit: { type: 'fade', duration: 1 } };
    expect(applyBehavior(base, b, 0, duration, canvas).opacity).toBe(0);
    const mid = applyBehavior(base, b, 0.5, duration, canvas).opacity;
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(1);
    expect(applyBehavior(base, b, 2, duration, canvas)).toEqual(base);
    expect(applyBehavior(base, b, 4, duration, canvas).opacity).toBe(0);
    // The exit mirrors the entrance.
    expect(applyBehavior(base, b, 4 - 0.5, duration, canvas).opacity).toBeCloseTo(mid, 9);
  });

  test('slide presets start a canvas away and land on the base position', () => {
    const left = applyBehavior(base, { enter: { type: 'slide-left', duration: 1 } }, 0, duration, canvas);
    expect(left.x).toBe(960 - 1920);
    expect(left.y).toBe(540);
    expect(applyBehavior(base, { enter: { type: 'slide-right', duration: 1 } }, 0, duration, canvas).x).toBe(960 + 1920);
    expect(applyBehavior(base, { enter: { type: 'slide-up', duration: 1 } }, 0, duration, canvas).y).toBe(540 - 1080);
    expect(applyBehavior(base, { enter: { type: 'slide-down', duration: 1 } }, 0, duration, canvas).y).toBe(540 + 1080);
    expect(applyBehavior(base, { enter: { type: 'slide-left', duration: 1 } }, 1, duration, canvas)).toEqual(base);
  });

  test('exit slide leaves in the same direction', () => {
    const out = applyBehavior(base, { exit: { type: 'slide-left', duration: 1 } }, 4, duration, canvas);
    expect(out.x).toBe(960 - 1920);
  });

  test('pop grows from nothing and spin turns', () => {
    const pop = applyBehavior(base, { enter: { type: 'pop', duration: 1 } }, 0, duration, canvas);
    expect(pop.scale).toBeCloseTo(0, 9);
    expect(pop.opacity).toBe(0);
    const spin = applyBehavior(base, { enter: { type: 'spin', duration: 1 } }, 0, duration, canvas);
    expect(spin.rotation).toBe(-360);
    expect(spin.scale).toBeLessThan(0.1);
    expect(applyBehavior(base, { enter: { type: 'spin', duration: 1 } }, 1, duration, canvas)).toEqual(base);
  });

  test('a step is capped at half the clip so the ends never overlap', () => {
    const b = { enter: { type: 'fade', duration: 5 }, exit: { type: 'fade', duration: 5 } };
    expect(applyBehavior(base, b, 0, 2, canvas).opacity).toBe(0);
    expect(applyBehavior(base, b, 1, 2, canvas).opacity).toBeCloseTo(1, 9);
  });

  test('properties the item lacks are left alone, volume is never touched', () => {
    const out = applyBehavior({ opacity: 1 }, { enter: { type: 'slide-left', duration: 1 } }, 0, duration, canvas);
    expect(out).toEqual({ opacity: 1 });
    expect(applyBehavior(base, { enter: { type: 'fade', duration: 1 } }, 0, duration, canvas).volume).toBe(1);
  });
});

describe('behaviors: emphasis', () => {
  test('pulse swells the scale and returns; it waits for the entrance to finish', () => {
    const b = { enter: { type: 'fade', duration: 1 }, emphasis: { type: 'pulse', duration: 1 } };
    expect(applyBehavior(base, b, 0.5, 6, canvas).scale).toBe(1);
    expect(applyBehavior(base, b, 1.5, 6, canvas).scale).toBeCloseTo(1.12, 6);
    expect(applyBehavior(base, b, 2, 6, canvas).scale).toBeCloseTo(1, 6);
  });

  test('wobble swings the rotation both ways', () => {
    const b = { emphasis: { type: 'wobble', duration: 1 } };
    expect(applyBehavior(base, b, 0.25, 6, canvas).rotation).toBeCloseTo(6, 6);
    expect(applyBehavior(base, b, 0.75, 6, canvas).rotation).toBeCloseTo(-6, 6);
  });

  test('behaviors sit on top of keyframes through resolveProps', () => {
    const keys = setKey(undefined, 'opacity', { t: 0, v: 0.5, ease: 'linear' });
    const p = resolveProps(base, { keys, behavior: { enter: { type: 'fade', duration: 1 } } }, 0, 4, canvas);
    expect(p.opacity).toBe(0);
    expect(resolveProps(base, { keys, behavior: { enter: { type: 'fade', duration: 1 } } }, 2, 4, canvas).opacity).toBe(0.5);
  });
});

describe('parseBehavior', () => {
  test('keeps known presets, clamps durations, drops the rest', () => {
    expect(parseBehavior({ enter: { type: 'pop', duration: 99 }, exit: { type: 'bogus', duration: 1 }, emphasis: { type: 'pulse' } })).toEqual({
      enter: { type: 'pop', duration: 10 },
      emphasis: { type: 'pulse', duration: 0.5 },
    });
    expect(parseBehavior({ enter: { type: 'wobble', duration: 1 } })).toBeUndefined();
    expect(parseBehavior(null)).toBeUndefined();
    expect(parseBehavior({})).toBeUndefined();
  });

  test('a project round trip keeps a clip behavior, transitions and keys', () => {
    let { p, id } = withClip();
    p = setClipBehavior(p, id, 'enter', { type: 'slide-up', duration: 0.7 });
    p = setClipTransition(p, id, 'in', { type: 'wipe-right', duration: 0.4 });
    p = addClipKey(p, id, 'scale', 3, 1.5);
    const back = parseProject(JSON.parse(JSON.stringify(p)));
    const c = back.clips[0];
    expect(c.behavior).toEqual({ enter: { type: 'slide-up', duration: 0.7 } });
    expect(c.transitionIn).toEqual({ type: 'wipe-right', duration: 0.4 });
    expect(c.keys?.scale?.[0].v).toBe(1.5);
  });
});

describe('transitionMod', () => {
  const clip = { start: 10, duration: 4, transitionIn: { type: 'fade', duration: 1 }, transitionOut: { type: 'fade', duration: 1 } };

  test('fade: dark at the first frame, clear after the transition, dark at the end', () => {
    expect(transitionMod(clip, 10, canvas)!.alpha).toBe(0);
    const mid = transitionMod(clip, 10.5, canvas)!.alpha;
    expect(mid).toBeCloseTo(0.5, 6);
    expect(transitionMod(clip, 11, canvas)).toBeNull();
    expect(transitionMod(clip, 12, canvas)).toBeNull();
    expect(transitionMod(clip, 13.5, canvas)!.alpha).toBeCloseTo(0.5, 6);
    expect(transitionMod(clip, 13.999, canvas)!.alpha).toBeLessThan(0.01);
  });

  test('nothing without a transition', () => {
    expect(transitionMod({ start: 0, duration: 2 }, 0.1, canvas)).toBeNull();
  });

  test('slide moves a canvas width at the start and settles', () => {
    const c = { start: 0, duration: 4, transitionIn: { type: 'slide-left', duration: 1 } };
    expect(transitionMod(c, 0, canvas)!.dx).toBe(-1920);
    expect(transitionMod(c, 0.5, canvas)!.dx).toBeCloseTo(-960, 6);
    expect(transitionMod(c, 1, canvas)).toBeNull();
    expect(transitionMod({ ...c, transitionIn: { type: 'slide-down', duration: 1 } }, 0, canvas)!.dy).toBe(1080);
  });

  test('wipe reveals from one edge and keeps going the same way when leaving', () => {
    const inn = { start: 0, duration: 4, transitionIn: { type: 'wipe-right', duration: 1 } };
    expect(transitionMod(inn, 0, canvas)!.wipe).toEqual({ x0: 0, y0: 0, x1: 0, y1: 1 });
    expect(transitionMod(inn, 0.5, canvas)!.wipe).toEqual({ x0: 0, y0: 0, x1: 0.5, y1: 1 });
    const out = { start: 0, duration: 4, transitionOut: { type: 'wipe-right', duration: 1 } };
    expect(transitionMod(out, 3.5, canvas)!.wipe).toEqual({ x0: 0.5, y0: 0, x1: 1, y1: 1 });
    expect(transitionMod({ start: 0, duration: 4, transitionIn: { type: 'wipe-down', duration: 1 } }, 0.5, canvas)!.wipe).toEqual({ x0: 0, y0: 0, x1: 1, y1: 0.5 });
  });

  test('zoom and pop scale the layer up', () => {
    const z = transitionMod({ start: 0, duration: 4, transitionIn: { type: 'zoom', duration: 1 } }, 0, canvas)!;
    expect(z.scale).toBe(0.5);
    expect(z.alpha).toBe(0);
    const p = transitionMod({ start: 0, duration: 4, transitionIn: { type: 'pop', duration: 1 } }, 0.5, canvas)!;
    expect(p.scale).toBeGreaterThan(0.5);
    expect(p.alpha).toBe(1);
  });

  test('the duration is clamped to half the clip', () => {
    const c = { start: 0, duration: 2, transitionIn: { type: 'fade', duration: 9 }, transitionOut: { type: 'fade', duration: 9 } };
    expect(effectiveTransitionSeconds(c.transitionIn, c.duration)).toBe(1);
    expect(transitionMod(c, 0.5, canvas)!.alpha).toBeCloseTo(0.5, 6);
    expect(transitionMod(c, 1, canvas)).toBeNull();
    expect(transitionMod(c, 1.5, canvas)!.alpha).toBeCloseTo(0.5, 6);
  });

  test('unknown types do nothing, parseTransition validates', () => {
    expect(transitionMod({ start: 0, duration: 4, transitionIn: { type: 'bogus', duration: 1 } }, 0, canvas)).toBeNull();
    expect(parseTransition({ type: 'fade', duration: 0 })).toEqual({ type: 'fade', duration: 0.05 });
    expect(parseTransition({ type: 'fade' })).toEqual({ type: 'fade', duration: 0.5 });
    expect(parseTransition({ type: 'melt', duration: 1 })).toBeUndefined();
    expect(parseTransition(5)).toBeUndefined();
  });
});

describe('cameraAt', () => {
  // A 2x zoom onto the top-left quadrant, 6 s from t=2, easing in and out over 1 s.
  const zoom = { id: 'z', start: 2, duration: 6, x: 0, y: 0, width: 960, height: 540, easeIn: 1, easeOut: 1, ease: 'linear' as const };
  const host = { ...canvas, zooms: [zoom] };

  test('the whole canvas before, at the first instant, and after', () => {
    expect(cameraAt(host, 1.9)).toBeNull();
    expect(cameraAt(host, 2)).toBeNull();
    expect(cameraAt(host, 8)).toBeNull();
    expect(cameraAt({ ...canvas, zooms: [] }, 3)).toBeNull();
  });

  test('eases in over easeIn seconds, holds on the rectangle, eases out', () => {
    const half = cameraAt(host, 2.5)!;
    expect(half.scale).toBeCloseTo(1.5, 6);
    expect(half.x).toBeCloseTo((960 + 480) / 2, 6); // halfway between the canvas centre and the region centre
    const hold = cameraAt(host, 5)!;
    expect(hold.scale).toBeCloseTo(2, 6);
    expect(hold.x).toBeCloseTo(480, 6);
    expect(hold.y).toBeCloseTo(270, 6);
    expect(cameraAt(host, 7.5)!.scale).toBeCloseTo(1.5, 6);
  });

  test('uses the easing curve', () => {
    const slow = { ...host, zooms: [{ ...zoom, ease: 'in' as const }] };
    expect(cameraAt(slow, 2.5)!.scale).toBeLessThan(1.2);
  });

  test('ease times too long for the region shrink to fit', () => {
    const tight = { ...host, zooms: [{ ...zoom, duration: 2, easeIn: 3, easeOut: 3 }] };
    expect(cameraAt(tight, 3)!.scale).toBeCloseTo(2, 6);
  });

  test('the camera window stays inside the canvas even for a region near an edge', () => {
    const edge = { ...host, zooms: [{ ...zoom, x: 1800, y: 1000, width: 120, height: 80, easeIn: 0, easeOut: 0 }] };
    const cam = cameraAt(edge, 4)!;
    const w = cameraWindow(cam, canvas);
    expect(w.x).toBeGreaterThanOrEqual(0);
    expect(w.y).toBeGreaterThanOrEqual(0);
    expect(w.x + w.width).toBeLessThanOrEqual(1920 + 1e-6);
    expect(w.y + w.height).toBeLessThanOrEqual(1080 + 1e-6);
  });

  test('a region with a different shape fits entirely in the picture', () => {
    const wide = { ...host, zooms: [{ ...zoom, x: 100, y: 100, width: 800, height: 200, easeIn: 0, easeOut: 0 }] };
    const w = cameraWindow(cameraAt(wide, 4)!, canvas);
    expect(w.x).toBeLessThanOrEqual(100 + 1e-6);
    expect(w.x + w.width).toBeGreaterThanOrEqual(900 - 1e-6);
    expect(w.height).toBeGreaterThanOrEqual(200);
  });

  test('overlapping regions: the later one wins and pans from where the camera was', () => {
    const a = { ...zoom, id: 'a', start: 0, duration: 10, easeIn: 0, easeOut: 0 };
    const b = { ...zoom, id: 'b', start: 5, duration: 3, x: 960, y: 540, easeIn: 1, easeOut: 0 };
    const h = { ...canvas, zooms: [b, a] }; // list order does not matter, start does
    expect(cameraAt(h, 4)!.x).toBeCloseTo(480, 6);
    const start = cameraAt(h, 5)!;
    expect(start.x).toBeCloseTo(480, 6); // no jump when b takes over
    expect(cameraAt(h, 5.5)!.x).toBeCloseTo(960, 6);
    expect(cameraAt(h, 6.5)!.x).toBeCloseTo(1440, 6);
    expect(cameraAt(h, 9)!.x).toBeCloseTo(480, 6); // back to a once b is over
  });

  test('a region covering the whole canvas is no zoom', () => {
    expect(cameraAt({ ...canvas, zooms: [{ ...zoom, x: 0, y: 0, width: 1920, height: 1080, easeIn: 0 }] }, 4)).toBeNull();
  });
});

describe('zoom operations', () => {
  test('addZoom makes a centred 2x region with sane defaults', () => {
    const p = createProject('z', 1920, 1080);
    const r = addZoom(p, 1.5);
    const z = r.project.zooms[0];
    expect(z.id).toBe(r.id);
    expect(z).toMatchObject({ start: 1.5, duration: 3, x: 480, y: 270, width: 960, height: 540, easeIn: 0.5, easeOut: 0.5 });
  });

  test('updateZoom keeps the rectangle inside the canvas and ease times inside the length', () => {
    let p = createProject('z', 1920, 1080);
    const r = addZoom(p, 0);
    p = updateZoom(r.project, r.id, { x: 5000, y: -4, width: 99999, easeIn: 50 });
    const z = p.zooms[0];
    expect(z.width).toBe(1920);
    expect(z.x).toBe(0);
    expect(z.y).toBe(0);
    expect(z.easeIn).toBe(3);
    expect(updateZoom(p, 'nope', { x: 1 })).toBe(p);
  });

  test('the magnification cannot exceed 20x', () => {
    const r = addZoom(createProject('z', 1920, 1080), 0, { width: 10, height: 10 });
    expect(r.project.zooms[0].width).toBe(96);
  });

  test('duplicate starts at the end of the original; remove deletes', () => {
    const r = addZoom(createProject('z', 1920, 1080), 2);
    const d = duplicateZoom(r.project, r.id);
    expect(d.project.zooms).toHaveLength(2);
    expect(d.project.zooms[1].start).toBe(5);
    expect(d.project.zooms[1].id).not.toBe(r.id);
    const gone = removeZoom(d.project, r.id);
    expect(gone.zooms.map((z) => z.id)).toEqual([d.id!]);
    expect(removeZoom(gone, 'nope')).toBe(gone);
    expect(duplicateZoom(gone, 'nope').id).toBeNull();
  });

  test('zoomRect gives the canvas shape and stays inside', () => {
    expect(zoomRect(canvas, 4, { x: 0, y: 0 })).toEqual({ x: 0, y: 0, width: 480, height: 270 });
    expect(zoomRect(canvas, 2, { x: 1900, y: 1080 })).toEqual({ x: 960, y: 540, width: 960, height: 540 });
  });

  test('rescale and canvas resize carry the regions along', () => {
    const r = addZoom(createProject('z', 1920, 1080), 0);
    expect(rescaleZooms(r.project.zooms, 0.5, 0.5)[0]).toMatchObject({ x: 240, y: 135, width: 480, height: 270 });
    expect(rescaleZooms(r.project.zooms, 1, 1)).toBe(r.project.zooms);
    expect(resizeCanvas(r.project, 960, 540).zooms[0]).toMatchObject({ x: 240, width: 480 });
  });
});

describe('parseZooms', () => {
  test('hardens junk: bad entries dropped, numbers clamped, ids filled in', () => {
    const zooms = parseZooms(
      [
        { id: 'ok', start: 1, duration: 2, x: 10, y: 10, width: 400, height: 300, easeIn: 0.2, easeOut: 0.2, ease: 'out' },
        { start: -5, duration: 'x', x: 0, y: 0, width: 10, height: 10 },
        null,
        'str',
        { start: -3, duration: 0, x: 99999, y: -1, width: 99999, height: 1, ease: 'wobble', easeIn: NaN },
      ],
      canvas,
    );
    expect(zooms).toHaveLength(2);
    expect(zooms[0]).toEqual({ id: 'ok', start: 1, duration: 2, x: 10, y: 10, width: 400, height: 300, easeIn: 0.2, easeOut: 0.2, ease: 'out' });
    const z = zooms[1];
    expect(z.start).toBe(0);
    expect(z.duration).toBeGreaterThan(0);
    expect(z.width).toBe(1920);
    expect(z.height).toBe(1080 / 20);
    expect(z.x + z.width).toBeLessThanOrEqual(1920);
    expect(z.y).toBe(0);
    expect(z.ease).toBe('inOut');
    expect(z.id.length).toBeGreaterThan(0);
    expect(parseZooms(undefined, canvas)).toEqual([]);
    expect(parseZooms({}, canvas)).toEqual([]);
  });

  test('survives a project round trip', () => {
    const r = addZoom(createProject('z', 1920, 1080), 1);
    const back = parseProject(JSON.parse(JSON.stringify(r.project)));
    expect(back.zooms).toEqual(r.project.zooms);
  });
});

describe('keyframe edits and auto-key', () => {
  test('addClipKey stores a key relative to the clip start, with the current value by default', () => {
    const { p, id } = withClip();
    const a = addClipKey(p, id, 'x', 3, 100);
    expect(a.clips[0].keys!.x).toEqual([{ t: 1, v: 100, ease: 'inOut' }]);
    const b = addClipKey(a, id, 'y', 4);
    expect(b.clips[0].keys!.y![0]).toMatchObject({ t: 2, v: 540 });
    // Outside the clip it clamps to the clip.
    expect(addClipKey(p, id, 'x', 99, 1).clips[0].keys!.x![0].t).toBe(p.clips[0].duration);
  });

  test('removing, easing, moving and clearing keys', () => {
    const { p, id } = withClip();
    let q = addClipKey(p, id, 'scale', 3, 1); // clip starts at 2 s: local t = 1
    q = addClipKey(q, id, 'scale', 5, 2); // local t = 3
    q = setKeyEase(q, id, 'scale', 1, 'hold');
    expect(q.clips[0].keys!.scale![0].ease).toBe('hold');
    q = moveClipKey(q, id, 'scale', 1, 2);
    expect(q.clips[0].keys!.scale!.map((k) => k.t)).toEqual([2, 3]);
    q = removeClipKey(q, id, 'scale', 2);
    expect(q.clips[0].keys!.scale).toHaveLength(1);
    expect(clearClipKeys(q, id).clips[0].keys).toBeUndefined();
    expect(removeClipKey(q, id, 'x', 0)).toBe(q);
  });

  test('keyedProps follows the keys but not the behavior', () => {
    let { p, id } = withClip();
    p = addClipKey(p, id, 'x', 2, 0);
    p = addClipKey(p, id, 'x', 4, 1000);
    p = setKeyEase(p, id, 'x', 0, 'linear');
    expect(keyedProps(p.clips[0], 3).x).toBeCloseTo(500, 6);
  });

  test('editing a keyed property sets a key at the playhead and leaves the base alone', () => {
    let { p, id } = withClip();
    p = addClipKey(p, id, 'x', 2, 100);
    p = addClipKey(p, id, 'x', 4, 200);
    const base0 = p.clips[0].props.x;
    const q = updateClipPropsAt(p, id, { x: 777, y: 111 }, 3);
    const c = q.clips[0];
    expect(c.props.x).toBe(base0); // keyed: base untouched
    expect(c.props.y).toBe(111); // not keyed: a plain edit
    expect(c.keys!.x!.map((k) => [k.t, k.v])).toEqual([
      [0, 100],
      [1, 777],
      [2, 200],
    ]);
    // Dragging at the same time replaces that key rather than piling up new ones.
    const again = updateClipPropsAt(q, id, { x: 800 }, 3);
    expect(again.clips[0].keys!.x).toHaveLength(3);
    expect(keyedProps(again.clips[0], 3).x).toBe(800);
  });

  test('without keyframes it is an ordinary edit, and locked tracks stay locked', () => {
    const { p, id } = withClip();
    expect(updateClipPropsAt(p, id, { x: 5 }, 3).clips[0].props.x).toBe(5);
    // updatedAt is the clock at the moment of each edit, so it may differ by a millisecond.
    expect({ ...updateClipPropsAt(p, id, { x: 5 }, 3), updatedAt: 0 }).toEqual({ ...updateClipProps(p, id, { x: 5 }), updatedAt: 0 });
    const locked = { ...addClipKey(p, id, 'x', 2, 1), tracks: p.tracks.map((t) => ({ ...t, locked: true })) };
    expect(updateClipPropsAt(locked, id, { x: 9 }, 3)).toBe(locked);
  });

  test('volume is never auto-keyed', () => {
    let { p, id } = withClip();
    p = addClipKey(p, id, 'x', 2, 1);
    const q = updateClipPropsAt(p, id, { volume: 0.5 }, 3);
    expect(q.clips[0].props.volume).toBe(0.5);
    expect(q.clips[0].keys!.volume).toBeUndefined();
  });

  test('behavior and transition setters clear cleanly', () => {
    let { p, id } = withClip();
    p = setClipBehavior(p, id, 'enter', { type: 'fade', duration: 1 });
    p = setClipBehavior(p, id, 'emphasis', { type: 'pulse', duration: 1 });
    p = setClipBehavior(p, id, 'enter', undefined);
    expect(p.clips[0].behavior).toEqual({ emphasis: { type: 'pulse', duration: 1 } });
    p = setClipBehavior(p, id, 'emphasis', undefined);
    expect(p.clips[0].behavior).toBeUndefined();
    p = setClipTransition(p, id, 'out', { type: 'fade', duration: 1 });
    expect(p.clips[0].transitionOut).toEqual({ type: 'fade', duration: 1 });
    p = setClipTransition(p, id, 'out', undefined);
    expect(p.clips[0].transitionOut).toBeUndefined();
  });
});
