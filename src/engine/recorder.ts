// Screen recording with the browser's screen-capture permission. System audio (when the user
// shares it) and the microphone are mixed into one track, since MediaRecorder records one.

/** What the user chose to record. Matches MediaTrackSettings.displaySurface. */
export type CaptureSurface = 'browser' | 'window' | 'monitor';

export const SURFACE_LABEL: Record<CaptureSurface, string> = { browser: 'browser tab', window: 'window', monitor: 'entire screen' };

export interface RecordOptions {
  microphone: boolean;
  systemAudio: boolean;
  frameRate: number;
  /** Defaults to 'monitor' (the browser offers everything). */
  surface?: CaptureSurface;
  /** Larger sources are scaled down to fit; smaller ones are never scaled up. */
  maxWidth?: number;
  maxHeight?: number;
}

export interface Recording {
  blob: Blob;
  seconds: number;
  name: string;
  width: number;
  height: number;
}

/**
 * getDisplayMedia options for a surface. For a tab or a window, screens are excluded from the
 * picker so the whole desktop cannot be shared by mistake.
 */
export function displayMediaOptions(o: RecordOptions): DisplayMediaStreamOptions & Record<string, unknown> {
  const surface = o.surface ?? 'monitor';
  const video: MediaTrackConstraints & Record<string, unknown> = { frameRate: { ideal: o.frameRate, max: 60 }, displaySurface: surface };
  if (o.maxWidth && o.maxHeight) {
    video.width = { max: o.maxWidth };
    video.height = { max: o.maxHeight };
  }
  return {
    video,
    audio: o.systemAudio,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
    monitorTypeSurfaces: surface === 'monitor' ? 'include' : 'exclude',
    systemAudio: o.systemAudio ? 'include' : 'exclude',
    preferCurrentTab: false,
  };
}

/**
 * Null when the shared surface is what was asked for, otherwise why it is refused. A tab or
 * window request is refused when the browser does not say what is being shared.
 */
export function surfaceProblem(wanted: CaptureSurface, settings: { displaySurface?: string }): string | null {
  if (wanted === 'monitor') return null;
  const got = settings.displaySurface;
  if (got === wanted) return null;
  if (!got) return `This browser does not report what is being shared, so Capstan cannot confirm it is a ${SURFACE_LABEL[wanted]}. Use a current Edge or Chrome.`;
  const label = SURFACE_LABEL[got as CaptureSurface] ?? got;
  return `You chose to record a ${SURFACE_LABEL[wanted]}, but the browser shared ${got === 'monitor' ? 'the' : 'a'} ${label}. Nothing was recorded.`;
}

/**
 * Recording formats in order of preference: MP4 (indexed, so export seeks fast), then WebM. A type
 * is only offered if this browser can also play it back: some Chromium builds record H.264 they
 * cannot decode, which would leave a recording the editor cannot open.
 */
export function recorderCandidates(): string[] {
  const types = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  if (typeof MediaRecorder === 'undefined') return [];
  const probe = typeof document !== 'undefined' ? document.createElement('video') : null;
  const playable = (t: string) => !probe || probe.canPlayType(t) !== '';
  return types.filter((t) => MediaRecorder.isTypeSupported(t) && playable(t));
}

/**
 * True if a short test recording of `track` in `type` produces data. Edge's H.264 recorder can
 * accept screen and tab capture and then write nothing at all, with no error.
 */
async function recordsData(track: MediaStreamTrack, type: string, ms = 2000): Promise<boolean> {
  const copy = track.clone();
  try {
    const rec = new MediaRecorder(new MediaStream([copy]), { mimeType: type, videoBitsPerSecond: 2_000_000 });
    return await new Promise<boolean>((resolve) => {
      let timer = 0;
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        rec.ondataavailable = null;
        rec.onerror = null;
        if (rec.state !== 'inactive') rec.stop();
        resolve(ok);
      };
      timer = window.setTimeout(() => finish(false), ms);
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) finish(true);
      };
      rec.onerror = () => finish(false);
      rec.start(250);
    });
  } catch {
    return false;
  } finally {
    copy.stop();
  }
}

/** The first candidate that actually records this track: MP4 only after a test, WebM as is. */
async function workingRecorderType(track: MediaStreamTrack): Promise<string> {
  for (const type of recorderCandidates()) {
    if (!type.startsWith('video/mp4') || (await recordsData(track, type))) return type;
  }
  return '';
}

export class ScreenRecorder {
  private recorder: MediaRecorder | null = null;
  private streams: MediaStream[] = [];
  private audioContext: AudioContext | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private stoppedAt = 0;
  private pausedTotal = 0;
  private pausedAt = 0;
  private finished: Promise<Recording> | null = null;
  private size = { width: 0, height: 0 };
  onEnded: (() => void) | null = null;

