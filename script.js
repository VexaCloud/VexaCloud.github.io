    function showInitError(message) {
      const el = document.getElementById("auth-init-error");
      if (el) {
        el.textContent = message;
        el.classList.add("visible");
      }
      const boot = document.getElementById("boot-loader");
      if (boot) boot.classList.add("hidden");
      console.error(message);
    }

    window.addEventListener("error", (e) => {
      showInitError("Script error: " + (e.error && e.error.message ? e.error.message : e.message));
    });

    let resolveAuthReady;
    const authReadyPromise = new Promise((resolve) => {
      resolveAuthReady = resolve;
    });
    let authReadyResolved = false;

    let supabaseClient;
    try {
      if (!window.supabase || typeof window.supabase.createClient !== "function") {
        throw new Error(
          "Supabase client library did not load. Check your network/CDN access or the js/supabase.js script."
        );
      }
      supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
      supabaseClient.auth.onAuthStateChange((_event, session) => {

        if (!authReadyResolved) {
          authReadyResolved = true;
          resolveAuthReady();
        }
        if (session && session.access_token) {
          supabaseClient.realtime.setAuth(session.access_token);
        }

        if (_event === "PASSWORD_RECOVERY") {
          recoveryPasswordError.textContent = "";
          recoveryPasswordNew.value = "";
          recoveryPasswordConfirm.value = "";
          recoveryPasswordModal.style.display = "flex";
        }
      });

      setTimeout(() => {
        if (!authReadyResolved) {
          authReadyResolved = true;
          resolveAuthReady();
        }
      }, 3000);
    } catch (err) {
      showInitError(err.message || "Failed to initialize Supabase client.");

      if (!authReadyResolved) {
        authReadyResolved = true;
        resolveAuthReady();
      }
    }

    let currentUser = null;
    let currentProfile = null;
    let currentServer = null;
    let currentChannel = null;
    let currentServerMembers = [];

    const userBanStatusCache = new Map();

    function findServerMember(userId) {
      return (currentServerMembers || []).find((m) => m.user && m.user.id === userId) || null;
    }

    function isServerBanned(userId) {
      const m = findServerMember(userId);
      return !!(m && m.is_banned);
    }

    function isServerOwner(server) {
      return !!(server && currentProfile && server.owner_id === currentProfile.id);
    }

    function canActOnAdminTarget(server, targetMember, action) {
      if (!targetMember) return false;
      if (isAdmin(currentProfile)) return true;
      if (action === "ban" && isAdmin(targetMember.user)) return false;
      if (targetMember.role === "admin" && targetMember.user.id !== currentProfile.id) {
        if (!isServerOwner(server)) return false;
      }
      return true;
    }

    async function getIsUserBanned(userId) {
      const known = currentServerMembers.find((m) => m.user && m.user.id === userId);
      if (known && known.user.is_banned !== undefined) {
        userBanStatusCache.set(userId, !!known.user.is_banned);
        return userBanStatusCache.get(userId);
      }
      if (userBanStatusCache.has(userId)) return userBanStatusCache.get(userId);
      try {
        const { users } = await apiFetch("/api/admin/users");
        (users || []).forEach((u) => userBanStatusCache.set(u.id, !!u.is_banned));
      } catch (err) {
        console.error("Failed to refresh ban status", err);
      }
      return userBanStatusCache.get(userId) || false;
    }

    function logRealtimeStatus(label, status, err) {
      if (status === "SUBSCRIBED") {
        console.info(`[realtime] ${label}: connected`);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        console.error(`[realtime] ${label}: ${status}`, err || "");
      }
    }
    let currentServerMembership = null;
    let undoTimers = new Map();

    const unreadChannelCounts = new Map();

    let notificationSettings = {
      dms_enabled: true,
      calls_enabled: true,
      channel_messages_enabled: false,
      mentions_enabled: true,
    };
    const mutedServerIds = new Set();
    const mutedChannelIds = new Set();
    const mutedConversationIds = new Set();

    async function loadNotificationSettings() {
      try {
        const data = await apiFetch("/api/notification-settings");
        notificationSettings = data.settings;
        mutedServerIds.clear();
        (data.mutedServerIds || []).forEach((id) => mutedServerIds.add(id));
        mutedChannelIds.clear();
        (data.mutedChannelIds || []).forEach((id) => mutedChannelIds.add(id));
        mutedConversationIds.clear();
        (data.mutedConversationIds || []).forEach((id) => mutedConversationIds.add(id));
      } catch (err) {
        console.error("Failed to load notification settings", err);
      }
    }

    function isChannelMutedForNotifs(channelId) {
      if (!channelId) return false;
      if (mutedChannelIds.has(channelId)) return true;
      const serverId = channelIdToServerId.get(channelId);
      return !!(serverId && mutedServerIds.has(serverId));
    }

    function isConversationMutedForNotifs(conversationId) {
      return !!(conversationId && mutedConversationIds.has(conversationId));
    }

    async function toggleMuteServer(serverId, mute) {
      try {
        await apiFetch(`/api/notification-settings/mute-server/${serverId}`, { method: mute ? "POST" : "DELETE" });
        if (mute) mutedServerIds.add(serverId);
        else mutedServerIds.delete(serverId);
        if (mute) {
          for (const [chId] of Array.from(unreadChannelCounts.entries())) {
            if (channelIdToServerId.get(chId) === serverId) markChannelRead(chId);
          }
        }
        refreshServerUnreadDot(serverId);
        if (typeof updateServerHeaderMuteLeaveButtons === "function") updateServerHeaderMuteLeaveButtons();
        showToast(mute ? "Server muted" : "Server unmuted", { duration: 1500 });
      } catch (err) {
        console.error(err);
        showToast("Failed to update mute setting", { variant: "danger" });
      }
    }

    async function toggleMuteChannel(channelId, mute) {
      try {
        await apiFetch(`/api/notification-settings/mute-channel/${channelId}`, { method: mute ? "POST" : "DELETE" });
        if (mute) mutedChannelIds.add(channelId);
        else mutedChannelIds.delete(channelId);
        if (mute) markChannelRead(channelId);
        showToast(mute ? "Channel muted" : "Channel unmuted", { duration: 1500 });
      } catch (err) {
        console.error(err);
        showToast("Failed to update mute setting", { variant: "danger" });
      }
    }

    async function toggleMuteConversation(conversationId, mute) {
      try {
        await apiFetch(`/api/notification-settings/mute-conversation/${conversationId}`, {
          method: mute ? "POST" : "DELETE",
        });
        if (mute) mutedConversationIds.add(conversationId);
        else mutedConversationIds.delete(conversationId);
        if (mute) {
          markDmRead(conversationId);
          const stack = document.querySelector(".dm-notification-stack");
          if (stack) {
            const existing = stack.querySelector(`[data-conversation-id="${conversationId}"]`);
            if (existing) existing.remove();
          }
        }
        showToast(mute ? "Conversation muted" : "Conversation unmuted", { duration: 1500 });
      } catch (err) {
        console.error(err);
        showToast("Failed to update mute setting", { variant: "danger" });
      }
    }

    const unreadDmCounts = new Map();
    const channelIdToServerId = new Map();
    let dmConversationsCache = [];
    let globalActivityChannel = null;
    let incomingCallPopupEl = null;
    let incomingCallPopupCallId = null;
    const activeVoiceRoomIds = new Set();
    const activeCallConversationIds = new Set();
    let voiceActivityPollTimer = null;

    function serverHasVoiceActivity(serverId) {
      for (const chId of activeVoiceRoomIds) {
        if (channelIdToServerId.get(chId) === serverId) return true;
      }
      return false;
    }

    function refreshVoiceActivityUI() {
      channelListEl.querySelectorAll('.channel-item[data-channel-type="voice"]').forEach((el) => {
        el.classList.toggle("has-voice-activity", activeVoiceRoomIds.has(el.dataset.channelId));
      });
      serverListEl.querySelectorAll(".server-item[data-server-id]").forEach((el) => {
        el.classList.toggle("has-voice-activity", serverHasVoiceActivity(el.dataset.serverId));
      });
      dmConversationList.querySelectorAll(".dm-conversation-item[data-conversation-id]").forEach((el) => {
        el.classList.toggle("has-voice-activity", activeCallConversationIds.has(el.dataset.conversationId));
      });
    }

    async function pollActiveVoiceRooms() {
      try {
        const { rooms } = await apiFetch("/api/voice/active-rooms");
        activeVoiceRoomIds.clear();
        (rooms || []).forEach((r) => {
          if (r.participantCount > 0) activeVoiceRoomIds.add(r.name);
        });
        refreshVoiceActivityUI();
      } catch (err) {

        console.error("Failed to poll active voice rooms", err);
      }
    }

    function startVoiceActivityPolling() {
      stopVoiceActivityPolling();
      pollActiveVoiceRooms();
      voiceActivityPollTimer = setInterval(pollActiveVoiceRooms, 15000);
    }

    function stopVoiceActivityPolling() {
      if (voiceActivityPollTimer) clearInterval(voiceActivityPollTimer);
      voiceActivityPollTimer = null;
    }

    let syncPollTimer = null;
    let lastSyncAt = null;
    const seenIncomingCallIds = new Set();

    async function pollSync() {
      if (!currentUser) return;
      try {
        const params = new URLSearchParams();
        if (lastSyncAt) params.set("since", lastSyncAt);
        if (currentServer) params.set("currentServerId", currentServer.id);
        const requestedSince = lastSyncAt;
        const data = await apiFetch(`/api/sync?${params.toString()}`);
        lastSyncAt = data.now;

        if (data.banned || data.force_logout) {
          await forceSignOutAndReload(
            data.banned
              ? "You've been banned by an administrator."
              : "You've been signed out by an administrator."
          );
          return;
        }

        (data.messages || []).forEach((m) => handleSyncedMessage(m, requestedSince));
        processCallsSnapshot(data.calls || [], requestedSince);
        reconcileServersFromSync(data.servers || []);
        if (data.channels) reconcileChannelsFromSync(data.channels);
        if (data.members) reconcileMembersFromSync(data.members);
      } catch (err) {
        const described = describeAuthBlockError(err);
        if (described) {
          await forceSignOutAndReload(described);
          return;
        }
        console.error("Sync poll failed", err);
      }
    }

    function listSignature(list, fields) {
      return list.map((item) => fields.map((f) => item[f]).join(":")).join("|");
    }

    let lastServersSignature = "";
    let lastServerIds = new Set();
    const recentlyLeftServerIds = new Set();
    const recentlyDeletedServerIds = new Set();

    function markServerLeftLocally(serverId) {
      if (!serverId) return;
      recentlyLeftServerIds.add(serverId);
      lastServerIds.delete(serverId);
    }

    function markServerDeletedLocally(serverId) {
      if (!serverId) return;
      recentlyDeletedServerIds.add(serverId);
      lastServerIds.delete(serverId);
    }

    function syncLocalServerIdsFromAllServers() {
      lastServerIds = new Set((allServers || []).map((s) => s.id));
      lastServersSignature = listSignature(allServers || [], ["id", "name", "icon_url", "is_public"]);
    }

    function reconcileServersFromSync(servers) {
      const sig = listSignature(servers, ["id", "name", "icon_url", "is_public"]);
      if (sig === lastServersSignature) return;

      const newIds = new Set(servers.map((s) => s.id));
      if (lastServersSignature) {
        lastServerIds.forEach((id) => {
          if (newIds.has(id)) return;
          const wasCurrent = currentServer && currentServer.id === id;
          const leftOnPurpose = recentlyLeftServerIds.has(id);
          const deletedOnPurpose = recentlyDeletedServerIds.has(id);
          recentlyLeftServerIds.delete(id);
          recentlyDeletedServerIds.delete(id);
          if (wasCurrent) {
            currentServer = null;
            clearNoChannelSelectedState();
          }
          if (!leftOnPurpose && !deletedOnPurpose && !wasCurrent) {
            return;
          }
        });
      }

      lastServersSignature = sig;
      lastServerIds = newIds;
      loadServers();
    }

    let lastChannelsSignature = "";
    function reconcileChannelsFromSync(channels) {
      const sig = listSignature(channels, ["id", "name", "type", "is_private", "position"]);
      if (sig === lastChannelsSignature) return;
      lastChannelsSignature = sig;
      if (currentServer) loadChannels(currentServer.id);
    }

    let lastMembersSignature = "";
    let lastMemberProfilesById = new Map();
    function reconcileMembersFromSync(members) {

      members.forEach((m) => {
        if (!m.user) return;
        const prev = lastMemberProfilesById.get(m.user.id);
        if (prev && (prev.username !== m.user.username || prev.avatar_url !== m.user.avatar_url)) {
          applyLiveProfileUpdate(m.user);
        }
        lastMemberProfilesById.set(m.user.id, { username: m.user.username, avatar_url: m.user.avatar_url });
      });

      const sig = listSignature(
        members.map((m) => ({
          id: m.user ? m.user.id : "?",
          role: m.role,
          banned: m.user && m.user.is_banned,
          username: m.user && m.user.username,
          avatar_url: m.user && m.user.avatar_url,
        })),
        ["id", "role", "banned", "username", "avatar_url"]
      );
      if (sig === lastMembersSignature) return;
      lastMembersSignature = sig;
      if (currentServer) loadServerMembers(currentServer.id);
    }

    function handleSyncedMessage(message, since) {

      const isNewMessage = !since || new Date(message.created_at) > new Date(since);

      if (message.channel_id) {
        if (currentChannel && currentChannel.id === message.channel_id) {
          const existingRow = messageListEl.querySelector(`[data-message-id="${message.id}"]`);

          if (existingRow) {

            if (message.deleted_at) {
              existingRow.remove();
            } else {
              const contentEl = existingRow.querySelector(".message-content");
              if (contentEl) {
                contentEl.innerHTML = formatMessageContent(message.content);
                applyMessageContentTruncation(contentEl);
              }

              const reactionsEl = existingRow.querySelector(".message-reactions");
              if (reactionsEl) {
                reactionsEl.innerHTML = reactionSummaryHTML(message.reactions);
                reactionsEl.querySelectorAll(".reaction-pill").forEach((btn) => {
                  btn.addEventListener("click", () => toggleReaction(message, btn.dataset.emoji));
                });
              }
            }
          } else {

            renderMessage(message, messageListEl);
            messageListEl.scrollTop = messageListEl.scrollHeight;
          }
        } else if (isNewMessage && !message.deleted_at && message.user_id !== currentUser.id) {
          markChannelUnread(message.channel_id);
        }
        return;
      }

      if (message.conversation_id) {
        const isOpenDm =
          dmModal.classList.contains("visible") && currentDmConversationId === message.conversation_id;
        if (isOpenDm) {
          renderDmMessage(message);
          dmMessageList.scrollTop = dmMessageList.scrollHeight;
          return;
        }
        if (message.deleted_at || message.user_id === currentUser.id) return;
        if (!isNewMessage) return;

        markDmUnread(message.conversation_id);
        const known = dmConversationsCache.find((c) => c.id === message.conversation_id);
        if (known) {
          showDmNotification(message, known.other_user);
        } else {

          apiFetch(`/api/profiles/${message.user_id}`)
            .then(({ profile }) => showDmNotification(message, profile))
            .catch(() => showDmNotification(message, null));
          loadDmConversations();
        }
        return;
      }
    }

    function processCallsSnapshot(calls, requestedSince) {
      const currentIds = new Set(calls.map((c) => c.id));

      activeCallConversationIds.clear();
      calls.forEach((c) => activeCallConversationIds.add(c.conversation_id));
      refreshVoiceActivityUI();

      if (activeDmCallId) {
        const mine = calls.find((c) => c.id === activeDmCallId);
        if (mine) {
          dmCallParticipants = Array.isArray(mine.participants) ? mine.participants : [];
          renderDmCallBar();
          updateDmCallButton();
        } else if (voiceRoom && voiceContext === "dm") {

          const snapshotIsFreshEnough =
            requestedSince && activeDmCallStartedAt && new Date(requestedSince).getTime() >= activeDmCallStartedAt;
          if (snapshotIsFreshEnough) {
            showToast("Call ended", { duration: 2000 });
            disconnectVoice();
          }
        }
      }

      calls.forEach((call) => {
        if (seenIncomingCallIds.has(call.id)) return;
        seenIncomingCallIds.add(call.id);
        if (call.started_by === currentUser.id) return;
        if (call.conversation_id && mutedConversationIds.has(call.conversation_id)) return;
        const alreadyOnThisCall =
          voiceRoom &&
          voiceContext === "dm" &&
          (activeDmCallId === call.id || currentDmConversationId === call.conversation_id);
        if (alreadyOnThisCall) return;
        showIncomingCallPopup(call);
      });

      seenIncomingCallIds.forEach((id) => {
        if (!currentIds.has(id)) seenIncomingCallIds.delete(id);
      });
      if (incomingCallPopupCallId && !currentIds.has(incomingCallPopupCallId)) {
        try {
          if (incomingCallPopupEl) incomingCallPopupEl.remove();
        } catch (e) {}
        incomingCallPopupEl = null;
        incomingCallPopupCallId = null;
      }
    }

    function startSyncPolling() {
      stopSyncPolling();
      lastSyncAt = new Date().toISOString();
      pollSync();
      syncPollTimer = setInterval(pollSync, 3000);
    }

    function stopSyncPolling() {
      if (syncPollTimer) clearInterval(syncPollTimer);
      syncPollTimer = null;
      lastSyncAt = null;
      seenIncomingCallIds.clear();
    }

    async function seedUnreadState() {
      try {
        const { channels, conversations, channelServers } = await apiFetch("/api/unreads");
        (channelServers || []).forEach((c) => channelIdToServerId.set(c.id, c.server_id));
        (channels || []).forEach((id) => markChannelUnread(id));
        (conversations || []).forEach((id) => markDmUnread(id));

        if ((channels || []).length) loadServers();
      } catch (err) {
        console.error("Failed to load unread state", err);
      }
    }

    function badgeHTML(count) {
      if (!count) return "";
      return `<span class="unread-badge">${count > 99 ? "99+" : count}</span>`;
    }

    function serverHasUnread(serverId) {
      if (mutedServerIds.has(serverId)) return false;
      for (const [chId, count] of unreadChannelCounts) {
        if (count > 0 && channelIdToServerId.get(chId) === serverId && !mutedChannelIds.has(chId)) return true;
      }
      return false;
    }

    function serverUnreadTotal(serverId) {
      if (mutedServerIds.has(serverId)) return 0;
      let total = 0;
      for (const [chId, count] of unreadChannelCounts) {
        if (channelIdToServerId.get(chId) === serverId && !mutedChannelIds.has(chId)) total += count;
      }
      return total;
    }

    function refreshServerUnreadDot(serverId) {
      const el = serverListEl.querySelector(`.server-item[data-server-id="${serverId}"]`);
      if (!el) return;
      el.classList.toggle("has-unread", serverHasUnread(serverId));
      const badgeEl = el.querySelector(".unread-badge");
      if (badgeEl) badgeEl.remove();
      const total = serverUnreadTotal(serverId);
      if (total > 0) el.insertAdjacentHTML("beforeend", badgeHTML(total));
    }

    function markChannelUnread(channelId) {
      if (isChannelMutedForNotifs(channelId)) return;
      unreadChannelCounts.set(channelId, (unreadChannelCounts.get(channelId) || 0) + 1);
      const el = channelListEl.querySelector(`.channel-item[data-channel-id="${channelId}"]`);
      if (el) {
        el.classList.add("has-unread");
        const badgeEl = el.querySelector(".unread-badge");
        if (badgeEl) badgeEl.remove();
        el.querySelector(".channel-item-main").insertAdjacentHTML("beforeend", badgeHTML(unreadChannelCounts.get(channelId)));
      }
      const serverId = channelIdToServerId.get(channelId);
      if (serverId) refreshServerUnreadDot(serverId);
    }

    function markChannelRead(channelId) {
      if (!unreadChannelCounts.has(channelId)) return;
      unreadChannelCounts.delete(channelId);
      const el = channelListEl.querySelector(`.channel-item[data-channel-id="${channelId}"]`);
      if (el) {
        el.classList.remove("has-unread");
        const badgeEl = el.querySelector(".unread-badge");
        if (badgeEl) badgeEl.remove();
      }
      const serverId = channelIdToServerId.get(channelId);
      if (serverId) refreshServerUnreadDot(serverId);
    }

    function refreshDmButtonDot() {
      let total = 0;
      for (const [id, count] of unreadDmCounts) {
        if (!isConversationMutedForNotifs(id)) total += count;
      }
      dmButton.classList.toggle("has-unread", total > 0);
      const existing = dmButton.querySelector(".unread-badge");
      if (existing) existing.remove();
      if (total > 0) dmButton.insertAdjacentHTML("beforeend", badgeHTML(total));
    }

    function markDmUnread(conversationId) {
      if (isConversationMutedForNotifs(conversationId)) return;
      unreadDmCounts.set(conversationId, (unreadDmCounts.get(conversationId) || 0) + 1);
      const el = dmConversationList.querySelector(`.dm-conversation-item[data-conversation-id="${conversationId}"]`);
      if (el) {
        el.classList.add("has-unread");
        const badgeEl = el.querySelector(".unread-badge");
        if (badgeEl) badgeEl.remove();
        const trailing = el.querySelector(".dm-conversation-trailing") || el;
        trailing.insertAdjacentHTML("beforeend", badgeHTML(unreadDmCounts.get(conversationId)));
      }
      refreshDmButtonDot();
    }

    function markDmRead(conversationId) {
      if (!unreadDmCounts.has(conversationId)) return;
      unreadDmCounts.delete(conversationId);
      const el = dmConversationList.querySelector(`.dm-conversation-item[data-conversation-id="${conversationId}"]`);
      if (el) {
        el.classList.remove("has-unread");
        const badgeEl = el.querySelector(".unread-badge");
        if (badgeEl) badgeEl.remove();
      }
      refreshDmButtonDot();

      apiFetch(`/api/dms/${conversationId}/read`, { method: "POST", body: JSON.stringify({}) }).catch(() => {});
    }

    let topRightAlertStackEl = null;
    let dmNotificationStackEl = null;
    function getTopRightAlertStack() {
      if (!topRightAlertStackEl || !document.body.contains(topRightAlertStackEl)) {
        topRightAlertStackEl = document.createElement("div");
        topRightAlertStackEl.className = "top-right-alert-stack";
        topRightAlertStackEl.id = "top-right-alert-stack";
        document.body.appendChild(topRightAlertStackEl);
      }
      return topRightAlertStackEl;
    }
    function getDmNotificationStack() {
      const parent = getTopRightAlertStack();
      if (!dmNotificationStackEl || !parent.contains(dmNotificationStackEl)) {
        dmNotificationStackEl = document.createElement("div");
        dmNotificationStackEl.className = "dm-notification-stack";
        parent.appendChild(dmNotificationStackEl);
      }
      return dmNotificationStackEl;
    }

    async function showDmNotification(message, other) {
      if (!message || isConversationMutedForNotifs(message.conversation_id)) return;
      const stack = getDmNotificationStack();

      const existing = stack.querySelector(`[data-conversation-id="${message.conversation_id}"]`);
      if (existing) existing.remove();

      let profile = other;
      if ((!profile || !profile.avatar_url) && (profile?.id || message.user_id)) {
        try {
          const id = (profile && profile.id) || message.user_id;
          const { profile: full } = await apiFetch(`/api/profiles/${id}`);
          if (full) profile = { ...(profile || {}), ...full };
        } catch (_) {}
      }

      const name = profile ? profile.username : "Someone";
      const el = document.createElement("div");
      el.className = "dm-notification";
      el.dataset.conversationId = message.conversation_id;
      el.innerHTML = `
        <button class="dm-notification-close" title="Close">×</button>
        <div class="dm-notification-avatar">${profile ? avatarHTML(profile) : DEFAULT_AVATAR_SVG}</div>
        <div class="dm-notification-body">
          <div class="dm-notification-name">${escapeHtml(name)}</div>
          <div class="dm-notification-text">${escapeHtml(message.content || "(attachment)")}</div>
          <div class="dm-notification-actions">
            <button class="dm-notification-button dm-notification-open">Open</button>
            <button class="dm-notification-button dm-notification-dismiss">Dismiss</button>
          </div>
        </div>
      `;
      stack.appendChild(el);

      el.querySelector(".dm-notification-close").addEventListener("click", () => el.remove());

      el.querySelector(".dm-notification-dismiss").addEventListener("click", () => {
        markDmRead(message.conversation_id);
        el.remove();
      });

      el.querySelector(".dm-notification-open").addEventListener("click", () => {
        handleOpenDmModal();
        openDmConversation(message.conversation_id, profile || other);
        el.remove();
      });

      setTimeout(() => {
        if (el.isConnected) el.remove();
      }, 12000);
    }

    async function showIncomingCallPopup(call) {
      if (call && call.conversation_id && mutedConversationIds.has(call.conversation_id)) return;
      if (incomingCallPopupEl) incomingCallPopupEl.remove();
      const cached = dmConversationsCache.find((c) => c.id === call.conversation_id);
      const other = (cached && cached.other_user) || (await resolveProfile(call.started_by));
      const name = other ? other.username : "Someone";

      const el = document.createElement("div");
      el.className = "incoming-call-popup";
      const isVideoCall = !!(
        call.is_video ||
        call.video ||
        (Array.isArray(call.participants) &&
          call.participants.some((p) => p && (p.video || p.is_video) && p.user_id === call.started_by))
      );
      el.innerHTML = `
        <div class="incoming-call-info">
          <div class="incoming-call-name">${uiIcon("phone", 16)} ${escapeHtml(name)}</div>
          <div class="incoming-call-sub">${isVideoCall ? "Incoming video call" : "Incoming voice call"}</div>
        </div>
        <div class="incoming-call-actions">
          <button class="incoming-call-button incoming-call-answer">Answer</button>
          <button class="incoming-call-button incoming-call-decline">Dismiss</button>
        </div>
      `;
      el.dataset.isVideo = isVideoCall ? "1" : "0";
      const stack = getTopRightAlertStack();
      const callBar = stack.querySelector(".dm-call-bar");
      if (callBar) stack.insertBefore(el, callBar);
      else stack.insertBefore(el, stack.firstChild);
      incomingCallPopupEl = el;
      incomingCallPopupCallId = call.id;

      const dismiss = () => {
        if (incomingCallPopupEl === el) {
          el.remove();
          incomingCallPopupEl = null;
          incomingCallPopupCallId = null;
        }
      };

      const joinIncoming = async () => {
        dismiss();
        try {
          if (voiceRoom) await disconnectVoice();
          const wantVideo = el.dataset.isVideo === "1";
          voicePreferVideo = wantVideo;
          if (wantVideo) {
            showCallOverlay(true);
            updateCallOverlayChrome();
          }
          handleOpenDmModal();
          openDmConversation(call.conversation_id, other);
          const { call: joined } = await apiFetch(`/api/voice-calls/${call.id}/join`, { method: "POST" });
          activeDmCallId = joined.id;
          activeDmCallStartedAt = Date.now();
          dmCallParticipants = Array.isArray(joined.participants) ? joined.participants : [];
          currentDmOtherUser = other;
          await connectVoice({ id: joined.id, name }, "dm");
          subscribeDmCallRealtime(call.conversation_id);
          updateDmCallButton();
          renderDmCallBar();
          if (wantVideo) showCallOverlay(true);
          else {
            try { hideCallOverlay(); } catch (e) {}
            try { renderDmCallBar(); } catch (e) {}
          }
        } catch (err) {
          console.error(err);
          showToast(err.message || "Failed to join call", { variant: "danger" });
          try { hideCallOverlay(); } catch (e) {}
        }
      };
      el.querySelector(".incoming-call-decline").addEventListener("click", dismiss);
      el.querySelector(".incoming-call-answer").addEventListener("click", () => joinIncoming());

      setTimeout(() => {
        if (incomingCallPopupCallId === call.id) dismiss();
      }, 30000);
    }

    function unsubscribeGlobalActivity() {
      if (globalActivityChannel) {
        supabaseClient.removeChannel(globalActivityChannel);
        globalActivityChannel = null;
      }
    }

    async function subscribeGlobalActivity() {
      unsubscribeGlobalActivity();
      if (!supabaseClient || !currentUser) return;
      try {
        const { data } = await supabaseClient.auth.getSession();
        if (data?.session?.access_token) {
          await supabaseClient.realtime.setAuth(data.session.access_token);
        }
      } catch (err) {
        console.error("Failed to refresh realtime auth", err);
      }
      globalActivityChannel = supabaseClient
        .channel(`activity:${currentUser.id}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "messages" },
          async (payload) => {
            const row = payload.new;
            if (!row || row.user_id === currentUser.id) return;

            if (row.channel_id) {
              const isOpenChannel = currentChannel && currentChannel.id === row.channel_id;
              if (isOpenChannel) return;
              markChannelUnread(row.channel_id);
              return;
            }

            if (row.conversation_id) {
              const isOpenDm =
                dmModal.classList.contains("visible") && currentDmConversationId === row.conversation_id;
              if (isOpenDm) return;
              if (isConversationMutedForNotifs(row.conversation_id)) return;
              markDmUnread(row.conversation_id);
              const known = dmConversationsCache.find((c) => c.id === row.conversation_id);
              const other = known ? known.other_user : await resolveProfile(row.user_id);

              if (!known) loadDmConversations();
              showToast(
                `${escapeHtml(other ? other.username : "Someone")}: ${escapeHtml((row.content || "").slice(0, 80))}`,
                {
                  variant: "accent",
                  onClick: () => {
                    handleOpenDmModal();
                    openDmConversation(row.conversation_id, other);
                    markDmRead(row.conversation_id);
                  },
                }
              );
            }
          }
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "voice_calls" },
          async (payload) => {
            const call = payload.new;
            if (!call || !call.conversation_id) return;
            activeCallConversationIds.add(call.conversation_id);
            refreshVoiceActivityUI();
            if (call.started_by === currentUser.id) return;
            const alreadyOnThisCall =
              voiceRoom &&
              voiceContext === "dm" &&
              (activeDmCallId === call.id || currentDmConversationId === call.conversation_id);
            if (alreadyOnThisCall) return;
            showIncomingCallPopup(call);
          }
        )
        .on(
          "postgres_changes",
          { event: "DELETE", schema: "public", table: "voice_calls" },
          (payload) => {
            const old = payload.old;
            if (!old || !old.conversation_id) return;
            activeCallConversationIds.delete(old.conversation_id);
            refreshVoiceActivityUI();
          }
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "servers" },
          async (payload) => {
            const server = payload.new;
            if (!server) return;
            await loadServers();
          }
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "servers" },
          async (payload) => {
            const server = payload.new;
            if (!server) return;
            const el = serverListEl.querySelector(`.server-item[data-server-id="${server.id}"]`);
            if (el) {
              const tooltipEl = el.querySelector(".server-tooltip");
              if (tooltipEl) tooltipEl.textContent = server.name + (server.is_public ? " · Public" : "");
            }
            if (currentServer && currentServer.id === server.id) {
              currentServer.name = server.name;
              if (typeof chatServerNameEl !== "undefined" && chatServerNameEl) {
                chatServerNameEl.textContent = server.name;
              }
            }
          }
        )
        .on(
          "postgres_changes",
          { event: "DELETE", schema: "public", table: "servers" },
          async (payload) => {
            const old = payload.old;
            if (!old) return;
            const wasCurrent = currentServer && currentServer.id === old.id;
            const leftOnPurpose = recentlyLeftServerIds.has(old.id);
            const deletedOnPurpose = recentlyDeletedServerIds.has(old.id);
            recentlyLeftServerIds.delete(old.id);
            recentlyDeletedServerIds.delete(old.id);
            await loadServers();
            if (leftOnPurpose || deletedOnPurpose) return;
            if (wasCurrent) {
              currentServer = null;
              clearNoChannelSelectedState();
            }
          }
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "profiles" },
          (payload) => {
            const profile = payload.new;
            if (!profile || profile.id === currentUser.id) return;
            applyLiveProfileUpdate(profile);
          }
        )
        .subscribe((status, err) => logRealtimeStatus("global-activity", status, err));
    }

    function applyLiveProfileUpdate(profile) {
      if (extraKnownProfiles.has(profile.id)) extraKnownProfiles.set(profile.id, profile);

      messageListEl.querySelectorAll(`.message-row[data-user-id="${profile.id}"]`).forEach((row) => {
        const nameEl = row.querySelector(".message-username");
        if (nameEl) nameEl.textContent = profile.username || "Unknown";
        const avatarEl = row.querySelector(".message-avatar");
        if (avatarEl) avatarEl.innerHTML = avatarHTML(profile);
      });

      dmMessageList.querySelectorAll(`.dm-message[data-user-id="${profile.id}"]`).forEach((row) => {
        const nameEl = row.querySelector(".dm-message-username");
        if (nameEl) nameEl.textContent = profile.username || "Unknown";
        const avatarEl = row.querySelector(".dm-message-avatar");
        if (avatarEl) avatarEl.innerHTML = avatarHTML(profile);
      });

      const convo = dmConversationsCache.find((c) => c.other_user && c.other_user.id === profile.id);
      if (convo) {
        convo.other_user = { ...convo.other_user, ...profile };
        const el = dmConversationList.querySelector(`.dm-conversation-item[data-conversation-id="${convo.id}"]`);
        if (el) {
          const nameEl = el.querySelector(".dm-conversation-name");
          if (nameEl) nameEl.textContent = profile.username || "Unknown";
          const avatarEl = el.querySelector(".dm-conversation-avatar");
          if (avatarEl) avatarEl.innerHTML = avatarHTML(profile);
        }
      }

      if (currentDmOtherUser && currentDmOtherUser.id === profile.id) {
        currentDmOtherUser = { ...currentDmOtherUser, ...profile };
        dmChatHeader.textContent = profile.username || "Conversation";
      }

      const member = currentServerMembers.find((m) => m.id === profile.id || (m.user && m.user.id === profile.id));
      if (member) {
        Object.assign(member.user || member, profile);
        if (typeof renderMemberList === "function") {
          try {
            renderMemberList();
          } catch (e) {

          }
        }
      }
    }

    const authOverlay = document.getElementById("auth-overlay");
    const bootLoaderEl = document.getElementById("boot-loader");
    const bootLoaderStatusEl = document.getElementById("boot-loader-status");

function hideBootLoader() {
  if (bootLoaderEl) bootLoaderEl.classList.add("hidden");
}

function setBootLoaderStatus(text) {
  if (bootLoaderStatusEl) bootLoaderStatusEl.textContent = text;
}

function hideAuthOverlay() {
  authOverlay.classList.add("hidden");
  hideBootLoader();
}

function showAuthOverlay() {
  authOverlay.classList.remove("hidden");
  hideBootLoader();
}

    function urlBase64ToUint8Array(base64String) {
      const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
      const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
      const rawData = window.atob(base64);
      const outputArray = new Uint8Array(rawData.length);
      for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
      return outputArray;
    }

    let pushServiceWorkerRegistration = null;

    let pushNotificationsActive = false;
    function refreshMuteButtonsVisibility() {
      if (currentServer) loadChannels(currentServer.id);
      if (dmConversationsCache.length) loadDmConversations();
      if (typeof renderNotificationBell === "function") renderNotificationBell();
    }

    function reportFocusStateToServiceWorker() {
      if (!("serviceWorker" in navigator)) return;
      const state = {
        type: "focus-state",
        visible: document.visibilityState === "visible",
        channelId: currentChannel ? currentChannel.id : null,
        conversationId:
          dmModal && dmModal.classList.contains("visible") ? currentDmConversationId : null,
      };
      navigator.serviceWorker.ready
        .then((reg) => reg.active && reg.active.postMessage(state))
        .catch(() => {});
    }
    document.addEventListener("visibilitychange", reportFocusStateToServiceWorker);

    window.addEventListener("focus", reportFocusStateToServiceWorker);
    window.addEventListener("blur", reportFocusStateToServiceWorker);
    setInterval(reportFocusStateToServiceWorker, 15000);

    async function getPushServiceWorkerRegistration() {
      if (pushServiceWorkerRegistration) return pushServiceWorkerRegistration;
      if (!("serviceWorker" in navigator)) return null;

      await navigator.serviceWorker.register("sw.js", { scope: "./" });
      pushServiceWorkerRegistration = await navigator.serviceWorker.ready;
      return pushServiceWorkerRegistration;
    }

    async function getCurrentPushSubscription() {
      try {
        const registration = await getPushServiceWorkerRegistration();
        if (!registration) return null;
        return await registration.pushManager.getSubscription();
      } catch (err) {
        return null;
      }
    }

    function enablePushNotifications() {
      requestNativePermissionAndSubscribe();
    }

    function requestNativePermissionAndSubscribe() {
      if (!("Notification" in window)) return Promise.resolve();
      return Notification.requestPermission()
        .then((permission) => {
          updatePushStatusUI();
          if (permission === "granted") {
            return subscribeToPush();
          } else if (permission === "denied") {
            showToast("Notifications weren't allowed", { variant: "danger" });
          }
        })
        .catch((err) => {
          console.error("Failed to request notification permission", err);
          showToast("Failed to request notification permission", { variant: "danger" });
        });
    }

    async function subscribeToPush(isRetry) {
      try {
        if (!window.VAPID_PUBLIC_KEY) {
          showToast("Push notifications aren't configured yet", { variant: "danger" });
          return;
        }
        const registration = await getPushServiceWorkerRegistration();
        if (!registration) {
          showToast("Push notifications aren't supported in this browser", { variant: "danger" });
          return;
        }
        let subscription;
        try {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(window.VAPID_PUBLIC_KEY),
          });
        } catch (subscribeErr) {

          if (!isRetry) {
            const existing = await registration.pushManager.getSubscription().catch(() => null);
            if (existing) {
              await existing.unsubscribe().catch(() => {});
              return subscribeToPush(true);
            }
          }
          throw subscribeErr;
        }
        const json = subscription.toJSON();
        await apiFetch("/api/push/subscribe", {
          method: "POST",
          body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
        });
        showToast("Push notifications enabled", { variant: "accent" });
      } catch (err) {
        console.error("Failed to enable push notifications", err);
        showToast("Failed to enable push notifications", { variant: "danger" });
      } finally {
        updatePushStatusUI();
      }
    }

    async function disablePushNotifications() {
      try {
        const subscription = await getCurrentPushSubscription();
        if (subscription) {
          const endpoint = subscription.endpoint;
          await subscription.unsubscribe();
          await apiFetch("/api/push/unsubscribe", {
            method: "POST",
            body: JSON.stringify({ endpoint }),
          });
        }
        showToast("Push notifications disabled", { variant: "accent" });
      } catch (err) {
        console.error("Failed to disable push notifications", err);
        showToast("Failed to disable push notifications", { variant: "danger" });
      } finally {
        updatePushStatusUI();
      }
    }

    async function handlePushButtonClick() {
      const permission = ("Notification" in window) ? Notification.permission : null;
      if (permission === "denied") return;

      if (permission === "granted") {
        const subscription = await getCurrentPushSubscription();
        if (subscription) {
          await disablePushNotifications();
        } else {
          await subscribeToPush();
        }
        return;
      }

      await requestNativePermissionAndSubscribe();
    }

    async function updatePushStatusUI() {
      const dot = document.getElementById("notification-push-status-dot");
      const text = document.getElementById("notification-push-status-text");
      const hint = document.getElementById("notification-push-hint");
      const button = notificationEnablePushButton;
      if (!dot || !text || !button) return;

      const setPushActive = (active) => {
        if (pushNotificationsActive !== active) {
          pushNotificationsActive = active;
          refreshMuteButtonsVisibility();
        }
      };

      button.onclick = () => handlePushButtonClick();

      if (isMobileDevice()) {
        dot.className = "push-status-dot is-blocked";
        text.textContent = "Notifications not supported on mobile";
        button.style.display = "none";
        hint.textContent = "Push notifications aren't supported on mobile browsers yet. Try this on a desktop browser instead.";
        setPushActive(false);
        return;
      }

      if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
        dot.className = "push-status-dot is-blocked";
        text.textContent = "Push notifications aren't supported in this browser.";
        button.style.display = "none";
        hint.textContent = "Try a recent version of Chrome, Firefox, Edge, or Safari.";
        setPushActive(false);
        return;
      }

      const permission = Notification.permission;
      button.style.display = "block";

      if (permission === "denied") {
        dot.className = "push-status-dot is-blocked";
        text.textContent = "Push notifications are blocked in your browser.";
        button.textContent = "\ud83d\udd14 Blocked \u2014 check browser settings";
        button.disabled = true;
        hint.textContent =
          "Your browser is blocking notifications for this site. Open your browser's site settings (usually the lock/info icon next to the address bar) and allow notifications, then reload.";
        setPushActive(false);
        return;
      }

      if (permission === "granted") {
        const subscription = await getCurrentPushSubscription();
        if (subscription) {
          dot.className = "push-status-dot is-enabled";
          text.textContent = "Push notifications are enabled on this device.";
          button.textContent = "\ud83d\udd15 Disable push notifications";
          button.disabled = false;
          hint.textContent = "Turn these off anytime here, or from your browser's site settings.";
          setPushActive(true);
        } else {
          dot.className = "push-status-dot is-default";
          text.textContent = "Your browser allows notifications, but this device isn't subscribed yet.";
          button.textContent = "\ud83d\udd14 Enable push notifications";
          button.disabled = false;
          hint.textContent = "Click to subscribe this device to push notifications.";
          setPushActive(false);
        }
        return;
      }

      dot.className = "push-status-dot is-default";
      text.textContent = "Push notifications aren't enabled yet on this device.";
      button.textContent = "\ud83d\udd14 Enable push notifications";
      button.disabled = false;
      hint.textContent = "Your browser will ask for permission. You can revoke it anytime from your browser's site settings.";
      setPushActive(false);
    }
    window.updatePushStatusUI = updatePushStatusUI;

    const authTabSignin = document.getElementById("auth-tab-signin");
    const authTabSignup = document.getElementById("auth-tab-signup");
    const authFormSignin = document.getElementById("auth-form-signin");
    const authFormSignup = document.getElementById("auth-form-signup");
    const authErrorSignin = document.getElementById("auth-error-signin");
    const authErrorSignup = document.getElementById("auth-error-signup");
    const authConfirmSignup = document.getElementById("auth-confirm-signup");

    const signinEmail = document.getElementById("signin-email");
    const signinPassword = document.getElementById("signin-password");
    const signinSubmit = document.getElementById("signin-submit");
    const signinGithub = document.getElementById("signin-github");
    const signinGoogle = document.getElementById("signin-google");

    const signupEmail = document.getElementById("signup-email");
    const signupPassword = document.getElementById("signup-password");
    const signupUsername = document.getElementById("signup-username");
    const signupAvatar = document.getElementById("signup-avatar");
    const signupAvatarUpload = document.getElementById("signup-avatar-upload");
    const signupAvatarPreview = document.getElementById("signup-avatar-preview");
    const signupSubmit = document.getElementById("signup-submit");
    const signupGithub = document.getElementById("signup-github");
    const signupGoogle = document.getElementById("signup-google");

    const authForgotPasswordLink = document.getElementById("auth-forgot-password-link");
    const forgotPasswordModal = document.getElementById("forgot-password-modal");
    const forgotPasswordClose = document.getElementById("forgot-password-close");
    const forgotPasswordCancel = document.getElementById("forgot-password-cancel");
    const forgotPasswordEmail = document.getElementById("forgot-password-email");
    const forgotPasswordSend = document.getElementById("forgot-password-send");
    const forgotPasswordError = document.getElementById("forgot-password-error");
    const forgotPasswordConfirm = document.getElementById("forgot-password-confirm");

    const recoveryPasswordModal = document.getElementById("recovery-password-modal");
    const recoveryPasswordNew = document.getElementById("recovery-password-new");
    const recoveryPasswordConfirm = document.getElementById("recovery-password-confirm");
    const recoveryPasswordSave = document.getElementById("recovery-password-save");
    const recoveryPasswordError = document.getElementById("recovery-password-error");

    const authSupportLink = document.getElementById("auth-support-link");
    const openSupportModal = document.getElementById("open-support-modal");
    const supportModal = document.getElementById("support-modal");
    const supportClose = document.getElementById("support-close");
    const supportCancel = document.getElementById("support-cancel");
    const supportAccountName = document.getElementById("support-account-name");
    const supportEmail = document.getElementById("support-email");
    const supportMessage = document.getElementById("support-message");
    const supportSend = document.getElementById("support-send");
    const supportError = document.getElementById("support-error");
    const supportConfirm = document.getElementById("support-confirm");

    const serverListEl = document.getElementById("server-list");
    const channelListEl = document.getElementById("channel-list");
    function showNoChannelSelectedState() {
      messageListEl.innerHTML = `
        <div class="empty-state-full">
          <div class="empty-state-full-icon">${uiIcon("message", 40)}</div>
          <div class="empty-state-full-title">No channel selected</div>
          <div class="empty-state-full-sub">Pick a channel from the menu on the left to start chatting.</div>
        </div>
      `;
      chatInputEl.disabled = true;
      chatInputEl.placeholder = "Select a channel first...";
      chatSendButton.disabled = true;
      attachmentButton.disabled = true;
    }

    function clearNoChannelSelectedState() {
      chatInputEl.disabled = false;
      chatInputEl.placeholder = "Message...";
      chatSendButton.disabled = false;
      attachmentButton.disabled = false;
    }

    const messageListEl = document.getElementById("message-list");
    const reportReviewBanner = document.getElementById("report-review-banner");
    const reportReviewBanButton = document.getElementById("report-review-ban-button");
    const reportReviewBanReporterButton = document.getElementById("report-review-ban-reporter-button");
    const reportReviewDismissButton = document.getElementById("report-review-dismiss-button");
    const reportReviewResolveButton = document.getElementById("report-review-resolve-button");
    let activeReviewingReport = null;
    let activeReviewingMessageId = null;

    let messageListStickToBottom = true;

    function isScrolledNearBottom(el, threshold = 100) {
      return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
    }

    messageListEl.addEventListener("scroll", () => {
      messageListStickToBottom = isScrolledNearBottom(messageListEl);
    });

    messageListEl.addEventListener(
      "load",
      (e) => {
        if (e.target.tagName === "IMG" && messageListStickToBottom) {
          messageListEl.scrollTop = messageListEl.scrollHeight;
        }
      },
      true
    );

    const userListEl = document.getElementById("user-list");
    const userPanelEl = document.getElementById("user-panel");
    const memberSearchInput = document.getElementById("member-search-input");

    const channelsDrawer = document.getElementById("channels-drawer");
    const drawerBackdrop = document.getElementById("drawer-backdrop");
    const channelsDrawerToggle = document.getElementById("channels-drawer-toggle");
    const membersDrawerToggle = document.getElementById("members-drawer-toggle");

    const currentServerNameEl = document.getElementById("current-server-name");
    const currentServerMetaEl = document.getElementById("current-server-meta");
    const chatChannelPrefixEl = document.getElementById("chat-channel-prefix");
    const chatChannelNameEl = document.getElementById("chat-channel-name");
    const chatChannelMetaEl = document.getElementById("chat-channel-meta");
    const chatConnectionStatusEl = document.getElementById("chat-connection-status");
    const chatInputEl = document.getElementById("chat-input");
    const chatSendButton = document.getElementById("chat-send-button");
    const chatInputHintEl = document.getElementById("chat-input-hint");
    const replyPreviewBar = document.getElementById("reply-preview-bar");
    const replyPreviewText = document.getElementById("reply-preview-text");
    const replyPreviewCancel = document.getElementById("reply-preview-cancel");
    let replyingToMessage = null;
    const attachmentInput = document.getElementById("attachment-input");
    const attachmentButton = document.getElementById("attachment-button");
    const attachmentPreview = document.getElementById("attachment-preview");
    const chatDropOverlay = document.getElementById("chat-drop-overlay");
    const voiceBar = document.getElementById("voice-bar");
    let _voiceAudioContainer = null;
    function getVoiceAudioContainer() {
      if (!_voiceAudioContainer || !document.body.contains(_voiceAudioContainer)) {
        _voiceAudioContainer = document.getElementById("voice-audio-container");
        if (!_voiceAudioContainer) {
          _voiceAudioContainer = document.createElement("div");
          _voiceAudioContainer.id = "voice-audio-container";
          _voiceAudioContainer.style.display = "none";
          document.body.appendChild(_voiceAudioContainer);
        }
      }
      return _voiceAudioContainer;
    }
    const voiceBarLabel = document.getElementById("voice-bar-label");
    const voiceBarParticipants = document.getElementById("voice-bar-participants");
    const voiceMuteButton = document.getElementById("voice-mute-button");
    const voiceLeaveButton = document.getElementById("voice-leave-button");
    const voiceStage = document.getElementById("voice-stage");
    const voiceStageGrid = document.getElementById("voice-stage-grid");
    const chatBodyEl = document.getElementById("chat-body");

    function setVoiceStageVisible(visible) {
      voiceStage.classList.toggle("visible", visible);
      chatBodyEl.style.display = visible ? "none" : "flex";
    }

    const createServerButton = document.getElementById("create-server-button");
    const browseServersButton = document.getElementById("browse-servers-button");
    const createChannelButton = document.getElementById("create-channel-button");
    const serverAdminPanelButton = document.getElementById("server-admin-panel-button");
    const serverMuteButton = document.getElementById("server-mute-button");
    const serverLeaveButton = document.getElementById("server-leave-button");

    function updateServerHeaderMuteLeaveButtons() {
      if (!serverMuteButton || !serverLeaveButton) return;
      if (!currentServer) {
        serverMuteButton.style.display = "none";
        serverLeaveButton.style.display = "none";
        return;
      }
      const muted = mutedServerIds.has(currentServer.id);
      serverMuteButton.style.display = "flex";
      serverMuteButton.innerHTML = muteBellSVG(muted);
      serverMuteButton.title = muted ? "Unmute server notifications" : "Mute server notifications";
      serverMuteButton.setAttribute("aria-label", serverMuteButton.title);
      serverLeaveButton.style.display = "flex";
    }
    const settingsModal = document.getElementById("settings-modal");
    const viewProfileModal = document.getElementById("view-profile-modal");
    const viewProfileClose = document.getElementById("view-profile-close");
    const viewProfileAvatarEl = document.getElementById("view-profile-avatar");
    const viewProfileUsernameEl = document.getElementById("view-profile-username");
    const viewProfileRoleEl = document.getElementById("view-profile-role");
    const viewProfileBioEl = document.getElementById("view-profile-bio");
    const viewProfileJoinedRow = document.getElementById("view-profile-joined-row");
    const viewProfileJoinedEl = document.getElementById("view-profile-joined");
    const viewProfileBanRow = document.getElementById("view-profile-ban-row");
    const viewProfileBanReasonEl = document.getElementById("view-profile-ban-reason");
    const viewProfileDmButton = document.getElementById("view-profile-dm-button");
    const viewProfileBanButton = document.getElementById("view-profile-ban-button");
    const settingsClose = document.getElementById("settings-close");
    const settingsCancel = document.getElementById("settings-cancel");
    const settingsSave = document.getElementById("settings-save");
    const settingsUsername = document.getElementById("settings-username");
    const settingsEmail = document.getElementById("settings-email");
    const settingsUpdateEmailButton = document.getElementById("settings-update-email-button");
    const settingsAvatar = document.getElementById("settings-avatar");
    const settingsAvatarUpload = document.getElementById("settings-avatar-upload");
    const settingsAvatarPreview = document.getElementById("settings-avatar-preview");
    let pendingSettingsAvatarFile = null;
    const settingsBio = document.getElementById("settings-bio");
    const settingsTheme = document.getElementById("settings-theme");
    const settingsAccentColor = document.getElementById("settings-accent-color");
    const settingsAccentReset = document.getElementById("settings-accent-reset");
    const settingsBackground = document.getElementById("settings-background");
    const settingsBackgroundUpload = document.getElementById("settings-background-upload");
    const settingsBackgroundPreview = document.getElementById("settings-background-preview");
    const settingsBackgroundRemove = document.getElementById("settings-background-remove");
    const settingsTextMode = document.getElementById("settings-text-mode");
    const settingsCustomTextColorRow = document.getElementById("settings-custom-text-color-row");
    const settingsCustomTextColor = document.getElementById("settings-custom-text-color");
    const settingsDensity = document.getElementById("settings-density");
    const settingsCorners = document.getElementById("settings-corners");
    const settingsAppearanceCancel = document.getElementById("settings-appearance-cancel");
    const settingsAppearanceSave = document.getElementById("settings-appearance-save");
    let pendingSettingsBackgroundFile = null;
    let pendingSettingsBackgroundRemoved = false;
    const identityBadges = document.getElementById("identity-badges");
    const identityOAuthActions = document.getElementById("identity-oauth-actions");
    const identitySetPassword = document.getElementById("identity-set-password");
    const identityNewPassword = document.getElementById("identity-new-password");
    const identityConfirmPassword = document.getElementById("identity-confirm-password");
    const identitySetPasswordButton = document.getElementById("identity-set-password-button");

    const themeSelect = document.getElementById("theme-select");
    const topBarSubtitle = document.getElementById("top-bar-subtitle");
    const userPill = document.getElementById("user-pill");
    const userPillAvatar = document.getElementById("user-pill-avatar");
    const userPillName = document.getElementById("user-pill-name");
    const logoutButton = document.getElementById("logout-button");

    const messageContextMenu = document.getElementById("message-context-menu");
    const userContextMenu = document.getElementById("user-context-menu");
    const serverContextMenu = document.getElementById("server-context-menu");

    const formModal = document.getElementById("form-modal");
    const formModalTitle = document.getElementById("form-modal-title");
    const formModalSubtitle = document.getElementById("form-modal-subtitle");
    const formModalBody = document.getElementById("form-modal-body");
    const formModalClose = document.getElementById("form-modal-close");
    const formModalCancel = document.getElementById("form-modal-cancel");
    const formModalSubmit = document.getElementById("form-modal-submit");
    const formModalError = document.getElementById("form-modal-error");

    const browseServersModal = document.getElementById("browse-servers-modal");
    const browseServersClose = document.getElementById("browse-servers-close");
    const publicServerList = document.getElementById("public-server-list");
    const publicServerSearchInput = document.getElementById("public-server-search-input");
    const myServersModal = document.getElementById("my-servers-modal");
    const myServersClose = document.getElementById("my-servers-close");
    const myServersSearchInput = document.getElementById("my-servers-search-input");

    const adminDashboardButton = document.getElementById("admin-dashboard-button");
    const adminDashboardModal = document.getElementById("admin-dashboard-modal");
    const adminDashboardClose = document.getElementById("admin-dashboard-close");
    const adminTabs = document.querySelectorAll(".admin-tab");
    const adminUsersPanel = document.getElementById("admin-users-panel");
    const adminUserSearchBar = document.getElementById("admin-user-search-bar");
    const adminUserSearchInput = document.getElementById("admin-user-search-input");
    const adminServersPanel = document.getElementById("admin-servers-panel");
    const adminServerSearchBar = document.getElementById("admin-server-search-bar");
    const adminServerSearchInput = document.getElementById("admin-server-search-input");
    const adminReportsPanel = document.getElementById("admin-reports-panel");
    const adminBanRequestsPanel = document.getElementById("admin-ban-requests-panel");

    const serverAdminModal = document.getElementById("server-admin-modal");
    const serverAdminClose = document.getElementById("server-admin-close");
    const serverAdminSubtitle = document.getElementById("server-admin-subtitle");
    const serverAdminTabs = document.querySelectorAll(".server-admin-tab");
    const serverAdminChannelsPanel = document.getElementById("server-admin-channels-panel");
    const serverAdminMembersPanel = document.getElementById("server-admin-members-panel");
    const serverAdminMemberSearchBar = document.getElementById("server-admin-member-search-bar");
    const serverAdminMemberSearchInput = document.getElementById("server-admin-member-search-input");
    const serverAdminFilteringPanel = document.getElementById("server-admin-filtering-panel");
    const serverAdminFilterEnabled = document.getElementById("server-admin-filter-enabled");
    const serverAdminFilterUseBasic = document.getElementById("server-admin-filter-use-basic");
    const serverAdminFilterPhrase = document.getElementById("server-admin-filter-phrase");
    const serverAdminFilterReplacement = document.getElementById("server-admin-filter-replacement");
    const serverAdminFilterAdd = document.getElementById("server-admin-filter-add");
    const serverAdminFiltersList = document.getElementById("server-admin-filters-list");
    let serverAdminTarget = null;

    const invitesModal = document.getElementById("invites-modal");
    const invitesModalSubtitle = document.getElementById("invites-modal-subtitle");
    const invitesClose = document.getElementById("invites-close");
    const createInviteButton = document.getElementById("create-invite-button");
    const inviteExpirySelect = document.getElementById("invite-expiry-select");
    const inviteMaxUsesInput = document.getElementById("invite-max-uses-input");
    const invitesList = document.getElementById("invites-list");

    const dmButton = document.getElementById("dm-button");
    const dmModal = document.getElementById("dm-modal");
    const dmClose = document.getElementById("dm-close");
    const dmConversationList = document.getElementById("dm-conversation-items");
    const dmSearchInput = document.getElementById("dm-search-input");
    const dmSearchResults = document.getElementById("dm-search-results");
    const dmChatHeader = document.getElementById("dm-chat-header");
    const dmMessageList = document.getElementById("dm-message-list");
    const dmInput = document.getElementById("dm-input");
    const dmSendButton = document.getElementById("dm-send-button");
    const dmReplyPreviewBar = document.getElementById("dm-reply-preview-bar");
    const dmReplyPreviewText = document.getElementById("dm-reply-preview-text");
    const dmReplyPreviewCancel = document.getElementById("dm-reply-preview-cancel");
    let dmReplyingToMessage = null;
    const dmCallButton = document.getElementById("dm-call-button");
    const dmVoiceBar = document.getElementById("dm-voice-bar");
    const dmVoiceBarLabel = document.getElementById("dm-voice-bar-label");
    const dmVoiceBarParticipants = document.getElementById("dm-voice-bar-participants");
    const dmVoiceMuteButton = document.getElementById("dm-voice-mute-button");
    const dmVoiceLeaveButton = document.getElementById("dm-voice-leave-button");
    const dmVideoCallButton = document.getElementById("dm-video-call-button");
    const dmVideoStage = document.getElementById("dm-video-stage");
    const dmVideoToggleButton = document.getElementById("dm-video-toggle-button");
    const dmScreenShareButton = document.getElementById("dm-screen-share-button");
    const dmRecordButton = document.getElementById("dm-record-button");

    const toastContainer = document.getElementById("toast-container");

const passwordSave = document.getElementById("password-save");

passwordSave.onclick = async () => {
  const current = document.getElementById("password-current").value;
  const next = document.getElementById("password-new").value;
  const confirm = document.getElementById("password-confirm").value;

  if (next !== confirm) {
    alert("New passwords do not match.");
    return;
  }

  try {

    await apiFetch("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current, next })
    });

    const { error: reSignInError } = await supabaseClient.auth.signInWithPassword({
      email: currentUser?.email,
      password: next,
    });

    document.getElementById("password-current").value = "";
    document.getElementById("password-new").value = "";
    document.getElementById("password-confirm").value = "";

    if (reSignInError) {
      console.error("Re-sign-in after password change failed:", reSignInError);
      showToast("Password updated. Please sign in again with your new password.", { variant: "accent" });
      currentUser = null;
      showAuthOverlay();
      return;
    }

    showToast("Password updated", { variant: "accent" });
  } catch (err) {
    showToast(err.message || "Failed to update password", { variant: "danger" });
  }
};

const notificationSettingsSave = document.getElementById("notification-settings-save");
const notificationEnablePushButton = document.getElementById("notification-enable-push");

function renderNotificationSettingsModal() {
  document.getElementById("notif-dms-enabled").checked = !!notificationSettings.dms_enabled;
  document.getElementById("notif-calls-enabled").checked = !!notificationSettings.calls_enabled;
  document.getElementById("notif-channel-messages-enabled").checked = !!notificationSettings.channel_messages_enabled;
  document.getElementById("notif-mentions-enabled").checked = !!notificationSettings.mentions_enabled;

  const serverList = document.getElementById("notif-muted-servers-list");
  const mutedServers = allServers.filter((s) => mutedServerIds.has(s.id));
  serverList.innerHTML = mutedServers.length
    ? mutedServers
        .map(
          (s) => `
      <div class="notif-muted-row" data-server-id="${s.id}">
        <span>${escapeHtml(s.name)}</span>
        <button class="notif-unmute-button">Unmute</button>
      </div>
    `
        )
        .join("")
    : `<div class="form-field-hint">No muted servers.</div>`;
  serverList.querySelectorAll(".notif-muted-row").forEach((row) => {
    row.querySelector(".notif-unmute-button").addEventListener("click", async () => {
      await toggleMuteServer(row.dataset.serverId, false);
      renderNotificationSettingsModal();
    });
  });

  const channelList = document.getElementById("notif-muted-channels-list");
  const mutedChannelNames = Array.from(mutedChannelIds).map((id) => {
    const el = channelListEl.querySelector(`.channel-item[data-channel-id="${id}"]`);
    return { id, name: el ? el.querySelector(".channel-item-name").textContent : id };
  });
  channelList.innerHTML = mutedChannelNames.length
    ? mutedChannelNames
        .map(
          (c) => `
      <div class="notif-muted-row" data-channel-id="${c.id}">
        <span>#${escapeHtml(c.name)}</span>
        <button class="notif-unmute-button">Unmute</button>
      </div>
    `
        )
        .join("")
    : `<div class="form-field-hint">No muted channels.</div>`;
  channelList.querySelectorAll(".notif-muted-row").forEach((row) => {
    row.querySelector(".notif-unmute-button").addEventListener("click", async () => {
      await toggleMuteChannel(row.dataset.channelId, false);
      renderNotificationSettingsModal();
    });
  });

  const conversationList = document.getElementById("notif-muted-conversations-list");
  const mutedConversations = dmConversationsCache.filter((c) => mutedConversationIds.has(c.id));
  conversationList.innerHTML = mutedConversations.length
    ? mutedConversations
        .map(
          (c) => `
      <div class="notif-muted-row" data-conversation-id="${c.id}">
        <span>${escapeHtml(c.other_user ? c.other_user.username : "Unknown")}</span>
        <button class="notif-unmute-button">Unmute</button>
      </div>
    `
        )
        .join("")
    : `<div class="form-field-hint">No muted conversations.</div>`;
  conversationList.querySelectorAll(".notif-muted-row").forEach((row) => {
    row.querySelector(".notif-unmute-button").addEventListener("click", async () => {
      await toggleMuteConversation(row.dataset.conversationId, false);
      renderNotificationSettingsModal();
    });
  });
}

async function openNotificationSettingsTab() {
  openSettingsModal("notifications");
  await loadNotificationSettings();
  renderNotificationSettingsModal();
  updatePushStatusUI();
}

const notificationBellButton = document.getElementById("notification-bell-button");
const notificationBellPopover = document.getElementById("notification-bell-popover");
const notificationBellToggle = document.getElementById("notification-bell-toggle");
const notificationBellHint = document.getElementById("notification-bell-popover-hint");
const notificationBellMoreLink = document.getElementById("notification-bell-more-link");
const notificationBellDot = document.getElementById("notification-bell-dot");

function renderNotificationBell() {
  if (isMobileDevice()) {
    notificationBellDot.style.display = "none";
    notificationBellHint.textContent = "Notifications not supported on mobile.";
    return;
  }
  notificationBellToggle.checked = pushNotificationsActive;
  notificationBellDot.style.display = pushNotificationsActive ? "block" : "none";
  notificationBellHint.textContent = pushNotificationsActive
    ? "You'll get push notifications using your default settings."
    : "Notifications are off on this device.";
}

notificationBellButton.addEventListener("click", (e) => {
  e.stopPropagation();
  if (isMobileDevice()) return;
  const isOpen = notificationBellPopover.style.display === "block";
  if (isOpen) {
    notificationBellPopover.style.display = "none";
    return;
  }
  renderNotificationBell();
  notificationBellPopover.style.display = "block";
});

document.addEventListener("click", (e) => {
  if (
    notificationBellPopover.style.display === "block" &&
    !notificationBellPopover.contains(e.target) &&
    e.target !== notificationBellButton
  ) {
    notificationBellPopover.style.display = "none";
  }
});

notificationBellToggle.addEventListener("click", async (e) => {

      notificationBellToggle.disabled = true;
      try {
        await handlePushButtonClick();

        if (pushNotificationsActive) {
          try {
            const { settings } = await apiFetch("/api/notification-settings", {
              method: "PUT",
              body: JSON.stringify({
                dms_enabled: true,
                calls_enabled: true,
                channel_messages_enabled: false,
                mentions_enabled: true,
              }),
            });
            notificationSettings = settings;
          } catch (err) {
            console.error("Failed to reset notification defaults", err);
          }
        }
        renderNotificationBell();
      } finally {
        notificationBellToggle.disabled = false;
      }
    });

notificationBellMoreLink.addEventListener("click", () => {
  notificationBellPopover.style.display = "none";
  openNotificationSettingsTab();
});

notificationSettingsSave.onclick = async () => {
  try {
    const { settings } = await apiFetch("/api/notification-settings", {
      method: "PUT",
      body: JSON.stringify({
        dms_enabled: document.getElementById("notif-dms-enabled").checked,
        calls_enabled: document.getElementById("notif-calls-enabled").checked,
        channel_messages_enabled: document.getElementById("notif-channel-messages-enabled").checked,
        mentions_enabled: document.getElementById("notif-mentions-enabled").checked,
      }),
    });
    notificationSettings = settings;
    showToast("Notification settings saved", { variant: "accent" });
  } catch (err) {
    console.error(err);
    showToast("Failed to save notification settings", { variant: "danger" });
  }
};

    function stripToastEmoji(message) {
      return String(message || "")
        .replace(/[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    function showToast(message, options = {}) {
      const toast = document.createElement("div");
      toast.className = "toast";
      if (options.variant === "danger") toast.classList.add("toast-danger");
      if (options.variant === "accent") toast.classList.add("toast-strong");
      if (options.onClick) toast.style.cursor = "pointer";
      toast.innerHTML = `
        <span>${stripToastEmoji(message)}</span>
        <button class="toast-close">×</button>
      `;
      toastContainer.appendChild(toast);
      const close = () => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      };
      toast.querySelector(".toast-close").addEventListener("click", (e) => {
        e.stopPropagation();
        close();
      });
      if (options.onClick) {
        toast.addEventListener("click", () => {
          options.onClick();
          close();
        });
      }
      setTimeout(close, options.duration || 3500);
    }

    const PRIMARY_THEMES = ["light", "dark", "midnight", "ash"];
    let lastNamedTheme = "dark";
    const ALL_THEMES = [
      { value: "light", label: "Light", group: "core", swatch: "linear-gradient(135deg,#ffffff 40%,#4f46e5)", desc: "Clean bright UI" },
      { value: "dark", label: "Dark", group: "core", swatch: "linear-gradient(135deg,#15171c 40%,#818cf8)", desc: "Default dark" },
      { value: "midnight", label: "Midnight", group: "core", swatch: "linear-gradient(135deg,#0d0d0d 40%,#7dd3fc)", desc: "True black" },
      { value: "ash", label: "Ash", group: "core", swatch: "linear-gradient(135deg,#2b2d31 40%,#5865f2)", desc: "Discord-style" },
      { value: "dracula", label: "Dracula", group: "extra", swatch: "linear-gradient(135deg,#282a36 40%,#bd93f9)", desc: "Purple neon" },
      { value: "nord", label: "Nord", group: "extra", swatch: "linear-gradient(135deg,#2a2f3c 40%,#88c0d0)", desc: "Arctic cool" },
      { value: "rose-pine", label: "Rosé Pine", group: "extra", swatch: "linear-gradient(135deg,#1f1d2e 40%,#eb6f92)", desc: "Soft rose" },
      { value: "sepia", label: "Sepia", group: "extra", swatch: "linear-gradient(135deg,#fbf3e3 40%,#b5651d)", desc: "Warm paper" },
      { value: "forest", label: "Forest", group: "extra", swatch: "linear-gradient(135deg,#1c1b14 40%,#8fae4f)", desc: "Mossy green" },
      { value: "ocean", label: "Ocean", group: "extra", swatch: "linear-gradient(135deg,#0a212c 40%,#14b8c4)", desc: "Deep teal" },
      { value: "sunset", label: "Sunset", group: "extra", swatch: "linear-gradient(135deg,#241a16 40%,#f97316)", desc: "Warm orange" },
      { value: "lavender", label: "Lavender", group: "extra", swatch: "linear-gradient(135deg,#1e1b2e 40%,#a78bfa)", desc: "Soft violet" },
      { value: "aurora", label: "Aurora", group: "extra", swatch: "linear-gradient(135deg,#121c1a 40%,#2dd4bf)", desc: "Northern lights" },
      { value: "ember", label: "Ember", group: "extra", swatch: "linear-gradient(135deg,#1c1212 40%,#ef4444)", desc: "Hot coals" },
      { value: "cosmos", label: "Cosmos", group: "gradient", swatch: "linear-gradient(135deg,#0f0c29,#302b63,#a78bfa)", desc: "Space purple" },
      { value: "horizon", label: "Horizon", group: "gradient", swatch: "linear-gradient(135deg,#0b1026,#1a2744,#fb923c)", desc: "Dusk sky" },
      { value: "mint", label: "Mint", group: "gradient", swatch: "linear-gradient(135deg,#0d1f1a,#134e4a,#2dd4bf)", desc: "Fresh mint" },
      { value: "candy", label: "Candy", group: "gradient", swatch: "linear-gradient(135deg,#2a1030,#7c3aed,#ec4899)", desc: "Pink purple" },
      { value: "slate", label: "Slate", group: "gradient", swatch: "linear-gradient(135deg,#0f172a,#1e293b,#38bdf8)", desc: "Cool slate" },
    ];
    const EXTRA_THEMES = ALL_THEMES.filter((t) => t.group !== "core");

    function themeLabel(theme) {
      if (theme === "custom") return "Custom";
      const found = ALL_THEMES.find((t) => t.value === theme);
      if (found) return found.label;
      if (!theme) return "Theme";
      return theme.charAt(0).toUpperCase() + theme.slice(1);
    }

    function rebuildThemeSelect(selectEl, activeTheme) {
      if (!selectEl) return;
      const current = activeTheme || document.documentElement.getAttribute("data-theme") || "light";
      selectEl.innerHTML = "";
      PRIMARY_THEMES.forEach((v) => {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = themeLabel(v);
        selectEl.appendChild(opt);
      });
      if (current && !PRIMARY_THEMES.includes(current) && current !== "__more__") {
        const opt = document.createElement("option");
        opt.value = current;
        opt.textContent = themeLabel(current);
        opt.dataset.tempSlot = "1";
        selectEl.appendChild(opt);
      }
      const more = document.createElement("option");
      more.value = "__more__";
      more.textContent = "More themes…";
      selectEl.appendChild(more);
      if ([...selectEl.options].some((o) => o.value === current)) selectEl.value = current;
      else selectEl.value = "light";
    }

    function setTheme(theme) {
      if (!theme || theme === "__more__") return;
      if (theme !== "custom") lastNamedTheme = theme;
      document.documentElement.setAttribute("data-theme", theme);
      const root = document.documentElement;
      root.classList.remove("theme-has-gradient-bg");
      root.style.removeProperty("--theme-gradient-bg");
      const gradientThemes = {
        cosmos: "linear-gradient(160deg, #0f0c29 0%, #302b63 50%, #24243e 100%)",
        horizon: "linear-gradient(160deg, #0b1026 0%, #1a2744 55%, #3d1f14 100%)",
        mint: "linear-gradient(160deg, #0d1f1a 0%, #134e4a 55%, #0f766e 100%)",
        candy: "linear-gradient(160deg, #2a1030 0%, #5b21b6 50%, #9d174d 100%)",
        slate: "linear-gradient(160deg, #0f172a 0%, #1e293b 50%, #334155 100%)",
      };
      if (gradientThemes[theme]) {
        root.classList.add("theme-has-gradient-bg");
        root.style.setProperty("--theme-gradient-bg", gradientThemes[theme]);
      }
      rebuildThemeSelect(themeSelect, theme);
      rebuildThemeSelect(settingsTheme, theme);
    }

    function openMoreThemesModal(fromSettings) {
      const modal = document.getElementById("more-themes-modal");
      const grid = document.getElementById("more-themes-modal-grid");
      if (!modal || !grid) return;
      const active = document.documentElement.getAttribute("data-theme") || "light";
      grid.innerHTML = "";

      const groups = [
        { key: "extra", title: "Classic" },
        { key: "gradient", title: "Gradient" },
      ];
      groups.forEach((g) => {
        const items = ALL_THEMES.filter((t) => t.group === g.key && t.value !== "custom");
        if (!items.length) return;
        const section = document.createElement("div");
        section.className = "more-themes-section";
        section.innerHTML = `<div class="more-themes-section-title">${g.title}</div>`;
        const row = document.createElement("div");
        row.className = "more-themes-modal-grid";
        items.forEach((t) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "more-theme-chip" + (active === t.value ? " active" : "");
          btn.innerHTML = `
            <span class="more-theme-swatch" style="background-image:${t.swatch};background-color:#1a1c22;"></span>
            <span class="more-theme-name">${t.label}</span>
            <span class="more-theme-desc">${t.desc || ""}</span>
          `;
          btn.addEventListener("click", async () => {
            modal.classList.remove("visible");
            await handleThemeChange(t.value);
          });
          row.appendChild(btn);
        });
        section.appendChild(row);
        grid.appendChild(section);
      });
      modal.classList.add("visible");
      modal.dataset.fromSettings = fromSettings ? "1" : "0";
    }

    function syncColorPickerMode(target, isGradient) {
      const card = document.getElementById(target === "accent" ? "accent-picker-card" : "bg-picker-card");
      if (!card) return;
      card.querySelectorAll(".color-mode-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.mode === (isGradient ? "gradient" : "solid"));
      });
      const stop2 = card.querySelector(target === "accent" ? ".accent-stop-2" : ".bg-stop-2");
      if (stop2) stop2.style.display = isGradient ? "" : "none";
      const cb = document.getElementById(target === "accent" ? "settings-accent-gradient" : "settings-bg-gradient");
      if (cb) cb.checked = !!isGradient;
      updateColorPickerPreview(target);
    }

    function updateColorPickerPreview(target) {
      const c1 = document.getElementById(target === "accent" ? "settings-accent-color" : "settings-bg-color");
      const c2 = document.getElementById(target === "accent" ? "settings-accent-color-2" : "settings-bg-color-2");
      const cb = document.getElementById(target === "accent" ? "settings-accent-gradient" : "settings-bg-gradient");
      const preview = document.getElementById(target === "accent" ? "accent-preview" : "bg-preview");
      if (!preview || !c1) return;
      if (cb && cb.checked && c2) {
        preview.style.background = `linear-gradient(135deg, ${c1.value}, ${c2.value})`;
      } else {
        preview.style.background = c1.value;
      }
    }

    function applyProfileTheme(profile) {
      if (!profile || !profile.theme || profile.theme === "system") return;
      if (profile.theme !== "custom") lastNamedTheme = profile.theme;
      setTheme(profile.theme);
    }

    function clearAccentOverrides() {
      const root = document.documentElement;
      root.style.removeProperty("--accent-user");
      root.style.removeProperty("--accent-user-gradient");
      root.style.removeProperty("--accent");
      root.style.removeProperty("--accent-hover");
      root.style.removeProperty("--accent-strong");
      root.style.removeProperty("--accent-subtle");
    }

    function applyAccentColor(hex, gradient) {
      const root = document.documentElement;
      if (gradient) {
        root.style.setProperty("--accent-user", hex || "#6366f1");
        root.style.setProperty("--accent-user-gradient", gradient);
        root.style.setProperty("--accent", hex || "#6366f1");
        root.style.setProperty("--accent-hover", hex || "#6366f1");
        root.style.setProperty("--accent-strong", hex || "#6366f1");
      } else if (hex) {
        root.style.setProperty("--accent-user", hex);
        root.style.setProperty("--accent", hex);
        root.style.setProperty("--accent-hover", hex);
        root.style.setProperty("--accent-strong", hex);
        root.style.removeProperty("--accent-user-gradient");
      } else {
        clearAccentOverrides();
      }
    }

    function clearBackgroundOverrides() {
      const root = document.documentElement;
      root.style.removeProperty("--bg-canvas");
      root.style.removeProperty("--surface");
      root.style.removeProperty("--surface-2");
      root.style.removeProperty("--surface-3");
      root.style.backgroundImage = "";
      root.style.backgroundColor = "";
      document.body.style.backgroundImage = "";
      document.body.style.backgroundColor = "";
      document.body.style.background = "";
      root.classList.remove("has-custom-bg-color");
    }

    function applyBackgroundColor(color, gradient) {
      const root = document.documentElement;
      if (gradient) {
        root.style.setProperty("--bg-canvas", color || "#0a0b0e");
        root.style.setProperty("--surface", color || "#0a0b0e");
        root.style.backgroundImage = gradient;
        root.style.backgroundAttachment = "fixed";
        root.style.backgroundColor = color || "#0a0b0e";
        document.body.style.backgroundImage = gradient;
        document.body.style.backgroundAttachment = "fixed";
        document.body.style.backgroundColor = color || "#0a0b0e";
        root.classList.add("has-custom-bg-color");
      } else if (color) {
        root.style.setProperty("--bg-canvas", color);
        root.style.setProperty("--surface", color);
        root.style.backgroundImage = "";
        root.style.backgroundColor = color;
        document.body.style.backgroundImage = "";
        document.body.style.backgroundColor = color;
        document.body.style.background = color;
        root.classList.add("has-custom-bg-color");
      } else {
        clearBackgroundOverrides();
      }
    }

    function detectImageTextMode(imgUrl) {
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            const w = 32, h = 32;
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, w, h);
            const { data } = ctx.getImageData(0, 0, w, h);
            let total = 0;
            for (let i = 0; i < data.length; i += 4) {
              total += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
            }
            const avg = total / (data.length / 4);
            resolve(avg < 130 ? "light" : "dark");
          } catch (err) {

            resolve("light");
          }
        };
        img.onerror = () => resolve("light");
        img.src = imgUrl;
      });
    }

    async function applyChatBackground(profile) {
      if (!chatBodyEl) return;
      const url = profile && profile.background_url;
      let bgImageEl = chatBodyEl.querySelector(".chat-bg-image");
      let bgScrimEl = chatBodyEl.querySelector(".chat-bg-scrim");
      if (!bgImageEl) {
        bgImageEl = document.createElement("div");
        bgImageEl.className = "chat-bg-image";
        chatBodyEl.insertBefore(bgImageEl, chatBodyEl.firstChild);
      }
      if (!bgScrimEl) {
        bgScrimEl = document.createElement("div");
        bgScrimEl.className = "chat-bg-scrim";
        chatBodyEl.insertBefore(bgScrimEl, chatBodyEl.firstChild.nextSibling || null);
      }

      if (!url) {
        chatBodyEl.classList.remove("has-custom-bg");
        chatBodyEl.removeAttribute("data-chat-text-mode");
        bgImageEl.style.backgroundImage = "";
        return;
      }

      chatBodyEl.classList.add("has-custom-bg");
      bgImageEl.style.backgroundImage = `url("${url}")`;

      const appearance = (profile && profile.appearance) || {};
      const mode = appearance.text_color_mode || "auto";
      if (mode === "custom" && appearance.custom_text_color) {
        chatBodyEl.setAttribute("data-chat-text-mode", "custom");
        chatBodyEl.style.setProperty("--chat-custom-text-color", appearance.custom_text_color);
      } else if (mode === "light" || mode === "dark") {
        chatBodyEl.setAttribute("data-chat-text-mode", mode);
      } else {

        const detected = await detectImageTextMode(url);
        chatBodyEl.setAttribute("data-chat-text-mode", detected);
      }
    }

    function applyProfileAppearance(profile) {
      const appearance = (profile && profile.appearance) || {};
      const theme = (profile && profile.theme) || document.documentElement.getAttribute("data-theme") || "light";
      const useCustomColors = theme === "custom";

      if (useCustomColors) {
        let accentGrad = null;
        if (appearance.accent_gradient && appearance.accent_color && appearance.accent_color_2) {
          accentGrad = `linear-gradient(135deg, ${appearance.accent_color}, ${appearance.accent_color_2})`;
        }
        applyAccentColor(appearance.accent_color || null, accentGrad);
        let bgGrad = null;
        if (appearance.bg_gradient && appearance.bg_color && appearance.bg_color_2) {
          bgGrad = `linear-gradient(160deg, ${appearance.bg_color}, ${appearance.bg_color_2})`;
        }
        if (!profile || !profile.background_url) {
          applyBackgroundColor(appearance.bg_color || null, bgGrad);
        } else {
          clearBackgroundOverrides();
        }
      } else {
        clearAccentOverrides();
        clearBackgroundOverrides();
      }
      document.documentElement.setAttribute("data-density", appearance.density || "comfortable");
      document.documentElement.setAttribute("data-corners", appearance.corner_style || "rounded");
      applyChatBackground(profile);
    }

    async function handleThemeChange(theme) {
      if (!theme || theme === "__more__") return;
      setTheme(theme);
      if (theme !== "custom") {
        clearAccentOverrides();
        clearBackgroundOverrides();
      } else if (currentProfile) {
        applyProfileAppearance({ ...currentProfile, theme: "custom" });
      }
      if (!currentUser) return;
      try {
        const payload = { theme };
        if (theme !== "custom" && currentProfile && currentProfile.appearance) {
          payload.appearance = {
            ...currentProfile.appearance,
            accent_color: null,
            accent_color_2: null,
            accent_gradient: false,
            bg_color: null,
            bg_color_2: null,
            bg_gradient: false,
          };
        }
        const { profile } = await apiFetch("/api/profile", {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        currentProfile = profile;
        applyProfileAppearance(profile);
      } catch (err) {
        console.error(err);
        showToast(err.message || "Theme changed, but failed to save it to your profile", { variant: "danger" });
      }
    }

    function getInitials(name) {
      if (!name) return "?";
      const parts = name.trim().split(/\s+/);
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    const DEFAULT_AVATAR_SVG = `
      <svg viewBox="0 0 40 40" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Default avatar">
        <defs>
          <linearGradient id="default-avatar-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#334155"/>
            <stop offset="100%" stop-color="#1e293b"/>
          </linearGradient>
        </defs>
        <rect width="40" height="40" fill="url(#default-avatar-grad)"/>
        <circle cx="20" cy="16" r="7" fill="#64748b"/>
        <path d="M6 36c0-8 6.3-13 14-13s14 5 14 13" fill="#64748b"/>
      </svg>
    `;

    function formatMessageContent(content) {
      const escaped = escapeHtml(content || "");
      return escaped.replace(/@([a-zA-Z0-9_]{2,32})/g, (match, handle) => {
        const isMe = currentProfile && handle.toLowerCase() === (currentProfile.username || "").toLowerCase();

        const known = findKnownUserByUsername(handle);
        const avatar = known ? avatarHTML(known) : DEFAULT_AVATAR_SVG;
        return `<span class="mention-token${isMe ? " mention-token-me" : ""}" data-mention-handle="${escapeHtml(handle)}">${avatar}<span class="mention-token-name">@${handle}</span></span>`;
      });
    }

    function applyMessageContentTruncation(contentEl) {
      if (!contentEl) return;

      const existingBtn = contentEl.nextElementSibling;
      if (existingBtn && existingBtn.classList && existingBtn.classList.contains("message-show-more")) {
        existingBtn.remove();
      }
      contentEl.classList.remove("clamped");

      requestAnimationFrame(() => {
        if (!contentEl.isConnected) return;
        contentEl.classList.add("clamped");
        const isTruncated = contentEl.scrollHeight - contentEl.clientHeight > 2;
        if (!isTruncated) {
          contentEl.classList.remove("clamped");
          return;
        }

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "message-show-more";
        btn.textContent = "Show more";
        btn.addEventListener("click", () => {
          const expanded = !contentEl.classList.contains("clamped");
          if (expanded) {
            contentEl.classList.add("clamped");
            btn.textContent = "Show more";
          } else {
            contentEl.classList.remove("clamped");
            btn.textContent = "Show less";
          }
        });
        contentEl.insertAdjacentElement("afterend", btn);
      });
    }

    function autoResizeTextarea(el) {
      if (!el) return;
      const maxHeight = 200;
      el.style.height = "auto";
      const newHeight = Math.min(el.scrollHeight, maxHeight);
      el.style.height = newHeight + "px";
      el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
    }

    function findKnownUserByUsername(handle) {
      const needle = handle.toLowerCase();
      const pools = [
        currentServerMembers ? currentServerMembers.map((m) => m.user) : [],
        currentDmOtherUser ? [currentDmOtherUser] : [],
        mentionSuggestions || [],
      ];
      for (const pool of pools) {
        const match = pool.find((u) => u && u.username && u.username.toLowerCase() === needle);
        if (match) return match;
      }
      return null;
    }

    async function handleMentionTokenClick(handle) {
      const known = findKnownUserByUsername(handle);
      if (known) {
        openViewProfileModal(known);
        return;
      }

      try {
        const { user } = await apiFetch(`/api/users/by-username/${encodeURIComponent(handle)}`);
        if (user) openViewProfileModal(user);
      } catch (err) {
        showToast("Couldn't find that user", { variant: "danger" });
      }
    }

    document.addEventListener("click", (e) => {
      const token = e.target.closest(".mention-token");
      if (token && token.dataset.mentionHandle) {
        e.stopPropagation();
        handleMentionTokenClick(token.dataset.mentionHandle);
      }
    });

    let mentionDropdownEl = null;
    let mentionSuggestions = [];
    let mentionActiveIndex = 0;
    let mentionTargetInput = null;
    let mentionQueryStart = 0;

    function closeMentionDropdown() {
      if (mentionDropdownEl) mentionDropdownEl.remove();
      mentionDropdownEl = null;
      mentionTargetInput = null;
      mentionSuggestions = [];
    }

    function getMentionQuery(inputEl) {
      const cursor = inputEl.selectionStart;
      const value = inputEl.value.slice(0, cursor);
      const at = value.lastIndexOf("@");
      if (at === -1) return null;
      const between = value.slice(at + 1);
      if (/\s/.test(between)) return null;
      if (at > 0 && /\S/.test(value[at - 1]) && value[at - 1] !== " ") {

        if (!/^[\s(]|^$/.test(value[at - 1])) return null;
      }
      return { start: at, query: between };
    }

    function updateMentionSuggestions(inputEl, getMembersFn) {
      const info = getMentionQuery(inputEl);
      if (!info) {
        closeMentionDropdown();
        return;
      }
      const query = info.query.toLowerCase();
      const candidates = (getMembersFn() || []).filter(
        (u) => u && u.username && u.username.toLowerCase().startsWith(query) && (!currentUser || u.id !== currentUser.id)
      );

      const seen = new Set();

      mentionSuggestions = candidates.filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true))).slice(0, 30);

      if (!mentionSuggestions.length) {
        closeMentionDropdown();
        return;
      }

      mentionTargetInput = inputEl;
      mentionQueryStart = info.start;
      mentionActiveIndex = 0;
      renderMentionDropdown(inputEl);
    }

    function renderMentionDropdown(inputEl) {
      if (!mentionDropdownEl) {
        mentionDropdownEl = document.createElement("div");
        mentionDropdownEl.className = "mention-suggestions mention-scroll-limited";
        document.body.appendChild(mentionDropdownEl);
      }
      const rect = inputEl.getBoundingClientRect();

      const visibleRows = Math.min(mentionSuggestions.length, 5);

      mentionDropdownEl.innerHTML = mentionSuggestions
        .map(
          (u, i) => `
        <div class="mention-suggestion-item${i === mentionActiveIndex ? " active" : ""}" data-index="${i}">
          ${avatarHTML(u)}
          <span>${escapeHtml(u.username)}</span>
        </div>
      `
        )
        .join("");

      clampToViewport(mentionDropdownEl, rect.left, rect.top - visibleRows * 32 - 8);

      mentionDropdownEl.querySelectorAll(".mention-suggestion-item").forEach((el) => {
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          selectMentionSuggestion(mentionSuggestions[Number(el.dataset.index)]);
        });
      });
    }

    function selectMentionSuggestion(user) {
      if (!mentionTargetInput || !user) return;
      const inputEl = mentionTargetInput;
      const cursor = inputEl.selectionStart;
      const before = inputEl.value.slice(0, mentionQueryStart);
      const after = inputEl.value.slice(cursor);
      const insertion = `@${user.username} `;
      inputEl.value = before + insertion + after;
      const newCursor = before.length + insertion.length;
      inputEl.focus();
      inputEl.setSelectionRange(newCursor, newCursor);
      closeMentionDropdown();
    }

    function handleMentionKeydown(e, inputEl) {
      if (!mentionDropdownEl || mentionTargetInput !== inputEl || !mentionSuggestions.length) return false;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        mentionActiveIndex = (mentionActiveIndex + 1) % mentionSuggestions.length;
        renderMentionDropdown(inputEl);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        mentionActiveIndex = (mentionActiveIndex - 1 + mentionSuggestions.length) % mentionSuggestions.length;
        renderMentionDropdown(inputEl);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectMentionSuggestion(mentionSuggestions[mentionActiveIndex]);
        return true;
      }
      if (e.key === "Escape") {
        closeMentionDropdown();
        return true;
      }
      return false;
    }

    document.addEventListener("click", (e) => {
      if (mentionDropdownEl && !mentionDropdownEl.contains(e.target) && e.target !== mentionTargetInput) {
        closeMentionDropdown();
      }
    });

    function avatarHTML(user) {
      if (user && user.avatar_url) {
        const name = escapeHtml(user.username || "");
        return `<img src="${user.avatar_url}" alt="${name}" loading="lazy">`;
      }
      return DEFAULT_AVATAR_SVG;
    }

    function getAppBaseUrl() {
      const dir = window.location.pathname.replace(/[^/]*$/, "");
      return `${window.location.origin}${dir}`;
    }

    function isMobileDevice() {
      return (
        window.matchMedia("(max-width: 680px)").matches ||
        /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent || "")
      );
    }

    function applyMobileNotificationLock() {
      const mobile = isMobileDevice();
      const bellButton = document.getElementById("notification-bell-button");
      const pushButton = document.getElementById("notification-enable-push");
      const bellHint = document.getElementById("notification-bell-popover-hint");
      const pushHint = document.getElementById("notification-push-hint");
      const pushStatusText = document.getElementById("notification-push-status-text");
      const pushStatusDot = document.getElementById("notification-push-status-dot");
      const bellPopover = document.getElementById("notification-bell-popover");

      if (bellButton) {
        bellButton.classList.toggle("notif-mobile-disabled", mobile);
        bellButton.title = mobile ? "Notifications not supported on mobile" : "Notifications";
      }
      if (pushButton) {
        pushButton.classList.toggle("notif-mobile-disabled", mobile);
        pushButton.title = mobile ? "Notifications not supported on mobile" : "";
      }
      if (mobile) {
        if (bellPopover) bellPopover.style.display = "none";
        if (bellHint) bellHint.textContent = "Notifications not supported on mobile.";
        if (pushHint) pushHint.textContent = "Notifications not supported on mobile.";
        if (pushStatusText) pushStatusText.textContent = "Notifications not supported on mobile";
        if (pushStatusDot) pushStatusDot.className = "push-status-dot is-blocked";
      }
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function clampToViewport(el, left, top, margin = 8) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const maxLeft = Math.max(margin, window.innerWidth - w - margin);
      const maxTop = Math.max(margin, window.innerHeight - h - margin);
      el.style.left = `${Math.min(Math.max(left, margin), maxLeft)}px`;
      el.style.top = `${Math.min(Math.max(top, margin), maxTop)}px`;
    }

    function positionAnchoredPopover(el, anchorRect, margin = 8, gap = 8) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const isCompact = el.classList.contains("is-compact");
      const preferredH = isCompact ? Math.min(280, Math.max(el.offsetHeight || 200, 180)) : 360;
      const w = Math.min(el.offsetWidth || 320, vw - margin * 2);

      const spaceBelow = vh - anchorRect.bottom - margin - gap;
      const spaceAbove = anchorRect.top - margin - gap;

      const openAbove =
        spaceBelow < preferredH * 0.6 ||
        (anchorRect.bottom > vh * 0.55 && spaceAbove >= Math.min(spaceBelow, preferredH * 0.5));

      const available = openAbove ? spaceAbove : spaceBelow;
      const h = isCompact
        ? Math.min(preferredH, available > 40 ? available : vh - margin * 2)
        : Math.max(200, Math.min(preferredH, available > 40 ? available : vh - margin * 2));

      el.style.width = `${Math.min(320, vw - margin * 2)}px`;
      if (isCompact) {
        el.style.height = "auto";
        el.style.maxHeight = `${Math.max(160, h)}px`;
      } else {
        el.style.height = `${h}px`;
        el.style.maxHeight = `${h}px`;
      }

      let top = openAbove
        ? anchorRect.top - gap - h
        : anchorRect.bottom + gap;

      if (top < margin) top = margin;
      if (top + h > vh - margin) top = Math.max(margin, vh - h - margin);

      let left = anchorRect.left;
      const maxLeft = Math.max(margin, vw - w - margin);
      left = Math.min(Math.max(left, margin), maxLeft);

      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }

    const EMOJI_CATEGORIES = [
      { name: "Recent", icon: "🕐", emojis: [] },
      {
        name: "Smileys",
        icon: "😀",
        emojis: [
          "😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","☺️","😚",
          "😙","🥲","😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔","🤐","🤨","😐","😑","😶","😏","😒","🙄",
          "😬","🤥","😌","😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤮","🤧","🥵","🥶","🥴","😵","😵‍💫","🤯","🤠",
          "🥳","🥸","😎","🤓","🧐","😕","😟","🙁","☹️","😮","😯","😲","😳","🥺","😦","😧","😨","😰","😥","😢",
          "😭","😱","😖","😣","😞","😓","😩","😫","🥱","😤","😡","😠","🤬","😈","👿","💀","☠️","💩","🤡","👹",
          "👺","👻","👽","👾","🤖",
        ],
      },
      {
        name: "People",
        icon: "👋",
        emojis: [
          "👋","🤚","🖐️","✋","🖖","🫡","👌","🤌","🤏","✌️","🤞","🤟","🤘","🤙","👈","👉","👆","🖕","👇","☝️",
          "👍","👎","✊","👊","🤛","🤜","👏","🙌","👐","🤲","🤝","🙏","✍️","💅","🤳","💪","🫶","🫀","🫁","🦷",
          "🦴","👀","👁️","👅","👄","💋","🫦","👶","🧒","👦","👧","🧑","👱","👨","🧔","👩","🧓","👴","👵","🙍",
          "🙎","🙅","🙆","💁","🙋","🧏","🙇","🤦","🤷","👮","🕵️","💂","🥷","👷","🤴","👸","👰","🤵","🤰","🤱",
          "👼","🎅","🤶","🦸","🦹","🧙","🧚","🧛","🧜","🧝","🧞","🧟","💆","💇","🚶","🧍","🧎","🏃","💃","🕺",
        ],
      },
      {
        name: "Animals",
        icon: "🐶",
        emojis: [
          "🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐔","🐧",
          "🐦","🐤","🦆","🦅","🦉","🦇","🐺","🐗","🐴","🦄","🐝","🪱","🐛","🦋","🐌","🐞","🐜","🦟","🦗","🕷️",
          "🦂","🐢","🐍","🦎","🦖","🦕","🐙","🦑","🦐","🦞","🦀","🐡","🐠","🐟","🐬","🐳","🐋","🦈","🐊","🐅",
          "🐆","🦓","🦍","🦧","🦣","🐘","🦛","🦏","🐪","🐫","🦒","🦘","🦬","🐃","🐂","🐄","🐎","🐖","🐏","🐑",
          "🦙","🐐","🦌","🐕","🐩","🦮","🐈","🐈‍⬛","🐓","🦃","🦤","🦚","🦜","🦢","🦩","🕊️","🐇","🦝","🦨","🦡",
          "🦫","🦦","🦥","🐁","🐀","🐿️","🦔","🐾","🐉","🐲",
        ],
      },
      {
        name: "Nature",
        icon: "🌿",
        emojis: [
          "🌵","🎄","🌲","🌳","🌴","🌱","🌿","☘️","🍀","🎍","🎋","🍃","🍂","🍁","🍄","🐚","🪨","🌾","💐","🌷",
          "🌹","🥀","🌺","🌸","🌼","🌻","🌞","🌝","🌛","🌜","🌚","🌕","🌖","🌗","🌘","🌑","🌒","🌓","🌔","🌙",
          "🌟","⭐","🌠","🌌","☁️","⛅","🌤️","⛈️","🌧️","🌨️","❄️","☃️","⛄","🌬️","💨","💧","💦","🌊","🌈","🌫️",
          "🌀","🌪️","🌩️","⚡","🔥","💥","🌍","🌎","🌏","🗺️","🏔️","⛰️","🌋","🏕️","🏖️","🏜️","🏝️","🏞️",
        ],
      },
      {
        name: "Food",
        icon: "🍔",
        emojis: [
          "🍏","🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🫒","🥑",
          "🍆","🥔","🥕","🌽","🌶️","🫑","🥒","🥬","🥦","🧄","🧅","🍄","🥜","🌰","🍞","🥐","🥖","🫓","🥨","🥯",
          "🧀","🥚","🍳","🧈","🥞","🧇","🥓","🥩","🍗","🍖","🌭","🍔","🍟","🍕","🫔","🌮","🌯","🥙","🧆","🥘",
          "🍲","🫕","🥣","🥗","🍿","🧂","🥫","🍱","🍙","🍚","🍛","🍜","🍝","🍠","🍣","🍤","🍥","🥮","🍡","🥟",
          "🥠","🥡","🍦","🍧","🍨","🍩","🍪","🎂","🍰","🧁","🥧","🍫","🍬","🍭","🍯","🍼","🥛","☕","🫖","🍵",
          "🧃","🥤","🧋","🍶","🍺","🍻","🥂","🍷","🥃","🍸","🍹","🧉","🍾",
        ],
      },
      {
        name: "Travel",
        icon: "✈️",
        emojis: [
          "🚗","🚕","🚙","🚌","🏎️","🚓","🚑","🚒","🚐","🛻","🚚","🚛","🚜","🏍️","🛵","🛺","🚲","🛴","🛹","🚏",
          "⛽","🚨","🚥","🚦","🛑","⚓","⛵","🛶","🚤","🛳️","⛴️","🚢","✈️","🛩️","🛫","🛬","💺","🚁","🚀","🛸",
          "🏔️","⛰️","🌋","🏕️","🏖️","🏜️","🏝️","🏞️","🏟️","🏛️","🏗️","🏘️","🏚️","🏠","🏡","🏢","🏣","🏤","🏥","🏦",
          "🏨","🏩","🏪","🏫","🏬","🏭","🏯","🏰","💒","🗼","🗽","⛪","🕌","🛕","🕍","⛩️","🕋","⛲","🎠","🎡",
          "🎢","🎪","🌁","🌃","🏙️","🌄","🌅","🌆","🌇","🌉","🗺️",
        ],
      },
      {
        name: "Activities",
        icon: "⚽",
        emojis: [
          "⚽","🏀","🏈","⚾","🥎","🎾","🏐","🏉","🥏","🎱","🏓","🏸","🏒","🥅","⛳","🎣","🤿","🥊","🥋","🎽",
          "🛹","🛷","⛸️","🥌","🎿","⛷️","🏂","🏋️","🤸","⛹️","🤺","🏇","🧘","🧗","🚵","🚴","🏆","🥇","🥈","🥉",
          "🏅","🎖️","🏵️","🎗️","🎫","🎟️","🎪","🤹","🎭","🩰","🎨","🎬","🎤","🎧","🎼","🎵","🎶","🥁","🎷","🎺",
          "🎸","🪕","🎻","🎲","♟️","🎯","🎳","🎮","🎰","🧩",
        ],
      },
      {
        name: "Objects",
        icon: "💡",
        emojis: [
          "📱","💻","⌨️","🖥️","🖨️","🖱️","💽","💾","💿","📀","📺","📷","📸","📹","🎥","📽️","🎞️","📞","☎️","📟",
          "📡","🔋","🔌","💡","🔦","🕯️","💰","💳","🪙","✉️","📧","📨","📩","📦","📫","📬","📭","📮","✏️","✒️",
          "🖊️","📝","📁","📂","🗂️","📅","📆","📇","📈","📉","📊","📋","📌","📍","📎","✂️","🗃️","🗄️","🗑️","🔒",
          "🔓","🔑","🗝️","🔨","⚒️","🛠️","⚔️","🔫","🛡️","🔧","🔩","⚙️","⚖️","🔗","🧲","🪜","🧪","🧫","🧬","🔬",
          "🔭","💊","💉","🩸","🩹","🩺","🪞","🛏️","🛋️","🚪","🧴","🧹","🧺","🧻","🧼","🧽","🛒","🚬","🪦","🧿",
          "📿","🪬",
        ],
      },
      {
        name: "Symbols",
        icon: "❤️",
        emojis: [
          "❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❤️‍🔥","❤️‍🩹","❣️","💕","💞","💓","💗","💖","💘","💝",
          "💟","☮️","✝️","☪️","🕉️","☸️","✡️","☯️","☦️","🛐","♈","♉","♊","♋","♌","♍","♎","♏","♐","♑","♒","♓",
          "🆔","⚛️","☢️","☣️","📴","📳","✴️","🆚","💮","㊙️","㊗️","🅰️","🅱️","🆎","🆑","🅾️","🆘","❌","⭕","🛑",
          "⛔","📛","🚫","💯","💢","♨️","🚷","🚯","🚳","🚱","🔞","📵","🚭","❗","❕","❓","❔","‼️","⁉️","🔅","🔆",
          "⚠️","🚸","🔱","⚜️","🔰","♻️","✅","❇️","✳️","❎","🌐","💠","💤","🏧","♿","🅿️","🈳","🚹","🚺","🚼",
          "🚻","⚧️","▶️","⏩","⏭️","⏯️","◀️","⏪","⏮️","⏸️","⏹️","⏺️","⏏️","➕","➖","➗","✖️","💲","💱","™️","©️",
          "®️","✔️","☑️","🔴","🟠","🟡","🟢","🔵","🟣","⚫","⚪","🟤","🔺","🔻","🔷","🔶","🔹","🔸","💬","💭",
          "🗯️","♠️","♣️","♥️","♦️","🃏","🎴","🀄",
        ],
      },
      { name: "Custom", icon: "⭐", emojis: [] },
    ];

    const EMOJI_KEYWORDS = new Map([
      ["😀","grinning happy smile"], ["😁","grin happy smile"], ["😂","laugh cry funny lol"],
      ["🤣","rofl laugh funny"], ["😊","smile blush happy"], ["😇","angel innocent halo"],
      ["🙂","smile slight"], ["🙃","upside down silly"], ["😉","wink"], ["😍","love heart eyes"],
      ["🥰","love hearts adore"], ["😘","kiss love"], ["😗","kiss"], ["😋","yum tongue tasty"],
      ["😛","tongue silly"], ["😜","wink tongue silly"], ["🤪","zany crazy silly"],
      ["🤨","suspicious eyebrow"], ["🧐","monocle thinking curious"], ["🤓","nerd glasses"],
      ["😎","cool sunglasses"], ["🥸","disguise glasses"], ["🤩","starstruck excited amazed"],
      ["🥳","party celebrate birthday"], ["😏","smirk"], ["😒","unamused annoyed"],
      ["😞","disappointed sad"], ["😔","pensive sad"], ["😟","worried"], ["😕","confused"],
      ["🙁","frown sad"], ["☹️","frown sad"], ["😣","persevere struggle"], ["😖","confounded"],
      ["😫","tired exhausted weary"], ["😩","weary tired"], ["🥺","pleading please cute"],
      ["😢","cry sad tear"], ["😭","sob cry sad bawling"], ["😤","triumph huff annoyed"],
      ["😠","angry mad"], ["😡","angry rage mad furious"], ["🤬","cursing swearing angry"],
      ["🤯","mind blown shocked"], ["😳","flushed embarrassed shocked"], ["🥵","hot sweating"],
      ["🥶","cold freezing"], ["😱","scream shocked scared"], ["😨","fearful scared"],
      ["😰","anxious sweat nervous"], ["😥","sad relieved disappointed"], ["😓","sweat tired"],
      ["🤗","hug"], ["🤔","thinking"], ["🤭","giggle oops"], ["🤫","shush quiet secret"],
      ["🤥","lying pinocchio"], ["😶","speechless blank"], ["😐","neutral meh"],
      ["😑","expressionless meh"], ["😬","grimace awkward"], ["🙄","eyeroll annoyed"],
      ["😯","surprised gasp"], ["😦","frowning surprised"], ["😧","anguished shocked"],
      ["😮","surprised open mouth wow"], ["😲","astonished shocked"], ["🥱","yawn tired bored"],
      ["😴","sleep tired zzz"], ["🤤","drool"], ["😪","sleepy tired"], ["😵","dizzy confused"],
      ["😵‍💫","dizzy spiral confused"], ["🤐","zipper mouth quiet"], ["🥴","woozy drunk dizzy"],
      ["🤢","sick nauseous"], ["🤮","vomit sick"], ["🤧","sneeze sick"], ["😷","mask sick"],
      ["🤒","sick thermometer fever"], ["🤕","hurt bandage injured"], ["🥹","holding back tears touched"],
      ["😈","devil evil smirk"], ["👿","devil angry"], ["👻","ghost spooky"], ["💀","skull dead"],
      ["☠️","skull crossbones dead danger"], ["👽","alien"], ["🤖","robot"], ["🎃","pumpkin halloween"],
      ["😺","cat happy"], ["😸","cat grin happy"], ["😹","cat laugh"], ["😻","cat love heart eyes"],
      ["😼","cat smirk"], ["😽","cat kiss"], ["🙀","cat scared"], ["😿","cat cry sad"],
      ["😾","cat angry pout"],
      ["👍","thumbs up yes good"], ["👎","thumbs down no bad"], ["👏","clap applause"],
      ["🙌","hands raised celebrate"], ["🙏","pray please thanks"], ["👋","wave hi hello bye"],
      ["🤝","handshake deal agree"], ["💪","muscle strong flex"], ["🤙","call shaka"],
      ["✌️","peace victory"], ["🤞","fingers crossed luck hope"], ["🫶","heart hands love"],
      ["👌","ok okay perfect"], ["🤟","love you sign"], ["👊","fist bump punch"],
      ["✊","fist power solidarity"], ["🤛","fist bump left"], ["🤜","fist bump right"],
      ["👆","point up"], ["👇","point down"], ["👈","point left"], ["👉","point right"],
      ["☝️","point up one"], ["✋","hand stop raised"], ["🖐️","hand splayed"], ["🤚","hand back raised"],
      ["🖖","vulcan salute"], ["🫡","salute respect"], ["🫠","melting"], ["💅","nails done"],
      ["🖤","black heart"], ["💔","broken heart sad"], ["❤️","heart love red"], ["🧡","heart orange love"],
      ["💛","heart yellow love"], ["💚","heart green love"], ["💙","heart blue love"],
      ["💜","heart purple love"], ["🤍","white heart love"], ["🤎","brown heart love"],
      ["💕","hearts love"], ["💞","hearts love spin"], ["💓","heartbeat love"],
      ["💗","heart growing love"], ["💖","sparkling heart love"], ["💘","heart arrow cupid love"],
      ["💝","heart gift love"], ["❤️‍🔥","heart on fire love passion"], ["❤️‍🩹","heart mending healing"],
      ["✨","sparkles shine magic"], ["🔥","fire lit hot"], ["💯","hundred perfect"],
      ["💥","boom explosion"], ["🎉","party celebrate confetti"], ["🎊","confetti party"],
      ["🎁","gift present"], ["🏆","trophy win champion"], ["🥇","gold medal first winner"],
      ["⭐","star favorite"], ["🌟","star sparkle"], ["⚡","lightning zap energy"],
      ["💧","water drop tear"], ["🌈","rainbow pride"], ["☀️","sun sunny weather"],
      ["🌙","moon night"], ["☁️","cloud weather"], ["❄️","snow cold winter"], ["⛄","snowman"],
      ["🍕","pizza food"], ["🍔","burger food"], ["🍟","fries food"], ["🌮","taco food"],
      ["🍣","sushi food"], ["🍰","cake dessert food"], ["🍪","cookie dessert"],
      ["☕","coffee drink"], ["🍺","beer drink"], ["🍷","wine drink"], ["🥂","cheers champagne toast"],
      ["🎂","birthday cake"], ["🍎","apple fruit"], ["🍉","watermelon fruit"],
      ["🍓","strawberry fruit"], ["🥑","avocado food"], ["🍩","donut dessert"],
      ["🍫","chocolate candy"], ["🍿","popcorn movie snack"], ["🥤","drink soda cup"],
      ["🍜","noodles ramen food"], ["🥗","salad healthy food"], ["🌭","hotdog food"],
      ["⚽","soccer football sport"], ["🏀","basketball sport"], ["🏈","football sport"],
      ["⚾","baseball sport"], ["🎾","tennis sport"], ["🏐","volleyball sport"],
      ["🎮","gaming controller"], ["🎧","headphones music"], ["🎸","guitar music"],
      ["🎹","piano music"], ["🎤","microphone karaoke sing"], ["🎬","movie clapper film"],
      ["🎯","target dart bullseye"], ["🎲","dice game"], ["🚀","rocket launch space"],
      ["✈️","airplane travel flight"], ["🚗","car drive"], ["🚕","taxi cab"], ["🚲","bike bicycle"],
      ["🏠","house home"], ["🏢","building office"], ["🏖️","beach vacation"], ["⛰️","mountain"],
      ["🗻","mountain fuji"], ["🏕️","camping tent"],
      ["💻","laptop computer"], ["🖥️","desktop computer"], ["📱","phone mobile"],
      ["📸","camera photo picture"], ["🎥","video camera film"], ["📺","tv television"],
      ["🕐","clock time"], ["⏰","alarm clock time"], ["📅","calendar date"], ["⏳","hourglass time"],
      ["✅","check done yes correct"], ["☑️","checkbox done"], ["❌","x no wrong cross"],
      ["❓","question mark confused"], ["❗","exclamation important"], ["⚠️","warning caution"],
      ["🚫","no forbidden banned"], ["🔴","red circle stop"], ["🟢","green circle go"],
      ["🟡","yellow circle warning"], ["💤","sleep zzz"], ["💬","speech bubble chat talk"],
      ["👀","eyes look watching"], ["🧠","brain smart mind"], ["💡","idea lightbulb"],
      ["📌","pin note"], ["📎","paperclip attach"], ["🔗","link chain"],
      ["🔒","lock secure private"], ["🔓","unlock open"], ["🎈","balloon party"],
      ["🎓","graduation cap school"], ["📚","books study"], ["✏️","pencil write"],
      ["📝","memo note write"], ["📈","chart up growth stonks"], ["📉","chart down decline"],
      ["💰","money bag cash"], ["💸","money flying spending"], ["💳","credit card pay"],
      ["🤡","clown"], ["💩","poop"], ["🙈","see no evil monkey"], ["🙉","hear no evil monkey"],
      ["🙊","speak no evil monkey"], ["🐶","dog"], ["🐱","cat"], ["🐭","mouse"], ["🐹","hamster"],
      ["🐰","rabbit bunny"], ["🦊","fox"], ["🐻","bear"], ["🐼","panda"], ["🐨","koala"],
      ["🐯","tiger"], ["🦁","lion"], ["🐮","cow"], ["🐷","pig"], ["🐸","frog"], ["🐵","monkey"],
      ["🦄","unicorn"], ["🐝","bee"], ["🦋","butterfly"], ["🐢","turtle"], ["🐍","snake"],
      ["🦖","dinosaur trex"], ["🐳","whale"], ["🐬","dolphin"], ["🦈","shark"], ["🐙","octopus"],
    ]);

    const EMOJI_SEARCH_POOL = EMOJI_CATEGORIES.filter(
      (c) => c.name !== "Recent" && c.name !== "Custom"
    ).flatMap((c) => c.emojis);

    const RECENT_EMOJI_STORAGE_KEY = "vexacloud-recent-emoji";
    const MAX_RECENT_EMOJI = 32;

    function loadRecentEmoji() {
      try {
        const raw = localStorage.getItem(RECENT_EMOJI_STORAGE_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
      } catch (err) {
        return [];
      }
    }

    function recordRecentEmoji(emoji) {
      try {
        const list = loadRecentEmoji().filter((e) => e !== emoji);
        list.unshift(emoji);
        localStorage.setItem(RECENT_EMOJI_STORAGE_KEY, JSON.stringify(list.slice(0, MAX_RECENT_EMOJI)));
      } catch (err) {

      }
    }

    const EMOJI_CHAR_RE =
      /\p{Extended_Pictographic}(?:\u200d\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}]|\uFE0F)*/u;

    function reactionSummaryHTML(reactions) {
      if (!reactions || !reactions.length) return "";
      const groups = new Map();
      reactions.forEach((r) => {
        if (!groups.has(r.emoji)) groups.set(r.emoji, []);
        groups.get(r.emoji).push(r.user_id);
      });
      return Array.from(groups.entries())
        .map(([emoji, userIds]) => {
          const mine = currentUser && userIds.includes(currentUser.id);
          return `
            <button class="reaction-pill ${mine ? "mine" : ""}" data-emoji="${escapeHtml(emoji)}">
              <span>${emoji}</span><span class="reaction-count">${userIds.length}</span>
            </button>
          `;
        })
        .join("");
    }

    async function toggleReaction(message, emoji) {
      const mine =
        currentUser &&
        (message.reactions || []).some((r) => r.emoji === emoji && r.user_id === currentUser.id);

      if (!message.reactions) message.reactions = [];
      if (mine) {
        message.reactions = message.reactions.filter(
          (r) => !(r.emoji === emoji && r.user_id === currentUser.id)
        );
      } else {
        message.reactions.push({ emoji, user_id: currentUser.id });
        recordRecentEmoji(emoji);
      }
      const row = messageListEl.querySelector(`[data-message-id="${message.id}"]`);
      if (row) {
        const container = row.querySelector(".message-reactions");
        if (container) container.innerHTML = reactionSummaryHTML(message.reactions);

        row.querySelectorAll(".reaction-pill").forEach((btn) => {
          btn.addEventListener("click", () => toggleReaction(message, btn.dataset.emoji));
        });
      }
      try {
        if (mine) {
          await apiFetch(`/api/messages/${message.id}/reactions`, {
            method: "DELETE",
            body: JSON.stringify({ emoji }),
          });
        } else {
          await apiFetch(`/api/messages/${message.id}/reactions`, {
            method: "POST",
            body: JSON.stringify({ emoji }),
          });
        }
      } catch (err) {
        console.error(err);
        showToast("Failed to react", { variant: "danger" });
      }
    }

    let openEmojiPickerEl = null;
    let openEmojiPickerAnchor = null;

    function closeEmojiPicker() {
      if (openEmojiPickerEl) openEmojiPickerEl.remove();
      openEmojiPickerEl = null;
      openEmojiPickerAnchor = null;
      document.removeEventListener("click", closeEmojiPickerOnOutsideClick);
    }

    function openEmojiPicker(anchorEl, message) {
      const alreadyOpenForThisAnchor = openEmojiPickerEl && openEmojiPickerAnchor === anchorEl;
      closeContextMenus();
      if (alreadyOpenForThisAnchor) return;
      const picker = document.createElement("div");
      picker.className = "emoji-picker emoji-picker-grid-mode";
      picker.innerHTML = `
        <div class="emoji-picker-tabs">
          ${EMOJI_CATEGORIES.map(
            (c, i) =>
              `<button type="button" class="emoji-picker-tab${i === 0 ? " active" : ""}" data-category="${c.name}" title="${c.name}">${c.icon}</button>`
          ).join("")}
        </div>
        <input type="text" class="emoji-picker-search" placeholder="Search emoji…" />
        <div class="emoji-picker-category-label"></div>
        <div class="emoji-picker-grid"></div>
      `;
      document.body.appendChild(picker);

      const tabsEl = picker.querySelector(".emoji-picker-tabs");
      const searchInput = picker.querySelector(".emoji-picker-search");
      const categoryLabel = picker.querySelector(".emoji-picker-category-label");
      const grid = picker.querySelector(".emoji-picker-grid");
      let activeCategory = EMOJI_CATEGORIES[0].name;

      function pickEmoji(emoji) {
        toggleReaction(message, emoji);
        closeEmojiPicker();
      }

      function renderList(list, emptyMessage) {
        grid.innerHTML = list.length
          ? list.map((e) => `<button type="button" class="emoji-picker-option" data-emoji="${e}">${e}</button>`).join("")
          : `<div class="empty-state-small">${emptyMessage}</div>`;
        grid.querySelectorAll(".emoji-picker-option").forEach((btn) => {
          btn.addEventListener("click", () => pickEmoji(btn.dataset.emoji));
        });
        const compact = list.length <= 16;
        picker.classList.toggle("is-compact", compact);
        if (picker.isConnected && anchorEl.isConnected) {
          positionAnchoredPopover(picker, anchorEl.getBoundingClientRect());
        }
      }

      function renderCategory(name) {
        activeCategory = name;
        categoryLabel.textContent = name;
        tabsEl.querySelectorAll(".emoji-picker-tab").forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.category === name);
        });
        if (name === "Recent") {
          renderList(loadRecentEmoji(), "Emoji you use will show up here");
        } else if (name === "Custom") {
          renderList([], "No custom emoji yet");
        } else {
          const category = EMOJI_CATEGORIES.find((c) => c.name === name);
          renderList(category ? category.emojis : [], "No matches");
        }
        grid.scrollTop = 0;
      }

      function renderSearch(filter) {
        const f = filter.trim().toLowerCase();
        const list = EMOJI_SEARCH_POOL.filter((e) => (EMOJI_KEYWORDS.get(e) || "").includes(f));
        categoryLabel.textContent = "Search results";
        tabsEl.querySelectorAll(".emoji-picker-tab").forEach((btn) => btn.classList.remove("active"));
        renderList(list, "No matches");
      }

      renderCategory(activeCategory);

      tabsEl.querySelectorAll(".emoji-picker-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          searchInput.value = "";
          renderCategory(btn.dataset.category);
        });
      });

      searchInput.addEventListener("input", () => {

        const typed = EMOJI_CHAR_RE.exec(searchInput.value);
        if (typed) {
          pickEmoji(typed[0]);
          return;
        }
        if (searchInput.value.trim()) {
          renderSearch(searchInput.value);
        } else {
          renderCategory(activeCategory);
        }
      });

      const rect = anchorEl.getBoundingClientRect();
      positionAnchoredPopover(picker, rect);
      requestAnimationFrame(() => searchInput.focus());

      openEmojiPickerEl = picker;
      openEmojiPickerAnchor = anchorEl;
      setTimeout(() => {
        document.addEventListener("click", closeEmojiPickerOnOutsideClick);
      }, 0);
    }

    function closeEmojiPickerOnOutsideClick(e) {
      if (openEmojiPickerEl && !openEmojiPickerEl.contains(e.target)) {
        closeEmojiPicker();
      }
    }

    function formatTime(dateString) {
      if (!dateString) return "";
      const d = new Date(dateString);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    function isAdmin(profile) {
      if (!profile) return false;
      return profile.global_role === "admin" || profile.global_role === "superadmin";
    }

    function canUndoMessageClient(message) {
      if (!currentUser || !message || !message.created_at) return false;
      if (message.user_id !== currentUser.id) return false;
      const createdAt = new Date(message.created_at).getTime();
      const now = Date.now();
      return now - createdAt <= 60 * 1000 && !message.deleted_at;
    }

    function apiUrl(path) {
      if (path.startsWith("http")) return path;
      return `${window.EDGE_FUNCTIONS_BASE || ""}${path}`;
    }

    function apiFetch(path, options = {}, _isRetry = false) {
      if (!supabaseClient) {
        return Promise.reject(new Error("Supabase client is not initialized. Reload the page or check the console."));
      }
      const url = apiUrl(path);
      const headers = { ...(options.headers || {}) };
      return authReadyPromise.then(() =>
        supabaseClient.auth.getSession().then(({ data }) => {
          const token = data.session?.access_token;
          if (token) {
            headers["Authorization"] = `Bearer ${token}`;
          }
          headers["Content-Type"] = headers["Content-Type"] || "application/json";
          return fetch(url, {
            ...options,
            headers,
          }).then(async (res) => {
            if (!res.ok) {

              if (res.status === 401 && token && !_isRetry) {
                const { data: refreshed } = await supabaseClient.auth
                  .refreshSession()
                  .catch(() => ({ data: null }));
                if (refreshed?.session?.access_token) {
                  return apiFetch(path, options, true);
                }
              }
              const text = await res.text();
              let json;
              try {
                json = JSON.parse(text);
              } catch {
                json = { error: text || "Request failed" };
              }
              const apiError = new Error(json.error || json.message || "Request failed");

              if (json.code === "banned" || json.code === "force_logout") {
                apiError.code = json.code;
                apiError.reason = json.reason || null;
                apiError.until = json.until || null;
                apiError.forever = !!json.forever;
              }
              throw apiError;
            }
            const ct = res.headers.get("content-type") || "";
            if (ct.includes("application/json")) return res.json();
            return res.text();
          });
        })
      );
    }

    async function loadCurrentUser() {
      if (!supabaseClient) {
        showAuthOverlay();
        topBarSubtitle.textContent = "Not signed in";
        userPill.style.display = "none";
        logoutButton.style.display = "none";
        return;
      }
      const { data } = await supabaseClient.auth.getSession();

      currentUser = data.session?.user || null;
      if (!currentUser) {
        showAuthOverlay();
        topBarSubtitle.textContent = "Not signed in";
        userPill.style.display = "none";
        logoutButton.style.display = "none";
        return;
      }
      setBootLoaderStatus("Loading…");
      try {

        const serversPromise = loadServers();
        const me = await apiFetch("/api/auth/me");
        currentProfile = me.user;
        topBarSubtitle.textContent = currentProfile.username || currentUser.email;
        userPillName.textContent = currentProfile.username || currentUser.email;
        userPillAvatar.innerHTML = avatarHTML(currentProfile);
        userPill.style.display = "flex";
        logoutButton.style.display = "inline-flex";
        adminDashboardButton.style.display = isAdmin(currentProfile) ? "flex" : "none";
        hideAuthOverlay();
        applyProfileTheme(currentProfile);
        applyProfileAppearance(currentProfile);

        if (typeof window.updatePushStatusUI === "function") window.updatePushStatusUI();
        await tryApplyPendingAvatar();

        await serversPromise;
        loadDmConversations();
        await loadNotificationSettings();

        startVoiceActivityPolling();
        startSyncPolling();
        startAccountStatusWatch();
        seedUnreadState();
        updatePushStatusUI();
        reportFocusStateToServiceWorker();
        const params = new URLSearchParams(window.location.search);
        if (params.get("invite")) {
          await redeemInviteFromUrl();
        } else {
          await autoSelectDefaultServerAndChannel();
        }
      } catch (err) {
        console.error(err);
        showAuthOverlay();
        authErrorSignin.textContent = describeAuthBlockError(err) || err.message || "Failed to load your profile";
      }
    }

    function describeAuthBlockError(err) {
      if (!err || (err.code !== "banned" && err.code !== "force_logout")) return null;
      const whenText = err.forever ? "permanently" : `until ${new Date(err.until).toLocaleString(undefined, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
      const action = err.code === "banned" ? "banned" : "signed out";
      let text = `You've been ${action} ${whenText}.`;
      if (err.reason) text += ` Reason: ${err.reason}`;
      return text;
    }

    function openChannelsDrawer() {
      channelsDrawer.classList.add("open");
      drawerBackdrop.classList.add("visible");
    }

    function closeChannelsDrawer() {
      channelsDrawer.classList.remove("open");
      if (!userPanelEl.classList.contains("open")) {
        drawerBackdrop.classList.remove("visible");
      }
    }

    function openMembersDrawer() {
      userPanelEl.classList.add("open");
      drawerBackdrop.classList.add("visible");
    }

    function closeMembersDrawer() {
      userPanelEl.classList.remove("open");
      if (!channelsDrawer.classList.contains("open")) {
        drawerBackdrop.classList.remove("visible");
      }
    }

    function closeAllDrawers() {
      channelsDrawer.classList.remove("open");
      userPanelEl.classList.remove("open");
      drawerBackdrop.classList.remove("visible");
    }

    let allServers = [];
    const SERVER_MENU_RECENT_LIMIT = 4;
    const RECENT_SERVERS_KEY = "vexa_recent_server_ids";

    function muteBellSVG(muted) {
      return uiIcon(muted ? "bell-off" : "bell", 14);
    }

    function eyeIcon(open) {
      if (open) {
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
      }
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    }

    function uiIcon(name, size) {
      const s = size || 16;
      const paths = {
        globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
        mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
        "mic-off": '<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
        paperclip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
        phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
        hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
        volume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
        megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.08"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
        message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
        smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
        file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
        mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
        link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
        "chevron-down": '<polyline points="6 9 12 15 18 9"/>',
        "chevron-up": '<polyline points="18 15 12 9 6 15"/>',
        alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
        reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
        bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
        "bell-off": '<path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/>',
      };
      return `<svg class="ui-icon" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ""}</svg>`;
    }

    function channelTypeIcon(type, size) {
      const t = (type || "text").toString();
      if (t === "voice") return uiIcon("volume", size || 14);
      if (t === "announcement") return uiIcon("megaphone", size || 14);
      return uiIcon("hash", size || 14);
    }

    function repliesToggleHTML(count, open) {
      const n = Number(count) || 0;
      const word = n === 1 ? "reply" : "replies";
      return `${uiIcon("message", 14)} ${n} ${word} ${uiIcon(open ? "chevron-up" : "chevron-down", 12)}`;
    }

    function setRepliesToggle(btn, count, open) {
      if (!btn) return;
      if (count != null) btn.dataset.count = String(count);
      const n = count != null ? Number(count) : parseInt(btn.dataset.count || "0", 10);
      btn.innerHTML = repliesToggleHTML(n, !!open);
    }

    function setMuteButtonIcon(btn, muted) {
      if (!btn) return;
      btn.innerHTML = uiIcon(muted ? "mic-off" : "mic", 16);
      btn.title = muted ? "Unmute" : "Mute";
      btn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
    }

    function getRecentServerIds() {
      try {
        const raw = localStorage.getItem(RECENT_SERVERS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
      } catch {
        return [];
      }
    }

    function rememberServerVisit(serverId) {
      if (!serverId) return;
      const next = [serverId, ...getRecentServerIds().filter((id) => id !== serverId)].slice(0, 50);
      try {
        localStorage.setItem(RECENT_SERVERS_KEY, JSON.stringify(next));
      } catch {}
    }

    function orderServersForMenu(servers) {
      const recent = getRecentServerIds();
      const rank = new Map(recent.map((id, i) => [id, i]));
      return [...servers].sort((a, b) => {
        const ra = rank.has(a.id) ? rank.get(a.id) : 9999;
        const rb = rank.has(b.id) ? rank.get(b.id) : 9999;
        if (ra !== rb) return ra - rb;
        const ja = a.joined_at || a.created_at || "";
        const jb = b.joined_at || b.created_at || "";
        return ja < jb ? 1 : ja > jb ? -1 : 0;
      });
    }

    const DEFAULT_SERVER_ID = "afd99627-f642-4a98-9ea5-743d873e1064";
    const DEFAULT_CHANNEL_ID = "b305cfc6-4c85-4301-9232-981788126142";

    async function autoSelectDefaultServerAndChannel() {
      let server = allServers.find((s) => s.id === DEFAULT_SERVER_ID);

      if (!server) {

        try {
          await apiFetch(`/api/servers/${DEFAULT_SERVER_ID}/join`, { method: "POST" });
          await loadServers();
          server = allServers.find((s) => s.id === DEFAULT_SERVER_ID);
        } catch (err) {
          console.error("Failed to auto-join default server", err);
        }
      }

      server = server || allServers[0];
      if (!server) return;

      await selectServer(server);

      const channelEl =
        channelListEl.querySelector(`[data-channel-id="${DEFAULT_CHANNEL_ID}"]`) ||
        channelListEl.querySelector('.channel-item[data-channel-type="text"]');
      if (channelEl) channelEl.click();
    }

    let serversLoadToken = 0;

    function renderServerMenuItem(server) {
      const el = document.createElement("div");
      el.className = "server-item";
      el.dataset.serverId = server.id;
      const iconContent = server.icon_url
        ? `<img src="${escapeHtml(server.icon_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
        : `<span>${escapeHtml((server.name || "?").slice(0, 2).toUpperCase())}</span>`;
      el.innerHTML = `
  ${iconContent}
  <span class="voice-active-dot"></span>
  ${badgeHTML(serverUnreadTotal(server.id))}
  <div class="server-tooltip">${escapeHtml(server.name)}${server.is_public ? " · Public" : ""}</div>
`;
      if (currentServer && currentServer.id === server.id) el.classList.add("active");
      if (serverHasUnread(server.id)) el.classList.add("has-unread");
      if (serverHasVoiceActivity(server.id)) el.classList.add("has-voice-activity");
      el.addEventListener("click", () => {
        selectServer(server);
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openServerContextMenu(e.clientX, e.clientY, server);
      });
      return el;
    }

    function renderServerList() {
      serverListEl.innerHTML = "";
      if (!allServers.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state-small";
        empty.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0;padding:0;font-size:12px;";
        empty.textContent = "No servers yet";
        serverListEl.appendChild(empty);
        return;
      }

      const ordered = orderServersForMenu(allServers);
      const visible = ordered.slice(0, SERVER_MENU_RECENT_LIMIT);
      visible.forEach((server) => serverListEl.appendChild(renderServerMenuItem(server)));

      if (ordered.length > SERVER_MENU_RECENT_LIMIT) {
        const moreBtn = document.createElement("button");
        moreBtn.type = "button";
        moreBtn.className = "server-item server-item-add";
        moreBtn.title = "Show all servers";
        moreBtn.innerHTML = `<span style="font-size:11px;font-weight:700;">More</span>`;
        moreBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          openMyServersModal();
        });
        serverListEl.appendChild(moreBtn);
      }
    }

    function openMyServersModal() {
      const modal = document.getElementById("my-servers-modal");
      const searchInput = document.getElementById("my-servers-search-input");
      if (searchInput) searchInput.value = "";
      renderMyServersList("");
      if (modal) modal.classList.add("visible");
      if (searchInput) setTimeout(() => searchInput.focus(), 50);
    }

    function renderMyServersList(filterText) {
      const listEl = document.getElementById("my-servers-list");
      if (!listEl) return;
      const q = (filterText || "").trim().toLowerCase();
      const ordered = orderServersForMenu(allServers);
      const filtered = q
        ? ordered.filter((s) => (s.name || "").toLowerCase().includes(q))
        : ordered;

      if (!filtered.length) {
        listEl.innerHTML = `<div class="empty-state-small">${q ? "No servers match that search." : "No servers yet."}</div>`;
        return;
      }

      listEl.innerHTML = filtered
        .map(
          (s) => `
        <div class="admin-row" data-my-server-id="${s.id}">
          <div class="admin-row-main">
            <div class="public-server-icon">
              ${
                s.icon_url
                  ? `<img src="${escapeHtml(s.icon_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
                  : escapeHtml((s.name || "?").slice(0, 2).toUpperCase())
              }
            </div>
            <div>
              <div class="admin-row-name">
                ${escapeHtml(s.name)}
                ${s.is_public ? `<span class="admin-row-badge">Public</span>` : ""}
                ${currentServer && currentServer.id === s.id ? `<span class="admin-row-badge">Current</span>` : ""}
              </div>
              <div class="admin-row-meta">${s.is_public ? "Public server" : "Private server"}</div>
            </div>
          </div>
          <div class="admin-row-actions">
            <button class="identity-action-button" data-action="open-my-server">Open</button>
            <button class="identity-action-button identity-action-button-danger" data-action="leave-my-server">Leave</button>
          </div>
        </div>
      `
        )
        .join("");

      listEl.querySelectorAll("[data-action]").forEach((btn) => {
        const row = btn.closest("[data-my-server-id]");
        const serverId = row && row.dataset.myServerId;
        const server = allServers.find((s) => s.id === serverId);
        if (!server) return;
        btn.addEventListener("click", async () => {
          if (btn.dataset.action === "open-my-server") {
            document.getElementById("my-servers-modal").classList.remove("visible");
            await selectServer(server);
            return;
          }
          if (btn.dataset.action === "leave-my-server") {
            await handleLeaveServer(server);
            renderMyServersList(document.getElementById("my-servers-search-input")?.value || "");
          }
        });
      });
    }

    async function loadServers() {
      const loadToken = ++serversLoadToken;
      try {
        const { servers } = await apiFetch("/api/servers");
        if (loadToken !== serversLoadToken) return;
        allServers = servers || [];
        syncLocalServerIdsFromAllServers();
        renderServerList();
      } catch (err) {
        if (loadToken !== serversLoadToken) return;
        console.error(err);
        showToast(err.message || "Failed to load servers", { variant: "danger" });
      }
    }

    async function selectServer(server) {
      currentServer = server;
      currentChannel = null;
      currentServerMembers = [];
      currentServerMembership = null;
      unsubscribeRealtimeMessages();
      rememberServerVisit(server.id);
      Array.from(serverListEl.querySelectorAll(".server-item")).forEach((el) => {
        el.classList.toggle("active", el.dataset.serverId === server.id);
      });
      if (allServers.some((s) => s.id === server.id)) {
        renderServerList();
      }
      currentServerNameEl.textContent = server.name;
      currentServerMetaEl.textContent = server.is_public ? "Public server" : "Private server";
      chatChannelNameEl.textContent = "No channel";
      chatChannelMetaEl.textContent = "Select a channel to start";
      showNoChannelSelectedState();
      createChannelButton.style.display = "none";
      serverAdminPanelButton.style.display = "none";
      if (serverMuteButton) serverMuteButton.style.display = "none";
      if (serverLeaveButton) serverLeaveButton.style.display = "none";
      try {
        const { membership } = await apiFetch(`/api/servers/${server.id}/membership`);
        currentServerMembership = membership;
        const canManage = canManageCurrentServer();
        createChannelButton.style.display = canManage ? "flex" : "none";
        serverAdminPanelButton.style.display = canManage ? "flex" : "none";
        updateServerHeaderMuteLeaveButtons();
      } catch (err) {
        console.error(err);
        updateServerHeaderMuteLeaveButtons();
      }

      await Promise.all([loadChannels(server.id), loadServerMembers(server.id)]);
      try { await subscribeServerPresence(server.id); } catch (err) { console.error(err); }
      openChannelsDrawer();
    }

    function normalizedChannelType(type) {
      const t = (type || "").toString().trim().toLowerCase();
      return t === "voice" ? "voice" : t === "announcement" ? "announcement" : "text";
    }

    let channelsLoadToken = 0;

    async function loadChannels(serverId) {
      const loadToken = ++channelsLoadToken;
      channelListEl.innerHTML = `<div class="loading-state-full"><span class="spinner-lg"></span><div class="loading-state-full-label">Loading channels…</div></div>`;
      try {
        const { channels } = await apiFetch(`/api/servers/${serverId}/channels`);
        if (loadToken !== channelsLoadToken) return;
        channelListEl.innerHTML = "";
        const textChannels = channels.filter((c) => normalizedChannelType(c.type) === "text");
        const voiceChannels = channels.filter((c) => normalizedChannelType(c.type) === "voice");
        const announcementChannels = channels.filter((c) => normalizedChannelType(c.type) === "announcement");

        if (!channels.length) {
          const empty = document.createElement("div");
          empty.className = "empty-state-small";
          empty.textContent = canManageCurrentServer()
            ? "No channels yet — click + above to create one."
            : "No channels yet.";
          channelListEl.appendChild(empty);
        }

        function renderSection(label, items, icon) {
          if (!items.length) return;
          const sectionLabel = document.createElement("div");
          sectionLabel.className = "channel-section-label";
          sectionLabel.textContent = label;
          channelListEl.appendChild(sectionLabel);
          items.forEach((ch) => {
            const type = normalizedChannelType(ch.type);
            const el = document.createElement("div");
            el.className = "channel-item";
            if (type === "voice" && voiceRoom && voiceChannelId === ch.id) {
              el.classList.add("in-voice");
            }
            el.dataset.channelId = ch.id;
            el.dataset.channelType = type;
            channelIdToServerId.set(ch.id, serverId);
            const isMuted = mutedChannelIds.has(ch.id) || mutedServerIds.has(serverId);
            const unreadCount = isMuted ? 0 : (unreadChannelCounts.get(ch.id) || 0);
            if (unreadCount > 0) el.classList.add("has-unread");
            if (type === "voice" && activeVoiceRoomIds.has(ch.id)) el.classList.add("has-voice-activity");
            el.innerHTML = `
              <div class="channel-item-main">
                <span class="channel-item-icon">${icon}</span>
                <span class="channel-item-name">${escapeHtml(ch.name)}</span>
                ${type === "voice" ? `<span class="voice-active-dot"></span>` : ""}
                ${badgeHTML(unreadCount)}
              </div>
              <div class="channel-item-trailing">
                <span class="channel-item-meta">${ch.is_private ? "Private" : ""}</span>
                <button class="channel-mute-toggle" title="${isMuted ? "Unmute" : "Mute notifications"}" aria-label="${isMuted ? "Unmute" : "Mute notifications"}">${muteBellSVG(isMuted)}</button>
              </div>
            `;
            const muteBtn = el.querySelector(".channel-mute-toggle");

            if (muteBtn) muteBtn.addEventListener("click", async (e) => {
              e.stopPropagation();
              await toggleMuteChannel(ch.id, !mutedChannelIds.has(ch.id));
              const nowMuted = mutedChannelIds.has(ch.id);
              muteBtn.innerHTML = muteBellSVG(nowMuted);
              muteBtn.title = nowMuted ? "Unmute" : "Mute notifications";
              muteBtn.setAttribute("aria-label", nowMuted ? "Unmute" : "Mute notifications");
            });
            el.title = type === "voice" ? "Click to join voice" : "Click to open";
            el.addEventListener("click", () => {
              if (type === "voice") {
                toggleVoiceChannel({ ...ch, type });
              } else {
                selectChannel({ ...ch, type });
                markChannelRead(ch.id);
              }
              closeChannelsDrawer();
            });
            channelListEl.appendChild(el);
          });
        }

        renderSection("Text Channels", textChannels, channelTypeIcon("text"));
        renderSection("Voice Channels", voiceChannels, channelTypeIcon("voice"));
        renderSection("Announcements", announcementChannels, channelTypeIcon("announcement"));
      } catch (err) {
        if (loadToken !== channelsLoadToken) return;
        console.error(err);
        channelListEl.innerHTML = `<div class="empty-state-small">Failed to load channels.</div>`;
        showToast("Failed to load channels", { variant: "danger" });
      }
    }

    let serverMembersLoadToken = 0;

    async function loadServerMembers(serverId) {
      const loadToken = ++serverMembersLoadToken;
      userPanelEl.style.display = "flex";
      userListEl.innerHTML = `<div class="loading-state-full"><span class="spinner-lg"></span><div class="loading-state-full-label">Loading members…</div></div>`;
      try {
        const { members } = await apiFetch(`/api/servers/${serverId}/users`);
        if (loadToken !== serverMembersLoadToken) return;
        currentServerMembers = members || [];
        renderMemberList(memberSearchInput ? memberSearchInput.value : "");
      } catch (err) {
        console.error(err);
        if (loadToken !== serverMembersLoadToken) return;
        userListEl.innerHTML = `<div class="empty-state-small">Failed to load members.</div>`;
      }
    }


    let serverPresenceChannel = null;
    const onlineUserIds = new Set();

    function isUserOnline(userId) {
      return onlineUserIds.has(userId);
    }

    function unsubscribeServerPresence() {
      if (serverPresenceChannel && supabaseClient) {
        try { supabaseClient.removeChannel(serverPresenceChannel); } catch (e) {}
      }
      serverPresenceChannel = null;
      onlineUserIds.clear();
    }

    async function subscribeServerPresence(serverId) {
      unsubscribeServerPresence();
      if (!supabaseClient || !serverId || !currentUser) return;
      const channel = supabaseClient.channel(`presence:server:${serverId}`, {
        config: { presence: { key: currentUser.id } },
      });
      channel
        .on("presence", { event: "sync" }, () => {
          const state = channel.presenceState();
          onlineUserIds.clear();
          Object.keys(state || {}).forEach((key) => onlineUserIds.add(key));
          if (typeof renderMemberList === "function") {
            try { renderMemberList(memberSearchInput ? memberSearchInput.value : ""); } catch (e) {}
          }
        })
        .on("presence", { event: "join" }, ({ key }) => {
          if (key) onlineUserIds.add(key);
          if (typeof renderMemberList === "function") {
            try { renderMemberList(memberSearchInput ? memberSearchInput.value : ""); } catch (e) {}
          }
        })
        .on("presence", { event: "leave" }, ({ key }) => {
          if (key) onlineUserIds.delete(key);
          if (typeof renderMemberList === "function") {
            try { renderMemberList(memberSearchInput ? memberSearchInput.value : ""); } catch (e) {}
          }
        });
      channel.subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          try {
            await channel.track({
              user_id: currentUser.id,
              username: (currentProfile && currentProfile.username) || currentUser.email,
              online_at: new Date().toISOString(),
            });
          } catch (err) {
            console.error("presence track failed", err);
          }
        }
      });
      serverPresenceChannel = channel;
    }

    function renderMemberList(filterText) {

      userListEl.innerHTML = "";
      const q = (filterText || "").trim().toLowerCase();
      const members = q
        ? currentServerMembers.filter((m) => (m.user.username || "").toLowerCase().includes(q))
        : currentServerMembers.slice();

      const sortOnlineFirst = (list) =>
        list.slice().sort((a, b) => {
          const ao = isUserOnline(a.user.id) ? 0 : 1;
          const bo = isUserOnline(b.user.id) ? 0 : 1;
          if (ao !== bo) return ao - bo;
          return (a.user.username || "").localeCompare(b.user.username || "");
        });

      const online = sortOnlineFirst(members.filter((m) => isUserOnline(m.user.id)));
      const offline = sortOnlineFirst(members.filter((m) => !isUserOnline(m.user.id)));
      const adminsOnline = online.filter((m) => m.role === "admin" || m.user.global_role === "admin" || m.user.global_role === "superadmin");
      const adminsOffline = offline.filter((m) => m.role === "admin" || m.user.global_role === "admin" || m.user.global_role === "superadmin");
      const membersOnline = online.filter((m) => !(m.role === "admin" || m.user.global_role === "admin" || m.user.global_role === "superadmin"));
      const membersOffline = offline.filter((m) => !(m.role === "admin" || m.user.global_role === "admin" || m.user.global_role === "superadmin"));

      function renderSection(label, list) {
        if (!list.length) return;
        const labelEl = document.createElement("div");
        labelEl.className = "user-section-label";
        labelEl.textContent = label;
        userListEl.appendChild(labelEl);
        list.forEach((m) => {
          const onlineNow = isUserOnline(m.user.id);
          const el = document.createElement("div");
          el.className = "user-row " + (onlineNow ? "is-online" : "is-offline");
          el.dataset.userId = m.user.id;
          el.innerHTML = `
            <div class="user-avatar">
              ${avatarHTML(m.user)}
              <span class="user-online-dot" title="${onlineNow ? "Online" : "Offline"}"></span>
            </div>
            <div class="user-main">
              <div class="user-name-row">
                <span class="user-name">${escapeHtml(m.user.username || "")}</span>
                ${m.user.global_role !== "user" ? `<span class="user-role-pill">${m.user.global_role}</span>` : ""}
              </div>
              <div class="user-meta">${onlineNow ? '<span class="user-meta-online">Online</span> · ' : ""}${escapeHtml(m.role || "member")}</div>
            </div>
          `;
          el.addEventListener("contextmenu", async (e) => {
            e.preventDefault();
            await openUserContextMenu(e.clientX, e.clientY, m.user);
          });
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            openViewProfileModal(m.user);
          });
          userListEl.appendChild(el);
        });
      }

      renderSection(`Online — ${online.length}`, [...adminsOnline, ...membersOnline]);
      renderSection(`Offline — ${offline.length}`, [...adminsOffline, ...membersOffline]);
      if (q && !members.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state-small";
        empty.textContent = "No members match that search.";
        userListEl.appendChild(empty);
      }
    }

    const profileCache = new Map();

    async function resolveProfile(userId) {
      const cached = findMemberProfile(userId);
      if (cached) return cached;
      if (profileCache.has(userId)) return profileCache.get(userId);
      try {
        const { profile } = await apiFetch(`/api/profiles/${userId}`);
        profileCache.set(userId, profile);
        return profile;
      } catch (err) {
        console.error(err);
        return { username: "Unknown" };
      }
    }

    let realtimeMessagesChannel = null;

    function unsubscribeRealtimeMessages() {
      if (realtimeMessagesChannel && supabaseClient) {
        supabaseClient.removeChannel(realtimeMessagesChannel);
      }
      realtimeMessagesChannel = null;
    }

    function subscribeRealtimeMessages(channelId) {
      unsubscribeRealtimeMessages();
      if (!supabaseClient) return;

      realtimeMessagesChannel = supabaseClient
        .channel(`channel:${channelId}`, { config: { private: true } })
        .on("broadcast", { event: "*" }, async (msg) => {
          const { operation, record } = msg.payload || {};
          if (!record) return;

          if (operation === "DELETE") {
            const row = messageListEl.querySelector(`[data-message-id="${record.id}"]`);
            if (row) row.remove();
            return;
          }

          if (operation === "UPDATE") {
            const row = messageListEl.querySelector(`[data-message-id="${record.id}"]`);
            if (row) {
              if (record.deleted_at) {
                row.remove();
              } else {
                const contentEl = row.querySelector(".message-content");
                if (contentEl) {
                  contentEl.innerHTML = formatMessageContent(record.content || "");
                  applyMessageContentTruncation(contentEl);
                }
              }
            }
            return;
          }

          if (messageListEl.querySelector(`[data-message-id="${record.id}"]`)) return;
          const user = await resolveProfile(record.user_id);
          renderMessage({ ...record, user });
          messageListEl.scrollTop = messageListEl.scrollHeight;
        })
        .subscribe((status, err) => logRealtimeStatus(`channel-messages:${channelId}`, status, err));
    }

    async function selectChannel(channel) {
      currentChannel = channel;
      hideReportReviewBanner();
      clearReplyTarget();
      markChannelRead(channel.id);
      reportFocusStateToServiceWorker();
      apiFetch(`/api/channels/${channel.id}/read`, { method: "POST", body: JSON.stringify({}) }).catch(
        () => {}
      );
      Array.from(channelListEl.querySelectorAll(".channel-item")).forEach((el) => {
        el.classList.toggle("active", el.dataset.channelId === channel.id);
      });
      chatChannelPrefixEl.innerHTML = channelTypeIcon(channel.type, 14);
      chatChannelNameEl.textContent = channel.name;
      chatChannelMetaEl.textContent = channel.type === "announcement" ? "Announcement channel" : "Text channel";
      clearNoChannelSelectedState();
      messageListEl.innerHTML = `<div class="loading-state-full"><span class="spinner-lg"></span><div class="loading-state-full-label">Loading messages…</div></div>`;
      await loadMessages(channel.id);
      subscribeRealtimeMessages(channel.id);
    }

    async function loadMessages(channelId) {
      try {
        chatConnectionStatusEl.textContent = "Loading";
        const { messages } = await apiFetch(`/api/channels/${channelId}/messages`);
        messageListEl.innerHTML = "";
        messages.forEach((msg) => {
          renderMessage(msg);
        });
        messageListStickToBottom = true;
        messageListEl.scrollTop = messageListEl.scrollHeight;
        chatConnectionStatusEl.textContent = "Ready";
      } catch (err) {
        console.error(err);
        chatConnectionStatusEl.textContent = "Error";
        messageListEl.innerHTML = `<div class="empty-state-small">Failed to load messages.</div>`;
        showToast("Failed to load messages", { variant: "danger" });
      }
    }

    function renderMessage(message, container) {
      const target = container || messageListEl;

      if (message.parent_id) {
        upsertReplyOnParent(target, message);
        return;
      }
      const emptyState = target.querySelector(".empty-state-small");
      if (emptyState) emptyState.remove();
      const existing = target.querySelector(`[data-message-id="${message.id}"]`);

      const isReRender = !!existing;
      if (existing) existing.remove();

      const row = document.createElement("div");
      row.className = "message-row";
      if (isReRender) row.classList.add("no-entrance-anim");
      row.dataset.messageId = message.id;
      row.dataset.userId = message.user_id || "";
      row.addEventListener("contextmenu", async (e) => {
        e.preventDefault();
        await openMessageContextMenu(e.clientX, e.clientY, message);
      });

      const user = message.user || {};
      if (message.deleted_at) return;
      const isOwn = applyOwnMessageMarker(row, message);

      const canUndo = canUndoMessageClient(message);

      row.innerHTML = `
        <div class="message-avatar">
          ${avatarHTML(user)}
        </div>
        <div class="message-main">
          <div class="message-header">
            <span class="message-username">${escapeHtml(user.username || "Unknown")}</span>
            ${user.global_role && user.global_role !== "user" ? `<span class="message-role-badge">${user.global_role}</span>` : ""}
            <span class="message-timestamp">${formatTime(message.created_at)}</span>
          </div>
          ${
            message.parent && message.parent.id
              ? `<div class="message-reply-quote" data-parent-id="${message.parent.id}">${uiIcon("reply", 12)} ${escapeHtml((message.parent.user && message.parent.user.username) || "Unknown")}: ${escapeHtml(message.parent.deleted_at ? "(message deleted)" : message.parent.content ? message.parent.content.slice(0, 80) : "Attachment")}</div>`
              : ""
          }
          <div class="message-content">${formatMessageContent(message.content)}</div>
          <div class="message-attachments">
            ${(message.attachments || [])
              .map((att) => {
                const isImage = (att.type || "").startsWith("image/");
                const path = att.path || att;
                if (isImage) {
                  return `<button class="attachment-image-preview" data-path="${escapeHtml(path)}" title="${escapeHtml(att.name || "Image")}">
                    <span class="spinner"></span>
                  </button>`;
                }
                return `<button class="attachment-pill" data-path="${escapeHtml(path)}">
                    <span>${escapeHtml(att.name || "Attachment")}</span>
                  </button>`;
              })
              .join("")}
          </div>
          <div class="message-reactions">
            ${reactionSummaryHTML(message.reactions)}
          </div>
          ${
            message.reply_count > 0
              ? `<button class="message-replies-toggle" data-message-id="${message.id}" data-count="${message.reply_count}">${repliesToggleHTML(message.reply_count, false)}</button>
                 <div class="message-replies-thread" data-thread-for="${message.id}" style="display:none;"></div>`
              : ""
          }
          <div class="message-meta-row">
            ${
              canUndo
                ? `<button class="message-undo-pill" data-message-id="${message.id}">Undo</button>`
                : ""
            }
            <div class="message-actions-inline">
              <button class="message-inline-button" data-action="react" title="React">${uiIcon("smile", 14)}</button>
              <button class="message-inline-button" data-action="reply" title="Reply">${uiIcon("reply", 14)} Reply</button>
              ${
                isOwn || canModerateMessages() || !isOwn
                  ? `<button class="message-inline-button message-more-button" data-action="more" title="More">⋯</button>`
                  : ""
              }
            </div>
          </div>
        </div>
      `;

      row.querySelectorAll(".reaction-pill").forEach((btn) => {
        btn.addEventListener("click", () => toggleReaction(message, btn.dataset.emoji));
      });

      renderLinkPreviewInto(row, message.content);

      const usernameEl = row.querySelector(".message-username");
      const avatarEl = row.querySelector(".message-avatar");
      const openThisProfile = (e) => {
        e.stopPropagation();
        openViewProfileModal(user);
      };
      if (usernameEl) {
        usernameEl.style.cursor = "pointer";
        usernameEl.addEventListener("click", openThisProfile);
      }
      if (avatarEl) {
        avatarEl.style.cursor = "pointer";
        avatarEl.addEventListener("click", openThisProfile);
      }

      row.querySelectorAll(".attachment-pill").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const path = btn.dataset.path;
          try {
            const { url } = await apiFetch("/api/attachments/signed-url", {
              method: "POST",
              body: JSON.stringify({ path }),
            });
            window.open(url, "_blank");
          } catch (err) {
            console.error(err);
            showToast("Failed to open attachment", { variant: "danger" });
          }
        });
      });

      row.querySelectorAll(".attachment-image-preview").forEach((btn) => {
        const path = btn.dataset.path;
        let resolvedUrl = null;
        (async () => {
          try {
            const { url } = await apiFetch("/api/attachments/signed-url", {
              method: "POST",
              body: JSON.stringify({ path }),
            });
            resolvedUrl = url;
            btn.innerHTML = `<img src="${url}" alt="${btn.title || ""}" loading="lazy" />`;
          } catch (err) {
            console.error(err);
            btn.innerHTML = `${uiIcon("alert", 14)} <span>Failed to load image</span>`;
          }
        })();
        btn.addEventListener("click", () => {
          if (resolvedUrl) window.open(resolvedUrl, "_blank");
        });
      });

      const undoBtn = row.querySelector(".message-undo-pill");
      if (undoBtn) {
        undoBtn.addEventListener("click", () => {
          handleUndoMessage(message);
        });
        const remaining = 60 * 1000 - (Date.now() - new Date(message.created_at).getTime());
        if (remaining > 0) {
          const timer = setTimeout(() => {
            const btn = row.querySelector(".message-undo-pill");
            if (btn) btn.remove();
          }, remaining);
          undoTimers.set(message.id, timer);
        }
      }

      row.querySelectorAll(".message-inline-button").forEach((btn) => {
        const action = btn.dataset.action;
        if (action === "react") {
          btn.addEventListener("click", (e) => openEmojiPicker(e.currentTarget, message));
        } else if (action === "reply") {
          btn.addEventListener("click", () => setReplyTarget(message));
        } else if (action === "more") {
          btn.addEventListener("click", (e) => openMessageMoreMenu(e.currentTarget, message, isOwn));
        }
      });

      const replyQuoteEl = row.querySelector(".message-reply-quote");
      if (replyQuoteEl) {
        replyQuoteEl.addEventListener("click", () => scrollToMessage(replyQuoteEl.dataset.parentId));
      }

      const repliesToggle = row.querySelector(".message-replies-toggle");
      if (repliesToggle) {
        repliesToggle.addEventListener("click", () => toggleRepliesThread(message.id, repliesToggle));
      }

      messageListEl.appendChild(row);

      applyMessageContentTruncation(row.querySelector(".message-content"));
    }

    function applyOwnMessageMarker(el, message) {
      const isOwn = !!(currentUser && message.user_id === currentUser.id);
      el.classList.toggle("own-message", isOwn);
      return isOwn;
    }

    let openMoreMenuAnchor = null;

    function openMessageMoreMenu(anchorEl, message, isOwn) {

      if (openMoreMenuAnchor === anchorEl && messageContextMenu.classList.contains("visible")) {
        closeContextMenus();
        return;
      }
      closeContextMenus();
      const items = [];
      if (isOwn || canModerateMessages()) {
        items.push({ label: "Edit", action: () => handleEditMessage(message) });
      }
      if (canUndoMessageClient(message)) {
        items.push({ label: "Undo send", action: () => handleUndoMessage(message) });
      }
      if (isOwn || canModerateMessages()) {
        items.push({ label: "Delete", action: () => handleDeleteMessage(message), danger: true });
      }
      if (!isOwn) {
        items.push({ label: "Report", action: () => handleReportMessage(message), danger: true });
      }
      const rect = anchorEl.getBoundingClientRect();
      if (!items.length) return;
      messageContextMenu.innerHTML = items
        .map(
          (item) => `
        <div class="context-menu-item ${item.danger ? "context-menu-item-danger" : ""}">
          <span>${item.label}</span>
        </div>
      `
        )
        .join("");
      Array.from(messageContextMenu.querySelectorAll(".context-menu-item")).forEach((el, idx) => {
        el.addEventListener("click", () => {
          items[idx].action();
          closeContextMenus();
        });
      });
      messageContextMenu.classList.add("visible");
      clampToViewport(messageContextMenu, rect.left, rect.bottom + 4);
      openMoreMenuAnchor = anchorEl;
    }

    function appendReplyThreadItem(threadEl, reply) {
      if (threadEl.querySelector(`[data-reply-id="${reply.id}"]`)) return;
      const el = document.createElement("div");
      el.className = "message-reply-thread-item";
      el.dataset.replyId = reply.id;

      el.dataset.messageId = reply.id;
      el.dataset.userId = reply.user_id || "";
      applyOwnMessageMarker(el, reply);
      el.innerHTML = `
        <div class="message-avatar">${avatarHTML(reply.user || {})}</div>
        <div class="message-reply-thread-item-body">
          <span class="message-username">${escapeHtml((reply.user && reply.user.username) || "Unknown")}</span>
          ${reply.user && reply.user.global_role && reply.user.global_role !== "user" ? `<span class="message-role-badge">${reply.user.global_role}</span>` : ""}
          <span class="message-timestamp">${formatTime(reply.created_at)}</span>
          <div class="message-content">${formatMessageContent(reply.content)}</div>
          <div class="message-reactions">${reactionSummaryHTML(reply.reactions)}</div>
        </div>
      `;

      el.addEventListener("contextmenu", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await openMessageContextMenu(e.clientX, e.clientY, reply, { isReply: true });
      });
      el.querySelectorAll(".reaction-pill").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleReaction(reply, btn.dataset.emoji);
        });
      });
      const replyUser = reply.user || { id: reply.user_id };
      const openReplyProfile = (e) => {
        e.stopPropagation();
        openViewProfileModal(replyUser);
      };
      const replyUsernameEl = el.querySelector(".message-username");
      const replyAvatarEl = el.querySelector(".message-avatar");
      if (replyUsernameEl) {
        replyUsernameEl.style.cursor = "pointer";
        replyUsernameEl.addEventListener("click", openReplyProfile);
      }
      if (replyAvatarEl) {
        replyAvatarEl.style.cursor = "pointer";
        replyAvatarEl.addEventListener("click", openReplyProfile);
      }
      threadEl.appendChild(el);
      applyMessageContentTruncation(el.querySelector(".message-content"));
    }

    async function toggleRepliesThread(messageId, toggleBtn) {
      const row = toggleBtn.closest(".message-row, .dm-message");
      const threadEl = row ? row.querySelector(`.message-replies-thread[data-thread-for="${messageId}"]`) : null;
      if (!threadEl) return;
      const isOpen = threadEl.style.display !== "none";
      if (isOpen) {
        threadEl.style.display = "none";
        toggleBtn.innerHTML = repliesToggleHTML(parseInt(toggleBtn.dataset.count || "0", 10), false);
        return;
      }
      setRepliesToggle(toggleBtn, toggleBtn.dataset.count, true);
      threadEl.style.display = "block";
      threadEl.innerHTML = `<div class="empty-state-small"><span class="spinner"></span>Loading replies...</div>`;
      try {
        const { replies } = await apiFetch(`/api/messages/${messageId}/replies`);
        threadEl.innerHTML = "";
        replies.forEach((r) => appendReplyThreadItem(threadEl, r));

        toggleBtn._countedReplyIds = new Set(replies.map((r) => r.id));
        toggleBtn.dataset.count = String(replies.length);
        setRepliesToggle(toggleBtn, replies.length, true);
      } catch (err) {
        console.error(err);
        threadEl.innerHTML = `<div class="empty-state-small">Failed to load replies.</div>`;
      }
    }

    function upsertReplyOnParent(container, replyMsg) {
      if (!replyMsg.parent_id) return false;
      const row =
        container.querySelector(`[data-message-id="${replyMsg.parent_id}"]`) ||
        container.querySelector(`[data-dm-message-id="${replyMsg.parent_id}"]`);
      if (!row) return true;

      let toggleBtn = row.querySelector(".message-replies-toggle");
      let threadEl = row.querySelector(".message-replies-thread");

      if (replyMsg.deleted_at) {
        if (threadEl) {
          const existingItem = threadEl.querySelector(`[data-reply-id="${replyMsg.id}"]`);
          if (existingItem) existingItem.remove();
        }
        if (toggleBtn && toggleBtn._countedReplyIds && toggleBtn._countedReplyIds.has(replyMsg.id)) {
          toggleBtn._countedReplyIds.delete(replyMsg.id);
          const next = Math.max(0, parseInt(toggleBtn.dataset.count || "1", 10) - 1);
          toggleBtn.dataset.count = String(next);
          const isOpenNow = threadEl && threadEl.style.display !== "none";
          setRepliesToggle(toggleBtn, next, isOpenNow);
        }
        return true;
      }

      if (!toggleBtn) {
        const anchor = row.querySelector(".message-meta-row") || row.querySelector(".dm-message-actions");
        const html = `<button class="message-replies-toggle" data-message-id="${replyMsg.parent_id}" data-count="0">${repliesToggleHTML(0, false)}</button><div class="message-replies-thread" data-thread-for="${replyMsg.parent_id}" style="display:none;"></div>`;
        if (anchor) {
          anchor.insertAdjacentHTML("beforebegin", html);
        } else {
          const mount = row.querySelector(".message-main") || row.querySelector(".dm-message-body");
          if (mount) mount.insertAdjacentHTML("beforeend", html);
        }
        toggleBtn = row.querySelector(".message-replies-toggle");
        threadEl = row.querySelector(".message-replies-thread");
        if (toggleBtn) toggleBtn.addEventListener("click", () => toggleRepliesThread(replyMsg.parent_id, toggleBtn));
      }

      if (!threadEl || !toggleBtn) return true;

      if (!toggleBtn._countedReplyIds) {
        toggleBtn._countedReplyIds = new Set();
        const startingCount = parseInt(toggleBtn.dataset.count || "0", 10);
        toggleBtn.dataset.count = String(startingCount);
      }
      if (!toggleBtn._countedReplyIds.has(replyMsg.id)) {
        toggleBtn._countedReplyIds.add(replyMsg.id);
        const next = parseInt(toggleBtn.dataset.count || "0", 10) + 1;
        toggleBtn.dataset.count = String(next);
        const isOpenAlready = threadEl.style.display !== "none";
        setRepliesToggle(toggleBtn, next, isOpenAlready);
      }

      const isOpen = threadEl.style.display !== "none";
      if (isOpen) {
        appendReplyThreadItem(threadEl, replyMsg);
      }
      return true;
    }

    function formatFileSize(bytes) {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function clearAttachmentPreview() {
      attachmentInput.value = "";
      attachmentPreview.style.display = "none";
      attachmentPreview.innerHTML = "";
    }

    function handleAttachmentSelected() {
      const file = attachmentInput.files[0];
      if (!file) {
        clearAttachmentPreview();
        return;
      }

      const isImage = file.type && file.type.startsWith("image/");
      attachmentPreview.style.display = "flex";
      attachmentPreview.innerHTML = `
        <div class="attachment-preview-thumb" id="attachment-preview-thumb">${uiIcon("file", 18)}</div>
        <div class="attachment-preview-info">
          <div class="attachment-preview-name">${escapeHtml(file.name)}</div>
          <div class="attachment-preview-size">${formatFileSize(file.size)}</div>
        </div>
        <button class="attachment-preview-remove" id="attachment-preview-remove" title="Remove">${uiIcon("x", 14)}</button>
      `;

      if (isImage) {
        const reader = new FileReader();
        reader.onload = () => {
          const thumb = document.getElementById("attachment-preview-thumb");
          if (thumb) thumb.innerHTML = `<img src="${reader.result}" alt="">`;
        };
        reader.readAsDataURL(file);
      }

      document.getElementById("attachment-preview-remove").addEventListener("click", clearAttachmentPreview);
    }

    function attachFileToComposer(file) {
      if (!file) return;
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        attachmentInput.files = dt.files;
        handleAttachmentSelected();
      } catch (err) {
        console.error(err);
        showToast("Couldn't attach that file", { variant: "danger" });
      }
    }

    function isImageUrlLike(url) {
      return /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?(#.*)?$/i.test(url);
    }

    function faviconUrlFor(url) {
      try {
        const hostname = new URL(url).hostname;
        return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=128`;
      } catch (err) {
        return "";
      }
    }

    function extractPreviewUrl(text) {
      if (!text) return null;
      const match = text.match(/https?:\/\/[^\s<>"']+/i);
      if (!match) return null;
      const candidate = match[0].replace(/[),.!?;:'"]+$/, "");
      let parsed;
      try {
        parsed = new URL(candidate);
      } catch (err) {
        return null;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      if (!parsed.hostname || !parsed.hostname.includes(".")) return null;
      return parsed.href;
    }

    let linkPreviewIdCounter = 0;

    function buildLinkPreviewHTML(url) {
      let hostname = url;
      try {
        hostname = new URL(url).hostname;
      } catch (err) {
        /* keep raw url as label */
      }
      const looksLikeImage = isImageUrlLike(url);
      const thumbId = `link-preview-thumb-${++linkPreviewIdCounter}`;
      const html = `
        <a class="message-link-preview" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
          <div class="message-link-preview-thumb" id="${thumbId}">${uiIcon("globe", 20)}</div>
          <div class="message-link-preview-info">
            <div class="message-link-preview-title">${looksLikeImage ? "Image link" : escapeHtml(hostname)}</div>
            <div class="message-link-preview-url">${escapeHtml(url)}</div>
          </div>
        </a>
      `;
      return { html, thumbId, looksLikeImage };
    }

    function loadLinkPreviewThumb(url, thumbId, looksLikeImage) {
      const thumb = document.getElementById(thumbId);
      if (!thumb) return;
      const img = new Image();
      img.alt = "";
      img.onload = () => {
        if (!thumb.isConnected) return;
        thumb.innerHTML = "";
        thumb.appendChild(img);
      };
      img.src = looksLikeImage ? url : faviconUrlFor(url);
    }

    function renderLinkPreviewInto(rowEl, content, contentSelector) {
      if (!rowEl) return;
      const url = extractPreviewUrl(content);
      if (!url) return;
      const contentEl = rowEl.querySelector(contentSelector || ".message-content");
      if (!contentEl) return;
      const { html, thumbId, looksLikeImage } = buildLinkPreviewHTML(url);
      contentEl.insertAdjacentHTML("afterend", html);
      loadLinkPreviewThumb(url, thumbId, looksLikeImage);
    }

    function handleChatInputPaste(e) {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === "file" && item.type && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            attachFileToComposer(file);
            return;
          }
        }
      }
    }

    function isFileDrag(e) {
      return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"));
    }

    let chatDragCounter = 0;

    function setReplyTarget(message) {
      replyingToMessage = message;
      const user = message.user || {};
      replyPreviewText.textContent = `Replying to ${user.username || "Unknown"}: ${(message.content || "(attachment)").slice(0, 80)}`;
      replyPreviewBar.style.display = "flex";
      chatInputEl.focus();
    }

    function clearReplyTarget() {
      replyingToMessage = null;
      replyPreviewBar.style.display = "none";
      replyPreviewText.textContent = "";
    }

    function scrollToMessage(messageId) {
      const row = messageListEl.querySelector(`[data-message-id="${messageId}"]`);
      if (!row) return;
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.classList.add("highlight-flash");
      setTimeout(() => row.classList.remove("highlight-flash"), 1500);
    }

    function clearReportHighlight() {
      if (!activeReviewingMessageId) return;
      const row = messageListEl.querySelector(`[data-message-id="${activeReviewingMessageId}"]`);
      if (row) row.classList.remove("report-highlight");
      activeReviewingMessageId = null;
    }

    function scrollToReportedMessage(messageId, attempt = 0) {
      const row = messageListEl.querySelector(`[data-message-id="${messageId}"]`);
      if (!row) {
        if (attempt < 10) {
          setTimeout(() => scrollToReportedMessage(messageId, attempt + 1), 200);
        }
        return;
      }
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      clearReportHighlight();
      row.classList.add("report-highlight");
      activeReviewingMessageId = messageId;
    }

    function showReportReviewBanner(report) {
      activeReviewingReport = report;
      reportReviewBanButton.style.display = report.reported_user ? "" : "none";
      if (reportReviewBanReporterButton) {
        reportReviewBanReporterButton.style.display = report.reporter ? "" : "none";
      }
      const reporterName = (report.reporter && report.reporter.username) || "reporter";
      const reportedName = (report.reported_user && report.reported_user.username) || "user";
      const bannerText = reportReviewBanner.querySelector(".report-review-banner-text");
      if (bannerText) {
        bannerText.textContent = `Reviewing report · ${reportedName}${report.reporter ? ` (reported by ${reporterName})` : ""}`;
      }
      reportReviewBanner.style.display = "flex";
    }

    function hideReportReviewBanner() {
      reportReviewBanner.style.display = "none";
      activeReviewingReport = null;
      clearReportHighlight();
    }

    async function resolveActiveReviewingReport(status) {
      const report = activeReviewingReport;
      if (!report) return;
      try {
        await apiFetch(`/api/admin/reports/${report.id}/resolve`, {
          method: "POST",
          body: JSON.stringify({ status }),
        });
        showToast(`Report ${status}`, { variant: "accent" });
        hideReportReviewBanner();
      } catch (err) {
        console.error(err);
        showToast(err.message || "Action failed", { variant: "danger" });
      }
    }

    reportReviewDismissButton.addEventListener("click", () => resolveActiveReviewingReport("dismissed"));
    reportReviewResolveButton.addEventListener("click", () => resolveActiveReviewingReport("resolved"));
    reportReviewBanButton.addEventListener("click", async () => {
      const report = activeReviewingReport;
      if (!report || !report.reported_user) return;
      try {
        const result = await apiFetch(`/api/admin/users/${report.reported_user.id}/ban`, {
          method: "POST",
          body: JSON.stringify({ reason: `Report: ${report.reason}` }),
        });
        showToast(result.executed ? "Reported user banned" : result.message, { variant: "accent" });
        hideReportReviewBanner();
      } catch (err) {
        console.error(err);
        showToast(err.message || "Action failed", { variant: "danger" });
      }
    });

    if (reportReviewBanReporterButton) {
      reportReviewBanReporterButton.addEventListener("click", async () => {
        const report = activeReviewingReport;
        if (!report || !report.reporter) return;
        const ok = window.confirm(
          `Ban reporter "${report.reporter.username || "user"}"? Use this for abuse of the report system.`
        );
        if (!ok) return;
        try {
          const result = await apiFetch(`/api/admin/users/${report.reporter.id}/ban`, {
            method: "POST",
            body: JSON.stringify({ reason: `Abusive report: ${report.reason || "n/a"}` }),
          });
          showToast(result.executed ? "Reporter banned" : result.message, { variant: "accent" });
          hideReportReviewBanner();
        } catch (err) {
          console.error(err);
          showToast(err.message || "Action failed", { variant: "danger" });
        }
      });
    }

    let isSendingMessage = false;

    async function handleSendMessage() {
      if (!currentChannel || currentChannel.type !== "text") return;
      const content = chatInputEl.value.trim();
      if (!content && !attachmentInput.files.length) return;
      if (isSendingMessage) return;
      isSendingMessage = true;
      chatSendButton.disabled = true;

      const attachments = [];
      if (attachmentInput.files.length) {
        const file = attachmentInput.files[0];
        const reader = new FileReader();
        reader.onload = async () => {
          const base64 = reader.result.split(",")[1];
          try {
            const tempMessageId = crypto.randomUUID();
            const uploadRes = await apiFetch("/api/attachments/upload", {
              method: "POST",
              body: JSON.stringify({
                fileName: file.name,
                contentType: file.type || "application/octet-stream",
                base64Data: base64,
                message_id: tempMessageId,
              }),
            });
            attachments.push({ path: uploadRes.path, name: file.name, type: file.type || "" });
            await sendMessageToServer(content, attachments);
          } catch (err) {
            console.error(err);
            showToast(err.message || "Failed to upload attachment", { variant: "danger" });
          } finally {
            clearAttachmentPreview();
            isSendingMessage = false;
            chatSendButton.disabled = false;
          }
        };
        reader.readAsDataURL(attachmentInput.files[0]);
      } else {
        try {
          await sendMessageToServer(content, attachments);
        } finally {
          isSendingMessage = false;
          chatSendButton.disabled = false;
        }
      }
    }

    async function sendMessageToServer(content, attachments) {
      if (!currentChannel) return;
      try {
        const parentId = replyingToMessage ? replyingToMessage.id : null;
        const { message } = await apiFetch(`/api/channels/${currentChannel.id}/messages`, {
          method: "POST",
          body: JSON.stringify({ content, attachments, parent_id: parentId }),
        });
        chatInputEl.value = "";
        autoResizeTextarea(chatInputEl);
        clearReplyTarget();

        renderMessage({ ...message, user: currentProfile });
        messageListEl.scrollTop = messageListEl.scrollHeight;
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to send message", { variant: "danger" });
      }
    }

    async function handleEditMessage(message) {
      const newContent = prompt("Edit message", message.content || "");
      if (newContent === null) return;
      try {
        const { message: updated } = await apiFetch(`/api/messages/${message.id}`, {
          method: "PUT",
          body: JSON.stringify({ content: newContent }),
        });

        const row = messageListEl.querySelector(`[data-message-id="${message.id}"]`);
        if (row) {
          const contentEl = row.querySelector(".message-content");
          if (contentEl) {
            contentEl.innerHTML = formatMessageContent(updated.content);
            applyMessageContentTruncation(contentEl);
          }
        }
        showToast("Message edited", { variant: "accent" });
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to edit message", { variant: "danger" });
      }
    }

    async function handleDeleteMessage(message) {
      try {
        await apiFetch(`/api/messages/${message.id}`, {
          method: "DELETE",
          body: JSON.stringify({}),
        });
        const row = messageListEl.querySelector(`[data-message-id="${message.id}"]`);
        if (row) {

          const threadEl = row.closest(".message-replies-thread");
          if (threadEl) {
            const parentRow = threadEl.closest(".message-row, .dm-message");
            const toggleBtn = parentRow ? parentRow.querySelector(".message-replies-toggle") : null;
            if (toggleBtn) {
              if (toggleBtn._countedReplyIds) toggleBtn._countedReplyIds.delete(message.id);
              const next = Math.max(0, parseInt(toggleBtn.dataset.count || "1", 10) - 1);
              toggleBtn.dataset.count = String(next);
              const isOpenNow = threadEl.style.display !== "none";
              setRepliesToggle(toggleBtn, next, isOpenNow);
            }
          }
          row.remove();
        }
      } catch (err) {
        console.error(err);
        showToast(err.message, { variant: "danger" });
      }
    }

    async function handleUndoMessage(message) {
      const row = messageListEl.querySelector(`[data-message-id="${message.id}"]`);
      const undoBtn = row ? row.querySelector(".message-undo-pill") : null;

      if (undoBtn) {
        if (undoBtn.disabled) return;
        undoBtn.disabled = true;
        undoBtn.textContent = "Undoing…";
      }
      try {
        await apiFetch(`/api/messages/${message.id}/undo`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        if (row) {
          const contentEl = row.querySelector(".message-content");
          if (contentEl) {
            contentEl.textContent = "Message deleted";
            contentEl.classList.add("deleted");
          }
          if (undoBtn) undoBtn.remove();
        }
      } catch (err) {
        console.error(err);
        showToast(err.message, { variant: "danger" });
        if (undoBtn) {
          undoBtn.disabled = false;
          undoBtn.textContent = "Undo";
        }
      }
    }

    async function handleReportMessage(message) {
      const reason = prompt("Why are you reporting this message?");
      if (reason === null || !reason.trim()) return;
      try {
        await apiFetch("/api/reports", {
          method: "POST",
          body: JSON.stringify({ message_id: message.id, reason: reason.trim() }),
        });
        showToast("Message reported. Thanks for flagging this.", { variant: "accent" });
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to file report", { variant: "danger" });
      }
    }

    async function handleReportUser(userId) {
      const reason = prompt("Why are you reporting this user?");
      if (reason === null || !reason.trim()) return;
      try {
        await apiFetch("/api/reports", {
          method: "POST",
          body: JSON.stringify({ reported_user_id: userId, reason: reason.trim() }),
        });
        showToast("User reported. Thanks for flagging this.", { variant: "accent" });
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to file report", { variant: "danger" });
      }
    }

    async function openMessageContextMenu(x, y, message, opts) {
      closeContextMenus();
      const isReply = !!(opts && opts.isReply);
      const isOwn = currentUser && message.user_id === currentUser.id;
      const admin = isAdmin(currentProfile);
      const canModerate = canModerateMessages();
      const items = [];

      if (!isReply) {
        items.push({ label: "Reply", action: () => setReplyTarget(message) });
      }

      if (isOwn || canModerate) {
        items.push({ label: "Edit message", action: () => handleEditMessage(message) });
        if (isOwn && canUndoMessageClient(message)) {
          items.push({ label: "Undo (1 min)", action: () => handleUndoMessage(message) });
        }
      }

      if (isOwn || canModerate) {
        items.push({
          label: "Delete message",
          action: () => handleDeleteMessage(message),
          danger: true,
        });
      }

      if (!isOwn) {
        items.push({ label: "Report message", action: () => handleReportMessage(message), danger: true });
      }

      if (admin && message.user_id) {
        const banned = await getIsUserBanned(message.user_id);
        items.push(
          banned
            ? { label: "Unban user (global)", action: () => handleUnbanUser(message.user_id) }
            : { label: "Ban user (global)", action: () => handleBanUser(message.user_id), danger: true }
        );
        if (currentServer) {
          items.push({
            label: "Remove from server",
            action: () => handleRemoveFromServer(currentServer.id, message.user_id),
            danger: true,
          });
        }
      }

      if (message.user_id && currentUser && message.user_id !== currentUser.id && currentServer && (admin || canManageCurrentServer())) {
        const serverBanned = isServerBanned(message.user_id);
        const targetMember = findServerMember(message.user_id);
        if (serverBanned) {
          items.push({ label: "Unban from server", action: () => handleUnbanFromServer(currentServer.id, message.user_id) });
        } else if (canActOnAdminTarget(currentServer, targetMember, "ban")) {
          items.push({ label: "Ban from server", action: () => handleBanFromServer(currentServer.id, message.user_id), danger: true });
        }
      }

      if (!items.length) return;

      messageContextMenu.innerHTML = items
        .map(
          (item) => `
        <div class="context-menu-item ${item.danger ? "context-menu-item-danger" : ""}">
          <span>${item.label}</span>
        </div>
      `
        )
        .join("");

      Array.from(messageContextMenu.querySelectorAll(".context-menu-item")).forEach((el, idx) => {
        el.addEventListener("click", () => {
          items[idx].action();
          closeContextMenus();
        });
      });

      messageContextMenu.classList.add("visible");
      clampToViewport(messageContextMenu, x, y);
    }

    async function openUserContextMenu(x, y, user) {
      closeContextMenus();
      if (!currentUser || user.id === currentUser.id) return;

      const items = [
        { label: "View profile", action: () => openViewProfileModal(user) },
        { label: "Message", action: () => openDmWith(user) },
      ];
      items.push({ label: "Report user", action: () => handleReportUser(user.id), danger: true });

      if (isAdmin(currentProfile)) {

        const banned = user.is_banned !== undefined ? user.is_banned : await getIsUserBanned(user.id);
        items.push(
          banned
            ? { label: "Unban user (global)", action: () => handleUnbanUser(user.id) }
            : { label: "Ban user (global)", action: () => handleBanUser(user.id), danger: true }
        );
        items.push({
          label: "Force logout (no ban)",
          action: () => handleForceLogoutUser(user.id),
        });
        if (currentServer) {
          items.push({
            label: "Remove from server",
            action: () => handleRemoveFromServer(currentServer.id, user.id),
            danger: true,
          });
        }
      } else if (currentServer && currentServerMembership && currentServerMembership.role === "admin") {

        if (canActOnAdminTarget(currentServer, findServerMember(user.id), "kick")) {
          items.push({
            label: "Kick from server",
            action: () => handleKickFromServer(currentServer.id, user.id),
            danger: true,
          });
        }
      }

      if (currentServer && (isAdmin(currentProfile) || (currentServerMembership && currentServerMembership.role === "admin"))) {
        const serverBanned = isServerBanned(user.id);
        const targetMember = findServerMember(user.id);
        if (serverBanned) {
          items.push({ label: "Unban from server", action: () => handleUnbanFromServer(currentServer.id, user.id) });
        } else if (canActOnAdminTarget(currentServer, targetMember, "ban")) {
          items.push({ label: "Ban from server", action: () => handleBanFromServer(currentServer.id, user.id), danger: true });
        }
      }
      userContextMenu.innerHTML = items
        .map(
          (item) => `
        <div class="context-menu-item ${item.danger ? "context-menu-item-danger" : ""}">
          <span>${item.label}</span>
        </div>
      `
        )
        .join("");
      Array.from(userContextMenu.querySelectorAll(".context-menu-item")).forEach((el, idx) => {
        el.addEventListener("click", () => {
          items[idx].action();
          closeContextMenus();
        });
      });
      userContextMenu.classList.add("visible");
      clampToViewport(userContextMenu, x, y);
    }

    function closeContextMenus() {
      messageContextMenu.classList.remove("visible");
      userContextMenu.classList.remove("visible");
      serverContextMenu.classList.remove("visible");
      closeEmojiPicker();
      openMoreMenuAnchor = null;
    }

    function computeUntilFromDuration(duration, customLocalDatetime) {
      if (!duration || duration === "forever") return null;
      if (duration === "custom") {
        if (!customLocalDatetime) throw new Error("Pick a date and time for the custom expiry");
        const d = new Date(customLocalDatetime);
        if (Number.isNaN(d.getTime())) throw new Error("Invalid expiry date");
        if (d.getTime() <= Date.now()) throw new Error("Expiry date must be in the future");
        return d.toISOString();
      }
      const hoursByDuration = { "1h": 1, "6h": 6, "24h": 24, "3d": 72, "7d": 168, "30d": 720 };
      const hours = hoursByDuration[duration];
      if (!hours) return null;
      return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    }

    function durationSelectField(id) {
      return {
        id,
        label: "Duration",
        type: "select",
        value: "forever",
        options: [
          { value: "forever", label: "Forever" },
          { value: "1h", label: "1 hour" },
          { value: "6h", label: "6 hours" },
          { value: "24h", label: "24 hours" },
          { value: "3d", label: "3 days" },
          { value: "7d", label: "7 days" },
          { value: "30d", label: "30 days" },
          { value: "custom", label: "Custom date…" },
        ],
      };
    }

    function formatUntil(until) {
      if (until === undefined || until === null || until === "") return "forever";
      const d = new Date(until);
      if (Number.isNaN(d.getTime())) return "forever";
      if (d.getFullYear() >= 9999) return "forever";
      return `until ${d.toLocaleString(undefined, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
    }

    /** True when a ban is currently in effect (respects banned_until expiry). */
    function isBanActive(user) {
      if (!user || !user.is_banned) return false;
      if (!user.banned_until) return true;
      const t = new Date(user.banned_until).getTime();
      if (Number.isNaN(t)) return true;
      return t > Date.now();
    }

    /** True when a force-logout / kick lock is currently in effect (respects force_logout_until). */
    function isForceLogoutActive(user) {
      if (!user || !user.force_logout) return false;
      if (!user.force_logout_until) return true;
      const t = new Date(user.force_logout_until).getTime();
      if (Number.isNaN(t)) return true;
      return t > Date.now();
    }

    async function handleBanDetails(userId) {
      const user = adminUsersCache.find((u) => u.id === userId);
      if (!user) return;
      const currentUntil = user.banned_until ? new Date(user.banned_until) : null;
      const untilLocal =
        currentUntil && !Number.isNaN(currentUntil.getTime())
          ? new Date(currentUntil.getTime() - currentUntil.getTimezoneOffset() * 60000)
              .toISOString()
              .slice(0, 16)
          : "";
      openFormModal({
        title: "Ban details",
        subtitle: `Manage ban for ${user.username || "user"}`,
        fields: [
          {
            id: "ban-reason",
            label: "Reason",
            type: "textarea",
            placeholder: "Why is this user banned?",
            value: user.banned_reason || "",
          },
          {
            id: "ban-until",
            label: "Banned until (leave empty for permanent)",
            type: "datetime-local",
            value: untilLocal,
          },
        ],
        submitLabel: "Save ban",
        onSubmit: async (values) => {
          const untilRaw = (values["ban-until"] || "").trim();
          const until = untilRaw ? new Date(untilRaw).toISOString() : null;
          const result = await apiFetch(`/api/admin/users/${userId}/ban`, {
            method: "POST",
            body: JSON.stringify({ reason: values["ban-reason"] || null, until }),
          });
          if (result.executed) {
            showToast(`Ban updated ${formatUntil(until)}`, { variant: "accent" });
          } else {
            showToast(result.message || "Ban update recorded — awaiting approval", {
              variant: "accent",
            });
          }
          loadAdminUsers();
        },
      });
    }

    async function handleBanUser(userId) {
      openFormModal({
        title: "Ban user",
        subtitle: "They'll be signed out and blocked from logging back in until the ban lifts.",
        fields: [
          { id: "ban-reason", label: "Reason (optional)", type: "textarea", placeholder: "Why is this user being banned?" },
          durationSelectField("ban-duration"),
          { id: "ban-until", label: "Banned until", type: "datetime-local", hidden: true, showWhen: { fieldId: "ban-duration", equals: "custom" } },
        ],
        submitLabel: "Ban user",
        onSubmit: async (values) => {
          const until = computeUntilFromDuration(values["ban-duration"], values["ban-until"]);
          const result = await apiFetch(`/api/admin/users/${userId}/ban`, {
            method: "POST",
            body: JSON.stringify({ reason: values["ban-reason"] || null, until }),
          });
          if (result.executed) {
            userBanStatusCache.set(userId, true);
            showToast(`User banned ${formatUntil(until)}`, { variant: "accent" });
          } else {
            showToast(result.message || "Ban recorded — awaiting another admin's approval", {
              variant: "accent",
            });
          }
          loadAdminUsers();
        },
      });
    }

    async function handleUnbanUser(userId) {
      try {
        await apiFetch(`/api/admin/users/${userId}/unban`, { method: "POST" });
        userBanStatusCache.set(userId, false);
        showToast("User unbanned", { variant: "accent" });
      } catch (err) {
        console.error(err);
        showToast("Failed to unban user", { variant: "danger" });
      }
    }

    async function handleForceLogoutUser(userId) {
      openFormModal({
        title: "Force log out user",
        subtitle: "They'll be signed out and can't log back in until you allow it (or the expiry passes).",
        fields: [durationSelectField("logout-duration"), { id: "logout-until", label: "Locked out until", type: "datetime-local", hidden: true, showWhen: { fieldId: "logout-duration", equals: "custom" } }],
        submitLabel: "Force log out",
        onSubmit: async (values) => {
          const until = computeUntilFromDuration(values["logout-duration"], values["logout-until"]);
          const result = await apiFetch(`/api/admin/users/${userId}/force-logout`, {
            method: "POST",
            body: JSON.stringify({ until }),
          });
          if (result.executed) {
            showToast(`User signed out ${formatUntil(until)}`, { variant: "accent" });
          } else {
            showToast(result.message || "Recorded — awaiting another admin's approval", {
              variant: "accent",
            });
          }
          loadAdminUsers();
        },
      });
    }

    let viewProfileTargetUser = null;

    async function openViewProfileModal(user) {

      if (currentUser && user && user.id === currentUser.id) {
        closeViewProfileModal();
        handleSettingsOpen();
        return;
      }

      viewProfileTargetUser = user;
      viewProfileAvatarEl.innerHTML = avatarHTML(user);
      viewProfileUsernameEl.textContent = user.username || "Unknown user";
      viewProfileRoleEl.textContent = user.global_role || "member";
      viewProfileBioEl.textContent = "Loading…";
      viewProfileJoinedRow.style.display = "none";
      viewProfileBanRow.style.display = "none";
      viewProfileBanButton.style.display = "none";
      viewProfileModal.classList.add("visible");

      if (isAdmin(currentProfile) && currentUser && user.id !== currentUser.id) {
        viewProfileBanButton.style.display = "inline-flex";
        viewProfileBanButton.disabled = true;
        viewProfileBanButton.textContent = "…";
        getIsUserBanned(user.id).then((banned) => {
          if (viewProfileTargetUser !== user) return;
          viewProfileBanButton.disabled = false;
          viewProfileBanButton.textContent = banned ? "Unban user" : "Ban user";
          viewProfileBanButton.onclick = async () => {
            if (banned) {
              await handleUnbanUser(user.id);
            } else {
              await handleBanUser(user.id);
            }
            closeViewProfileModal();
          };
        });
      }

      try {
        const { profile } = await apiFetch(`/api/profiles/${user.id}`);
        if (viewProfileTargetUser !== user) return;
        viewProfileUsernameEl.textContent = profile.username || "Unknown user";
        viewProfileRoleEl.textContent = profile.global_role || "member";
        viewProfileBioEl.textContent = profile.bio || "No bio yet.";
        viewProfileAvatarEl.innerHTML = avatarHTML(profile);
        if (profile.created_at) {
          viewProfileJoinedRow.style.display = "";
          viewProfileJoinedEl.textContent = new Date(profile.created_at).toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          });
        }

        if (isAdmin(currentProfile) && (!Array.isArray(adminUsersCache) || !adminUsersCache.find((u) => u.id === user.id))) {
          try {
            const { users } = await apiFetch("/api/admin/users");
            adminUsersCache = users || [];
          } catch (err) {
            console.error("Failed to refresh admin users for ban status", err);
          }
        }

        const cached = Array.isArray(adminUsersCache)
          ? adminUsersCache.find((u) => u.id === user.id)
          : null;
        const banSource = {
          is_banned:
            cached && cached.is_banned !== undefined
              ? cached.is_banned
              : profile.is_banned !== undefined
                ? profile.is_banned
                : user.is_banned,
          banned_until:
            cached && cached.banned_until !== undefined
              ? cached.banned_until
              : profile.banned_until !== undefined && profile.banned_until !== null
                ? profile.banned_until
                : user.banned_until,
          banned_reason:
            cached && cached.banned_reason !== undefined
              ? cached.banned_reason
              : profile.banned_reason !== undefined && profile.banned_reason !== null
                ? profile.banned_reason
                : user.banned_reason,
        };

        if (isAdmin(currentProfile) && isBanActive(banSource)) {
          viewProfileBanRow.style.display = "";
          const untilText = `Banned ${formatUntil(banSource.banned_until)}`;
          viewProfileBanReasonEl.textContent = banSource.banned_reason
            ? `${banSource.banned_reason} — ${untilText}`
            : untilText;
        }
      } catch (err) {
        console.error(err);
        viewProfileBioEl.textContent = "Failed to load profile.";
      }
    }

    function closeViewProfileModal() {
      viewProfileModal.classList.remove("visible");
      viewProfileTargetUser = null;
    }

    async function handleRemoveFromServer(serverId, userId) {
      const reason = prompt("Reason for removal (optional)");
      try {
        await apiFetch(`/api/admin/servers/${serverId}/users/${userId}/remove`, {
          method: "POST",
          body: JSON.stringify({ reason }),
        });
        showToast("User removed from server", { variant: "accent" });
        await loadServerMembers(serverId);
      } catch (err) {
        console.error(err);
        showToast("Failed to remove user", { variant: "danger" });
      }
    }

    async function handleKickFromServer(serverId, userId) {
      if (!confirm("Kick this member from the server? They can rejoin with a new invite.")) return;
      try {
        await apiFetch(`/api/servers/${serverId}/members/${userId}/kick`, { method: "POST" });
        showToast("Member kicked", { variant: "accent" });
        await loadServerMembers(serverId);
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to kick member", { variant: "danger" });
      }
    }

    async function handleBanFromServer(serverId, userId) {
      const reason = prompt("Reason for server ban (optional)");
      if (reason === null) return;
      try {
        await apiFetch(`/api/servers/${serverId}/members/${userId}/ban`, {
          method: "POST",
          body: JSON.stringify({ reason }),
        });
        showToast("Member banned from server", { variant: "accent" });
        await loadServerMembers(serverId);
        if (serverAdminTarget && serverAdminTarget.id === serverId) loadServerAdminMembers();
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to ban member", { variant: "danger" });
      }
    }

    async function handleUnbanFromServer(serverId, userId) {
      try {
        await apiFetch(`/api/servers/${serverId}/members/${userId}/unban`, { method: "POST" });
        showToast("Member unbanned from server", { variant: "accent" });
        await loadServerMembers(serverId);
        if (serverAdminTarget && serverAdminTarget.id === serverId) loadServerAdminMembers();
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to unban member", { variant: "danger" });
      }
    }

    let formModalSubmitHandler = null;

    function closeFormModal() {
      formModal.classList.remove("visible");
      formModalError.textContent = "";
      formModalSubmitHandler = null;
    }

    function fieldMarkup(field) {
      if (field.type === "toggle") {
        return `
          <div class="form-field">
            <div class="form-field-row">
              <div>
                <div class="settings-label">${escapeHtml(field.label)}</div>
                ${field.hint ? `<div class="form-field-hint">${escapeHtml(field.hint)}</div>` : ""}
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="${field.id}" ${field.checked ? "checked" : ""} />
                <span class="toggle-switch-track"><span class="toggle-switch-thumb"></span></span>
              </label>
            </div>
          </div>
        `;
      }
      if (field.type === "channel-type") {
        return `
          <div class="form-field">
            <div class="settings-label">${escapeHtml(field.label)}</div>
            <div class="channel-type-options" id="${field.id}" data-value="${field.value || "text"}">
              <div class="channel-type-option ${(field.value || "text") === "text" ? "selected" : ""}" data-value="text">
                <span class="channel-type-icon">${uiIcon("hash", 18)}</span>
                <span>Text</span>
                <small>Chat with messages</small>
              </div>
              <div class="channel-type-option ${field.value === "voice" ? "selected" : ""}" data-value="voice">
                <span class="channel-type-icon">${uiIcon("volume", 18)}</span>
                <span>Voice</span>
                <small>Live audio room</small>
              </div>
            </div>
          </div>
        `;
      }
      if (field.type === "select") {
        const options = (field.options || [])
          .map(
            (opt) =>
              `<option value="${escapeHtml(opt.value)}" ${opt.value === field.value ? "selected" : ""}>${escapeHtml(opt.label)}</option>`
          )
          .join("");
        return `
          <div class="form-field">
            <div class="settings-label">${escapeHtml(field.label)}</div>
            <select id="${field.id}" class="settings-input">${options}</select>
            ${field.hint ? `<div class="form-field-hint">${escapeHtml(field.hint)}</div>` : ""}
          </div>
        `;
      }
      if (field.type === "datetime-local") {
        return `
          <div class="form-field" id="${field.id}-wrap" style="${field.hidden ? "display:none;" : ""}">
            <div class="settings-label">${escapeHtml(field.label)}</div>
            <input id="${field.id}" class="settings-input" type="datetime-local" value="${escapeHtml(field.value || "")}" />
            ${field.hint ? `<div class="form-field-hint">${escapeHtml(field.hint)}</div>` : ""}
          </div>
        `;
      }
      if (field.type === "textarea") {
        return `
          <div class="form-field">
            <div class="settings-label">${escapeHtml(field.label)}</div>
            <textarea id="${field.id}" class="settings-textarea" placeholder="${escapeHtml(field.placeholder || "")}">${escapeHtml(field.value || "")}</textarea>
          </div>
        `;
      }
      if (field.type === "file") {
        const previewContent = field.value
          ? `<img src="${escapeHtml(field.value)}" alt="" />`
          : `<span class="avatar-upload-placeholder">${escapeHtml((field.placeholderText || "?").slice(0, 2).toUpperCase())}</span>`;
        return `
          <div class="form-field form-field-icon">
            <div class="settings-label">${escapeHtml(field.label)}</div>
            <div class="avatar-upload" id="${field.id}-upload" tabindex="0" role="button" aria-label="${escapeHtml(field.label)}">
              <div class="avatar-upload-preview" id="${field.id}-preview">${previewContent}</div>
              <div class="avatar-upload-badge">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </div>
              <input id="${field.id}" type="file" accept="image/*" />
            </div>
            <div class="form-field-hint">PNG, JPG or GIF · max 5 MB</div>
          </div>
        `;
      }
      return `
        <div class="form-field">
          <div class="settings-label">${escapeHtml(field.label)}</div>
          <input id="${field.id}" class="settings-input" type="text" placeholder="${escapeHtml(field.placeholder || "")}" value="${escapeHtml(field.value || "")}" />
        </div>
      `;
    }

    function openFormModal({ title, subtitle, fields, submitLabel, onSubmit }) {
      formModalTitle.textContent = title;
      formModalSubtitle.textContent = subtitle || "";
      formModalBody.innerHTML = fields.map(fieldMarkup).join("");
      formModalSubmit.textContent = submitLabel || "Save";
      formModalError.textContent = "";

      formModalBody.querySelectorAll(".channel-type-options").forEach((wrap) => {
        wrap.querySelectorAll(".channel-type-option").forEach((opt) => {
          opt.addEventListener("click", () => {
            wrap.querySelectorAll(".channel-type-option").forEach((o) => o.classList.remove("selected"));
            opt.classList.add("selected");
            wrap.dataset.value = opt.dataset.value;
          });
        });
      });

      fields.forEach((field) => {
        if (!field.showWhen) return;
        const wrap = document.getElementById(`${field.id}-wrap`);
        const controller = document.getElementById(field.showWhen.fieldId);
        if (!wrap || !controller) return;
        const sync = () => {
          wrap.style.display = controller.value === field.showWhen.equals ? "" : "none";
        };
        controller.addEventListener("change", sync);
        sync();
      });

      fields.forEach((field) => {
        if (field.type !== "file") return;
        const fileInput = document.getElementById(field.id);
        const preview = document.getElementById(`${field.id}-preview`);
        if (!fileInput || !preview) return;
        fileInput.addEventListener("change", () => {
          const file = fileInput.files && fileInput.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            preview.innerHTML = `<img src="${reader.result}" alt="" />`;
          };
          reader.readAsDataURL(file);
        });
      });

      formModalSubmitHandler = async () => {
        const values = {};
        fields.forEach((field) => {
          if (field.type === "toggle") {
            values[field.id] = document.getElementById(field.id).checked;
          } else if (field.type === "channel-type") {
            values[field.id] = document.getElementById(field.id).dataset.value;
          } else {
            values[field.id] = document.getElementById(field.id).value;
          }
        });
        try {
          formModalSubmit.disabled = true;
          await onSubmit(values);
          closeFormModal();
        } catch (err) {
          console.error(err);
          formModalError.textContent = err.message || "Something went wrong";
        } finally {
          formModalSubmit.disabled = false;
        }
      };

      formModal.classList.add("visible");
    }

async function handleCreateServer() {
  const superadmin = currentProfile && currentProfile.global_role === "superadmin";
  const fields = [
    { id: "srv-name", label: "Server name", type: "text", placeholder: "My Server" },
    { id: "srv-desc", label: "Description", type: "textarea", placeholder: "Optional" },
    { id: "srv-icon", label: "Server icon (optional)", type: "file" },
  ];
  if (superadmin) {
    fields.push({
      id: "srv-public",
      label: "Public server",
      type: "toggle",
      hint: "Anyone can find and join a public server. Only superadmins can toggle this.",
      checked: false,
    });
  }
  openFormModal({
    title: "Create a server",
    subtitle: "Set up a new space for your community",
    fields,
    submitLabel: "Create server",
    onSubmit: async (values) => {
      if (!values["srv-name"] || !values["srv-name"].trim()) {
        throw new Error("Server name is required");
      }

      let iconUrl = null;
      const fileInput = document.getElementById("srv-icon");
      if (fileInput && fileInput.files && fileInput.files[0]) {
        const file = fileInput.files[0];
        if (file.size > 5 * 1024 * 1024) throw new Error("Icon must be under 5MB");
        const dataUrl = await fileToDataUrl(file);
        const { url } = await apiFetch("/api/servers/icon", {
          method: "POST",
          body: JSON.stringify({ dataUrl }),
        });
        iconUrl = url;
      }

      const { server } = await apiFetch("/api/servers", {
        method: "POST",
        body: JSON.stringify({
          name: values["srv-name"].trim(),
          description: values["srv-desc"] ? values["srv-desc"].trim() : null,
          is_public: superadmin ? !!values["srv-public"] : false,
          icon_url: iconUrl,
        }),
      });
      showToast("Server created", { variant: "accent" });
      await loadServers();
      await selectServer(server);
    },
  });
}

    function canModerateMessages() {
      if (isAdmin(currentProfile)) return true;
      return !!(
        currentServerMembership &&
        (currentServerMembership.role === "admin" || currentServerMembership.role === "moderator")
      );
    }

    function canManageCurrentServer() {
      if (!currentServer) return false;
      if (isAdmin(currentProfile)) return true;
      return !!(currentServerMembership && currentServerMembership.role === "admin");
    }

    async function handleCreateChannel() {
      if (!currentServer) return;
      openFormModal({
        title: "Create a channel",
        subtitle: `In ${currentServer.name}`,
        fields: [
          { id: "ch-name", label: "Channel name", type: "text", placeholder: "general" },
          { id: "ch-type", label: "Channel type", type: "channel-type", value: "text" },
          {
            id: "ch-private",
            label: "Private channel",
            type: "toggle",
            hint: "Only visible to server admins and moderators for now.",
            checked: false,
          },
        ],
        submitLabel: "Create channel",
        onSubmit: async (values) => {
          if (!values["ch-name"] || !values["ch-name"].trim()) {
            throw new Error("Channel name is required");
          }
          const { channel } = await apiFetch(`/api/servers/${currentServer.id}/channels`, {
            method: "POST",
            body: JSON.stringify({
              name: values["ch-name"].trim(),
              type: values["ch-type"] || "text",
              is_private: !!values["ch-private"],
            }),
          });
          showToast("Channel created", { variant: "accent" });
          await loadChannels(currentServer.id);
          if ((values["ch-type"] || "text") === "voice") {
            toggleVoiceChannel(channel);
          } else {
            selectChannel(channel);
          }
        },
      });
    }

    async function handleEditServer(server) {
      const admin = isAdmin(currentProfile);
      const superadmin = currentProfile && currentProfile.global_role === "superadmin";
      openFormModal({
        title: "Edit server",
        subtitle: server.name,
        fields: [
          { id: "srv-name", label: "Server name", type: "text", value: server.name },
          { id: "srv-desc", label: "Description", type: "textarea", value: server.description || "" },
          { id: "srv-icon", label: "Server icon", type: "file", value: server.icon_url || "", placeholderText: server.name },
          ...(superadmin
            ? [
                {
                  id: "srv-public",
                  label: "Public server",
                  type: "toggle",
                  hint: "Anyone can find and join a public server. Only superadmins can toggle this.",
                  checked: !!server.is_public,
                },
              ]
            : []),
        ],
        submitLabel: "Save changes",
        onSubmit: async (values) => {
          const body = {
            name: values["srv-name"].trim(),
            description: values["srv-desc"] ? values["srv-desc"].trim() : null,
          };
          if (superadmin) body.is_public = !!values["srv-public"];

          const fileInput = document.getElementById("srv-icon");
          if (fileInput && fileInput.files && fileInput.files[0]) {
            const file = fileInput.files[0];
            if (file.size > 5 * 1024 * 1024) throw new Error("Icon must be under 5MB");
            const dataUrl = await fileToDataUrl(file);
            const { url } = await apiFetch("/api/servers/icon", {
              method: "POST",
              body: JSON.stringify({ dataUrl }),
            });
            body.icon_url = url;
          }

          const { server: updated } = await apiFetch(`/api/servers/${server.id}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          });
          showToast("Server updated", { variant: "accent" });
          await loadServers();
          if (currentServer && currentServer.id === updated.id) {
            currentServer = updated;
            currentServerNameEl.textContent = updated.name;
            currentServerMetaEl.textContent = updated.is_public ? "Public server" : "Private server";
          }
        },
      });
    }

    async function handleDeleteServer(server) {
      if (!confirm(`Delete "${server.name}"? This deletes every channel and message in it. This can't be undone.`)) {
        return;
      }
      try {
        await apiFetch(`/api/servers/${server.id}`, { method: "DELETE" });
        showToast("Server deleted", { variant: "accent" });
        markServerDeletedLocally(server.id);
        if (currentServer && currentServer.id === server.id) {
          currentServer = null;
          currentChannel = null;
          unsubscribeRealtimeMessages();
          channelListEl.innerHTML = "";
          messageListEl.innerHTML = "";
          currentServerNameEl.textContent = "No server";
          currentServerMetaEl.textContent = "Select a server";
        }
        await loadServers();
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to delete server", { variant: "danger" });
      }
    }

    async function handleLeaveServer(server) {
      if (!confirm(`Leave "${server.name}"? It will disappear from your server list.`)) return;
      try {
        await apiFetch(`/api/servers/${server.id}/leave`, { method: "POST" });
        showToast(`Left ${server.name}`, { variant: "accent" });
        markServerLeftLocally(server.id);
        if (currentServer && currentServer.id === server.id) {
          currentServer = null;
          currentChannel = null;
          unsubscribeRealtimeMessages();
          channelListEl.innerHTML = "";
          messageListEl.innerHTML = "";
          currentServerNameEl.textContent = "No server";
          currentServerMetaEl.textContent = "Select a server";
          showNoChannelSelectedState();
        }
        const recent = getRecentServerIds().filter((id) => id !== server.id);
        try {
          localStorage.setItem(RECENT_SERVERS_KEY, JSON.stringify(recent));
        } catch {}
        await loadServers();
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to leave server", { variant: "danger" });
      }
    }

    function openServerContextMenu(x, y, server) {
      closeContextMenus();
      const isMember = allServers.some((s) => s.id === server.id);
      const canManage =
        (currentServerMembership &&
          currentServer &&
          currentServer.id === server.id &&
          (currentServerMembership.role === "admin" || currentServerMembership.role === "moderator")) ||
        isAdmin(currentProfile) ||
        server.owner_id === (currentProfile && currentProfile.id);
      const muted = mutedServerIds.has(server.id);

      const items = [
        {
          label: `${muteBellSVG(muted)} ${muted ? "Unmute notifications" : "Mute notifications"}`,
          action: async () => {
            await toggleMuteServer(server.id, !muted);
          },
        },
        ...(canManage
          ? [
              { label: "Edit server", action: () => handleEditServer(server) },
              { label: "Server admin panel", action: () => openServerAdminPanel(server) },
              { label: "Invite people", action: () => handleOpenInvites(server) },
              {
                label: server.is_public ? "Make private" : "Make public",
                action: async () => {
                  try {
                    await apiFetch(`/api/servers/${server.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ is_public: !server.is_public }),
                    });
                    showToast(server.is_public ? "Server is now private" : "Server is now public", {
                      variant: "accent",
                    });
                    await loadServers();
                  } catch (err) {
                    console.error(err);
                    showToast(err.message || "Failed to update server", { variant: "danger" });
                  }
                },
                superadminOnly: true,
              },
              { label: "Delete server", action: () => handleDeleteServer(server), danger: true },
            ]
          : []),
        ...(isMember
          ? [{ label: "Leave server", action: () => handleLeaveServer(server), danger: true }]
          : []),
      ].filter((item) => !item.superadminOnly || (currentProfile && currentProfile.global_role === "superadmin"));

      if (!items.length) return;

      serverContextMenu.innerHTML = items
        .map(
          (item) => `
        <div class="context-menu-item ${item.danger ? "context-menu-item-danger" : ""}">
          <span>${item.label}</span>
        </div>
      `
        )
        .join("");

      Array.from(serverContextMenu.querySelectorAll(".context-menu-item")).forEach((el, idx) => {
        el.addEventListener("click", () => {
          items[idx].action();
          closeContextMenus();
        });
      });

      serverContextMenu.classList.add("visible");
      clampToViewport(serverContextMenu, x, y);
    }

    let publicServersCache = [];
    let myServerIdsCache = new Set();

    async function handleBrowseServers() {
      browseServersModal.classList.add("visible");
      if (publicServerSearchInput) publicServerSearchInput.value = "";
      publicServerList.innerHTML = `<div class="empty-state-small"><span class="spinner"></span>Loading...</div>`;
      try {
        const { servers } = await apiFetch("/api/servers/public");
        publicServersCache = servers || [];
        myServerIdsCache = new Set((await apiFetch("/api/servers")).servers.map((s) => s.id));
        renderPublicServers("");
      } catch (err) {
        console.error(err);
        publicServerList.innerHTML = `<div class="empty-state-small">Failed to load public servers.</div>`;
      }
    }

    function renderPublicServers(filterText) {
      const q = (filterText || "").trim().toLowerCase();
      const servers = q
        ? publicServersCache.filter(
            (s) => (s.name || "").toLowerCase().includes(q) || (s.description || "").toLowerCase().includes(q)
          )
        : publicServersCache;

      if (!servers.length) {
        publicServerList.innerHTML = `<div class="empty-state-small">${
          publicServersCache.length ? "No servers match that search." : "No public servers yet."
        }</div>`;
        return;
      }

      publicServerList.innerHTML = servers
        .map(
          (s) => `
        <div class="public-server-card">
          <div class="public-server-card-main">
<div class="public-server-icon">
  ${s.icon_url
    ? `<img src="${escapeHtml(s.icon_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
    : escapeHtml((s.name || "?").slice(0, 2).toUpperCase())}
</div>              <div>
            <div class="public-server-name">${escapeHtml(s.name)}</div>
            <div class="public-server-desc">${escapeHtml(s.description || "No description")}</div>
          </div>
        </div>
        <button class="public-server-join" data-server-id="${s.id}" ${myServerIdsCache.has(s.id) ? "disabled" : ""}>
          ${myServerIdsCache.has(s.id) ? "Joined" : "Join"}
        </button>
      </div>
    `
        )
        .join("");

      publicServerList.querySelectorAll(".public-server-join").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (btn.disabled) return;
          btn.disabled = true;
          btn.textContent = "Joining...";
          try {
            const server = servers.find((s) => s.id === btn.dataset.serverId);
            await apiFetch(`/api/servers/${btn.dataset.serverId}/join`, { method: "POST" });
            showToast(`Joined ${server ? server.name : "server"}`, { variant: "accent" });
            btn.textContent = "Joined";
            myServerIdsCache.add(btn.dataset.serverId);
            await loadServers();
          } catch (err) {
            console.error(err);
            btn.disabled = false;
            btn.textContent = "Join";
            showToast(err.message || "Failed to join server", { variant: "danger" });
          }
        });
      });
    }

    let invitesModalServer = null;

    function inviteUrl(code) {

      return `${getAppBaseUrl()}?invite=${code}`;
    }

    function handleOpenInvites(server) {
      invitesModalServer = server;
      invitesModalSubtitle.textContent = `Share a link to let others join ${server.name}`;
      invitesModal.classList.add("visible");
      loadInvites(server.id);
    }

    async function loadInvites(serverId) {
      invitesList.innerHTML = `<div class="empty-state-small"><span class="spinner"></span>Loading...</div>`;
      try {
        const { invites } = await apiFetch(`/api/servers/${serverId}/invites`);
        if (!invites.length) {
          invitesList.innerHTML = `<div class="empty-state-small">No invite links yet.</div>`;
          return;
        }
        invitesList.innerHTML = invites
          .map((inv) => {
            const expired = inv.expires_at && new Date(inv.expires_at) < new Date();
            const usedUp = inv.max_uses !== null && inv.uses >= inv.max_uses;
            const dead = expired || usedUp;
            return `
            <div class="admin-row" style="margin-bottom:8px;">
              <div class="admin-row-main">
                <div>
                  <div class="admin-row-name">
                    ${escapeHtml(inviteUrl(inv.code))}
                    ${dead ? `<span class="admin-row-badge admin-row-badge-danger">Inactive</span>` : ""}
                  </div>
                  <div class="admin-row-meta">
                    ${inv.uses || 0}${inv.max_uses ? ` / ${inv.max_uses}` : ""} uses
                    ${inv.expires_at ? ` · Expires ${new Date(inv.expires_at).toLocaleString()}` : " · No expiry"}
                  </div>
                </div>
              </div>
              <div class="admin-row-actions">
                <button class="identity-action-button" data-action="copy" data-code="${inv.code}">Copy</button>
                <button class="identity-action-button identity-action-button-danger" data-action="revoke" data-id="${inv.id}">Revoke</button>
              </div>
            </div>
          `;
          })
          .join("");

        invitesList.querySelectorAll('[data-action="copy"]').forEach((btn) => {
          btn.addEventListener("click", () => {
            navigator.clipboard.writeText(inviteUrl(btn.dataset.code));
            showToast("Invite link copied", { variant: "accent" });
          });
        });
        invitesList.querySelectorAll('[data-action="revoke"]').forEach((btn) => {
          btn.addEventListener("click", async () => {
            try {
              await apiFetch(`/api/invites/${btn.dataset.id}`, { method: "DELETE" });
              showToast("Invite revoked", { variant: "accent" });
              loadInvites(serverId);
            } catch (err) {
              console.error(err);
              showToast(err.message || "Failed to revoke invite", { variant: "danger" });
            }
          });
        });
      } catch (err) {
        console.error(err);
        invitesList.innerHTML = `<div class="empty-state-small">Failed to load invites.</div>`;
      }
    }

    async function handleCreateInvite() {
      if (!invitesModalServer) return;
      try {
        const expiresInHours = inviteExpirySelect.value ? Number(inviteExpirySelect.value) : null;
        const maxUses = inviteMaxUsesInput.value ? Number(inviteMaxUsesInput.value) : null;
        const { invite } = await apiFetch(`/api/servers/${invitesModalServer.id}/invites`, {
          method: "POST",
          body: JSON.stringify({ expiresInHours, maxUses }),
        });
        navigator.clipboard.writeText(inviteUrl(invite.code));
        showToast("Invite link created and copied", { variant: "accent" });
        inviteMaxUsesInput.value = "";
        inviteExpirySelect.value = "";
        loadInvites(invitesModalServer.id);
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to create invite", { variant: "danger" });
      }
    }

    async function redeemInviteFromUrl() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("invite");
      if (!code) return;

      params.delete("invite");
      const cleanUrl =
        window.location.pathname + (params.toString() ? `?${params.toString()}` : "");
      window.history.replaceState({}, "", cleanUrl);

      try {
        const { server, alreadyMember } = await apiFetch(`/api/invites/${code}/redeem`, {
          method: "POST",
        });
        showToast(alreadyMember ? `You're already in ${server.name}` : `Joined ${server.name}!`, {
          variant: "accent",
        });
        await loadServers();
        const joined = allServers.find((s) => s.id === server.id);
        if (joined) selectServer(joined);
      } catch (err) {
        console.error(err);
        showToast(err.message || "That invite link is invalid or expired", { variant: "danger" });
      }
    }

    let currentDmConversationId = null;
    let dmRealtimeChannel = null;

    function unsubscribeDmRealtime() {
      if (dmRealtimeChannel && supabaseClient) {
        supabaseClient.removeChannel(dmRealtimeChannel);
      }
      dmRealtimeChannel = null;
    }

    function renderDmMessage(message) {

      if (message.parent_id) {
        upsertReplyOnParent(dmMessageList, message);
        return;
      }

      const emptyState = dmMessageList.querySelector(".empty-state-small");
      if (emptyState) emptyState.remove();

      const existing = dmMessageList.querySelector(`[data-dm-message-id="${message.id}"]`);
      if (message.deleted_at) {
        if (existing) existing.remove();
        return;
      }
      if (existing) {

        const contentEl = existing.querySelector(".dm-message-content");
        if (contentEl) {
          contentEl.innerHTML = formatMessageContent(message.content);
          applyMessageContentTruncation(contentEl);
        }
        return;
      }

      const user = message.user || {};
      const el = document.createElement("div");
      el.className = "dm-message";
      el.dataset.dmMessageId = message.id;
      el.dataset.userId = message.user_id || "";
      el.innerHTML = `
        <div class="dm-message-avatar">${avatarHTML(user)}</div>
        <div class="dm-message-body">
          <span class="dm-message-username">${escapeHtml(user.username || "Unknown")}</span>
          <span class="dm-message-time">${formatTime(message.created_at)}</span>
          ${
            message.parent && message.parent.id
              ? `<div class="dm-message-reply-quote" data-parent-id="${message.parent.id}">${uiIcon("reply", 12)} ${escapeHtml((message.parent.user && message.parent.user.username) || "Unknown")}: ${escapeHtml(message.parent.deleted_at ? "(message deleted)" : message.parent.content ? message.parent.content.slice(0, 80) : "Attachment")}</div>`
              : ""
          }
          <div class="dm-message-content">${formatMessageContent(message.content)}</div>
          ${
            message.reply_count > 0
              ? `<button class="message-replies-toggle" data-message-id="${message.id}" data-count="${message.reply_count}">${repliesToggleHTML(message.reply_count, false)}</button>
                 <div class="message-replies-thread" data-thread-for="${message.id}" style="display:none;"></div>`
              : ""
          }
          <div class="dm-message-actions">
            <button class="message-inline-button" data-action="reply">Reply</button>
            ${
              currentUser && message.user_id !== currentUser.id
                ? `<button class="message-inline-button" data-action="report">Report</button>`
                : ""
            }
          </div>
        </div>
      `;
      renderLinkPreviewInto(el, message.content, ".dm-message-content");
      el.querySelector('[data-action="reply"]').addEventListener("click", () => setDmReplyTarget(message));
      const reportBtn = el.querySelector('[data-action="report"]');
      if (reportBtn) reportBtn.addEventListener("click", () => handleReportMessage(message));
      const quoteEl = el.querySelector(".dm-message-reply-quote");
      if (quoteEl) quoteEl.addEventListener("click", () => scrollToDmMessage(quoteEl.dataset.parentId));
      const repliesToggle = el.querySelector(".message-replies-toggle");
      if (repliesToggle) {
        repliesToggle.addEventListener("click", () => toggleRepliesThread(message.id, repliesToggle));
      }
      dmMessageList.appendChild(el);

      applyMessageContentTruncation(el.querySelector(".dm-message-content"));
    }

    async function openDmConversation(conversationId, otherUser) {
      currentDmConversationId = conversationId;
      clearDmReplyTarget();
      markDmRead(conversationId);
      reportFocusStateToServiceWorker();
      apiFetch(`/api/dms/${conversationId}/read`, { method: "POST", body: JSON.stringify({}) }).catch(
        () => {}
      );
      currentDmOtherUser = otherUser || null;
      if (otherUser) extraKnownProfiles.set(otherUser.id, otherUser);
      dmChatHeader.textContent = otherUser ? otherUser.username : "Conversation";
      dmMessageList.innerHTML = `<div class="empty-state-small"><span class="spinner"></span>Loading...</div>`;
      Array.from(dmConversationList.querySelectorAll(".dm-conversation-item")).forEach((el) => {
        el.classList.toggle("active", el.dataset.conversationId === conversationId);
      });
      updateDmCallButton();

      try {
        const { messages } = await apiFetch(`/api/dms/${conversationId}/messages`);
        dmMessageList.innerHTML = "";
        if (!messages.length) {
          dmMessageList.innerHTML = `<div class="empty-state-small">No messages yet — say hi!</div>`;
        } else {
          messages.forEach((m) => renderDmMessage(m));
        }
        dmMessageList.scrollTop = dmMessageList.scrollHeight;
      } catch (err) {
        console.error(err);
        dmMessageList.innerHTML = `<div class="empty-state-small">Failed to load messages.</div>`;
      }

      unsubscribeDmRealtime();
      if (supabaseClient) {
        dmRealtimeChannel = supabaseClient
          .channel(`dm:${conversationId}`, { config: { private: true } })
          .on("broadcast", { event: "*" }, async (msg) => {
            const { operation, record } = msg.payload || {};
            if (!record) return;

            if (operation === "DELETE") {
              const row = dmMessageList.querySelector(`[data-dm-message-id="${record.id}"]`);
              if (row) row.remove();
              return;
            }

            if (operation === "UPDATE") {
              const row = dmMessageList.querySelector(`[data-dm-message-id="${record.id}"]`);
              if (row) {
                if (record.deleted_at) {
                  row.remove();
                } else {

                  const contentEl = row.querySelector(".dm-message-content");
                  if (contentEl) {
                    contentEl.innerHTML = formatMessageContent(record.content || "");
                    applyMessageContentTruncation(contentEl);
                  }
                }
              }
              return;
            }

            if (dmMessageList.querySelector(`[data-dm-message-id="${record.id}"]`)) return;
            const user = await resolveProfile(record.user_id);
            renderDmMessage({ ...record, user });
            dmMessageList.scrollTop = dmMessageList.scrollHeight;
          })
          .subscribe((status, err) => logRealtimeStatus(`dm-conversation:${conversationId}`, status, err));
      }
    }

    async function loadDmConversations() {
      dmConversationList.innerHTML = `<div class="empty-state-small"><span class="spinner"></span>Loading...</div>`;
      try {
        const { conversations } = await apiFetch("/api/dms");
        dmConversationsCache = conversations;
        activeCallConversationIds.clear();
        conversations.forEach((c) => {
          if (c.active_call) activeCallConversationIds.add(c.id);
        });
        if (!conversations.length) {
          dmConversationList.innerHTML = `<div class="empty-state-small">No conversations yet.</div>`;
          return;
        }
        dmConversationList.innerHTML = conversations
          .map(
            (c) => {
              const isMuted = mutedConversationIds.has(c.id);
              const unread = isMuted ? 0 : (unreadDmCounts.get(c.id) || 0);
              return `
          <div class="dm-conversation-item${unread > 0 ? " has-unread" : ""}${activeCallConversationIds.has(c.id) ? " has-voice-activity" : ""}" data-conversation-id="${c.id}">
            <div class="dm-conversation-avatar">${c.other_user ? avatarHTML(c.other_user) : DEFAULT_AVATAR_SVG}</div>
            <div class="dm-conversation-main">
              <div class="dm-conversation-name">${escapeHtml(c.other_user ? c.other_user.username : "Unknown")}</div>
              <div class="dm-conversation-preview">${escapeHtml(c.last_message ? c.last_message.content || "" : "No messages yet")}</div>
            </div>
            <div class="dm-conversation-trailing">
              ${badgeHTML(unread)}
              <button class="dm-mute-toggle" title="${isMuted ? "Unmute" : "Mute notifications"}" aria-label="${isMuted ? "Unmute" : "Mute notifications"}">${muteBellSVG(isMuted)}</button>
              <span class="voice-active-dot"></span>
            </div>
          </div>`;
            }
          )
          .join("");

        dmConversationList.querySelectorAll(".dm-mute-toggle").forEach((btn, idx) => {
          btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const id = conversations[idx].id;
            await toggleMuteConversation(id, !mutedConversationIds.has(id));
            const nowMuted = mutedConversationIds.has(id);
            btn.innerHTML = muteBellSVG(nowMuted);
            btn.title = nowMuted ? "Unmute" : "Mute notifications";
            btn.setAttribute("aria-label", nowMuted ? "Unmute" : "Mute notifications");
          });
        });

        dmConversationList.querySelectorAll(".dm-conversation-item").forEach((el, idx) => {
          el.addEventListener("click", () => {
            openDmConversation(conversations[idx].id, conversations[idx].other_user);
            markDmRead(conversations[idx].id);
          });
        });
      } catch (err) {
        console.error(err);
        dmConversationList.innerHTML = `<div class="empty-state-small">Failed to load conversations.</div>`;
      }
    }

    let dmOpenInProgressUserId = null;

    async function openDmWith(user) {
      dmModal.classList.add("visible");

      const cached = dmConversationsCache.find((c) => c.other_user && c.other_user.id === user.id);
      if (cached) {
        openDmConversation(cached.id, user);
        return;
      }

      if (dmOpenInProgressUserId === user.id) return;
      dmOpenInProgressUserId = user.id;

      try {
        const { conversation_id } = await apiFetch("/api/dms", {
          method: "POST",
          body: JSON.stringify({ target_user_id: user.id }),
        });
        await loadDmConversations();
        openDmConversation(conversation_id, user);
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to open conversation", { variant: "danger" });
      } finally {
        dmOpenInProgressUserId = null;
      }
    }

    let dmSearchDebounce = null;

    function closeDmSearchResults() {
      dmSearchResults.classList.remove("visible");
      dmSearchResults.innerHTML = "";
    }

    function handleDmSearchInput() {
      const q = dmSearchInput.value.trim();
      clearTimeout(dmSearchDebounce);
      if (q.length < 2) {
        closeDmSearchResults();
        return;
      }
      dmSearchDebounce = setTimeout(async () => {
        try {
          const { users } = await apiFetch(`/api/users/search?q=${encodeURIComponent(q)}`);
          if (!users.length) {
            dmSearchResults.innerHTML = `<div class="empty-state-small">No users found</div>`;
          } else {
            dmSearchResults.innerHTML = users
              .map(
                (u) => `
              <div class="dm-search-result-item" data-user-id="${u.id}">
                <div class="dm-search-result-avatar">${avatarHTML(u)}</div>
                <span>${escapeHtml(u.username)}</span>
              </div>
            `
              )
              .join("");
            dmSearchResults.querySelectorAll(".dm-search-result-item").forEach((el, idx) => {
              el.addEventListener("click", () => {
                dmSearchInput.value = "";
                closeDmSearchResults();
                openDmWith(users[idx]);
              });
            });
          }
          dmSearchResults.classList.add("visible");
        } catch (err) {
          console.error(err);
        }
      }, 250);
    }

    function handleOpenDmModal() {
      dmModal.classList.add("visible");
      loadDmConversations();
      if (!currentDmConversationId) {
        if (dmCallButton) dmCallButton.style.display = "none";
        if (dmVideoCallButton) dmVideoCallButton.style.display = "none";
      } else {
        try { updateDmCallButton(); } catch (e) {}
      }

      if (currentDmConversationId) {
        Array.from(dmConversationList.querySelectorAll(".dm-conversation-item")).forEach((el) => {
          el.classList.toggle("active", el.dataset.conversationId === currentDmConversationId);
        });
      }
    }

    function closeDmModal() {
      dmModal.classList.remove("visible");
      unsubscribeDmRealtime();
      unsubscribeDmCallRealtime();
      currentDmConversationId = null;
      currentDmOtherUser = null;
      clearDmReplyTarget();
      dmChatHeader.textContent = "Select a conversation";
      dmMessageList.innerHTML = "";
      if (dmCallButton) dmCallButton.style.display = "none";
      if (dmVideoCallButton) dmVideoCallButton.style.display = "none";
      if (dmVoiceBar) dmVoiceBar.classList.remove("visible");
      Array.from(dmConversationList.querySelectorAll(".dm-conversation-item")).forEach((el) => {
        el.classList.remove("active");
      });
      try { updateDmCallButton(); } catch (e) {}
      reportFocusStateToServiceWorker();
    }

    function setDmReplyTarget(message) {
      dmReplyingToMessage = message;
      const user = message.user || {};
      dmReplyPreviewText.textContent = `Replying to ${user.username || "Unknown"}: ${(message.content || "(attachment)").slice(0, 80)}`;
      dmReplyPreviewBar.style.display = "flex";
      dmInput.focus();
    }

    function clearDmReplyTarget() {
      dmReplyingToMessage = null;
      dmReplyPreviewBar.style.display = "none";
      dmReplyPreviewText.textContent = "";
    }

    function scrollToDmMessage(messageId) {
      const row = dmMessageList.querySelector(`[data-dm-message-id="${messageId}"]`);
      if (!row) return;
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.classList.add("highlight-flash");
      setTimeout(() => row.classList.remove("highlight-flash"), 1500);
    }

    function updateDmConversationPreview(conversationId, message) {
      const convo = dmConversationsCache.find((c) => c.id === conversationId);
      if (convo) {
        convo.last_message = {
          content: message.content,
          created_at: message.created_at,
          user_id: message.user_id,
        };
      }
      const el = dmConversationList.querySelector(
        `.dm-conversation-item[data-conversation-id="${conversationId}"] .dm-conversation-preview`
      );
      if (el) {
        el.textContent = message.content || "";
      }
    }

    let isSendingDmMessage = false;

    async function handleSendDmMessage() {
      const content = dmInput.value.trim();
      if (!content || !currentDmConversationId) return;
      if (isSendingDmMessage) return;
      isSendingDmMessage = true;
      dmSendButton.disabled = true;
      try {
        const parentId = dmReplyingToMessage ? dmReplyingToMessage.id : null;
        const { message } = await apiFetch(`/api/dms/${currentDmConversationId}/messages`, {
          method: "POST",
          body: JSON.stringify({ content, parent_id: parentId }),
        });
        dmInput.value = "";
        autoResizeTextarea(dmInput);
        clearDmReplyTarget();
        renderDmMessage({ ...message, user: currentProfile });
        dmMessageList.scrollTop = dmMessageList.scrollHeight;
        updateDmConversationPreview(currentDmConversationId, message);
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to send message", { variant: "danger" });
      } finally {
        isSendingDmMessage = false;
        dmSendButton.disabled = false;
      }
    }

    function switchAdminTab(tab) {
      adminTabs.forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
      adminUsersPanel.style.display = tab === "users" ? "flex" : "none";
      adminUserSearchBar.style.display = tab === "users" ? "block" : "none";
      adminServersPanel.style.display = tab === "servers" ? "flex" : "none";
      if (adminServerSearchBar) adminServerSearchBar.style.display = tab === "servers" ? "block" : "none";
      adminReportsPanel.style.display = tab === "reports" ? "flex" : "none";
      adminBanRequestsPanel.style.display = tab === "ban-requests" ? "flex" : "none";
      if (tab === "users") loadAdminUsers();
      if (tab === "servers") loadAdminServers();
      if (tab === "reports") loadAdminReports();
      if (tab === "ban-requests") loadAdminBanRequests();
    }

    function handleAdminDashboardOpen() {
      adminDashboardModal.classList.add("visible");
      switchAdminTab("users");
    }

    function switchServerAdminTab(tab) {
      serverAdminTabs.forEach((btn) => btn.classList.toggle("active", btn.dataset.serverAdminTab === tab));
      serverAdminChannelsPanel.style.display = tab === "channels" ? "flex" : "none";
      serverAdminMembersPanel.style.display = tab === "members" ? "flex" : "none";
      if (serverAdminMemberSearchBar) serverAdminMemberSearchBar.style.display = tab === "members" ? "block" : "none";
      const invitesPanel = document.getElementById("server-admin-invites-panel");
      if (invitesPanel) invitesPanel.style.display = tab === "invites" ? "flex" : "none";
      serverAdminFilteringPanel.style.display = tab === "filtering" ? "flex" : "none";
      if (tab === "channels") loadServerAdminChannels();
      if (tab === "members") loadServerAdminMembers();
      if (tab === "invites") loadServerAdminInvites();
      if (tab === "filtering") loadServerAdminFiltering();
    }

    async function loadServerAdminInvites() {
      if (!serverAdminTarget) return;
      const panel = document.getElementById("server-admin-invites-panel");
      panel.innerHTML = `<div class="empty-state-small"><span class="spinner"></span>Loading...</div>`;
      try {
        const { invites } = await apiFetch(`/api/servers/${serverAdminTarget.id}/invites`);
        const listHtml = !invites.length
          ? `<div class="empty-state-small">No invite links yet.</div>`
          : invites
              .map((inv) => {
                const expired = inv.expires_at && new Date(inv.expires_at) < new Date();
                const usedUp = inv.max_uses !== null && inv.uses >= inv.max_uses;
                const dead = expired || usedUp;
                return `
            <div class="admin-row" style="margin-bottom:8px;">
              <div class="admin-row-main">
                <div>
                  <div class="admin-row-name">
                    ${escapeHtml(inviteUrl(inv.code))}
                    ${dead ? `<span class="admin-row-badge admin-row-badge-danger">Inactive</span>` : ""}
                  </div>
                  <div class="admin-row-meta">
                    ${inv.uses || 0}${inv.max_uses ? ` / ${inv.max_uses}` : ""} uses
                    ${inv.expires_at ? ` · Expires ${new Date(inv.expires_at).toLocaleString()}` : " · No expiry"}
                  </div>
                </div>
              </div>
              <div class="admin-row-actions">
                <button class="identity-action-button" data-action="copy" data-code="${inv.code}">Copy</button>
                <button class="identity-action-button identity-action-button-danger" data-action="revoke" data-id="${inv.id}">Revoke</button>
              </div>
            </div>`;
              })
              .join("");

        panel.innerHTML = `
          <div class="form-row" style="display:flex; gap:8px; margin-bottom:10px;">
            <select id="server-admin-invite-expiry" class="settings-input" style="flex:1;">
              <option value="">No expiry</option>
              <option value="1">1 hour</option>
              <option value="24">1 day</option>
              <option value="168">7 days</option>
              <option value="720">30 days</option>
            </select>
            <input id="server-admin-invite-max-uses" class="settings-input" type="number" min="1" placeholder="Max uses (optional)" style="flex:1;" />
          </div>
          <button class="settings-save" id="server-admin-create-invite" style="width:100%; margin-bottom:10px;">Create invite link</button>
          <div id="server-admin-invites-list">${listHtml}</div>
        `;

        document.getElementById("server-admin-create-invite").onclick = async () => {
          const expiresInHours = document.getElementById("server-admin-invite-expiry").value
            ? Number(document.getElementById("server-admin-invite-expiry").value)
            : null;
          const maxUses = document.getElementById("server-admin-invite-max-uses").value
            ? Number(document.getElementById("server-admin-invite-max-uses").value)
            : null;
          try {
            const { invite } = await apiFetch(`/api/servers/${serverAdminTarget.id}/invites`, {
              method: "POST",
              body: JSON.stringify({ expiresInHours, maxUses }),
            });
            navigator.clipboard.writeText(inviteUrl(invite.code));
            showToast("Invite link created and copied", { variant: "accent" });
            loadServerAdminInvites();
          } catch (err) {
            showToast(err.message || "Failed to create invite", { variant: "danger" });
          }
        };

        panel.querySelectorAll('[data-action="copy"]').forEach((btn) => {
          btn.addEventListener("click", () => {
            navigator.clipboard.writeText(inviteUrl(btn.dataset.code));
            showToast("Invite link copied", { variant: "accent" });
          });
        });
        panel.querySelectorAll('[data-action="revoke"]').forEach((btn) => {
          btn.addEventListener("click", async () => {
            try {
              await apiFetch(`/api/invites/${btn.dataset.id}`, { method: "DELETE" });
              showToast("Invite revoked", { variant: "accent" });
              loadServerAdminInvites();
            } catch (err) {
              showToast(err.message || "Failed to revoke invite", { variant: "danger" });
            }
          });
        });
      } catch (err) {
        panel.innerHTML = `<div class="empty-state-small">Failed to load invites.</div>`;
      }
    }

    function openServerAdminPanel(server) {
      serverAdminTarget = server;
      serverAdminSubtitle.textContent = server.name;
      if (serverAdminMemberSearchInput) serverAdminMemberSearchInput.value = "";
      serverAdminModal.classList.add("visible");
      switchServerAdminTab("channels");
    }

    async function loadServerAdminChannels() {
      if (!serverAdminTarget) return;
      serverAdminChannelsPanel.innerHTML = `<div class="empty-state-small"><span class="spinner"></span>Loading...</div>`;
      try {
        const { channels } = await apiFetch(`/api/servers/${serverAdminTarget.id}/channels`);
        if (!channels.length) {
          serverAdminChannelsPanel.innerHTML = `<div class="empty-state-small">No channels.</div>`;
          return;
        }
        serverAdminChannelsPanel.innerHTML = channels
          .map(
            (ch) => `
          <div class="admin-row">
            <div class="admin-row-main">
              <div>
                <div class="admin-row-name">${channelTypeIcon(ch.type, 14)} ${escapeHtml(ch.name)}</div>
                <div class="admin-row-meta">${escapeHtml(ch.type || "text")}${ch.is_private ? " · Private" : ""}</div>
              </div>
            </div>
            <div class="admin-row-actions" data-channel-id="${ch.id}">
              <button class="identity-action-button identity-action-button-danger" data-action="delete-channel">Delete</button>
            </div>
          </div>
        `
          )
          .join("");

        serverAdminChannelsPanel.querySelectorAll("[data-action='delete-channel']").forEach((el) => {
          const channelId = el.closest(".admin-row-actions").dataset.channelId;
          const channel = channels.find((c) => c.id === channelId);
          el.addEventListener("click", async () => {
            if (!confirm(`Delete #${channel.name}? This deletes all of its messages too. This can't be undone.`)) return;
            try {
              await apiFetch(`/api/servers/${serverAdminTarget.id}/channels/${channelId}`, { method: "DELETE" });
              showToast("Channel deleted", { variant: "accent" });
              loadServerAdminChannels();
              if (currentServer && currentServer.id === serverAdminTarget.id) loadChannels(currentServer.id);
            } catch (err) {
              console.error(err);
              showToast(err.message || "Failed to delete channel", { variant: "danger" });
            }
          });
        });
      } catch (err) {
        console.error(err);
        serverAdminChannelsPanel.innerHTML = `<div class="empty-state-small">Failed to load channels.</div>`;
      }
    }

    let serverAdminMembersCache = [];

    async function loadServerAdminMembers() {
      if (!serverAdminTarget) return;
      serverAdminMembersPanel.innerHTML = `<div class="empty-state-small"><span class="spinner"></span>Loading...</div>`;
      try {
        const { members } = await apiFetch(`/api/servers/${serverAdminTarget.id}/users`);
        serverAdminMembersCache = members || [];
        renderServerAdminMembers(serverAdminMemberSearchInput ? serverAdminMemberSearchInput.value : "");
      } catch (err) {
        console.error(err);
        serverAdminMembersPanel.innerHTML = `<div class="empty-state-small">Failed to load members.</div>`;
      }
    }

    function renderServerAdminMembers(filterText) {
      const q = (filterText || "").trim().toLowerCase();
      const members = q ? serverAdminMembersCache.filter((m) => (m.user.username || "").toLowerCase().includes(q)) : serverAdminMembersCache;

      if (!members.length) {
        serverAdminMembersPanel.innerHTML = `<div class="empty-state-small">${q ? "No members match that search." : "No members."}</div>`;
        return;
      }

      serverAdminMembersPanel.innerHTML = members
        .map((m) => {
          const targetIsSiteAdmin = isAdmin(m.user);
          const canBan = !m.is_banned && canActOnAdminTarget(serverAdminTarget, m, "ban");
          const canKick = canActOnAdminTarget(serverAdminTarget, m, "kick");
          const roleLocked = m.role === "admin" && !canActOnAdminTarget(serverAdminTarget, m, "demote");
          const banTitle = targetIsSiteAdmin ? "Can't ban a system-wide admin or superadmin" : "Only the server owner can ban another admin";
          const kickTitle = "Only the server owner can kick another admin";
          const roleTitle = "Only the server owner can demote another admin";

          return `
        <div class="admin-row">
          <div class="admin-row-main">
            <div class="user-avatar" style="width:32px;height:32px;">${avatarHTML(m.user)}</div>
            <div>
              <div class="admin-row-name">
                ${escapeHtml(m.user.username || "")}
                ${m.is_banned ? `<span class="user-role-pill" style="background:var(--danger-subtle); color:var(--danger);">Banned</span>` : ""}
                ${targetIsSiteAdmin ? `<span class="user-role-pill">Site admin</span>` : ""}
              </div>
              <div class="admin-row-meta">${escapeHtml(m.role)}</div>
            </div>
          </div>
          <div class="admin-row-actions" data-user-id="${m.user.id}">
            <select class="settings-input server-admin-role-select" data-action="role" style="padding:4px 8px; font-size:11px;" ${roleLocked ? `disabled title="${roleTitle}"` : ""}>
              <option value="member" ${m.role === "member" ? "selected" : ""}>Member</option>
              <option value="moderator" ${m.role === "moderator" ? "selected" : ""}>Moderator</option>
              <option value="admin" ${m.role === "admin" ? "selected" : ""}>Admin</option>
            </select>
            ${
              m.is_banned
                ? `<button class="identity-action-button" data-action="unban">Unban</button>`
                : `<button class="identity-action-button identity-action-button-danger" data-action="ban" ${!canBan ? `disabled title="${banTitle}"` : ""}>Ban</button>`
            }
            <button class="identity-action-button identity-action-button-danger" data-action="kick" ${!canKick ? `disabled title="${kickTitle}"` : ""}>Kick</button>
          </div>
        </div>
      `;
        })
        .join("");

      serverAdminMembersPanel.querySelectorAll("[data-action='role']").forEach((el) => {
        const userId = el.closest(".admin-row-actions").dataset.userId;
        el.addEventListener("change", async () => {
          try {
            await apiFetch(`/api/servers/${serverAdminTarget.id}/members/${userId}`, {
              method: "PATCH",
              body: JSON.stringify({ role: el.value }),
            });
            showToast("Member role updated", { variant: "accent" });
            if (currentServer && currentServer.id === serverAdminTarget.id) loadServerMembers(currentServer.id);
          } catch (err) {
            console.error(err);
            showToast(err.message || "Failed to update role", { variant: "danger" });
            loadServerAdminMembers();
          }
        });
      });

      serverAdminMembersPanel.querySelectorAll("[data-action='kick']").forEach((el) => {
        const userId = el.closest(".admin-row-actions").dataset.userId;
        const member = members.find((m) => m.user.id === userId);
        el.addEventListener("click", async () => {
          if (!confirm(`Kick ${member.user.username} from this server? They can rejoin with a new invite.`)) return;
          try {
            await apiFetch(`/api/servers/${serverAdminTarget.id}/members/${userId}/kick`, { method: "POST" });
            showToast("Member kicked", { variant: "accent" });
            loadServerAdminMembers();
            if (currentServer && currentServer.id === serverAdminTarget.id) loadServerMembers(currentServer.id);
          } catch (err) {
            console.error(err);
            showToast(err.message || "Failed to kick member", { variant: "danger" });
          }
        });
      });

      serverAdminMembersPanel.querySelectorAll("[data-action='ban']").forEach((el) => {
        const userId = el.closest(".admin-row-actions").dataset.userId;
        el.addEventListener("click", () => handleBanFromServer(serverAdminTarget.id, userId));
      });

      serverAdminMembersPanel.querySelectorAll("[data-action='unban']").forEach((el) => {
        const userId = el.closest(".admin-row-actions").dataset.userId;
        el.addEventListener("click", () => handleUnbanFromServer(serverAdminTarget.id, userId));
      });
    }

    async function loadServerAdminFiltering() {
      if (!serverAdminTarget) return;
      serverAdminFiltersList.innerHTML = `<div class="empty-state-small"><span class="spinner"></span>Loading...</div>`;
      try {
        const { settings, filters } = await apiFetch(`/api/servers/${serverAdminTarget.id}/filter-settings`);
        serverAdminFilterEnabled.checked = !!settings.enabled;
        serverAdminFilterUseBasic.checked = settings.use_basic_filter !== false;
        renderServerAdminFilters(filters || []);
      } catch (err) {
        console.error(err);
        serverAdminFiltersList.innerHTML = `<div class="empty-state-small">Failed to load filters.</div>`;
      }
    }

    function renderServerAdminFilters(filters) {
      if (!filters.length) {
        serverAdminFiltersList.innerHTML = `<div class="empty-state-small">No custom filters yet.</div>`;
        return;
      }
      serverAdminFiltersList.innerHTML = filters
        .map(
          (f) => `
        <div class="server-admin-filter-row" data-filter-id="${f.id}">
          <div class="server-admin-filter-row-text">${escapeHtml(f.phrase)} → ${escapeHtml(f.replacement || "(removed)")}</div>
          <button class="identity-action-button identity-action-button-danger" data-action="delete-filter">Remove</button>
        </div>
      `
        )
        .join("");

      serverAdminFiltersList.querySelectorAll("[data-action='delete-filter']").forEach((el) => {
        const filterId = el.closest(".server-admin-filter-row").dataset.filterId;
        el.addEventListener("click", async () => {
          try {
            await apiFetch(`/api/servers/${serverAdminTarget.id}/filters/${filterId}`, { method: "DELETE" });
            loadServerAdminFiltering();
          } catch (err) {
            console.error(err);
            showToast(err.message || "Failed to remove filter", { variant: "danger" });
          }
        });
      });
    }

    async function handleServerAdminFilterToggle(field, value) {
      if (!serverAdminTarget) return;
      try {
        await apiFetch(`/api/servers/${serverAdminTarget.id}/filter-settings`, {
          method: "PATCH",
          body: JSON.stringify({ [field]: value }),
        });
        showToast("Filter settings saved", { variant: "accent" });
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to save filter settings", { variant: "danger" });
        loadServerAdminFiltering();
      }
    }

    async function handleAddServerAdminFilter() {
      if (!serverAdminTarget) return;
      const phrase = serverAdminFilterPhrase.value.trim();
      const replacement = serverAdminFilterReplacement.value;
      if (!phrase) return;
      try {
        await apiFetch(`/api/servers/${serverAdminTarget.id}/filters`, {
          method: "POST",
          body: JSON.stringify({ phrase, replacement }),
        });
        serverAdminFilterPhrase.value = "";
        serverAdminFilterReplacement.value = "";
        loadServerAdminFiltering();
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to add filter", { variant: "danger" });
      }
    }

    let adminUsersCache = [];

    async function loadAdminUsers() {
      adminUsersPanel.innerHTML = `<div class="empty-state-small"><span class="spinner"></span>Loading...</div>`;
      try {
        const { users } = await apiFetch("/api/admin/users");
        adminUsersCache = users;
        renderAdminUsers(adminUserSearchInput ? adminUserSearchInput.value : "");
      } catch (err) {
        console.error(err);
        adminUsersPanel.innerHTML = `<div class="empty-state-small">Failed to load users.</div>`;
      }
    }

    function renderAdminUsers(filterText) {
      const canChangeRoles = currentProfile.global_role === "superadmin";
      const q = (filterText || "").trim().toLowerCase();
      const users = q ? adminUsersCache.filter((u) => (u.username || "").toLowerCase().includes(q)) : adminUsersCache;

      if (!users.length) {
        adminUsersPanel.innerHTML = `<div class="empty-state-small">No users match that search.</div>`;
        return;
      }

      adminUsersPanel.innerHTML = users
        .map((u) => {
          const banActive = isBanActive(u);
          const lockActive = isForceLogoutActive(u);
          const badges = [];
          if (u.global_role !== "user") badges.push(`<span class="admin-row-badge">${escapeHtml(u.global_role)}</span>`);
          if (banActive) {
            badges.push(`<span class="admin-row-badge admin-row-badge-danger">Banned</span>`);
          }
          if (lockActive && !banActive) {
            const shortKick =
              u.force_logout_until &&
              new Date(u.force_logout_until).getTime() - Date.now() < 5 * 60 * 1000;
            badges.push(
              shortKick
                ? `<span class="admin-row-badge admin-row-badge-danger">Session reset</span>`
                : `<span class="admin-row-badge admin-row-badge-danger">Locked out</span>`
            );
          }

          const roleChangeBlocked = u.global_role === "superadmin" && u.id !== currentProfile.id;
          const banActions = banActive
            ? `<button class="identity-action-button" data-action="unban">Unban</button>
               <button class="identity-action-button" data-action="ban-details">Ban details</button>`
            : `<button class="identity-action-button identity-action-button-danger" data-action="ban">Ban</button>`;
          const lockActions = banActive
            ? ""
            : lockActive
              ? `<button class="identity-action-button" data-action="allow-login">Allow login</button>`
              : `<button class="identity-action-button" data-action="force-logout">Force logout</button>`;

          return `
            <div class="admin-row">
              <div class="admin-row-main">
                <div class="user-avatar" style="width:32px;height:32px;flex-shrink:0;">${avatarHTML(u)}</div>
                <div style="min-width:0; flex:1;">
                  <div class="admin-row-name">${escapeHtml(u.username || "")} ${badges.join(" ")}</div>
                  <div class="admin-row-meta">Joined ${new Date(u.created_at).toLocaleDateString()}${
                    banActive
                      ? ` · Banned ${formatUntil(u.banned_until)}`
                      : lockActive
                        ? ` · Signed out ${formatUntil(u.force_logout_until)}`
                        : ""
                  }</div>
                </div>
              </div>
              <div class="admin-row-actions" data-user-id="${u.id}">
                <button class="identity-action-button" data-action="view-profile">Profile</button>
                ${banActions}
                ${lockActions}
                <button class="identity-action-button" data-action="kick">Kick</button>
                ${
                  canChangeRoles
                    ? `
                  <select class="settings-input admin-role-select${roleChangeBlocked ? " role-select-disabled" : ""}" data-action="role" ${roleChangeBlocked ? 'title="Can\'t change another superadmin\'s role" disabled' : ""} style="padding:4px 8px; font-size:11px;">
                    <option value="user" ${u.global_role === "user" ? "selected" : ""}>User</option>
                    <option value="admin" ${u.global_role === "admin" ? "selected" : ""}>Admin</option>
                    <option value="superadmin" ${u.global_role === "superadmin" ? "selected" : ""}>Superadmin</option>
                  </select>
                `
                    : ""
                }
              </div>
            </div>
          `;
        })
        .join("");

      adminUsersPanel.querySelectorAll("[data-action]").forEach((el) => {
        const userId = el.closest(".admin-row-actions").dataset.userId;
        const action = el.dataset.action;
        if (action === "role") {
          el.addEventListener("change", async () => {
            try {
              await apiFetch(`/api/admin/users/${userId}/role`, {
                method: "POST",
                body: JSON.stringify({ role: el.value }),
              });
              showToast("Role updated", { variant: "accent" });
            } catch (err) {
              console.error(err);
              showToast(err.message || "Failed to update role", { variant: "danger" });
              loadAdminUsers();
            }
          });
          return;
        }
        el.addEventListener("click", async () => {
          try {
            if (action === "view-profile") {
              const user = adminUsersCache.find((u) => u.id === userId);
              if (user) {
                adminDashboardModal.classList.remove("visible");
                openViewProfileModal(user);
              }
              return;
            }
            if (action === "ban") {
              await handleBanUser(userId);
              return;
            } else if (action === "ban-details") {
              await handleBanDetails(userId);
              return;
            } else if (action === "unban") {
              await apiFetch(`/api/admin/users/${userId}/unban`, { method: "POST" });
              showToast("User unbanned", { variant: "accent" });
            } else if (action === "force-logout") {
              await handleForceLogoutUser(userId);
              return;
            } else if (action === "kick") {
              const result = await apiFetch(`/api/admin/users/${userId}/kick`, { method: "POST" });
              showToast(
                result.executed
                  ? "User kicked (temporary sign-out)"
                  : result.message || "Recorded — awaiting another admin's approval",
                { variant: "accent" }
              );
            } else if (action === "allow-login") {
              await apiFetch(`/api/admin/users/${userId}/allow-login`, { method: "POST" });
              showToast("User can sign in again", { variant: "accent" });
            }
            loadAdminUsers();
          } catch (err) {
            console.error(err);
            showToast(err.message || "Action failed", { variant: "danger" });
          }
        });
      });
    }

    let adminServersCache = [];

    async function loadAdminServers() {
      adminServersPanel.innerHTML = `<div class="empty-state-small"><span class="spinner"></span>Loading...</div>`;
      try {
        const { servers } = await apiFetch("/api/admin/servers");
        adminServersCache = servers || [];
        renderAdminServers(adminServerSearchInput ? adminServerSearchInput.value : "");
      } catch (err) {
        console.error(err);
        adminServersPanel.innerHTML = `<div class="empty-state-small">Failed to load servers.</div>`;
      }
    }

    function renderAdminServers(filterText) {
      const q = (filterText || "").trim().toLowerCase();
      const servers = q ? adminServersCache.filter((s) => (s.name || "").toLowerCase().includes(q)) : adminServersCache;

      if (!servers.length) {
        adminServersPanel.innerHTML = `<div class="empty-state-small">${q ? "No servers match that search." : "No servers."}</div>`;
        return;
      }

      adminServersPanel.innerHTML = servers
        .map(
          (s) => `
        <div class="admin-row">
          <div class="admin-row-main">
<div class="public-server-icon">
  ${s.icon_url
    ? `<img src="${escapeHtml(s.icon_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
    : escapeHtml((s.name || "?").slice(0, 2).toUpperCase())}
</div>              <div>
              <div class="admin-row-name">
                ${escapeHtml(s.name)}
                ${s.is_public ? `<span class="admin-row-badge">Public</span>` : ""}
              </div>
              <div class="admin-row-meta">Owner: ${escapeHtml(s.owner ? s.owner.username : "Unknown")}</div>
            </div>
          </div>
          <div class="admin-row-actions" data-server-id="${s.id}">
            <button class="identity-action-button" data-action="open">Open</button>
            <button class="identity-action-button" data-action="toggle-public">${s.is_public ? "Make private" : "Make public"}</button>
            <button class="identity-action-button identity-action-button-danger" data-action="delete">Delete</button>
          </div>
        </div>
      `
        )
        .join("");

      adminServersPanel.querySelectorAll("[data-action]").forEach((el) => {
        const serverId = el.closest(".admin-row-actions").dataset.serverId;
        const server = servers.find((s) => s.id === serverId);
        const action = el.dataset.action;
        el.addEventListener("click", async () => {
          if (action === "open") {
            adminDashboardModal.classList.remove("visible");
            try {
              await apiFetch(`/api/servers/${serverId}/join`, { method: "POST" });
              await loadServers();
              let target = allServers.find((s) => s.id === serverId) || server;
              if (!target || !target.id) {
                const res = await apiFetch(`/api/servers/${serverId}`);
                target = res.server;
              }
              await selectServer(target);
            } catch (err) {
              console.error(err);
              showToast(err.message || "Failed to open server", { variant: "danger" });
            }
            return;
          }
          if (action === "delete") {
            if (!confirm(`Delete "${server.name}"? This can't be undone.`)) return;
            try {
              await apiFetch(`/api/servers/${serverId}`, { method: "DELETE" });
              showToast("Server deleted", { variant: "accent" });
              markServerDeletedLocally(serverId);
              loadAdminServers();
              loadServers();
            } catch (err) {
              console.error(err);
              showToast(err.message || "Failed to delete server", { variant: "danger" });
            }
            return;
          }
          if (action === "toggle-public") {
            try {
              await apiFetch(`/api/servers/${serverId}`, {
                method: "PATCH",
                body: JSON.stringify({ is_public: !server.is_public }),
              });
              showToast("Server updated", { variant: "accent" });
              loadAdminServers();
              loadServers();
            } catch (err) {
              console.error(err);
              showToast(err.message || "Failed to update server", { variant: "danger" });
            }
          }
        });
      });
    }

    async function openReportTarget(report) {
      const msg = report && report.message;
      if (!msg) {
        showToast("This report has no linked message", { variant: "danger" });
        return;
      }
      const channelId = msg.channel_id || (msg.channel && msg.channel.id);
      const serverId = msg.channel && msg.channel.server_id;
      if (!channelId || !serverId) {
        showToast("Could not locate the reported message's channel", { variant: "danger" });
        return;
      }
      try {
        adminDashboardModal.classList.remove("visible");
        let server = allServers.find((s) => s.id === serverId);
        if (!server) {
          const res = await apiFetch(`/api/servers/${serverId}`);
          server = res.server;
        }
        await selectServer(server);
        const channel =
          (msg.channel && msg.channel.id === channelId && msg.channel) ||
          { id: channelId, name: (msg.channel && msg.channel.name) || "channel", type: (msg.channel && msg.channel.type) || "text", server_id: serverId };
        await selectChannel(channel);
        scrollToReportedMessage(msg.id);
        showReportReviewBanner(report);
        showToast("Opened reported message", { variant: "accent" });
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to open report", { variant: "danger" });
      }
    }

    async function loadAdminReports() {
      adminReportsPanel.innerHTML = `<div class="empty-state-small"><span class="spinner"></span>Loading...</div>`;
      try {
        const { reports } = await apiFetch("/api/admin/reports?status=open");
        if (!reports.length) {
          adminReportsPanel.innerHTML = `<div class="empty-state-small">No open reports.</div>`;
          return;
        }
        adminReportsPanel.innerHTML = reports
          .map((r) => {
            const target = r.reported_user;
            const msg = r.message;
            return `
            <div class="admin-row" data-report-id="${r.id}">
              <div class="admin-row-main">
                <div>
                  <div class="admin-row-name">
                    Reported ${target ? escapeHtml(target.username || "user") : "content"}
                    ${target && target.global_role !== "user" ? `<span class="admin-row-badge">${escapeHtml(target.global_role)}</span>` : ""}
                  </div>
                  <div class="admin-row-meta">
                    Reason: ${escapeHtml(r.reason)}${r.details ? ` — ${escapeHtml(r.details)}` : ""}
                  </div>
                  <div class="admin-row-meta">
                    Reported by ${escapeHtml((r.reporter && r.reporter.username) || "someone")} on ${new Date(r.created_at).toLocaleString()}
                    ${msg ? ` · Message: "${escapeHtml((msg.content || "(no content)").slice(0, 120))}"` : ""}
                  </div>
                </div>
              </div>
              <div class="admin-row-actions">
                ${msg && (msg.channel_id || (msg.channel && msg.channel.id)) ? `<button class="identity-action-button" data-action="open">Open report</button>` : ""}
                ${target ? `<button class="identity-action-button identity-action-button-danger" data-action="ban">Ban reported</button>` : ""}
                ${r.reporter ? `<button class="identity-action-button identity-action-button-danger" data-action="ban-reporter">Ban reporter</button>` : ""}
                <button class="identity-action-button" data-action="dismiss">Dismiss</button>
                <button class="identity-action-button" data-action="resolve">Mark resolved</button>
              </div>
            </div>
          `;
          })
          .join("");

        adminReportsPanel.querySelectorAll("[data-action]").forEach((el) => {
          const row = el.closest("[data-report-id]");
          const reportId = row.dataset.reportId;
          const report = reports.find((r) => r.id === reportId);
          el.addEventListener("click", async () => {
            try {
              if (el.dataset.action === "open") {
                await openReportTarget(report);
                return;
              }
              if (el.dataset.action === "ban" && report.reported_user) {
                const result = await apiFetch(`/api/admin/users/${report.reported_user.id}/ban`, {
                  method: "POST",
                  body: JSON.stringify({ reason: `Report: ${report.reason}` }),
                });
                showToast(result.executed ? "Reported user banned" : result.message, { variant: "accent" });
              } else if (el.dataset.action === "ban-reporter" && report.reporter) {
                const ok = window.confirm(
                  `Ban reporter "${report.reporter.username || "user"}"? Use this for abuse of the report system.`
                );
                if (!ok) return;
                const result = await apiFetch(`/api/admin/users/${report.reporter.id}/ban`, {
                  method: "POST",
                  body: JSON.stringify({ reason: `Abusive report: ${report.reason || "n/a"}` }),
                });
                showToast(result.executed ? "Reporter banned" : result.message, { variant: "accent" });
              } else {
                const status = el.dataset.action === "dismiss" ? "dismissed" : "resolved";
                await apiFetch(`/api/admin/reports/${reportId}/resolve`, {
                  method: "POST",
                  body: JSON.stringify({ status }),
                });
                showToast(`Report ${status}`, { variant: "accent" });
              }
              loadAdminReports();
            } catch (err) {
              console.error(err);
              showToast(err.message || "Action failed", { variant: "danger" });
            }
          });
        });
      } catch (err) {
        console.error(err);
        adminReportsPanel.innerHTML = `<div class="empty-state-small">Failed to load reports.</div>`;
      }
    }

    async function loadAdminBanRequests() {
      adminBanRequestsPanel.innerHTML = `<div class="empty-state-small"><span class="spinner"></span>Loading...</div>`;
      try {
        const { banRequests } = await apiFetch("/api/admin/ban-requests");
        if (!banRequests.length) {
          adminBanRequestsPanel.innerHTML = `<div class="empty-state-small">No pending ban requests.</div>`;
          return;
        }
        adminBanRequestsPanel.innerHTML = banRequests
          .map((r) => {
            const approvedByMe = (r.approvals || []).some((a) => a.approver_id === currentUser.id);
            return `
            <div class="admin-row" data-request-id="${r.id}">
              <div class="admin-row-main">
                <div>
                  <div class="admin-row-name">
                    Ban ${escapeHtml((r.target && r.target.username) || "user")}
                    <span class="admin-row-badge">${escapeHtml(r.target_role)}</span>
                  </div>
                  <div class="admin-row-meta">
                    Requested by ${escapeHtml((r.requester && r.requester.username) || "someone")}${r.reason ? ` — ${escapeHtml(r.reason)}` : ""}
                  </div>
                  <div class="admin-row-meta">
                    ${(r.approvals || []).length} / ${r.required_approvals} approvals
                  </div>
                </div>
              </div>
              <div class="admin-row-actions">
                <button class="identity-action-button identity-action-button-danger" data-action="approve" ${approvedByMe ? "disabled" : ""}>
                  ${approvedByMe ? "Approved" : "Approve ban"}
                </button>
                <button class="identity-action-button" data-action="cancel">Cancel</button>
              </div>
            </div>
          `;
          })
          .join("");

        adminBanRequestsPanel.querySelectorAll("[data-action]").forEach((el) => {
          const requestId = el.closest("[data-request-id]").dataset.requestId;
          el.addEventListener("click", async () => {
            try {
              if (el.dataset.action === "approve") {
                const result = await apiFetch(`/api/admin/ban-requests/${requestId}/approve`, {
                  method: "POST",
                });
                showToast(result.executed ? "User banned" : result.message, { variant: "accent" });
              } else {
                await apiFetch(`/api/admin/ban-requests/${requestId}/cancel`, { method: "POST" });
                showToast("Ban request cancelled", { variant: "accent" });
              }
              loadAdminBanRequests();
            } catch (err) {
              console.error(err);
              showToast(err.message || "Action failed", { variant: "danger" });
            }
          });
        });
      } catch (err) {
        console.error(err);
        adminBanRequestsPanel.innerHTML = `<div class="empty-state-small">Failed to load ban requests.</div>`;
      }
    }

    let voiceRoom = null;
    let voiceChannelId = null;
    let voiceMuted = false;
    let voiceVideoEnabled = false;
    let voiceScreenSharing = false;
    let voicePreferVideo = false;
    let voiceContext = null;
    let activeDmCallId = null;
    let callRecorder = null;
    let callRecordedChunks = [];
    let callRecordMixedStream = null;

    let activeDmCallStartedAt = null;
    let currentDmOtherUser = null;
    let dmCallParticipants = [];
    let dmCallRealtimeChannel = null;
    let dmCallBarEl = null;
    const extraKnownProfiles = new Map();

    function findMemberProfile(identity) {
      const match = (currentServerMembers || []).find((m) => m.user && m.user.id === identity);
      if (match) return match.user;
      if (currentProfile && currentProfile.id === identity) return currentProfile;
      if (extraKnownProfiles.has(identity)) return extraKnownProfiles.get(identity);
      return null;
    }

    function activeVoiceBarEls() {
      return voiceContext === "dm"
        ? {
            bar: dmVoiceBar,
            label: dmVoiceBarLabel,
            participants: dmVoiceBarParticipants,
            muteButton: dmVoiceMuteButton,
          }
        : {
            bar: voiceBar,
            label: voiceBarLabel,
            participants: voiceBarParticipants,
            muteButton: voiceMuteButton,
          };
    }

    let _voiceRenderScheduled = false;
    function renderVoiceParticipants() {
      if (_voiceRenderScheduled) return;
      _voiceRenderScheduled = true;
      requestAnimationFrame(() => {
        _voiceRenderScheduled = false;
        renderVoiceParticipantsNow();
      });
    }

    function renderVoiceParticipantsNow() {
      if (voiceContext === "server") {
        renderVoiceStage();
        return;
      }

      const { participants: participantsEl } = activeVoiceBarEls();
      if (!voiceRoom) {
        participantsEl.innerHTML = "";
        return;
      }
      const speakingIds = new Set((voiceRoom.activeSpeakers || []).map((p) => p.identity));
      const participants = [voiceRoom.localParticipant, ...Array.from(voiceRoom.remoteParticipants.values())];

      participantsEl.innerHTML = participants
        .map((p) => {
          const isLocal = p.identity === voiceRoom.localParticipant.identity;
          const profile = resolveVoiceProfile(p.identity, isLocal);
          const name = profile ? profile.username : isLocal ? "You" : "Loading...";
          const speaking = speakingIds.has(p.identity);
          const muted = p.isMicrophoneEnabled === false;
          return `
            <div class="voice-participant ${speaking ? "speaking" : ""}" data-identity="${escapeHtml(p.identity)}">
              <div class="voice-participant-avatar">${profile ? avatarHTML(profile) : DEFAULT_AVATAR_SVG}</div>
              <span>${escapeHtml(name)}${muted ? uiIcon("mic-off", 12) : ""}</span>
            </div>
          `;
        })
        .join("");
    }

    function resolveVoiceProfile(identity, isLocal) {
      if (isLocal && currentProfile) return currentProfile;
      if (currentProfile && currentProfile.id === identity) return currentProfile;
      if (currentDmOtherUser && currentDmOtherUser.id === identity) return currentDmOtherUser;
      let profile = findMemberProfile(identity);
      if (!profile && extraKnownProfiles.has(identity)) {
        profile = extraKnownProfiles.get(identity);
      }
      if (!profile && identity) {
        resolveProfile(identity).then((resolved) => {
          if (resolved) {
            extraKnownProfiles.set(identity, resolved);
            try { renderVoiceParticipants(); } catch (e) {}
            try { renderCallOverlayStage(); } catch (e) {}
            try { renderDmCallBar(); } catch (e) {}
          }
        });
      }
      return profile || null;
    }

    function renderVoiceStage() {
      if (!voiceRoom) {
        voiceStageGrid.innerHTML = "";
        return;
      }
      const speakingIds = new Set((voiceRoom.activeSpeakers || []).map((p) => p.identity));
      const participants = [voiceRoom.localParticipant, ...Array.from(voiceRoom.remoteParticipants.values())];

      voiceStageGrid.innerHTML = participants
        .map((p) => {
          const isLocal = p.identity === voiceRoom.localParticipant.identity;
          const profile = resolveVoiceProfile(p.identity, isLocal);
          const name = profile ? profile.username : isLocal ? "You" : "Loading...";
          const speaking = speakingIds.has(p.identity);
          const muted = p.isMicrophoneEnabled === false;
          const canModerate = !isLocal && canManageCurrentServer();
          return `
            <div class="voice-tile ${speaking ? "speaking" : ""}" data-identity="${escapeHtml(p.identity)}">
              <div class="voice-tile-avatar">${profile ? avatarHTML(profile) : DEFAULT_AVATAR_SVG}</div>
              <div class="voice-tile-name">
                ${muted ? `<span class="voice-tile-mic-off">${uiIcon("mic-off", 14)}</span>` : ""}
                <span>${escapeHtml(name)}${isLocal ? " (you)" : ""}</span>
              </div>
              ${
                canModerate
                  ? `<div class="voice-tile-mod-actions">
                      <button class="voice-tile-mod-button" data-mod-action="mute" title="Mute">${uiIcon("mic-off", 14)}</button>
                      <button class="voice-tile-mod-button" data-mod-action="kick" title="Remove from voice">${uiIcon("x", 14)}</button>
                    </div>`
                  : ""
              }
            </div>
          `;
        })
        .join("");

      voiceStageGrid.querySelectorAll("[data-mod-action]").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const identity = btn.closest("[data-identity]").dataset.identity;
          const action = btn.dataset.modAction;
          try {
            await apiFetch(`/api/voice/channels/${voiceChannelId}/${action}`, {
              method: "POST",
              body: JSON.stringify({ userId: identity }),
            });
            showToast(action === "kick" ? "Removed from voice" : "Muted", { duration: 1500 });
          } catch (err) {
            console.error(err);
            showToast(err.message || `Failed to ${action}`, { variant: "danger" });
          }
        });
      });
    }

    const _pendingAudioEls = new Set();
    let _audioResumeToastShown = false;
    function tryPlayAudioEl(el) {
      el.play().catch(() => {
        _pendingAudioEls.add(el);
        if (!_audioResumeToastShown) {
          _audioResumeToastShown = true;
          showToast("Click anywhere to enable voice audio", { variant: "accent" });
        }
        document.addEventListener(
          "click",
          () => {
            _pendingAudioEls.forEach((pending) => pending.play().catch(() => {}));
            _pendingAudioEls.clear();
            _audioResumeToastShown = false;
          },
          { once: true }
        );
      });
    }

    let voiceConnectGeneration = 0;


    function renderDmVideoStage() {
      if (!dmVideoStage) return;
      if (!voiceRoom || voiceContext !== "dm") {
        dmVideoStage.classList.remove("visible");
        dmVideoStage.innerHTML = "";
        return;
      }
      const participants = [voiceRoom.localParticipant, ...Array.from(voiceRoom.remoteParticipants.values())];
      const tiles = [];
      participants.forEach((p) => {
        const pubs = Array.from(p.videoTrackPublications?.values?.() || p.trackPublications?.values?.() || []);
        pubs.forEach((pub) => {
          if (!pub || pub.kind !== "video" && pub.track?.kind !== "video") return;
          const track = pub.track;
          if (!track || track.isMuted) return;
          const isLocal = p.identity === voiceRoom.localParticipant.identity;
          const profile = resolveVoiceProfile(p.identity, isLocal);
          const name = profile ? profile.username : isLocal ? "You" : "User";
          const source = pub.source === 2 || pub.source === "screen_share" || (pub.trackName || "").includes("screen") ? "screen" : "camera";
          tiles.push({ identity: p.identity, track, name, isLocal, source });
        });
      });
      if (!tiles.length) {
        dmVideoStage.classList.remove("visible");
        dmVideoStage.innerHTML = "";
        return;
      }
      dmVideoStage.classList.add("visible");
      const existing = new Map();
      Array.from(dmVideoStage.querySelectorAll(".dm-video-tile")).forEach((el) => {
        existing.set(el.dataset.key, el);
      });
      const used = new Set();
      tiles.forEach((t) => {
        const key = `${t.identity}:${t.source}:${t.track.sid || ""}`;
        used.add(key);
        let tile = existing.get(key);
        if (!tile) {
          tile = document.createElement("div");
          tile.className = "dm-video-tile";
          tile.dataset.key = key;
          const video = t.track.attach();
          video.autoplay = true;
          video.playsInline = true;
          video.muted = t.isLocal;
          tile.appendChild(video);
          const label = document.createElement("div");
          label.className = "dm-video-tile-label";
          label.textContent = `${t.name}${t.source === "screen" ? " (screen)" : ""}`;
          tile.appendChild(label);
          dmVideoStage.appendChild(tile);
        }
      });
      existing.forEach((el, key) => {
        if (!used.has(key)) el.remove();
      });
    }

    function updateDmCallMediaButtons() {
      const isVideoCall = !!(voicePreferVideo || voiceVideoEnabled || voiceScreenSharing);
      if (dmVideoToggleButton) {
        dmVideoToggleButton.style.display = isVideoCall ? "" : "none";
        dmVideoToggleButton.classList.toggle("active", !!voiceVideoEnabled);
        dmVideoToggleButton.textContent = voiceVideoEnabled ? "Cam on" : "Cam";
      }
      if (dmScreenShareButton) {
        dmScreenShareButton.style.display = isVideoCall ? "" : "none";
        dmScreenShareButton.classList.toggle("active", !!voiceScreenSharing);
        dmScreenShareButton.textContent = voiceScreenSharing ? "Sharing" : "Share";
      }
      if (dmRecordButton) {
        const rec = !!callRecorder;
        dmRecordButton.classList.toggle("recording", rec);
        dmRecordButton.textContent = rec ? "Stop" : "Rec";
      }
    }

    async function toggleDmCamera() {
      if (!voiceRoom || voiceContext !== "dm") return;
      if (!voicePreferVideo && !voiceVideoEnabled && !voiceScreenSharing) {
        showToast("Camera is only available on video calls", { duration: 2000 });
        return;
      }
      try {
        const next = !voiceVideoEnabled;
        await voiceRoom.localParticipant.setCameraEnabled(next);
        await new Promise((r) => setTimeout(r, 120));
        syncLocalMediaFlagsFromRoom();
        if (next && !voiceVideoEnabled) voiceVideoEnabled = true;
        if (!next) voiceVideoEnabled = false;
        renderDmVideoStage();
        updateDmCallMediaButtons();
        updateCallOverlayControls();
        showCallOverlay(true);
        scheduleCallStageRender();
        showToast(voiceVideoEnabled ? "Camera on" : "Camera off", { duration: 1500 });
      } catch (err) {
        console.error(err);
        syncLocalMediaFlagsFromRoom();
        updateDmCallMediaButtons();
        updateCallOverlayControls();
        scheduleCallStageRender();
        showToast(err.message || "Failed to toggle camera", { variant: "danger" });
      }
    }

    function syncLocalMediaFlagsFromRoom() {
      if (!voiceRoom) {
        voiceScreenSharing = false;
        voiceVideoEnabled = false;
        return;
      }
      const pubs = voiceRoom.localParticipant.videoTrackPublications
        ? Array.from(voiceRoom.localParticipant.videoTrackPublications.values())
        : [];
      let sharing = false;
      let cam = false;
      pubs.forEach((pub) => {
        if (!pub || pub.isMuted || !pub.track) return;
        const src = pub.source;
        const isScreen =
          src === 2 ||
          src === "screen_share" ||
          src === "screen_share_audio" ||
          (typeof src === "string" && src.toLowerCase().includes("screen"));
        if (isScreen) sharing = true;
        else cam = true;
      });
      voiceScreenSharing = sharing;
      voiceVideoEnabled = cam || voicePreferVideo && cam;
      voiceVideoEnabled = cam;
    }

    async function toggleDmScreenShare() {
      if (!voiceRoom || voiceContext !== "dm") return;
      try {
        const currentlySharing = !!voiceScreenSharing;
        const next = !currentlySharing;
        const hadCamera = !!voiceVideoEnabled;
        if (next) {
          await voiceRoom.localParticipant.setScreenShareEnabled(true);
        } else {
          await voiceRoom.localParticipant.setScreenShareEnabled(false);
          const pubs = Array.from(voiceRoom.localParticipant.videoTrackPublications.values());
          for (const pub of pubs) {
            const src = pub.source;
            const isScreen =
              src === 2 ||
              src === "screen_share" ||
              (typeof src === "string" && String(src).toLowerCase().includes("screen"));
            if (isScreen && pub.track) {
              try {
                await voiceRoom.localParticipant.unpublishTrack(pub.track);
              } catch (e) {}
            }
          }
        }
        syncLocalMediaFlagsFromRoom();
        if (!next && hadCamera) {
          try {
            await voiceRoom.localParticipant.setCameraEnabled(true);
          } catch (camErr) {
            console.error("Failed to restore camera after screen share", camErr);
          }
          syncLocalMediaFlagsFromRoom();
        }
        if (next && hadCamera) {
          try {
            await voiceRoom.localParticipant.setCameraEnabled(true);
          } catch (camErr) {
            console.error(camErr);
          }
          syncLocalMediaFlagsFromRoom();
        }
        renderDmVideoStage();
        renderCallOverlayStage();
        updateDmCallMediaButtons();
        updateCallOverlayControls();
        showToast(voiceScreenSharing ? "Screen sharing" : "Screen share stopped", { duration: 1500 });
      } catch (err) {
        console.error(err);
        syncLocalMediaFlagsFromRoom();
        updateDmCallMediaButtons();
        updateCallOverlayControls();
        showToast(err.message || "Failed to share screen", { variant: "danger" });
      }
    }

    function buildCallMixStream() {
      if (!voiceRoom) return null;
      const tracks = [];
      try {
        voiceRoom.localParticipant.audioTrackPublications.forEach((pub) => {
          if (pub.track && pub.track.mediaStreamTrack) tracks.push(pub.track.mediaStreamTrack);
        });
        voiceRoom.localParticipant.videoTrackPublications.forEach((pub) => {
          if (pub.track && pub.track.mediaStreamTrack) tracks.push(pub.track.mediaStreamTrack);
        });
        voiceRoom.remoteParticipants.forEach((p) => {
          p.audioTrackPublications.forEach((pub) => {
            if (pub.track && pub.track.mediaStreamTrack) tracks.push(pub.track.mediaStreamTrack);
          });
          p.videoTrackPublications.forEach((pub) => {
            if (pub.track && pub.track.mediaStreamTrack) tracks.push(pub.track.mediaStreamTrack);
          });
        });
      } catch (err) {
        console.error(err);
      }
      if (!tracks.length) return null;
      return new MediaStream(tracks);
    }

    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    function stopCallRecording(fromCleanup) {
      if (!callRecorder) return;
      const rec = callRecorder;
      callRecorder = null;
      try {
        if (rec.state !== "inactive") rec.stop();
      } catch (e) {}
      updateDmCallMediaButtons();
      updateCallOverlayControls();
      try { broadcastCallData({ type: "recording_stopped", at: Date.now() }); } catch (e) {}
      if (!fromCleanup) showToast("Recording stopped — downloading…", { duration: 2000 });
    }

    function startCallRecording() {
      if (!voiceRoom || voiceContext !== "dm") return;
      if (callRecorder) {
        stopCallRecording(false);
        return;
      }
      const stream = buildCallMixStream();
      if (!stream) {
        showToast("Nothing to record yet — join with audio or video first", { variant: "danger" });
        return;
      }
      callRecordedChunks = [];
      callRecordMixedStream = stream;
      const hasVideo = stream.getVideoTracks().length > 0;
      const mimeCandidates = hasVideo
        ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
        : ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"];
      let mime = "";
      for (const m of mimeCandidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) {
          mime = m;
          break;
        }
      }
      try {
        callRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      } catch (err) {
        console.error(err);
        showToast("Recording not supported in this browser", { variant: "danger" });
        callRecorder = null;
        return;
      }
      callRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size) callRecordedChunks.push(e.data);
      };
      callRecorder.onstop = () => {
        try {
          const type = (callRecorder && callRecorder.mimeType) || mime || (hasVideo ? "video/webm" : "audio/webm");
          const blob = new Blob(callRecordedChunks, { type });
          const ext = type.includes("ogg") ? "ogg" : "webm";
          const kind = hasVideo ? "video" : "audio";
          const name = `vexa-call-${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
          downloadBlob(blob, name);
          showToast(`Downloaded ${kind} recording`, { variant: "accent" });
        } catch (err) {
          console.error(err);
          showToast("Failed to save recording", { variant: "danger" });
        }
        callRecordedChunks = [];
        callRecordMixedStream = null;
        callRecorder = null;
        updateDmCallMediaButtons();
      };
      callRecorder.start(1000);
      updateDmCallMediaButtons();
      updateCallOverlayControls();
      broadcastCallData({ type: "recording_started", at: Date.now() });
      showToast("Recording started — others were notified", { variant: "accent", duration: 2000 });
    }

    async function connectVoice(descriptor, context) {
      if (!window.LivekitClient) {
        showToast("Voice library failed to load. Check your connection.", { variant: "danger" });
        return;
      }

      const myGeneration = ++voiceConnectGeneration;
      voiceContext = context || "server";
      const { bar, label } = activeVoiceBarEls();

      label.textContent = `Connecting to ${descriptor.name}...`;
      bar.classList.add("visible");
      if (voiceContext === "server") chatConnectionStatusEl.textContent = "Requesting token";
      let data;
      try {
        data = await apiFetch("/api/livekit/token", {
          method: "POST",
          body: JSON.stringify({ roomName: descriptor.id }),
        });
      } catch (err) {
        console.error(err);
        if (voiceContext === "server") chatConnectionStatusEl.textContent = "Voice error";
        label.textContent = `Couldn't connect: ${err.message || "request failed"}`;
        bar.classList.add("visible");
        setTimeout(() => bar.classList.remove("visible"), 4000);
        showToast(err.message || "Failed to get a voice token", { variant: "danger" });
        return;
      }

      if (myGeneration !== voiceConnectGeneration) return;

      const token = data.token || data.accessToken;
      const url = data.url || data.serverUrl || data.wsUrl || data.livekitUrl;

      if (!token || !url) {
        console.error("Unexpected LiveKit token response shape", data);
        if (voiceContext === "server") chatConnectionStatusEl.textContent = "Voice error";
        label.textContent = "Couldn't connect: bad token response";
        setTimeout(() => bar.classList.remove("visible"), 4000);
        showToast("Voice server did not return a usable token/URL — check the browser console for the raw response.", { variant: "danger" });
        return;
      }

      try {
        if (voiceContext === "server") chatConnectionStatusEl.textContent = "Connecting";
        const { Room, RoomEvent } = window.LivekitClient;
        const room = new Room({ adaptiveStream: true, dynacast: true });

        room
          .on(RoomEvent.ParticipantConnected, () => {
            renderVoiceParticipants();
            try { setCallConnecting(false); } catch (e) {}
            try { updateCallOverlayChrome(); } catch (e) {}
            try { updateDmCallButton(); } catch (e) {}
            try { updateCallOverlayControls(); } catch (e) {}
            try { renderDmCallBar(); } catch (e) {}
            try { scheduleCallStageRender(); } catch (e) {}
            try { updateMuteBadges(); } catch (e) {}
          })
          .on(RoomEvent.ParticipantDisconnected, () => {
            renderVoiceParticipants();
            try { updateDmCallButton(); } catch (e) {}
            try { updateCallOverlayControls(); } catch (e) {}
            try { renderDmCallBar(); } catch (e) {}
            if (voiceContext === "dm" && voiceRoom && voiceRoom.remoteParticipants.size === 0) {
              showToast("Call ended — everyone else left", { duration: 2500 });
              setTimeout(() => {
                try { disconnectVoice(); } catch (e) {}
              }, 400);
            }
          })
          .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === "audio") {
              const el = track.attach();
              el.id = `voice-audio-${participant.identity}-${track.sid}`;
              el.autoplay = true;

              el.setAttribute("playsinline", "true");
              getVoiceAudioContainer().appendChild(el);
              tryPlayAudioEl(el);
            }
            if (track.kind === "video") {
              renderDmVideoStage();
              scheduleCallStageRender();
            }
            renderVoiceParticipants();
          })
          .on(RoomEvent.TrackUnsubscribed, (track) => {
            track.detach().forEach((el) => el.remove());
            if (track.kind === "video") {
              renderDmVideoStage();
              scheduleCallStageRender();
            }
            renderVoiceParticipants();
          })
          .on(RoomEvent.ActiveSpeakersChanged, () => {
            renderVoiceParticipants();
            updateSpeakingIndicators();
          })
          .on(RoomEvent.DataReceived, (payload, participant) => {
            try {
              const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
              const data = JSON.parse(text);
              handleIncomingCallData(data, participant);
            } catch (e) {}
          })
          .on(RoomEvent.LocalTrackPublished, () => { syncLocalMediaFlagsFromRoom(); renderVoiceParticipants(); renderDmVideoStage(); scheduleCallStageRender(); updateDmCallMediaButtons(); updateCallOverlayControls(); updateMuteBadges(); })
          .on(RoomEvent.LocalTrackUnpublished, () => { syncLocalMediaFlagsFromRoom(); renderVoiceParticipants(); renderDmVideoStage(); scheduleCallStageRender(); updateDmCallMediaButtons(); updateCallOverlayControls(); updateMuteBadges(); })
          .on(RoomEvent.TrackMuted, (pub, participant) => {
            renderVoiceParticipants();
            syncLocalMediaFlagsFromRoom();
            updateMuteBadges();
            if (pub && (pub.kind === "video" || (pub.track && pub.track.kind === "video"))) {
              scheduleCallStageRender();
            }
          })
          .on(RoomEvent.TrackUnmuted, (pub, participant) => {
            renderVoiceParticipants();
            syncLocalMediaFlagsFromRoom();
            updateMuteBadges();
            if (pub && (pub.kind === "video" || (pub.track && pub.track.kind === "video"))) {
              scheduleCallStageRender();
            }
          })
          .on(RoomEvent.Disconnected, () => {
            const wasDm = voiceContext === "dm";
            const callId = activeDmCallId;
            voiceRoom = null;
            leaveVoiceCleanup();
            if (wasDm && callId) {
              apiFetch(`/api/voice-calls/${callId}/leave`, { method: "POST" }).catch(() => {});
              try { updateDmCallButton(); } catch (e) {}
            }
          });

        await room.connect(url, token);

        if (myGeneration !== voiceConnectGeneration) {
          try {
            await room.disconnect();
          } catch (err) {
            console.error(err);
          }
          leaveVoiceCleanup();
          return;
        }

        await room.localParticipant.setMicrophoneEnabled(true);
        if (voicePreferVideo && context === "dm") {
          try {
            await room.localParticipant.setCameraEnabled(true);
            voiceVideoEnabled = true;
          } catch (camErr) {
            console.error(camErr);
            showToast("Could not enable camera: " + (camErr.message || "permission denied"), { variant: "danger" });
            voiceVideoEnabled = false;
          }
        } else {
          try {
            await room.localParticipant.setCameraEnabled(false);
          } catch (e) {}
          voiceVideoEnabled = false;
        }
        voiceScreenSharing = false;

        voiceRoom = room;
        voiceChannelId = descriptor.id;
        voiceMuted = false;
        const { label: activeLabel, muteButton } = activeVoiceBarEls();
        activeLabel.innerHTML = `${uiIcon("volume", 14)} Connected: ${escapeHtml(descriptor.name)}`;
        setMuteButtonIcon(muteButton, false);
        muteButton.classList.remove("active");
        if (voiceContext === "server") chatConnectionStatusEl.textContent = "Voice connected";
        renderVoiceParticipants();
        if (voiceContext === "server") {
          Array.from(channelListEl.querySelectorAll(".channel-item")).forEach((el) => {
            el.classList.toggle("in-voice", el.dataset.channelId === descriptor.id);
          });
          pollActiveVoiceRooms();
          setVoiceStageVisible(true);
        } else if (voiceContext === "dm") {
          renderDmVideoStage();
          updateDmCallMediaButtons();
          try { setCallConnecting(false); } catch (e) {}
          try { updateCallOverlayChrome(); } catch (e) {}
          try { scheduleCallStageRender(); } catch (e) {}
          try { updateMuteBadges(); } catch (e) {}
        }
        showToast(`Joined ${voicePreferVideo ? "video" : "voice"}: ${descriptor.name}`, { variant: "accent" });
      } catch (err) {
        console.error(err);
        if (voiceContext === "server") chatConnectionStatusEl.textContent = "Voice error";
        label.textContent = `Couldn't connect: ${err.message || "connection failed"}`;
        setTimeout(() => bar.classList.remove("visible"), 4000);
        showToast(err.message || "Failed to connect to voice", { variant: "danger" });
      }
    }

    function leaveVoiceCleanup() {
      try { stopCallRecording(false); } catch (e) {}
      try { hideCallOverlay(); } catch (e) {}
      try {
        if (dmVideoStage) {
          dmVideoStage.classList.remove("visible");
          dmVideoStage.innerHTML = "";
        }
      } catch (e) {}
      voiceVideoEnabled = false;
      voiceScreenSharing = false;
      voicePreferVideo = false;
      remoteIsRecording = false;
      const wasServerVoice = voiceContext === "server";
      const previousContext = voiceContext;
      try {
        const { bar, participants: participantsEl } = activeVoiceBarEls();
        if (bar) bar.classList.remove("visible");
        if (participantsEl) participantsEl.innerHTML = "";
      } catch (err) {
        console.error(err);
      }
      voiceRoom = null;
      voiceChannelId = null;
      voiceMuted = false;
      try {
        getVoiceAudioContainer().innerHTML = "";
      } catch (err) {}
      try {
        Array.from(channelListEl.querySelectorAll(".channel-item")).forEach((el) => {
          el.classList.remove("in-voice");
        });
      } catch (err) {}
      if (wasServerVoice && chatConnectionStatusEl && chatConnectionStatusEl.textContent.startsWith("Voice")) {
        chatConnectionStatusEl.textContent = "Ready";
      }
      voiceContext = null;
      activeDmCallId = null;
      activeDmCallStartedAt = null;
      dmCallParticipants = [];
      try {
        unsubscribeDmCallRealtime();
      } catch (err) {}
      try {
        hideDmCallBar();
      } catch (err) {}
      if (wasServerVoice || previousContext === "server") {
        try {
          pollActiveVoiceRooms();
        } catch (err) {}
        try {
          setVoiceStageVisible(false);
          voiceStageGrid.innerHTML = "";
        } catch (err) {}
      }
    }

    async function disconnectVoice() {
      voiceConnectGeneration++;
      const wasDm = voiceContext === "dm";
      const callId = activeDmCallId;
      const room = voiceRoom;
      voiceRoom = null;
      activeDmCallId = null;
      try {
        if (room) {
          try {
            await room.localParticipant.setCameraEnabled(false);
          } catch (e) {}
          try {
            await room.localParticipant.setScreenShareEnabled(false);
          } catch (e) {}
          try {
            await room.localParticipant.setMicrophoneEnabled(false);
          } catch (e) {}
          try {
            await room.disconnect(true);
          } catch (err) {
            console.error(err);
            try { room.disconnect(); } catch (e2) {}
          }
        }
      } catch (err) {
        console.error("disconnectVoice room teardown", err);
      }
      leaveVoiceCleanup();
      if (wasDm && callId) {
        try {
          await apiFetch(`/api/voice-calls/${callId}/leave`, { method: "POST" });
        } catch (err) {
          console.error(err);
        }
        try {
          updateDmCallButton();
        } catch (err) {
          console.error(err);
        }
      }
      try { hideDmCallBar(); } catch (e) {}
      try { renderDmCallBar(); } catch (e) {}
    }

    function toggleVoiceMute() {
      if (!voiceRoom) return;
      voiceMuted = !voiceMuted;
      voiceRoom.localParticipant.setMicrophoneEnabled(!voiceMuted);
      const { muteButton } = activeVoiceBarEls();
      setMuteButtonIcon(muteButton, voiceMuted);
      muteButton.classList.toggle("active", voiceMuted);
      showToast(voiceMuted ? "Microphone muted" : "Microphone unmuted", { duration: 1500 });
    }

    async function toggleVoiceChannel(channel) {
      if (voiceRoom && voiceChannelId === channel.id) {
        await disconnectVoice();
        return;
      }
      if (voiceRoom && voiceChannelId !== channel.id) {
        await disconnectVoice();
      }
      await connectVoice(channel, "server");
    }

    async function updateDmCallButton() {
      if (!currentDmConversationId) {
        if (dmCallButton) dmCallButton.style.display = "none";
        if (dmVideoCallButton) dmVideoCallButton.style.display = "none";
        return;
      }
      if (dmCallButton) dmCallButton.style.display = "inline-flex";
      if (dmVideoCallButton) dmVideoCallButton.style.display = "inline-flex";
      if (voiceRoom && voiceContext === "dm" && activeDmCallId) {
        const remoteCount = voiceRoom.remoteParticipants ? voiceRoom.remoteParticipants.size : 0;
        const alone = remoteCount === 0 && (dmCallParticipants.length <= 1);
        const label = alone ? "End call" : "Leave call";
        dmCallButton.innerHTML = `${uiIcon("phone", 14)} ${label}`;
        if (dmVideoCallButton) dmVideoCallButton.style.display = "none";
        return;
      }
      try {
        const { call } = await apiFetch(`/api/dms/${currentDmConversationId}/call`);
        dmCallButton.innerHTML = `${uiIcon("phone", 14)} ${call ? "Join call" : "Call"}`;
        if (dmVideoCallButton) dmVideoCallButton.innerHTML = call ? "Join video" : "Video";
      } catch (err) {
        console.error(err);
        dmCallButton.innerHTML = `${uiIcon("phone", 14)} Call`;
        if (dmVideoCallButton) dmVideoCallButton.innerHTML = "Video";
      }
    }


    let remoteIsRecording = false;
    let remoteRecordingUsername = null;
    let callLayoutMode = "gallery"; // focus | gallery
    let callFocusIdentity = "auto";
    let stickySpeakerId = null;
    let stickySpeakerUntil = 0;

    function callEls() {
      return {
        overlay: document.getElementById("call-overlay"),
        title: document.getElementById("call-overlay-title"),
        sub: document.getElementById("call-overlay-sub"),
        mainVideo: document.getElementById("call-main-video"),
        mainPlaceholder: document.getElementById("call-main-placeholder"),
        mainAvatar: document.getElementById("call-main-avatar"),
        mainName: document.getElementById("call-main-name"),
        grid: document.getElementById("call-grid"),
        pip: document.getElementById("call-pip"),
        pipVideo: document.getElementById("call-pip-video"),
        pipLabel: document.getElementById("call-pip-label"),
        pipAvatar: document.getElementById("call-pip-avatar"),
        banner: document.getElementById("call-recording-banner"),
        focusSelect: document.getElementById("call-focus-select"),
      };
    }




    let _callStageRenderTimer = null;
    function scheduleCallStageRender() {
      if (_callStageRenderTimer) clearTimeout(_callStageRenderTimer);
      _callStageRenderTimer = setTimeout(() => {
        _callStageRenderTimer = null;
        try { renderCallOverlayStage(); } catch (e) {}
      }, 80);
    }

    function updateSpeakingIndicators() {
      if (!voiceRoom) return;
      const speakingIds = new Set((voiceRoom.activeSpeakers || []).map((p) => p.identity));
      document.querySelectorAll(".call-grid-tile[data-identity]").forEach((tile) => {
        tile.classList.toggle("speaking", speakingIds.has(tile.dataset.identity));
      });
      const focusId = callFocusIdentity && callFocusIdentity !== "auto"
        ? callFocusIdentity
        : null;
      let ringId = focusId;
      if (!ringId) {
        const remote = (voiceRoom.activeSpeakers || []).find(
          (p) => p.identity !== voiceRoom.localParticipant.identity
        );
        ringId = remote ? remote.identity : ((voiceRoom.activeSpeakers || [])[0] || {}).identity;
      }
      const mainVid = document.getElementById("call-main-video");
      const mainPh = document.getElementById("call-main-placeholder");
      const speaking = !!(ringId && speakingIds.has(ringId));
      if (mainVid) mainVid.classList.toggle("speaking-ring", speaking && mainVid.style.display !== "none");
      if (mainPh) mainPh.classList.toggle("speaking-ring", speaking && mainPh.style.display !== "none");
    }

    function isParticipantMicMuted(participant) {
      if (!participant) return false;
      try {
        if (participant.isMicrophoneEnabled === false) return true;
      } catch (e) {}
      try {
        const pubs = participant.audioTrackPublications
          ? Array.from(participant.audioTrackPublications.values())
          : [];
        if (pubs.length) {
          return pubs.some((p) => p.isMuted || !p.track);
        }
      } catch (e) {}
      return false;
    }

    function ensureMuteBadge(el, muted) {
      if (!el) return;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") {
        const existing = el.querySelector(":scope > .call-mute-badge");
        if (existing) existing.remove();
        return;
      }
      let badge = null;
      for (const child of el.children) {
        if (child.classList && child.classList.contains("call-mute-badge")) {
          badge = child;
          break;
        }
      }
      if (muted) {
        if (!badge) {
          badge = document.createElement("div");
          badge.className = "call-mute-badge";
          badge.title = "Muted";
          badge.innerHTML = uiIcon("mic-off", 14);
          const pos = style.position;
          if (pos === "static" || !pos) el.style.position = "relative";
          el.appendChild(badge);
        }
      } else if (badge) {
        badge.remove();
      }
    }

    function updateMuteBadges() {
      if (!voiceRoom) return;
      const all = [voiceRoom.localParticipant, ...Array.from(voiceRoom.remoteParticipants.values())];
      const mutedById = {};
      all.forEach((p) => {
        mutedById[p.identity] = isParticipantMicMuted(p);
      });

      document.querySelectorAll("[data-identity]").forEach((el) => {
        if (el.classList && (el.classList.contains("call-grid-tile-label") || el.classList.contains("call-pip-label"))) return;
        const id = el.dataset.identity;
        if (!id || !(id in mutedById)) return;
        ensureMuteBadge(el, mutedById[id]);
      });

      const mainVid = document.getElementById("call-main-video");
      const mainPh = document.getElementById("call-main-placeholder");
      const stage = document.getElementById("call-overlay-stage");
      const mainId =
        (mainPh && mainPh.dataset.identity) ||
        (stage && stage.dataset.mainIdentity) ||
        null;
      if (mainId && mainId in mutedById) {
        const mainVisible =
          mainVid && mainVid.style.display !== "none"
            ? mainVid
            : mainPh && mainPh.style.display !== "none"
              ? mainPh
              : stage;
        if (stage) {
          stage.dataset.mainIdentity = mainId;
          let host = document.getElementById("call-main-mute-host");
          if (!host) {
            host = document.createElement("div");
            host.id = "call-main-mute-host";
            host.style.cssText =
              "position:absolute;top:14px;right:14px;z-index:12;width:32px;height:32px;pointer-events:none;";
            stage.appendChild(host);
          }
          host.dataset.identity = mainId;
          host.innerHTML = "";
          if (mutedById[mainId]) {
            const badge = document.createElement("div");
            badge.className = "call-mute-badge";
            badge.title = "Muted";
            badge.innerHTML = uiIcon("mic-off", 14);
            badge.style.position = "static";
            host.appendChild(badge);
          }
        }
        ensureMuteBadge(mainVisible, mutedById[mainId]);
      }

      const pip = document.getElementById("call-pip");
      if (pip && pip.dataset.identity && pip.style.display !== "none") {
        ensureMuteBadge(pip, !!mutedById[pip.dataset.identity]);
      }
    }

    function setCallConnecting(visible, title, sub) {
      const el = document.getElementById("call-connecting");
      const t = document.getElementById("call-connecting-text");
      const s = document.getElementById("call-connecting-sub");
      if (!el) return;
      el.classList.toggle("visible", !!visible);
      if (t && title) t.textContent = title;
      if (s && sub) s.textContent = sub;
    }

    function showCallOverlay(force) {
      if (!force && !voicePreferVideo && !voiceVideoEnabled && !voiceScreenSharing) {
        try { hideCallOverlay(); } catch (e) {}
        try { renderDmCallBar(); } catch (e) {}
        return;
      }
      const c = callEls();
      if (!c.overlay) {
        console.error("call-overlay element missing from DOM");
        return;
      }
      c.overlay.classList.add("visible");
      c.overlay.setAttribute("aria-hidden", "false");
      c.overlay.style.cssText =
        "display:flex!important;position:fixed!important;inset:0!important;z-index:99999!important;flex-direction:column;background:#07080c;color:#f5f6f8;";
      document.body.classList.add("in-call-overlay");
      try {
        const dmModal = document.getElementById("dm-modal");
        if (dmModal) dmModal.classList.remove("visible");
      } catch (e) {}
      updateCallOverlayChrome();
      if (!voiceRoom) {
        setCallConnecting(true, "Connecting…", "Setting up your call");
      } else if (voiceRoom.remoteParticipants.size === 0) {
        setCallConnecting(false);
      } else {
        setCallConnecting(false);
      }
      renderCallOverlayStage();
      updateCallOverlayControls();
      refreshCallFocusOptions();
      updateSpeakingIndicators();
      updateMuteBadges();
    }

    function hideCallOverlay() {
      const c = callEls();
      if (!c.overlay) return;
      c.overlay.classList.remove("visible");
      c.overlay.setAttribute("aria-hidden", "true");
      c.overlay.style.cssText = "";
      document.body.classList.remove("in-call-overlay");
      try { setCallConnecting(false); } catch (e) {}
      try {
        const ctrls = document.getElementById("call-overlay-controls");
        if (ctrls) ctrls.classList.remove("bar-hidden");
        const pip = document.getElementById("call-pip");
        if (pip) pip.classList.remove("pip-hidden");
      } catch (e) {}
      if (c.mainVideo) {
        try { c.mainVideo.srcObject = null; } catch (e) {}
        c.mainVideo.style.display = "none";
      }
      if (c.pipVideo) {
        try { c.pipVideo.srcObject = null; } catch (e) {}
      }
      if (c.grid) c.grid.innerHTML = "";
      if (c.pip) c.pip.style.display = "none";
      if (c.banner) c.banner.classList.remove("visible");
      remoteIsRecording = false;
      remoteRecordingUsername = null;
      callLayoutMode = "gallery";
      callFocusIdentity = "auto";
      stickySpeakerId = null;
      stickySpeakerUntil = 0;
    }

    function updateCallOverlayChrome() {
      const c = callEls();
      if (!c.title) return;
      const name = currentDmOtherUser ? currentDmOtherUser.username : "Call";
      const kind = voicePreferVideo || voiceVideoEnabled || voiceScreenSharing ? "Video call" : "Voice call";
      c.title.textContent = `${kind} · ${name}`;
      if (c.sub) {
        if (!voiceRoom) {
          c.sub.textContent = `Calling ${name}…`;
        } else if (voiceRoom.remoteParticipants.size === 0) {
          c.sub.textContent = `Waiting for ${name} to join…`;
        } else {
          const n = 1 + voiceRoom.remoteParticipants.size;
          c.sub.textContent = `${n} in call`;
        }
      }
      if (c.mainName) c.mainName.textContent = name;
      if (c.mainAvatar) {
        const profile = currentDmOtherUser || (currentProfile && voiceRoom && voiceRoom.remoteParticipants.size === 0 ? currentDmOtherUser : null);
        if (currentDmOtherUser) c.mainAvatar.innerHTML = avatarHTML(currentDmOtherUser);
        else if (currentProfile) c.mainAvatar.innerHTML = avatarHTML(currentProfile);
      }
    }

    function updateCallOverlayControls() {
      const muteBtn = document.getElementById("call-ctrl-mute");
      const camBtn = document.getElementById("call-ctrl-cam");
      const shareBtn = document.getElementById("call-ctrl-share");
      const recBtn = document.getElementById("call-ctrl-record");
      const leaveBtn = document.getElementById("call-ctrl-leave");
      const c = callEls();
      const isVideoCall = !!(voicePreferVideo || voiceVideoEnabled || voiceScreenSharing);
      if (muteBtn) {
        muteBtn.classList.toggle("active", !!voiceMuted);
        muteBtn.textContent = voiceMuted ? "Unmute" : "Mute";
      }
      if (camBtn) {
        camBtn.style.display = isVideoCall ? "" : "none";
        camBtn.classList.toggle("active", !!voiceVideoEnabled);
        camBtn.textContent = voiceVideoEnabled ? "Cam on" : "Camera";
      }
      if (shareBtn) {
        shareBtn.style.display = isVideoCall ? "" : "none";
        shareBtn.classList.toggle("active", !!voiceScreenSharing);
        shareBtn.textContent = voiceScreenSharing ? "Sharing" : "Share";
      }
      if (recBtn) {
        const rec = !!callRecorder;
        recBtn.classList.toggle("recording", rec);
        recBtn.textContent = rec ? "Stop" : "Record";
      }
      if (leaveBtn && voiceRoom) {
        const alone = voiceRoom.remoteParticipants.size === 0;
        leaveBtn.textContent = alone ? "End" : "Leave";
        leaveBtn.title = alone ? "End call" : "Leave call";
      }
      const layoutCtrls = document.getElementById("call-layout-controls");
      const focusSel = document.getElementById("call-focus-select");
      if (layoutCtrls) layoutCtrls.style.display = isVideoCall ? "" : "none";
      if (focusSel) focusSel.style.display = isVideoCall ? "" : "none";
      if (c.banner) {
        const show = !!callRecorder || remoteIsRecording;
        c.banner.classList.toggle("visible", show);
        if (show) {
          const who = callRecorder
            ? "You are recording this call"
            : `${remoteRecordingUsername || "Someone"} is recording this call`;
          c.banner.innerHTML = `<span class="call-recording-dot"></span> ${who}`;
        }
      }
      document.querySelectorAll(".call-layout-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.layout === callLayoutMode);
      });
    }

    function refreshCallFocusOptions() {
      const c = callEls();
      if (!c.focusSelect || !voiceRoom) return;
      const prev = callFocusIdentity;
      c.focusSelect.innerHTML = `<option value="auto">Default view</option>`;
      const participants = [voiceRoom.localParticipant, ...Array.from(voiceRoom.remoteParticipants.values())];
      participants.forEach((p) => {
        const isLocal = p.identity === voiceRoom.localParticipant.identity;
        const profile = resolveVoiceProfile(p.identity, isLocal);
        const name = profile ? profile.username : isLocal ? "You" : "User";
        const opt = document.createElement("option");
        opt.value = p.identity;
        opt.textContent = isLocal ? `${name} (you)` : name;
        c.focusSelect.appendChild(opt);
      });
      if ([...c.focusSelect.options].some((o) => o.value === prev)) c.focusSelect.value = prev;
      else {
        c.focusSelect.value = "auto";
        callFocusIdentity = "auto";
      }
    }

    function collectVideoTracks() {
      if (!voiceRoom) return { screens: [], cameras: [], people: [] };
      const screens = [];
      const cameras = [];
      const people = [];
      const pushFrom = (p) => {
        const isLocal = p.identity === voiceRoom.localParticipant.identity;
        const profile = resolveVoiceProfile(p.identity, isLocal);
        const name = profile ? profile.username : isLocal ? "You" : "User";
        const person = { identity: p.identity, isLocal, name, profile, camera: null, screen: null, hasCam: false };
        const pubs = p.videoTrackPublications
          ? Array.from(p.videoTrackPublications.values())
          : [];
        pubs.forEach((pub) => {
          const track = pub.track;
          if (!track || track.isMuted) return;
          const src = pub.source;
          const isScreen =
            src === 2 ||
            src === "screen_share" ||
            src === "screen_share_audio" ||
            (typeof src === "string" && src.toLowerCase().includes("screen"));
          const entry = { track, isLocal, identity: p.identity, name, isScreen, profile };
          if (isScreen) {
            screens.push(entry);
            person.screen = entry;
          } else {
            cameras.push(entry);
            person.camera = entry;
            person.hasCam = true;
          }
        });
        people.push(person);
      };
      pushFrom(voiceRoom.localParticipant);
      voiceRoom.remoteParticipants.forEach(pushFrom);
      return { screens, cameras, people };
    }

    function attachTrackToVideoEl(track, videoEl, muted) {
      if (!videoEl || !track) return;
      const mst = track.mediaStreamTrack;
      const already =
        videoEl.srcObject &&
        mst &&
        videoEl.srcObject.getTracks &&
        videoEl.srcObject.getTracks().some((t) => t.id === mst.id);
      if (!already) {
        try {
          track.detach(videoEl);
        } catch (e) {}
        track.attach(videoEl);
      }
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      videoEl.muted = !!muted;
      try {
        videoEl.play().catch(() => {});
      } catch (e) {}
    }

    function renderAvatarTile(container, person, extraClass) {
      const tile = document.createElement("div");
      tile.className = "call-grid-tile call-avatar-tile" + (extraClass ? " " + extraClass : "");
      tile.dataset.identity = person.identity;
      tile.style.display = "flex";
      tile.style.alignItems = "center";
      tile.style.justifyContent = "center";
      const av = document.createElement("div");
      av.className = "call-tile-avatar";
      const prof = person.profile || (person.isLocal ? currentProfile : currentDmOtherUser);
      av.innerHTML = prof
        ? avatarHTML(prof)
        : `<div class="call-tile-initials">${(person.name || "?")[0]}</div>`;
      tile.appendChild(av);
      const label = document.createElement("div");
      label.className = "call-grid-tile-label";
      label.textContent = person.name + (person.isLocal ? " (you)" : "");
      tile.appendChild(label);
      container.appendChild(tile);
      return tile;
    }

    function renderCallOverlayStage() {
      const c = callEls();
      if (!c.overlay || !c.overlay.classList.contains("visible")) return;
      c.overlay.classList.toggle("focus-mode", callLayoutMode === "focus");
      c.overlay.classList.toggle("gallery-mode", callLayoutMode === "gallery");
      const eyes = document.getElementById("call-eye-toggles");
      if (eyes) eyes.style.display = callLayoutMode === "focus" ? "flex" : "none";
      updateCallOverlayChrome();
      if (!voiceRoom) return;

      const { screens, cameras, people } = collectVideoTracks();
      refreshCallFocusOptions();

      if (screens.length && callLayoutMode === "focus") {
        if (c.grid) c.grid.style.display = "none";
        const main = screens[0];
        if (c.mainVideo) {
          c.mainVideo.style.display = "block";
          attachTrackToVideoEl(main.track, c.mainVideo, main.isLocal);
        }
        if (c.mainPlaceholder) c.mainPlaceholder.style.display = "none";

        let pipPerson = null;
        if (callFocusIdentity !== "auto") {
          pipPerson = people.find((p) => p.identity === callFocusIdentity) || null;
        }
        if (!pipPerson) {
          pipPerson =
            people.find((p) => !p.isLocal && p.hasCam) ||
            people.find((p) => !p.isLocal) ||
            people.find((p) => p.isLocal) ||
            null;
        }
        if (pipPerson && c.pip) {
          c.pip.style.display = "block";
          c.pip.dataset.identity = pipPerson.identity;
          if (pipPerson.hasCam && pipPerson.camera && c.pipVideo) {
            c.pipVideo.style.display = "block";
            if (c.pipAvatar) c.pipAvatar.style.display = "none";
            attachTrackToVideoEl(pipPerson.camera.track, c.pipVideo, true);
          } else {
            if (c.pipVideo) {
              c.pipVideo.style.display = "none";
              try { c.pipVideo.srcObject = null; } catch (e) {}
            }
            if (c.pipAvatar) {
              c.pipAvatar.style.display = "flex";
              c.pipAvatar.innerHTML = pipPerson.profile
                ? avatarHTML(pipPerson.profile)
                : `<div class="call-tile-initials">${(pipPerson.name || "?")[0]}</div>`;
            }
          }
          if (c.pipLabel) c.pipLabel.textContent = pipPerson.name + (pipPerson.isLocal ? " (you)" : "");
        } else if (c.pip) {
          c.pip.style.display = "none";
        }
        updateSpeakingIndicators();
        updateMuteBadges();
        return;
      }

      if (c.pip) c.pip.style.display = "none";

      if (callLayoutMode === "gallery" && c.grid) {
        if (c.mainVideo) {
          c.mainVideo.style.display = "none";
          try { c.mainVideo.srcObject = null; } catch (e) {}
        }
        if (c.mainPlaceholder) c.mainPlaceholder.style.display = "none";
        c.grid.style.display = "grid";
        c.grid.classList.toggle("single-participant", people.length <= 1 && screens.length === 0);
        c.grid.innerHTML = "";
        const speakingIds = new Set((voiceRoom.activeSpeakers || []).map((p) => p.identity));
        const list = people.slice();
        list.forEach((person) => {
          const speaking = speakingIds.has(person.identity);
          if (person.hasCam && person.camera) {
            const tile = document.createElement("div");
            tile.className = "call-grid-tile" + (speaking ? " speaking" : "");
            tile.dataset.identity = person.identity;
            const v = document.createElement("video");
            v.autoplay = true;
            v.playsInline = true;
            v.muted = person.isLocal;
            tile.appendChild(v);
            const label = document.createElement("div");
            label.className = "call-grid-tile-label";
            label.textContent = person.name + (person.isLocal ? " (you)" : "");
            tile.appendChild(label);
            c.grid.appendChild(tile);
            attachTrackToVideoEl(person.camera.track, v, person.isLocal);
          } else {
            const tile = renderAvatarTile(c.grid, person, speaking ? "speaking" : "");
            if (tile && speaking) tile.classList.add("speaking");
          }
        });
        screens.forEach((s) => {
          const tile = document.createElement("div");
          tile.className = "call-grid-tile";
          tile.dataset.identity = s.identity;
          const v = document.createElement("video");
          v.autoplay = true;
          v.playsInline = true;
          v.muted = s.isLocal;
          tile.appendChild(v);
          const label = document.createElement("div");
          label.className = "call-grid-tile-label";
          label.textContent = s.name + " (screen)";
          tile.appendChild(label);
          c.grid.appendChild(tile);
          attachTrackToVideoEl(s.track, v, s.isLocal);
        });
        updateSpeakingIndicators();
        updateMuteBadges();
        return;
      }

      if (c.grid) c.grid.style.display = "none";

      const self = people.find((p) => p.isLocal) || null;
      const remote = people.find((p) => !p.isLocal) || null;
      let mainPerson =
        callFocusIdentity && callFocusIdentity !== "auto"
          ? people.find((p) => p.identity === callFocusIdentity)
          : null;
      if (!mainPerson) mainPerson = remote || self;
      const pipPerson =
        mainPerson && self && mainPerson.identity === self.identity
          ? remote
          : self;

      if (mainPerson && mainPerson.hasCam && mainPerson.camera) {
        if (c.mainPlaceholder) c.mainPlaceholder.style.display = "none";
        if (c.mainVideo) {
          c.mainVideo.style.display = "block";
          attachTrackToVideoEl(mainPerson.camera.track, c.mainVideo, !!mainPerson.isLocal);
        }
        if (c.mainPlaceholder) c.mainPlaceholder.dataset.identity = mainPerson.identity;
        const stageEl = document.getElementById("call-overlay-stage");
        if (stageEl) stageEl.dataset.mainIdentity = mainPerson.identity;
      } else {
        if (c.mainVideo) {
          c.mainVideo.style.display = "none";
          try { c.mainVideo.srcObject = null; } catch (e) {}
        }
        if (c.mainPlaceholder) {
          c.mainPlaceholder.style.display = "flex";
          if (mainPerson) {
            c.mainPlaceholder.dataset.identity = mainPerson.identity;
            const stageEl = document.getElementById("call-overlay-stage");
            if (stageEl) stageEl.dataset.mainIdentity = mainPerson.identity;
            if (c.mainName) {
              c.mainName.textContent =
                mainPerson.name + (mainPerson.isLocal ? " (you)" : "");
            }
            if (c.mainAvatar) {
              const prof =
                mainPerson.profile ||
                (mainPerson.isLocal ? currentProfile : currentDmOtherUser);
              c.mainAvatar.innerHTML = prof
                ? avatarHTML(prof)
                : `<div class="call-tile-initials">${(mainPerson.name || "?")[0]}</div>`;
            }
          }
        }
      }

      if (pipPerson && c.pip) {
        c.pip.style.cssText =
          "display:block;position:absolute;right:16px;bottom:16px;left:auto;top:auto;width:min(200px,28vw);aspect-ratio:16/10;border-radius:12px;overflow:hidden;z-index:6;background:#16181f;border:2px solid rgba(255,255,255,0.18);";
        c.pip.dataset.identity = pipPerson.identity;
        if (pipPerson.hasCam && pipPerson.camera && c.pipVideo) {
          c.pipVideo.style.display = "block";
          if (c.pipAvatar) c.pipAvatar.style.display = "none";
          attachTrackToVideoEl(pipPerson.camera.track, c.pipVideo, true);
        } else {
          if (c.pipVideo) {
            c.pipVideo.style.display = "none";
            try { c.pipVideo.srcObject = null; } catch (e) {}
          }
          if (c.pipAvatar) {
            c.pipAvatar.style.display = "flex";
            const prof =
              pipPerson.profile ||
              (pipPerson.isLocal ? currentProfile : currentDmOtherUser);
            c.pipAvatar.innerHTML = prof
              ? avatarHTML(prof)
              : `<div class="call-tile-initials">${(pipPerson.name || "?")[0]}</div>`;
          }
        }
        if (c.pipLabel) {
          c.pipLabel.textContent =
            pipPerson.name + (pipPerson.isLocal ? " (you)" : "");
        }
      } else if (c.pip) {
        c.pip.style.display = "none";
      }

      updateSpeakingIndicators();
      updateMuteBadges();
    }

    function broadcastCallData(payload) {
      if (!voiceRoom) return;
      try {
        const data = new TextEncoder().encode(JSON.stringify(payload));
        voiceRoom.localParticipant.publishData(data, { reliable: true });
      } catch (err) {
        console.error("publishData failed", err);
      }
    }

    function handleIncomingCallData(payload, participant) {
      if (!payload || !payload.type) return;
      if (payload.type === "recording_started") {
        remoteIsRecording = true;
        const who = participant?.identity
          ? resolveVoiceProfile(participant.identity, false)?.username || "Someone"
          : "Someone";
        remoteRecordingUsername = who;
        showToast(`${who} started recording this call`, { variant: "danger", duration: 4000 });
        updateCallOverlayControls();
      } else if (payload.type === "recording_stopped") {
        remoteIsRecording = false;
        remoteRecordingUsername = null;
        updateCallOverlayControls();
      }
    }

    async function startOrJoinDmCall(withVideo) {
      if (!currentDmConversationId) return;

      if (voiceRoom && voiceContext === "dm" && activeDmCallId) {
        await disconnectVoice();
        return;
      }

      if (voiceRoom) {
        await disconnectVoice();
      }

      voicePreferVideo = !!withVideo;

      if (withVideo) {
        try {
          showCallOverlay(true);
          const nm = currentDmOtherUser ? currentDmOtherUser.username : "them";
          setCallConnecting(true, "Connecting…", `Calling ${nm}`);
        } catch (e) {}
      }

      try {
        let call;
        const { call: existingCall } = await apiFetch(`/api/dms/${currentDmConversationId}/call`);
        if (existingCall) {
          const { call: joined } = await apiFetch(`/api/voice-calls/${existingCall.id}/join`, {
            method: "POST",
            body: JSON.stringify({ video: !!withVideo }),
          });
          call = joined;
        } else {
          const { call: started } = await apiFetch(`/api/dms/${currentDmConversationId}/call/start`, {
            method: "POST",
            body: JSON.stringify({ is_video: !!withVideo }),
          });
          call = started;
        }
        activeDmCallId = call.id;
        activeDmCallStartedAt = Date.now();
        dmCallParticipants = Array.isArray(call.participants) ? call.participants : [];
        const name = currentDmOtherUser ? currentDmOtherUser.username : "call";
        await connectVoice({ id: call.id, name }, "dm");
        subscribeDmCallRealtime(currentDmConversationId);
        updateDmCallButton();
        renderDmCallBar();
        if (withVideo) showCallOverlay(true);
        else {
          try { hideCallOverlay(); } catch (e) {}
          try { renderDmCallBar(); } catch (e) {}
        }
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to start/join call", { variant: "danger" });
        try { hideCallOverlay(); } catch (e) {}
      }
    }

    async function handleDmCallButtonClick() {
      await startOrJoinDmCall(false);
    }

    async function handleDmVideoCallButtonClick() {
      await startOrJoinDmCall(true);
    }

    function unsubscribeDmCallRealtime() {
      if (dmCallRealtimeChannel && supabaseClient) {
        supabaseClient.removeChannel(dmCallRealtimeChannel);
      }
      dmCallRealtimeChannel = null;
    }

    function subscribeDmCallRealtime(conversationId) {
      unsubscribeDmCallRealtime();
      if (!supabaseClient || !conversationId) return;
      dmCallRealtimeChannel = supabaseClient
        .channel(`voice:dm:${conversationId}`, { config: { private: true } })
        .on("broadcast", { event: "*" }, (msg) => {
          const { operation, record } = msg.payload || {};
          if (!record || !activeDmCallId || record.id !== activeDmCallId) return;

          if (operation === "DELETE") {

            if (voiceRoom) {
              showToast("Call ended", { duration: 2000 });
              disconnectVoice();
            }
            return;
          }

          dmCallParticipants = Array.isArray(record.participants) ? record.participants : [];
          renderDmCallBar();
          updateDmCallButton();
        })
        .subscribe((status, err) => logRealtimeStatus(`dm-call:${conversationId}`, status, err));
    }

    async function renderDmCallBar() {
      if (voiceContext !== "dm" || !voiceRoom || !activeDmCallId) {
        hideDmCallBar();
        return;
      }
      if (!dmCallBarEl) {
        dmCallBarEl = document.createElement("div");
        dmCallBarEl.className = "dm-call-bar";
        const stack = getTopRightAlertStack();
        const incoming = stack.querySelector(".incoming-call-popup");
        if (incoming && incoming.nextSibling) stack.insertBefore(dmCallBarEl, incoming.nextSibling);
        else if (incoming) stack.appendChild(dmCallBarEl);
        else stack.insertBefore(dmCallBarEl, stack.firstChild);
      }

      const otherParticipants = dmCallParticipants.filter((p) => p.user_id !== currentUser.id);
      const names = (
        await Promise.all(otherParticipants.map((p) => resolveProfile(p.user_id)))
      ).map((p) => (p ? p.username : "Unknown"));
      const namesText = names.length ? names.join(", ") : "Waiting for others to join...";
      const remoteN = voiceRoom && voiceRoom.remoteParticipants ? voiceRoom.remoteParticipants.size : Math.max(0, dmCallParticipants.length - 1);
      const isAlone = remoteN === 0;

      dmCallBarEl.innerHTML = `
        <div class="dm-call-bar-info">
          <div class="dm-call-bar-title">${uiIcon("volume", 14)} On a call</div>
          <div class="dm-call-bar-names">${escapeHtml(namesText)}</div>
        </div>
        <div class="dm-call-bar-actions">
          <button class="dm-call-bar-button dm-call-bar-mute${voiceMuted ? " active" : ""}" title="${voiceMuted ? "Unmute" : "Mute"}">${uiIcon(voiceMuted ? "mic-off" : "mic", 16)}</button>
          <button class="dm-call-bar-button dm-call-bar-leave">${isAlone ? "End" : "Leave"}</button>
        </div>
      `;

      dmCallBarEl.querySelector(".dm-call-bar-info").addEventListener("click", () => {
        if (voiceRoom && voiceContext === "dm") {
          if (voicePreferVideo || voiceVideoEnabled || voiceScreenSharing) {
            showCallOverlay(true);
          } else {
            handleOpenDmModal();
            if (currentDmOtherUser) openDmConversation(currentDmConversationId, currentDmOtherUser);
          }
          return;
        }
        handleOpenDmModal();
        if (currentDmOtherUser) openDmConversation(currentDmConversationId, currentDmOtherUser);
      });
      dmCallBarEl.querySelector(".dm-call-bar-mute").addEventListener("click", () => {
        toggleVoiceMute();
        renderDmCallBar();
      });
      dmCallBarEl.querySelector(".dm-call-bar-leave").addEventListener("click", () => {
        disconnectVoice();
      });
    }

    function hideDmCallBar() {
      if (dmCallBarEl) {
        dmCallBarEl.remove();
        dmCallBarEl = null;
      }
    }

    function switchSettingsTab(tab) {
      document.querySelectorAll(".settings-nav-item").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.settingsTab === tab);
      });
      document.querySelectorAll(".settings-panel").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.settingsPanel === tab);
      });
      if (tab === "notifications") {
        loadNotificationSettings().then(() => {
          renderNotificationSettingsModal();
          updatePushStatusUI();
        });
      }
    }

    document.querySelectorAll(".settings-nav-item").forEach((btn) => {
      btn.addEventListener("click", () => switchSettingsTab(btn.dataset.settingsTab));
    });

    async function handleSettingsOpen(tab) {
      if (!currentProfile) return;
      settingsUsername.value = currentProfile.username || "";
      settingsEmail.value = currentUser?.email || "";
      settingsBio.value = currentProfile.bio || "";
      settingsTheme.value = currentProfile.theme || "light";
      pendingSettingsAvatarFile = null;
      settingsAvatar.value = "";
      settingsAvatarPreview.innerHTML = avatarHTML(currentProfile);
      document.getElementById("password-current").value = "";
      document.getElementById("password-new").value = "";
      document.getElementById("password-confirm").value = "";

      const appearance = currentProfile.appearance || {};
      pendingSettingsBackgroundFile = null;
      pendingSettingsBackgroundRemoved = false;
      settingsBackground.value = "";
      settingsBackgroundPreview.innerHTML = currentProfile.background_url
        ? `<img src="${currentProfile.background_url}" alt="">`
        : `<span style="font-size:11px; color:var(--text-tertiary);">None</span>`;
      settingsAccentColor.value = appearance.accent_color || getComputedThemeAccentHex();
      const accent2 = document.getElementById("settings-accent-color-2");
      const accentGrad = document.getElementById("settings-accent-gradient");
      if (accent2) accent2.value = appearance.accent_color_2 || appearance.accent_color || getComputedThemeAccentHex();
      if (accentGrad) accentGrad.checked = !!appearance.accent_gradient;
      try { syncColorPickerMode("accent", !!appearance.accent_gradient); } catch (e) {}
      const bgColor = document.getElementById("settings-bg-color");
      const bgColor2 = document.getElementById("settings-bg-color-2");
      const bgGrad = document.getElementById("settings-bg-gradient");
      if (bgColor) {
        bgColor.value = appearance.bg_color || "#0a0b0e";
        bgColor.dataset.userSet = appearance.bg_color ? "1" : "0";
      }
      if (bgColor2) bgColor2.value = appearance.bg_color_2 || appearance.bg_color || "#1a1c22";
      if (bgGrad) bgGrad.checked = !!appearance.bg_gradient;
      try { syncColorPickerMode("bg", !!appearance.bg_gradient); } catch (e) {}
      settingsTextMode.value = appearance.text_color_mode || "auto";
      settingsCustomTextColor.value = appearance.custom_text_color || "#ffffff";
      settingsCustomTextColorRow.style.display = settingsTextMode.value === "custom" ? "" : "none";
      settingsDensity.value = appearance.density || "comfortable";
      settingsCorners.value = appearance.corner_style || "rounded";

      switchSettingsTab(tab || "general");
      settingsModal.classList.add("visible");
      renderIdentitySection();
    }

    function getComputedThemeAccentHex() {

      const root = document.documentElement;
      const activeOverride = root.style.getPropertyValue("--accent-user");
      if (activeOverride) root.style.removeProperty("--accent-user");
      const raw = getComputedStyle(root).getPropertyValue("--accent").trim();
      if (activeOverride) root.style.setProperty("--accent-user", activeOverride);
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) return raw;

      const probe = document.createElement("div");
      probe.style.color = raw || "#6366f1";
      document.body.appendChild(probe);
      const computed = getComputedStyle(probe).color;
      document.body.removeChild(probe);
      const m = computed.match(/\d+/g);
      if (!m) return "#6366f1";
      const toHex = (n) => Number(n).toString(16).padStart(2, "0");
      return `#${toHex(m[0])}${toHex(m[1])}${toHex(m[2])}`;
    }

    function openSettingsModal(tab) {
      if (settingsModal.classList.contains("visible")) {
        switchSettingsTab(tab || "general");
      } else {
        handleSettingsOpen(tab);
      }
    }

    const OAUTH_PROVIDERS = ["google", "github"];

    async function renderIdentitySection() {
      if (!supabaseClient) return;
      identityBadges.innerHTML = "";
      identityOAuthActions.innerHTML = "";
      identitySetPassword.style.display = "none";

      const { data, error } = await supabaseClient.auth.getUser();
      if (error || !data?.user) return;

      const identities = data.user.identities || [];
      const providers = new Set(identities.map((i) => i.provider));

      identityBadges.innerHTML = Array.from(providers)
        .map((p) => `<span class="identity-badge">${p === "email" ? uiIcon("mail", 12) : uiIcon("link", 12)} ${escapeHtml(p)}</span>`)
        .join("");

      OAUTH_PROVIDERS.forEach((provider) => {
        if (providers.has(provider)) return;
        const btn = document.createElement("button");
        btn.className = "identity-action-button";
        btn.textContent = `Connect ${provider === "google" ? "Google" : "GitHub"}`;
        btn.addEventListener("click", async () => {
          try {

            const { error: linkError } = await supabaseClient.auth.linkIdentity({
              provider,
              options: { redirectTo: getAppBaseUrl() },
            });
            if (linkError) throw linkError;
          } catch (err) {
            console.error(err);
            showToast(err.message || `Failed to connect ${provider}`, { variant: "danger" });
          }
        });
        identityOAuthActions.appendChild(btn);
      });

      if (!providers.has("email")) {
        identitySetPassword.style.display = "block";
      }
    }

    async function handleUpdateEmail() {
      const nextEmail = settingsEmail.value.trim();
      if (!nextEmail || !nextEmail.includes("@")) {
        showToast("Enter a valid email address", { variant: "danger" });
        return;
      }
      if (currentUser && nextEmail === currentUser.email) {
        showToast("That's already your current email", { variant: "danger" });
        return;
      }
      settingsUpdateEmailButton.disabled = true;
      settingsUpdateEmailButton.textContent = "Sending confirmation...";
      try {

        const { error } = await supabaseClient.auth.updateUser(
          { email: nextEmail },
          { emailRedirectTo: getAppBaseUrl() }
        );
        if (error) throw error;
        showToast(`Confirmation link sent to ${nextEmail} — click it to finish the change`, { variant: "accent" });
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to update email", { variant: "danger" });
      } finally {
        settingsUpdateEmailButton.disabled = false;
        settingsUpdateEmailButton.textContent = "Update Email";
      }
    }

    async function handleSetPassword() {
      const next = identityNewPassword.value;
      const confirm = identityConfirmPassword.value;
      if (!next || next.length < 8) {
        showToast("Password must be at least 8 characters", { variant: "danger" });
        return;
      }
      if (next !== confirm) {
        showToast("Passwords don't match", { variant: "danger" });
        return;
      }
      try {

        const { error } = await supabaseClient.auth.updateUser({ password: next });
        if (error) throw error;
        identityNewPassword.value = "";
        identityConfirmPassword.value = "";
        showToast("Password set — you can now sign in with email + password too", { variant: "accent" });
        await renderIdentitySection();
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to set password", { variant: "danger" });
      }
    }

    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Failed to read the selected file"));
        reader.readAsDataURL(file);
      });
    }

    async function uploadAvatarFile(file) {
      if (file.size > 5 * 1024 * 1024) {
        throw new Error("Image must be under 5MB");
      }
      const dataUrl = await fileToDataUrl(file);
      const { url } = await apiFetch("/api/profile/avatar", {
        method: "POST",
        body: JSON.stringify({ dataUrl }),
      });
      return url;
    }

    function pendingAvatarKey(email) {
      return `pendingAvatar:${(email || "").trim().toLowerCase()}`;
    }

    function stashPendingAvatar(email, dataUrl) {
      try {
        localStorage.setItem(pendingAvatarKey(email), JSON.stringify({ dataUrl, savedAt: Date.now() }));
      } catch (err) {
        console.error("Failed to stash pending avatar", err);
      }
    }

    function readPendingAvatar(email) {
      try {
        const raw = localStorage.getItem(pendingAvatarKey(email));
        if (!raw) return null;
        const parsed = JSON.parse(raw);

        if (!parsed.savedAt || Date.now() - parsed.savedAt > 7 * 24 * 60 * 60 * 1000) {
          localStorage.removeItem(pendingAvatarKey(email));
          return null;
        }
        return parsed.dataUrl || null;
      } catch (err) {
        return null;
      }
    }

    function clearPendingAvatar(email) {
      try {
        localStorage.removeItem(pendingAvatarKey(email));
      } catch (err) {}
    }

    async function tryApplyPendingAvatar() {
      if (!currentUser || !currentProfile || currentProfile.avatar_url) return;
      const dataUrl = readPendingAvatar(currentUser.email);
      if (!dataUrl) return;
      try {
        const { url } = await apiFetch("/api/profile/avatar", {
          method: "POST",
          body: JSON.stringify({ dataUrl }),
        });
        await apiFetch("/api/profile", {
          method: "PUT",
          body: JSON.stringify({ avatar_url: url }),
        });
        clearPendingAvatar(currentUser.email);
        showToast("Applied the profile picture from signup", { variant: "accent" });
        await loadCurrentUser();
      } catch (err) {
        console.error("Failed to apply pending avatar", err);

      }
    }

    async function handleSettingsSave() {
      const username = settingsUsername.value.trim();
      if (!username) {
        showToast("Username can't be empty", { variant: "danger" });
        return;
      }
      settingsSave.disabled = true;
      settingsSave.textContent = "Saving...";
      try {
        let avatarUrl;
        if (pendingSettingsAvatarFile) {
          try {
            avatarUrl = await uploadAvatarFile(pendingSettingsAvatarFile);
          } catch (err) {
            console.error(err);
            showToast(err.message || "Failed to upload avatar", { variant: "danger" });
          }
        }

        const updates = {
          username,
          bio: settingsBio.value.trim() || null,
        };
        if (avatarUrl) updates.avatar_url = avatarUrl;

        const { profile } = await apiFetch("/api/profile", {
          method: "PUT",
          body: JSON.stringify(updates),
        });
        currentProfile = profile;
        pendingSettingsAvatarFile = null;
        topBarSubtitle.textContent = profile.username || currentUser.email;
        userPillName.textContent = profile.username || currentUser.email;
        userPillAvatar.innerHTML = avatarHTML(profile);
        settingsModal.classList.remove("visible");
        showToast("Profile updated", { variant: "accent" });
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to update profile", { variant: "danger" });
      } finally {
        settingsSave.disabled = false;
        settingsSave.textContent = "Save";
      }
    }

    async function uploadBackgroundFile(file) {
      if (file.size > 8 * 1024 * 1024) {
        throw new Error("Image must be under 8MB");
      }
      const dataUrl = await fileToDataUrl(file);
      const { url } = await apiFetch("/api/profile/background", {
        method: "POST",
        body: JSON.stringify({ dataUrl }),
      });
      return url;
    }

    async function handleAppearanceSave() {
      settingsAppearanceSave.disabled = true;
      settingsAppearanceSave.textContent = "Saving...";
      try {
        let backgroundUrl;
        if (pendingSettingsBackgroundFile) {
          try {
            backgroundUrl = await uploadBackgroundFile(pendingSettingsBackgroundFile);
          } catch (err) {
            console.error(err);
            showToast(err.message || "Failed to upload background", { variant: "danger" });
          }
        }

        const accentDefault = getComputedThemeAccentHex();
        const accentColor = settingsAccentColor ? settingsAccentColor.value : null;
        const accentColor2El = document.getElementById("settings-accent-color-2");
        const accentGradEl = document.getElementById("settings-accent-gradient");
        const accentColor2 = accentColor2El ? accentColor2El.value : null;
        const useAccentGrad = accentGradEl && accentGradEl.checked;

        const bgColorEl = document.getElementById("settings-bg-color");
        const bgColor2El = document.getElementById("settings-bg-color-2");
        const bgGradEl = document.getElementById("settings-bg-gradient");
        const bgColor = bgColorEl ? bgColorEl.value : null;
        const bgColor2 = bgColor2El ? bgColor2El.value : null;
        const useBgGrad = bgGradEl && bgGradEl.checked;

        const accentChanged = accentColor && accentColor.toLowerCase() !== accentDefault.toLowerCase();
        const hasCustomColors = accentChanged || useAccentGrad || useBgGrad || (bgColorEl && bgColorEl.dataset.userSet === "1");

        const appearance = {
          accent_color: accentChanged || useAccentGrad ? accentColor : null,
          accent_color_2: useAccentGrad ? accentColor2 : null,
          accent_gradient: !!useAccentGrad,
          bg_color: useBgGrad || (bgColorEl && bgColorEl.dataset.userSet === "1") ? bgColor : null,
          bg_color_2: useBgGrad ? bgColor2 : null,
          bg_gradient: !!useBgGrad,
          text_color_mode: settingsTextMode.value,
          custom_text_color: settingsTextMode.value === "custom" ? settingsCustomTextColor.value : null,
          density: settingsDensity.value,
          corner_style: settingsCorners.value,
        };

        let themeToSave = settingsTheme.value;
        if (hasCustomColors) themeToSave = "custom";

        const updates = { theme: themeToSave, appearance };
        if (backgroundUrl) updates.background_url = backgroundUrl;
        else if (pendingSettingsBackgroundRemoved) updates.background_url = null;

        const { profile } = await apiFetch("/api/profile", {
          method: "PUT",
          body: JSON.stringify(updates),
        });
        currentProfile = profile;
        pendingSettingsBackgroundFile = null;
        pendingSettingsBackgroundRemoved = false;
        applyProfileTheme(profile);
        applyProfileAppearance(profile);
        try {
          rebuildThemeSelect(themeSelect, profile.theme);
          rebuildThemeSelect(settingsTheme, profile.theme);
        } catch (e) {}
        settingsModal.classList.remove("visible");
        showToast("Appearance updated", { variant: "accent" });
      } catch (err) {
        console.error(err);
        showToast(err.message || "Failed to update appearance", { variant: "danger" });
      } finally {
        settingsAppearanceSave.disabled = false;
        settingsAppearanceSave.textContent = "Save";
      }
    }

async function handleSignIn() {
      authErrorSignin.textContent = "";
      if (!supabaseClient) {
        authErrorSignin.textContent = "App failed to initialize. Reload the page.";
        return;
      }
      try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
          email: signinEmail.value.trim(),
          password: signinPassword.value,
        });
        if (error) throw error;
        await loadCurrentUser();
      } catch (err) {
        authErrorSignin.textContent = err.message || "Sign in failed";
      }
    }

    function openForgotPasswordModal() {
      forgotPasswordError.textContent = "";
      forgotPasswordConfirm.classList.remove("visible");
      forgotPasswordConfirm.textContent = "";
      forgotPasswordEmail.value = signinEmail.value.trim();
      forgotPasswordModal.style.display = "flex";
    }

    async function handleSendResetLink() {
      forgotPasswordError.textContent = "";
      forgotPasswordConfirm.classList.remove("visible");
      const email = forgotPasswordEmail.value.trim();
      if (!email || !email.includes("@")) {
        forgotPasswordError.textContent = "Enter a valid email address";
        return;
      }
      if (!supabaseClient) {
        forgotPasswordError.textContent = "App failed to initialize. Reload the page.";
        return;
      }
      forgotPasswordSend.disabled = true;
      forgotPasswordSend.textContent = "Sending...";
      try {

        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
          redirectTo: getAppBaseUrl(),
        });
        if (error) throw error;
        forgotPasswordConfirm.textContent = `If an account exists for ${email}, a reset link is on its way. Don't see it? Check your spam or junk folder.`;
        forgotPasswordConfirm.classList.add("visible");
      } catch (err) {
        console.error(err);
        forgotPasswordError.textContent = err.message || "Failed to send reset link";
      } finally {
        forgotPasswordSend.disabled = false;
        forgotPasswordSend.textContent = "Send reset link";
      }
    }

    async function handleSetNewPasswordFromRecovery() {
      recoveryPasswordError.textContent = "";
      const next = recoveryPasswordNew.value;
      const confirm = recoveryPasswordConfirm.value;
      if (!next || next.length < 8) {
        recoveryPasswordError.textContent = "Password must be at least 8 characters";
        return;
      }
      if (next !== confirm) {
        recoveryPasswordError.textContent = "Passwords don't match";
        return;
      }
      recoveryPasswordSave.disabled = true;
      recoveryPasswordSave.textContent = "Saving...";
      try {
        const { error } = await supabaseClient.auth.updateUser({ password: next });
        if (error) throw error;
        recoveryPasswordNew.value = "";
        recoveryPasswordConfirm.value = "";
        recoveryPasswordModal.style.display = "none";
        showToast("Password updated — you're signed in", { variant: "accent" });
        await loadCurrentUser();
      } catch (err) {
        console.error(err);
        recoveryPasswordError.textContent = err.message || "Failed to set new password";
      } finally {
        recoveryPasswordSave.disabled = false;
        recoveryPasswordSave.textContent = "Set new password";
      }
    }

    function openSupportModalFn() {
      supportError.textContent = "";
      supportConfirm.classList.remove("visible");
      supportConfirm.textContent = "";
      supportAccountName.value = currentProfile ? currentProfile.username || "" : "";
      supportEmail.value = currentUser ? currentUser.email || "" : "";
      supportMessage.value = "";
      supportModal.style.display = "flex";
    }

    async function handleSendSupportRequest() {
      supportError.textContent = "";
      supportConfirm.classList.remove("visible");
      const email = supportEmail.value.trim();
      const message = supportMessage.value.trim();
      if (!email || !email.includes("@")) {
        supportError.textContent = "Enter a valid email address so we can reply to you";
        return;
      }
      if (!message) {
        supportError.textContent = "Describe the problem before sending";
        return;
      }
      supportSend.disabled = true;
      supportSend.textContent = "Sending...";
      try {

        const res = await fetch(apiUrl("/api/support"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountName: supportAccountName.value.trim(),
            email,
            message,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || "Failed to send your message");
        supportConfirm.textContent = "Sent — we'll get back to you by email. Don't see our reply later? Check your spam or junk folder.";
        supportConfirm.classList.add("visible");
        supportMessage.value = "";
      } catch (err) {
        console.error(err);
        supportError.textContent = err.message || "Failed to send your message";
      } finally {
        supportSend.disabled = false;
        supportSend.textContent = "Send";
      }
    }

    async function handleSignUp() {
      authErrorSignup.textContent = "";
      authConfirmSignup.classList.remove("visible");
      authConfirmSignup.textContent = "";
      if (!supabaseClient) {
        authErrorSignup.textContent = "App failed to initialize. Reload the page.";
        return;
      }

      const email = signupEmail.value.trim();
      const password = signupPassword.value;
      const username = signupUsername.value.trim();

      if (!email || !password || !username) {
        authErrorSignup.textContent = "Email, password, and username are required";
        return;
      }

      signupSubmit.disabled = true;
      signupSubmit.textContent = "Creating account...";

      try {

        const { available } = await apiFetch(`/api/usernames/${encodeURIComponent(username)}/available`);
        if (!available) {
          throw new Error("That username is already taken. Try another one.");
        }

        if (signupAvatar.files.length) {
          try {
            const dataUrl = await fileToDataUrl(signupAvatar.files[0]);
            stashPendingAvatar(email, dataUrl);
          } catch (err) {
            console.error("Failed to read avatar file", err);
          }
        }

        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: {

            data: { username },

            emailRedirectTo: getAppBaseUrl(),
          },
        });

        if (error) {
          console.error("Supabase signUp error:", error);
          const msg = (error.message || error.error_description || "").trim();
          if (/already registered|already exists|user_already_exists/i.test(msg)) {
            throw new Error("An account with that email already exists. Try signing in instead.");
          }

          if (!msg || /database error|unexpected_failure|500/i.test(msg)) {
            throw new Error(
              "Sign up failed on the server side — this isn't a bad email or password. It usually means the Postgres trigger that creates your profile row is erroring (commonly because it still references a column, like display_name, that was removed). Check the trigger function on auth.users in the Supabase SQL editor."
            );
          }
          throw error;
        }

        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          throw new Error("An account with that email already exists. Try signing in instead.");
        }

        if (!data.session) {

          signupEmail.value = "";
          signupPassword.value = "";
          signupUsername.value = "";
          signupAvatar.value = "";
          signupAvatarPreview.innerHTML = DEFAULT_AVATAR_SVG;
          authConfirmSignup.textContent =
            "Please check your email for a confirmation link to finish creating your account. Don't see it? Check your spam or junk folder.";
          authConfirmSignup.classList.add("visible");
          return;
        }

        await loadCurrentUser();

        if (currentProfile && currentProfile.username !== username) {
          await apiFetch("/api/profile", {
            method: "PUT",
            body: JSON.stringify({ username }),
          });

          const me = await apiFetch("/api/auth/me");
          currentProfile = me.user;
          topBarSubtitle.textContent = currentProfile.username || currentUser.email;
          userPillName.textContent = currentProfile.username || currentUser.email;
          userPillAvatar.innerHTML = avatarHTML(currentProfile);
        }
      } catch (err) {
        authErrorSignup.textContent = err.message || "Sign up failed";
      } finally {
        signupSubmit.disabled = false;
        signupSubmit.textContent = "Create account";
      }
    }

    async function handleOAuth(provider, errorEl) {
      const target = errorEl || authErrorSignin;
      if (!supabaseClient) {
        target.textContent = "App failed to initialize. Reload the page.";
        return;
      }
      try {
        const { error } = await supabaseClient.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo: getAppBaseUrl(),
          },
        });
        if (error) throw error;
      } catch (err) {
        target.textContent = err.message || "OAuth failed";
      }
    }

    async function handleLogout() {

      try {
        await disconnectVoice();
      } catch (err) {
        console.error("Error disconnecting voice during logout:", err);
      }
      try {
        unsubscribeRealtimeMessages();
      } catch (err) {
        console.error(err);
      }
      try {
        unsubscribeGlobalActivity();
      } catch (err) {
        console.error(err);
      }
      try {
        unsubscribeServerPresence();
      } catch (err) {
        console.error(err);
      }
      stopVoiceActivityPolling();
      stopSyncPolling();
      try {
        stopAccountStatusWatch();
      } catch (err) {
        console.error(err);
      }
      try {
        if (supabaseClient) {
          await supabaseClient.auth.signOut();
        }
      } catch (err) {
        console.error("Error signing out of Supabase:", err);
      }
      currentUser = null;
      currentProfile = null;
      unreadChannelCounts.clear();
      unreadDmCounts.clear();
      refreshDmButtonDot();
      showAuthOverlay();
      userPill.style.display = "none";
      logoutButton.style.display = "none";
      adminDashboardButton.style.display = "none";
      topBarSubtitle.textContent = "Not signed in";
    }

    function initAuthTabs() {
      authTabSignin.addEventListener("click", () => {
        authTabSignin.classList.add("active");
        authTabSignup.classList.remove("active");
        authFormSignin.style.display = "flex";
        authFormSignup.style.display = "none";
      });
      authTabSignup.addEventListener("click", () => {
        authTabSignup.classList.add("active");
        authTabSignin.classList.remove("active");
        authFormSignin.style.display = "none";
        authFormSignup.style.display = "flex";
      });
    }

    function initEvents() {
      signinSubmit.addEventListener("click", handleSignIn);
      signupSubmit.addEventListener("click", handleSignUp);
      signinGithub.addEventListener("click", () => handleOAuth("github", authErrorSignin));
      signinGoogle.addEventListener("click", () => handleOAuth("google", authErrorSignin));
      signupGithub.addEventListener("click", () => handleOAuth("github", authErrorSignup));
      signupGoogle.addEventListener("click", () => handleOAuth("google", authErrorSignup));

      authForgotPasswordLink.addEventListener("click", openForgotPasswordModal);
      forgotPasswordClose.addEventListener("click", () => (forgotPasswordModal.style.display = "none"));
      forgotPasswordCancel.addEventListener("click", () => (forgotPasswordModal.style.display = "none"));
      forgotPasswordSend.addEventListener("click", handleSendResetLink);
      recoveryPasswordSave.addEventListener("click", handleSetNewPasswordFromRecovery);

      authSupportLink.addEventListener("click", openSupportModalFn);
      openSupportModal.addEventListener("click", () => {
        settingsModal.classList.remove("visible");
        openSupportModalFn();
      });
      supportClose.addEventListener("click", () => (supportModal.style.display = "none"));
      supportCancel.addEventListener("click", () => (supportModal.style.display = "none"));
      supportSend.addEventListener("click", handleSendSupportRequest);

      chatSendButton.addEventListener("click", handleSendMessage);
      chatInputEl.addEventListener("keydown", (e) => {
        if (handleMentionKeydown(e, chatInputEl)) return;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSendMessage();
        }
      });
      chatInputEl.addEventListener("input", () => {
        autoResizeTextarea(chatInputEl);
        updateMentionSuggestions(chatInputEl, () => currentServerMembers.map((m) => m.user).filter(Boolean));
      });
      chatInputEl.addEventListener("paste", handleChatInputPaste);
      replyPreviewCancel.addEventListener("click", clearReplyTarget);

      attachmentButton.addEventListener("click", () => attachmentInput.click());
      attachmentInput.addEventListener("change", handleAttachmentSelected);

      chatBodyEl.addEventListener("dragenter", (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        chatDragCounter++;
        chatDropOverlay.classList.add("visible");
      });
      chatBodyEl.addEventListener("dragover", (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
      });
      chatBodyEl.addEventListener("dragleave", (e) => {
        if (!isFileDrag(e)) return;
        chatDragCounter = Math.max(0, chatDragCounter - 1);
        if (chatDragCounter === 0) chatDropOverlay.classList.remove("visible");
      });
      chatBodyEl.addEventListener("drop", (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        chatDragCounter = 0;
        chatDropOverlay.classList.remove("visible");
        if (!currentChannel || currentChannel.type !== "text") return;
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) attachFileToComposer(file);
      });

      signupAvatar.addEventListener("change", () => {
        const file = signupAvatar.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          signupAvatarPreview.innerHTML = `<img src="${reader.result}" alt="">`;
        };
        reader.readAsDataURL(file);
      });

      settingsAvatar.addEventListener("change", () => {
        const file = settingsAvatar.files[0];
        if (!file) return;
        pendingSettingsAvatarFile = file;
        const reader = new FileReader();
        reader.onload = () => {
          settingsAvatarPreview.innerHTML = `<img src="${reader.result}" alt="">`;
        };
        reader.readAsDataURL(file);
      });

      settingsBackground.addEventListener("change", () => {
        const file = settingsBackground.files[0];
        if (!file) return;
        pendingSettingsBackgroundFile = file;
        pendingSettingsBackgroundRemoved = false;
        const reader = new FileReader();
        reader.onload = () => {
          settingsBackgroundPreview.innerHTML = `<img src="${reader.result}" alt="">`;
        };
        reader.readAsDataURL(file);
      });

      settingsBackgroundRemove.addEventListener("click", () => {
        pendingSettingsBackgroundFile = null;
        pendingSettingsBackgroundRemoved = true;
        settingsBackground.value = "";
        settingsBackgroundPreview.innerHTML = `<span style="font-size:11px; color:var(--text-tertiary);">None</span>`;
      });

      settingsTextMode.addEventListener("change", () => {
        settingsCustomTextColorRow.style.display = settingsTextMode.value === "custom" ? "" : "none";
      });

      settingsAccentReset.addEventListener("click", () => {
        clearAccentOverrides();
        const themeNow =
          (currentProfile && currentProfile.theme && currentProfile.theme !== "custom"
            ? currentProfile.theme
            : null) ||
          lastNamedTheme ||
          document.documentElement.getAttribute("data-theme") ||
          "dark";
        if (themeNow === "custom") {
          setTheme(lastNamedTheme || "dark");
        } else {
          setTheme(themeNow);
        }
        void document.documentElement.offsetHeight;
        const themeAccent = getComputedThemeAccentHex();
        if (settingsAccentColor) settingsAccentColor.value = themeAccent;
        const a2 = document.getElementById("settings-accent-color-2");
        const ag = document.getElementById("settings-accent-gradient");
        if (a2) a2.value = themeAccent;
        if (ag) ag.checked = false;
        try { syncColorPickerMode("accent", false); } catch (e) {}
        try { updateColorPickerPreview("accent"); } catch (e) {}
        applyAccentColor(null);
        clearAccentOverrides();
        showToast("Accent restored to theme", { duration: 1800 });
      });
      const settingsBgReset = document.getElementById("settings-bg-reset");
      const settingsBgColor = document.getElementById("settings-bg-color");
      if (settingsBgColor) {
        settingsBgColor.addEventListener("input", () => { settingsBgColor.dataset.userSet = "1"; });
      }
      if (settingsBgReset) {
        settingsBgReset.addEventListener("click", () => {
          clearBackgroundOverrides();
          const themeNow =
            (currentProfile && currentProfile.theme && currentProfile.theme !== "custom"
              ? currentProfile.theme
              : null) || lastNamedTheme || "dark";
          setTheme(themeNow);
          void document.documentElement.offsetHeight;
          const canvas = getComputedStyle(document.documentElement).getPropertyValue("--bg-canvas").trim() || "#0a0b0e";
          const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || canvas;
          const bg = document.getElementById("settings-bg-color");
          const bg2 = document.getElementById("settings-bg-color-2");
          const bgg = document.getElementById("settings-bg-gradient");
          const toHex = (raw) => {
            if (!raw) return "#0a0b0e";
            if (/^#/.test(raw)) return raw.length === 4
              ? "#" + raw[1]+raw[1]+raw[2]+raw[2]+raw[3]+raw[3]
              : raw;
            const m = raw.match(/\d+/g);
            if (!m) return "#0a0b0e";
            return "#" + m.slice(0,3).map((n) => Number(n).toString(16).padStart(2,"0")).join("");
          };
          if (bg) { bg.value = toHex(canvas); bg.dataset.userSet = "0"; }
          if (bg2) bg2.value = toHex(surface);
          if (bgg) bgg.checked = false;
          try { syncColorPickerMode("bg", false); } catch (e) {}
          try { updateColorPickerPreview("bg"); } catch (e) {}
          showToast("Background restored to theme", { duration: 1800 });
        });
      }

      settingsTheme.addEventListener("change", () => setTheme(settingsTheme.value));

      settingsAppearanceCancel.addEventListener("click", () => {
        settingsModal.classList.remove("visible");

        applyProfileTheme(currentProfile);
      });
      settingsAppearanceSave.addEventListener("click", handleAppearanceSave);

      voiceMuteButton.addEventListener("click", toggleVoiceMute);
      voiceLeaveButton.addEventListener("click", disconnectVoice);

      createServerButton.addEventListener("click", handleCreateServer);
      browseServersButton.addEventListener("click", handleBrowseServers);
      browseServersClose.addEventListener("click", () => browseServersModal.classList.remove("visible"));
      if (myServersClose && myServersModal) {
        myServersClose.addEventListener("click", () => myServersModal.classList.remove("visible"));
      }
      if (myServersSearchInput) {
        myServersSearchInput.addEventListener("input", () => {
          renderMyServersList(myServersSearchInput.value);
        });
      }

      adminDashboardButton.addEventListener("click", handleAdminDashboardOpen);
      adminDashboardClose.addEventListener("click", () => adminDashboardModal.classList.remove("visible"));

      invitesClose.addEventListener("click", () => invitesModal.classList.remove("visible"));
      createInviteButton.addEventListener("click", handleCreateInvite);

      channelsDrawerToggle.addEventListener("click", () => {
        if (channelsDrawer.classList.contains("open")) {
          closeChannelsDrawer();
        } else {
          closeMembersDrawer();
          openChannelsDrawer();
        }
      });
      membersDrawerToggle.addEventListener("click", () => {
        if (userPanelEl.classList.contains("open")) {
          closeMembersDrawer();
        } else {
          closeChannelsDrawer();
          openMembersDrawer();
        }
      });
      drawerBackdrop.addEventListener("click", closeAllDrawers);

      document.addEventListener(
        "mousedown",
        (e) => {
          const menus = [messageContextMenu, userContextMenu, serverContextMenu];
          const anyOpen = menus.some((m) => m.classList.contains("visible"));
          if (!anyOpen) return;
          if (menus.some((m) => m.contains(e.target))) return;
          closeContextMenus();
        },
        true
      );
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeContextMenus();
      });
      window.addEventListener(
        "scroll",
        (e) => {

          if (openEmojiPickerEl && openEmojiPickerEl.contains(e.target)) return;
          closeContextMenus();
        },
        true
      );
      window.addEventListener("resize", () => closeContextMenus());

      dmButton.addEventListener("click", handleOpenDmModal);
      dmClose.addEventListener("click", closeDmModal);
      viewProfileClose.addEventListener("click", closeViewProfileModal);
      memberSearchInput.addEventListener("input", () => {
        renderMemberList(memberSearchInput.value);
      });
      adminUserSearchInput.addEventListener("input", () => {
        renderAdminUsers(adminUserSearchInput.value);
      });
      if (serverAdminMemberSearchInput) {
        serverAdminMemberSearchInput.addEventListener("input", () => {
          renderServerAdminMembers(serverAdminMemberSearchInput.value);
        });
      }
      if (publicServerSearchInput) {
        publicServerSearchInput.addEventListener("input", () => {
          renderPublicServers(publicServerSearchInput.value);
        });
      }
      if (adminServerSearchInput) {
        adminServerSearchInput.addEventListener("input", () => {
          renderAdminServers(adminServerSearchInput.value);
        });
      }
      viewProfileDmButton.addEventListener("click", () => {
        if (!viewProfileTargetUser) return;
        const user = viewProfileTargetUser;
        closeViewProfileModal();
        openDmWith(user);
      });
      dmSendButton.addEventListener("click", handleSendDmMessage);
      dmInput.addEventListener("keydown", (e) => {
        if (handleMentionKeydown(e, dmInput)) return;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSendDmMessage();
        }
      });
      dmInput.addEventListener("input", () => {
        autoResizeTextarea(dmInput);
        updateMentionSuggestions(dmInput, () => (currentDmOtherUser ? [currentDmOtherUser] : []));
      });
      dmReplyPreviewCancel.addEventListener("click", clearDmReplyTarget);
      dmCallButton.addEventListener("click", handleDmCallButtonClick);
      if (dmVideoCallButton) dmVideoCallButton.addEventListener("click", handleDmVideoCallButtonClick);
      if (dmVideoToggleButton) dmVideoToggleButton.addEventListener("click", toggleDmCamera);
      if (dmScreenShareButton) dmScreenShareButton.addEventListener("click", toggleDmScreenShare);
      if (dmRecordButton) dmRecordButton.addEventListener("click", startCallRecording);
      dmSearchInput.addEventListener("input", handleDmSearchInput);
      dmSearchInput.addEventListener("focus", () => {
        if (dmSearchResults.innerHTML) dmSearchResults.classList.add("visible");
      });
      document.addEventListener("click", (e) => {
        if (!dmSearchInput.contains(e.target) && !dmSearchResults.contains(e.target)) {
          closeDmSearchResults();
        }
      });
      dmVoiceMuteButton.addEventListener("click", toggleVoiceMute);
      dmVoiceLeaveButton.addEventListener("click", disconnectVoice);
      adminTabs.forEach((btn) => {
        btn.addEventListener("click", () => switchAdminTab(btn.dataset.tab));
      });
      serverAdminTabs.forEach((btn) => {
        btn.addEventListener("click", () => switchServerAdminTab(btn.dataset.serverAdminTab));
      });
      serverAdminClose.addEventListener("click", () => serverAdminModal.classList.remove("visible"));
      serverAdminFilterEnabled.addEventListener("change", () =>
        handleServerAdminFilterToggle("enabled", serverAdminFilterEnabled.checked)
      );
      serverAdminFilterUseBasic.addEventListener("change", () =>
        handleServerAdminFilterToggle("use_basic_filter", serverAdminFilterUseBasic.checked)
      );
      serverAdminFilterAdd.addEventListener("click", handleAddServerAdminFilter);
      createChannelButton.addEventListener("click", handleCreateChannel);
      serverAdminPanelButton.addEventListener("click", () => {
        if (currentServer) openServerAdminPanel(currentServer);
      });
      if (serverMuteButton) {
        serverMuteButton.addEventListener("click", async () => {
          if (!currentServer) return;
          const next = !mutedServerIds.has(currentServer.id);
          await toggleMuteServer(currentServer.id, next);
        });
      }
      if (serverLeaveButton) {
        serverLeaveButton.addEventListener("click", async () => {
          if (!currentServer) return;
          await handleLeaveServer(currentServer);
        });
      }

      formModalClose.addEventListener("click", closeFormModal);
      formModalCancel.addEventListener("click", closeFormModal);
      formModalSubmit.addEventListener("click", () => {
        if (formModalSubmitHandler) formModalSubmitHandler();
      });

      document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
        backdrop.addEventListener("click", (e) => {
          if (e.target !== backdrop) return;

          if (backdrop === dmModal) {
            closeDmModal();
            return;
          }
          if (backdrop === viewProfileModal) {
            closeViewProfileModal();
            return;
          }
          backdrop.classList.remove("visible");
        });
      });

      userPill.addEventListener("click", () => handleSettingsOpen());
      settingsClose.addEventListener("click", () => settingsModal.classList.remove("visible"));
      settingsCancel.addEventListener("click", () => settingsModal.classList.remove("visible"));

      const dangerSignOutButton = document.getElementById("danger-sign-out-button");
      if (dangerSignOutButton) {
        dangerSignOutButton.addEventListener("click", async () => {
          settingsModal.classList.remove("visible");
          await handleLogout();
        });
      }

      const dangerDeleteAccountButton = document.getElementById("danger-delete-account-button");
      if (dangerDeleteAccountButton) {
        dangerDeleteAccountButton.addEventListener("click", async () => {
          const confirmed = window.confirm(
            "Delete your account permanently? This removes your profile and cannot be undone."
          );
          if (!confirmed) return;
          const typed = window.prompt('Type "DELETE" to confirm.');
          if (typed !== "DELETE") return;
          dangerDeleteAccountButton.disabled = true;
          dangerDeleteAccountButton.textContent = "Deleting...";
          try {
            await apiFetch("/api/auth/delete-account", { method: "POST" });
            showToast("Account deleted", { variant: "accent" });
            settingsModal.classList.remove("visible");
            await handleLogout();
          } catch (err) {
            console.error(err);
            showToast(err.message || "Failed to delete account", { variant: "danger" });
          } finally {
            dangerDeleteAccountButton.disabled = false;
            dangerDeleteAccountButton.textContent = "Delete account";
          }
        });
      }
      settingsSave.addEventListener("click", handleSettingsSave);
      settingsUpdateEmailButton.addEventListener("click", handleUpdateEmail);
      identitySetPasswordButton.addEventListener("click", handleSetPassword);

      themeSelect.addEventListener("change", () => {
        const v = themeSelect.value;
        if (v === "__more__") {
          if (currentProfile && currentProfile.theme) themeSelect.value = currentProfile.theme;
          else themeSelect.value = document.documentElement.getAttribute("data-theme") || "light";
          openMoreThemesModal(false);
          return;
        }
        handleThemeChange(v);
      });
      const moreThemesModal = document.getElementById("more-themes-modal");
      const closeMoreThemes = () => {
        if (moreThemesModal) moreThemesModal.classList.remove("visible");
      };
      if (moreThemesModal) {
        moreThemesModal.addEventListener("click", (e) => {
          if (e.target === moreThemesModal) closeMoreThemes();
          const closeBtn = e.target.closest && e.target.closest("#more-themes-close, .modal-close");
          if (closeBtn && moreThemesModal.contains(closeBtn)) {
            e.preventDefault();
            e.stopPropagation();
            closeMoreThemes();
          }
        });
      }
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && moreThemesModal && moreThemesModal.classList.contains("visible")) {
          closeMoreThemes();
        }
      });
      if (settingsTheme) {
        settingsTheme.addEventListener("change", () => {
          const v = settingsTheme.value;
          if (v === "__more__") {
            if (currentProfile && currentProfile.theme) settingsTheme.value = currentProfile.theme;
            openMoreThemesModal(true);
            return;
          }
          setTheme(v);
        });
      }
      document.querySelectorAll(".color-mode-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const target = btn.dataset.target;
          const mode = btn.dataset.mode;
          syncColorPickerMode(target, mode === "gradient");
          if (target === "bg") {
            const bg = document.getElementById("settings-bg-color");
            if (bg) bg.dataset.userSet = "1";
          }
        });
      });
      ["settings-accent-color", "settings-accent-color-2", "settings-bg-color", "settings-bg-color-2"].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("input", () => {
          const target = id.includes("accent") ? "accent" : "bg";
          if (target === "bg") el.dataset.userSet = "1";
          updateColorPickerPreview(target);
        });
      });

      const callCtrlMute = document.getElementById("call-ctrl-mute");
      const callCtrlCam = document.getElementById("call-ctrl-cam");
      const callCtrlShare = document.getElementById("call-ctrl-share");
      const callCtrlRecord = document.getElementById("call-ctrl-record");
      const callCtrlLeave = document.getElementById("call-ctrl-leave");
      const callOverlayMinimize = document.getElementById("call-overlay-minimize");
      if (callCtrlMute) callCtrlMute.addEventListener("click", () => { toggleVoiceMute(); updateCallOverlayControls(); });
      if (callCtrlCam) callCtrlCam.addEventListener("click", toggleDmCamera);
      if (callCtrlShare) callCtrlShare.addEventListener("click", toggleDmScreenShare);
      if (callCtrlRecord) callCtrlRecord.addEventListener("click", startCallRecording);
      if (callCtrlLeave) callCtrlLeave.addEventListener("click", disconnectVoice);
      let callPipVisible = true;
      let callBarVisible = true;
      const callTogglePip = document.getElementById("call-toggle-pip");
      const callToggleBar = document.getElementById("call-toggle-bar");
      const refreshEyeButtons = () => {
        if (callTogglePip) {
          callTogglePip.innerHTML = (typeof eyeIcon === "function" ? eyeIcon(callPipVisible) : "");
          callTogglePip.classList.toggle("is-off", !callPipVisible);
        }
        if (callToggleBar) {
          callToggleBar.innerHTML = (typeof eyeIcon === "function" ? eyeIcon(callBarVisible) : "");
          callToggleBar.classList.toggle("is-off", !callBarVisible);
        }
      };
      if (callTogglePip) {
        callTogglePip.addEventListener("click", () => {
          callPipVisible = !callPipVisible;
          const pip = document.getElementById("call-pip");
          if (pip) pip.classList.toggle("pip-hidden", !callPipVisible);
          refreshEyeButtons();
        });
      }
      if (callToggleBar) {
        callToggleBar.addEventListener("click", () => {
          callBarVisible = !callBarVisible;
          const ctrls = document.getElementById("call-overlay-controls");
          if (ctrls) ctrls.classList.toggle("bar-hidden", !callBarVisible);
          refreshEyeButtons();
        });
      }
      refreshEyeButtons();
      if (callOverlayMinimize) callOverlayMinimize.addEventListener("click", () => {
        const ov = document.getElementById("call-overlay");
        if (ov) {
          ov.classList.remove("visible");
          ov.style.cssText = "display:none!important;";
          document.body.classList.remove("in-call-overlay");
        }
        try { renderDmCallBar(); } catch (e) {}
      });
      document.querySelectorAll(".call-layout-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          callLayoutMode = btn.dataset.layout || "gallery";
          updateCallOverlayControls();
          renderCallOverlayStage();
        });
      });
      const focusSel = document.getElementById("call-focus-select");
      if (focusSel) {
        focusSel.addEventListener("change", () => {
          callFocusIdentity = focusSel.value || "auto";
          renderCallOverlayStage();
        });
      }


      logoutButton.addEventListener("click", handleLogout);

      document.addEventListener("click", (e) => {

        if (e.target.closest(".message-more-button")) return;
        if (!messageContextMenu.contains(e.target)) {
          messageContextMenu.classList.remove("visible");
          openMoreMenuAnchor = null;
        }
        if (!userContextMenu.contains(e.target)) {
          userContextMenu.classList.remove("visible");
        }
      });

      window.addEventListener("resize", () => {
        closeContextMenus();
      });
    }

    async function init() {
      initAuthTabs();
      initEvents();
      applyMobileNotificationLock();
      window.addEventListener("resize", applyMobileNotificationLock);
      window.addEventListener("orientationchange", applyMobileNotificationLock);
      await loadCurrentUser();
    }

    let accountStatusInterval = null;
    let ownProfileRealtimeChannel = null;

    async function forceSignOutAndReload(message) {
      if (window.__forcingSignOut) return;
      window.__forcingSignOut = true;
      showToast(message || "Your session has ended.", { variant: "danger", duration: 5000 });

      await handleLogout();
      window.__forcingSignOut = false;
    }

    async function pollAccountStatus() {
      if (!currentUser || window.__forcingSignOut) return;
      try {
        const result = await apiFetch("/api/auth/force-logout");
        if (result.forceLogout) {
          await forceSignOutAndReload("You've been signed out by an administrator.");
        }
      } catch (err) {
        const described = describeAuthBlockError(err);
        if (described) {
          await forceSignOutAndReload(described);
          return;
        }
        const msg = (err && err.message) || "";
        if (/banned|force logged out/i.test(msg)) {
          await forceSignOutAndReload("Your account access has been revoked.");
        }
      }
    }

    function startAccountStatusWatch() {
      stopAccountStatusWatch();
      if (!currentUser || !supabaseClient) return;

      accountStatusInterval = setInterval(pollAccountStatus, 15000);

      ownProfileRealtimeChannel = supabaseClient
        .channel(`own-profile:${currentUser.id}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${currentUser.id}` },
          async (payload) => {

            try {
              await apiFetch("/api/auth/me");
              currentProfile = { ...currentProfile, ...payload.new };
            } catch (err) {
              const described = describeAuthBlockError(err);
              if (described) await forceSignOutAndReload(described);
            }
          }
        )
        .subscribe((status, err) => logRealtimeStatus("own-profile", status, err));
    }

    function stopAccountStatusWatch() {
      if (accountStatusInterval) clearInterval(accountStatusInterval);
      accountStatusInterval = null;
      if (ownProfileRealtimeChannel && supabaseClient) {
        supabaseClient.removeChannel(ownProfileRealtimeChannel);
      }
      ownProfileRealtimeChannel = null;
    }

    init().catch((err) => {
      showInitError(err.message || "Failed to initialize the app.");
    });

    window.addEventListener("pageshow", (event) => {
      if (event.persisted) {
        window.location.reload();
      }
    });
  
