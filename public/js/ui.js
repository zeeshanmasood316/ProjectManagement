import { state, $, $$, mainContent, mobileNavToggle, sidebarBackdrop } from './state.js';
import { escapeHtml, ICONS } from './format.js';
import { api } from './api.js';
import { loadProjectData } from './workspace-loader.js';
import { render } from './dispatch.js';

export let activeRequests = 0;
export let lastDialogTrigger = null;

export function resolvedTheme(preference) {
  if (preference === 'dark' || preference === 'light') return preference;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function updateThemeToggleButtons() {
  const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const nextLabel = current === 'dark' ? 'Light' : 'Dark';
  const nextIcon = current === 'dark' ? ICONS.sun : ICONS.moon;
  $$('[data-theme-toggle]').forEach(button => {
    button.innerHTML = nextIcon;
    const label = `Switch to ${nextLabel.toLowerCase()} mode`;
    button.setAttribute('aria-label', label);
    button.setAttribute('data-tooltip', label);
    button.removeAttribute('title');
  });
}

export function applyTheme(preference = 'light') {
  const safePreference = resolvedTheme(preference);
  localStorage.setItem('orbit_theme', safePreference);
  document.documentElement.dataset.themePreference = safePreference;
  document.documentElement.dataset.theme = safePreference;
  updateThemeToggleButtons();
}

export async function toggleTheme() {
  const previous = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const next = previous === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  state.settings = { ...(state.settings || {}), theme: next };
  if (!state.user) return;
  try {
    state.settings = await api('/api/users/me/settings', { method: 'PATCH', body: JSON.stringify({ theme: next }) });
  } catch (error) {
    applyTheme(previous);
    state.settings = { ...(state.settings || {}), theme: previous };
    toast(error.message, true);
  }
}

export function announce(message) {
  const element = $('#appStatus');
  if (!element) return;
  element.textContent = '';
  requestAnimationFrame(() => { element.textContent = message; });
}

export function toast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.setAttribute('role', isError ? 'alert' : 'status');
  element.classList.add('show');
  announce(message);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 4500);
}

// Deliberately separate from toast() — a new-message popup (Phase 3, item 11/19) must never be
// visually or semantically confused with a system toast, so it gets its own element/styling
// (#messagePopup in index.html) and its own click-through behavior instead of reusing #toast.
export function showMessagePopup(title, preview, onOpen) {
  const element = $('#messagePopup');
  if (!element) return;
  $('#messagePopupTitle').textContent = title;
  $('#messagePopupPreview').textContent = preview;
  element.classList.remove('hidden');
  element.classList.add('show');
  element.onclick = () => { element.classList.remove('show'); onOpen?.(); };
  announce(`New message: ${title}`);
  clearTimeout(showMessagePopup.timer);
  showMessagePopup.timer = setTimeout(() => element.classList.remove('show'), 6000);
}

export function setGlobalLoading(isLoading) {
  activeRequests = Math.max(0, activeRequests + (isLoading ? 1 : -1));
  const loading = activeRequests > 0;
  const element = $('#globalLoading');
  if (!element) return;
  element.classList.toggle('active', loading);
  element.setAttribute('aria-hidden', String(!loading));
}

export function setWorkspaceBusy(isBusy, message = 'Loading workspace…') {
  mainContent.setAttribute('aria-busy', String(Boolean(isBusy)));
  if (isBusy && !mainContent.children.length) {
    mainContent.innerHTML = `<div class="loading-state" role="status"><span class="spinner" aria-hidden="true"></span><strong>${escapeHtml(message)}</strong><span>Please wait while Orbit prepares your workspace.</span></div>`;
  }
}

