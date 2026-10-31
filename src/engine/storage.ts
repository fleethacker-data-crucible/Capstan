// IndexedDB persistence: media bytes (as Blobs) and project documents stay in the browser
// profile on this computer. Nothing is uploaded anywhere except to the Capstan host on this same
// computer: when it keeps a library on disk (modules/Library.ps1), each media file is also copied there
// in the background, and read back from there when IndexedDB does not have it (see library-mirror.ts).
import { HostLibrary, pageSessionToken } from './library-host';
import { LibraryMirror, type MirrorState } from './library-mirror';
import { type MediaItem, type Project, parseProject } from './project';
import { type ProjectSummary, summariseProject } from './projects';
import { type ProjectTemplate, parseTemplate } from './templates';

const DB_NAME = 'capstan';
const DB_VERSION = 2;
const MEDIA = 'media';
const PROJECTS = 'projects';
const META = 'meta';
// Added in version 2: reusable assets and the user's own templates. They belong to no project, so
// New project and Delete project never touch them.
const LIBRARY = 'library';
const TEMPLATES = 'templates';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEDIA)) db.createObjectStore(MEDIA);
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(LIBRARY)) db.createObjectStore(LIBRARY);
      if (!db.objectStoreNames.contains(TEMPLATES)) db.createObjectStore(TEMPLATES);
    };
    request.onsuccess = () => {
      // Another tab opening a newer version must not be blocked by this one.
      request.result.onversionchange = () => {
        request.result.close();
        dbPromise = null;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('IndexedDB unavailable'));
    };
  });
  return dbPromise;
}

async function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const request = run(t.objectStore(store));
    t.oncomplete = () => resolve(request.result);
    t.onerror = () => reject(t.error ?? request.error);
    t.onabort = () => reject(t.error ?? new Error('Storage transaction aborted (disk full?)'));
  });
}

// The page's connection to the host's on-disk library. Only exists when the host served this page.
const mirror = new LibraryMirror(() => (pageSessionToken() ? new HostLibrary({ token: pageSessionToken }) : null));

/** Where a failed copy to the library on disk is reported (the status bar). */
export function setLibraryReporter(fn: (text: string) => void): void {
  mirror.setReporter(fn);
}

/** Subscribes to the library's state (active, files waiting, last failure). Calls back at once. */
export function onLibraryState(fn: (s: MirrorState) => void): () => void {
  void mirror.ready();
  return mirror.subscribe(fn);
}

const labelOf = (id: string, blob: Blob) => (blob as File).name || id;

function putLocal(id: string, blob: Blob): Promise<IDBValidKey> {
  return tx(MEDIA, 'readwrite', (s) => s.put(blob, id));
}

/** Stores media in IndexedDB, then (when the host has a library) copies it there without waiting for it. */
export async function putMediaBlob(id: string, blob: Blob): Promise<IDBValidKey> {
  const key = await putLocal(id, blob);
  mirror.store(id, blob, labelOf(id, blob));
  return key;
}

/** IndexedDB first; the host's library when IndexedDB does not have the media (another port, cleared data). */
export async function getMediaBlob(id: string): Promise<Blob | null> {
  const value = await tx<Blob | undefined>(MEDIA, 'readonly', (s) => s.get(id));
  if (value instanceof Blob) {
    mirror.noteLocal(id, value, labelOf(id, value));
    return value;
  }
  const remote = await mirror.fetch(id);
  if (!remote) return null;
  // Keep a local copy so the next open does not go through the host; best effort (quota).
  await putLocal(id, remote).catch(() => undefined);
  return remote;
}

export function deleteMediaBlob(id: string): Promise<undefined> {
  return tx<undefined>(MEDIA, 'readwrite', (s) => s.delete(id)).then((r) => {
    mirror.forget(id);
    return r;
  });
}

/** Stores a project. `markLast: false` saves one that is not the open project (rename, duplicate). */
export async function saveProject(project: Project, options: { markLast?: boolean } = {}): Promise<void> {
  await tx(PROJECTS, 'readwrite', (s) => s.put(project, project.id));
  if (options.markLast !== false) await tx(META, 'readwrite', (s) => s.put(project.id, 'lastProjectId'));
}

