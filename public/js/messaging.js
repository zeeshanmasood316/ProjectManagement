import { state, $ } from './state.js';
import { api } from './api.js';
import { escapeHtml, avatarMarkup, statusMarkup } from './format.js';

export let messageStream = null;
export let messageStreamChannelId = null;
export let directMessageStream = null;
export let directMessageStreamConversationId = null;

export async function loadMessages() {
  state.messages = state.channelId ? await api(`/api/channels/${state.channelId}/messages`) : [];
}

export function messageMarkup(message) {
  const member = state.members.find(item => Number(item.user_id) === Number(message.user_id));
  return `<article class="message" data-message-id="${message.id}">${avatarMarkup({ ...message, ...(member || {}) })}<div><div class="message-meta"><strong>${escapeHtml(message.full_name)}</strong>${member ? statusMarkup(member, true) : ''}<small>@${escapeHtml(message.username)} · ${escapeHtml(new Date(message.created_at).toLocaleString())}</small></div><div class="message-body">${escapeHtml(message.body)}</div></div></article>`;
}

export function appendMessageToFeed(message) {
  const feed = $('#messageFeed');
  if (!feed || feed.querySelector(`[data-message-id="${message.id}"]`)) return;
  const empty = feed.querySelector('.empty');
  if (empty) empty.remove();
  feed.insertAdjacentHTML('beforeend', messageMarkup(message));
  feed.scrollTop = feed.scrollHeight;
}

export function receiveMessage(message) {
  if (Number(message.channel_id) !== Number(state.channelId)) return;
  if (state.messages.some(item => Number(item.id) === Number(message.id))) return;
  state.messages.push(message);
  if (state.view === 'chat') appendMessageToFeed(message);
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
  if (!feed || feed.querySelector(`[data-message-id="${message.id}"]`)) return;
  const empty = feed.querySelector('.empty');
  if (empty) empty.remove();
  feed.insertAdjacentHTML('beforeend', messageMarkup(message));
  feed.scrollTop = feed.scrollHeight;
}

export function receiveDirectMessage(message) {
  if (Number(message.conversation_id) !== Number(state.activeConversationId)) return;
  if (state.directMessages.some(item => Number(item.id) === Number(message.id))) return;
  state.directMessages.push(message);
  if (state.view === 'chat' && state.chatMode === 'direct') appendDirectMessageToFeed(message);
  const conversation = state.directConversations.find(item => Number(item.id) === Number(message.conversation_id));
  if (conversation) { conversation.last_message = message.body; conversation.last_message_at = message.created_at; }
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
