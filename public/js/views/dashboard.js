import { state } from '../state.js';
import { escapeHtml, badge, ICONS, canManage, personNameWithStatus, memberForUser } from '../format.js';
import { pageHead } from '../dispatch.js';
import { renderMilestoneList } from './work-breakdown.js';

export const DEFAULT_DASHBOARD_LAYOUT = [
  { key: 'team_work', visible: true },
  { key: 'summary', visible: true },
  { key: 'my_tasks', visible: true },
  { key: 'status_overview', visible: true },
  { key: 'priority_breakdown', visible: true },
  { key: 'assigned_tasks', visible: true },
  { key: 'people', visible: true },
  { key: 'team_workload', visible: true }
];
export const DASHBOARD_WIDGET_LABELS = { team_work: 'Team Work', summary: 'Summary', my_tasks: 'My Tasks', status_overview: 'Status Overview', priority_breakdown: 'Priority Breakdown', assigned_tasks: 'Tasks I’ve Assigned', people: 'People', team_workload: 'Team Workload' };

export function getDashboardLayout() {
  try {
    const parsed = JSON.parse(state.settings?.dashboard_layout || '');
    if (Array.isArray(parsed) && parsed.length) {
      const seen = new Set(parsed.map(item => item.key));
      return [...parsed, ...DEFAULT_DASHBOARD_LAYOUT.filter(item => !seen.has(item.key))];
    }
  } catch { /* fall through to defaults */ }
  return DEFAULT_DASHBOARD_LAYOUT;
}

