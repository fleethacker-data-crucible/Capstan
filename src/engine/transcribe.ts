// Speech-to-text, the pure parts: turning recogniser segments into caption cues, cutting long audio into
// requests at the quietest point, and mixing down to the mono 16 kHz the host's recogniser reads. The host
// calls and the UI are in src/ui/speechClient.ts and src/ui/transcribeRun.ts.
import { type Caption, MAX_CAPTION_CHARS, newId } from './project';

/** One recognised phrase from the host, in seconds from the start of the audio that was sent. */
export interface SpeechSegment {
  start: number;
  end: number;
  text: string;
  confidence?: number;
}

/** The recogniser reads mono, 16 kHz, 16-bit audio. */
export const SPEECH_RATE = 16000;
/** Longest audio sent in one request: 10 minutes is 19.2 MB, inside the host's 30 MB limit. */
export const CHUNK_SECONDS = 600;

export const CUE_MAX_SECONDS = 7;
export const CUE_MAX_LINES = 2;
export const CUE_LINE_CHARS = 42;
/** A cue shorter than this (seconds) or than CUE_MIN_CHARS characters is a fragment: it is merged into a neighbour when it fits. */
export const CUE_MIN_SECONDS = 0.5;
export const CUE_MIN_CHARS = 12;
/** A pause between two phrases at least this long always starts a new cue. */
const PAUSE_BREAK_SECONDS = 0.8;
/** Reading speed used to guess a length for a segment that came without one. */
const CHARS_PER_SECOND = 15;

// ---- text ----

/** Collapses white space and fixes the spacing around punctuation that dictation can leave odd. */
export function tidyText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?%)\]}])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .replace(/([,;!?])(?=[A-Za-z])/g, '$1 ')
    .replace(/([a-z]{2}[.!?])(?=[A-Z])/g, '$1 ')
    .trim();
}

/**
 * Lays text out on at most CUE_MAX_LINES lines of CUE_LINE_CHARS. Two lines are balanced (the break
 * nearest the middle that keeps both inside the limit). Returns null when the text cannot fit.
 */
export function layoutLines(text: string): string[] | null {
  if (text.length <= CUE_LINE_CHARS) return [text];
  let best = -1;
  let gap = Infinity;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ' ') continue;
    const left = i;
    const right = text.length - i - 1;
    if (left > CUE_LINE_CHARS || right > CUE_LINE_CHARS) continue;
    const d = Math.abs(left - right);
    if (d < gap) {
      gap = d;
      best = i;
    }
  }
  return best < 0 ? null : [text.slice(0, best), text.slice(best + 1)];
}

// ---- segments to cues ----

interface Word {
  text: string;
  start: number;
  end: number;
  /** First word of a recogniser segment. */
  fresh: boolean;
}

const MAX_CUE_CHARS = CUE_MAX_LINES * CUE_LINE_CHARS + (CUE_MAX_LINES - 1);

/** Segments cleaned up: finite times, no empty text, in order, no overlaps, every one with a length. */
function normalise(segments: SpeechSegment[]): SpeechSegment[] {
  const clean = segments
    .map((s) => ({ ...s, text: tidyText(String(s.text ?? '')), start: Number(s.start), end: Number(s.end) }))
    .filter((s) => s.text && Number.isFinite(s.start))
    .sort((a, b) => a.start - b.start);
  const out: SpeechSegment[] = [];
  let floor = 0;
  for (const s of clean) {
    const start = Math.max(0, s.start, floor);
    let end = Number.isFinite(s.end) ? s.end : start;
    if (end <= start) end = start + Math.max(0.5, s.text.length / CHARS_PER_SECOND);
    out.push({ ...s, start, end });
    floor = end;
  }
  return out;
}

