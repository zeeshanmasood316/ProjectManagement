import { state, organizationSelect, mobileOrganizationSelect, projectSelect } from './state.js';
import { api } from './api.js';
import { escapeHtml, canManage } from './format.js';
import { setWorkspaceBusy, applyTheme, toast, renderWorkspaceError } from './ui.js';
import { heartbeat } from './presence.js';
import { loadMessages, loadDirectConversations, connectMessageStream, openConversation } from './messaging.js';
import { updateShell, render } from './dispatch.js';
import { clearWorkspaceSelection, showSetup } from './auth-screens.js';

export async function loadWorkspace() {
  const organizationId = state.organizationId;
  setWorkspaceBusy(true);
  try {
    await heartbeat(false);
    [state.organization, state.members, state.projects, state.channels, state.aiStatus, state.departments, state.teams, state.jobRoles, state.managerWorkspace] = await Promise.all([
      api(`/api/organizations/${organizationId}`),
      api(`/api/organizations/${organizationId}/members`),
      api(`/api/organizations/${organizationId}/projects`),
      api(`/api/organizations/${organizationId}/channels`),
      api('/api/ai/status'),
      api(`/api/organizations/${organizationId}/departments`),
      api(`/api/organizations/${organizationId}/teams`),
      api(`/api/organizations/${organizationId}/job-roles`),
      api(`/api/organizations/${organizationId}/manager-workspace`)
    ]);
    state.orgDashboard = await api(`/api/organizations/${organizationId}/dashboard`);
    try {
      state.invitations = canManage() ? await api(`/api/organizations/${organizationId}/invitations`) : [];
    } catch {
      state.invitations = [];
    }
    const [notificationData, sessions] = await Promise.all([
      api('/api/users/me/notifications?limit=100'),
      api('/api/users/me/sessions')
    ]);
    state.notifications = notificationData.items || [];
    state.unreadNotificationCount = Number(notificationData.unread_count || 0);
    state.sessions = sessions || [];
    if (state.view === 'activity') state.activity = await api('/api/users/me/activity?limit=100');
    const activeOrganizations = state.organizations.filter(item => item.membership_status === 'active');
    const organizationOptions = activeOrganizations.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
    organizationSelect.innerHTML = organizationOptions;
    mobileOrganizationSelect.innerHTML = organizationOptions;
    organizationSelect.value = String(organizationId);
    mobileOrganizationSelect.value = String(organizationId);
    projectSelect.innerHTML = state.projects.length
      ? state.projects.map(project => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join('')
      : '<option value="">No projects</option>';
    if (!state.projects.some(project => Number(project.id) === Number(state.projectId))) state.projectId = state.projects[0] ? Number(state.projects[0].id) : null;
    projectSelect.value = state.projectId ? String(state.projectId) : '';
    if (state.projectId) localStorage.setItem('orbit_project_id', state.projectId); else localStorage.removeItem('orbit_project_id');
    if (!state.channels.some(channel => Number(channel.id) === Number(state.channelId))) state.channelId = state.channels[0] ? Number(state.channels[0].id) : null;
    if (state.channelId) localStorage.setItem('orbit_channel_id', state.channelId); else localStorage.removeItem('orbit_channel_id');
    await Promise.all([loadProjectData(), loadMessages(), loadDirectConversations()]);
    connectMessageStream(state.channelId);
    if (state.chatMode === 'direct' && state.activeConversationId && state.directConversations.some(item => Number(item.id) === Number(state.activeConversationId))) {
      await openConversation(state.activeConversationId);
    }
    updateShell();
    render();
  } catch (error) {
    renderWorkspaceError(error);
    throw error;
  } finally {
    setWorkspaceBusy(false);
  }
}

export async function loadProjectData() {
  if (!state.projectId) {
    Object.assign(state, { project: null, tasks: [], risks: [], decisions: [], changes: [], suggestions: [], report: null, milestones: [], stories: [], boardColumns: [] });
    return;
  }
  const id = state.projectId;
  [state.project, state.tasks, state.risks, state.decisions, state.changes, state.suggestions, state.report, state.milestones, state.stories, state.boardColumns] = await Promise.all([
    api(`/api/projects/${id}`), api(`/api/projects/${id}/tasks`), api(`/api/projects/${id}/risks`),
    api(`/api/projects/${id}/decisions`), api(`/api/projects/${id}/changes`),
    api(`/api/projects/${id}/suggestions`), api(`/api/projects/${id}/report`), api(`/api/projects/${id}/milestones`), api(`/api/projects/${id}/stories`),
    api(`/api/projects/${id}/board-columns`)
  ]);
}

export async function refreshCurrent() {
  const me = await api('/api/auth/me');
  state.user = me.user;
  state.presence = me.presence || state.presence;
  state.settings = me.settings || state.settings;
  state.unreadNotificationCount = Number(me.unread_notification_count || 0);
  applyTheme(state.settings?.theme || 'light');
  state.organizations = me.organizations;
  state.workspaceAccess = me.workspace_access;
  const activeOrganizations = state.organizations.filter(item => item.membership_status === 'active');
  if (!activeOrganizations.some(item => Number(item.id) === Number(state.organizationId))) {
    state.organizationId = activeOrganizations[0] ? Number(activeOrganizations[0].id) : null;
  }
  if (!state.organizationId) {
    clearWorkspaceSelection();
    showSetup();
    return;
  }
  localStorage.setItem('orbit_organization_id', state.organizationId);
  await loadWorkspace();
  toast('Workspace refreshed.');
}

export async function downloadExport(format) {
  const path = format === 'csv' ? `/api/projects/${state.projectId}/tasks.csv` : `/api/projects/${state.projectId}/export.json`;
  const response = await fetch(path, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!response.ok) throw new Error('Export failed');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = format === 'csv' ? `project-${state.projectId}-tasks.csv` : `project-${state.projectId}-export.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
