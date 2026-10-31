import { describe, expect, test } from 'bun:test';
import { clearClipboard, copyClips, hasClipboard, pasteHeld } from '../../src/engine/clipboard';
import {
  bundleIds,
  canDetachAudio,
  closeGaps,
  cropForAspect,
  deleteBundle,
  detachAudio,
  dragCrop,
  duplicateClips,
  expandSelection,
  extendFrame,
  freezeFrame,
  groupClips,
  magnetize,
  moveClips,
  pasteClips,
  removeGapAt,
  setClipCrop,
  setClipSpeed,
  setTrackMagnetic,
  snapshotClips,
  splitBundle,
  trackGaps,
  trimBundle,
  ungroupClips,
  unlinkClips,
} from '../../src/engine/editops';
import { addClip, addMedia, updateClipProps, updateTrack } from '../../src/engine/ops';
import {
  type Clip,
  type MediaItem,
  type Project,
  clipEnd,
  createProject,
  parseProject,
  sourceSpan,
  sourceTimeAt,
} from '../../src/engine/project';

function media(id: string, duration: number, kind: MediaItem['kind'] = 'video', hasAudio = kind !== 'image'): MediaItem {
  return { id, name: id, kind, mime: '', bytes: 0, duration, width: 1280, height: 720, hasAudio, createdAt: 0 };
}

function setup(): { p: Project; t0: string; t1: string; t2: string } {
  let p = createProject('t');
  p = addMedia(p, media('a', 10));
  p = addMedia(p, media('b', 4));
  p = addMedia(p, media('img', 0, 'image'));
  p = addMedia(p, media('mute', 5, 'video', false));
  return { p, t0: p.tracks[0].id, t1: p.tracks[1].id, t2: p.tracks[2].id };
}

function place(p: Project, mediaId: string, start: number, trackId: string): { p: Project; id: string } {
  const r = addClip(p, mediaId, start, trackId);
  expect(r.clipId).not.toBeNull();
  return { p: r.project, id: r.clipId! };
}

function noOverlaps(p: Project): boolean {
  for (const t of p.tracks) {
    const cs = p.clips.filter((c) => c.trackId === t.id).sort((x, y) => x.start - y.start);
    for (let i = 1; i < cs.length; i++) if (cs[i].start < clipEnd(cs[i - 1]) - 1e-6) return false;
  }
  return true;
}

const get = (p: Project, id: string): Clip => p.clips.find((c) => c.id === id)!;

describe('multi-clip move', () => {
  test('moves a selection together and keeps offsets', () => {
    const { p: p0, t0, t1 } = setup();
    const a = place(p0, 'b', 1, t0);
    const b = place(a.p, 'b', 6, t1);
    const moved = moveClips(b.p, [a.id, b.id], 3);
    expect(get(moved, a.id).start).toBeCloseTo(4);
    expect(get(moved, b.id).start).toBeCloseTo(9);
    expect(get(moved, b.id).start - get(moved, a.id).start).toBeCloseTo(5);
  });

  test('moves the block to another pair of lanes', () => {
    const { p: p0, t0, t1, t2 } = setup();
    const a = place(p0, 'b', 0, t0);
    const b = place(a.p, 'b', 0, t1);
    const moved = moveClips(b.p, [a.id, b.id], 0, 1);
    expect(get(moved, a.id).trackId).toBe(t1);
    expect(get(moved, b.id).trackId).toBe(t2);
  });

  test('is all-or-nothing: a lane shift past the last track or onto a locked track moves nothing', () => {
    const { p: p0, t0, t1, t2 } = setup();
    const a = place(p0, 'b', 0, t0);
    const b = place(a.p, 'b', 0, t2);
    expect(moveClips(b.p, [a.id, b.id], 0, 1)).toBe(b.p);
    const locked = updateTrack(place(p0, 'b', 0, t0).p, t1, { locked: true });
    expect(moveClips(locked, [locked.clips[0].id], 0, 1)).toBe(locked);
  });

  test('exact mode refuses a collision; otherwise the whole block slides to the nearest fit', () => {
    const { p: p0, t0, t1 } = setup();
    const a = place(p0, 'b', 0, t0); // 0..4
    const b = place(a.p, 'b', 1, t1); // 1..5
    const blocker = place(b.p, 'b', 6, t0); // 6..10 on lane 0
    // Exactly +3 puts a at 3..7 over the blocker.
    expect(moveClips(blocker.p, [a.id, b.id], 3, 0, { exact: true })).toBe(blocker.p);
    const fitted = moveClips(blocker.p, [a.id, b.id], 3);
    expect(fitted).not.toBe(blocker.p);
    expect(noOverlaps(fitted)).toBe(true);
    expect(get(fitted, b.id).start - get(fitted, a.id).start).toBeCloseTo(1); // offset kept
    // The nearest fit butts a up against the blocker: a ends at 6.
    expect(get(fitted, a.id).start).toBeCloseTo(2);
  });

  test('never moves before time zero', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'b', 2, t0);
    expect(get(moveClips(a.p, [a.id], -5), a.id).start).toBeCloseTo(0);
  });

  test('a grouped or linked clip drags its bundle', () => {
    const { p: p0, t0, t1 } = setup();
    const a = place(p0, 'b', 0, t0);
    const b = place(a.p, 'b', 0, t1);
    const g = groupClips(b.p, [a.id, b.id]);
    const moved = moveClips(g.project, [a.id], 2);
    expect(get(moved, a.id).start).toBeCloseTo(2);
    expect(get(moved, b.id).start).toBeCloseTo(2);
  });
});