export function setButtonBusy(button, busy, label = 'Working…') {
  if (!button) return;
  if (busy) {
    button.dataset.previousLabel = button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span>${escapeHtml(label)}`;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.previousLabel) button.innerHTML = button.dataset.previousLabel;
    delete button.dataset.previousLabel;
  }
}

export function updateNetworkStatus() {
  const offline = !navigator.onLine;
  $('#networkBanner')?.classList.toggle('hidden', !offline);
  document.body.classList.toggle('is-offline', offline);
  if (offline) announce('You are offline.');
}

export function toggleMobileNavigation(open) {
  const shouldOpen = open ?? !document.body.classList.contains('mobile-nav-open');
  document.body.classList.toggle('mobile-nav-open', shouldOpen);
  mobileNavToggle?.setAttribute('aria-expanded', String(shouldOpen));
  mobileNavToggle?.setAttribute('aria-label', shouldOpen ? 'Close navigation' : 'Open navigation');
  sidebarBackdrop?.classList.toggle('hidden', !shouldOpen);
  if (shouldOpen) $('#mainNav button.active')?.focus();
}

export function closeDialog(overlay) {
  if (!overlay) return;
  overlay._onClose?.();
  overlay.remove();
  if (!document.querySelector('.dialog-backdrop')) document.body.classList.remove('dialog-open');
  lastDialogTrigger?.focus?.();
  lastDialogTrigger = null;
}

export function mountDialog(overlay, titleId, options = {}) {
  overlay._confirmClose = options.confirmClose || null;
  lastDialogTrigger = document.activeElement;
  overlay.setAttribute('role', 'presentation');
  const dialog = overlay.querySelector('.dialog-card');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  if (titleId) dialog.setAttribute('aria-labelledby', titleId);
  document.body.appendChild(overlay);
  document.body.classList.add('dialog-open');
  const focusable = () => [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]')];
  requestAnimationFrame(() => { enhanceAiFields(dialog); (dialog.querySelector('[autofocus]') || focusable()[0])?.focus(); });
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); if (overlay._confirmClose && !overlay._confirmClose()) return; closeDialog(overlay); return; }
    if (event.key !== 'Tab') return;
    const items = focusable();
    if (!items.length) return;
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}

export const aiFieldNames = new Set(['name','objective','scope','constraints','assumptions','brief','notes','title','description','acceptance_criteria','body','topic','phase','custom_status','status_label','proposed_department']);
export let aiFieldCounter = 0;

export function enhanceAiFields(root = document) {
  root.querySelectorAll('input[name], textarea[name]').forEach(field => {
    if (field.dataset.aiEnhanced === '1' || field.disabled || field.readOnly || !aiFieldNames.has(field.name)) return;
    if (['password','email','url','number','date','hidden'].includes(field.type)) return;
    field.dataset.aiEnhanced = '1';
    if (!field.id) field.id = `ai-field-${++aiFieldCounter}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-assist-button';
    button.dataset.action = 'ai-assist-field';
    button.dataset.targetId = field.id;
    button.innerHTML = '✨ AI Suggest';
    button.title = 'Generate an editable AI suggestion for this field';
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      setButtonBusy(button, true, 'Thinking…');
      try {
        await openAiSuggestionDialog(field);
      } catch (error) {
        toast(error.message, true);
      } finally {
        setButtonBusy(button, false);
      }
    });
    field.insertAdjacentElement('afterend', button);
  });
}

export function fieldLabel(field) {
  const label = field.closest('label');
  if (!label) return field.name || 'Field';
  return [...label.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent.trim()).filter(Boolean).join(' ') || field.name || 'Field';
}

export function formContextFor(field) {
  const form = field.closest('form');
  if (!form) return {};
  const context = {};
  for (const [key, value] of new FormData(form).entries()) if (typeof value === 'string' && key !== 'password') context[key] = value;
  return context;
}

export async function requestAiSuggestion(field, instruction = '') {
  return api('/api/ai/suggest', { method: 'POST', timeoutMs: 55_000, body: JSON.stringify({
    project_id: state.projectId || null,
    field_name: field.name,
    field_label: fieldLabel(field),
    value: field.value,
    instruction,
    form_context: formContextFor(field)
  }) });
}

