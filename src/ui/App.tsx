import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteClips, splitAt } from '../engine/ops';
import type { Player } from '../engine/player';
import { parseProject, projectDuration } from '../engine/project';
import { ExportDialog } from './ExportDialog';
import { download, safeFileName, timecode } from './format';
import { Icon } from './icons';
import { Inspector } from './Inspector';
import { MediaBin } from './MediaBin';
import { Preview } from './Preview';
import { RecordDialog } from './RecordDialog';
import { Timeline } from './Timeline';
import { useEditor } from './useEditor';

declare const __CAPSTAN_VERSION__: string;

const SHORTCUTS: Array<[string, string]> = [
  ['Space', 'Play or pause'],
  ['S', 'Split at the playhead'],
  ['Delete', 'Delete selected clips'],
  ['Shift+Delete', 'Delete and close the gap'],
  ['← / →', 'Step one frame (Shift: one second)'],
  ['Home / End', 'Go to start or end'],
  ['Ctrl+Z / Ctrl+Y', 'Undo or redo'],
  ['Ctrl+A', 'Select all clips'],
  ['Ctrl+wheel', 'Zoom the timeline'],
];

export function App() {
  const editor = useEditor();
  const [player, setPlayer] = useState<Player | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(60);
  const [snapping, setSnapping] = useState(true);
  const [dialog, setDialog] = useState<'record' | 'export' | 'shortcuts' | null>(null);
  const [dragging, setDragging] = useState(false);
  const openInput = useRef<HTMLInputElement>(null);
  const { project, selection } = editor;
  const duration = projectDuration(project);

  useEffect(() => {
    if (!player) return;
    return player.subscribe((t, p) => {
      setTime(t);
      setPlaying(p);
    });
  }, [player]);

  const split = useCallback(() => {
    editor.commit(splitAt(editor.project, time, selection));
  }, [editor, time, selection]);

  const remove = useCallback(
    (ripple: boolean) => {
      if (!selection.length) return;
      editor.commit(deleteClips(editor.project, selection, ripple));
      editor.setSelection([]);
    },
    [editor, selection],
  );

  // Keyboard shortcuts (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (dialog || target.closest('input, select, textarea, [contenteditable="true"]')) return;
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
    editor.setStatus('Project file saved. Media stays in Capstan on this computer.');
  };

  const openProjectFile = async (file: File) => {
    try {
      const p = parseProject(JSON.parse(await file.text()));
      editor.replaceProject(p);
      editor.setStatus(`Opened ${p.name}`);
    } catch (e) {
      editor.setStatus(`Could not open ${file.name}: ${(e as Error).message}`);
    }
  };

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand" aria-label="Capstan">
          <svg viewBox="0 0 28 20" width="28" height="20" aria-hidden>
            <rect x="0.75" y="0.75" width="26.5" height="18.5" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="8.5" cy="9" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="19.5" cy="9" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8.5 12.2h11" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <span>Capstan</span>
        </div>
        <div className="tool-group">
          <button className="icon-button" title="New project" onClick={() => {
            if (project.clips.length && !window.confirm('Start a new project? The current project and its media will be removed from Capstan.')) return;
            editor.newProject();
          }}>
            <Icon name="newDoc" />
          </button>
          <button className="icon-button" title="Open project file" onClick={() => openInput.current?.click()}>
            <Icon name="open" />
          </button>
          <button className="icon-button" title="Save project file" onClick={saveProjectFile}>
            <Icon name="save" />
          </button>
          <input
            ref={openInput}
            type="file"
            accept=".capstan,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void openProjectFile(f);
            }}
          />
        </div>
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
        <div className="project-title" title={project.name}>
          {project.name}
        </div>
        <button className="icon-button" title="Keyboard shortcuts (?)" onClick={() => setDialog('shortcuts')}>
          <span className="kbd-hint">?</span>
        </button>
        <button className="button primary export" onClick={() => setDialog('export')}>
          <Icon name="export" size={16} />
          Export video
        </button>
      </header>

      <main className="workspace">
        <MediaBin editor={editor} time={time} onRecord={() => setDialog('record')} />
        <Preview editor={editor} time={time} onPlayer={setPlayer} />
        <Inspector editor={editor} />
      </main>

      <div className="transport" role="toolbar" aria-label="Playback">
        <button className="icon-button" title="Go to start (Home)" onClick={() => player?.seek(0)}>
          <Icon name="toStart" />
        </button>
        <button className="icon-button" title="Previous frame (←)" onClick={() => player?.step(-1)}>
          <Icon name="stepBack" />
        </button>
        <button className="play-button" title={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => player?.toggle()} disabled={!duration}>
          <Icon name={playing ? 'pause' : 'play'} size={20} />
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

      <footer className="statusbar">
        <span role="status">{editor.status}</span>
        <span className="version">Capstan {__CAPSTAN_VERSION__} · works offline</span>
      </footer>

      {dragging && (
        <div className="drop-overlay" aria-hidden>
          <p>Drop to import</p>
        </div>
      )}
      {dialog === 'record' && <RecordDialog editor={editor} onClose={() => setDialog(null)} />}
      {dialog === 'export' && <ExportDialog editor={editor} onClose={() => setDialog(null)} />}
      {dialog === 'shortcuts' && (
        <div className="modal-backdrop" role="presentation" onClick={() => setDialog(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="keys-title" onClick={(e) => e.stopPropagation()}>
            <header className="modal-head">
              <h2 id="keys-title">Keyboard shortcuts</h2>
              <button className="icon-button" onClick={() => setDialog(null)} title="Close">
                <Icon name="close" size={16} />
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
      )}
    </div>
  );
}
