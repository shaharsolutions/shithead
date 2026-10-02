const CACHE_NAME = 'shithead-cache-v11';
const URLS_TO_CACHE = [
  '/',
  '/index.html',
  '/favicon.png',
  '/apple-touch-icon.png',
  '/lobby_hero.png',
  '/lobby_guatemala.jpg',
  '/lobby_guatemala_gen.jpg',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.all(
        URLS_TO_CACHE.map((url) => {
          return fetch(new Request(url, { cache: 'reload' }))
            .then((res) => {
              if (res.ok) return cache.put(url, res);
            })
            .catch(() => {});
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});
