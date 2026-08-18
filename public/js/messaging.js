import { state, $ } from './state.js';
import { api } from './api.js';
import { escapeHtml, avatarMarkup, statusMarkup, ICONS } from './format.js';
import { mountDialog, closeDialog, setButtonBusy, toast } from './ui.js';

export let messageStream = null;
export let messageStreamChannelId = null;
export let directMessageStream = null;
export let directMessageStreamConversationId = null;

// Currently-open thread panel (Phase 3, item 18), if any — { kind: 'channel'|'dm', conversationId,
// parentId, overlay }. Only one thread can be open at a time, mirroring how only one task dialog
// or one conversation stream is "current" at once elsewhere in this file.
let openThread = null;

export async function loadMessages() {
  state.messages = state.channelId ? await api(`/api/channels/${state.channelId}/messages`) : [];
}

// `replyCount` renders a "Reply (N)" affordance on a top-level message; omitted (or 0) for a
// plain message. `insideThread` suppresses the Reply button entirely — replies are one level
// deep only (a minimal thread UI, not nested threads-of-threads).
export function messageMarkup(message, { replyCount = 0, insideThread = false } = {}) {
  const member = state.members.find(item => Number(item.user_id) === Number(message.user_id));
  const replyButton = insideThread ? '' : `<button type="button" class="text-link small" data-action="open-thread" data-id="${message.id}" data-reply-count="${replyCount}">${replyCount ? `${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}` : 'Reply'}</button>`;
  return `<article class="message" data-message-id="${message.id}">${avatarMarkup({ ...message, ...(member || {}) })}<div><div class="message-meta"><strong>${escapeHtml(message.full_name)}</strong>${member ? statusMarkup(member, true) : ''}<small>@${escapeHtml(message.username)} · ${escapeHtml(new Date(message.created_at).toLocaleString())}</small></div><div class="message-body">${escapeHtml(message.body)}</div><div class="message-actions">${replyButton}</div></div></article>`;
}

// Main feed only ever shows top-level messages — a reply is either routed into an open thread
// panel or shown as a reply-count bump on its parent's row, never inlined into the main feed.
export function topLevelMessages(list) {
  return list.filter(item => !item.parent_message_id);
}

export function replyCountFor(list, parentId) {
  return list.filter(item => Number(item.parent_message_id) === Number(parentId)).length;
}

function bumpReplyCountBadge(feed, parentId) {
  const parentRow = feed?.querySelector(`[data-message-id="${parentId}"]`);
  const button = parentRow?.querySelector('[data-action="open-thread"]');
  if (!button) return;
  const count = Number(button.dataset.replyCount || 0) + 1;
  button.dataset.replyCount = String(count);
  button.textContent = `${count} repl${count === 1 ? 'y' : 'ies'}`;
}

export function appendMessageToFeed(message) {
  const feed = $('#messageFeed');
  if (!feed) return;
  if (message.parent_message_id) { bumpReplyCountBadge(feed, message.parent_message_id); return; }
  if (feed.querySelector(`[data-message-id="${message.id}"]`)) return;
  const empty = feed.querySelector('.empty');
  if (empty) empty.remove();
  feed.insertAdjacentHTML('beforeend', messageMarkup(message));
  feed.scrollTop = feed.scrollHeight;
}

export function receiveMessage(message) {
  if (Number(message.channel_id) !== Number(state.channelId)) return;
  if (state.messages.some(item => Number(item.id) === Number(message.id))) return;
  state.messages.push(message);
  const activelyViewing = state.view === 'chat' && state.chatMode !== 'direct';
  if (openThread && openThread.kind === 'channel' && Number(message.parent_message_id) === Number(openThread.parentId)) appendThreadReply(message);
  else if (activelyViewing) appendMessageToFeed(message);
  // A message that arrives while this exact channel is already open on screen has, in effect,
  // already been "read" live — without this, the server's unread count (computed purely from
  // channel_reads.last_read_at) would keep climbing for a user who is actively watching it.
  if (activelyViewing) { markChannelRead(state.channelId).then(refreshUnreadMessageCount); }
}

export function setMessageStreamStatus(connected) {
  const indicator = $('#chatConnectionStatus');
  if (!indicator) return;
  if (connected === false) { indicator.textContent = 'Reconnecting…'; indicator.classList.remove('hidden'); }
  else { indicator.textContent = ''; indicator.classList.add('hidden'); }
}