describe('clipboard', () => {
  test('copy then paste at the playhead keeps offsets, tracks and keyframes, with new ids', () => {
    const { p: p0, t0, t1 } = setup();
    const a = place(p0, 'b', 1, t0);
    const b = place(a.p, 'a', 2, t1);
    let p = b.p;
    p = { ...p, clips: p.clips.map((c) => (c.id === a.id ? { ...c, keys: { x: [{ t: 0, v: 5, ease: 'linear' as const }, { t: 1, v: 9, ease: 'linear' as const }] } } : c)) };
    clearClipboard();
    expect(hasClipboard()).toBe(false);
    expect(copyClips(p, [a.id, b.id])).toBe(2);
    expect(hasClipboard()).toBe(true);
    const r = pasteHeld(p, 20);
    expect(r.ids).toHaveLength(2);
    const [ca, cb] = r.ids.map((id) => get(r.project, id));
    expect(ca.start).toBeCloseTo(20);
    expect(cb.start - ca.start).toBeCloseTo(1);
    expect(ca.trackId).toBe(t0);
    expect(cb.trackId).toBe(t1);
    expect(ca.keys?.x?.[1].v).toBe(9);
    expect(ca.id).not.toBe(a.id);
    expect(ca.keys).not.toBe(get(p, a.id).keys); // a deep copy
    expect(r.project.clips).toHaveLength(4);
  });

  test('paste onto an occupied spot slides the block into free space instead of overlapping', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'b', 0, t0); // 0..4
    clearClipboard();
    copyClips(a.p, [a.id]);
    const r = pasteHeld(a.p, 1);
    expect(noOverlaps(r.project)).toBe(true);
    expect(get(r.project, r.ids[0]).start).toBeCloseTo(4);
  });

  test('paste goes to a free gap that is nearest the playhead', () => {
    const { p: p0, t0 } = setup();
    let p = place(p0, 'b', 0, t0).p; // 0..4
    p = place(p, 'b', 10, t0).p; // 10..14, gap 4..10 (6 s)
    const src = place(p, 'b', 20, t0); // the thing to copy, 4 s
    const items = snapshotClips(src.p, [src.id]);
    const r = pasteClips(src.p, items, 5);
    expect(get(r.project, r.ids[0]).start).toBeCloseTo(5);
    const tight = pasteClips(src.p, items, 8); // 8..12 hits the clip at 10, so it slides to 6..10
    expect(get(tight.project, tight.ids[0]).start).toBeCloseTo(6);
  });

  test('a locked or missing track sends the clip to an open track', () => {
    const { p: p0, t0, t1 } = setup();
    const a = place(p0, 'b', 0, t0);
    clearClipboard();
    copyClips(a.p, [a.id]);
    const locked = updateTrack(a.p, t0, { locked: true });
    const r = pasteHeld(locked, 10);
    expect(get(r.project, r.ids[0]).trackId).toBe(t1);
    const all = { ...locked, tracks: locked.tracks.map((t) => ({ ...t, locked: true })) };
    const r2 = pasteHeld(all, 10);
    expect(r2.project.tracks.length).toBe(all.tracks.length + 1);
  });

  test('clips whose media is gone are skipped', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'b', 0, t0);
    clearClipboard();
    copyClips(a.p, [a.id]);
    const fresh = createProject('other');
    const r = pasteHeld(fresh, 0);
    expect(r.ids).toHaveLength(0);
    expect(r.project).toBe(fresh);
  });

  test('links and groups survive a paste only when every member is copied, under new ids', () => {
    const { p: p0, t0, t1 } = setup();
    const a = place(p0, 'b', 0, t0);
    const b = place(a.p, 'b', 0, t1);
    const g = groupClips(b.p, [a.id, b.id]);
    const whole = pasteClips(g.project, snapshotClips(g.project, [a.id, b.id]), 10);
    const [x, y] = whole.ids.map((id) => get(whole.project, id));
    expect(x.groupId).toBeDefined();
    expect(x.groupId).toBe(y.groupId);
    expect(x.groupId).not.toBe(g.groupId);
    // Copying from a group copies the whole group (bundle), so ids are always paired.
    expect(snapshotClips(g.project, [a.id])).toHaveLength(2);
    // A hand-made snapshot of a single member loses the dangling group id.
    const lone = pasteClips(g.project, [structuredClone(get(g.project, a.id))], 10);
    expect(get(lone.project, lone.ids[0]).groupId).toBeUndefined();
  });

  test('duplicate puts a copy right after the selection', () => {
    const { p: p0, t0, t1 } = setup();
    const a = place(p0, 'b', 0, t0);
    const b = place(a.p, 'b', 2, t1);
    const r = duplicateClips(b.p, [a.id, b.id]);
    const [x, y] = r.ids.map((id) => get(r.project, id));
    expect(x.start).toBeCloseTo(6); // selection spans 0..6
    expect(y.start).toBeCloseTo(8);
    expect(noOverlaps(r.project)).toBe(true);
  });
});

