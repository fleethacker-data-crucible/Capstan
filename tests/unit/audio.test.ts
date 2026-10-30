import { describe, expect, test } from 'bun:test';
import { addVolumePoint, applyProcessedAudio, clearVolumePoints, moveVolumePoint, removeVolumePoint, updateClipAudio } from '../../src/engine/audioops';
import { parseClipAudio } from '../../src/engine/audiofx';
import { DEFAULT_DUCK, duckEnvelope, levelEnvelopeDb } from '../../src/engine/dsp/duck';
import { FFT } from '../../src/engine/dsp/fft';
import { levelAudio, limiterGain, loudnessDb, peakDb } from '../../src/engine/dsp/level';
import { reduceNoise, rmsDb } from '../../src/engine/dsp/noise';
import { decodeWav, encodeWav } from '../../src/engine/dsp/wav';
import { clearLevelEnvelopes, clipGainAt, duckGainAt, fadeGain, fadeShape, planClipGain, previewVolume, setLevelEnvelope } from '../../src/engine/gain';
import { addClip, addMedia } from '../../src/engine/ops';
import { computePeaks, peakWindow } from '../../src/engine/peaks';
import { type Clip, type MediaItem, type Project, createProject, parseProject } from '../../src/engine/project';

// ---- helpers ------------------------------------------------------------------------------------------------

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
function gaussian(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}
const SR = 48000;

function mediaItem(id: string, kind: 'audio' | 'video', duration: number): MediaItem {
  return { id, name: `${id}.${kind === 'audio' ? 'wav' : 'webm'}`, kind, mime: kind === 'audio' ? 'audio/wav' : 'video/webm', bytes: 1, duration, width: kind === 'video' ? 640 : 0, height: kind === 'video' ? 360 : 0, hasAudio: true, createdAt: 0 };
}

/** A project with one music clip on the first track and one narration clip on the second, both 10 s long. */
function twoTrackProject(): { project: Project; music: Clip; voice: Clip } {
  let p = createProject('t', 640, 360, 30);
  p = addMedia(p, mediaItem('music', 'audio', 10));
  p = addMedia(p, mediaItem('voice', 'audio', 10));
  let r = addClip(p, 'music', 0, p.tracks[0].id);
  p = r.project;
  const musicId = r.clipId!;
  r = addClip(p, 'voice', 0, p.tracks[1].id);
  p = r.project;
  const voiceId = r.clipId!;
  return { project: p, music: p.clips.find((c) => c.id === musicId)!, voice: p.clips.find((c) => c.id === voiceId)! };
}

