// Fast export decoding: reads a video's sample table (demux/mp4.ts, demux/webm.ts) and feeds a
// WebCodecs VideoDecoder in order, instead of seeking a <video> element to every output frame.
// Covers H.264 in MP4 and VP8/VP9 in WebM or MP4; for anything else open() returns null and the
// export keeps using the seeking path (frames.ts decides, per clip).
import { openMp4 } from './demux/mp4';
import type { VideoSample, VideoTrackInfo } from './demux/types';
import { openWebm } from './demux/webm';

/** Reads the container of a video file. Null when it is not a layout the fast path understands. */
export async function demuxVideo(blob: Blob): Promise<VideoTrackInfo | null> {
  try {
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return await openWebm(blob);
    if (String.fromCharCode(...head.subarray(4, 8)) === 'ftyp') return await openMp4(blob);
  } catch {
    /* an unreadable file is handled by the element path */
  }
  return null;
}

export class FastDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FastDecodeError';
  }
}

/** How long the decoder may stay silent while it has input before the fast path gives up. */
const STALL_MS = 5000;
/** Input kept queued in the decoder. */
const QUEUE_AHEAD = 6;

/** Pure helpers, exported for the unit tests. */
export function presentationOrder(samples: VideoSample[]): number[] {
  return samples.map((_, i) => i).sort((a, b) => samples[a].pts - samples[b].pts || a - b);
}

/** Position in `order` of the last sample presented at or before `us` (the first sample if none is). */
export function frameIndexAt(samples: VideoSample[], order: number[], us: number): number {
  let lo = 0;
  let hi = order.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[order[mid]].pts <= us) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** Decode index of the closest key sample at or before decode index `di`. */
export function keyBefore(samples: VideoSample[], di: number): number {
  let k = Math.min(di, samples.length - 1);
  while (k > 0 && !samples[k].key) k--;
  return k;
}

export class FastVideoSource {
  private readonly order: number[];
  private decoder: VideoDecoder | null = null;
  private cursor = 0;
  private ready: VideoFrame[] = [];
  private lastOut = -Infinity;
  private dropBelow = -Infinity;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  private lastActivity = 0;
  private current: { pts: number; bitmap: ImageBitmap } | null = null;
  /** Frames handed out, and decoder restarts (a restart is a seek to a key frame). */
  frames = 0;
  restarts = 0;

  constructor(
    private readonly blob: Blob,
    readonly info: VideoTrackInfo,
  ) {
    this.order = presentationOrder(info.samples);
  }

  /** Demuxes and checks the decoder supports the stream. Null means: use the seeking path. */
  static async open(blob: Blob, info?: VideoTrackInfo | null): Promise<FastVideoSource | null> {
    if (typeof VideoDecoder === 'undefined') return null;
    const track = info === undefined ? await demuxVideo(blob) : info;
    if (!track) return null;
    try {
      const support = await VideoDecoder.isConfigSupported(FastVideoSource.configOf(track));
      if (!support.supported) return null;
    } catch {
      return null;
    }
    return new FastVideoSource(blob, track);
  }

  private static configOf(info: VideoTrackInfo): VideoDecoderConfig {
    return {
      codec: info.codec,
      codedWidth: info.width,
      codedHeight: info.height,
      description: info.description,
      optimizeForLatency: true,
      // Media elements read an untagged stream as BT.601; WebCodecs would assume BT.709 and the
      // picture would come out darker and less saturated than the preview. Match the element.
      colorSpace: { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false },
    };
  }

  get duration(): number {
    const s = this.info.samples;
    const last = s[this.order[this.order.length - 1]];
    return (last.pts + last.duration) / 1e6;
  }

