'use strict';

const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const Busboy = require('busboy');
const db = require('../database/client');
const ai = require('../ai/engine');
const { route } = require('../middleware/router');
const { HttpError, jsonResponse, textResponse } = require('../middleware/http');
const { cleanString, requiredString, integer } = require('../utils/validation');
const { membership, requireMembership, FULL_ACCESS_ROLES } = require('../rbac/permissions');
const { audit, activity, notifyUser } = require('../notifications/events');
const { activeOrganizationMembers, activeOrganizationTeams } = require('../services/organizations');
const { briefSessionAccess, projectWithAccess } = require('../services/access');
const { PROJECT_PRIORITIES } = require('../services/projects');
const { createSseHub } = require('../realtime/sseHub');

const BRIEF_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const BRIEF_ALLOWED_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'pdf', 'docx']);

async function extractBriefText(filename, buffer) {
  const extension = (String(filename || '').split('.').pop() || '').toLowerCase();
  if (!BRIEF_ALLOWED_EXTENSIONS.has(extension)) throw new HttpError(400, `Unsupported file type: .${extension || 'unknown'}. Upload a .txt, .md, .pdf, or .docx file.`);
  if (extension === 'txt' || extension === 'md' || extension === 'markdown') return buffer.toString('utf8');
  if (extension === 'pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

const briefProgressHub = createSseHub();

function broadcastBriefProgress(token, payload) {
  briefProgressHub.broadcast(token, payload);
}

route('GET', '/api/brief-analysis/progress', async ({ req, res, user, query }) => {
  const token = cleanString(query.get('token'), 80);
  if (!token) throw new HttpError(400, 'A progress token is required');
  req.socket.setTimeout(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  briefProgressHub.add(token, res);
  req.on('close', () => briefProgressHub.remove(token, res));
});

route('POST', '/api/projects/:projectId/brief-analysis/upload', async ({ req, res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId, FULL_ACCESS_ROLES);
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw new HttpError(415, 'Content-Type must be multipart/form-data');
  const upload = await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
    let busboyInstance;
    try {
      busboyInstance = Busboy({ headers: req.headers, limits: { files: 1, fileSize: BRIEF_UPLOAD_MAX_BYTES } });
    } catch (error) {
      return settle(new HttpError(400, 'Invalid upload request'));
    }
    let found = null;
    let truncated = false;
    busboyInstance.on('file', (fieldname, stream, info) => {
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => { size += chunk.length; if (size <= BRIEF_UPLOAD_MAX_BYTES) chunks.push(chunk); });
      stream.on('limit', () => { truncated = true; });
      stream.on('close', () => { if (!found) found = { filename: info.filename, buffer: Buffer.concat(chunks) }; });
    });
    busboyInstance.on('close', () => {
      if (truncated) return settle(new HttpError(400, `File exceeds the ${Math.round(BRIEF_UPLOAD_MAX_BYTES / (1024 * 1024))}MB limit`));
      if (!found || !found.buffer.length) return settle(new HttpError(400, 'No file was uploaded'));
      settle(null, found);
    });
    busboyInstance.on('error', error => settle(error));
    req.pipe(busboyInstance);
  });
  const text = await extractBriefText(upload.filename, upload.buffer);
  const cleanedText = String(text || '').trim();
  if (!cleanedText) throw new HttpError(400, 'No readable text was found in that file');
  jsonResponse(res, 200, { filename: upload.filename, text: cleanedText.slice(0, 100000) });
}, { rawBody: true });

route('POST', '/api/projects/:projectId/brief-analysis', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, FULL_ACCESS_ROLES);
  const rawText = requiredString(body.raw_text, 'Brief text', 10, 100000);
  const sourceType = body.source_type === 'upload' ? 'upload' : 'paste';
  const streamToken = cleanString(body.stream_token, 80);
  const onProgress = streamToken ? (step, detail) => broadcastBriefProgress(streamToken, { step, detail }) : undefined;
  const members = await activeOrganizationMembers(project.organization_id);
  const teams = await activeOrganizationTeams(project.organization_id);
  const analysis = await ai.analyzeProjectBrief(project, members, rawText, onProgress, teams);
  if (streamToken) broadcastBriefProgress(streamToken, { step: 'done', detail: 'Analysis complete' });
  const now = db.utcnow();
  const result = await db.run(
    'INSERT INTO ai_brief_sessions(project_id,organization_id,client_name,project_name,source_type,source_filename,raw_text,status,generated_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [projectId, project.organization_id, project.client_name || '', project.name, sourceType, cleanString(body.source_filename, 255), rawText, 'ready_for_review', JSON.stringify(analysis.item), user.id, now]
  );
  await audit(project.organization_id, projectId, user.id, 'ai_brief_session', result.lastInsertRowid, 'generated', { provider: analysis.provider, fallback: analysis.fallback });
  jsonResponse(res, 201, { session_id: result.lastInsertRowid, plan: analysis.item, project_fields: analysis.project || null, ai_provider: analysis.provider, fallback_used: analysis.fallback, warning: analysis.warning || null });
});

