import { state, mainContent } from './state.js';
import { api } from './api.js';
import { toast, toggleMobileNavigation, renderWorkspaceError } from './ui.js';
import { updateShell, render } from './dispatch.js';
import { resetIntakeState } from './views/intake.js';
import { loadWorkspace, loadProjectData } from './workspace-loader.js';

export async function switchView(view) {
  try {
    state.view = view;
    if (state.view === 'notifications') {
      const result = await api('/api/users/me/notifications?limit=100');
      state.notifications = result.items || [];
      state.unreadNotificationCount = Number(result.unread_count || 0);
      updateShell();
    }
    if (state.view === 'activity') state.activity = await api('/api/users/me/activity?limit=100');
    if (state.view === 'dashboard') state.orgDashboard = await api(`/api/organizations/${state.organizationId}/dashboard`);
    if (state.view === 'intake') resetIntakeState();
    render();
    toggleMobileNavigation(false);
    mainContent.focus();
  } catch (error) { toast(error.message, true); }
}

export async function switchOrganization(organizationId) {
  state.organizationId = Number(organizationId);
  state.projectId = null;
  state.channelId = null;
  state.memberSearch = '';
  state.memberDepartment = 'all';
  state.memberPresence = 'all';
  localStorage.setItem('orbit_organization_id', state.organizationId);
  await loadWorkspace();
  toast(`Switched to ${state.organization.name}.`);
}

export async function switchProject(projectId, view = null) {
  try {
    state.projectId = Number(projectId) || null;
    if (state.projectId) localStorage.setItem('orbit_project_id', state.projectId); else localStorage.removeItem('orbit_project_id');
    if (view) state.view = view;
    await loadProjectData();
    updateShell();
    render();
  } catch (error) { renderWorkspaceError(error, 'retry-workspace'); toast(error.message, true); }
}
