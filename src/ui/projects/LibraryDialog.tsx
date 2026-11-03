import { useCallback, useEffect, useRef, useState } from 'react';
import { probeMedia } from '../../engine/media';
import { deleteLibraryAsset, getLibraryBlob, type LibraryAsset, listLibrary, putLibraryAsset } from '../../engine/storage';
import { bytes, shortDuration } from '../format';
import { Icon } from '../icons';
import type { Editor } from '../useEditor';
import { DialogFrame } from './DialogFrame';

/** Library assets are meant to be images, audio and short clips; very large files belong in a project. */
export const LIBRARY_MAX_ASSET_BYTES = 300 * 1024 * 1024;

const KIND_ICON = { video: 'film', audio: 'wave', image: 'image' } as const;

export function LibraryDialog({ editor, onClose }: { editor: Editor; onClose(): void }) {
  const [assets, setAssets] = useState<LibraryAsset[] | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setAssets(await listLibrary());
    } catch (e) {
      setError(`Could not read the library: ${(e as Error).message}`);
      setAssets([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (work: () => Promise<string | void>) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const text = await work();
      if (text) setNote(text);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addFiles = (files: File[]) =>
    run(async () => {
      let added = 0;
      const problems: string[] = [];
      for (const file of files) {
        if (file.size > LIBRARY_MAX_ASSET_BYTES) {
          problems.push(`${file.name} is over ${bytes(LIBRARY_MAX_ASSET_BYTES)}`);
          continue;
        }
        try {
          const meta = await probeMedia(file);
          await putLibraryAsset(meta, file);
          added++;
        } catch (e) {
          problems.push(`${file.name}: ${(e as Error).message}`);
        }
      }
      if (problems.length) throw new Error(`Could not add ${problems.join('; ')}${added ? `. ${added} added.` : ''}`);
      return `Added ${added} file${added === 1 ? '' : 's'} to the library`;
    });

  const saveFromProject = (id: string) =>
    run(async () => {
      const media = editor.getProject().media.find((m) => m.id === id);
      const blob = media ? await editor.sources.blob(id) : null;
      if (!media || !blob) throw new Error('That media is not stored in this browser, so it cannot be saved to the library.');
      if (blob.size > LIBRARY_MAX_ASSET_BYTES) throw new Error(`${media.name} is over ${bytes(LIBRARY_MAX_ASSET_BYTES)}; the library is for images, audio and short clips.`);
      await putLibraryAsset(media, blob);
      return `Saved ${media.name} to the library`;
    });

  const addToProject = (asset: LibraryAsset) =>
    run(async () => {
      const blob = await getLibraryBlob(asset.meta.id);
      if (!blob) throw new Error(`${asset.meta.name} is no longer stored in this browser.`);
      const added = await editor.importFiles([new File([blob], asset.meta.name, { type: asset.meta.mime || blob.type })]);
      if (!added.length) throw new Error(`${asset.meta.name} could not be added to the project.`);
      return `Added ${asset.meta.name} to the project's media bin`;
    });

  const remove = (asset: LibraryAsset) => {
    if (!window.confirm(`Remove ${asset.meta.name} from the library? Projects that already use it keep their own copy.`)) return;
    void run(async () => {
      await deleteLibraryAsset(asset.meta.id);
      return `Removed ${asset.meta.name} from the library`;
    });
  };

  // An asset added to a project gets a new media id, so match on what the file is.
  const savedKeys = new Set((assets ?? []).map((a) => `${a.meta.name}|${a.meta.bytes}`));
  const inLibrary = { has: (m: { name: string; bytes: number }) => savedKeys.has(`${m.name}|${m.bytes}`) };
  const projectMedia = editor.project.media;

  return (
    <DialogFrame title="Library" titleId="library-title" onClose={onClose}>
      <p className="modal-text">Logos, music, stings and short clips you reuse. The library belongs to no project, so it is still here after New project, and any asset can be added to any project.</p>
      <div className="pp-bar">
        <button className="button" data-action="capstan.library.add" disabled={busy} aria-disabled={busy} onClick={() => input.current?.click()}>
          <Icon name="import" />
          Add files…
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Add files to the library"
          accept="video/*,audio/*,image/*"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) void addFiles(files);
          }}
        />
      </div>
      {assets === null ? (
        <p className="hint">Loading…</p>
      ) : assets.length === 0 ? (
        <p className="hint">The library is empty. Add files above, or save media from this project below.</p>
      ) : (
        <ul className="pp-list" aria-label="Library assets">
          {assets.map((a) => (
            <li key={a.meta.id} className="pp-item" data-asset-id={a.meta.id}>
              <div className={`pp-thumb kind-${a.meta.kind}`}>{a.meta.thumb ? <img src={a.meta.thumb} alt="" /> : <Icon name={KIND_ICON[a.meta.kind]} size={20} />}</div>
              <div className="pp-main">
                <span className="pp-name" title={a.meta.name}>
                  {a.meta.name}
                </span>
                <span className="pp-sub">
                  {a.meta.kind === 'audio' ? 'Audio' : `${a.meta.width}×${a.meta.height}`}
                  {a.meta.kind !== 'image' ? ` · ${shortDuration(a.meta.duration)}` : ''} · {bytes(a.meta.bytes)}
                </span>
              </div>
              <div className="pp-actions">
                <button className="button primary" data-action="capstan.library.use" disabled={busy} aria-disabled={busy} aria-label={`Add ${a.meta.name} to this project`} onClick={() => void addToProject(a)}>
                  Add to project
                </button>
                <button className="button" data-action="capstan.library.remove" disabled={busy} aria-disabled={busy} aria-label={`Remove ${a.meta.name} from the library`} onClick={() => remove(a)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="lib-proj-h" className="pp-section">
        <h3 id="lib-proj-h">Save from this project</h3>
        {projectMedia.length === 0 ? (
          <p className="hint">This project has no media yet.</p>
        ) : (
          <ul className="pp-list compact" aria-label="Project media">
            {projectMedia.map((m) => (
              <li key={m.id} className="pp-item">
                <div className="pp-main">
                  <span className="pp-name" title={m.name}>
                    {m.name}
                  </span>
                  <span className="pp-sub">{bytes(m.bytes)}</span>
                </div>
                <div className="pp-actions">
                  <button className="button" data-action="capstan.library.save" disabled={busy || inLibrary.has(m)} aria-disabled={busy || inLibrary.has(m)} aria-label={`Save ${m.name} to the library`} onClick={() => void saveFromProject(m.id)}>
                    {inLibrary.has(m) ? 'In library' : 'Save to library'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {note && (
        <p className="success" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </DialogFrame>
  );
}
