import { state, $, $$ } from '../state.js';
import { escapeHtml, badge, avatarMarkup, statusMarkup, presenceLabel, relativeTime, currentRole, roleCanApproveMembers, canManage } from '../format.js';
import { pageHead } from '../dispatch.js';

export function renderMembers() {
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

export function applyMemberFilters() {
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

export function roleOptions(member) {
  const actorRole = currentRole();
  const roles = actorRole === 'ceo' ? ['admin', 'moderator', 'member'] : ['moderator', 'member'];
  return roles.map(role => `<option value="${role}" ${member.role === role ? 'selected' : ''}>${role}</option>`).join('');
}

export function renderMemberRow(member) {
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
