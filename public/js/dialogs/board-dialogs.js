import { state } from '../state.js';
import { escapeHtml, ICONS } from '../format.js';
import { mountDialog, closeDialog, setButtonBusy, toast } from '../ui.js';
import { api } from '../api.js';
import { loadProjectData } from '../workspace-loader.js';
import { render } from '../dispatch.js';
import { moveColumnDirection } from '../dnd.js';

export function openMilestoneDialog(milestoneId = null) {
  const milestone = state.milestones.find(item => Number(item.id) === Number(milestoneId));
  const ownerOptions = `<option value="">Unassigned</option>${state.members.filter(member => member.status === 'active').map(member => `<option value="${member.user_id}" ${Number(milestone?.owner_id) === Number(member.user_id) ? 'selected' : ''}>${escapeHtml(member.full_name)}</option>`).join('')}`;
  const overlay = document.createElement('div');
  overlay.id = 'milestoneDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="milestoneForm" class="dialog-card form-grid"><div class="dialog-head full"><h2 id="milestoneDialogTitle">${milestone ? 'Edit milestone' : 'Add milestone'}</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <label class="full">Name<input name="name" autofocus required value="${escapeHtml(milestone?.name || '')}"></label>
    <label class="full">Description<textarea name="description">${escapeHtml(milestone?.description || '')}</textarea></label>
    <label>Due date<input name="due_date" type="date" value="${escapeHtml(milestone?.due_date || '')}"></label>
    <label>Assigned To<select name="owner_id">${ownerOptions}</select></label>
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

export function openAddColumnDialog() {
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

export function openColumnOptionsDialog(columnId) {
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

export function openDeleteColumnDialog(columnId) {
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

