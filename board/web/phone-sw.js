// Phone control service worker (served at /phone/sw.js, scope /phone/).
// It caches ONLY the static app shell below, so the app opens offline and
// says so. It never touches /api/ or /auth/ requests, anything that is not
// a GET, or any other path: those go straight to the network, uncached.
// Shell files are network-first (the hub serves them no-cache + ETag), so a
// deploy is picked up on the next online load.
//
// Push (W2-B, board/hub/push.js): the hub sends an EMPTY push. This worker
// never reads a payload: it shows a fixed "needs you" notification, and a
// tap opens the approvals screen, which fetches what is waiting through the
// end-to-end relay. Nothing about the request is in the push.
const CACHE = 'plexiform-phone-v3';
const SHELL = [
  '/phone/', '/phone/manifest.webmanifest', '/web/phone.css', '/web/phone-icon-192.png', '/web/phone-icon-512.png',
  '/web/js/phone-app.js', '/web/js/phone-core.js', '/web/js/phone-render.js', '/web/js/phone-vault.js', '/web/js/phone-e2e.js', '/web/js/h.js',
  '/web/js/phone-approvals.js', '/web/js/remote/encoding.js', '/web/js/remote/canonical.js', '/web/js/remote/envelope.js',
  '/web/js/remote/keys.js', '/web/js/remote/registry.js', '/web/js/remote/decision.js', '/web/js/remote/pairing.js',
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

// Content-free: whatever a push carries is ignored.
self.addEventListener('push', (e) => {
  e.waitUntil(self.registration.showNotification('Plexiform', {
    body: 'Something on your computer needs you.', tag: 'plexiform-needs-you', renotify: true,
    icon: '/web/phone-icon-192.png', badge: '/web/phone-icon-192.png',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((w) => new URL(w.url).pathname.startsWith('/phone/'));
    if (open) { open.postMessage({ type: 'plexiform-open-approvals' }); return open.focus(); }
    return self.clients.openWindow('/phone/#approvals');
  })());
});
