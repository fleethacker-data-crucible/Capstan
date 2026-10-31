import { type ReactElement, useRef } from 'react';
import {
  BLEND_MODES,
  type BlendMode,
  type BorderFx,
  type ChromaFx,
  type ClipEffects,
  type ColourFx,
  DEFAULT_BORDER,
  DEFAULT_CHROMA,
  DEFAULT_COLOUR,
  DEFAULT_FRAME,
  DEFAULT_SHADOW,
  FRAME_KINDS,
  type FrameFx,
  type MaskShape,
  type ShadowFx,
} from '../../engine/fx';
import { effectsBackend } from '../../engine/fx-gl';
import { updateClipEffects } from '../../engine/fx-ops';
import { findMedia, type Project } from '../../engine/project';
import { Field } from './Field';
import type { ClipSectionProps } from './types';

/** A checkbox that switches one effect on or off without losing its settings. */
function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange(on: boolean): void }): ReactElement {
  return (
    <label className="fx-toggle">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function ColourInput({ label, value, onPreview, onCommit, begin }: { label: string; value: string; onPreview(v: string): void; onCommit(): void; begin(): void }): ReactElement {
  const id = `fx-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="field fx-colour">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="color"
        value={value}
        onFocus={begin}
        onChange={(e) => {
          begin();
          onPreview(e.target.value);
        }}
        onBlur={onCommit}
      />
    </div>
  );
}

// Effects area: colour, chroma key, shadow, border, rounded corners, blend mode and device frame for the selected clip.
export function EffectsSection({ editor, clip, locked }: ClipSectionProps): ReactElement | null {
  const before = useRef<Project | null>(null);
  const media = findMedia(editor.project, clip.mediaId);
  if (media?.kind === 'audio') return null;

  const fx: ClipEffects = clip.effects ?? {};
  const colour: ColourFx = fx.colour ?? { ...DEFAULT_COLOUR, on: false };
  const chroma: ChromaFx = fx.chroma ?? { ...DEFAULT_CHROMA, on: false };
  const shadow: ShadowFx = fx.shadow ?? { ...DEFAULT_SHADOW, on: false };
  const border: BorderFx = fx.border ?? { ...DEFAULT_BORDER, on: false };
  const frame: FrameFx = fx.frame ?? { ...DEFAULT_FRAME, on: false };
  const blend: BlendMode = fx.blend ?? 'normal';
  const framed = frame.on;

  const begin = () => {
    if (!before.current) before.current = editor.project;
  };
  const commit = () => {
    if (before.current) editor.commit(editor.project, before.current);
    before.current = null;
  };
  /** Previews a change to this clip's effects; letting go of the control records one undo step. */
  const preview = (change: (e: ClipEffects) => ClipEffects) => {
    begin();
    editor.preview(updateClipEffects(editor.project, [clip.id], (cur) => change(cur ?? {})));
  };
  /** A one-shot change (a checkbox, a menu) records straight away. */
  const apply = (change: (e: ClipEffects) => ClipEffects) => {
    editor.commit(updateClipEffects(editor.project, [clip.id], (cur) => change(cur ?? {})));
  };

  const setColour = (patch: Partial<ColourFx>) => preview((e) => ({ ...e, colour: { ...colour, on: true, ...patch } }));
  const setChroma = (patch: Partial<ChromaFx>) => preview((e) => ({ ...e, chroma: { ...chroma, on: true, ...patch } }));
  const setShadow = (patch: Partial<ShadowFx>) => preview((e) => ({ ...e, shadow: { ...shadow, on: true, ...patch } }));
  const setBorder = (patch: Partial<BorderFx>) => preview((e) => ({ ...e, border: { ...border, on: true, ...patch } }));
  const setRadius = (radius: number) => preview((e) => ({ ...e, radius }));

  return (
    <section className="inspector-section fx-section" aria-labelledby="fx-heading">
      <h3 id="fx-heading">Effects</h3>
      <p className="hint">{`Colour and green screen run on the graphics card (${effectsBackend() === 'webgl2' ? 'WebGL2' : 'not available here, so the processor is used'}).`}</p>
      <fieldset className="fields fx-fields" disabled={locked}>
        <div className="fx-group">
          <Toggle label="Colour adjustment" on={colour.on} onChange={(on) => apply((e) => ({ ...e, colour: { ...colour, on } }))} />
          {colour.on && (
            <>
              <Field label="Brightness" value={colour.brightness} min={-100} max={100} step={1} onPreview={(v) => setColour({ brightness: v })} onCommit={commit} />
              <Field label="Contrast" value={colour.contrast} min={-100} max={100} step={1} onPreview={(v) => setColour({ contrast: v })} onCommit={commit} />
              <Field label="Saturation" value={colour.saturation} min={-100} max={100} step={1} onPreview={(v) => setColour({ saturation: v })} onCommit={commit} />
              <Field label="Hue" value={colour.hue} min={-180} max={180} step={1} unit="°" onPreview={(v) => setColour({ hue: v })} onCommit={commit} />
              <ColourInput label="Tint colour" value={colour.tint} begin={begin} onPreview={(v) => setColour({ tint: v })} onCommit={commit} />
              <Field label="Tint amount" value={colour.tintAmount} min={0} max={100} step={1} unit="%" onPreview={(v) => setColour({ tintAmount: v })} onCommit={commit} />
            </>
          )}
        </div>

        <div className="fx-group">
          <Toggle label="Remove a colour (green screen)" on={chroma.on} onChange={(on) => apply((e) => ({ ...e, chroma: { ...chroma, on } }))} />
          {chroma.on && (
            <>
              <ColourInput label="Key colour" value={chroma.key} begin={begin} onPreview={(v) => setChroma({ key: v })} onCommit={commit} />
              <Field label="Key tolerance" value={chroma.tolerance} min={0} max={100} step={1} unit="%" onPreview={(v) => setChroma({ tolerance: v })} onCommit={commit} />
              <Field label="Edge softness" value={chroma.softness} min={0} max={100} step={1} unit="%" onPreview={(v) => setChroma({ softness: v })} onCommit={commit} />
              <Field label="Spill suppression" value={chroma.spill} min={0} max={100} step={1} unit="%" onPreview={(v) => setChroma({ spill: v })} onCommit={commit} />
            </>
          )}
        </div>

        <div className="fx-group">
          <Toggle label="Drop shadow" on={shadow.on} onChange={(on) => apply((e) => ({ ...e, shadow: { ...shadow, on } }))} />
          {shadow.on && (
            <>
              <Field label="Shadow blur" value={shadow.blur} min={0} max={200} step={1} unit="px" onPreview={(v) => setShadow({ blur: v })} onCommit={commit} />
              <Field label="Shadow X" value={shadow.dx} min={-200} max={200} step={1} unit="px" onPreview={(v) => setShadow({ dx: v })} onCommit={commit} />
              <Field label="Shadow Y" value={shadow.dy} min={-200} max={200} step={1} unit="px" onPreview={(v) => setShadow({ dy: v })} onCommit={commit} />
              <Field label="Shadow opacity" value={shadow.opacity} min={0} max={100} step={1} unit="%" onPreview={(v) => setShadow({ opacity: v })} onCommit={commit} />
              <ColourInput label="Shadow colour" value={shadow.colour} begin={begin} onPreview={(v) => setShadow({ colour: v })} onCommit={commit} />
            </>
          )}
        </div>

        <div className="fx-group">
          <Toggle label="Border" on={border.on && !framed} onChange={(on) => apply((e) => ({ ...e, border: { ...border, on } }))} />
          {border.on && !framed && (
            <>
              <Field label="Border width" value={border.width} min={0} max={100} step={1} unit="px" onPreview={(v) => setBorder({ width: v })} onCommit={commit} />
              <ColourInput label="Border colour" value={border.colour} begin={begin} onPreview={(v) => setBorder({ colour: v })} onCommit={commit} />
            </>
          )}
        </div>

        <div className="fx-group">
          <Field label="Corner radius" value={framed ? 0 : (fx.radius ?? 0)} min={0} max={300} step={1} unit="px" onPreview={setRadius} onCommit={commit} />
          <div className="field wide">
            <label htmlFor="fx-mask">Mask shape</label>
            <select id="fx-mask" value={fx.mask ?? 'none'} onChange={(e) => apply((cur) => ({ ...cur, mask: e.target.value === 'none' ? undefined : (e.target.value as MaskShape) }))}>
              <option value="none">Rectangle (use the corner radius)</option>
              <option value="circle">Circle</option>
              <option value="ellipse">Ellipse</option>
            </select>
          </div>
          {framed && <p className="hint fx-note">A device frame sets its own corners, so radius, mask and border are not used.</p>}
        </div>

        <div className="fx-group">
          <div className="field wide">
            <label htmlFor="fx-blend">Blend mode</label>
            <select id="fx-blend" value={blend} onChange={(e) => apply((cur) => ({ ...cur, blend: e.target.value as BlendMode }))}>
              {BLEND_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="fx-group">
          <div className="field wide">
            <label htmlFor="fx-frame">Device frame</label>
            <select
              id="fx-frame"
              value={frame.on ? frame.kind : 'none'}
              onChange={(e) =>
                apply((cur) => {
                  if (e.target.value === 'none') return { ...cur, frame: { ...frame, on: false } };
                  return { ...cur, frame: { ...frame, on: true, kind: e.target.value as FrameFx['kind'] } };
                })
              }
            >
              <option value="none">None</option>
              {FRAME_KINDS.map((f) => (
                <option key={f.kind} value={f.kind}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          {frame.on && (
            <div className="field wide">
              <label htmlFor="fx-frame-tone">Frame colour</label>
              <select id="fx-frame-tone" value={frame.tone} onChange={(e) => apply((cur) => ({ ...cur, frame: { ...frame, tone: e.target.value === 'light' ? 'light' : 'dark' } }))}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>
          )}
        </div>
      </fieldset>
      <button className="button" disabled={locked || !clip.effects} onClick={() => apply(() => ({}))}>
        Reset effects
      </button>
    </section>
  );
}
