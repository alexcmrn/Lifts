// Lifts service worker: lets the app open and run without a connection.
// App files are fetched fresh when online, so updates show straight away, and the latest copy is kept for offline use.
// Requests to Supabase (your data, sign-in and photos) are never cached here.
var CACHE = 'lifts-v2';
var SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];
// The pinned Supabase library and the fonts never change at a given address, so they are served from the cache first.
var STATIC_HOSTS = ['https://cdn.jsdelivr.net/', 'https://fonts.googleapis.com/', 'https://fonts.gstatic.com/'];

self.addEventListener('install', function (e) {
  // 'reload' skips the browser's own cache, so the offline copy is always the latest version.
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
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
    // 'no-cache' asks GitHub every time whether a file changed (unchanged files are not downloaded again),
    // so a new version shows as soon as the app reloads instead of up to 10 minutes later.
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(function (res) { return keep(req, res); }).catch(function () {
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