describe('groups', () => {
  test('group and ungroup', () => {
    const { p: p0, t0, t1 } = setup();
    const a = place(p0, 'b', 0, t0);
    const b = place(a.p, 'b', 0, t1);
    expect(groupClips(b.p, [a.id]).groupId).toBeNull(); // one clip is not a group
    const g = groupClips(b.p, [a.id, b.id]);
    expect(g.groupId).not.toBeNull();
    expect(get(g.project, a.id).groupId).toBe(g.groupId!);
    expect(get(g.project, b.id).groupId).toBe(g.groupId!);
    const u = ungroupClips(g.project, [a.id]);
    expect(get(u, a.id).groupId).toBeUndefined();
    expect(get(u, b.id).groupId).toBeUndefined(); // the whole group dissolves
    expect(ungroupClips(u, [a.id])).toBe(u);
  });

  test('selecting one grouped clip selects the group; other ids pass through', () => {
    const { p: p0, t0, t1, t2 } = setup();
    const a = place(p0, 'b', 0, t0);
    const b = place(a.p, 'b', 0, t1);
    const c = place(b.p, 'b', 0, t2);
    const g = groupClips(c.p, [a.id, b.id]);
    expect(expandSelection(g.project, [a.id]).sort()).toEqual([a.id, b.id].sort());
    expect(expandSelection(g.project, [c.id])).toEqual([c.id]);
    expect(expandSelection(g.project, ['red_1'])).toEqual(['red_1']);
  });

  test('grouping merges existing groups', () => {
    const { p: p0, t0, t1, t2 } = setup();
    const a = place(p0, 'b', 0, t0);
    const b = place(a.p, 'b', 0, t1);
    const c = place(b.p, 'b', 0, t2);
    const g1 = groupClips(c.p, [a.id, b.id]);
    const g2 = groupClips(g1.project, [b.id, c.id]);
    const ids = new Set(g2.project.clips.map((x) => x.groupId));
    expect(ids.size).toBe(1);
  });

  test('delete, trim and split carry the group', () => {
    const { p: p0, t0, t1 } = setup();
    const a = place(p0, 'b', 0, t0); // 0..4
    const b = place(a.p, 'b', 0, t1); // 0..4
    const g = groupClips(b.p, [a.id, b.id]);
    // trim both ends together
    const trimmed = trimBundle(g.project, a.id, 'end', 3);
    expect(get(trimmed, a.id).duration).toBeCloseTo(3);
    expect(get(trimmed, b.id).duration).toBeCloseTo(3);
    const startTrim = trimBundle(g.project, a.id, 'start', 1);
    expect(get(startTrim, b.id).start).toBeCloseTo(1);
    expect(get(startTrim, b.id).in).toBeCloseTo(1);
    // split splits both halves and gives the right halves their own group
    const split = splitBundle(g.project, 2, [a.id]);
    expect(split.clips).toHaveLength(4);
    const lefts = split.clips.filter((c) => c.start < 1);
    const rights = split.clips.filter((c) => c.start >= 1);
    expect(new Set(lefts.map((c) => c.groupId)).size).toBe(1);
    expect(new Set(rights.map((c) => c.groupId)).size).toBe(1);
    expect(lefts[0].groupId).not.toBe(rights[0].groupId);
    // delete removes both
    expect(deleteBundle(g.project, [a.id]).clips).toHaveLength(0);
  });

  test('a clip whose edge differs from the group member is left alone when trimming', () => {
    const { p: p0, t0, t1 } = setup();
    const a = place(p0, 'b', 0, t0); // ends 4
    const b = place(a.p, 'b', 1, t1); // ends 5
    const g = groupClips(b.p, [a.id, b.id]);
    const trimmed = trimBundle(g.project, a.id, 'end', 3);
    expect(get(trimmed, a.id).duration).toBeCloseTo(3);
    expect(get(trimmed, b.id).duration).toBeCloseTo(4);
  });
});

