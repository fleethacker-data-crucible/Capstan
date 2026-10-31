// Pure logic for the extra recording sources: webcam options, countdown and length limit, and
// where each recorded part goes on the timeline.
import { addClip, touch } from './ops';
import { type Clip, type ClipProps, type Crop, type MediaItem, type Project, createTrack, defaultProps, findMedia } from './project';
import type { PartRole, PlacementPlan } from './recording-store';
import { fittedSize } from './compositor';

// ---------------------------------------------------------------- options

export interface WebcamResolution {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const WEBCAM_RESOLUTIONS: WebcamResolution[] = [
  { id: '480', label: '480p (640×480)', width: 640, height: 480 },
  { id: '720', label: '720p (1280×720)', width: 1280, height: 720 },
  { id: '1080', label: '1080p (1920×1080)', width: 1920, height: 1080 },
];

export const COUNTDOWN_CHOICES = [0, 3, 5] as const;
export type CountdownSeconds = (typeof COUNTDOWN_CHOICES)[number];

export interface WebcamOptions {
  /** Empty = the browser's default camera. */
  deviceId: string;
  width: number;
  height: number;
  frameRate: number;
}

export function webcamOptions(deviceId: string, resolutionId: string, frameRate = 30): WebcamOptions {
  const res = WEBCAM_RESOLUTIONS.find((r) => r.id === resolutionId) ?? WEBCAM_RESOLUTIONS[1];
  return { deviceId, width: res.width, height: res.height, frameRate };
}

/** getUserMedia constraints for the webcam: video only, the microphone is recorded on its own. */
export function webcamConstraints(o: WebcamOptions): MediaStreamConstraints {
  const video: MediaTrackConstraints = { width: { ideal: o.width }, height: { ideal: o.height }, frameRate: { ideal: o.frameRate } };
  if (o.deviceId) video.deviceId = { exact: o.deviceId };
  return { video, audio: false };
}

/** What the setup step collects, saved between sessions (except the webcam, which is off each time). */
export interface RecordPrefs {
  countdown: CountdownSeconds;
  /** Minutes; 0 = no limit. */
  maxMinutes: number;
  toDisk: boolean;
  separateAudio: boolean;
  webcamPip: boolean;
  webcamResolution: string;
}

export const DEFAULT_PREFS: RecordPrefs = { countdown: 3, maxMinutes: 0, toDisk: true, separateAudio: false, webcamPip: true, webcamResolution: '720' };

export function parsePrefs(text: string | null): RecordPrefs {
  if (!text) return { ...DEFAULT_PREFS };
  try {
    const v = JSON.parse(text) as Partial<RecordPrefs>;
    const countdown = COUNTDOWN_CHOICES.find((c) => c === v.countdown) ?? DEFAULT_PREFS.countdown;
    const max = typeof v.maxMinutes === 'number' && Number.isFinite(v.maxMinutes) ? Math.min(24 * 60, Math.max(0, v.maxMinutes)) : 0;
    return {
      countdown,
      maxMinutes: max,
      toDisk: v.toDisk !== false,
      separateAudio: v.separateAudio === true,
      webcamPip: v.webcamPip !== false,
      webcamResolution: WEBCAM_RESOLUTIONS.some((r) => r.id === v.webcamResolution) ? (v.webcamResolution as string) : DEFAULT_PREFS.webcamResolution,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

// ---------------------------------------------------------------- countdown and limit

/** The number to show with `remainingMs` left: 3 until two seconds remain... down to 1, then 0. */
export function countdownValue(remainingMs: number): number {
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

/** How long before the limit the warning appears: a tenth of it, between 2 and 30 seconds. */
export function warningLead(maxSeconds: number): number {
  return Math.min(30, Math.max(2, Math.round(maxSeconds * 0.1)));
}

export interface LimitState {
  /** Seconds left; null without a limit. */
  remaining: number | null;
  /** True in the warning window. */
  warn: boolean;
  /** True once the limit is reached and the recording must stop. */
  reached: boolean;
}

export function limitState(elapsedSeconds: number, maxSeconds: number): LimitState {
  if (!(maxSeconds > 0)) return { remaining: null, warn: false, reached: false };
  const remaining = Math.max(0, maxSeconds - elapsedSeconds);
  return { remaining, warn: remaining > 0 && remaining <= warningLead(maxSeconds), reached: remaining <= 0 };
}

export const minutesToSeconds = (minutes: number) => (Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : 0);

// ---------------------------------------------------------------- placement

/** Properties for a picture-in-picture clip: `scale` of the canvas fit, in the lower right corner. */
export function pipProps(project: Pick<Project, 'width' | 'height'>, media: { width: number; height: number }, scale = 0.25, margin = 0.03): ClipProps {
  const fit = fittedSize(media, project);
  const w = fit.width * scale;
  const h = fit.height * scale;
  const m = Math.round(Math.min(project.width, project.height) * margin);
  return { ...defaultProps(project), scale, x: Math.round(project.width - m - w / 2), y: Math.round(project.height - m - h / 2) };
}

export interface PartMedia {
  role: PartRole;
  media: MediaItem;
}

export interface PlacedSet {
  project: Project;
  /** Clip ids by role. */
  clips: Partial<Record<PartRole, string>>;
}

const TRACK_NAME: Record<PartRole, string> = { screen: 'Screen', webcam: 'Webcam', mic: 'Microphone', system: 'System audio' };

/**
 * Puts a recording on the timeline: the screen clip where it fits at `start` (cropped to the
 * chosen region), and every other part on its own new track starting at the same moment. New
 * tracks go on top, so a webcam picture-in-picture is drawn over the screen. Parts missing from
 * `parts` are skipped; the screen part is optional so a recovered session without it still works.
 */
export function placeRecordingSet(project: Project, parts: PartMedia[], start: number, plan: PlacementPlan): PlacedSet {
  let next = project;
  const clips: Partial<Record<PartRole, string>> = {};
  const order: PartRole[] = ['screen', 'webcam', 'mic', 'system'];
  for (const role of order) {
    const part = parts.find((p) => p.role === role);
    if (!part || !findMedia(next, part.media.id)) continue;
    let trackId: string | undefined;
    if (role !== 'screen') {
      // Every other part gets its own new track on top; the screen clip takes the first track with room.
      const track = { ...createTrack(next.tracks.length), name: TRACK_NAME[role] };
      next = touch(next, { tracks: [...next.tracks, track] });
      trackId = track.id;
    }
    const placed = addClip(next, part.media.id, start, trackId);
    if (!placed.clipId) continue;
    next = placed.project;
    const patch = clipPatch(next, placed.clipId, role, part.media, plan);
    next = touch(next, {
      clips: next.clips.map((c) => (c.id === placed.clipId ? patch(c) : c)),
      // A webcam records no sound: say so, so export does not try to mix it.
      media: role === 'webcam' ? next.media.map((m) => (m.id === part.media.id ? { ...m, hasAudio: false } : m)) : next.media,
    });
    clips[role] = placed.clipId;
  }
  return { project: next, clips };
}

function clipPatch(project: Project, _clipId: string, role: PartRole, media: MediaItem, plan: PlacementPlan): (c: Clip) => Clip {
  if (role === 'screen' && plan.crop) {
    const crop: Crop = plan.crop;
    return (c) => ({ ...c, crop });
  }
  if (role === 'webcam' && plan.pip) return (c) => ({ ...c, props: pipProps(project, media) });
  return (c) => c;
}
