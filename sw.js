// Lifts service worker: lets the app open and run without a connection.
// App files are fetched fresh when online, so updates show straight away, and the latest copy is kept for offline use.
// Requests to Supabase (your data, sign-in and photos) are never cached here.
var CACHE = 'lifts-v1';
var SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];
// The pinned Supabase library and the fonts never change at a given address, so they are served from the cache first.
var STATIC_HOSTS = ['https://cdn.jsdelivr.net/', 'https://fonts.googleapis.com/', 'https://fonts.gstatic.com/'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function keep(req, res) {
  if (res && (res.ok || res.type === 'opaque')) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(req, copy); });
  }
  return res;
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then(function (res) { return keep(req, res); }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (r) {
        return r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
      });
    }));
    return;
  }
  if (STATIC_HOSTS.some(function (h) { return req.url.indexOf(h) === 0; })) {
    e.respondWith(caches.match(req).then(function (r) {
      return r || fetch(req).then(function (res) { return keep(req, res); });
    }));
  }
});