describe('gaps and magnetic tracks', () => {
  function gappy() {
    const s = setup();
    let p = place(s.p, 'b', 1, s.t0).p; // gap 0..1
    const mid = place(p, 'b', 7, s.t0); // 7..11, gap 5..7
    p = place(mid.p, 'b', 14, s.t0).p; // gap 11..14
    return { ...s, p };
  }

  test('trackGaps lists leading and inner gaps', () => {
    const { p, t0 } = gappy();
    const gaps = trackGaps(p, t0);
    expect(gaps.map((g) => [g.start, g.end])).toEqual([[0, 1], [5, 7], [11, 14]]);
  });

  test('removeGapAt closes one gap and pulls everything after it', () => {
    const { p, t0 } = gappy();
    const r = removeGapAt(p, t0, 6);
    const starts = trackGapsStarts(r, t0);
    expect(starts).toEqual([1, 5, 12]);
    expect(removeGapAt(p, t0, 2)).toBe(p); // not in a gap
  });

  test('closeGaps closes them all', () => {
    const { p, t0 } = gappy();
    const r = closeGaps(p, t0);
    expect(trackGapsStarts(r, t0)).toEqual([0, 4, 8]);
    expect(trackGaps(r, t0)).toHaveLength(0);
    expect(noOverlaps(r)).toBe(true);
  });

  test('a locked track is not changed', () => {
    const { p, t0 } = gappy();
    const locked = updateTrack(p, t0, { locked: true });
    expect(closeGaps(locked, t0)).toBe(locked);
  });

  test('gap removal carries linked clips on other tracks along', () => {
    const { p: p0, t0 } = setup();
    let p = place(p0, 'a', 2, t0).p;
    const id = p.clips[0].id;
    const d = detachAudio(p, id);
    p = d.project;
    const closed = closeGaps(p, t0);
    expect(get(closed, id).start).toBeCloseTo(0);
    expect(get(closed, d.audioClipId!).start).toBeCloseTo(0);
  });

  test('setTrackMagnetic closes gaps on turning on; deleting then ripples on a magnetic track', () => {
    const { p, t0 } = gappy();
    const on = setTrackMagnetic(p, t0, true);
    expect(on.tracks[0].magnetic).toBe(true);
    expect(trackGaps(on, t0)).toHaveLength(0);
    const ids = on.clips.filter((c) => c.trackId === t0).sort((a, b) => a.start - b.start).map((c) => c.id);
    const after = deleteBundle(on, [ids[1]]); // delete the middle one
    expect(trackGaps(after, t0)).toHaveLength(0);
    expect(after.clips.filter((c) => c.trackId === t0).map((c) => c.start).sort((a, b) => a - b)).toEqual([0, 4]);
    const off = setTrackMagnetic(on, t0, false);
    expect(off.tracks[0].magnetic).toBeUndefined();
    // Not magnetic: deleting leaves the gap.
    const plain = deleteBundle(off, [ids[1]]);
    expect(trackGaps(plain, t0)).toHaveLength(1);
  });

  test('trimming on a magnetic track pulls later clips in once magnetize runs', () => {
    const { p, t0 } = gappy();
    const on = setTrackMagnetic(p, t0, true);
    const first = on.clips.filter((c) => c.trackId === t0).sort((a, b) => a.start - b.start)[0];
    const shorter = magnetize(trimBundle(on, first.id, 'end', 2));
    expect(trackGaps(shorter, t0)).toHaveLength(0);
    expect(shorter.clips.filter((c) => c.trackId === t0).map((c) => c.start).sort((a, b) => a - b)).toEqual([0, 2, 6]);
  });

  test('parseProject keeps magnetic', () => {
    const { p, t0 } = gappy();
    const on = setTrackMagnetic(p, t0, true);
    const back = parseProject(JSON.parse(JSON.stringify(on)));
    expect(back.tracks[0].magnetic).toBe(true);
    expect(back.tracks[1].magnetic).toBeUndefined();
  });
});

function trackGapsStarts(p: Project, trackId: string): number[] {
  return p.clips
    .filter((c) => c.trackId === trackId)
    .map((c) => c.start)
    .sort((a, b) => a - b)
    .map((n) => Math.round(n * 1000) / 1000);
}

