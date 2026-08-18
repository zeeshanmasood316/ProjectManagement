import { state } from '../state.js';
import { escapeHtml, canManage } from '../format.js';
import { messageMarkup } from '../messaging.js';

export function chatModeTabs() {
  return `<div class="tabbar" role="tablist" aria-label="Messaging mode">
    <button type="button" role="tab" aria-selected="${state.chatMode === 'channels'}" class="${state.chatMode === 'channels' ? 'active' : ''}" data-action="set-chat-mode" data-mode="channels">Channels</button>
    <button type="button" role="tab" aria-selected="${state.chatMode === 'direct'}" class="${state.chatMode === 'direct' ? 'active' : ''}" data-action="set-chat-mode" data-mode="direct">Direct Messages${state.directConversations.some(item => item.unread_count) ? ' •' : ''}</button>
  </div>`;
}

export function renderChat() {
  if (state.chatMode === 'direct') return `${chatModeTabs()}${renderDirectMessagesPanel()}`;
  const channel = state.channels.find(item => Number(item.id) === Number(state.channelId));
  return `${chatModeTabs()}<div class="chat-layout">
    <aside class="channel-panel">
      <h3>Channels</h3>
      <div class="channel-list">
        ${state.channels.map(item => `<button data-action="select-channel" data-id="${item.id}" class="${Number(item.id) === Number(state.channelId) ? 'active' : ''}"># ${escapeHtml(item.name)} <span class="small">(${item.message_count})</span></button>`).join('') || '<div class="empty">No channels</div>'}
      </div>
      ${canManage() ? `<form id="channelForm" class="stack compact" style="margin-top:18px"><label>New channel<input name="name" placeholder="design-team" required></label><label>Topic<input name="topic" placeholder="Optional channel topic"></label><button class="secondary" type="submit">Create channel</button></form>` : ''}
    </aside>
    <section class="message-panel">
      ${channel ? `<header class="channel-head"><h2># ${escapeHtml(channel.name)}</h2><div class="small muted">${escapeHtml(channel.topic || 'Team discussion')} <span id="chatConnectionStatus" class="small connection-status hidden"></span></div></header>
      <div id="messageFeed" class="message-feed">
        ${state.messages.map(messageMarkup).join('') || '<div class="empty" style="margin-top:20px">No messages yet. Start the conversation.</div>'}
      </div>
      <form id="messageForm" class="message-form"><textarea name="body" required placeholder="Message #${escapeHtml(channel.name)}"></textarea><button class="primary" type="submit">Send</button></form>` : '<div class="empty">Select or create a channel.</div>'}
    </section>
  </div>`;
}

export function renderDirectMessagesPanel() {
  const activeConversation = state.directConversations.find(item => Number(item.id) === Number(state.activeConversationId));
  return `<div class="chat-layout">
    <aside class="channel-panel">
      <div class="page-head compact-head" style="margin-bottom:8px"><h3>Direct Messages</h3><button class="secondary" type="button" data-action="open-new-dm">+ New</button></div>
      <div class="channel-list">
        ${state.directConversations.map(conversation => `<button data-action="select-conversation" data-id="${conversation.id}" class="${Number(conversation.id) === Number(state.activeConversationId) ? 'active' : ''}">${escapeHtml(conversation.other_user?.full_name || 'Unknown')}${conversation.unread_count ? `<span class="dm-unread-badge">${conversation.unread_count}</span>` : ''}</button>`).join('') || '<div class="empty">No conversations yet.</div>'}
      </div>
    </aside>
    <section class="message-panel">
      ${activeConversation ? `<header class="channel-head"><h2>${escapeHtml(activeConversation.other_user?.full_name || 'Unknown')}</h2><div class="small muted">@${escapeHtml(activeConversation.other_user?.username || '')} <span id="dmConnectionStatus" class="small connection-status hidden"></span></div></header>
      <div id="directMessageFeed" class="message-feed">
        ${state.directMessages.map(messageMarkup).join('') || '<div class="empty" style="margin-top:20px">No messages yet. Say hello.</div>'}
      </div>
      <form id="directMessageForm" class="message-form"><textarea name="body" required placeholder="Message ${escapeHtml(activeConversation.other_user?.full_name || '')}"></textarea><button class="primary" type="submit">Send</button></form>` : '<div class="empty">Select a conversation, or start a new one.</div>'}
    </section>
  </div>`;
}
