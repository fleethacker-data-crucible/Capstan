// Browser-side export harness: builds a timeline from the fixtures without the UI and exports
// it, so the encoder + muxer can be verified with ffprobe independently of the editor.
import { exportMp4, defaultExportOptions, mixAudio } from '../../src/engine/export';
import { DEFAULT_DUCK } from '../../src/engine/dsp/duck';
import { encodeWav } from '../../src/engine/dsp/wav';
import { decodeBlob } from '../../src/engine/peaks';
import { updateClipAudio } from '../../src/engine/audioops';
import { getMediaBlob, loadLastProject } from '../../src/engine/storage';
import { probeMedia } from '../../src/engine/media';
import { addClip, addMedia, moveClip, updateClipProps } from '../../src/engine/ops';
import { type MediaItem, createProject, projectDuration } from '../../src/engine/project';

declare global {
  interface Window {
    runExport: (opts?: { audio?: boolean }) => Promise<{ base64: string; info: unknown }>;
    /** Audio area: RMS (dBFS, left channel) of windows of the mixed audio of the project saved by the editor. */
    mixSaved: (windows: Array<[number, number]>) => Promise<number[] | null>;
    /** Audio area: RMS (dBFS) of windows of one media item's decoded audio, found by name in the saved project. */
    mediaLevels: (name: string, windows: Array<[number, number]>) => Promise<number[] | null>;
    /** Audio area: level of the 200 Hz music (dBFS, via a Goertzel filter) in three windows of a mix where a narration ducks it. */
    duckMix: (ducking: boolean) => Promise<number[]>;
  }
}

async function fixture(name: string): Promise<File> {
  const res = await fetch(`/fixtures/${name}`);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type });
}

window.runExport = async (opts = {}) => {
  const blobs = new Map<string, Blob>();
  let p = createProject('harness', 640, 360, 30);
  const files = await Promise.all(['clip.webm', 'card.png', 'tone.wav'].map(fixture));
  const ids: string[] = [];
  for (const f of files) {
    const m = await probeMedia(f);
    blobs.set(m.id, f);
    ids.push(m.id);
    p = addMedia(p, m);
  }
  const [video, card, tone] = ids;
  const bottom = p.tracks[0].id;
  const top = p.tracks[2].id;
  let r = addClip(p, video, 0, bottom); // 0..3
  p = r.project;
  r = addClip(p, card, 3, bottom); // 3..8 (image)
  p = r.project;
  r = addClip(p, video, 1, top); // picture-in-picture 1..4
  p = updateClipProps(r.project, r.clipId!, { scale: 0.35, x: 500, y: 90, opacity: 0.9 });
  r = addClip(p, tone, 4, p.tracks[1].id);
  p = moveClip(r.project, r.clipId!, 4.5);
  const options = { ...defaultExportOptions(p), videoBitrate: 1_500_000, includeAudio: opts.audio !== false };
  const result = await exportMp4(p, async (id) => blobs.get(id) ?? null, options);
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {
    base64: btoa(binary),
    info: { videoCodec: result.videoCodec, audioCodec: result.audioCodec, frames: result.frames, seconds: result.seconds, bytes: bytes.length },
  };
};

const levels = (data: Float32Array, rate: number, windows: Array<[number, number]>) =>
  windows.map(([a, b]) => {
    const from = Math.floor(a * rate);
    const to = Math.min(data.length, Math.floor(b * rate));
    let sum = 0;
    for (let i = from; i < to; i++) sum += data[i] * data[i];
    return to > from ? 10 * Math.log10(sum / (to - from) + 1e-12) : -120;
  });

window.mixSaved = async (windows) => {
  const project = await loadLastProject();
  if (!project) return null;
  const mixed = await mixAudio(project, getMediaBlob, projectDuration(project));
  return mixed ? levels(mixed.getChannelData(0), mixed.sampleRate, windows) : null;
};

window.mediaLevels = async (name, windows) => {
  const project = await loadLastProject();
  const media = project?.media.find((m) => m.name === name);
  const blob = media ? await getMediaBlob(media.id) : null;
  const buffer = blob ? await decodeBlob(blob) : null;
  return buffer ? levels(buffer.getChannelData(0), buffer.sampleRate, windows) : null;
};


// A 200 Hz "music" bed for 6 s and an 880 Hz "narration" burst from 2 s to 4 s; the narration ducks the music.
window.duckMix = async (ducking) => {
  const sr = 48000;
  const tone = (hz: number, from: number, to: number, seconds: number) => {
    const x = new Float32Array(sr * seconds);
    for (let i = Math.floor(from * sr); i < Math.floor(to * sr); i++) x[i] = 0.3 * Math.sin((2 * Math.PI * hz * i) / sr);
    return x;
  };
  const wav = (x: Float32Array) => new Blob([encodeWav([x], sr, 16) as BlobPart], { type: 'audio/wav' });
  const blobs = new Map<string, Blob>([
    ['music', wav(tone(200, 0, 6, 6))],
    ['voice', wav(tone(880, 2, 4, 6))],
  ]);
  const item = (id: string): MediaItem => ({ id, name: id, kind: 'audio', mime: 'audio/wav', bytes: 1, duration: 6, width: 0, height: 0, hasAudio: true, createdAt: 0 });
  let p = createProject('duck', 320, 180, 30);
  p = addMedia(addMedia(p, item('music')), item('voice'));
  p = addClip(p, 'music', 0, p.tracks[0].id).project;
  const voice = addClip(p, 'voice', 0, p.tracks[1].id);
  p = voice.project;
  if (ducking) p = updateClipAudio(p, voice.clipId!, { duck: { ...DEFAULT_DUCK, thresholdDb: -30, reductionDb: 12, attack: 0.05, release: 0.3 } });
  const mixed = await mixAudio(p, async (id) => blobs.get(id) ?? null, 6);
  if (!mixed) return [];
  const data = mixed.getChannelData(0);
  const goertzel = (from: number, to: number, hz: number) => {
    const a = Math.floor(from * sr);
    const b = Math.floor(to * sr);
    const w = (2 * Math.PI * hz) / sr;
    let re = 0;
    let im = 0;
    for (let i = a; i < b; i++) {
      re += data[i] * Math.cos(w * (i - a));
      im -= data[i] * Math.sin(w * (i - a));
    }
    const amp = (2 * Math.hypot(re, im)) / (b - a);
    return 20 * Math.log10(amp + 1e-9);
  };
  return [goertzel(0.5, 1.5, 200), goertzel(2.5, 3.5, 200), goertzel(5, 6, 200)];
};

document.title = 'harness-ready';
