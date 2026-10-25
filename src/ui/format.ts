/** 0:00:00.00 style timecode, or h:mm:ss;ff with frames when fps is given. */
export function timecode(seconds: number, fps?: number): string {
  // Round to the nearest frame (or centisecond) first, so 5.9999999 s reads as 6 s.
  const unit = fps ?? 100;
  const s = Math.max(0, Math.round(seconds * unit) / unit);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (fps) {
    const f = Math.round((s - Math.floor(s)) * fps) % fps;
    return `${h}:${pad(m)}:${pad(sec)};${pad(f)}`;
  }
  const cs = Math.round((s - Math.floor(s)) * 100) % 100;
  return `${h ? `${h}:` : ''}${h ? pad(m) : m}:${pad(sec)}.${pad(cs)}`;
}

export function shortDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 100) || 'OpenTape export';
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
