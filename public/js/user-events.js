// Frontend half of the Phase 3 per-user SSE stream (server side: src/routes/users.routes.js +
// src/realtime/userEvents.js). One EventSource per session, opened as soon as the user is known
// to be authenticated (auth-screens.js's bootstrap(), right after `/api/auth/me` succeeds — even
// before workspace access is granted, since a user stuck on the setup screen waiting for approval
// still needs invitation_updated to arrive live) and closed on logout. Unlike the four existing
// per-conversation/per-task hubs, this stream has no natural "close" point mid-session — it stays
// open the whole time, mirroring the plan's explicit instruction.
import { state, $ } from './state.js';
import { toast, showMessagePopup } from './ui.js';
import { render, updateShell } from './dispatch.js';
import { loadProjectData, refreshNotifications } from './workspace-loader.js';
import { renderSetupInvitations, renderOnboardingState } from './auth-screens.js';
import { api } from './api.js';
import { refreshUnreadMessageCount } from './messaging.js';

export let userEventStream = null;

export function disconnectUserEventStream() {
  if (userEventStream) userEventStream.close();
  userEventStream = null;
}

export function connectUserEventStream() {
  if (userEventStream) return;
  const source = new EventSource('/api/users/me/events/stream');
  userEventStream = source;
  source.onmessage = event => {
    if (userEventStream !== source) return;
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    handleUserEvent(payload).catch(() => {});
  };
  // EventSource reconnects on its own on transient drops; there's no per-conversation
  // connected/reconnecting indicator for this always-on stream (nothing in the UI depends on it
  // the way #chatConnectionStatus/#dmConnectionStatus gate a single open conversation).
  source.onerror = () => {};
}

function projectViewOpen(event) {
  const projectId = event.payload?.project_id ?? event.id;
  return Number(state.organizationId) === Number(event.organization_id)
    && Number(state.projectId) === Number(projectId)
    && ['work', 'dashboard', 'risks', 'changes', 'report', 'meeting'].includes(state.view);
}

function setupScreenOpen() {
  return !$('#setupScreen')?.classList.contains('hidden');
}

async function handleUserEvent(event) {
  switch (event.type) {
    case 'notification_created': {
      state.unreadNotificationCount += 1;
      if (state.view === 'notifications') { await refreshNotifications(); render(); }
      updateShell();
      break;
    }
    case 'task_updated':
    case 'change_updated': {
      if (projectViewOpen(event)) { await loadProjectData(); render(); }
      break;
    }
    case 'project_updated': {
      if (Number(state.organizationId) === Number(event.organization_id) && Number(state.projectId) === Number(event.id)) {
        await loadProjectData();
        render();
      }
      break;
    }
    case 'team_updated': {
      if (Number(state.organizationId) === Number(event.organization_id) && state.view === 'teams') {
        try { state.teams = await api(`/api/organizations/${state.organizationId}/teams`, { silent: true }); render(); } catch { /* keep the stale list rather than break the view */ }
      }
      break;
    }
    case 'invitation_updated': {
      if (setupScreenOpen()) {
        try {
          state.myInvitations = await api('/api/invitations/me', { silent: true });
          renderSetupInvitations();
          renderOnboardingState();
        } catch { /* best-effort */ }
      }
      if (state.view === 'admin' && Number(state.organizationId) === Number(event.organization_id)) {
        try { state.invitations = await api(`/api/organizations/${state.organizationId}/invitations`, { silent: true }); render(); } catch { /* best-effort */ }
      }
      break;
    }
    case 'comment_added': {
      // The task dialog itself already gets live comments via its own per-task stream
      // (taskCommentHub) when open for this exact task — only surface a toast when it isn't.
      const openTaskId = document.querySelector('#taskDialog input[name="task_id"]')?.value;
      if (!openTaskId || Number(openTaskId) !== Number(event.payload?.task_id)) {
        toast(`💬 ${event.payload?.commenter_name || 'Someone'} commented on ${event.payload?.task_title || 'a task'}`);
      }
      break;
    }
    case 'message': {
      await handleMessageEvent(event);
      break;
    }
    default:
      break;
  }
}

function conversationCurrentlyOpen(payload) {
  if (state.view !== 'chat') return false;
  if (payload.conversation_type === 'channel') return state.chatMode === 'channels' && Number(state.channelId) === Number(payload.conversation_id);
  return state.chatMode === 'direct' && Number(state.activeConversationId) === Number(payload.conversation_id);
}

async function handleMessageEvent(event) {
  const payload = event.payload || {};
  if (conversationCurrentlyOpen(payload)) return; // already visible live via the per-conversation hub — don't double-notify
  state.unreadMessageCount += 1;
  updateShell();
  const title = payload.conversation_type === 'channel' ? `#${payload.channel_name || ''} · ${payload.sender_name || ''}` : payload.sender_name || 'New message';
  showMessagePopup(title, payload.preview || '', () => openFromPopup(payload));
  await refreshUnreadMessageCount().catch(() => {});
  updateShell();
}

function openFromPopup(payload) {
  state.view = 'chat';
  state.chatMode = payload.conversation_type === 'channel' ? 'channels' : 'direct';
  localStorage.setItem('orbit_chat_mode', state.chatMode);
  if (payload.conversation_type === 'channel') {
    state.channelId = Number(payload.conversation_id);
    localStorage.setItem('orbit_channel_id', state.channelId);
  } else {
    state.activeConversationId = Number(payload.conversation_id);
    localStorage.setItem('orbit_conversation_id', state.activeConversationId);
  }
  updateShell();
  render();
  // Re-dispatch through the normal click handlers so the same connect/read/render wiring used
  // everywhere else runs (loadMessages/connectMessageStream/openConversation, read-marking, etc.)
  // instead of duplicating that logic here.
  const selector = payload.conversation_type === 'channel'
    ? `[data-action="select-channel"][data-id="${payload.conversation_id}"]`
    : `[data-action="select-conversation"][data-id="${payload.conversation_id}"]`;
  requestAnimationFrame(() => document.querySelector(selector)?.click());
}
