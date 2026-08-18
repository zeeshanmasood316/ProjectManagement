import { state, $ } from './state.js';
import { escapeHtml } from './format.js';
import { switchProject } from './navigation.js';
import { openTaskDialog } from './dialogs/task-dialogs.js';

export function hideGlobalSearchResults() {
  const panel = $('#globalSearchResults');
  panel.classList.add('hidden');
  panel.innerHTML = '';
}

export function renderGlobalSearchResults(query) {
  const panel = $('#globalSearchResults');
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return hideGlobalSearchResults();
  const projectMatches = state.projects.filter(item => item.name.toLowerCase().includes(trimmed)).slice(0, 8);
  const taskMatches = state.tasks.filter(item => item.title.toLowerCase().includes(trimmed)).slice(0, 8);
  const sections = [];
  if (projectMatches.length) sections.push(`<div class="search-group-label">Projects (${projectMatches.length})</div>${projectMatches.map(item => `<button type="button" data-search-project="${item.id}">${escapeHtml(item.name)}</button>`).join('')}`);
  if (taskMatches.length) sections.push(`<div class="search-group-label">Tasks in current project (${taskMatches.length})</div>${taskMatches.map(item => `<button type="button" data-search-task="${item.id}">${escapeHtml(item.title)}</button>`).join('')}`);
  panel.innerHTML = sections.join('') || '<div class="empty">No matches found.</div>';
  panel.classList.remove('hidden');
}

export let globalSearchTimer = null;
$('#globalSearchInput').addEventListener('input', event => {
  clearTimeout(globalSearchTimer);
  const query = event.target.value;
  globalSearchTimer = setTimeout(() => renderGlobalSearchResults(query), 200);
});
$('#globalSearchInput').addEventListener('focus', event => { if (event.target.value.trim()) renderGlobalSearchResults(event.target.value); });
document.addEventListener('click', event => {
  if (!event.target.closest('#globalSearchWrap') && !event.target.closest('#globalSearchResults')) hideGlobalSearchResults();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideGlobalSearchResults(); });
$('#globalSearchResults').addEventListener('click', async event => {
  const projectButton = event.target.closest('[data-search-project]');
  const taskButton = event.target.closest('[data-search-task]');
  if (projectButton) {
    hideGlobalSearchResults();
    $('#globalSearchInput').value = '';
    await switchProject(projectButton.dataset.searchProject, 'work');
  } else if (taskButton) {
    hideGlobalSearchResults();
    $('#globalSearchInput').value = '';
    openTaskDialog(Number(taskButton.dataset.searchTask));
  }
});
