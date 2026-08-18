import { state } from '../state.js';
import { escapeHtml, badge, ICONS, canManage } from '../format.js';
import { pageHead } from '../dispatch.js';

export function projectHealth(project) {
  if (project.health_override) return project.health_override;
  if (project.status === 'completed') return 'completed';
  if (Number(project.overdue_task_count) > 0) return 'critical';
  if (Number(project.open_risk_count) > 0) return 'at_risk';
  return 'healthy';
}

export function renderProjects() {
  const newProjectAction = canManage() ? `<button class="primary" data-action="open-intake">${ICONS.plus} New Project</button>` : '';
  if (!state.projects.length) {
    return `${pageHead('Projects', 'Every project in this organization, at a glance.', newProjectAction)}
    <div class="card empty">No projects yet<br><span class="small muted">Create your first project to start organizing your work.</span>${canManage() ? `<div style="margin-top:14px"><button class="primary" data-action="open-intake">${ICONS.plus} New Project</button></div>` : ''}</div>`;
  }
  return `${pageHead('Projects', 'Every project in this organization, at a glance.', newProjectAction)}
  <div class="grid cols-3">
    ${state.projects.map(project => {
      const health = projectHealth(project);
      const done = Number(project.done_task_count || 0);
      const total = Number(project.task_count || 0);
      const percent = total ? Math.round((done / total) * 100) : 0;
      return `<article class="card project-card" data-action="open-project" data-id="${project.id}" tabindex="0" role="button" aria-label="Open ${escapeHtml(project.name)}">
        <div class="project-card-head"><h3>${escapeHtml(project.name)}</h3>${badge(health)}</div>
        <div class="small muted">${escapeHtml(project.owner_name || project.created_by_name || 'Unassigned')} · ${badge(project.priority || 'medium')}</div>
        <div class="progress" style="margin-top:12px"><span style="width:${percent}%"></span></div>
        <div class="small muted" style="margin-top:6px">${done}/${total} tasks done${project.due_date ? ` · Due ${escapeHtml(project.due_date)}` : ''}</div>
        <div class="project-card-foot">${badge(project.status)}${project.open_risk_count ? `<span class="small">${project.open_risk_count} open risk${project.open_risk_count === 1 ? '' : 's'}</span>` : ''}</div>
      </article>`;
    }).join('')}
  </div>`;
}
