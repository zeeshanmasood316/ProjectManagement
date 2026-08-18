import { state } from '../state.js';
import { escapeHtml, badge, statusMarkup, avatarMarkup, memberForUser, currentRole, statusPresets, notificationIcon, relativeTime, sessionDevice, presenceLabel } from '../format.js';
import { resolvedTheme } from '../ui.js';
import { pageHead } from '../dispatch.js';

export function statusOptions(selected) {
  return Object.entries(statusPresets).map(([key, item]) => `<option value="${key}" ${selected === key ? 'selected' : ''}>${escapeHtml(item.emoji)} ${escapeHtml(item.label)}</option>`).join('');
}

export function renderProfile() {
  const member = memberForUser(state.user.id) || { ...state.user, role: currentRole(), department: 'General', ...state.presence };
  return `${pageHead('Your profile', 'Manage your identity and the status shown beside your name across Orbit.')}
  <div class="profile-layout">
    <section class="card profile-hero-card">
      ${avatarMarkup({ ...member, ...state.user, current_status: member.current_status || state.presence?.current_status }, 'profile-hero-avatar')}
      <div class="profile-hero-copy"><div class="name-with-status"><h2>${escapeHtml(state.user.full_name)}</h2>${statusMarkup(member)}</div><p>@${escapeHtml(state.user.username)} · ${escapeHtml(state.user.email)}</p><div class="member-card-badges">${badge(member.role || currentRole())} ${badge(member.department || 'General')}</div>${member.custom_status ? `<p class="profile-status-note">${escapeHtml(member.custom_status)}</p>` : ''}</div>
    </section>
    <form id="profilePageForm" class="card stack">
      <div><h3>Profile details</h3><p class="muted">Your name and avatar are visible to members of every organization you join.</p></div>
      <label>Full name<input name="full_name" value="${escapeHtml(state.user.full_name)}" minlength="2" maxlength="120" required></label>
      <label>Username<input value="${escapeHtml(state.user.username)}" disabled><small>Usernames cannot be changed in this iteration.</small></label>
      <label>Email<input value="${escapeHtml(state.user.email)}" disabled></label>
      <label>Avatar image URL<input name="avatar_url" type="url" value="${escapeHtml(state.user.avatar_url || '')}" placeholder="https://..."><small>Optional HTTPS image; initials are used when blank.</small></label>
      <button class="primary" type="submit">Save profile</button>
    </form>
    <form id="statusPageForm" class="card stack">
      <div><h3>Workspace status</h3><p class="muted">This badge appears beside your name in channels, member cards, task ownership, and the sidebar.</p></div>
      <label>Status<select name="status_key">${statusOptions(state.presence?.status_key || 'available')}</select></label>
      <div class="form-grid custom-status-fields ${state.presence?.status_key === 'custom' ? '' : 'hidden'}" id="customStatusFields">
        <label>Custom label<input name="status_label" maxlength="50" value="${escapeHtml(state.presence?.status_key === 'custom' ? state.presence.status_label : '')}" placeholder="e.g. Client site"></label>
        <label>Emoji<input name="status_emoji" maxlength="8" value="${escapeHtml(state.presence?.status_key === 'custom' ? state.presence.status_emoji : '💬')}" placeholder="💬"></label>
      </div>
      <label>Status note<input name="custom_status" maxlength="120" value="${escapeHtml(state.presence?.custom_status || '')}" placeholder="e.g. Available after 3 PM"></label>
      <button class="primary" type="submit">Update status</button>
    </form>
  </div>`;
}

export function renderNotifications() {
  return `${pageHead('Notifications', 'Invitations, approvals, mentions, and important workspace updates.', state.unreadNotificationCount ? '<button class="secondary" data-action="read-all-notifications">Mark all as read</button>' : '')}
  <section class="notification-list">
    ${state.notifications.map(item => `<article class="card notification-item ${item.read_at ? '' : 'unread'}">
      <div class="notification-icon">${notificationIcon(item.notification_type)}</div>
      <div class="notification-copy"><div class="notification-title"><strong>${escapeHtml(item.title)}</strong>${item.organization_name ? `<span>${escapeHtml(item.organization_name)}</span>` : ''}</div><p>${escapeHtml(item.body)}</p><small>${escapeHtml(new Date(item.created_at).toLocaleString())}</small></div>
      <div class="notification-actions">${!item.read_at ? `<button class="secondary" data-action="mark-notification-read" data-id="${item.id}">Mark read</button>` : '<span class="read-label">Read</span>'}${item.action_view ? `<button class="ghost-action" data-action="open-notification" data-view="${escapeHtml(item.action_view)}" data-id="${item.id}">Open</button>` : ''}</div>
    </article>`).join('') || '<div class="card empty">No notifications yet.</div>'}
  </section>`;
}

