import { state } from '../state.js';
import { escapeHtml, badge, ICONS } from '../format.js';
import { mountDialog, closeDialog, setButtonBusy, toast } from '../ui.js';
import { api } from '../api.js';
import { intakeState, resetIntakeState } from '../views/intake.js';
import { loadWorkspace } from '../workspace-loader.js';

export function briefSourceBadge(item) {
  const source = item.source === 'brief' ? 'brief' : item.source === 'manual' ? 'manual' : 'inferred';
  const label = source === 'brief' ? '📄 From brief' : source === 'manual' ? '✎ Manual' : '✨ AI inferred';
  return `<span class="source-badge ${source === 'brief' ? 'from-brief' : source}" title="${escapeHtml(item.source_note || '')}">${label}</span>`;
}

export function briefEditedBadge(item) {
  return item._edited ? '<span class="source-badge edited" title="Manually edited after generation">Edited</span>' : '';
}

export function briefTeamBadge(item) {
  if (item.team_name) return `<span class="source-badge from-brief" title="${escapeHtml(item.team_reason || '')}">🏷️ ${escapeHtml(item.team_name)}${item.team_confidence != null ? ` (${item.team_confidence}%)` : ''}</span>`;
  return '<span class="source-badge inferred" title="No team could be confidently matched. Assign one manually or leave unassigned.">🏷️ Unassigned team</span>';
}

export let briefReviewPlan = null;
export let briefReviewSessionId = null;
export let briefReviewRejected = new Set();
export let briefReviewCollapsed = new Set();
export let briefActiveReviewOverlay = null;

export function briefPathParts(path) { return String(path).split(':').map(Number); }
export function briefGetStory(sIndex) { return briefReviewPlan.stories[sIndex]; }
export function briefGetTask(sIndex, tIndex) { return briefReviewPlan.stories[sIndex]?.tasks[tIndex]; }
export function briefGetSubtask(sIndex, tIndex, stIndex) { return briefReviewPlan.stories[sIndex]?.tasks[tIndex]?.subtasks[stIndex]; }

export function blankBriefStory() {
  return { name: 'New story', description: '', department: '', owner_id: null, priority: 'medium', status: 'not_started', start_date: null, due_date: null, source: 'manual', source_note: 'Added manually by a reviewer.', team_name: '', team_confidence: null, team_reason: '', tasks: [] };
}
export function blankBriefTask() {
  return { title: 'New task', description: '', owner_id: null, priority: 'medium', status: 'not_started', start_date: null, due_date: null, tags: [], estimated_hours: null, source: 'manual', source_note: 'Added manually by a reviewer.', team_name: '', team_confidence: null, team_reason: '', subtasks: [] };
}
export function blankBriefSubtask() {
  return { title: 'New subtask', description: '', owner_id: null, priority: 'medium', status: 'not_started', due_date: null, tags: [], estimated_hours: null, source: 'manual', source_note: 'Added manually by a reviewer.', team_name: '', team_confidence: null, team_reason: '' };
}

export function briefOwnerBadge(kind, item) {
  if (!item.owner_id) return '';
  const member = state.members.find(m => Number(m.user_id) === Number(item.owner_id));
  const label = kind === 'story' ? 'Manager' : 'Assignee';
  return `<span class="small muted">${label}: ${escapeHtml(member?.full_name || 'Unknown')}</span>`;
}

export function briefRowMeta(kind, item) {
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

export function briefLeafRow(kind, index, item, label, suffix = '') {
  const key = `${kind}:${index}`;
  return `<label class="brief-review-row"><input type="checkbox" data-brief-check="${key}" ${briefReviewRejected.has(key) ? '' : 'checked'}><input type="text" class="brief-review-name" data-brief-name="${key}" value="${escapeHtml(label)}">${briefSourceBadge(item)}${suffix ? `<span class="small muted">${suffix}</span>` : ''}</label>`;
}

export function renderBriefReviewTree(plan) {
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

export function refreshBriefTree() {
  const tree = briefActiveReviewOverlay?.querySelector('#briefReviewTree');
  if (tree) tree.innerHTML = renderBriefReviewTree(briefReviewPlan);
}

export function briefDescendantCounts(kind, item) {
  if (kind === 'story') {
    const taskCount = item.tasks.length;
    const subtaskCount = item.tasks.reduce((sum, task) => sum + task.subtasks.length, 0);
    return { taskCount, subtaskCount };
  }
  if (kind === 'task') return { subtaskCount: item.subtasks.length };
  return {};
}

export function briefConfirmDelete(kind, item) {
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

export function briefHasManualEdits(kind, item) {
  if (kind === 'story') return item.tasks.some(task => task._edited || task.subtasks.some(subtask => subtask._edited));
  if (kind === 'task') return item.subtasks.some(subtask => subtask._edited);
  return false;
}

export function briefPlanHasAnyManualEdits(plan) {
  return plan.stories.some(story => story._edited || story.tasks.some(task => task._edited || task.subtasks.some(subtask => subtask._edited)));
}

export function briefAllKeys() {
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

export function briefMemberOptions(ownerId) {
  return `<option value="">Unassigned</option>${state.members.filter(member => member.status === 'active').map(member => `<option value="${member.user_id}" ${Number(ownerId) === Number(member.user_id) ? 'selected' : ''}>${escapeHtml(member.full_name)}</option>`).join('')}`;
}

export function briefTeamOptions(teamName) {
  return `<option value="">Unassigned</option>${(state.teams || []).map(team => `<option value="${escapeHtml(team.name)}" ${team.name === teamName ? 'selected' : ''}>${escapeHtml(team.name)}</option>`).join('')}`;
}

export function briefEffectiveTeamName(kind, path) {
  if (kind === 'story') return briefGetStory(Number(path))?.team_name || '';
  if (kind === 'task') {
    const [sIndex, tIndex] = briefPathParts(path);
    return briefGetTask(sIndex, tIndex)?.team_name || briefGetStory(sIndex)?.team_name || '';
  }
  const [sIndex, tIndex, stIndex] = briefPathParts(path);
  return briefGetSubtask(sIndex, tIndex, stIndex)?.team_name || briefGetTask(sIndex, tIndex)?.team_name || briefGetStory(sIndex)?.team_name || '';
}

export async function openBriefAssignPicker(kind, path) {
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

export function openBriefItemEditDialog(kind, path) {
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

export function openBriefMoveDialog(kind, path) {
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

export function openBriefDuplicateDialog(kind, path) {
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

export function openBriefAiEditDialog(path) {
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

export async function briefRegenerateScoped(kind, path, button) {
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

export function wireBriefTreeActions(overlay) {
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

export function openBriefReviewDialog(analysis) {
  briefReviewPlan = JSON.parse(JSON.stringify(analysis.plan));
  briefReviewSessionId = analysis.session_id;
  briefReviewRejected = new Set();
  briefReviewCollapsed = new Set();
  const isNewProjectFlow = Boolean(intakeState.details);
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
    const detailsForCommit = intakeState.details;
    intakeState.details = null;
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
    } catch (error) { intakeState.details = detailsForCommit; toast(error.message, true); } finally { setButtonBusy(button, false); }
  });
}

export function workDistributionSummaryMarkup(result) {
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

export function openWorkDistributionSummaryDialog(result, onContinue) {
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

export function collectBriefReviewPlan() {
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

