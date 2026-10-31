// Editor state: the current project, selection, undo history, and loaded media sources.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { History } from '../engine/history';
import { type MediaHints, probeMedia } from '../engine/media';
import { addMedia, removeMedia } from '../engine/ops';
import { MAX_DESCRIPTION_CHARS, type MediaItem, type Project, createProject } from '../engine/project';
import { isEmptyProject } from '../engine/projects';
import { deleteProject, getMediaBlob, loadLastProject, putMediaBlob, requestPersistence, saveProject, setLibraryReporter } from '../engine/storage';

export interface MediaSources {
  url(mediaId: string): string | null;
  bitmap(mediaId: string): ImageBitmap | null;
  blob(mediaId: string): Promise<Blob | null>;
}

export interface Editor {
  project: Project;
  /** The latest project, for code that runs after an await. */
  getProject(): Project;
  ready: boolean;
  selection: string[];
  setSelection(ids: string[]): void;
  /** Applies an edit and records it for undo. */
  commit(next: Project, before?: Project): void;
  /** Shows an in-progress edit (a drag) without recording it. */
  preview(next: Project): void;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  /** `descriptions` attaches text to the media made from a file (the OCR text of a SnapShackle capture). */
  importFiles(files: Iterable<File>, options?: { descriptions?: ReadonlyMap<File, string> }): Promise<MediaItem[]>;
  /** Adds a fresh recording to the bin; throws if it cannot be added. */
  importRecording(file: File, hints: MediaHints): Promise<MediaItem>;
  deleteMedia(mediaId: string): Promise<void>;
  /** Starts an empty project. The one being left stays in the Projects list (or is dropped if it was never used). */
  newProject(): void;
  replaceProject(project: Project): void;
  /**
   * Switches to `project`: saves the current one, loads the media of `project` from browser storage
   * and shows it. Resolves with the names of media that are not in storage.
   */
  openProject(project: Project): Promise<string[]>;
  sources: MediaSources;
  /** Bumped when media finishes loading so the preview can redraw. */
  sourcesVersion: number;
  status: string;
  setStatus(text: string): void;
}