route('POST', '/api/brief-sessions/:sessionId/commit', async ({ res, user, params, body }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const session = await db.get('SELECT * FROM ai_brief_sessions WHERE id=?', [sessionId]);
  if (!session) throw new HttpError(404, 'Brief analysis session not found');
  if (session.status !== 'ready_for_review') throw new HttpError(409, 'This brief analysis is not ready to be created into a project (it may already be converted, or analysis has not completed).');
  const { project: accessProject } = await briefSessionAccess(user.id, session, FULL_ACCESS_ROLES);
  const plan = body.plan && typeof body.plan === 'object' ? body.plan : {};
  const now = db.utcnow();

  // Resolved fresh at commit time against real organization teams — never trust a client-submitted
  // team name blindly, and never fabricate a team that doesn't exist (only exact matches route work).
  const orgTeams = await activeOrganizationTeams(session.organization_id);
  const teamByLowerName = new Map(orgTeams.map(team => [String(team.name).toLowerCase(), team]));
  const teamById = new Map(orgTeams.map(team => [Number(team.id), team]));
  const resolveTeam = name => {
    const clean = cleanString(name, 120);
    return clean ? teamByLowerName.get(clean.toLowerCase()) || null : null;
  };
  const validTeamConfidence = value => {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num))) : null;
  };

  const summary = await db.transaction(async () => {
    let project = accessProject;
    let createdProjectId = null;
    if (!session.project_id) {
      const projectName = cleanString(body.project_name, 160) || cleanString(session.project_name, 160) || 'Untitled project';
      const clientName = cleanString(body.client_name, 160) || cleanString(session.client_name, 160);
      const projectOwnerId = body.owner_id ? integer(body.owner_id, 'owner_id') : user.id;
      const validOwnerId = projectOwnerId === user.id || await membership(projectOwnerId, session.organization_id, true) ? projectOwnerId : user.id;
      const projectPriority = PROJECT_PRIORITIES.includes(body.priority) ? body.priority : 'medium';
      const projectResult = await db.run(
        'INSERT INTO projects(organization_id,name,client_name,objective,scope,constraints,assumptions,status,owner_id,priority,start_date,due_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [session.organization_id, projectName, clientName, cleanString(body.objective), cleanString(body.scope), cleanString(body.constraints), '', 'active', validOwnerId, projectPriority, cleanString(body.start_date, 10) || null, cleanString(body.due_date, 10) || null, user.id, now, now]
      );
      createdProjectId = projectResult.lastInsertRowid;
      project = await db.get('SELECT * FROM projects WHERE id=?', [createdProjectId]);
      await audit(session.organization_id, createdProjectId, user.id, 'project', createdProjectId, 'created', { name: projectName, source: 'client_brief' });
    }
    const departmentIdByName = new Map();
    const resolveDepartment = async name => {
      const clean = cleanString(name, 120);
      if (!clean) return null;
      const key = clean.toLowerCase();
      if (departmentIdByName.has(key)) return departmentIdByName.get(key);
      await db.run('INSERT OR IGNORE INTO departments(organization_id,name,created_at,updated_at) VALUES(?,?,?,?)', [project.organization_id, clean, now, now]);
      const row = await db.get('SELECT id FROM departments WHERE organization_id=? AND name=? COLLATE NOCASE', [project.organization_id, clean]);
      departmentIdByName.set(key, row?.id || null);
      return row?.id || null;
    };

    let departmentCount = 0;
    for (const item of Array.isArray(plan.departments) ? plan.departments : []) {
      const name = cleanString(item?.name, 120);
      if (!name) continue;
      const id = await resolveDepartment(name);
      if (id) departmentCount += 1;
    }

    let milestoneCount = 0;
    for (const item of Array.isArray(plan.milestones) ? plan.milestones : []) {
      const name = cleanString(item?.name, 160);
      if (!name) continue;
      await db.run('INSERT INTO milestones(project_id,name,description,due_date,owner_id,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [project.id, name, `Generated from project brief analysis. ${cleanString(item?.source_note, 500)}`.trim(), /^\d{4}-\d{2}-\d{2}$/.test(cleanString(item?.due_date, 10)) ? item.due_date : null, null, 'planned', user.id, now, now]);
      milestoneCount += 1;
    }

    let riskCount = 0;
    for (const item of Array.isArray(plan.risks) ? plan.risks : []) {
      const title = cleanString(item?.title, 220);
      if (!title) continue;
      await db.run('INSERT INTO risks(project_id,risk_type,severity,title,description,evidence,status,ai_generated,approved,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        [project.id, 'brief_analysis', ['low', 'medium', 'high', 'critical'].includes(item?.severity) ? item.severity : 'medium', title, cleanString(item?.description, 4000), cleanString(item?.source_note, 1000), 'open', 1, 0, now, now]);
      riskCount += 1;
    }

    let assumptionCount = 0;
    const assumptionTexts = (Array.isArray(plan.assumptions) ? plan.assumptions : []).map(item => cleanString(item?.text, 500)).filter(Boolean);
    if (assumptionTexts.length) {
      const existingProject = await db.get('SELECT assumptions FROM projects WHERE id=?', [project.id]);
      const merged = [cleanString(existingProject?.assumptions, 20000), ...assumptionTexts.map(text => `- ${text} (from brief analysis)`)].filter(Boolean).join('\n');
      await db.run('UPDATE projects SET assumptions=?,updated_at=? WHERE id=?', [merged.slice(0, 20000), now, project.id]);
      assumptionCount = assumptionTexts.length;
    }

    const resolveOwner = async value => {
      const ownerId = value ? Number(value) : null;
      if (!ownerId || !Number.isInteger(ownerId)) return null;
      return (await membership(ownerId, project.organization_id, true)) ? ownerId : null;
    };
    const validStoryStatus = value => ['not_started', 'in_progress', 'at_risk', 'done'].includes(value) ? value : 'not_started';
    const validTaskStatus = value => ['not_started', 'in_progress', 'blocked', 'done'].includes(value) ? value : 'not_started';
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(cleanString(value, 10)) ? value : null;
    const cleanTags = value => Array.isArray(value) ? value.map(tag => cleanString(tag, 40)).filter(Boolean).slice(0, 8).join(',') : '';
    const cleanHours = value => value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

    let storyCount = 0, taskCount = 0, subtaskCount = 0;
    let unassignedTaskCount = 0;
    const teamBreakdownMap = new Map();
    const workersToNotify = [];
    const recordTeamWork = (team, isSubtask) => {
      if (!team) { unassignedTaskCount += 1; return; }
      if (!teamBreakdownMap.has(team.id)) teamBreakdownMap.set(team.id, { team_id: Number(team.id), team_name: team.name, task_count: 0, subtask_count: 0 });
      const entry = teamBreakdownMap.get(team.id);
      if (isSubtask) entry.subtask_count += 1; else entry.task_count += 1;
    };

    const maxPositionRow = await db.get('SELECT COALESCE(MAX(position),-1) AS maxPos FROM stories WHERE project_id=?', [project.id]);
    let nextPosition = Number(maxPositionRow.maxPos) + 1;
    for (const storyItem of Array.isArray(plan.stories) ? plan.stories : []) {
      const storyName = cleanString(storyItem?.name, 160);
      if (!storyName) continue;
      const departmentId = await resolveDepartment(storyItem?.department);
      const storyOwnerId = await resolveOwner(storyItem?.owner_id);
      const storyTeam = resolveTeam(storyItem?.team_name);
      const storyResult = await db.run(
        'INSERT INTO stories(project_id,name,description,owner_id,department_id,priority,status,start_date,due_date,position,team_id,ai_team_confidence,ai_team_reason,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [project.id, storyName, cleanString(storyItem?.description, 4000), storyOwnerId, departmentId, ['low', 'medium', 'high', 'critical'].includes(storyItem?.priority) ? storyItem.priority : 'medium', validStoryStatus(storyItem?.status), validDate(storyItem?.start_date), validDate(storyItem?.due_date), nextPosition, storyTeam?.id || null, storyTeam ? validTeamConfidence(storyItem?.team_confidence) : null, storyTeam ? cleanString(storyItem?.team_reason, 500) : '', user.id, now, now]
      );
      nextPosition += 1;
      storyCount += 1;
      for (const taskItem of Array.isArray(storyItem?.tasks) ? storyItem.tasks : []) {
        const taskTitle = cleanString(taskItem?.title, 220);
        if (!taskTitle) continue;
        const taskOwnerId = await resolveOwner(taskItem?.owner_id);
        const taskTeamOverride = resolveTeam(taskItem?.team_name);
        const taskTeam = taskTeamOverride || storyTeam;
        const taskResult = await db.run(
          `INSERT INTO tasks(project_id,phase,title,description,owner_id,priority,status,progress,acceptance_criteria,due_date,story_id,tags,estimated_hours,source_type,ai_generated,approved,rejected,team_id,ai_team_confidence,ai_team_reason,created_by,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [project.id, storyName.slice(0, 120), taskTitle, cleanString(taskItem?.description, 4000), taskOwnerId, ['low', 'medium', 'high', 'critical'].includes(taskItem?.priority) ? taskItem.priority : 'medium', validTaskStatus(taskItem?.status), 0, '', validDate(taskItem?.due_date), storyResult.lastInsertRowid, cleanTags(taskItem?.tags), cleanHours(taskItem?.estimated_hours), 'ai_brief', 1, 0, 0, taskTeam?.id || null, taskTeamOverride ? validTeamConfidence(taskItem?.team_confidence) : null, taskTeamOverride ? cleanString(taskItem?.team_reason, 500) : '', user.id, now, now]
        );
        taskCount += 1;
        recordTeamWork(taskTeam, false);
        if (taskOwnerId) workersToNotify.push({ taskId: taskResult.lastInsertRowid, taskTitle, ownerId: taskOwnerId });
        for (const subtaskItem of Array.isArray(taskItem?.subtasks) ? taskItem.subtasks : []) {
          const subtaskTitle = cleanString(subtaskItem?.title, 220);
          if (!subtaskTitle) continue;
          const subtaskOwnerId = await resolveOwner(subtaskItem?.owner_id);
          const subtaskTeamOverride = resolveTeam(subtaskItem?.team_name);
          const subtaskTeam = subtaskTeamOverride || taskTeam;
          const subtaskResult = await db.run(
            `INSERT INTO tasks(project_id,phase,title,description,owner_id,priority,status,progress,acceptance_criteria,due_date,story_id,parent_task_id,tags,estimated_hours,source_type,ai_generated,approved,rejected,team_id,ai_team_confidence,ai_team_reason,created_by,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [project.id, storyName.slice(0, 120), subtaskTitle, cleanString(subtaskItem?.description, 4000), subtaskOwnerId, ['low', 'medium', 'high', 'critical'].includes(subtaskItem?.priority) ? subtaskItem.priority : 'medium', validTaskStatus(subtaskItem?.status), 0, '', validDate(subtaskItem?.due_date), storyResult.lastInsertRowid, taskResult.lastInsertRowid, cleanTags(subtaskItem?.tags), cleanHours(subtaskItem?.estimated_hours), 'ai_brief', 1, 0, 0, subtaskTeam?.id || null, subtaskTeamOverride ? validTeamConfidence(subtaskItem?.team_confidence) : null, subtaskTeamOverride ? cleanString(subtaskItem?.team_reason, 500) : '', user.id, now, now]
          );
          subtaskCount += 1;
          recordTeamWork(subtaskTeam, true);
          if (subtaskOwnerId) workersToNotify.push({ taskId: subtaskResult.lastInsertRowid, taskTitle: subtaskTitle, ownerId: subtaskOwnerId });
        }
      }
    }

    await db.run("UPDATE ai_brief_sessions SET status='converted',project_id=? WHERE id=?", [project.id, sessionId]);
    return {
      departmentCount, milestoneCount, riskCount, assumptionCount, storyCount, taskCount, subtaskCount,
      unassignedTaskCount, teamBreakdown: [...teamBreakdownMap.values()], workersToNotify,
      projectId: project.id, projectName: project.name, organizationId: project.organization_id
    };
  });

  const teamsNotified = [];
  const teamsWithoutManager = [];
  for (const entry of summary.teamBreakdown) {
    const team = teamById.get(entry.team_id);
    const leadUserId = team?.lead_user_id ? Number(team.lead_user_id) : null;
    if (leadUserId) {
      const taskWord = entry.task_count === 1 ? 'task' : 'tasks';
      const subtaskWord = entry.subtask_count === 1 ? 'subtask' : 'subtasks';
      await notifyUser(
        leadUserId, 'team_work', 'New work for your team',
        `${entry.task_count} ${taskWord} and ${entry.subtask_count} ${subtaskWord} from "${summary.projectName}" need review.`,
        summary.organizationId, `teams:${entry.team_id}`
      );
      await activity(leadUserId, 'team_work_assigned', 'New team work assigned', `${entry.team_name}: ${entry.task_count} tasks, ${entry.subtask_count} subtasks from "${summary.projectName}"`, summary.organizationId);
      teamsNotified.push({ team_id: entry.team_id, team_name: entry.team_name, manager_id: leadUserId });
    } else {
      teamsWithoutManager.push({ team_id: entry.team_id, team_name: entry.team_name });
    }
  }

  for (const worker of summary.workersToNotify) {
    if (Number(worker.ownerId) === Number(user.id)) continue;
    await notifyUser(worker.ownerId, 'task_assignment', 'New task assigned to you', `"${worker.taskTitle}" was assigned to you.`, summary.organizationId, `work:${worker.taskId}`);
    await activity(worker.ownerId, 'task_assigned', 'New task assigned to you', worker.taskTitle, summary.organizationId);
    await audit(summary.organizationId, summary.projectId, user.id, 'task', worker.taskId, 'assigned', { previous_owner_id: null, new_owner_id: worker.ownerId });
  }

  const { workersToNotify: _workersToNotify, ...summaryForResponse } = summary;
  await audit(summary.organizationId, summary.projectId, user.id, 'ai_brief_session', sessionId, 'converted', summaryForResponse);
  jsonResponse(res, 200, {
    committed: true, project_id: summary.projectId, ...summaryForResponse,
    teams_notified: teamsNotified, teams_without_manager: teamsWithoutManager,
    team_breakdown: summary.teamBreakdown, unassigned_task_count: summary.unassignedTaskCount
  });
});

