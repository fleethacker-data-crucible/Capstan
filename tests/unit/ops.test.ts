import { describe, expect, test } from 'bun:test';
import { History } from '../../src/engine/history';
import {
  addClip,
  addMedia,
  deleteClips,
  duplicateClip,
  fitOnTrack,
  moveClip,
  removeMedia,
  removeTrack,
  snapTime,
  splitAt,
  splitClip,
  trimEnd,
  trimStart,
  updateClipProps,
  updateTrack,
} from '../../src/engine/ops';
import {
  type MediaItem,
  type Project,
  activeClipsAt,
  clipEnd,
  createProject,
  parseProject,
  projectDuration,
} from '../../src/engine/project';

function media(id: string, duration: number, kind: MediaItem['kind'] = 'video'): MediaItem {
  return { id, name: id, kind, mime: '', bytes: 0, duration, width: 1280, height: 720, hasAudio: kind !== 'image', createdAt: 0 };
}

function setup(): { p: Project; track: string } {
  let p = createProject('t');
  p = addMedia(p, media('a', 10));
  p = addMedia(p, media('b', 4));
  p = addMedia(p, media('img', 0, 'image'));
  return { p, track: p.tracks[0].id };
}

function noOverlaps(p: Project): boolean {
  for (const t of p.tracks) {
    const cs = p.clips.filter((c) => c.trackId === t.id).sort((x, y) => x.start - y.start);
    for (let i = 1; i < cs.length; i++) if (cs[i].start < clipEnd(cs[i - 1]) - 1e-6) return false;
  }
  return true;
}

describe('placing clips', () => {
  test('adds a clip at the requested time and track', () => {
    const { p, track } = setup();
    const r = addClip(p, 'a', 2, track);
    const clip = r.project.clips[0];
    expect(clip.start).toBe(2);
    expect(clip.duration).toBe(10);
    expect(clip.trackId).toBe(track);
    expect(projectDuration(r.project)).toBe(12);
  });

  test('images get a default 5 second duration', () => {
    const { p, track } = setup();
    expect(addClip(p, 'img', 0, track).project.clips[0].duration).toBe(5);
  });

  test('a clip that would overlap goes to another track instead', () => {
    const { p, track } = setup();
    let q = addClip(p, 'a', 0, track).project;
    q = addClip(q, 'b', 3, track).project;
    expect(q.clips[1].trackId).not.toBe(track);
    expect(noOverlaps(q)).toBe(true);
  });

  test('adds a new track when every track is busy', () => {
    const { p } = setup();
    let q = p;
    for (const t of p.tracks) q = addClip(q, 'a', 0, t.id).project;
    expect(q.tracks.length).toBe(3);
    q = addClip(q, 'b', 1).project;
    expect(q.tracks.length).toBe(4);
    expect(noOverlaps(q)).toBe(true);
  });
});

describe('moving and trimming', () => {
  test('moving into an occupied spot lands on the nearest free gap', () => {
    const { p, track } = setup();
    let q = addClip(p, 'a', 0, track).project; // 0..10
    const r = addClip(q, 'b', 20, track);
    q = moveClip(r.project, r.clipId!, 8);
    const moved = q.clips.find((c) => c.id === r.clipId)!;
    expect(moved.start).toBe(10);
    expect(noOverlaps(q)).toBe(true);
  });

  test('fitOnTrack returns null on a locked track', () => {
    const { p, track } = setup();
    expect(fitOnTrack(updateTrack(p, track, { locked: true }), track, 0, 1)).toBeNull();
  });

  test('trimStart cannot reveal media before the source start', () => {
    const { p, track } = setup();
    const r = addClip(p, 'a', 5, track);
    const q = trimStart(r.project, r.clipId!, 1);
    const c = q.clips[0];
    expect(c.start).toBe(5);
    expect(c.in).toBe(0);
  });

  test('trimStart then trimEnd keeps source mapping consistent', () => {
    const { p, track } = setup();
    const r = addClip(p, 'a', 0, track);
    let q = trimStart(r.project, r.clipId!, 2);
    expect(q.clips[0]).toMatchObject({ start: 2, in: 2, duration: 8 });
    q = trimEnd(q, r.clipId!, 6);
    expect(q.clips[0]).toMatchObject({ start: 2, in: 2, duration: 4 });
    q = trimEnd(q, r.clipId!, 50); // cannot exceed source
    expect(clipEnd(q.clips[0])).toBe(10);
  });

  test('trimEnd stops at the next clip', () => {
    const { p, track } = setup();
    const img = addClip(p, 'img', 0, track); // 0..5, stretchable
    const q = addClip(img.project, 'b', 6, track).project; // 6..10
    const trimmed = trimEnd(q, img.clipId!, 20);
    expect(clipEnd(trimmed.clips.find((c) => c.id === img.clipId)!)).toBe(6);
  });

  test('image clips can be stretched freely', () => {
    const { p, track } = setup();
    const r = addClip(p, 'img', 0, track);
    expect(clipEnd(trimEnd(r.project, r.clipId!, 42).clips[0])).toBe(42);
  });
});

