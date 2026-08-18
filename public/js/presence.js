import { state, presenceSelect } from './state.js';
import { api } from './api.js';
import { render } from './dispatch.js';

export let heartbeatTimer = null;

export function stopPresenceHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

export async function heartbeat(refreshDirectory = false) {
  if (!state.user) return;
  try {
    state.presence = await api('/api/presence/heartbeat', { method: 'POST', silent: true });
    if (presenceSelect) presenceSelect.value = state.presence.status_key || 'available';
    if (refreshDirectory && state.organizationId && ['members', 'admin'].includes(state.view)) {
      state.members = await api(`/api/organizations/${state.organizationId}/members`);
      render();
    }
  } catch {}
}

export function startPresenceHeartbeat() {
  stopPresenceHeartbeat();
  heartbeatTimer = setInterval(() => heartbeat(true), 60_000);
}
