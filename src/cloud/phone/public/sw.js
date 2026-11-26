/*
 * docs/CLOUD-PHONE.md: the phone app opens even while the cloud that serves it sleeps. This keeps a copy of the app
 * (its page and its build) and serves it when the cloud doesn't answer; the app then wakes the cloud through its fleet.
 * Never the API: /api and /v1 always go to the network.
 */
const CACHE = 'principia-phone-v1'
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/']))); self.skipWaiting() })
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()) })
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url)
  if (e.request.method !== 'GET' || u.origin !== location.origin || /^\/(api|v1|console|preview)\b/.test(u.pathname)) return
  // the page: the network first (a new version), the copy when the cloud sleeps
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { if (r.ok) caches.open(CACHE).then((c) => c.put('/', r.clone())); return r }).catch(() => caches.match('/')))
    return
  }
  // the build and the art: the copy first, kept as they come
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)) } return r })))
})
