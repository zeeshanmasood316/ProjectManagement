// Entry point: imports every module (so their own top-level wiring, if any, runs), wires the
// remaining top-level/direct DOM listeners that don't naturally belong to one specific module
// (auth forms, setup screen, nav/org/project pickers, presence select, network/theme init),
// and finally bootstraps the app — mirroring the original app.js's top-to-bottom execution order.
import {
  state, $, organizationSelect, mobileOrganizationSelect, projectSelect,
  presenceSelect, mobileNavToggle, sidebarBackdrop, setupScreen
} from './state.js';
import { api } from './api.js';
import {
  toast, setButtonBusy, toggleMobileNavigation, updateThemeToggleButtons, updateNetworkStatus
} from './ui.js';
import {
  saveToken, switchAuthTab, showForgotPassword, logout, setOnboardingDeferred, bootstrap,
  renderSetupInvitations, renderOnboardingState
} from './auth-screens.js';
import { render, updateShell } from './dispatch.js';
import { switchView, switchOrganization, switchProject } from './navigation.js';
import { refreshCurrent } from './workspace-loader.js';
import { openOrganizationDialog } from './dialogs/org-team-dialogs.js';

// Side-effecting modules: importing them registers their own top-level DOM listeners.
import './search.js';
import './events.js';
import './dnd.js';

$('#loginTab').addEventListener('click', () => switchAuthTab('login'));
$('#registerTab').addEventListener('click', () => switchAuthTab('register'));
$('#forgotPasswordBtn').addEventListener('click', showForgotPassword);
$('#backToLoginBtn').addEventListener('click', () => switchAuthTab('login'));
$('#sendResetCodeBtn').addEventListener('click', async event => {
  const button = event.currentTarget;
  const formElement = $('#forgotPasswordForm');
  const email = new FormData(formElement).get('email');
  if (!email) { toast('Enter your email address first.', true); return; }
  setButtonBusy(button, true);
  try {
    const result = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
    $('#resetPasswordFields').classList.remove('hidden');
    const codeInput = formElement.querySelector('[name="code"]');
    const passwordInput = formElement.querySelector('[name="password"]');
    codeInput.required = true;
    passwordInput.required = true;
    if (result.dev_reset_code) codeInput.value = result.dev_reset_code;
    toast(result.dev_reset_code ? `Development reset code: ${result.dev_reset_code}` : 'Reset code sent. Check your email.');
    codeInput.focus();
  } catch (error) { toast(error.message, true); } finally { setButtonBusy(button, false); }
});
$('#setupLogout').addEventListener('click', () => logout());
$('#setupRefresh').addEventListener('click', () => bootstrap().then(() => toast('Approval status checked.')).catch(error => toast(error.message, true)));
$('#logoutBtn').addEventListener('click', () => logout());
$('#refreshBtn').addEventListener('click', () => refreshCurrent().catch(error => toast(error.message, true)));
$('#newOrganizationBtn').addEventListener('click', openOrganizationDialog);
$('#mobileNewOrganizationBtn').addEventListener('click', openOrganizationDialog);
mobileNavToggle?.addEventListener('click', () => toggleMobileNavigation());
sidebarBackdrop?.addEventListener('click', () => toggleMobileNavigation(false));
presenceSelect.addEventListener('change', async () => {
  if (presenceSelect.value === 'custom') {
    state.view = 'profile';
    render();
    toast('Add your custom label from Profile.');
    return;
  }
  try {
    state.presence = await api('/api/presence/me', { method: 'PATCH', body: JSON.stringify({ status_key: presenceSelect.value }) });
    if (state.organizationId) state.members = await api(`/api/organizations/${state.organizationId}/members`);
    updateShell();
    render();
    toast(`Status set to ${state.presence.status_emoji} ${state.presence.status_label}.`);
  } catch (error) { toast(error.message, true); }
});

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const submitter = event.submitter;
  setButtonBusy(submitter, true);
  try {
    const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier: form.get('identifier'), password: form.get('password') }) });
    saveToken(result.token);
    formElement.reset();
    await bootstrap();
    toast('Signed in successfully.');
  } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
});

$('#registerForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const submitter = event.submitter;
  setButtonBusy(submitter, true);
  try {
    const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ full_name: form.get('full_name'), username: form.get('username'), email: form.get('email'), password: form.get('password') }) });
    saveToken(result.token);
    formElement.reset();
    await bootstrap();
    toast('Your user ID has been created.');
  } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
});

$('#forgotPasswordForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const submitter = event.submitter;
  setButtonBusy(submitter, true);
  try {
    const result = await api('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ email: form.get('email'), code: form.get('code'), password: form.get('password') })
    });
    formElement.reset();
    $('#resetPasswordFields').classList.add('hidden');
    switchAuthTab('login');
    toast(result.message || 'Password updated. Sign in with your new password.');
  } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
});

$('#organizationForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const submitter = event.submitter;
  setButtonBusy(submitter, true);
  try {
    const organization = await api('/api/organizations', { method: 'POST', body: JSON.stringify({ name: form.get('name') }) });
    state.organizationId = Number(organization.id);
    localStorage.setItem('orbit_organization_id', state.organizationId);
    setOnboardingDeferred(false);
    formElement.reset();
    await bootstrap();
    toast('Organization created. Workspace access is now unlocked.');
  } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
});

setupScreen.addEventListener('click', async event => {
  const button = event.target.closest('[data-setup-action]');
  if (!button) return;
  const action = button.dataset.setupAction;
  setButtonBusy(button, true);

  try {
    if (action === 'defer-onboarding') {
      setOnboardingDeferred(true);
      renderOnboardingState();
      toast('Organization setup skipped for now. Workspace modules remain locked.');
      return;
    }
    if (action === 'show-onboarding-options') {
      setOnboardingDeferred(false);
      renderOnboardingState();
      return;
    }
    if (action === 'refresh-membership') {
      await bootstrap();
      toast('Organization access checked.');
      return;
    }
    if (!['accept-invite', 'decline-invite'].includes(action)) return;

    await api(`/api/invitations/${button.dataset.id}/${action === 'accept-invite' ? 'accept' : 'decline'}`, { method: 'POST' });
    const me = await api('/api/auth/me');
    state.organizations = me.organizations;
    state.workspaceAccess = me.workspace_access;
    state.myInvitations = await api('/api/invitations/me');
    renderSetupInvitations();
    renderOnboardingState();
    toast(action === 'accept-invite' ? 'Accepted. Workspace stays locked until CEO/admin approval.' : 'Invitation declined.');
  } catch (error) { toast(error.message, true); } finally { setButtonBusy(button, false); }
});

$('#mainNav').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  switchView(button.dataset.view);
});

$('#headerNotificationBtn').addEventListener('click', () => switchView('notifications'));
$('#sidebarProfileBtn').addEventListener('click', () => switchView('profile'));
$('#headerProfileBtn').addEventListener('click', () => switchView('profile'));

organizationSelect.addEventListener('change', () => switchOrganization(organizationSelect.value).catch(error => toast(error.message, true)));
mobileOrganizationSelect.addEventListener('change', () => switchOrganization(mobileOrganizationSelect.value).catch(error => toast(error.message, true)));

projectSelect.addEventListener('change', () => switchProject(projectSelect.value));

updateThemeToggleButtons();
updateNetworkStatus();
window.addEventListener('online', () => { updateNetworkStatus(); toast('Connection restored.'); refreshCurrent().catch(() => {}); });
window.addEventListener('offline', updateNetworkStatus);
window.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('mobile-nav-open')) toggleMobileNavigation(false); });

bootstrap();
