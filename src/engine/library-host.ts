// Client for the media library the PowerShell host keeps on disk (modules/Library.ps1,
// %LOCALAPPDATA%\Capstan\library). Chunked, resumable upload; ranged download into a Blob; list; delete.
// Same-origin only: every call goes to the host that served this page, with its session token.
// Nothing here holds a whole big file in memory except the Blob the browser already has.

export const HOST_CHUNK_BYTES = 8 * 1024 * 1024;
/** Whole-file SHA-256 needs the bytes in memory (Web Crypto cannot stream), so only smaller files carry one. */
export const HASH_LIMIT_BYTES = 64 * 1024 * 1024;
const TOKEN_HEADER = 'X-Capstan-Token';
const ID_PATTERN = /^[a-z0-9_-]{1,80}$/;
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', 'conin', 'conout', 'clock', ...Array.from({ length: 10 }, (_, i) => `com${i}`), ...Array.from({ length: 10 }, (_, i) => `lpt${i}`)]);

/** True when the host would accept this id as a file name. Ids that fail stay in the browser only. */
export function isLibraryId(id: string): boolean {
  return ID_PATTERN.test(id) && !RESERVED.has(id);
}

export interface HostFileInfo {
  id: string;
  size: number;
  modified: string;
}

export interface TransferOptions {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface UploadOptions extends TransferOptions {
  /** Hex SHA-256 of the file; computed here for files up to HASH_LIMIT_BYTES when not given. */
  sha256?: string;
}

/** What the page needs from the host library. HostLibrary implements it; tests use a fake. */
export interface HostLibraryLike {
  probe(): Promise<{ library: boolean; maxBytes: number }>;
  list(): Promise<HostFileInfo[]>;
  upload(id: string, blob: Blob, options?: UploadOptions): Promise<void>;
  download(id: string, options?: TransferOptions): Promise<Blob | null>;
  remove(id: string): Promise<boolean>;
}

export class HostLibraryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'HostLibraryError';
  }
}

export interface HostLibraryConfig {
  fetch?: typeof fetch;
  /** The per-launch session token (empty: the page was not served by the host). */
  token: () => string;
  /** Tries per chunk or request for network errors and 5xx answers. Default 3. */
  attempts?: number;
  /** Pause before a retry, doubled each time. Default 400 ms. */
  retryDelayMs?: number;
}

function abortError(): Error {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}
export const isAbortError = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';

/** Best guess at a media type from the first bytes: the host stores bytes only, and a Blob needs a type to play. */
export function sniffMime(head: Uint8Array): string {
  const b = head;
  const ascii = (from: number, text: string) => text.length + from <= b.length && [...text].every((c, i) => b[from + i] === c.charCodeAt(0));
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (ascii(4, 'ftyp')) return 'video/mp4';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'audio/wav';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 'PNG')) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 'GIF8')) return 'image/gif';
  if (ascii(0, 'OggS')) return 'audio/ogg';
  if (ascii(0, 'fLaC')) return 'audio/flac';
  if (ascii(0, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return '';
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true },
    );
  });

export class HostLibrary implements HostLibraryLike {
  private readonly doFetch: typeof fetch;
  private readonly attempts: number;
  private readonly retryDelay: number;

  constructor(private readonly config: HostLibraryConfig) {
    this.doFetch = config.fetch ?? ((...args) => globalThis.fetch(...args));
    this.attempts = Math.max(1, config.attempts ?? 3);
    this.retryDelay = config.retryDelayMs ?? 400;
  }

