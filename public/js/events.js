import { state, $, mainContent } from './state.js';
import { canManage, ICONS } from './format.js';
import { api } from './api.js';
import { toast, setButtonBusy, closeDialog, openAiSuggestionDialog, openGeneratePlanDialog, toggleTheme } from './ui.js';
import { logout } from './auth-screens.js';
import { heartbeat } from './presence.js';
import { loadMessages, connectMessageStream, disconnectDmStream, receiveMessage, receiveDirectMessage, openConversation, markChannelRead, refreshUnreadMessageCount, openThreadDialog } from './messaging.js';
import { loadWorkspace, loadProjectData, downloadExport } from './workspace-loader.js';
import { render, updateShell, viewTitles } from './dispatch.js';
import { switchProject } from './navigation.js';
import { intakeState, resetIntakeState } from './views/intake.js';
import { getDashboardCollapseState, setDashboardCollapseState } from './views/dashboard.js';
import { openTaskDialog, openAssignDialog, openProjectEditDialog, openDeleteProjectDialog, openStoryDialog } from './dialogs/task-dialogs.js';
import { updateBriefProgress, openBriefAnalyzerDialog } from './ai-brief/analyzer.js';
import { openBriefReviewDialog } from './ai-brief/review.js';
import { openDepartmentDialog, openTeamDialog, openAddTeamMemberDialog, openOrganizationDialog } from './dialogs/org-team-dialogs.js';
import { openCustomizeDashboardDialog, openNewDmDialog } from './dialogs/misc-dialogs.js';
import { openMilestoneDialog, openAddColumnDialog, openColumnOptionsDialog } from './dialogs/board-dialogs.js';
import { applyMemberFilters } from './views/members.js';

