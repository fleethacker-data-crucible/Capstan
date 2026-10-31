// Per-clip audio settings beyond volume: fades, ducking, and the "audio replaced" flag.
// Owned by the audio area; the player and the export mixer both read these through gain.ts (clipGainAt).
import type { DuckOptions } from './dsp/duck';

export type FadeCurve = 'linear' | 'smooth';

export interface ClipAudio {
  /** Seconds of fade-in at the start of the clip and fade-out at its end. */
  fadeIn?: number;
  fadeOut?: number;
  /** 'linear' ramps straight; 'smooth' is an equal-power-ish S curve. Default linear. */
  fadeCurve?: FadeCurve;
  /**
   * Set on a narration clip: while it is speaking, audio on the other tracks is pulled down.
   * The clip's own level is never changed by this.
   */
  duck?: DuckOptions;
  /**
   * The clip's own sound is silent because a processed copy (noise removal, levelling) was placed as an audio clip
   * beside it. Only ever set on video clips; an audio clip is swapped to the processed media instead.
   */
  silent?: boolean;
}

export const MAX_FADE_SECONDS = 600;

const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;

export function parseDuck(input: unknown): DuckOptions | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const d = input as Record<string, unknown>;
  const thresholdDb = num(d.thresholdDb, -90, 0);
  const reductionDb = num(d.reductionDb, 0, 60);
  const attack = num(d.attack, 0.005, 5);
  const release = num(d.release, 0.02, 10);
  if (thresholdDb === undefined || reductionDb === undefined || attack === undefined || release === undefined) return undefined;
  const hold = num(d.hold, 0, 5);
  return { thresholdDb, reductionDb, attack, release, ...(hold !== undefined ? { hold } : {}) };
}

/** Validates the audio settings read from a project file; undefined when nothing worth keeping is set. */
export function parseClipAudio(input: unknown): ClipAudio | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const a = input as Record<string, unknown>;
  const out: ClipAudio = {};
  const fadeIn = num(a.fadeIn, 0, MAX_FADE_SECONDS);
  const fadeOut = num(a.fadeOut, 0, MAX_FADE_SECONDS);
  if (fadeIn) out.fadeIn = fadeIn;
  if (fadeOut) out.fadeOut = fadeOut;
  if (a.fadeCurve === 'smooth') out.fadeCurve = 'smooth';
  const duck = parseDuck(a.duck);
  if (duck) out.duck = duck;
  if (a.silent === true) out.silent = true;
  return Object.keys(out).length ? out : undefined;
}