export function disconnectMessageStream() {
  if (messageStream) messageStream.close();
  messageStream = null;
  messageStreamChannelId = null;
  setMessageStreamStatus(null);
}

export function connectMessageStream(channelId) {
  if (!channelId) { disconnectMessageStream(); return; }
  if (messageStreamChannelId === channelId && messageStream) return;
  disconnectMessageStream();
  messageStreamChannelId = channelId;
  const source = new EventSource(`/api/channels/${channelId}/messages/stream`);
  messageStream = source;
  source.onmessage = event => {
    if (messageStream !== source) return;
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    receiveMessage(payload);
  };
  source.onopen = () => { if (messageStream === source) setMessageStreamStatus(true); };
  source.onerror = () => { if (messageStream === source) setMessageStreamStatus(false); };
}

export function appendDirectMessageToFeed(message) {
  const feed = $('#directMessageFeed');
  if (!feed) return;
  if (message.parent_message_id) { bumpReplyCountBadge(feed, message.parent_message_id); return; }
  if (feed.querySelector(`[data-message-id="${message.id}"]`)) return;
  const empty = feed.querySelector('.empty');
  if (empty) empty.remove();
  feed.insertAdjacentHTML('beforeend', messageMarkup(message));
  feed.scrollTop = feed.scrollHeight;
}

export function receiveDirectMessage(message) {
  if (Number(message.conversation_id) !== Number(state.activeConversationId)) return;
  if (state.directMessages.some(item => Number(item.id) === Number(message.id))) return;
  state.directMessages.push(message);
  const activelyViewing = state.view === 'chat' && state.chatMode === 'direct';
  if (openThread && openThread.kind === 'dm' && Number(message.parent_message_id) === Number(openThread.parentId)) appendThreadReply(message);
  else if (activelyViewing) appendDirectMessageToFeed(message);
  const conversation = state.directConversations.find(item => Number(item.id) === Number(message.conversation_id));
  if (conversation) { conversation.last_message = message.body; conversation.last_message_at = message.created_at; }
  // Same reasoning as receiveMessage() above: a DM that arrives while this exact conversation is
  // already open on screen has, in effect, already been read live.
  if (activelyViewing) {
    api(`/api/direct-conversations/${message.conversation_id}/read`, { method: 'POST', silent: true })
      .then(() => { if (conversation) conversation.unread_count = 0; return refreshUnreadMessageCount(); })
      .catch(() => {});
  }
}

export function setDmStreamStatus(connected) {
  const indicator = $('#dmConnectionStatus');
  if (!indicator) return;
  if (connected === false) { indicator.textContent = 'Reconnecting…'; indicator.classList.remove('hidden'); }
  else { indicator.textContent = ''; indicator.classList.add('hidden'); }
}

export function disconnectDmStream() {
  if (directMessageStream) directMessageStream.close();
  directMessageStream = null;
  directMessageStreamConversationId = null;
  setDmStreamStatus(null);
}

export function connectDmStream(conversationId) {
  if (!conversationId) { disconnectDmStream(); return; }
  if (directMessageStreamConversationId === conversationId && directMessageStream) return;
  disconnectDmStream();
  directMessageStreamConversationId = conversationId;
  const source = new EventSource(`/api/direct-conversations/${conversationId}/messages/stream`);
  directMessageStream = source;
  source.onmessage = event => {
    if (directMessageStream !== source) return;
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    receiveDirectMessage(payload);
  };
  source.onopen = () => { if (directMessageStream === source) setDmStreamStatus(true); };
  source.onerror = () => { if (directMessageStream === source) setDmStreamStatus(false); };
}

export async function loadDirectConversations() {
  state.directConversations = await api(`/api/organizations/${state.organizationId}/direct-conversations`);
}

// Channels had no per-user read-marker before Phase 3 (unlike DMs' direct_conversation_members.
// last_read_at); mirrors the DM read call below against the new channel_reads table.
export async function markChannelRead(channelId) {
  if (!channelId) return;
  try { await api(`/api/channels/${channelId}/read`, { method: 'POST', silent: true }); } catch { /* best-effort */ }
}

