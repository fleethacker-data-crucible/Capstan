// Write-through and fallback between the browser's media store (IndexedDB, the primary store) and the
// library the host keeps on disk. Rules:
//   - nothing here ever blocks or fails an edit: uploads run in the background, one at a time, and a
//     failure becomes a status-bar message while the media stays in the browser;
//   - the host is asked for a media file only when IndexedDB does not have it (a project opened on another
//     port, or after the browser's data was cleared);
//   - without a host library (no token, library off, host unreachable) every method is a quiet no-op.
import { type HostFileInfo, type HostLibraryLike, isAbortError, isLibraryId } from './library-host';

export interface MirrorState {
  /** The host has a library and this page can use it. */
  active: boolean;
  /** Files waiting for or in the middle of an upload. */
  pending: number;
  /** Uploads that failed since the last success (they stay in the browser). */
  failed: number;
  /** Progress of the upload in flight, 0..1, or null. */
  progress: number | null;
  lastError: string | null;
}

type Job = { blob: Blob; label: string; ctrl: AbortController };

export class LibraryMirror {
  private host: HostLibraryLike | null = null;
  private readyPromise: Promise<boolean> | null = null;
  private known = new Map<string, number>();
  private jobs = new Map<string, Job>();
  private queue: string[] = [];
  private running = false;
  private listeners = new Set<(s: MirrorState) => void>();
  private message: (text: string) => void = () => undefined;
  private snapshot: MirrorState = { active: false, pending: 0, failed: 0, progress: null, lastError: null };

  /** `make` builds the client; it returns null where there is no host (the page is not served by it). */
  constructor(private readonly make: () => HostLibraryLike | null) {}

  /** Where failures are shown (the status bar). */
  setReporter(fn: (text: string) => void): void {
    this.message = fn;
  }

  get state(): MirrorState {
    return this.snapshot;
  }

  subscribe(fn: (s: MirrorState) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<MirrorState>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) fn(this.snapshot);
  }

  /** Asks the host once whether it has a library, and reads its index. Resolves true when it does. */
  ready(): Promise<boolean> {
    if (!this.readyPromise) this.readyPromise = this.probe();
    return this.readyPromise;
  }

  /** Forgets what was learnt and asks again (after the host came back). */
  reprobe(): Promise<boolean> {
    this.readyPromise = null;
    return this.ready();
  }

  private async probe(): Promise<boolean> {
    try {
      this.host = this.make();
      if (!this.host) return false;
      const info = await this.host.probe();
      if (!info.library) {
        this.host = null;
        return false;
      }
      this.known = new Map((await this.host.list().catch(() => [] as HostFileInfo[])).map((f) => [f.id, f.size]));
      this.set({ active: true });
      return true;
    } catch {
      this.host = null;
      return false;
    }
  }

  /** Copies a media file to the host in the background. */
  store(id: string, blob: Blob, label = id): void {
    void this.ready().then((on) => {
      if (!on || !isLibraryId(id) || blob.size < 1) return;
      const old = this.jobs.get(id);
      if (old) old.ctrl.abort();
      this.jobs.set(id, { blob, label, ctrl: new AbortController() });
      if (!this.queue.includes(id)) this.queue.push(id);
      this.set({ pending: this.jobs.size });
      void this.pump();
    });
  }

  /** IndexedDB has this file: make sure the host does too (media imported before the library was on). */
  noteLocal(id: string, blob: Blob, label = id): void {
    void this.ready().then((on) => {
      if (!on || this.jobs.has(id) || this.known.get(id) === blob.size) return;
      this.store(id, blob, label);
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift() as string;
        const job = this.jobs.get(id);
        if (!job || !this.host) continue;
        try {
          await this.host.upload(id, job.blob, {
            signal: job.ctrl.signal,
            onProgress: (done, total) => this.set({ progress: total ? done / total : null }),
          });
          this.known.set(id, job.blob.size);
          if (this.jobs.get(id) === job) this.jobs.delete(id);
          this.set({ pending: this.jobs.size, progress: null, failed: 0, lastError: null });
        } catch (e) {
          if (this.jobs.get(id) === job) this.jobs.delete(id);
          if (isAbortError(e)) {
            this.set({ pending: this.jobs.size, progress: null });
            continue;
          }
          const text = `Could not copy ${job.label} to the library on disk (${e instanceof Error ? e.message : String(e)}). It is still saved in this browser.`;
          this.set({ pending: this.jobs.size, progress: null, failed: this.snapshot.failed + 1, lastError: text });
          this.message(text);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Reads a file from the host. Null when there is no library, the host lacks the file, or it cannot be read. */
  async fetch(id: string, label = id): Promise<Blob | null> {
    if (!(await this.ready()) || !this.host || !isLibraryId(id)) return null;
    try {
      const blob = await this.host.download(id);
      if (blob) this.known.set(id, blob.size);
      return blob;
    } catch (e) {
      const text = `Could not read ${label} from the library on disk (${e instanceof Error ? e.message : String(e)}).`;
      this.set({ lastError: text });
      this.message(text);
      return null;
    }
  }

  /** The browser deleted this media: drop the host's copy too (background, quiet). */
  forget(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.ctrl.abort();
      this.jobs.delete(id);
      this.set({ pending: this.jobs.size });
    }
    void this.ready().then(async (on) => {
      if (!on || !this.host || !isLibraryId(id)) return;
      this.known.delete(id);
      try {
        await this.host.remove(id);
      } catch {
        /* the stored copy stays until the library is cleaned; harmless */
      }
    });
  }
}
