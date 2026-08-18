import { state, $, authScreen, setupScreen, appShell } from './state.js';
import { api } from './api.js';
import { escapeHtml, badge } from './format.js';
import { applyTheme, setWorkspaceBusy, toast } from './ui.js';
import { startPresenceHeartbeat, stopPresenceHeartbeat } from './presence.js';
import { disconnectMessageStream, disconnectDmStream } from './messaging.js';
import { loadWorkspace } from './workspace-loader.js';
import { connectUserEventStream, disconnectUserEventStream } from './user-events.js';

export function saveToken() {
  // New sessions use an HttpOnly SameSite cookie. Remove legacy localStorage tokens.
  state.token = '';
  localStorage.removeItem('orbit_token');
}

export function logout(showMessage = true) {
  stopPresenceHeartbeat();
  disconnectMessageStream();
  disconnectDmStream();
  disconnectUserEventStream();
  const token = state.token;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  fetch('/api/auth/logout', { method: 'POST', headers, credentials: 'same-origin' }).catch(() => {});
  localStorage.removeItem('orbit_token');
  localStorage.removeItem('orbit_organization_id');
  localStorage.removeItem('orbit_project_id');
  localStorage.removeItem('orbit_channel_id');
  localStorage.removeItem('orbit_onboarding_deferred');
  Object.assign(state, {
    token: '', user: null, presence: null, settings: null, notifications: [], activity: [], sessions: [], unreadNotificationCount: 0, organizations: [], workspaceAccess: null, onboardingDeferred: false, organizationId: null, organization: null,
    members: [], invitations: [], myInvitations: [], projects: [], projectId: null,
    project: null, tasks: [], risks: [], decisions: [], changes: [], suggestions: [],
    report: null, channels: [], channelId: null, messages: [], memberSearch: '', memberDepartment: 'all', memberPresence: 'all', view: 'chat'
  });
  showScreen('auth');
  if (showMessage) toast('You have been logged out.');
}

export function showScreen(name) {
  authScreen.classList.toggle('hidden', name !== 'auth');
  setupScreen.classList.toggle('hidden', name !== 'setup');
  appShell.classList.toggle('hidden', name !== 'app');
}

export function switchAuthTab(tab) {
  const login = tab === 'login';
  $('#authTabs').classList.remove('hidden');
  $('#forgotPasswordForm').classList.add('hidden');
  $('#loginTab').classList.toggle('active', login);
  $('#registerTab').classList.toggle('active', !login);
  $('#loginTab').setAttribute('aria-selected', String(login));
  $('#registerTab').setAttribute('aria-selected', String(!login));
  $('#loginForm').classList.toggle('hidden', !login);
  $('#registerForm').classList.toggle('hidden', login);
  requestAnimationFrame(() => $(login ? '#loginForm input' : '#registerForm input')?.focus());
}

export function showForgotPassword() {
  $('#authTabs').classList.add('hidden');
  $('#loginForm').classList.add('hidden');
  $('#registerForm').classList.add('hidden');
  $('#forgotPasswordForm').classList.remove('hidden');
  $('#resetPasswordFields').classList.add('hidden');
  const resetForm = $('#forgotPasswordForm');
  resetForm.querySelector('[name="code"]').required = false;
  resetForm.querySelector('[name="password"]').required = false;
  requestAnimationFrame(() => $('#resetEmail')?.focus());
}

export function clearWorkspaceSelection() {
  state.organizationId = null;
  state.organization = null;
  state.projectId = null;
  state.project = null;
  state.channelId = null;
  state.members = [];
  state.projects = [];
  state.channels = [];
  state.messages = [];
  localStorage.removeItem('orbit_organization_id');
  localStorage.removeItem('orbit_project_id');
  localStorage.removeItem('orbit_channel_id');
}

export function setOnboardingDeferred(value) {
  state.onboardingDeferred = Boolean(value);
  if (state.onboardingDeferred) localStorage.setItem('orbit_onboarding_deferred', '1');
  else localStorage.removeItem('orbit_onboarding_deferred');
}

