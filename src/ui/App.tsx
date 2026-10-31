import { useCallback, useEffect, useRef, useState } from 'react';
import { removeAnnotation } from '../engine/annotationOps';
import { removeCaption } from '../engine/captionops';
import { deleteBundle, splitBundle } from '../engine/editops';
import { addMarker, removeMarker } from '../engine/markers';
import { removeRedaction } from '../engine/ops';
import type { Player } from '../engine/player';
import { removeZoom } from '../engine/zoom';
import { projectDuration } from '../engine/project';
import { setRange, setRangeIn, setRangeOut } from '../engine/range';
import { ExportDialog } from './ExportDialog';
import { copySelection, cutSelection, duplicateSelection, groupSelection, pasteAtPlayhead, ungroupSelection } from './editActions';
import { download, safeFileName, timecode } from './format';
import { Icon } from './icons';
import { Emblem, Welcome } from './Welcome';
import { RecoveryDialog } from './RecoveryDialog';
import { Inspector } from './Inspector';
import { onHotkey, startHotkeys } from './hotkeys';
import { endSession, isBusy, onEngineState, sessionToken, startHeartbeat, type EngineState } from './lifecycle';
import { onLibraryState } from '../engine/storage';
import type { MirrorState } from '../engine/library-mirror';
import { Preview } from './Preview';
import { ProjectMenu } from './projects/ProjectMenu';
import { openAnyProjectFile } from './projects/actions';
import { RecordDialog } from './RecordDialog';
import { applyTheme, nextTheme, readSidebarCollapsed, readTheme, saveSidebarCollapsed, themeName, useModal, type ThemeChoice } from './shell';
import { Timeline } from './Timeline';
import { Toolbox } from './Toolbox';
import { useEditor } from './useEditor';

declare const __CAPSTAN_VERSION__: string;

const ENGINE_WORD: Record<EngineState, string> = {
  connecting: 'Connecting',
  running: 'Running',
  disconnected: 'Disconnected',
  stopped: 'Stopped',
  standalone: 'Standalone',
};
const THEME_ICON = { system: 'themeSystem', dark: 'themeDark', light: 'themeLight' } as const;

