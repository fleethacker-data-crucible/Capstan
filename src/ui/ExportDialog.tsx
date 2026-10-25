import { useRef, useState } from 'react';
import { type ExportProgress, type ExportResult, defaultExportOptions, exportMp4 } from '../engine/export';
import { projectDuration } from '../engine/project';
import { bytes, download, safeFileName, timecode } from './format';
import { Icon } from './icons';
import type { Editor } from './useEditor';

type Quality = 'standard' | 'high' | 'small';
const QUALITY: Record<Quality, { label: string; factor: number }> = {
  small: { label: 'Smaller file', factor: 0.5 },
  standard: { label: 'Standard', factor: 1 },
  high: { label: 'High quality', factor: 1.8 },
};

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

export function ExportDialog({ editor, onClose }: { editor: Editor; onClose(): void }) {
  const { project } = editor;
  const [size, setSize] = useState<'project' | 1080 | 720>('project');
  const [quality, setQuality] = useState<Quality>('standard');
  const [includeAudio, setIncludeAudio] = useState(true);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const started = useRef(0);
  const duration = projectDuration(project);

  const dims = () => {
    if (size === 'project') return { width: even(project.width), height: even(project.height) };
    const k = size / Math.min(project.width, project.height);
    return { width: even(project.width * k), height: even(project.height * k) };
  };

  const run = async () => {
    setError('');
    setResult(null);
    const { width, height } = dims();
    const base = defaultExportOptions({ ...project, width, height });
    const controller = new AbortController();
    abort.current = controller;
    started.current = performance.now();
    try {
      const r = await exportMp4(
        project,
        editor.sources.blob,
        { ...base, videoBitrate: Math.round(base.videoBitrate * QUALITY[quality].factor), includeAudio },
        setProgress,
        controller.signal,
      );
      setResult(r);
      download(r.blob, `${safeFileName(project.name)}.mp4`);
      editor.setStatus(`Exported ${safeFileName(project.name)}.mp4 (${bytes(r.blob.size)})`);
    } catch (e) {
      const err = e as Error;
      setError(err.name === 'AbortError' ? 'Export cancelled.' : err.message);
    } finally {
      abort.current = null;
      setProgress(null);
    }
  };

  const busy = !!progress;
  const pct = progress ? Math.round(progress.fraction * 100) : 0;
  const elapsed = (performance.now() - started.current) / 1000;
  const eta = progress && progress.fraction > 0.08 ? (elapsed / progress.fraction) * (1 - progress.fraction) : null;

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <header className="modal-head">
          <h2 id="export-title">Export video</h2>
          {!busy && (
            <button className="icon-button" onClick={onClose} title="Close">
              <Icon name="close" size={16} />
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
              MP4 (H.264), {timecode(duration)} long. Rendering happens on this computer and the file goes to your Downloads folder.
            </p>
            <fieldset className="options" disabled={busy}>
              <div className="field wide">
                <label htmlFor="export-size">Size</label>
                <select id="export-size" value={String(size)} onChange={(e) => setSize(e.target.value === 'project' ? 'project' : (Number(e.target.value) as 1080 | 720))}>
                  <option value="project">Same as project ({project.width}×{project.height})</option>
                  <option value="1080">1080p</option>
                  <option value="720">720p</option>
                </select>
              </div>
              <div className="field wide">
                <label htmlFor="export-quality">Quality</label>
                <select id="export-quality" value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
                  {(Object.keys(QUALITY) as Quality[]).map((q) => (
                    <option key={q} value={q}>
                      {QUALITY[q].label}
                    </option>
                  ))}
                </select>
              </div>
              <label className="check">
                <input type="checkbox" checked={includeAudio} onChange={(e) => setIncludeAudio(e.target.checked)} />
                Include audio
              </label>
            </fieldset>
            {busy && (
              <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Export progress">
                <div className="progress-bar" style={{ width: `${pct}%` }} />
                <span className="progress-text">
                  {progress!.stage === 'audio'
                    ? 'Mixing audio…'
                    : progress!.stage === 'video'
                      ? `Rendering frame ${progress!.frame} of ${progress!.frames}${eta !== null ? `, about ${Math.ceil(eta)} s left` : ''}`
                      : progress!.stage === 'finishing'
                        ? 'Writing the file…'
                        : 'Preparing…'}
                </span>
              </div>
            )}
            {result && !busy && (
              <p className="success" role="status">
                Saved {safeFileName(project.name)}.mp4 ({bytes(result.blob.size)}, H.264 video
                {result.audioCodec ? ` with ${result.audioCodec === 'aac' ? 'AAC' : 'Opus'} audio` : ', no audio'}).
              </p>
            )}
            {error && <p className="error" role="alert">{error}</p>}
            <div className="modal-actions">
              {busy ? (
                <button className="button" onClick={() => abort.current?.abort()}>
                  Cancel export
                </button>
              ) : (
                <>
                  <button className="button" onClick={onClose}>
                    {result ? 'Done' : 'Cancel'}
                  </button>
                  <button className="button primary" onClick={() => void run()}>
                    <Icon name="export" size={16} />
                    {result ? 'Export again' : 'Export video'}
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
