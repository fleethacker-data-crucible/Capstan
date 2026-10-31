// Recording operations as plain data and callbacks, with no React and no DOM beyond what the
// recorder itself needs: settings -> recorder options, finished recording -> project, recovered
// session -> project. RecordDialog and RecoveryDialog are thin shells over these, so the same
// operations can later be wrapped as commands.
import type { CursorData } from './cursor';
import { attachCursorData, setCursorFx } from './cursorops';
import type { MediaHints } from './media';
import { type MediaItem, type Project, projectDuration } from './project';
import type { CaptureSurface, RecordOptions, Recording } from './recorder';
import {
  type CountdownSeconds,
  DEFAULT_PREFS,
  type PartMedia,
  type PlacedSet,
  type RecordPrefs,
  minutesToSeconds,
  placeRecordingSet,
  webcamOptions,
} from './recording-sources';
import type { PartRole, PlacementPlan, RecoverableSession, RecordingStore } from './recording-store';

/** Everything the setup step collects. Plain data, so it can come from a form, a file or a command line. */
export interface RecordSettings {
  surface: CaptureSurface;
  microphone: boolean;
  systemAudio: boolean;
  separateAudio: boolean;
  webcam: boolean;
  /** Empty = default camera. */
  cameraId: string;
  webcamResolution: string;
  webcamPip: boolean;
  countdown: CountdownSeconds;
  /** Minutes; 0 = no limit. */
  maxMinutes: number;
  toDisk: boolean;
  /** Ask for a region before recording (the UI step; the region itself becomes `PlacementPlan.crop`). */
  pickRegion: boolean;
  /** Ask the browser not to draw the mouse pointer into the capture. */
  hideCursor: boolean;
  /** Have the host log the pointer and button presses for cursor effects (off unless asked for; the pointer is then left out of the picture). */
  captureCursor: boolean;
  /** With `captureCursor`: also log keyboard shortcuts (function keys and Ctrl/Alt/Win combinations), never typed text. */
  captureKeys: boolean;
  addToTimeline: boolean;
}

export function defaultSettings(prefs: RecordPrefs = DEFAULT_PREFS): RecordSettings {
  return {
    surface: 'window',
    microphone: true,
    systemAudio: true,
    separateAudio: prefs.separateAudio,
    webcam: false,
    cameraId: '',
    webcamResolution: prefs.webcamResolution,
    webcamPip: prefs.webcamPip,
    countdown: prefs.countdown,
    maxMinutes: prefs.maxMinutes,
    toDisk: prefs.toDisk,
    pickRegion: false,
    hideCursor: false,
    captureCursor: false,
    captureKeys: false,
    addToTimeline: true,
  };
}

/** The part of the settings that is remembered between sessions. */
export function settingsToPrefs(s: RecordSettings): RecordPrefs {
  return {
    countdown: s.countdown,
    maxMinutes: s.maxMinutes > 0 ? s.maxMinutes : 0,
    toDisk: s.toDisk,
    separateAudio: s.separateAudio,
    webcamPip: s.webcamPip,
    webcamResolution: s.webcamResolution,
  };
}

/** Recorder options for these settings on this project; `store` is only used when saving to disk. */
export function toRecordOptions(s: RecordSettings, project: Pick<Project, 'width' | 'height' | 'fps'>, store: RecordingStore | null): RecordOptions {
  return {
    microphone: s.microphone,
    systemAudio: s.systemAudio,
    frameRate: project.fps >= 50 ? 60 : 30,
    surface: s.surface,
    maxWidth: project.width,
    maxHeight: project.height,
    separateAudio: s.separateAudio,
    webcam: s.webcam ? webcamOptions(s.cameraId, s.webcamResolution) : null,
    store: s.toDisk ? store : null,
    // Capstan draws the pointer again from the captured data, so the browser must leave it out.
    hideCursor: s.hideCursor || s.captureCursor,
  };
}

