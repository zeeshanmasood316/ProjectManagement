'use strict';

const state = {
  token: localStorage.getItem('orbit_token') || '',
  user: null,
  presence: null,
  settings: null,
  notifications: [],
  activity: [],
  sessions: [],
  unreadNotificationCount: 0,
  organizations: [],
  workspaceAccess: null,
  onboardingDeferred: localStorage.getItem('orbit_onboarding_deferred') === '1',
  organizationId: Number(localStorage.getItem('orbit_organization_id')) || null,
  organization: null,
  members: [],
  invitations: [],
  myInvitations: [],
  projects: [],
  projectId: Number(localStorage.getItem('orbit_project_id')) || null,
  project: null,
  projectTab: localStorage.getItem('orbit_project_tab') || 'overview',
  tasks: [],
  milestones: [],
  stories: [],
  boardColumns: [],
  storyFilter: 'all',
  departments: [],
  teams: [],
  jobRoles: [],
  managerWorkspace: null,
  teamsDetail: null,
  orgDashboard: null,
  dashboardMyTasksTab: 'upcoming',
  calendarMonth: (() => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`; })(),
  risks: [],
  decisions: [],
  changes: [],
  suggestions: [],
  report: null,
  channels: [],
  channelId: Number(localStorage.getItem('orbit_channel_id')) || null,
  messages: [],
  chatMode: localStorage.getItem('orbit_chat_mode') || 'channels',
  directConversations: [],
  activeConversationId: Number(localStorage.getItem('orbit_conversation_id')) || null,
  directMessages: [],
  memberSearch: '',
  memberDepartment: 'all',
  memberPresence: 'all',
  aiStatus: { enabled: false, provider: 'local_fallback', model: 'local-rule-engine', mode: 'local_fallback' },
  view: 'chat'
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const authScreen = $('#authScreen');
const setupScreen = $('#setupScreen');
const appShell = $('#appShell');
const mainContent = $('#mainContent');
const organizationSelect = $('#organizationSelect');
const mobileOrganizationSelect = $('#mobileOrganizationSelect');
const projectSelect = $('#projectSelect');
const presenceSelect = $('#presenceSelect');
const mobileNavToggle = $('#mobileNavToggle');
const sidebarBackdrop = $('#sidebarBackdrop');
let heartbeatTimer = null;
let activeRequests = 0;
let lastDialogTrigger = null;
let messageStream = null;
let messageStreamChannelId = null;
let directMessageStream = null;
let directMessageStreamConversationId = null;

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const badge = value => `<span class="badge ${escapeHtml(value)}">${escapeHtml(String(value || '').replaceAll('_', ' '))}</span>`;
const initials = name => String(name || 'U').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
const presenceLabel = status => ({ online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Offline' }[status] || 'Offline');
const statusPresets = {
  available: { label: 'Available', emoji: '🟢' }, busy: { label: 'Busy', emoji: '🔴' },
  on_leave: { label: 'On Leave', emoji: '🏖️' }, remote: { label: 'Remote', emoji: '🏠' },
  in_meeting: { label: 'In a Meeting', emoji: '🟡' }, focus: { label: 'Focus Time', emoji: '🎯' },
  travelling: { label: 'Travelling', emoji: '✈️' }, custom: { label: 'Custom', emoji: '💬' }
};
const roleIsManager = role => ['ceo', 'admin', 'moderator'].includes(role);
const roleCanApproveMembers = role => ['ceo', 'admin'].includes(role);
const currentRole = () => state.organization?.membership?.role || '';
const canManage = () => roleIsManager(currentRole());
// "Manager" here is the business-level tier from the RBAC spec: a plain member who leads a team
// or manages a department — distinct from the ceo/admin/moderator org role tier above (canManage()).
// Full-access roles are never counted as this tier (they already see everything via canManage()).
const isTeamLeadOrDeptManager = () => {
  if (canManage()) return false;
  const userId = state.user?.id;
  const leadsTeam = (state.teams || []).some(team => Number(team.lead_user_id) === Number(userId));
  const managesDept = (state.departments || []).some(dept => Number(dept.manager_user_id) === Number(userId));
  return leadsTeam || managesDept;
};
const isWorkerTier = () => !canManage() && !isTeamLeadOrDeptManager();

function resolvedTheme(preference) {
  if (preference === 'dark' || preference === 'light') return preference;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const ICONS = {
  sun: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
  moon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>',
  mail: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/></svg>',
  atSign: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>',
  history: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
  upload: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>',
  fileText: '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  arrowLeft: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>',
  chevronLeft: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  chevronUp: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>',
  moreHorizontal: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>',
  userPlus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 21a8 8 0 0 1 13.292-6"/><circle cx="10" cy="8" r="5"/><path d="M19 16v6"/><path d="M22 19h-6"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>'
};

function updateThemeToggleButtons() {
  const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const nextLabel = current === 'dark' ? 'Light' : 'Dark';
  const nextIcon = current === 'dark' ? ICONS.sun : ICONS.moon;
  $$('[data-theme-toggle]').forEach(button => {
    button.innerHTML = nextIcon;
    const label = `Switch to ${nextLabel.toLowerCase()} mode`;
    button.setAttribute('aria-label', label);
    button.setAttribute('data-tooltip', label);
    button.removeAttribute('title');
  });
}

function applyTheme(preference = 'light') {
  const safePreference = resolvedTheme(preference);
  localStorage.setItem('orbit_theme', safePreference);
  document.documentElement.dataset.themePreference = safePreference;
  document.documentElement.dataset.theme = safePreference;
  updateThemeToggleButtons();
}

async function toggleTheme() {
  const previous = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const next = previous === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  state.settings = { ...(state.settings || {}), theme: next };
  if (!state.user) return;
  try {
    state.settings = await api('/api/users/me/settings', { method: 'PATCH', body: JSON.stringify({ theme: next }) });
  } catch (error) {
    applyTheme(previous);
    state.settings = { ...(state.settings || {}), theme: previous };
    toast(error.message, true);
  }
}

function statusMarkup(person, compact = false) {
  const key = person?.status_key || 'available';
  const preset = statusPresets[key] || statusPresets.available;
  const emoji = person?.status_emoji || preset.emoji;
  const label = person?.status_label || preset.label;
  return `<span class="workspace-status ${escapeHtml(key)} ${compact ? 'compact' : ''}" title="${escapeHtml(person?.custom_status || label)}"><span>${escapeHtml(emoji)}</span>${compact ? '' : `<b>${escapeHtml(label)}</b>`}</span>`;
}

function memberForUser(userId) {
  return state.members.find(member => Number(member.user_id) === Number(userId));
}

function notificationIcon(type) {
  return ({ invitation: ICONS.mail, mention: ICONS.atSign, activity: ICONS.history, workspace: ICONS.bell, team_work: ICONS.userPlus, task_assignment: ICONS.userPlus }[type] || ICONS.bell);
}

function personNameWithStatus(userId, fallbackName) {
  const member = memberForUser(userId);
  return `<span class="name-with-inline-status"><span>${escapeHtml(fallbackName || 'Unassigned')}</span>${member ? statusMarkup(member, true) : ''}</span>`;
}

function avatarMarkup(person, className = '') {
  const image = person?.avatar_url ? `<img src="${escapeHtml(person.avatar_url)}" alt="" loading="lazy">` : '';
  return `<div class="avatar member-avatar ${escapeHtml(className)}">${image}<span>${escapeHtml(initials(person?.full_name))}</span><i class="presence-dot ${escapeHtml(person?.current_status || 'offline')}" aria-label="${escapeHtml(presenceLabel(person?.current_status))}"></i></div>`;
}

function relativeTime(value) {
  if (!value) return 'Never active';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return String(value);
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'Active just now';
  if (seconds < 3600) return `Active ${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `Active ${Math.floor(seconds / 3600)}h ago`;
  return `Active ${Math.floor(seconds / 86400)}d ago`;
}

function sessionDevice(userAgent = '') {
  const value = String(userAgent);
  const browser = /Edg\//.test(value) ? 'Microsoft Edge' : /Chrome\//.test(value) ? 'Chrome' : /Firefox\//.test(value) ? 'Firefox' : /Safari\//.test(value) ? 'Safari' : 'Browser';
  const platform = /Windows/i.test(value) ? 'Windows' : /Android/i.test(value) ? 'Android' : /iPhone|iPad/i.test(value) ? 'iOS' : /Mac OS/i.test(value) ? 'macOS' : /Linux/i.test(value) ? 'Linux' : 'Unknown device';
  return `${browser} on ${platform}`;
}

function announce(message) {
  const element = $('#appStatus');
  if (!element) return;
  element.textContent = '';
  requestAnimationFrame(() => { element.textContent = message; });
}

function toast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.setAttribute('role', isError ? 'alert' : 'status');
  element.classList.add('show');
  announce(message);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 4500);
}

function setGlobalLoading(isLoading) {
  activeRequests = Math.max(0, activeRequests + (isLoading ? 1 : -1));
  const loading = activeRequests > 0;
  const element = $('#globalLoading');
  if (!element) return;
  element.classList.toggle('active', loading);
  element.setAttribute('aria-hidden', String(!loading));
}

function setWorkspaceBusy(isBusy, message = 'Loading workspace…') {
  mainContent.setAttribute('aria-busy', String(Boolean(isBusy)));
  if (isBusy && !mainContent.children.length) {
    mainContent.innerHTML = `<div class="loading-state" role="status"><span class="spinner" aria-hidden="true"></span><strong>${escapeHtml(message)}</strong><span>Please wait while Orbit prepares your workspace.</span></div>`;
  }
}

function setButtonBusy(button, busy, label = 'Working…') {
  if (!button) return;
  if (busy) {
    button.dataset.previousLabel = button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span>${escapeHtml(label)}`;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.previousLabel) button.innerHTML = button.dataset.previousLabel;
    delete button.dataset.previousLabel;
  }
}

function updateNetworkStatus() {
  const offline = !navigator.onLine;
  $('#networkBanner')?.classList.toggle('hidden', !offline);
  document.body.classList.toggle('is-offline', offline);
  if (offline) announce('You are offline.');
}

function toggleMobileNavigation(open) {
  const shouldOpen = open ?? !document.body.classList.contains('mobile-nav-open');
  document.body.classList.toggle('mobile-nav-open', shouldOpen);
  mobileNavToggle?.setAttribute('aria-expanded', String(shouldOpen));
  mobileNavToggle?.setAttribute('aria-label', shouldOpen ? 'Close navigation' : 'Open navigation');
  sidebarBackdrop?.classList.toggle('hidden', !shouldOpen);
  if (shouldOpen) $('#mainNav button.active')?.focus();
}

function closeDialog(overlay) {
  if (!overlay) return;
  overlay._onClose?.();
  overlay.remove();
  if (!document.querySelector('.dialog-backdrop')) document.body.classList.remove('dialog-open');
  lastDialogTrigger?.focus?.();
  lastDialogTrigger = null;
}

function mountDialog(overlay, titleId, options = {}) {
  overlay._confirmClose = options.confirmClose || null;
  lastDialogTrigger = document.activeElement;
  overlay.setAttribute('role', 'presentation');
  const dialog = overlay.querySelector('.dialog-card');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  if (titleId) dialog.setAttribute('aria-labelledby', titleId);
  document.body.appendChild(overlay);
  document.body.classList.add('dialog-open');
  const focusable = () => [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]')];
  requestAnimationFrame(() => { enhanceAiFields(dialog); (dialog.querySelector('[autofocus]') || focusable()[0])?.focus(); });
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); if (overlay._confirmClose && !overlay._confirmClose()) return; closeDialog(overlay); return; }
    if (event.key !== 'Tab') return;
    const items = focusable();
    if (!items.length) return;
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}

const aiFieldNames = new Set(['name','objective','scope','constraints','assumptions','brief','notes','title','description','acceptance_criteria','body','topic','phase','custom_status','status_label','proposed_department']);
let aiFieldCounter = 0;

function enhanceAiFields(root = document) {
  root.querySelectorAll('input[name], textarea[name]').forEach(field => {
    if (field.dataset.aiEnhanced === '1' || field.disabled || field.readOnly || !aiFieldNames.has(field.name)) return;
    if (['password','email','url','number','date','hidden'].includes(field.type)) return;
    field.dataset.aiEnhanced = '1';
    if (!field.id) field.id = `ai-field-${++aiFieldCounter}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-assist-button';
    button.dataset.action = 'ai-assist-field';
    button.dataset.targetId = field.id;
    button.innerHTML = '✨ AI Suggest';
    button.title = 'Generate an editable AI suggestion for this field';
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      setButtonBusy(button, true, 'Thinking…');
      try {
        await openAiSuggestionDialog(field);
      } catch (error) {
        toast(error.message, true);
      } finally {
        setButtonBusy(button, false);
      }
    });
    field.insertAdjacentElement('afterend', button);
  });
}

function fieldLabel(field) {
  const label = field.closest('label');
  if (!label) return field.name || 'Field';
  return [...label.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent.trim()).filter(Boolean).join(' ') || field.name || 'Field';
}

function formContextFor(field) {
  const form = field.closest('form');
  if (!form) return {};
  const context = {};
  for (const [key, value] of new FormData(form).entries()) if (typeof value === 'string' && key !== 'password') context[key] = value;
  return context;
}

async function requestAiSuggestion(field, instruction = '') {
  return api('/api/ai/suggest', { method: 'POST', timeoutMs: 55_000, body: JSON.stringify({
    project_id: state.projectId || null,
    field_name: field.name,
    field_label: fieldLabel(field),
    value: field.value,
    instruction,
    form_context: formContextFor(field)
  }) });
}

async function openAiSuggestionDialog(field) {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<section class="dialog-card ai-suggestion-dialog"><div class="dialog-head"><div><p class="eyebrow dark">AI WRITING ASSISTANT</p><h2 id="aiSuggestionTitle">${escapeHtml(fieldLabel(field))}</h2></div><button type="button" class="icon-button" data-ai-close aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div><div class="ai-thinking"><span class="spinner"></span> Generating suggestion…</div></section>`;
  document.body.appendChild(overlay); document.body.classList.add('dialog-open');
  const card = overlay.querySelector('.dialog-card'); card.setAttribute('role','dialog'); card.setAttribute('aria-modal','true'); card.setAttribute('aria-labelledby','aiSuggestionTitle');
  const load = async instruction => {
    card.querySelector('.ai-thinking')?.remove();
    let result;
    try { result = await requestAiSuggestion(field, instruction); }
    catch (error) { overlay.remove(); if (!document.querySelector('.dialog-backdrop')) document.body.classList.remove('dialog-open'); throw error; }
    card.innerHTML = `<div class="dialog-head"><div><p class="eyebrow dark">AI WRITING ASSISTANT</p><h2 id="aiSuggestionTitle">${escapeHtml(fieldLabel(field))}</h2></div><button type="button" class="icon-button" data-ai-close aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div><div class="ai-provider-row"><span class="ai-status ${result.fallback ? 'fallback' : 'connected'}">✨ ${escapeHtml(result.provider)}</span><span class="small muted">Edit below before accepting.</span></div><textarea id="aiSuggestionText" class="ai-suggestion-text">${escapeHtml(result.suggestion)}</textarea><p class="small muted">${escapeHtml(result.rationale || '')}</p><div class="actions"><button class="primary" type="button" data-ai-accept>Accept suggestion</button><button class="secondary" type="button" data-ai-regenerate>Regenerate</button><button class="secondary" type="button" data-ai-close>Cancel</button></div>`;
    card.querySelector('#aiSuggestionText')?.focus();
  };
  overlay.addEventListener('click', async event => {
    if (event.target.closest('[data-ai-close]')) { overlay.remove(); if (!document.querySelector('.dialog-backdrop')) document.body.classList.remove('dialog-open'); field.focus(); }
    else if (event.target.closest('[data-ai-accept]')) { field.value = card.querySelector('#aiSuggestionText').value; field.dispatchEvent(new Event('input',{bubbles:true})); field.dispatchEvent(new Event('change',{bubbles:true})); overlay.remove(); if (!document.querySelector('.dialog-backdrop')) document.body.classList.remove('dialog-open'); field.focus(); toast('AI suggestion added. You can still edit it.'); }
    else if (event.target.closest('[data-ai-regenerate]')) { const btn=event.target.closest('[data-ai-regenerate]'); setButtonBusy(btn,true,'Regenerating…'); try { const result=await requestAiSuggestion(field,'Generate a different, stronger version.'); card.querySelector('#aiSuggestionText').value=result.suggestion; card.querySelector('.ai-status').textContent=`✨ ${result.provider}`; } catch(e){toast(e.message,true)} finally {setButtonBusy(btn,false)} }
  });
  await load('');
}

function openGeneratePlanDialog() {
  const overlay = document.createElement('div'); overlay.className='dialog-backdrop';
  overlay.innerHTML = `<form id="aiPlanForm" class="dialog-card stack"><div class="dialog-head"><div><p class="eyebrow dark">AI PROJECT PLANNER</p><h2 id="aiPlanTitle">Generate a project-specific plan</h2></div><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div><div class="notice">AI will use the saved objective, scope, constraints, assumptions, team members and the optional brief below. Every generated task stays pending for human review.</div><label>Extra instructions / brief<textarea name="brief" placeholder="Example: Launch MVP in 6 weeks. Prioritize authentication, payments and mobile responsiveness."></textarea></label><label class="toggle-row"><span><strong>Replace pending AI tasks</strong><small>Remove only previous unapproved AI tasks before generating a fresh plan.</small></span><input type="checkbox" name="replace_unapproved"></label><div class="actions"><button class="primary" type="submit">✨ Generate with AI</button></div></form>`;
  mountDialog(overlay,'aiPlanTitle');
  overlay.querySelector('form').addEventListener('submit', async event => { event.preventDefault(); const btn=event.submitter; const fd=new FormData(event.currentTarget); setButtonBusy(btn,true,'AI is planning…'); try { const result=await api(`/api/projects/${state.projectId}/generate-plan`,{method:'POST',timeoutMs:60_000,body:JSON.stringify({brief:fd.get('brief'),replace_unapproved:event.currentTarget.elements.replace_unapproved.checked})}); closeDialog(overlay); await loadProjectData(); render(); toast(result.fallback_used ? 'Plan created with local fallback. Add an AI API key for full AI generation.' : `AI plan created with ${result.ai_provider}.`); } catch(e){toast(e.message,true)} finally {setButtonBusy(btn,false)} });
}

function renderWorkspaceError(error, retryAction = 'retry-workspace') {
  const requestReference = error.requestId ? `<p class="small muted">Reference: ${escapeHtml(error.requestId)}</p>` : '';
  mainContent.innerHTML = `<section class="card error-state" role="alert"><div class="error-state-icon">!</div><h2>We could not load this view</h2><p>${escapeHtml(error.message || 'An unexpected error occurred.')}</p>${requestReference}<button class="primary" type="button" data-action="${escapeHtml(retryAction)}">Try again</button></section>`;
  mainContent.focus();
}

async function api(path, options = {}) {
  const { silent = false, timeoutMs = 20_000, ...fetchOptions } = options;
  const headers = { ...(fetchOptions.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (fetchOptions.body !== undefined && !(fetchOptions.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (!silent) setGlobalLoading(true);
  try {
    const response = await fetch(path, { ...fetchOptions, headers, credentials: 'same-origin', signal: controller.signal });
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch {}
      const error = new Error(payload.detail || `${response.status} ${response.statusText}`);
      error.status = response.status;
      error.code = payload.code;
      error.payload = payload;
      error.requestId = payload.request_id || response.headers.get('x-request-id');
      if (response.status === 401 && !path.endsWith('/auth/login') && !path.endsWith('/auth/register')) logout(false);
      throw error;
    }
    if (response.status === 204) return null;
    const type = response.headers.get('content-type') || '';
    return type.includes('application/json') ? response.json() : response.text();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The request timed out. Please check your connection and try again.');
    if (error instanceof TypeError) throw new Error('Unable to reach Orbit. Check your internet connection and try again.');
    throw error;
  } finally {
    clearTimeout(timer);
    if (!silent) setGlobalLoading(false);
  }
}

function saveToken() {
  // New sessions use an HttpOnly SameSite cookie. Remove legacy localStorage tokens.
  state.token = '';
  localStorage.removeItem('orbit_token');
}

function logout(showMessage = true) {
  stopPresenceHeartbeat();
  disconnectMessageStream();
  disconnectDmStream();
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

function showScreen(name) {
  authScreen.classList.toggle('hidden', name !== 'auth');
  setupScreen.classList.toggle('hidden', name !== 'setup');
  appShell.classList.toggle('hidden', name !== 'app');
}

function switchAuthTab(tab) {
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

function showForgotPassword() {
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

function clearWorkspaceSelection() {
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

function setOnboardingDeferred(value) {
  state.onboardingDeferred = Boolean(value);
  if (state.onboardingDeferred) localStorage.setItem('orbit_onboarding_deferred', '1');
  else localStorage.removeItem('orbit_onboarding_deferred');
}

function stopPresenceHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function heartbeat(refreshDirectory = false) {
  if (!state.user) return;
  try {
    state.presence = await api('/api/presence/heartbeat', { method: 'POST', silent: true });
    if (presenceSelect) presenceSelect.value = state.presence.status_key || 'available';
    if (refreshDirectory && state.organizationId && ['members', 'admin'].includes(state.view)) {
      state.members = await api(`/api/organizations/${state.organizationId}/members`);
      render();
    }
  } catch {}
}

function startPresenceHeartbeat() {
  stopPresenceHeartbeat();
  heartbeatTimer = setInterval(() => heartbeat(true), 60_000);
}

async function bootstrap() {
  setWorkspaceBusy(true, 'Checking your account…');
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
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

function showSetup() {
  showScreen('setup');
  $('#setupUser').textContent = `${state.user.full_name} (@${state.user.username})`;
  renderSetupInvitations();
  renderOnboardingState();
}

function renderOnboardingState() {
  $('#setupOptions').classList.toggle('hidden', state.onboardingDeferred);
  $('#setupDeferredState').classList.toggle('hidden', !state.onboardingDeferred);
  const pendingCount = Number(state.workspaceAccess?.pending_invitation_count || state.myInvitations.length || 0);
  $('#deferredAccessMessage').textContent = pendingCount
    ? `You have ${pendingCount} pending invitation${pendingCount === 1 ? '' : 's'}. Check approval to unlock the workspace once membership becomes active.`
    : 'Create an organization or receive an invitation from an organization manager to unlock the workspace.';
}

function renderSetupInvitations() {
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

async function loadWorkspace() {
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

async function loadProjectData() {
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

async function loadMessages() {
  state.messages = state.channelId ? await api(`/api/channels/${state.channelId}/messages`) : [];
}

function messageMarkup(message) {
  const member = state.members.find(item => Number(item.user_id) === Number(message.user_id));
  return `<article class="message" data-message-id="${message.id}">${avatarMarkup({ ...message, ...(member || {}) })}<div><div class="message-meta"><strong>${escapeHtml(message.full_name)}</strong>${member ? statusMarkup(member, true) : ''}<small>@${escapeHtml(message.username)} · ${escapeHtml(new Date(message.created_at).toLocaleString())}</small></div><div class="message-body">${escapeHtml(message.body)}</div></div></article>`;
}

function appendMessageToFeed(message) {
  const feed = $('#messageFeed');
  if (!feed || feed.querySelector(`[data-message-id="${message.id}"]`)) return;
  const empty = feed.querySelector('.empty');
  if (empty) empty.remove();
  feed.insertAdjacentHTML('beforeend', messageMarkup(message));
  feed.scrollTop = feed.scrollHeight;
}

function receiveMessage(message) {
  if (Number(message.channel_id) !== Number(state.channelId)) return;
  if (state.messages.some(item => Number(item.id) === Number(message.id))) return;
  state.messages.push(message);
  if (state.view === 'chat') appendMessageToFeed(message);
}

function setMessageStreamStatus(connected) {
  const indicator = $('#chatConnectionStatus');
  if (!indicator) return;
  if (connected === false) { indicator.textContent = 'Reconnecting…'; indicator.classList.remove('hidden'); }
  else { indicator.textContent = ''; indicator.classList.add('hidden'); }
}

function disconnectMessageStream() {
  if (messageStream) messageStream.close();
  messageStream = null;
  messageStreamChannelId = null;
  setMessageStreamStatus(null);
}

function connectMessageStream(channelId) {
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

function appendDirectMessageToFeed(message) {
  const feed = $('#directMessageFeed');
  if (!feed || feed.querySelector(`[data-message-id="${message.id}"]`)) return;
  const empty = feed.querySelector('.empty');
  if (empty) empty.remove();
  feed.insertAdjacentHTML('beforeend', messageMarkup(message));
  feed.scrollTop = feed.scrollHeight;
}

function receiveDirectMessage(message) {
  if (Number(message.conversation_id) !== Number(state.activeConversationId)) return;
  if (state.directMessages.some(item => Number(item.id) === Number(message.id))) return;
  state.directMessages.push(message);
  if (state.view === 'chat' && state.chatMode === 'direct') appendDirectMessageToFeed(message);
  const conversation = state.directConversations.find(item => Number(item.id) === Number(message.conversation_id));
  if (conversation) { conversation.last_message = message.body; conversation.last_message_at = message.created_at; }
}

function setDmStreamStatus(connected) {
  const indicator = $('#dmConnectionStatus');
  if (!indicator) return;
  if (connected === false) { indicator.textContent = 'Reconnecting…'; indicator.classList.remove('hidden'); }
  else { indicator.textContent = ''; indicator.classList.add('hidden'); }
}

function disconnectDmStream() {
  if (directMessageStream) directMessageStream.close();
  directMessageStream = null;
  directMessageStreamConversationId = null;
  setDmStreamStatus(null);
}

function connectDmStream(conversationId) {
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

async function loadDirectConversations() {
  state.directConversations = await api(`/api/organizations/${state.organizationId}/direct-conversations`);
}

async function openConversation(conversationId) {
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

function updateShell() {
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
  $$('[data-manager]').forEach(button => button.classList.toggle('hidden', !canManage()));
  $$('[data-admin]').forEach(button => button.classList.toggle('hidden', !canManage()));
  $$('[data-hide-worker]').forEach(button => button.classList.toggle('hidden', isWorkerTier()));
}

const viewTitles = {
  chat: 'Channel', members: 'People', profile: 'Profile', notifications: 'Notifications', activity: 'Account Activity', settings: 'Settings',
  dashboard: 'Dashboard', intake: 'New project', projects: 'Projects', work: 'Work Breakdown', meeting: 'Meeting Notes',
  risks: 'Risk & Decisions', changes: 'Change Control', report: 'Reports & export', admin: 'Admin dashboard', teams: 'Teams'
};

function render() {
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

const aiStatusBadge = () => `<span class="ai-status ${state.aiStatus?.enabled ? 'connected' : 'fallback'}" title="${escapeHtml(state.aiStatus?.model || '')}">✨ ${state.aiStatus?.enabled ? 'AI connected' : 'AI local mode'}</span>`;
const pageHead = (title, subtitle, actions = '') => `<div class="page-head"><div><h2>${title}</h2><p>${subtitle}</p></div><div class="actions">${aiStatusBadge()}${actions}</div></div>`;

function noProject() {
  return `<div class="card empty">No project exists in this organization. ${canManage() ? 'Use “New project” to create one.' : 'Ask a manager to create a project.'}</div>`;
}

function chatModeTabs() {
  return `<div class="tabbar" role="tablist" aria-label="Messaging mode">
    <button type="button" role="tab" aria-selected="${state.chatMode === 'channels'}" class="${state.chatMode === 'channels' ? 'active' : ''}" data-action="set-chat-mode" data-mode="channels">Channels</button>
    <button type="button" role="tab" aria-selected="${state.chatMode === 'direct'}" class="${state.chatMode === 'direct' ? 'active' : ''}" data-action="set-chat-mode" data-mode="direct">Direct Messages${state.directConversations.some(item => item.unread_count) ? ' •' : ''}</button>
  </div>`;
}

function renderChat() {
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

function renderDirectMessagesPanel() {
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

function statusOptions(selected) {
  return Object.entries(statusPresets).map(([key, item]) => `<option value="${key}" ${selected === key ? 'selected' : ''}>${escapeHtml(item.emoji)} ${escapeHtml(item.label)}</option>`).join('');
}

function renderProfile() {
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

function renderNotifications() {
  return `${pageHead('Notifications', 'Invitations, approvals, mentions, and important workspace updates.', state.unreadNotificationCount ? '<button class="secondary" data-action="read-all-notifications">Mark all as read</button>' : '')}
  <section class="notification-list">
    ${state.notifications.map(item => `<article class="card notification-item ${item.read_at ? '' : 'unread'}">
      <div class="notification-icon">${notificationIcon(item.notification_type)}</div>
      <div class="notification-copy"><div class="notification-title"><strong>${escapeHtml(item.title)}</strong>${item.organization_name ? `<span>${escapeHtml(item.organization_name)}</span>` : ''}</div><p>${escapeHtml(item.body)}</p><small>${escapeHtml(new Date(item.created_at).toLocaleString())}</small></div>
      <div class="notification-actions">${!item.read_at ? `<button class="secondary" data-action="mark-notification-read" data-id="${item.id}">Mark read</button>` : '<span class="read-label">Read</span>'}${item.action_view ? `<button class="ghost-action" data-action="open-notification" data-view="${escapeHtml(item.action_view)}" data-id="${item.id}">Open</button>` : ''}</div>
    </article>`).join('') || '<div class="card empty">No notifications yet.</div>'}
  </section>`;
}

function renderActivity() {
  return `${pageHead('Account activity', 'A private history of sign-ins, profile changes, settings, invitations, and membership events.', '<button class="secondary" data-action="refresh-activity">Refresh activity</button>')}
  <section class="card activity-timeline">
    ${state.activity.map(item => `<article class="activity-item"><div class="activity-marker">${notificationIcon(item.activity_type === 'signed_in' ? 'activity' : 'workspace')}</div><div><div class="activity-title"><strong>${escapeHtml(item.title)}</strong>${item.organization_name ? `<span>${escapeHtml(item.organization_name)}</span>` : ''}</div>${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ''}<small>${escapeHtml(new Date(item.created_at).toLocaleString())}</small></div></article>`).join('') || '<div class="empty">No account activity has been recorded yet.</div>'}
  </section>`;
}

function renderSettings() {
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

const DEFAULT_DASHBOARD_LAYOUT = [
  { key: 'team_work', visible: true },
  { key: 'summary', visible: true },
  { key: 'my_tasks', visible: true },
  { key: 'status_overview', visible: true },
  { key: 'priority_breakdown', visible: true },
  { key: 'assigned_tasks', visible: true },
  { key: 'people', visible: true },
  { key: 'team_workload', visible: true }
];
const DASHBOARD_WIDGET_LABELS = { team_work: 'Team Work', summary: 'Summary', my_tasks: 'My Tasks', status_overview: 'Status Overview', priority_breakdown: 'Priority Breakdown', assigned_tasks: 'Tasks I’ve Assigned', people: 'People', team_workload: 'Team Workload' };

function getDashboardLayout() {
  try {
    const parsed = JSON.parse(state.settings?.dashboard_layout || '');
    if (Array.isArray(parsed) && parsed.length) {
      const seen = new Set(parsed.map(item => item.key));
      return [...parsed, ...DEFAULT_DASHBOARD_LAYOUT.filter(item => !seen.has(item.key))];
    }
  } catch { /* fall through to defaults */ }
  return DEFAULT_DASHBOARD_LAYOUT;
}

function svgDonutChart(segments, size = 118) {
  const total = segments.reduce((sum, item) => sum + item.value, 0);
  const radius = size / 2 - 10;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const circles = segments.filter(item => item.value > 0).map(item => {
    const dash = (total ? item.value / total : 0) * circumference;
    const markup = `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="${item.color}" stroke-width="16" stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${size / 2} ${size / 2})"></circle>`;
    offset += dash;
    return markup;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Distribution chart">${circles || `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="var(--line)" stroke-width="16"></circle>`}<text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="middle" font-size="20" font-weight="800" fill="var(--ink)">${total}</text></svg>`;
}

