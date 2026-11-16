// Walkthrough field app service worker (Phase 3, docs/walkthrough/PHASE3_PLAN.md). Hand-written, no library.
// It caches exactly two kinds of thing: the /field app shell (a static page holding no data) and static assets
// (/_next/static/*, the manifest, the icons). Every other request — org pages, the feed, the sync endpoint, sign-in —
// goes to the network untouched and is never stored, so no one's data ever lands in this cache.
const CACHE = 'walkthrough-shell-v1';
const SHELL = '/field';
const ASSETS = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
const SHELL_TIMEOUT_MS = 3000;

/** 'shell' | 'static' | 'pass' for one request. Only same-origin GETs are ever cached. */
function kind(request) {
  if (request.method !== 'GET') return 'pass';
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return 'pass';
  if (url.pathname === SHELL && request.mode === 'navigate') return 'shell';
  if (url.pathname.startsWith('/_next/static/') || ASSETS.includes(url.pathname)) return 'static';
  return 'pass';
}

/** The /_next/static URLs a page's HTML references, so the first install caches the scripts the shell boots with. */
function assetsIn(html) {
  return [...new Set(html.match(/\/_next\/static\/[^"'\s)\\]+/g) || [])];
}

async function install() {
  const cache = await caches.open(CACHE);
  const res = await fetch(SHELL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`shell answered ${res.status}`);
  await cache.put(SHELL, res.clone());
  await Promise.all([...ASSETS, ...assetsIn(await res.text())].map((u) => cache.add(u).catch(() => {})));
}

async function activate() {
  for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
  await self.clients.claim();
}

/** Network first, so an online technician always gets the newest shell; the cached copy after a timeout or failure. */
async function shell(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), SHELL_TIMEOUT_MS)),
    ]);
    if (res.ok) await cache.put(SHELL, res.clone());
    return res;
  } catch {
    const hit = await cache.match(SHELL);
    if (!hit) return Response.error();
    // Marked, so a test (and anyone in devtools) can tell an offline open came from this cache.
    const headers = new Headers(hit.headers);
    headers.set('x-walkthrough-cache', 'hit');
    return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
  }
}

/** Static assets have content-hashed names: cache first. */
async function asset(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

self.addEventListener('install', (e) => e.waitUntil(install().then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(activate()));
self.addEventListener('fetch', (e) => {
  const k = kind(e.request);
  if (k === 'shell') e.respondWith(shell(e.request));
  else if (k === 'static') e.respondWith(asset(e.request));
  // 'pass': no respondWith — the browser fetches it as if there were no service worker.
});
// The page reports the assets it actually loaded (lazy chunks the shell's HTML does not name).
self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'cache-assets' || !Array.isArray(e.data.urls)) return;
  const urls = e.data.urls.filter((u) => typeof u === 'string' && kind(new Request(new URL(u, self.location.origin))) === 'static');
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(urls.map((u) => c.match(u).then((hit) => hit || c.add(u).catch(() => {}))))));
});
