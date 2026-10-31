import { useEffect, useRef, useState } from 'react';
import { deleteUserTemplate, listUserTemplates, putUserTemplate } from '../../engine/storage';
import { BUILTIN_TEMPLATES, type ProjectTemplate, createTemplate, instantiateTemplate } from '../../engine/templates';
import { THEMES, type Theme, applyThemeToProject, themeFontStack } from '../../engine/themes';
import type { Editor } from '../useEditor';
import { DialogFrame } from './DialogFrame';

const FONT_LABEL: Record<string, string> = { ui: 'Segoe UI', display: 'Segoe UI Semibold', serif: 'Georgia', rounded: 'Trebuchet', mono: 'Consolas' };

function Swatches({ theme }: { theme: Theme }) {
  const c = theme.colors;
  return (
    <span className="pp-swatches" aria-hidden>
      {[c.background, c.surface, c.accent, c.highlight].map((hex, i) => (
        <span key={i} style={{ background: hex }} />
      ))}
    </span>
  );
}

export function TemplatesDialog({ editor, mode, onClose }: { editor: Editor; mode: 'new' | 'save'; onClose(): void }) {
  const [user, setUser] = useState<ProjectTemplate[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(`${editor.project.name} template`);
  const [description, setDescription] = useState('');
  const [saved, setSaved] = useState('');
  const saveRef = useRef<HTMLInputElement>(null);

  const refresh = () =>
    listUserTemplates()
      .then(setUser)
      .catch((e: Error) => setError(`Could not read saved templates: ${e.message}`));

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (mode === 'save') saveRef.current?.focus();
  }, [mode]);

  const useTemplate = async (t: ProjectTemplate) => {
    setBusy(true);
    setError('');
    try {
      const project = instantiateTemplate(t);
      await editor.openProject(project);
      editor.setStatus(`New project from ${t.name}`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const saveTemplate = async () => {
    setError('');
    setSaved('');
    try {
      const tpl = createTemplate(editor.getProject(), name, description);
      await putUserTemplate(tpl);
      setSaved(`Saved template ${tpl.name}`);
      editor.setStatus(`Saved template ${tpl.name}`);
      await refresh();
    } catch (e) {
      setError(`Could not save the template: ${(e as Error).message}`);
    }
  };

  const removeTemplate = async (t: ProjectTemplate) => {
    if (!window.confirm(`Delete the template ${t.name}? Projects made from it are not affected.`)) return;
    try {
      await deleteUserTemplate(t.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const applyTheme = (theme: Theme) => {
    editor.commit(applyThemeToProject(editor.getProject(), theme));
    editor.setStatus(`Applied the ${theme.name} theme`);
  };

  const card = (t: ProjectTemplate) => (
    <li key={t.id} className="pp-item" data-template-id={t.id}>
      <div className="pp-main">
        <span className="pp-name">{t.name}</span>
        {t.builtin && <span className="fl-badge pp-badge">Built in</span>}
        <span className="pp-sub">
          {t.body.width}×{t.body.height} · {t.body.fps} fps · {t.body.tracks.length} tracks{t.body.annotations.length ? ` · ${t.body.annotations.length} annotations` : ''}
        </span>
        {t.description && <span className="pp-sub">{t.description}</span>}
      </div>
      <div className="pp-actions">
        <button className="button primary" disabled={busy} aria-label={`New project from ${t.name}`} onClick={() => void useTemplate(t)}>
          New project
        </button>
        {!t.builtin && (
          <button className="button" aria-label={`Delete template ${t.name}`} onClick={() => void removeTemplate(t)}>
            Delete
          </button>
        )}
      </div>
    </li>
  );

  return (
    <DialogFrame title="Templates and themes" titleId="templates-title" onClose={onClose}>
      <section aria-labelledby="tpl-new-h" className="pp-section">
        <h3 id="tpl-new-h">Start a new project from a template</h3>
        <ul className="pp-list" aria-label="Templates">
          {BUILTIN_TEMPLATES.map(card)}
          {user.map(card)}
        </ul>
      </section>

      <section aria-labelledby="tpl-save-h" className="pp-section">
        <h3 id="tpl-save-h">Save this project as a template</h3>
        <p className="hint">Keeps the size, frame rate, background, track layout, annotations, zoom regions and markers. Media, clips and captions are left out.</p>
        <div className="pp-form">
          <label htmlFor="tpl-name">Template name</label>
          <input id="tpl-name" ref={saveRef} type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="tpl-desc">Description (optional)</label>
          <input id="tpl-desc" type="text" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
          <button className="button primary" disabled={!name.trim()} onClick={() => void saveTemplate()}>
            Save as template
          </button>
        </div>
        {saved && (
          <p className="success" role="status">
            {saved}
          </p>
        )}
      </section>

      <section aria-labelledby="tpl-theme-h" className="pp-section">
        <h3 id="tpl-theme-h">Themes</h3>
        <p className="hint">A theme is a set of colours and fonts. Applying one sets this project&apos;s canvas background now; annotations use the rest as their defaults.</p>
        <ul className="pp-themes" aria-label="Themes">
          {THEMES.map((theme) => (
            <li key={theme.id}>
              <button className="pp-theme" aria-label={`Apply the ${theme.name} theme`} onClick={() => applyTheme(theme)} data-theme-id={theme.id}>
                <Swatches theme={theme} />
                <span className="pp-name">{theme.name}</span>
                <span className="pp-sub" style={{ fontFamily: themeFontStack(theme, 'heading') }}>
                  {FONT_LABEL[theme.fonts.heading]} · {FONT_LABEL[theme.fonts.body]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

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
