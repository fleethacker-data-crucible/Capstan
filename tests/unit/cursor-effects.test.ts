import { describe, expect, test } from 'bun:test';
import {
  CURSOR_LIMITS,
  type CursorData,
  CursorFormatError,
  DEFAULT_CURSOR_FX,
  activeClicks,
  drawCursorFx,
  isSidecarName,
  parseCursorData,
  parseCursorFx,
  parseSidecar,
  positionAt,
  pressedAt,
  ringState,
  serializeSidecar,
  sidecarName,
  smoothedPositionAt,
} from '../../src/engine/cursor';
import { findFocusEvents, fitZoomRect, suggestZooms } from '../../src/engine/cursorfocus';
import { calloutAlpha, calloutText, keyCallouts, keyLabel } from '../../src/engine/cursorkeys';
import { addZoomRegions, attachCursorData, clearCursorFx, removeCursorData, setCursorFx } from '../../src/engine/cursorops';
import { clickSoundTimes, synthClick } from '../../src/engine/cursorsound';
import { addClip, addMedia } from '../../src/engine/ops';
import { type MediaItem, type Project, createProject, parseProject } from '../../src/engine/project';
import { jitter, longCursor, shortCursor } from '../helpers/cursor-synth.mjs';

function video(id: string, seconds: number, cursor?: CursorData): MediaItem {
  return { id, name: `${id}.webm`, kind: 'video', mime: 'video/webm', bytes: 1, duration: seconds, width: 1920, height: 1080, hasAudio: false, createdAt: 0, ...(cursor ? { cursor } : {}) };
}

function projectWith(data: CursorData, seconds = 12): { p: Project; clipId: string } {
  let p = createProject('t', 1920, 1080);
  p = addMedia(p, video('m', seconds, data));
  const r = addClip(p, 'm', 0);
  return { p: r.project, clipId: r.clipId! };
}

