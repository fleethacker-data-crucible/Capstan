// The "Select region" step: a still frame of the shared screen with a rectangle to drag and
// resize, aspect presets and numeric fields. Everything is measured in source pixels.
import { useRef, useState } from 'react';
import { ASPECT_PRESETS, type Bounds, type Handle, type Rect, aspectRatio, clampRect, fitAspect, fullRect, moveRect, resizeRect, setRectField } from '../engine/region';

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const FIELDS: Array<[keyof Rect, string]> = [
  ['x', 'Left'],
  ['y', 'Top'],
  ['width', 'Width'],
  ['height', 'Height'],
];

interface Drag {
  mode: 'move' | Handle;
  startX: number;
  startY: number;
  rect: Rect;
}

export function RegionPicker({
  still,
  bounds,
  canvas,
  rect,
  onChange,
}: {
  still: string;
  bounds: Bounds;
  /** The project canvas, for the "Project canvas" shape. */
  canvas: Bounds;
  rect: Rect;
  onChange(rect: Rect): void;
}) {
  const [shape, setShape] = useState('free');
  const [draft, setDraft] = useState<Partial<Record<keyof Rect, string>>>({});
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const ratio = aspectRatio(shape, canvas);

  // Pointer movement in source pixels, whatever size the picture is shown at.
  const toSource = (e: React.PointerEvent) => {
    const box = stage.current!.getBoundingClientRect();
    return { x: ((e.clientX - box.left) / box.width) * bounds.width, y: ((e.clientY - box.top) / box.height) * bounds.height };
  };

  const begin = (e: React.PointerEvent, mode: Drag['mode'], from: Rect = rect) => {
    e.preventDefault();
    e.stopPropagation();
    // preventDefault keeps focus where it was; leave a number field so it shows the new value.
    (document.activeElement as HTMLElement | null)?.blur?.();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toSource(e);
    drag.current = { mode, startX: p.x, startY: p.y, rect: from };
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toSource(e);
    const dx = p.x - d.startX;
    const dy = p.y - d.startY;
    onChange(d.mode === 'move' ? moveRect(d.rect, dx, dy, bounds) : resizeRect(d.rect, d.mode, dx, dy, bounds, ratio));
  };
  const endDrag = () => {
    drag.current = null;
  };

  // Dragging on the picture outside the rectangle draws a new one from that corner.
  const startNew = (e: React.PointerEvent) => {
    const p = toSource(e);
    const seed = clampRect({ x: p.x, y: p.y, width: 16, height: 16 }, bounds);
    onChange(seed);
    begin(e, 'se', seed);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 1 : 10;
    const move: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const m = move[e.key];
    if (!m) return;
    e.preventDefault();
    onChange(e.altKey ? resizeRect(rect, 'se', m[0], m[1], bounds, ratio) : moveRect(rect, m[0], m[1], bounds));
  };

  const pct = (n: number, of: number) => `${(n / of) * 100}%`;

  return (
    <div className="region-picker">
      <div ref={stage} className="region-stage" onPointerDown={startNew} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <img src={still} alt="Frame from the shared screen" draggable={false} />
        <div
          className="region-rect"
          role="group"
          tabIndex={0}
          aria-label={`Region: ${rect.width} by ${rect.height} pixels at ${rect.x}, ${rect.y}. Arrow keys move it, Alt with arrows resizes, Shift for fine steps.`}
          style={{ left: pct(rect.x, bounds.width), top: pct(rect.y, bounds.height), width: pct(rect.width, bounds.width), height: pct(rect.height, bounds.height) }}
          onPointerDown={(e) => begin(e, 'move')}
          onKeyDown={onKey}
        >
          {HANDLES.map((h) => (
            <span key={h} className={`region-handle ${h}`} data-handle={h} aria-hidden onPointerDown={(e) => begin(e, h)} />
          ))}
        </div>
      </div>
      <div className="region-controls">
        <div className="field wide">
          <label htmlFor="region-shape">Shape</label>
          <select
            id="region-shape"
            value={shape}
            onChange={(e) => {
              setShape(e.target.value);
              onChange(fitAspect(rect, aspectRatio(e.target.value, canvas), bounds));
            }}
          >
            {ASPECT_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {FIELDS.map(([key, label]) => (
          <div key={key} className="field wide">
            <label htmlFor={`region-${key}`}>{label} (px)</label>
            <input
              id={`region-${key}`}
              type="number"
              inputMode="numeric"
              min={key === 'x' || key === 'y' ? 0 : 16}
              max={key === 'x' || key === 'width' ? bounds.width : bounds.height}
              value={draft[key] ?? String(rect[key])}
              onChange={(e) => {
                setDraft({ ...draft, [key]: e.target.value });
                if (e.target.value !== '') onChange(setRectField(rect, key, Number(e.target.value), bounds, ratio));
              }}
              onBlur={() => setDraft({})}
            />
          </div>
        ))}
        <button
          type="button"
          className="button"
          onClick={() => {
            setShape('free');
            onChange(fullRect(bounds));
          }}
        >
          Whole screen
        </button>
      </div>
      <p className="hint region-hint">
        Source is {bounds.width}×{bounds.height}. The whole screen is recorded; the region is applied as a crop you can change later in the editor.
      </p>
    </div>
  );
}