// Aggregate "my total unread message count" (channels + DMs combined) — deliberately separate
// from state.unreadNotificationCount; messages never post into the general notifications table
// (Phase 3, item 11/19), so they need their own counter fed from their own endpoint.
export async function refreshUnreadMessageCount() {
  try {
    const summary = await api('/api/users/me/unread-messages', { silent: true });
    state.unreadMessageCount = Number(summary.total_unread_count || 0);
  } catch { /* best-effort; keep previous count on failure */ }
}

export async function openConversation(conversationId) {
  state.activeConversationId = conversationId;
  localStorage.setItem('orbit_conversation_id', conversationId);
  state.directMessages = conversationId ? await api(`/api/direct-conversations/${conversationId}/messages`) : [];
  connectDmStream(conversationId);
  if (conversationId) {
    try { await api(`/api/direct-conversations/${conversationId}/read`, { method: 'POST' }); } catch {}
    const conversation = state.directConversations.find(item => Number(item.id) === Number(conversationId));
    if (conversation) conversation.unread_count = 0;
  }
}

// --- Thread replies (Phase 3, item 18) --------------------------------------------------------
// A minimal "Reply" action on each top-level message opens a small panel showing just that
// message's replies, ordered oldest-first, fetched via the ?parent_message_id= filter added to
// the existing GET .../messages endpoints. New replies post through the SAME send endpoint as a
// normal message (with parent_message_id set) and arrive back through the SAME per-conversation
// SSE hub (channelHub/dmHub) — see receiveMessage/receiveDirectMessage above, which route an
// incoming reply into this panel when it's open for that exact parent, instead of the main feed.

function threadEndpoint(kind, conversationId) {
  return kind === 'channel' ? `/api/channels/${conversationId}/messages` : `/api/direct-conversations/${conversationId}/messages`;
}

function appendThreadReply(message) {
  if (!openThread) return;
  const feed = openThread.overlay.querySelector('#threadReplyFeed');
  if (!feed || feed.querySelector(`[data-message-id="${message.id}"]`)) return;
  feed.querySelector('.empty')?.remove();
  feed.insertAdjacentHTML('beforeend', messageMarkup(message, { insideThread: true }));
  feed.scrollTop = feed.scrollHeight;
  bumpReplyCountBadge(document.getElementById(openThread.kind === 'channel' ? 'messageFeed' : 'directMessageFeed'), message.parent_message_id);
}

export async function openThreadDialog(kind, conversationId, parentMessage) {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<section class="dialog-card compact-dialog"><div class="dialog-head"><h2 id="threadDialogTitle">Thread</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <div class="comment-item" style="margin-bottom:10px">${messageMarkup(parentMessage, { insideThread: true })}</div>
    <div id="threadReplyFeed" class="comment-feed"><div class="small muted">Loading replies…</div></div>
    <form id="threadReplyForm" class="comment-form"><textarea name="body" placeholder="Reply in thread..." required></textarea><button class="primary" type="submit">Reply</button></form>
  </section>`;
  mountDialog(overlay, 'threadDialogTitle');
  openThread = { kind, conversationId, parentId: parentMessage.id, overlay };
  overlay._onClose = () => { openThread = null; };

  try {
    const replies = await api(`${threadEndpoint(kind, conversationId)}?parent_message_id=${parentMessage.id}`);
    const feed = overlay.querySelector('#threadReplyFeed');
    if (feed) { feed.innerHTML = replies.map(item => messageMarkup(item, { insideThread: true })).join('') || '<div class="empty small">No replies yet.</div>'; feed.scrollTop = feed.scrollHeight; }
  } catch {
    const feed = overlay.querySelector('#threadReplyFeed');
    if (feed) feed.innerHTML = '<div class="small muted">Could not load replies.</div>';
  }

  overlay.querySelector('#threadReplyForm').addEventListener('submit', async event => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const body = new FormData(formElement).get('body');
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    try {
      const created = await api(threadEndpoint(kind, conversationId), { method: 'POST', body: JSON.stringify({ body, parent_message_id: parentMessage.id }) });
      formElement.reset();
      appendThreadReply(created);
      if (kind === 'channel') state.messages.push(created); else state.directMessages.push(created);
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
}

export function closeThreadDialog() {
  if (openThread) closeDialog(openThread.overlay);
}
