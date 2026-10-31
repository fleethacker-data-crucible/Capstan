import { describe, expect, test } from 'bun:test';
import { addMedia } from '../../src/engine/ops';
import { type MediaItem, createProject, newId } from '../../src/engine/project';
import { displayMediaOptions, type Recording } from '../../src/engine/recorder';
import { defaultSettings, importRecordingSet, maxSeconds, placeAtEnd, primaryClip, settingsToPrefs, toRecordOptions } from '../../src/engine/recording-flow';

const item = (kind: MediaItem['kind'], name: string, width = 0, height = 0): MediaItem => ({
  id: newId('med'),
  name,
  kind,
  mime: kind === 'audio' ? 'audio/webm' : 'video/webm',
  bytes: 10,
  duration: 4,
  width,
  height,
  hasAudio: true,
  createdAt: 0,
});

describe('cursor option', () => {
  const base = { microphone: false, systemAudio: false, frameRate: 30 };
  test('the pointer is left to the browser by default, hidden only when asked', () => {
    expect((displayMediaOptions(base).video as Record<string, unknown>).cursor).toBeUndefined();
    expect((displayMediaOptions({ ...base, hideCursor: false }).video as Record<string, unknown>).cursor).toBeUndefined();
    expect((displayMediaOptions({ ...base, hideCursor: true }).video as Record<string, unknown>).cursor).toBe('never');
  });
});

describe('settings', () => {
  test('defaults keep the single mixed track, no webcam, no region, cursor shown', () => {
    const s = defaultSettings();
    expect(s).toMatchObject({ separateAudio: false, webcam: false, pickRegion: false, hideCursor: false, toDisk: true, countdown: 3, addToTimeline: true });
  });
  test('settings become recorder options for the project', () => {
    const project = createProject('p', 1280, 720, 60);
    const o = toRecordOptions({ ...defaultSettings(), webcam: true, cameraId: 'c1', webcamResolution: '1080', separateAudio: true, hideCursor: true }, project, null);
    expect(o).toMatchObject({ frameRate: 60, maxWidth: 1280, maxHeight: 720, separateAudio: true, hideCursor: true, store: null });
    expect(o.webcam).toMatchObject({ deviceId: 'c1', width: 1920, height: 1080 });
    expect(toRecordOptions(defaultSettings(), project, null).webcam).toBeNull();
  });
  test('only the remembered part goes to prefs; the limit is in seconds', () => {
    const s = { ...defaultSettings(), webcam: true, maxMinutes: 2, countdown: 5 as const };
    expect(settingsToPrefs(s)).toEqual({ countdown: 5, maxMinutes: 2, toDisk: true, separateAudio: false, webcamPip: true, webcamResolution: '720' });
    expect(maxSeconds(s)).toBe(120);
  });
});

describe('importing a finished recording', () => {
  const rec = (parts: Recording['parts']): Recording => ({
    blob: new Blob(['x'], { type: 'video/webm' }),
    seconds: 4,
    name: 'Recording a.webm',
    width: 640,
    height: 360,
    parts,
    notes: [],
    session: null,
  });
  const part = (role: 'webcam' | 'mic' | 'system', name: string) => ({ role, blob: new Blob(['y'], { type: 'video/webm' }), name, seconds: 4, width: 0, height: 0 });

  test('screen first, then each part, with the hints the recorder knows', async () => {
    const seen: Array<[string, unknown]> = [];
    const out = await importRecordingSet(rec([part('webcam', 'Webcam a.webm'), part('mic', 'Microphone a.webm')]), async (file, hints) => {
      seen.push([file.name, hints]);
      return item(file.name.startsWith('Micro') ? 'audio' : 'video', file.name);
    });
    expect(out.parts.map((p) => p.role)).toEqual(['screen', 'webcam', 'mic']);
    expect(seen[0]).toEqual(['Recording a.webm', { duration: 4, width: 640, height: 360 }]);
    expect(out.problems).toEqual([]);
  });

  test('a failing extra part is reported but the rest lands; a failing screen file throws', async () => {
    const out = await importRecordingSet(rec([part('webcam', 'Webcam a.webm'), part('mic', 'Microphone a.webm')]), async (file) => {
      if (file.name.startsWith('Webcam')) throw new Error('could not decode');
      return item('video', file.name);
    });
    expect(out.parts.map((p) => p.role)).toEqual(['screen', 'mic']);
    expect(out.problems).toEqual(['Webcam a.webm: could not decode']);
    await expect(importRecordingSet(rec([]), async () => Promise.reject(new Error('no')))).rejects.toThrow('no');
  });

  test('placeAtEnd puts the set after existing clips and names the clip to select', () => {
    const screen = item('video', 's', 640, 360);
    const cam = item('video', 'c', 640, 480);
    let project = addMedia(addMedia(createProject('p'), screen), cam);
    const first = placeAtEnd(project, [{ role: 'screen', media: screen }], { pip: true })!;
    project = first.project;
    const second = placeAtEnd(project, [{ role: 'screen', media: screen }, { role: 'webcam', media: cam }], { pip: true })!;
    const clip = second.project.clips.find((c) => c.id === primaryClip(second))!;
    expect(clip.start).toBeCloseTo(4);
    expect(second.project.clips).toHaveLength(3);
    expect(placeAtEnd(project, [], { pip: true })).toBeNull();
  });
});
