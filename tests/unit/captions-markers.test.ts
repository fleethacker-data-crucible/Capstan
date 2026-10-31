import { describe, expect, test } from 'bun:test';
import { formatSrt, formatVtt, parseSubtitles } from '../../src/engine/captions';
import {
  addCaptionAt,
  mergeWithNext,
  moveCaption,
  nudgeCaptions,
  removeCaption,
  retimeCaption,
  splitCaption,
  splitText,
  updateCaptionText,
} from '../../src/engine/captionops';
import {
  addMarker,
  chapterList,
  formatChaptersText,
  formatChaptersVtt,
  moveMarker,
  neighbourMarker,
  parseMarkers,
  removeMarker,
  renameMarker,
  toggleMarkerChapter,
} from '../../src/engine/markers';
import { chapterBox } from '../../src/engine/mp4/muxer';
import { setCaptions } from '../../src/engine/ops';
import { type Caption, createProject, parseProject } from '../../src/engine/project';
import { captionLane } from '../../src/ui/lanes/captionLane';

const cap = (start: number, end: number, text: string, id = `c${start}`): Caption => ({ id, start, end, text });
const withCaptions = (...c: Caption[]) => setCaptions(createProject(), c);

describe('markers', () => {
  test('add keeps the list sorted, names default to Marker N', () => {
    let p = createProject();
    const a = addMarker(p, 5);
    p = a.project;
    const b = addMarker(p, 2);
    p = b.project;
    expect(p.markers.map((m) => m.time)).toEqual([2, 5]);
    expect(p.markers.find((m) => m.id === b.id)?.name).toBe('Marker 2');
    expect(p.markers.every((m) => !m.chapter)).toBe(true);
  });

  test('rename, move (re-sorts), toggle chapter, remove', () => {
    let p = addMarker(createProject(), 1).project;
    const id = p.markers[0].id;
    p = addMarker(p, 3).project;
    p = renameMarker(p, id, 'Intro');
    expect(p.markers[0].name).toBe('Intro');
    p = moveMarker(p, id, 9);
    expect(p.markers.map((m) => m.time)).toEqual([3, 9]);
    p = toggleMarkerChapter(p, id);
    expect(p.markers.find((m) => m.id === id)?.chapter).toBe(true);
    p = removeMarker(p, id);
    expect(p.markers).toHaveLength(1);
  });

  test('edits that change nothing return the same project (no undo entry)', () => {
    const p = addMarker(createProject(), 1).project;
    const m = p.markers[0];
    expect(moveMarker(p, m.id, 1)).toBe(p);
    expect(renameMarker(p, m.id, m.name)).toBe(p);
    expect(removeMarker(p, 'nope')).toBe(p);
    expect(moveMarker(p, 'nope', 4)).toBe(p);
  });

  test('negative or non-finite times are clamped to 0', () => {
    const p = addMarker(createProject(), -4).project;
    expect(p.markers[0].time).toBe(0);
    expect(moveMarker(p, p.markers[0].id, Number.NaN).markers[0].time).toBe(0);
  });

  test('parseMarkers drops junk, fixes ids and names, sorts', () => {
    const out = parseMarkers([
      { id: 'a', time: 5, name: '  Five  ', chapter: true },
      { id: 'a', time: 2, name: 'Dup id', chapter: 'yes' },
      { id: 'c', time: -1, name: 'negative' },
      { id: 'd', time: 'x', name: 'string time' },
      null,
      7,
      { time: 1 },
    ]);
    expect(out.map((m) => m.time)).toEqual([1, 2, 5]);
    expect(new Set(out.map((m) => m.id)).size).toBe(3);
    expect(out.find((m) => m.time === 5)).toMatchObject({ name: 'Five', chapter: true });
    expect(out.find((m) => m.time === 2)?.chapter).toBe(false);
    expect(out.find((m) => m.time === 1)?.name).toMatch(/^Marker/);
    expect(parseMarkers('nope')).toEqual([]);
    expect(parseMarkers(undefined)).toEqual([]);
  });

  test('markers survive a project save and open', () => {
    let p = addMarker(createProject(), 4.5, 'Demo', true).project;
    p = addMarker(p, 1).project;
    const back = parseProject(JSON.parse(JSON.stringify(p)));
    expect(back.markers).toEqual(p.markers);
  });

  test('neighbourMarker finds the next and previous', () => {
    let p = addMarker(createProject(), 2).project;
    p = addMarker(p, 6).project;
    expect(neighbourMarker(p, 2, 1)?.time).toBe(6);
    expect(neighbourMarker(p, 6, -1)?.time).toBe(2);
    expect(neighbourMarker(p, 6, 1)).toBeUndefined();
  });
});

