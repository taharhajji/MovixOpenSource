/* MEWFLIX web — service worker.
 *
 * Rôle volontairement limité :
 *  - navigations : réseau d'abord ; si le réseau manque, page hors-ligne
 *    (offline.html) qui recharge toute seule dès que la connexion revient ;
 *  - /assets/ (fichiers hachés, immuables) : cache d'abord, pour des
 *    ouvertures instantanées et moins de données sur mobile ;
 *  - icônes et manifeste : cache puis rafraîchissement en arrière-plan ;
 *  - /api/ et /media/ : jamais interceptés (toujours frais, jamais mis en cache).
 *
 * __BUILD__ est remplacé par le script de build : chaque déploiement nettoie
 * les caches des versions précédentes.
 */
const BUILD = '__BUILD__';
const SHELL_CACHE = `mewflix-shell-${BUILD}`;
const ASSET_CACHE = 'mewflix-assets-v1';
const SHELL = ['/offline.html', '/mewflix-icon.png', '/mewflix-icon-192.png', '/mewflix-icon-512.png'];
const MAX_ASSETS = 160;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // Anciennes versions de la coquille, et caches laissés par d'autres
    // service workers (workbox du site d'origine).
    await Promise.all(names
      .filter((name) => name !== SHELL_CACHE && name !== ASSET_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'mewflix:skip-waiting') self.skipWaiting();
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  await Promise.all(keys.slice(0, keys.length - max).map((req) => cache.delete(req)));
}

async function networkFirstNavigation(request) {
  try {
    return await fetch(request);
  } catch (_) {
    const cache = await caches.open(SHELL_CACHE);
    const offline = await cache.match('/offline.html');
    if (!offline) throw _;
    // La page hors-ligne connaît la page demandée pour y revenir d'elle-même.
    const target = new URL(request.url);
    const from = target.pathname + target.search;
    const html = (await offline.text()).replace('</head>', `<script>window.__mewflixFrom=${JSON.stringify(from)}</script></head>`);
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone()).then(() => trimCache(cacheName, MAX_ASSETS)).catch(() => {});
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const refresh = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  }).catch(() => null);
  return hit || (await refresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path.startsWith('/api/') || path.startsWith('/media/') || path === '/media' || path === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (path.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }
  if (/^\/mewflix-icon[^/]*\.png$/.test(path) || path === '/offline.html') {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
  }
});
