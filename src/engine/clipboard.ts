// The in-memory clip clipboard. It lives for the page session only (nothing is written to the system
// clipboard) and holds deep copies, so later edits to the originals never change what gets pasted.
import { type PasteResult, pasteClips, snapshotClips } from './editops';
import type { Clip, Project } from './project';

let held: Clip[] = [];

/** Copies the clips (and whatever is linked or grouped with them). Returns how many were copied. */
export function copyClips(project: Project, ids: string[]): number {
  const items = snapshotClips(project, ids);
  if (items.length) held = items;
  return items.length;
}

export function hasClipboard(): boolean {
  return held.length > 0;
}

export function clipboardCount(): number {
  return held.length;
}

export function clearClipboard(): void {
  held = [];
}

/** Pastes the held clips so the earliest starts at `time`, fitted into free gaps. */
export function pasteHeld(project: Project, time: number): PasteResult {
  return pasteClips(project, held, time);
}
