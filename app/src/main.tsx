import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/manrope';
import './styles/tokens.css';
import App from './App';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// New version handling: the service worker updates in the background; as soon as the new one takes over,
// reload once so nobody keeps working on an old screen. Also check for updates every 15 minutes and on return.
if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) return; reloading = true; window.location.reload(); });
  const check = () => navigator.serviceWorker.getRegistration().then((r) => r?.update()).catch(() => undefined);
  window.addEventListener('load', () => { check(); setInterval(check, 15 * 60 * 1000); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
}
