// The one gain function for clip audio. The preview (Player.sync) and the export mixer (mixAudio) both call
// clipGainAt, so what you hear while editing is what the file gets.
//
//   gain = volume (the Volume slider, or the volume points when there are any)
//        x fade in x fade out
//        x ducking (other tracks pulled down while a narration clip with ducking switched on is speaking)
//
// Preview limit: an HTML media element cannot play louder than 1.0, so in the preview a gain above 1 is shown
// as 1. The exported file does apply it (up to 2.0, +6 dB).
import { evalTrack } from './anim';
import type { ClipAudio, FadeCurve } from './audiofx';
import { type DuckOptions, duckEnvelope } from './dsp/duck';
import { type Clip, type Project, sourceTimeAt } from './project';

/** Level of a media item (dBFS per step, `rate` steps per second), measured once per media. */
export interface LevelEnvelope {
  rate: number;
  db: ArrayLike<number>;
}

const envelopes = new Map<string, LevelEnvelope>();

export function setLevelEnvelope(mediaId: string, env: LevelEnvelope): void {
  envelopes.set(mediaId, env);
}

export function getLevelEnvelope(mediaId: string): LevelEnvelope | undefined {
  return envelopes.get(mediaId);
}

export function clearLevelEnvelopes(): void {
  envelopes.clear();
}

/** Fade progress 0..1 to gain 0..1. */
export function fadeShape(u: number, curve: FadeCurve | undefined): number {
  const x = Math.min(1, Math.max(0, u));
  return curve === 'smooth' ? x * x * (3 - 2 * x) : x;
}

/** Combined fade-in and fade-out gain at `t` seconds into a clip of `duration` seconds. */
export function fadeGain(audio: ClipAudio | undefined, duration: number, t: number): number {
  if (!audio) return 1;
  let g = 1;
  if (audio.fadeIn && audio.fadeIn > 0) g *= fadeShape(t / audio.fadeIn, audio.fadeCurve);
  if (audio.fadeOut && audio.fadeOut > 0) g *= fadeShape((duration - t) / audio.fadeOut, audio.fadeCurve);
  return g;
}

/** The Volume slider, or the volume points (keys.volume) once there are any. */
export function volumeAt(clip: Clip, localTime: number): number {
  return evalTrack(clip.keys?.volume, localTime, clip.props.volume);
}

// ---- ducking ---------------------------------------------------------------------------------------------

const CURVE_RATE = 100;

interface DuckCurve {
  env: LevelEnvelope;
  gains: Float32Array;
}

const curves = new WeakMap<Clip, DuckCurve>();

/** Gain curve (100 steps a second from the narration clip's start) that the narration pulls the others down by. */
function narrationCurve(n: Clip, o: DuckOptions, env: LevelEnvelope): Float32Array {
  const cached = curves.get(n);
  if (cached && cached.env === env) return cached.gains;
  const tail = Math.min(12, o.release * 6 + (o.hold ?? 0.2) + 0.5);
  const steps = Math.ceil((n.duration + tail) * CURVE_RATE) + 1;
  const levels = new Float32Array(steps);
  const trim = n.props.volume > 0 ? 20 * Math.log10(n.props.volume) : -120;
  for (let i = 0; i < steps; i++) {
    const local = i / CURVE_RATE;
    let db = -120;
    if (local < n.duration) {
      const idx = Math.floor(sourceTimeAt(n, n.start + local) * env.rate);
      if (idx >= 0 && idx < env.db.length) db = env.db[idx] + trim;
    }
    levels[i] = db;
  }
  const gains = duckEnvelope(levels, CURVE_RATE, o);
  curves.set(n, { env, gains });
  return gains;
}

/** Does this clip's sound count as narration right now (ducking on, audible, envelope measured)? */
function narrations(project: Project, clip: Clip): Array<{ n: Clip; o: DuckOptions; env: LevelEnvelope }> {
  if (clip.audio?.duck) return [];
  const out: Array<{ n: Clip; o: DuckOptions; env: LevelEnvelope }> = [];
  for (const n of project.clips) {
    const o = n.audio?.duck;
    if (!o || n.id === clip.id || n.trackId === clip.trackId || n.freeze || n.audio?.silent) continue;
    if (project.tracks.find((t) => t.id === n.trackId)?.muted) continue;
    const env = envelopes.get(n.mediaId);
    if (env) out.push({ n, o, env });
  }
  return out;
}

/** Linear gain (1 = untouched) that narration clips on other tracks impose on `clip` at timeline time `time`. */
export function duckGainAt(project: Project, clip: Clip, time: number): number {
  let g = 1;
  for (const { n, o, env } of narrations(project, clip)) {
    const pos = (time - n.start) * CURVE_RATE;
    if (pos < 0) continue;
    const gains = narrationCurve(n, o, env);
    if (pos >= gains.length - 1) continue;
    const i = Math.floor(pos);
    const f = pos - i;
    g = Math.min(g, gains[i] * (1 - f) + gains[i + 1] * f);
  }
  return g;
}

// ---- the gain function -----------------------------------------------------------------------------------

/** Linear gain of a clip's audio `localTime` seconds after the clip starts. 0 = silent; may exceed 1 (up to 2). */
export function clipGainAt(project: Project, clip: Clip, localTime: number): number {
  if (clip.audio?.silent || clip.freeze) return 0;
  const t = Math.min(clip.duration, Math.max(0, localTime));
  let g = volumeAt(clip, t) * fadeGain(clip.audio, clip.duration, t);
  if (g > 0) g *= duckGainAt(project, clip, clip.start + t);
  return Math.max(0, g);
}

/** The gain as the preview element can play it: element volume stops at 1. */
export function previewVolume(project: Project, clip: Clip, localTime: number): number {
  return Math.min(1, clipGainAt(project, clip, localTime));
}

/** True when the gain changes over the clip (fades, several volume points, or narration ducking). */
export function gainVaries(project: Project, clip: Clip): boolean {
  const a = clip.audio;
  return !!(a?.fadeIn || a?.fadeOut || (clip.keys?.volume?.length ?? 0) > 1 || narrations(project, clip).length);
}

export interface GainPlan {
  /** Gain at the start of the clip (the whole clip's gain when `curve` is absent). */
  value: number;
  /** Gain sampled `hz` times a second from the clip's start to its end (>= 2 samples), when it varies. */
  curve?: Float32Array;
}

/** What the export mixer schedules on a clip's GainNode: a constant, or sampled gain automation. */
export function planClipGain(project: Project, clip: Clip, hz = 100): GainPlan {
  const value = clipGainAt(project, clip, 0);
  if (clip.audio?.silent || clip.freeze || !gainVaries(project, clip)) return { value };
  const steps = Math.max(2, Math.ceil(clip.duration * hz) + 1);
  const curve = new Float32Array(steps);
  for (let i = 0; i < steps; i++) curve[i] = clipGainAt(project, clip, (i / (steps - 1)) * clip.duration);
  return { value, curve };
}
