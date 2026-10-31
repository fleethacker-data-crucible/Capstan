import { describe, expect, test } from 'bun:test';
import { clipRect } from '../../src/engine/compositor';
import { addMedia } from '../../src/engine/ops';
import { type MediaItem, createProject, newId } from '../../src/engine/project';
import {
  DEFAULT_PREFS,
  countdownValue,
  limitState,
  minutesToSeconds,
  parsePrefs,
  pipProps,
  placeRecordingSet,
  warningLead,
  webcamConstraints,
  webcamOptions,
} from '../../src/engine/recording-sources';
import { ASPECT_PRESETS, aspectRatio, clampRect, cropToRect, fitAspect, fullRect, moveRect, rectToCrop, resizeRect, setRectField } from '../../src/engine/region';
import { extensionFor } from '../../src/engine/recorder';

const media = (kind: MediaItem['kind'], name: string, width = 0, height = 0, duration = 5): MediaItem => ({
  id: newId('med'),
  name,
  kind,
  mime: kind === 'audio' ? 'audio/webm' : 'video/webm',
  bytes: 1000,
  duration,
  width,
  height,
  hasAudio: true,
  createdAt: 0,
});

describe('webcam options', () => {
  test('constraints ask for the chosen device and size, video only', () => {
    const c = webcamConstraints(webcamOptions('cam-2', '1080'));
    expect(c.audio).toBe(false);
    const v = c.video as MediaTrackConstraints;
    expect(v.deviceId).toEqual({ exact: 'cam-2' });
    expect(v.width).toEqual({ ideal: 1920 });
    expect(v.height).toEqual({ ideal: 1080 });
  });
  test('the default camera sets no device id; unknown resolutions fall back to 720p', () => {
    const v = webcamConstraints(webcamOptions('', 'nope')).video as MediaTrackConstraints;
    expect(v.deviceId).toBeUndefined();
    expect(v.width).toEqual({ ideal: 1280 });
  });
});

describe('preferences', () => {
  test('defaults, and bad values are repaired', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{')).toEqual(DEFAULT_PREFS);
    const p = parsePrefs(JSON.stringify({ countdown: 4, maxMinutes: -3, toDisk: false, separateAudio: true, webcamResolution: 'x' }));
    expect(p).toMatchObject({ countdown: 3, maxMinutes: 0, toDisk: false, separateAudio: true, webcamResolution: '720' });
    expect(parsePrefs(JSON.stringify({ countdown: 5, maxMinutes: 30 }))).toMatchObject({ countdown: 5, maxMinutes: 30 });
  });
});

describe('countdown and limits', () => {
  test('the countdown shows 3, 2, 1 then 0', () => {
    expect([3000, 2999, 2000, 1999, 1000, 1, 0, -50].map(countdownValue)).toEqual([3, 3, 2, 2, 1, 1, 0, 0]);
  });
  test('warning lead is a tenth of the limit, between 2 and 30 seconds', () => {
    expect(warningLead(6)).toBe(2);
    expect(warningLead(120)).toBe(12);
    expect(warningLead(3600)).toBe(30);
  });
  test('limit state: none, running, warning, reached', () => {
    expect(limitState(100, 0)).toEqual({ remaining: null, warn: false, reached: false });
    expect(limitState(10, 120)).toMatchObject({ remaining: 110, warn: false, reached: false });
    expect(limitState(110, 120)).toMatchObject({ remaining: 10, warn: true, reached: false });
    expect(limitState(120, 120)).toMatchObject({ remaining: 0, warn: false, reached: true });
    expect(limitState(500, 120).reached).toBe(true);
  });
  test('minutes convert, and junk means no limit', () => {
    expect(minutesToSeconds(1.5)).toBe(90);
    expect(minutesToSeconds(0)).toBe(0);
    expect(minutesToSeconds(Number.NaN)).toBe(0);
    expect(minutesToSeconds(-2)).toBe(0);
  });
  test('file extensions follow the recorder type', () => {
    expect(extensionFor('video/mp4;codecs=avc1')).toBe('mp4');
    expect(extensionFor('audio/ogg;codecs=opus')).toBe('ogg');
    expect(extensionFor('audio/webm;codecs=opus')).toBe('webm');
    expect(extensionFor('')).toBe('webm');
  });
});

