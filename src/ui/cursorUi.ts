// Shared UI helpers for the cursor area: attaching a sidecar file and editing the effect settings.
import { useRef } from 'react';
import { CURSOR_LIMITS, type CursorFx, DEFAULT_CURSOR_FX, CursorFormatError, loadCursorImage, parseSidecar } from '../engine/cursor';
import { attachCursorData, setCursorFx } from '../engine/cursorops';
import type { Project } from '../engine/project';
import type { Editor } from './useEditor';

/** Reads a `.cursor.json` file and attaches it to a media item (one undo step; creates the default effect settings if there are none). */
export async function attachCursorFile(editor: Editor, mediaId: string, file: File): Promise<string | null> {
  try {
    if (file.size > CURSOR_LIMITS.sidecarChars) throw new CursorFormatError('The cursor file is too large (limit 24 MB)');
    const data = parseSidecar(await file.text());
    const p = editor.getProject();
    editor.commit(setCursorFx(attachCursorData(p, mediaId, data), {}), p);
    editor.setStatus(`Attached cursor data: ${data.samples.length} positions, ${data.clicks.length} click events, ${data.keys.length} key events`);
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    editor.setStatus(`Cursor data not attached: ${message}`);
    return message;
  }
}

const IMAGE_TYPES = ['image/png', 'image/svg+xml', 'image/webp', 'image/jpeg'];

/** Reads a replacement cursor image as a data URL. Returns the URL, or an error message. */
export function readCursorImage(file: File): Promise<{ url: string } | { error: string }> {
  if (!IMAGE_TYPES.includes(file.type)) return Promise.resolve({ error: 'Use a PNG, SVG, WebP or JPEG picture.' });
  if (file.size > 256 * 1024) return Promise.resolve({ error: 'The picture is larger than 256 KB.' });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve({ error: 'The picture could not be read.' });
    reader.onload = async () => {
      const url = String(reader.result);
      if (url.length > CURSOR_LIMITS.imageChars) return resolve({ error: 'The picture is larger than 256 KB.' });
      resolve((await loadCursorImage(url)) ? { url } : { error: 'The picture could not be decoded.' });
    };
    reader.readAsDataURL(file);
  });
}

export interface FxEditing {
  fx: CursorFx;
  /** True when the project has cursor effect settings at all. */
  exists: boolean;
  /** Applies a change and records one undo step (toggles, selects). */
  set(patch: Partial<CursorFx>): void;
  /** Shows a change while a slider or colour is being dragged. */
  preview(patch: Partial<CursorFx>): void;
  /** Ends the drag: records the change since the first preview as one undo step. */
  end(): void;
}

export function useFxEditing(editor: Editor): FxEditing {
  const before = useRef<Project | null>(null);
  return {
    fx: editor.project.cursorFx ?? DEFAULT_CURSOR_FX,
    exists: !!editor.project.cursorFx,
    set(patch) {
      editor.commit(setCursorFx(editor.getProject(), patch));
    },
    preview(patch) {
      if (!before.current) before.current = editor.getProject();
      editor.preview(setCursorFx(editor.getProject(), patch));
    },
    end() {
      if (before.current) editor.commit(editor.getProject(), before.current);
      before.current = null;
    },
  };
}
