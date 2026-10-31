// Audio-only exports: the timeline's mix as WAV (16-bit PCM) or M4A (AAC in an MP4 audio container).
import { type BlobLookup, SAMPLE_RATE, encodeMixedAudio, mixAudio, pickAudioConfig } from './export';
import { Mp4Muxer } from './mp4/muxer';
import type { ByteSink } from './mp4/muxer';
import { projectDuration } from './project';
import type { Project } from './project';
import { type TimeRange, exportSpan } from './range';
import { pcm16, wavHeader } from './wav-export';

export interface AudioExportOptions {
  range?: TimeRange;
  /** Write to this destination as the file is produced (blob is then null). */
  openSink?: () => Promise<ByteSink>;
}

export interface AudioProgress {
  stage: 'preparing' | 'audio' | 'finishing';
  fraction: number;
}

export interface AudioResult {
  blob: Blob | null;
  bytes: number;
  streamed: boolean;
  seconds: number;
  sampleRate: number;
  codec: 'pcm16' | 'aac';
}

async function mixSpan(project: Project, blobs: BlobLookup, range: TimeRange | undefined): Promise<{ mixed: AudioBuffer; seconds: number }> {
  const span = exportSpan(projectDuration(project), range);
  if (!span) throw new Error(range ? 'The in and out marks cover nothing on the timeline' : 'The timeline is empty');
  const seconds = span.end - span.start;
  const mixed = await mixAudio(project, blobs, seconds, span.start);
  if (!mixed) throw new Error('There is no audio to export: no sound clips play in this part of the timeline');
  return { mixed, seconds };
}

function aborted(): Error {
  return new DOMException('Export cancelled', 'AbortError');
}

export async function exportWav(
  project: Project,
  blobs: BlobLookup,
  options: AudioExportOptions = {},
  onProgress: (p: AudioProgress) => void = () => undefined,
  signal?: AbortSignal,
): Promise<AudioResult> {
  onProgress({ stage: 'audio', fraction: 0.05 });
  const { mixed, seconds } = await mixSpan(project, blobs, options.range);
  if (signal?.aborted) throw aborted();
  const channels = [mixed.getChannelData(0), mixed.getChannelData(1)];
  const header = wavHeader({ sampleRate: SAMPLE_RATE, channels: 2, frames: mixed.length });
  const CHUNK = 1 << 17;
  const sink = options.openSink ? await options.openSink() : null;
  try {
    const parts: BlobPart[] = [header as Uint8Array<ArrayBuffer>];
    let position = 0;
    if (sink) {
      await sink.write(header, 0);
      position = header.length;
    }
    for (let i = 0; i < mixed.length; i += CHUNK) {
      if (signal?.aborted) throw aborted();
      const pcm = pcm16(channels, i, Math.min(mixed.length, i + CHUNK));
      if (sink) {
        await sink.write(pcm, position);
        position += pcm.length;
      } else parts.push(pcm as Uint8Array<ArrayBuffer>);
      onProgress({ stage: 'audio', fraction: 0.1 + 0.85 * Math.min(1, (i + CHUNK) / mixed.length) });
    }
    if (sink) {
      await sink.close();
      return { blob: null, bytes: position, streamed: true, seconds, sampleRate: SAMPLE_RATE, codec: 'pcm16' };
    }
    const blob = new Blob(parts, { type: 'audio/wav' });
    return { blob, bytes: blob.size, streamed: false, seconds, sampleRate: SAMPLE_RATE, codec: 'pcm16' };
  } catch (e) {
    await sink?.abort?.();
    throw e;
  }
}

export async function exportM4a(
  project: Project,
  blobs: BlobLookup,
  options: AudioExportOptions = {},
  onProgress: (p: AudioProgress) => void = () => undefined,
  signal?: AbortSignal,
): Promise<AudioResult> {
  onProgress({ stage: 'preparing', fraction: 0 });
  const choice = await pickAudioConfig(true);
  if (!choice) throw new Error('This browser has no AAC audio encoder, so M4A is not available. Export WAV instead.');
  onProgress({ stage: 'audio', fraction: 0.05 });
  const { mixed, seconds } = await mixSpan(project, blobs, options.range);
  if (signal?.aborted) throw aborted();
  const sink = options.openSink ? await options.openSink() : undefined;
  const muxer = new Mp4Muxer(null, { codec: 'aac', sampleRate: SAMPLE_RATE, channels: 2 }, { sink });
  try {
    await encodeMixedAudio(mixed, choice, muxer, signal);
    onProgress({ stage: 'finishing', fraction: 0.97 });
    if (sink) {
      const bytes = await muxer.finalizeStream();
      return { blob: null, bytes, streamed: true, seconds, sampleRate: SAMPLE_RATE, codec: 'aac' };
    }
    const blob = muxer.finalize();
    return { blob: new Blob([blob], { type: 'audio/mp4' }), bytes: blob.size, streamed: false, seconds, sampleRate: SAMPLE_RATE, codec: 'aac' };
  } catch (e) {
    if (sink) await muxer.abort().catch(() => undefined);
    throw e;
  }
}
