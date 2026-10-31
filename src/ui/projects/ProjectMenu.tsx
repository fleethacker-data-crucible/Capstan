import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { sessionToken } from '../lifecycle';
import type { Editor } from '../useEditor';
import { importSnapshackleCaptures, openPackageFile, savePackage, snapshackleAvailable, snapshackleHostAvailable } from './actions';
import { type ProjectDialogKind, onProjectDialog } from './bus';
import { LibraryDialog } from './LibraryDialog';
import { ProjectsDialog } from './ProjectsDialog';
import { SnapshackleDialog } from './SnapshackleDialog';
import { TemplatesDialog } from './TemplatesDialog';

type Item = { id: string; label: string; hint?: string; disabled?: boolean; run(): void } | 'separator';

/**
 * The toolbar's Project menu: Projects, package save/open, templates, library and SnapShackle import,
 * with the dialogs they open. One button in App.tsx; everything else lives here.
 */
export function ProjectMenu({ editor }: { editor: Editor }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<ProjectDialogKind | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const packageInput = useRef<HTMLInputElement>(null);
  const supported = snapshackleAvailable();
  // null until the host has answered; true when it found a SnapShackle Captures folder to list.
  const [hostSnap, setHostSnap] = useState<boolean | null>(null);
  const hasHost = sessionToken() !== '';

  useEffect(() => onProjectDialog(setDialog), []);

  // Close on a click elsewhere or Esc.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        root.current?.querySelector<HTMLElement>('.project-menu-button')?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (menuOpen) root.current?.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')?.focus();
  }, [menuOpen]);

  // Ask the host each time the menu opens: SnapShackle may have made its folder since.
  useEffect(() => {
    if (!menuOpen) return;
    let live = true;
    void snapshackleHostAvailable().then((found) => live && setHostSnap(found));
    return () => {
      live = false;
    };
  }, [menuOpen]);

  const importCaptures = async () => {
    // Asked again at click time so a quick click never lands on the folder picker by mistake.
    const found = await snapshackleHostAvailable();
    setHostSnap(found);
    if (found) setDialog('snapshackle');
    else await importSnapshackleCaptures(editor);
  };

  const guarded = (work: () => Promise<void>) => () => {
    // The actions report their own failures in the status bar; this only stops an unhandled rejection.
    void work().catch(() => undefined);
  };

  const items: Item[] = [
    { id: 'projects', label: 'Projects…', hint: 'Open, rename, duplicate or delete', run: () => setDialog('projects') },
    { id: 'save-package', label: 'Save package (.capstanz)', hint: 'Project and all media in one file', run: guarded(() => savePackage(editor)) },
    { id: 'open-package', label: 'Open package…', run: () => packageInput.current?.click() },
    'separator',
    { id: 'save-template', label: 'Save as template…', run: () => setDialog('templates-save') },
    { id: 'new-template', label: 'New from template…', hint: 'Templates and themes', run: () => setDialog('templates-new') },
    { id: 'library', label: 'Library…', hint: 'Reusable images, audio and clips', run: () => setDialog('library') },
    'separator',
    {
      id: 'snapshackle',
      label: 'Import from SnapShackle captures…',
      hint: hostSnap
        ? 'Choose from your newest captures, with their text'
        : hasHost && hostSnap === false && supported
          ? 'No SnapShackle folder found; pick one by hand'
          : supported
            ? 'Pick the Captures folder'
            : hasHost
              ? 'No SnapShackle folder found'
              : 'Needs Edge or Chrome',
      disabled: !supported && !hostSnap,
      run: guarded(importCaptures),
    },
  ];

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const buttons = Array.from(root.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)') ?? []);
    if (!buttons.length) return;
    e.preventDefault();
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  const close = () => setDialog(null);

  return (
    <div className="tool-group project-menu" ref={root}>
      <button
        className="icon-button labelled project-menu-button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Project: packages, templates, library"
        onClick={() => setMenuOpen(!menuOpen)}
      >
        <Icon name="film" />
        <span>Project</span>
        <span className="menu-caret" aria-hidden>
          ▾
        </span>
      </button>
      {menuOpen && (
        <div className="project-menu-list" role="menu" aria-label="Project" onKeyDown={onMenuKey}>
          {items.map((item, i) =>
            item === 'separator' ? (
              <div key={`s${i}`} className="project-menu-sep" role="separator" />
            ) : (
              <button
                key={item.id}
                role="menuitem"
                className="project-menu-item"
                disabled={item.disabled}
                data-menu-id={item.id}
                onClick={() => {
                  setMenuOpen(false);
                  item.run();
                }}
              >
                <span>{item.label}</span>
                {item.hint && <small>{item.hint}</small>}
              </button>
            ),
          )}
        </div>
      )}
      <input
        ref={packageInput}
        type="file"
        accept=".capstanz,.zip,application/zip"
        hidden
        aria-label="Open a project package"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void openPackageFile(editor, f).catch(() => undefined);
        }}
      />
      {dialog === 'projects' && <ProjectsDialog editor={editor} onClose={close} />}
      {(dialog === 'templates-new' || dialog === 'templates-save') && <TemplatesDialog editor={editor} mode={dialog === 'templates-save' ? 'save' : 'new'} onClose={close} />}
      {dialog === 'library' && <LibraryDialog editor={editor} onClose={close} />}
      {dialog === 'snapshackle' && (
        <SnapshackleDialog
          editor={editor}
          onClose={close}
          onPickFolder={() => {
            close();
            if (supported) void importSnapshackleCaptures(editor).catch(() => undefined);
            else editor.setStatus('This browser cannot open a folder. Use Edge or Chrome, or select the capture files with Import media.');
          }}
        />
      )}
    </div>
  );
}