export function useEditor(): Editor {
  const [project, setProject] = useState<Project>(() => createProject());
  const [ready, setReady] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [status, setStatus] = useState('Ready');
  const [, setTick] = useState(0);
  const [sourcesVersion, setSourcesVersion] = useState(0);
  const history = useRef(new History());
  const projectRef = useRef(project);
  projectRef.current = project;
  const urls = useRef(new Map<string, string>());
  const bitmaps = useRef(new Map<string, ImageBitmap>());
  const blobs = useRef(new Map<string, Blob>());

  // A failed copy to the library on disk shows in the status bar; the edit itself is never held up by it.
  useEffect(() => {
    setLibraryReporter(setStatus);
  }, []);

  const loadSource = useCallback(async (media: MediaItem, blob?: Blob | null) => {
    const b = blob ?? (await getMediaBlob(media.id));
    if (!b) return false;
    blobs.current.set(media.id, b);
    if (media.kind === 'image') {
      if (!bitmaps.current.has(media.id)) bitmaps.current.set(media.id, await createImageBitmap(b));
    } else if (!urls.current.has(media.id)) {
      urls.current.set(media.id, URL.createObjectURL(b));
    }
    return true;
  }, []);

  // Restore the last project and its media from IndexedDB.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      void requestPersistence();
      try {
        const saved = await loadLastProject();
        if (saved && !cancelled) {
          const missing: string[] = [];
          for (const m of saved.media) if (!(await loadSource(m))) missing.push(m.name);
          setProject(saved);
          setSourcesVersion((v) => v + 1);
          setStatus(missing.length ? `Missing media: ${missing.join(', ')}` : `Opened ${saved.name}`);
        }
      } catch (e) {
        setStatus(`Could not open the saved project: ${(e as Error).message}`);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSource]);

  // Autosave shortly after each change.
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      saveProject(projectRef.current).catch((e) => setStatus(`Autosave failed: ${(e as Error).message}`));
    }, 400);
    return () => clearTimeout(timer);
  }, [project, ready]);

  const commit = useCallback((next: Project, before?: Project) => {
    const base = before ?? projectRef.current;
    if (next === base) {
      if (next !== projectRef.current) setProject(next);
      return;
    }
    history.current.record(base, next);
    projectRef.current = next;
    setProject(next);
    setTick((t) => t + 1);
  }, []);

  const preview = useCallback((next: Project) => {
    projectRef.current = next;
    setProject(next);
  }, []);

  const undo = useCallback(() => {
    const prev = history.current.undo(projectRef.current);
    if (prev) {
      projectRef.current = prev;
      setProject(prev);
      setTick((t) => t + 1);
    }
  }, []);

  const redo = useCallback(() => {
    const next = history.current.redo(projectRef.current);
    if (next) {
      projectRef.current = next;
      setProject(next);
      setTick((t) => t + 1);
    }
  }, []);

  const importOne = useCallback(
    async (file: File, hints?: MediaHints) => {
      setStatus(`Importing ${file.name}…`);
      const media = await probeMedia(file, undefined, hints);
      await putMediaBlob(media.id, file);
      await loadSource(media, file);
      return media;
    },
    [loadSource],
  );

  const importRecording = useCallback(
    async (file: File, hints: MediaHints) => {
      const media = await importOne(file, hints);
      commit(addMedia(projectRef.current, media));
      setSourcesVersion((v) => v + 1);
      setStatus(`Recorded ${file.name}`);
      return media;
    },
    [commit, importOne],
  );

  const importFiles = useCallback(
    async (files: Iterable<File>, options?: { descriptions?: ReadonlyMap<File, string> }) => {
      const added: MediaItem[] = [];
      const errors: string[] = [];
      let next = projectRef.current;
      for (const file of files) {
        try {
          const imported = await importOne(file);
          const description = options?.descriptions?.get(file)?.slice(0, MAX_DESCRIPTION_CHARS);
          const media = description?.trim() ? { ...imported, description } : imported;
          next = addMedia(next, media);
          added.push(media);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      if (added.length) {
        commit(next);
        setSourcesVersion((v) => v + 1);
      }
      setStatus(
        errors.length
          ? `Could not import: ${errors.join('; ')}`
          : added.length
            ? `Imported ${added.length} item${added.length > 1 ? 's' : ''}`
            : 'Nothing to import',
      );
      return added;
    },
    [commit, importOne],
  );

  const deleteMedia = useCallback(
    async (mediaId: string) => {
      commit(removeMedia(projectRef.current, mediaId));
      // Bytes stay in storage while undo could bring the media back; they are removed with
      // the project they belong to (see newProject).
      setStatus('Media removed');
    },
    [commit],
  );

  const releaseSources = useCallback(() => {
    for (const u of urls.current.values()) URL.revokeObjectURL(u);
    for (const b of bitmaps.current.values()) b.close();
    urls.current.clear();
    bitmaps.current.clear();
    blobs.current.clear();
  }, []);

  const openProject = useCallback(
    async (next: Project): Promise<string[]> => {
      const old = projectRef.current;
      // From here on the autosave timer and getProject() see the new project, so the one being left
      // is never written again by a timer that was already pending.
      projectRef.current = next;
      if (old.id !== next.id) {
        try {
          if (isEmptyProject(old)) await deleteProject(old);
          else await saveProject(old, { markLast: false });
        } catch (e) {
          setStatus(`Could not save ${old.name} before switching: ${(e as Error).message}`);
        }
      }
      history.current.clear();
      releaseSources();
      const missing: string[] = [];
      for (const m of next.media) if (!(await loadSource(m))) missing.push(m.name);
      setProject(next);
      setSelection([]);
      setSourcesVersion((v) => v + 1);
      try {
        await saveProject(next);
      } catch (e) {
        setStatus(`Could not save ${next.name}: ${(e as Error).message}`);
      }
      setStatus(missing.length ? `Opened ${next.name}. Media not found in this browser: ${missing.join(', ')}` : `Opened ${next.name}`);
      return missing;
    },
    [loadSource, releaseSources],
  );

  const newProject = useCallback(() => {
    void openProject(createProject()).then(() => setStatus('New project'));
  }, [openProject]);

  const replaceProject = useCallback(
    (p: Project) => {
      history.current.clear();
      projectRef.current = p;
      setProject(p);
      setSelection([]);
      void (async () => {
        for (const m of p.media) await loadSource(m);
        setSourcesVersion((v) => v + 1);
      })();
    },
    [loadSource],
  );

  const sources = useMemo<MediaSources>(
    () => ({
      url: (id) => urls.current.get(id) ?? null,
      bitmap: (id) => bitmaps.current.get(id) ?? null,
      blob: async (id) => blobs.current.get(id) ?? (await getMediaBlob(id)),
    }),
    [],
  );

  const getProject = useCallback(() => projectRef.current, []);

  return {
    project,
    getProject,
    ready,
    selection,
    setSelection,
    commit,
    preview,
    undo,
    redo,
    canUndo: history.current.canUndo,
    canRedo: history.current.canRedo,
    importFiles,
    importRecording,
    deleteMedia,
    newProject,
    replaceProject,
    openProject,
    sources,
    sourcesVersion,
    status,
    setStatus,
  };
}