function useNarrow(): boolean {
  // Narrower than 1024 px the sidebar collapses by itself (docs/UNIFIED-UI.md section 5).
  const query = '(max-width: 1023px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

function ShortcutsDialog({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div ref={ref} tabIndex={-1} className="modal fl-dialog" role="dialog" aria-modal="true" aria-labelledby="keys-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 id="keys-title">Keyboard shortcuts</h2>
          <button className="icon-button" onClick={onClose} title="Close (Esc)">
            <Icon name="close" />
          </button>
        </header>
        <dl className="shortcuts">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ['Space', 'Play or pause'],
  ['S', 'Split at the playhead'],
  ['M', 'Add a marker at the playhead'],
  ['Ctrl+Shift+F9 / F10 / F11', 'Anywhere in Windows (changeable in Record screen): start or stop, pause or resume, add a marker'],
  ['Delete', 'Delete selected clips, blur region, annotation, zoom, caption or marker'],
  ['Shift+Delete', 'Delete and close the gap'],
  ['← / →', 'Step one frame (Shift: one second)'],
  ['Home / End', 'Go to start or end'],
  ['Ctrl+Z / Ctrl+Y', 'Undo or redo'],
  ['Ctrl+A', 'Select all clips'],
  ['Ctrl+C / Ctrl+X / Ctrl+V', 'Copy, cut or paste clips at the playhead'],
  ['Ctrl+D', 'Duplicate the selected clips'],
  ['G / Shift+G', 'Group or ungroup the selected clips'],
  ['I / O', 'Mark the start / end of the part to export'],
  ['Alt+X', 'Clear the in and out marks'],
  ['Ctrl+wheel', 'Zoom the timeline'],
  ['?', 'Show these shortcuts'],
  ['Esc', 'Clear the selection, or close a dialog'],
];

export function App() {
  const editor = useEditor();
  const [player, setPlayer] = useState<Player | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(60);
  const [snapping, setSnapping] = useState(true);
  const [dialog, setDialog] = useState<'record' | 'export' | 'shortcuts' | null>(null);
  // Opened by the start hotkey: the Record dialog tries to start with the last used settings.
  const [recordAuto, setRecordAuto] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [ended, setEnded] = useState(false);
  // An empty project opens on the Welcome landing view until there is media or the viewer asks for the editor.
  const [editorAnyway, setEditorAnyway] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [collapsedPref, setCollapsedPref] = useState(readSidebarCollapsed);
  const [engine, setEngine] = useState<EngineState>('connecting');
  const [library, setLibrary] = useState<MirrorState>({ active: false, pending: 0, failed: 0, progress: null, lastError: null });
  const narrow = useNarrow();
  const collapsed = collapsedPref || narrow;
  const openInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => onEngineState(setEngine), []);
  useEffect(() => onLibraryState(setLibrary), []);

  const cycleTheme = () => {
    const t = nextTheme(theme);
    applyTheme(t);
    setTheme(t);
  };
  const toggleSidebar = () => {
    saveSidebarCollapsed(!collapsedPref);
    setCollapsedPref(!collapsedPref);
  };
  const { project, selection } = editor;
  const duration = projectDuration(project);

  // This window owns the local host: it stops by itself once no Capstan window is open.
  const stopHeartbeat = useRef<() => void>(() => {});
  useEffect(() => {
    stopHeartbeat.current = startHeartbeat();
    return () => stopHeartbeat.current();
  }, []);

  // Global hotkeys and the tray icon (the Windows host queues them; the Record dialog answers while it is open).
  const hotkeyContext = useRef({ editor, time, dialog });
  hotkeyContext.current = { editor, time, dialog };
  useEffect(() => startHotkeys(), []);
  useEffect(
    () =>
      onHotkey((e) => {
        const { editor: ed, time: t, dialog: d } = hotkeyContext.current;
        if (e.name === 'start-stop') {
          if (d === null) {
            setRecordAuto(true);
            setDialog('record');
          }
          return true;
        }
        if (e.name === 'marker') {
          const r = addMarker(ed.project, t);
          if (r.id) {
            ed.commit(r.project);
            ed.setSelection([r.id]);
          }
          return true;
        }
        if (e.name === 'tray-open') {
          window.focus();
          return true;
        }
        return true;
      }),
    [],
  );

  const quit = async () => {
    const busyNote = isBusy() ? ' An export or recording is still running and will be lost.' : '';
    if (!window.confirm(`End this Capstan session? The local server stops; your projects and media stay saved in this browser.${busyNote}`)) return;
    try {
      await endSession();
      stopHeartbeat.current();
      player?.pause();
      setEnded(true);
    } catch (e) {
      editor.setStatus((e as Error).message);
    }
  };

  useEffect(() => {
    if (!player) return;
    return player.subscribe((t, p) => {
      setTime(t);
      setPlaying(p);
    });
  }, [player]);

  const split = useCallback(() => {
    editor.commit(splitBundle(editor.project, time, selection));
  }, [editor, time, selection]);

  const remove = useCallback(
    (ripple: boolean) => {
      if (!selection.length) return;
      let next = deleteBundle(editor.project, selection, ripple);
      for (const id of selection) next = removeMarker(removeCaption(removeZoom(removeAnnotation(removeRedaction(next, id), id), id), id), id);
      editor.commit(next);
      editor.setSelection([]);
    },
    [editor, selection],
  );

  // Keyboard shortcuts (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (dialog || target.closest('input, select, textarea, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === ' ') {
        e.preventDefault();
        player?.toggle();
      } else if (ctrl && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
      } else if (ctrl && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        editor.redo();
      } else if (ctrl && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        editor.setSelection(editor.project.clips.map((c) => c.id));
      } else if (ctrl && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        copySelection(editor);
      } else if (ctrl && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        cutSelection(editor);
      } else if (ctrl && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        pasteAtPlayhead(editor, time);
      } else if (ctrl && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateSelection(editor);
      } else if (!ctrl && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        if (e.shiftKey) ungroupSelection(editor);
        else groupSelection(editor);
      } else if (!ctrl && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        const r = addMarker(editor.project, time);
        if (r.id) {
          editor.commit(r.project);
          editor.setSelection([r.id]);
        }
      } else if (!ctrl && e.key.toLowerCase() === 's') {
        e.preventDefault();
        split();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        remove(e.shiftKey);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey) player?.seek(time + dir);
        else player?.step(dir);
      } else if (!ctrl && !e.altKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        editor.commit(setRangeIn(editor.project, time, duration));
      } else if (!ctrl && !e.altKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        editor.commit(setRangeOut(editor.project, time));
      } else if (e.altKey && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        editor.commit(setRange(editor.project, undefined));
      } else if (e.key === 'Home') {
        player?.seek(0);
      } else if (e.key === 'End') {
        player?.seek(duration);
      } else if (e.key === 'Escape') {
        editor.setSelection([]);
      } else if (e.key === '?') {
        setDialog('shortcuts');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, editor, player, split, remove, time, duration]);

  // Files dropped anywhere in the window are imported.
  useEffect(() => {
    const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const over = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void editor.importFiles(files);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [editor]);

  const saveProjectFile = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    download(blob, `${safeFileName(project.name)}.capstan`);
    editor.setStatus('Project file saved (the edit only). To carry the media too, use Project > Save package.');
  };

  const openProjectFile = (file: File) => openAnyProjectFile(editor, file);

  if (ended) {
    return (
      <div className="session-ended fl-empty" role="main">
        <Emblem size={240} />
        <h2>Session ended</h2>
        <p>Capstan has stopped. Your projects and media are saved in this browser. You can close this window; run Launch-Capstan.bat to start again.</p>
        <button className="button primary fl-btn fl-btn--primary" onClick={() => window.close()}>
          Close window
        </button>
      </div>
    );
  }

  return (
    <div className={`app${collapsed ? ' sidebar-collapsed' : ''}`}>
      <aside className="sidebar" aria-label="Capstan">
        <div className="sidebar-brand" title="Capstan">
          {/* Expanded: the full emblem with its wordmark. Collapsed rail: the emblem's circle. */}
          {collapsed ? <img src="/assets/icon-256.png" alt="Capstan" width={40} height={40} /> : <Emblem size={184} />}
        </div>
        <nav className="fl-nav sidebar-nav" aria-label="Capstan">
          <button aria-current="page" title="Editor">
            <Icon name="editor" size={20} />
            <span>Editor</span>
          </button>
          <button className="nav-record" title="Record screen" onClick={() => setDialog('record')}>
            <Icon name="record" size={20} />
            <span>Record screen</span>
          </button>
          <button title="Import media" onClick={() => importInput.current?.click()}>
            <Icon name="import" size={20} />
            <span>Import media</span>
          </button>
          <button title="Export video" onClick={() => setDialog('export')}>
            <Icon name="export" size={20} />
            <span>Export video</span>
          </button>
          <input
            ref={importInput}
            type="file"
            multiple
            accept="video/*,audio/*,image/*"
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length) void editor.importFiles(files);
            }}
          />
        </nav>
        <div className="fl-nav sidebar-foot">
          <button title="Keyboard shortcuts (?)" onClick={() => setDialog('shortcuts')}>
            <Icon name="keyboard" size={20} />
            <span>Shortcuts</span>
          </button>
          <button title={`Theme: ${themeName(theme)}. Click for ${themeName(nextTheme(theme))}.`} onClick={cycleTheme}>
            <Icon name={THEME_ICON[theme]} size={20} />
            <span>{themeName(theme)}</span>
          </button>
          {sessionToken() && (
            <button className="end-session" title="End session: stop Capstan's local server" onClick={() => void quit()}>
              <Icon name="power" size={20} />
              <span>End session</span>
            </button>
          )}
          {!narrow && (
            <button title={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} aria-expanded={!collapsed} onClick={toggleSidebar}>
              <Icon name={collapsed ? 'expand' : 'collapse'} size={20} />
              <span>Collapse</span>
            </button>
          )}
        </div>
      </aside>

      <div className="main">
      <header className="toolbar">
        <h1 className="project-title" title={project.name}>
          {project.name}
        </h1>
        <div className="tool-group">
          <button className="icon-button" title="New project" onClick={() => {
            if (project.clips.length && !window.confirm('Start a new project? The current project stays in Project > Projects.')) return;
            editor.newProject();
          }}>
            <Icon name="newDoc" />
          </button>
          <button className="icon-button" title="Open project file (.capstan edit, or a .capstanz package with its media)" onClick={() => openInput.current?.click()}>
            <Icon name="open" />
          </button>
          <button className="icon-button" title="Save project file (.capstan: the edit only, no media). To move a project to another computer use Project, Save package." onClick={saveProjectFile}>
            <Icon name="save" />
          </button>
          <input
            ref={openInput}
            type="file"
            accept=".capstan,.capstanz,application/json,application/zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void openProjectFile(f);
            }}
          />
        </div>
        <ProjectMenu editor={editor} />
        <div className="tool-group">
          <button className="icon-button" title="Undo (Ctrl+Z)" disabled={!editor.canUndo} onClick={editor.undo}>
            <Icon name="undo" />
          </button>
          <button className="icon-button" title="Redo (Ctrl+Y)" disabled={!editor.canRedo} onClick={editor.redo}>
            <Icon name="redo" />
          </button>
        </div>
        <div className="tool-group">
          <button className="icon-button labelled" title="Split at playhead (S)" onClick={split}>
            <Icon name="split" />
            <span>Split</span>
          </button>
          <button className="icon-button labelled" title="Delete (Del)" disabled={!selection.length} onClick={() => remove(false)}>
            <Icon name="trash" />
            <span>Delete</span>
          </button>
        </div>
        <button className="button primary export fl-btn fl-btn--primary" onClick={() => setDialog('export')}>
          <Icon name="export" />
          Export video
        </button>
      </header>

      {!editorAnyway && project.media.length === 0 && project.clips.length === 0 ? (
        <Welcome
          onRecord={() => setDialog('record')}
          onImport={() => importInput.current?.click()}
          onOpen={() => openInput.current?.click()}
          onEditor={() => setEditorAnyway(true)}
        />
      ) : (
      <>
      <main className="workspace">
        <Toolbox editor={editor} time={time} onRecord={() => setDialog('record')} onSeek={(t) => player?.seek(t)} />
        <Preview editor={editor} time={time} onPlayer={setPlayer} />
        <Inspector editor={editor} time={time} onSeek={(t) => player?.seek(t)} />
      </main>

      <div className="transport" role="toolbar" aria-label="Playback">
        <button className="icon-button" title="Go to start (Home)" onClick={() => player?.seek(0)}>
          <Icon name="toStart" />
        </button>
        <button className="icon-button" title="Previous frame (←)" onClick={() => player?.step(-1)}>
          <Icon name="stepBack" />
        </button>
        <button className="play-button" title={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => player?.toggle()} disabled={!duration}>
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <button className="icon-button" title="Next frame (→)" onClick={() => player?.step(1)}>
          <Icon name="stepForward" />
        </button>
        <div className="timecode" aria-live="off">
          <span className="now">{timecode(time, project.fps)}</span>
          <span className="total">{timecode(duration, project.fps)}</span>
        </div>
        <div className="spacer" />
        <button
          className={`icon-button labelled${snapping ? ' on' : ''}`}
          title="Snap to clip edges and the playhead"
          aria-pressed={snapping}
          onClick={() => setSnapping(!snapping)}
        >
          <Icon name="magnet" />
          <span>Snap</span>
        </button>
        <button className="icon-button" title="Zoom out" onClick={() => setZoom(Math.max(4, zoom / 1.4))}>
          <Icon name="zoomOut" />
        </button>
        <input
          className="zoom"
          type="range"
          min={Math.log(4)}
          max={Math.log(400)}
          step={0.01}
          value={Math.log(zoom)}
          aria-label="Timeline zoom"
          onChange={(e) => setZoom(Math.exp(Number(e.target.value)))}
        />
        <button className="icon-button" title="Zoom in" onClick={() => setZoom(Math.min(400, zoom * 1.4))}>
          <Icon name="zoomIn" />
        </button>
      </div>

      <Timeline editor={editor} player={player} time={time} playing={playing} zoom={zoom} setZoom={setZoom} snapping={snapping} />
      </>
      )}
      </div>

      <footer className="statusbar">
        <span className={`engine engine-${engine}`}>
          <span className="engine-dot" aria-hidden />
          {ENGINE_WORD[engine]}
        </span>
        {library.active && (
          <span
            className={`library-line${library.failed ? ' library-failed' : ''}`}
            title={library.lastError ?? 'Media is also kept in a folder on this computer (Capstan, under LOCALAPPDATA), so a project still finds it on another port or after the browser was cleared.'}
          >
            Library on disk
            {library.pending > 0 && ` · saving ${library.pending}${library.progress != null ? ` (${Math.round(library.progress * 100)}%)` : ''}`}
            {library.failed > 0 && ' · last copy failed'}
          </span>
        )}
        <span className="address" title="The address this Capstan is served from">
          {window.location.host || 'file'}
        </span>
        <span className="message" role="status">
          {editor.status}
        </span>
        <span className="version">Capstan {__CAPSTAN_VERSION__}</span>
      </footer>

      {dragging && (
        <div className="drop-overlay" aria-hidden>
          <p>Drop to import</p>
        </div>
      )}
      {editor.ready && <RecoveryDialog editor={editor} />}
      {dialog === 'record' && (
        <RecordDialog
          editor={editor}
          autostart={recordAuto}
          onClose={() => {
            setDialog(null);
            setRecordAuto(false);
          }}
        />
      )}
      {dialog === 'export' && <ExportDialog editor={editor} time={time} onClose={() => setDialog(null)} />}
      {dialog === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
