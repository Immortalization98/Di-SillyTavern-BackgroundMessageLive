// Push-only service worker for Background Message Live.
// Registered with this directory as its scope, so it never controls pages and never touches
// any root-scope service worker other extensions may use. It has no fetch handler on purpose.
const DEFAULT_TITLE = 'SillyTavern';
const DEFAULT_BODY = 'A reply is ready.';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  // iOS revokes push permission if a push does not show a notification, so always show one.
  event.waitUntil(self.registration.showNotification(data.title || DEFAULT_TITLE, {
    body: data.body || DEFAULT_BODY,
    tag: data.tag || 'di-bgmessage-live',
    icon: '/img/apple-icon-192x192.png',
    data: { url: typeof data.url === 'string' ? data.url : '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && 'focus' in client) return client.focus();
    }
    return self.clients.openWindow(target.href);
  })());
});