export async function bootstrap() {
  setWorkspaceBusy(true, 'Checking your account…');
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    // Open the per-user stream as soon as we know the user is authenticated — even before
    // workspace access is confirmed below, since someone stuck on the setup screen waiting for
    // CEO/admin approval still needs invitation_updated to arrive live (item 10's requirement).
    // Kept open for the whole session; only closed on logout().
    connectUserEventStream();
    state.presence = me.presence || null;
    state.settings = me.settings || state.settings || { theme: 'light' };
    state.unreadNotificationCount = Number(me.unread_notification_count || 0);
    applyTheme(state.settings.theme || 'light');
    state.organizations = me.organizations;
    startPresenceHeartbeat();
    state.workspaceAccess = me.workspace_access || null;
    state.myInvitations = await api('/api/invitations/me');
    const activeOrganizations = state.organizations.filter(item => item.membership_status === 'active');
    const canAccessWorkspace = state.workspaceAccess
      ? state.workspaceAccess.can_access_workspace
      : activeOrganizations.length > 0;

    if (!canAccessWorkspace || !activeOrganizations.length) {
      clearWorkspaceSelection();
      showSetup();
      return;
    }

    setOnboardingDeferred(false);
    if (!activeOrganizations.some(item => Number(item.id) === Number(state.organizationId))) {
      state.organizationId = Number(activeOrganizations[0].id);
    }
    localStorage.setItem('orbit_organization_id', state.organizationId);
    showScreen('app');
    await loadWorkspace();
  } catch (error) {
    if (error.status === 401) {
      state.user = null;
      showScreen('auth');
      localStorage.removeItem('orbit_token');
    } else if (state.user) {
      showSetup();
      toast(error.message, true);
    } else {
      showScreen('auth');
      toast(error.message, true);
    }
  } finally {
    setWorkspaceBusy(false);
  }
}

export function showSetup() {
  showScreen('setup');
  $('#setupUser').textContent = `${state.user.full_name} (@${state.user.username})`;
  renderSetupInvitations();
  renderOnboardingState();
}

export function renderOnboardingState() {
  $('#setupOptions').classList.toggle('hidden', state.onboardingDeferred);
  $('#setupDeferredState').classList.toggle('hidden', !state.onboardingDeferred);
  const pendingCount = Number(state.workspaceAccess?.pending_invitation_count || state.myInvitations.length || 0);
  $('#deferredAccessMessage').textContent = pendingCount
    ? `You have ${pendingCount} pending invitation${pendingCount === 1 ? '' : 's'}. Check approval to unlock the workspace once membership becomes active.`
    : 'Create an organization or receive an invitation from an organization manager to unlock the workspace.';
}

export function renderSetupInvitations() {
  const container = $('#setupInvitations');
  const openInvitations = state.myInvitations.filter(invitation => ['invited', 'awaiting_approval'].includes(invitation.status));
  if (!openInvitations.length) {
    container.innerHTML = '<div class="empty invitation-empty"><strong>No pending invitation</strong><span>Share your registered username or email with an organization manager.</span></div>';
    return;
  }
  container.innerHTML = openInvitations.map(invitation => `
    <div class="invitation-card">
      <strong>${escapeHtml(invitation.organization_name)}</strong>
      <p class="small muted">Role: ${escapeHtml(invitation.proposed_role)} · ${escapeHtml(invitation.proposed_department || 'General')} · invited by ${escapeHtml(invitation.invited_by_name)}</p>
      <div>${badge(invitation.status)}</div>
      ${invitation.status === 'invited' ? `<div class="actions" style="margin-top:10px"><button class="primary" data-setup-action="accept-invite" data-id="${invitation.id}">Accept invitation</button><button class="secondary" data-setup-action="decline-invite" data-id="${invitation.id}">Decline</button></div>` : '<p class="small">Invitation accepted. Workspace remains locked until CEO/admin approval.</p>'}
    </div>`).join('');
}
