const CACHE = 'quest-maker-shell-v13';
const SHELL = ['./', './index.html', './register-sw.js', './styles.css', './app.js', './domain.js', './storage.js',
  './manifest.webmanifest', './assets/icon.svg', './assets/guide.png', './assets/icon-192.png', './assets/icon-512.png',
  './config.js', './cloud.js', './sync.js', './vendor/supabase-2.118.0.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(path => new Request(path, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('quest-maker-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(new URL('./index.html', self.location.href))));
  } else if (SHELL.some(path => new URL(path, self.location.href).href === url.href)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
