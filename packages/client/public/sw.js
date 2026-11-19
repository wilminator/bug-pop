// Service worker: lets Bug Pop start with no network.
// Strategy: network first (so updates arrive right away), falling back to the
// last copy we saw. Everything same-origin is cached as it is fetched.
const CACHE = 'bugpop-v2';

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', './index.html', './manifest.webmanifest'])));
});

self.addEventListener('activate', event => {
  // Drop caches from older versions of this file.
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
  // Then, in the background, fetch every file the game could need (all music and sounds
  // included), so the first offline play is complete even for things not used yet.
  fillCache();
});

// precache.json is written by the build (vite.config.ts; the official site's build rewrites it
// after adding its own files). Files already in the cache are skipped, one file at a time so a
// phone on mobile data isn't flooded. Best effort: anything missed is cached when first used.
async function fillCache() {
  try {
    const res = await fetch('./precache.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const { files } = await res.json();
    const cache = await caches.open(CACHE);
    for (const file of files) {
      const url = new URL(file, self.registration.scope).href;
      if (await cache.match(url)) continue;
      const got = await fetch(url, { cache: 'no-cache' }).catch(() => null);
      if (got && got.ok && got.status === 200) await cache.put(url, got);
    }
  } catch { /* offline or no list: the fetch handler below still caches as files are used */ }
}

// cache: 'no-cache' makes the browser re-check with the server instead of trusting its own
// HTTP cache. Hashed files in assets/ never change under the same name, so they skip that.
function fresh(req, url) {
  if (url.pathname.includes('/assets/')) return fetch(req);
  // A navigation request can't be copied with new options, so fetch its URL instead.
  return req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(req, { cache: 'no-cache' });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // The version check must always reach the network, never a cached answer.
  if (url.pathname.endsWith('/version.json')) return;
  event.respondWith(
    fresh(req, url)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))),
  );
});
