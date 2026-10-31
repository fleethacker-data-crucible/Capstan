// Recording to disk. MediaRecorder chunks are written into the browser's private file system (OPFS)
// as they arrive, so memory stays flat however long the recording runs, and a crash or a closed
// window leaves the footage behind to recover at the next start.
//
// createWritable() only commits a file when it is closed, so one growing file would stay empty
// (and be lost in a crash). Each batch of chunks is therefore its own small segment file,
//   <session>.<role>.<seq>.<ext>
// and a manifest <session>.manifest.json describes the session. Segments are joined lazily into a
// Blob (file-backed, not copied into memory) when the recording is imported.
//
// Everything here talks to a tiny directory interface, so the logic runs in unit tests against an
// in-memory directory; `openRecordingStore()` wires it to the real OPFS.
import type { Crop } from './project';

export type PartRole = 'screen' | 'webcam' | 'mic' | 'system';

export const STORE_DIR = 'capstan-recordings';

export const ROLE_LABEL: Record<PartRole, string> = { screen: 'Recording', webcam: 'Webcam', mic: 'Microphone', system: 'System audio' };

export interface StoreWritable {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
}
export interface StoreFile {
  getFile(): Promise<File>;
  createWritable(): Promise<StoreWritable>;
}
/** The slice of FileSystemDirectoryHandle this module uses. */
export interface StoreDir {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<StoreFile>;
  removeEntry(name: string): Promise<void>;
  names(): Promise<string[]>;
}

// ---------------------------------------------------------------- names

const p2 = (n: number) => String(n).padStart(2, '0');

/** Local time with dots instead of colons, so the name is valid on Windows. */
export function stampName(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}`;
}

/** "Recording 2026-10-30 10.15.00.webm", "Webcam …", "Microphone …", "System audio …". */
export function partFileName(role: PartRole, d: Date, ext: string): string {
  return `${ROLE_LABEL[role]} ${stampName(d)}.${ext}`;
}

/** A session id with no dots, sortable by time: rec-20261030-101500-k3f9. */
export function newSessionId(d: Date = new Date(), random: () => number = Math.random): string {
  const day = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  const time = `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const tail = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `rec-${day}-${time}-${tail}`;
}

export const segmentName = (session: string, role: PartRole, seq: number, ext: string) => `${session}.${role}.${String(seq).padStart(6, '0')}.${ext}`;
export const manifestName = (session: string) => `${session}.manifest.json`;

export type ParsedName =
  | { kind: 'segment'; session: string; role: PartRole; seq: number; ext: string }
  | { kind: 'manifest'; session: string };

const ROLES: PartRole[] = ['screen', 'webcam', 'mic', 'system'];

/** Reads a file name in the store; null for anything that is not ours. */
export function parseEntryName(name: string): ParsedName | null {
  const parts = name.split('.');
  if (parts.length === 3 && parts[1] === 'manifest' && parts[2] === 'json' && parts[0].startsWith('rec-')) return { kind: 'manifest', session: parts[0] };
  if (parts.length === 4 && parts[0].startsWith('rec-') && ROLES.includes(parts[1] as PartRole) && /^\d{1,9}$/.test(parts[2]) && /^[a-z0-9]{2,5}$/.test(parts[3])) {
    return { kind: 'segment', session: parts[0], role: parts[1] as PartRole, seq: Number(parts[2]), ext: parts[3] };
  }
  return null;
}

/** MIME type for a part recorded as `ext`. Audio roles are audio-only containers. */
export function mimeFor(role: PartRole, ext: string): string {
  const audio = role === 'mic' || role === 'system';
  if (ext === 'mp4') return audio ? 'audio/mp4' : 'video/mp4';
  if (ext === 'ogg') return 'audio/ogg';
  return audio ? 'audio/webm' : 'video/webm';
}

// ---------------------------------------------------------------- manifest

export interface PartInfo {
  ext: string;
  mime: string;
  width?: number;
  height?: number;
}

/** How the parts go on the timeline, kept so a recovered session is placed as it would have been. */
export interface PlacementPlan {
  /** Webcam as a small picture-in-picture (otherwise full frame on its own track). */
  pip: boolean;
  /** Region chosen before recording, as fractions of the screen frame. */
  crop?: Crop;
}

export interface SessionManifest {
  version: 1;
  session: string;
  startedAt: number;
  /** File name of the screen recording; the other parts derive theirs from the same moment. */
  name: string;
  width: number;
  height: number;
  parts: Partial<Record<PartRole, PartInfo>>;
  /** The recorder was stopped cleanly. False after a crash or a closed window. */
  complete: boolean;
  /** Imported into the project; the files are only kept until the next start (see sweep). */
  imported: boolean;
  seconds: number;
  place: PlacementPlan;
}

