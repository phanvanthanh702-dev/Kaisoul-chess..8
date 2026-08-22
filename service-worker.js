/* =========================================================
   KAISOUL CHESS — service-worker.js
   Caches the app shell for offline play (2 players / puzzles),
   and opportunistically caches the CDN chess.js / Stockfish
   scripts so "Chơi với máy" can also work offline after the
   first successful load.
   ========================================================= */

var CACHE_NAME = 'kaisoul-chess-v1';
var APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './js/engine.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(APP_SHELL); })
      .catch(function (err) { console.warn('KAISOUL SW: precache failed', err); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) {
        // Refresh runtime-cached (e.g. CDN) resources in the background.
        fetchAndCache(req);
        return cached;
      }
      return fetchAndCache(req).catch(function () {
        // Offline and not cached — for navigations, fall back to the shell.
        if (req.mode === 'navigate') { return caches.match('./index.html'); }
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});

function fetchAndCache(req) {
  return fetch(req).then(function (res) {
    if (res && res.status === 200) {
      var copy = res.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
    }
    return res;
  });
}
