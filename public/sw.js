// Anvil PWA service worker. Handles:
//   - Web Push 'push' events (renders a notification with title/body/url)
//   - 'notificationclick' (focuses or opens the URL the server passed)
//
// The PWA registers this file at /sw.js. We deliberately keep it tiny:
// no precache, no offline shell. The app already handles offline-edge
// behaviours in code; the SW is here purely for push.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_e) { payload = { title: "Anvil", body: event.data?.text() || "" }; }
  const title = payload.title || "Anvil";
  const options = {
    body: payload.body || "",
    icon: "/icon-192.svg",
    badge: "/icon-192.svg",
    data: { url: payload.url || "/", ...payload.data },
    tag: payload.tag || "anvil-default",
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url && c.url.includes(target)) { c.focus(); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