/** Words with their times spread over the segment in proportion to their length. Words wider than a line are cut. */
function wordsOf(segments: SpeechSegment[]): Word[] {
  const words: Word[] = [];
  for (const s of segments) {
    const pieces: string[] = [];
    for (const raw of s.text.split(' ')) {
      for (let i = 0; i < raw.length; i += CUE_LINE_CHARS) pieces.push(raw.slice(i, i + CUE_LINE_CHARS));
    }
    const total = pieces.reduce((n, p) => n + p.length, 0) + pieces.length - 1;
    let used = 0;
    pieces.forEach((p, i) => {
      const a = s.start + ((s.end - s.start) * used) / total;
      used += p.length;
      const b = s.start + ((s.end - s.start) * used) / total;
      used += 1;
      words.push({ text: p, start: a, end: b, fresh: i === 0 });
    });
  }
  return words;
}

const textOf = (ws: Word[]) => ws.map((w) => w.text).join(' ');
const spanOf = (ws: Word[]) => ws[ws.length - 1].end - ws[0].start;
const endsSentence = (w: Word) => /[.?!]["')\]]*$/.test(w.text);
const endsClause = (w: Word) => /[,;:.?!]["')\]]*$/.test(w.text);
const fragment = (ws: Word[]) => spanOf(ws) < CUE_MIN_SECONDS || textOf(ws).length < CUE_MIN_CHARS;

function fits(ws: Word[]): boolean {
  const text = textOf(ws);
  return text.length <= MAX_CUE_CHARS && spanOf(ws) <= CUE_MAX_SECONDS && layoutLines(text) !== null;
}

/**
 * Turns recogniser segments into caption cues of at most CUE_MAX_SECONDS and two lines of CUE_LINE_CHARS.
 * Timing comes from the segment positions: a cue starts when its first word starts and ends when its last
 * word ends, with the words of a segment spread over it in proportion to their length. Long segments are
 * split (after a sentence or clause if there is one, else where the cue is full); each phrase otherwise keeps
 * its own cue, and fragments (a word or two) are joined to a neighbour unless there is a pause between them.
 * `offset` moves everything later (the start of the audio on the timeline). Cues never overlap.
 */
export function segmentsToCaptions(segments: SpeechSegment[], offset = 0): Caption[] {
  const words = wordsOf(normalise(segments));
  const groups: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const gap = w.start - prev.end;
      if (!fits([...cur, w])) {
        // Full: cut after the last clause end in the second half of the cue, else right here.
        let cut = -1;
        for (let i = cur.length - 2; i >= Math.floor(cur.length * 0.4); i--) {
          if (endsClause(cur[i])) {
            cut = i;
            break;
          }
        }
        if (cut >= 0) {
          groups.push(cur.slice(0, cut + 1));
          cur = cur.slice(cut + 1);
        }
        while (cur.length && !fits([...cur, w])) {
          groups.push(cur);
          cur = [];
        }
      } else if ((endsSentence(prev) && textOf(cur).length >= 20) || (w.fresh && (gap >= PAUSE_BREAK_SECONDS || !fragment(cur)))) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);

  // Join cues that would flash by when they fit with their neighbour and there is no real pause.
  const short = fragment;
  for (let i = 0; i < groups.length; ) {
    const g = groups[i];
    const next = groups[i + 1];
    const prev = groups[i - 1];
    if (short(g) && next && next[0].start - g[g.length - 1].end < PAUSE_BREAK_SECONDS && fits([...g, ...next])) {
      groups.splice(i, 2, [...g, ...next]);
    } else if (short(g) && prev && g[0].start - prev[prev.length - 1].end < PAUSE_BREAK_SECONDS && fits([...prev, ...g])) {
      groups.splice(i - 1, 2, [...prev, ...g]);
      i = Math.max(0, i - 1);
    } else i++;
  }

  const shift = Number.isFinite(offset) ? offset : 0;
  return groups.map((g, i) => {
    const start = g[0].start;
    // Hold a short cue a little longer if the next one leaves room.
    const room = i + 1 < groups.length ? groups[i + 1][0].start : Infinity;
    const end = Math.min(room, Math.max(g[g.length - 1].end, start + 0.8));
    const lines = layoutLines(textOf(g)) ?? [textOf(g)];
    return { id: newId('cap'), start: Math.max(0, start + shift), end: Math.max(0, end + shift), text: lines.join('\n').slice(0, MAX_CAPTION_CHARS) };
  });
}

// ---- audio ----

/**
 * Mixes the channels down to mono and resamples to 16 kHz with a windowed-sinc low-pass (a whole-number
 * ratio, which is what the 48 kHz timeline mix always is) or, for any other rate, a box average and linear
 * interpolation.
 */
export function toMono16k(channels: Float32Array[], rate: number): Float32Array {
  const frames = channels[0]?.length ?? 0;
  const mono = new Float32Array(frames);
  for (const ch of channels) for (let i = 0; i < frames; i++) mono[i] += ch[i] / channels.length;
  if (rate === SPEECH_RATE || frames === 0) return mono;
  const ratio = rate / SPEECH_RATE;
  const outLength = Math.floor(frames / ratio);
  const out = new Float32Array(outLength);
  if (Number.isInteger(ratio)) {
    // Low-pass just under the new Nyquist frequency, Hann-windowed, 8 lobes each side.
    const radius = 8 * ratio;
    const cutoff = 0.9 / (2 * ratio);
    const kernel = new Float32Array(2 * radius + 1);
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const x = 2 * Math.PI * cutoff * k;
      const sinc = k === 0 ? 1 : Math.sin(x) / x;
      const hann = 0.5 + 0.5 * Math.cos((Math.PI * k) / (radius + 1));
      kernel[k + radius] = sinc * hann;
      sum += kernel[k + radius];
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    for (let i = 0; i < outLength; i++) {
      const centre = i * ratio;
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const at = centre + k;
        if (at >= 0 && at < frames) acc += mono[at] * kernel[k + radius];
      }
      out[i] = acc;
    }
    return out;
  }
  const width = Math.max(1, Math.round(ratio));
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const a = Math.floor(pos);
    const f = pos - a;
    const avg = (from: number) => {
      let acc = 0;
      let n = 0;
      for (let k = 0; k < width; k++) {
        const at = from + k - Math.floor(width / 2);
        if (at >= 0 && at < frames) {
          acc += mono[at];
          n++;
        }
      }
      return n ? acc / n : 0;
    };
    out[i] = avg(a) * (1 - f) + avg(a + 1) * f;
  }
  return out;
}

