/*
 * Promo dashboards — app-shell service worker (instant reloads).
 *
 * Only the dashboard's OWN files are cached; every Supabase / Odoo / GitHub request goes straight
 * to the network, untouched, so the numbers are always live.
 *   - /assets/*  : content-hashed (a new build = new file names) -> cache-first, kept forever.
 *   - the page   : stale-while-revalidate -> the cached page paints at once while the network copy
 *                  is fetched; if it changed (a new deploy), open pages are told so they can offer a
 *                  reload, and assets no build still uses are dropped.
 */
const CACHE = 'promo-shell-v1'
// v2: the page check bypasses the browser's 10-minute HTTP cache, or a deploy goes unseen for 10 min
const PAGE = 'app-page'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

const assetsIn = (html) => new Set([...html.matchAll(/assets\/[\w.-]+\.(?:js|css|woff2|svg|png)/g)].map((m) => m[0]))

// After a deploy keep only the new build's entry files; everything else (old builds, old lazy
// chunks) is dropped. Old files stay on the server, so a still-open old page re-fetches any it
// needs, and the new build's lazy chunks are cached the first time they are used.
async function cleanup(cache, freshHtml) {
  const keep = assetsIn(freshHtml)
  for (const req of await cache.keys()) {
    const p = new URL(req.url).pathname
    const i = p.indexOf('assets/')
    if (i >= 0 && !keep.has(p.slice(i))) await cache.delete(req)
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // Supabase, Odoo, fonts CDN: never cached here

  if (url.pathname.includes('/assets/')) {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(req)
        if (hit) return hit
        const res = await fetch(req)
        if (res.ok) c.put(req, res.clone())
        return res
      }),
    )
    return
  }

  if (req.mode === 'navigate') {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const cached = await c.match(PAGE)
        const network = fetch(req, { cache: 'no-cache' })
          .then(async (res) => {
            if (!res.ok) return res
            const fresh = await res.clone().text()
            const old = cached ? await cached.clone().text() : null
            await c.put(PAGE, res.clone())
            if (old !== null && old !== fresh) {
              await cleanup(c, fresh)
              const clients = await self.clients.matchAll({ type: 'window' })
              for (const w of clients) w.postMessage({ type: 'promo-update-ready' })
            }
            return res
          })
          .catch(() => cached || Response.error())
        if (cached) {
          e.waitUntil(network)
          return cached
        }
        return network
      }),
    )
  }
})