mainContent.addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.target;
  const form = new FormData(formElement);
  const submitter = event.submitter;
  setButtonBusy(submitter, true);
  try {
    if (formElement.id === 'channelForm') {
      const channel = await api(`/api/organizations/${state.organizationId}/channels`, { method: 'POST', body: JSON.stringify({ name: form.get('name'), topic: form.get('topic') }) });
      state.channelId = Number(channel.id);
      await loadWorkspace();
      toast('Channel created.');
    } else if (formElement.id === 'messageForm') {
      const created = await api(`/api/channels/${state.channelId}/messages`, { method: 'POST', body: JSON.stringify({ body: form.get('body') }) });
      formElement.reset();
      receiveMessage(created);
    } else if (formElement.id === 'directMessageForm') {
      const created = await api(`/api/direct-conversations/${state.activeConversationId}/messages`, { method: 'POST', body: JSON.stringify({ body: form.get('body') }) });
      formElement.reset();
      receiveDirectMessage(created);
    } else if (formElement.id === 'intakeBriefForm') {
      const rawText = String(form.get('raw_text') || '').trim();
      if (!intakeState.attachedFile && !rawText) throw new Error('Describe the project or attach a brief file.');
      const progressWrap = formElement.querySelector('#intakeProgressWrap');
      const progressSteps = formElement.querySelector('#intakeProgressSteps');
      let sessionResult;
      if (intakeState.attachedFile) {
        const uploadBody = new FormData();
        uploadBody.append('file', intakeState.attachedFile);
        sessionResult = await api(`/api/organizations/${state.organizationId}/client-briefs/upload`, { method: 'POST', body: uploadBody, timeoutMs: 60_000 });
      } else {
        sessionResult = await api(`/api/organizations/${state.organizationId}/client-briefs`, { method: 'POST', body: JSON.stringify({ raw_text: rawText }) });
      }
      intakeState.sessionId = sessionResult.session_id;
      intakeState.guessed = { clientName: sessionResult.client_name || '', projectName: sessionResult.project_name || '' };
      progressWrap.hidden = false;
      let source = null;
      try {
        const token = crypto.randomUUID();
        source = new EventSource(`/api/brief-analysis/progress?token=${encodeURIComponent(token)}`);
        source.onmessage = messageEvent => {
          try { const payload = JSON.parse(messageEvent.data); updateBriefProgress(progressSteps, payload.step, payload.detail); } catch {}
        };
        await new Promise(resolve => { source.onopen = resolve; setTimeout(resolve, 600); });
        intakeState.analysis = await api(`/api/client-briefs/${intakeState.sessionId}/analyze`, { method: 'POST', timeoutMs: 120_000, body: JSON.stringify({ stream_token: token }) });
      } finally {
        source?.close();
      }
      if (intakeState.analysis.project_fields) {
        const extracted = intakeState.analysis.project_fields;
        intakeState.guessed = { projectName: extracted.name || intakeState.guessed.projectName, clientName: extracted.client_name || intakeState.guessed.clientName };
        intakeState.extractedFields = extracted;
      }
      intakeState.step = 'details';
      render();
      toast(intakeState.analysis.fallback_used ? 'Brief analyzed with local fallback.' : `Brief analyzed with ${intakeState.analysis.ai_provider}.`);
    } else if (formElement.id === 'intakeDetailsForm') {
      intakeState.details = {
        project_name: form.get('name'), client_name: form.get('client_name'), objective: form.get('objective'),
        scope: form.get('scope'), constraints: form.get('constraints'), owner_id: form.get('owner_id') || null,
        priority: form.get('priority'), start_date: form.get('start_date') || null, due_date: form.get('due_date') || null
      };
      openBriefReviewDialog(intakeState.analysis);
    } else if (formElement.id === 'meetingForm') {
      const result = await api(`/api/projects/${state.projectId}/meeting-notes`, { method: 'POST', timeoutMs: 60_000, body: JSON.stringify({ notes: form.get('notes') }) });
      await loadProjectData();
      render();
      toast(result.fallback_used ? 'Meeting proposals created with local fallback.' : `AI analyzed meeting notes with ${result.ai_provider}.`);
    } else if (formElement.id === 'changeForm') {
      const result = await api(`/api/projects/${state.projectId}/changes`, { method: 'POST', timeoutMs: 60_000, body: JSON.stringify({ title: form.get('title'), description: form.get('description'), requested_by: form.get('requested_by') }) });
      await loadProjectData();
      render();
      toast(result.fallback_used ? 'Change analyzed with local fallback.' : `AI change analysis completed with ${result.ai_provider}.`);
    } else if (formElement.id === 'profilePageForm') {
      state.user = await api('/api/users/me/profile', { method: 'PATCH', body: JSON.stringify({ full_name: form.get('full_name'), avatar_url: form.get('avatar_url') }) });
      state.members = await api(`/api/organizations/${state.organizationId}/members`);
      updateShell();
      render();
      toast('Profile updated.');
    } else if (formElement.id === 'statusPageForm') {
      const statusKey = form.get('status_key');
      state.presence = await api('/api/presence/me', { method: 'PATCH', body: JSON.stringify({ status_key: statusKey, status_label: form.get('status_label'), status_emoji: form.get('status_emoji'), custom_status: form.get('custom_status') }) });
      state.members = await api(`/api/organizations/${state.organizationId}/members`);
      updateShell();
      render();
      toast(`Status updated to ${state.presence.status_emoji} ${state.presence.status_label}.`);
    } else if (formElement.id === 'settingsForm') {
      state.settings = await api('/api/users/me/settings', { method: 'PATCH', body: JSON.stringify({
        theme: form.get('theme'),
        workspace_notifications: formElement.elements.workspace_notifications.checked,
        mention_notifications: formElement.elements.mention_notifications.checked,
        invitation_notifications: formElement.elements.invitation_notifications.checked,
        activity_notifications: formElement.elements.activity_notifications.checked
      }) });
      state.presence = await api('/api/presence/me', { method: 'PATCH', body: JSON.stringify({ presence_mode: form.get('presence_mode') }) });
      applyTheme(state.settings.theme);
      state.members = await api(`/api/organizations/${state.organizationId}/members`);
      updateShell();
      render();
      toast('Settings saved.');
    } else if (formElement.id === 'inviteForm') {
      await api(`/api/organizations/${state.organizationId}/invitations`, { method: 'POST', body: JSON.stringify({ identifier: form.get('identifier'), proposed_role: form.get('proposed_role'), proposed_department: form.get('proposed_department') }) });
      formElement.reset();
      await loadWorkspace();
      toast('Invitation sent to the registered user.');
    }
  } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
});