export function newManifest(session: string, startedAt: number, patch: Partial<SessionManifest> = {}): SessionManifest {
  return {
    version: 1,
    session,
    startedAt,
    name: partFileName('screen', new Date(startedAt), 'webm'),
    width: 0,
    height: 0,
    parts: {},
    complete: false,
    imported: false,
    seconds: 0,
    place: { pip: true },
    ...patch,
  };
}

/** Parses a stored manifest; null when it is unusable (the files are then listed from their names). */
export function parseManifest(text: string): SessionManifest | null {
  try {
    const v = JSON.parse(text) as Partial<SessionManifest>;
    if (!v || v.version !== 1 || typeof v.session !== 'string') return null;
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
    const place = v.place && typeof v.place === 'object' ? v.place : { pip: true };
    return {
      version: 1,
      session: v.session,
      startedAt: num(v.startedAt),
      name: typeof v.name === 'string' ? v.name : partFileName('screen', new Date(num(v.startedAt)), 'webm'),
      width: num(v.width),
      height: num(v.height),
      parts: v.parts && typeof v.parts === 'object' ? v.parts : {},
      complete: v.complete === true,
      imported: v.imported === true,
      seconds: num(v.seconds),
      place: { pip: place.pip !== false, crop: place.crop },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- chunk sinks

/** Receives the chunks of one MediaRecorder and hands back the finished recording. */
export interface ChunkSink {
  /** Bytes received so far (written or waiting). */
  readonly received: number;
  /** Bytes safely on disk; always 0 for a memory sink. */
  readonly written: number;
  /** True when chunks are going to disk (false for memory, or after a disk write failed). */
  readonly onDisk: boolean;
  push(chunk: Blob): void;
  /** Flushes what is waiting and returns the whole recording. */
  finish(type: string): Promise<Blob>;
}

export class MemorySink implements ChunkSink {
  private chunks: Blob[] = [];
  received = 0;
  written = 0;
  onDisk = false;
  push(chunk: Blob): void {
    this.chunks.push(chunk);
    this.received += chunk.size;
  }
  async finish(type: string): Promise<Blob> {
    return new Blob(this.chunks, { type });
  }
}

export interface DiskSinkOptions {
  /** Write a segment once this many bytes are waiting... */
  flushBytes?: number;
  /** ...or once this long has passed since the last write, whichever comes first. */
  flushMs?: number;
  now?: () => number;
  /** Called once if a write fails and the sink carries on in memory. */
  onFallback?: (error: Error) => void;
}

export class DiskSink implements ChunkSink {
  received = 0;
  written = 0;
  onDisk = true;
  /** Number of segment files written. */
  segments = 0;
  private pending: Blob[] = [];
  private pendingBytes = 0;
  private lastFlush: number;
  private chain: Promise<void> = Promise.resolve();
  private memoryTail: Blob[] = [];
  private readonly flushBytes: number;
  private readonly flushMs: number;
  private readonly now: () => number;

  constructor(
    private readonly dir: StoreDir,
    private readonly session: string,
    private readonly role: PartRole,
    private readonly ext: string,
    private readonly options: DiskSinkOptions = {},
  ) {
    this.flushBytes = options.flushBytes ?? 512 * 1024;
    this.flushMs = options.flushMs ?? 1500;
    this.now = options.now ?? (() => Date.now());
    this.lastFlush = this.now();
  }

  push(chunk: Blob): void {
    this.received += chunk.size;
    if (!this.onDisk) {
      this.memoryTail.push(chunk);
      return;
    }
    this.pending.push(chunk);
    this.pendingBytes += chunk.size;
    if (this.pendingBytes >= this.flushBytes || this.now() - this.lastFlush >= this.flushMs) this.flush();
  }

  private flush(): void {
    if (!this.pending.length) return;
    const batch = this.pending;
    const bytes = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    this.lastFlush = this.now();
    this.chain = this.chain.then(async () => {
      if (!this.onDisk) {
        this.memoryTail.push(...batch);
        return;
      }
      const name = segmentName(this.session, this.role, this.segments + 1, this.ext);
      try {
        const handle = await this.dir.getFileHandle(name, { create: true });
        const w = await handle.createWritable();
        await w.write(new Blob(batch));
        await w.close();
        this.segments++;
        this.written += bytes;
      } catch (e) {
        // Disk full or storage blocked: keep this and every later chunk in memory instead.
        this.onDisk = false;
        this.memoryTail.push(...batch);
        await this.dir.removeEntry(name).catch(() => undefined); // no empty segment left behind
        this.options.onFallback?.(e as Error);
      }
    });
  }

  async finish(type: string): Promise<Blob> {
    this.flush();
    await this.chain;
    const parts: Blob[] = [];
    for (let seq = 1; seq <= this.segments; seq++) {
      const handle = await this.dir.getFileHandle(segmentName(this.session, this.role, seq, this.ext));
      parts.push(await handle.getFile());
    }
    return new Blob([...parts, ...this.memoryTail], { type });
  }
}

// ---------------------------------------------------------------- store

export interface RecoverablePart {
  role: PartRole;
  ext: string;
  mime: string;
  segments: number;
  bytes: number;
  /** Segment file names in recording order. */
  files: string[];
}

export interface RecoverableSession {
  session: string;
  manifest: SessionManifest;
  parts: RecoverablePart[];
  totalBytes: number;
}

export interface StoreOptions {
  /** Sessions another window is recording right now; they are never listed or swept. */
  activeSessions?: () => Promise<Set<string>>;
  /** Hold a claim on a session while it records; returns the release function. */
  claim?: (session: string) => () => void;
}

export class RecordingStore {
  private manifests = new Map<string, SessionManifest>();
  private releases = new Map<string, () => void>();

  constructor(
    readonly dir: StoreDir,
    private readonly options: StoreOptions = {},
  ) {}

  /** Starts a session: writes its manifest and claims it while it records. */
  async begin(manifest: SessionManifest): Promise<void> {
    this.manifests.set(manifest.session, manifest);
    const release = this.options.claim?.(manifest.session);
    if (release) this.releases.set(manifest.session, release);
    await this.writeManifest(manifest);
  }

  sink(session: string, role: PartRole, ext: string, options?: DiskSinkOptions): DiskSink {
    return new DiskSink(this.dir, session, role, ext, options);
  }

  /** Merges `patch` into the session's manifest and saves it. */
  async update(session: string, patch: Partial<SessionManifest>): Promise<void> {
    const current = this.manifests.get(session) ?? (await this.readManifest(session));
    if (!current) return;
    const next = { ...current, ...patch };
    this.manifests.set(session, next);
    await this.writeManifest(next);
  }

  /** The recorder has stopped: the session stays listed only if it still holds footage. */
  release(session: string): void {
    this.releases.get(session)?.();
    this.releases.delete(session);
  }

  private async writeManifest(m: SessionManifest): Promise<void> {
    const handle = await this.dir.getFileHandle(manifestName(m.session), { create: true });
    const w = await handle.createWritable();
    await w.write(JSON.stringify(m));
    await w.close();
  }

  private async readManifest(session: string): Promise<SessionManifest | null> {
    try {
      const handle = await this.dir.getFileHandle(manifestName(session));
      return parseManifest(await (await handle.getFile()).text());
    } catch {
      return null;
    }
  }

  /** Every session in the store that no window is recording, oldest first. */
  async list(): Promise<RecoverableSession[]> {
    const active = (await this.options.activeSessions?.()) ?? new Set<string>();
    const names = await this.dir.names();
    const bySession = new Map<string, { segments: Map<PartRole, Array<{ name: string; seq: number; ext: string }>>; manifest: boolean }>();
    for (const name of names) {
      const p = parseEntryName(name);
      if (!p || active.has(p.session)) continue;
      const entry = bySession.get(p.session) ?? { segments: new Map(), manifest: false };
      bySession.set(p.session, entry);
      if (p.kind === 'manifest') entry.manifest = true;
      else {
        const list = entry.segments.get(p.role) ?? [];
        list.push({ name, seq: p.seq, ext: p.ext });
        entry.segments.set(p.role, list);
      }
    }
    const out: RecoverableSession[] = [];
    for (const [session, entry] of bySession) {
      const stored = entry.manifest ? await this.readManifest(session) : null;
      const parts: RecoverablePart[] = [];
      for (const role of ROLES) {
        const segs = entry.segments.get(role);
        if (!segs?.length) continue;
        segs.sort((a, b) => a.seq - b.seq);
        let bytes = 0;
        for (const s of segs) bytes += (await (await this.dir.getFileHandle(s.name)).getFile()).size;
        const ext = segs[0].ext;
        parts.push({ role, ext, mime: stored?.parts[role]?.mime ?? mimeFor(role, ext), segments: segs.length, bytes, files: segs.map((x) => x.name) });
      }
      const startedAt = stored?.startedAt || startOfSession(session);
      const manifest = stored ?? newManifest(session, startedAt, { name: partFileName('screen', new Date(startedAt), parts.find((p) => p.role === 'screen')?.ext ?? 'webm') });
      out.push({ session, manifest, parts, totalBytes: parts.reduce((n, p) => n + p.bytes, 0) });
    }
    return out.sort((a, b) => a.manifest.startedAt - b.manifest.startedAt || a.session.localeCompare(b.session));
  }

  /** The files of one session as Files, joined from their segments without reading them into memory. */
  async load(session: string): Promise<Array<{ role: PartRole; file: File; info: PartInfo }>> {
    const found = (await this.list()).find((s) => s.session === session);
    if (!found) return [];
    const out: Array<{ role: PartRole; file: File; info: PartInfo }> = [];
    const started = new Date(found.manifest.startedAt);
    for (const part of found.parts) {
      const files: File[] = [];
      for (const name of part.files) files.push(await (await this.dir.getFileHandle(name)).getFile());
      if (!part.bytes) continue;
      const name = part.role === 'screen' && found.manifest.name ? found.manifest.name : partFileName(part.role, started, part.ext);
      const info = { ...found.manifest.parts[part.role], ext: part.ext, mime: part.mime };
      out.push({ role: part.role, file: new File(files, name, { type: part.mime }), info });
    }
    return out;
  }

  /** Marks a session imported. Its files stay until the next start: the open project still reads them. */
  async markImported(session: string): Promise<void> {
    await this.update(session, { imported: true, complete: true });
  }

  /** Deletes every file of a session. */
  async discard(session: string): Promise<void> {
    this.release(session);
    this.manifests.delete(session);
    for (const name of await this.dir.names()) {
      if (parseEntryName(name)?.session === session) await this.dir.removeEntry(name).catch(() => undefined);
    }
  }

  /**
   * Removes what is not worth offering: sessions already imported, and sessions with no footage.
   * Returns the sessions that remain for recovery.
   */
  async sweep(): Promise<RecoverableSession[]> {
    const all = await this.list();
    const keep: RecoverableSession[] = [];
    for (const s of all) {
      if (s.manifest.imported || s.totalBytes === 0) await this.discard(s.session);
      else keep.push(s);
    }
    return keep;
  }

  /** Total bytes on disk for a session (for progress readouts and tests). */
  async sizeOf(session: string): Promise<number> {
    let n = 0;
    for (const name of await this.dir.names()) {
      const p = parseEntryName(name);
      if (p?.kind === 'segment' && p.session === session) n += (await (await this.dir.getFileHandle(name)).getFile()).size;
    }
    return n;
  }
}

/** Best-effort start time from an id like rec-20261030-101500-k3f9. */
function startOfSession(session: string): number {
  const m = /^rec-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(session);
  if (!m) return 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

// ---------------------------------------------------------------- the browser's file system

type DirectoryHandleLike = {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<StoreFile>;
  removeEntry(name: string): Promise<void>;
  entries(): AsyncIterable<[string, { kind: string }]>;
};

function adapt(handle: DirectoryHandleLike): StoreDir {
  return {
    getFileHandle: (name, options) => handle.getFileHandle(name, options),
    removeEntry: (name) => handle.removeEntry(name),
    async names() {
      const out: string[] = [];
      for await (const [name, entry] of handle.entries()) if (entry.kind === 'file') out.push(name);
      return out;
    },
  };
}

/** Web Locks keep a claim on a session while its window records, so a second window leaves it alone. */
function lockOptions(): StoreOptions {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return {};
  return {
    claim(session) {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      void locks.request(`capstan-rec-${session}`, () => held).catch(() => undefined);
      return release;
    },
    async activeSessions() {
      const state = await locks.query();
      const held = new Set<string>();
      for (const l of state.held ?? []) if (l.name?.startsWith('capstan-rec-')) held.add(l.name.slice('capstan-rec-'.length));
      return held;
    },
  };
}

/** The recording store in this browser's private file system, or null where OPFS is unavailable. */
export async function openRecordingStore(): Promise<RecordingStore | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(STORE_DIR, { create: true });
    // Some builds expose the API but cannot write; find out now, not mid-recording.
    const probe = await dir.getFileHandle('.probe', { create: true });
    const w = await probe.createWritable();
    await w.write('ok');
    await w.close();
    await dir.removeEntry('.probe');
    return new RecordingStore(adapt(dir as unknown as DirectoryHandleLike), lockOptions());
  } catch {
    return null;
  }
}
