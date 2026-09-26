// Service Worker for Web Push notifications, ported from the wishlist app's sw.js. No caching/offline
// strategy — this exists solely so pushManager.subscribe() has a registration to attach to and so a push
// event has somewhere to run; it does not intercept fetches.

self.addEventListener("install", (event) => {
  // Activate immediately, don't wait for old service worker to stop
  event.waitUntil(self.skipWaiting())
})

self.addEventListener("activate", (event) => {
  // Take control of all clients immediately
  event.waitUntil(self.clients.claim())
})

self.addEventListener("push", (event) => {
  if (!event.data) {
    return
  }

  const payload = event.data.json()
  const options = {
    body: payload.body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: {
      url: payload.url,
    },
    tag: payload.tag,
    renotify: !!payload.tag,
  }

  event.waitUntil(self.registration.showNotification(payload.title, options))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()

  const url = event.notification.data?.url || "/"

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Try to focus an existing window
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && "focus" in client) {
            client.focus()
            client.navigate(url)
            return
          }
        }
        // Open new window if none exists
        if (self.clients.openWindow) {
          return self.clients.openWindow(url)
        }
      }),
  )
})
