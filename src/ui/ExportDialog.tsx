import { useEffect, useMemo, useRef, useState } from 'react';
import { ExportQueue, type QueueItem } from '../engine/exportqueue';
import { type RunResult, runExport } from '../engine/export-run';
import {
  type ExportPreset,
  type ExportSettings,
  FILE_EXTENSION,
  FORMAT_LABEL,
  type ExportFormat,
  allPresets,
  describeSettings,
  loadLastSettings,
  loadUserPresets,
  saveLastSettings,
  saveUserPresets,
  withPreset,
  withoutPreset,
} from '../engine/presets';
import { projectDuration } from '../engine/project';
import { exportSpan } from '../engine/range';
import { type FileHandleLike, canPickFile, pickFolder, pickSaveFile, uniqueName } from '../engine/sinks';
import { bytes, download, safeFileName, timecode } from './format';
import { Icon } from './icons';
import { markBusy } from './lifecycle';
import { useModal } from './shell';
import type { Editor } from './useEditor';

interface Job {
  name: string;
  settings: ExportSettings;
}

const FORMATS: ExportFormat[] = ['mp4', 'gif', 'm4a', 'wav', 'png'];
const isAudio = (f: ExportFormat) => f === 'wav' || f === 'm4a';
const MP4_FPS = [15, 24, 25, 30, 50, 60];
const GIF_FPS = [8, 10, 12, 15, 20, 25];
const SIZES = [2160, 1440, 1080, 720, 480, 360, 240, 180];

/** The listed frame rates plus the current one, so a preset's own value always has an option. */
function fpsChoices(list: number[], current: ExportSettings['fps']): number[] {
  return typeof current === 'number' && !list.includes(current) ? [...list, current].sort((a, b) => a - b) : list;
}

