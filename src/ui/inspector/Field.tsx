// Shared inspector control.
import type { ReactElement } from 'react';

/**
 * A slider + number pair. Dragging previews the change; letting go records one undo step.
 */
export function Field({
  label,
  value,
  min,
  max,
  step,
  unit,
  onPreview,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onPreview(v: number): void;
  onCommit(): void;
}): ReactElement {
  const id = `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        aria-label={label}
        onChange={(e) => onPreview(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
      <div className="number">
        <input
          id={id}
          type="number"
          step={step}
          value={Number.isInteger(step) ? Math.round(value) : Math.round(value * 100) / 100}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onPreview(v);
          }}
          onBlur={onCommit}
          onKeyDown={(e) => e.key === 'Enter' && onCommit()}
        />
        {unit && <span>{unit}</span>}
      </div>
    </div>
  );
}

