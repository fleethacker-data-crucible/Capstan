import { type ReactElement, useRef, useState } from 'react';
import { formatSrt, formatVtt, parseSubtitles } from '../../engine/captions';
import { addCaptionAt, nudgeCaptions, removeCaption, splitCaption, updateCaptionText } from '../../engine/captionops';
import { setCaptions } from '../../engine/ops';
import type { Project } from '../../engine/project';
import { download, safeFileName, timecode } from '../format';
import { Icon } from '../icons';
import type { ToolboxProps } from '../toolboxTabs';
import { TranscribeSection } from './TranscribeSection';

// Caption list and editor: import and export subtitle files, edit every caption in place.
export const enabled = true;
export const tab = { id: 'captions', label: 'Captions' };

export function CaptionsPanel({ editor, time, onSeek }: ToolboxProps): ReactElement {
  const { project, selection } = editor;
  const [note, setNote] = useState('');
  const [shift, setShift] = useState('0.5');
  const before = useRef<Project | null>(null);
  const captions = project.captions;

  const begin = () => {
    if (!before.current) before.current = editor.project;
  };
  const commit = () => {
    if (before.current) editor.commit(editor.getProject(), before.current);
    before.current = null;
  };

  const importFile = async (file: File) => {
    try {
      const parsed = parseSubtitles(await file.text());
      if (!parsed.length) {
        setNote(`${file.name} has no captions Capstan can read (SRT or WebVTT).`);
        return;
      }
      editor.commit(setCaptions(editor.getProject(), parsed));
      setNote(`Imported ${parsed.length} captions from ${file.name}${captions.length ? `, replacing ${captions.length}. Undo brings them back` : ''}.`);
    } catch (e) {
      setNote(`Could not read ${file.name}: ${(e as Error).message}`);
    }
  };

  const save = (kind: 'srt' | 'vtt') => {
    const text = kind === 'srt' ? formatSrt(captions) : formatVtt(captions);
    download(new Blob([text], { type: kind === 'srt' ? 'application/x-subrip' : 'text/vtt' }), `${safeFileName(project.name)}.${kind}`);
    setNote(`Saved ${safeFileName(project.name)}.${kind} (${captions.length} captions).`);
  };

  const delta = Number(shift);
  const validShift = Number.isFinite(delta) && delta > 0;

  return (
    <section className="panel captions-panel" aria-label="Captions">
      <header className="panel-head">
        <h2>Captions</h2>
        <span className="count">{captions.length || ''}</span>
      </header>
      <div className="bin-actions">
        <button
          className="button primary"
          onClick={() => {
            const r = addCaptionAt(editor.getProject(), time);
            editor.commit(r.project);
            editor.setSelection([r.id]);
          }}
        >
          <Icon name="plus" size={16} />
          Add caption at playhead
        </button>
        <button
          className="button"
          disabled={!captions.some((c) => time > c.start + 0.05 && time < c.end - 0.05)}
          title="Cut the caption showing at the playhead in two"
          onClick={() => {
            const r = splitCaption(editor.getProject(), time);
            if (r.ids.length) {
              editor.commit(r.project);
              editor.setSelection([r.ids[0]]);
            }
          }}
        >
          <Icon name="split" size={16} />
          Split caption at playhead
        </button>
        <label className="button file-button">
          <Icon name="import" size={16} />
          Import SRT or VTT
          <input
            type="file"
            accept=".srt,.vtt,text/vtt,application/x-subrip"
            aria-label="Import captions from an SRT or WebVTT file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void importFile(f);
            }}
          />
        </label>
        <div className="caption-actions">
          <button className="button" data-action="capstan.caption.export-srt" disabled={!captions.length} aria-disabled={!captions.length} onClick={() => save('srt')}>
            Export .srt
          </button>
          <button className="button" data-action="capstan.caption.export-vtt" disabled={!captions.length} aria-disabled={!captions.length} onClick={() => save('vtt')}>
            Export .vtt
          </button>
          <button
            className="button"
            data-action="capstan.caption.clear"
            disabled={!captions.length}
            aria-disabled={!captions.length}
            onClick={() => {
              editor.commit(setCaptions(editor.getProject(), []));
              editor.setSelection([]);
              setNote('Captions removed.');
            }}
          >
            Remove all
          </button>
        </div>
        {captions.length > 0 && (
          <div className="caption-shift">
            <label htmlFor="caption-shift">Shift all by</label>
            <input id="caption-shift" type="number" min={0} step={0.1} value={shift} onChange={(e) => setShift(e.target.value)} />
            <span>s</span>
            <button className="button" data-action="capstan.caption.shift" disabled={!validShift} aria-disabled={!validShift} onClick={() => editor.commit(nudgeCaptions(editor.getProject(), -delta))}>
              Earlier
            </button>
            <button className="button" data-action="capstan.caption.shift" disabled={!validShift} aria-disabled={!validShift} onClick={() => editor.commit(nudgeCaptions(editor.getProject(), delta))}>
              Later
            </button>
          </div>
        )}
        {note && (
          <p className="hint caption-note" role="status">
            {note}
          </p>
        )}
      </div>
      <TranscribeSection editor={editor} />
      {captions.length === 0 ? (
        <p className="bin-empty">No captions yet. Add one at the playhead, import an SRT or WebVTT file, or transcribe speech from the sound on the timeline.</p>
      ) : (
        <ul className="caption-list">
          {captions.map((c, i) => {
            const live = time >= c.start && time < c.end;
            const selected = selection.includes(c.id);
            return (
              <li key={c.id} className={`caption-row${selected ? ' selected' : ''}${live ? ' live' : ''}`} aria-current={live ? 'true' : undefined}>
                <div className="caption-row-head">
                  <button
                    className="caption-jump"
                    title="Select this caption and go to its start"
                    onClick={() => {
                      editor.setSelection([c.id]);
                      onSeek(c.start);
                    }}
                  >
                    <span className="caption-num">{i + 1}</span>
                    {`${timecode(c.start, project.fps)} – ${timecode(c.end, project.fps)}`}
                  </button>
                  <button
                    className="icon-button small"
                    title={`Delete caption ${i + 1}`}
                    aria-label={`Delete caption ${i + 1}`}
                    onClick={() => {
                      editor.commit(removeCaption(editor.getProject(), c.id));
                      if (selected) editor.setSelection([]);
                    }}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
                <textarea
                  rows={2}
                  aria-label={`Caption ${i + 1} text`}
                  value={c.text}
                  onFocus={() => {
                    begin();
                    if (!selected) editor.setSelection([c.id]);
                  }}
                  onChange={(e) => {
                    begin();
                    editor.preview(updateCaptionText(editor.getProject(), c.id, e.target.value));
                  }}
                  onBlur={commit}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
