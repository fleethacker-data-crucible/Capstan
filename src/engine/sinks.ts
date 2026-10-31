// Places an export can be written to as it is produced: a file chosen with the File System Access
// picker, a private file in the origin's storage (OPFS), or memory. All of them are ByteSinks, so
// the streaming MP4 muxer, the GIF encoder and the audio writers share one interface.
import type { ByteSink } from './mp4/muxer';

/** The slice of FileSystemFileHandle / FileSystemWritableFileStream the sinks use. */
interface WritableLike {
  write(data: { type: 'write'; position: number; data: Uint8Array<ArrayBuffer> }): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
export interface FileHandleLike {
  name: string;
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableLike>;
  getFile?(): Promise<File>;
}

/** Wraps a file's writable stream. Every write carries its position, so patching earlier bytes works. */
export function fileSink(writable: WritableLike): ByteSink {
  return {
    async write(data, position) {
      // Copy out of any larger backing buffer: a stream write must not see bytes beyond the view.
      const view = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? (data as Uint8Array<ArrayBuffer>) : new Uint8Array(data);
      await writable.write({ type: 'write', position, data: view });
    },
    async close() {
      await writable.close();
    },
    async abort() {
      try {
        await (writable.abort ? writable.abort() : writable.close());
      } catch {
        /* already closed */
      }
    },
  };
}

/** A sink that keeps everything in memory (used by tests, and as the plain-download fallback). */
export function memorySink(): ByteSink & { bytes(): Uint8Array; writes: Array<{ position: number; length: number }>; closed: boolean } {
  let buf = new Uint8Array(1024);
  let size = 0;
  const sink = {
    writes: [] as Array<{ position: number; length: number }>,
    closed: false,
    write(data: Uint8Array, position: number) {
      const end = position + data.length;
      if (end > buf.length) {
        let n = buf.length;
        while (n < end) n *= 2;
        const next = new Uint8Array(n);
        next.set(buf.subarray(0, size));
        buf = next;
      }
      buf.set(data, position);
      size = Math.max(size, end);
      sink.writes.push({ position, length: data.length });
    },
    close() {
      sink.closed = true;
    },
    bytes: () => buf.slice(0, size),
  };
  return sink;
}

interface PickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileHandleLike>;
  showDirectoryPicker?: (options?: { mode?: 'readwrite' }) => Promise<{
    name: string;
    getFileHandle(name: string, options: { create: boolean }): Promise<FileHandleLike>;
  }>;
}

export function canPickFile(): boolean {
  return typeof (globalThis as PickerWindow).showSaveFilePicker === 'function';
}

export function canPickFolder(): boolean {
  return typeof (globalThis as PickerWindow).showDirectoryPicker === 'function';
}

const TYPES: Record<string, { description: string; mime: string }> = {
  mp4: { description: 'MP4 video', mime: 'video/mp4' },
  gif: { description: 'Animated GIF', mime: 'image/gif' },
  wav: { description: 'WAV audio', mime: 'audio/wav' },
  m4a: { description: 'M4A audio', mime: 'audio/mp4' },
  png: { description: 'PNG image', mime: 'image/png' },
};

/**
 * Asks the user where to save (File System Access). Must be called straight from a click, before
 * any await, or the browser refuses to show the picker. Resolves to null if the user cancels.
 */
export async function pickSaveFile(name: string, ext: string): Promise<FileHandleLike | null> {
  const picker = (globalThis as PickerWindow).showSaveFilePicker;
  if (!picker) throw new Error('This browser cannot save straight to a file. Turn off "Save to file" to download instead.');
  const type = TYPES[ext];
  try {
    return await picker.call(globalThis, {
      suggestedName: `${name}.${ext}`,
      types: type ? [{ description: type.description, accept: { [type.mime]: [`.${ext}`] } }] : undefined,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    throw e;
  }
}

/** Asks for a folder to put a batch of exports in. Resolves to null if the user cancels. */
export async function pickFolder(): Promise<{ name: string; file(name: string): Promise<FileHandleLike> } | null> {
  const picker = (globalThis as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error('This browser cannot save into a folder.');
  try {
    const dir = await picker.call(globalThis, { mode: 'readwrite' });
    return { name: dir.name, file: (n) => dir.getFileHandle(n, { create: true }) };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    throw e;
  }
}

/** Opens a (truncated) writable on a handle and wraps it as a sink. */
export async function openSink(handle: FileHandleLike): Promise<ByteSink> {
  return fileSink(await handle.createWritable({ keepExistingData: false }));
}

/** A file in the origin's private storage (OPFS). Used where no picker exists, and by the tests. */
export async function opfsFile(name: string): Promise<FileHandleLike> {
  const root = await navigator.storage.getDirectory();
  return root.getFileHandle(name, { create: true }) as unknown as Promise<FileHandleLike>;
}

/** Collision-free file name inside a folder: "name.mp4", "name (2).mp4", ... */
export function uniqueName(base: string, ext: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let n = 1;
  let name = `${base}.${ext}`;
  while (used.has(name)) name = `${base} (${++n}).${ext}`;
  return name;
}
