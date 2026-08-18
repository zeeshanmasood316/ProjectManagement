'use strict';

const db = require('../database/client');
const { route } = require('../middleware/router');
const { jsonResponse, textResponse } = require('../middleware/http');
const { integer } = require('../utils/validation');
const { FULL_ACCESS_ROLES } = require('../rbac/permissions');
const { isManagerScope, scopeTaskList, requireManagerTierOrAbove } = require('../rbac/scope');
const { projectWithAccess } = require('../services/access');
const { getProject, projectReport } = require('../services/projects');

route('GET', '/api/projects/:projectId/report', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  const report = await projectReport(projectId);
  if (!scope.fullAccess && !isManagerScope(scope)) {
    jsonResponse(res, 200, { ...report, blockers: [], open_risks: [], approved_decisions: [], pending_changes: [], recent_updates: [] });
    return;
  }
  jsonResponse(res, 200, report);
});

route('GET', '/api/projects/:projectId/audit', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId, FULL_ACCESS_ROLES);
  jsonResponse(res, 200, await db.all(
    `SELECT a.*,u.full_name actor_name,u.username actor_username FROM audit_log a
     LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.project_id=? ORDER BY a.id DESC LIMIT 500`,
    [projectId]
  ));
});

route('GET', '/api/projects/:projectId/export.json', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  requireManagerTierOrAbove(scope, 'Exporting a project is only available to managers and above');
  const allTasksForExport = await db.all(
    `SELECT t.*, s.team_id story_team_id FROM tasks t LEFT JOIN stories s ON s.id=t.story_id WHERE t.project_id=?`,
    [projectId]
  );
  const exportData = {
    project: await getProject(projectId),
    tasks: scopeTaskList(scope, allTasksForExport),
    dependencies: await db.all('SELECT d.* FROM dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.project_id=?', [projectId]),
    risks: await db.all('SELECT * FROM risks WHERE project_id=?', [projectId]),
    decisions: await db.all('SELECT * FROM decisions WHERE project_id=?', [projectId]),
    changes: await db.all('SELECT * FROM changes WHERE project_id=?', [projectId]),
    updates: await db.all('SELECT * FROM updates WHERE project_id=?', [projectId]),
    report: await projectReport(projectId)
  };
  const body = JSON.stringify(exportData, null, 2);
  textResponse(res, 200, body, 'application/json; charset=utf-8', { 'Content-Disposition': `attachment; filename="project-${projectId}-export.json"` });
});

function csvCell(value) {
  const string = String(value ?? '');
  return /[",\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

route('GET', '/api/projects/:projectId/tasks.csv', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { scope } = await projectWithAccess(user.id, projectId);
  requireManagerTierOrAbove(scope, 'Exporting tasks is only available to managers and above');
  const allTasksForCsv = await db.all(
    `SELECT t.*,u.full_name owner_name,s.team_id story_team_id FROM tasks t LEFT JOIN users u ON u.id=t.owner_id LEFT JOIN stories s ON s.id=t.story_id WHERE t.project_id=? ORDER BY t.id`,
    [projectId]
  );
  const tasks = scopeTaskList(scope, allTasksForCsv);
  const headers = ['id','phase','title','owner_name','priority','status','approved','due_date','acceptance_criteria'];
  const csv = [headers.join(','), ...tasks.map(task => headers.map(header => csvCell(task[header])).join(','))].join('\n');
  textResponse(res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="project-${projectId}-tasks.csv"` });
});
