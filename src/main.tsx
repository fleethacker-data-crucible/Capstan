import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { applyTheme, readTheme } from './ui/shell';

// Apply a remembered Night watch / Chart room choice before the first paint.
applyTheme(readTheme());

createRoot(document.getElementById('root')!).render(<App />);
