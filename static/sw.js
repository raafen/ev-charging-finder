/* Cache only this application's owned interface. Never cache API data or tiles. */
'use strict';
const VERSION = 'current-shell-v1';
const ROOT = new URL('./', self.location.href);
const CACHE_PREFIX = `current-shell-${encodeURIComponent(ROOT.pathname)}-`;
const CACHE_NAME = CACHE_PREFIX + VERSION;
let SHELL_ASSETS = ['./', './static/app.css', './static/app.js', './static/domain.js', './static/demo.json', './static/explorer.js', './static/explorer.css', './static/icon.svg', './static/manifest.webmanifest'];
/* BUILD_ASSETS */
const OWNED_URLS = new Set(SHELL_ASSETS.map(path => new URL(path, ROOT).href));
const STATUS_URL = new URL('./.shell-cache-status', ROOT).href;

async function stamp(cache) {
  await cache.put(STATUS_URL, new Response(JSON.stringify({type: 'EV_CACHE_STATUS', version: VERSION, cached_at: new Date().toISOString()}), {headers: {'Content-Type': 'application/json'}}));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll([...OWNED_URLS].map(url => new Request(url, {cache: 'reload'})));
    await stamp(cache);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_STATUS') return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(STATUS_URL);
    const status = response ? await response.json() : {type: 'EV_CACHE_STATUS', version: VERSION, cached_at: null};
    if (event.ports[0]) event.ports[0].postMessage(status);
    else event.source?.postMessage(status);
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== ROOT.origin || url.search) return;
  const home = url.href === ROOT.href || url.href === new URL('./index.html', ROOT).href;
  if (request.mode === 'navigate' && home) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        // Only the default GET shell is persisted; searches/history are never stored here.
        if (response.ok && response.type === 'basic') {
          await cache.put(ROOT.href, response.clone());
          await stamp(cache);
        }
        return response;
      } catch (error) {
        const shell = await cache.match(ROOT.href);
        if (shell) return shell;
        throw error;
      }
    })());
    return;
  }
  if (!OWNED_URLS.has(url.href) || home) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
    return response;
  })());
});
