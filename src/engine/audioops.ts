// Pure edits for the audio area: fades, ducking, volume points, and swapping in a processed copy of a clip's sound.
import { removeKey, setKey } from './anim';
import { type ClipAudio, parseClipAudio } from './audiofx';
import { fitOnTrack, isLocked, touch } from './ops';
import { type Clip, type MediaItem, type Project, createTrack, newId } from './project';

function replaceClip(project: Project, clip: Clip): Project {
  return touch(project, { clips: project.clips.map((c) => (c.id === clip.id ? clip : c)) });
}

/** Merges `patch` into the clip's audio settings; a key set to undefined is removed. Returns the project unchanged when locked. */
export function updateClipAudio(project: Project, clipId: string, patch: { [K in keyof ClipAudio]?: ClipAudio[K] | undefined }): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || isLocked(project, clip.trackId)) return project;
  const merged: Record<string, unknown> = { ...clip.audio, ...patch };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const audio = parseClipAudio(merged);
  const { audio: _old, ...rest } = clip;
  return replaceClip(project, audio ? { ...rest, audio } : rest);
}

function withVolumeKeys(project: Project, clipId: string, edit: (keys: Clip['keys']) => Clip['keys']): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || isLocked(project, clip.trackId)) return project;
  const keys = edit(clip.keys);
  const { keys: _old, ...rest } = clip;
  return replaceClip(project, keys ? { ...rest, keys } : rest);
}

/** Adds (or replaces) a volume point `t` seconds into the clip. Value 0..2 (1 = unchanged). */
export function addVolumePoint(project: Project, clipId: string, t: number, value: number): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const at = Math.min(clip.duration, Math.max(0, t));
  const v = Math.round(Math.min(2, Math.max(0, value)) * 1000) / 1000;
  return withVolumeKeys(project, clipId, (keys) => setKey(keys, 'volume', { t: at, v, ease: 'linear' }));
}

export function removeVolumePoint(project: Project, clipId: string, t: number): Project {
  return withVolumeKeys(project, clipId, (keys) => removeKey(keys, 'volume', t));
}

/** Moves a point from time `fromT` to `toT` with a new value (used when dragging a point on the clip). */
export function moveVolumePoint(project: Project, clipId: string, fromT: number, toT: number, value: number): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  const removed = removeKey(clip.keys, 'volume', fromT);
  const at = Math.min(clip.duration, Math.max(0, toT));
  const v = Math.round(Math.min(2, Math.max(0, value)) * 1000) / 1000;
  return withVolumeKeys(project, clipId, () => setKey(removed, 'volume', { t: at, v, ease: 'linear' }));
}

export function clearVolumePoints(project: Project, clipId: string): Project {
  return withVolumeKeys(project, clipId, (keys) => {
    if (!keys?.volume) return keys;
    const { volume: _drop, ...rest } = keys;
    return Object.keys(rest).length ? rest : undefined;
  });
}

/**
 * Uses a processed copy of a clip's sound (`media`: a WAV made from the same source, same length).
 *  - An audio clip is simply switched to the new media.
 *  - A video clip keeps its picture and is silenced; the processed sound goes on an audio clip with the same timing,
 *    speed, volume points and fades, linked to the video so they move together. It lands on the first track with room,
 *    or a new track.
 * The media must already be in the project (addMedia).
 */
export function applyProcessedAudio(project: Project, clipId: string, media: MediaItem): { project: Project; audioClipId: string | null } {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || !project.media.some((m) => m.id === media.id)) return { project, audioClipId: null };
  const source = project.media.find((m) => m.id === clip.mediaId);
  if (source?.kind !== 'video') {
    return { project: replaceClip(project, { ...clip, mediaId: media.id }), audioClipId: clip.id };
  }
  const linkId = clip.linkId ?? newId('lnk');
  let tracks = project.tracks;
  let trackId: string | null = null;
  for (const t of [...project.tracks].reverse()) {
    if (t.id === clip.trackId || t.locked) continue;
    const at = fitOnTrack(project, t.id, clip.start, clip.duration);
    if (at !== null && Math.abs(at - clip.start) < 1e-6) {
      trackId = t.id;
      break;
    }
  }
  if (!trackId) {
    const track = createTrack(tracks.length);
    tracks = [...tracks, track];
    trackId = track.id;
  }
  const { audio, ...videoRest } = clip;
  const audioClip: Clip = {
    id: newId('clp'),
    trackId,
    mediaId: media.id,
    start: clip.start,
    in: clip.in,
    duration: clip.duration,
    props: { ...clip.props },
    ...(clip.speed !== undefined ? { speed: clip.speed } : {}),
    ...(clip.keys?.volume ? { keys: { volume: clip.keys.volume.map((k) => ({ ...k })) } } : {}),
    ...(audio ? { audio: { ...audio } } : {}),
    linkId,
  };
  const silenced: Clip = { ...videoRest, linkId, audio: { silent: true } };
  return {
    project: touch(project, { tracks, clips: [...project.clips.map((c) => (c.id === clipId ? silenced : c)), audioClip] }),
    audioClipId: audioClip.id,
  };
}
