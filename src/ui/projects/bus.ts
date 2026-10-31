// A tiny event hop so the Welcome view can open the Project dialogs without App.tsx wiring each one.
export type ProjectDialogKind = 'projects' | 'templates-new' | 'templates-save' | 'library' | 'snapshackle';

const listeners = new Set<(kind: ProjectDialogKind) => void>();

export function openProjectDialog(kind: ProjectDialogKind): void {
  for (const l of listeners) l(kind);
}

export function onProjectDialog(listener: (kind: ProjectDialogKind) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