  private async send(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set(TOKEN_HEADER, this.config.token());
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(init.json);
    }
    return this.doFetch(path, { method: init.method ?? 'GET', headers, body, signal: init.signal, cache: 'no-store' });
  }

  /** send() with retries for network errors and 5xx. Other answers (including 4xx) come back as they are. */
  private async sendRetrying(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
    let last: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      if (init.signal?.aborted) throw abortError();
      try {
        const res = await this.send(path, init);
        if (res.status < 500 || attempt === this.attempts) return res;
        last = new HostLibraryError('The host failed to handle the request', res.status, 'server');
      } catch (e) {
        if (isAbortError(e)) throw e;
        last = e;
        if (attempt === this.attempts) break;
      }
      await sleep(this.retryDelay * 2 ** (attempt - 1), init.signal ?? undefined);
    }
    throw last instanceof Error ? last : new Error('The host did not answer');
  }

  private async fail(res: Response, what: string): Promise<never> {
    let code = 'http';
    let text = '';
    try {
      const j = (await res.json()) as { error?: string; code?: string };
      text = j.error ?? '';
      code = j.code ?? code;
    } catch {
      /* not JSON */
    }
    throw new HostLibraryError(`${what}: ${text || `HTTP ${res.status}`}`, res.status, code);
  }

  async probe(): Promise<{ library: boolean; maxBytes: number }> {
    if (!this.config.token()) return { library: false, maxBytes: 0 };
    const res = await this.send('/api/health');
    if (!res.ok) return { library: false, maxBytes: 0 };
    const j = (await res.json()) as { library?: unknown; libraryMaxBytes?: unknown };
    return { library: j.library === true, maxBytes: typeof j.libraryMaxBytes === 'number' ? j.libraryMaxBytes : 0 };
  }

  async list(): Promise<HostFileInfo[]> {
    const res = await this.sendRetrying('/api/files');
    if (!res.ok) await this.fail(res, 'Could not list the library');
    const j = (await res.json()) as { files?: unknown };
    if (!Array.isArray(j.files)) return [];
    return j.files.filter((f): f is HostFileInfo => !!f && typeof f.id === 'string' && typeof f.size === 'number' && typeof f.modified === 'string');
  }

  /**
   * Stores `blob` under `id`. Resumable: if an upload of this id and size is already under way on the host
   * (a failed or reloaded attempt), only the missing chunks are sent. On a failure the partial upload is
   * kept on the host for a retry; on cancel it is removed.
   */
  async upload(id: string, blob: Blob, options: UploadOptions = {}): Promise<void> {
    if (!isLibraryId(id)) throw new HostLibraryError('This id cannot be stored in the library', 400, 'bad_id');
    if (blob.size < 1) throw new HostLibraryError('An empty file is not stored in the library', 400, 'bad_size');
    const { signal, onProgress } = options;
    const size = blob.size;
    const sha256 = options.sha256 ?? (size <= HASH_LIMIT_BYTES ? await sha256Hex(blob) : undefined);
    try {
      let init = await this.startUpload(id, size, sha256, signal);
      for (let round = 0; round < 2; round++) {
        const have = new Set(init.received);
        let done = 0;
        for (const part of have) done += Math.min(size, (part + 1) * init.chunkSize) - part * init.chunkSize;
        onProgress?.(Math.min(done, size), size);
        for (let part = 0; part < init.parts; part++) {
          if (have.has(part)) continue;
          if (signal?.aborted) throw abortError();
          const start = part * init.chunkSize;
          const end = Math.min(size, start + init.chunkSize);
          await this.putPart(id, part, blob.slice(start, end), signal);
          done += end - start;
          onProgress?.(Math.min(done, size), size);
        }
        const res = await this.sendRetrying(`/api/files/${id}/complete`, { method: 'POST', json: {}, signal });
        if (res.ok) return;
        if (res.status === 409 && round === 0) {
          // Something the host holds went missing (its temp file was swept): start over once.
          const body = (await res.json().catch(() => ({}))) as { code?: string };
          if (body.code === 'incomplete' || body.code === 'size_mismatch') {
            init = await this.startUpload(id, size, sha256, signal);
            continue;
          }
        }
        await this.fail(res, 'Could not finish storing the file');
      }
    } catch (e) {
      if (isAbortError(e) || signal?.aborted) {
        await this.abortUpload(id);
        throw abortError();
      }
      throw e;
    }
  }

  private async startUpload(id: string, size: number, sha256: string | undefined, signal?: AbortSignal) {
    const body: Record<string, unknown> = { id, size };
    if (sha256) body.sha256 = sha256;
    let res = await this.sendRetrying('/api/files', { method: 'POST', json: body, signal });
    if (res.status === 409) {
      // A leftover upload of the same id with other settings: drop it and start clean.
      await this.abortUpload(id);
      res = await this.sendRetrying('/api/files', { method: 'POST', json: body, signal });
    }
    if (!res.ok) await this.fail(res, 'The host did not accept the upload');
    const j = (await res.json()) as { chunkSize?: unknown; parts?: unknown; received?: unknown };
    const chunkSize = Number(j.chunkSize);
    const parts = Number(j.parts);
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > HOST_CHUNK_BYTES || !Number.isInteger(parts) || parts < 1 || parts !== Math.ceil(size / chunkSize)) {
      throw new HostLibraryError('The host answered the upload request with unusable values', 502, 'bad_handle');
    }
    const received = Array.isArray(j.received) ? j.received.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < parts) : [];
    return { chunkSize, parts, received };
  }

  private async putPart(id: string, part: number, chunk: Blob, signal?: AbortSignal): Promise<void> {
    for (let pass = 0; pass < 2; pass++) {
      const res = await this.sendRetrying(`/api/files/${id}?part=${part}`, { method: 'PUT', body: chunk, headers: { 'Content-Type': 'application/octet-stream' }, signal });
      if (res.ok) return;
      // The host saw a cut-off body: the part did not count; send it once more.
      const body = res.status === 400 ? ((await res.clone().json().catch(() => ({}))) as { code?: string }) : {};
      if (body.code !== 'upload_interrupted' || pass === 1) await this.fail(res, 'A chunk was not accepted');
    }
  }

  /** Drops an upload that is under way (not a stored file). Best effort. */
  async abortUpload(id: string): Promise<void> {
    if (!isLibraryId(id)) return;
    try {
      await this.send(`/api/files/${id}?upload=1`, { method: 'DELETE' });
    } catch {
      /* the host is gone; its temp files are swept at the next start */
    }
  }

  /** Reads a stored file in ranged requests of 8 MB. Null when the host does not have it. */
  async download(id: string, options: TransferOptions = {}): Promise<Blob | null> {
    if (!isLibraryId(id)) return null;
    const { signal, onProgress } = options;
    const parts: Blob[] = [];
    let total = -1;
    let next = 0;
    let type = '';
    while (total < 0 || next < total) {
      if (signal?.aborted) throw abortError();
      const res = await this.sendRetrying(`/api/files/${id}`, { headers: { Range: `bytes=${next}-${next + HOST_CHUNK_BYTES - 1}` }, signal });
      if (res.status === 404 || res.status === 416) return null;
      if (res.status !== 200 && res.status !== 206) await this.fail(res, 'Could not read the file from the library');
      const piece = await res.blob();
      if (res.status === 200) {
        // A host that ignored Range sent everything.
        parts.length = 0;
        parts.push(piece);
        total = piece.size;
        next = total;
        type = sniffMime(new Uint8Array(await piece.slice(0, 16).arrayBuffer()));
        onProgress?.(total, total);
        break;
      }
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('Content-Range') ?? '');
      if (!m || Number(m[1]) !== next || Number(m[2]) - Number(m[1]) + 1 !== piece.size || piece.size < 1) {
        throw new HostLibraryError('The host sent an unexpected part of the file', 502, 'bad_range');
      }
      total = Number(m[3]);
      if (next === 0) type = sniffMime(new Uint8Array(await piece.slice(0, 16).arrayBuffer()));
      parts.push(piece);
      next += piece.size;
      onProgress?.(next, total);
    }
    return new Blob(parts, type ? { type } : undefined);
  }

  /** Removes a stored file (and any upload of the id). False when the host had nothing. */
  async remove(id: string): Promise<boolean> {
    if (!isLibraryId(id)) return false;
    const res = await this.sendRetrying(`/api/files/${id}`, { method: 'DELETE' });
    if (res.status === 404) return false;
    if (!res.ok) await this.fail(res, 'Could not remove the file from the library');
    return true;
  }
}

/** The per-launch token the host writes into index.html (same meta tag src/ui/lifecycle.ts reads). */
export function pageSessionToken(): string {
  try {
    const t = document.querySelector<HTMLMetaElement>('meta[name="capstan-session"]')?.content ?? '';
    return t && !t.startsWith('__') ? t : '';
  } catch {
    return '';
  }
}