describe('chapters', () => {
  const markers = parseMarkers([
    { id: 'a', time: 12, name: 'Setup', chapter: true },
    { id: 'b', time: 30, name: 'Not a chapter', chapter: false },
    { id: 'c', time: 75.4, name: 'Results', chapter: true },
    { id: 'd', time: 500, name: 'After the end', chapter: true },
  ]);

  test('only flagged markers inside the timeline are chapters', () => {
    expect(chapterList(markers, 100)).toEqual([
      { time: 12, name: 'Setup' },
      { time: 75.4, name: 'Results' },
    ]);
    expect(chapterList(markers)).toHaveLength(3);
  });

  test('YouTube text starts at 0:00 (a Start line is added) and uses m:ss', () => {
    expect(formatChaptersText(chapterList(markers, 100))).toBe('0:00 Start\n0:12 Setup\n1:15 Results\n');
    expect(formatChaptersText([{ time: 0, name: 'Intro' }, { time: 65, name: 'Next' }])).toBe('0:00 Intro\n1:05 Next\n');
    expect(formatChaptersText([{ time: 0, name: 'A' }, { time: 3725, name: 'B' }])).toBe('0:00:00 A\n1:02:05 B\n');
    expect(formatChaptersText([])).toBe('');
  });

  test('WebVTT chapters: each runs to the next, the last to the end; the file parses as cues', () => {
    const vtt = formatChaptersVtt(chapterList(markers, 100), 100);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    const cues = parseSubtitles(vtt);
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([
      [12, 75.4, 'Setup'],
      [75.4, 100, 'Results'],
    ]);
  });

  test('blank marker names become "Chapter"', () => {
    const q = addMarker(createProject(), 1, 'x', true).project;
    const named = renameMarker(q, q.markers[0].id, '   ');
    expect(chapterList(named.markers)[0].name).toBe('Chapter');
  });

  test('chpl box layout: udta > chpl v1, 100 ns starts, UTF-8 titles', () => {
    const udta = chapterBox([
      { time: 90, name: 'Later' },
      { time: 0, name: 'Début' },
    ])!;
    const dv = new DataView(udta.buffer);
    const type = (at: number) => String.fromCharCode(...udta.slice(at, at + 4));
    expect(dv.getUint32(0)).toBe(udta.length);
    expect(type(4)).toBe('udta');
    expect(type(12)).toBe('chpl');
    expect(udta[16]).toBe(1); // version
    expect(dv.getUint32(20)).toBe(0); // reserved
    expect(udta[24]).toBe(2); // count
    // first entry is the earlier chapter even though it was given second
    expect(Number(dv.getBigUint64(25))).toBe(0);
    const len = udta[33];
    expect(new TextDecoder().decode(udta.slice(34, 34 + len))).toBe('Début');
    const second = 34 + len;
    expect(Number(dv.getBigUint64(second))).toBe(900_000_000);
    expect(chapterBox([])).toBeNull();
  });

  test('chpl titles never exceed 255 bytes', () => {
    const udta = chapterBox([{ time: 0, name: 'é'.repeat(300) }])!;
    expect(udta[33]).toBeLessThanOrEqual(255);
    expect(udta[33] % 2).toBe(0); // no half character
  });
});

