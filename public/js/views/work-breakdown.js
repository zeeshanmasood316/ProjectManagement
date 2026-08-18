import { state } from '../state.js';
import { escapeHtml, badge, ICONS, canManage, personNameWithStatus, memberForUser } from '../format.js';
import { pageHead, noProject } from '../dispatch.js';

export const PROJECT_TABS = [['overview', 'Overview'], ['list', 'List'], ['board', 'Board'], ['calendar', 'Calendar'], ['timeline', 'Timeline']];

export function projectTabBar() {
  return `<div class="tabbar" role="tablist" aria-label="Project views">${PROJECT_TABS.map(([key, label]) => `<button type="button" role="tab" aria-selected="${state.projectTab === key}" class="${state.projectTab === key ? 'active' : ''}" data-action="set-project-tab" data-tab="${key}">${label}</button>`).join('')}</div>`;
}

export function renderMilestoneList(milestones) {
  if (!milestones.length) return '<div class="empty small">No milestones yet.</div>';
  const tag = canManage() ? 'button' : 'div';
  const attrs = canManage() ? 'type="button" data-action="open-milestone"' : '';
  return `<div class="milestone-list">${milestones.map(item => `<${tag} class="milestone-item" ${attrs} data-id="${item.id}"><div><strong>${escapeHtml(item.name)}</strong><div class="small muted">${item.due_date ? escapeHtml(item.due_date) : 'No date'} · ${item.done_task_count || 0}/${item.task_count || 0} tasks</div></div>${badge(item.status)}</${tag}>`).join('')}</div>`;
}

