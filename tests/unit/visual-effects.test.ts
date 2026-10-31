import { describe, expect, test } from 'bun:test';
import { DEFAULT_CHROMA, DEFAULT_COLOUR, EFFECT_PRESETS, activeEffects, hasActiveEffects, mergeEffects, parseEffects, rescaleEffects } from '../../src/engine/fx';
import { frameLayout } from '../../src/engine/fx-frames';
import { cbcr, chromaParams, colourParams, hexToRgb, hueMatrix, processImageData, processPixel } from '../../src/engine/fx-math';
import { updateClipEffects } from '../../src/engine/fx-ops';
import { addClip, addMedia, resizeCanvas } from '../../src/engine/ops';
import { type MediaItem, createProject, parseProject } from '../../src/engine/project';

const media: MediaItem = { id: 'm1', name: 'a.png', kind: 'image', mime: 'image/png', bytes: 1, duration: 5, width: 640, height: 360, hasAudio: false, createdAt: 0 };

describe('parseEffects', () => {
  test('nothing valid means no effects', () => {
    expect(parseEffects(undefined)).toBeUndefined();
    expect(parseEffects('x')).toBeUndefined();
    expect(parseEffects({})).toBeUndefined();
    expect(parseEffects({ blend: 'normal', radius: 0, mask: 'star', frame: { kind: 'toaster' } })).toBeUndefined();
  });

  test('clamps values and fills defaults', () => {
    const e = parseEffects({ colour: { brightness: 500, hue: -999, tint: 'red' }, chroma: { tolerance: -4 }, shadow: { opacity: 300, blur: -1 }, border: { width: 9999 } })!;
    expect(e.colour).toMatchObject({ on: true, brightness: 100, hue: -180, tint: DEFAULT_COLOUR.tint });
    expect(e.chroma).toMatchObject({ key: DEFAULT_CHROMA.key, tolerance: 0 });
    expect(e.shadow).toMatchObject({ opacity: 100, blur: 0 });
    expect(e.border!.width).toBe(500);
  });

  test('keeps a switched-off group and its settings', () => {
    const e = parseEffects({ colour: { on: false, saturation: -50 } })!;
    expect(e.colour).toMatchObject({ on: false, saturation: -50 });
    expect(hasActiveEffects(e)).toBe(false);
  });

  test('round-trips through a project', () => {
    let p = createProject('x', 640, 360);
    p = addMedia(p, media);
    const r = addClip(p, 'm1', 0);
    const effects = parseEffects({ chroma: { key: '#00FF00', tolerance: 30 }, radius: 20, blend: 'multiply', frame: { kind: 'laptop', tone: 'light' }, mask: 'circle' })!;
    const withFx = updateClipEffects(r.project, [r.clipId!], () => effects);
    const back = parseProject(JSON.parse(JSON.stringify(withFx)));
    expect(back.clips[0].effects).toEqual(effects);
    expect(back.clips[0].effects!.chroma!.key).toBe('#00ff00');
  });

  test('malformed effects in a saved project are dropped, not fatal', () => {
    let p = createProject('x', 640, 360);
    p = addMedia(p, media);
    const raw = JSON.parse(JSON.stringify(addClip(p, 'm1', 0).project));
    raw.clips[0].effects = { chroma: 5, shadow: 'dark', blend: 'bogus', radius: 'big' };
    expect(parseProject(raw).clips[0].effects).toBeUndefined();
  });
});

describe('rescaleEffects', () => {
  test('pixel sizes scale, percentages and colours do not', () => {
    const e = parseEffects({ radius: 20, shadow: { blur: 30, dx: 4, dy: 10, opacity: 40 }, border: { width: 6 }, colour: { saturation: 20 } })!;
    const r = rescaleEffects(e, 2)!;
    expect(r.radius).toBe(40);
    expect(r.shadow).toMatchObject({ blur: 60, dx: 8, dy: 20, opacity: 40 });
    expect(r.border!.width).toBe(12);
    expect(r.colour).toEqual(e.colour);
    expect(rescaleEffects(undefined, 2)).toBeUndefined();
    expect(rescaleEffects(e, 1)).toBe(e);
  });

  test('resizing the canvas rescales clip effects', () => {
    let p = createProject('x', 1920, 1080);
    p = addMedia(p, media);
    const r = addClip(p, 'm1', 0);
    p = updateClipEffects(r.project, [r.clipId!], () => ({ radius: 40, shadow: { on: true, blur: 20, dx: 0, dy: 10, colour: '#000000', opacity: 50 } }));
    const small = resizeCanvas(p, 960, 540);
    expect(small.clips[0].effects!.radius).toBe(20);
    expect(small.clips[0].effects!.shadow!.dy).toBe(5);
  });
});