/** Cursor capture can only follow a whole screen: a browser cannot tell where a shared window or tab is. */
export const CAPTURE_NEEDS_SCREEN = 'Cursor capture needs “The entire screen”: a browser cannot tell where a shared window or tab is on the screen.';

/** What the setup step asks the host for, or null when cursor capture is off (or the surface cannot support it). */
export function captureRequest(s: Pick<RecordSettings, 'captureCursor' | 'captureKeys' | 'surface'>): { keys: boolean } | null {
  if (!s.captureCursor || s.surface !== 'monitor') return null;
  return { keys: s.captureKeys };
}

/** The indicator text for the recording bar while capture runs. */
export function captureLabel(keys: boolean, paused: boolean): string {
  return paused ? 'Cursor capture paused' : keys ? 'Capturing cursor and shortcuts' : 'Capturing cursor';
}

/**
 * Attaches captured cursor data to the new recording. The pointer was left out of the video, so when the
 * project has no cursor effect settings yet they are created with the drawn cursor on; settings the user
 * already has are kept.
 */
export function attachCaptured(project: Project, mediaId: string, data: CursorData): Project {
  const next = attachCursorData(project, mediaId, data);
  return project.cursorFx ? next : setCursorFx(next, { showCursor: true });
}

export const maxSeconds = (s: Pick<RecordSettings, 'maxMinutes'>) => minutesToSeconds(s.maxMinutes);

/** Adds one file to the media bin and returns its item (the editor's importRecording). */
export type ImportFile = (file: File, hints: MediaHints) => Promise<MediaItem>;

export interface ImportedSet {
  /** Items that made it into the bin, screen first. */
  parts: PartMedia[];
  /** One line per part that could not be imported. */
  problems: string[];
}

/**
 * Imports a finished recording: the screen file (errors propagate, so the caller can offer the
 * file for saving) and each extra part (errors are collected, the rest still lands).
 */
export async function importRecordingSet(rec: Recording, importFile: ImportFile): Promise<ImportedSet> {
  const screen = await importFile(new File([rec.blob], rec.name, { type: rec.blob.type }), { duration: rec.seconds, width: rec.width, height: rec.height });
  const parts: PartMedia[] = [{ role: 'screen', media: screen }];
  const problems: string[] = [];
  for (const part of rec.parts) {
    try {
      const media = await importFile(new File([part.blob], part.name, { type: part.blob.type }), { duration: part.seconds, width: part.width, height: part.height });
      parts.push({ role: part.role, media });
    } catch (e) {
      problems.push(`${part.name}: ${(e as Error).message}`);
    }
  }
  return { parts, problems };
}

/** Places imported parts at the end of the timeline. Null when nothing could be placed. */
export function placeAtEnd(project: Project, parts: PartMedia[], plan: PlacementPlan): PlacedSet | null {
  const placed = placeRecordingSet(project, parts, projectDuration(project), plan);
  return Object.keys(placed.clips).length ? placed : null;
}

/** The clip to select after placing: the screen clip, else the first one. */
export function primaryClip(placed: PlacedSet): string | undefined {
  return placed.clips.screen ?? (Object.values(placed.clips)[0] as string | undefined);
}

/** Imports the files of a leftover session (a crash or failed import) as a set. */
export async function importRecoveredSession(store: RecordingStore, s: RecoverableSession, importFile: ImportFile): Promise<PartMedia[]> {
  const loaded = await store.load(s.session);
  if (!loaded.length) throw new Error('There is no footage left in this recording.');
  const parts: PartMedia[] = [];
  for (const { role, file, info } of loaded) {
    // A recording that was cut short has no known length: let the importer measure it.
    const known = s.manifest.complete && role === 'screen' ? s.manifest.seconds : undefined;
    parts.push({ role: role as PartRole, media: await importFile(file, { width: info.width, height: info.height, duration: known }) });
  }
  return parts;
}
