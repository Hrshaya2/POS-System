// Registers the PWA service worker and handles install prompt events.

export const registerServiceWorker = async () => {
  if (!('serviceWorker' in navigator)) {
    console.warn('[PWA] Service Worker not supported in this browser.');
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/'
    });
    console.log('[PWA] Service Worker registered:', registration.scope);
    return registration;
  } catch (err) {
    console.error('[PWA] Service Worker registration failed:', err);
    return null;
  }
};

// Captures the browser's beforeinstallprompt event so we can show a custom
// "Install App" button in the UI if desired.
let deferredInstallPrompt = null;

export const captureInstallPrompt = () => {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });
};

export const promptInstallApp = async () => {
  if (!deferredInstallPrompt) return false;
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  return choice.outcome === 'accepted';
};