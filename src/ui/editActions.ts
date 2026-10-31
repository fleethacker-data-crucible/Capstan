// Editor-level clip commands (copy, paste, group, ...), shared by the keyboard shortcuts and the
// inspector buttons. Each reads the latest project, makes one undo step and says what it did.
import { clipboardCount, copyClips, hasClipboard, pasteHeld } from '../engine/clipboard';
import { deleteBundle, duplicateClips, groupClips, magnetize, ungroupClips } from '../engine/editops';
import type { Editor } from './useEditor';

/** The selected ids that are clips (the selection can also hold blur regions and other items). */
export function selectedClips(editor: Editor): string[] {
  const project = editor.getProject();
  return editor.selection.filter((id) => project.clips.some((c) => c.id === id));
}

const plural = (n: number) => `${n} clip${n === 1 ? '' : 's'}`;

export function copySelection(editor: Editor): boolean {
  const n = copyClips(editor.getProject(), selectedClips(editor));
  if (n) editor.setStatus(`Copied ${plural(n)}`);
  return n > 0;
}

export function cutSelection(editor: Editor): void {
  const ids = selectedClips(editor);
  const n = copyClips(editor.getProject(), ids);
  if (!n) return;
  editor.commit(deleteBundle(editor.getProject(), ids, false));
  editor.setSelection([]);
  editor.setStatus(`Cut ${plural(n)}`);
}

export function pasteAtPlayhead(editor: Editor, time: number): void {
  if (!hasClipboard()) {
    editor.setStatus('Nothing copied yet');
    return;
  }
  const r = pasteHeld(editor.getProject(), time);
  if (!r.ids.length) {
    editor.setStatus('Could not paste: the media is no longer in this project');
    return;
  }
  editor.commit(magnetize(r.project));
  editor.setSelection(r.ids);
  editor.setStatus(`Pasted ${plural(clipboardCount())}`);
}

export function duplicateSelection(editor: Editor): void {
  const r = duplicateClips(editor.getProject(), selectedClips(editor));
  if (!r.ids.length) return;
  editor.commit(magnetize(r.project));
  editor.setSelection(r.ids);
  editor.setStatus(`Duplicated ${plural(r.ids.length)}`);
}

export function groupSelection(editor: Editor): void {
  const r = groupClips(editor.getProject(), selectedClips(editor));
  if (!r.groupId) {
    editor.setStatus('Select two or more clips to group them');
    return;
  }
  editor.commit(r.project);
  editor.setStatus('Grouped. They now select, move, trim and delete together');
}

export function ungroupSelection(editor: Editor): void {
  const next = ungroupClips(editor.getProject(), selectedClips(editor));
  if (next === editor.getProject()) return;
  editor.commit(next);
  editor.setStatus('Ungrouped');
}