describe('clip speed', () => {
  test('faster is shorter and keeps the same source span', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'a', 0, t0); // 10 s
    const fast = setClipSpeed(a.p, a.id, 2);
    const c = get(fast, a.id);
    expect(c.speed).toBe(2);
    expect(c.duration).toBeCloseTo(5);
    expect(sourceSpan(c)).toBeCloseTo(10);
    expect(sourceTimeAt(c, 2.5)).toBeCloseTo(5);
    const slow = setClipSpeed(a.p, a.id, 0.5);
    expect(get(slow, a.id).duration).toBeCloseTo(20);
    // back to normal drops the field
    const back = setClipSpeed(fast, a.id, 1);
    expect(get(back, a.id).speed).toBeUndefined();
    expect(get(back, a.id).duration).toBeCloseTo(10);
  });

  test('speed is clamped to 0.1x..8x', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'a', 0, t0);
    expect(get(setClipSpeed(a.p, a.id, 100), a.id).speed).toBe(8);
    expect(get(setClipSpeed(a.p, a.id, 0.001), a.id).speed).toBe(0.1);
  });

  test('a longer clip stops at the next clip; ripple pushes later clips instead', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'b', 0, t0); // 0..4
    const n = place(a.p, 'b', 6, t0); // 6..10
    const slowed = setClipSpeed(n.p, a.id, 0.5); // wants 8 s, only 6 fit
    expect(get(slowed, a.id).duration).toBeCloseTo(6);
    expect(noOverlaps(slowed)).toBe(true);
    const rippled = setClipSpeed(n.p, a.id, 0.5, { ripple: true });
    expect(get(rippled, a.id).duration).toBeCloseTo(8);
    expect(get(rippled, n.id).start).toBeCloseTo(10);
    expect(noOverlaps(rippled)).toBe(true);
    const faster = setClipSpeed(n.p, a.id, 2, { ripple: true });
    expect(get(faster, n.id).start).toBeCloseTo(4);
  });

  test('speed change applies to the linked audio clip and scales keyframes', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'a', 0, t0);
    const d = detachAudio(a.p, a.id);
    const keyed = { ...d.project, clips: d.project.clips.map((c) => (c.id === a.id ? { ...c, keys: { x: [{ t: 4, v: 1, ease: 'linear' as const }] } } : c)) };
    const fast = setClipSpeed(keyed, a.id, 2);
    expect(get(fast, a.id).duration).toBeCloseTo(5);
    expect(get(fast, d.audioClipId!).duration).toBeCloseTo(5);
    expect(get(fast, d.audioClipId!).speed).toBe(2);
    expect(get(fast, a.id).keys?.x?.[0].t).toBeCloseTo(2);
  });

  test('images, holds and locked tracks are left alone', () => {
    const { p: p0, t0 } = setup();
    const img = place(p0, 'img', 0, t0);
    expect(setClipSpeed(img.p, img.id, 2)).toBe(img.p);
    const a = place(p0, 'a', 0, t0);
    expect(setClipSpeed(updateTrack(a.p, t0, { locked: true }), a.id, 2).clips[0].speed).toBeUndefined();
  });

  test('trim after a speed change still respects the source', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'a', 0, t0);
    const fast = setClipSpeed(a.p, a.id, 4); // 2.5 s covering all 10 s
    const split = splitBundle(fast, 1, [a.id]);
    const right = split.clips.find((c) => c.start > 0.5)!;
    expect(right.in).toBeCloseTo(4); // 1 s on the timeline at 4x
    expect(right.speed).toBe(4);
  });
});

