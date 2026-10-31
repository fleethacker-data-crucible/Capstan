// SnapShackle captures through the local host. The host (modules/Captures.ps1) lists and serves the
// files of the SnapShackle Captures folder, read-only; this module is the page's side: it checks
// what the host sends, searches and orders the list, and turns the chosen captures into Files with
// their OCR text. Pure logic with an injectable fetch, so it is tested without a browser.

export const HOST_CAPTURE_LIMIT = 500;
/** The host caps OCR text at 20 KB; the page does not trust that and caps characters again. */
export const HOST_OCR_MAX_CHARS = 20480;
/** Most captures imported in one go (each is read into memory, then stored in the browser). */
export const HOST_IMPORT_MAX = 100;

const NAME_RE = /^[A-Za-z0-9 _.()+-]{1,120}$/;
const TYPES: Record<string, { mime: string; kind: 'image' | 'video' }> = {
  png: { mime: 'image/png', kind: 'image' },
  jpg: { mime: 'image/jpeg', kind: 'image' },
  jpeg: { mime: 'image/jpeg', kind: 'image' },
  webp: { mime: 'image/webp', kind: 'image' },
  gif: { mime: 'image/gif', kind: 'image' },
  mp4: { mime: 'video/mp4', kind: 'video' },
  webm: { mime: 'video/webm', kind: 'video' },
};
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export interface HostCapture {
  name: string;
  size: number;
  /** ISO 8601, UTC. */
  modified: string;
  kind: 'image' | 'video';
  hasOcr: boolean;
  ocr: string;
}

export interface CaptureList {
  captures: HostCapture[];
  /** How many usable files the folder holds (more than `captures.length` when it is over the limit). */
  total: number;
}

/** The same name rule the host applies, so the page never asks for what the host would refuse. */
export function isCaptureName(name: unknown): name is string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return false;
  if (name.includes('..') || name.endsWith('.') || name.startsWith(' ') || name.endsWith(' ')) return false;
  const dot = name.lastIndexOf('.');
  if (dot < 1 || !TYPES[name.slice(dot + 1).toLowerCase()]) return false;
  if (name.slice(0, dot).trim() === '') return false;
  return !RESERVED.test(name.split('.')[0].replace(/ +$/, ''));
}

export function captureMime(name: string): string {
  return TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()]?.mime ?? 'application/octet-stream';
}

/** Relative URL of a capture on the host. The name is encoded as one path segment. */
export function captureUrl(name: string): string {
  return `/api/snapshackle/captures/${encodeURIComponent(name)}`;
}

/** Validates the host's list. Anything that does not fit is dropped, never trusted. */
export function parseCaptureList(raw: unknown): CaptureList {
  const o = (raw ?? {}) as { captures?: unknown; total?: unknown };
  const list = Array.isArray(o.captures) ? o.captures : [];
  const captures: HostCapture[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (captures.length >= HOST_CAPTURE_LIMIT) break;
    const c = item as Partial<HostCapture> | null;
    if (!c || !isCaptureName(c.name) || seen.has(c.name)) continue;
    const kind = TYPES[c.name.slice(c.name.lastIndexOf('.') + 1).toLowerCase()].kind;
    const time = Date.parse(String(c.modified));
    if (!Number.isFinite(time)) continue;
    const ocr = typeof c.ocr === 'string' ? c.ocr.slice(0, HOST_OCR_MAX_CHARS) : '';
    seen.add(c.name);
    captures.push({
      name: c.name,
      size: typeof c.size === 'number' && Number.isFinite(c.size) && c.size >= 0 ? c.size : 0,
      modified: new Date(time).toISOString(),
      kind,
      hasOcr: ocr.trim() !== '',
      ocr,
    });
  }
  // The host sends newest first; keep that even if a faulty host did not.
  captures.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified) || a.name.localeCompare(b.name));
  const total = typeof o.total === 'number' && Number.isFinite(o.total) ? Math.max(captures.length, Math.floor(o.total)) : captures.length;
  return { captures, total };
}

