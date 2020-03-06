// const cache_name = "cache";
// const cache_urls = "offline.html";

// self.addEventListener("install", e => {
//   e.waitUntil(
//     caches.open(cache_name)
//       .then(cache => cache.add(offline_url))
//       .then(self.skipWaiting())
//   );
// });
// 
// const fetchConfig = () =>
//   fetch("config.json", { cache: "reload" })
//     .then(r => r.json());
// 
// self.addEventListener("activate", e => {
// //   caches.open(cache_name)
// //     .then(cache => cache.add(offline_url))
//   if (self.registration.navigationPreload)
//     e.waitUntil(self.registration.navigationPreload.enable())
// });
// 
// self.addEventListener("fetch", e => {
//   e.respondWith((async () => {
//     const offline = async () => (await caches.open(cache_name))
//         .match(offline_url);
//     const r = async () => (await e.preloadResponse) || fetch(e.request);
// 
//     if (e.request.mode != "navigate")
//       return r();
// 
//     try {
//       const cfg = await fetchConfig()
//       if (cfg.default.online === false)
//         return offline();
//       return await r();
//     } catch (e) {
//       return offline();
//     }
//   })());
// });

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
    .then(r => r.status == 200 ? r : null)
    .catch(() => null)
    .then(r => {
      if (!r) {
        return caches.open(cache_name)
          .then(cache => cache.match(e.request))
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