export function ExportDialog({ editor, onClose, time = 0 }: { editor: Editor; onClose(): void; time?: number }) {
  const { project } = editor;
  const hasRange = !!project.range;
  const [settings, setSettings] = useState<ExportSettings>(() => {
    const last = loadLastSettings();
    return { ...last, range: last.range === 'marks' && project.range ? 'marks' : 'whole', stream: last.stream && canPickFile() };
  });
  const [userPresets, setUserPresets] = useState<ExportPreset[]>(() => loadUserPresets());
  const [presetId, setPresetId] = useState('');
  const [saving, setSaving] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [progress, setProgress] = useState<{ fraction: number; detail: string } | null>(null);
  const [result, setResult] = useState<{ name: string; run: RunResult } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const abort = useRef<AbortController | null>(null);
  const started = useRef(0);
  const queue = useRef(new ExportQueue<Job, RunResult & { name: string }>());
  const [items, setItems] = useState<ReadonlyArray<Readonly<QueueItem<Job, RunResult & { name: string }>>>>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const duration = projectDuration(project);
  const presets = useMemo(() => allPresets(userPresets), [userPresets]);
  const span = exportSpan(duration, settings.range === 'marks' ? project.range : undefined);

  useEffect(() => {
    const q = queue.current;
    const sync = () => {
      setItems(q.items);
      setBatchRunning(q.running);
    };
    sync();
    return q.subscribe(sync);
  }, []);

  const patch = (p: Partial<ExportSettings>) => {
    setSettings((s) => ({ ...s, ...p }));
    setPresetId('');
  };

  const choosePreset = (id: string) => {
    setPresetId(id);
    const preset = presets.find((p) => p.id === id);
    if (preset) {
      // A preset never turns streaming on by itself, and never asks for marks that are not there.
      setSettings({ ...preset.settings, range: preset.settings.range === 'marks' && !hasRange ? 'whole' : preset.settings.range, stream: settings.stream });
    }
  };

  const persistSettings = () => saveLastSettings(settings);

  const run = async () => {
    setError('');
    setNotice('');
    setResult(null);
    persistSettings();
    const name = `${safeFileName(project.name)}.${FILE_EXTENSION[settings.format]}`;
    let handle: FileHandleLike | null = null;
    if (settings.stream) {
      try {
        // Straight from the click: browsers only show the save picker right after a user action.
        handle = await pickSaveFile(safeFileName(project.name), FILE_EXTENSION[settings.format]);
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      if (!handle) return; // the user cancelled the picker
    }
    const controller = new AbortController();
    abort.current = controller;
    started.current = performance.now();
    setProgress({ fraction: 0, detail: 'Preparing…' });
    // Export renders in this page; tell the host so it never gives up on this window mid-export.
    const release = markBusy();
    try {
      const r = await runExport(editor.getProject(), settings, { blobs: editor.sources.blob, time, handle, onProgress: setProgress, signal: controller.signal });
      const savedAs = handle?.name ?? name;
      if (r.blob) download(r.blob, name);
      setResult({ name: savedAs, run: r });
      editor.setStatus(`Exported ${savedAs} (${bytes(r.bytes)})`);
    } catch (e) {
      const err = e as Error;
      setError(err.name === 'AbortError' ? 'Export cancelled.' : err.message);
    } finally {
      release();
      abort.current = null;
      setProgress(null);
    }
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const next = withPreset(userPresets, name, { ...settings, stream: false });
    setUserPresets(next);
    const saved = next.find((p) => p.name.toLowerCase() === name.toLowerCase());
    setPresetId(saved?.id ?? '');
    setSaving(false);
    setPresetName('');
    setNotice(saveUserPresets(next) ? `Saved the preset "${name}".` : `The preset "${name}" works for now, but this browser would not keep it.`);
  };

  const deletePreset = () => {
    const next = withoutPreset(userPresets, presetId);
    setUserPresets(next);
    setPresetId('');
    saveUserPresets(next);
    setNotice('Preset deleted.');
  };

  const addToBatch = () => {
    const preset = presets.find((p) => p.id === presetId);
    const label = preset?.name ?? describeSettings(settings, project);
    queue.current.add(label, { name: label, settings: { ...settings } });
    setNotice(`Added "${label}" to the batch.`);
  };

  const runBatch = async () => {
    setError('');
    setNotice('');
    const q = queue.current;
    const wantsFiles = q.items.some((i) => i.status === 'queued' && i.payload.settings.stream);
    let folder: Awaited<ReturnType<typeof pickFolder>> = null;
    if (wantsFiles) {
      try {
        folder = await pickFolder();
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      if (!folder) return;
    }
    const taken = new Set<string>();
    const release = markBusy();
    started.current = performance.now();
    const current = editor.getProject();
    try {
      await q.run(async (job, ctx) => {
        const ext = FILE_EXTENSION[job.settings.format];
        const base = `${safeFileName(current.name)} - ${safeFileName(job.name)}`;
        const fileName = uniqueName(base, ext, taken);
        taken.add(fileName);
        const handle = job.settings.stream && folder ? await folder.file(fileName) : null;
        const r = await runExport(current, job.settings, {
          blobs: editor.sources.blob,
          time,
          handle,
          signal: ctx.signal,
          onProgress: (p) => ctx.report(p.fraction, p.detail),
        });
        if (r.blob) download(r.blob, fileName);
        return { ...r, name: fileName };
      });
    } finally {
      release();
    }
    const counts = q.counts();
    editor.setStatus(`Batch finished: ${counts.done} done${counts.failed ? `, ${counts.failed} failed` : ''}${counts.cancelled ? `, ${counts.cancelled} cancelled` : ''}`);
  };

  const single = !!progress;
  const busy = single || batchRunning;
  const dialogRef = useRef<HTMLDivElement>(null);
  // Esc closes only while the close button is shown: never mid-export.
  useModal(dialogRef, busy ? undefined : onClose);
  const pct = progress ? Math.round(progress.fraction * 100) : 0;
  const elapsed = (performance.now() - started.current) / 1000;
  const eta = progress && progress.fraction > 0.08 ? (elapsed / progress.fraction) * (1 - progress.fraction) : null;
  const f = settings.format;
  const queued = items.filter((i) => i.status === 'queued').length;
  const finished = items.some((i) => i.status === 'done' || i.status === 'failed' || i.status === 'cancelled');

  return (
    <div className="modal-backdrop" role="presentation">
      <div ref={dialogRef} tabIndex={-1} className="modal fl-dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <header className="modal-head">
          <h2 id="export-title">Export video</h2>
          {!busy && (
            <button className="icon-button" onClick={onClose} title="Close (Esc)" aria-label="Close">
              <Icon name="close" />
            </button>
          )}
        </header>
        {duration <= 0 ? (
          <>
            <p className="modal-text">Add something to the timeline first. There is nothing to export yet.</p>
            <div className="modal-actions">
              <button className="button primary" onClick={onClose}>
                OK
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="modal-text">
              {FORMAT_LABEL[f]}, {span ? timecode(span.end - span.start) : timecode(duration)} long. Rendering happens on this computer.
            </p>
            <fieldset className="options export-options" disabled={busy}>
              <legend className="sr-only">Export options</legend>
              <div className="field wide export-preset">
                <label htmlFor="export-preset">Preset</label>
                <div className="export-row">
                  <select id="export-preset" value={presetId} onChange={(e) => choosePreset(e.target.value)}>
                    <option value="">Custom</option>
                    <optgroup label="Built in">
                      {presets
                        .filter((p) => p.builtin)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </optgroup>
                    {userPresets.length > 0 && (
                      <optgroup label="Yours">
                        {userPresets.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  <button type="button" className="button" onClick={() => setSaving((s) => !s)} aria-expanded={saving}>
                    Save as preset
                  </button>
                  {presets.find((p) => p.id === presetId && !p.builtin) && (
                    <button type="button" className="button" onClick={deletePreset}>
                      Delete preset
                    </button>
                  )}
                </div>
                {saving && (
                  <div className="export-row">
                    <input
                      type="text"
                      aria-label="Preset name"
                      placeholder="Preset name"
                      value={presetName}
                      maxLength={60}
                      onChange={(e) => setPresetName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          savePreset();
                        }
                      }}
                    />
                    <button type="button" className="button primary" onClick={savePreset} disabled={!presetName.trim()}>
                      Save
                    </button>
                  </div>
                )}
              </div>

              <div className="export-grid">
                <div className="field wide">
                  <label htmlFor="export-format">Format</label>
                  <select id="export-format" value={f} onChange={(e) => patch({ format: e.target.value as ExportFormat })}>
                    {FORMATS.map((x) => (
                      <option key={x} value={x}>
                        {FORMAT_LABEL[x]}
                      </option>
                    ))}
                  </select>
                </div>
                {f !== 'png' && (
                  <div className="field wide">
                    <label htmlFor="export-range">Range</label>
                    <select id="export-range" value={settings.range} onChange={(e) => patch({ range: e.target.value === 'marks' ? 'marks' : 'whole' })}>
                      <option value="whole">Whole project</option>
                      <option value="marks" disabled={!hasRange}>
                        {project.range ? `In to out (${timecode(project.range.start)} to ${timecode(project.range.end)})` : 'In to out (press I and O to set marks)'}
                      </option>
                    </select>
                  </div>
                )}
                {!isAudio(f) && (
                  <div className="field wide">
                    <label htmlFor="export-size">Size</label>
                    <select id="export-size" value={String(settings.size)} onChange={(e) => patch({ size: e.target.value === 'project' ? 'project' : Number(e.target.value) })}>
                      <option value="project">
                        Same as project ({project.width}×{project.height})
                      </option>
                      {SIZES.map((s) => (
                        <option key={s} value={s}>
                          {s}p
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {(f === 'mp4' || f === 'gif') && (
                  <div className="field wide">
                    <label htmlFor="export-fps">Frame rate</label>
                    <select id="export-fps" value={String(settings.fps)} onChange={(e) => patch({ fps: e.target.value === 'project' ? 'project' : Number(e.target.value) })}>
                      {f === 'mp4' && <option value="project">Same as project ({project.fps} fps)</option>}
                      {fpsChoices(f === 'gif' ? GIF_FPS : MP4_FPS, settings.fps).map((r) => (
                        <option key={r} value={r}>
                          {r} fps
                        </option>
                      ))}
                      {f === 'gif' && settings.fps === 'project' && <option value="project">Same as project ({project.fps} fps)</option>}
                    </select>
                  </div>
                )}
                {f === 'mp4' && (
                  <div className="field wide">
                    <label htmlFor="export-quality">Quality</label>
                    <select id="export-quality" value={settings.quality} onChange={(e) => patch({ quality: e.target.value as ExportSettings['quality'] })}>
                      <option value="small">Smaller file</option>
                      <option value="standard">Standard</option>
                      <option value="high">High quality</option>
                    </select>
                  </div>
                )}
                {f === 'gif' && (
                  <div className="field wide">
                    <label htmlFor="export-colors">Colours</label>
                    <select id="export-colors" value={settings.gifColors} onChange={(e) => patch({ gifColors: Number(e.target.value) })}>
                      {[256, 128, 64, 32, 16].map((c) => (
                        <option key={c} value={c}>
                          {c} colours
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {f === 'mp4' && (
                <label className="check">
                  <input type="checkbox" checked={settings.includeAudio} onChange={(e) => patch({ includeAudio: e.target.checked })} />
                  Include audio
                </label>
              )}
              {f === 'gif' && (
                <>
                  <label className="check">
                    <input type="checkbox" checked={settings.gifOptimize} onChange={(e) => patch({ gifOptimize: e.target.checked })} />
                    Smaller file (store only what changes between frames)
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={settings.gifDither} onChange={(e) => patch({ gifDither: e.target.checked })} />
                    Dither (smoother gradients, larger file)
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={settings.gifLoop} onChange={(e) => patch({ gifLoop: e.target.checked })} />
                    Loop forever
                  </label>
                </>
              )}
              {!isAudio(f) && project.captions.length > 0 && (
                <label className="check">
                  <input type="checkbox" checked={settings.captions} onChange={(e) => patch({ captions: e.target.checked })} />
                  Burn in captions ({project.captions.length})
                </label>
              )}
              {(f === 'mp4' || f === 'gif' || f === 'png') && (
                <label className="check">
                  <input type="checkbox" checked={settings.fast} onChange={(e) => patch({ fast: e.target.checked })} />
                  <span>
                    Fast video decoding
                    <span className="hint-inline"> Reads the source videos in order instead of seeking to every frame. Clips it cannot read are handled the slow way.</span>
                  </span>
                </label>
              )}
              {/* EXPORT-OPTIONS-EXTRA: other areas add one checkbox line here (for example chapter markers). */}
              {canPickFile() && (
                <label className="check">
                  <input type="checkbox" checked={settings.stream} onChange={(e) => setSettings((s) => ({ ...s, stream: e.target.checked }))} />
                  <span>
                    Save to file as it renders
                    <span className="hint-inline">
                      {' '}
                      You pick the file first and the export writes to it directly, so long exports do not fill memory. {f === 'mp4' ? 'The finished MP4 keeps its index at the end of the file.' : ''}
                    </span>
                  </span>
                </label>
              )}
              {f === 'png' && <p className="hint-inline">The picture is the frame under the playhead ({timecode(time)}).</p>}
            </fieldset>

            {single && (
              <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Export progress">
                <div className="progress-bar" style={{ width: `${pct}%` }} />
                <span className="progress-text">
                  {progress!.detail}
                  {eta !== null ? `, about ${Math.ceil(eta)} s left` : ''}
                </span>
              </div>
            )}
            {result && !busy && (
              <p className="success" role="status">
                Saved {result.name} ({bytes(result.run.bytes)}, {result.run.summary}).
                {result.run.softwareFallback && ' The hardware video encoder stopped responding, so this was encoded in software.'}
              </p>
            )}
            {notice && !error && (
              <p className="hint-inline export-notice" role="status">
                {notice}
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}

            <section className="export-batch" aria-labelledby="export-batch-title">
              <div className="export-batch-head">
                <h3 id="export-batch-title">Batch</h3>
                <div className="export-row">
                  <button type="button" className="button" onClick={addToBatch} disabled={busy}>
                    Add these settings to the batch
                  </button>
                  {finished && !batchRunning && (
                    <button type="button" className="button" onClick={() => queue.current.clearFinished()}>
                      Clear finished
                    </button>
                  )}
                </div>
              </div>
              {items.length === 0 ? (
                <p className="hint-inline">Add several presets and run them one after another.</p>
              ) : (
                <ul className="export-queue" aria-label="Batch export queue">
                  {items.map((it) => (
                    <li key={it.id} className={`export-item status-${it.status}`}>
                      <div className="export-item-main">
                        <span className="export-item-name">{it.label}</span>
                        <span className="export-item-meta">{describeSettings(it.payload.settings, project)}</span>
                        <span className="export-item-status" role="status">
                          {it.status === 'queued' && 'Waiting'}
                          {it.status === 'running' && `${Math.round(it.progress * 100)}% ${it.detail}`}
                          {it.status === 'done' && it.result && `Done: ${it.result.name} (${bytes(it.result.bytes)})`}
                          {it.status === 'failed' && `Failed: ${it.error}`}
                          {it.status === 'cancelled' && 'Cancelled'}
                        </span>
                        {it.status === 'running' && (
                          <div className="progress small" role="progressbar" aria-valuenow={Math.round(it.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Progress of ${it.label}`}>
                            <div className="progress-bar" style={{ width: `${Math.round(it.progress * 100)}%` }} />
                          </div>
                        )}
                      </div>
                      {(it.status === 'queued' || it.status === 'running') && (
                        <button type="button" className="button" onClick={() => queue.current.cancel(it.id)}>
                          Cancel<span className="sr-only"> {it.label}</span>
                        </button>
                      )}
                      {(it.status === 'failed' || it.status === 'cancelled') && !batchRunning && (
                        <button type="button" className="button" onClick={() => queue.current.retry(it.id)}>
                          Retry<span className="sr-only"> {it.label}</span>
                        </button>
                      )}
                      {it.status !== 'running' && !batchRunning && (
                        <button type="button" className="button" onClick={() => queue.current.remove(it.id)}>
                          Remove<span className="sr-only"> {it.label}</span>
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="modal-actions">
              {busy ? (
                <button
                  className="button"
                  onClick={() => {
                    if (single) abort.current?.abort();
                    else queue.current.cancelAll();
                  }}
                >
                  {single ? 'Cancel export' : 'Cancel batch'}
                </button>
              ) : (
                <>
                  <button className="button" onClick={onClose}>
                    {result || finished ? 'Done' : 'Cancel'}
                  </button>
                  {queued > 0 && (
                    <button className="button" onClick={() => void runBatch()}>
                      Run batch ({queued})
                    </button>
                  )}
                  <button className="button primary" onClick={() => void run()}>
                    <Icon name="export" size={16} />
                    {result ? 'Export again' : f === 'png' ? 'Export picture' : isAudio(f) ? 'Export audio' : f === 'gif' ? 'Export GIF' : 'Export video'}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