/** The first line with text in it, trimmed and shortened, for the list. */
export function firstOcrLine(ocr: string, max = 140): string {
  const line = ocr.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Every word of the query must appear in the name or the OCR text (case-insensitive). */
export function filterCaptures(captures: HostCapture[], query: string): HostCapture[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return captures;
  return captures.filter((c) => {
    const hay = `${c.name}\n${c.ocr}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** What the host or the network said, in words for the dialog. */
export class HostCaptureError extends Error {
  constructor(
    message: string,
    readonly code: 'no-folder' | 'host' | 'network',
  ) {
    super(message);
  }
}

type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
const HEADER = 'X-Capstan-Token';

/** Asks the host whether a SnapShackle captures folder exists. Any failure means "no". */
export async function hostHasSnapshackle(token: string, fetchFn: FetchLike = fetch): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetchFn('/api/health', { headers: { [HEADER]: token } });
    if (!res.ok) return false;
    return ((await res.json()) as { snapshackle?: unknown }).snapshackle === true;
  } catch {
    return false;
  }
}

export async function fetchCaptureList(token: string, fetchFn: FetchLike = fetch, signal?: AbortSignal): Promise<CaptureList> {
  let res: Response;
  try {
    res = await fetchFn('/api/snapshackle/captures', { headers: { [HEADER]: token }, signal });
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e;
    throw new HostCaptureError('Capstan could not reach its local host to list the captures.', 'network');
  }
  if (res.status === 404) throw new HostCaptureError('No SnapShackle Captures folder was found on this computer.', 'no-folder');
  if (!res.ok) throw new HostCaptureError(`The host could not list the captures (HTTP ${res.status}).`, 'host');
  try {
    return parseCaptureList(await res.json());
  } catch {
    throw new HostCaptureError('The host sent a list Capstan could not read.', 'host');
  }
}

/** Downloads one capture as a File with the right type. */
export async function fetchCaptureBlob(name: string, token: string, fetchFn: FetchLike = fetch, signal?: AbortSignal): Promise<Blob> {
  if (!isCaptureName(name)) throw new Error('the name is not one SnapShackle uses');
  let res: Response;
  try {
    res = await fetchFn(captureUrl(name), { headers: { [HEADER]: token }, signal });
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e;
    throw new Error('the host could not be reached');
  }
  if (res.status === 404) throw new Error('it is no longer in the folder');
  if (!res.ok) throw new Error(`the host refused it (HTTP ${res.status})`);
  const blob = await res.blob();
  if (blob.size === 0) throw new Error('the file is empty');
  return blob.type === captureMime(name) ? blob : new Blob([blob], { type: captureMime(name) });
}

export interface LoadedCaptures {
  /** Oldest first, so they land in the bin in the order they were taken. */
  files: File[];
  /** OCR text per file, only where there is some. */
  descriptions: Map<File, string>;
  failed: Array<{ name: string; reason: string }>;
}

/** Reads the chosen captures from the host. A file that cannot be read is reported, not fatal. */
export async function loadCaptureFiles(
  chosen: HostCapture[],
  token: string,
  fetchFn: FetchLike = fetch,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<LoadedCaptures> {
  const order = [...chosen].sort((a, b) => Date.parse(a.modified) - Date.parse(b.modified) || a.name.localeCompare(b.name));
  const out: LoadedCaptures = { files: [], descriptions: new Map(), failed: [] };
  let done = 0;
  for (const c of order) {
    onProgress?.(done, order.length, c.name);
    try {
      const blob = await fetchCaptureBlob(c.name, token, fetchFn, signal);
      const file = new File([blob], c.name, { type: blob.type, lastModified: Date.parse(c.modified) });
      out.files.push(file);
      if (c.hasOcr) out.descriptions.set(file, c.ocr.slice(0, HOST_OCR_MAX_CHARS));
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') throw e;
      out.failed.push({ name: c.name, reason: (e as Error).message });
    }
    done++;
  }
  return out;
}