describe('split, delete, duplicate', () => {
  test('split produces two halves with continuous source time', () => {
    const { p, track } = setup();
    const r = addClip(p, 'a', 1, track);
    const s = splitClip(r.project, r.clipId!, 4);
    const [l, rr] = s.ids.map((id) => s.project.clips.find((c) => c.id === id)!);
    expect(l).toMatchObject({ start: 1, in: 0, duration: 3 });
    expect(rr).toMatchObject({ start: 4, in: 3, duration: 7 });
  });

  test('splitAt splits every clip under the playhead when none selected', () => {
    const { p, track } = setup();
    let q = addClip(p, 'a', 0, track).project;
    q = addClip(q, 'b', 1, q.tracks[1].id).project;
    q = splitAt(q, 2);
    expect(q.clips.length).toBe(4);
  });

  test('split at a clip edge does nothing', () => {
    const { p, track } = setup();
    const r = addClip(p, 'a', 0, track);
    expect(splitClip(r.project, r.clipId!, 0).ids).toEqual([]);
  });

  test('ripple delete closes the gap', () => {
    const { p, track } = setup();
    let q = addClip(p, 'b', 0, track).project; // 0..4
    const r = addClip(q, 'a', 4, track); // 4..14
    q = deleteClips(r.project, [q.clips[0].id], true);
    expect(q.clips.length).toBe(1);
    expect(q.clips[0].start).toBe(0);
  });

  test('duplicate lands right after the original', () => {
    const { p, track } = setup();
    const r = addClip(p, 'b', 0, track);
    const d = duplicateClip(r.project, r.clipId!);
    expect(d.project.clips.find((c) => c.id === d.clipId)!.start).toBe(4);
  });

  test('removing media removes its clips', () => {
    const { p, track } = setup();
    const q = removeMedia(addClip(p, 'a', 0, track).project, 'a');
    expect(q.clips.length).toBe(0);
    expect(q.media.some((m) => m.id === 'a')).toBe(false);
  });

  test('removing a track removes its clips but never the last track', () => {
    const { p, track } = setup();
    let q = addClip(p, 'a', 0, track).project;
    q = removeTrack(q, track);
    expect(q.clips.length).toBe(0);
    q = removeTrack(removeTrack(q, q.tracks[0].id), q.tracks[1].id);
    expect(q.tracks.length).toBe(1);
  });
});

describe('props, snapping, ordering, history, parsing', () => {
  test('clip props are clamped', () => {
    const { p, track } = setup();
    const r = addClip(p, 'a', 0, track);
    const c = updateClipProps(r.project, r.clipId!, { opacity: 3, volume: -1, scale: 0 }).clips[0];
    expect(c.props).toMatchObject({ opacity: 1, volume: 0, scale: 0.01 });
  });

  test('snaps to clip edges and extra points within threshold', () => {
    const { p, track } = setup();
    const q = addClip(p, 'a', 0, track).project;
    expect(snapTime(q, 9.9, 0.2)).toBe(10);
    expect(snapTime(q, 9.5, 0.2)).toBe(9.5);
    expect(snapTime(q, 3.05, 0.2, new Set(), [3])).toBe(3);
  });

  test('active clips are ordered bottom track first', () => {
    const { p } = setup();
    let q = addClip(p, 'a', 0, p.tracks[2].id).project;
    q = addClip(q, 'b', 0, p.tracks[0].id).project;
    expect(activeClipsAt(q, 1).map((c) => c.mediaId)).toEqual(['b', 'a']);
    expect(activeClipsAt(q, 10)).toEqual([]);
  });

  test('history undoes and redoes snapshots', () => {
    const { p, track } = setup();
    const h = new History();
    const q = addClip(p, 'a', 0, track).project;
    h.record(p, q);
    expect(h.undo(q)).toBe(p);
    expect(h.redo(p)).toBe(q);
    h.record(q, q);
    expect(h.canRedo).toBe(false);
  });

  test('parseProject rejects junk and drops dangling clips', () => {
    expect(() => parseProject({})).toThrow();
    const { p, track } = setup();
    const q = addClip(p, 'a', 0, track).project;
    const broken = { ...q, clips: [...q.clips, { ...q.clips[0], id: 'x', mediaId: 'missing' }], width: 1e9 };
    const parsed = parseProject(JSON.parse(JSON.stringify(broken)));
    expect(parsed.clips.length).toBe(1);
    expect(parsed.width).toBe(7680);
  });
});