  private notify(): void {
    this.lastActivity = performance.now();
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private restart(at: number): void {
    this.decoder?.close();
    for (const f of this.ready) f.close();
    this.ready = [];
    this.lastOut = -Infinity;
    this.failure = null;
    this.cursor = at;
    this.restarts++;
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (decoder !== this.decoder) {
          frame.close();
          return;
        }
        this.lastOut = Math.max(this.lastOut, frame.timestamp);
        if (frame.timestamp < this.dropBelow) frame.close();
        else {
          this.ready.push(frame);
          this.ready.sort((a, b) => a.timestamp - b.timestamp);
        }
        this.notify();
      },
      error: (e) => {
        if (decoder !== this.decoder) return;
        this.failure = new FastDecodeError(e.message || 'The video decoder reported an error');
        this.notify();
      },
    });
    decoder.configure(FastVideoSource.configOf(this.info));
    this.decoder = decoder;
  }

  private async read(i: number): Promise<Uint8Array> {
    const s = this.info.samples[i];
    return new Uint8Array(await this.blob.slice(s.offset, s.offset + s.size).arrayBuffer());
  }

  /**
   * The picture shown at `seconds` in the source. The bitmap belongs to this source: it stays valid
   * until the next call that returns a different frame, or close().
   */
  async frameAt(seconds: number): Promise<ImageBitmap> {
    const samples = this.info.samples;
    const k = frameIndexAt(samples, this.order, Math.round(seconds * 1e6));
    const di = this.order[k];
    const target = samples[di];
    if (this.current && this.current.pts === target.pts) return this.current.bitmap;
    this.dropBelow = target.pts;

    const key = keyBefore(samples, di);
    const behind = target.pts <= this.lastOut && !this.ready.some((f) => f.timestamp === target.pts);
    if (!this.decoder || behind || this.failure || key > this.cursor + 2) this.restart(key);
    else this.dropBelow = target.pts;
    for (const f of [...this.ready]) {
      if (f.timestamp < target.pts) {
        f.close();
        this.ready.splice(this.ready.indexOf(f), 1);
      }
    }

    this.lastActivity = performance.now();
    let flushed = false;
    for (;;) {
      if (this.failure) throw this.failure;
      const exact = this.ready.find((f) => f.timestamp === target.pts);
      const later = this.ready.some((f) => f.timestamp > target.pts);
      if (exact || later || flushed) {
        const frame = exact ?? this.ready.find((f) => f.timestamp <= target.pts) ?? this.ready[0];
        if (!frame) throw new FastDecodeError('The decoder produced no picture for this time');
        this.ready.splice(this.ready.indexOf(frame), 1);
        const bitmap = await createImageBitmap(frame);
        frame.close();
        this.current?.bitmap.close();
        this.current = { pts: target.pts, bitmap };
        this.frames++;
        return bitmap;
      }
      const decoder = this.decoder!;
      if (this.cursor < samples.length && decoder.decodeQueueSize < QUEUE_AHEAD) {
        const batch: number[] = [];
        while (batch.length < QUEUE_AHEAD && this.cursor + batch.length < samples.length) batch.push(this.cursor + batch.length);
        const datas = await Promise.all(batch.map((i) => this.read(i)));
        if (decoder !== this.decoder) continue;
        batch.forEach((i, n) => {
          const s = samples[i];
          decoder.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.pts, duration: s.duration, data: datas[n] }));
        });
        this.cursor += batch.length;
        this.lastActivity = performance.now();
        continue;
      }
      if (this.cursor >= samples.length && decoder.decodeQueueSize === 0) {
        // Everything is in: ask for the frames the decoder is still holding back.
        await decoder.flush().catch((e: Error) => {
          this.failure = new FastDecodeError(e.message);
        });
        flushed = true;
        // A flushed decoder wants a key frame next, so the following call restarts it.
        this.cursor = samples.length + 1;
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        this.wake = resolve;
        const timer = setInterval(() => {
          if (performance.now() - this.lastActivity > STALL_MS) {
            clearInterval(timer);
            this.wake = null;
            reject(new FastDecodeError('The video decoder stopped responding'));
          }
        }, 250);
        const done = resolve;
        this.wake = () => {
          clearInterval(timer);
          done();
        };
      });
    }
  }

  close(): void {
    this.decoder?.close();
    this.decoder = null;
    for (const f of this.ready) f.close();
    this.ready = [];
    this.current?.bitmap.close();
    this.current = null;
  }
}
