import { describe, expect, test } from 'bun:test';
import { formatSrt, parseSubtitles, wrapCaption } from '../../src/engine/captions';
import { redactionAmount } from '../../src/engine/compositor';
import { addRedaction, removeRedaction, resizeCanvas, setCaptions, updateRedaction } from '../../src/engine/ops';
import { activeRedactionsAt, captionAt, createProject, parseProject } from '../../src/engine/project';
import { displayMediaOptions, surfaceProblem } from '../../src/engine/recorder';

describe('subtitles', () => {
  const srt = '﻿1\r\n00:00:01,500 --> 00:00:04,000\r\nHello <i>there</i>\r\nsecond line\r\n\r\n2\r\n00:00:05,000 --> 00:00:07,250\r\nBye\r\n';
  test('parses SRT with a BOM, CRLF, tags and two lines', () => {
    const c = parseSubtitles(srt);
    expect(c.length).toBe(2);
    expect(c[0]).toMatchObject({ start: 1.5, end: 4, text: 'Hello there\nsecond line' });
    expect(c[1]).toMatchObject({ start: 5, end: 7.25, text: 'Bye' });
  });
  test('parses WebVTT cues with dots and optional hours', () => {
    const c = parseSubtitles('WEBVTT\n\n00:02.000 --> 00:03.500 align:center\nShort\n\nnote\n01:00:00.000 --> 01:00:01.000\nLong');
    expect(c.map((x) => [x.start, x.end, x.text])).toEqual([
      [2, 3.5, 'Short'],
      [3600, 3601, 'Long'],
    ]);
  });
  test('skips cues with bad or reversed times', () => {
    expect(parseSubtitles('1\n00:00:05,000 --> 00:00:01,000\nBackwards\n\n2\nnot a time\nNope').length).toBe(0);
  });
  test('round-trips through formatSrt', () => {
    const c = parseSubtitles(srt);
    const again = parseSubtitles(formatSrt(c));
    expect(again.map((x) => [x.start, x.end, x.text])).toEqual(c.map((x) => [x.start, x.end, x.text]));
    expect(formatSrt(c)).toContain('00:00:01,500 --> 00:00:04,000');
  });
  test('wraps to the width, keeps breaks, caps the line count', () => {
    const measure = (s: string) => s.length * 10;
    expect(wrapCaption('one two three four', measure, 90)).toEqual(['one two', 'three', 'four']);
    expect(wrapCaption('a\nb', measure, 1000)).toEqual(['a', 'b']);
    expect(wrapCaption('w1 w2 w3 w4 w5', measure, 20, 2)).toEqual(['w1', 'w2…']);
  });
});

describe('captions on the project', () => {
  test('setCaptions sorts, drops empty and zero-length cues', () => {
    let p = createProject();
    p = setCaptions(p, [
      { id: 'b', start: 5, end: 6, text: 'later' },
      { id: 'a', start: 1, end: 2, text: 'first' },
      { id: 'x', start: 3, end: 3, text: 'zero' },
      { id: 'y', start: 4, end: 5, text: '   ' },
    ]);
    expect(p.captions.map((c) => c.id)).toEqual(['a', 'b']);
    expect(captionAt(p, 1.5)?.text).toBe('first');
    expect(captionAt(p, 2)).toBeUndefined();
  });
});

