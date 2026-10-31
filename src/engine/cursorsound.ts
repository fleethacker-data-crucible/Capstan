// Click sounds: a short synthesized click, played by the preview when playback crosses a recorded
// click and mixed into the export's audio at the same moments.
import { type Project, findMedia, sourceSpan } from './project';
import { upperBound } from './cursor';

export const CLICK_SECONDS = 0.06;

/** The click: a short damped two-tone knock with a noise tick at the front. Deterministic. */
export function synthClick(sampleRate: number): Float32Array {
  const n = Math.max(1, Math.round(sampleRate * CLICK_SECONDS));
  const out = new Float32Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = (seed / 0xffffffff) * 2 - 1;
    const tone = Math.sin(2 * Math.PI * 1750 * t) * 0.55 + Math.sin(2 * Math.PI * 880 * t) * 0.3;
    out[i] = (tone * Math.exp(-t / 0.009) + noise * 0.5 * Math.exp(-t / 0.0015)) * 0.7;
  }
  // Fade the last milliseconds so the buffer always ends at silence.
  const tail = Math.min(n, Math.round(sampleRate * 0.004));
  for (let i = 0; i < tail; i++) out[n - 1 - i] *= i / tail;
  return out;
}

export interface ClickTime {
  /** Timeline seconds. */
  t: number;
  volume: number;
}

/**
 * Timeline moments at which a recorded click is heard: every press of every visible, unmuted clip
 * whose media has cursor data, when click sounds are switched on. Sorted by time.
 */
export function clickSoundTimes(project: Project): ClickTime[] {
  const fx = project.cursorFx;
  if (!fx || !fx.enabled || !fx.clickSound || fx.clickVolume <= 0) return [];
  const out: ClickTime[] = [];
  for (const clip of project.clips) {
    const media = findMedia(project, clip.mediaId);
    const track = project.tracks.find((t) => t.id === clip.trackId);
    if (!media?.cursor || !media.cursor.clicks.length || clip.freeze || track?.muted || track?.hidden) continue;
    const speed = clip.speed && Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
    const from = clip.in;
    const to = clip.in + sourceSpan(clip);
    const clicks = media.cursor.clicks;
    for (let i = upperBound(clicks, from - 1e-9); i < clicks.length && clicks[i].t < to; i++) {
      if (clicks[i].down && clicks[i].t >= from) out.push({ t: clip.start + (clicks[i].t - from) / speed, volume: fx.clickVolume * Math.min(1, Math.max(0, clip.props.volume)) });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Schedules the click sound at each time on an audio context (the export's offline context). Returns how many were scheduled. */
export function scheduleClickSounds(ctx: BaseAudioContext, times: ClickTime[]): number {
  if (!times.length) return 0;
  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * CLICK_SECONDS), ctx.sampleRate);
  buffer.copyToChannel(synthClick(ctx.sampleRate) as Float32Array<ArrayBuffer>, 0);
  for (const c of times) {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = c.volume;
    source.connect(gain).connect(ctx.destination);
    source.start(Math.max(0, c.t));
  }
  return times.length;
}

/** Plays the click sound during preview playback whenever the playhead passes a recorded click. */
export class ClickSoundPlayer {
  private times: ClickTime[] = [];
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  /** How many clicks have been played (for tests). */
  played = 0;

  setProject(project: Project): void {
    this.times = clickSoundTimes(project);
  }

  /** Call from a user gesture (play) so the browser lets the sound start. */
  prepare(): void {
    if (!this.times.length || typeof AudioContext === 'undefined') return;
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  /** Plays the clicks in (from, to]. Seeks never call this, so scrubbing is silent. */
  tick(from: number, to: number): void {
    if (!this.times.length || to <= from) return;
    // After a stall, skip clicks that are already long past.
    const lo = Math.max(from, to - 0.25);
    for (let i = upperBound(this.times, lo); i < this.times.length && this.times[i].t <= to; i++) this.play(this.times[i].volume);
  }

  private play(volume: number): void {
    this.prepare();
    const ctx = this.ctx;
    if (!ctx) return;
    this.played++;
    try {
      if (!this.buffer || this.buffer.sampleRate !== ctx.sampleRate) {
        this.buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * CLICK_SECONDS), ctx.sampleRate);
        this.buffer.copyToChannel(synthClick(ctx.sampleRate) as Float32Array<ArrayBuffer>, 0);
      }
      const source = ctx.createBufferSource();
      source.buffer = this.buffer;
      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.connect(gain).connect(ctx.destination);
      source.start();
    } catch {
      /* no audio device: the preview stays silent */
    }
  }

  destroy(): void {
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