describe('freeze frame and extend frame', () => {
  test('freeze splits the clip and puts a still between the halves, rippling the rest', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'a', 0, t0); // 0..10
    const n = place(a.p, 'b', 10, t0);
    const r = freezeFrame(n.p, a.id, 4, 2, { ripple: true });
    expect(r.clipId).not.toBeNull();
    const clips = r.project.clips.filter((c) => c.trackId === t0).sort((x, y) => x.start - y.start);
    expect(clips).toHaveLength(4);
    const [left, hold, right, later] = clips;
    expect(left.duration).toBeCloseTo(4);
    expect(hold.freeze).toBe(true);
    expect(hold.start).toBeCloseTo(4);
    expect(hold.duration).toBeCloseTo(2);
    expect(hold.in).toBeCloseTo(4);
    expect(sourceTimeAt(hold, 5)).toBeCloseTo(4); // never advances
    expect(right.start).toBeCloseTo(6);
    expect(right.in).toBeCloseTo(4);
    expect(later.start).toBeCloseTo(12); // pushed by 2 s
    expect(noOverlaps(r.project)).toBe(true);
  });

  test('freeze without ripple overwrites the following picture and total length is unchanged', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'a', 0, t0);
    const r = freezeFrame(a.p, a.id, 4, 2);
    const clips = r.project.clips.sort((x, y) => x.start - y.start);
    const [left, hold, right] = clips;
    expect(left.duration).toBeCloseTo(4);
    expect(hold.duration).toBeCloseTo(2);
    expect(right.start).toBeCloseTo(6);
    expect(right.in).toBeCloseTo(6); // source 4..6 is hidden under the hold
    expect(clipEnd(right)).toBeCloseTo(10);
  });

  test('freeze honours speed when working out the held source frame', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'a', 0, t0);
    const fast = setClipSpeed(a.p, a.id, 2); // 5 s
    const r = freezeFrame(fast, a.id, 2, 1, { ripple: true });
    const hold = r.project.clips.find((c) => c.freeze)!;
    expect(hold.in).toBeCloseTo(4);
    expect(hold.speed).toBeUndefined();
  });

  test('freeze is refused for images, audio-only clips, holds and locked tracks', () => {
    const { p: p0, t0 } = setup();
    const img = place(p0, 'img', 0, t0);
    expect(freezeFrame(img.p, img.id, 1, 1).clipId).toBeNull();
    const a = place(p0, 'a', 0, t0);
    const hold = freezeFrame(a.p, a.id, 4, 2, { ripple: true });
    expect(freezeFrame(hold.project, hold.clipId!, 4.5, 1).clipId).toBeNull();
    expect(freezeFrame(updateTrack(a.p, t0, { locked: true }), a.id, 1, 1).clipId).toBeNull();
  });

  test('freeze keeps a detached audio clip in step and silent during the hold', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'a', 0, t0);
    const d = detachAudio(a.p, a.id);
    const r = freezeFrame(d.project, a.id, 4, 2, { ripple: true });
    const audio = r.project.clips.filter((c) => c.audioOnly).sort((x, y) => x.start - y.start);
    expect(audio).toHaveLength(2);
    expect(audio[0].duration).toBeCloseTo(4);
    expect(audio[1].start).toBeCloseTo(6);
    expect(audio[1].in).toBeCloseTo(4);
  });

  test('extend frame adds a hold of the last picture at the end', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'b', 0, t0); // 0..4
    const n = place(a.p, 'b', 6, t0);
    const free = extendFrame(n.p, a.id, 5); // only 2 s of room
    const hold = free.project.clips.find((c) => c.freeze)!;
    expect(hold.start).toBeCloseTo(4);
    expect(hold.duration).toBeCloseTo(2);
    expect(hold.in).toBeLessThan(4);
    expect(hold.in).toBeGreaterThan(3.9);
    expect(noOverlaps(free.project)).toBe(true);
    const rippled = extendFrame(n.p, a.id, 5, { ripple: true });
    expect(rippled.project.clips.find((c) => c.freeze)!.duration).toBeCloseTo(5);
    expect(get(rippled.project, n.id).start).toBeCloseTo(11);
    expect(noOverlaps(rippled.project)).toBe(true);
  });

  test('extending an image just makes it longer; no room means no change', () => {
    const { p: p0, t0 } = setup();
    const img = place(p0, 'img', 0, t0); // 5 s
    const r = extendFrame(img.p, img.id, 3);
    expect(r.project.clips).toHaveLength(1);
    expect(r.project.clips[0].duration).toBeCloseTo(8);
    const a = place(p0, 'b', 0, t0);
    const n = place(a.p, 'b', 4, t0);
    expect(extendFrame(n.p, a.id, 2).clipId).toBeNull();
  });
});

describe('crop', () => {
  test('setClipCrop validates, clears and does not change locked clips', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'a', 0, t0);
    const c = setClipCrop(a.p, a.id, { x: 0.25, y: 0.1, width: 0.5, height: 0.5 });
    expect(get(c, a.id).crop).toEqual({ x: 0.25, y: 0.1, width: 0.5, height: 0.5 });
    const wild = setClipCrop(a.p, a.id, { x: 0.9, y: -1, width: 0.5, height: 5 });
    expect(get(wild, a.id).crop!.x).toBeCloseTo(0.5);
    expect(get(wild, a.id).crop!.y).toBe(0);
    expect(get(wild, a.id).crop!.height).toBe(1);
    const full = setClipCrop(c, a.id, { x: 0, y: 0, width: 1, height: 1 });
    expect('crop' in get(full, a.id)).toBe(false);
    expect(setClipCrop(a.p, a.id, undefined)).toBe(a.p);
    expect(setClipCrop(updateTrack(c, t0, { locked: true }), a.id, undefined).clips[0].crop).toBeDefined();
  });

  test('cropForAspect fits the largest centred rectangle of a ratio', () => {
    const m = { width: 1280, height: 720 };
    const sq = cropForAspect(m, undefined, 1);
    expect(sq.height).toBe(1);
    expect(sq.width * 1280).toBeCloseTo(720);
    expect(sq.x).toBeCloseTo((1 - sq.width) / 2);
    const tall = cropForAspect(m, undefined, 9 / 16);
    expect((tall.width * 1280) / (tall.height * 720)).toBeCloseTo(9 / 16);
    const wide = cropForAspect({ width: 720, height: 1280 }, undefined, 16 / 9);
    expect(wide.width).toBe(1);
    expect((wide.width * 720) / (wide.height * 1280)).toBeCloseTo(16 / 9);
    // stays centred on the existing crop where it can
    const moved = cropForAspect(m, { x: 0, y: 0, width: 0.2, height: 0.2 }, 1);
    expect(moved.x).toBe(0);
  });
});

