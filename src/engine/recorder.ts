// Screen recording with the browser's screen-capture permission. By default system audio (when the
// user shares it) and the microphone are mixed into one track; "separate tracks" records each on
// its own. A webcam can be recorded in parallel. Every source has its own MediaRecorder, and the
// chunks can stream to disk (see recording-store.ts) so memory stays flat on a long recording.
import { type WebcamOptions, webcamConstraints } from './recording-sources';
import {
  type ChunkSink,
  type DiskSinkOptions,
  MemorySink,
  type PartRole,
  type PlacementPlan,
  type RecordingStore,
  newManifest,
  newSessionId,
  partFileName,
} from './recording-store';

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
  /** Record the microphone and computer sound as separate files instead of one mixed track. */
  separateAudio?: boolean;
  /** Ask the browser to leave the mouse pointer out of the capture (off by default). */
  hideCursor?: boolean;
  /** Record the webcam as its own file. */
  webcam?: WebcamOptions | null;
  /** Stream chunks into this store; without one they stay in memory. */
  store?: RecordingStore | null;
  /** Segment sizes for the store (tests use small ones). */
  sink?: DiskSinkOptions;
}

/** A recorded source other than the screen. */
export interface RecordingPart {
  role: Exclude<PartRole, 'screen'>;
  blob: Blob;
  name: string;
  seconds: number;
  width: number;
  height: number;
}

export interface Recording {
  blob: Blob;
  seconds: number;
  name: string;
  width: number;
  height: number;
  /** Webcam, microphone and system sound, when recorded on their own. */
  parts: RecordingPart[];
  /** Things the user should know: a source that was unavailable, a disk fallback. */
  notes: string[];
  /** The store session holding the footage on disk, if any. */
  session: string | null;
}

/**
 * getDisplayMedia options for a surface. For a tab or a window, screens are excluded from the
 * picker so the whole desktop cannot be shared by mistake.
 */
