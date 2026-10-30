// A small seconds box that applies its value when you leave it or press Enter, so typing "1.5"
// is one edit (one undo step) rather than one per keystroke.
import { type ReactElement, useEffect, useState } from 'react';

export function SecondsInput({
  label,
  value,
  min = 0.05,
  max = 10,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange(v: number): void;
}): ReactElement {
  const [text, setText] = useState(String(Math.round(value * 100) / 100));
  useEffect(() => setText(String(Math.round(value * 100) / 100)), [value]);
  const apply = () => {
    const v = Number(text);
    if (!Number.isFinite(v) || text.trim() === '') {
      setText(String(Math.round(value * 100) / 100));
      return;
    }
    const clamped = Math.min(max, Math.max(min, v));
    setText(String(Math.round(clamped * 100) / 100));
    if (Math.abs(clamped - value) > 1e-9) onChange(clamped);
  };
  return (
    <span className="seconds-input">
      <input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={0.1}
        value={text}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => e.key === 'Enter' && apply()}
      />
      <span aria-hidden>s</span>
    </span>
  );
}
