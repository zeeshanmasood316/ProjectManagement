import { state } from '../state.js';
import { escapeHtml, ICONS } from '../format.js';
import { mountDialog, closeDialog, setButtonBusy, toast } from '../ui.js';
import { api } from '../api.js';
import { render } from '../dispatch.js';
import { DEFAULT_DASHBOARD_LAYOUT, DASHBOARD_WIDGET_LABELS, getDashboardLayout } from '../views/dashboard.js';
import { openConversation } from '../messaging.js';

export function openCustomizeDashboardDialog() {
  const layout = getDashboardLayout();
  const overlay = document.createElement('div');
  overlay.id = 'customizeDashboardDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="customizeDashboardForm" class="dialog-card stack compact-dialog">
    <div class="dialog-head"><div><h2 id="customizeDashboardTitle">Customize Dashboard</h2><p class="small muted">Choose which widgets appear on your Dashboard.</p></div><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    ${layout.map(item => `<label class="toggle-row"><span><strong>${escapeHtml(DASHBOARD_WIDGET_LABELS[item.key] || item.key)}</strong></span><input type="checkbox" name="widget" value="${item.key}" ${item.visible ? 'checked' : ''}></label>`).join('')}
    <div class="actions"><button type="button" class="secondary" data-action="restore-dashboard-defaults">Restore defaults</button><button class="primary" type="submit">Save</button></div>
  </form>`;
  mountDialog(overlay, 'customizeDashboardTitle');
  overlay.querySelector('#customizeDashboardForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const checkedKeys = new Set(form.getAll('widget'));
    const newLayout = DEFAULT_DASHBOARD_LAYOUT.map(item => ({ key: item.key, visible: checkedKeys.has(item.key) }));
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    try {
      state.settings = await api('/api/users/me/settings', { method: 'PATCH', body: JSON.stringify({ dashboard_layout: newLayout }) });
      closeDialog(overlay);
      render();
      toast('Dashboard updated.');
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
  overlay.querySelector('[data-action="restore-dashboard-defaults"]').addEventListener('click', async () => {
    try {
      state.settings = await api('/api/users/me/settings', { method: 'PATCH', body: JSON.stringify({ dashboard_layout: DEFAULT_DASHBOARD_LAYOUT }) });
      closeDialog(overlay);
      render();
      toast('Dashboard reset to defaults.');
    } catch (error) { toast(error.message, true); }
  });
}

export function openNewDmDialog() {
  const options = state.members.filter(member => member.status === 'active' && Number(member.user_id) !== Number(state.user.id)).map(member => `<option value="${member.user_id}">${escapeHtml(member.full_name)} (@${escapeHtml(member.username)})</option>`).join('');
  const overlay = document.createElement('div');
  overlay.id = 'newDmDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<form id="newDmForm" class="dialog-card stack compact-dialog"><div class="dialog-head"><div><h2 id="newDmDialogTitle">New direct message</h2></div><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <label>To<select name="user_id" autofocus required>${options || '<option value="">No other members yet</option>'}</select></label>
    <div class="actions"><button class="primary" type="submit">Start conversation</button></div>
  </form>`;
  mountDialog(overlay, 'newDmDialogTitle');
  overlay.querySelector('#newDmForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = event.submitter;
    setButtonBusy(submitter, true);
    try {
      const result = await api(`/api/organizations/${state.organizationId}/direct-conversations`, { method: 'POST', body: JSON.stringify({ user_id: form.get('user_id') }) });
      closeDialog(overlay);
      state.directConversations = await api(`/api/organizations/${state.organizationId}/direct-conversations`);
      await openConversation(Number(result.id));
      render();
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(submitter, false); }
  });
}