describe('blur regions', () => {
  test('addRedaction centres a region at the playhead', () => {
    const { project, id } = addRedaction(createProject(), 2);
    const r = project.redactions.find((x) => x.id === id)!;
    expect(r).toMatchObject({ start: 2, duration: 3, mode: 'blur', width: 480, height: 135, x: 720, y: 473 });
    expect(activeRedactionsAt(project, 4.9).length).toBe(1);
    expect(activeRedactionsAt(project, 5).length).toBe(0);
  });
  test('updateRedaction keeps the box on the canvas and at least 8 px', () => {
    const { project, id } = addRedaction(createProject(), 0);
    const moved = updateRedaction(project, id, { x: 5000, y: -40, width: 2, height: 99999, strength: 400 });
    expect(moved.redactions[0]).toMatchObject({ x: 1912, y: 0, width: 8, height: 1080, strength: 100 });
    expect(updateRedaction(project, 'missing', { x: 1 })).toBe(project);
  });
  test('removeRedaction', () => {
    const { project, id } = addRedaction(createProject(), 0);
    expect(removeRedaction(project, id).redactions.length).toBe(0);
    expect(removeRedaction(project, 'nope')).toBe(project);
  });
  test('resizeCanvas scales regions with the clips', () => {
    const { project } = addRedaction(createProject(), 0, { x: 100, y: 100, width: 400, height: 200 });
    const half = resizeCanvas(project, 960, 540);
    expect(half.redactions[0]).toMatchObject({ x: 50, y: 50, width: 200, height: 100 });
    expect([half.width, half.height]).toEqual([960, 540]);
  });
  test('strength scales with the canvas and never drops below 4 px', () => {
    expect(redactionAmount({ mode: 'blur', strength: 100 }, 1080)).toBe(43);
    expect(redactionAmount({ mode: 'pixelate', strength: 100 }, 1080)).toBe(54);
    expect(redactionAmount({ mode: 'blur', strength: 1 }, 1080)).toBe(4);
  });
});

describe('saved projects', () => {
  test('a project saved before regions and captions loads with empty lists', () => {
    const old = { ...createProject() } as Record<string, unknown>;
    delete old.redactions;
    delete old.captions;
    const p = parseProject(JSON.parse(JSON.stringify(old)));
    expect(p.redactions).toEqual([]);
    expect(p.captions).toEqual([]);
  });
  test('regions and captions are validated on load', () => {
    const raw = {
      ...createProject(),
      redactions: [{ id: 'r', start: -3, duration: 0, x: -10, y: 2000, width: 10000, height: 4, mode: 'weird', strength: 'x' }, null],
      captions: [
        { id: 'c2', start: 4, end: 5, text: 'b' },
        { id: 'c1', start: 1, end: 2, text: 'a' },
        { id: 'bad', start: 3, end: 2, text: 'reversed' },
        { id: 'num', start: 0, end: 1, text: 42 },
      ],
    };
    const p = parseProject(JSON.parse(JSON.stringify(raw)));
    expect(p.redactions.length).toBe(1);
    expect(p.redactions[0]).toMatchObject({ start: 0, x: 0, width: 1920, height: 8, y: 1072, mode: 'blur', strength: 60 });
    expect(p.captions.map((c) => c.id)).toEqual(['c1', 'c2']);
  });
});

describe('recorder capture options', () => {
  const base = { microphone: false, systemAudio: false, frameRate: 30, maxWidth: 1920, maxHeight: 1080 };
  test('a tab or window request excludes screens and the editor itself', () => {
    for (const surface of ['browser', 'window'] as const) {
      const o = displayMediaOptions({ ...base, surface });
      expect(o.monitorTypeSurfaces).toBe('exclude');
      expect(o.selfBrowserSurface).toBe('exclude');
      expect((o.video as Record<string, unknown>).displaySurface).toBe(surface);
    }
  });
  test('an entire-screen request offers screens; size is capped, never forced up', () => {
    const o = displayMediaOptions({ ...base, surface: 'monitor' });
    expect(o.monitorTypeSurfaces).toBe('include');
    expect((o.video as MediaTrackConstraints).width).toEqual({ max: 1920 });
    expect((o.video as MediaTrackConstraints).height).toEqual({ max: 1080 });
  });
  test('the shared surface must match a tab or window request', () => {
    expect(surfaceProblem('browser', { displaySurface: 'browser' })).toBeNull();
    expect(surfaceProblem('window', { displaySurface: 'window' })).toBeNull();
    expect(surfaceProblem('monitor', { displaySurface: 'window' })).toBeNull();
    expect(surfaceProblem('browser', { displaySurface: 'monitor' })).toContain('the entire screen');
    expect(surfaceProblem('window', { displaySurface: 'browser' })).toContain('a browser tab');
    expect(surfaceProblem('browser', {})).toContain('cannot confirm');
  });
});
