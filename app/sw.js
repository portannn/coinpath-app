/* Coinpath service worker — offline app shell.
   Bump CACHE_VERSION whenever you deploy new app files. */

const CACHE_VERSION = 'coinpath-v2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './firebase-config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_VERSION) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept Firebase traffic — the SDK does its own offline queueing
  // and a cached auth/Firestore response would be actively harmful.
  if (
    url.hostname.indexOf('firestore.googleapis.com') > -1 ||
    url.hostname.indexOf('identitytoolkit.googleapis.com') > -1 ||
    url.hostname.indexOf('securetoken.googleapis.com') > -1 ||
    url.hostname.indexOf('firebaseinstallations.googleapis.com') > -1
  ) {
    return;
  }

  // Navigation requests: network first so a fresh deploy is picked up,
  // falling back to the cached shell when offline. The shell is stored under
  // both keys because the app can be served at "/" or at "/index.html"
  // depending on the host.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(function (c) {
          c.put('./index.html', copy.clone());
          c.put('./', copy);
        });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (hit) {
          return hit || caches.match('./');
        });
      })
    );
    return;
  }

  // Everything else (app files, the Firebase SDK bundles): cache first,
  // then network, storing successful same-origin and CDN responses.
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return cached;
      });
    })
  );
});
