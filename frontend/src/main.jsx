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
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!url.startsWith('/api/')) return originalFetch(input, init);

  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  const token = localStorage.getItem('token');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  return originalFetch(input, { ...init, headers });
};

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)