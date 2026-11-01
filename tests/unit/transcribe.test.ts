import { describe, expect, test } from 'bun:test';
import { CUE_LINE_CHARS, CUE_MAX_SECONDS, type SpeechSegment, layoutLines, planChunks, segmentsToCaptions, tidyText, toMono16k } from '../../src/engine/transcribe';

const seg = (start: number, end: number, text: string): SpeechSegment => ({ start, end, text, confidence: 0.9 });
const lines = (text: string) => text.split('\n');

describe('tidyText', () => {
  test('collapses white space and closes the gap before punctuation', () => {
    expect(tidyText('  hello   world , how are you ?  ')).toBe('hello world, how are you?');
    expect(tidyText('wait ( what ) now')).toBe('wait (what) now');
  });
  test('adds the missing space after punctuation but leaves numbers and abbreviations alone', () => {
    expect(tidyText('one,two;three')).toBe('one, two; three');
    expect(tidyText('about 1,000 and 3.5 or 10:30')).toBe('about 1,000 and 3.5 or 10:30');
    expect(tidyText('Done.Next')).toBe('Done. Next');
    expect(tidyText('e.g. this')).toBe('e.g. this');
  });
});

describe('layoutLines', () => {
  test('short text stays on one line', () => {
    expect(layoutLines('Hello there')).toEqual(['Hello there']);
  });
  test('two lines are balanced and inside the limit', () => {
    const out = layoutLines('This sentence is a little too long to sit on one single line')!;
    expect(out).toHaveLength(2);
    expect(Math.abs(out[0].length - out[1].length)).toBeLessThan(10);
    for (const l of out) expect(l.length).toBeLessThanOrEqual(CUE_LINE_CHARS);
  });
  test('text that cannot fit two lines returns null', () => {
    expect(layoutLines('word '.repeat(30).trim())).toBeNull();
  });
});

describe('segmentsToCaptions', () => {
  test('one short phrase is one cue timed from the segment', () => {
    const caps = segmentsToCaptions([seg(1.2, 3.4, 'Hello and welcome')]);
    expect(caps).toHaveLength(1);
    expect(caps[0].start).toBeCloseTo(1.2, 3);
    expect(caps[0].end).toBeCloseTo(3.4, 3);
    expect(caps[0].text).toBe('Hello and welcome');
    expect(caps[0].id).toMatch(/^cap/);
  });

  test('the offset moves every cue later', () => {
    const caps = segmentsToCaptions([seg(0, 2, 'First phrase here'), seg(5, 7, 'Second phrase here')], 10);
    expect(caps.map((c) => [c.start, c.end])).toEqual([
      [10, 12],
      [15, 17],
    ]);
  });

  test('a long segment is split into cues of at most 7 s and two lines of 42 characters', () => {
    const text = 'the quick brown fox jumps over the lazy dog and then keeps running across the field until it reaches the river bank where it stops to drink some water before turning back towards the forest';
    const caps = segmentsToCaptions([seg(0, 20, text)]);
    expect(caps.length).toBeGreaterThanOrEqual(3);
    for (const c of caps) {
      expect(c.end - c.start).toBeLessThanOrEqual(CUE_MAX_SECONDS + 1e-6);
      expect(lines(c.text).length).toBeLessThanOrEqual(2);
      for (const l of lines(c.text)) expect(l.length).toBeLessThanOrEqual(CUE_LINE_CHARS);
    }
    // No words lost or reordered.
    expect(caps.map((c) => c.text.replace(/\n/g, ' ')).join(' ')).toBe(text);
    // In order, no overlap, covering the segment.
    for (let i = 1; i < caps.length; i++) expect(caps[i].start).toBeGreaterThanOrEqual(caps[i - 1].end - 1e-9);
    expect(caps[0].start).toBeCloseTo(0, 3);
    expect(caps[caps.length - 1].end).toBeCloseTo(20, 1);
  });

  test('a long segment is cut after a sentence or clause when there is one', () => {
    const text = 'We start with the basics of the editor, then we move on to the timeline and how clips snap together when you drag them around.';
    const caps = segmentsToCaptions([seg(0, 12, text)]);
    expect(caps.length).toBeGreaterThanOrEqual(2);
    expect(caps[0].text.replace(/\n/g, ' ')).toMatch(/[,.]$/);
  });

  test('a sentence end starts a new cue', () => {
    const caps = segmentsToCaptions([seg(0, 6, 'This is the first sentence. This is the second sentence.')]);
    expect(caps).toHaveLength(2);
    expect(caps[0].text).toBe('This is the first sentence.');
    expect(caps[1].text).toBe('This is the second sentence.');
  });

  test('short phrases without a pause between them are joined', () => {
    const caps = segmentsToCaptions([seg(0, 0.4, 'Yes'), seg(0.45, 1.0, 'it is'), seg(1.05, 2.0, 'working now')]);
    expect(caps).toHaveLength(1);
    expect(caps[0].text).toBe('Yes it is working now');
  });

  test('whole phrases keep their own cues even with no pause between them', () => {
    const caps = segmentsToCaptions([seg(0, 0.57, 'This is the first fake caption.'), seg(0.67, 1.23, 'This is the second fake caption.'), seg(1.33, 2, 'This is the third fake caption.')]);
    expect(caps.map((c) => c.text)).toEqual(['This is the first fake caption.', 'This is the second fake caption.', 'This is the third fake caption.']);
  });

  test('a pause of 0.8 s or more keeps phrases apart', () => {
    const caps = segmentsToCaptions([seg(0, 2, 'The first part is here'), seg(3.5, 5.5, 'and the other part comes later')]);
    expect(caps).toHaveLength(2);
  });

  test('a very short cue is held for a readable moment but never into the next cue', () => {
    const caps = segmentsToCaptions([seg(0, 0.2, 'Okay'), seg(2.0, 2.2, 'Next one please')]);
    expect(caps[0].end - caps[0].start).toBeGreaterThanOrEqual(0.8 - 1e-9);
    const tight = segmentsToCaptions([seg(0, 0.2, 'Okay then'), seg(0.5, 3, 'This follows right behind the short one')]);
    for (let i = 1; i < tight.length; i++) expect(tight[i].start).toBeGreaterThanOrEqual(tight[i - 1].end - 1e-9);
  });

  test('empty text, missing lengths, overlaps and bad numbers are survived', () => {
    const caps = segmentsToCaptions([seg(0, 2, '   '), seg(1, 1, 'No length given'), seg(1.2, 3, 'Overlapping the one before'), { start: Number.NaN, end: 4, text: 'skipped' }, seg(-2, 0, 'Starts early')]);
    expect(caps.length).toBeGreaterThan(0);
    for (const c of caps) {
      expect(c.start).toBeGreaterThanOrEqual(0);
      expect(c.end).toBeGreaterThan(c.start);
      expect(c.text.trim()).not.toBe('');
    }
    for (let i = 1; i < caps.length; i++) expect(caps[i].start).toBeGreaterThanOrEqual(caps[i - 1].end - 1e-9);
    expect(caps.some((c) => c.text.includes('skipped'))).toBe(false);
  });

  test('a word longer than a line is cut so the cue still fits', () => {
    const caps = segmentsToCaptions([seg(0, 3, 'x'.repeat(100))]);
    for (const c of caps) for (const l of lines(c.text)) expect(l.length).toBeLessThanOrEqual(CUE_LINE_CHARS);
    expect(caps.map((c) => c.text.replace(/\n/g, ' ')).join('').replace(/ /g, '')).toBe('x'.repeat(100));
  });

  test('no segments, no cues', () => {
    expect(segmentsToCaptions([])).toEqual([]);
  });

  test('punctuation spacing is fixed in the cue text', () => {
    const caps = segmentsToCaptions([seg(0, 3, 'well , that was fine !')]);
    expect(caps[0].text).toBe('well, that was fine!');
  });
});

