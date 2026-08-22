// Loyal Mobile POS - Service Worker
// Caches the app shell so the UI loads even when the internet is down.
// API requests are NEVER cached - only data/API calls should fail offline, never the app itself.

const CACHE_PREFIX = 'loyal-mobile-pos';
const APP_SHELL_CACHE = `${CACHE_PREFIX}-app-shell-v1`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-v1`;

// Static bundle files (JS/CSS/images/fonts) - these are hashed by Vite on build, so cache-first is safe
const STATIC_ASSET_PATTERN = /\.(js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|eot|map)(\?.*)?$/i;

self.addEventListener('install', (event) => {
  // Activate the new service worker immediately (no waiting on old tabs)
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== APP_SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only handle same-origin requests (API on Vercel is same-origin too, but we skip it below)
  if (url.origin !== self.location.origin) return;

  // Never cache API calls — the app must be able to see the network failure and respond locally
  if (url.pathname.startsWith('/api/')) return;

  // Navigation requests (HTML pages): network-first, fall back to cached index.html when offline
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(APP_SHELL_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches.match(request).then(
            (cached) => cached || caches.match('/index.html')
          )
        )
    );
    return;
  }

  // Static assets (JS/CSS/images): stale-while-revalidate.
  // On first visit these get cached; once cached they work instantly offline.
  if (STATIC_ASSET_PATTERN.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((response) => {
            if (response && response.ok && response.type === 'basic') {
              const copy = response.clone();
              caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
    return;
  }

  // Other same-origin assets (root /, manifest.json, favicon, etc.): cache fallback
  event.respondWith(
    caches.match(request).then((cached) =>
      cached ||
      fetch(request).then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached)
    )
  );
});

// Background Sync API — when the browser decides the network is back,
// tell all open tabs/top-level clients to attempt to push pending records.
self.addEventListener('sync', (event) => {
  if (event.tag === 'pos-sync') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then((clients) => {
          clients.forEach((client) => {
            client.postMessage({ type: 'POS_SYNC_TRIGGERED' });
          });
        })
    );
  }
});

// Manual sync request from a page (e.g. user clicks "Sync now")
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || !data.type) return;

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'REGISTER_SYNC') {
    self.registration.sync.register('pos-sync')
      .then(() => console.log('[SW] Background sync "pos-sync" registered'))
      .catch((err) => console.warn('[SW] Background sync registration failed (fallback will be used):', err));
  }
});