const cache_name = "cache";
const cache_urls = [
  "/",
  "/style.css",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(cache_name)
      .then(cache => cache.addAll(cache_urls))
      .then(self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  if ("navigationPreload" in self.registration)
    e.waitUntil(self.registration.navigationPreload.enable())
});

self.addEventListener("fetch", e => {
  e.respondWith((e.preloadResponse || Promise.resolve(null))
    .then(r => r || fetch(e.request))
    // .then(r => r.status == 200 ? r : null)
    .catch((...args) => null)
    .then(r => {
      if (!r) {
        return caches.open(cache_name)
          .then(cache => cache.match(e.request))
          .then(match => match || r)
      }
      caches.open(cache_name)
        .then(cache => {
          cache.match(e.request)
            .then(match => {
              if (match)
                cache.put(e.request, r);
            })
        });
      return r.clone();
    })
  );
});