describe('dragging crop handles', () => {
  const frame = { width: 1280, height: 720 };
  const full = { x: 0, y: 0, width: 1, height: 1 };

  test('an edge handle moves one edge and stays inside the frame', () => {
    const r = dragCrop(full, { hx: -1, hy: 0 }, 0.25, 0, frame);
    expect(r.x).toBeCloseTo(0.25);
    expect(r.width).toBeCloseTo(0.75);
    expect(r.y).toBe(0);
    expect(r.height).toBe(1);
    const out = dragCrop(full, { hx: 1, hy: 0 }, 0.5, 0, frame); // cannot grow past the frame
    expect(out.width).toBe(1);
    const tiny = dragCrop(full, { hx: 1, hy: 0 }, -2, 0, frame);
    expect(tiny.width).toBeCloseTo(0.02);
  });

  test('a corner handle moves two edges; dragging inside moves the rectangle', () => {
    const r = dragCrop(full, { hx: 1, hy: 1 }, -0.5, -0.4, frame);
    expect(r.width).toBeCloseTo(0.5);
    expect(r.height).toBeCloseTo(0.6);
    const moved = dragCrop({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, { hx: 0, hy: 0 }, 0.9, -0.5, frame);
    expect(moved.x).toBeCloseTo(0.5);
    expect(moved.y).toBe(0);
    expect(moved.width).toBe(0.5);
  });

  test('with a locked shape the crop keeps its aspect', () => {
    const start = cropForAspect(frame, undefined, 1); // a centred square
    const r = dragCrop(start, { hx: 1, hy: 1 }, -0.1, 0, frame, 1);
    expect((r.width * 1280) / (r.height * 720)).toBeCloseTo(1);
    expect(r.width).toBeLessThan(start.width);
    const edge = dragCrop(start, { hx: 1, hy: 0 }, -0.05, 0, frame, 1);
    expect((edge.width * 1280) / (edge.height * 720)).toBeCloseTo(1);
    const grow = dragCrop(start, { hx: 1, hy: 1 }, 1, 1, frame, 1);
    expect(grow.x + grow.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(grow.y + grow.height).toBeLessThanOrEqual(1 + 1e-9);
    expect((grow.width * 1280) / (grow.height * 720)).toBeCloseTo(1);
  });
});

describe('detach audio', () => {
  test('creates a linked audio-only clip with the same media, timing and speed; the picture is muted', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'a', 2, t0);
    const fast = setClipSpeed(a.p, a.id, 2);
    expect(canDetachAudio(fast, get(fast, a.id))).toBe(true);
    const d = detachAudio(fast, a.id);
    expect(d.audioClipId).not.toBeNull();
    const pic = get(d.project, a.id);
    const aud = get(d.project, d.audioClipId!);
    expect(pic.muteAudio).toBe(true);
    expect(pic.props.volume).toBe(1); // the user's volume is untouched
    expect(aud.audioOnly).toBe(true);
    expect(aud.muteAudio).toBeUndefined();
    expect(aud.mediaId).toBe('a');
    expect(aud.start).toBeCloseTo(pic.start);
    expect(aud.in).toBeCloseTo(pic.in);
    expect(aud.duration).toBeCloseTo(pic.duration);
    expect(aud.speed).toBe(2);
    expect(aud.trackId).not.toBe(pic.trackId);
    expect(aud.linkId).toBeDefined();
    expect(aud.linkId).toBe(pic.linkId);
    expect(noOverlaps(d.project)).toBe(true);
    // not twice, and not for media without sound
    expect(canDetachAudio(d.project, get(d.project, a.id))).toBe(false);
    expect(detachAudio(d.project, a.id).audioClipId).toBeNull();
    const silent = place(p0, 'mute', 0, t0);
    expect(canDetachAudio(silent.p, get(silent.p, silent.id))).toBe(false);
    const img = place(p0, 'img', 0, t0);
    expect(detachAudio(img.p, img.id).audioClipId).toBeNull();
  });

  test('uses a free track when there is one and adds an Audio track when not', () => {
    const { p: p0, t0, t1, t2 } = setup();
    const a = place(p0, 'a', 0, t0);
    const first = detachAudio(a.p, a.id);
    expect(get(first.project, first.audioClipId!).trackId).toBe(t1);
    // fill the other tracks
    let p = place(a.p, 'b', 0, t1).p;
    p = place(p, 'b', 0, t2).p;
    const d = detachAudio(p, a.id);
    expect(d.project.tracks).toHaveLength(4);
    const added = d.project.tracks[3];
    expect(added.name).toBe('Audio');
    expect(get(d.project, d.audioClipId!).trackId).toBe(added.id);
  });

  test('linked clips move, trim, split and delete together', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'a', 0, t0); // 0..10
    const d = detachAudio(a.p, a.id);
    const audio = d.audioClipId!;
    expect(bundleIds(d.project, [a.id]).sort()).toEqual([a.id, audio].sort());
    const moved = moveClips(d.project, [a.id], 3);
    expect(get(moved, a.id).start).toBeCloseTo(3);
    expect(get(moved, audio).start).toBeCloseTo(3);
    const trimmed = trimBundle(d.project, a.id, 'end', 6);
    expect(get(trimmed, a.id).duration).toBeCloseTo(6);
    expect(get(trimmed, audio).duration).toBeCloseTo(6);
    const startTrimmed = trimBundle(d.project, audio, 'start', 2);
    expect(get(startTrimmed, a.id).start).toBeCloseTo(2);
    expect(get(startTrimmed, a.id).in).toBeCloseTo(2);
    expect(get(startTrimmed, audio).in).toBeCloseTo(2);
    const split = splitBundle(d.project, 5, [a.id]);
    expect(split.clips).toHaveLength(4);
    const rights = split.clips.filter((c) => c.start >= 5);
    expect(rights).toHaveLength(2);
    expect(rights[0].linkId).toBe(rights[1].linkId);
    expect(rights[0].linkId).not.toBe(get(d.project, a.id).linkId);
    expect(new Set(rights.map((c) => c.audioOnly ?? false)).size).toBe(2);
    expect(deleteBundle(d.project, [audio]).clips).toHaveLength(0);
    // selection stays single (links are not groups)
    expect(expandSelection(d.project, [a.id])).toEqual([a.id]);
    // unlink separates them
    const free = unlinkClips(d.project, [a.id]);
    expect(deleteBundle(free, [audio]).clips).toHaveLength(1);
  });

  test('a clip blocked on the other track stops the pair moving (all-or-nothing)', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'b', 0, t0);
    const d = detachAudio(a.p, a.id);
    const audioTrack = get(d.project, d.audioClipId!).trackId;
    const wall = place(d.project, 'b', 10, audioTrack);
    expect(moveClips(wall.p, [a.id], 8, 0, { exact: true })).toBe(wall.p);
  });

  test('keeps volume keyframes on the audio clip and drops picture-only extras', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'a', 0, t0);
    const fancy = {
      ...a.p,
      clips: a.p.clips.map((c) => ({
        ...c,
        crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
        keys: { x: [{ t: 0, v: 1, ease: 'linear' as const }], volume: [{ t: 0, v: 0.5, ease: 'linear' as const }] },
      })),
    };
    const d = detachAudio(fancy, a.id);
    const aud = get(d.project, d.audioClipId!);
    expect(aud.crop).toBeUndefined();
    expect(aud.keys?.x).toBeUndefined();
    expect(aud.keys?.volume?.[0].v).toBe(0.5);
  });
});

