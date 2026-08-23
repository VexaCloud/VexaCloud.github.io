self.addEventListener("push", function (event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: "New notification", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "VexaCloud";
  const contextParts = ["VexaCloud"];
  if (data.server) contextParts.push(data.server);
  if (data.channel) contextParts.push(data.channel);
  if (data.dms) contextParts.push("DMs");
  if (data.calls) contextParts.push("Calls");
  if (data.mentions) contextParts.push("Mentions");
  const contextLine = contextParts.join(" • ");
  const body = data.body ? `${contextLine}\n${data.body}` : contextLine;

  const tag = data.conversationId
    ? `dm-${data.conversationId}`
    : data.channelId
      ? `channel-${data.channelId}`
      : data.tag;

  const options = {
    body,
    icon: "favicon.png",
    badge: "favicon.png",
    data: { url: data.url || self.registration.scope },
    tag: tag || undefined,
    renotify: !!tag,
  };

  event.waitUntil(
    (async () => {
      try {
        const clientList = await clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        const anyFocusedOrVisible = clientList.some(
          (c) => c.focused || c.visibilityState === "visible"
        );
        if (anyFocusedOrVisible || focusState.visible) {
          return;
        }
      } catch (_) {
        if (focusState.visible) return;
      }

      await self.registration.showNotification(title, options);
    })()
  );
});

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
