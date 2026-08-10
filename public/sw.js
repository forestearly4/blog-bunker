// Blog Bunker Service Worker
// Caches the app shell for offline use and fast loading

const CACHE_NAME = "blog-bunker-v2";
const SHELL = ["/", "/index.html"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // Never intercept GCS upload/download requests. Large binary PUT bodies
  // (resumable uploads) don't reliably survive being re-fetched through a
  // service worker's fetch handler — a known browser limitation — which was
  // silently converting every real upload attempt into a fake, synthetic
  // "Offline" 503 response below (with no real CORS headers, since it never
  // actually came from GCS at all). Not touching these lets the browser
  // handle them completely natively, exactly like a plain page without any
  // service worker would.
  if (url.hostname === "storage.googleapis.com") return;

  // Always network-first for API calls
  if (url.pathname.startsWith("/api/") || url.hostname !== location.hostname) {
    e.respondWith(fetch(e.request).catch(() => new Response("Offline", { status: 503 })));
    return;
  }

  // Cache-first for app shell, network-first for everything else
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        if (res.ok && e.request.method === "GET") {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      });
      return cached || networkFetch;
    })
  );
});