describe('updateClipEffects and presets', () => {
  test('an empty result removes the effects and no change returns the same project', () => {
    let p = createProject('x', 640, 360);
    p = addMedia(p, media);
    const r = addClip(p, 'm1', 0);
    const on = updateClipEffects(r.project, [r.clipId!], () => ({ blend: 'screen' }));
    expect(on.clips[0].effects).toEqual({ blend: 'screen' });
    expect(updateClipEffects(on, [r.clipId!], (c) => c)).toBe(on);
    expect(updateClipEffects(on, [r.clipId!], () => undefined).clips[0].effects).toBeUndefined();
  });

  test('every preset builds valid, active effects that scale with the canvas', () => {
    for (const preset of EFFECT_PRESETS) {
      const e = preset.build(1080);
      expect(parseEffects(e)).toBeDefined();
      expect(hasActiveEffects(e)).toBe(true);
    }
    const card = EFFECT_PRESETS.find((p) => p.id === 'card')!;
    expect(card.build(2160).radius).toBe(card.build(1080).radius! * 2);
  });

  test('presets stack', () => {
    const bw = EFFECT_PRESETS.find((p) => p.id === 'bw')!.build(1080);
    const card = EFFECT_PRESETS.find((p) => p.id === 'card')!.build(1080);
    const both = mergeEffects(bw, card);
    expect(both.colour).toBeDefined();
    expect(both.radius).toBeGreaterThan(0);
  });

  test('a device frame overrides radius, mask and border', () => {
    const a = activeEffects(parseEffects({ radius: 30, mask: 'circle', border: { width: 4 }, frame: { kind: 'phone' } }));
    expect(a.radius).toBe(0);
    expect(a.mask).toBeNull();
    expect(a.border).toBeNull();
    expect(a.frame).not.toBeNull();
  });

  test('blend modes map to canvas operations', () => {
    expect(activeEffects({ blend: 'multiply' }).blend).toBe('multiply');
    expect(activeEffects({ blend: 'add' }).blend).toBe('lighter');
    expect(activeEffects({ blend: 'normal' }).blend).toBeNull();
  });
});