describe('sidecar parsing and validation', () => {
  const ok = { format: 'capstan-cursor', version: 1, samples: [[0, 0.1, 0.2], { t: 1, x: 0.5, y: 0.5 }], clicks: [{ t: 0.5, button: 'right', down: true }], keys: [{ t: 0.7, key: 'a' }] };

  test('reads both sample spellings, defaults down to true and button to left', () => {
    const d = parseSidecar(JSON.stringify({ ...ok, clicks: [{ t: 0.5 }] }));
    expect(d.samples).toEqual([{ t: 0, x: 0.1, y: 0.2 }, { t: 1, x: 0.5, y: 0.5 }]);
    expect(d.clicks).toEqual([{ t: 0.5, button: 'left', down: true }]);
    expect(d.keys).toEqual([{ t: 0.7, key: 'a', down: true }]);
  });

  test('sorts by time and clamps positions into the frame', () => {
    const d = parseSidecar(JSON.stringify({ version: 1, samples: [[2, 1.5, -1], [1, 0.5, 0.5]] }));
    expect(d.samples.map((s) => s.t)).toEqual([1, 2]);
    expect(d.samples[1]).toEqual({ t: 2, x: 1, y: 0 });
  });

  test('rejects bad JSON, wrong version, wrong format and empty files', () => {
    expect(() => parseSidecar('{nope')).toThrow(CursorFormatError);
    expect(() => parseSidecar('[]')).toThrow(/object/);
    expect(() => parseSidecar(JSON.stringify({ samples: [] }))).toThrow(/version/);
    expect(() => parseSidecar(JSON.stringify({ version: 2, samples: [[0, 0, 0]] }))).toThrow(/version/);
    expect(() => parseSidecar(JSON.stringify({ format: 'other', version: 1, samples: [[0, 0, 0]] }))).toThrow(/format/);
    expect(() => parseSidecar(JSON.stringify({ version: 1 }))).toThrow(/no samples/);
  });

  test('any invalid entry rejects the file and names where', () => {
    expect(() => parseSidecar(JSON.stringify({ version: 1, samples: [[0, 0, 0], [1, 'x', 0]] }))).toThrow(/samples\[1\]/);
    expect(() => parseSidecar(JSON.stringify({ version: 1, samples: [[-1, 0, 0]] }))).toThrow(/time/);
    expect(() => parseSidecar(JSON.stringify({ version: 1, samples: [[0, 0, 0]], clicks: [{ t: 0, button: 'thumb' }] }))).toThrow(/button/);
    expect(() => parseSidecar(JSON.stringify({ version: 1, samples: [[0, 0, 0]], keys: [{ t: 0, key: 'x'.repeat(CURSOR_LIMITS.keyName + 1) }] }))).toThrow(/key/);
    expect(() => parseSidecar(JSON.stringify({ version: 1, samples: [[Number.NaN, 0, 0]] }))).toThrow(CursorFormatError);
  });

  test('size caps', () => {
    const many = new Array(CURSOR_LIMITS.samples + 1).fill([0, 0, 0]);
    expect(() => parseSidecar(JSON.stringify({ version: 1, samples: many }))).toThrow(/limit/);
    expect(() => parseSidecar(' '.repeat(CURSOR_LIMITS.sidecarChars + 1))).toThrow(/too large/);
    const clicks = new Array(CURSOR_LIMITS.clicks + 1).fill({ t: 0 });
    expect(() => parseSidecar(JSON.stringify({ version: 1, samples: [[0, 0, 0]], clicks }))).toThrow(/limit/);
    expect(parseCursorData({ samples: many })).toBeUndefined();
  });

  test('stored data: invalid entries are dropped, nothing usable gives undefined', () => {
    expect(parseCursorData(undefined)).toBeUndefined();
    expect(parseCursorData({ samples: [] })).toBeUndefined();
    expect(parseCursorData({ samples: [[0, 0.5, 0.5], [1, 'bad', 0]], clicks: [{ t: 1, button: 'x' }] })).toEqual({ samples: [{ t: 0, x: 0.5, y: 0.5 }], clicks: [], keys: [] });
  });

  test('file names', () => {
    expect(isSidecarName('Talk.CURSOR.JSON')).toBe(true);
    expect(isSidecarName('talk.json')).toBe(false);
    expect(sidecarName('my demo.webm')).toBe('my demo.cursor.json');
    expect(sidecarName('noext')).toBe('noext.cursor.json');
  });

  test('round trip: serialize then parse gives the same data', () => {
    const data = shortCursor() as CursorData;
    const back = parseSidecar(serializeSidecar(data));
    expect(back.samples.length).toBe(data.samples.length);
    expect(back.clicks).toEqual(data.clicks);
    expect(back.keys).toEqual(data.keys);
    for (let i = 0; i < data.samples.length; i++) {
      expect(back.samples[i].t).toBeCloseTo(data.samples[i].t, 4);
      expect(back.samples[i].x).toBeCloseTo(data.samples[i].x, 4);
      expect(back.samples[i].y).toBeCloseTo(data.samples[i].y, 4);
    }
    // And attaching it, saving the project and loading it again keeps it.
    const { p } = projectWith(back);
    const loaded = parseProject(JSON.parse(JSON.stringify(setCursorFx(p, { highlight: true }))));
    expect(loaded.media[0].cursor).toEqual(back);
    expect(loaded.cursorFx?.highlight).toBe(true);
  });

  test('a project with malformed cursor data loads without it', () => {
    const { p } = projectWith(shortCursor() as CursorData);
    const json = JSON.parse(JSON.stringify(setCursorFx(p, {})));
    json.media[0].cursor = { samples: 'nope' };
    json.cursorFx = 'nope';
    const loaded = parseProject(json);
    expect(loaded.media[0].cursor).toBeUndefined();
    expect(loaded.cursorFx).toBeUndefined();
  });
});