describe('caption editing', () => {
  test('add at the playhead: 2 s long, stops at the next caption, starts after one that covers the time', () => {
    const p0 = withCaptions(cap(0, 3, 'one', 'a'), cap(5, 8, 'two', 'b'));
    const a = addCaptionAt(p0, 4);
    const added = a.project.captions.find((c) => c.id === a.id)!;
    expect(added.start).toBe(4);
    expect(added.end).toBe(5);
    const b = addCaptionAt(p0, 1);
    const onTop = b.project.captions.find((c) => c.id === b.id)!;
    expect(onTop.start).toBe(3);
    expect(onTop.end).toBe(5);
    const c = addCaptionAt(p0, 20);
    expect(c.project.captions.find((x) => x.id === c.id)).toMatchObject({ start: 20, end: 22 });
    expect(c.project.captions.map((x) => x.start)).toEqual([0, 5, 20]);
  });

  test('edit text, clamp length, no-op returns the same project', () => {
    const p = withCaptions(cap(0, 2, 'hi', 'a'));
    const q = updateCaptionText(p, 'a', 'hello\r\nworld');
    expect(q.captions[0].text).toBe('hello\nworld');
    expect(updateCaptionText(q, 'a', 'hello\nworld')).toBe(q);
    expect(updateCaptionText(p, 'a', 'x'.repeat(900)).captions[0].text).toHaveLength(500);
    expect(updateCaptionText(p, 'zzz', 'x')).toBe(p);
  });

  test('retime keeps end after start and re-sorts', () => {
    const p = withCaptions(cap(0, 2, 'a', 'a'), cap(5, 7, 'b', 'b'));
    const q = retimeCaption(p, 'a', { start: 9 });
    expect(q.captions.map((c) => c.id)).toEqual(['b', 'a']);
    const a = q.captions.find((c) => c.id === 'a')!;
    expect(a.end).toBeGreaterThan(a.start);
    expect(retimeCaption(p, 'a', { start: -3 }).captions[0].start).toBe(0);
    expect(retimeCaption(p, 'a', { start: 0, end: 2 })).toBe(p);
  });

  test('moveCaption keeps the length', () => {
    const p = withCaptions(cap(1, 3.5, 'a', 'a'));
    const q = moveCaption(p, 'a', 10);
    expect(q.captions[0]).toMatchObject({ start: 10, end: 12.5 });
  });

  test('split at the playhead cuts time and text', () => {
    const p = withCaptions(cap(0, 10, 'the quick brown fox jumps over the lazy dog', 'a'));
    const r = splitCaption(p, 5);
    expect(r.ids).toHaveLength(2);
    const [x, y] = r.project.captions;
    expect([x.start, x.end, y.start, y.end]).toEqual([0, 5, 5, 10]);
    expect(`${x.text} ${y.text}`).toBe('the quick brown fox jumps over the lazy dog');
    expect(x.text.length).toBeGreaterThan(10);
    expect(y.text.length).toBeGreaterThan(10);
  });

  test('split keeps multi-line captions on a line break; outside a caption does nothing', () => {
    expect(splitText('first line\nsecond line', 0.5)).toEqual(['first line', 'second line']);
    expect(splitText('oneword', 0.5)).toEqual(['oneword', '']);
    const p = withCaptions(cap(0, 4, 'abc def', 'a'));
    expect(splitCaption(p, 9).ids).toEqual([]);
    expect(splitCaption(p, 9).project).toBe(p);
    expect(splitCaption(p, 0.01).project).toBe(p);
    // one word: both halves keep the word rather than going empty
    const w = splitCaption(withCaptions(cap(0, 4, 'single', 'a')), 2);
    expect(w.project.captions.map((c) => c.text)).toEqual(['single', 'single']);
  });

  test('merge with next joins text and span; the last caption cannot merge', () => {
    const p = withCaptions(cap(0, 2, 'one', 'a'), cap(3, 5, 'two', 'b'), cap(6, 7, 'three', 'c'));
    const m = mergeWithNext(p, 'a');
    expect(m.project.captions).toHaveLength(2);
    expect(m.project.captions[0]).toMatchObject({ id: m.id, start: 0, end: 5, text: 'one\ntwo' });
    expect(mergeWithNext(p, 'c').project).toBe(p);
    expect(mergeWithNext(p, 'zzz').id).toBe('');
  });

  test('nudge all, or some; never before 0', () => {
    const p = withCaptions(cap(1, 2, 'a', 'a'), cap(4, 6, 'b', 'b'));
    const later = nudgeCaptions(p, 0.5);
    expect(later.captions.map((c) => [c.start, c.end])).toEqual([
      [1.5, 2.5],
      [4.5, 6.5],
    ]);
    const earlier = nudgeCaptions(p, -5);
    expect(earlier.captions.map((c) => c.start)).toEqual([0, 3]); // stops at the earliest caption
    expect(nudgeCaptions(p, 1, ['b']).captions.map((c) => c.start)).toEqual([1, 5]);
    expect(nudgeCaptions(p, 0)).toBe(p);
  });

  test('delete', () => {
    const p = withCaptions(cap(0, 1, 'a', 'a'), cap(2, 3, 'b', 'b'));
    expect(removeCaption(p, 'a').captions.map((c) => c.id)).toEqual(['b']);
    expect(removeCaption(p, 'x')).toBe(p);
  });
});

