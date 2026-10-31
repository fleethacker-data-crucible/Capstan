// Export settings and presets: the options the export dialog edits, a few built-in presets, and
// user-saved presets kept in localStorage (guarded: storage can be missing or blocked).
import type { Project } from './project';

export type ExportFormat = 'mp4' | 'gif' | 'wav' | 'm4a' | 'png';
export type Quality = 'small' | 'standard' | 'high';

export const QUALITY_FACTOR: Record<Quality, number> = { small: 0.5, standard: 1, high: 1.8 };

export interface ExportSettings {
  format: ExportFormat;
  /** Short side of the picture in pixels, or the project's own size. */
  size: 'project' | number;
  quality: Quality;
  /** Frames per second, or the project's. */
  fps: 'project' | number;
  includeAudio: boolean;
  captions: boolean;
  range: 'whole' | 'marks';
  gifColors: number;
  gifDither: boolean;
  gifOptimize: boolean;
  gifLoop: boolean;
  /** Write straight to a file chosen by the user instead of downloading when finished. */
  stream: boolean;
  /** Decode source video in order with WebCodecs (falls back to seeking by itself). */
  fast: boolean;
}

export interface ExportPreset {
  id: string;
  name: string;
  builtin: boolean;
  settings: ExportSettings;
}

export const DEFAULT_SETTINGS: ExportSettings = {
  format: 'mp4',
  size: 'project',
  quality: 'standard',
  fps: 'project',
  includeAudio: true,
  captions: true,
  range: 'whole',
  gifColors: 256,
  gifDither: false,
  gifOptimize: true,
  gifLoop: true,
  stream: false,
  fast: true,
};

export const BUILTIN_PRESETS: ExportPreset[] = [
  { id: 'builtin-youtube-1080', name: 'YouTube 1080p', builtin: true, settings: { ...DEFAULT_SETTINGS, size: 1080, quality: 'high', fps: 'project' } },
  { id: 'builtin-small-720', name: 'Small 720p', builtin: true, settings: { ...DEFAULT_SETTINGS, size: 720, quality: 'small', fps: 30 } },
  { id: 'builtin-gif-480', name: 'GIF 480', builtin: true, settings: { ...DEFAULT_SETTINGS, format: 'gif', size: 480, fps: 12, gifColors: 128, includeAudio: false } },
  { id: 'builtin-audio', name: 'Audio only', builtin: true, settings: { ...DEFAULT_SETTINGS, format: 'm4a' } },
];

const FORMATS: ExportFormat[] = ['mp4', 'gif', 'wav', 'm4a', 'png'];

/** Fills in and clamps a settings object read from storage or typed in. Unknown fields are dropped. */
export function parseSettings(input: unknown): ExportSettings {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const num = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    format: FORMATS.includes(o.format as ExportFormat) ? (o.format as ExportFormat) : d.format,
    size: o.size === 'project' ? 'project' : typeof o.size === 'number' ? num(o.size, 64, 4320, 1080) : d.size,
    quality: o.quality === 'small' || o.quality === 'high' || o.quality === 'standard' ? o.quality : d.quality,
    fps: o.fps === 'project' ? 'project' : typeof o.fps === 'number' ? num(o.fps, 1, 60, 30) : d.fps,
    includeAudio: bool(o.includeAudio, d.includeAudio),
    captions: bool(o.captions, d.captions),
    range: o.range === 'marks' ? 'marks' : 'whole',
    gifColors: num(o.gifColors, 2, 256, d.gifColors),
    gifDither: bool(o.gifDither, d.gifDither),
    gifOptimize: bool(o.gifOptimize, d.gifOptimize),
    gifLoop: bool(o.gifLoop, d.gifLoop),
    stream: bool(o.stream, d.stream),
    fast: bool(o.fast, d.fast),
  };
}