describe('effect settings', () => {
  test('defaults fill in and values are clamped', () => {
    expect(parseCursorFx({})).toEqual(DEFAULT_CURSOR_FX);
    expect(parseCursorFx(null)).toBeUndefined();
    const fx = parseCursorFx({ size: 99, smoothing: -4, shape: 'banana', color: 'red', highlightColor: '#ABCDEF', clickDuration: 0, extra: 1 })!;
    expect(fx.size).toBe(4);
    expect(fx.smoothing).toBe(0);
    expect(fx.shape).toBe('arrow');
    expect(fx.color).toBe(DEFAULT_CURSOR_FX.color);
    expect(fx.highlightColor).toBe('#abcdef');
    expect(fx.clickDuration).toBe(0.2);
    expect('extra' in fx).toBe(false);
  });

  test('replacement image must be a small image data URL', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(parseCursorFx({ image: png })!.image).toBe(png);
    expect(parseCursorFx({ image: 'https://example.com/a.png' })!.image).toBeUndefined();
    expect(parseCursorFx({ image: 'data:text/html;base64,AAAA' })!.image).toBeUndefined();
    expect(parseCursorFx({ image: png + 'A'.repeat(CURSOR_LIMITS.imageChars) })!.image).toBeUndefined();
  });

  test('edits are pure and undoable data changes', () => {
    const { p } = projectWith(shortCursor() as CursorData);
    const a = setCursorFx(p, { highlight: true, size: 2 });
    expect(p.cursorFx).toBeUndefined();
    expect(a.cursorFx?.highlight).toBe(true);
    expect(setCursorFx(a, { size: 3 }).cursorFx?.highlight).toBe(true);
    expect(clearCursorFx(a).cursorFx).toBeUndefined();
    const removed = removeCursorData(a, 'm');
    expect(removed.media[0].cursor).toBeUndefined();
    expect(attachCursorData(removed, 'm', shortCursor() as CursorData).media[0].cursor).toBeDefined();
    expect(attachCursorData(a, 'nope', shortCursor() as CursorData)).toBe(a);
  });
});

describe('smoothing maths', () => {
  const data = shortCursor() as CursorData;

  test('strength 0 passes through every sample and holds at the ends', () => {
    for (const s of data.samples.filter((_, i) => i % 7 === 0)) {
      const p = smoothedPositionAt(data.samples, s.t, 0)!;
      expect(p.x).toBeCloseTo(s.x, 6);
      expect(p.y).toBeCloseTo(s.y, 6);
    }
    expect(positionAt(data.samples, -5)).toEqual({ x: 0.25, y: 0.3 });
    expect(positionAt(data.samples, 99)).toEqual({ x: 0.7, y: 0.6 });
    expect(positionAt([], 1)).toBeNull();
  });

  test('the spline is smooth between samples', () => {
    const s = [{ t: 0, x: 0, y: 0 }, { t: 1, x: 1, y: 1 }, { t: 2, x: 0, y: 1 }];
    const mid = positionAt(s, 0.5)!;
    expect(mid.x).toBeGreaterThan(0.3);
    expect(mid.x).toBeLessThan(0.8);
    for (let t = 0; t <= 2; t += 0.1) {
      const p = positionAt(s, t)!;
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
    }
  });

  test('rest stays put and a straight glide is not bent', () => {
    expect(smoothedPositionAt(data.samples, 0.2, 1)!.x).toBeCloseTo(0.25, 6);
    const mid = smoothedPositionAt(data.samples, 1.25, 0.5)!;
    expect(mid.x).toBeCloseTo(0.475, 2);
    expect(mid.y).toBeCloseTo(0.45, 2);
  });

  test('more strength means less jitter', () => {
    const rest = jitter(Array.from({ length: 90 }, (_, i) => ({ t: i / 30, x: 0.5, y: 0.5 })), 0.02);
    const spread = (strength: number) => {
      let sum = 0;
      let n = 0;
      for (let t = 0.5; t < 2.5; t += 1 / 30) {
        sum += (smoothedPositionAt(rest, t, strength)!.x - 0.5) ** 2;
        n++;
      }
      return Math.sqrt(sum / n);
    };
    expect(spread(0.3)).toBeLessThan(spread(0));
    expect(spread(1)).toBeLessThan(spread(0.3));
    expect(spread(1)).toBeLessThan(spread(0) / 2);
  });

  test('deterministic: the same time always gives the same place (scrubbing and export agree)', () => {
    const a = smoothedPositionAt(data.samples, 1.234, 0.6);
    smoothedPositionAt(data.samples, 2.5, 0.6);
    expect(smoothedPositionAt(data.samples, 1.234, 0.6)).toEqual(a);
  });
});

