import { state } from '../state.js';
import { escapeHtml, ICONS } from '../format.js';
import { mountDialog, closeDialog, setButtonBusy, toast } from '../ui.js';
import { api } from '../api.js';
import { loadWorkspace } from '../workspace-loader.js';

export function openDepartmentDialog(departmentId = null) {
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

export function openTeamDialog(teamId = null, defaultDepartmentId = null) {
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

export function openAddTeamMemberDialog(teamId) {
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

export function openOrganizationDialog() {
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
