self.addEventListener("push", (event) => {
  let message = {};
  try { message = event.data?.json() || {}; } catch { /* Use generic text. */ }
  event.waitUntil(self.registration.showNotification(message.title || "New activity", {
    body: message.body || "Open the app to view your encrypted messages.",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: "messenger-activity",
    data: { url: "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((window) => new URL(window.url).origin === self.location.origin);
    if (existing) return existing.focus();
    return clients.openWindow(event.notification.data?.url || "/");
  })());
});
