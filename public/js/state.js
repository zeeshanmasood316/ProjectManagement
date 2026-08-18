export const state = {
  token: localStorage.getItem('orbit_token') || '',
  user: null,
  presence: null,
  settings: null,
  notifications: [],
  activity: [],
  sessions: [],
  unreadNotificationCount: 0,
  // Separate from unreadNotificationCount on purpose — messages never appear in the general
  // Notifications list (Phase 3, item 11/19), so they get their own counter + badge.
  unreadMessageCount: 0,
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

export const $ = selector => document.querySelector(selector);
export const $$ = selector => [...document.querySelectorAll(selector)];
export const authScreen = $('#authScreen');
export const setupScreen = $('#setupScreen');
export const appShell = $('#appShell');
export const mainContent = $('#mainContent');
export const organizationSelect = $('#organizationSelect');
export const mobileOrganizationSelect = $('#mobileOrganizationSelect');
export const projectSelect = $('#projectSelect');
export const presenceSelect = $('#presenceSelect');
export const mobileNavToggle = $('#mobileNavToggle');
export const sidebarBackdrop = $('#sidebarBackdrop');