export function displayMediaOptions(o: RecordOptions): DisplayMediaStreamOptions & Record<string, unknown> {
  const surface = o.surface ?? 'monitor';
  const video: MediaTrackConstraints & Record<string, unknown> = { frameRate: { ideal: o.frameRate, max: 60 }, displaySurface: surface };
  if (o.hideCursor) video.cursor = 'never';
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

/** Audio-only formats: Opus in WebM first (always playable here), then AAC in MP4. */
export function audioRecorderType(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'];
  if (typeof MediaRecorder === 'undefined') return '';
  return types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

/** File extension for a recorder MIME type. */
export function extensionFor(type: string): string {
  if (type.includes('mp4')) return 'mp4';
  if (type.includes('ogg')) return 'ogg';
  return 'webm';
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

/** One MediaRecorder and where its chunks go. */
interface Lane {
  role: PartRole;
  recorder: MediaRecorder;
  sink: ChunkSink;
  type: string;
  width: number;
  height: number;
  /** Resolves with the finished file once the recorder has stopped and its chunks are flushed. */
  result: Promise<Blob>;
}

/** Everything chosen and probed before recording starts (so a countdown can sit in between). */
interface Prepared {
  options: RecordOptions;
  display: MediaStream;
  mic: MediaStream | null;
  webcam: MediaStream | null;
  screenType: string;
  webcamType: string;
  notes: string[];
}

export class ScreenRecorder {
  private lanes: Lane[] = [];
  private prepared: Prepared | null = null;
  private streams: MediaStream[] = [];
  private audioContext: AudioContext | null = null;
  private startedAt = 0;
  private stoppedAt = 0;
  private pausedTotal = 0;
  private pausedAt = 0;
  private finished: Promise<Recording> | null = null;
  private size = { width: 0, height: 0 };
  private session: string | null = null;
  private store: RecordingStore | null = null;
  private notes: string[] = [];
  private cancelled = false;
  /** The shared screen ended (the browser's "Stop sharing" bar), before or during recording. */
  onEnded: (() => void) | null = null;

  get state(): RecordingState | 'idle' {
    return this.lanes[0]?.recorder.state ?? 'idle';
  }

  /** True between `prepare` and `begin`: the screen is shared but nothing is recorded yet. */
  get isPrepared(): boolean {
    return this.prepared !== null && this.lanes.length === 0;
  }

  /** Size of the shared screen in pixels (0 until known). */
  get sourceSize(): { width: number; height: number } {
    return this.size;
  }

  /** The id of the on-disk session, or null when recording in memory. */
  get sessionId(): string | null {
    return this.session;
  }

  get elapsed(): number {
    if (!this.startedAt) return 0;
    // Frozen at Stop: the recorder can take a second to flush, and that is not footage.
    const now = this.pausedAt || this.stoppedAt || performance.now();
    return (now - this.startedAt - this.pausedTotal) / 1000;
  }

  /** Bytes the recording has produced so far (every source). */
  get bytes(): number {
    return this.lanes.reduce((n, l) => n + l.sink.received, 0);
  }

  /** Bytes already safely written to disk (0 when recording in memory). */
  get bytesOnDisk(): number {
    return this.lanes.reduce((n, l) => n + l.sink.written, 0);
  }

  /** Asks for the screen (and webcam, microphone), checks them and picks recording formats. */
  async prepare(options: RecordOptions): Promise<void> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen recording needs a current Edge or Chrome on this computer.');
    }
    this.notes = [];
    const display = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions(options));
    this.streams.push(display);
    const settings = display.getVideoTracks()[0]?.getSettings() ?? {};
    const problem = surfaceProblem(options.surface ?? 'monitor', settings);
    if (problem) {
      this.cleanup();
      throw new Error(problem);
    }
    this.size = { width: settings.width ?? 0, height: settings.height ?? 0 };
    display.getVideoTracks()[0].addEventListener('ended', () => this.sharingEnded());

    let webcam: MediaStream | null = null;
    if (options.webcam) {
      try {
        webcam = await navigator.mediaDevices.getUserMedia(webcamConstraints(options.webcam));
        this.streams.push(webcam);
      } catch (e) {
        this.cleanup();
        const name = (e as Error).name;
        throw new Error(
          name === 'NotAllowedError'
            ? 'The webcam was blocked. Allow the camera for this page, or turn the webcam off.'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'That camera was not found. Choose another camera, or turn the webcam off.'
              : `The webcam could not be started: ${(e as Error).message}`,
        );
      }
    }
    let mic: MediaStream | null = null;
    if (options.microphone) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        this.streams.push(mic);
      } catch {
        mic = null; // carry on without the microphone rather than failing the recording
        this.notes.push('The microphone was not available, so it was not recorded.');
      }
    }
    const [screenType, webcamType] = await Promise.all([
      workingRecorderType(display.getVideoTracks()[0]),
      webcam ? workingRecorderType(webcam.getVideoTracks()[0]) : Promise.resolve(''),
    ]);
    this.prepared = { options, display, mic, webcam, screenType, webcamType, notes: this.notes };
  }

  /**
   * A still of the shared screen as a JPEG data URL, for the region step. `width` and `height`
   * are the real size of the source, which the region is measured in.
   */
  async grabStill(maxWidth = 1280): Promise<{ url: string; width: number; height: number }> {
    const track = this.prepared?.display.getVideoTracks()[0];
    if (!track) throw new Error('Nothing is being shared.');
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The shared screen did not show a picture in time.')), 5000);
        const ready = () => {
          if (video.videoWidth > 0) {
            clearTimeout(timer);
            resolve();
          }
        };
        video.addEventListener('loadeddata', ready);
        video.addEventListener('resize', ready);
        void video.play().then(ready, reject);
      });
      const width = video.videoWidth;
      const height = video.videoHeight;
      this.size = { width, height };
      const k = Math.min(1, maxWidth / width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * k));
      canvas.height = Math.max(1, Math.round(height * k));
      canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
      return { url: canvas.toDataURL('image/jpeg', 0.85), width, height };
    } finally {
      video.pause();
      video.srcObject = null;
    }
  }

  /** Starts every recorder at once. `plan` is stored with the footage so a recovery places it the same way. */
  async begin(plan: PlacementPlan = { pip: true }): Promise<void> {
    const prep = this.prepared;
    if (!prep) throw new Error('Nothing is ready to record.');
    const { options, display, mic, webcam } = prep;
    const separate = !!options.separateAudio;
    const displayAudio = display.getAudioTracks();
    const micAudio = mic?.getAudioTracks() ?? [];

    // Which recorders, and which tracks each one takes.
    const plans: Array<{ role: PartRole; tracks: MediaStreamTrack[]; type: string; width: number; height: number }> = [];
    const screenTracks: MediaStreamTrack[] = [...display.getVideoTracks()];
    if (!separate) {
      if (displayAudio.length + micAudio.length === 1) {
        screenTracks.push(displayAudio[0] ?? micAudio[0]);
      } else if (displayAudio.length + micAudio.length > 1) {
        this.audioContext = new AudioContext();
        const destination = this.audioContext.createMediaStreamDestination();
        for (const s of [display, mic]) {
          if (s && s.getAudioTracks().length) this.audioContext.createMediaStreamSource(s).connect(destination);
        }
        screenTracks.push(destination.stream.getAudioTracks()[0]);
      }
    }
    plans.push({ role: 'screen', tracks: screenTracks, type: prep.screenType, ...this.size });
    if (webcam) {
      const s = webcam.getVideoTracks()[0]?.getSettings() ?? {};
      plans.push({ role: 'webcam', tracks: webcam.getVideoTracks(), type: prep.webcamType, width: s.width ?? 0, height: s.height ?? 0 });
    }
    if (separate) {
      const type = audioRecorderType();
      if (micAudio.length) plans.push({ role: 'mic', tracks: micAudio, type, width: 0, height: 0 });
      if (displayAudio.length) plans.push({ role: 'system', tracks: displayAudio, type, width: 0, height: 0 });
      else if (options.systemAudio) this.notes.push('No computer sound was shared, so there is no system audio track. Choose “Share audio” in the browser prompt.');
    } else if (options.systemAudio && !displayAudio.length) {
      this.notes.push('No computer sound was shared (choose “Share audio” in the browser prompt).');
    }

    // On disk when a store is given: the manifest first, so even a crash right now leaves a trace.
    const startDate = new Date();
    const store = options.store ?? null;
    let session: string | null = null;
    if (store) {
      session = newSessionId(startDate);
      try {
        await store.begin(
          newManifest(session, startDate.getTime(), {
            name: partFileName('screen', startDate, extensionFor(prep.screenType)),
            width: this.size.width,
            height: this.size.height,
            place: plan,
            parts: Object.fromEntries(
              plans.map((p) => {
                const ext = extensionFor(p.type);
                const mime = p.type.split(';')[0] || (p.role === 'mic' || p.role === 'system' ? 'audio/webm' : 'video/webm');
                return [p.role, { ext, mime, width: p.width, height: p.height }];
              }),
            ),
          }),
        );
        this.store = store;
        this.session = session;
      } catch {
        session = null;
        this.notes.push('Recording to disk was not possible, so the recording is kept in memory.');
      }
    }

    const lanes: Lane[] = plans.map((p) => {
      const isAudio = p.role === 'mic' || p.role === 'system';
      const recorder = new MediaRecorder(new MediaStream(p.tracks), {
        mimeType: p.type || undefined,
        ...(isAudio ? { audioBitsPerSecond: 128_000 } : { videoBitsPerSecond: p.role === 'webcam' ? 4_000_000 : 8_000_000, audioBitsPerSecond: 160_000 }),
      });
      const ext = extensionFor(p.type || recorder.mimeType);
      const sink: ChunkSink =
        session && store
          ? store.sink(session, p.role, ext, { ...options.sink, onFallback: () => this.notes.push('Writing to disk failed part way, so the rest of the recording is kept in memory.') })
          : new MemorySink();
      recorder.ondataavailable = (e) => {
        if (e.data.size) sink.push(e.data);
      };
      return { role: p.role, recorder, sink, type: p.type, width: p.width, height: p.height, result: Promise.resolve(new Blob()) };
    });
    const screen = lanes[0];
    for (const lane of lanes) {
      lane.result = new Promise<Blob>((resolve, reject) => {
        lane.recorder.onstop = () => {
          const type = (lane.recorder.mimeType || lane.type || (lane.role === 'mic' || lane.role === 'system' ? 'audio/webm' : 'video/webm')).split(';')[0];
          resolve(lane.sink.finish(type));
        };
        lane.recorder.onerror = (e) => reject((e as unknown as { error?: Error }).error ?? new Error('Recording failed'));
      });
      // A source that fails alone must not become an unhandled rejection; `finished` reports it.
      lane.result.catch(() => undefined);
    }
    this.lanes = lanes;
    this.prepared = null;

    this.finished = (async () => {
      let screenBlob: Blob;
      try {
        screenBlob = await screen.result;
      } catch (e) {
        this.cleanup();
        void this.discardSession();
        throw e;
      }
      const seconds = this.elapsed;
      const parts: RecordingPart[] = [];
      for (const lane of lanes.slice(1)) {
        try {
          const blob = await lane.result;
          if (!blob.size) {
            this.notes.push(`The ${lane.role === 'webcam' ? 'webcam' : lane.role === 'mic' ? 'microphone' : 'system audio'} recorded nothing, so it was left out.`);
            continue;
          }
          parts.push({ role: lane.role as RecordingPart['role'], blob, name: partFileName(lane.role, startDate, extensionFor(blob.type || lane.type)), seconds, width: lane.width, height: lane.height });
        } catch {
          this.notes.push(`The ${lane.role} recording failed and was left out.`);
        }
      }
      this.cleanup();
      if (this.cancelled) throw new Error('Recording cancelled');
      if (!screenBlob.size) {
        void this.discardSession();
        throw new Error('The browser recorded nothing (no video data arrived). Try again, or choose a different window or tab.');
      }
      if (this.store && this.session) {
        await this.store.update(this.session, { complete: true, seconds }).catch(() => undefined);
        this.store.release(this.session);
      }
      return {
        blob: screenBlob,
        seconds,
        name: partFileName('screen', startDate, extensionFor(screenBlob.type || screen.type)),
        ...this.size,
        parts,
        notes: this.notes,
        session: this.session,
      };
    })();
    this.finished.catch(() => undefined);

    // Ending the share from the browser's own bar is handled by sharingEnded, registered in prepare.
    for (const lane of lanes) lane.recorder.start(1000);
    this.startedAt = performance.now();
    this.stoppedAt = 0;
    this.pausedTotal = 0;
    this.pausedAt = 0;
  }

  /** Shares the screen and records at once (no countdown, no region): the original one-step flow. */
  async start(options: RecordOptions): Promise<void> {
    await this.prepare(options);
    await this.begin();
  }

  private sharingEnded(): void {
    if (this.lanes.length === 0) {
      // Before recording: the sharing ended during the countdown or region step.
      if (this.prepared) this.onEnded?.();
      return;
    }
    if (this.lanes[0].recorder.state !== 'inactive') {
      this.markStopped();
      this.stopLanes();
      this.onEnded?.();
    }
  }

  private stopLanes(): void {
    for (const lane of this.lanes) if (lane.recorder.state !== 'inactive') lane.recorder.stop();
  }

  pause(): void {
    if (this.state === 'recording') {
      for (const lane of this.lanes) if (lane.recorder.state === 'recording') lane.recorder.pause();
      this.pausedAt = performance.now();
    }
  }

  resume(): void {
    if (this.state === 'paused') {
      for (const lane of this.lanes) if (lane.recorder.state === 'paused') lane.recorder.resume();
      this.pausedTotal += performance.now() - this.pausedAt;
      this.pausedAt = 0;
    }
  }

  async stop(): Promise<Recording> {
    if (!this.lanes.length || !this.finished) throw new Error('Not recording');
    if (this.lanes[0].recorder.state !== 'inactive') {
      this.markStopped();
      this.stopLanes();
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

  /** Gives up: stops everything and deletes any footage already written. */
  cancel(): void {
    this.cancelled = true;
    for (const lane of this.lanes) {
      if (lane.recorder.state !== 'inactive') {
        lane.recorder.ondataavailable = null;
        lane.recorder.stop();
      }
    }
    this.prepared = null;
    this.cleanup();
    void this.discardSession();
  }

  private async discardSession(): Promise<void> {
    const { store, session } = this;
    if (!store || !session) return;
    this.session = null;
    // Let in-flight segment writes finish first so nothing is recreated after the delete.
    await Promise.allSettled(this.lanes.map((l) => l.result));
    await store.discard(session).catch(() => undefined);
  }

  private cleanup(): void {
    for (const s of this.streams) for (const t of s.getTracks()) t.stop();
    this.streams = [];
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
  }
}
