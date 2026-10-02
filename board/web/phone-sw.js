// Phone control service worker (served at /phone/sw.js, scope /phone/).
// It caches ONLY the static app shell below, so the app opens offline and
// says so. It never touches /api/ or /auth/ requests, anything that is not
// a GET, or any other path: those go straight to the network, uncached.
// Shell files are network-first (the hub serves them no-cache + ETag), so a
// deploy is picked up on the next online load.
const CACHE = 'plexiform-phone-v1';
const SHELL = [
  '/phone/', '/phone/manifest.webmanifest', '/web/phone.css', '/web/phone-icon-192.png', '/web/phone-icon-512.png',
  '/web/js/phone-app.js', '/web/js/phone-core.js', '/web/js/phone-render.js', '/web/js/phone-vault.js', '/web/js/h.js',
];

function shellPath(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search) return null;
  return SHELL.includes(url.pathname) ? url.pathname : null;
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); // privacy-flow: phone-control
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('plexiform-phone-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const path = shellPath(e.request);
  if (!path) return; // not ours: the browser fetches it normally, nothing is cached
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request, { cache: 'no-cache' }); // privacy-flow: phone-control
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then((c) => c.put(path, copy)));
      }
      return res;
    } catch {
      const hit = await caches.match(path);
      if (hit) return hit;
      throw new Error('offline');
    }
  })());
});
