import { type ReactNode, useRef } from 'react';
import { Icon } from '../icons';
import { useModal } from '../shell';

/** The shared dialog shell for the Project dialogs: backdrop, focus trap, Esc, header with close. */
export function DialogFrame({ title, titleId, onClose, children }: { title: string; titleId: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div ref={ref} tabIndex={-1} className="modal modal-wide fl-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