route('POST', '/api/brief-sessions/:sessionId/regenerate', async ({ res, user, params }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const session = await db.get('SELECT * FROM ai_brief_sessions WHERE id=?', [sessionId]);
  if (!session) throw new HttpError(404, 'Brief analysis session not found');
  if (session.status !== 'ready_for_review') throw new HttpError(409, 'This brief analysis is not ready to be regenerated (it may already be converted, or analysis has not completed).');
  const { project } = await briefSessionAccess(user.id, session, FULL_ACCESS_ROLES);
  const members = await activeOrganizationMembers(project.organization_id);
  const teams = await activeOrganizationTeams(project.organization_id);
  const analysis = await ai.analyzeProjectBrief(project, members, session.raw_text, undefined, teams);
  await db.run("UPDATE ai_brief_sessions SET status='discarded' WHERE id=?", [sessionId]);
  const now = db.utcnow();
  const result = await db.run(
    `INSERT INTO ai_brief_sessions(project_id,organization_id,client_name,project_name,source_type,source_filename,file_mime,file_size,original_file,raw_text,status,generated_json,created_by,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [session.project_id, session.organization_id, session.client_name, session.project_name, session.source_type, session.source_filename, session.file_mime, session.file_size, session.original_file, session.raw_text, 'ready_for_review', JSON.stringify(analysis.item), user.id, now]
  );
  jsonResponse(res, 201, { session_id: result.lastInsertRowid, plan: analysis.item, project_fields: analysis.project || null, ai_provider: analysis.provider, fallback_used: analysis.fallback, warning: analysis.warning || null });
});

async function briefSessionForScopedAction(userId, sessionId) {
  const session = await db.get('SELECT * FROM ai_brief_sessions WHERE id=?', [sessionId]);
  if (!session) throw new HttpError(404, 'Brief analysis session not found');
  if (session.status !== 'ready_for_review') throw new HttpError(409, 'This brief analysis is not ready to be edited (it may already be converted, or analysis has not completed).');
  const { project } = await briefSessionAccess(userId, session, FULL_ACCESS_ROLES);
  const members = await activeOrganizationMembers(project.organization_id);
  const teams = await activeOrganizationTeams(project.organization_id);
  return { session, project, members, teams };
}

route('POST', '/api/brief-sessions/:sessionId/regenerate-story', async ({ res, user, params, body }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const { session, project, members, teams } = await briefSessionForScopedAction(user.id, sessionId);
  const story = body.story && typeof body.story === 'object' ? body.story : {};
  const storyName = requiredString(story.name, 'Story name', 1, 160);
  const result = await ai.regenerateBriefStory(project, members, session.raw_text, { name: storyName, description: cleanString(story.description, 4000) }, teams);
  jsonResponse(res, 200, { tasks: result.tasks, ai_provider: result.provider, fallback_used: result.fallback, warning: result.warning || null });
});

route('POST', '/api/brief-sessions/:sessionId/regenerate-task', async ({ res, user, params, body }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const { session, project, members, teams } = await briefSessionForScopedAction(user.id, sessionId);
  const task = body.task && typeof body.task === 'object' ? body.task : {};
  const taskTitle = requiredString(task.title, 'Task title', 1, 220);
  const result = await ai.regenerateBriefTask(project, members, session.raw_text, { title: taskTitle, description: cleanString(task.description, 4000) }, teams);
  jsonResponse(res, 200, { subtasks: result.subtasks, ai_provider: result.provider, fallback_used: result.fallback, warning: result.warning || null });
});

route('POST', '/api/brief-sessions/:sessionId/ai-edit', async ({ res, user, params, body }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const { session, project, members, teams } = await briefSessionForScopedAction(user.id, sessionId);
  const story = body.story && typeof body.story === 'object' ? body.story : {};
  const storyName = requiredString(story.name, 'Story name', 1, 160);
  const instruction = requiredString(body.instruction, 'Instruction', 3, 500);
  const item = { name: storyName, description: cleanString(story.description, 4000), tasks: Array.isArray(story.tasks) ? story.tasks : [] };
  const result = await ai.applyBriefEditCommand(project, members, session.raw_text, item, instruction, teams);
  jsonResponse(res, 200, { tasks: result.tasks, ai_provider: result.provider, fallback_used: result.fallback, warning: result.warning || null });
});

const CLIENT_BRIEF_MIME_BY_EXTENSION = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

function guessClientAndProjectName(text) {
  const sample = String(text || '').slice(0, 3000);
  const clientMatch = sample.match(/^[ \t]*(?:client|customer|prepared for)[ \t]*:[ \t]*(.+)$/im);
  const projectMatch = sample.match(/^[ \t]*project(?:[ \t]*name|[ \t]*title)?[ \t]*:[ \t]*(.+)$/im);
  return {
    clientName: clientMatch ? clientMatch[1].trim().slice(0, 160) : '',
    projectName: projectMatch ? projectMatch[1].trim().slice(0, 160) : ''
  };
}

route('POST', '/api/organizations/:organizationId/client-briefs', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, FULL_ACCESS_ROLES);
  const rawText = requiredString(body.raw_text, 'Brief text', 10, 100000);
  const guessed = guessClientAndProjectName(rawText);
  const now = db.utcnow();
  const result = await db.run(
    `INSERT INTO ai_brief_sessions(project_id,organization_id,client_name,project_name,source_type,source_filename,file_mime,file_size,original_file,raw_text,status,generated_json,created_by,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [null, organizationId, guessed.clientName, guessed.projectName, 'paste', '', '', 0, null, rawText.slice(0, 100000), 'uploaded', '{}', user.id, now]
  );
  await audit(organizationId, null, user.id, 'ai_brief_session', result.lastInsertRowid, 'uploaded', { source: 'paste' });
  jsonResponse(res, 201, { session_id: result.lastInsertRowid, client_name: guessed.clientName, project_name: guessed.projectName });
});

route('POST', '/api/organizations/:organizationId/client-briefs/upload', async ({ req, res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, FULL_ACCESS_ROLES);
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw new HttpError(415, 'Content-Type must be multipart/form-data');
  const upload = await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
    let busboyInstance;
    try {
      busboyInstance = Busboy({ headers: req.headers, limits: { files: 1, fileSize: BRIEF_UPLOAD_MAX_BYTES } });
    } catch (error) {
      return settle(new HttpError(400, 'Invalid upload request'));
    }
    let found = null;
    let truncated = false;
    busboyInstance.on('file', (fieldname, stream, info) => {
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => { size += chunk.length; if (size <= BRIEF_UPLOAD_MAX_BYTES) chunks.push(chunk); });
      stream.on('limit', () => { truncated = true; });
      stream.on('close', () => { if (!found) found = { filename: info.filename, buffer: Buffer.concat(chunks) }; });
    });
    busboyInstance.on('close', () => {
      if (truncated) return settle(new HttpError(400, `File exceeds the ${Math.round(BRIEF_UPLOAD_MAX_BYTES / (1024 * 1024))}MB limit`));
      if (!found || !found.buffer.length) return settle(new HttpError(400, 'No file was uploaded'));
      settle(null, found);
    });
    busboyInstance.on('error', error => settle(error));
    req.pipe(busboyInstance);
  });
  let cleanedText;
  try {
    const text = await extractBriefText(upload.filename, upload.buffer);
    cleanedText = String(text || '').trim();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Unable to read this client brief.');
  }
  if (!cleanedText) throw new HttpError(400, 'Unable to read this client brief.');
  const extension = (String(upload.filename || '').split('.').pop() || '').toLowerCase();
  const fileMime = CLIENT_BRIEF_MIME_BY_EXTENSION[extension] || 'application/octet-stream';
  const guessed = guessClientAndProjectName(cleanedText);
  const now = db.utcnow();
  const result = await db.run(
    `INSERT INTO ai_brief_sessions(project_id,organization_id,client_name,project_name,source_type,source_filename,file_mime,file_size,original_file,raw_text,status,generated_json,created_by,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [null, organizationId, guessed.clientName, guessed.projectName, 'upload', upload.filename, fileMime, upload.buffer.length, upload.buffer, cleanedText.slice(0, 100000), 'uploaded', '{}', user.id, now]
  );
  await audit(organizationId, null, user.id, 'ai_brief_session', result.lastInsertRowid, 'uploaded', { filename: upload.filename });
  jsonResponse(res, 201, {
    session_id: result.lastInsertRowid, filename: upload.filename, file_mime: fileMime, file_size: upload.buffer.length,
    client_name: guessed.clientName, project_name: guessed.projectName
  });
}, { rawBody: true });

route('GET', '/api/organizations/:organizationId/client-briefs', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  const sessions = await db.all(
    `SELECT s.id,s.project_id,s.client_name,s.project_name,s.source_type,s.source_filename,s.file_mime,s.file_size,s.status,s.created_at,
            u.full_name AS created_by_name, p.name AS generated_project_name
     FROM ai_brief_sessions s
     LEFT JOIN users u ON u.id = s.created_by
     LEFT JOIN projects p ON p.id = s.project_id
     WHERE s.organization_id=? AND s.status <> 'discarded'
     ORDER BY s.created_at DESC`,
    [organizationId]
  );
  jsonResponse(res, 200, sessions);
});

route('GET', '/api/client-briefs/:sessionId', async ({ res, user, params }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const session = await db.get(
    `SELECT s.id,s.project_id,s.organization_id,s.client_name,s.project_name,s.source_type,s.source_filename,s.file_mime,s.file_size,s.raw_text,s.status,s.generated_json,s.created_at,
            u.full_name AS created_by_name, p.name AS generated_project_name
     FROM ai_brief_sessions s LEFT JOIN users u ON u.id=s.created_by LEFT JOIN projects p ON p.id=s.project_id
     WHERE s.id=?`,
    [sessionId]
  );
  if (!session) throw new HttpError(404, 'Client brief not found');
  await requireMembership(user.id, Number(session.organization_id));
  const { generated_json, ...rest } = session;
  let plan = {};
  try { plan = JSON.parse(generated_json || '{}'); } catch { plan = {}; }
  jsonResponse(res, 200, { ...rest, plan });
});

route('POST', '/api/client-briefs/:sessionId/analyze', async ({ res, user, params, body }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const session = await db.get('SELECT * FROM ai_brief_sessions WHERE id=?', [sessionId]);
  if (!session) throw new HttpError(404, 'Client brief not found');
  if (!['uploaded', 'failed'].includes(session.status)) throw new HttpError(409, 'This brief is not in a state that can be analyzed right now.');
  const { project } = await briefSessionAccess(user.id, session, FULL_ACCESS_ROLES);
  const streamToken = cleanString(body.stream_token, 80);
  const onProgress = streamToken ? (step, detail) => broadcastBriefProgress(streamToken, { step, detail }) : undefined;
  const members = await activeOrganizationMembers(session.organization_id);
  const teams = await activeOrganizationTeams(session.organization_id);
  const clientName = body.client_name !== undefined ? cleanString(body.client_name, 160) : session.client_name;
  const projectName = body.project_name !== undefined ? cleanString(body.project_name, 160) : session.project_name;
  await db.run('UPDATE ai_brief_sessions SET status=?,client_name=?,project_name=? WHERE id=?', ['analyzing', clientName, projectName, sessionId]);
  try {
    const contextProject = { ...project, name: projectName || project.name };
    const analysis = await ai.analyzeProjectBrief(contextProject, members, session.raw_text, onProgress, teams);
    if (streamToken) broadcastBriefProgress(streamToken, { step: 'done', detail: 'Analysis complete' });
    await db.run("UPDATE ai_brief_sessions SET status='ready_for_review',generated_json=? WHERE id=?", [JSON.stringify(analysis.item), sessionId]);
    await audit(session.organization_id, session.project_id, user.id, 'ai_brief_session', sessionId, 'analyzed', { provider: analysis.provider, fallback: analysis.fallback });
    jsonResponse(res, 200, { session_id: sessionId, plan: analysis.item, project_fields: analysis.project || null, ai_provider: analysis.provider, fallback_used: analysis.fallback, warning: analysis.warning || null });
  } catch (error) {
    await db.run("UPDATE ai_brief_sessions SET status='failed' WHERE id=?", [sessionId]);
    if (streamToken) broadcastBriefProgress(streamToken, { step: 'failed', detail: 'Client brief was uploaded successfully, but analysis could not be completed.' });
    throw error;
  }
});

route('GET', '/api/client-briefs/:sessionId/download', async ({ res, user, params }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const session = await db.get('SELECT organization_id,original_file,file_mime,source_filename FROM ai_brief_sessions WHERE id=?', [sessionId]);
  if (!session) throw new HttpError(404, 'Client brief not found');
  await requireMembership(user.id, Number(session.organization_id));
  if (!session.original_file) throw new HttpError(404, 'No original file was stored for this brief.');
  const buffer = Buffer.isBuffer(session.original_file) ? session.original_file : Buffer.from(session.original_file);
  const safeFilename = String(session.source_filename || 'client-brief').replace(/["\r\n]/g, '');
  textResponse(res, 200, buffer, session.file_mime || 'application/octet-stream', { 'Content-Disposition': `attachment; filename="${safeFilename}"` });
});

route('DELETE', '/api/client-briefs/:sessionId', async ({ res, user, params }) => {
  const sessionId = integer(params.sessionId, 'session id');
  const session = await db.get('SELECT organization_id FROM ai_brief_sessions WHERE id=?', [sessionId]);
  if (!session) throw new HttpError(404, 'Client brief not found');
  await requireMembership(user.id, Number(session.organization_id), FULL_ACCESS_ROLES);
  await db.run('DELETE FROM ai_brief_sessions WHERE id=?', [sessionId]);
  await audit(session.organization_id, null, user.id, 'ai_brief_session', sessionId, 'deleted', {});
  jsonResponse(res, 200, { removed: true });
});

route('POST', '/api/projects/:projectId/meeting-notes', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, FULL_ACCESS_ROLES);
  const notes = requiredString(body.notes, 'Meeting notes', 5, 30000);
  await db.run('INSERT INTO source_records(project_id,record_type,content,created_by,created_at) VALUES(?,?,?,?,?)', [projectId, 'meeting_notes', notes, user.id, db.utcnow()]);
  const aiResult = await ai.generateMeetingSuggestions(notes, await activeOrganizationMembers(project.organization_id), project);
  const proposals = aiResult.items;
  const ids = [];
  for (const proposal of proposals) {
    const inserted = await db.run(
      'INSERT INTO suggestions(project_id,suggestion_type,payload_json,rationale,evidence,status,created_at) VALUES(?,?,?,?,?,?,?)',
      [projectId, proposal.suggestion_type, JSON.stringify(proposal.payload), proposal.rationale, proposal.evidence, 'pending', db.utcnow()]
    );
    ids.push(inserted.lastInsertRowid);
  }
  await audit(project.organization_id, projectId, user.id, 'project', projectId, 'meeting_notes_processed', { suggestion_ids: ids, provider: aiResult.provider, fallback: aiResult.fallback });
  jsonResponse(res, 201, { created_suggestion_ids: ids, ai_provider: aiResult.provider, fallback_used: aiResult.fallback, message: 'Meeting-note proposals created for review.' });
});

route('GET', '/api/projects/:projectId/suggestions', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  const items = await db.all('SELECT * FROM suggestions WHERE project_id=? ORDER BY created_at DESC', [projectId]);
  items.forEach(item => {
    try { item.payload = JSON.parse(item.payload_json); } catch { item.payload = {}; }
  });
  jsonResponse(res, 200, items);
});

route('POST', '/api/suggestions/:suggestionId/approve', async ({ res, user, params }) => {
  const suggestionId = integer(params.suggestionId, 'suggestion id');
  const suggestion = await db.get('SELECT * FROM suggestions WHERE id=?', [suggestionId]);
  if (!suggestion) throw new HttpError(404, 'Suggestion not found');
  const { project } = await projectWithAccess(user.id, Number(suggestion.project_id), FULL_ACCESS_ROLES);
  if (suggestion.status !== 'pending') throw new HttpError(409, 'Suggestion has already been reviewed');
  let payload = {};
  try { payload = JSON.parse(suggestion.payload_json); } catch {}
  let createdEntity = null;
  if (suggestion.suggestion_type === 'task') {
    const owner = payload.owner_name ? await db.get(
      `SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id
       WHERE m.organization_id=? AND m.status='active' AND lower(u.full_name)=lower(?) LIMIT 1`,
      [project.organization_id, payload.owner_name]
    ) : null;
    const result = await db.run(
      `INSERT INTO tasks(project_id,phase,title,description,owner_id,priority,status,progress,acceptance_criteria,source_type,ai_generated,approved,rejected,created_by,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [suggestion.project_id, payload.phase || 'Meeting Follow-up', payload.title || 'Meeting follow-up', payload.description || '', owner?.id || null, ['low','medium','high','critical'].includes(payload.priority) ? payload.priority : 'medium', 'not_started', 0, payload.acceptance_criteria || '', 'meeting_note', 1, 1, 0, user.id, db.utcnow(), db.utcnow()]
    );
    createdEntity = { type: 'task', id: result.lastInsertRowid };
  } else if (suggestion.suggestion_type === 'decision') {
    const result = await db.run('INSERT INTO decisions(project_id,title,detail,owner,status,source,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', [suggestion.project_id, payload.title || 'Meeting decision', payload.detail || suggestion.evidence, payload.owner || '', 'approved', 'meeting_note', user.id, db.utcnow()]);
    createdEntity = { type: 'decision', id: result.lastInsertRowid };
  } else if (suggestion.suggestion_type === 'risk') {
    const result = await db.run('INSERT INTO risks(project_id,risk_type,severity,title,description,evidence,status,ai_generated,approved,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [suggestion.project_id, payload.risk_type || 'meeting_note', payload.severity || 'medium', payload.title || 'Meeting risk', payload.description || suggestion.evidence, suggestion.evidence, 'open', 1, 1, db.utcnow(), db.utcnow()]);
    createdEntity = { type: 'risk', id: result.lastInsertRowid };
  }
  await db.run("UPDATE suggestions SET status='approved',reviewed_at=?,reviewed_by=? WHERE id=?", [db.utcnow(), user.id, suggestionId]);
  await audit(project.organization_id, suggestion.project_id, user.id, 'suggestion', suggestionId, 'approved', createdEntity || {});
  jsonResponse(res, 200, { status: 'approved', created_entity: createdEntity });
});

route('POST', '/api/suggestions/:suggestionId/reject', async ({ res, user, params }) => {
  const suggestionId = integer(params.suggestionId, 'suggestion id');
  const suggestion = await db.get('SELECT * FROM suggestions WHERE id=?', [suggestionId]);
  if (!suggestion) throw new HttpError(404, 'Suggestion not found');
  const { project } = await projectWithAccess(user.id, Number(suggestion.project_id), FULL_ACCESS_ROLES);
  if (suggestion.status !== 'pending') throw new HttpError(409, 'Suggestion has already been reviewed');
  await db.run("UPDATE suggestions SET status='rejected',reviewed_at=?,reviewed_by=? WHERE id=?", [db.utcnow(), user.id, suggestionId]);
  await audit(project.organization_id, suggestion.project_id, user.id, 'suggestion', suggestionId, 'rejected');
  jsonResponse(res, 200, { status: 'rejected' });
});
