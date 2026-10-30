// Project-level actions behind the Project menu: save and open packages, open any project file, and
// import a SnapShackle captures folder. UI-free so the dialogs and the Welcome view can share them.
import { PACKAGE_EXT, PackageError, looksLikeZip, readPackage, writePackage } from '../../engine/package';
import { type Project, parseProject } from '../../engine/project';
import { cloneProject, copyName } from '../../engine/projects';
import { collectCaptureFiles, snapshackleSupported, type DirHandleLike } from '../../engine/snapshackle';
import { BlobSink, type ZipSink } from '../../engine/zip';
import { deleteMediaBlob, listProjects, loadProject, putMediaBlob, saveProject } from '../../engine/storage';
import { bytes as formatBytes, download, safeFileName } from '../format';
import type { Editor } from '../useEditor';

declare const __CAPSTAN_VERSION__: string;

interface WritableLike {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
interface SaveHandleLike {
  createWritable(): Promise<WritableLike>;
}
type SavePicker = (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<SaveHandleLike>;
type DirPicker = (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<DirHandleLike>;

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function packageFileName(project: Project): string {
  return `${safeFileName(project.name)}${PACKAGE_EXT}`;
}

/**
 * Saves the open project and all its media as a .capstanz. Where the browser offers a save dialog
 * (Edge, Chrome) the package streams straight to the chosen file, so a large project is never held in
 * memory; otherwise it is built as a Blob and downloaded.
 */
export async function savePackage(editor: Editor): Promise<void> {
  const project = editor.getProject();
  const name = packageFileName(project);
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  let writable: WritableLike | null = null;
  if (picker) {
    try {
      const handle = await picker.call(window, {
        suggestedName: name,
        types: [{ description: 'Capstan project package', accept: { 'application/zip': [PACKAGE_EXT] } }],
      });
      writable = await handle.createWritable();
    } catch (e) {
      if (isAbort(e)) {
        editor.setStatus('Save cancelled');
        return;
      }
      writable = null; // the picker is blocked here: fall back to a download
    }
  }
  let lastReport = 0;
  const onProgress = (done: number, total: number, file: string) => {
    const now = performance.now();
    if (now - lastReport < 200) return;
    lastReport = now;
    editor.setStatus(`Packing ${file.replace(/^media\//, '')}: ${formatBytes(done)} of ${formatBytes(total)}`);
  };
  const blobSink = new BlobSink();
  const sink: ZipSink = writable ? { write: (c) => writable!.write(c) } : blobSink;
  editor.setStatus('Packing project…');
  try {
    const result = await writePackage(project, (id) => editor.sources.blob(id), sink, {
      appVersion: typeof __CAPSTAN_VERSION__ === 'string' ? __CAPSTAN_VERSION__ : '',
      onProgress,
    });
    if (writable) await writable.close();
    else download(blobSink.blob(), name);
    editor.setStatus(`Saved ${name} (${formatBytes(result.bytes)}, ${project.media.length} media file${project.media.length === 1 ? '' : 's'}). It opens on any computer with Capstan.`);
  } catch (e) {
    if (writable) await writable.abort?.().catch(() => undefined);
    editor.setStatus(`Could not save the package: ${message(e)}`);
    throw e;
  }
}

/** Opens a .capstanz: verifies all of it, stores the media, then opens the project. */
export async function openPackageFile(editor: Editor, file: File): Promise<void> {
  editor.setStatus(`Reading ${file.name}…`);
  let opened;
  try {
    opened = await readPackage(file);
  } catch (e) {
    editor.setStatus(`Could not open ${file.name}: ${message(e)}`);
    throw e;
  }
  let { project } = opened;
  let blobs = opened.blobs;
  let note = '';
  // Never overwrite a project that is already here: a package of it opens as a copy.
  const stored = await loadProject(project.id).catch(() => null);
  if (stored || editor.getProject().id === project.id) {
    const names = (await listProjects().catch(() => [])).map((p) => p.project.name);
    const clone = cloneProject(project, copyName(project.name, names));
    blobs = new Map([...clone.idMap].map(([from, to]) => [to, opened.blobs.get(from) as Blob]));
    project = clone.project;
    note = ' (this project already exists here, so it opened as a copy)';
  }
  const written: string[] = [];
  try {
    for (const [id, blob] of blobs) {
      await putMediaBlob(id, blob);
      written.push(id);
    }
    await saveProject(project, { markLast: false });
  } catch (e) {
    for (const id of written) await deleteMediaBlob(id).catch(() => undefined);
    const text = `Could not store the package's media in this browser (${message(e)}). Free some space and try again.`;
    editor.setStatus(text);
    throw new PackageError(text);
  }
  await editor.openProject(project);
  editor.setStatus(`Opened ${project.name} from ${file.name}${note}`);
}

/** Opens a project file of either kind: a .capstanz package, or a plain .capstan (project only). */
export async function openAnyProjectFile(editor: Editor, file: File): Promise<void> {
  try {
    if (await looksLikeZip(file)) {
      await openPackageFile(editor, file);
      return;
    }
    const project = parseProject(JSON.parse(await file.text()));
    const missing = await editor.openProject(project);
    if (missing.length) {
      editor.setStatus(`Opened ${project.name}, but ${missing.length} media file${missing.length === 1 ? ' is' : 's are'} not in this browser (${missing.slice(0, 3).join(', ')}). A .capstan file holds the edit only; use a .capstanz package to move media between computers.`);
    }
  } catch (e) {
    // openPackageFile has already said why.
    if (!(e instanceof PackageError)) editor.setStatus(`Could not open ${file.name}: ${message(e)}`);
  }
}

export function snapshackleAvailable(): boolean {
  return snapshackleSupported();
}

/** Lets the user pick a SnapShackle captures folder and imports the images and videos in it. */
export async function importSnapshackleCaptures(editor: Editor): Promise<void> {
  const picker = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;
  if (!picker) {
    editor.setStatus('This browser cannot open a folder. Use Edge or Chrome, or select the capture files with Import media.');
    return;
  }
  let dir: DirHandleLike;
  try {
    dir = await picker.call(window, { id: 'snapshackle-captures', mode: 'read' });
  } catch (e) {
    editor.setStatus(isAbort(e) ? 'Import cancelled' : `The browser would not open that folder (${message(e)}). Pick the Captures folder itself, or select the files with Import media.`);
    return;
  }
  editor.setStatus(`Reading ${dir.name}…`);
  try {
    const scan = await collectCaptureFiles(dir);
    if (!scan.files.length) {
      editor.setStatus(`No images or videos found in ${dir.name}`);
      return;
    }
    const added = await editor.importFiles(scan.files);
    editor.setStatus(
      `Imported ${added.length} of ${scan.files.length} capture${scan.files.length === 1 ? '' : 's'} from ${dir.name}` +
        (scan.skipped ? `; ${scan.skipped} older ones were left out (the limit is ${scan.files.length} at a time)` : ''),
    );
  } catch (e) {
    editor.setStatus(`Could not read ${dir.name}: ${message(e)}`);
  }
}