describe('click effects timing', () => {
  test('ring: nothing before the click or after its duration, shrinking opacity in between', () => {
    expect(ringState(0.99, 1, 0.6)).toBeNull();
    expect(ringState(1.6, 1, 0.6)).toBeNull();
    const start = ringState(1, 1, 0.6)!;
    expect(start.progress).toBe(0);
    expect(start.radius).toBe(0);
    expect(start.alpha).toBe(1);
    const half = ringState(1.3, 1, 0.6)!;
    expect(half.progress).toBeCloseTo(0.5, 6);
    expect(half.radius).toBeCloseTo(0.875, 6);
    expect(half.alpha).toBeCloseTo(0.3536, 3);
    const late = ringState(1.59, 1, 0.6)!;
    expect(late.radius).toBeGreaterThan(half.radius);
    expect(late.alpha).toBeLessThan(half.alpha);
  });

  test('only presses count, and only while their ring shows', () => {
    const clicks = (shortCursor() as CursorData).clicks;
    expect(activeClicks(clicks, 0.45, 0.6)).toHaveLength(0);
    expect(activeClicks(clicks, 0.6, 0.6).map((c) => c.t)).toEqual([0.5]);
    expect(activeClicks(clicks, 1.2, 0.6)).toHaveLength(0);
    expect(activeClicks(clicks, 2.25, 0.6).map((c) => c.button)).toEqual(['left', 'right']);
  });

  test('pressed state follows the button', () => {
    const clicks = (shortCursor() as CursorData).clicks;
    expect(pressedAt(clicks, 0.4)).toBe(false);
    expect(pressedAt(clicks, 0.52)).toBe(true);
    expect(pressedAt(clicks, 0.6)).toBe(false);
    expect(pressedAt(clicks, 2.21)).toBe(true);
  });
});

describe('key grouping', () => {
  const keys = (shortCursor() as CursorData).keys;

  test('Ctrl+C is one combo bubble and "hi" one typed bubble', () => {
    const c = keyCallouts(keys);
    expect(c.map((x) => x.label)).toEqual(['Ctrl+C', 'hi']);
    expect(c[0].combo).toBe(true);
    expect(c[0].start).toBe(2.45);
    expect(c[1].combo).toBe(false);
  });

  test('modifier order and Shift handling', () => {
    const seq = (...k: Array<[number, string, boolean]>) => keyCallouts(k.map(([t, key, down]) => ({ t, key, down })));
    expect(seq([0, 'Shift', true], [0.01, 'Control', true], [0.02, 'Escape', true])[0].label).toBe('Ctrl+Shift+Esc');
    expect(seq([0, 'Meta', true], [0.1, 'd', true])[0].label).toBe('Win+D');
    // Shift + a letter is just typing an upper-case letter.
    const typed = seq([0, 'Shift', true], [0.1, 'A', true]);
    expect(typed.map((x) => x.label)).toEqual(['A']);
    expect(typed[0].combo).toBe(false);
    expect(seq([0, 'Control', true], [0.1, 'Control', false])).toHaveLength(0);
  });

  test('typing joins within 0.8 s and splits after a longer pause', () => {
    const seq = (...times: number[]) => keyCallouts(times.flatMap((t, i) => [{ t, key: 'abcdef'[i], down: true }, { t: t + 0.02, key: 'abcdef'[i], down: false }]));
    expect(seq(0, 0.3, 0.7).map((x) => x.label)).toEqual(['abc']);
    expect(seq(0, 0.3, 1.5, 1.8).map((x) => x.label)).toEqual(['ab', 'cd']);
  });

  test('special keys stand alone, auto-repeat counts once', () => {
    const c = keyCallouts([
      { t: 0, key: 'a', down: true },
      { t: 0.1, key: 'Enter', down: true },
      { t: 0.15, key: 'Enter', down: true },
      { t: 0.2, key: 'Enter', down: true },
      { t: 0.25, key: 'Enter', down: false },
      { t: 0.3, key: 'ArrowLeft', down: true },
    ]);
    expect(c.map((x) => x.label)).toEqual(['A'.toLowerCase(), 'Enter', '←']);
    expect(keyLabel('f5')).toBe('F5');
    expect(keyLabel('PageDown')).toBe('PgDn');
  });

  test('typed text appears character by character and bubbles fade after the hold time', () => {
    const run = keyCallouts(keys)[1];
    expect(calloutText(run, 2.7)).toBe('h');
    expect(calloutText(run, 2.9)).toBe('hi');
    expect(calloutAlpha(run, 2.69, 1.5)).toBe(0);
    expect(calloutAlpha(run, 2.9, 1.5)).toBe(1);
    expect(calloutAlpha(run, 2.8 + 1.5 - 0.1, 1.5)).toBeLessThan(0.5);
    expect(calloutAlpha(run, 2.8 + 1.5, 1.5)).toBe(0);
    expect(calloutAlpha(run, 2.705, 1.5)).toBeLessThan(1);
  });
});

