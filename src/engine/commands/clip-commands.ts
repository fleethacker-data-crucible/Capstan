// Clip commands: put media on the timeline, move, trim, split, delete, duplicate, set properties,
// speed, freeze and extend frames, crop, group, detach audio and close gaps. Each wraps the pure
// operations in ops.ts and editops.ts the same way the timeline and inspector call them
// (including closing gaps on magnetic tracks after an edit).
import {
  cropForAspect,
  closeGaps,
  deleteBundle,
  detachAudio,
  duplicateClips,
  extendFrame,
  freezeFrame,
  groupClips,
  magnetize,
  moveClips,
  pasteClips,
  removeGapAt,
  setClipCrop,
  setClipSpeed,
  snapshotClips,
  splitBundle,
  trimBundle,
  bundleIds,
  ungroupClips,
  unlinkClips,
} from '../editops';
import { addClip, moveClip, updateClipProps } from '../ops';
import { type Clip, type Crop, MAX_SPEED, MIN_SPEED } from '../project';
import { type CommandDef, bool, changed, fail, needClip, needMedia, needTrack, newIds, num, oneOf, pick, ref, seconds } from './define';

const FULL: Crop = { x: 0, y: 0, width: 1, height: 1 };

/** Ids of clips that had `key` before and no longer have it. */
function lost(before: Clip[], after: Clip[], key: 'groupId' | 'linkId'): string[] {
  const had = new Set(before.filter((c) => c[key] !== undefined).map((c) => c.id));
  return after.filter((c) => had.has(c.id) && c[key] === undefined).map((c) => c.id);
}

