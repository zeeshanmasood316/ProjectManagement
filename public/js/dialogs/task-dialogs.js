import { state } from '../state.js';
import { escapeHtml, badge, ICONS, canManage } from '../format.js';
import { mountDialog, closeDialog, setButtonBusy, toast } from '../ui.js';
import { api } from '../api.js';
import { loadProjectData } from '../workspace-loader.js';
import { render } from '../dispatch.js';

export let taskCommentStream = null;

export function taskCommentMarkup(comment) {
  return `<div class="comment-item" data-comment-id="${comment.id}"><div class="comment-meta"><strong>${escapeHtml(comment.full_name)}</strong><small>${escapeHtml(new Date(comment.created_at).toLocaleString())}</small></div><div class="comment-body">${escapeHtml(comment.body)}</div></div>`;
}

export function appendTaskComment(comment) {
  const feed = document.getElementById('taskCommentFeed');
  if (!feed || feed.querySelector(`[data-comment-id="${comment.id}"]`)) return;
  const empty = feed.querySelector('.empty');
  if (empty) empty.remove();
  feed.insertAdjacentHTML('beforeend', taskCommentMarkup(comment));
  feed.scrollTop = feed.scrollHeight;
}

export async function openAssignDialog(task, { onAssigned } = {}) {
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

export async function openTaskDialog(taskId = null, presetColumnId = null) {
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
    <label>Assigned To<select name="owner_id">${ownerOptions}</select></label>
    ${teamField}
    ${task?.team_name ? `<div class="small muted full">Manager: ${escapeHtml(task.team_manager_name || 'Not assigned')}</div>` : ''}
    <label>Priority<select name="priority">${['low', 'medium', 'high', 'critical'].map(value => `<option value="${value}" ${task?.priority === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
    <label>Status<select name="status" ${presetColumn ? 'disabled' : ''}>${['not_started', 'in_progress', 'blocked', 'done'].map(value => `<option value="${value}" ${(task?.status || presetColumn?.maps_to_status) === value ? 'selected' : ''}>${value.replaceAll('_', ' ')}</option>`).join('')}</select>${presetColumn ? `<small class="field-help">Set by the “${escapeHtml(presetColumn.name)}” column.</small>` : ''}</label>
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

export function openProjectEditDialog() {
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

export function openStoryDialog(storyId = null) {
  const story = state.stories.find(item => Number(item.id) === Number(storyId));
  const ownerOptions = `<option value="">Unassigned</option>${state.members.filter(member => member.status === 'active').map(member => `<option value="${member.user_id}" ${Number(story?.owner_id) === Number(member.user_id) ? 'selected' : ''}>${escapeHtml(member.full_name)}</option>`).join('')}`;
  const departmentOptions = `<option value="">None</option>${(state.departments || []).map(department => `<option value="${department.id}" ${Number(story?.department_id) === Number(department.id) ? 'selected' : ''}>${escapeHtml(department.name)}</option>`).join('')}`;
  const teamOptions = `<option value="">Unassigned</option>${(state.teams || []).map(team => `<option value="${team.id}" ${Number(story?.team_id) === Number(team.id) ? 'selected' : ''}>${escapeHtml(team.name)}</option>`).join('')}`;
  const teamField = canManage()
    ? `<label>Team<select name="team_id">${teamOptions}</select></label>`
    : `<label>Team<input value="${escapeHtml(story?.team_name || 'Unassigned')}" disabled></label>`;
  const overlay = document.createElement('div');
  overlay.id = 'storyDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="storyForm" class="dialog-card form-grid"><div class="dialog-head full"><h2 id="storyDialogTitle">${story ? 'Edit story' : 'Add story'}</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <label class="full">Name<input name="name" autofocus required value="${escapeHtml(story?.name || '')}"></label>
    <label class="full">Description<textarea name="description">${escapeHtml(story?.description || '')}</textarea></label>
    <label>Assigned To<select name="owner_id">${ownerOptions}</select></label>
    <label>Department<select name="department_id">${departmentOptions}</select></label>
    ${teamField}
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
    if (canManage()) payload.team_id = form.get('team_id') || null;
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