describe('smart focus', () => {
  const data = longCursor() as CursorData;

  test('finds the click clusters and the pause, in time order', () => {
    const e = findFocusEvents(data);
    expect(e.map((x) => x.kind)).toEqual(['dwell', 'clicks', 'dwell', 'clicks']);
    expect(e[1].clicks).toBe(2);
    expect(e[1].x).toBeCloseTo(0.75, 2);
    expect(e[1].y).toBeCloseTo(0.7, 2);
    expect(e[2].start).toBeGreaterThanOrEqual(4.9);
    expect(e[2].x).toBeCloseTo(0.3, 2);
    expect(e[3].start).toBeCloseTo(9, 1);
  });

  test('clicks far apart in time or space are separate clusters; a short rest is not a dwell', () => {
    const near = { samples: [{ t: 0, x: 0.5, y: 0.5 }, { t: 10, x: 0.5, y: 0.5 }], clicks: [{ t: 1, button: 'left' as const, down: true }, { t: 5, button: 'left' as const, down: true }], keys: [] };
    expect(findFocusEvents(near, { dwellSeconds: 99 }).filter((x) => x.kind === 'clicks')).toHaveLength(2);
    const quick = { samples: [{ t: 0, x: 0.1, y: 0.1 }, { t: 0.5, x: 0.1, y: 0.1 }, { t: 0.6, x: 0.9, y: 0.9 }], clicks: [], keys: [] };
    expect(findFocusEvents(quick)).toHaveLength(0);
    expect(findFocusEvents({ samples: [], clicks: [{ t: 1, button: 'left', down: true }], keys: [] })).toHaveLength(0);
  });

  test('zoom window fitting', () => {
    const canvas = { width: 1920, height: 1080 };
    const r = fitZoomRect({ x0: 1440, y0: 756, x1: 1440, y1: 756 }, canvas, 2, 150)!;
    expect(r.width).toBeCloseTo(960);
    expect(r.height).toBeCloseTo(540);
    expect(r.x + r.width).toBeLessThanOrEqual(1920 + 1e-6);
    expect(r.y + r.height).toBeLessThanOrEqual(1080 + 1e-6);
    expect(fitZoomRect({ x0: 100, y0: 100, x1: 1800, y1: 900 }, canvas, 2, 150)).toBeNull();
  });

  test('suggested regions are valid, inside the canvas and the clip, and do not overlap', () => {
    const { p } = projectWith(data);
    const z = suggestZooms(p);
    expect(z.length).toBeGreaterThanOrEqual(3);
    expect(new Set(z.map((r) => r.id)).size).toBe(z.length);
    z.forEach((r, i) => {
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.start + r.duration).toBeLessThanOrEqual(12 + 1e-6);
      expect(r.duration).toBeGreaterThanOrEqual(0.5);
      expect(r.x).toBeGreaterThanOrEqual(-1e-6);
      expect(r.y).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x + r.width).toBeLessThanOrEqual(1920 + 1e-6);
      expect(r.y + r.height).toBeLessThanOrEqual(1080 + 1e-6);
      expect(r.width / r.height).toBeCloseTo(16 / 9, 3);
      expect(r.easeIn).toBeGreaterThan(0);
      expect(r.easeOut).toBeGreaterThan(0);
      expect(r.ease).toBe('inOut');
      if (i) expect(r.start).toBeGreaterThanOrEqual(z[i - 1].start + z[i - 1].duration);
    });
    // The window around B (0.75, 0.70) contains that point.
    const b = z.find((r) => r.start < 3.2 && r.start + r.duration > 3.9)!;
    expect(b).toBeDefined();
    expect(b.x).toBeLessThan(0.75 * 1920);
    expect(b.x + b.width).toBeGreaterThan(0.75 * 1920);
    expect(b.y + b.height).toBeGreaterThan(0.7 * 1080);
  });

  test('accepting adds them in order; existing zooms are not overlapped; suggestions follow clip speed and position', () => {
    const { p } = projectWith(data);
    const z = suggestZooms(p);
    const added = addZoomRegions(p, z);
    expect(added.zooms.map((r) => r.start)).toEqual([...z.map((r) => r.start)].sort((a, b) => a - b));
    expect(addZoomRegions(added, z).zooms).toHaveLength(z.length);
    // Everything is already covered: nothing new is suggested over the same places.
    expect(suggestZooms(added)).toHaveLength(0);
    // Played at 2x and starting at 10 s on the timeline, the click at 3.2 s of media lands at 10 + 1.6 s.
    let q = createProject('t', 1920, 1080);
    q = addMedia(q, video('m', 12, data));
    const r = addClip(q, 'm', 10);
    const clip = { ...r.project.clips[0], speed: 2 };
    const fast = suggestZooms({ ...r.project, clips: [clip] });
    expect(fast.length).toBeGreaterThan(0);
    expect(fast.every((s) => s.start >= 10 - 1e-6)).toBe(true);
    const b = fast.find((s) => s.start < 11.6 && s.start + s.duration > 11.6);
    expect(b).toBeDefined();
  });

  test('media without cursor data, frozen clips and hidden tracks give nothing', () => {
    let p = createProject('t');
    p = addMedia(p, video('m', 12));
    p = addClip(p, 'm', 0).project;
    expect(suggestZooms(p)).toHaveLength(0);
    const { p: withData } = projectWith(data);
    expect(suggestZooms({ ...withData, clips: withData.clips.map((c) => ({ ...c, freeze: true })) })).toHaveLength(0);
    expect(suggestZooms({ ...withData, tracks: withData.tracks.map((t) => ({ ...t, hidden: true })) })).toHaveLength(0);
  });
});

