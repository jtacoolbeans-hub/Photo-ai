/* Service worker: lets the app open fast and work from the home screen.
 * "Network first": every time you open the app it fetches the newest version
 * from GitHub; it only falls back to the saved copy if there's no internet.
 * So updates arrive just by reopening the app. */
const CACHE = 'card-assistant-v1';
const SHELL = ['app.html', 'app.js', 'log.html', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return; // Worker calls go straight out
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
      .catch(() => caches.match(req).then((r) => r || caches.match('app.html')))
  );
});