describe('caption lane', () => {
  const p = withCaptions(cap(2, 6, 'Hello there', 'a'));
  test('lists captions with a duration', () => {
    expect(captionLane.items(p)).toEqual([{ id: 'a', start: 2, duration: 4, label: 'Hello there' }]);
  });
  test('start only = move, duration only = move the end, both = trim the start', () => {
    expect(captionLane.update(p, 'a', { start: 10 }).captions[0]).toMatchObject({ start: 10, end: 14 });
    expect(captionLane.update(p, 'a', { duration: 1 }).captions[0]).toMatchObject({ start: 2, end: 3 });
    expect(captionLane.update(p, 'a', { start: 4, duration: 2 }).captions[0]).toMatchObject({ start: 4, end: 6 });
    expect(captionLane.update(p, 'nope', { start: 1 })).toBe(p);
  });
});

describe('subtitle files', () => {
  const captions: Caption[] = [
    cap(0.5, 2, 'Plain line', 'a'),
    cap(2.25, 4.125, 'Two\nlines & <b>tags</b> --> arrows', 'b'),
    cap(3725.999, 3727, 'Over an hour', 'c'),
  ];

  test('WebVTT writer: header, dotted milliseconds', () => {
    const vtt = formatVtt(captions);
    expect(vtt.startsWith('WEBVTT\n\n1\n00:00:00.500 --> 00:00:02.000\nPlain line\n')).toBe(true);
    expect(vtt).toContain('01:02:05.999 --> 01:02:07.000');
    expect(vtt).not.toContain(',');
    expect(vtt).toContain('&amp; &lt;b&gt;tags&lt;/b&gt;');
  });

  test('VTT round-trips through parseSubtitles (times and text)', () => {
    const back = parseSubtitles(formatVtt(captions));
    expect(back.map((c) => [c.start, c.end, c.text])).toEqual(captions.map((c) => [c.start, c.end, c.text]));
  });

  test('SRT round-trips too', () => {
    const back = parseSubtitles(formatSrt(captions));
    expect(back.map((c) => [c.start, c.end])).toEqual(captions.map((c) => [c.start, c.end]));
    expect(back[0].text).toBe('Plain line');
  });

  test('blank lines inside a caption do not split the cue on export', () => {
    const out = formatVtt([cap(0, 1, 'one\n\n\ntwo', 'a')]);
    expect(parseSubtitles(out)).toHaveLength(1);
    expect(parseSubtitles(out)[0].text).toBe('one\ntwo');
  });

  test('parses real-world VTT: NOTE and STYLE blocks, identifiers, settings, short stamps', () => {
    const text = `WEBVTT - made by hand

NOTE this is a comment
spanning two lines

STYLE
::cue { color: red }

intro
00:01.000 --> 00:03.500 align:start position:10%
<v Speaker>Hello &amp; welcome

00:04.000 --> 00:05.000
Bye`;
    const c = parseSubtitles(text);
    expect(c.map((x) => [x.start, x.end, x.text])).toEqual([
      [1, 3.5, 'Hello & welcome'],
      [4, 5, 'Bye'],
    ]);
  });

  test('empty input and an end before the start are skipped', () => {
    expect(parseSubtitles('')).toEqual([]);
    expect(parseSubtitles('1\n00:00:05,000 --> 00:00:01,000\nbackwards\n')).toEqual([]);
  });
});
