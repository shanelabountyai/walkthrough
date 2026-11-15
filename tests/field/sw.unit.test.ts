// B3: the hand-written service worker caches only the app shell and static assets — never an org page, the feed,
// the sync endpoint or anything else that carries data. Runs public/sw.js against a fake `self` and `caches`.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const ORIGIN = 'http://localhost:8200';
const SHELL_HTML = `<html><script src="/_next/static/chunks/main-abc.js"></script><link href="/_next/static/css/app-1.css" rel="stylesheet"></html>`;

function load(fetchImpl: (u: string) => Promise<Response>) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const stores = new Map<string, Map<string, Response>>();
  const key = (r: unknown) => new URL(typeof r === 'string' ? r : (r as { url: string }).url, ORIGIN).pathname;
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name)!;
      return {
        put: async (r: unknown, res: Response) => void m.set(key(r), res),
        match: async (r: unknown) => m.get(key(r))?.clone(),
        add: async (u: string) => {
          const res = await fetchImpl(u);
          if (!res.ok) throw new Error('add failed');
          m.set(key(u), res);
        },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (n: string) => stores.delete(n),
  };
  const self = { location: { origin: ORIGIN }, addEventListener: (t: string, f: (e: unknown) => void) => void (listeners[t] = f), clients: { claim: vi.fn(async () => {}) }, skipWaiting: vi.fn(async () => {}) };
  vm.runInNewContext(readFileSync('public/sw.js', 'utf8'), { self, caches, fetch: (r: unknown) => fetchImpl(typeof r === 'string' ? r : (r as { url: string }).url), Request, Response, Headers, URL, setTimeout, Promise });
  const cached = (name = 'walkthrough-shell-v1') => [...(stores.get(name)?.keys() ?? [])].sort();
  return { listeners, cached, stores };
}

/** Dispatch a fetch event; resolves to the response if the worker took the request, or null if it let it pass. */
async function dispatch(listeners: Record<string, (e: unknown) => void>, req: { url: string; method?: string; mode?: string }) {
  let taken = null as Promise<Response> | null;
  listeners.fetch!({ request: { method: 'GET', mode: 'cors', ...req, url: new URL(req.url, ORIGIN).href }, respondWith: (p: Promise<Response>) => void (taken = p) });
  return taken ? ((await taken) as Response) : null;
}

const ok = (body = 'x') => Promise.resolve(new Response(body, { status: 200 }));
const online = (u: string) => ok(new URL(u, ORIGIN).pathname === '/field' ? SHELL_HTML : `asset ${u}`);

describe('service worker (B3)', () => {
  it('install caches the shell, the manifest, the icons and the static assets the shell names — nothing else', async () => {
    const { listeners, cached } = load(online);
    let done: Promise<unknown> = Promise.resolve();
    listeners.install!({ waitUntil: (p: Promise<unknown>) => void (done = p) });
    await done;
    expect(cached()).toEqual(['/_next/static/chunks/main-abc.js', '/_next/static/css/app-1.css', '/field', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest']);
  });

  it.each([
    ['the sync endpoint', { url: '/o/acme/inspections/1/sync' }],
    ['a sync push', { url: '/o/acme/inspections/1/sync', method: 'POST' }],
    ['the feed', { url: '/o/acme/inspections/feed' }],
    ['an org page', { url: '/o/acme/inspections', mode: 'navigate' }],
    ['the landing page', { url: '/', mode: 'navigate' }],
    ['an RSC fetch of the shell (not a navigation)', { url: '/field?_rsc=1' }],
    ['another origin', { url: 'https://cdn.example/_next/static/x.js' }],
    ['the health check', { url: '/api/health' }],
  ])('lets %s go to the network untouched and stores nothing', async (_, req) => {
    const fetchSpy = vi.fn(online);
    const { listeners, cached } = load(fetchSpy);
    expect(await dispatch(listeners, req)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cached()).toEqual([]);
  });

  it('serves the shell from the network when online (refreshing the cache) and from the cache, marked, when offline', async () => {
    let up = true;
    const { listeners, cached } = load((u) => (up ? online(u) : Promise.reject(new TypeError('offline'))));
    const first = await dispatch(listeners, { url: '/field?org=acme', mode: 'navigate' });
    expect(await first!.text()).toBe(SHELL_HTML);
    expect(first!.headers.get('x-walkthrough-cache')).toBeNull();
    expect(cached()).toEqual(['/field']);
    up = false;
    const offline = await dispatch(listeners, { url: '/field?org=globex', mode: 'navigate' });
    expect(await offline!.text()).toBe(SHELL_HTML);
    expect(offline!.headers.get('x-walkthrough-cache')).toBe('hit');
  });

  it('static assets are cache-first; the message handler caches only static URLs', async () => {
    const fetchSpy = vi.fn(online);
    const { listeners, cached } = load(fetchSpy);
    await dispatch(listeners, { url: '/_next/static/chunks/a.js' });
    await dispatch(listeners, { url: '/_next/static/chunks/a.js' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    let done: Promise<unknown> = Promise.resolve();
    listeners.message!({ data: { type: 'cache-assets', urls: [`${ORIGIN}/_next/static/chunks/b.js`, `${ORIGIN}/o/acme/inspections/feed`, '/api/health'] }, waitUntil: (p: Promise<unknown>) => void (done = p) });
    await done;
    expect(cached()).toEqual(['/_next/static/chunks/a.js', '/_next/static/chunks/b.js']);
  });

  it('activate drops caches from older versions and claims open pages', async () => {
    const { listeners, stores } = load(online);
    stores.set('walkthrough-shell-v0', new Map());
    let done: Promise<unknown> = Promise.resolve();
    listeners.activate!({ waitUntil: (p: Promise<unknown>) => void (done = p) });
    await done;
    expect(stores.has('walkthrough-shell-v0')).toBe(false);
  });
});