export async function loadProject(id: string): Promise<Project | null> {
  const raw = await tx<unknown>(PROJECTS, 'readonly', (s) => s.get(id));
  if (!raw) return null;
  try {
    return parseProject(raw);
  } catch {
    return null;
  }
}

/** Every stored project that parses, newest first, with what it occupies. */
export async function listProjects(): Promise<Array<{ project: Project; summary: ProjectSummary }>> {
  const all = await tx<unknown[]>(PROJECTS, 'readonly', (s) => s.getAll());
  const out: Array<{ project: Project; summary: ProjectSummary }> = [];
  for (const raw of all) {
    try {
      const project = parseProject(raw);
      out.push({ project, summary: summariseProject(project) });
    } catch {
      /* an unreadable record is skipped; it cannot be opened anyway */
    }
  }
  return out.sort((a, b) => b.summary.updatedAt - a.summary.updatedAt);
}

/** Removes a project and the media Blobs it owns. Projects never share media ids (see cloneProject). */
export async function deleteProject(project: Project): Promise<void> {
  for (const m of project.media) await deleteMediaBlob(m.id).catch(() => undefined);
  await tx(PROJECTS, 'readwrite', (s) => s.delete(project.id));
  const last = await tx<string | undefined>(META, 'readonly', (s) => s.get('lastProjectId'));
  if (last === project.id) await tx(META, 'readwrite', (s) => s.delete('lastProjectId'));
}

/** Copies a project's media Blobs to the ids in `idMap` (old to new). Rolls back on failure. */
export async function copyMediaBlobs(idMap: Map<string, string>): Promise<void> {
  const done: string[] = [];
  try {
    for (const [from, to] of idMap) {
      const blob = await getMediaBlob(from);
      if (!blob) throw new Error('A media file is missing from browser storage, so the project cannot be copied.');
      await putMediaBlob(to, blob);
      done.push(to);
    }
  } catch (e) {
    for (const id of done) await deleteMediaBlob(id).catch(() => undefined);
    throw e;
  }
}

export async function loadLastProject(): Promise<Project | null> {
  const id = await tx<string | undefined>(META, 'readonly', (s) => s.get('lastProjectId'));
  if (!id) return null;
  const raw = await tx<unknown>(PROJECTS, 'readonly', (s) => s.get(id));
  if (!raw) return null;
  try {
    return parseProject(raw);
  } catch {
    return null;
  }
}

/** Asks the browser not to evict media under storage pressure. Best effort. */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}

// ---------- library: reusable assets that outlive any project ----------

export interface LibraryAsset {
  /** Describes the file (name, kind, size, duration, thumbnail); `meta.id` is the asset id. */
  meta: MediaItem;
  savedAt: number;
}

interface LibraryRecord extends LibraryAsset {
  blob: Blob;
}

export async function putLibraryAsset(meta: MediaItem, blob: Blob): Promise<void> {
  const record: LibraryRecord = { meta, blob, savedAt: Date.now() };
  await tx(LIBRARY, 'readwrite', (s) => s.put(record, meta.id));
}

export async function listLibrary(): Promise<LibraryAsset[]> {
  const all = await tx<LibraryRecord[]>(LIBRARY, 'readonly', (s) => s.getAll());
  return all
    .filter((r) => r && r.meta && typeof r.meta.id === 'string')
    .map((r) => ({ meta: r.meta, savedAt: r.savedAt ?? 0 }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function getLibraryBlob(id: string): Promise<Blob | null> {
  const r = await tx<LibraryRecord | undefined>(LIBRARY, 'readonly', (s) => s.get(id));
  return r?.blob instanceof Blob ? r.blob : null;
}

export function deleteLibraryAsset(id: string): Promise<undefined> {
  return tx(LIBRARY, 'readwrite', (s) => s.delete(id));
}

// ---------- user templates ----------

export async function listUserTemplates(): Promise<ProjectTemplate[]> {
  const all = await tx<unknown[]>(TEMPLATES, 'readonly', (s) => s.getAll());
  return all
    .map(parseTemplate)
    .filter((t): t is ProjectTemplate => !!t)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function putUserTemplate(template: ProjectTemplate): Promise<IDBValidKey> {
  return tx(TEMPLATES, 'readwrite', (s) => s.put(template, template.id));
}

export function deleteUserTemplate(id: string): Promise<undefined> {
  return tx(TEMPLATES, 'readwrite', (s) => s.delete(id));
}