describe('picture-in-picture', () => {
  test('a 16:9 webcam at 0.25 sits in the lower right with a margin', () => {
    const project = createProject('p', 1920, 1080);
    const p = pipProps(project, { width: 1280, height: 720 });
    expect(p.scale).toBe(0.25);
    // 480x270 on a 1920x1080 canvas, 32 px (3% of 1080) from the edges.
    expect(p.x).toBe(1920 - 32 - 240);
    expect(p.y).toBe(1080 - 32 - 135);
  });
  test('a 4:3 webcam is placed by its fitted size and stays inside the canvas', () => {
    const project = createProject('p', 1920, 1080);
    const p = pipProps(project, { width: 640, height: 480 });
    const m = media('video', 'w', 640, 480);
    const rect = clipRect({ ...project, media: [m] }, { id: 'c', trackId: 't', mediaId: m.id, start: 0, in: 0, duration: 1, props: p }, undefined);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1920 - 32 + 1);
    expect(rect.y + rect.height).toBeLessThanOrEqual(1080 - 32 + 1);
    expect(rect.width).toBeCloseTo(1080 * (4 / 3) * 0.25, 0);
  });
});

describe('placeRecordingSet', () => {
  const setup = () => {
    const screen = media('video', 'screen', 1280, 720, 8);
    const cam = media('video', 'cam', 640, 480, 8);
    const mic = media('audio', 'mic', 0, 0, 8);
    const sys = media('audio', 'sys', 0, 0, 8);
    let project = createProject('p', 1920, 1080);
    for (const m of [screen, cam, mic, sys]) project = addMedia(project, m);
    return { project, screen, cam, mic, sys };
  };

  test('screen only: one clip, the crop applied, nothing else touched', () => {
    const { project, screen } = setup();
    const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    const { project: out, clips } = placeRecordingSet(project, [{ role: 'screen', media: screen }], 2, { pip: true, crop });
    expect(out.clips).toHaveLength(1);
    expect(out.clips[0].start).toBe(2);
    expect(out.clips[0].crop).toEqual(crop);
    expect(clips.screen).toBe(out.clips[0].id);
  });

  test('screen and webcam: separate tracks, same start, the webcam above and in the corner', () => {
    const { project, screen, cam } = setup();
    const { project: out } = placeRecordingSet(
      project,
      [
        { role: 'screen', media: screen },
        { role: 'webcam', media: cam },
      ],
      0,
      { pip: true },
    );
    expect(out.clips).toHaveLength(2);
    const s = out.clips.find((c) => c.mediaId === screen.id)!;
    const w = out.clips.find((c) => c.mediaId === cam.id)!;
    expect(s.trackId).not.toBe(w.trackId);
    expect(s.start).toBe(w.start);
    // Later tracks are drawn on top.
    expect(out.tracks.findIndex((t) => t.id === w.trackId)).toBeGreaterThan(out.tracks.findIndex((t) => t.id === s.trackId));
    expect(out.tracks.find((t) => t.id === w.trackId)?.name).toBe('Webcam');
    expect(w.props.scale).toBe(0.25);
    expect(w.props.x).toBeGreaterThan(1920 / 2);
    expect(w.props.y).toBeGreaterThan(1080 / 2);
    expect(out.media.find((m) => m.id === cam.id)?.hasAudio).toBe(false);
  });

  test('without picture-in-picture the webcam is full frame on its own track', () => {
    const { project, screen, cam } = setup();
    const { project: out } = placeRecordingSet(project, [{ role: 'screen', media: screen }, { role: 'webcam', media: cam }], 0, { pip: false });
    const w = out.clips.find((c) => c.mediaId === cam.id)!;
    expect(w.props.scale).toBe(1);
  });

  test('separate audio: screen, mic and system each on their own track from the same moment', () => {
    const { project, screen, mic, sys } = setup();
    const { project: out, clips } = placeRecordingSet(
      project,
      [
        { role: 'screen', media: screen },
        { role: 'mic', media: mic },
        { role: 'system', media: sys },
      ],
      1.5,
      { pip: true },
    );
    expect(out.clips).toHaveLength(3);
    expect(new Set(out.clips.map((c) => c.trackId)).size).toBe(3);
    expect(out.clips.every((c) => c.start === 1.5)).toBe(true);
    expect(out.tracks.map((t) => t.name)).toEqual(expect.arrayContaining(['Microphone', 'System audio']));
    expect(Object.keys(clips).sort()).toEqual(['mic', 'screen', 'system']);
  });

  test('an existing track with room is reused for the screen; extras still get new tracks', () => {
    const { project, screen, cam } = setup();
    const first = placeRecordingSet(project, [{ role: 'screen', media: screen }], 0, { pip: true }).project;
    const tracksBefore = first.tracks.length;
    const out = placeRecordingSet(first, [{ role: 'screen', media: screen }, { role: 'webcam', media: cam }], 8, { pip: true }).project;
    expect(out.tracks.length).toBe(tracksBefore + 1);
  });

  test('media missing from the project is skipped', () => {
    const { project, screen } = setup();
    const ghost = media('video', 'ghost');
    const { project: out, clips } = placeRecordingSet(project, [{ role: 'screen', media: screen }, { role: 'webcam', media: ghost }], 0, { pip: true });
    expect(out.clips).toHaveLength(1);
    expect(clips.webcam).toBeUndefined();
  });
});

