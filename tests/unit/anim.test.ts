import { describe, expect, test } from 'bun:test';
import { ease, evalTrack, hasKeys, parseKeys, removeKey, resolveProps, setKey, shiftKeys } from '../../src/engine/anim';

describe('easing', () => {
  test('every curve starts at 0 and ends at 1', () => {
    for (const name of ['linear', 'in', 'out', 'inOut', 'back', 'bounce'] as const) {
      expect(ease(name, 0)).toBeCloseTo(0, 6);
      expect(ease(name, 1)).toBeCloseTo(1, 6);
    }
  });

  test('hold stays at 0 until the end', () => {
    expect(ease('hold', 0.99)).toBe(0);
    expect(ease('hold', 1)).toBe(1);
  });

  test('in is slow first, out is fast first, inOut is symmetric', () => {
    expect(ease('in', 0.5)).toBeLessThan(0.5);
    expect(ease('out', 0.5)).toBeGreaterThan(0.5);
    expect(ease('inOut', 0.5)).toBeCloseTo(0.5, 6);
    expect(ease('inOut', 0.25) + ease('inOut', 0.75)).toBeCloseTo(1, 6);
  });

  test('back overshoots, input is clamped', () => {
    expect(Math.max(...[0.6, 0.7, 0.8, 0.9].map((u) => ease('back', u)))).toBeGreaterThan(1);
    expect(ease('linear', -3)).toBe(0);
    expect(ease('linear', 9)).toBe(1);
  });
});

describe('keyframe tracks', () => {
  const track = [
    { t: 1, v: 10, ease: 'linear' as const },
    { t: 3, v: 30, ease: 'linear' as const },
    { t: 4, v: 0, ease: 'hold' as const },
    { t: 5, v: 50, ease: 'linear' as const },
  ];

  test('no keys gives the fallback', () => {
    expect(evalTrack(undefined, 2, 7)).toBe(7);
    expect(evalTrack([], 2, 7)).toBe(7);
  });

  test('holds the end values outside the keys and interpolates between them', () => {
    expect(evalTrack(track, 0, 99)).toBe(10);
    expect(evalTrack(track, 2, 99)).toBeCloseTo(20, 6);
    expect(evalTrack(track, 3.5, 99)).toBeCloseTo(15, 6);
    expect(evalTrack(track, 9, 99)).toBe(50);
  });

  test('a hold key keeps its value until the next key', () => {
    expect(evalTrack(track, 4.9, 99)).toBe(0);
    expect(evalTrack(track, 5, 99)).toBe(50);
  });

  test('setKey keeps tracks sorted and replaces a key at the same time', () => {
    let keys = setKey(undefined, 'x', { t: 2, v: 1, ease: 'linear' });
    keys = setKey(keys, 'x', { t: 1, v: 5, ease: 'out' });
    keys = setKey(keys, 'x', { t: 2.0004, v: 9, ease: 'linear' });
    expect(keys.x!.map((k) => [k.t, k.v])).toEqual([
      [1, 5],
      [2.0004, 9],
    ]);
    expect(hasKeys(keys)).toBe(true);
  });

  test('removeKey drops empty tracks and then the whole object', () => {
    let keys = setKey(undefined, 'opacity', { t: 0, v: 0, ease: 'linear' });
    keys = setKey(keys, 'x', { t: 0, v: 0, ease: 'linear' });
    keys = removeKey(keys, 'opacity', 0)!;
    expect(keys.opacity).toBeUndefined();
    expect(removeKey(keys, 'x', 0)).toBeUndefined();
  });

  test('shiftKeys moves every key', () => {
    const keys = setKey(undefined, 'scale', { t: 2, v: 1, ease: 'linear' });
    expect(shiftKeys(keys, -0.5)!.scale![0].t).toBeCloseTo(1.5, 9);
    expect(shiftKeys(undefined, 1)).toBeUndefined();
  });
});

describe('resolveProps', () => {
  const canvas = { width: 1920, height: 1080 };
  const base = { x: 960, y: 540, scale: 1, rotation: 0, opacity: 1, volume: 1 };

  test('overlays keyframes on the base values', () => {
    let keys = setKey(undefined, 'opacity', { t: 0, v: 0, ease: 'linear' });
    keys = setKey(keys, 'opacity', { t: 2, v: 1, ease: 'linear' });
    const p = resolveProps(base, { keys }, 1, 4, canvas);
    expect(p.opacity).toBeCloseTo(0.5, 6);
    expect(p.x).toBe(960);
  });

  test('without keys the base comes back untouched', () => {
    expect(resolveProps(base, {}, 3, 4, canvas)).toEqual(base);
  });
});

describe('parseKeys', () => {
  test('drops junk, sorts and defaults unknown easing', () => {
    const keys = parseKeys({
      x: [
        { t: 2, v: 5, ease: 'out' },
        { t: 1, v: 3, ease: 'wobble' },
        { t: 'a', v: 1 },
        null,
      ],
      bogus: [{ t: 0, v: 0 }],
      scale: [],
    });
    expect(keys).toEqual({
      x: [
        { t: 1, v: 3, ease: 'linear' },
        { t: 2, v: 5, ease: 'out' },
      ],
    });
  });

  test('nothing worth keeping is undefined', () => {
    expect(parseKeys(undefined)).toBeUndefined();
    expect(parseKeys({ x: [] })).toBeUndefined();
    expect(parseKeys('x')).toBeUndefined();
  });
});