export async function openAiSuggestionDialog(field) {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<section class="dialog-card ai-suggestion-dialog"><div class="dialog-head"><div><p class="eyebrow dark">AI WRITING ASSISTANT</p><h2 id="aiSuggestionTitle">${escapeHtml(fieldLabel(field))}</h2></div><button type="button" class="icon-button" data-ai-close aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div><div class="ai-thinking"><span class="spinner"></span> Generating suggestion…</div></section>`;
  document.body.appendChild(overlay); document.body.classList.add('dialog-open');
  const card = overlay.querySelector('.dialog-card'); card.setAttribute('role','dialog'); card.setAttribute('aria-modal','true'); card.setAttribute('aria-labelledby','aiSuggestionTitle');
  const load = async instruction => {
    card.querySelector('.ai-thinking')?.remove();
    let result;
    try { result = await requestAiSuggestion(field, instruction); }
    catch (error) { overlay.remove(); if (!document.querySelector('.dialog-backdrop')) document.body.classList.remove('dialog-open'); throw error; }
    card.innerHTML = `<div class="dialog-head"><div><p class="eyebrow dark">AI WRITING ASSISTANT</p><h2 id="aiSuggestionTitle">${escapeHtml(fieldLabel(field))}</h2></div><button type="button" class="icon-button" data-ai-close aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div><div class="ai-provider-row"><span class="ai-status ${result.fallback ? 'fallback' : 'connected'}">✨ ${escapeHtml(result.provider)}</span><span class="small muted">Edit below before accepting.</span></div><textarea id="aiSuggestionText" class="ai-suggestion-text">${escapeHtml(result.suggestion)}</textarea><p class="small muted">${escapeHtml(result.rationale || '')}</p><div class="actions"><button class="primary" type="button" data-ai-accept>Accept suggestion</button><button class="secondary" type="button" data-ai-regenerate>Regenerate</button><button class="secondary" type="button" data-ai-close>Cancel</button></div>`;
    card.querySelector('#aiSuggestionText')?.focus();
  };
  overlay.addEventListener('click', async event => {
    if (event.target.closest('[data-ai-close]')) { overlay.remove(); if (!document.querySelector('.dialog-backdrop')) document.body.classList.remove('dialog-open'); field.focus(); }
    else if (event.target.closest('[data-ai-accept]')) { field.value = card.querySelector('#aiSuggestionText').value; field.dispatchEvent(new Event('input',{bubbles:true})); field.dispatchEvent(new Event('change',{bubbles:true})); overlay.remove(); if (!document.querySelector('.dialog-backdrop')) document.body.classList.remove('dialog-open'); field.focus(); toast('AI suggestion added. You can still edit it.'); }
    else if (event.target.closest('[data-ai-regenerate]')) { const btn=event.target.closest('[data-ai-regenerate]'); setButtonBusy(btn,true,'Regenerating…'); try { const result=await requestAiSuggestion(field,'Generate a different, stronger version.'); card.querySelector('#aiSuggestionText').value=result.suggestion; card.querySelector('.ai-status').textContent=`✨ ${result.provider}`; } catch(e){toast(e.message,true)} finally {setButtonBusy(btn,false)} }
  });
  await load('');
}

export function openGeneratePlanDialog() {
  const overlay = document.createElement('div'); overlay.className='dialog-backdrop';
  overlay.innerHTML = `<form id="aiPlanForm" class="dialog-card stack"><div class="dialog-head"><div><p class="eyebrow dark">AI PROJECT PLANNER</p><h2 id="aiPlanTitle">Generate a project-specific plan</h2></div><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div><div class="notice">AI will use the saved objective, scope, constraints, assumptions, team members and the optional brief below. Every generated task stays pending for human review.</div><label>Extra instructions / brief<textarea name="brief" placeholder="Example: Launch MVP in 6 weeks. Prioritize authentication, payments and mobile responsiveness."></textarea></label><label class="toggle-row"><span><strong>Replace pending AI tasks</strong><small>Remove only previous unapproved AI tasks before generating a fresh plan.</small></span><input type="checkbox" name="replace_unapproved"></label><div class="actions"><button class="primary" type="submit">✨ Generate with AI</button></div></form>`;
  mountDialog(overlay,'aiPlanTitle');
  overlay.querySelector('form').addEventListener('submit', async event => { event.preventDefault(); const btn=event.submitter; const fd=new FormData(event.currentTarget); setButtonBusy(btn,true,'AI is planning…'); try { const result=await api(`/api/projects/${state.projectId}/generate-plan`,{method:'POST',timeoutMs:60_000,body:JSON.stringify({brief:fd.get('brief'),replace_unapproved:event.currentTarget.elements.replace_unapproved.checked})}); closeDialog(overlay); await loadProjectData(); render(); toast(result.fallback_used ? 'Plan created with local fallback. Add an AI API key for full AI generation.' : `AI plan created with ${result.ai_provider}.`); } catch(e){toast(e.message,true)} finally {setButtonBusy(btn,false)} });
}

export function renderWorkspaceError(error, retryAction = 'retry-workspace') {
  const requestReference = error.requestId ? `<p class="small muted">Reference: ${escapeHtml(error.requestId)}</p>` : '';
  mainContent.innerHTML = `<section class="card error-state" role="alert"><div class="error-state-icon">!</div><h2>We could not load this view</h2><p>${escapeHtml(error.message || 'An unexpected error occurred.')}</p>${requestReference}<button class="primary" type="button" data-action="${escapeHtml(retryAction)}">Try again</button></section>`;
  mainContent.focus();
}
