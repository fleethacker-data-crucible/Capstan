import { useCallback, useEffect, useState } from 'react';
import { createProject } from '../../engine/project';
import { type ProjectSummary, cloneProject, copyName, isEmptyProject, summariseProject } from '../../engine/projects';
import { copyMediaBlobs, deleteProject, listProjects, saveProject, storageEstimate } from '../../engine/storage';
import type { Project } from '../../engine/project';
import { bytes, shortDuration } from '../format';
import { Icon } from '../icons';
import type { Editor } from '../useEditor';
import { DialogFrame } from './DialogFrame';

interface Row {
  project: Project;
  summary: ProjectSummary;
  current: boolean;
}

const when = (t: number) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

export function ProjectsDialog({ editor, onClose }: { editor: Editor; onClose(): void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const stored = await listProjects();
      // The open project's latest state is in memory (autosave trails by a moment).
      const open = editor.getProject();
      const list: Row[] = stored
        .filter((s) => s.project.id !== open.id)
        .filter((s) => !isEmptyProject(s.project))
        .map((s) => ({ ...s, current: false }));
      list.unshift({ project: open, summary: summariseProject(open), current: true });
      list.sort((a, b) => Number(b.current) - Number(a.current) || b.summary.updatedAt - a.summary.updatedAt);
      setRows(list);
      setUsage(await storageEstimate());
    } catch (e) {
      setError(`Could not read the project list: ${(e as Error).message}`);
      setRows([]);
    }
  }, [editor]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const open = (row: Row) =>
    run(async () => {
      if (!row.current) await editor.openProject(row.project);
      onClose();
    });

  const rename = (row: Row, name: string) =>
    run(async () => {
      const text = name.trim().slice(0, 120);
      setRenaming(null);
      if (!text || text === row.project.name) return;
      if (row.current) editor.commit({ ...editor.getProject(), name: text, updatedAt: Date.now() });
      else await saveProject({ ...row.project, name: text, updatedAt: Date.now() }, { markLast: false });
      editor.setStatus(`Renamed to ${text}`);
    });

  const duplicate = (row: Row) =>
    run(async () => {
      const source = row.current ? editor.getProject() : row.project;
      const { project: copy, idMap } = cloneProject(source, copyName(source.name, (rows ?? []).map((r) => r.project.name)));
      await copyMediaBlobs(idMap);
      try {
        await saveProject(copy, { markLast: false });
      } catch (e) {
        await deleteProject(copy); // remove the media copies written above
        throw e;
      }
      editor.setStatus(`Duplicated as ${copy.name}`);
    });

  const remove = (row: Row) => {
    const size = row.summary.mediaBytes ? ` and its ${bytes(row.summary.mediaBytes)} of media` : '';
    if (!window.confirm(`Delete ${row.project.name}${size} from this browser? This cannot be undone. A saved .capstanz package is not affected.`)) return;
    void run(async () => {
      if (row.current) {
        // Leave the project first (that saves it), then remove it.
        await editor.openProject(createProject());
        await deleteProject(row.project);
      } else await deleteProject(row.project);
      editor.setStatus(`Deleted ${row.project.name}`);
    });
  };

  return (
    <DialogFrame title="Projects" titleId="projects-title" onClose={onClose}>
      <p className="modal-text">Every project is kept in this browser, with its media. Open one to carry on, or save a .capstanz package from the Project menu to keep a copy outside the browser.</p>
      {rows === null ? (
        <p className="hint">Loading…</p>
      ) : (
        <ul className="pp-list" aria-label="Projects">
          {rows.map((row) => {
            const s = row.summary;
            const isRenaming = renaming?.id === row.project.id;
            return (
              <li key={row.project.id} className={`pp-item${row.current ? ' current' : ''}`} data-project-id={row.project.id}>
                <div className="pp-main">
                  {isRenaming ? (
                    <input
                      className="pp-rename"
                      aria-label={`New name for ${row.project.name}`}
                      value={renaming.text}
                      autoFocus
                      maxLength={120}
                      onChange={(e) => setRenaming({ id: row.project.id, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void rename(row, renaming.text);
                        else if (e.key === 'Escape') {
                          e.stopPropagation();
                          setRenaming(null);
                        }
                      }}
                      onBlur={() => setRenaming(null)}
                    />
                  ) : (
                    <span className="pp-name" title={row.project.name}>
                      {row.project.name}
                    </span>
                  )}
                  {row.current && <span className="fl-badge pp-badge">Open now</span>}
                  <span className="pp-sub">
                    {s.width}×{s.height} · {s.clipCount} clip{s.clipCount === 1 ? '' : 's'}
                    {s.duration > 0 ? ` · ${shortDuration(s.duration)}` : ''} · {s.mediaCount} media · <span className="pp-size">{bytes(s.mediaBytes)}</span> · edited {when(s.updatedAt)}
                  </span>
                </div>
                <div className="pp-actions">
                  {!row.current && (
                    <button className="button" disabled={busy} onClick={() => void open(row)} aria-label={`Open ${row.project.name}`}>
                      Open
                    </button>
                  )}
                  <button className="button" disabled={busy} aria-label={`Rename ${row.project.name}`} onClick={() => setRenaming({ id: row.project.id, text: row.project.name })}>
                    Rename
                  </button>
                  <button className="button" disabled={busy} aria-label={`Duplicate ${row.project.name}`} onClick={() => void duplicate(row)}>
                    Duplicate
                  </button>
                  <button className="button" disabled={busy} aria-label={`Delete ${row.project.name}`} onClick={() => remove(row)}>
                    <Icon name="trash" />
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="hint pp-foot">
        {rows ? `${rows.length} project${rows.length === 1 ? '' : 's'}, ${bytes(rows.reduce((n, r) => n + r.summary.mediaBytes, 0))} of media.` : ''}
        {usage && usage.quota ? ` This browser is using ${bytes(usage.usage)} of ${bytes(usage.quota)} available to Capstan.` : ''}
      </p>
      <div className="modal-actions">
        <button className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </DialogFrame>
  );
}