export interface AudioChunk {
  /** Sample index, inclusive. */
  start: number;
  /** Sample index, exclusive. */
  end: number;
}

/** The middle of the quietest 200 ms stretch between samples `lo` and `hi` (a run of equally quiet stretches counts once). */
function quietestPoint(samples: Float32Array, rate: number, lo: number, hi: number): number {
  const win = Math.max(2, Math.floor(rate * 0.2));
  const last = Math.min(samples.length, hi) - win;
  if (last <= lo) return Math.min(samples.length, hi);
  let energy = 0;
  for (let i = lo; i < lo + win; i++) energy += samples[i] * samples[i];
  let best = energy;
  let first = lo;
  let tail = lo;
  for (let at = lo + 1; at <= last; at++) {
    energy += samples[at + win - 1] ** 2 - samples[at - 1] ** 2;
    if (energy < best - 1e-9) {
      best = energy;
      first = at;
      tail = at;
    } else if (Math.abs(energy - best) <= 1e-9) tail = at;
  }
  return Math.floor((first + tail) / 2) + Math.floor(win / 2);
}

/**
 * Cuts the audio into pieces of at most `maxSeconds`, each cut at the quietest point of the last
 * `searchSeconds` before the limit (never in the first half of a piece), so words are rarely split.
 */
export function planChunks(samples: Float32Array, rate: number, maxSeconds = CHUNK_SECONDS, searchSeconds = 60): AudioChunk[] {
  const total = samples.length;
  if (total === 0) return [];
  const max = Math.max(1, Math.floor(maxSeconds * rate));
  const chunks: AudioChunk[] = [];
  let pos = 0;
  while (total - pos > max) {
    const hi = pos + max;
    const lo = Math.max(pos + Math.floor(max / 2), hi - Math.floor(searchSeconds * rate));
    const cut = Math.min(hi, Math.max(pos + 1, quietestPoint(samples, rate, lo, hi)));
    chunks.push({ start: pos, end: cut });
    pos = cut;
  }
  chunks.push({ start: pos, end: total });
  return chunks;
}
