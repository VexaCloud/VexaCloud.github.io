// Push service worker for standard Web Push (VAPID). Registered by the
// client from index.html with a relative path and scope ("./"), so it
// works whether the app is deployed at a domain root or a subpath (e.g. a
// GitHub Pages project page at username.github.io/reponame/). This file
// has to be plain, dependency-free JS — service workers can't use
// bundlers/imports the way the rest of the app does.

self.addEventListener("push", function (event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: "New notification", body: event.data ? event.data.text() : "" };
  }

  // "title" is who/what triggered this (a sender's name, or "Incoming
  // call") — shown as the notification's main title. The context line
  // (VexaCloud, plus server/channel for channel messages) goes as the
  // first line of the body so the notification is clearly identifiable as
  // coming from VexaCloud (and from which server) even on platforms like
  // Android where the site name isn't shown prominently, or when several
  // notifications are stacked together.
  const title = data.title || "VexaCloud";
  const contextParts = ["VexaCloud"];
  if (data.server) contextParts.push(data.server);
  if (data.channel) contextParts.push(data.channel);
  if (data.dms) contextParts.push("DMs");
  if (data.calls) contextParts.push("Calls");
  if (data.mentions) contextParts.push("Mentions");
  const contextLine = contextParts.join(" • ");
  const body = data.body ? `${contextLine}\n${data.body}` : contextLine;

  // Don't show a native OS push notification while the person is actually
  // looking at this tab right now — the in-app UI (toast, DM notification
  // popup, unread dot) already covers it, so a native push on top of that
  // is a duplicate, noisy notification. `focusState.visible` (set by the
  // client, see reportFocusStateToServiceWorker in index.html) is true
  // only when this exact tab is both the visible tab AND the focused
  // window — so switching to another tab, another app, or closing the
  // site entirely all correctly fall through to a real push below.
  if (focusState.visible) return;

  const tag = data.conversationId ? `dm-${data.conversationId}` : data.channelId ? `channel-${data.channelId}` : data.tag;

  const options = {
    body,
    // Relative, not "/favicon.png" — inside a service worker, a relative
    // URL resolves against this script's own location, which is what we
    // want on a GitHub Pages *project* page (username.github.io/reponame/):
    // the icon actually lives at .../reponame/favicon.png, and an
    // absolute "/favicon.png" would 404 there (it'd point at
    // username.github.io/favicon.png instead). Still resolves correctly
    // on a root deploy either way.
    icon: "favicon.png",
    badge: "favicon.png",
    data: { url: data.url || self.registration.scope },
    tag: tag || undefined,
    // Without this, a second notification with the same tag (e.g. another
    // message in the same channel/DM while the first is still showing)
    // silently replaces it without re-alerting the user — renotify makes
    // it re-alert (sound/vibrate) each time while still collapsing into
    // one notification instead of stacking indefinitely.
    renotify: !!tag,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// The client tells us which channel/DM is currently open and whether the
// tab is visible, so the push handler above can skip notifying for a chat
// the person is already looking at.
let focusState = { visible: false, channelId: null, conversationId: null };
self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "focus-state") {
    focusState = {
      visible: !!event.data.visible,
      channelId: event.data.channelId || null,
      conversationId: event.data.conversationId || null,
    };
  }
});

// Focuses an already-open tab if one exists, otherwise opens a new one, on
// the notification's target URL.
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