export function svgDonutChart(segments, size = 118) {
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

export function dashboardWidgetCard(title, contentHtml, headActions = '') {
  return `<section class="card dashboard-widget"><div class="page-head compact-head"><h3>${title}</h3>${headActions}</div>${contentHtml}</section>`;
}

export function getDashboardCollapseState(key) {
  try {
    const stored = localStorage.getItem(`dashboard_collapse_${key}`);
    return stored === null ? true : stored === '1';
  } catch { return true; }
}
export function setDashboardCollapseState(key, collapsed) {
  try { localStorage.setItem(`dashboard_collapse_${key}`, collapsed ? '1' : '0'); } catch { /* ignore */ }
}

export function collapsibleDashboardCard(key, title, collapsedContentHtml, extraContentHtml) {
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

export function dashboardTaskRow(task) {
  return `<button type="button" class="dashboard-task-row" data-action="open-task-cross-project" data-project-id="${task.project_id}" data-id="${task.id}">
    <span class="status-dot status-${escapeHtml(task.status)}"></span>
    <span class="dashboard-task-row-title">${escapeHtml(task.title)}</span>
    <span class="small muted">${escapeHtml(task.project_name || '')}</span>
    <span class="small muted">${escapeHtml(task.due_date || '')}</span>
  </button>`;
}

export function renderDashboardSummaryWidget() {
  const summary = state.orgDashboard?.summary;
  if (!summary) return '';
  return `<div class="grid cols-4">
    <div class="card"><div class="small muted">Completed</div><div class="metric">${summary.completed_7d}</div><div class="small muted">Last 7 days</div></div>
    <div class="card"><div class="small muted">Updated</div><div class="metric">${summary.updated_7d}</div><div class="small muted">Last 7 days</div></div>
    <div class="card"><div class="small muted">Created</div><div class="metric">${summary.created_7d}</div><div class="small muted">Last 7 days</div></div>
    <div class="card"><div class="small muted">Due soon</div><div class="metric">${summary.due_soon_7d}</div><div class="small muted">Next 7 days</div></div>
  </div>`;
}

export function renderDashboardMyTasksWidget() {
  const data = state.orgDashboard?.my_tasks;
  if (!data) return '';
  const activeTab = state.dashboardMyTasksTab;
  const list = data[activeTab] || [];
  const tabs = `<div class="tabbar" style="margin:0 0 10px" role="tablist">${['upcoming', 'overdue', 'completed'].map(key => `<button type="button" role="tab" class="${activeTab === key ? 'active' : ''}" data-action="dashboard-my-tasks-tab" data-tab="${key}">${key[0].toUpperCase()}${key.slice(1)} (${(data[key] || []).length})</button>`).join('')}</div>`;
  return dashboardWidgetCard('My Tasks', `${tabs}<div class="dashboard-task-list">${list.length ? list.map(dashboardTaskRow).join('') : '<div class="empty small">Nothing here.</div>'}</div>`);
}

export function renderDashboardStatusWidget() {
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

export function renderDashboardPriorityWidget() {
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

export function renderDashboardAssignedWidget() {
  const list = state.orgDashboard?.assigned_by_me || [];
  return dashboardWidgetCard('Tasks I’ve Assigned', `<div class="dashboard-task-list">${list.length ? list.map(task => `<button type="button" class="dashboard-task-row" data-action="open-task-cross-project" data-project-id="${task.project_id}" data-id="${task.id}"><span class="dashboard-task-row-title">${escapeHtml(task.title)}</span><span class="small muted">${escapeHtml(task.owner_name || 'Unassigned')}</span>${badge(task.priority)}<span class="small muted">${escapeHtml(task.due_date || '—')}</span></button>`).join('') : '<div class="empty small">You have not assigned any tasks yet.</div>'}</div>`,
    canManage() ? '<button class="secondary" type="button" data-action="open-members">Invite a teammate</button>' : '');
}

export function renderDashboardPeopleWidget() {
  const people = state.orgDashboard?.people || [];
  return dashboardWidgetCard('People', people.length ? people.map(person => `<div class="workload-row"><span>${escapeHtml(person.full_name)}</span><div class="progress"><span style="width:${person.capacity ? Math.min(100, Math.round((person.active_task_count / person.capacity) * 100)) : 0}%"></span></div><span class="small muted">${person.overdue_count} overdue · ${person.completed_count} done</span></div>`).join('') : '<div class="empty small">No team members yet.</div>');
}

export function renderDashboardTeamWorkloadWidget() {
  const people = state.orgDashboard?.people || [];
  return dashboardWidgetCard('Team Workload', people.length ? people.map(person => {
    const percent = person.capacity ? Math.round((person.active_task_count / person.capacity) * 100) : 0;
    return `<div class="workload-row"><span>${escapeHtml(person.full_name)}</span><div class="progress"><span style="width:${Math.min(100, percent)}%;${person.overloaded ? 'background:var(--danger)' : ''}"></span></div><span class="small muted">${percent}%${person.overloaded ? ' · Overloaded' : ''}</span></div>`;
  }).join('') : '<div class="empty small">No team members yet.</div>');
}

export function renderDashboardTeamWorkWidget() {
  const teams = state.orgDashboard?.team_management || [];
  if (!teams.length) return '';
  const rows = teams.map(team => `<div class="milestone-item" style="margin-bottom:8px">
    <div><strong>${escapeHtml(team.team_name)}</strong><div class="small muted">${team.in_progress_count} in progress · ${team.completed_count} completed${team.overdue_count ? ` · <span class="danger">${team.overdue_count} overdue</span>` : ''}</div></div>
    ${team.needs_distribution_count ? `<button type="button" class="primary" data-action="open-distribute-work" data-id="${team.team_id}">Distribute Work (${team.needs_distribution_count})</button>` : '<span class="small muted">Nothing to distribute</span>'}
  </div>`).join('');
  return dashboardWidgetCard('Team Work', rows);
}

export function renderDashboard() {
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
      state.report.blockers.length ? state.report.blockers.map(task => `<div class="notice danger" style="margin-top:9px"><strong>${escapeHtml(task.title)}</strong><div class="small">${badge(task.priority || 'medium')} · ${personNameWithStatus(task.owner_id, task.owner_name || 'Unassigned')}</div></div>`).join('') : '')}
    ${collapsibleDashboardCard('upcoming_milestones', 'Upcoming Milestones',
      upcomingMilestones.length ? `<div><strong>Milestones</strong><div class="small muted">${upcomingMilestones.length} milestone${upcomingMilestones.length === 1 ? '' : 's'} approaching.</div></div>` : '<div class="empty">No upcoming milestones.</div>',
      upcomingMilestones.length ? `<div style="margin-top:9px">${renderMilestoneList(upcomingMilestones)}</div>` : '')}
  </div>
  <section class="card" style="margin-top:16px"><h3>Kanban overview</h3>${renderBoard()}</section>`;
}

export function renderBoard() {
  const statuses = { not_started: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
  return `<div class="board">${Object.entries(statuses).map(([status, label]) => `<div class="board-column"><h3>${label} (${state.tasks.filter(task => task.status === status).length})</h3>${state.tasks.filter(task => task.status === status).map(task => `<div class="task-card"><strong>${escapeHtml(task.title)}</strong><div class="small muted">${personNameWithStatus(task.owner_id, task.owner_name || 'Unassigned')} · ${escapeHtml(task.phase)}</div><div class="progress" style="margin-top:9px"><span style="width:${task.progress}%"></span></div><div class="small" style="margin-top:5px">${task.progress}% ${task.approved ? '' : '· awaiting approval'}</div></div>`).join('') || '<div class="small muted">No tasks</div>'}</div>`).join('')}</div>`;
}
