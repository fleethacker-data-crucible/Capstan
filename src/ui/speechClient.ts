// The browser side of the host's speech-to-text endpoint (modules/Speech.ps1). Audio goes to the
// local host on this PC only; the host runs the Windows recogniser and answers with timed text.
import type { SpeechSegment } from '../engine/transcribe';
import { sessionToken } from './lifecycle';

export interface SpeechStatus {
  /** "windows" (the real recogniser), "fake" (tests only) or "none" (System.Speech is missing). */
  engine: 'windows' | 'fake' | 'none';
  available: boolean;
  /** Cultures that have a Windows speech recogniser installed, such as "en-US". */
  cultures: string[];
  maxBytes: number;
  reason?: string;
}

/** An error with the host's code ("no-recogniser", "unsupported-format", "busy", ...), or "standalone" / "offline". */
export class SpeechError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SpeechError';
    this.code = code;
  }
}

const abortError = () => new DOMException('Transcription cancelled', 'AbortError');
export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { 'X-Capstan-Token': sessionToken(), ...extra };
}

function requireHost() {
  if (!sessionToken()) throw new SpeechError('standalone', 'Speech-to-text needs the Capstan host. Open Capstan with Launch-Capstan.bat.');
}

// The host answers with small JSON bodies that are read field by field, so they stay loosely typed here.
async function call(path: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new SpeechError('offline', 'Capstan could not reach its local host. Is it still running?');
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* no JSON body */
  }
  if (!res.ok) throw new SpeechError(String(body?.code ?? 'failed'), String(body?.error ?? `The speech request failed (HTTP ${res.status}).`));
  return body;
}

export async function speechStatus(signal?: AbortSignal): Promise<SpeechStatus> {
  requireHost();
  return (await call('/api/speech/status', { headers: headers(), signal })) as SpeechStatus;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export interface ChunkResult {
  segments: SpeechSegment[];
  culture: string;
  engine: string;
}

/**
 * Sends one WAV (mono, 16 kHz, 16-bit, at most about 10 minutes) and waits for the segments, polling the job.
 * `onProgress` gets 0 to 1. Aborting the signal cancels the job on the host.
 */
export async function transcribeWav(wav: Blob, culture: string, onProgress: (fraction: number) => void, signal?: AbortSignal, pollMs = 400): Promise<ChunkResult> {
  requireHost();
  let started: any = null;
  // A job that was just cancelled may take a moment to wind down: try again for a few seconds.
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError();
    try {
      // Not tied to the signal: once the request is sent the host has the job, and it must be possible to cancel it.
      started = await call(`/api/speech/transcribe?culture=${encodeURIComponent(culture)}`, { method: 'POST', headers: headers({ 'Content-Type': 'audio/wav' }), body: wav });
      break;
    } catch (e) {
      if (e instanceof SpeechError && e.code === 'busy' && attempt < 10) {
        await wait(500, signal);
        continue;
      }
      throw e;
    }
  }
  const id = String(started.job);
  const release = () => void call(`/api/speech/${id}`, { method: 'DELETE', headers: headers() }).catch(() => undefined);
  try {
    let view = started;
    for (;;) {
      if (view.state === 'done') {
        onProgress(1);
        return { segments: (view.segments ?? []) as SpeechSegment[], culture: String(view.culture), engine: String(view.engine) };
      }
      if (view.state === 'cancelled') throw abortError();
      if (view.state === 'error') throw new SpeechError(String(view.code ?? 'failed'), String(view.error ?? 'The speech recogniser failed.'));
      onProgress(Number(view.progress) || 0);
      await wait(pollMs, signal);
      view = await call(`/api/speech/${id}`, { headers: headers(), signal });
    }
  } finally {
    // Cancels a running job (after Cancel) and frees a finished one; the host also forgets jobs after 15 minutes.
    release();
  }
}