export const clipCommands: CommandDef[] = [
  {
    name: 'clip add',
    summary: 'Put a media item on the timeline at a time, on a track with room (a new track is added when none has).',
    inputs: [
      ref('media', 'Media id.'),
      seconds('start', 'Timeline position in seconds.'),
      ref('track', 'Track to prefer.', { optional: true }),
    ],
    result: 'Object with the new clip id and the track it landed on.',
    needs: 'project',
    run: (p, a) => {
      needMedia(p, a.media);
      if (a.track) needTrack(p, a.track);
      const r = addClip(p, a.media, a.start, a.track);
      if (!r.clipId) return fail('The clip could not be placed');
      const next = magnetize(r.project);
      const clip = next.clips.find((c) => c.id === r.clipId);
      return { project: next, result: { clip: r.clipId, track: clip?.trackId, start: clip?.start } };
    },
  },
  {
    name: 'clip move',
    summary: 'Move a clip (with its group or linked audio) to a start time, optionally on another track. It settles in the nearest free gap.',
    inputs: [
      ref('clip', 'Clip id.'),
      seconds('start', 'New timeline position in seconds.'),
      ref('track', 'Track to move to (default: the same track).', { optional: true }),
    ],
    result: 'Object with the clips moved and where the clip landed.',
    needs: 'project',
    run: (p, a) => {
      const clip = needClip(p, a.clip);
      if (a.track) needTrack(p, a.track);
      const bundle = bundleIds(p, [clip.id]);
      let next: typeof p;
      if (bundle.length > 1) {
        const order = p.tracks.map((t) => t.id);
        const shift = a.track ? order.indexOf(a.track) - order.indexOf(clip.trackId) : 0;
        next = moveClips(p, [clip.id], a.start - clip.start, shift);
      } else next = moveClip(p, clip.id, a.start, a.track);
      next = changed(p, next, 'The clip did not move (it is already there, its track is locked, or there is no room)');
      next = magnetize(next);
      const now = next.clips.find((c) => c.id === clip.id);
      return { project: next, result: { clips: bundle, start: now?.start, track: now?.trackId } };
    },
  },
  {
    name: 'clip trim',
    summary: 'Move one edge of a clip. Linked and grouped clips with the same edge follow.',
    inputs: [ref('clip', 'Clip id.'), oneOf('edge', ['start', 'end'], 'Which edge.'), seconds('time', 'New edge position on the timeline, in seconds.')],
    result: 'Object with the clip start and duration after the trim.',
    needs: 'project',
    run: (p, a) => {
      needClip(p, a.clip);
      const next = magnetize(changed(p, trimBundle(p, a.clip, a.edge, a.time), 'The clip did not change (locked track, no room, or the edge is already there)'));
      const now = next.clips.find((c) => c.id === a.clip);
      return { project: next, result: { clip: a.clip, start: now?.start, duration: now?.duration } };
    },
  },
  {
    name: 'clip split',
    summary: 'Cut clips in two at a time: the given clips under it, otherwise every clip under it. Linked and grouped clips split too.',
    inputs: [seconds('time', 'Timeline position in seconds.'), ref('clips', 'Clips to split (default: every clip under the time).', { optional: true, many: true })],
    result: 'Object with the ids of the new right-hand halves.',
    needs: 'project',
    run: (p, a) => {
      const next = changed(p, splitBundle(p, a.time, a.clips ?? []), 'No clip to split at that time (it must be inside a clip, not at its edge, on an unlocked track)');
      return { project: next, result: { created: newIds(p.clips, next.clips) } };
    },
  },
  {
    name: 'clip delete',
    summary: 'Delete clips together with the clips linked or grouped with them.',
    inputs: [ref('clips', 'Clip ids.', { many: true }), bool('ripple', 'Later clips on the same tracks close the gap (default: false).', { optional: true })],
    result: 'Object with the ids removed.',
    destructive: true,
    needs: 'project',
    run: (p, a) => {
      for (const id of a.clips) needClip(p, id);
      const next = changed(p, deleteBundle(p, a.clips, !!a.ripple), 'Nothing was deleted (the clips are on locked tracks)');
      const kept = new Set(next.clips.map((c) => c.id));
      return { project: next, result: { removed: p.clips.filter((c) => !kept.has(c.id)).map((c) => c.id) } };
    },
  },
  {
    name: 'clip duplicate',
    summary: 'Copy clips (with their groups and links) to just after the selection, or to a given time (copy and paste).',
    inputs: [
      ref('clips', 'Clip ids.', { many: true }),
      seconds('at', 'Paste so the earliest clip starts here (default: right after the last clip).', { optional: true }),
    ],
    result: 'Object with the new clip ids.',
    needs: 'project',
    run: (p, a) => {
      for (const id of a.clips) needClip(p, id);
      const r = a.at === undefined ? duplicateClips(p, a.clips) : pasteClips(p, snapshotClips(p, a.clips), a.at);
      if (!r.ids.length) return fail('The clips could not be placed');
      return { project: magnetize(r.project), result: { clips: r.ids } };
    },
  },
  {
    name: 'clip props',
    summary: 'Set a clip’s position, size, rotation, opacity or volume.',
    inputs: [
      ref('clip', 'Clip id.'),
      num('x', 'Centre of the clip on the canvas, in pixels.', { optional: true }),
      num('y', 'Centre of the clip on the canvas, in pixels.', { optional: true }),
      num('scale', '1 fits the clip inside the canvas.', { optional: true, min: 0.01, max: 20 }),
      num('rotation', 'Degrees.', { optional: true, min: -360, max: 360 }),
      num('opacity', '0 to 1.', { optional: true, min: 0, max: 1 }),
      num('volume', '0 to 2 (1 = unchanged).', { optional: true, min: 0, max: 2 }),
    ],
    result: 'Object with the clip properties after the change.',
    needs: 'project',
    atLeastOne: ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'],
    run: (p, a) => {
      needClip(p, a.clip);
      const next = changed(p, updateClipProps(p, a.clip, pick(a, ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'])), 'The clip is on a locked track');
      return { project: next, result: { clip: a.clip, props: next.clips.find((c) => c.id === a.clip)?.props } };
    },
  },
  {
    name: 'clip speed',
    summary: 'Change playback speed. The clip keeps showing the same stretch of source, so its length on the timeline changes.',
    inputs: [
      ref('clip', 'Clip id.'),
      num('speed', 'Playback speed (1 = normal).', { min: MIN_SPEED, max: MAX_SPEED }),
      bool('ripple', 'Later clips on the track move to make room or close up (default: false).', { optional: true }),
    ],
    result: 'Object with the clip duration and speed after the change.',
    needs: 'project',
    run: (p, a) => {
      needClip(p, a.clip);
      const next = changed(p, setClipSpeed(p, a.clip, a.speed, { ripple: !!a.ripple }), 'The speed did not change (a picture or a hold has no speed, the track is locked, or it is already that speed)');
      const now = next.clips.find((c) => c.id === a.clip);
      return { project: next, result: { clip: a.clip, speed: now?.speed ?? 1, duration: now?.duration } };
    },
  },
  {
    name: 'clip freeze',
    summary: 'Hold the picture at a time for some seconds (a freeze frame).',
    inputs: [
      ref('clip', 'Clip id.'),
      seconds('time', 'Timeline position inside the clip, in seconds.'),
      num('seconds', 'How long to hold (default 2).', { optional: true, min: 0.1, max: 60 }),
      bool('ripple', 'Later clips move to make room; otherwise the hold overwrites (default: false).', { optional: true }),
    ],
    result: 'Object with the id of the still clip.',
    needs: 'project',
    run: (p, a) => {
      needClip(p, a.clip);
      const r = freezeFrame(p, a.clip, a.time, a.seconds ?? 2, { ripple: !!a.ripple });
      if (!r.clipId) return fail('No freeze frame made (the time must be inside a video clip on an unlocked track, with room for the hold)');
      return { project: r.project, result: { clip: r.clipId } };
    },
  },
  {
    name: 'clip extend',
    summary: 'Hold a clip’s last picture for some seconds after it ends.',
    inputs: [
      ref('clip', 'Clip id.'),
      num('seconds', 'How long to hold (default 2).', { optional: true, min: 0.1, max: 60 }),
      bool('ripple', 'Later clips move to make room (default: false).', { optional: true }),
    ],
    result: 'Object with the id of the clip that holds the picture.',
    needs: 'project',
    run: (p, a) => {
      needClip(p, a.clip);
      const r = extendFrame(p, a.clip, a.seconds ?? 2, { ripple: !!a.ripple });
      if (!r.clipId) return fail('No frame extended (audio has no picture, the track is locked, or there is no room after the clip)');
      return { project: r.project, result: { clip: r.clipId } };
    },
  },
  {
    name: 'clip crop',
    summary: 'Show only part of the source picture. Fractions of the source frame; or an aspect ratio, or clear.',
    inputs: [
      ref('clip', 'Clip id.'),
      num('x', 'Left edge, 0 to 1.', { optional: true, min: 0, max: 1 }),
      num('y', 'Top edge, 0 to 1.', { optional: true, min: 0, max: 1 }),
      num('width', 'Width, 0.02 to 1.', { optional: true, min: 0.02, max: 1 }),
      num('height', 'Height, 0.02 to 1.', { optional: true, min: 0.02, max: 1 }),
      num('aspect', 'Crop to this width/height ratio, centred on the current crop (for example 1.7778).', { optional: true, min: 0.1, max: 10 }),
      bool('clear', 'Remove the crop.', { optional: true }),
    ],
    result: 'Object with the crop after the change (null when there is none).',
    needs: 'project',
    atLeastOne: ['x', 'y', 'width', 'height', 'aspect', 'clear'],
    run: (p, a) => {
      const clip = needClip(p, a.clip);
      const media = needMedia(p, clip.mediaId);
      let crop: Crop | undefined;
      if (a.clear) crop = undefined;
      else if (a.aspect !== undefined) crop = cropForAspect(media, clip.crop, a.aspect);
      else crop = { ...(clip.crop ?? FULL), ...pick(a, ['x', 'y', 'width', 'height']) };
      const next = changed(p, setClipCrop(p, a.clip, crop), 'The crop did not change (locked track, or it is already like that)');
      return { project: next, result: { clip: a.clip, crop: next.clips.find((c) => c.id === a.clip)?.crop ?? null } };
    },
  },
  {
    name: 'clip group',
    summary: 'Put two or more clips in a group that selects, moves, trims and deletes together.',
    inputs: [ref('clips', 'Clip ids (two or more).', { many: true })],
    result: 'Object with the group id.',
    needs: 'project',
    run: (p, a) => {
      for (const id of a.clips) needClip(p, id);
      const r = groupClips(p, a.clips);
      if (!r.groupId) return fail('A group needs two or more clips');
      return { project: r.project, result: { group: r.groupId } };
    },
  },
  {
    name: 'clip ungroup',
    summary: 'Dissolve the groups the given clips belong to.',
    inputs: [ref('clips', 'Clip ids.', { many: true })],
    result: 'Object with the clips that were in a group.',
    needs: 'project',
    run: (p, a) => {
      for (const id of a.clips) needClip(p, id);
      const next = changed(p, ungroupClips(p, a.clips), 'None of those clips is in a group');
      return { project: next, result: { clips: lost(p.clips, next.clips, 'groupId') } };
    },
  },
  {
    name: 'clip unlink',
    summary: 'Break the link between a video clip and the audio detached from it, so they move separately.',
    inputs: [ref('clips', 'Clip ids.', { many: true })],
    result: 'Object with the clips that were linked.',
    needs: 'project',
    run: (p, a) => {
      for (const id of a.clips) needClip(p, id);
      const next = changed(p, unlinkClips(p, a.clips), 'None of those clips is linked');
      return { project: next, result: { clips: lost(p.clips, next.clips, 'linkId') } };
    },
  },
  {
    name: 'clip detach-audio',
    summary: 'Split the sound off a video clip onto its own linked audio clip.',
    inputs: [ref('clip', 'Video clip id.')],
    result: 'Object with the new audio clip id.',
    needs: 'project',
    run: (p, a) => {
      needClip(p, a.clip);
      const r = detachAudio(p, a.clip);
      if (!r.audioClipId) return fail('The audio cannot be detached (the clip needs a video with sound, on an unlocked track, not already detached)');
      return { project: r.project, result: { audioClip: r.audioClipId } };
    },
  },
  {
    name: 'clip close-gaps',
    summary: 'Close every gap on a track, from the start.',
    inputs: [ref('track', 'Track id.')],
    result: 'Object with changed: true when something moved.',
    needs: 'project',
    run: (p, a) => {
      needTrack(p, a.track);
      const next = closeGaps(p, a.track);
      return { project: next, result: { track: a.track, changed: next !== p } };
    },
  },
  {
    name: 'clip remove-gap',
    summary: 'Close the gap at a time on a track: later clips move earlier by the gap’s length.',
    inputs: [ref('track', 'Track id.'), seconds('time', 'A time inside the gap, in seconds.')],
    result: 'Object with the track and the clips that moved.',
    needs: 'project',
    run: (p, a) => {
      needTrack(p, a.track);
      const next = changed(p, removeGapAt(p, a.track, a.time), 'There is no gap at that time on the track, or the track is locked');
      const was = new Map(p.clips.map((c) => [c.id, c.start]));
      const moved = next.clips.filter((c) => was.get(c.id) !== c.start).map((c) => c.id);
      return { project: next, result: { track: a.track, moved } };
    },
  },
];
