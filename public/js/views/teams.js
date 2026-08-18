import { state } from '../state.js';
import { escapeHtml, badge, ICONS, canManage, roleCanApproveMembers, currentRole } from '../format.js';
import { pageHead } from '../dispatch.js';
import { renderMemberRow } from './members.js';

export function renderTeamsHub() {
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

export function renderDepartmentDetail(departmentId) {
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

export function renderTeamDetail(teamId) {
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

export function distributeWorkerOptions(members, ownerId) {
  return `<option value="">Unassigned</option>${members.map(person => `<option value="${person.user_id}" ${Number(ownerId) === Number(person.user_id) ? 'selected' : ''}>${escapeHtml(person.full_name)}</option>`).join('')}`;
}

export function distributeTaskRow(item, members, isSubtask) {
  return `<tr data-distribute-row data-id="${item.id}">
    <td><input type="checkbox" data-distribute-check value="${item.id}"></td>
    <td>${isSubtask ? '↳ ' : ''}${escapeHtml(item.title)}${isSubtask && item.parent_task_title ? `<div class="small muted">Subtask of ${escapeHtml(item.parent_task_title)}</div>` : ''}</td>
    <td>${badge(item.priority)}</td>
    <td>${escapeHtml(item.due_date || '—')}</td>
    <td><select data-distribute-owner data-id="${item.id}">${distributeWorkerOptions(members, item.owner_id)}</select></td>
  </tr>`;
}

export function renderDistributeWork(teamId) {
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

export function renderAdmin() {
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