  get state(): RecordingState | 'idle' {
    return this.recorder?.state ?? 'idle';
  }

  get elapsed(): number {
    if (!this.startedAt) return 0;
    // Frozen at Stop: the recorder can take a second to flush, and that is not footage.
    const now = this.pausedAt || this.stoppedAt || performance.now();
    return (now - this.startedAt - this.pausedTotal) / 1000;
  }

  async start(options: RecordOptions): Promise<void> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen recording needs a current Edge or Chrome on this computer.');
    }
    const display = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions(options));
    this.streams.push(display);
    const settings = display.getVideoTracks()[0]?.getSettings() ?? {};
    const problem = surfaceProblem(options.surface ?? 'monitor', settings);
    if (problem) {
      this.cleanup();
      throw new Error(problem);
    }
    this.size = { width: settings.width ?? 0, height: settings.height ?? 0 };
    let mic: MediaStream | null = null;
    if (options.microphone) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        this.streams.push(mic);
      } catch {
        mic = null; // carry on without the microphone rather than failing the recording
      }
    }
    const audioSources = [display, mic].filter((s): s is MediaStream => !!s && s.getAudioTracks().length > 0);
    const tracks: MediaStreamTrack[] = [...display.getVideoTracks()];
    if (audioSources.length === 1) {
      tracks.push(audioSources[0].getAudioTracks()[0]);
    } else if (audioSources.length > 1) {
      this.audioContext = new AudioContext();
      const destination = this.audioContext.createMediaStreamDestination();
      for (const s of audioSources) this.audioContext.createMediaStreamSource(s).connect(destination);
      tracks.push(destination.stream.getAudioTracks()[0]);
    }
    const stream = new MediaStream(tracks);
    const mimeType = await workingRecorderType(display.getVideoTracks()[0]);
    const recorder = new MediaRecorder(stream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: 8_000_000,
      audioBitsPerSecond: 160_000,
    });
    this.recorder = recorder;
    this.chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.finished = new Promise<Recording>((resolve, reject) => {
      recorder.onstop = () => {
        const seconds = this.elapsed;
        const type = recorder.mimeType || mimeType || 'video/webm';
        const blob = new Blob(this.chunks, { type: type.split(';')[0] });
        this.cleanup();
        if (!blob.size) {
          reject(new Error('The browser recorded nothing (no video data arrived). Try again, or choose a different window or tab.'));
          return;
        }
        const d = new Date();
        const p2 = (n: number) => String(n).padStart(2, '0');
        // Local time, with dots instead of colons so the name is valid on Windows.
        const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}`;
        resolve({ blob, seconds, name: `Recording ${stamp}.${type.includes('mp4') ? 'mp4' : 'webm'}`, ...this.size });
      };
      recorder.onerror = (e) => {
        this.cleanup();
        reject((e as unknown as { error?: Error }).error ?? new Error('Recording failed'));
      };
    });
    // The user can end sharing from the browser's own bar; treat that as Stop.
    display.getVideoTracks()[0].addEventListener('ended', () => {
      if (this.recorder?.state !== 'inactive') {
        this.markStopped();
        this.recorder?.stop();
        this.onEnded?.();
      }
    });
    recorder.start(1000);
    this.startedAt = performance.now();
    this.stoppedAt = 0;
    this.pausedTotal = 0;
    this.pausedAt = 0;
  }

  pause(): void {
    if (this.recorder?.state === 'recording') {
      this.recorder.pause();
      this.pausedAt = performance.now();
    }
  }

  resume(): void {
    if (this.recorder?.state === 'paused') {
      this.recorder.resume();
      this.pausedTotal += performance.now() - this.pausedAt;
      this.pausedAt = 0;
    }
  }

  async stop(): Promise<Recording> {
    if (!this.recorder || !this.finished) throw new Error('Not recording');
    if (this.recorder.state !== 'inactive') {
      this.markStopped();
      this.recorder.stop();
    }
    return this.finished;
  }

  private markStopped(): void {
    if (this.stoppedAt) return;
    if (this.pausedAt) {
      // Stopped while paused: the pause up to now is not footage either.
      this.pausedTotal += performance.now() - this.pausedAt;
      this.pausedAt = 0;
    }
    this.stoppedAt = performance.now();
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.ondataavailable = null;
      this.recorder.stop();
    }
    this.cleanup();
  }

  private cleanup(): void {
    for (const s of this.streams) for (const t of s.getTracks()) t.stop();
    this.streams = [];
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
  }
}
