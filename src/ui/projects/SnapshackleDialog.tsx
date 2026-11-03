import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type CaptureList,
  HOST_IMPORT_MAX,
  HostCaptureError,
  type HostCapture,
  fetchCaptureBlob,
  fetchCaptureList,
  filterCaptures,
  firstOcrLine,
  loadCaptureFiles,
} from '../../engine/snapshackleHost';
import { bytes } from '../format';
import { Icon } from '../icons';
import { sessionToken } from '../lifecycle';
import type { Editor } from '../useEditor';
import { DialogFrame } from './DialogFrame';

/**
 * Small pictures for the list. The host wants the session token in a header, which an <img src> cannot
 * send, so each picture is fetched, shrunk and shown from a blob URL. Three at a time, only for rows
 * that scroll into view, and everything is released when the dialog closes.
 */
class ThumbLoader {
  private urls = new Map<string, string>();
  private waiting: Array<() => void> = [];
  private running = 0;
  private readonly abort = new AbortController();
  constructor(private readonly token: string) {}

  get(name: string): Promise<string | null> {
    return new Promise((resolve) => {
      const start = () => {
        this.running++;
        this.make(name)
          .then(resolve, () => resolve(null))
          .finally(() => {
            this.running--;
            this.waiting.shift()?.();
          });
      };
      if (this.abort.signal.aborted) resolve(null);
      else if (this.running < 3) start();
      else this.waiting.push(start);
    });
  }

  private async make(name: string): Promise<string | null> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const blob = await fetchCaptureBlob(name, this.token, fetch, this.abort.signal);
    let url: string;
    try {
      const bitmap = await createImageBitmap(blob);
      const k = Math.min(1, 160 / bitmap.width, 100 / bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * k));
      canvas.height = Math.max(1, Math.round(bitmap.height * k));
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const small = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75));
      url = URL.createObjectURL(small ?? blob);
    } catch {
      url = URL.createObjectURL(blob);
    }
    if (this.abort.signal.aborted) {
      URL.revokeObjectURL(url);
      return null;
    }
    this.urls.set(name, url);
    return url;
  }

  dispose() {
    this.abort.abort();
    this.waiting = [];
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
  }
}

function Thumb({ capture, loader }: { capture: HostCapture; loader: ThumbLoader }) {
  const box = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (capture.kind !== 'image' || !box.current) return;
    let live = true;
    const watcher = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      watcher.disconnect();
      void loader.get(capture.name).then((u) => live && setUrl(u));
    });
    watcher.observe(box.current);
    return () => {
      live = false;
      watcher.disconnect();
    };
  }, [capture.kind, capture.name, loader]);
  return (
    <div ref={box} className={`pp-thumb kind-${capture.kind}`}>
      {url ? <img src={url} alt="" /> : <Icon name={capture.kind === 'video' ? 'film' : 'image'} size={20} />}
    </div>
  );
}

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};

type Load = { phase: 'loading' } | { phase: 'error'; message: string; noFolder: boolean } | { phase: 'ready'; list: CaptureList };

/**
 * The list of SnapShackle captures the host reads from the Captures folder: newest first, a search
 * box over names and OCR text, several can be ticked and are imported with their OCR text.
 */