describe('colour maths (the reference the shader is checked against)', () => {
  const run = (fx: Partial<typeof DEFAULT_COLOUR>, r: number, g: number, b: number) => processPixel(colourParams({ ...DEFAULT_COLOUR, ...fx }), null, r, g, b, 1);

  test('no adjustment is no work', () => {
    expect(colourParams({ ...DEFAULT_COLOUR })).toBeNull();
    expect(colourParams({ ...DEFAULT_COLOUR, on: false, brightness: 50 })).toBeNull();
  });

  test('brightness lifts every channel and clamps', () => {
    const out = run({ brightness: 40 }, 0.2, 0.5, 0.9);
    expect(out[0]).toBeCloseTo(0.4, 6);
    expect(out[1]).toBeCloseTo(0.7, 6);
    expect(out[2]).toBe(1);
  });

  test('contrast pivots on mid grey', () => {
    const out = run({ contrast: 100 }, 0.25, 0.5, 0.75);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeCloseTo(1, 6);
  });

  test('saturation -100 is greyscale at the same luma', () => {
    const out = run({ saturation: -100 }, 1, 0, 0);
    expect(out[0]).toBeCloseTo(out[1], 6);
    expect(out[1]).toBeCloseTo(out[2], 6);
    expect(out[0]).toBeCloseTo(0.2126, 4);
  });

  test('hue 0 is the identity and 360-degree equivalents agree', () => {
    expect(hueMatrix(0).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const a = hueMatrix(120);
    const b = hueMatrix(-240);
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
  });

  test('hue rotation by 120 degrees sends red towards green', () => {
    const out = run({ hue: 120 }, 1, 0, 0);
    expect(out[1]).toBeGreaterThan(out[0]);
  });

  test('a full tint of mid grey is the tint colour', () => {
    const out = run({ tint: '#ff8000', tintAmount: 100 }, 0.5, 0.5, 0.5);
    expect(out[0]).toBeCloseTo(1, 2);
    expect(out[1]).toBeCloseTo(0.5, 2);
    expect(out[2]).toBeCloseTo(0, 2);
  });

  test('alpha is untouched by colour adjustment', () => {
    expect(processPixel(colourParams({ ...DEFAULT_COLOUR, brightness: 30 }), null, 0.1, 0.2, 0.3, 0.4)[3]).toBeCloseTo(0.4, 6);
  });
});

describe('chroma key maths', () => {
  const key = (fx: Partial<typeof DEFAULT_CHROMA>, r: number, g: number, b: number) => processPixel(null, chromaParams({ ...DEFAULT_CHROMA, ...fx }), r, g, b, 1);

  test('the key colour is removed and a distant colour is kept', () => {
    expect(key({}, 0, 1, 0)[3]).toBe(0);
    expect(key({}, 1, 0, 0)[3]).toBe(1);
    expect(key({}, 0.1, 0.2, 0.9)[3]).toBe(1);
  });

  test('tolerance widens what is removed', () => {
    const near: [number, number, number] = [0.3, 0.8, 0.3];
    expect(key({ tolerance: 0, softness: 0 }, ...near)[3]).toBe(1);
    expect(key({ tolerance: 60, softness: 0 }, ...near)[3]).toBe(0);
  });

  test('softness gives partial alpha between removed and kept, rising with distance', () => {
    const p = chromaParams({ ...DEFAULT_CHROMA, tolerance: 20, softness: 50 })!;
    const alphas = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4].map((g) => processPixel(null, p, 0.2, g, 0.2, 1)[3]);
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]).toBeGreaterThanOrEqual(alphas[i - 1]);
    expect(alphas.some((a) => a > 0 && a < 1)).toBe(true);
  });

  test('spill suppression pulls green out of a kept edge pixel but leaves red alone', () => {
    const edge = [0.5, 0.9, 0.5] as const;
    const without = key({ spill: 0, tolerance: 5, softness: 0 }, ...edge);
    const withSpill = key({ spill: 100, tolerance: 5, softness: 0 }, ...edge);
    expect(withSpill[1]).toBeLessThan(without[1]);
    const red = key({ spill: 100 }, 1, 0, 0);
    expect(red.slice(0, 3)).toEqual([1, 0, 0]);
  });

  test('a grey key has no spill direction and does not crash', () => {
    const p = chromaParams({ ...DEFAULT_CHROMA, key: '#808080' })!;
    expect(p.keyDir).toEqual([0, 0, 0]);
    expect(processPixel(null, p, 0.5, 0.5, 0.5, 1)[3]).toBe(0);
  });

  test('cbcr of white and black is zero', () => {
    expect(cbcr(1, 1, 1)[0]).toBeCloseTo(0, 2);
    expect(cbcr(0, 0, 0)).toEqual([0, 0]);
  });

  test('byte-level pass matches the per-pixel reference and skips transparent pixels', () => {
    const data = new Uint8ClampedArray([0, 255, 0, 255, 255, 0, 0, 255, 10, 20, 30, 0]);
    processImageData(data, colourParams({ ...DEFAULT_COLOUR, brightness: 20 }), chromaParams(DEFAULT_CHROMA));
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(255);
    expect(data[4]).toBe(255);
    expect(data.slice(8)).toEqual(new Uint8ClampedArray([10, 20, 30, 0]));
  });

  test('hexToRgb', () => {
    expect(hexToRgb('#ff0000')).toEqual([1, 0, 0]);
    expect(hexToRgb('#0f0')).toEqual([0, 1, 0]);
    expect(hexToRgb('nope')).toEqual([0, 0, 0]);
  });
});

describe('device frame layout', () => {
  test('every frame fits inside the clip box and keeps the picture inside the device', () => {
    for (const kind of ['browser', 'laptop', 'phone', 'tablet', 'monitor'] as const) {
      for (const [w, h] of [[1280, 720], [400, 800], [500, 500]]) {
        const l = frameLayout(kind, w, h);
        expect(l.scale).toBeGreaterThan(0.5);
        expect(l.scale).toBeLessThanOrEqual(1);
        expect(l.W * l.scale).toBeLessThanOrEqual(w + 1e-6);
        expect(l.H * l.scale).toBeLessThanOrEqual(h + 1e-6);
        expect(l.sx + w).toBeLessThanOrEqual(l.W + 1e-6);
        expect(l.sy + h).toBeLessThanOrEqual(l.H + 1e-6);
      }
    }
  });
});