export function renderProjectOverview() {
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

export function renderStoryList() {
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
      ${story.team_name ? `<div class="small muted">🏷️ ${escapeHtml(story.team_name)}</div>` : ''}
      <div class="progress" style="margin-top:8px"><span style="width:${percent}%"></span></div>
      <div class="small muted" style="margin-top:4px">${done}/${total} tasks done</div>
    </div>`;
  }).join('')}</div>`;
}

export function nestedTaskOrder(tasks) {
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

export function filteredSortedTasks() {
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
    title: (a, b) => a.title.localeCompare(b.title),
    phase: (a, b) => a.phase.localeCompare(b.phase) || a.id - b.id
  };
  return [...tasks].sort(sorters[state.taskSort] || sorters.phase);
}

export function groupOrderedTasksByStory(ordered) {
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

export function taskRowMarkup(task, depth) {
  return `<tr class="${depth ? 'subtask-row' : ''}"><td style="padding-left:${12 + depth * 20}px">${depth ? '↳ ' : ''}<strong>${escapeHtml(task.title)}</strong><br><span class="small muted">${escapeHtml(task.phase)}${task.dependencies?.length ? ` · blocked by ${task.dependencies.length}` : ''}</span></td><td>${personNameWithStatus(task.owner_id, task.owner_name || 'Unassigned')}</td><td>${badge(task.priority)}</td><td>${badge(task.status)}</td><td>${escapeHtml(task.due_date || '—')}</td><td>${task.approved ? badge('approved') : badge('pending')}</td><td><div class="actions"><button class="icon-action" type="button" data-action="open-task" data-id="${task.id}" aria-label="Edit task" data-tooltip="Edit task">${ICONS.pencil}</button>${canManage() && !task.approved ? `<button class="primary" data-action="approve-task" data-id="${task.id}">Approve</button>` : ''}${canManage() ? `<button class="secondary" data-action="regenerate-task" data-id="${task.id}">Regenerate</button><button class="danger" data-action="reject-task" data-id="${task.id}">Reject</button>` : ''}</div></td></tr>`;
}

export function renderTaskList() {
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
    <select id="taskSortSelect">${[['phase', 'Sort: Phase'], ['due_date', 'Sort: Due date'], ['priority', 'Sort: Priority'], ['title', 'Sort: Title']].map(([value, label]) => `<option value="${value}" ${state.taskSort === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
    ${canManage() ? '<button class="secondary" type="button" data-action="open-story">+ Add Story</button>' : ''}
  </div>`;
  if (!storyGroups.length) return `${filterBar}<div class="card empty">No tasks match these filters.</div>`;
  const tables = storyGroups.map(({ story, rows }) => {
    const done = rows.filter(item => item.depth === 0 && item.task.status === 'done').length;
    const total = rows.filter(item => item.depth === 0).length;
    const heading = story
      ? `<div class="story-group-head"><h3>${escapeHtml(story.name)}</h3>${badge(story.status)}<span class="small muted">${done}/${total} done</span><button class="text-link" type="button" data-action="open-story" data-id="${story.id}">Edit story</button></div>`
      : `<div class="story-group-head"><h3>No story</h3><span class="small muted">${total} task${total === 1 ? '' : 's'}</span></div>`;
    return `${heading}<section class="card table-wrap"><table><thead><tr><th>Task</th><th>Assigned To</th><th>Priority</th><th>Status</th><th>Due</th><th>Approval</th><th>Actions</th></tr></thead><tbody>
      ${rows.map(({ task, depth }) => taskRowMarkup(task, depth)).join('')}
    </tbody></table></section>`;
  }).join('');
  return `${filterBar}${tables}`;
}

export function tasksForStoryFilter(tasks) {
  const filters = state.taskFilters || {};
  if (!filters.story || filters.story === 'all') return tasks;
  return tasks.filter(task => String(task.story_id || 'none') === filters.story);
}

export function storyFilterBar() {
  const filters = state.taskFilters || {};
  return `<div class="task-filter-bar"><select data-task-filter="story"><option value="all">All stories</option><option value="none" ${filters.story === 'none' ? 'selected' : ''}>No story</option>${state.stories.map(story => `<option value="${story.id}" ${filters.story === String(story.id) ? 'selected' : ''}>${escapeHtml(story.name)}</option>`).join('')}</select></div>`;
}

export function boardTaskCardMarkup(task, storyMap) {
  const subtasks = state.tasks.filter(item => Number(item.parent_task_id) === Number(task.id) && !item.rejected);
  const doneSubtasks = subtasks.filter(item => item.status === 'done').length;
  const story = task.story_id ? storyMap.get(String(task.story_id)) : null;
  return `<div class="board-task-card" draggable="true" data-drag-board-task="${task.id}" data-action="open-task" data-id="${task.id}" role="button" tabindex="0" aria-label="Open ${escapeHtml(task.title)}">
    <span class="board-task-card-title">${escapeHtml(task.title)}</span>
    ${story ? `<div class="board-task-card-story">${escapeHtml(story.name)}</div>` : ''}
    ${subtasks.length ? `<div class="small muted">${doneSubtasks} / ${subtasks.length} subtasks</div>` : ''}
    ${task.team_name ? `<div class="small muted">🏷️ ${escapeHtml(task.team_name)}</div>` : ''}
    <div class="board-task-card-meta">${badge(task.priority)}<span class="small muted">${personNameWithStatus(task.owner_id, task.owner_name || 'Unassigned')}</span>${task.due_date ? `<span class="small muted">Due ${escapeHtml(task.due_date)}</span>` : ''}<button type="button" class="icon-action" data-action="quick-assign-task" data-id="${task.id}" aria-label="Assign task" data-tooltip="Assign">${ICONS.userPlus}</button></div>
  </div>`;
}

export function renderTaskBoard() {
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

export function renderTaskCalendar() {
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

export function renderTaskTimeline() {
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
      const dateRange = task.start_date && task.due_date ? `${task.start_date} → ${task.due_date}` : (task.due_date ? `Due ${task.due_date}` : `Starts ${task.start_date}`);
      const assignee = task.owner_name || 'Unassigned';
      const statusLabel = task.status.replaceAll('_', ' ');
      return `<div class="timeline-row"><div class="timeline-row-label"><div>${escapeHtml(task.title)}${dependencyNames.length ? ` <span class="small muted" title="Blocked by: ${escapeHtml(dependencyNames.join(', '))}">(blocked by ${dependencyNames.length})</span>` : ''}</div><div class="small muted">${personNameWithStatus(task.owner_id, assignee)}</div></div><div class="timeline-track"><div class="timeline-bar status-${escapeHtml(task.status)}" style="left:${left}%;width:${width}%" data-action="open-task" data-id="${task.id}" role="button" tabindex="0" aria-label="${escapeHtml(task.title)}, assigned to ${escapeHtml(assignee)}, ${escapeHtml(statusLabel)}, ${escapeHtml(dateRange)}" title="${escapeHtml(dateRange)}"></div></div></div>`;
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

export function renderWork() {
  if (!state.project) return noProject();
  const actions = `${canManage() ? '<button class="primary" data-action="generate-plan">Generate AI plan</button>' : ''}<button class="secondary" data-action="open-task">Add task</button>`;
  const tabRenderers = { overview: renderProjectOverview, list: renderTaskList, board: renderTaskBoard, calendar: renderTaskCalendar, timeline: renderTaskTimeline };
  const activeTab = tabRenderers[state.projectTab] ? state.projectTab : 'overview';
  return `${pageHead(escapeHtml(state.project.name), 'Create, assign, update, approve, reject, or regenerate project tasks.', actions)}
  <div class="notice warning"><strong>Human control:</strong> AI-generated tasks remain pending until a CEO, admin, or moderator approves or edits them.</div>
  ${projectTabBar()}
  <div style="margin-top:16px">${tabRenderers[activeTab]()}</div>`;
}

export function renderMeeting() {
  if (!state.project) return noProject();
  if (!canManage()) return '<div class="notice danger">Only CEO, admin, or moderator can process meeting notes.</div>';
  const pending = state.suggestions.filter(item => item.status === 'pending');
  return `${pageHead('Meeting notes', 'Convert explicit actions, decisions, and blockers into approval-ready proposals.')}
  <form id="meetingForm" class="card stack"><label>Meeting notes<textarea name="notes" required placeholder="Paste meeting notes. Explicit wording produces better proposals."></textarea></label><div class="actions"><button class="primary" type="submit">Create proposals</button></div></form>
  <section style="margin-top:16px"><h3>Pending proposals</h3>${pending.map(item => `<div class="card" style="margin-bottom:10px"><div class="actions" style="justify-content:space-between"><div>${badge(item.suggestion_type)} ${badge(item.status)}</div><div><button class="primary" data-action="approve-suggestion" data-id="${item.id}">Approve</button><button class="danger" data-action="reject-suggestion" data-id="${item.id}">Reject</button></div></div><p>${escapeHtml(item.evidence)}</p><div class="small muted">${escapeHtml(item.rationale)}</div></div>`).join('') || '<div class="empty">No meeting-note proposals await review.</div>'}</section>`;
}

export function renderRisks() {
  if (!state.project) return noProject();
  return `${pageHead('Risks & decisions', 'Evidence-based warnings and approved project decisions.', canManage() ? '<button class="primary" data-action="scan-risks">Run risk scan</button>' : '')}
  <div class="grid cols-2"><section><h3>Risk register</h3>${state.risks.map(risk => `<div class="card" style="margin-bottom:10px"><div class="actions">${badge(risk.severity)} ${badge(risk.status)} ${risk.approved ? badge('approved') : badge('pending')}</div><h3 style="margin-top:10px">${escapeHtml(risk.title)}</h3><p>${escapeHtml(risk.description)}</p><div class="notice"><strong>Evidence:</strong> ${escapeHtml(risk.evidence || 'No evidence recorded')}</div>${canManage() && !risk.approved ? `<button class="primary" data-action="approve-risk" data-id="${risk.id}">Approve warning</button>` : ''}</div>`).join('') || '<div class="empty">No risks stored. Run the scan.</div>'}</section>
  <section><h3>Decision history</h3>${state.decisions.map(decision => `<div class="card" style="margin-bottom:10px"><div>${badge(decision.status)} <span class="small muted">${escapeHtml(decision.source)}</span></div><h3 style="margin-top:10px">${escapeHtml(decision.title)}</h3><p>${escapeHtml(decision.detail)}</p><div class="small muted">Owner: ${escapeHtml(decision.owner || 'Not recorded')} · ${escapeHtml(decision.created_at)}</div></div>`).join('') || '<div class="empty">No approved decisions stored.</div>'}</section></div>`;
}

export function renderChanges() {
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

export function renderReport() {
  if (!state.project || !state.report) return noProject();
  return `${pageHead('Reports & export', 'Factual project reporting assembled only from stored records.', '<button class="primary" data-action="download" data-format="json">Export JSON</button><button class="secondary" data-action="download" data-format="csv">Export CSV</button>')}
  <div class="notice">${escapeHtml(state.report.reliability_note)}</div><pre class="report">${escapeHtml(JSON.stringify(state.report, null, 2))}</pre>`;
}

