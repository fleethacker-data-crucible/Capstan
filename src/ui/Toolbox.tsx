import { useState } from 'react';
import { MediaBin } from './MediaBin';
import { TOOLBOX_TABS } from './toolboxTabs';
import type { Editor } from './useEditor';

/** The left panel: the media bin, plus a tab for each feature area that has tools. */
export function Toolbox({ editor, time, onRecord, onSeek }: { editor: Editor; time: number; onRecord(): void; onSeek(t: number): void }) {
  const [active, setActive] = useState('media');
  if (TOOLBOX_TABS.length === 0) return <MediaBin editor={editor} time={time} onRecord={onRecord} />;
  const tab = TOOLBOX_TABS.find((t) => t.id === active);
  return (
    <div className="toolbox">
      <div className="toolbox-tabs" role="tablist" aria-label="Tools">
        {[{ id: 'media', label: 'Media' }, ...TOOLBOX_TABS].map((t) => (
          <button key={t.id} role="tab" aria-selected={active === t.id} className={`toolbox-tab${active === t.id ? ' on' : ''}`} onClick={() => setActive(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab ? <tab.Panel editor={editor} time={time} onSeek={onSeek} /> : <MediaBin editor={editor} time={time} onRecord={onRecord} />}
    </div>
  );
}
