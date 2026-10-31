// Transcribe a stretch of the timeline: mix it to mono 16 kHz in the browser, send it to the host in pieces of
// at most 10 minutes (cut at the quietest point), and gather the segments with their time offsets.
import { type BlobLookup, mixAudio } from '../engine/export';
import type { Project } from '../engine/project';
import type { TimeRange } from '../engine/range';
import { CHUNK_SECONDS, SPEECH_RATE, type SpeechSegment, planChunks, toMono16k } from '../engine/transcribe';
import { encodeWav } from '../engine/wav-export';
import { transcribeWav } from './speechClient';

export interface TranscribeRequest {
  project: Project;
  blobs: BlobLookup;
  /** Timeline stretch to transcribe, seconds. */
  span: TimeRange;
  /** Only this clip's sound (the selected clip), else everything that plays in the span. */
  clipId?: string;
  culture: string;
  onProgress(fraction: number, detail: string): void;
  signal?: AbortSignal;
}

export interface TranscribeResult {
  /** Seconds from the start of `span`. */
  segments: SpeechSegment[];
  pieces: number;
  culture: string;
}

export async function transcribeSpan(req: TranscribeRequest): Promise<TranscribeResult> {
  const { project, span, signal } = req;
  const mixProject = req.clipId ? { ...project, clips: project.clips.filter((c) => c.id === req.clipId) } : project;
  req.onProgress(0, 'Mixing the sound');
  const mixed = await mixAudio(mixProject, req.blobs, span.end - span.start, span.start);
  if (!mixed) throw new Error('No sound plays in that part of the timeline, so there is nothing to transcribe.');
  if (signal?.aborted) throw new DOMException('Transcription cancelled', 'AbortError');
  const channels = Array.from({ length: mixed.numberOfChannels }, (_, c) => mixed.getChannelData(c));
  const mono = toMono16k(channels, mixed.sampleRate);
  const chunks = planChunks(mono, SPEECH_RATE, CHUNK_SECONDS);
  const segments: SpeechSegment[] = [];
  let culture = req.culture;
  for (let i = 0; i < chunks.length; i++) {
    const { start, end } = chunks[i];
    const detail = chunks.length > 1 ? `Recognising part ${i + 1} of ${chunks.length}` : 'Recognising speech';
    const base = i / chunks.length;
    req.onProgress(0.03 + 0.97 * base, detail);
    const wav = encodeWav([mono.subarray(start, end)], SPEECH_RATE);
    const result = await transcribeWav(wav, req.culture, (f) => req.onProgress(0.03 + 0.97 * (base + f / chunks.length), detail), signal);
    culture = result.culture;
    const offset = start / SPEECH_RATE;
    for (const s of result.segments) segments.push({ ...s, start: s.start + offset, end: s.end + offset });
  }
  req.onProgress(1, 'Done');
  return { segments, pieces: chunks.length, culture };
}