function setClip(p: Project, id: string, patch: Partial<Clip>): Project {
  return { ...p, clips: p.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

// ---- gain function ------------------------------------------------------------------------------------------

describe('fades', () => {
  test('shapes run 0..1; smooth is an S curve', () => {
    expect(fadeShape(0, 'linear')).toBe(0);
    expect(fadeShape(1, 'linear')).toBe(1);
    expect(fadeShape(0.25, 'linear')).toBeCloseTo(0.25, 9);
    expect(fadeShape(0.25, 'smooth')).toBeLessThan(0.25);
    expect(fadeShape(0.5, 'smooth')).toBeCloseTo(0.5, 9);
    expect(fadeShape(0.75, 'smooth')).toBeGreaterThan(0.75);
    expect(fadeShape(-1, 'linear')).toBe(0);
    expect(fadeShape(9, 'smooth')).toBe(1);
  });

  test('fade in and fade out multiply, and no fade is unity', () => {
    expect(fadeGain(undefined, 10, 3)).toBe(1);
    const a = { fadeIn: 2, fadeOut: 2 };
    expect(fadeGain(a, 10, 0)).toBe(0);
    expect(fadeGain(a, 10, 1)).toBeCloseTo(0.5, 9);
    expect(fadeGain(a, 10, 5)).toBe(1);
    expect(fadeGain(a, 10, 9)).toBeCloseTo(0.5, 9);
    expect(fadeGain(a, 10, 10)).toBe(0);
  });
});

describe('clipGainAt', () => {
  test('plain volume, clamped time, silent and freeze', () => {
    const { project, music } = twoTrackProject();
    expect(clipGainAt(project, music, 3)).toBe(1);
    const p2 = setClip(project, music.id, { props: { ...music.props, volume: 0.4 } });
    expect(clipGainAt(p2, p2.clips[0], 3)).toBeCloseTo(0.4, 9);
    expect(clipGainAt(p2, p2.clips[0], -5)).toBeCloseTo(0.4, 9);
    const p3 = setClip(project, music.id, { audio: { silent: true } });
    expect(clipGainAt(p3, p3.clips[0], 3)).toBe(0);
    const p4 = setClip(project, music.id, { freeze: true });
    expect(clipGainAt(p4, p4.clips[0], 3)).toBe(0);
  });

  test('fade in ramps from silence, fade out ramps to silence', () => {
    const { project, music } = twoTrackProject();
    const p = setClip(project, music.id, { audio: { fadeIn: 2, fadeOut: 1 } });
    const c = p.clips[0];
    expect(clipGainAt(p, c, 0)).toBe(0);
    expect(clipGainAt(p, c, 1)).toBeCloseTo(0.5, 9);
    expect(clipGainAt(p, c, 5)).toBe(1);
    expect(clipGainAt(p, c, 9.5)).toBeCloseTo(0.5, 9);
    expect(clipGainAt(p, c, 10)).toBe(0);
  });

  test('volume points override the slider and interpolate; a fade multiplies them', () => {
    const { project, music } = twoTrackProject();
    let p = addVolumePoint(project, music.id, 0, 0.2);
    p = addVolumePoint(p, music.id, 4, 1.0);
    p = addVolumePoint(p, music.id, 8, 0.0);
    let c = p.clips[0];
    expect(c.keys?.volume?.map((k) => [k.t, k.v])).toEqual([[0, 0.2], [4, 1], [8, 0]]);
    expect(clipGainAt(p, c, 0)).toBeCloseTo(0.2, 9);
    expect(clipGainAt(p, c, 2)).toBeCloseTo(0.6, 9);
    expect(clipGainAt(p, c, 6)).toBeCloseTo(0.5, 9);
    expect(clipGainAt(p, c, 9.5)).toBe(0);
    p = updateClipAudio(p, music.id, { fadeIn: 4 });
    c = p.clips[0];
    expect(clipGainAt(p, c, 2)).toBeCloseTo(0.6 * 0.5, 9);
  });

  test('gain above 1 is kept for the export and capped to 1 for the preview element', () => {
    const { project, music } = twoTrackProject();
    const p = addVolumePoint(project, music.id, 0, 1.6);
    expect(clipGainAt(p, p.clips[0], 1)).toBeCloseTo(1.6, 9);
    expect(previewVolume(p, p.clips[0], 1)).toBe(1);
    const q = setClip(project, music.id, { props: { ...music.props, volume: 0.3 } });
    expect(previewVolume(q, q.clips[0], 1)).toBeCloseTo(0.3, 9);
  });

  test('planClipGain is a constant without automation and a sampled curve with it', () => {
    const { project, music } = twoTrackProject();
    expect(planClipGain(project, music)).toEqual({ value: 1 });
    const p = setClip(project, music.id, { audio: { fadeIn: 1 } });
    const plan = planClipGain(p, p.clips[0], 50);
    expect(plan.curve).toBeDefined();
    expect(plan.curve!.length).toBe(10 * 50 + 1);
    expect(plan.curve![0]).toBe(0);
    expect(plan.curve![25]).toBeCloseTo(0.5, 2);
    expect(plan.curve![plan.curve!.length - 1]).toBe(1);
  });

  test('point edits: move, remove, clear', () => {
    const { project, music } = twoTrackProject();
    let p = addVolumePoint(project, music.id, 1, 0.5);
    p = addVolumePoint(p, music.id, 5, 1.5);
    p = moveVolumePoint(p, music.id, 1, 3, 0.25);
    expect(p.clips[0].keys?.volume?.map((k) => [k.t, k.v])).toEqual([[3, 0.25], [5, 1.5]]);
    p = removeVolumePoint(p, music.id, 3);
    expect(p.clips[0].keys?.volume?.length).toBe(1);
    p = clearVolumePoints(p, music.id);
    expect(p.clips[0].keys).toBeUndefined();
    expect(addVolumePoint(project, music.id, 99, 5).clips[0].keys?.volume?.[0]).toMatchObject({ t: 10, v: 2 });
  });
});

describe('ducking in the gain function', () => {
  // The narration speaks from 2 s to 4 s and 6 s to 7 s; elsewhere it is silent (-90 dB).
  function narration(): Float32Array {
    const env = new Float32Array(1000).fill(-90);
    for (let i = 200; i < 400; i++) env[i] = -20;
    for (let i = 600; i < 700; i++) env[i] = -20;
    return env;
  }

  test('music gain drops while the narration speaks and recovers after', () => {
    clearLevelEnvelopes();
    const { project, voice } = twoTrackProject();
    const p = setClip(project, voice.id, { audio: { duck: { ...DEFAULT_DUCK, reductionDb: 12, attack: 0.05, release: 0.3 } } });
    setLevelEnvelope('voice', { rate: 100, db: narration() });
    const music = p.clips.find((c) => c.mediaId === 'music')!;
    const lin = (db: number) => 10 ** (db / 20);
    expect(clipGainAt(p, music, 1)).toBeCloseTo(1, 3);
    expect(clipGainAt(p, music, 3.5)).toBeCloseTo(lin(-12), 1);
    expect(clipGainAt(p, music, 3.5)).toBeLessThan(0.3);
    // After 4 s the hold (0.2 s) and the release bring it back.
    expect(clipGainAt(p, music, 4.1)).toBeLessThan(0.3);
    expect(clipGainAt(p, music, 5.5)).toBeGreaterThan(0.95);
    // The second phrase ducks again.
    expect(clipGainAt(p, music, 6.6)).toBeLessThan(0.35);
    expect(clipGainAt(p, music, 9)).toBeGreaterThan(0.99);
    // The narration itself is never ducked.
    expect(clipGainAt(p, p.clips.find((c) => c.id === voice.id)!, 3)).toBe(1);
    clearLevelEnvelopes();
  });

  test('no ducking without ducking switched on, without a measured envelope, or from a muted track', () => {
    clearLevelEnvelopes();
    const { project, voice } = twoTrackProject();
    const music = project.clips.find((c) => c.mediaId === 'music')!;
    setLevelEnvelope('voice', { rate: 100, db: narration() });
    expect(duckGainAt(project, music, 3)).toBe(1);
    const on = setClip(project, voice.id, { audio: { duck: { ...DEFAULT_DUCK } } });
    expect(duckGainAt(on, music, 3)).toBeLessThan(0.3);
    clearLevelEnvelopes();
    expect(duckGainAt(on, music, 3)).toBe(1);
    setLevelEnvelope('voice', { rate: 100, db: narration() });
    const muted = { ...on, tracks: on.tracks.map((t) => (t.id === voice.trackId ? { ...t, muted: true } : t)) };
    expect(duckGainAt(muted, music, 3)).toBe(1);
    clearLevelEnvelopes();
  });

  test('the ducked gain feeds the export plan as automation', () => {
    clearLevelEnvelopes();
    const { project, voice } = twoTrackProject();
    const p = setClip(project, voice.id, { audio: { duck: { ...DEFAULT_DUCK } } });
    setLevelEnvelope('voice', { rate: 100, db: narration() });
    const music = p.clips.find((c) => c.mediaId === 'music')!;
    const plan = planClipGain(p, music, 100);
    expect(plan.curve).toBeDefined();
    expect(plan.curve![100]).toBeCloseTo(1, 2);
    expect(plan.curve![350]).toBeLessThan(0.3);
    expect(plan.curve![550]).toBeGreaterThan(0.88);
    clearLevelEnvelopes();
  });

  test('the narration follows its clip: a later start and a faster speed move the ducking with it', () => {
    clearLevelEnvelopes();
    const { project, voice } = twoTrackProject();
    // Voice clip starts at 3 s timeline, source offset 0, speed 2: source 2..4 s plays at timeline 4..5 s.
    const p = setClip(project, voice.id, { start: 3, duration: 5, speed: 2, audio: { duck: { ...DEFAULT_DUCK, attack: 0.02, release: 0.1 } } });
    setLevelEnvelope('voice', { rate: 100, db: narration() });
    const music = p.clips.find((c) => c.mediaId === 'music')!;
    expect(duckGainAt(p, music, 3.5)).toBeGreaterThan(0.9);
    expect(duckGainAt(p, music, 4.6)).toBeLessThan(0.3);
    clearLevelEnvelopes();
  });
});

describe('audio settings', () => {
  test('parseClipAudio keeps valid values and drops the rest', () => {
    expect(parseClipAudio(undefined)).toBeUndefined();
    expect(parseClipAudio({ fadeIn: 0, fadeOut: -3 })).toBeUndefined();
    expect(parseClipAudio({ fadeIn: 1.5, fadeOut: 'x', fadeCurve: 'smooth', silent: true })).toEqual({ fadeIn: 1.5, fadeCurve: 'smooth', silent: true });
    expect(parseClipAudio({ duck: { thresholdDb: -40, reductionDb: 12, attack: 0.05, release: 0.5 } })?.duck?.reductionDb).toBe(12);
    expect(parseClipAudio({ duck: { thresholdDb: -40 } })).toBeUndefined();
    expect(parseClipAudio({ fadeIn: 99999 })?.fadeIn).toBe(600);
  });

  test('settings survive saving and loading a project', () => {
    const { project, music } = twoTrackProject();
    let p = updateClipAudio(project, music.id, { fadeIn: 1, fadeOut: 2, duck: { ...DEFAULT_DUCK } });
    p = addVolumePoint(p, music.id, 2, 0.5);
    const back = parseProject(JSON.parse(JSON.stringify(p)));
    const c = back.clips.find((x) => x.id === music.id)!;
    expect(c.audio).toMatchObject({ fadeIn: 1, fadeOut: 2 });
    expect(c.audio?.duck?.thresholdDb).toBe(DEFAULT_DUCK.thresholdDb);
    expect(c.keys?.volume?.[0]).toMatchObject({ t: 2, v: 0.5 });
  });

  test('updateClipAudio removes keys set to undefined and respects locked tracks', () => {
    const { project, music } = twoTrackProject();
    let p = updateClipAudio(project, music.id, { fadeIn: 1 });
    expect(p.clips.find((c) => c.id === music.id)?.audio).toEqual({ fadeIn: 1 });
    p = updateClipAudio(p, music.id, { fadeIn: undefined });
    expect(p.clips.find((c) => c.id === music.id)?.audio).toBeUndefined();
    const locked = { ...project, tracks: project.tracks.map((t) => (t.id === music.trackId ? { ...t, locked: true } : t)) };
    expect(updateClipAudio(locked, music.id, { fadeIn: 1 })).toBe(locked);
  });
});

describe('applyProcessedAudio', () => {
  test('an audio clip is switched to the processed media', () => {
    const { project, music } = twoTrackProject();
    const baked = mediaItem('music-clean', 'audio', 10);
    const p = addMedia(project, baked);
    const r = applyProcessedAudio(p, music.id, baked);
    expect(r.audioClipId).toBe(music.id);
    expect(r.project.clips.find((c) => c.id === music.id)?.mediaId).toBe('music-clean');
    expect(r.project.clips.length).toBe(p.clips.length);
  });

  test('a video clip keeps its picture, goes silent, and gets a linked audio clip with the same timing', () => {
    let p = createProject('t', 640, 360, 30);
    p = addMedia(p, mediaItem('vid', 'video', 8));
    const placed = addClip(p, 'vid', 2, p.tracks[0].id);
    p = setClip(placed.project, placed.clipId!, { in: 1, duration: 4, speed: 2, audio: { fadeIn: 0.5 } });
    p = addVolumePoint(p, placed.clipId!, 1, 0.5);
    const baked = mediaItem('vid-clean', 'audio', 8);
    p = addMedia(p, baked);
    const r = applyProcessedAudio(p, placed.clipId!, baked);
    const video = r.project.clips.find((c) => c.id === placed.clipId)!;
    const audio = r.project.clips.find((c) => c.id === r.audioClipId)!;
    expect(video.mediaId).toBe('vid');
    expect(video.audio).toEqual({ silent: true });
    expect(clipGainAt(r.project, video, 1)).toBe(0);
    expect(audio.mediaId).toBe('vid-clean');
    expect([audio.start, audio.in, audio.duration, audio.speed]).toEqual([2, 1, 4, 2]);
    expect(audio.audio).toEqual({ fadeIn: 0.5 });
    expect(audio.keys?.volume?.length).toBe(1);
    expect(audio.linkId).toBeDefined();
    expect(audio.linkId).toBe(video.linkId);
    expect(audio.trackId).not.toBe(video.trackId);
    // No overlap with other clips on its track.
    expect(r.project.clips.filter((c) => c.trackId === audio.trackId && c.id !== audio.id).length).toBe(0);
  });
});

// ---- DSP ----------------------------------------------------------------------------------------------------

describe('FFT and WAV', () => {
  test('forward then inverse restores the input; a sine lands in the right bin', () => {
    const fft = new FFT(256);
    const re = new Float64Array(256);
    const im = new Float64Array(256);
    for (let i = 0; i < 256; i++) re[i] = Math.sin((2 * Math.PI * 8 * i) / 256) + 0.25 * Math.cos(i);
    const copy = re.slice();
    fft.forward(re, im);
    const mag = (k: number) => Math.hypot(re[k], im[k]);
    expect(mag(8)).toBeGreaterThan(100);
    expect(mag(8)).toBeGreaterThan(mag(20) * 10);
    fft.inverse(re, im);
    for (let i = 0; i < 256; i++) expect(re[i]).toBeCloseTo(copy[i], 9);
    expect(() => new FFT(100)).toThrow();
  });

  test('WAV 16-bit round trip, header fields, stereo interleave', () => {
    const left = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
    const right = new Float32Array([1, -1, 0.1, 0, 0.3, -0.3]);
    const bytes = encodeWav([left, right], 44100, 16);
    const text = (a: number) => String.fromCharCode(...bytes.subarray(a, a + 4));
    expect(text(0)).toBe('RIFF');
    expect(text(8)).toBe('WAVE');
    expect(text(12)).toBe('fmt ');
    expect(text(36)).toBe('data');
    const v = new DataView(bytes.buffer);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(6 * 2 * 2);
    expect(bytes.length).toBe(44 + 24);
    const back = decodeWav(bytes);
    expect(back.sampleRate).toBe(44100);
    expect(back.channels.length).toBe(2);
    for (let i = 0; i < 6; i++) {
      expect(back.channels[0][i]).toBeCloseTo(left[i], 3);
      expect(back.channels[1][i]).toBeCloseTo(right[i], 3);
    }
  });

  test('WAV 32-bit float is lossless, and bad input is rejected', () => {
    const x = new Float32Array([0.123456, -0.654321, 0.5]);
    const back = decodeWav(encodeWav([x], 48000, 32));
    expect(Array.from(back.channels[0])).toEqual(Array.from(x));
    expect(() => decodeWav(new Uint8Array(10))).toThrow();
    expect(() => encodeWav([], 48000)).toThrow();
    expect(() => encodeWav([new Float32Array(2), new Float32Array(3)], 48000)).toThrow();
  });
});

describe('noise reduction', () => {
  // 6 s: noise only 0-1.5 s, a 440 Hz tone with noise 1.5-4.5 s, noise only 4.5-6 s.
  function noisyTone(noiseSigma: number) {
    const r = rng(7);
    const n = SR * 6;
    const noisy = new Float32Array(n);
    const clean = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const tone = t >= 1.5 && t < 4.5 ? 0.3 * Math.sin(2 * Math.PI * 440 * t) : 0;
      clean[i] = tone;
      noisy[i] = tone + noiseSigma * gaussian(r);
    }
    return { noisy, clean };
  }
  const span = (a: number, b: number): [number, number] => [Math.round(a * SR), Math.round(b * SR)];

  test('noise-only stretches drop by at least 12 dB and the tone stays within 1 dB', async () => {
    const { noisy, clean } = noisyTone(0.02);
    const out = await reduceNoise(noisy, SR, { strength: 0.6 });
    expect(out.length).toBe(noisy.length);
    for (const [a, b] of [span(0.3, 1.3), span(4.8, 5.8)]) {
      const drop = rmsDb(noisy, a, b) - rmsDb(out, a, b);
      expect(drop).toBeGreaterThanOrEqual(12);
    }
    const [a, b] = span(2, 4);
    expect(Math.abs(rmsDb(out, a, b) - rmsDb(clean, a, b))).toBeLessThan(1);
  });

  test('a stronger setting removes more, and works on a noise sample marked by the user', async () => {
    const { noisy } = noisyTone(0.02);
    const [a, b] = span(0.3, 1.3);
    const soft = await reduceNoise(noisy, SR, { strength: 0.2 });
    const hard = await reduceNoise(noisy, SR, { strength: 0.95 });
    expect(rmsDb(hard, a, b)).toBeLessThan(rmsDb(soft, a, b) - 6);
    const marked = await reduceNoise(noisy, SR, { strength: 0.6, profile: { start: 0.1, end: 1.4 } });
    expect(rmsDb(noisy, a, b) - rmsDb(marked, a, b)).toBeGreaterThanOrEqual(12);
    const [c, d] = span(2, 4);
    expect(Math.abs(rmsDb(marked, c, d) - rmsDb(noisyTone(0.0001).clean, c, d))).toBeLessThan(1);
  });

  test('a very short clip is returned unchanged and silence stays silent', async () => {
    const short = new Float32Array(1000).fill(0.1);
    expect(Array.from(await reduceNoise(short, SR))).toEqual(Array.from(short));
    const silent = await reduceNoise(new Float32Array(SR), SR);
    expect(Math.max(...silent.map(Math.abs))).toBe(0);
  });
});

describe('levelling', () => {
  // Alternating phrases a second long: a loud one and one at half the amplitude (6 dB softer).
  function phrases(amp: number, seconds = 8): Float32Array {
    const n = SR * seconds;
    const x = new Float32Array(n);
    const r = rng(3);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const a = Math.floor(t) % 2 === 0 ? amp : amp / 2;
      x[i] = a * Math.sin(2 * Math.PI * 220 * t) + 0.1 * a * gaussian(r);
    }
    return x;
  }

  test('a quiet clip and a loud clip both land within 1.5 dB of the target', () => {
    for (const target of [-18, -24]) {
      const quiet = levelAudio([phrases(0.01)], SR, { targetDb: target });
      const loud = levelAudio([phrases(0.7)], SR, { targetDb: target });
      expect(Math.abs(loudnessDb(quiet.channels, SR) - target)).toBeLessThan(1.5);
      expect(Math.abs(loudnessDb(loud.channels, SR) - target)).toBeLessThan(1.5);
      expect(Math.abs(quiet.afterDb - loud.afterDb)).toBeLessThan(1.5);
    }
  });

  test('peaks stay under the ceiling and the compressor narrows the gap between loud and soft phrases', () => {
    const src = phrases(0.5);
    const out = levelAudio([src], SR, { targetDb: -14, amount: 1, ceilingDb: -1 });
    expect(peakDb(out.channels)).toBeLessThanOrEqual(-1 + 0.01);
    const gap = (x: Float32Array) => rmsDb(x, 2 * SR + 20000, 3 * SR - 20000) - rmsDb(x, 1 * SR + 20000, 2 * SR - 20000);
    const before = gap(src);
    const none = levelAudio([src], SR, { targetDb: -14, amount: 0 });
    expect(Math.abs(gap(none.channels[0]) - before)).toBeLessThan(0.5);
    expect(before).toBeGreaterThan(5);
    expect(gap(out.channels[0])).toBeLessThan(before - 1.5);
    expect(out.maxReductionDb).toBeGreaterThan(0);
  });

  test('stereo stays linked, silence is untouched, and the limiter never exceeds its ceiling', () => {
    const a = phrases(0.05, 4);
    const b = a.map((v) => v * 0.5);
    const out = levelAudio([a, b], SR, { targetDb: -18 });
    expect(out.channels.length).toBe(2);
    expect(rmsDb(out.channels[0]) - rmsDb(out.channels[1])).toBeCloseTo(rmsDb(a) - rmsDb(b), 0);
    const silence = levelAudio([new Float32Array(SR)], SR);
    expect(Math.max(...silence.channels[0].map(Math.abs))).toBe(0);
    expect(silence.makeupDb).toBe(0);
    const spiky = new Float32Array(SR);
    spiky[1000] = 4;
    spiky[1001] = -3;
    const g = limiterGain([spiky], SR, 0.5);
    expect(Math.abs(spiky[1000] * g[1000])).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(Math.abs(spiky[1001] * g[1001])).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(g[0]).toBe(1);
    expect(g[5000]).toBe(1);
  });

  test('loudness measurement ignores silence between phrases', () => {
    const x = new Float32Array(SR * 4);
    for (let i = 0; i < SR; i++) x[i] = 0.1 * Math.sin((2 * Math.PI * 300 * i) / SR);
    const solo = new Float32Array(SR);
    solo.set(x.subarray(0, SR));
    expect(Math.abs(loudnessDb([x], SR) - loudnessDb([solo], SR))).toBeLessThan(1);
    expect(loudnessDb([new Float32Array(SR)], SR)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('ducking envelope', () => {
  test('level envelope reads the loudness of each step', () => {
    const x = new Float32Array(SR * 2);
    for (let i = SR; i < SR * 2; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / SR);
    const env = levelEnvelopeDb([x], SR, 100);
    expect(env.length).toBe(200);
    expect(env[50]).toBeLessThan(-100);
    expect(env[150]).toBeCloseTo(-9, 0);
  });

  test('the music gain drops while the narration is present and recovers after', () => {
    const rate = 100;
    const level = new Float32Array(1000).fill(-80);
    for (let i = 200; i < 500; i++) level[i] = -25;
    const g = duckEnvelope(level, rate, { thresholdDb: -40, reductionDb: 14, attack: 0.05, release: 0.4, hold: 0.2 });
    const db = (i: number) => 20 * Math.log10(g[i]);
    expect(db(100)).toBeCloseTo(0, 3);
    expect(db(190)).toBeCloseTo(0, 3);
    expect(db(204)).toBeLessThan(-2); // starting to fall
    expect(db(204)).toBeGreaterThan(-13.9); // but not instantly
    expect(db(300)).toBeCloseTo(-14, 0);
    expect(db(480)).toBeCloseTo(-14, 0);
    expect(db(515)).toBeLessThan(-12); // held across the first 0.2 s of silence
    expect(db(700)).toBeGreaterThan(-0.2); // recovered
    for (let i = 0; i < g.length; i++) {
      expect(g[i]).toBeLessThanOrEqual(1);
      expect(g[i]).toBeGreaterThanOrEqual(10 ** (-14 / 20) - 1e-6);
    }
  });

  test('short pauses between words do not make the music pump', () => {
    const level = new Float32Array(600).fill(-80);
    for (let w = 0; w < 5; w++) for (let i = 100 + w * 60; i < 100 + w * 60 + 45; i++) level[i] = -25; // 0.45 s words, 0.15 s gaps
    const g = duckEnvelope(level, 100, { thresholdDb: -40, reductionDb: 12, attack: 0.03, release: 0.5, hold: 0.2 });
    const inside = Array.from(g.subarray(150, 380));
    expect(Math.max(...inside)).toBeLessThan(10 ** (-9 / 20));
  });
});

describe('waveform peaks', () => {
  test('min and max per bin follow the signal; a window finds the loudest part', () => {
    const x = new Float32Array(SR * 2);
    for (let i = SR; i < SR * 2; i++) x[i] = 0.8 * Math.sin((2 * Math.PI * 100 * i) / SR);
    const p = computePeaks([x], SR, 100);
    expect(p.min.length).toBe(200);
    expect(p.duration).toBeCloseTo(2, 6);
    expect(p.max[10]).toBe(0);
    expect(p.max[150]).toBeCloseTo(0.8, 2);
    expect(p.min[150]).toBeCloseTo(-0.8, 2);
    expect(peakWindow(p, 0, 0.9)).toEqual([0, 0]);
    const [lo, hi] = peakWindow(p, 1.2, 1.5);
    expect(hi).toBeGreaterThan(0.75);
    expect(lo).toBeLessThan(-0.75);
    expect(p.levelDb[150]).toBeGreaterThan(p.levelDb[10] + 60);
  });

  test('stereo peaks cover both channels, and empty input still gives one bin', () => {
    const l = new Float32Array(SR / 10);
    const r = new Float32Array(SR / 10);
    r[100] = -0.9;
    l[200] = 0.4;
    const p = computePeaks([l, r], SR, 100);
    expect(p.min[0]).toBeCloseTo(-0.9, 5);
    expect(p.max[0]).toBeCloseTo(0.4, 5);
    expect(computePeaks([new Float32Array(0)], SR, 100).min.length).toBe(1);
  });
});