function dashboardWidgetCard(title, contentHtml, headActions = '') {
  return `<section class="card dashboard-widget"><div class="page-head compact-head"><h3>${title}</h3>${headActions}</div>${contentHtml}</section>`;
}

function getDashboardCollapseState(key) {
  try {
    const stored = localStorage.getItem(`dashboard_collapse_${key}`);
    return stored === null ? true : stored === '1';
  } catch { return true; }
}
function setDashboardCollapseState(key, collapsed) {
  try { localStorage.setItem(`dashboard_collapse_${key}`, collapsed ? '1' : '0'); } catch { /* ignore */ }
}

function collapsibleDashboardCard(key, title, collapsedContentHtml, extraContentHtml) {
  if (!extraContentHtml) return `<section class="card"><h3>${title}</h3>${collapsedContentHtml}</section>`;
  const collapsed = getDashboardCollapseState(key);
  const label = collapsed ? 'Expand' : 'Collapse';
  const icon = collapsed ? ICONS.chevronDown : ICONS.chevronUp;
  return `<section class="card dashboard-collapsible" data-collapse-key="${key}" data-collapse-title="${escapeHtml(title)}">
    <div class="page-head compact-head"><h3>${title}</h3><button type="button" class="icon-button" data-action="toggle-dashboard-collapse" data-key="${key}" aria-expanded="${!collapsed}" aria-label="${label} ${escapeHtml(title)}" data-tooltip="${label}">${icon}</button></div>
    <div class="dashboard-collapsible-collapsed">${collapsedContentHtml}</div>
    <div class="dashboard-collapsible-extra${collapsed ? '' : ' is-open'}" ${collapsed ? 'aria-hidden="true"' : ''}><div class="dashboard-collapsible-extra-inner">${extraContentHtml}</div></div>
  </section>`;
}

function dashboardTaskRow(task) {
  return `<button type="button" class="dashboard-task-row" data-action="open-task-cross-project" data-project-id="${task.project_id}" data-id="${task.id}">
    <span class="status-dot status-${escapeHtml(task.status)}"></span>
    <span class="dashboard-task-row-title">${escapeHtml(task.title)}</span>
    <span class="small muted">${escapeHtml(task.project_name || '')}</span>
    <span class="small muted">${escapeHtml(task.due_date || '')}</span>
  </button>`;
}

function renderDashboardSummaryWidget() {
  const summary = state.orgDashboard?.summary;
  if (!summary) return '';
  return `<div class="grid cols-4">
    <div class="card"><div class="small muted">Completed</div><div class="metric">${summary.completed_7d}</div><div class="small muted">Last 7 days</div></div>
    <div class="card"><div class="small muted">Updated</div><div class="metric">${summary.updated_7d}</div><div class="small muted">Last 7 days</div></div>
    <div class="card"><div class="small muted">Created</div><div class="metric">${summary.created_7d}</div><div class="small muted">Last 7 days</div></div>
    <div class="card"><div class="small muted">Due soon</div><div class="metric">${summary.due_soon_7d}</div><div class="small muted">Next 7 days</div></div>
  </div>`;
}

function renderDashboardMyTasksWidget() {
  const data = state.orgDashboard?.my_tasks;
  if (!data) return '';
  const activeTab = state.dashboardMyTasksTab;
  const list = data[activeTab] || [];
  const tabs = `<div class="tabbar" style="margin:0 0 10px" role="tablist">${['upcoming', 'overdue', 'completed'].map(key => `<button type="button" role="tab" class="${activeTab === key ? 'active' : ''}" data-action="dashboard-my-tasks-tab" data-tab="${key}">${key[0].toUpperCase()}${key.slice(1)} (${(data[key] || []).length})</button>`).join('')}</div>`;
  return dashboardWidgetCard('My Tasks', `${tabs}<div class="dashboard-task-list">${list.length ? list.map(dashboardTaskRow).join('') : '<div class="empty small">Nothing here.</div>'}</div>`);
}

function renderDashboardStatusWidget() {
  const dist = state.orgDashboard?.status_distribution;
  if (!dist) return '';
  const segments = [
    { label: 'Not started', value: dist.not_started, color: 'var(--muted)' },
    { label: 'In progress', value: dist.in_progress, color: 'var(--warn)' },
    { label: 'Blocked', value: dist.blocked, color: 'var(--danger)' },
    { label: 'Done', value: dist.done, color: 'var(--good)' }
  ];
  return dashboardWidgetCard('Status Overview', `<div class="dashboard-chart-row">${svgDonutChart(segments)}<div class="dashboard-legend">${segments.map(item => `<div class="legend-row"><span class="legend-dot" style="background:${item.color}"></span>${item.label}<span class="small muted">${item.value}</span></div>`).join('')}</div></div>`);
}

function renderDashboardPriorityWidget() {
  const dist = state.orgDashboard?.priority_distribution;
  if (!dist) return '';
  const segments = [
    { label: 'Low', value: dist.low, color: 'var(--good)' },
    { label: 'Medium', value: dist.medium, color: 'var(--warn)' },
    { label: 'High', value: dist.high, color: 'var(--brand)' },
    { label: 'Critical', value: dist.critical, color: 'var(--danger)' }
  ];
  return dashboardWidgetCard('Priority Breakdown', `<div class="dashboard-chart-row">${svgDonutChart(segments)}<div class="dashboard-legend">${segments.map(item => `<div class="legend-row"><span class="legend-dot" style="background:${item.color}"></span>${item.label}<span class="small muted">${item.value}</span></div>`).join('')}</div></div>`);
}

function renderDashboardAssignedWidget() {
  const list = state.orgDashboard?.assigned_by_me || [];
  return dashboardWidgetCard('Tasks I’ve Assigned', `<div class="dashboard-task-list">${list.length ? list.map(task => `<button type="button" class="dashboard-task-row" data-action="open-task-cross-project" data-project-id="${task.project_id}" data-id="${task.id}"><span class="dashboard-task-row-title">${escapeHtml(task.title)}</span><span class="small muted">${escapeHtml(task.owner_name || 'Unassigned')}</span>${badge(task.priority)}<span class="small muted">${escapeHtml(task.due_date || '—')}</span></button>`).join('') : '<div class="empty small">You have not assigned any tasks yet.</div>'}</div>`,
    canManage() ? '<button class="secondary" type="button" data-action="open-members">Invite a teammate</button>' : '');
}

function renderDashboardPeopleWidget() {
  const people = state.orgDashboard?.people || [];
  return dashboardWidgetCard('People', people.length ? people.map(person => `<div class="workload-row"><span>${escapeHtml(person.full_name)}</span><div class="progress"><span style="width:${person.capacity ? Math.min(100, Math.round((person.active_task_count / person.capacity) * 100)) : 0}%"></span></div><span class="small muted">${person.overdue_count} overdue · ${person.completed_count} done</span></div>`).join('') : '<div class="empty small">No team members yet.</div>');
}

function renderDashboardTeamWorkloadWidget() {
  const people = state.orgDashboard?.people || [];
  return dashboardWidgetCard('Team Workload', people.length ? people.map(person => {
    const percent = person.capacity ? Math.round((person.active_task_count / person.capacity) * 100) : 0;
    return `<div class="workload-row"><span>${escapeHtml(person.full_name)}</span><div class="progress"><span style="width:${Math.min(100, percent)}%;${person.overloaded ? 'background:var(--danger)' : ''}"></span></div><span class="small muted">${percent}%${person.overloaded ? ' · Overloaded' : ''}</span></div>`;
  }).join('') : '<div class="empty small">No team members yet.</div>');
}

function renderDashboardTeamWorkWidget() {
  const teams = state.orgDashboard?.team_management || [];
  if (!teams.length) return '';
  const rows = teams.map(team => `<div class="milestone-item" style="margin-bottom:8px">
    <div><strong>${escapeHtml(team.team_name)}</strong><div class="small muted">${team.in_progress_count} in progress · ${team.completed_count} completed${team.overdue_count ? ` · <span class="danger">${team.overdue_count} overdue</span>` : ''}</div></div>
    ${team.needs_distribution_count ? `<button type="button" class="primary" data-action="open-distribute-work" data-id="${team.team_id}">Distribute Work (${team.needs_distribution_count})</button>` : '<span class="small muted">Nothing to distribute</span>'}
  </div>`).join('');
  return dashboardWidgetCard('Team Work', rows);
}

function renderDashboard() {
  const newProjectAction = canManage() ? `<button class="primary" data-action="open-intake">${ICONS.plus} New Project</button>` : '';
  const customizeAction = '<button class="secondary" type="button" data-action="customize-dashboard">Customize Dashboard</button>';
  const widgetRenderers = {
    team_work: renderDashboardTeamWorkWidget,
    summary: renderDashboardSummaryWidget, my_tasks: renderDashboardMyTasksWidget, status_overview: renderDashboardStatusWidget,
    priority_breakdown: renderDashboardPriorityWidget, assigned_tasks: renderDashboardAssignedWidget, people: renderDashboardPeopleWidget, team_workload: renderDashboardTeamWorkloadWidget
  };
  const visibleLayout = getDashboardLayout().filter(item => item.visible);
  const visibleKeys = new Set(visibleLayout.map(item => item.key));
  let chartRowRendered = false;
  const widgetsHtml = visibleLayout.map(item => {
    if (item.key === 'status_overview' || item.key === 'priority_breakdown') {
      if (chartRowRendered) return '';
      chartRowRendered = true;
      const showStatus = visibleKeys.has('status_overview');
      const showPriority = visibleKeys.has('priority_breakdown');
      const statusHtml = showStatus ? renderDashboardStatusWidget() : '';
      const priorityHtml = showPriority ? renderDashboardPriorityWidget() : '';
      if (showStatus && showPriority) return `<div class="grid cols-2">${statusHtml}${priorityHtml}</div>`;
      return statusHtml || priorityHtml;
    }
    return widgetRenderers[item.key]?.() || '';
  }).filter(Boolean).join('<div style="height:16px"></div>');

  if (!state.project || !state.report) {
    return `${pageHead('Dashboard', 'A personalized overview of your work, your team, and your projects.', `${newProjectAction}${customizeAction}`)}
    ${widgetsHtml}
    <div class="card empty" style="margin-top:16px">No project exists in this organization. ${canManage() ? 'Use “+ New Project” above to create one — describe it or upload a brief and AI will draft the structure for you.' : 'Ask a manager to create a project.'}</div>`;
  }
  const pending = state.tasks.filter(task => task.ai_generated && !task.approved).length + state.suggestions.filter(item => item.status === 'pending').length + state.changes.filter(item => item.status === 'pending').length;
  const dashboardActions = `${newProjectAction}${customizeAction}${canManage() ? '<button class="secondary" data-action="scan-risks">Scan risks</button>' : ''}`;
  const today = new Date().toISOString().slice(0, 10);
  const activeTasks = state.tasks.filter(task => !task.rejected && task.status !== 'done');
  const overdueCount = activeTasks.filter(task => task.due_date && task.due_date < today).length;
  const dueTodayCount = activeTasks.filter(task => task.due_date === today).length;
  const myTaskCount = activeTasks.filter(task => Number(task.owner_id) === Number(state.user.id)).length;
  const upcomingMilestones = state.milestones.filter(item => item.status !== 'done').slice(0, 5);
  return `${pageHead('Dashboard', 'A personalized overview of your work, your team, and your projects.', dashboardActions)}
  ${widgetsHtml}
  <h3 style="margin:22px 0 12px">Current project</h3>
  <div class="grid cols-4">
    <div class="card"><div class="small muted">Overall progress</div><div class="metric">${state.report.overall_progress_percent}%</div><div class="progress"><span style="width:${state.report.overall_progress_percent}%"></span></div></div>
    <div class="card"><div class="small muted">Active members</div><div class="metric">${state.members.filter(member => member.status === 'active').length}</div><div class="small muted">Organization-wide team</div></div>
    <div class="card"><div class="small muted">Open risks</div><div class="metric">${state.report.open_risks.length}</div><div class="small muted">Evidence retained for every warning</div></div>
    <div class="card"><div class="small muted">Awaiting review</div><div class="metric">${pending}</div><div class="small muted">AI proposals and changes</div></div>
  </div>
  <div class="grid cols-4" style="margin-top:16px">
    <div class="card dashboard-stat" data-action="dashboard-open-tasks" role="button" tabindex="0" aria-label="Open overdue tasks"><div class="small muted">Overdue tasks</div><div class="metric ${overdueCount ? 'danger' : ''}">${overdueCount}</div><div class="small muted">Past due date, not done</div></div>
    <div class="card dashboard-stat" data-action="dashboard-open-tasks" role="button" tabindex="0" aria-label="Open tasks due today"><div class="small muted">Due today</div><div class="metric">${dueTodayCount}</div><div class="small muted">Due ${escapeHtml(today)}</div></div>
    <div class="card dashboard-stat" data-action="dashboard-open-tasks" role="button" tabindex="0" aria-label="Open tasks assigned to me"><div class="small muted">Assigned to me</div><div class="metric">${myTaskCount}</div><div class="small muted">In this project</div></div>
    <div class="card"><div class="small muted">Upcoming milestones</div><div class="metric">${upcomingMilestones.length}</div><div class="small muted">Not yet done</div></div>
  </div>
  <div class="grid cols-3" style="margin-top:16px">
    ${collapsibleDashboardCard('project_snapshot', 'Project Snapshot',
      `<div class="kv"><div>Objective</div><div>${escapeHtml(state.project.objective || 'Not recorded')}</div><div>Scope</div><div>${escapeHtml(state.project.scope || 'Not recorded')}</div></div>`,
      `<div class="kv" style="margin-top:9px"><div>Constraints</div><div>${escapeHtml(state.project.constraints || 'Not recorded')}</div><div>Assumptions</div><div>${escapeHtml(state.project.assumptions || 'Not recorded')}</div><div>Owner</div><div>${personNameWithStatus(state.project.owner_id, memberForUser(state.project.owner_id)?.full_name || 'Unassigned')}</div><div>Timeline</div><div>${escapeHtml(state.project.start_date || 'Not set')} → ${escapeHtml(state.project.due_date || 'Not set')}</div><div>Progress</div><div>${state.report.overall_progress_percent}%<div class="progress" style="margin-top:5px"><span style="width:${state.report.overall_progress_percent}%"></span></div></div></div>`)}
    ${collapsibleDashboardCard('immediate_attention', 'Immediate Attention',
      state.report.blockers.length ? `<div class="notice danger"><strong>Blocked tasks</strong><div class="small">${state.report.blockers.length} task${state.report.blockers.length === 1 ? '' : 's'} require${state.report.blockers.length === 1 ? 's' : ''} attention.</div></div>` : '<div class="empty">No blocked task is stored.</div>',
      state.report.blockers.length ? state.report.blockers.map(task => `<div class="notice danger" style="margin-top:9px"><strong>${escapeHtml(task.title)}</strong><div class="small">${badge(task.priority || 'medium')} · ${personNameWithStatus(task.owner_id, task.owner_name || 'Unassigned')} · ${task.progress}% progress</div></div>`).join('') : '')}
    ${collapsibleDashboardCard('upcoming_milestones', 'Upcoming Milestones',
      upcomingMilestones.length ? `<div><strong>Milestones</strong><div class="small muted">${upcomingMilestones.length} milestone${upcomingMilestones.length === 1 ? '' : 's'} approaching.</div></div>` : '<div class="empty">No upcoming milestones.</div>',
      upcomingMilestones.length ? `<div style="margin-top:9px">${renderMilestoneList(upcomingMilestones)}</div>` : '')}
  </div>
  <section class="card" style="margin-top:16px"><h3>Kanban overview</h3>${renderBoard()}</section>`;
}

