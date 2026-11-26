// Replaces the old app's service worker so installed copies stop using the old site.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.registration.unregister().then(() => self.clients.matchAll()).then(cs => cs.forEach(c => c.navigate(c.url)))));