import { type ReactElement, useState } from 'react';
import { type CursorFx, CURSOR_SHAPES, sidecarName } from '../../engine/cursor';
import { suggestZooms } from '../../engine/cursorfocus';
import { addZoomRegions, removeCursorData } from '../../engine/cursorops';
import type { ZoomRegion } from '../../engine/zoom';
import { Field } from '../inspector/Field';
import { attachCursorFile, readCursorImage, useFxEditing } from '../cursorUi';
import type { ToolboxProps } from '../toolboxTabs';

export const enabled = true;
export const tab = { id: 'cursor', label: 'Cursor' };

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }): ReactElement {
  return (
    <label className="check cfx-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function ColorField({ label, value, onPreview, onCommit }: { label: string; value: string; onPreview(v: string): void; onCommit(): void }): ReactElement {
  const id = `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="color" value={value} aria-label={label} onChange={(e) => onPreview(e.target.value)} onBlur={onCommit} />
    </div>
  );
}

const seconds = (s: number) => `${s.toFixed(1)}s`;

export function CursorPanel({ editor, onSeek }: ToolboxProps): ReactElement {
  const { project } = editor;
  const { fx, exists, set, preview, end } = useFxEditing(editor);
  const [error, setError] = useState('');
  const [suggestions, setSuggestions] = useState<ZoomRegion[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const videos = project.media.filter((m) => m.kind === 'video');
  const pct = (key: keyof CursorFx, min: number, max: number, label: string, unit = '%', scale = 100) => (
    <Field
      label={label}
      value={(fx[key] as number) * scale}
      min={min}
      max={max}
      step={1}
      unit={unit}
      onPreview={(v) => preview({ [key]: v / scale } as Partial<CursorFx>)}
      onCommit={end}
    />
  );

  const suggest = () => {
    const found = suggestZooms(editor.getProject());
    setSuggestions(found);
    setPicked(new Set(found.map((z) => z.id)));
  };
  const addPicked = () => {
    const chosen = (suggestions ?? []).filter((z) => picked.has(z.id));
    if (chosen.length) editor.commit(addZoomRegions(editor.getProject(), chosen));
    setSuggestions(null);
  };

  return (
    <section className="panel cursor-panel" aria-label="Cursor effects">
      <header className="panel-head">
        <h2>Cursor</h2>
      </header>
      <div className="cfx-body">
        <p className="hint">
          A browser cannot read your mouse or keyboard while it records another app, so the Capstan host does it when you turn on "Capture cursor and keys for effects" in the Record dialog. Data can also come from a <code>.cursor.json</code> file (format in docs/cursor-data.md). Attach one, then turn on the effects you want.
        </p>

        <h3 className="cfx-h">Cursor data</h3>
        {videos.length === 0 ? (
          <p className="hint">Import or record a video first.</p>
        ) : (
          <ul className="cfx-media">
            {videos.map((m) => (
              <li key={m.id} className="cfx-media-item">
                <span className="cfx-media-name" title={m.name}>
                  {m.name}
                </span>
                <span className="cfx-media-sub" data-testid="cursor-summary">
                  {m.cursor ? `${m.cursor.samples.length} positions, ${m.cursor.clicks.filter((c) => c.down).length} clicks, ${m.cursor.keys.filter((k) => k.down).length} keys` : `No cursor data (${sidecarName(m.name)})`}
                </span>
                <div className="cfx-row">
                  <label className="button file-button">
                    {m.cursor ? 'Replace data' : 'Attach cursor data'}
                    <input
                      type="file"
                      accept=".json,application/json"
                      aria-label={`Attach cursor data to ${m.name}`}
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (f) setError((await attachCursorFile(editor, m.id, f)) ?? '');
                      }}
                    />
                  </label>
                  {m.cursor && (
                    <button className="button" onClick={() => editor.commit(removeCursorData(editor.getProject(), m.id))}>
                      Remove data
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="error cfx-error" role="alert">
            {error}
          </p>
        )}

        <h3 className="cfx-h">Effects</h3>
        <div className="fields">
          <Toggle label="Cursor effects on" checked={exists && fx.enabled} onChange={(v) => set({ enabled: v })} />
        </div>

        <h3 className="cfx-h">Cursor</h3>
        <div className="fields">
          <Toggle label="Draw the cursor" checked={fx.showCursor} onChange={(v) => set({ showCursor: v })} />
          <p className="hint cfx-hint">Off hides the drawn cursor. A cursor already in the recording cannot be removed.</p>
          <div className="field wide">
            <label htmlFor="cursor-shape">Shape</label>
            <select id="cursor-shape" value={fx.shape} onChange={(e) => set({ shape: e.target.value as CursorFx['shape'] })}>
              {CURSOR_SHAPES.map((s) => (
                <option key={s} value={s}>
                  {s === 'arrow' ? 'Arrow' : s === 'hand' ? 'Hand' : 'Pointer dot'}
                </option>
              ))}
            </select>
          </div>
          <Field label="Cursor size" value={fx.size * 100} min={50} max={400} step={5} unit="%" onPreview={(v) => preview({ size: v / 100 })} onCommit={end} />
          <ColorField label="Cursor colour" value={fx.color} onPreview={(v) => preview({ color: v })} onCommit={end} />
          {pct('smoothing', 0, 100, 'Smoothing')}
          <div className="cfx-row">
            <label className="button file-button">
              Replace cursor image
              <input
                type="file"
                accept="image/png,image/svg+xml,image/webp,image/jpeg"
                aria-label="Replace cursor image"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  const r = await readCursorImage(f);
                  if ('error' in r) setError(r.error);
                  else {
                    setError('');
                    set({ image: r.url, showCursor: true });
                  }
                }}
              />
            </label>
            {fx.image && (
              <button className="button" onClick={() => set({ image: undefined })}>
                Use built-in shapes
              </button>
            )}
          </div>
          {fx.image && (
            <>
              {pct('imageHotX', 0, 100, 'Click point across')}
              {pct('imageHotY', 0, 100, 'Click point down')}
            </>
          )}
        </div>

        <h3 className="cfx-h">Highlight, magnify, spotlight</h3>
        <div className="fields">
          <Toggle label="Highlight halo" checked={fx.highlight} onChange={(v) => set({ highlight: v })} />
          {fx.highlight && (
            <>
              {pct('highlightSize', 2, 25, 'Halo size')}
              {pct('highlightOpacity', 5, 100, 'Halo strength')}
              <ColorField label="Halo colour" value={fx.highlightColor} onPreview={(v) => preview({ highlightColor: v })} onCommit={end} />
            </>
          )}
          <Toggle label="Magnify under the cursor" checked={fx.magnify} onChange={(v) => set({ magnify: v })} />
          {fx.magnify && (
            <>
              <Field label="Loupe zoom" value={fx.magnifyZoom} min={1.25} max={6} step={0.25} unit="x" onPreview={(v) => preview({ magnifyZoom: v })} onCommit={end} />
              {pct('magnifySize', 5, 30, 'Loupe size')}
            </>
          )}
          <Toggle label="Spotlight" checked={fx.spotlight} onChange={(v) => set({ spotlight: v })} />
          {fx.spotlight && (
            <>
              {pct('spotlightSize', 5, 60, 'Spotlight size')}
              {pct('spotlightDim', 0, 95, 'Spotlight dimming')}
            </>
          )}
        </div>

        <h3 className="cfx-h">Clicks</h3>
        <div className="fields">
          <Toggle label="Click rings" checked={fx.clickRings} onChange={(v) => set({ clickRings: v })} />
          {fx.clickRings && (
            <>
              {pct('clickSize', 2, 20, 'Ring size')}
              <Field label="Ring duration" value={fx.clickDuration} min={0.2} max={2} step={0.1} unit="s" onPreview={(v) => preview({ clickDuration: v })} onCommit={end} />
              <ColorField label="Ring colour" value={fx.clickColor} onPreview={(v) => preview({ clickColor: v })} onCommit={end} />
            </>
          )}
          <Toggle label="Click sounds" checked={fx.clickSound} onChange={(v) => set({ clickSound: v })} />
          {fx.clickSound && pct('clickVolume', 0, 100, 'Click volume')}
        </div>

        <h3 className="cfx-h">Keystrokes</h3>
        <div className="fields">
          <Toggle label="Keystroke callouts" checked={fx.keys} onChange={(v) => set({ keys: v })} />
          {fx.keys && (
            <>
              <Field label="Hold time" value={fx.keysHold} min={0.3} max={6} step={0.1} unit="s" onPreview={(v) => preview({ keysHold: v })} onCommit={end} />
              <Field label="Bubble size" value={fx.keysSize * 100} min={50} max={200} step={5} unit="%" onPreview={(v) => preview({ keysSize: v / 100 })} onCommit={end} />
            </>
          )}
        </div>

        <h3 className="cfx-h">Smart focus</h3>
        <div className="fields">
          <p className="hint cfx-hint">Finds click clusters and pauses in the cursor data and suggests zoom regions. Nothing is added until you accept.</p>
          <div className="cfx-row">
            <button className="button" onClick={suggest} disabled={!project.media.some((m) => m.cursor)}>
              Suggest zooms
            </button>
            <span className="cfx-count" data-testid="zoom-count">
              {project.zooms.length} zoom region{project.zooms.length === 1 ? '' : 's'} in the project
            </span>
          </div>
          {suggestions && suggestions.length === 0 && <p className="hint cfx-hint">No clear click clusters or pauses found, or the places already have a zoom.</p>}
          {suggestions && suggestions.length > 0 && (
            <>
              <ul className="cfx-suggestions" aria-label="Suggested zoom regions">
                {suggestions.map((z) => (
                  <li key={z.id}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={picked.has(z.id)}
                        onChange={(e) => {
                          const next = new Set(picked);
                          if (e.target.checked) next.add(z.id);
                          else next.delete(z.id);
                          setPicked(next);
                        }}
                      />
                      <span>
                        {seconds(z.start)} to {seconds(z.start + z.duration)}, {(project.width / z.width).toFixed(1)}x
                      </span>
                    </label>
                    <button className="button" onClick={() => onSeek(z.start)}>
                      Go
                    </button>
                  </li>
                ))}
              </ul>
              <div className="cfx-row">
                <button className="button primary" onClick={addPicked} disabled={picked.size === 0}>
                  Add {picked.size} zoom{picked.size === 1 ? '' : 's'}
                </button>
                <button className="button" onClick={() => setSuggestions(null)}>
                  Dismiss
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