function renderBoard() {
  const statuses = { not_started: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
  return `<div class="board">${Object.entries(statuses).map(([status, label]) => `<div class="board-column"><h3>${label} (${state.tasks.filter(task => task.status === status).length})</h3>${state.tasks.filter(task => task.status === status).map(task => `<div class="task-card"><strong>${escapeHtml(task.title)}</strong><div class="small muted">${personNameWithStatus(task.owner_id, task.owner_name || 'Unassigned')} · ${escapeHtml(task.phase)}</div><div class="progress" style="margin-top:9px"><span style="width:${task.progress}%"></span></div><div class="small" style="margin-top:5px">${task.progress}% ${task.approved ? '' : '· awaiting approval'}</div></div>`).join('') || '<div class="small muted">No tasks</div>'}</div>`).join('')}</div>`;
}

function projectHealth(project) {
  if (project.health_override) return project.health_override;
  if (project.status === 'completed') return 'completed';
  if (Number(project.overdue_task_count) > 0) return 'critical';
  if (Number(project.open_risk_count) > 0) return 'at_risk';
  return 'healthy';
}

function renderProjects() {
  const newProjectAction = canManage() ? `<button class="primary" data-action="open-intake">${ICONS.plus} New Project</button>` : '';
  if (!state.projects.length) {
    return `${pageHead('Projects', 'Every project in this organization, at a glance.', newProjectAction)}
    <div class="card empty">No projects yet<br><span class="small muted">Create your first project to start organizing your work.</span>${canManage() ? `<div style="margin-top:14px"><button class="primary" data-action="open-intake">${ICONS.plus} New Project</button></div>` : ''}</div>`;
  }
  return `${pageHead('Projects', 'Every project in this organization, at a glance.', newProjectAction)}
  <div class="grid cols-3">
    ${state.projects.map(project => {
      const health = projectHealth(project);
      const done = Number(project.done_task_count || 0);
      const total = Number(project.task_count || 0);
      const percent = total ? Math.round((done / total) * 100) : 0;
      return `<article class="card project-card" data-action="open-project" data-id="${project.id}" tabindex="0" role="button" aria-label="Open ${escapeHtml(project.name)}">
        <div class="project-card-head"><h3>${escapeHtml(project.name)}</h3>${badge(health)}</div>
        <div class="small muted">${escapeHtml(project.owner_name || project.created_by_name || 'Unassigned')} · ${badge(project.priority || 'medium')}</div>
        <div class="progress" style="margin-top:12px"><span style="width:${percent}%"></span></div>
        <div class="small muted" style="margin-top:6px">${done}/${total} tasks done${project.due_date ? ` · Due ${escapeHtml(project.due_date)}` : ''}</div>
        <div class="project-card-foot">${badge(project.status)}${project.open_risk_count ? `<span class="small">${project.open_risk_count} open risk${project.open_risk_count === 1 ? '' : 's'}</span>` : ''}</div>
      </article>`;
    }).join('')}
  </div>`;
}

let intakeStep = 'brief'; // 'brief' | 'details'
let intakeSessionId = null;
let intakeAnalysis = null;
let intakeGuessed = { clientName: '', projectName: '' };
let intakeExtractedFields = null;
let intakeDetails = null;
let intakeAttachedFile = null;

function resetIntakeState() {
  intakeStep = 'brief';
  intakeSessionId = null;
  intakeAnalysis = null;
  intakeGuessed = { clientName: '', projectName: '' };
  intakeExtractedFields = null;
  intakeDetails = null;
  intakeAttachedFile = null;
}

function renderIntake() {
  if (!canManage()) return '<div class="notice danger">Only CEO, admin, or moderator can create a project.</div>';
  return intakeStep === 'details' && intakeAnalysis ? renderIntakeDetailsStep() : renderIntakeBriefStep();
}

function renderIntakeBriefStep() {
  const attached = intakeAttachedFile
    ? `<div class="intake-attached-file"><span>${ICONS.fileText} ${escapeHtml(intakeAttachedFile.name)} <span class="small muted">(${formatFileSize(intakeAttachedFile.size)})</span></span><button type="button" class="icon-button" data-action="intake-remove-file" aria-label="Remove file" data-tooltip="Remove file">${ICONS.x}</button></div>`
    : '';
  return `${pageHead('New project', 'Describe the project or attach a brief — VibeManagement drafts the Stories, Tasks and Subtasks automatically.')}
  <div class="card intake-composer">
    <form id="intakeBriefForm" class="stack">
      <textarea name="raw_text" rows="7" placeholder="Describe this project in your own words — goals, scope, key deliverables, deadlines... Or attach a brief file below." autofocus ${intakeAttachedFile ? 'disabled' : ''}></textarea>
      <input type="file" id="intakeFileInput" accept=".txt,.md,.markdown,.pdf,.docx" hidden>
      ${attached}
      <div class="actions" style="justify-content:space-between;align-items:center">
        <button type="button" class="secondary" data-action="intake-attach">${ICONS.upload} Attach brief file</button>
        <button type="submit" class="primary">${ICONS.send} Send</button>
      </div>
      <div id="intakeProgressWrap" hidden><p class="small muted" style="margin:10px 0 0">Analyzing Project Brief…</p><ul class="brief-progress-steps" id="intakeProgressSteps"></ul></div>
    </form>
  </div>`;
}

function renderIntakeDetailsStep() {
  const ownerOptions = `<option value="">Me (${escapeHtml(state.user.full_name)})</option>${state.members.filter(member => member.status === 'active' && Number(member.user_id) !== Number(state.user.id)).map(member => `<option value="${member.user_id}">${escapeHtml(member.full_name)} (${escapeHtml(member.role)})</option>`).join('')}`;
  const plan = intakeAnalysis?.plan;
  const taskCount = plan ? (plan.stories || []).reduce((sum, story) => sum + (story.tasks || []).length, 0) : 0;
  const fields = intakeExtractedFields || {};
  const autoFilledAnything = Boolean(fields.objective || fields.scope || fields.constraints || fields.start_date || fields.due_date || (fields.priority && fields.priority !== 'medium'));
  const summaryLine = plan
    ? `<div class="notice">Drafted ${(plan.stories || []).length} stories and ${taskCount} tasks from your brief.${autoFilledAnything ? ' We’ve also pre-filled the project details below from what your brief mentioned — review and adjust anything before continuing.' : ' Add a few project details below, then continue to review the breakdown and assign teams/workers.'}</div>`
    : '';
  const backAction = `<button type="button" class="secondary" data-action="intake-back-to-brief">${ICONS.arrowLeft} Back</button>`;
  return `${pageHead('Project details', 'A few details before we create the project.', backAction)}
  ${summaryLine}
  <form id="intakeDetailsForm" class="card form-grid">
    <label>Project name<input name="name" required value="${escapeHtml(intakeGuessed.projectName || '')}"></label>
    <label>Client name<input name="client_name" value="${escapeHtml(intakeGuessed.clientName || '')}"></label>
    <label>Objective<input name="objective" value="${escapeHtml(fields.objective || '')}"></label>
    <label class="full">Scope<textarea name="scope">${escapeHtml(fields.scope || '')}</textarea></label>
    <label>Constraints<textarea name="constraints">${escapeHtml(fields.constraints || '')}</textarea></label>
    <label>Owner<select name="owner_id">${ownerOptions}</select></label>
    <label>Priority<select name="priority">${['low', 'medium', 'high', 'critical'].map(value => `<option value="${value}" ${(fields.priority || 'medium') === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
    <label>Start date<input name="start_date" type="date" value="${escapeHtml(fields.start_date || '')}"></label>
    <label>Due date<input name="due_date" type="date" value="${escapeHtml(fields.due_date || '')}"></label>
    <div class="full actions"><button class="primary" type="submit">Continue to Stories &amp; Assignment</button></div>
  </form>`;
}

const PROJECT_TABS = [['overview', 'Overview'], ['list', 'List'], ['board', 'Board'], ['calendar', 'Calendar'], ['timeline', 'Timeline']];

function projectTabBar() {
  return `<div class="tabbar" role="tablist" aria-label="Project views">${PROJECT_TABS.map(([key, label]) => `<button type="button" role="tab" aria-selected="${state.projectTab === key}" class="${state.projectTab === key ? 'active' : ''}" data-action="set-project-tab" data-tab="${key}">${label}</button>`).join('')}</div>`;
}

function renderMilestoneList(milestones) {
  if (!milestones.length) return '<div class="empty small">No milestones yet.</div>';
  const tag = canManage() ? 'button' : 'div';
  const attrs = canManage() ? 'type="button" data-action="open-milestone"' : '';
  return `<div class="milestone-list">${milestones.map(item => `<${tag} class="milestone-item" ${attrs} data-id="${item.id}"><div><strong>${escapeHtml(item.name)}</strong><div class="small muted">${item.due_date ? escapeHtml(item.due_date) : 'No date'} · ${item.done_task_count || 0}/${item.task_count || 0} tasks</div></div>${badge(item.status)}</${tag}>`).join('')}</div>`;
}

function renderProjectOverview() {
  const project = state.project;
  const editAction = canManage() ? '<button class="secondary" data-action="edit-project">Edit details</button>' : '';
  return `<div class="grid cols-2" style="margin-top:16px">
    <section class="card stack">
      <div class="page-head compact-head"><h3>Project details</h3>${editAction}</div>
      <div class="kv">
        <div>Status</div><div>${badge(project.status)}</div>
        <div>Priority</div><div>${badge(project.priority || 'medium')}</div>
        <div>Owner</div><div>${personNameWithStatus(project.owner_id, memberForUser(project.owner_id)?.full_name || 'Unassigned')}</div>
        <div>Start date</div><div>${escapeHtml(project.start_date || 'Not set')}</div>
        <div>Due date</div><div>${escapeHtml(project.due_date || 'Not set')}</div>
        <div>Objective</div><div>${escapeHtml(project.objective || 'Not recorded')}</div>
        <div>Scope</div><div>${escapeHtml(project.scope || 'Not recorded')}</div>
        <div>Constraints</div><div>${escapeHtml(project.constraints || 'Not recorded')}</div>
        <div>Assumptions</div><div>${escapeHtml(project.assumptions || 'Not recorded')}</div>
      </div>
    </section>
    <section class="card stack">
      <h3>Jump to</h3>
      <div class="actions" style="flex-wrap:wrap">
        <button class="secondary" data-action="jump-view" data-view="risks">Risk & Decisions</button>
        <button class="secondary" data-action="jump-view" data-view="changes">Change Control</button>
        <button class="secondary" data-action="jump-view" data-view="meeting">Meeting Notes</button>
        <button class="secondary" data-action="jump-view" data-view="report">Reports</button>
      </div>
      <h3 style="margin-top:14px">Milestones</h3>
      ${renderMilestoneList(state.milestones)}
      ${canManage() ? '<button class="secondary" data-action="open-milestone" style="margin-top:8px">+ Add milestone</button>' : ''}
    </section>
  </div>
  <section class="card stack" style="margin-top:16px">
    <div class="page-head compact-head"><h3>Stories</h3><div class="actions">${canManage() ? '<button class="secondary" type="button" data-action="open-brief-analyzer">✨ Analyze Brief</button>' : ''}${canManage() ? '<button class="secondary" type="button" data-action="open-story">+ Add Story</button>' : ''}</div></div>
    ${renderStoryList()}
  </section>`;
}

function renderStoryList() {
  if (!state.stories.length) return '<div class="empty small">No stories yet. Break this project into stories to organize its tasks.</div>';
  return `<div class="story-list">${state.stories.map(story => {
    const total = Number(story.task_count || 0);
    const done = Number(story.done_task_count || 0);
    const percent = total ? Math.round((done / total) * 100) : 0;
    return `<div class="story-list-item" draggable="${canManage()}" data-drag-story="${story.id}" data-drop-story="${story.id}">
      <div class="story-list-item-head">
        <strong>${escapeHtml(story.name)}</strong>
        ${badge(story.status)}${badge(story.priority)}
        <button class="icon-action text-link" type="button" data-action="open-story" data-id="${story.id}" aria-label="Edit story" data-tooltip="Edit story">${ICONS.pencil}</button>
      </div>
      <div class="small muted">${story.department_name ? `${escapeHtml(story.department_name)} · ` : ''}${personNameWithStatus(story.owner_id, story.owner_name || 'Unassigned')}${story.due_date ? ` · Due ${escapeHtml(story.due_date)}` : ''}</div>
      <div class="progress" style="margin-top:8px"><span style="width:${percent}%"></span></div>
      <div class="small muted" style="margin-top:4px">${done}/${total} tasks done</div>
    </div>`;
  }).join('')}</div>`;
}

function nestedTaskOrder(tasks) {
  const byParent = new Map();
  for (const task of tasks) {
    const key = task.parent_task_id || null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(task);
  }
  const result = [];
  const visit = (parentId, depth) => {
    for (const task of byParent.get(parentId) || []) {
      result.push({ task, depth });
      visit(task.id, depth + 1);
    }
  };
  visit(null, 0);
  const includedIds = new Set(result.map(item => item.task.id));
  for (const task of tasks) if (!includedIds.has(task.id)) result.push({ task, depth: 0 });
  return result;
}

function filteredSortedTasks() {
  let tasks = state.tasks.filter(task => !task.rejected);
  const filters = state.taskFilters || {};
  if (filters.status && filters.status !== 'all') tasks = tasks.filter(task => task.status === filters.status);
  if (filters.priority && filters.priority !== 'all') tasks = tasks.filter(task => task.priority === filters.priority);
  if (filters.assignee && filters.assignee !== 'all') tasks = tasks.filter(task => String(task.owner_id || '') === filters.assignee);
  if (filters.phase && filters.phase !== 'all') tasks = tasks.filter(task => task.phase === filters.phase);
  if (filters.story && filters.story !== 'all') tasks = tasks.filter(task => String(task.story_id || 'none') === filters.story);
  const priorityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorters = {
    due_date: (a, b) => (a.due_date || '9999-99-99').localeCompare(b.due_date || '9999-99-99'),
    priority: (a, b) => priorityRank[a.priority] - priorityRank[b.priority],
    progress: (a, b) => b.progress - a.progress,
    title: (a, b) => a.title.localeCompare(b.title),
    phase: (a, b) => a.phase.localeCompare(b.phase) || a.id - b.id
  };
  return [...tasks].sort(sorters[state.taskSort] || sorters.phase);
}

function groupOrderedTasksByStory(ordered) {
  const groupOrder = [];
  const groups = new Map();
  let currentKey = 'none';
  for (const item of ordered) {
    if (item.depth === 0) currentKey = item.task.story_id ? String(item.task.story_id) : 'none';
    if (!groups.has(currentKey)) { groups.set(currentKey, []); groupOrder.push(currentKey); }
    groups.get(currentKey).push(item);
  }
  const storyMap = new Map(state.stories.map(story => [String(story.id), story]));
  return groupOrder.map(key => ({ story: storyMap.get(key) || null, rows: groups.get(key) }));
}

function taskRowMarkup(task, depth) {
  return `<tr class="${depth ? 'subtask-row' : ''}"><td style="padding-left:${12 + depth * 20}px">${depth ? '↳ ' : ''}<strong>${escapeHtml(task.title)}</strong><br><span class="small muted">${escapeHtml(task.phase)}${task.dependencies?.length ? ` · blocked by ${task.dependencies.length}` : ''}</span></td><td>${personNameWithStatus(task.owner_id, task.owner_name || 'Unassigned')}</td><td>${badge(task.priority)}</td><td>${badge(task.status)}</td><td>${task.progress}%</td><td>${escapeHtml(task.due_date || '—')}</td><td>${task.approved ? badge('approved') : badge('pending')}</td><td><div class="actions"><button class="icon-action" type="button" data-action="open-task" data-id="${task.id}" aria-label="Edit task" data-tooltip="Edit task">${ICONS.pencil}</button>${canManage() && !task.approved ? `<button class="primary" data-action="approve-task" data-id="${task.id}">Approve</button>` : ''}${canManage() ? `<button class="secondary" data-action="regenerate-task" data-id="${task.id}">Regenerate</button><button class="danger" data-action="reject-task" data-id="${task.id}">Reject</button>` : ''}</div></td></tr>`;
}

function renderTaskList() {
  const filters = state.taskFilters || {};
  const phases = [...new Set(state.tasks.map(task => task.phase))];
  const ordered = nestedTaskOrder(filteredSortedTasks());
  const storyGroups = groupOrderedTasksByStory(ordered);
  const filterBar = `<div class="task-filter-bar">
    <select data-task-filter="story"><option value="all">All stories</option><option value="none" ${filters.story === 'none' ? 'selected' : ''}>No story</option>${state.stories.map(story => `<option value="${story.id}" ${filters.story === String(story.id) ? 'selected' : ''}>${escapeHtml(story.name)}</option>`).join('')}</select>
    <select data-task-filter="status"><option value="all">All statuses</option>${['not_started', 'in_progress', 'blocked', 'done'].map(value => `<option value="${value}" ${filters.status === value ? 'selected' : ''}>${value.replaceAll('_', ' ')}</option>`).join('')}</select>
    <select data-task-filter="priority"><option value="all">All priorities</option>${['low', 'medium', 'high', 'critical'].map(value => `<option value="${value}" ${filters.priority === value ? 'selected' : ''}>${value}</option>`).join('')}</select>
    <select data-task-filter="assignee"><option value="all">All assignees</option>${state.members.filter(member => member.status === 'active').map(member => `<option value="${member.user_id}" ${filters.assignee === String(member.user_id) ? 'selected' : ''}>${escapeHtml(member.full_name)}</option>`).join('')}</select>
    <select data-task-filter="phase"><option value="all">All phases</option>${phases.map(phase => `<option value="${escapeHtml(phase)}" ${filters.phase === phase ? 'selected' : ''}>${escapeHtml(phase)}</option>`).join('')}</select>
    <select id="taskSortSelect">${[['phase', 'Sort: Phase'], ['due_date', 'Sort: Due date'], ['priority', 'Sort: Priority'], ['progress', 'Sort: Progress'], ['title', 'Sort: Title']].map(([value, label]) => `<option value="${value}" ${state.taskSort === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
    ${canManage() ? '<button class="secondary" type="button" data-action="open-story">+ Add Story</button>' : ''}
  </div>`;
  if (!storyGroups.length) return `${filterBar}<div class="card empty">No tasks match these filters.</div>`;
  const tables = storyGroups.map(({ story, rows }) => {
    const done = rows.filter(item => item.depth === 0 && item.task.status === 'done').length;
    const total = rows.filter(item => item.depth === 0).length;
    const heading = story
      ? `<div class="story-group-head"><h3>${escapeHtml(story.name)}</h3>${badge(story.status)}<span class="small muted">${done}/${total} done</span><button class="text-link" type="button" data-action="open-story" data-id="${story.id}">Edit story</button></div>`
      : `<div class="story-group-head"><h3>No story</h3><span class="small muted">${total} task${total === 1 ? '' : 's'}</span></div>`;
    return `${heading}<section class="card table-wrap"><table><thead><tr><th>Task</th><th>Owner</th><th>Priority</th><th>Status</th><th>Progress</th><th>Due</th><th>Approval</th><th>Actions</th></tr></thead><tbody>
      ${rows.map(({ task, depth }) => taskRowMarkup(task, depth)).join('')}
    </tbody></table></section>`;
  }).join('');
  return `${filterBar}${tables}`;
}

function tasksForStoryFilter(tasks) {
  const filters = state.taskFilters || {};
  if (!filters.story || filters.story === 'all') return tasks;
  return tasks.filter(task => String(task.story_id || 'none') === filters.story);
}

function storyFilterBar() {
  const filters = state.taskFilters || {};
  return `<div class="task-filter-bar"><select data-task-filter="story"><option value="all">All stories</option><option value="none" ${filters.story === 'none' ? 'selected' : ''}>No story</option>${state.stories.map(story => `<option value="${story.id}" ${filters.story === String(story.id) ? 'selected' : ''}>${escapeHtml(story.name)}</option>`).join('')}</select></div>`;
}

function boardTaskCardMarkup(task, storyMap) {
  const subtasks = state.tasks.filter(item => Number(item.parent_task_id) === Number(task.id) && !item.rejected);
  const doneSubtasks = subtasks.filter(item => item.status === 'done').length;
  const story = task.story_id ? storyMap.get(String(task.story_id)) : null;
  return `<div class="board-task-card" draggable="true" data-drag-board-task="${task.id}" data-action="open-task" data-id="${task.id}" role="button" tabindex="0" aria-label="Open ${escapeHtml(task.title)}">
    <span class="board-task-card-title">${escapeHtml(task.title)}</span>
    ${story ? `<div class="board-task-card-story">${escapeHtml(story.name)}</div>` : ''}
    ${subtasks.length ? `<div class="small muted">${doneSubtasks} / ${subtasks.length} subtasks</div>` : ''}
    <div class="progress" style="margin-top:8px"><span style="width:${task.progress}%"></span></div>
    ${task.team_name ? `<div class="small muted">🏷️ ${escapeHtml(task.team_name)}</div>` : ''}
    <div class="board-task-card-meta">${badge(task.priority)}<span class="small muted">${personNameWithStatus(task.owner_id, task.owner_name || 'Unassigned')}</span>${task.due_date ? `<span class="small muted">Due ${escapeHtml(task.due_date)}</span>` : ''}<button type="button" class="icon-action" data-action="quick-assign-task" data-id="${task.id}" aria-label="Assign task" data-tooltip="Assign">${ICONS.userPlus}</button></div>
  </div>`;
}

function renderTaskBoard() {
  const filters = state.taskFilters || {};
  const filterActive = Boolean(filters.story && filters.story !== 'all');
  const tasks = tasksForStoryFilter(state.tasks.filter(task => !task.rejected && !task.parent_task_id));
  const storyMap = new Map(state.stories.map(story => [String(story.id), story]));
  const columns = [...state.boardColumns].sort((a, b) => a.position - b.position);
  const columnsHtml = columns.map(column => {
    const columnTasks = tasks.filter(task => Number(task.column_id) === Number(column.id)).sort((a, b) => a.board_position - b.board_position);
    const cardsHtml = columnTasks.map(task => boardTaskCardMarkup(task, storyMap)).join('') || '<div class="board-empty-hint">Drop tasks here</div>';
    return `<div class="kanban-column" data-column-id="${column.id}">
      <div class="kanban-column-head" ${canManage() ? 'draggable="true"' : ''} data-drag-column="${column.id}">
        <span class="kanban-column-title">${escapeHtml(column.name)}</span>
        <span class="kanban-column-count">${columnTasks.length}</span>
        ${canManage() ? `<button type="button" class="icon-button" data-action="open-column-options" data-id="${column.id}" aria-label="Column options" data-tooltip="Column options">${ICONS.moreHorizontal}</button>` : ''}
      </div>
      <div class="kanban-column-body" data-drop-board-column="${column.id}">${cardsHtml}</div>
      <div class="kanban-column-foot"><button type="button" class="secondary" data-action="add-task-to-column" data-id="${column.id}">${ICONS.plus} Add task</button></div>
    </div>`;
  }).join('');
  const addColumnTile = canManage() ? `<button type="button" class="kanban-add-column" data-action="open-add-column">${ICONS.plus} Add column</button>` : '';
  const notice = filterActive ? '<div class="notice kanban-filtered-notice">A story filter is active — drag-and-drop reordering within a column is disabled while filtered, to avoid disturbing hidden tasks. Moving a card to a different column still works.</div>' : '';
  return `${storyFilterBar()}${notice}<div class="kanban-board">${columnsHtml}${addColumnTile}</div>`;
}

function renderTaskCalendar() {
  const [year, month] = state.calendarMonth.split('-').map(Number);
  const firstOfMonth = new Date(year, month - 1, 1);
  const startWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthLabel = firstOfMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const itemsByDate = new Map();
  const addItem = (dateStr, html) => {
    if (!dateStr) return;
    if (!itemsByDate.has(dateStr)) itemsByDate.set(dateStr, []);
    itemsByDate.get(dateStr).push(html);
  };
  for (const task of state.tasks.filter(item => !item.rejected)) {
    if (task.due_date) addItem(task.due_date, `<button type="button" class="calendar-item task" data-action="open-task" data-id="${task.id}">${escapeHtml(task.title)}</button>`);
  }
  for (const milestone of state.milestones) {
    if (milestone.due_date) addItem(milestone.due_date, `<span class="calendar-item milestone">🚩 ${escapeHtml(milestone.name)}</span>`);
  }
  const cells = [];
  for (let i = 0; i < startWeekday; i += 1) cells.push('<div class="calendar-cell empty-cell"></div>');
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const items = itemsByDate.get(dateStr) || [];
    cells.push(`<div class="calendar-cell"><div class="calendar-date">${day}</div>${items.slice(0, 4).join('')}${items.length > 4 ? `<div class="small muted">+${items.length - 4} more</div>` : ''}</div>`);
  }
  return `<div class="calendar-toolbar"><button class="icon-action" type="button" data-action="calendar-prev" aria-label="Previous month" data-tooltip="Previous month">${ICONS.chevronLeft}</button><h3>${escapeHtml(monthLabel)}</h3><button class="icon-action" type="button" data-action="calendar-next" aria-label="Next month" data-tooltip="Next month">${ICONS.chevronRight}</button></div>
  <div class="calendar-grid">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => `<div class="calendar-weekday">${day}</div>`).join('')}${cells.join('')}</div>`;
}

function renderTaskTimeline() {
  const tasks = tasksForStoryFilter(state.tasks.filter(task => !task.rejected && (task.start_date || task.due_date)));
  if (!tasks.length) return `${storyFilterBar()}<div class="card empty">No tasks with start/due dates match this filter.</div>`;
  const allDates = tasks.flatMap(task => [task.start_date, task.due_date]).filter(Boolean).map(value => new Date(value).getTime());
  const minTime = Math.min(...allDates);
  const maxTime = Math.max(...allDates, minTime + 86_400_000);
  const span = maxTime - minTime || 1;
  const phases = [...new Set(tasks.map(task => task.phase))];
  const rows = phases.map(phase => {
    const phaseTasks = tasks.filter(task => task.phase === phase);
    return `<div class="timeline-phase-label">${escapeHtml(phase)}</div>${phaseTasks.map(task => {
      const start = task.start_date ? new Date(task.start_date).getTime() : new Date(task.due_date).getTime();
      const end = task.due_date ? new Date(task.due_date).getTime() : start + 86_400_000;
      const left = ((start - minTime) / span) * 100;
      const width = Math.max(((end - start) / span) * 100, 1.5);
      const dependencyNames = (task.dependencies || []).map(id => state.tasks.find(item => Number(item.id) === id)?.title).filter(Boolean);
      return `<div class="timeline-row"><div class="timeline-row-label">${escapeHtml(task.title)}${dependencyNames.length ? ` <span class="small muted" title="Blocked by: ${escapeHtml(dependencyNames.join(', '))}">(blocked by ${dependencyNames.length})</span>` : ''}</div><div class="timeline-track"><div class="timeline-bar status-${escapeHtml(task.status)}" style="left:${left}%;width:${width}%" data-action="open-task" data-id="${task.id}" role="button" tabindex="0" aria-label="${escapeHtml(task.title)}"><span>${task.progress}%</span></div></div></div>`;
    }).join('')}`;
  }).join('');
  const milestoneMarkers = state.milestones.filter(item => item.due_date).map(item => {
    const time = new Date(item.due_date).getTime();
    if (time < minTime || time > maxTime) return '';
    const left = ((time - minTime) / span) * 100;
    return `<div class="timeline-milestone-marker" style="left:${left}%" title="${escapeHtml(item.name)} · ${escapeHtml(item.due_date)}">🚩</div>`;
  }).join('');
  return `${storyFilterBar()}<section class="card timeline-wrap"><div class="timeline-axis-row"><div class="timeline-row-label"></div><div class="timeline-track">${milestoneMarkers}</div></div>${rows}</section>`;
}

function renderWork() {
  if (!state.project) return noProject();
  const actions = `${canManage() ? '<button class="primary" data-action="generate-plan">Generate AI plan</button>' : ''}<button class="secondary" data-action="open-task">Add task</button>`;
  const tabRenderers = { overview: renderProjectOverview, list: renderTaskList, board: renderTaskBoard, calendar: renderTaskCalendar, timeline: renderTaskTimeline };
  const activeTab = tabRenderers[state.projectTab] ? state.projectTab : 'overview';
  return `${pageHead(escapeHtml(state.project.name), 'Create, assign, update, approve, reject, or regenerate project tasks.', actions)}
  <div class="notice warning"><strong>Human control:</strong> AI-generated tasks remain pending until a CEO, admin, or moderator approves or edits them.</div>
  ${projectTabBar()}
  <div style="margin-top:16px">${tabRenderers[activeTab]()}</div>`;
}

function renderMeeting() {
  if (!state.project) return noProject();
  if (!canManage()) return '<div class="notice danger">Only CEO, admin, or moderator can process meeting notes.</div>';
  const pending = state.suggestions.filter(item => item.status === 'pending');
  return `${pageHead('Meeting notes', 'Convert explicit actions, decisions, and blockers into approval-ready proposals.')}
  <form id="meetingForm" class="card stack"><label>Meeting notes<textarea name="notes" required placeholder="Paste meeting notes. Explicit wording produces better proposals."></textarea></label><div class="actions"><button class="primary" type="submit">Create proposals</button></div></form>
  <section style="margin-top:16px"><h3>Pending proposals</h3>${pending.map(item => `<div class="card" style="margin-bottom:10px"><div class="actions" style="justify-content:space-between"><div>${badge(item.suggestion_type)} ${badge(item.status)}</div><div><button class="primary" data-action="approve-suggestion" data-id="${item.id}">Approve</button><button class="danger" data-action="reject-suggestion" data-id="${item.id}">Reject</button></div></div><p>${escapeHtml(item.evidence)}</p><div class="small muted">${escapeHtml(item.rationale)}</div></div>`).join('') || '<div class="empty">No meeting-note proposals await review.</div>'}</section>`;
}

function renderRisks() {
  if (!state.project) return noProject();
  return `${pageHead('Risks & decisions', 'Evidence-based warnings and approved project decisions.', canManage() ? '<button class="primary" data-action="scan-risks">Run risk scan</button>' : '')}
  <div class="grid cols-2"><section><h3>Risk register</h3>${state.risks.map(risk => `<div class="card" style="margin-bottom:10px"><div class="actions">${badge(risk.severity)} ${badge(risk.status)} ${risk.approved ? badge('approved') : badge('pending')}</div><h3 style="margin-top:10px">${escapeHtml(risk.title)}</h3><p>${escapeHtml(risk.description)}</p><div class="notice"><strong>Evidence:</strong> ${escapeHtml(risk.evidence || 'No evidence recorded')}</div>${canManage() && !risk.approved ? `<button class="primary" data-action="approve-risk" data-id="${risk.id}">Approve warning</button>` : ''}</div>`).join('') || '<div class="empty">No risks stored. Run the scan.</div>'}</section>
  <section><h3>Decision history</h3>${state.decisions.map(decision => `<div class="card" style="margin-bottom:10px"><div>${badge(decision.status)} <span class="small muted">${escapeHtml(decision.source)}</span></div><h3 style="margin-top:10px">${escapeHtml(decision.title)}</h3><p>${escapeHtml(decision.detail)}</p><div class="small muted">Owner: ${escapeHtml(decision.owner || 'Not recorded')} · ${escapeHtml(decision.created_at)}</div></div>`).join('') || '<div class="empty">No approved decisions stored.</div>'}</section></div>`;
}

function renderChanges() {
  if (!state.project) return noProject();
  return `${pageHead('Change Control', 'Analyze likely scope, effort, dependency, and workload effects before approval.')}
  <form id="changeForm" class="card form-grid"><label>Change title<input name="title" required></label><label>Requested by<input name="requested_by"></label><label class="full">Description<textarea name="description" required></textarea></label><div class="full actions"><button class="primary" type="submit">Analyze and submit</button></div></form>
  <div class="change-grid">${state.changes.map(change => `<article class="card change-card">
      <div class="change-card-head">
        <div class="change-card-title">${badge(change.status)}<strong>${escapeHtml(change.title)}</strong></div>
        ${canManage() && change.status === 'pending' ? `<div class="actions"><button class="primary" data-action="review-change" data-review="approve" data-id="${change.id}">Approve</button><button class="danger" data-action="review-change" data-review="reject" data-id="${change.id}">Reject</button></div>` : ''}
      </div>
      <p>${escapeHtml(change.description)}</p>
      <div class="kv"><div>Scope</div><div>${escapeHtml(change.impact_scope)}</div><div>Effort</div><div>${escapeHtml(change.impact_effort)}</div><div>Dependencies</div><div>${escapeHtml(change.impact_dependencies)}</div><div>Workload</div><div>${escapeHtml(change.impact_workload)}</div></div>
    </article>`).join('') || '<div class="empty">No change requests stored.</div>'}</div>`;
}

function renderReport() {
  if (!state.project || !state.report) return noProject();
  return `${pageHead('Reports & export', 'Factual project reporting assembled only from stored records.', '<button class="primary" data-action="download" data-format="json">Export JSON</button><button class="secondary" data-action="download" data-format="csv">Export CSV</button>')}
  <div class="notice">${escapeHtml(state.report.reliability_note)}</div><pre class="report">${escapeHtml(JSON.stringify(state.report, null, 2))}</pre>`;
}

function renderMembers() {
  const activeMembers = state.members.filter(member => member.status === 'active');
  const onlineMembers = activeMembers.filter(member => member.current_status === 'online');
  const departments = [...new Set(activeMembers.map(member => member.department || 'General'))].sort((a, b) => a.localeCompare(b));
  const actions = `<button class="secondary" data-action="edit-profile">Edit my profile</button>${canManage() ? '<button class="primary" data-action="open-admin">Invite & manage members</button>' : ''}`;
  return `${pageHead('People directory', 'Everyone in this organization, including their role, department, membership state, and live Slack-style presence.', actions)}
  <div class="grid cols-3 member-metrics">
    <div class="card"><div class="small muted">Active members</div><div class="metric">${activeMembers.length}</div></div>
    <div class="card"><div class="small muted">Online now</div><div class="metric">${onlineMembers.length}</div></div>
    <div class="card"><div class="small muted">Departments</div><div class="metric">${departments.length}</div></div>
  </div>
  <section class="card member-directory-card">
    <div class="member-filters">
      <label>Search<input id="memberSearch" value="${escapeHtml(state.memberSearch)}" placeholder="Name, username, email, or department"></label>
      <label>Department<select id="memberDepartment"><option value="all">All departments</option>${departments.map(department => `<option value="${escapeHtml(department.toLowerCase())}" ${state.memberDepartment === department.toLowerCase() ? 'selected' : ''}>${escapeHtml(department)}</option>`).join('')}</select></label>
      <label>Presence<select id="memberPresence"><option value="all">All statuses</option>${['online','away','dnd','offline'].map(status => `<option value="${status}" ${state.memberPresence === status ? 'selected' : ''}>${presenceLabel(status)}</option>`).join('')}</select></label>
    </div>
    <div class="directory-summary"><strong id="memberResultsCount">${state.members.length}</strong> people shown</div>
    <div id="memberDirectory" class="member-grid">
      ${state.members.map(member => {
        const search = `${member.full_name} ${member.username} ${member.email} ${member.department}`.toLowerCase();
        const presenceText = member.status === 'suspended' ? 'Membership suspended' : presenceLabel(member.current_status);
        return `<article class="member-card ${member.status === 'suspended' ? 'suspended-member' : ''}" data-member-card data-search="${escapeHtml(search)}" data-department="${escapeHtml((member.department || 'General').toLowerCase())}" data-presence="${escapeHtml(member.current_status || 'offline')}">
          <div class="member-card-head">${avatarMarkup(member, 'large')}<div class="member-card-identity"><div class="name-with-status"><strong>${escapeHtml(member.full_name)}</strong>${statusMarkup(member, true)}</div><span>@${escapeHtml(member.username)}</span></div></div>
          <div class="member-card-badges">${badge(member.role)} ${member.status !== 'active' ? badge(member.status) : ''}</div>
          <dl class="member-details"><div><dt>Department</dt><dd>${escapeHtml(member.department || 'General')}</dd></div><div><dt>Current status</dt><dd><span class="presence-inline"><i class="presence-dot static ${escapeHtml(member.current_status || 'offline')}"></i>${escapeHtml(presenceText)}</span></dd></div></dl>
          ${member.custom_status ? `<p class="custom-status">“${escapeHtml(member.custom_status)}”</p>` : ''}
          <div class="member-card-footer"><span>${escapeHtml(member.email)}</span><span>${escapeHtml(relativeTime(member.last_seen_at))}</span></div>
        </article>`;
      }).join('') || '<div class="empty">No organization members yet.</div>'}
    </div>
    <div id="memberFilterEmpty" class="empty hidden">No members match these filters.</div>
  </section>`;
}

function applyMemberFilters() {
  const searchInput = $('#memberSearch');
  const departmentSelect = $('#memberDepartment');
  const presenceFilter = $('#memberPresence');
  if (!searchInput || !departmentSelect || !presenceFilter) return;
  state.memberSearch = searchInput.value.trim().toLowerCase();
  state.memberDepartment = departmentSelect.value;
  state.memberPresence = presenceFilter.value;
  let visible = 0;
  $$('[data-member-card]').forEach(card => {
    const matchesSearch = !state.memberSearch || card.dataset.search.includes(state.memberSearch);
    const matchesDepartment = state.memberDepartment === 'all' || card.dataset.department === state.memberDepartment;
    const matchesPresence = state.memberPresence === 'all' || card.dataset.presence === state.memberPresence;
    const show = matchesSearch && matchesDepartment && matchesPresence;
    card.classList.toggle('hidden', !show);
    if (show) visible += 1;
  });
  const count = $('#memberResultsCount');
  if (count) count.textContent = String(visible);
  $('#memberFilterEmpty')?.classList.toggle('hidden', visible !== 0);
}

function roleOptions(member) {
  const actorRole = currentRole();
  const roles = actorRole === 'ceo' ? ['admin', 'moderator', 'member'] : ['moderator', 'member'];
  return roles.map(role => `<option value="${role}" ${member.role === role ? 'selected' : ''}>${role}</option>`).join('');
}

function renderMemberRow(member) {
  const actorRole = currentRole();
  const editable = roleCanApproveMembers(actorRole) && member.role !== 'ceo' && !(actorRole !== 'ceo' && member.role === 'admin');
  const roleCell = editable ? `<select data-member-role="${member.membership_id}">${roleOptions(member)}</select>` : badge(member.role);
  const departmentCell = editable ? `<input data-member-department="${member.membership_id}" value="${escapeHtml(member.department || 'General')}" maxlength="80">` : escapeHtml(member.department || 'General');
  const structuredDepartmentCell = editable
    ? `<select data-member-department-id="${member.membership_id}"><option value="">None</option>${state.departments.map(department => `<option value="${department.id}" ${Number(member.department_id) === Number(department.id) ? 'selected' : ''}>${escapeHtml(department.name)}</option>`).join('')}</select>`
    : escapeHtml(member.department_name || '—');
  const managerCell = editable
    ? `<select data-member-manager="${member.membership_id}"><option value="">None</option>${state.members.filter(other => Number(other.user_id) !== Number(member.user_id) && other.status === 'active').map(other => `<option value="${other.user_id}" ${Number(member.manager_user_id) === Number(other.user_id) ? 'selected' : ''}>${escapeHtml(other.full_name)}</option>`).join('')}</select>`
    : escapeHtml(member.manager_name || '—');
  const jobRoleCell = editable
    ? `<select data-member-job-role="${member.membership_id}"><option value="">None</option>${state.jobRoles.map(role => `<option value="${role.id}" ${Number(member.job_role_id) === Number(role.id) ? 'selected' : ''}>${escapeHtml(role.name)}</option>`).join('')}</select>`
    : escapeHtml(member.job_role_name || '—');
  const statusCell = editable ? `<select data-member-status="${member.membership_id}"><option value="active" ${member.status === 'active' ? 'selected' : ''}>active</option><option value="suspended" ${member.status === 'suspended' ? 'selected' : ''}>suspended</option></select>` : badge(member.status);
  const presenceCell = `<div class="member-presence-stack">${statusMarkup(member)}<span class="presence-inline"><i class="presence-dot static ${escapeHtml(member.current_status || 'offline')}"></i>${escapeHtml(presenceLabel(member.current_status))}</span>${member.custom_status ? `<small>${escapeHtml(member.custom_status)}</small>` : ''}</div>`;
  const actionsCell = member.role === 'ceo'
    ? '<span class="small muted">Protected CEO account</span>'
    : editable
      ? `<div class="actions"><button class="secondary" data-action="save-member" data-id="${member.membership_id}">Save</button><button class="danger" data-action="remove-member" data-id="${member.membership_id}">Remove</button></div>`
      : '<span class="small muted">Read-only for your role</span>';
  return `<tr><td><div class="member-cell">${avatarMarkup(member)}<div><div class="name-with-status"><strong>${escapeHtml(member.full_name)}</strong>${statusMarkup(member, true)}</div><small>@${escapeHtml(member.username)} · ${escapeHtml(member.email)}</small></div></div></td><td>${roleCell}</td><td>${departmentCell}</td><td>${structuredDepartmentCell}</td><td>${managerCell}</td><td>${jobRoleCell}</td><td>${presenceCell}</td><td>${statusCell}</td><td>${actionsCell}</td></tr>`;
}

function renderTeamsHub() {
  if (state.teamsDetail?.type === 'department') return renderDepartmentDetail(state.teamsDetail.id);
  if (state.teamsDetail?.type === 'team') return renderTeamDetail(state.teamsDetail.id);
  if (state.teamsDetail?.type === 'distribute') return renderDistributeWork(state.teamsDetail.id);

  const actions = `${canManage() ? '<button class="secondary" type="button" data-action="open-department">+ Add Department</button>' : ''}${canManage() ? '<button class="secondary" type="button" data-action="open-team">+ Add Team</button>' : ''}`;
  const departmentCards = state.departments.map(dept => {
    const teamsInDept = state.teams.filter(team => Number(team.department_id) === Number(dept.id));
    const canOpenWorkspace = canManage() || Number(dept.manager_user_id) === Number(state.user.id);
    return `<article class="card department-card">
      <div class="project-card-head"><h3>${escapeHtml(dept.name)}</h3>${canManage() ? `<button class="icon-action text-link" type="button" data-action="open-department" data-id="${dept.id}" aria-label="Edit department" data-tooltip="Edit department">${ICONS.pencil}</button>` : ''}</div>
      <div class="small muted">Manager: ${dept.manager_name ? escapeHtml(dept.manager_name) : 'Unassigned'}</div>
      <div class="small muted" style="margin-top:4px">${dept.member_count || 0} member${Number(dept.member_count) === 1 ? '' : 's'} · ${dept.team_count || 0} team${Number(dept.team_count) === 1 ? '' : 's'}</div>
      ${teamsInDept.length ? `<div class="actions" style="margin-top:10px;flex-wrap:wrap">${teamsInDept.map(team => `<button class="secondary" type="button" data-action="view-team" data-id="${team.id}"># ${escapeHtml(team.name)}</button>`).join('')}</div>` : ''}
      ${canOpenWorkspace ? `<button class="primary" type="button" data-action="view-department" data-id="${dept.id}" style="margin-top:10px;width:100%">Open Manager Workspace</button>` : ''}
    </article>`;
  }).join('') || '<div class="card empty">No departments yet. Create one to start organizing teams and managers.</div>';

  const unassignedTeams = state.teams.filter(team => !team.department_id);
  const unassignedSection = unassignedTeams.length ? `<section class="card stack" style="margin-top:16px"><h3>Teams without a department</h3><div class="actions" style="flex-wrap:wrap">${unassignedTeams.map(team => `<button class="secondary" type="button" data-action="view-team" data-id="${team.id}"># ${escapeHtml(team.name)}</button>`).join('')}</div></section>` : '';

  return `${pageHead('Teams', 'Departments, teams, and managers across your organization.', actions)}
  <div class="grid cols-3">${departmentCards}</div>
  ${unassignedSection}`;
}

function renderDepartmentDetail(departmentId) {
  const backAction = `<button class="icon-action" type="button" data-action="teams-back" aria-label="Back to Teams" data-tooltip="Back to Teams">${ICONS.arrowLeft}</button>`;
  const entry = state.managerWorkspace?.departments?.find(item => Number(item.department.id) === Number(departmentId));
  const fallbackDepartment = state.departments.find(item => Number(item.id) === Number(departmentId));
  if (!entry) {
    return `${pageHead(fallbackDepartment ? fallbackDepartment.name : 'Department', 'You do not have manager access to this department.', backAction)}<div class="card empty">Only the department manager, CEO, or admin can view this workspace.</div>`;
  }
  const { department, teams, workload, stories, deadline_tasks: deadlineTasks, blocked_tasks: blockedTasks } = entry;
  return `${pageHead(department.name, 'Manager workspace', backAction)}
  <div class="grid cols-4">
    <div class="card"><div class="small muted">Teams</div><div class="metric">${teams.length}</div></div>
    <div class="card"><div class="small muted">People</div><div class="metric">${entry.roster.length}</div></div>
    <div class="card"><div class="small muted">Stories</div><div class="metric">${stories.length}</div></div>
    <div class="card"><div class="small muted">Blocked tasks</div><div class="metric ${blockedTasks.length ? 'danger' : ''}">${blockedTasks.length}</div></div>
  </div>
  <div class="grid cols-2" style="margin-top:16px">
    <section class="card">
      <h3>Team workload</h3>
      ${workload.length ? workload.map(person => {
        const capacity = person.capacity || 5;
        const percent = Math.min(100, Math.round((person.active_task_count / capacity) * 100));
        const overloaded = person.active_task_count > capacity;
        return `<div class="workload-row"><span>${escapeHtml(person.full_name)}</span><div class="progress"><span style="width:${percent}%;${overloaded ? 'background:var(--danger)' : ''}"></span></div><span class="small muted">${person.active_task_count}/${capacity}${overloaded ? ' · Overloaded' : ''}</span></div>`;
      }).join('') : '<div class="empty small">No team members yet.</div>'}
    </section>
    <section class="card">
      <div class="page-head compact-head"><h3>Teams</h3>${canManage() || Number(department.manager_user_id) === Number(state.user.id) ? `<button class="secondary" type="button" data-action="open-team" data-department-id="${department.id}">+ Add team</button>` : ''}</div>
      ${teams.length ? teams.map(team => `<div class="milestone-item" style="margin-bottom:8px"><div><strong>${escapeHtml(team.name)}</strong><div class="small muted">${team.member_count || 0} members</div></div><button class="text-link" type="button" data-action="view-team" data-id="${team.id}">Open</button></div>`).join('') : '<div class="empty small">No teams in this department yet.</div>'}
    </section>
  </div>
  <section class="card" style="margin-top:16px">
    <h3>Stories in this department</h3>
    ${stories.length ? `<div class="story-list">${stories.map(story => `<div class="story-list-item"><div class="story-list-item-head"><strong>${escapeHtml(story.name)}</strong>${badge(story.status)}<span class="small muted">${escapeHtml(story.project_name)}</span></div><div class="progress" style="margin-top:8px"><span style="width:${story.task_count ? Math.round((story.done_task_count / story.task_count) * 100) : 0}%"></span></div></div>`).join('')}</div>` : '<div class="empty small">No stories assigned to this department yet.</div>'}
  </section>
  <div class="grid cols-2" style="margin-top:16px">
    <section class="card"><h3>Upcoming deadlines</h3>${deadlineTasks.length ? deadlineTasks.map(task => `<div class="notice"><strong>${escapeHtml(task.title)}</strong><div class="small">Due ${escapeHtml(task.due_date)}</div></div>`).join('') : '<div class="empty small">Nothing due soon.</div>'}</section>
    <section class="card"><h3>Blocked work</h3>${blockedTasks.length ? blockedTasks.map(task => `<div class="notice danger"><strong>${escapeHtml(task.title)}</strong></div>`).join('') : '<div class="empty small">Nothing blocked.</div>'}</section>
  </div>`;
}

function renderTeamDetail(teamId) {
  const backAction = `<button class="icon-action" type="button" data-action="teams-back" aria-label="Back to Teams" data-tooltip="Back to Teams">${ICONS.arrowLeft}</button>`;
  const data = state.teamWorkspaceData;
  if (!data || Number(data.team.id) !== Number(teamId)) return `${pageHead('Team', '', backAction)}<div class="card empty">Loading…</div>`;
  const { team, members, workload, tasks, projects, overdue_count: overdueCount, needs_distribution: needsDistribution } = data;
  const canEditTeam = canManage() || Number(team.lead_user_id) === Number(state.user.id);
  const distributionStories = needsDistribution?.stories || [];
  const needsDistributionCount = distributionStories.reduce((sum, group) => sum + group.tasks.length + group.subtasks.length, 0);
  const distributionBanner = canEditTeam && needsDistributionCount ? `<section class="card notice" style="margin-top:16px">
    <div class="page-head compact-head"><div><strong>${needsDistributionCount} item${needsDistributionCount === 1 ? '' : 's'} need distribution</strong><p class="small muted">Review and assign AI-generated or manually routed work for this team.</p></div>
    <button type="button" class="primary" data-action="open-distribute-work" data-id="${team.id}">Distribute Work</button></div>
  </section>` : '';
  return `${pageHead(team.name, team.description || 'Team workspace', backAction)}
  <div class="grid cols-4">
    <div class="card"><div class="small muted">Members</div><div class="metric">${members.length}</div></div>
    <div class="card"><div class="small muted">Assigned projects</div><div class="metric">${projects.length}</div></div>
    <div class="card"><div class="small muted">Open tasks</div><div class="metric">${tasks.filter(task => task.status !== 'done').length}</div></div>
    <div class="card"><div class="small muted">Overdue</div><div class="metric ${overdueCount ? 'danger' : ''}">${overdueCount}</div></div>
  </div>
  ${distributionBanner}
  <div class="grid cols-2" style="margin-top:16px">
    <section class="card">
      <div class="page-head compact-head"><h3>Members</h3>${canEditTeam ? `<button class="secondary" type="button" data-action="add-team-member" data-id="${team.id}">+ Add member</button>` : ''}</div>
      ${members.length ? members.map(person => `<div class="milestone-item" style="margin-bottom:8px"><div><strong>${escapeHtml(person.full_name)}</strong>${person.role_in_team ? `<div class="small muted">${escapeHtml(person.role_in_team)}</div>` : ''}</div>${canEditTeam ? `<button class="danger" type="button" data-action="remove-team-member" data-id="${team.id}" data-user-id="${person.user_id}">Remove</button>` : ''}</div>`).join('') : '<div class="empty small">No members yet.</div>'}
    </section>
    <section class="card">
      <h3>Workload</h3>
      ${workload.length ? workload.map(person => {
        const capacity = person.capacity || 5;
        const percent = Math.min(100, Math.round((person.active_task_count / capacity) * 100));
        return `<div class="workload-row"><span>${escapeHtml(person.full_name)}</span><div class="progress"><span style="width:${percent}%"></span></div><span class="small muted">${person.active_task_count}/${capacity}</span></div>`;
      }).join('') : '<div class="empty small">No members yet.</div>'}
    </section>
  </div>
  <section class="card table-wrap" style="margin-top:16px"><h3>Team tasks</h3><table><thead><tr><th>Task</th><th>Project</th><th>Status</th><th>Due</th></tr></thead><tbody>
    ${tasks.slice(0, 50).map(task => `<tr><td>${escapeHtml(task.title)}</td><td>${escapeHtml(task.project_name)}</td><td>${badge(task.status)}</td><td>${escapeHtml(task.due_date || '—')}</td></tr>`).join('') || '<tr><td colspan="4"><div class="empty">No tasks yet.</div></td></tr>'}
  </tbody></table></section>`;
}

function distributeWorkerOptions(members, ownerId) {
  return `<option value="">Unassigned</option>${members.map(person => `<option value="${person.user_id}" ${Number(ownerId) === Number(person.user_id) ? 'selected' : ''}>${escapeHtml(person.full_name)}</option>`).join('')}`;
}

function distributeTaskRow(item, members, isSubtask) {
  return `<tr data-distribute-row data-id="${item.id}">
    <td><input type="checkbox" data-distribute-check value="${item.id}"></td>
    <td>${isSubtask ? '↳ ' : ''}${escapeHtml(item.title)}${isSubtask && item.parent_task_title ? `<div class="small muted">Subtask of ${escapeHtml(item.parent_task_title)}</div>` : ''}</td>
    <td>${badge(item.priority)}</td>
    <td>${escapeHtml(item.due_date || '—')}</td>
    <td><select data-distribute-owner data-id="${item.id}">${distributeWorkerOptions(members, item.owner_id)}</select></td>
  </tr>`;
}

function renderDistributeWork(teamId) {
  const backAction = `<button class="icon-action" type="button" data-action="view-team" data-id="${teamId}" aria-label="Back to team" data-tooltip="Back to team">${ICONS.arrowLeft}</button>`;
  const data = state.teamWorkspaceData;
  if (!data || Number(data.team.id) !== Number(teamId)) return `${pageHead('Distribute Work', '', backAction)}<div class="card empty">Loading…</div>`;
  const { team, members, needs_distribution: needsDistribution } = data;
  const stories = needsDistribution?.stories || [];
  const storyBlocks = stories.map(group => `
    <section class="card" style="margin-top:16px">
      <div class="page-head compact-head"><h3>${escapeHtml(group.story_name)}</h3><span class="small muted">${escapeHtml(group.project_name)}</span></div>
      <div class="table-wrap"><table><thead><tr><th></th><th>Task</th><th>Priority</th><th>Due</th><th>Assignee</th></tr></thead><tbody>
        ${group.tasks.map(item => distributeTaskRow(item, members, false)).join('')}
        ${group.subtasks.map(item => distributeTaskRow(item, members, true)).join('')}
      </tbody></table></div>
    </section>`).join('') || '<div class="card empty" style="margin-top:16px">Nothing needs distribution right now — all of this team’s work is assigned.</div>';
  const actions = stories.length ? `<div class="page-head compact-head"><span class="small muted">Pick an assignee per row and save, or select rows and assign them all to one worker.</span>
    <div class="actions">
      <button type="button" class="secondary" data-action="distribute-select-all">Select all</button>
      <select id="distributeBulkOwner">${distributeWorkerOptions(members, null)}</select>
      <button type="button" class="secondary" data-action="distribute-assign-selected" data-team-id="${teamId}">Assign selected</button>
      <button type="button" class="primary" data-action="distribute-save-assignments" data-team-id="${teamId}">Save Assignments</button>
    </div>
  </div>` : '';
  return `${pageHead('Distribute Work', `${escapeHtml(team.name)} · unassigned work awaiting a worker`, backAction)}
  <section class="card" style="margin-top:16px">${actions}</section>
  ${storyBlocks}`;
}

function renderAdmin() {
  if (!canManage()) return '<div class="notice danger">This dashboard is available to CEO, admin, and moderator roles.</div>';
  const awaiting = state.invitations.filter(item => item.status === 'awaiting_approval');
  const proposedRoles = currentRole() === 'ceo' ? ['member', 'moderator', 'admin'] : currentRole() === 'admin' ? ['member', 'moderator'] : ['member'];
  const openInvitations = state.invitations.filter(item => ['invited', 'awaiting_approval'].includes(item.status));
  return `${pageHead('Member administration', 'Invite registered users, approve access, assign roles and departments, and control membership.', '<button class="secondary" data-action="open-members">View people directory</button>')}
  <div class="grid cols-4">
    <div class="card"><div class="small muted">Active members</div><div class="metric">${state.members.filter(member => member.status === 'active').length}</div></div>
    <div class="card"><div class="small muted">Online now</div><div class="metric">${state.members.filter(member => member.status === 'active' && member.current_status === 'online').length}</div></div>
    <div class="card"><div class="small muted">Open invitations</div><div class="metric">${openInvitations.length}</div></div>
    <div class="card"><div class="small muted">Your role</div><div class="metric role-metric">${escapeHtml(currentRole())}</div></div>
  </div>
  <div class="grid cols-2" style="margin-top:16px">
    <form id="inviteForm" class="card stack"><h3>Invite registered user</h3><div class="notice">Enter the exact username or email. The user accepts first; CEO/admin approval then activates the membership.</div><label>Username or email<input name="identifier" required></label><label>Department<input name="proposed_department" maxlength="80" value="General" required></label><label>Proposed role<select name="proposed_role">${proposedRoles.map(role => `<option value="${role}">${role}</option>`).join('')}</select></label><button class="primary" type="submit">Send invitation</button></form>
    <section class="card"><h3>Join approvals</h3>${awaiting.map(invitation => `<div class="invitation-card"><strong>${escapeHtml(invitation.invited_name)}</strong><p class="small muted">@${escapeHtml(invitation.invited_username)} · ${escapeHtml(invitation.invited_email)}</p><p class="small muted">${escapeHtml(invitation.proposed_department || 'General')} department</p><div>${badge(invitation.proposed_role)} ${badge(invitation.status)}</div>${roleCanApproveMembers(currentRole()) ? `<div class="actions" style="margin-top:10px"><button class="primary" data-action="approve-invite" data-id="${invitation.id}">Approve access</button><button class="danger" data-action="reject-invite" data-id="${invitation.id}">Reject</button></div>` : '<p class="small">CEO or admin approval required.</p>'}</div>`).join('') || '<div class="empty">No accepted invitations await approval.</div>'}</section>
  </div>
  <section class="card table-wrap" style="margin-top:16px"><h3>Role & department management</h3><table><thead><tr><th>User</th><th>Role</th><th>Department (text)</th><th>Department</th><th>Manager</th><th>Job role</th><th>Presence</th><th>Membership</th><th>Actions</th></tr></thead><tbody>
    ${state.members.map(renderMemberRow).join('')}
  </tbody></table></section>
  <section class="card table-wrap" style="margin-top:16px"><h3>Invitation history</h3><table><thead><tr><th>User</th><th>Role</th><th>Department</th><th>Status</th><th>Invited by</th><th>Actions</th></tr></thead><tbody>${state.invitations.map(invitation => `<tr><td>${escapeHtml(invitation.invited_name)}<br><span class="small muted">@${escapeHtml(invitation.invited_username)}</span></td><td>${badge(invitation.proposed_role)}</td><td>${escapeHtml(invitation.proposed_department || 'General')}</td><td>${badge(invitation.status)}</td><td>${escapeHtml(invitation.invited_by_name)}</td><td>${['invited','awaiting_approval'].includes(invitation.status) ? `<button class="danger" data-action="cancel-invite" data-id="${invitation.id}">Cancel</button>` : '<span class="small muted">Completed</span>'}</td></tr>`).join('') || '<tr><td colspan="6"><div class="empty">No invitations yet.</div></td></tr>'}</tbody></table></section>`;
}

let taskCommentStream = null;

function taskCommentMarkup(comment) {
  return `<div class="comment-item" data-comment-id="${comment.id}"><div class="comment-meta"><strong>${escapeHtml(comment.full_name)}</strong><small>${escapeHtml(new Date(comment.created_at).toLocaleString())}</small></div><div class="comment-body">${escapeHtml(comment.body)}</div></div>`;
}

function appendTaskComment(comment) {
  const feed = document.getElementById('taskCommentFeed');
  if (!feed || feed.querySelector(`[data-comment-id="${comment.id}"]`)) return;
  const empty = feed.querySelector('.empty');
  if (empty) empty.remove();
  feed.insertAdjacentHTML('beforeend', taskCommentMarkup(comment));
  feed.scrollTop = feed.scrollHeight;
}

async function openAssignDialog(task, { onAssigned } = {}) {
  let candidates = state.members.filter(member => member.status === 'active');
  if (task.team_id) {
    try {
      const teamMembers = await api(`/api/teams/${task.team_id}/members`, { silent: true });
      const ids = new Set(teamMembers.map(item => Number(item.user_id)));
      if (ids.size) candidates = candidates.filter(member => ids.has(Number(member.user_id)));
    } catch { /* fall back to all active org members */ }
  }
  const workloadByUser = new Map((state.orgDashboard?.people || []).map(item => [Number(item.user_id), item]));
  const subtasks = state.tasks.filter(item => Number(item.parent_task_id) === Number(task.id));
  const hasUnassignedSubtasks = subtasks.some(item => !item.owner_id);

  const overlay = document.createElement('div');
  overlay.id = 'assignTaskDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form class="dialog-card stack compact-dialog" id="assignTaskForm">
    <div class="dialog-head"><h2 id="assignTaskTitle">Assign “${escapeHtml(task.title)}”</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    ${task.team_name ? `<div class="small muted">Team: ${escapeHtml(task.team_name)}${task.team_manager_name ? ` · Manager: ${escapeHtml(task.team_manager_name)}` : ''}</div>` : '<div class="small muted">This task has no team. Any active member can be assigned.</div>'}
    <label>Assign to<select name="owner_id">
      <option value="">Unassigned</option>
      ${candidates.map(member => {
        const workload = workloadByUser.get(Number(member.user_id));
        const suffix = workload ? ` — ${workload.active_task_count}/${workload.capacity} active${workload.overloaded ? ' ⚠ overloaded' : ''}` : '';
        return `<option value="${member.user_id}" ${Number(task.owner_id) === Number(member.user_id) ? 'selected' : ''}>${escapeHtml(member.full_name)}${suffix}</option>`;
      }).join('')}
    </select></label>
    ${hasUnassignedSubtasks ? `<label class="toggle-row"><span><strong>Include unassigned subtasks</strong><small>Also assign this worker to this task's subtasks that don't have one yet. Existing subtask assignments are never overwritten.</small></span><input type="checkbox" name="include_subtasks"></label>` : ''}
    <div class="actions"><button class="primary" type="submit">Assign</button></div>
  </form>`;
  mountDialog(overlay, 'assignTaskTitle');
  overlay.querySelector('#assignTaskForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const ownerId = form.get('owner_id') || null;
    const includeSubtasks = hasUnassignedSubtasks && form.get('include_subtasks');
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    try {
      if (includeSubtasks) {
        await api(`/api/tasks/${task.id}/assign-with-subtasks`, { method: 'POST', body: JSON.stringify({ owner_id: ownerId, include_unassigned_subtasks: true }) });
      } else {
        await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ owner_id: ownerId }) });
      }
      closeDialog(overlay);
      await onAssigned?.();
      toast('Assignment saved.');
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
}

async function openTaskDialog(taskId = null, presetColumnId = null) {
  const task = state.tasks.find(item => Number(item.id) === Number(taskId));
  const presetColumn = !task && presetColumnId ? state.boardColumns.find(item => Number(item.id) === Number(presetColumnId)) : null;
  const ownerOptions = `<option value="">Unassigned</option>${state.members.filter(member => member.status === 'active').map(member => `<option value="${member.user_id}" ${Number(task?.owner_id) === Number(member.user_id) ? 'selected' : ''}>${escapeHtml(member.full_name)} (${escapeHtml(member.role)})</option>`).join('')}`;
  const teamOptions = `<option value="">Unassigned</option>${(state.teams || []).map(team => `<option value="${team.id}" ${Number(task?.team_id) === Number(team.id) ? 'selected' : ''}>${escapeHtml(team.name)}</option>`).join('')}`;
  const teamField = canManage()
    ? `<label>Team<select name="team_id">${teamOptions}</select></label>`
    : `<label>Team<input value="${escapeHtml(task?.team_name || 'Unassigned')}" disabled></label>`;
  const otherTasks = state.tasks.filter(item => Number(item.id) !== Number(taskId));
  const descendantIds = new Set();
  if (task) {
    const collect = parentId => { for (const item of state.tasks) if (Number(item.parent_task_id) === Number(parentId)) { descendantIds.add(item.id); collect(item.id); } };
    collect(task.id);
  }
  const linkableTasks = otherTasks.filter(item => !descendantIds.has(item.id));
  const parentOptions = `<option value="">None</option>${linkableTasks.map(item => `<option value="${item.id}" ${Number(task?.parent_task_id) === Number(item.id) ? 'selected' : ''}>${escapeHtml(item.title)}</option>`).join('')}`;
  const milestoneOptions = `<option value="">None</option>${state.milestones.map(item => `<option value="${item.id}" ${Number(task?.milestone_id) === Number(item.id) ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}`;
  const storyOptions = `<option value="">None</option>${state.stories.map(item => `<option value="${item.id}" ${Number(task?.story_id) === Number(item.id) ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}`;
  const dependencyOptions = linkableTasks.map(item => `<label class="dependency-option"><input type="checkbox" name="dependencies" value="${item.id}" ${task?.dependencies?.includes(Number(item.id)) ? 'checked' : ''}> ${escapeHtml(item.title)}</label>`).join('') || '<div class="small muted">No other tasks in this project yet.</div>';
  const subtasks = task ? state.tasks.filter(item => Number(item.parent_task_id) === Number(task.id)) : [];

  const overlay = document.createElement('div');
  overlay.id = 'taskDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<div class="dialog-card wide"><form id="taskForm" class="form-grid"><input type="hidden" name="task_id" value="${task?.id || ''}"><input type="hidden" name="column_id" value="${presetColumn?.id || ''}"><div class="dialog-head full"><h2 id="taskDialogTitle">${task ? 'Edit task' : 'Add task'}</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <label>Phase<input name="phase" autofocus value="${escapeHtml(task?.phase || 'General')}"></label>
    <label>Title<input name="title" required value="${escapeHtml(task?.title || '')}"></label>
    <label class="full">Description<textarea name="description">${escapeHtml(task?.description || '')}</textarea></label>
    <label>Owner<select name="owner_id">${ownerOptions}</select></label>
    ${teamField}
    ${task?.team_name ? `<div class="small muted full">Manager: ${escapeHtml(task.team_manager_name || 'Not assigned')}</div>` : ''}
    <label>Priority<select name="priority">${['low', 'medium', 'high', 'critical'].map(value => `<option value="${value}" ${task?.priority === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
    <label>Status<select name="status" ${presetColumn ? 'disabled' : ''}>${['not_started', 'in_progress', 'blocked', 'done'].map(value => `<option value="${value}" ${(task?.status || presetColumn?.maps_to_status) === value ? 'selected' : ''}>${value.replaceAll('_', ' ')}</option>`).join('')}</select>${presetColumn ? `<small class="field-help">Set by the “${escapeHtml(presetColumn.name)}” column.</small>` : ''}</label>
    <label>Progress<input name="progress" type="number" min="0" max="100" value="${task?.progress || 0}"></label>
    <label>Start date<input name="start_date" type="date" value="${escapeHtml(task?.start_date || '')}"></label>
    <label>Due date<input name="due_date" type="date" value="${escapeHtml(task?.due_date || '')}"></label>
    <label>Story<select name="story_id">${storyOptions}</select></label>
    <label>Milestone<select name="milestone_id">${milestoneOptions}</select></label>
    <label>Parent task (subtask of)<select name="parent_task_id">${parentOptions}</select></label>
    <label class="full">Acceptance criteria<textarea name="acceptance_criteria">${escapeHtml(task?.acceptance_criteria || '')}</textarea></label>
    <fieldset class="full dependency-fieldset"><legend>Blocked by (dependencies)</legend><div class="dependency-options">${dependencyOptions}</div></fieldset>
    <div class="full actions"><button class="primary" type="submit">${task ? 'Save changes' : 'Create task'}</button></div>
  </form>
  ${task ? `<div class="dialog-subsection">
    <h3>Subtasks</h3>
    ${subtasks.length ? `<div class="subtask-progress-list">${subtasks.map(item => `<div class="subtask-progress-row"><button type="button" class="text-link" data-action="open-task" data-id="${item.id}">${escapeHtml(item.title)}</button>${badge(item.status)}<span class="small muted">${escapeHtml(item.owner_name || 'Unassigned')}</span><button type="button" class="icon-action" data-action="quick-assign-task" data-id="${item.id}" aria-label="Assign subtask" data-tooltip="Assign">${ICONS.userPlus}</button></div>`).join('')}</div>` : '<div class="small muted">No subtasks yet. Create another task and set this one as its parent.</div>'}
    <h3 style="margin-top:16px">Comments</h3>
    <div id="taskCommentFeed" class="comment-feed"><div class="small muted">Loading comments…</div></div>
    <form id="taskCommentForm" class="comment-form"><textarea name="body" placeholder="Write a comment..." required></textarea><button class="primary" type="submit">Comment</button></form>
  </div>` : ''}</div>`;
  mountDialog(overlay, 'taskDialogTitle');

  if (!task) return;

  try {
    const comments = await api(`/api/tasks/${task.id}/comments`);
    const feed = overlay.querySelector('#taskCommentFeed');
    if (feed) { feed.innerHTML = comments.map(taskCommentMarkup).join('') || '<div class="empty small">No comments yet.</div>'; feed.scrollTop = feed.scrollHeight; }
  } catch {
    const feed = overlay.querySelector('#taskCommentFeed');
    if (feed) feed.innerHTML = '<div class="small muted">Could not load comments.</div>';
  }

  taskCommentStream?.close();
  const source = new EventSource(`/api/tasks/${task.id}/comments/stream`);
  taskCommentStream = source;
  source.onmessage = event => {
    if (taskCommentStream !== source) return;
    try { appendTaskComment(JSON.parse(event.data)); } catch {}
  };
  overlay._onClose = () => { source.close(); if (taskCommentStream === source) taskCommentStream = null; };

  overlay.querySelector('#taskCommentForm').addEventListener('submit', async event => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const body = new FormData(formElement).get('body');
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    try {
      const created = await api(`/api/tasks/${task.id}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
      formElement.reset();
      appendTaskComment(created);
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
}

function openProjectEditDialog() {
  const project = state.project;
  const ownerOptions = state.members.filter(member => member.status === 'active').map(member => `<option value="${member.user_id}" ${Number(project.owner_id) === Number(member.user_id) ? 'selected' : ''}>${escapeHtml(member.full_name)} (${escapeHtml(member.role)})</option>`).join('');
  const overlay = document.createElement('div');
  overlay.id = 'projectEditDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="projectEditForm" class="dialog-card form-grid"><div class="dialog-head full"><h2 id="projectEditDialogTitle">Edit project details</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <label>Project name<input name="name" autofocus required value="${escapeHtml(project.name)}"></label>
    <label>Owner<select name="owner_id">${ownerOptions}</select></label>
    <label>Priority<select name="priority">${['low', 'medium', 'high', 'critical'].map(value => `<option value="${value}" ${project.priority === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
    <label>Status<select name="status">${['active', 'on_hold', 'completed', 'archived'].map(value => `<option value="${value}" ${project.status === value ? 'selected' : ''}>${value.replaceAll('_', ' ')}</option>`).join('')}</select></label>
    <label>Start date<input name="start_date" type="date" value="${escapeHtml(project.start_date || '')}"></label>
    <label>Due date<input name="due_date" type="date" value="${escapeHtml(project.due_date || '')}"></label>
    <label class="full">Objective<input name="objective" value="${escapeHtml(project.objective || '')}"></label>
    <label class="full">Scope<textarea name="scope">${escapeHtml(project.scope || '')}</textarea></label>
    <label>Constraints<textarea name="constraints">${escapeHtml(project.constraints || '')}</textarea></label>
    <label>Assumptions<textarea name="assumptions">${escapeHtml(project.assumptions || '')}</textarea></label>
    <div class="full actions"><button class="primary" type="submit">Save changes</button></div></form>`;
  mountDialog(overlay, 'projectEditDialogTitle');
  overlay.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    try {
      await api(`/api/projects/${state.projectId}`, { method: 'PATCH', body: JSON.stringify({
        name: form.get('name'), owner_id: form.get('owner_id') || null, priority: form.get('priority'), status: form.get('status'),
        start_date: form.get('start_date') || null, due_date: form.get('due_date') || null,
        objective: form.get('objective'), scope: form.get('scope'), constraints: form.get('constraints'), assumptions: form.get('assumptions')
      }) });
      closeDialog(overlay);
      await loadProjectData();
      render();
      toast('Project updated.');
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
}

function openStoryDialog(storyId = null) {
  const story = state.stories.find(item => Number(item.id) === Number(storyId));
  const ownerOptions = `<option value="">Unassigned</option>${state.members.filter(member => member.status === 'active').map(member => `<option value="${member.user_id}" ${Number(story?.owner_id) === Number(member.user_id) ? 'selected' : ''}>${escapeHtml(member.full_name)}</option>`).join('')}`;
  const departmentOptions = `<option value="">None</option>${(state.departments || []).map(department => `<option value="${department.id}" ${Number(story?.department_id) === Number(department.id) ? 'selected' : ''}>${escapeHtml(department.name)}</option>`).join('')}`;
  const overlay = document.createElement('div');
  overlay.id = 'storyDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="storyForm" class="dialog-card form-grid"><div class="dialog-head full"><h2 id="storyDialogTitle">${story ? 'Edit story' : 'Add story'}</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <label class="full">Name<input name="name" autofocus required value="${escapeHtml(story?.name || '')}"></label>
    <label class="full">Description<textarea name="description">${escapeHtml(story?.description || '')}</textarea></label>
    <label>Owner<select name="owner_id">${ownerOptions}</select></label>
    <label>Department<select name="department_id">${departmentOptions}</select></label>
    <label>Priority<select name="priority">${['low', 'medium', 'high', 'critical'].map(value => `<option value="${value}" ${(story?.priority || 'medium') === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
    <label>Status<select name="status">${['not_started', 'in_progress', 'at_risk', 'done'].map(value => `<option value="${value}" ${story?.status === value ? 'selected' : ''}>${value.replaceAll('_', ' ')}</option>`).join('')}</select></label>
    <label>Start date<input name="start_date" type="date" value="${escapeHtml(story?.start_date || '')}"></label>
    <label>Due date<input name="due_date" type="date" value="${escapeHtml(story?.due_date || '')}"></label>
    <div class="full actions">${story ? `<button type="button" class="icon-action danger" data-action="delete-story" aria-label="Delete story" data-tooltip="Delete story">${ICONS.trash}</button>` : ''}<button class="primary" type="submit">${story ? 'Save changes' : 'Create story'}</button></div>
  </form>`;
  mountDialog(overlay, 'storyDialogTitle');
  overlay.querySelector('#storyForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    const payload = { name: form.get('name'), description: form.get('description'), owner_id: form.get('owner_id') || null, department_id: form.get('department_id') || null, priority: form.get('priority'), status: form.get('status') || 'not_started', start_date: form.get('start_date') || null, due_date: form.get('due_date') || null };
    try {
      if (story) await api(`/api/stories/${story.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else await api(`/api/projects/${state.projectId}/stories`, { method: 'POST', body: JSON.stringify(payload) });
      closeDialog(overlay);
      await loadProjectData();
      render();
      toast(story ? 'Story updated.' : 'Story created.');
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
  overlay.querySelector('[data-action="delete-story"]')?.addEventListener('click', async () => {
    if (!confirm('Delete this story? Its tasks will remain but become unassigned from any story.')) return;
    try {
      await api(`/api/stories/${story.id}`, { method: 'DELETE' });
      closeDialog(overlay);
      await loadProjectData();
      render();
      toast('Story deleted.');
    } catch (error) { toast(error.message, true); }
  });
}

function updateBriefProgress(container, step, detail) {
  if (!container) return;
  let line = container.querySelector(`[data-step="${step}"]`);
  if (!line) {
    container.querySelectorAll('li').forEach(el => { el.classList.remove('active'); el.classList.add('done'); const mark = el.querySelector('.step-mark'); if (mark) mark.textContent = '✓'; });
    line = document.createElement('li');
    line.dataset.step = step;
    line.innerHTML = '<span class="step-mark">●</span><span class="step-label"></span>';
    container.appendChild(line);
  }
  line.classList.add('active');
  line.classList.remove('done');
  line.querySelector('.step-label').textContent = detail;
  if (step === 'done') {
    container.querySelectorAll('li').forEach(el => { el.classList.remove('active'); el.classList.add('done'); const mark = el.querySelector('.step-mark'); if (mark) mark.textContent = '✓'; });
  }
}

function openBriefAnalyzerDialog() {
  const overlay = document.createElement('div');
  overlay.id = 'briefAnalyzerDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<div class="dialog-card wide">
    <div class="dialog-head full"><h2 id="briefAnalyzerTitle">AI Project Brief Analyzer</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <form id="briefAnalyzerForm" class="stack">
      <div class="notice">Upload a project brief (.txt, .md, .pdf, or .docx) or paste text below. The AI proposes a structured plan — stories, tasks, subtasks, departments, milestones, risks, and assumptions — for you to review before anything is created. Nothing is written to your project until you accept it.</div>
      <label>Upload document<input type="file" name="file" accept=".txt,.md,.markdown,.pdf,.docx"></label>
      <label class="full">Or paste brief text<textarea name="raw_text" rows="8" placeholder="Paste the project brief here..."></textarea></label>
      <div id="briefProgressWrap" hidden><p class="small muted" style="margin:10px 0 0">Processing…</p><ul class="brief-progress-steps" id="briefProgressSteps"></ul></div>
      <div class="full actions"><button class="primary" type="submit">Analyze brief</button></div>
    </form>
  </div>`;
  mountDialog(overlay, 'briefAnalyzerTitle');
  overlay.querySelector('#briefAnalyzerForm').addEventListener('submit', async event => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const submitter = event.submitter;
    const fileInput = formElement.querySelector('input[type="file"]');
    const textArea = formElement.querySelector('textarea[name="raw_text"]');
    const progressWrap = formElement.querySelector('#briefProgressWrap');
    const progressSteps = formElement.querySelector('#briefProgressSteps');
    setButtonBusy(submitter, true, 'Analyzing…');
    let source = null;
    try {
      let rawText = textArea.value.trim();
      let sourceType = 'paste';
      let sourceFilename = '';
      if (fileInput.files[0]) {
        const uploadBody = new FormData();
        uploadBody.append('file', fileInput.files[0]);
        const uploadResult = await api(`/api/projects/${state.projectId}/brief-analysis/upload`, { method: 'POST', body: uploadBody, timeoutMs: 60_000 });
        rawText = uploadResult.text;
        sourceType = 'upload';
        sourceFilename = uploadResult.filename;
      }
      if (!rawText) throw new Error('Upload a document or paste brief text.');
      progressWrap.hidden = false;
      const token = crypto.randomUUID();
      source = new EventSource(`/api/brief-analysis/progress?token=${encodeURIComponent(token)}`);
      source.onmessage = event => {
        try { const payload = JSON.parse(event.data); updateBriefProgress(progressSteps, payload.step, payload.detail); } catch {}
      };
      await new Promise(resolve => { source.onopen = resolve; setTimeout(resolve, 600); });
      const analysis = await api(`/api/projects/${state.projectId}/brief-analysis`, { method: 'POST', timeoutMs: 120_000, body: JSON.stringify({ source_type: sourceType, source_filename: sourceFilename, raw_text: rawText, stream_token: token }) });
      closeDialog(overlay);
      openBriefReviewDialog(analysis);
      toast(analysis.fallback_used ? 'Brief analyzed with local fallback.' : `Brief analyzed with ${analysis.ai_provider}.`);
    } catch (error) { toast(error.message, true); } finally { source?.close(); setButtonBusy(submitter, false); }
  });
}

function briefSourceBadge(item) {
  const source = item.source === 'brief' ? 'brief' : item.source === 'manual' ? 'manual' : 'inferred';
  const label = source === 'brief' ? '📄 From brief' : source === 'manual' ? '✎ Manual' : '✨ AI inferred';
  return `<span class="source-badge ${source === 'brief' ? 'from-brief' : source}" title="${escapeHtml(item.source_note || '')}">${label}</span>`;
}

function briefEditedBadge(item) {
  return item._edited ? '<span class="source-badge edited" title="Manually edited after generation">Edited</span>' : '';
}

function briefTeamBadge(item) {
  if (item.team_name) return `<span class="source-badge from-brief" title="${escapeHtml(item.team_reason || '')}">🏷️ ${escapeHtml(item.team_name)}${item.team_confidence != null ? ` (${item.team_confidence}%)` : ''}</span>`;
  return '<span class="source-badge inferred" title="No team could be confidently matched. Assign one manually or leave unassigned.">🏷️ Unassigned team</span>';
}

let briefReviewPlan = null;
let briefReviewSessionId = null;
let briefReviewRejected = new Set();
let briefReviewCollapsed = new Set();
let briefActiveReviewOverlay = null;

function briefPathParts(path) { return String(path).split(':').map(Number); }
function briefGetStory(sIndex) { return briefReviewPlan.stories[sIndex]; }
function briefGetTask(sIndex, tIndex) { return briefReviewPlan.stories[sIndex]?.tasks[tIndex]; }
function briefGetSubtask(sIndex, tIndex, stIndex) { return briefReviewPlan.stories[sIndex]?.tasks[tIndex]?.subtasks[stIndex]; }

function blankBriefStory() {
  return { name: 'New story', description: '', department: '', owner_id: null, priority: 'medium', status: 'not_started', start_date: null, due_date: null, source: 'manual', source_note: 'Added manually by a reviewer.', team_name: '', team_confidence: null, team_reason: '', tasks: [] };
}
function blankBriefTask() {
  return { title: 'New task', description: '', owner_id: null, priority: 'medium', status: 'not_started', start_date: null, due_date: null, tags: [], estimated_hours: null, source: 'manual', source_note: 'Added manually by a reviewer.', team_name: '', team_confidence: null, team_reason: '', subtasks: [] };
}
function blankBriefSubtask() {
  return { title: 'New subtask', description: '', owner_id: null, priority: 'medium', status: 'not_started', due_date: null, tags: [], estimated_hours: null, source: 'manual', source_note: 'Added manually by a reviewer.', team_name: '', team_confidence: null, team_reason: '' };
}

function briefOwnerBadge(kind, item) {
  if (!item.owner_id) return '';
  const member = state.members.find(m => Number(m.user_id) === Number(item.owner_id));
  const label = kind === 'story' ? 'Manager' : 'Assignee';
  return `<span class="small muted">${label}: ${escapeHtml(member?.full_name || 'Unknown')}</span>`;
}

function briefRowMeta(kind, item) {
  const parts = [briefSourceBadge(item), briefEditedBadge(item), badge(item.status || 'not_started')];
  if (kind !== 'subtask') parts.push(badge(item.priority || 'medium'));
  if (kind === 'story' && item.department) parts.push(`<span class="small muted">${escapeHtml(item.department)}</span>`);
  parts.push(briefTeamBadge(item));
  parts.push(briefOwnerBadge(kind, item));
  if (kind !== 'story' && item.tags?.length) parts.push(`<span class="small muted">${escapeHtml(item.tags.join(', '))}</span>`);
  if (kind !== 'story' && item.estimated_hours != null) parts.push(`<span class="small muted">${item.estimated_hours}h</span>`);
  if (item.due_date) parts.push(`<span class="small muted">Due ${escapeHtml(item.due_date)}</span>`);
  return `<span class="brief-review-meta">${parts.join('')}</span>`;
}

function briefLeafRow(kind, index, item, label, suffix = '') {
  const key = `${kind}:${index}`;
  return `<label class="brief-review-row"><input type="checkbox" data-brief-check="${key}" ${briefReviewRejected.has(key) ? '' : 'checked'}><input type="text" class="brief-review-name" data-brief-name="${key}" value="${escapeHtml(label)}">${briefSourceBadge(item)}${suffix ? `<span class="small muted">${suffix}</span>` : ''}</label>`;
}

function renderBriefReviewTree(plan) {
  const section = (title, html) => html ? `<div class="brief-review-section"><h3>${title}</h3>${html}</div>` : '';
  const departments = section(`Departments (${plan.departments.length})`, plan.departments.map((item, i) => briefLeafRow('department', i, item, item.name)).join(''));
  const milestones = section(`Milestones (${plan.milestones.length})`, plan.milestones.map((item, i) => briefLeafRow('milestone', i, item, item.name, item.due_date ? `Due ${escapeHtml(item.due_date)}` : '')).join(''));
  const risks = section(`Risks (${plan.risks.length})`, plan.risks.map((item, i) => briefLeafRow('risk', i, item, item.title, item.severity)).join(''));
  const assumptions = section(`Assumptions (${plan.assumptions.length})`, plan.assumptions.map((item, i) => briefLeafRow('assumption', i, item, item.text)).join(''));
  const stories = plan.stories.map((story, sIndex) => {
    const storyKey = `story:${sIndex}`;
    const collapsed = briefReviewCollapsed.has(storyKey);
    const tasksHtml = story.tasks.map((task, tIndex) => {
      const taskKey = `task:${sIndex}:${tIndex}`;
      const taskCollapsed = briefReviewCollapsed.has(taskKey);
      const subtasksHtml = task.subtasks.map((subtask, stIndex) => {
        const subtaskKey = `subtask:${sIndex}:${tIndex}:${stIndex}`;
        return `<div class="brief-review-row subtask-row"><span class="brief-collapse-toggle" aria-hidden="true"></span><input type="checkbox" data-brief-check="${subtaskKey}" ${briefReviewRejected.has(subtaskKey) ? '' : 'checked'}><input type="text" class="brief-review-name" data-brief-name="${subtaskKey}" value="${escapeHtml(subtask.title)}">${briefRowMeta('subtask', subtask)}<div class="brief-row-actions"><button type="button" class="icon-action" data-action="brief-assign" data-kind="subtask" data-path="${sIndex}:${tIndex}:${stIndex}" aria-label="Assign" data-tooltip="Assign">${ICONS.userPlus}</button><button type="button" class="icon-action" data-action="brief-edit" data-kind="subtask" data-path="${sIndex}:${tIndex}:${stIndex}" aria-label="Edit subtask" data-tooltip="Edit subtask">${ICONS.pencil}</button><button type="button" data-action="brief-duplicate" data-kind="subtask" data-path="${sIndex}:${tIndex}:${stIndex}">Duplicate</button><button type="button" data-action="brief-move" data-kind="subtask" data-path="${sIndex}:${tIndex}:${stIndex}">Move to…</button><button type="button" class="icon-action danger" data-action="brief-delete" data-kind="subtask" data-path="${sIndex}:${tIndex}:${stIndex}" aria-label="Delete subtask" data-tooltip="Delete subtask">${ICONS.trash}</button></div></div>`;
      }).join('');
      return `<div class="brief-review-task ${taskCollapsed ? 'collapsed' : ''}">
        <label class="brief-review-row task-row"><button type="button" class="brief-collapse-toggle" data-action="brief-toggle" data-key="${taskKey}" aria-label="Expand or collapse task">${taskCollapsed ? '▸' : '▾'}</button><input type="checkbox" data-brief-check="${taskKey}" ${briefReviewRejected.has(taskKey) ? '' : 'checked'}><input type="text" class="brief-review-name" data-brief-name="${taskKey}" value="${escapeHtml(task.title)}">${briefRowMeta('task', task)}</label>
        <div class="brief-row-actions"><button type="button" class="icon-action" data-action="brief-assign" data-kind="task" data-path="${sIndex}:${tIndex}" aria-label="Assign" data-tooltip="Assign">${ICONS.userPlus}</button><button type="button" class="icon-action" data-action="brief-edit" data-kind="task" data-path="${sIndex}:${tIndex}" aria-label="Edit task" data-tooltip="Edit task">${ICONS.pencil}</button><button type="button" data-action="brief-duplicate" data-kind="task" data-path="${sIndex}:${tIndex}">Duplicate</button><button type="button" data-action="brief-move" data-kind="task" data-path="${sIndex}:${tIndex}">Move to…</button><button type="button" data-action="brief-add-subtask" data-path="${sIndex}:${tIndex}">+ Add subtask</button><button type="button" data-action="brief-regenerate" data-kind="task" data-path="${sIndex}:${tIndex}">Regenerate</button><button type="button" class="icon-action danger" data-action="brief-delete" data-kind="task" data-path="${sIndex}:${tIndex}" aria-label="Delete task" data-tooltip="Delete task">${ICONS.trash}</button></div>
        <div class="brief-review-children">${subtasksHtml}</div>
      </div>`;
    }).join('');
    return `<div class="brief-review-story ${collapsed ? 'collapsed' : ''}">
      <label class="brief-review-row story-row"><button type="button" class="brief-collapse-toggle" data-action="brief-toggle" data-key="${storyKey}" aria-label="Expand or collapse story">${collapsed ? '▸' : '▾'}</button><input type="checkbox" data-brief-check="${storyKey}" ${briefReviewRejected.has(storyKey) ? '' : 'checked'}><input type="text" class="brief-review-name" data-brief-name="${storyKey}" value="${escapeHtml(story.name)}">${briefRowMeta('story', story)}</label>
      <div class="brief-row-actions"><button type="button" class="icon-action" data-action="brief-assign" data-kind="story" data-path="${sIndex}" aria-label="Assign manager" data-tooltip="Assign manager">${ICONS.userPlus}</button><button type="button" class="icon-action" data-action="brief-edit" data-kind="story" data-path="${sIndex}" aria-label="Edit story" data-tooltip="Edit story">${ICONS.pencil}</button><button type="button" data-action="brief-duplicate" data-kind="story" data-path="${sIndex}">Duplicate</button><button type="button" data-action="brief-add-task" data-path="${sIndex}">+ Add task</button><button type="button" data-action="brief-regenerate" data-kind="story" data-path="${sIndex}">Regenerate</button><button type="button" data-action="brief-ai-edit" data-kind="story" data-path="${sIndex}">✨ Improve with AI</button><button type="button" class="icon-action danger" data-action="brief-delete" data-kind="story" data-path="${sIndex}" aria-label="Delete story" data-tooltip="Delete story">${ICONS.trash}</button></div>
      <div class="brief-review-children">${tasksHtml}</div>
    </div>`;
  }).join('');
  const storiesSection = `<div class="brief-review-section"><h3>Stories, Tasks &amp; Subtasks (${plan.stories.length})</h3>${stories || '<div class="empty small">No stories yet.</div>'}<div class="brief-add-row"><button type="button" class="secondary" data-action="brief-add-story">+ Add story</button></div></div>`;
  return `${departments}${milestones}${risks}${assumptions}${storiesSection}`;
}

function refreshBriefTree() {
  const tree = briefActiveReviewOverlay?.querySelector('#briefReviewTree');
  if (tree) tree.innerHTML = renderBriefReviewTree(briefReviewPlan);
}

function briefDescendantCounts(kind, item) {
  if (kind === 'story') {
    const taskCount = item.tasks.length;
    const subtaskCount = item.tasks.reduce((sum, task) => sum + task.subtasks.length, 0);
    return { taskCount, subtaskCount };
  }
  if (kind === 'task') return { subtaskCount: item.subtasks.length };
  return {};
}

function briefConfirmDelete(kind, item) {
  if (kind === 'story') {
    const { taskCount, subtaskCount } = briefDescendantCounts('story', item);
    const message = taskCount
      ? `This story contains ${taskCount} task${taskCount === 1 ? '' : 's'} and ${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'}. Deleting it will also remove its child items.\n\nDelete story "${item.name}"?`
      : `Delete story "${item.name}"?`;
    return confirm(message);
  }
  if (kind === 'task') {
    const { subtaskCount } = briefDescendantCounts('task', item);
    const message = subtaskCount
      ? `This task contains ${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'}. Deleting it will also remove its child items.\n\nDelete task "${item.title}"?`
      : `Delete task "${item.title}"?`;
    return confirm(message);
  }
  return confirm(`Delete subtask "${item.title}"?`);
}

function briefHasManualEdits(kind, item) {
  if (kind === 'story') return item.tasks.some(task => task._edited || task.subtasks.some(subtask => subtask._edited));
  if (kind === 'task') return item.subtasks.some(subtask => subtask._edited);
  return false;
}

function briefPlanHasAnyManualEdits(plan) {
  return plan.stories.some(story => story._edited || story.tasks.some(task => task._edited || task.subtasks.some(subtask => subtask._edited)));
}

function briefAllKeys() {
  const keys = [];
  briefReviewPlan.departments.forEach((_, i) => keys.push(`department:${i}`));
  briefReviewPlan.milestones.forEach((_, i) => keys.push(`milestone:${i}`));
  briefReviewPlan.risks.forEach((_, i) => keys.push(`risk:${i}`));
  briefReviewPlan.assumptions.forEach((_, i) => keys.push(`assumption:${i}`));
  briefReviewPlan.stories.forEach((story, sIndex) => {
    keys.push(`story:${sIndex}`);
    story.tasks.forEach((task, tIndex) => {
      keys.push(`task:${sIndex}:${tIndex}`);
      task.subtasks.forEach((subtask, stIndex) => keys.push(`subtask:${sIndex}:${tIndex}:${stIndex}`));
    });
  });
  return keys;
}

function briefMemberOptions(ownerId) {
  return `<option value="">Unassigned</option>${state.members.filter(member => member.status === 'active').map(member => `<option value="${member.user_id}" ${Number(ownerId) === Number(member.user_id) ? 'selected' : ''}>${escapeHtml(member.full_name)}</option>`).join('')}`;
}

function briefTeamOptions(teamName) {
  return `<option value="">Unassigned</option>${(state.teams || []).map(team => `<option value="${escapeHtml(team.name)}" ${team.name === teamName ? 'selected' : ''}>${escapeHtml(team.name)}</option>`).join('')}`;
}

function briefEffectiveTeamName(kind, path) {
  if (kind === 'story') return briefGetStory(Number(path))?.team_name || '';
  if (kind === 'task') {
    const [sIndex, tIndex] = briefPathParts(path);
    return briefGetTask(sIndex, tIndex)?.team_name || briefGetStory(sIndex)?.team_name || '';
  }
  const [sIndex, tIndex, stIndex] = briefPathParts(path);
  return briefGetSubtask(sIndex, tIndex, stIndex)?.team_name || briefGetTask(sIndex, tIndex)?.team_name || briefGetStory(sIndex)?.team_name || '';
}

async function openBriefAssignPicker(kind, path) {
  const parts = briefPathParts(path);
  const item = kind === 'story' ? briefGetStory(parts[0]) : kind === 'task' ? briefGetTask(parts[0], parts[1]) : briefGetSubtask(parts[0], parts[1], parts[2]);
  if (!item) return;
  const teamName = briefEffectiveTeamName(kind, path);
  const team = teamName ? (state.teams || []).find(candidate => candidate.name === teamName) : null;
  let candidates = state.members.filter(member => member.status === 'active');
  if (team) {
    try {
      const teamMembers = await api(`/api/teams/${team.id}/members`, { silent: true });
      const ids = new Set(teamMembers.map(member => Number(member.user_id)));
      if (ids.size) candidates = candidates.filter(member => ids.has(Number(member.user_id)));
    } catch { /* fall back to all active org members */ }
  }
  const workloadByUser = new Map((state.orgDashboard?.people || []).map(person => [Number(person.user_id), person]));
  const roleLabel = kind === 'story' ? 'manager' : 'assignee';
  const itemLabel = kind === 'story' ? item.name : item.title;
  const overlay = document.createElement('div');
  overlay.id = 'briefAssignDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form class="dialog-card stack compact-dialog" id="briefAssignForm">
    <div class="dialog-head"><h2 id="briefAssignTitle">Assign “${escapeHtml(itemLabel)}”</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    ${team ? `<div class="small muted">Team: ${escapeHtml(team.name)}</div>` : '<div class="small muted">No team assigned yet — any active member can be picked.</div>'}
    <label>Assign ${roleLabel} to<select name="owner_id">
      <option value="">Unassigned</option>
      ${candidates.map(member => {
        const workload = workloadByUser.get(Number(member.user_id));
        const suffix = workload ? ` — ${workload.active_task_count}/${workload.capacity} active${workload.overloaded ? ' ⚠ overloaded' : ''}` : '';
        return `<option value="${member.user_id}" ${Number(item.owner_id) === Number(member.user_id) ? 'selected' : ''}>${escapeHtml(member.full_name)}${suffix}</option>`;
      }).join('')}
    </select></label>
    <div class="actions"><button class="primary" type="submit">Assign</button></div>
  </form>`;
  mountDialog(overlay, 'briefAssignTitle');
  overlay.querySelector('#briefAssignForm').addEventListener('submit', event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    item.owner_id = form.get('owner_id') ? Number(form.get('owner_id')) : null;
    closeDialog(overlay);
    refreshBriefTree();
  });
}

function openBriefItemEditDialog(kind, path) {
  const parts = briefPathParts(path);
  const item = kind === 'story' ? briefGetStory(parts[0]) : kind === 'task' ? briefGetTask(parts[0], parts[1]) : briefGetSubtask(parts[0], parts[1], parts[2]);
  if (!item) return;
  const parentStory = kind === 'story' ? item : briefGetStory(parts[0]);
  let dirty = false;
  let fieldsHtml = '';
  let titleText = '';
  if (kind === 'story') {
    titleText = 'Edit story';
    fieldsHtml = `
      <label>Name<input name="name" required value="${escapeHtml(item.name)}"></label>
      <label class="full">Description<textarea name="description">${escapeHtml(item.description || '')}</textarea></label>
      <label>Department<input name="department" list="briefDeptList" value="${escapeHtml(item.department || '')}"></label>
      <datalist id="briefDeptList">${state.departments.map(department => `<option value="${escapeHtml(department.name)}">`).join('')}</datalist>
      <label>Manager<select name="owner_id">${briefMemberOptions(item.owner_id)}</select></label>
      <label>Team <span class="small muted">${item.team_name && item.team_confidence != null ? `(AI: ${item.team_confidence}% confident${item.team_reason ? ` — ${escapeHtml(item.team_reason)}` : ''})` : ''}</span><select name="team_name">${briefTeamOptions(item.team_name)}</select></label>
      <label>Priority<select name="priority">${['low', 'medium', 'high', 'critical'].map(value => `<option value="${value}" ${item.priority === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
      <label>Status<select name="status">${['not_started', 'in_progress', 'at_risk', 'done'].map(value => `<option value="${value}" ${item.status === value ? 'selected' : ''}>${value.replaceAll('_', ' ')}</option>`).join('')}</select></label>
      <label>Start date<input type="date" name="start_date" value="${escapeHtml(item.start_date || '')}"></label>
      <label>Due date<input type="date" name="due_date" value="${escapeHtml(item.due_date || '')}"></label>`;
  } else {
    const isTask = kind === 'task';
    titleText = isTask ? 'Edit task' : 'Edit subtask';
    const managerName = state.members.find(member => Number(member.user_id) === Number(parentStory?.owner_id))?.full_name;
    fieldsHtml = `
      <label>Title<input name="title" required value="${escapeHtml(item.title)}"></label>
      <label class="full">Description<textarea name="description">${escapeHtml(item.description || '')}</textarea></label>
      <label>Assignee<select name="owner_id">${briefMemberOptions(item.owner_id)}</select></label>
      <label>Department <span class="small muted">(from story)</span><input value="${escapeHtml(parentStory?.department || '—')}" disabled></label>
      <label>Manager <span class="small muted">(from story)</span><input value="${escapeHtml(managerName || '—')}" disabled></label>
      <label>Team <span class="small muted">${item.team_name && item.team_confidence != null ? `(AI: ${item.team_confidence}% confident${item.team_reason ? ` — ${escapeHtml(item.team_reason)}` : ''})` : 'defaults to story/task team if left unassigned'}</span><select name="team_name">${briefTeamOptions(item.team_name)}</select></label>
      <label>Priority<select name="priority">${['low', 'medium', 'high', 'critical'].map(value => `<option value="${value}" ${item.priority === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
      <label>Status<select name="status">${['not_started', 'in_progress', 'blocked', 'done'].map(value => `<option value="${value}" ${item.status === value ? 'selected' : ''}>${value.replaceAll('_', ' ')}</option>`).join('')}</select></label>
      ${isTask ? `<label>Start date<input type="date" name="start_date" value="${escapeHtml(item.start_date || '')}"></label>` : ''}
      <label>Due date<input type="date" name="due_date" value="${escapeHtml(item.due_date || '')}"></label>
      <label>Estimated effort (hours)<input type="number" min="0" step="0.5" name="estimated_hours" value="${item.estimated_hours ?? ''}"></label>
      <label>Tags <span class="small muted">(comma separated)</span><input name="tags" value="${escapeHtml((item.tags || []).join(', '))}"></label>`;
  }
  const overlay = document.createElement('div');
  overlay.id = 'briefItemEditDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form class="dialog-card form-grid" id="briefItemEditForm">
    <div class="dialog-head full"><h2 id="briefItemEditTitle">${titleText}</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    ${fieldsHtml}
    <div class="full actions"><button type="button" class="secondary" data-action="close-dialog">Cancel</button><button class="primary" type="submit">Save changes</button></div>
  </form>`;
  const form = overlay.querySelector('#briefItemEditForm');
  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('change', () => { dirty = true; });
  mountDialog(overlay, 'briefItemEditTitle', { confirmClose: () => !dirty || confirm('You have unsaved changes. Discard them?') });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(form);
    const applyTeamSelection = () => {
      const teamName = String(data.get('team_name') || '');
      if (teamName !== (item.team_name || '')) {
        item.team_name = teamName;
        item.team_confidence = teamName ? 100 : null;
        item.team_reason = teamName ? 'Manually selected by reviewer.' : '';
      }
    };
    if (kind === 'story') {
      item.name = String(data.get('name') || '').trim() || item.name;
      item.description = String(data.get('description') || '');
      item.department = String(data.get('department') || '');
      item.owner_id = data.get('owner_id') ? Number(data.get('owner_id')) : null;
      applyTeamSelection();
      item.priority = data.get('priority');
      item.status = data.get('status');
      item.start_date = data.get('start_date') || null;
      item.due_date = data.get('due_date') || null;
    } else {
      item.title = String(data.get('title') || '').trim() || item.title;
      item.description = String(data.get('description') || '');
      item.owner_id = data.get('owner_id') ? Number(data.get('owner_id')) : null;
      applyTeamSelection();
      item.priority = data.get('priority');
      item.status = data.get('status');
      item.due_date = data.get('due_date') || null;
      if (kind === 'task') item.start_date = data.get('start_date') || null;
      item.estimated_hours = data.get('estimated_hours') !== '' ? Number(data.get('estimated_hours')) : null;
      item.tags = String(data.get('tags') || '').split(',').map(tag => tag.trim()).filter(Boolean);
    }
    item._edited = true;
    dirty = false;
    closeDialog(overlay);
    refreshBriefTree();
    toast('Changes saved to the draft plan. Click "Accept selected & create" to write them to the project.');
  });
}

function openBriefMoveDialog(kind, path) {
  const parts = briefPathParts(path);
  const overlay = document.createElement('div');
  overlay.id = 'briefMoveDialog';
  overlay.className = 'dialog-backdrop';
  let options = '';
  let label = '';
  if (kind === 'task') {
    label = 'story';
    options = briefReviewPlan.stories.map((story, sIndex) => `<option value="${sIndex}" ${sIndex === parts[0] ? 'selected' : ''}>${escapeHtml(story.name)}</option>`).join('');
  } else {
    label = 'task';
    const targets = [];
    briefReviewPlan.stories.forEach((story, sIndex) => story.tasks.forEach((task, tIndex) => targets.push({ sIndex, tIndex, selected: sIndex === parts[0] && tIndex === parts[1], text: `${story.name} → ${task.title}` })));
    options = targets.map(target => `<option value="${target.sIndex}:${target.tIndex}" ${target.selected ? 'selected' : ''}>${escapeHtml(target.text)}</option>`).join('');
  }
  overlay.innerHTML = `<form class="dialog-card stack compact-dialog" id="briefMoveForm">
    <div class="dialog-head"><h2 id="briefMoveTitle">Move ${kind}</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <label>Move to ${label}<select name="target">${options}</select></label>
    <div class="actions"><button class="primary" type="submit">Move</button></div>
  </form>`;
  mountDialog(overlay, 'briefMoveTitle');
  overlay.querySelector('#briefMoveForm').addEventListener('submit', event => {
    event.preventDefault();
    const target = String(new FormData(event.currentTarget).get('target'));
    if (kind === 'task') {
      const [sIndex, tIndex] = parts;
      const targetIndex = Number(target);
      if (targetIndex === sIndex) { closeDialog(overlay); return; }
      const [task] = briefReviewPlan.stories[sIndex].tasks.splice(tIndex, 1);
      briefReviewPlan.stories[targetIndex].tasks.push(task);
    } else {
      const [sIndex, tIndex, stIndex] = parts;
      const [targetS, targetT] = target.split(':').map(Number);
      if (targetS === sIndex && targetT === tIndex) { closeDialog(overlay); return; }
      const [subtask] = briefReviewPlan.stories[sIndex].tasks[tIndex].subtasks.splice(stIndex, 1);
      briefReviewPlan.stories[targetS].tasks[targetT].subtasks.push(subtask);
    }
    closeDialog(overlay);
    refreshBriefTree();
    toast('Moved.');
  });
}

function openBriefDuplicateDialog(kind, path) {
  const parts = briefPathParts(path);
  const overlay = document.createElement('div');
  overlay.id = 'briefDuplicateDialog';
  overlay.className = 'dialog-backdrop';
  let optionsHtml = '<p class="small muted">This will create a copy with new items.</p>';
  if (kind === 'story') optionsHtml = `<label class="toggle-row"><span>Include tasks</span><input type="checkbox" name="include_tasks" checked></label><label class="toggle-row"><span>Include subtasks</span><input type="checkbox" name="include_subtasks" checked></label>`;
  else if (kind === 'task') optionsHtml = `<label class="toggle-row"><span>Include subtasks</span><input type="checkbox" name="include_subtasks" checked></label>`;
  overlay.innerHTML = `<form class="dialog-card stack compact-dialog" id="briefDuplicateForm">
    <div class="dialog-head"><h2 id="briefDuplicateTitle">Duplicate ${kind}</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    ${optionsHtml}
    <div class="actions"><button class="primary" type="submit">Duplicate</button></div>
  </form>`;
  mountDialog(overlay, 'briefDuplicateTitle');
  overlay.querySelector('#briefDuplicateForm').addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const includeTasks = data.get('include_tasks') !== null;
    const includeSubtasks = data.get('include_subtasks') !== null;
    if (kind === 'story') {
      const [sIndex] = parts;
      const original = briefGetStory(sIndex);
      const copy = JSON.parse(JSON.stringify(original));
      copy.name = `${original.name} (copy)`;
      copy._edited = false;
      copy.source = 'manual';
      copy.source_note = `Duplicated from "${original.name}".`;
      copy.tasks = includeTasks ? copy.tasks.map(task => (includeSubtasks ? task : { ...task, subtasks: [] })) : [];
      briefReviewPlan.stories.splice(sIndex + 1, 0, copy);
    } else if (kind === 'task') {
      const [sIndex, tIndex] = parts;
      const original = briefGetTask(sIndex, tIndex);
      const copy = JSON.parse(JSON.stringify(original));
      copy.title = `${original.title} (copy)`;
      copy._edited = false;
      copy.source = 'manual';
      copy.source_note = `Duplicated from "${original.title}".`;
      if (!includeSubtasks) copy.subtasks = [];
      briefReviewPlan.stories[sIndex].tasks.splice(tIndex + 1, 0, copy);
    } else {
      const [sIndex, tIndex, stIndex] = parts;
      const original = briefGetSubtask(sIndex, tIndex, stIndex);
      const copy = JSON.parse(JSON.stringify(original));
      copy.title = `${original.title} (copy)`;
      copy._edited = false;
      copy.source = 'manual';
      copy.source_note = `Duplicated from "${original.title}".`;
      briefReviewPlan.stories[sIndex].tasks[tIndex].subtasks.splice(stIndex + 1, 0, copy);
    }
    closeDialog(overlay);
    refreshBriefTree();
    toast('Duplicated.');
  });
}

function openBriefAiEditDialog(path) {
  const [sIndex] = briefPathParts(path);
  const story = briefGetStory(sIndex);
  if (!story) return;
  const overlay = document.createElement('div');
  overlay.id = 'briefAiEditDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form class="dialog-card stack compact-dialog" id="briefAiEditForm">
    <div class="dialog-head"><h2 id="briefAiEditTitle">Improve "${escapeHtml(story.name)}" with AI</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <label>Instruction<textarea name="instruction" required rows="3" placeholder="e.g. Break this into more detailed development tasks"></textarea></label>
    <p class="small muted">The AI will propose revised tasks for this story. Review them before creating the project.</p>
    <div class="actions"><button class="primary" type="submit">Apply</button></div>
  </form>`;
  mountDialog(overlay, 'briefAiEditTitle');
  overlay.querySelector('#briefAiEditForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    const instruction = new FormData(event.currentTarget).get('instruction');
    setButtonBusy(button, true, 'Applying…');
    try {
      const result = await api(`/api/brief-sessions/${briefReviewSessionId}/ai-edit`, { method: 'POST', timeoutMs: 60_000, body: JSON.stringify({ story: { name: story.name, description: story.description, tasks: story.tasks }, instruction }) });
      if (!result.tasks.length) { toast(result.warning || 'The AI made no changes.', true); return; }
      story.tasks = result.tasks.map(task => ({ ...task, _edited: true }));
      briefReviewCollapsed.delete(`story:${sIndex}`);
      closeDialog(overlay);
      refreshBriefTree();
      toast(result.fallback_used ? (result.warning || 'No AI provider is configured; the story was left unchanged.') : `Updated with ${result.ai_provider}. Review the new tasks before creating the project.`);
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(button, false); }
  });
}

async function briefRegenerateScoped(kind, path, button) {
  const parts = briefPathParts(path);
  const item = kind === 'story' ? briefGetStory(parts[0]) : briefGetTask(parts[0], parts[1]);
  if (!item) return;
  if (briefHasManualEdits(kind, item) && !confirm('Some items have been manually edited. Regenerating may replace these changes.\n\nRegenerate anyway?')) return;
  setButtonBusy(button, true, 'Regenerating…');
  try {
    if (kind === 'story') {
      const result = await api(`/api/brief-sessions/${briefReviewSessionId}/regenerate-story`, { method: 'POST', timeoutMs: 60_000, body: JSON.stringify({ story: { name: item.name, description: item.description } }) });
      item.tasks = result.tasks;
      briefReviewCollapsed.delete(`story:${parts[0]}`);
      toast(result.fallback_used ? 'Regenerated with local fallback.' : `Regenerated with ${result.ai_provider}.`);
    } else {
      const result = await api(`/api/brief-sessions/${briefReviewSessionId}/regenerate-task`, { method: 'POST', timeoutMs: 60_000, body: JSON.stringify({ task: { title: item.title, description: item.description } }) });
      item.subtasks = result.subtasks;
      briefReviewCollapsed.delete(`task:${parts[0]}:${parts[1]}`);
      toast(result.fallback_used ? 'Regenerated with local fallback.' : `Regenerated with ${result.ai_provider}.`);
    }
    refreshBriefTree();
  } catch (error) { toast(error.message, true); } finally { setButtonBusy(button, false); }
}

function wireBriefTreeActions(overlay) {
  const tree = overlay.querySelector('#briefReviewTree');
  tree.addEventListener('click', event => {
    const toggle = event.target.closest('[data-action="brief-toggle"]');
    if (toggle) {
      const key = toggle.dataset.key;
      if (briefReviewCollapsed.has(key)) briefReviewCollapsed.delete(key); else briefReviewCollapsed.add(key);
      refreshBriefTree();
      return;
    }
    const addStory = event.target.closest('[data-action="brief-add-story"]');
    if (addStory) {
      briefReviewPlan.stories.push(blankBriefStory());
      refreshBriefTree();
      return;
    }
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, kind, path } = button.dataset;
    if (action === 'brief-assign') { openBriefAssignPicker(kind, path); return; }
    if (action === 'brief-edit') { openBriefItemEditDialog(kind, path); return; }
    if (action === 'brief-duplicate') { openBriefDuplicateDialog(kind, path); return; }
    if (action === 'brief-move') { openBriefMoveDialog(kind, path); return; }
    if (action === 'brief-ai-edit') { openBriefAiEditDialog(path); return; }
    if (action === 'brief-regenerate') { briefRegenerateScoped(kind, path, button); return; }
    if (action === 'brief-add-task') {
      const story = briefGetStory(Number(path));
      story.tasks.push(blankBriefTask());
      briefReviewCollapsed.delete(`story:${path}`);
      refreshBriefTree();
      return;
    }
    if (action === 'brief-add-subtask') {
      const [sIndex, tIndex] = briefPathParts(path);
      briefGetTask(sIndex, tIndex).subtasks.push(blankBriefSubtask());
      briefReviewCollapsed.delete(`task:${sIndex}:${tIndex}`);
      refreshBriefTree();
      return;
    }
    if (action === 'brief-delete') {
      const item = kind === 'story' ? briefGetStory(Number(path)) : kind === 'task' ? briefGetTask(...briefPathParts(path)) : briefGetSubtask(...briefPathParts(path));
      if (!item || !briefConfirmDelete(kind, item)) return;
      if (kind === 'story') briefReviewPlan.stories.splice(Number(path), 1);
      else if (kind === 'task') { const [sIndex, tIndex] = briefPathParts(path); briefReviewPlan.stories[sIndex].tasks.splice(tIndex, 1); }
      else { const [sIndex, tIndex, stIndex] = briefPathParts(path); briefReviewPlan.stories[sIndex].tasks[tIndex].subtasks.splice(stIndex, 1); }
      refreshBriefTree();
    }
  });
  tree.addEventListener('change', event => {
    const checkbox = event.target.closest('[data-brief-check]');
    if (!checkbox) return;
    const key = checkbox.dataset.briefCheck;
    if (checkbox.checked) briefReviewRejected.delete(key); else briefReviewRejected.add(key);
  });
  tree.addEventListener('input', event => {
    const nameField = event.target.closest('[data-brief-name]');
    if (!nameField) return;
    const [kind, ...rest] = nameField.dataset.briefName.split(':');
    const indices = rest.map(Number);
    if (kind === 'story') { const item = briefGetStory(indices[0]); item.name = nameField.value; item._edited = true; }
    else if (kind === 'task') { const item = briefGetTask(indices[0], indices[1]); item.title = nameField.value; item._edited = true; }
    else if (kind === 'subtask') { const item = briefGetSubtask(indices[0], indices[1], indices[2]); item.title = nameField.value; item._edited = true; }
  });
}

function openBriefReviewDialog(analysis) {
  briefReviewPlan = JSON.parse(JSON.stringify(analysis.plan));
  briefReviewSessionId = analysis.session_id;
  briefReviewRejected = new Set();
  briefReviewCollapsed = new Set();
  const isNewProjectFlow = Boolean(intakeDetails);
  const commitLabel = isNewProjectFlow ? 'Create Project' : 'Accept selected & create';
  const overlay = document.createElement('div');
  overlay.id = 'briefReviewDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<div class="dialog-card wide">
    <div class="dialog-head full"><div><h2 id="briefReviewTitle">Review generated plan</h2><p class="small muted">${analysis.fallback_used ? 'Generated with a local fallback (no AI key configured).' : `Generated with ${escapeHtml(analysis.ai_provider)}.`} Uncheck anything you don't want, edit inline or via each item's actions — use the ${ICONS.userPlus} button to assign a team member — then accept. Nothing is created until you click "${commitLabel}".</p></div><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <div id="briefReviewTree">${renderBriefReviewTree(briefReviewPlan)}</div>
    <div class="full actions" style="margin-top:16px">
      <button type="button" class="secondary" data-action="brief-select-all">Accept all</button>
      <button type="button" class="secondary" data-action="brief-select-none">Select none</button>
      <button type="button" class="secondary" data-action="brief-regenerate">Regenerate all</button>
      <button type="button" class="primary" data-action="brief-commit">${commitLabel}</button>
    </div>
  </div>`;
  mountDialog(overlay, 'briefReviewTitle');
  briefActiveReviewOverlay = overlay;
  overlay._onClose = () => { if (briefActiveReviewOverlay === overlay) briefActiveReviewOverlay = null; };
  wireBriefTreeActions(overlay);
  overlay.querySelector('[data-action="brief-select-all"]').addEventListener('click', () => {
    briefReviewRejected.clear();
    refreshBriefTree();
  });
  overlay.querySelector('[data-action="brief-select-none"]').addEventListener('click', () => {
    briefAllKeys().forEach(key => briefReviewRejected.add(key));
    refreshBriefTree();
  });
  overlay.querySelector('[data-action="brief-regenerate"]').addEventListener('click', async event => {
    if (briefPlanHasAnyManualEdits(briefReviewPlan) && !confirm('Some items have been manually edited. Regenerating may replace these changes.\n\nRegenerate anyway?')) return;
    const button = event.currentTarget;
    setButtonBusy(button, true, 'Regenerating…');
    try {
      const freshAnalysis = await api(`/api/brief-sessions/${briefReviewSessionId}/regenerate`, { method: 'POST', timeoutMs: 60_000 });
      closeDialog(overlay);
      openBriefReviewDialog(freshAnalysis);
      toast('Plan regenerated.');
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(button, false); }
  });
  overlay.querySelector('[data-action="brief-commit"]').addEventListener('click', async event => {
    const button = event.currentTarget;
    setButtonBusy(button, true, 'Creating…');
    const detailsForCommit = intakeDetails;
    intakeDetails = null;
    try {
      const plan = collectBriefReviewPlan();
      const result = await api(`/api/brief-sessions/${briefReviewSessionId}/commit`, { method: 'POST', body: JSON.stringify({ plan, ...(detailsForCommit || {}) }) });
      closeDialog(overlay);
      resetIntakeState();
      openWorkDistributionSummaryDialog(result, async () => {
        state.projectId = Number(result.project_id);
        state.projectTab = 'overview';
        state.view = 'work';
        await loadWorkspace();
      });
    } catch (error) { intakeDetails = detailsForCommit; toast(error.message, true); } finally { setButtonBusy(button, false); }
  });
}

function workDistributionSummaryMarkup(result) {
  const teamRows = (result.team_breakdown || []).map(entry => {
    const notified = (result.teams_notified || []).some(item => Number(item.team_id) === Number(entry.team_id));
    const noManager = (result.teams_without_manager || []).some(item => Number(item.team_id) === Number(entry.team_id));
    const statusLabel = notified ? '✓ Manager notified' : noManager ? '⚠ No manager assigned' : '';
    return `<div class="milestone-item" style="margin-bottom:8px">
      <div><strong>${escapeHtml(entry.team_name)}</strong><div class="small muted">${entry.task_count} task${entry.task_count === 1 ? '' : 's'} · ${entry.subtask_count} subtask${entry.subtask_count === 1 ? '' : 's'}</div></div>
      <span class="small ${noManager ? 'danger' : ''}">${statusLabel}</span>
    </div>`;
  }).join('') || '<div class="empty small">No work was routed to a team.</div>';
  const unassignedNotice = result.unassigned_task_count
    ? `<div class="notice danger" style="margin-top:12px">⚠ ${result.unassigned_task_count} task${result.unassigned_task_count === 1 ? '' : 's'} need manual team assignment — no confident team match was found.</div>`
    : '';
  const noManagerTeams = (result.teams_without_manager || []);
  const noManagerNotice = noManagerTeams.length
    ? `<div class="notice danger" style="margin-top:12px">⚠ ${noManagerTeams.map(item => escapeHtml(item.team_name)).join(', ')} ${noManagerTeams.length === 1 ? 'has' : 'have'} no manager assigned. Work is saved but nobody was notified — assign a manager or distribute this work manually.</div>`
    : '';
  return `<div class="grid cols-4">
      <div class="card"><div class="small muted">Stories</div><div class="metric">${result.storyCount}</div></div>
      <div class="card"><div class="small muted">Tasks</div><div class="metric">${result.taskCount}</div></div>
      <div class="card"><div class="small muted">Subtasks</div><div class="metric">${result.subtaskCount}</div></div>
      <div class="card"><div class="small muted">Teams identified</div><div class="metric">${(result.team_breakdown || []).length}</div></div>
    </div>
    <section class="card" style="margin-top:16px"><h3>Team routing</h3>${teamRows}</section>
    ${unassignedNotice}${noManagerNotice}`;
}

function openWorkDistributionSummaryDialog(result, onContinue) {
  const overlay = document.createElement('div');
  overlay.id = 'workDistributionDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<div class="dialog-card wide">
    <div class="dialog-head full"><h2 id="workDistributionTitle">Work Distribution</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    ${workDistributionSummaryMarkup(result)}
    <div class="full actions" style="margin-top:16px"><button type="button" class="primary" data-action="continue-work-distribution">Continue to project</button></div>
  </div>`;
  mountDialog(overlay, 'workDistributionTitle');
  let navigated = false;
  overlay._onClose = async () => {
    if (navigated) return;
    navigated = true;
    await onContinue?.();
    toast(`Created ${result.storyCount} stories, ${result.taskCount} tasks, ${result.subtaskCount} subtasks.`);
  };
  overlay.querySelector('[data-action="continue-work-distribution"]').addEventListener('click', () => closeDialog(overlay));
}

function collectBriefReviewPlan() {
  const plan = briefReviewPlan;
  const isAccepted = key => !briefReviewRejected.has(key);
  const departments = plan.departments.filter((item, i) => isAccepted(`department:${i}`));
  const milestones = plan.milestones.filter((item, i) => isAccepted(`milestone:${i}`));
  const risks = plan.risks.filter((item, i) => isAccepted(`risk:${i}`));
  const assumptions = plan.assumptions.filter((item, i) => isAccepted(`assumption:${i}`));
  const stories = [];
  plan.stories.forEach((story, sIndex) => {
    if (!isAccepted(`story:${sIndex}`)) return;
    const tasks = [];
    story.tasks.forEach((task, tIndex) => {
      if (!isAccepted(`task:${sIndex}:${tIndex}`)) return;
      const subtasks = task.subtasks.filter((subtask, stIndex) => isAccepted(`subtask:${sIndex}:${tIndex}:${stIndex}`));
      tasks.push({ ...task, subtasks });
    });
    stories.push({ ...story, tasks });
  });
  return { departments, milestones, risks, assumptions, stories };
}

function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}


function openDepartmentDialog(departmentId = null) {
  const department = state.departments.find(item => Number(item.id) === Number(departmentId));
  const managerOptions = `<option value="">Unassigned</option>${state.members.filter(member => member.status === 'active').map(member => `<option value="${member.user_id}" ${Number(department?.manager_user_id) === Number(member.user_id) ? 'selected' : ''}>${escapeHtml(member.full_name)}</option>`).join('')}`;
  const overlay = document.createElement('div');
  overlay.id = 'departmentDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="departmentForm" class="dialog-card form-grid"><div class="dialog-head full"><h2 id="departmentDialogTitle">${department ? 'Edit department' : 'Add department'}</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <label class="full">Name<input name="name" autofocus required value="${escapeHtml(department?.name || '')}"></label>
    <label class="full">Description<textarea name="description">${escapeHtml(department?.description || '')}</textarea></label>
    <label>Manager<select name="manager_user_id">${managerOptions}</select></label>
    <div class="full actions"><button class="primary" type="submit">${department ? 'Save changes' : 'Create department'}</button></div>
  </form>`;
  mountDialog(overlay, 'departmentDialogTitle');
  overlay.querySelector('#departmentForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    const payload = { name: form.get('name'), description: form.get('description'), manager_user_id: form.get('manager_user_id') || null };
    try {
      if (department) await api(`/api/departments/${department.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else await api(`/api/organizations/${state.organizationId}/departments`, { method: 'POST', body: JSON.stringify(payload) });
      closeDialog(overlay);
      await loadWorkspace();
      toast(department ? 'Department updated.' : 'Department created.');
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
}

function openTeamDialog(teamId = null, defaultDepartmentId = null) {
  const team = state.teams.find(item => Number(item.id) === Number(teamId));
  const departmentOptions = `<option value="">None</option>${state.departments.map(department => `<option value="${department.id}" ${Number(team?.department_id ?? defaultDepartmentId) === Number(department.id) ? 'selected' : ''}>${escapeHtml(department.name)}</option>`).join('')}`;
  const leadOptions = `<option value="">Unassigned</option>${state.members.filter(member => member.status === 'active').map(member => `<option value="${member.user_id}" ${Number(team?.lead_user_id) === Number(member.user_id) ? 'selected' : ''}>${escapeHtml(member.full_name)}</option>`).join('')}`;
  const overlay = document.createElement('div');
  overlay.id = 'teamDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="teamForm" class="dialog-card form-grid"><div class="dialog-head full"><h2 id="teamDialogTitle">${team ? 'Edit team' : 'Add team'}</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <label class="full">Name<input name="name" autofocus required value="${escapeHtml(team?.name || '')}"></label>
    <label class="full">Description<textarea name="description">${escapeHtml(team?.description || '')}</textarea></label>
    <label>Department<select name="department_id">${departmentOptions}</select></label>
    <label>Team lead<select name="lead_user_id">${leadOptions}</select></label>
    ${team ? `<label>Status<select name="status">${['active', 'archived'].map(value => `<option value="${value}" ${team.status === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>` : ''}
    <div class="full actions">${team ? `<button type="button" class="icon-action danger" data-action="delete-team" aria-label="Delete team" data-tooltip="Delete team">${ICONS.trash}</button>` : ''}<button class="primary" type="submit">${team ? 'Save changes' : 'Create team'}</button></div>
  </form>`;
  mountDialog(overlay, 'teamDialogTitle');
  overlay.querySelector('#teamForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    const payload = { name: form.get('name'), description: form.get('description'), department_id: form.get('department_id') || null, lead_user_id: form.get('lead_user_id') || null };
    if (team) payload.status = form.get('status');
    try {
      if (team) await api(`/api/teams/${team.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else await api(`/api/organizations/${state.organizationId}/teams`, { method: 'POST', body: JSON.stringify(payload) });
      closeDialog(overlay);
      await loadWorkspace();
      toast(team ? 'Team updated.' : 'Team created.');
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
  overlay.querySelector('[data-action="delete-team"]')?.addEventListener('click', async () => {
    if (!confirm('Delete this team?')) return;
    try {
      await api(`/api/teams/${team.id}`, { method: 'DELETE' });
      closeDialog(overlay);
      state.teamsDetail = null;
      await loadWorkspace();
      toast('Team deleted.');
    } catch (error) { toast(error.message, true); }
  });
}

function openAddTeamMemberDialog(teamId) {
  const existingIds = new Set((state.teamWorkspaceData?.members || []).map(person => Number(person.user_id)));
  const options = state.members.filter(member => member.status === 'active' && !existingIds.has(Number(member.user_id))).map(member => `<option value="${member.user_id}">${escapeHtml(member.full_name)}</option>`).join('');
  const overlay = document.createElement('div');
  overlay.id = 'teamMemberDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="teamMemberForm" class="dialog-card form-grid"><div class="dialog-head full"><h2 id="teamMemberDialogTitle">Add team member</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <label class="full">Person<select name="user_id" required>${options || '<option value="">No available members</option>'}</select></label>
    <label class="full">Role on this team<input name="role_in_team" placeholder="e.g. Developer, QA Engineer" maxlength="80"></label>
    <div class="full actions"><button class="primary" type="submit">Add to team</button></div>
  </form>`;
  mountDialog(overlay, 'teamMemberDialogTitle');
  overlay.querySelector('#teamMemberForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    try {
      await api(`/api/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify({ user_id: form.get('user_id'), role_in_team: form.get('role_in_team') }) });
      closeDialog(overlay);
      state.teamWorkspaceData = await api(`/api/teams/${teamId}/workspace`);
      await loadWorkspace();
      toast('Member added to team.');
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
}

function openCustomizeDashboardDialog() {
  const layout = getDashboardLayout();
  const overlay = document.createElement('div');
  overlay.id = 'customizeDashboardDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="customizeDashboardForm" class="dialog-card stack compact-dialog">
    <div class="dialog-head"><div><h2 id="customizeDashboardTitle">Customize Dashboard</h2><p class="small muted">Choose which widgets appear on your Dashboard.</p></div><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    ${layout.map(item => `<label class="toggle-row"><span><strong>${escapeHtml(DASHBOARD_WIDGET_LABELS[item.key] || item.key)}</strong></span><input type="checkbox" name="widget" value="${item.key}" ${item.visible ? 'checked' : ''}></label>`).join('')}
    <div class="actions"><button type="button" class="secondary" data-action="restore-dashboard-defaults">Restore defaults</button><button class="primary" type="submit">Save</button></div>
  </form>`;
  mountDialog(overlay, 'customizeDashboardTitle');
  overlay.querySelector('#customizeDashboardForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const checkedKeys = new Set(form.getAll('widget'));
    const newLayout = DEFAULT_DASHBOARD_LAYOUT.map(item => ({ key: item.key, visible: checkedKeys.has(item.key) }));
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    try {
      state.settings = await api('/api/users/me/settings', { method: 'PATCH', body: JSON.stringify({ dashboard_layout: newLayout }) });
      closeDialog(overlay);
      render();
      toast('Dashboard updated.');
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
  overlay.querySelector('[data-action="restore-dashboard-defaults"]').addEventListener('click', async () => {
    try {
      state.settings = await api('/api/users/me/settings', { method: 'PATCH', body: JSON.stringify({ dashboard_layout: DEFAULT_DASHBOARD_LAYOUT }) });
      closeDialog(overlay);
      render();
      toast('Dashboard reset to defaults.');
    } catch (error) { toast(error.message, true); }
  });
}

function openNewDmDialog() {
  const options = state.members.filter(member => member.status === 'active' && Number(member.user_id) !== Number(state.user.id)).map(member => `<option value="${member.user_id}">${escapeHtml(member.full_name)} (@${escapeHtml(member.username)})</option>`).join('');
  const overlay = document.createElement('div');
  overlay.id = 'newDmDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="newDmForm" class="dialog-card stack compact-dialog"><div class="dialog-head"><div><h2 id="newDmDialogTitle">New direct message</h2></div><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <label>To<select name="user_id" autofocus required>${options || '<option value="">No other members yet</option>'}</select></label>
    <div class="actions"><button class="primary" type="submit">Start conversation</button></div>
  </form>`;
  mountDialog(overlay, 'newDmDialogTitle');
  overlay.querySelector('#newDmForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    try {
      const result = await api(`/api/organizations/${state.organizationId}/direct-conversations`, { method: 'POST', body: JSON.stringify({ user_id: form.get('user_id') }) });
      closeDialog(overlay);
      state.directConversations = await api(`/api/organizations/${state.organizationId}/direct-conversations`);
      await openConversation(Number(result.id));
      render();
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
}

function openMilestoneDialog(milestoneId = null) {
  const milestone = state.milestones.find(item => Number(item.id) === Number(milestoneId));
  const ownerOptions = `<option value="">Unassigned</option>${state.members.filter(member => member.status === 'active').map(member => `<option value="${member.user_id}" ${Number(milestone?.owner_id) === Number(member.user_id) ? 'selected' : ''}>${escapeHtml(member.full_name)}</option>`).join('')}`;
  const overlay = document.createElement('div');
  overlay.id = 'milestoneDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="milestoneForm" class="dialog-card form-grid"><div class="dialog-head full"><h2 id="milestoneDialogTitle">${milestone ? 'Edit milestone' : 'Add milestone'}</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <label class="full">Name<input name="name" autofocus required value="${escapeHtml(milestone?.name || '')}"></label>
    <label class="full">Description<textarea name="description">${escapeHtml(milestone?.description || '')}</textarea></label>
    <label>Due date<input name="due_date" type="date" value="${escapeHtml(milestone?.due_date || '')}"></label>
    <label>Owner<select name="owner_id">${ownerOptions}</select></label>
    <label>Status<select name="status">${['planned', 'in_progress', 'at_risk', 'done'].map(value => `<option value="${value}" ${milestone?.status === value ? 'selected' : ''}>${value.replaceAll('_', ' ')}</option>`).join('')}</select></label>
    <div class="full actions">${milestone ? `<button type="button" class="icon-action danger" data-action="delete-milestone" aria-label="Delete milestone" data-tooltip="Delete milestone">${ICONS.trash}</button>` : ''}<button class="primary" type="submit">${milestone ? 'Save changes' : 'Create milestone'}</button></div>
  </form>`;
  mountDialog(overlay, 'milestoneDialogTitle');
  overlay.querySelector('#milestoneForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    const payload = { name: form.get('name'), description: form.get('description'), due_date: form.get('due_date') || null, owner_id: form.get('owner_id') || null, status: form.get('status') };
    try {
      if (milestone) await api(`/api/milestones/${milestone.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else await api(`/api/projects/${state.projectId}/milestones`, { method: 'POST', body: JSON.stringify(payload) });
      closeDialog(overlay);
      await loadProjectData();
      render();
      toast(milestone ? 'Milestone updated.' : 'Milestone created.');
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
  overlay.querySelector('[data-action="delete-milestone"]')?.addEventListener('click', async () => {
    if (!confirm('Delete this milestone?')) return;
    try {
      await api(`/api/milestones/${milestone.id}`, { method: 'DELETE' });
      closeDialog(overlay);
      await loadProjectData();
      render();
      toast('Milestone deleted.');
    } catch (error) { toast(error.message, true); }
  });
}

function openAddColumnDialog() {
  const overlay = document.createElement('div');
  overlay.id = 'addColumnDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="addColumnForm" class="dialog-card form-grid"><div class="dialog-head full"><h2 id="addColumnDialogTitle">Create column</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <label class="full">Name<input name="name" autofocus required maxlength="80" placeholder="e.g. Client Review"></label>
    <label class="full">Maps to status<select name="maps_to_status">${['not_started', 'in_progress', 'blocked', 'done'].map(value => `<option value="${value}">${value.replaceAll('_', ' ')}</option>`).join('')}</select></label>
    <div class="full small muted">Tasks placed in this column automatically carry this status, so it stays compatible with the Dashboard, Reports, and filters.</div>
    <div class="full actions"><button class="primary" type="submit">Create column</button></div>
  </form>`;
  mountDialog(overlay, 'addColumnDialogTitle');
  overlay.querySelector('#addColumnForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    try {
      await api(`/api/projects/${state.projectId}/board-columns`, { method: 'POST', body: JSON.stringify({ name: form.get('name'), maps_to_status: form.get('maps_to_status') }) });
      closeDialog(overlay);
      await loadProjectData();
      render();
      toast('Column created.');
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
}

function openColumnOptionsDialog(columnId) {
  const column = state.boardColumns.find(item => Number(item.id) === Number(columnId));
  if (!column) return;
  const sorted = [...state.boardColumns].sort((a, b) => a.position - b.position);
  const index = sorted.findIndex(item => Number(item.id) === Number(column.id));
  const overlay = document.createElement('div');
  overlay.id = 'columnOptionsDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="columnOptionsForm" class="dialog-card form-grid"><div class="dialog-head full"><h2 id="columnOptionsDialogTitle">Column options</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <label class="full">Name<input name="name" autofocus required maxlength="80" value="${escapeHtml(column.name)}"></label>
    <label class="full">Maps to status<select name="maps_to_status">${['not_started', 'in_progress', 'blocked', 'done'].map(value => `<option value="${value}" ${column.maps_to_status === value ? 'selected' : ''}>${value.replaceAll('_', ' ')}</option>`).join('')}</select></label>
    <div class="full small muted">Tasks dropped in this column automatically get this status; changing a task's status elsewhere relocates it to a matching column.</div>
    <div class="full actions" style="justify-content:space-between;flex-wrap:wrap">
      <div class="actions">
        <button type="button" class="icon-action" data-action="move-column-left" data-id="${column.id}" ${index <= 0 ? 'disabled' : ''} aria-label="Move left" data-tooltip="Move left">${ICONS.chevronLeft}</button>
        <button type="button" class="icon-action" data-action="move-column-right" data-id="${column.id}" ${index >= sorted.length - 1 ? 'disabled' : ''} aria-label="Move right" data-tooltip="Move right">${ICONS.chevronRight}</button>
        <button type="button" class="icon-action danger" data-action="delete-column" data-id="${column.id}" aria-label="Delete column" data-tooltip="Delete column">${ICONS.trash}</button>
      </div>
      <button class="primary" type="submit">Save changes</button>
    </div>
  </form>`;
  mountDialog(overlay, 'columnOptionsDialogTitle');
  overlay.querySelector('#columnOptionsForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    try {
      await api(`/api/board-columns/${column.id}`, { method: 'PATCH', body: JSON.stringify({ name: form.get('name'), maps_to_status: form.get('maps_to_status') }) });
      closeDialog(overlay);
      await loadProjectData();
      render();
      toast('Column updated.');
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
  overlay.querySelector('[data-action="move-column-left"]')?.addEventListener('click', () => moveColumnDirection(column.id, -1, overlay));
  overlay.querySelector('[data-action="move-column-right"]')?.addEventListener('click', () => moveColumnDirection(column.id, 1, overlay));
  overlay.querySelector('[data-action="delete-column"]')?.addEventListener('click', () => { closeDialog(overlay); openDeleteColumnDialog(column.id); });
}

function openDeleteColumnDialog(columnId) {
  const column = state.boardColumns.find(item => Number(item.id) === Number(columnId));
  if (!column) return;
  if (state.boardColumns.length <= 1) { toast('A board must have at least one column.', true); return; }
  const otherColumns = state.boardColumns.filter(item => Number(item.id) !== Number(columnId));
  const taskCount = state.tasks.filter(task => Number(task.column_id) === Number(columnId) && !task.rejected).length;
  const overlay = document.createElement('div');
  overlay.id = 'deleteColumnDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="deleteColumnForm" class="dialog-card stack compact-dialog"><div class="dialog-head"><h2 id="deleteColumnDialogTitle">Delete column?</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    ${taskCount
      ? `<p class="muted">"${escapeHtml(column.name)}" contains ${taskCount} task${taskCount === 1 ? '' : 's'}. Choose where to move ${taskCount === 1 ? 'it' : 'them'} before deleting.</p>
         <label class="full">Move tasks to<select name="move_tasks_to_column_id" required>${otherColumns.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}</select></label>`
      : `<p class="muted">"${escapeHtml(column.name)}" is empty. It will be removed permanently.</p>`}
    <div class="actions"><button type="button" class="secondary" data-action="close-dialog">Cancel</button><button class="danger" type="submit">Delete column</button></div>
  </form>`;
  mountDialog(overlay, 'deleteColumnDialogTitle');
  overlay.querySelector('#deleteColumnForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    const moveTo = form.get('move_tasks_to_column_id');
    try {
      await api(`/api/board-columns/${columnId}`, { method: 'DELETE', body: JSON.stringify(moveTo ? { move_tasks_to_column_id: Number(moveTo) } : {}) });
      closeDialog(overlay);
      await loadProjectData();
      render();
      toast('Column deleted.');
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
}

function openOrganizationDialog() {
  const overlay = document.createElement('div');
  overlay.id = 'organizationDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="newOrganizationForm" class="dialog-card stack compact-dialog"><div class="dialog-head"><div><p class="eyebrow dark">NEW WORKSPACE</p><h2 id="organizationDialogTitle">Create another organization</h2></div><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div><p class="muted">You will become the CEO. After creation, Orbit switches to the new organization automatically.</p><label>Organization name<input name="name" autofocus minlength="2" maxlength="120" required placeholder="e.g. Northstar Labs"></label><div class="actions"><button class="primary" type="submit">Create and switch</button></div></form>`;
  mountDialog(overlay, 'organizationDialogTitle');
  overlay.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    try {
      const organization = await api('/api/organizations', { method: 'POST', body: JSON.stringify({ name: form.get('name') }) });
      const me = await api('/api/auth/me');
      state.organizations = me.organizations;
      state.workspaceAccess = me.workspace_access;
      state.organizationId = Number(organization.id);
      state.projectId = null;
      state.channelId = null;
      localStorage.setItem('orbit_organization_id', state.organizationId);
      closeDialog(overlay);
      await loadWorkspace();
      toast(`Created and switched to ${organization.name}.`);
    } catch (error) { toast(error.message, true); }
  });
}

function openProfileDialog() {
  state.view = 'profile';
  render();
}

async function refreshCurrent() {
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

async function downloadExport(format) {
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

async function switchView(view) {
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

$('#mainNav').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  switchView(button.dataset.view);
});

$('#headerNotificationBtn').addEventListener('click', () => switchView('notifications'));
$('#sidebarProfileBtn').addEventListener('click', () => switchView('profile'));
$('#headerProfileBtn').addEventListener('click', () => switchView('profile'));

async function switchOrganization(organizationId) {
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

organizationSelect.addEventListener('change', () => switchOrganization(organizationSelect.value).catch(error => toast(error.message, true)));
mobileOrganizationSelect.addEventListener('change', () => switchOrganization(mobileOrganizationSelect.value).catch(error => toast(error.message, true)));

async function switchProject(projectId, view = null) {
  try {
    state.projectId = Number(projectId) || null;
    if (state.projectId) localStorage.setItem('orbit_project_id', state.projectId); else localStorage.removeItem('orbit_project_id');
    if (view) state.view = view;
    await loadProjectData();
    updateShell();
    render();
  } catch (error) { renderWorkspaceError(error, 'retry-workspace'); toast(error.message, true); }
}

projectSelect.addEventListener('change', () => switchProject(projectSelect.value));

function hideGlobalSearchResults() {
  const panel = $('#globalSearchResults');
  panel.classList.add('hidden');
  panel.innerHTML = '';
}

function renderGlobalSearchResults(query) {
  const panel = $('#globalSearchResults');
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return hideGlobalSearchResults();
  const projectMatches = state.projects.filter(item => item.name.toLowerCase().includes(trimmed)).slice(0, 8);
  const taskMatches = state.tasks.filter(item => item.title.toLowerCase().includes(trimmed)).slice(0, 8);
  const sections = [];
  if (projectMatches.length) sections.push(`<div class="search-group-label">Projects (${projectMatches.length})</div>${projectMatches.map(item => `<button type="button" data-search-project="${item.id}">${escapeHtml(item.name)}</button>`).join('')}`);
  if (taskMatches.length) sections.push(`<div class="search-group-label">Tasks in current project (${taskMatches.length})</div>${taskMatches.map(item => `<button type="button" data-search-task="${item.id}">${escapeHtml(item.title)}</button>`).join('')}`);
  panel.innerHTML = sections.join('') || '<div class="empty">No matches found.</div>';
  panel.classList.remove('hidden');
}

let globalSearchTimer = null;
$('#globalSearchInput').addEventListener('input', event => {
  clearTimeout(globalSearchTimer);
  const query = event.target.value;
  globalSearchTimer = setTimeout(() => renderGlobalSearchResults(query), 200);
});
$('#globalSearchInput').addEventListener('focus', event => { if (event.target.value.trim()) renderGlobalSearchResults(event.target.value); });
document.addEventListener('click', event => {
  if (!event.target.closest('#globalSearchWrap') && !event.target.closest('#globalSearchResults')) hideGlobalSearchResults();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideGlobalSearchResults(); });
$('#globalSearchResults').addEventListener('click', async event => {
  const projectButton = event.target.closest('[data-search-project]');
  const taskButton = event.target.closest('[data-search-task]');
  if (projectButton) {
    hideGlobalSearchResults();
    $('#globalSearchInput').value = '';
    await switchProject(projectButton.dataset.searchProject, 'work');
  } else if (taskButton) {
    hideGlobalSearchResults();
    $('#globalSearchInput').value = '';
    openTaskDialog(Number(taskButton.dataset.searchTask));
  }
});

mainContent.addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.target;
  const form = new FormData(formElement);
  const submitter = event.submitter;
  setButtonBusy(submitter, true);
  try {
    if (formElement.id === 'channelForm') {
      const channel = await api(`/api/organizations/${state.organizationId}/channels`, { method: 'POST', body: JSON.stringify({ name: form.get('name'), topic: form.get('topic') }) });
      state.channelId = Number(channel.id);
      await loadWorkspace();
      toast('Channel created.');
    } else if (formElement.id === 'messageForm') {
      const created = await api(`/api/channels/${state.channelId}/messages`, { method: 'POST', body: JSON.stringify({ body: form.get('body') }) });
      formElement.reset();
      receiveMessage(created);
    } else if (formElement.id === 'directMessageForm') {
      const created = await api(`/api/direct-conversations/${state.activeConversationId}/messages`, { method: 'POST', body: JSON.stringify({ body: form.get('body') }) });
      formElement.reset();
      receiveDirectMessage(created);
    } else if (formElement.id === 'intakeBriefForm') {
      const rawText = String(form.get('raw_text') || '').trim();
      if (!intakeAttachedFile && !rawText) throw new Error('Describe the project or attach a brief file.');
      const progressWrap = formElement.querySelector('#intakeProgressWrap');
      const progressSteps = formElement.querySelector('#intakeProgressSteps');
      let sessionResult;
      if (intakeAttachedFile) {
        const uploadBody = new FormData();
        uploadBody.append('file', intakeAttachedFile);
        sessionResult = await api(`/api/organizations/${state.organizationId}/client-briefs/upload`, { method: 'POST', body: uploadBody, timeoutMs: 60_000 });
      } else {
        sessionResult = await api(`/api/organizations/${state.organizationId}/client-briefs`, { method: 'POST', body: JSON.stringify({ raw_text: rawText }) });
      }
      intakeSessionId = sessionResult.session_id;
      intakeGuessed = { clientName: sessionResult.client_name || '', projectName: sessionResult.project_name || '' };
      progressWrap.hidden = false;
      let source = null;
      try {
        const token = crypto.randomUUID();
        source = new EventSource(`/api/brief-analysis/progress?token=${encodeURIComponent(token)}`);
        source.onmessage = messageEvent => {
          try { const payload = JSON.parse(messageEvent.data); updateBriefProgress(progressSteps, payload.step, payload.detail); } catch {}
        };
        await new Promise(resolve => { source.onopen = resolve; setTimeout(resolve, 600); });
        intakeAnalysis = await api(`/api/client-briefs/${intakeSessionId}/analyze`, { method: 'POST', timeoutMs: 120_000, body: JSON.stringify({ stream_token: token }) });
      } finally {
        source?.close();
      }
      if (intakeAnalysis.project_fields) {
        const extracted = intakeAnalysis.project_fields;
        intakeGuessed = { projectName: extracted.name || intakeGuessed.projectName, clientName: extracted.client_name || intakeGuessed.clientName };
        intakeExtractedFields = extracted;
      }
      intakeStep = 'details';
      render();
      toast(intakeAnalysis.fallback_used ? 'Brief analyzed with local fallback.' : `Brief analyzed with ${intakeAnalysis.ai_provider}.`);
    } else if (formElement.id === 'intakeDetailsForm') {
      intakeDetails = {
        project_name: form.get('name'), client_name: form.get('client_name'), objective: form.get('objective'),
        scope: form.get('scope'), constraints: form.get('constraints'), owner_id: form.get('owner_id') || null,
        priority: form.get('priority'), start_date: form.get('start_date') || null, due_date: form.get('due_date') || null
      };
      openBriefReviewDialog(intakeAnalysis);
    } else if (formElement.id === 'meetingForm') {
      const result = await api(`/api/projects/${state.projectId}/meeting-notes`, { method: 'POST', timeoutMs: 60_000, body: JSON.stringify({ notes: form.get('notes') }) });
      await loadProjectData();
      render();
      toast(result.fallback_used ? 'Meeting proposals created with local fallback.' : `AI analyzed meeting notes with ${result.ai_provider}.`);
    } else if (formElement.id === 'changeForm') {
      const result = await api(`/api/projects/${state.projectId}/changes`, { method: 'POST', timeoutMs: 60_000, body: JSON.stringify({ title: form.get('title'), description: form.get('description'), requested_by: form.get('requested_by') }) });
      await loadProjectData();
      render();
      toast(result.fallback_used ? 'Change analyzed with local fallback.' : `AI change analysis completed with ${result.ai_provider}.`);
    } else if (formElement.id === 'profilePageForm') {
      state.user = await api('/api/users/me/profile', { method: 'PATCH', body: JSON.stringify({ full_name: form.get('full_name'), avatar_url: form.get('avatar_url') }) });
      state.members = await api(`/api/organizations/${state.organizationId}/members`);
      updateShell();
      render();
      toast('Profile updated.');
    } else if (formElement.id === 'statusPageForm') {
      const statusKey = form.get('status_key');
      state.presence = await api('/api/presence/me', { method: 'PATCH', body: JSON.stringify({ status_key: statusKey, status_label: form.get('status_label'), status_emoji: form.get('status_emoji'), custom_status: form.get('custom_status') }) });
      state.members = await api(`/api/organizations/${state.organizationId}/members`);
      updateShell();
      render();
      toast(`Status updated to ${state.presence.status_emoji} ${state.presence.status_label}.`);
    } else if (formElement.id === 'settingsForm') {
      state.settings = await api('/api/users/me/settings', { method: 'PATCH', body: JSON.stringify({
        theme: form.get('theme'),
        workspace_notifications: formElement.elements.workspace_notifications.checked,
        mention_notifications: formElement.elements.mention_notifications.checked,
        invitation_notifications: formElement.elements.invitation_notifications.checked,
        activity_notifications: formElement.elements.activity_notifications.checked
      }) });
      state.presence = await api('/api/presence/me', { method: 'PATCH', body: JSON.stringify({ presence_mode: form.get('presence_mode') }) });
      applyTheme(state.settings.theme);
      state.members = await api(`/api/organizations/${state.organizationId}/members`);
      updateShell();
      render();
      toast('Settings saved.');
    } else if (formElement.id === 'inviteForm') {
      await api(`/api/organizations/${state.organizationId}/invitations`, { method: 'POST', body: JSON.stringify({ identifier: form.get('identifier'), proposed_role: form.get('proposed_role'), proposed_department: form.get('proposed_department') }) });
      formElement.reset();
      await loadWorkspace();
      toast('Invitation sent to the registered user.');
    }
  } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
});

mainContent.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target.closest('[role="button"][data-action]');
  if (!target) return;
  event.preventDefault();
  target.click();
});

mainContent.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  setButtonBusy(button, true);
  try {
    if (action === 'ai-assist-field') {
      const field = document.getElementById(button.dataset.targetId);
      if (field) await openAiSuggestionDialog(field);
    } else if (action === 'retry-workspace') {
      await loadWorkspace();
      toast('Workspace loaded.');
    } else if (action === 'retry-render') {
      render();
    } else if (action === 'revoke-other-sessions') {
      const result = await api('/api/users/me/sessions/revoke-others', { method: 'POST' });
      state.sessions = await api('/api/users/me/sessions');
      render();
      toast(`${result.revoked_count} other session(s) signed out.`);
    } else if (action === 'revoke-session') {
      const result = await api(`/api/users/me/sessions/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' });
      if (result.current) { logout(); return; }
      state.sessions = await api('/api/users/me/sessions');
      render();
      toast('Session revoked.');
    } else if (action === 'open-admin') {
      state.view = 'admin'; render();
    } else if (action === 'open-intake') {
      resetIntakeState();
      state.view = 'intake'; render();
    } else if (action === 'open-project') {
      state.projectTab = 'overview';
      await switchProject(button.dataset.id, 'work');
    } else if (action === 'open-members') {
      state.view = 'members'; render();
    } else if (action === 'edit-profile') {
      state.view = 'profile'; render();
    } else if (action === 'mark-notification-read') {
      const updated = await api(`/api/notifications/${button.dataset.id}/read`, { method: 'PATCH' });
      state.notifications = state.notifications.map(item => Number(item.id) === Number(updated.id) ? { ...item, read_at: updated.read_at } : item);
      state.unreadNotificationCount = Math.max(0, state.unreadNotificationCount - 1);
      updateShell(); render();
    } else if (action === 'read-all-notifications') {
      await api('/api/users/me/notifications/read-all', { method: 'POST' });
      const now = new Date().toISOString();
      state.notifications = state.notifications.map(item => ({ ...item, read_at: item.read_at || now }));
      state.unreadNotificationCount = 0;
      updateShell(); render(); toast('All notifications marked as read.');
    } else if (action === 'open-notification') {
      const item = state.notifications.find(notification => Number(notification.id) === Number(button.dataset.id));
      if (item && !item.read_at) {
        const updated = await api(`/api/notifications/${button.dataset.id}/read`, { method: 'PATCH' });
        item.read_at = updated.read_at;
        state.unreadNotificationCount = Math.max(0, state.unreadNotificationCount - 1);
      }
      const rawDestination = String(button.dataset.view || '');
      const [destination, entityId] = rawDestination.includes(':') ? rawDestination.split(':') : [rawDestination, null];
      if (destination === 'teams' && entityId) {
        state.teamWorkspaceData = await api(`/api/teams/${entityId}/workspace`);
        state.teamsDetail = { type: 'team', id: Number(entityId) };
        state.view = 'teams';
        updateShell(); render();
      } else if (destination === 'work' && entityId) {
        const task = await api(`/api/tasks/${entityId}`);
        if (Number(state.projectId) !== Number(task.project_id)) await switchProject(Number(task.project_id), 'work');
        else state.view = 'work';
        state.projectTab = 'list';
        localStorage.setItem('orbit_project_tab', 'list');
        updateShell(); render();
        openTaskDialog(Number(entityId));
      } else {
        state.view = destination === 'admin' && !canManage() ? 'notifications' : (viewTitles[destination] ? destination : 'notifications');
        if (state.view === 'activity') state.activity = await api('/api/users/me/activity?limit=100');
        updateShell(); render();
      }
    } else if (action === 'refresh-activity') {
      state.activity = await api('/api/users/me/activity?limit=100');
      render(); toast('Account activity refreshed.');
    } else if (action === 'select-channel') {
      state.channelId = Number(button.dataset.id);
      localStorage.setItem('orbit_channel_id', state.channelId);
      await loadMessages();
      connectMessageStream(state.channelId);
      render();
    } else if (action === 'set-chat-mode') {
      state.chatMode = button.dataset.mode;
      localStorage.setItem('orbit_chat_mode', state.chatMode);
      if (state.chatMode === 'direct') {
        state.directConversations = await api(`/api/organizations/${state.organizationId}/direct-conversations`);
        if (state.activeConversationId && state.directConversations.some(item => Number(item.id) === Number(state.activeConversationId))) await openConversation(state.activeConversationId);
      } else {
        disconnectDmStream();
      }
      render();
    } else if (action === 'select-conversation') {
      await openConversation(Number(button.dataset.id));
      render();
    } else if (action === 'open-new-dm') {
      openNewDmDialog();
    } else if (action === 'customize-dashboard') {
      openCustomizeDashboardDialog();
    } else if (action === 'toggle-dashboard-collapse') {
      const key = button.dataset.key;
      const section = button.closest('.dashboard-collapsible');
      const title = section?.dataset.collapseTitle || '';
      const wasCollapsed = getDashboardCollapseState(key);
      const nowCollapsed = !wasCollapsed;
      setDashboardCollapseState(key, nowCollapsed);
      const extra = section?.querySelector('.dashboard-collapsible-extra');
      if (extra) {
        extra.classList.toggle('is-open', !nowCollapsed);
        if (nowCollapsed) extra.setAttribute('aria-hidden', 'true'); else extra.removeAttribute('aria-hidden');
      }
      const label = nowCollapsed ? 'Expand' : 'Collapse';
      button.innerHTML = nowCollapsed ? ICONS.chevronDown : ICONS.chevronUp;
      button.setAttribute('aria-expanded', String(!nowCollapsed));
      button.setAttribute('aria-label', `${label} ${title}`.trim());
      button.setAttribute('data-tooltip', label);
    } else if (action === 'dashboard-my-tasks-tab') {
      state.dashboardMyTasksTab = button.dataset.tab;
      render();
    } else if (action === 'open-task-cross-project') {
      const targetProjectId = Number(button.dataset.projectId);
      const targetTaskId = Number(button.dataset.id);
      if (Number(state.projectId) !== targetProjectId) await switchProject(targetProjectId, 'work');
      state.projectTab = 'list';
      localStorage.setItem('orbit_project_tab', 'list');
      openTaskDialog(targetTaskId);
    } else if (action === 'scan-risks') {
      const result = await api(`/api/projects/${state.projectId}/risks/scan`, { method: 'POST', timeoutMs: 60_000 });
      await loadProjectData(); render(); toast(result.fallback_used ? 'Risk scan completed with local rules.' : `AI risk scan completed with ${result.ai_provider}.`);
    } else if (action === 'generate-plan') {
      openGeneratePlanDialog();
    } else if (action === 'open-task') {
      openTaskDialog(button.dataset.id ? Number(button.dataset.id) : null);
    } else if (action === 'quick-assign-task') {
      const targetId = Number(button.dataset.id);
      const target = state.tasks.find(item => Number(item.id) === targetId);
      if (target) {
        const openTaskDialogEl = document.getElementById('taskDialog');
        const reopenTaskId = openTaskDialogEl ? Number(openTaskDialogEl.querySelector('input[name="task_id"]')?.value) || null : null;
        await openAssignDialog(target, {
          onAssigned: async () => {
            await loadProjectData();
            render();
            if (reopenTaskId) { closeDialog(document.getElementById('taskDialog')); openTaskDialog(reopenTaskId); }
          }
        });
      }
    } else if (action === 'add-task-to-column') {
      openTaskDialog(null, Number(button.dataset.id));
    } else if (action === 'open-add-column') {
      openAddColumnDialog();
    } else if (action === 'open-column-options') {
      openColumnOptionsDialog(Number(button.dataset.id));
    } else if (action === 'set-project-tab') {
      state.projectTab = button.dataset.tab;
      localStorage.setItem('orbit_project_tab', state.projectTab);
      render();
    } else if (action === 'jump-view') {
      state.view = button.dataset.view;
      render();
    } else if (action === 'dashboard-open-tasks') {
      state.view = 'work';
      state.projectTab = 'list';
      localStorage.setItem('orbit_project_tab', 'list');
      render();
    } else if (action === 'edit-project') {
      openProjectEditDialog();
    } else if (action === 'open-story') {
      openStoryDialog(button.dataset.id ? Number(button.dataset.id) : null);
    } else if (action === 'open-brief-analyzer') {
      openBriefAnalyzerDialog();
    } else if (action === 'intake-attach') {
      $('#intakeFileInput')?.click();
    } else if (action === 'intake-remove-file') {
      intakeAttachedFile = null;
      render();
    } else if (action === 'intake-back-to-brief') {
      intakeStep = 'brief';
      render();
    } else if (action === 'open-department') {
      openDepartmentDialog(button.dataset.id ? Number(button.dataset.id) : null);
    } else if (action === 'open-team') {
      openTeamDialog(button.dataset.id ? Number(button.dataset.id) : null, button.dataset.departmentId ? Number(button.dataset.departmentId) : null);
    } else if (action === 'view-department') {
      state.teamsDetail = { type: 'department', id: Number(button.dataset.id) };
      render();
    } else if (action === 'view-team') {
      const teamId = Number(button.dataset.id);
      state.teamWorkspaceData = await api(`/api/teams/${teamId}/workspace`);
      state.teamsDetail = { type: 'team', id: teamId };
      render();
    } else if (action === 'open-distribute-work') {
      const teamId = Number(button.dataset.id);
      state.teamWorkspaceData = await api(`/api/teams/${teamId}/workspace`);
      state.teamsDetail = { type: 'distribute', id: teamId };
      state.view = 'teams';
      render();
    } else if (action === 'distribute-select-all') {
      mainContent.querySelectorAll('[data-distribute-check]').forEach(checkbox => { checkbox.checked = true; });
    } else if (action === 'distribute-assign-selected') {
      const teamId = Number(button.dataset.teamId);
      const taskIds = [...mainContent.querySelectorAll('[data-distribute-check]:checked')].map(checkbox => Number(checkbox.value));
      const ownerId = $('#distributeBulkOwner')?.value || null;
      if (!taskIds.length) { toast('Select at least one row first.', true); }
      else {
        await api('/api/tasks/bulk-assign', { method: 'POST', body: JSON.stringify({ task_ids: taskIds, owner_id: ownerId ? Number(ownerId) : null }) });
        state.teamWorkspaceData = await api(`/api/teams/${teamId}/workspace`);
        await loadProjectData();
        render();
        toast(`Assigned ${taskIds.length} item${taskIds.length === 1 ? '' : 's'}.`);
      }
    } else if (action === 'distribute-save-assignments') {
      const teamId = Number(button.dataset.teamId);
      const rows = [...mainContent.querySelectorAll('[data-distribute-owner]')].filter(select => select.value);
      if (!rows.length) { toast('Choose an assignee for at least one row first.', true); }
      else {
        for (const select of rows) {
          await api(`/api/tasks/${select.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ owner_id: Number(select.value) }) });
        }
        state.teamWorkspaceData = await api(`/api/teams/${teamId}/workspace`);
        await loadProjectData();
        render();
        toast(`Saved ${rows.length} assignment${rows.length === 1 ? '' : 's'}.`);
      }
    } else if (action === 'teams-back') {
      state.teamsDetail = null;
      render();
    } else if (action === 'add-team-member') {
      openAddTeamMemberDialog(Number(button.dataset.id));
    } else if (action === 'remove-team-member') {
      if (!confirm('Remove this person from the team?')) return;
      await api(`/api/teams/${button.dataset.id}/members/${button.dataset.userId}`, { method: 'DELETE' });
      state.teamWorkspaceData = await api(`/api/teams/${button.dataset.id}/workspace`);
      render();
      toast('Member removed from team.');
    } else if (action === 'open-milestone') {
      openMilestoneDialog(button.dataset.id ? Number(button.dataset.id) : null);
    } else if (action === 'calendar-prev' || action === 'calendar-next') {
      const [year, month] = state.calendarMonth.split('-').map(Number);
      const delta = action === 'calendar-prev' ? -1 : 1;
      const next = new Date(year, month - 1 + delta, 1);
      state.calendarMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
      render();
    } else if (action === 'approve-task') {
      await api(`/api/tasks/${button.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ approved: true, rejected: false }) });
      await loadProjectData(); render(); toast('Task approved.');
    } else if (action === 'reject-task') {
      if (!confirm('Reject this task?')) return;
      await api(`/api/tasks/${button.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ rejected: true }) });
      await loadProjectData(); render(); toast('Task rejected.');
    } else if (action === 'regenerate-task') {
      const result = await api(`/api/tasks/${button.dataset.id}/regenerate`, { method: 'POST', timeoutMs: 60_000 });
      await loadProjectData(); render(); toast(result.fallback_used ? 'Task regenerated with local fallback.' : `Task regenerated with ${result.ai_provider}.`);
    } else if (action === 'approve-suggestion' || action === 'reject-suggestion') {
      await api(`/api/suggestions/${button.dataset.id}/${action.startsWith('approve') ? 'approve' : 'reject'}`, { method: 'POST' });
      await loadProjectData(); render(); toast(`Suggestion ${action.startsWith('approve') ? 'approved' : 'rejected'}.`);
    } else if (action === 'approve-risk') {
      await api(`/api/risks/${button.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ approved: true }) });
      await loadProjectData(); render(); toast('Risk warning approved.');
    } else if (action === 'review-change') {
      await api(`/api/changes/${button.dataset.id}/${button.dataset.review}`, { method: 'POST' });
      await loadProjectData(); render(); toast(`Change ${button.dataset.review}d.`);
    } else if (action === 'download') {
      await downloadExport(button.dataset.format);
    } else if (action === 'approve-invite' || action === 'reject-invite' || action === 'cancel-invite') {
      const endpoint = action === 'approve-invite' ? 'approve' : action === 'reject-invite' ? 'reject' : 'cancel';
      if (action === 'cancel-invite' && !confirm('Cancel this invitation?')) return;
      await api(`/api/invitations/${button.dataset.id}/${endpoint}`, { method: 'POST' });
      await loadWorkspace();
      toast(action === 'approve-invite' ? 'Member access approved.' : action === 'reject-invite' ? 'Invitation rejected.' : 'Invitation cancelled.');
    } else if (action === 'save-member') {
      const id = button.dataset.id;
      const role = $(`[data-member-role="${id}"]`)?.value;
      const department = $(`[data-member-department="${id}"]`)?.value;
      const departmentId = $(`[data-member-department-id="${id}"]`)?.value;
      const managerUserId = $(`[data-member-manager="${id}"]`)?.value;
      const jobRoleId = $(`[data-member-job-role="${id}"]`)?.value;
      const status = $(`[data-member-status="${id}"]`)?.value;
      await api(`/api/memberships/${id}`, { method: 'PATCH', body: JSON.stringify({ role, department, status, department_id: departmentId || null, manager_user_id: managerUserId || null, job_role_id: jobRoleId || null }) });
      await loadWorkspace(); toast('Member access updated.');
    } else if (action === 'remove-member') {
      if (!confirm('Remove this member from the organization?')) return;
      await api(`/api/memberships/${button.dataset.id}`, { method: 'DELETE' });
      await loadWorkspace(); toast('Member removed.');
    }
  } catch (error) { toast(error.message, true); } finally { setButtonBusy(button, false); }
});

document.body.addEventListener('click', event => {
  const themeButton = event.target.closest('[data-theme-toggle]');
  if (themeButton) {
    toggleTheme();
    return;
  }
  const closeButton = event.target.closest('[data-action="close-dialog"]');
  if (closeButton) {
    const overlayToClose = closeButton.closest('.dialog-backdrop');
    if (overlayToClose?._confirmClose && !overlayToClose._confirmClose()) return;
    closeDialog(overlayToClose);
    return;
  }
  if (event.target.classList?.contains('dialog-backdrop')) {
    if (event.target._confirmClose && !event.target._confirmClose()) return;
    closeDialog(event.target);
  }
});

document.addEventListener('error', event => {
  if (event.target.matches?.('.avatar img')) event.target.remove();
}, true);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') heartbeat(true);
});

updateThemeToggleButtons();
updateNetworkStatus();
window.addEventListener('online', () => { updateNetworkStatus(); toast('Connection restored.'); refreshCurrent().catch(() => {}); });
window.addEventListener('offline', updateNetworkStatus);
window.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('mobile-nav-open')) toggleMobileNavigation(false); });

mainContent.addEventListener('input', event => {
  if (['memberSearch', 'memberDepartment', 'memberPresence'].includes(event.target.id)) applyMemberFilters();
});
mainContent.addEventListener('change', event => {
  if (['memberDepartment', 'memberPresence'].includes(event.target.id)) applyMemberFilters();
  if (event.target.matches('[name="status_key"]')) $('#customStatusFields')?.classList.toggle('hidden', event.target.value !== 'custom');
  if (event.target.dataset.taskFilter) {
    state.taskFilters = { ...(state.taskFilters || {}), [event.target.dataset.taskFilter]: event.target.value };
    render();
  }
  if (event.target.id === 'taskSortSelect') {
    state.taskSort = event.target.value;
    render();
  }
  if (event.target.id === 'intakeFileInput') {
    intakeAttachedFile = event.target.files[0] || null;
    render();
  }
});

function getBoardDragAfterElement(container, y) {
  const cards = [...container.querySelectorAll('.board-task-card:not(.dragging)')];
  return cards.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

function getColumnDragAfterElement(container, x) {
  const columns = [...container.querySelectorAll('.kanban-column:not(.column-dragging)')];
  return columns.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = x - box.left - box.width / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

async function persistBoardMove(taskId, sourceColumnId, targetColumnId, orderedIdsInTargetColumn) {
  const targetColumn = state.boardColumns.find(item => Number(item.id) === Number(targetColumnId));
  const task = state.tasks.find(item => Number(item.id) === Number(taskId));
  if (!targetColumn || !task) { render(); return; }
  const previousTasks = state.tasks.map(item => ({ ...item }));
  orderedIdsInTargetColumn.forEach((id, index) => {
    const item = state.tasks.find(t => Number(t.id) === Number(id));
    if (!item) return;
    item.board_position = index;
    item.column_id = Number(targetColumnId);
    if (Number(id) === Number(taskId)) item.status = targetColumn.maps_to_status;
  });
  let sourceOrdered = [];
  if (sourceColumnId && Number(sourceColumnId) !== Number(targetColumnId)) {
    sourceOrdered = state.tasks
      .filter(item => Number(item.column_id) === Number(sourceColumnId) && Number(item.id) !== Number(taskId))
      .sort((a, b) => a.board_position - b.board_position);
    sourceOrdered.forEach((item, index) => { item.board_position = index; });
  }
  render();
  try {
    const requests = orderedIdsInTargetColumn.map((id, index) => {
      const body = Number(id) === Number(taskId) ? { column_id: Number(targetColumnId), board_position: index } : { board_position: index };
      return api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    });
    for (const item of sourceOrdered) requests.push(api(`/api/tasks/${item.id}`, { method: 'PATCH', body: JSON.stringify({ board_position: item.board_position }) }));
    await Promise.all(requests);
  } catch (error) {
    state.tasks = previousTasks;
    render();
    toast("Couldn't move task. Your previous position has been restored.", true);
  }
}

async function persistColumnOrder(orderedIds) {
  const columnMap = new Map(state.boardColumns.map(column => [Number(column.id), column]));
  const reordered = orderedIds.map(id => columnMap.get(Number(id))).filter(Boolean);
  if (!reordered.length) return;
  const previous = state.boardColumns;
  state.boardColumns = reordered.map((column, position) => ({ ...column, position }));
  render();
  try {
    await Promise.all(reordered.map((column, position) => api(`/api/board-columns/${column.id}`, { method: 'PATCH', body: JSON.stringify({ position }) })));
    toast('Column order updated.');
  } catch (error) {
    state.boardColumns = previous;
    render();
    toast(error.message, true);
  }
}

function moveColumnDirection(columnId, direction, overlay) {
  const sorted = [...state.boardColumns].sort((a, b) => a.position - b.position);
  const index = sorted.findIndex(item => Number(item.id) === Number(columnId));
  const swapIndex = index + direction;
  if (index === -1 || swapIndex < 0 || swapIndex >= sorted.length) return;
  const ids = sorted.map(item => item.id);
  [ids[index], ids[swapIndex]] = [ids[swapIndex], ids[index]];
  if (overlay) closeDialog(overlay);
  persistColumnOrder(ids);
}

let draggedBoardTaskId = null;
let draggedBoardTaskSourceColumnId = null;
mainContent.addEventListener('dragstart', event => {
  const card = event.target.closest('[data-drag-board-task]');
  if (!card) return;
  draggedBoardTaskId = Number(card.dataset.dragBoardTask);
  draggedBoardTaskSourceColumnId = Number(card.closest('[data-drop-board-column]')?.dataset.dropBoardColumn) || null;
  event.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
mainContent.addEventListener('dragover', event => {
  if (draggedBoardTaskId === null) return;
  const zone = event.target.closest('[data-drop-board-column]');
  if (!zone) return;
  event.preventDefault();
  const filters = state.taskFilters || {};
  const filterActive = Boolean(filters.story && filters.story !== 'all');
  const targetColumnId = Number(zone.dataset.dropBoardColumn);
  if (filterActive && targetColumnId === draggedBoardTaskSourceColumnId) return;
  mainContent.querySelectorAll('.kanban-column-body.body-drag-over').forEach(el => { if (el !== zone) el.classList.remove('body-drag-over'); });
  zone.classList.add('body-drag-over');
});
mainContent.addEventListener('drop', async event => {
  if (draggedBoardTaskId === null) return;
  const zone = event.target.closest('[data-drop-board-column]');
  if (!zone) return;
  event.preventDefault();
  const targetColumnId = Number(zone.dataset.dropBoardColumn);
  const sourceColumnId = draggedBoardTaskSourceColumnId;
  const taskId = draggedBoardTaskId;
  draggedBoardTaskId = null;
  draggedBoardTaskSourceColumnId = null;
  const filters = state.taskFilters || {};
  const filterActive = Boolean(filters.story && filters.story !== 'all');
  if (filterActive && targetColumnId === sourceColumnId) { render(); return; }
  const existingIds = [...zone.querySelectorAll('[data-drag-board-task]')].map(el => Number(el.dataset.dragBoardTask)).filter(id => id !== taskId);
  const afterElement = getBoardDragAfterElement(zone, event.clientY);
  let insertIndex = existingIds.length;
  if (afterElement) {
    const afterId = Number(afterElement.dataset.dragBoardTask);
    const foundIndex = existingIds.indexOf(afterId);
    if (foundIndex !== -1) insertIndex = foundIndex;
  }
  const orderedIds = [...existingIds];
  orderedIds.splice(insertIndex, 0, taskId);
  await persistBoardMove(taskId, sourceColumnId, targetColumnId, orderedIds);
});
mainContent.addEventListener('dragend', event => {
  mainContent.querySelectorAll('.kanban-column-body.body-drag-over').forEach(el => el.classList.remove('body-drag-over'));
  const card = event.target.closest('[data-drag-board-task]');
  card?.classList.remove('dragging');
  draggedBoardTaskId = null;
  draggedBoardTaskSourceColumnId = null;
});

let draggedColumnId = null;
mainContent.addEventListener('dragstart', event => {
  const handle = event.target.closest('[data-drag-column]');
  if (!handle) return;
  draggedColumnId = Number(handle.dataset.dragColumn);
  event.dataTransfer.effectAllowed = 'move';
  handle.closest('.kanban-column')?.classList.add('column-dragging');
});
mainContent.addEventListener('dragover', event => {
  if (draggedColumnId === null) return;
  const board = event.target.closest('.kanban-board');
  if (!board) return;
  event.preventDefault();
});
mainContent.addEventListener('drop', async event => {
  if (draggedColumnId === null) return;
  const board = event.target.closest('.kanban-board');
  if (!board) return;
  event.preventDefault();
  const columnId = draggedColumnId;
  draggedColumnId = null;
  const existingIds = [...board.querySelectorAll('[data-column-id]')].map(el => Number(el.dataset.columnId)).filter(id => id !== columnId);
  const afterElement = getColumnDragAfterElement(board, event.clientX);
  let insertIndex = existingIds.length;
  if (afterElement) {
    const afterId = Number(afterElement.dataset.columnId);
    const foundIndex = existingIds.indexOf(afterId);
    if (foundIndex !== -1) insertIndex = foundIndex;
  }
  const orderedIds = [...existingIds];
  orderedIds.splice(insertIndex, 0, columnId);
  await persistColumnOrder(orderedIds);
});
mainContent.addEventListener('dragend', event => {
  const col = event.target.closest('.kanban-column');
  col?.classList.remove('column-dragging');
  draggedColumnId = null;
});

let draggedStoryId = null;
mainContent.addEventListener('dragstart', event => {
  const card = event.target.closest('[data-drag-story]');
  if (!card) return;
  draggedStoryId = Number(card.dataset.dragStory);
  event.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
mainContent.addEventListener('dragend', event => {
  event.target.closest('[data-drag-story]')?.classList.remove('dragging');
});
mainContent.addEventListener('dragover', event => {
  if (!event.target.closest('[data-drop-story]')) return;
  event.preventDefault();
});
mainContent.addEventListener('drop', async event => {
  const zone = event.target.closest('[data-drop-story]');
  if (!zone || draggedStoryId === null) return;
  event.preventDefault();
  const targetId = Number(zone.dataset.dropStory);
  const sourceId = draggedStoryId;
  draggedStoryId = null;
  if (targetId === sourceId) return;
  const reordered = [...state.stories];
  const fromIndex = reordered.findIndex(story => Number(story.id) === sourceId);
  const toIndex = reordered.findIndex(story => Number(story.id) === targetId);
  if (fromIndex === -1 || toIndex === -1) return;
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);
  const previous = state.stories;
  state.stories = reordered;
  render();
  try {
    await Promise.all(reordered.map((story, index) => api(`/api/stories/${story.id}`, { method: 'PATCH', body: JSON.stringify({ position: index }) })));
    toast('Story order updated.');
  } catch (error) {
    state.stories = previous;
    render();
    toast(error.message, true);
  }
});
document.body.addEventListener('submit', async event => {
  if (event.target.id !== 'taskForm') return;
  event.preventDefault();
  const form = new FormData(event.target);
  const submitter = event.submitter;
  setButtonBusy(submitter, true);
  const id = Number(form.get('task_id')) || null;
  const columnId = form.get('column_id') ? Number(form.get('column_id')) : undefined;
  const payload = {
    phase: form.get('phase'), title: form.get('title'), description: form.get('description'),
    owner_id: form.get('owner_id') ? Number(form.get('owner_id')) : null,
    priority: form.get('priority'), status: form.get('status') || 'not_started', progress: Number(form.get('progress') || 0),
    acceptance_criteria: form.get('acceptance_criteria'), due_date: form.get('due_date') || null,
    start_date: form.get('start_date') || null,
    milestone_id: form.get('milestone_id') ? Number(form.get('milestone_id')) : null,
    story_id: form.get('story_id') ? Number(form.get('story_id')) : null,
    parent_task_id: form.get('parent_task_id') ? Number(form.get('parent_task_id')) : null,
    dependencies: form.getAll('dependencies').map(Number),
    column_id: columnId
  };
  if (form.has('team_id')) payload.team_id = form.get('team_id') ? Number(form.get('team_id')) : null;
  try {
    if (id) await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    else await api(`/api/projects/${state.projectId}/tasks`, { method: 'POST', body: JSON.stringify(payload) });
    closeDialog($('#taskDialog'));
    await loadProjectData();
    render();
    toast(id ? 'Task updated.' : 'Task created.');
  } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
});

bootstrap();