export function renderActivity() {
  return `${pageHead('Account activity', 'A private history of sign-ins, profile changes, settings, invitations, and membership events.', '<button class="secondary" data-action="refresh-activity">Refresh activity</button>')}
  <section class="card activity-timeline">
    ${state.activity.map(item => `<article class="activity-item"><div class="activity-marker">${notificationIcon(item.activity_type === 'signed_in' ? 'activity' : 'workspace')}</div><div><div class="activity-title"><strong>${escapeHtml(item.title)}</strong>${item.organization_name ? `<span>${escapeHtml(item.organization_name)}</span>` : ''}</div>${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ''}<small>${escapeHtml(new Date(item.created_at).toLocaleString())}</small></div></article>`).join('') || '<div class="empty">No account activity has been recorded yet.</div>'}
  </section>`;
}

export function renderSettings() {
  const settings = state.settings || { theme: 'light', workspace_notifications: 1, mention_notifications: 1, invitation_notifications: 1, activity_notifications: 1 };
  const activeSessions = state.sessions || [];
  return `${pageHead('Settings', 'Control appearance, presence, notifications, and account security.')}
  <form id="settingsForm" class="settings-grid">
    <section class="card stack"><div><h3>Appearance</h3><p class="muted">Choose Light or Dark mode. You can also use the quick theme button in the top bar.</p></div><label>Theme<select name="theme"><option value="light" ${resolvedTheme(settings.theme) === 'light' ? 'selected' : ''}>☀️ Light</option><option value="dark" ${resolvedTheme(settings.theme) === 'dark' ? 'selected' : ''}>🌙 Dark</option></select></label><div class="theme-preview-row two-options"><span class="theme-preview light-preview">☀️ Light</span><span class="theme-preview dark-preview">🌙 Dark</span></div></section>
    <section class="card stack"><div><h3>Presence</h3><p class="muted">Presence is the small live dot. Your workspace status is the emoji badge beside your name.</p></div><label>Presence mode<select name="presence_mode">${[['auto','Automatic'],['online','Always online'],['away','Away'],['dnd','Do not disturb'],['offline','Appear offline']].map(([value,label]) => `<option value="${value}" ${state.presence?.presence_mode === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><div class="notice">Current live presence: <strong>${escapeHtml(presenceLabel(state.presence?.current_status))}</strong></div></section>
    <section class="card stack settings-wide"><div><h3>Notification preferences</h3><p class="muted">Choose which updates appear in your private Notifications page.</p></div>
      <label class="toggle-row"><span><strong>Workspace updates</strong><small>Important organization and membership changes.</small></span><input type="checkbox" name="workspace_notifications" ${Number(settings.workspace_notifications) ? 'checked' : ''}></label>
      <label class="toggle-row"><span><strong>Mentions</strong><small>Messages containing your @username.</small></span><input type="checkbox" name="mention_notifications" ${Number(settings.mention_notifications) ? 'checked' : ''}></label>
      <label class="toggle-row"><span><strong>Invitations</strong><small>Organization invitations, approvals, and rejections.</small></span><input type="checkbox" name="invitation_notifications" ${Number(settings.invitation_notifications) ? 'checked' : ''}></label>
      <label class="toggle-row"><span><strong>Account activity</strong><small>Membership and access-related alerts.</small></span><input type="checkbox" name="activity_notifications" ${Number(settings.activity_notifications) ? 'checked' : ''}></label>
    </section>
    <div class="settings-save"><button class="primary" type="submit">Save settings</button></div>
  </form>
  <section class="card session-card">
    <div class="page-head compact-head"><div><h3>Active sessions</h3><p>Review devices signed into your account and revoke access you no longer recognize.</p></div>${activeSessions.length > 1 ? '<button class="danger" type="button" data-action="revoke-other-sessions">Sign out other devices</button>' : ''}</div>
    <div class="session-list">${activeSessions.map(session => `<article class="session-item"><div class="session-icon" aria-hidden="true">▣</div><div><strong>${escapeHtml(sessionDevice(session.user_agent))}${session.current ? ' <span class="current-session">Current</span>' : ''}</strong><p>${escapeHtml(session.ip_address || 'Unknown IP')} · ${escapeHtml(relativeTime(session.last_seen_at))}</p><small>Expires ${escapeHtml(new Date(session.expires_at).toLocaleString())}</small></div><button class="secondary" type="button" data-action="revoke-session" data-id="${escapeHtml(session.id)}">${session.current ? 'Sign out' : 'Revoke'}</button></article>`).join('') || '<div class="empty">No active sessions found.</div>'}</div>
  </section>`;
}
