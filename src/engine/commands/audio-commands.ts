// Audio commands: fades, volume points and ducking over plain data. Noise removal and levelling
// need the decoded sound, so they are registered for the page to run.
import { addVolumePoint, clearVolumePoints, removeVolumePoint, updateClipAudio } from '../audioops';
import { localTime } from '../animate';
import { DEFAULT_DUCK } from '../dsp/duck';
import { type CommandDef, browserCommand, changed, fail, needClip, num, oneOf, ref, seconds, bool } from './define';

function audibleClip(p: Parameters<typeof needClip>[0], id: string) {
  const clip = needClip(p, id);
  const media = p.media.find((m) => m.id === clip.mediaId);
  if (!media || media.kind === 'image' || !media.hasAudio) fail('That clip has no sound');
  return clip;
}

export const audioCommands: CommandDef[] = [
  {
    name: 'audio fade',
    summary: 'Set the fade in and fade out of a clip’s sound, in seconds (0 removes a fade).',
    inputs: [
      ref('clip', 'Clip id.'),
      num('fadeIn', 'Seconds of fade in at the start.', { optional: true, min: 0, max: 600 }),
      num('fadeOut', 'Seconds of fade out at the end.', { optional: true, min: 0, max: 600 }),
      oneOf('curve', ['linear', 'smooth'], 'Fade shape (default linear).', { optional: true }),
    ],
    result: 'Object with the clip’s audio settings after the change.',
    needs: 'project',
    atLeastOne: ['fadeIn', 'fadeOut', 'curve'],
    run: (p, a) => {
      audibleClip(p, a.clip);
      const patch: Parameters<typeof updateClipAudio>[2] = {};
      if (a.fadeIn !== undefined) patch.fadeIn = a.fadeIn;
      if (a.fadeOut !== undefined) patch.fadeOut = a.fadeOut;
      if (a.curve !== undefined) patch.fadeCurve = a.curve === 'smooth' ? 'smooth' : undefined;
      const next = changed(p, updateClipAudio(p, a.clip, patch), 'The clip is on a locked track');
      return { project: next, result: { clip: a.clip, audio: next.clips.find((c) => c.id === a.clip)?.audio ?? null } };
    },
  },
  {
    name: 'audio point-set',
    summary: 'Set a volume point on a clip at a time (replaces a point at the same time). Between points the volume ramps.',
    inputs: [ref('clip', 'Clip id.'), seconds('time', 'Timeline position in seconds (clamped into the clip).'), num('value', 'Volume, 0 to 2 (1 = unchanged).', { min: 0, max: 2 })],
    result: 'Object with the volume points after the change.',
    needs: 'project',
    run: (p, a) => {
      const clip = audibleClip(p, a.clip);
      const next = changed(p, addVolumePoint(p, a.clip, localTime(clip, a.time), a.value), 'The clip is on a locked track');
      return { project: next, result: { clip: a.clip, points: next.clips.find((c) => c.id === a.clip)?.keys?.volume ?? [] } };
    },
  },
  {
    name: 'audio point-remove',
    summary: 'Remove the volume point at a time.',
    inputs: [ref('clip', 'Clip id.'), seconds('time', 'Timeline position of the point, in seconds.')],
    result: 'Object with the volume points left.',
    needs: 'project',
    run: (p, a) => {
      const clip = audibleClip(p, a.clip);
      const t = localTime(clip, a.time);
      if (!clip.keys?.volume?.some((k) => Math.abs(k.t - t) <= 1e-3)) fail(`No volume point at ${a.time} s on that clip`);
      const next = changed(p, removeVolumePoint(p, a.clip, t), 'The clip is on a locked track');
      return { project: next, result: { clip: a.clip, points: next.clips.find((c) => c.id === a.clip)?.keys?.volume ?? [] } };
    },
  },
  {
    name: 'audio points-clear',
    summary: 'Remove every volume point of a clip.',
    inputs: [ref('clip', 'Clip id.')],
    result: 'Object with changed: true when points were removed.',
    needs: 'project',
    run: (p, a) => {
      audibleClip(p, a.clip);
      const next = clearVolumePoints(p, a.clip);
      return { project: next, result: { clip: a.clip, changed: next !== p } };
    },
  },
  {
    name: 'audio duck',
    summary: 'Make a narration clip pull the audio on the other tracks down while it speaks (or turn that off).',
    inputs: [
      ref('clip', 'Narration clip id.'),
      bool('on', 'Ducking on (default true); false removes it.', { optional: true }),
      num('thresholdDb', 'Speaking counts above this level, dBFS (default -40).', { optional: true, min: -90, max: 0 }),
      num('reductionDb', 'How far the others are pulled down, dB (default 12).', { optional: true, min: 0, max: 60 }),
      num('attack', 'Seconds to pull down (default 0.05).', { optional: true, min: 0.005, max: 5 }),
      num('release', 'Seconds to come back (default 0.5).', { optional: true, min: 0.02, max: 10 }),
      num('hold', 'Seconds to stay down across short pauses (default 0.2).', { optional: true, min: 0, max: 5 }),
    ],
    result: 'Object with the clip’s ducking settings after the change (null when off).',
    needs: 'project',
    run: (p, a) => {
      const clip = audibleClip(p, a.clip);
      let duck;
      if (a.on !== false) {
        duck = { ...DEFAULT_DUCK, ...clip.audio?.duck };
        for (const k of ['thresholdDb', 'reductionDb', 'attack', 'release', 'hold'] as const) if (a[k] !== undefined) duck[k] = a[k];
      }
      const next = changed(p, updateClipAudio(p, a.clip, { duck }), 'The clip is on a locked track');
      return { project: next, result: { clip: a.clip, duck: next.clips.find((c) => c.id === a.clip)?.audio?.duck ?? null } };
    },
  },
  browserCommand({
    name: 'audio level',
    summary: 'Even out loud and quiet parts and bring a clip to a target loudness. Decodes the sound, makes a new audio file in the bin and switches the clip to it.',
    inputs: [
      ref('clip', 'Clip id.'),
      num('target', 'Target loudness in dBFS (default -18).', { optional: true, min: -30, max: -10 }),
      num('amount', 'Compression, 0 to 100 percent (default 50).', { optional: true, min: 0, max: 100 }),
    ],
    result: 'Object with the summary line and the id of the processed audio clip.',
  }),
  browserCommand({
    name: 'audio denoise',
    summary: 'Remove steady background noise from a clip. Decodes the sound, makes a new audio file in the bin and switches the clip to it.',
    inputs: [
      ref('clip', 'Clip id.'),
      num('strength', 'Noise removal strength, 0 to 100 percent (default 60).', { optional: true, min: 0, max: 100 }),
      seconds('sampleStart', 'Start (seconds into the clip) of a stretch that holds only noise.', { optional: true }),
      seconds('sampleEnd', 'End (seconds into the clip) of that stretch.', { optional: true }),
    ],
    result: 'Object with the summary line and the id of the processed audio clip.',
  }),
];
