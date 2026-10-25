// IndexedDB persistence: media bytes (as Blobs) and project documents stay in the browser
// profile on this computer. Nothing is uploaded anywhere.
import { type Project, parseProject } from './project';

const DB_NAME = 'capstan';
const DB_VERSION = 1;
const MEDIA = 'media';
const PROJECTS = 'projects';
const META = 'meta';

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
    };
    request.onsuccess = () => resolve(request.result);
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

export function putMediaBlob(id: string, blob: Blob): Promise<IDBValidKey> {
  return tx(MEDIA, 'readwrite', (s) => s.put(blob, id));
}

export async function getMediaBlob(id: string): Promise<Blob | null> {
  const value = await tx<Blob | undefined>(MEDIA, 'readonly', (s) => s.get(id));
  return value instanceof Blob ? value : null;
}

export function deleteMediaBlob(id: string): Promise<undefined> {
  return tx(MEDIA, 'readwrite', (s) => s.delete(id));
}

export async function saveProject(project: Project): Promise<void> {
  await tx(PROJECTS, 'readwrite', (s) => s.put(project, project.id));
  await tx(META, 'readwrite', (s) => s.put(project.id, 'lastProjectId'));
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
