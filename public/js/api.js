import { state } from './state.js';
import { setGlobalLoading } from './ui.js';
import { logout } from './auth-screens.js';

export async function api(path, options = {}) {
  const { silent = false, timeoutMs = 20_000, ...fetchOptions } = options;
  const headers = { ...(fetchOptions.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (fetchOptions.body !== undefined && !(fetchOptions.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (!silent) setGlobalLoading(true);
  try {
    const response = await fetch(path, { ...fetchOptions, headers, credentials: 'same-origin', signal: controller.signal });
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch {}
      const error = new Error(payload.detail || `${response.status} ${response.statusText}`);
      error.status = response.status;
      error.code = payload.code;
      error.payload = payload;
      error.requestId = payload.request_id || response.headers.get('x-request-id');
      if (response.status === 401 && !path.endsWith('/auth/login') && !path.endsWith('/auth/register')) logout(false);
      throw error;
    }
    if (response.status === 204) return null;
    const type = response.headers.get('content-type') || '';
    return type.includes('application/json') ? response.json() : response.text();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The request timed out. Please check your connection and try again.');
    if (error instanceof TypeError) throw new Error('Unable to reach Orbit. Check your internet connection and try again.');
    throw error;
  } finally {
    clearTimeout(timer);
    if (!silent) setGlobalLoading(false);
  }
}
