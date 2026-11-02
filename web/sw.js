const CACHE = 'quest-maker-shell-v16';
const SHELL = ['./', './index.html', './register-sw.js?v=16', './styles.css?v=16', './app.js?v=16', './domain.js', './list-view.js', './recurrence.js', './storage.js',
  './manifest.webmanifest', './assets/icon.svg', './assets/guide.png', './assets/icon-192.png', './assets/icon-512.png',
  './config.js', './cloud.js', './sync.js', './vendor/supabase-2.118.0.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(path => new Request(path, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('quest-maker-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

async function networkOrCache(request, cacheKey = request) {
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok) {
      try {
        const cache = await caches.open(CACHE);
        await cache.put(cacheKey, response.clone());
      } catch { /* A full cache must not prevent online use. */ }
    }
    return response;
  } catch (error) {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(cacheKey);
    if (saved) return saved;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const index = new URL('./index.html', self.location.href);
  const appNavigation = event.request.mode === 'navigate' &&
    (url.pathname === index.pathname || url.pathname === new URL('./', self.location.href).pathname);
  if (appNavigation) {
    event.respondWith(networkOrCache(event.request, index.href));
  } else if (SHELL.some(path => new URL(path, self.location.href).href === url.href)) {
    event.respondWith(networkOrCache(event.request));
  }
});
