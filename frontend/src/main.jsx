import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { registerServiceWorker, captureInstallPrompt } from './utils/registerServiceWorker'

// Register the PWA service worker so the app shell loads offline.
// The install prompt is captured so the browser shows "Install App".
registerServiceWorker();
captureInstallPrompt();

// Global session-expiry detection:
// JWTs expire after 8 hours. Without this, an expired token made every API
// call fail silently (e.g. Sales History showing "No sales found"). Any 401
// from the API now dispatches a global event that AuthContext listens to,
// logging the user out and returning them to the login screen.
const originalFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await originalFetch(...args);
  try {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')) {
      window.dispatchEvent(new CustomEvent('pos:auth-expired'));
    }
  } catch (err) { /* never break the caller */ }
  return res;
};

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)