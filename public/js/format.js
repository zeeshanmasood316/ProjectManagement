import { state } from './state.js';

export const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
export const badge = value => `<span class="badge ${escapeHtml(value)}">${escapeHtml(String(value || '').replaceAll('_', ' '))}</span>`;
export const initials = name => String(name || 'U').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
export const presenceLabel = status => ({ online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Offline' }[status] || 'Offline');
export const statusPresets = {
  available: { label: 'Available', emoji: '🟢' }, busy: { label: 'Busy', emoji: '🔴' },
  on_leave: { label: 'On Leave', emoji: '🏖️' }, remote: { label: 'Remote', emoji: '🏠' },
  in_meeting: { label: 'In a Meeting', emoji: '🟡' }, focus: { label: 'Focus Time', emoji: '🎯' },
  travelling: { label: 'Travelling', emoji: '✈️' }, custom: { label: 'Custom', emoji: '💬' }
};
export const roleIsManager = role => ['ceo', 'admin', 'moderator'].includes(role);
export const roleCanApproveMembers = role => ['ceo', 'admin'].includes(role);
export const currentRole = () => state.organization?.membership?.role || '';
export const canManage = () => roleIsManager(currentRole());
// "Manager" here is the business-level tier from the RBAC spec: a plain member who leads a team
// or manages a department — distinct from the ceo/admin/moderator org role tier above (canManage()).
// Full-access roles are never counted as this tier (they already see everything via canManage()).
export const isTeamLeadOrDeptManager = () => {
  if (canManage()) return false;
  const userId = state.user?.id;
  const leadsTeam = (state.teams || []).some(team => Number(team.lead_user_id) === Number(userId));
  const managesDept = (state.departments || []).some(dept => Number(dept.manager_user_id) === Number(userId));
  return leadsTeam || managesDept;
};
export const isWorkerTier = () => !canManage() && !isTeamLeadOrDeptManager();

export const ICONS = {
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

export function statusMarkup(person, compact = false) {
  const key = person?.status_key || 'available';
  const preset = statusPresets[key] || statusPresets.available;
  const emoji = person?.status_emoji || preset.emoji;
  const label = person?.status_label || preset.label;
  return `<span class="workspace-status ${escapeHtml(key)} ${compact ? 'compact' : ''}" title="${escapeHtml(person?.custom_status || label)}"><span>${escapeHtml(emoji)}</span>${compact ? '' : `<b>${escapeHtml(label)}</b>`}</span>`;
}

export function memberForUser(userId) {
  return state.members.find(member => Number(member.user_id) === Number(userId));
}

export function notificationIcon(type) {
  return ({ invitation: ICONS.mail, mention: ICONS.atSign, activity: ICONS.history, workspace: ICONS.bell, team_work: ICONS.userPlus, task_assignment: ICONS.userPlus }[type] || ICONS.bell);
}

export function personNameWithStatus(userId, fallbackName) {
  const member = memberForUser(userId);
  return `<span class="name-with-inline-status"><span>${escapeHtml(fallbackName || 'Unassigned')}</span>${member ? statusMarkup(member, true) : ''}</span>`;
}

export function avatarMarkup(person, className = '') {
  const image = person?.avatar_url ? `<img src="${escapeHtml(person.avatar_url)}" alt="" loading="lazy">` : '';
  return `<div class="avatar member-avatar ${escapeHtml(className)}">${image}<span>${escapeHtml(initials(person?.full_name))}</span><i class="presence-dot ${escapeHtml(person?.current_status || 'offline')}" aria-label="${escapeHtml(presenceLabel(person?.current_status))}"></i></div>`;
}

export function relativeTime(value) {
  if (!value) return 'Never active';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return String(value);
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'Active just now';
  if (seconds < 3600) return `Active ${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `Active ${Math.floor(seconds / 3600)}h ago`;
  return `Active ${Math.floor(seconds / 86400)}d ago`;
}

export function sessionDevice(userAgent = '') {
  const value = String(userAgent);
  const browser = /Edg\//.test(value) ? 'Microsoft Edge' : /Chrome\//.test(value) ? 'Chrome' : /Firefox\//.test(value) ? 'Firefox' : /Safari\//.test(value) ? 'Safari' : 'Browser';
  const platform = /Windows/i.test(value) ? 'Windows' : /Android/i.test(value) ? 'Android' : /iPhone|iPad/i.test(value) ? 'iOS' : /Mac OS/i.test(value) ? 'macOS' : /Linux/i.test(value) ? 'Linux' : 'Unknown device';
  return `${browser} on ${platform}`;
}

export function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