describe('click sounds', () => {
  test('the click is deterministic, short, audible and ends in silence', () => {
    const a = synthClick(48000);
    const b = synthClick(48000);
    expect(a.length).toBe(2880);
    expect(Array.from(a.slice(0, 50))).toEqual(Array.from(b.slice(0, 50)));
    expect(Math.max(...a.map(Math.abs))).toBeGreaterThan(0.3);
    expect(Math.max(...a.map(Math.abs))).toBeLessThanOrEqual(1);
    expect(a[a.length - 1]).toBeCloseTo(0, 9);
  });

  test('times follow clip position, in point, speed, mute and the on switch', () => {
    const data = shortCursor() as CursorData;
    const { p } = projectWith(data, 3);
    expect(clickSoundTimes(p)).toHaveLength(0); // not switched on
    const on = setCursorFx(p, { clickSound: true, clickVolume: 0.8 });
    expect(clickSoundTimes(on).map((c) => c.t)).toEqual([0.5, 2.0, 2.2]);
    expect(clickSoundTimes(on)[0].volume).toBeCloseTo(0.8);
    // Trimmed to start 1 s in and placed at 5 s: the 2.0 s click is heard at 6.0 s.
    const moved = { ...on, clips: on.clips.map((c) => ({ ...c, start: 5, in: 1, duration: 2 })) };
    expect(clickSoundTimes(moved).map((c) => Math.round(c.t * 1000) / 1000)).toEqual([6, 6.2]);
    const fast = { ...moved, clips: moved.clips.map((c) => ({ ...c, speed: 2 })) };
    expect(clickSoundTimes(fast).map((c) => Math.round(c.t * 1000) / 1000)).toEqual([5.5, 5.6]);
    expect(clickSoundTimes({ ...on, tracks: on.tracks.map((t) => ({ ...t, muted: true })) })).toHaveLength(0);
    expect(clickSoundTimes(setCursorFx(on, { enabled: false }))).toHaveLength(0);
    expect(clickSoundTimes(setCursorFx(on, { clickVolume: 0 }))).toHaveLength(0);
  });
});

