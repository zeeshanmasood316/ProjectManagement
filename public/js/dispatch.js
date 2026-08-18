import { state, $, $$, mainContent, presenceSelect } from './state.js';
import { escapeHtml, statusMarkup, initials, canManage, isWorkerTier, currentRole } from './format.js';
import { enhanceAiFields, renderWorkspaceError } from './ui.js';
import { messageStream, setMessageStreamStatus } from './messaging.js';
import { renderChat } from './views/chat.js';
import { renderMembers, applyMemberFilters } from './views/members.js';
import { renderProfile, renderNotifications, renderActivity, renderSettings } from './views/profile.js';
import { renderDashboard } from './views/dashboard.js';
import { renderIntake } from './views/intake.js';
import { renderProjects } from './views/projects.js';
import { renderWork, renderMeeting, renderRisks, renderChanges, renderReport } from './views/work-breakdown.js';
import { renderAdmin, renderTeamsHub } from './views/teams.js';

export function updateShell() {
  const role = currentRole();
  const currentMember = state.members.find(member => Number(member.user_id) === Number(state.user.id)) || { ...state.user, current_status: state.presence?.current_status };
  $('#sidebarUserName').innerHTML = `${escapeHtml(state.user.full_name)} ${statusMarkup(currentMember, true)}`;
  $('#sidebarUserRole').textContent = `${role} · ${currentMember.status_label || 'Available'}`;
  $('#userAvatar').innerHTML = `${state.user.avatar_url ? `<img src="${escapeHtml(state.user.avatar_url)}" alt="">` : ''}<span>${escapeHtml(initials(state.user.full_name))}</span><i class="presence-dot ${escapeHtml(currentMember.current_status || 'offline')}"></i>`;
  $('#headerAvatar').innerHTML = `${state.user.avatar_url ? `<img src="${escapeHtml(state.user.avatar_url)}" alt="">` : ''}<span>${escapeHtml(initials(state.user.full_name))}</span>`;
  $('#workspaceEyebrow').textContent = state.organization.name.toUpperCase();
  presenceSelect.value = state.presence?.status_key || 'available';
  const navBadge = $('#navNotificationBadge');
  if (navBadge) { navBadge.textContent = String(state.unreadNotificationCount); navBadge.classList.toggle('hidden', !state.unreadNotificationCount); }
  const messageBadge = $('#navMessageBadge');
  if (messageBadge) { messageBadge.textContent = String(state.unreadMessageCount); messageBadge.classList.toggle('hidden', !state.unreadMessageCount); }
  $$('[data-manager]').forEach(button => button.classList.toggle('hidden', !canManage()));
  $$('[data-admin]').forEach(button => button.classList.toggle('hidden', !canManage()));
  $$('[data-hide-worker]').forEach(button => button.classList.toggle('hidden', isWorkerTier()));
}

export const viewTitles = {
  chat: 'Channel', members: 'People', profile: 'Profile', notifications: 'Notifications', activity: 'Account Activity', settings: 'Settings',
  dashboard: 'Dashboard', intake: 'New project', projects: 'Projects', work: 'Work Breakdown', meeting: 'Meeting Notes',
  risks: 'Risk & Decisions', changes: 'Change Control', report: 'Reports & export', admin: 'Admin dashboard', teams: 'Teams'
};

export function render() {
  try {
    $$('#mainNav button').forEach(button => {
      const active = button.dataset.view === state.view;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    $('#viewTitle').textContent = viewTitles[state.view] || 'Workspace';
    $('#projectPickerWrap').classList.toggle('hidden', ['chat', 'members', 'profile', 'notifications', 'activity', 'settings', 'admin', 'intake', 'projects', 'teams'].includes(state.view));
    const views = {
      chat: renderChat, members: renderMembers, profile: renderProfile, notifications: renderNotifications,
      activity: renderActivity, settings: renderSettings, dashboard: renderDashboard, intake: renderIntake,
      projects: renderProjects, work: renderWork, meeting: renderMeeting, risks: renderRisks, changes: renderChanges,
      report: renderReport, admin: renderAdmin, teams: renderTeamsHub
    };
    mainContent.innerHTML = (views[state.view] || renderDashboard)();
    if (state.view === 'chat') {
      requestAnimationFrame(() => { const feed = $('#messageFeed'); if (feed) feed.scrollTop = feed.scrollHeight; });
      setMessageStreamStatus(messageStream ? messageStream.readyState === 1 : null);
    }
    if (state.view === 'members') requestAnimationFrame(applyMemberFilters);
    requestAnimationFrame(() => enhanceAiFields(mainContent));
  } catch (error) {
    renderWorkspaceError(error, 'retry-render');
  }
}

export const aiStatusBadge = () => `<span class="ai-status ${state.aiStatus?.enabled ? 'connected' : 'fallback'}" title="${escapeHtml(state.aiStatus?.model || '')}">✨ ${state.aiStatus?.enabled ? 'AI connected' : 'AI local mode'}</span>`;
export const pageHead = (title, subtitle, actions = '') => `<div class="page-head"><div><h2>${title}</h2><p>${subtitle}</p></div><div class="actions">${aiStatusBadge()}${actions}</div></div>`;

export function noProject() {
  return `<div class="card empty">No project exists in this organization. ${canManage() ? 'Use “New project” to create one.' : 'Ask a manager to create a project.'}</div>`;
}