mainContent.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target.closest('[role="button"][data-action]');
  if (!target) return;
  event.preventDefault();
  target.click();
});

mainContent.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  setButtonBusy(button, true);
  try {
    if (action === 'ai-assist-field') {
      const field = document.getElementById(button.dataset.targetId);
      if (field) await openAiSuggestionDialog(field);
    } else if (action === 'retry-workspace') {
      await loadWorkspace();
      toast('Workspace loaded.');
    } else if (action === 'retry-render') {
      render();
    } else if (action === 'revoke-other-sessions') {
      const result = await api('/api/users/me/sessions/revoke-others', { method: 'POST' });
      state.sessions = await api('/api/users/me/sessions');
      render();
      toast(`${result.revoked_count} other session(s) signed out.`);
    } else if (action === 'revoke-session') {
      const result = await api(`/api/users/me/sessions/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' });
      if (result.current) { logout(); return; }
      state.sessions = await api('/api/users/me/sessions');
      render();
      toast('Session revoked.');
    } else if (action === 'open-admin') {
      state.view = 'admin'; render();
    } else if (action === 'open-intake') {
      resetIntakeState();
      state.view = 'intake'; render();
    } else if (action === 'open-project') {
      state.projectTab = 'overview';
      await switchProject(button.dataset.id, 'work');
    } else if (action === 'open-members') {
      state.view = 'members'; render();
    } else if (action === 'edit-profile') {
      state.view = 'profile'; render();
    } else if (action === 'mark-notification-read') {
      const updated = await api(`/api/notifications/${button.dataset.id}/read`, { method: 'PATCH' });
      state.notifications = state.notifications.map(item => Number(item.id) === Number(updated.id) ? { ...item, read_at: updated.read_at } : item);
      state.unreadNotificationCount = Math.max(0, state.unreadNotificationCount - 1);
      updateShell(); render();
    } else if (action === 'read-all-notifications') {
      await api('/api/users/me/notifications/read-all', { method: 'POST' });
      const now = new Date().toISOString();
      state.notifications = state.notifications.map(item => ({ ...item, read_at: item.read_at || now }));
      state.unreadNotificationCount = 0;
      updateShell(); render(); toast('All notifications marked as read.');
    } else if (action === 'open-notification') {
      const item = state.notifications.find(notification => Number(notification.id) === Number(button.dataset.id));
      if (item && !item.read_at) {
        const updated = await api(`/api/notifications/${button.dataset.id}/read`, { method: 'PATCH' });
        item.read_at = updated.read_at;
        state.unreadNotificationCount = Math.max(0, state.unreadNotificationCount - 1);
      }
      const rawDestination = String(button.dataset.view || '');
      const [destination, entityId] = rawDestination.includes(':') ? rawDestination.split(':') : [rawDestination, null];
      if (destination === 'teams' && entityId) {
        state.teamWorkspaceData = await api(`/api/teams/${entityId}/workspace`);
        state.teamsDetail = { type: 'team', id: Number(entityId) };
        state.view = 'teams';
        updateShell(); render();
      } else if (destination === 'work' && entityId) {
        const task = await api(`/api/tasks/${entityId}`);
        if (Number(state.projectId) !== Number(task.project_id)) await switchProject(Number(task.project_id), 'work');
        else state.view = 'work';
        state.projectTab = 'list';
        localStorage.setItem('orbit_project_tab', 'list');
        updateShell(); render();
        openTaskDialog(Number(entityId));
      } else {
        state.view = destination === 'admin' && !canManage() ? 'notifications' : (viewTitles[destination] ? destination : 'notifications');
        if (state.view === 'activity') state.activity = await api('/api/users/me/activity?limit=100');
        updateShell(); render();
      }
    } else if (action === 'refresh-activity') {
      state.activity = await api('/api/users/me/activity?limit=100');
      render(); toast('Account activity refreshed.');
    } else if (action === 'select-channel') {
      state.channelId = Number(button.dataset.id);
      localStorage.setItem('orbit_channel_id', state.channelId);
      await loadMessages();
      connectMessageStream(state.channelId);
      await markChannelRead(state.channelId);
      await refreshUnreadMessageCount();
      updateShell();
      render();
    } else if (action === 'set-chat-mode') {
      state.chatMode = button.dataset.mode;
      localStorage.setItem('orbit_chat_mode', state.chatMode);
      if (state.chatMode === 'direct') {
        state.directConversations = await api(`/api/organizations/${state.organizationId}/direct-conversations`);
        if (state.activeConversationId && state.directConversations.some(item => Number(item.id) === Number(state.activeConversationId))) await openConversation(state.activeConversationId);
      } else {
        disconnectDmStream();
        await markChannelRead(state.channelId);
      }
      await refreshUnreadMessageCount();
      updateShell();
      render();
    } else if (action === 'select-conversation') {
      await openConversation(Number(button.dataset.id));
      await refreshUnreadMessageCount();
      updateShell();
      render();
    } else if (action === 'open-thread') {
      const messageId = Number(button.dataset.id);
      const isDirect = state.chatMode === 'direct';
      const parentMessage = (isDirect ? state.directMessages : state.messages).find(item => Number(item.id) === messageId);
      if (parentMessage) await openThreadDialog(isDirect ? 'dm' : 'channel', isDirect ? state.activeConversationId : state.channelId, parentMessage);
    } else if (action === 'open-new-dm') {
      openNewDmDialog();
    } else if (action === 'customize-dashboard') {
      openCustomizeDashboardDialog();
    } else if (action === 'toggle-dashboard-collapse') {
      const key = button.dataset.key;
      const section = button.closest('.dashboard-collapsible');
      const title = section?.dataset.collapseTitle || '';
      const wasCollapsed = getDashboardCollapseState(key);
      const nowCollapsed = !wasCollapsed;
      setDashboardCollapseState(key, nowCollapsed);
      const extra = section?.querySelector('.dashboard-collapsible-extra');
      if (extra) {
        extra.classList.toggle('is-open', !nowCollapsed);
        if (nowCollapsed) extra.setAttribute('aria-hidden', 'true'); else extra.removeAttribute('aria-hidden');
      }
      const label = nowCollapsed ? 'Expand' : 'Collapse';
      button.innerHTML = nowCollapsed ? ICONS.chevronDown : ICONS.chevronUp;
      button.setAttribute('aria-expanded', String(!nowCollapsed));
      button.setAttribute('aria-label', `${label} ${title}`.trim());
      button.setAttribute('data-tooltip', label);
    } else if (action === 'dashboard-my-tasks-tab') {
      state.dashboardMyTasksTab = button.dataset.tab;
      render();
    } else if (action === 'open-task-cross-project') {
      const targetProjectId = Number(button.dataset.projectId);
      const targetTaskId = Number(button.dataset.id);
      if (Number(state.projectId) !== targetProjectId) await switchProject(targetProjectId, 'work');
      state.projectTab = 'list';
      localStorage.setItem('orbit_project_tab', 'list');
      openTaskDialog(targetTaskId);
    } else if (action === 'scan-risks') {
      const result = await api(`/api/projects/${state.projectId}/risks/scan`, { method: 'POST', timeoutMs: 60_000 });
      await loadProjectData(); render(); toast(result.fallback_used ? 'Risk scan completed with local rules.' : `AI risk scan completed with ${result.ai_provider}.`);
    } else if (action === 'generate-plan') {
      openGeneratePlanDialog();
    } else if (action === 'open-task') {
      openTaskDialog(button.dataset.id ? Number(button.dataset.id) : null);
    } else if (action === 'quick-assign-task') {
      const targetId = Number(button.dataset.id);
      const target = state.tasks.find(item => Number(item.id) === targetId);
      if (target) {
        const openTaskDialogEl = document.getElementById('taskDialog');
        const reopenTaskId = openTaskDialogEl ? Number(openTaskDialogEl.querySelector('input[name="task_id"]')?.value) || null : null;
        await openAssignDialog(target, {
          onAssigned: async () => {
            await loadProjectData();
            render();
            if (reopenTaskId) { closeDialog(document.getElementById('taskDialog')); openTaskDialog(reopenTaskId); }
          }
        });
      }
    } else if (action === 'add-task-to-column') {
      openTaskDialog(null, Number(button.dataset.id));
    } else if (action === 'open-add-column') {
      openAddColumnDialog();
    } else if (action === 'open-column-options') {
      openColumnOptionsDialog(Number(button.dataset.id));
    } else if (action === 'set-project-tab') {
      state.projectTab = button.dataset.tab;
      localStorage.setItem('orbit_project_tab', state.projectTab);
      render();
    } else if (action === 'jump-view') {
      state.view = button.dataset.view;
      render();
    } else if (action === 'dashboard-open-tasks') {
      state.view = 'work';
      state.projectTab = 'list';
      localStorage.setItem('orbit_project_tab', 'list');
      render();
    } else if (action === 'edit-project') {
      openProjectEditDialog();
    } else if (action === 'delete-project') {
      openDeleteProjectDialog();
    } else if (action === 'open-story') {
      openStoryDialog(button.dataset.id ? Number(button.dataset.id) : null);
    } else if (action === 'open-brief-analyzer') {
      openBriefAnalyzerDialog();
    } else if (action === 'intake-attach') {
      $('#intakeFileInput')?.click();
    } else if (action === 'intake-remove-file') {
      intakeState.attachedFile = null;
      render();
    } else if (action === 'intake-back-to-brief') {
      intakeState.step = 'brief';
      render();
    } else if (action === 'open-department') {
      openDepartmentDialog(button.dataset.id ? Number(button.dataset.id) : null);
    } else if (action === 'open-team') {
      openTeamDialog(button.dataset.id ? Number(button.dataset.id) : null, button.dataset.departmentId ? Number(button.dataset.departmentId) : null);
    } else if (action === 'view-department') {
      state.teamsDetail = { type: 'department', id: Number(button.dataset.id) };
      render();
    } else if (action === 'view-team') {
      const teamId = Number(button.dataset.id);
      state.teamWorkspaceData = await api(`/api/teams/${teamId}/workspace`);
      state.teamsDetail = { type: 'team', id: teamId };
      render();
    } else if (action === 'open-distribute-work') {
      const teamId = Number(button.dataset.id);
      state.teamWorkspaceData = await api(`/api/teams/${teamId}/workspace`);
      state.teamsDetail = { type: 'distribute', id: teamId };
      state.view = 'teams';
      render();
    } else if (action === 'distribute-select-all') {
      mainContent.querySelectorAll('[data-distribute-check]').forEach(checkbox => { checkbox.checked = true; });
    } else if (action === 'distribute-assign-selected') {
      const teamId = Number(button.dataset.teamId);
      const taskIds = [...mainContent.querySelectorAll('[data-distribute-check]:checked')].map(checkbox => Number(checkbox.value));
      const ownerId = $('#distributeBulkOwner')?.value || null;
      if (!taskIds.length) { toast('Select at least one row first.', true); }
      else {
        await api('/api/tasks/bulk-assign', { method: 'POST', body: JSON.stringify({ task_ids: taskIds, owner_id: ownerId ? Number(ownerId) : null }) });
        state.teamWorkspaceData = await api(`/api/teams/${teamId}/workspace`);
        await loadProjectData();
        render();
        toast(`Assigned ${taskIds.length} item${taskIds.length === 1 ? '' : 's'}.`);
      }
    } else if (action === 'distribute-save-assignments') {
      const teamId = Number(button.dataset.teamId);
      const rows = [...mainContent.querySelectorAll('[data-distribute-owner]')].filter(select => select.value);
      if (!rows.length) { toast('Choose an assignee for at least one row first.', true); }
      else {
        for (const select of rows) {
          await api(`/api/tasks/${select.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ owner_id: Number(select.value) }) });
        }
        state.teamWorkspaceData = await api(`/api/teams/${teamId}/workspace`);
        await loadProjectData();
        render();
        toast(`Saved ${rows.length} assignment${rows.length === 1 ? '' : 's'}.`);
      }
    } else if (action === 'teams-back') {
      state.teamsDetail = null;
      render();
    } else if (action === 'add-team-member') {
      openAddTeamMemberDialog(Number(button.dataset.id));
    } else if (action === 'remove-team-member') {
      if (!confirm('Remove this person from the team?')) return;
      await api(`/api/teams/${button.dataset.id}/members/${button.dataset.userId}`, { method: 'DELETE' });
      state.teamWorkspaceData = await api(`/api/teams/${button.dataset.id}/workspace`);
      render();
      toast('Member removed from team.');
    } else if (action === 'reassign-team-task') {
      // The Team Detail "Team tasks" table can list tasks from any project this team touches, not
      // just the currently-selected one — so unlike the board's quick-assign, the task must come
      // from state.teamWorkspaceData (this team's own task list), not state.tasks.
      const targetId = Number(button.dataset.id);
      const target = state.teamWorkspaceData?.tasks?.find(item => Number(item.id) === targetId);
      if (target) {
        const teamId = state.teamWorkspaceData.team.id;
        await openAssignDialog(target, {
          onAssigned: async () => {
            state.teamWorkspaceData = await api(`/api/teams/${teamId}/workspace`);
            render();
          }
        });
      }
    } else if (action === 'open-milestone') {
      openMilestoneDialog(button.dataset.id ? Number(button.dataset.id) : null);
    } else if (action === 'calendar-prev' || action === 'calendar-next') {
      const [year, month] = state.calendarMonth.split('-').map(Number);
      const delta = action === 'calendar-prev' ? -1 : 1;
      const next = new Date(year, month - 1 + delta, 1);
      state.calendarMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
      render();
    } else if (action === 'approve-task') {
      await api(`/api/tasks/${button.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ approved: true, rejected: false }) });
      await loadProjectData(); render(); toast('Task approved.');
    } else if (action === 'reject-task') {
      if (!confirm('Reject this task?')) return;
      await api(`/api/tasks/${button.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ rejected: true }) });
      await loadProjectData(); render(); toast('Task rejected.');
    } else if (action === 'regenerate-task') {
      const result = await api(`/api/tasks/${button.dataset.id}/regenerate`, { method: 'POST', timeoutMs: 60_000 });
      await loadProjectData(); render(); toast(result.fallback_used ? 'Task regenerated with local fallback.' : `Task regenerated with ${result.ai_provider}.`);
    } else if (action === 'approve-suggestion' || action === 'reject-suggestion') {
      await api(`/api/suggestions/${button.dataset.id}/${action.startsWith('approve') ? 'approve' : 'reject'}`, { method: 'POST' });
      await loadProjectData(); render(); toast(`Suggestion ${action.startsWith('approve') ? 'approved' : 'rejected'}.`);
    } else if (action === 'approve-risk') {
      await api(`/api/risks/${button.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ approved: true }) });
      await loadProjectData(); render(); toast('Risk warning approved.');
    } else if (action === 'review-change') {
      await api(`/api/changes/${button.dataset.id}/${button.dataset.review}`, { method: 'POST' });
      await loadProjectData(); render(); toast(`Change ${button.dataset.review}d.`);
    } else if (action === 'download') {
      await downloadExport(button.dataset.format);
    } else if (action === 'approve-invite' || action === 'reject-invite' || action === 'cancel-invite') {
      const endpoint = action === 'approve-invite' ? 'approve' : action === 'reject-invite' ? 'reject' : 'cancel';
      if (action === 'cancel-invite' && !confirm('Cancel this invitation?')) return;
      await api(`/api/invitations/${button.dataset.id}/${endpoint}`, { method: 'POST' });
      await loadWorkspace();
      toast(action === 'approve-invite' ? 'Member access approved.' : action === 'reject-invite' ? 'Invitation rejected.' : 'Invitation cancelled.');
    } else if (action === 'save-member') {
      const id = button.dataset.id;
      const role = $(`[data-member-role="${id}"]`)?.value;
      const department = $(`[data-member-department="${id}"]`)?.value;
      const departmentId = $(`[data-member-department-id="${id}"]`)?.value;
      const managerUserId = $(`[data-member-manager="${id}"]`)?.value;
      const jobRoleId = $(`[data-member-job-role="${id}"]`)?.value;
      const status = $(`[data-member-status="${id}"]`)?.value;
      await api(`/api/memberships/${id}`, { method: 'PATCH', body: JSON.stringify({ role, department, status, department_id: departmentId || null, manager_user_id: managerUserId || null, job_role_id: jobRoleId || null }) });
      await loadWorkspace(); toast('Member access updated.');
    } else if (action === 'remove-member') {
      if (!confirm('Remove this member from the organization?')) return;
      await api(`/api/memberships/${button.dataset.id}`, { method: 'DELETE' });
      await loadWorkspace(); toast('Member removed.');
    }
  } catch (error) { toast(error.message, true); } finally { setButtonBusy(button, false); }
});

document.body.addEventListener('click', event => {
  const themeButton = event.target.closest('[data-theme-toggle]');
  if (themeButton) {
    toggleTheme();
    return;
  }
  const closeButton = event.target.closest('[data-action="close-dialog"]');
  if (closeButton) {
    const overlayToClose = closeButton.closest('.dialog-backdrop');
    if (overlayToClose?._confirmClose && !overlayToClose._confirmClose()) return;
    closeDialog(overlayToClose);
    return;
  }
  if (event.target.classList?.contains('dialog-backdrop')) {
    if (event.target._confirmClose && !event.target._confirmClose()) return;
    closeDialog(event.target);
  }
});

document.addEventListener('error', event => {
  if (event.target.matches?.('.avatar img')) event.target.remove();
}, true);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') heartbeat(true);
});

mainContent.addEventListener('input', event => {
  if (['memberSearch', 'memberDepartment', 'memberPresence'].includes(event.target.id)) applyMemberFilters();
});
mainContent.addEventListener('change', event => {
  if (['memberDepartment', 'memberPresence'].includes(event.target.id)) applyMemberFilters();
  if (event.target.matches('[name="status_key"]')) $('#customStatusFields')?.classList.toggle('hidden', event.target.value !== 'custom');
  if (event.target.dataset.taskFilter) {
    state.taskFilters = { ...(state.taskFilters || {}), [event.target.dataset.taskFilter]: event.target.value };
    render();
  }
  if (event.target.id === 'taskSortSelect') {
    state.taskSort = event.target.value;
    render();
  }
  if (event.target.id === 'intakeFileInput') {
    intakeState.attachedFile = event.target.files[0] || null;
    render();
  }
});

document.body.addEventListener('submit', async event => {
  if (event.target.id !== 'taskForm') return;
  event.preventDefault();
  const form = new FormData(event.target);
  const submitter = event.submitter;
  setButtonBusy(submitter, true);
  const id = Number(form.get('task_id')) || null;
  const columnId = form.get('column_id') ? Number(form.get('column_id')) : undefined;
  const payload = {
    phase: form.get('phase'), title: form.get('title'), description: form.get('description'),
    owner_id: form.get('owner_id') ? Number(form.get('owner_id')) : null,
    priority: form.get('priority'), status: form.get('status') || 'not_started',
    acceptance_criteria: form.get('acceptance_criteria'), due_date: form.get('due_date') || null,
    start_date: form.get('start_date') || null,
    milestone_id: form.get('milestone_id') ? Number(form.get('milestone_id')) : null,
    story_id: form.get('story_id') ? Number(form.get('story_id')) : null,
    parent_task_id: form.get('parent_task_id') ? Number(form.get('parent_task_id')) : null,
    dependencies: form.getAll('dependencies').map(Number),
    column_id: columnId
  };
  if (form.has('team_id')) payload.team_id = form.get('team_id') ? Number(form.get('team_id')) : null;
  try {
    if (id) await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    else await api(`/api/projects/${state.projectId}/tasks`, { method: 'POST', body: JSON.stringify(payload) });
    closeDialog($('#taskDialog'));
    await loadProjectData();
    render();
    toast(id ? 'Task updated.' : 'Task created.');
  } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
});
