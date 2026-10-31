// Bulk import from a SnapShackle captures folder. A browser cannot read %LOCALAPPDATA% by itself; the
// user picks the folder (usually %LOCALAPPDATA%\SnapShackle\Captures) with showDirectoryPicker and
// Capstan reads image and video files from it, read-only. Nothing is written back or watched.

export const SNAP_MAX_FILES = 300;
export const SNAP_MAX_DEPTH = 3;

const MEDIA_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|mp4|webm|mkv|mov|m4v)$/i;

/** The slice of FileSystemDirectoryHandle this needs (so tests can fake it). */
export interface DirHandleLike {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<DirHandleLike | FileHandleLike>;
}
export interface FileHandleLike {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

export function snapshackleSupported(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export interface CaptureScan {
  files: File[];
  /** Media files found beyond the cap that were left out (the oldest). */
  skipped: number;
}

/**
 * Collects image and video files from a folder and up to SNAP_MAX_DEPTH levels of subfolders. At
 * most `maxFiles` are kept (the newest), returned oldest first so they land in the bin in capture order.
 */
export async function collectCaptureFiles(root: DirHandleLike, maxFiles = SNAP_MAX_FILES): Promise<CaptureScan> {
  const found: File[] = [];
  const walk = async (dir: DirHandleLike, depth: number) => {
    for await (const entry of dir.values()) {
      if (entry.kind === 'directory') {
        if (depth < SNAP_MAX_DEPTH && !entry.name.startsWith('.')) await walk(entry, depth + 1);
      } else if (MEDIA_EXT.test(entry.name)) {
        try {
          found.push(await entry.getFile());
        } catch {
          /* unreadable or removed while scanning: skip it */
        }
      }
    }
  };
  await walk(root, 0);
  found.sort((a, b) => a.lastModified - b.lastModified || a.name.localeCompare(b.name));
  const skipped = Math.max(0, found.length - maxFiles);
  return { files: skipped ? found.slice(found.length - maxFiles) : found, skipped };
}
