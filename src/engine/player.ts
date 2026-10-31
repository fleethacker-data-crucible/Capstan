// Preview playback. A wall-clock timeline drives one media element per active clip; elements
// are kept within a small drift of the timeline and composited onto the preview canvas.
import { drawFrame } from './compositor';
import { previewVolume } from './gain';
import { type Clip, type Project, clipEnd, clipSpeed, findMedia, projectDuration, sourceTimeAt } from './project';

export interface PlayerSources {
  /** Object URL for a media item's bytes, or null if not loaded yet. */
  url(mediaId: string): string | null;
  /** Decoded still image for image media, or null if not loaded yet. */
  bitmap(mediaId: string): ImageBitmap | null;
}

type Listener = (time: number, playing: boolean) => void;

const DRIFT_PLAYING = 0.25;
const PRELOAD_SECONDS = 2;

export class Player {
  private project: Project;
  private ctx: CanvasRenderingContext2D;
  private elements = new Map<string, HTMLMediaElement>();
  private listeners = new Set<Listener>();
  private raf = 0;
  private clockStart = 0;
  private timeAtStart = 0;
  private _time = 0;
  private _playing = false;
  private redrawQueued = false;

  constructor(
    private canvas: HTMLCanvasElement,
    project: Project,
    private sources: PlayerSources,
  ) {
    this.project = project;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.resize();
  }

  get time(): number {
    return this._time;
  }

  get playing(): boolean {
    return this._playing;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setProject(project: Project): void {
    const sizeChanged = project.width !== this.project.width || project.height !== this.project.height;
    this.project = project;
    if (sizeChanged) this.resize();
    const live = new Set(project.clips.map((c) => c.id));
    for (const [id, el] of this.elements) {
      if (!live.has(id)) this.dropElement(id, el);
    }
    this.sync(true);
    this.requestRedraw();
  }

  play(): void {
    if (this._playing) return;
    const end = projectDuration(this.project);
    if (end <= 0) return;
    if (this._time >= end - 1e-3) this._time = 0;
    this._playing = true;
    this.clockStart = performance.now();
    this.timeAtStart = this._time;
    this.sync(true);
    this.loop();
    this.emit();
  }

  pause(): void {
    if (!this._playing) return;
    this._playing = false;
    cancelAnimationFrame(this.raf);
    for (const el of this.elements.values()) el.pause();
    this.sync(true);
    this.emit();
  }

  toggle(): void {
    if (this._playing) this.pause();
    else this.play();
  }

  seek(time: number): void {
    const end = projectDuration(this.project);
    this._time = Math.max(0, Math.min(time, Math.max(end, 0)));
    if (this._playing) {
      this.clockStart = performance.now();
      this.timeAtStart = this._time;
    }
    this.sync(true);
    this.render();
    this.emit();
  }

  /** Steps whole frames while paused. */
  step(frames: number): void {
    this.pause();
    const fps = this.project.fps;
    this.seek(Math.round(this._time * fps + frames) / fps);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    for (const [id, el] of this.elements) this.dropElement(id, el);
    this.listeners.clear();
  }

  requestRedraw(): void {
    if (this.redrawQueued) return;
    this.redrawQueued = true;
    requestAnimationFrame(() => {
      this.redrawQueued = false;
      this.render();
    });
  }

  private resize(): void {
    this.canvas.width = this.project.width;
    this.canvas.height = this.project.height;
  }

  private loop = (): void => {
    if (!this._playing) return;
    const end = projectDuration(this.project);
    this._time = this.timeAtStart + (performance.now() - this.clockStart) / 1000;
    if (this._time >= end) {
      this._time = end;
      this.render();
      this.pause();
      return;
    }
    this.sync(false);
    this.render();
    this.emit();
    this.raf = requestAnimationFrame(this.loop);
  };

  private emit(): void {
    for (const fn of this.listeners) fn(this._time, this._playing);
  }

  private sourceTime(clip: Clip): number {
    return sourceTimeAt(clip, this._time);
  }

  private element(clip: Clip): HTMLMediaElement | null {
    const existing = this.elements.get(clip.id);
    if (existing) return existing;
    const media = findMedia(this.project, clip.mediaId);
    if (!media || media.kind === 'image') return null;
    const url = this.sources.url(media.id);
    if (!url) return null;
    const el = document.createElement(media.kind === 'video' ? 'video' : 'audio');
    el.preload = 'auto';
    (el as HTMLVideoElement).playsInline = true;
    el.src = url;
    el.addEventListener('seeked', () => this.requestRedraw());
    el.addEventListener('loadeddata', () => this.requestRedraw());
    this.elements.set(clip.id, el);
    return el;
  }

  private dropElement(id: string, el: HTMLMediaElement): void {
    el.pause();
    el.removeAttribute('src');
    el.load();
    this.elements.delete(id);
  }

  /** Brings every relevant media element in line with the timeline. */
  private sync(hard: boolean): void {
    const muted = new Set(this.project.tracks.filter((t) => t.muted).map((t) => t.id));
    for (const clip of this.project.clips) {
      const active = this._time >= clip.start && this._time < clipEnd(clip);
      const upcoming = !active && clip.start > this._time && clip.start - this._time < PRELOAD_SECONDS;
      const el = active || upcoming ? this.element(clip) : this.elements.get(clip.id);
      if (!el) continue;
      if (!active) {
        if (!el.paused) el.pause();
        if (upcoming && hard && Math.abs(el.currentTime - clip.in) > 0.05) el.currentTime = clip.in;
        continue;
      }
      el.muted = muted.has(clip.trackId) || !!clip.freeze || !!clip.muteAudio;
      // Fades, volume points and ducking; an element cannot play louder than 1, so gain above 1 shows as 1 here.
      el.volume = Math.max(0, previewVolume(this.project, clip, this._time - clip.start));
      el.playbackRate = clipSpeed(clip);
      const want = this.sourceTime(clip);
      if (clip.freeze) {
        // A freeze frame never plays: it sits on one source frame.
        if (!el.paused) el.pause();
        if (hard && Math.abs(el.currentTime - want) > 0.5 / this.project.fps) el.currentTime = want;
      } else if (this._playing) {
        if (el.paused) {
          el.currentTime = want;
          void el.play().catch(() => undefined);
        } else if (Math.abs(el.currentTime - want) > DRIFT_PLAYING) {
          el.currentTime = want;
        }
      } else {
        if (!el.paused) el.pause();
        if (hard && Math.abs(el.currentTime - want) > 0.5 / this.project.fps) el.currentTime = want;
      }
    }
  }

  render(): void {
    drawFrame(this.ctx, this.project, this._time, (clip) => {
      const media = findMedia(this.project, clip.mediaId);
      if (!media) return null;
      if (media.kind === 'image') return this.sources.bitmap(media.id);
      const el = this.elements.get(clip.id);
      return el instanceof HTMLVideoElement && el.readyState >= 2 ? el : null;
    });
  }
}