/** A canvas context that records what is drawn, for checking the drawing code without a browser. */
function recorder() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const gradient = { addColorStop() {} };
  const ctx = new Proxy(
    { canvas: {}, measureText: (s: string) => ({ width: s.length * 8 }), createRadialGradient: (...a: unknown[]) => (calls.push({ fn: 'createRadialGradient', args: a }), gradient) },
    {
      get(target, key: string) {
        if (key in target) return (target as Record<string, unknown>)[key];
        return (...args: unknown[]) => calls.push({ fn: key, args });
      },
      set() {
        return true;
      },
    },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('drawCursorFx', () => {
  const data = shortCursor() as CursorData;
  const layer = (sourceTime: number, extra: object = {}) => ({ data, sourceTime, rect: { x: 100, y: 50, width: 800, height: 600 }, canvas: { width: 1000, height: 700 }, ...extra });
  const fx = (patch: object) => parseCursorFx({ ...DEFAULT_CURSOR_FX, smoothing: 0, ...patch })!;

  test('nothing is drawn when disabled or when every effect is off', () => {
    const a = recorder();
    drawCursorFx(a.ctx, fx({ enabled: false, highlight: true }), layer(1));
    expect(a.calls).toHaveLength(0);
    const b = recorder();
    drawCursorFx(b.ctx, fx({}), layer(1));
    expect(b.calls.filter((c) => c.fn === 'arc' || c.fn === 'fillRect' || c.fn === 'fillText')).toHaveLength(0);
  });

  test('the halo is centred on the cursor, mapped into the clip rectangle', () => {
    const r = recorder();
    drawCursorFx(r.ctx, fx({ highlight: true, highlightSize: 0.1 }), layer(0.2));
    const arc = r.calls.find((c) => c.fn === 'arc')!;
    expect(arc.args[0]).toBeCloseTo(100 + 0.25 * 800, 6);
    expect(arc.args[1]).toBeCloseTo(50 + 0.3 * 600, 6);
    expect(arc.args[2]).toBeCloseTo(60, 6);
  });

  test('crop maps the position into the shown part of the frame', () => {
    const r = recorder();
    drawCursorFx(r.ctx, fx({ highlight: true, highlightSize: 0.1 }), layer(0.2, { crop: { x: 0.15, y: 0.2, width: 0.5, height: 0.5 } }));
    const arc = r.calls.find((c) => c.fn === 'arc')!;
    expect(arc.args[0]).toBeCloseTo(100 + ((0.25 - 0.15) / 0.5) * 800, 6);
    expect(arc.args[1]).toBeCloseTo(50 + ((0.3 - 0.2) / 0.5) * 600, 6);
  });

  test('a click ring appears at the click position only during its duration', () => {
    const rings = (t: number) => {
      const r = recorder();
      drawCursorFx(r.ctx, fx({ clickRings: true, clickDuration: 0.5, clickSize: 0.1 }), layer(t));
      return r.calls.filter((c) => c.fn === 'arc');
    };
    expect(rings(0.49)).toHaveLength(0);
    const at = rings(0.6);
    expect(at.length).toBe(2); // fill + stroke
    expect(at[0].args[0]).toBeCloseTo(100 + 0.25 * 800, 6);
    expect(rings(1.05)).toHaveLength(0);
    // A right click draws an extra inner ring.
    expect(rings(2.05)).toHaveLength(2);
    expect(rings(2.3)).toHaveLength(5); // the left ring (2) plus the right ring (2 + the inner ring)
  });

  test('key bubbles are drawn as text', () => {
    const r = recorder();
    drawCursorFx(r.ctx, fx({ keys: true }), layer(2.5));
    const text = r.calls.filter((c) => c.fn === 'fillText').map((c) => c.args[0]);
    expect(text).toEqual(['Ctrl', 'C']);
  });

  test('hiding the cursor skips the shape', () => {
    const shown = recorder();
    drawCursorFx(shown.ctx, fx({ showCursor: true }), layer(1));
    const hidden = recorder();
    drawCursorFx(hidden.ctx, fx({ showCursor: false }), layer(1));
    expect(shown.calls.some((c) => c.fn === 'lineTo')).toBe(true);
    expect(hidden.calls.filter((c) => c.fn === 'lineTo').length).toBe(3); // only the clip outline
  });
});