describe('parsing the new fields', () => {
  test('audioOnly, muteAudio, linkId, groupId, speed, freeze and crop survive a round trip', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'a', 0, t0);
    let p = setClipSpeed(a.p, a.id, 2);
    p = setClipCrop(p, a.id, { x: 0.1, y: 0.2, width: 0.5, height: 0.5 });
    const d = detachAudio(p, a.id);
    const frozen = freezeFrame(d.project, a.id, 1, 1, { ripple: true });
    const g = groupClips(frozen.project, [a.id, frozen.clipId!]);
    const back = parseProject(JSON.parse(JSON.stringify(g.project)));
    const pic = back.clips.find((c) => c.id === a.id)!;
    expect(pic.muteAudio).toBe(true);
    expect(pic.speed).toBe(2);
    expect(pic.crop?.width).toBe(0.5);
    expect(pic.linkId).toBeDefined();
    expect(pic.groupId).toBe(g.groupId!);
    expect(back.clips.find((c) => c.audioOnly)).toBeDefined();
    expect(back.clips.find((c) => c.freeze)).toBeDefined();
  });

  test('junk values are dropped', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'a', 0, t0);
    const dirty = JSON.parse(JSON.stringify(a.p));
    dirty.clips[0].audioOnly = 'yes';
    dirty.clips[0].muteAudio = 1;
    dirty.tracks[0].magnetic = 'x';
    const back = parseProject(dirty);
    expect(back.clips[0].audioOnly).toBeUndefined();
    expect(back.clips[0].muteAudio).toBeUndefined();
    expect(back.tracks[0].magnetic).toBe(true); // truthy, kept as a plain boolean
  });

  test('volume setting is independent of muteAudio', () => {
    const { p: p0, t0 } = setup();
    const a = place(p0, 'a', 0, t0);
    const d = detachAudio(a.p, a.id);
    const louder = updateClipProps(d.project, a.id, { volume: 1.5 });
    expect(get(louder, a.id).muteAudio).toBe(true);
    expect(get(louder, a.id).props.volume).toBe(1.5);
  });
});