describe('region geometry', () => {
  const bounds = { width: 1280, height: 720 };

  test('clamp keeps the rectangle inside the frame and at least 16 px', () => {
    expect(clampRect({ x: -10, y: 700, width: 2000, height: 5 }, bounds)).toEqual({ x: 0, y: 700, width: 1280, height: 16 });
  });

  test('moving never leaves the frame', () => {
    const r = moveRect({ x: 100, y: 100, width: 300, height: 200 }, 5000, -5000, bounds);
    expect(r).toEqual({ x: 980, y: 0, width: 300, height: 200 });
  });

  test('free resize moves only the dragged edges, in bounds, with a minimum size', () => {
    const r = { x: 100, y: 100, width: 300, height: 200 };
    expect(resizeRect(r, 'se', 50, 40, bounds)).toEqual({ x: 100, y: 100, width: 350, height: 240 });
    expect(resizeRect(r, 'nw', -50, -40, bounds)).toEqual({ x: 50, y: 60, width: 350, height: 240 });
    expect(resizeRect(r, 'e', 5000, 0, bounds)).toEqual({ x: 100, y: 100, width: 1180, height: 200 });
    expect(resizeRect(r, 'w', 5000, 0, bounds)).toEqual({ x: 384, y: 100, width: 16, height: 200 });
  });

  test('aspect resize keeps the shape, grows from the opposite corner and stays in bounds', () => {
    const r = { x: 100, y: 100, width: 320, height: 180 };
    const bigger = resizeRect(r, 'se', 160, 0, bounds, 16 / 9);
    expect(bigger.x).toBe(100);
    expect(bigger.y).toBe(100);
    expect(bigger.width / bigger.height).toBeCloseTo(16 / 9, 1);
    expect(bigger.width).toBeGreaterThanOrEqual(480);
    const huge = resizeRect(r, 'se', 9000, 9000, bounds, 16 / 9);
    expect(huge.x + huge.width).toBeLessThanOrEqual(1280);
    expect(huge.y + huge.height).toBeLessThanOrEqual(720);
    expect(huge.width / huge.height).toBeCloseTo(16 / 9, 1);
    const side = resizeRect(r, 'e', 100, 0, bounds, 16 / 9);
    expect(side.width / side.height).toBeCloseTo(16 / 9, 1);
    expect(side.y + side.height / 2).toBeCloseTo(190, 0);
  });

  test('fitting an aspect keeps the middle and does not grow', () => {
    const r = fitAspect({ x: 100, y: 100, width: 400, height: 400 }, 16 / 9, bounds);
    expect(r.width).toBe(400);
    expect(r.height).toBe(225);
    expect(Math.abs(r.y + r.height / 2 - 300)).toBeLessThanOrEqual(1);
    const tall = fitAspect({ x: 100, y: 100, width: 400, height: 200 }, 9 / 16, bounds);
    expect(tall.height).toBe(200);
    expect(tall.width).toBe(113);
    expect(fitAspect({ x: 1, y: 2, width: 30, height: 40 }, null, bounds)).toEqual({ x: 1, y: 2, width: 30, height: 40 });
  });

  test('typing a field keeps the aspect when locked', () => {
    const r = { x: 0, y: 0, width: 320, height: 180 };
    expect(setRectField(r, 'width', 640, bounds, 16 / 9)).toEqual({ x: 0, y: 0, width: 640, height: 360 });
    expect(setRectField(r, 'height', 90, bounds, 16 / 9)).toEqual({ x: 0, y: 0, width: 160, height: 90 });
    expect(setRectField(r, 'x', 99999, bounds)).toEqual({ x: 960, y: 0, width: 320, height: 180 });
    expect(setRectField(r, 'width', Number.NaN, bounds)).toBe(r);
  });

  test('presets resolve; the canvas preset follows the project', () => {
    expect(aspectRatio('free', bounds)).toBeNull();
    expect(aspectRatio('canvas', { width: 1000, height: 500 })).toBe(2);
    expect(aspectRatio('4:3', bounds)).toBeCloseTo(4 / 3);
    expect(ASPECT_PRESETS.map((p) => p.id)).toContain('9:16');
  });

  test('a region becomes crop fractions, and back', () => {
    const crop = rectToCrop({ x: 320, y: 180, width: 640, height: 360 }, bounds);
    expect(crop).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    expect(cropToRect(crop, bounds)).toEqual({ x: 320, y: 180, width: 640, height: 360 });
    expect(rectToCrop(fullRect(bounds), bounds)).toBeUndefined();
    expect(cropToRect(undefined, bounds)).toEqual(fullRect(bounds));
  });
});