export const FILE_EXTENSION: Record<ExportFormat, string> = { mp4: 'mp4', gif: 'gif', wav: 'wav', m4a: 'm4a', png: 'png' };
export const FORMAT_LABEL: Record<ExportFormat, string> = {
  mp4: 'MP4 video (H.264)',
  gif: 'Animated GIF',
  wav: 'WAV audio',
  m4a: 'M4A audio (AAC)',
  png: 'PNG picture (frame at the playhead)',
};

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Output size for the settings: the project's aspect ratio with the short side as asked, kept even. */
export function outputSize(project: Pick<Project, 'width' | 'height'>, size: ExportSettings['size']): { width: number; height: number } {
  if (size === 'project') return { width: even(project.width), height: even(project.height) };
  const k = size / Math.min(project.width, project.height);
  return { width: even(project.width * k), height: even(project.height * k) };
}

export function outputFps(project: Pick<Project, 'fps'>, fps: ExportSettings['fps']): number {
  return fps === 'project' ? project.fps : fps;
}

/** A short line describing the settings, for presets and the batch list. */
export function describeSettings(s: ExportSettings, project: Pick<Project, 'width' | 'height' | 'fps'>): string {
  const ext = FILE_EXTENSION[s.format].toUpperCase();
  const range = s.range === 'marks' ? ', in to out' : '';
  if (s.format === 'wav' || s.format === 'm4a') return `${ext}${range}`;
  const { width, height } = outputSize(project, s.size);
  if (s.format === 'png') return `${ext} ${width}×${height}`;
  if (s.format === 'gif') return `${ext} ${width}×${height}, ${outputFps(project, s.fps)} fps, ${s.gifColors} colours${range}`;
  return `${ext} ${width}×${height}, ${outputFps(project, s.fps)} fps, ${s.quality}${range}`;
}

// ---- user presets in localStorage ---------------------------------------------------------

export const PRESETS_KEY = 'capstan.export.presets.v1';
export const LAST_KEY = 'capstan.export.last.v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function store(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Parses the stored preset list; anything malformed is dropped. */
export function parsePresets(raw: string | null): ExportPreset[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    const out: ExportPreset[] = [];
    for (const p of list) {
      if (!p || typeof p !== 'object' || typeof (p as ExportPreset).name !== 'string') continue;
      const name = (p as ExportPreset).name.trim().slice(0, 60);
      if (!name) continue;
      out.push({ id: String((p as ExportPreset).id ?? `user-${out.length}`), name, builtin: false, settings: parseSettings((p as ExportPreset).settings) });
    }
    return out;
  } catch {
    return [];
  }
}

export function loadUserPresets(storage: StorageLike | null = store()): ExportPreset[] {
  try {
    return parsePresets(storage?.getItem(PRESETS_KEY) ?? null);
  } catch {
    return [];
  }
}

/** Returns false when the browser would not store it (private window, blocked storage, full). */
export function saveUserPresets(list: ExportPreset[], storage: StorageLike | null = store()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(PRESETS_KEY, JSON.stringify(list.filter((p) => !p.builtin)));
    return true;
  } catch {
    return false;
  }
}

/** Adds a preset, or replaces the user preset with the same name (case-insensitive). */
export function withPreset(list: ExportPreset[], name: string, settings: ExportSettings): ExportPreset[] {
  const clean = name.trim().slice(0, 60);
  if (!clean) return list;
  const existing = list.find((p) => !p.builtin && p.name.toLowerCase() === clean.toLowerCase());
  const entry: ExportPreset = { id: existing?.id ?? `user-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: clean, builtin: false, settings };
  return existing ? list.map((p) => (p === existing ? entry : p)) : [...list, entry];
}

export function withoutPreset(list: ExportPreset[], id: string): ExportPreset[] {
  return list.filter((p) => p.builtin || p.id !== id);
}

export function allPresets(user: ExportPreset[]): ExportPreset[] {
  return [...BUILTIN_PRESETS, ...user.filter((p) => !p.builtin)];
}

export function loadLastSettings(storage: StorageLike | null = store()): ExportSettings {
  try {
    const raw = storage?.getItem(LAST_KEY);
    return raw ? parseSettings(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveLastSettings(settings: ExportSettings, storage: StorageLike | null = store()): void {
  try {
    storage?.setItem(LAST_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable: the dialog just opens with defaults next time */
  }
}
