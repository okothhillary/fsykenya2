/* service worker that lets phones install the app.
   It stores nothing: every page and file still comes fresh from the site, so updates show as usual. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return; // only the page itself; Firebase and everything else go straight to the network
  e.respondWith(fetch(e.request).catch(() => new Response('<h1 style="font-family:sans-serif">You are offline</h1><p style="font-family:sans-serif">Connect to the internet and open the app again.</p>', { headers: { 'Content-Type': 'text/html' } })));
});