describe('planChunks', () => {
  const rate = 1000;
  test('audio inside the limit is one piece; empty audio none', () => {
    expect(planChunks(new Float32Array(5000), rate, 10)).toEqual([{ start: 0, end: 5000 }]);
    expect(planChunks(new Float32Array(0), rate, 10)).toEqual([]);
  });

  test('a long recording is cut at the quietest point before the limit', () => {
    // 25 s of loud noise with a quiet gap around 8.5 s and another around 17 s.
    const x = new Float32Array(25 * rate);
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * (i % 2 ? 1 : -1);
    const quiet = (from: number, to: number) => {
      for (let i = from * rate; i < to * rate; i++) x[i] = 0;
    };
    quiet(8.3, 8.8);
    quiet(16.8, 17.2);
    const chunks = planChunks(x, rate, 10, 5);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].start).toBe(0);
    expect(chunks[0].end / rate).toBeGreaterThan(8.3);
    expect(chunks[0].end / rate).toBeLessThan(8.8);
    expect(chunks[1].end / rate).toBeGreaterThan(16.8);
    expect(chunks[1].end / rate).toBeLessThan(17.2);
    expect(chunks[2].end).toBe(x.length);
  });

  test('pieces tile the audio exactly and none is longer than the limit', () => {
    const x = new Float32Array(47 * rate);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin(i / 7) * 0.3;
    const chunks = planChunks(x, rate, 10, 4);
    expect(chunks[0].start).toBe(0);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBe(chunks[i - 1].end);
    expect(chunks[chunks.length - 1].end).toBe(x.length);
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(10 * rate);
  });

  test('a cut never lands in the first half of a piece', () => {
    const x = new Float32Array(30 * rate).fill(0.4);
    for (let i = 1 * rate; i < 2 * rate; i++) x[i] = 0; // quiet, but far before the limit
    const chunks = planChunks(x, rate, 10, 8);
    expect(chunks[0].end / rate).toBeGreaterThanOrEqual(5);
  });

  test('600 s pieces at 16 kHz stay under the 30 MB request limit', () => {
    expect(600 * 16000 * 2 + 44).toBeLessThan(30_000_000);
  });
});

describe('toMono16k', () => {
  test('48 kHz stereo becomes mono 16 kHz of a third the length, averaging the channels', () => {
    const n = 48000;
    const left = new Float32Array(n).fill(0.5);
    const right = new Float32Array(n).fill(-0.1);
    const out = toMono16k([left, right], 48000);
    expect(out.length).toBe(16000);
    expect(out[8000]).toBeCloseTo(0.2, 3);
  });

  test('a 1 kHz tone keeps its level and a 12 kHz tone is filtered out', () => {
    const n = 48000;
    const tone = (hz: number) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / 48000));
    const rms = (a: Float32Array) => Math.sqrt(a.slice(2000, 14000).reduce((s, v) => s + v * v, 0) / 12000);
    expect(rms(toMono16k([tone(1000)], 48000))).toBeCloseTo(Math.SQRT1_2, 1);
    expect(rms(toMono16k([tone(12000)], 48000))).toBeLessThan(0.05);
  });

  test('16 kHz passes through and other rates are resampled to the right length', () => {
    const x = Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 20));
    expect(toMono16k([x], 16000)).toEqual(x);
    expect(toMono16k([new Float32Array(44100)], 44100).length).toBe(16000);
    expect(toMono16k([], 48000).length).toBe(0);
  });
});
