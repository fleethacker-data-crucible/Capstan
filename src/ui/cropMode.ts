// Crop mode is UI state shared by the inspector (its toggle and aspect presets), the crop tool on the
// picture and the preview (which shows the whole frame while cropping). Not part of the project.
import { useMemo, useSyncExternalStore } from 'react';
import type { Project } from '../engine/project';

export interface CropState {
  /** The clip being cropped, or null when crop mode is off. */
  clipId: string | null;
  /** Locked shape (width / height in source pixels) or null for free cropping. */
  aspect: number | null;
}

let state: CropState = { clipId: null, aspect: null };
const listeners = new Set<() => void>();

function set(next: CropState): void {
  if (next.clipId === state.clipId && next.aspect === state.aspect) return;
  state = next;
  for (const fn of listeners) fn();
}

export const cropMode = {
  get(): CropState {
    return state;
  },
  /** Turns crop mode on for a clip, or off when it is already on for it. */
  toggle(clipId: string): void {
    set(state.clipId === clipId ? { clipId: null, aspect: null } : { clipId, aspect: null });
  },
  off(): void {
    set({ clipId: null, aspect: null });
  },
  setAspect(aspect: number | null): void {
    set({ ...state, aspect });
  },
  /** The clip being cropped, if it is the one clip selected. */
  activeFor(selection: string[]): string | null {
    return state.clipId && selection.length === 1 && selection[0] === state.clipId ? state.clipId : null;
  },
};

export function useCropMode(): CropState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

/**
 * The project the preview should draw. While a clip is being cropped the picture shows the whole
 * frame (so the crop frame can be dragged over what is being cut); everything else is unchanged.
 */
export function useCropView(project: Project, selection: string[]): Project {
  const crop = useCropMode();
  const id = crop.clipId && selection.length === 1 && selection[0] === crop.clipId ? crop.clipId : null;
  return useMemo(() => {
    if (!id) return project;
    const clip = project.clips.find((c) => c.id === id);
    if (!clip?.crop) return project;
    return { ...project, clips: project.clips.map((c) => (c.id === id ? { ...c, crop: undefined } : c)) };
  }, [project, id]);
}
