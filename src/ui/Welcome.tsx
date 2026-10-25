import { Icon } from './icons';

/** The full Capstan emblem (assets/ui, from assets/brand/emblem-*.png), one per theme. */
export function Emblem({ size, className }: { size: number; className?: string }) {
  return (
    <>
      <img className={`only-light ${className ?? ''}`} src="/assets/emblem-light.png" alt="Capstan" width={size} height={size} />
      <img className={`only-dark ${className ?? ''}`} src="/assets/emblem-dark.png" alt="Capstan" width={size} height={size} />
    </>
  );
}

/**
 * Landing view for an empty project (no media, no clips): the emblem large, one headline and the
 * three ways in (UNIFIED-UI 6, .fl-empty). It gives way to the editor as soon as there is media,
 * or when the viewer asks for the editor.
 */
export function Welcome({ onRecord, onImport, onOpen, onEditor }: { onRecord: () => void; onImport: () => void; onOpen: () => void; onEditor: () => void }) {
  return (
    <main className="welcome fl-empty" aria-labelledby="welcome-title">
      <Emblem size={360} className="welcome-emblem" />
      <h2 id="welcome-title">Haul in your footage.</h2>
      <p>Record your screen or bring in video, audio and images, then trim and arrange them on the timeline. Everything stays on this PC.</p>
      <div className="welcome-actions">
        <button className="button primary fl-btn fl-btn--primary fl-btn--lg" onClick={onRecord}>
          <Icon name="record" />
          Record screen
        </button>
        <button className="button fl-btn fl-btn--secondary fl-btn--lg" onClick={onImport}>
          <Icon name="import" />
          Import media
        </button>
        <button className="button fl-btn fl-btn--secondary fl-btn--lg" onClick={onOpen}>
          <Icon name="open" />
          Open project
        </button>
      </div>
      <button className="welcome-skip" onClick={onEditor}>
        Go to the editor
      </button>
      <p className="welcome-hint">You can also drop files anywhere in this window.</p>
    </main>
  );
}
