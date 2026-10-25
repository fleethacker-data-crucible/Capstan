// Screen recording with the browser's screen-capture permission. System audio (when the user
// shares it) and the microphone are mixed into one track, since MediaRecorder records one.

export interface RecordOptions {
  microphone: boolean;
  systemAudio: boolean;
  frameRate: number;
}

export interface Recording {
  blob: Blob;
  seconds: number;
  name: string;
}

/** MP4 where the browser can record it (current Edge/Chrome on Windows), WebM otherwise. */
export function pickRecorderType(): string {
  const types = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return types.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) ?? '';
}

export class ScreenRecorder {
  private recorder: MediaRecorder | null = null;
  private streams: MediaStream[] = [];
  private audioContext: AudioContext | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private pausedTotal = 0;
  private pausedAt = 0;
  private finished: Promise<Recording> | null = null;
  onEnded: (() => void) | null = null;

  get state(): RecordingState | 'idle' {
    return this.recorder?.state ?? 'idle';
  }

  get elapsed(): number {
    if (!this.startedAt) return 0;
    const now = this.pausedAt || performance.now();
    return (now - this.startedAt - this.pausedTotal) / 1000;
  }

  async start(options: RecordOptions): Promise<void> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen recording needs a current Edge or Chrome on this computer.');
    }
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: options.frameRate, max: 60 } },
      audio: options.systemAudio,
    });
    this.streams.push(display);
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
    const mimeType = pickRecorderType();
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
        const d = new Date();
        const p2 = (n: number) => String(n).padStart(2, '0');
        // Local time, with dots instead of colons so the name is valid on Windows.
        const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}`;
        resolve({ blob, seconds, name: `Recording ${stamp}.${type.includes('mp4') ? 'mp4' : 'webm'}` });
      };
      recorder.onerror = (e) => {
        this.cleanup();
        reject((e as unknown as { error?: Error }).error ?? new Error('Recording failed'));
      };
    });
    // The user can end sharing from the browser's own bar; treat that as Stop.
    display.getVideoTracks()[0].addEventListener('ended', () => {
      if (this.recorder?.state !== 'inactive') {
        this.recorder?.stop();
        this.onEnded?.();
      }
    });
    recorder.start(1000);
    this.startedAt = performance.now();
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
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    return this.finished;
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