export function SnapshackleDialog({ editor, onClose, onPickFolder }: { editor: Editor; onClose(): void; onPickFolder(): void }) {
  const token = useMemo(() => sessionToken(), []);
  const loader = useMemo(() => new ThumbLoader(token), [token]);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  const abort = useRef(new AbortController());

  useEffect(() => {
    const ac = new AbortController();
    abort.current = ac;
    fetchCaptureList(token, fetch, ac.signal).then(
      (list) => setLoad({ phase: 'ready', list }),
      (e: unknown) => {
        if ((e as { name?: string }).name === 'AbortError') return;
        setLoad({ phase: 'error', message: (e as Error).message, noFolder: e instanceof HostCaptureError && e.code === 'no-folder' });
      },
    );
    return () => {
      ac.abort();
      loader.dispose();
    };
  }, [token, loader]);

  const list = load.phase === 'ready' ? load.list : null;
  const shown = useMemo(() => (list ? filterCaptures(list.captures, query) : []), [list, query]);

  const toggle = (name: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else if (next.size < HOST_IMPORT_MAX) next.add(name);
      return next;
    });

  const importPicked = async () => {
    if (!list || !picked.size || busy) return;
    const chosen = list.captures.filter((c) => picked.has(c.name));
    setProblem('');
    setBusy('Reading captures…');
    try {
      const loaded = await loadCaptureFiles(chosen, token, fetch, abort.current.signal, (done, total, name) => {
        setBusy(`Reading ${done + 1} of ${total}: ${name}`);
      });
      let added = 0;
      if (loaded.files.length) added = (await editor.importFiles(loaded.files, { descriptions: loaded.descriptions })).length;
      const failed = loaded.failed.map((f) => `${f.name} (${f.reason})`);
      const unreadable = loaded.files.length - added;
      if (!failed.length && !unreadable) {
        editor.setStatus(`Imported ${added} SnapShackle capture${added === 1 ? '' : 's'}${chosen.some((c) => c.hasOcr) ? ' with their OCR text' : ''}`);
        onClose();
        return;
      }
      const text = [
        failed.length ? `Could not read ${failed.join('; ')}.` : '',
        unreadable ? `${unreadable} file${unreadable === 1 ? ' was' : 's were'} read but could not be added to the project.` : '',
      ]
        .filter(Boolean)
        .join(' ');
      editor.setStatus(`Imported ${added} of ${chosen.length} SnapShackle captures. ${text}`);
      setProblem(`${added ? `Imported ${added} of ${chosen.length}. ` : ''}${text}`);
      // What went in is done; what failed stays ticked so it can be tried again.
      const failedNames = new Set(loaded.failed.map((f) => f.name));
      setPicked(new Set([...picked].filter((n) => failedNames.has(n))));
    } catch (e) {
      if ((e as { name?: string }).name !== 'AbortError') setProblem(`Could not import: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  };

  return (
    <DialogFrame title="Import SnapShackle captures" titleId="snap-title" onClose={onClose}>
      <p className="modal-text">
        Your newest screenshots and recordings from the SnapShackle Captures folder, with the text SnapShackle found in them. Capstan only reads that folder; nothing is changed or sent anywhere.
      </p>
      {load.phase === 'loading' && <p className="hint" role="status">Reading the Captures folder…</p>}
      {load.phase === 'error' && (
        <>
          <p className="error" role="alert">
            {load.message}
            {load.noFolder ? ' Looked for SnapShackle, CutterMk and Lasso under your local app data.' : ''}
          </p>
          <div className="pp-bar">
            <button className="button" onClick={onPickFolder}>
              <Icon name="import" />
              Choose a folder by hand…
            </button>
          </div>
        </>
      )}
      {list && list.captures.length === 0 && (
        <>
          <p className="hint" role="status">
            There is nothing in the SnapShackle Captures folder yet. Take a screenshot with SnapShackle and it shows up here.
          </p>
          <div className="pp-bar">
            <button className="button" onClick={onPickFolder}>
              <Icon name="import" />
              Choose another folder…
            </button>
          </div>
        </>
      )}
      {list && list.captures.length > 0 && (
        <>
          <div className="pp-bar snap-bar">
            <input
              type="search"
              className="snap-search"
              aria-label="Search captures by name or text"
              placeholder="Search names and text in the pictures"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              className="button"
              disabled={!shown.length || !!busy}
              onClick={() =>
                setPicked((prev) => {
                  const next = new Set(prev);
                  for (const c of shown) if (next.size < HOST_IMPORT_MAX) next.add(c.name);
                  return next;
                })
              }
            >
              Tick shown
            </button>
            <button className="button" disabled={!picked.size || !!busy} onClick={() => setPicked(new Set())}>
              Clear
            </button>
          </div>
          <p className="hint snap-count" role="status">
            {shown.length === list.captures.length ? `${list.captures.length} captures` : `${shown.length} of ${list.captures.length} match`}
            {list.total > list.captures.length ? ` (the folder holds ${list.total}; the newest ${list.captures.length} are listed)` : ''}
            {` · ${picked.size} ticked (up to ${HOST_IMPORT_MAX} at a time)`}
          </p>
          {shown.length === 0 ? (
            <p className="hint">No capture matches &ldquo;{query}&rdquo;.</p>
          ) : (
            <ul className="pp-list snap-list" aria-label="SnapShackle captures">
              {shown.map((c) => {
                const checked = picked.has(c.name);
                const line = firstOcrLine(c.ocr);
                return (
                  <li key={c.name} className="pp-item snap-item" data-capture={c.name}>
                    <label className="snap-row">
                      <input type="checkbox" checked={checked} disabled={!!busy || (!checked && picked.size >= HOST_IMPORT_MAX)} onChange={() => toggle(c.name)} />
                      <Thumb capture={c} loader={loader} />
                      <span className="pp-main">
                        <span className="pp-name" title={c.name}>
                          {c.name}
                        </span>
                        <span className="pp-sub">
                          {c.kind === 'video' ? 'Video' : 'Image'} · {when(c.modified)} · {bytes(c.size)}
                        </span>
                        {line && <span className="pp-sub snap-ocr">{line}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {busy && (
        <p className="hint" role="status">
          {busy}
        </p>
      )}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="modal-actions">
        <button className="button" onClick={onClose}>
          Cancel
        </button>
        <button className="button primary" data-action="capstan.media.import-captures" disabled={!picked.size || !!busy} aria-disabled={!picked.size || !!busy} onClick={() => void importPicked()}>
          {picked.size ? `Import ${picked.size} capture${picked.size === 1 ? '' : 's'}` : 'Import'}
        </button>
      </div>
    </DialogFrame>
  );
}
