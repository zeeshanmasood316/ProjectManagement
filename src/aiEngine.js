'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const provider = require('./aiProvider');

function clean(value) {
  return String(value || '').trim();
}

function chooseOwner(members, keywords = []) {
  if (!members.length) return null;
  const scored = members.map(member => {
    const haystack = `${member.full_name || ''} ${member.username || ''} ${member.role || ''}`.toLowerCase();
    const score = keywords.reduce((total, keyword) => total + (haystack.includes(keyword) ? 1 : 0), 0);
    return { id: member.user_id || member.id, score };
  }).sort((a, b) => b.score - a.score || a.id - b.id);
  return scored[0]?.id || null;
}

// AI may only suggest a team; below this confidence (0-100) the item stays Unassigned
// rather than being routed, and a suggested name that isn't a real org team is never used.
const TEAM_CONFIDENCE_THRESHOLD = 40;
const TEAM_MATCH_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'team', 'department', 'build', 'create', 'implement', 'develop', 'work', 'task']);

function significantWords(text) {
  return [...new Set(String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [])].filter(word => word.length > 2 && !TEAM_MATCH_STOPWORDS.has(word));
}

function teamSummary(teams) {
  return (teams || []).map(team => ({ id: Number(team.id), name: clean(team.name), department_name: clean(team.department_name) }));
}

// Deterministic, no-API-key fallback: score real team names against an item's own text by shared
// significant words. Used so team routing still works when no external AI provider is configured.
function chooseTeamLocally(teams, text) {
  const itemWords = significantWords(text);
  if (!teams.length || !itemWords.length) return { team_name: '', team_confidence: null, team_reason: '' };
  const scored = teams.map(team => {
    const teamWords = significantWords(`${team.name} ${team.department_name || ''}`);
    const overlap = itemWords.filter(word => teamWords.includes(word));
    return { team, overlap };
  }).sort((a, b) => b.overlap.length - a.overlap.length);
  const best = scored[0];
  if (!best || !best.overlap.length) return { team_name: '', team_confidence: null, team_reason: '' };
  const confidence = Math.min(95, 35 + best.overlap.length * 25);
  return { team_name: best.team.name, team_confidence: confidence, team_reason: `Local keyword match on: ${best.overlap.join(', ')}.` };
}

// Never trust a raw AI (or hand-authored) team suggestion: only a name that exactly matches a real
// org team, at or above the confidence threshold, is ever routed. Everything else becomes Unassigned.
function sanitizeTeamSuggestion(item, teams) {
  const validByLower = new Map((teams || []).map(team => [clean(team.name).toLowerCase(), clean(team.name)]));
  const rawName = clean(item?.team_name).slice(0, 120);
  const matched = rawName ? validByLower.get(rawName.toLowerCase()) : null;
  const confidenceValue = Number(item?.team_confidence);
  const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(100, Math.round(confidenceValue))) : null;
  if (!matched || confidence === null || confidence < TEAM_CONFIDENCE_THRESHOLD) {
    return { team_name: '', team_confidence: null, team_reason: '' };
  }
  return { team_name: matched, team_confidence: confidence, team_reason: clean(item?.team_reason).slice(0, 500) };
}

function proposePlan(project, members, brief = '') {
  const objective = clean(project.objective) || clean(brief) || `Deliver ${project.name}`;
  const pm = chooseOwner(members, ['ceo', 'admin', 'moderator', 'project']);
  const builder = chooseOwner(members, ['developer', 'engineer', 'backend', 'frontend', 'member']);
  const reviewer = chooseOwner(members, ['moderator', 'admin', 'quality', 'test']);
  const tasks = [
    ['Discovery', 'Confirm objectives and success measures', `Confirm the intended outcome for: ${objective}`, pm, 'high', 'Objectives, success measures, constraints, and unresolved questions are documented and approved.', []],
    ['Discovery', 'Validate scope and assumptions', `Review the stored scope, constraints, assumptions, and source brief for ${project.name}.`, pm, 'high', 'Scope boundaries and assumptions are traceable to approved records.', [0]],
    ['Planning', 'Create delivery milestones', 'Convert the approved scope into sequenced milestones with owners and measurable outcomes.', pm, 'high', 'Milestones, owners, dependencies, and review points are recorded.', [1]],
    ['Design', 'Prepare solution and user workflow', 'Define the proposed workflow, data needs, permissions, and acceptance criteria.', builder, 'medium', 'The proposed design is reviewed and covers the approved scope.', [1]],
    ['Build', 'Implement approved project scope', 'Build only the approved requirements and record implementation evidence.', builder, 'high', 'Approved requirements are implemented and linked to verification evidence.', [2, 3]],
    ['Quality', 'Verify acceptance criteria', 'Test the implemented work against stored acceptance criteria and record defects.', reviewer, 'high', 'Verification results and unresolved defects are recorded.', [4]],
    ['Launch', 'Complete launch readiness review', 'Review security, support, documentation, communications, and rollback readiness.', pm, 'high', 'Launch readiness is approved by an authorized workspace manager.', [5]],
    ['Operations', 'Publish factual project update', 'Generate a status update from stored task, risk, decision, and change records.', pm, 'medium', 'The update contains no unsupported completion claims.', [6]]
  ];
  return tasks.map(([phase, title, description, ownerId, priority, acceptanceCriteria, depends]) => ({
    phase,
    title,
    description,
    owner_id: ownerId,
    priority,
    status: 'not_started',
    progress: 0,
    acceptance_criteria: acceptanceCriteria,
    due_date: null,
    depends_on_proposal_indexes: depends
  }));
}

function parseMeetingNotes(notes, members) {
  const memberNames = members.map(member => member.full_name).filter(Boolean);
  const sentences = String(notes).split(/(?<=[.!?])\s+|\n+/).map(value => value.trim()).filter(value => value.length >= 5);
  const suggestions = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const ownerName = memberNames.find(name => lower.includes(name.toLowerCase())) || '';
    if (/\b(decided|decision|agreed|approved)\b/.test(lower)) {
      suggestions.push({
        suggestion_type: 'decision',
        payload: { title: sentence.slice(0, 120), detail: sentence, owner: ownerName },
        rationale: 'Decision-oriented language was detected.',
        evidence: sentence
      });
    } else if (/\b(blocked|blocker|waiting|cannot|dependency|risk)\b/.test(lower)) {
      suggestions.push({
        suggestion_type: 'risk',
        payload: { risk_type: 'meeting_note', severity: /critical|urgent/.test(lower) ? 'high' : 'medium', title: sentence.slice(0, 120), description: sentence },
        rationale: 'Risk or blocker language was detected.',
        evidence: sentence
      });
    } else if (/\b(will|must|needs? to|action|follow[- ]?up|todo|assign)\b/.test(lower)) {
      suggestions.push({
        suggestion_type: 'task',
        payload: {
          phase: 'Meeting Follow-up',
          title: sentence.slice(0, 120),
          description: sentence,
          owner_name: ownerName,
          priority: /urgent|critical|must/.test(lower) ? 'high' : 'medium',
          acceptance_criteria: 'The stated follow-up is completed and supporting evidence is recorded.'
        },
        rationale: 'Action-oriented language was detected.',
        evidence: sentence
      });
    }
  }
  if (!suggestions.length) {
    suggestions.push({
      suggestion_type: 'clarification',
      payload: { question: 'No explicit action, decision, or blocker was detected. Please review the notes manually.' },
      rationale: 'The notes did not contain sufficiently explicit project language.',
      evidence: String(notes).slice(0, 300)
    });
  }
  return suggestions;
}

function analyzeChange(description, taskCount, activeOwnerCounts) {
  const lower = String(description).toLowerCase();
  const overloaded = Object.entries(activeOwnerCounts).filter(([, count]) => count >= 5).map(([name]) => name);
  return {
    impact_scope: /\b(add|new|extra|include|support)\b/.test(lower) ? 'Likely scope expansion' : 'Scope effect requires review',
    impact_effort: /\b(redesign|migration|integration|replace|all users)\b/.test(lower) ? 'High' : 'Medium',
    impact_dependencies: taskCount ? 'Re-check downstream build, test, and delivery dependencies.' : 'No stored tasks exist; dependency effect cannot yet be measured.',
    impact_workload: overloaded.length ? `Potential overload for: ${overloaded.join(', ')}` : 'No current owner overload is shown by stored active-task counts.'
  };
}

function risk(type, severity, title, description, evidence) {
  return { risk_type: type, severity, title, description, evidence };
}

function scanRisks(tasks, members, dependencies) {
  const results = [];
  const memberMap = new Map(members.map(member => [Number(member.user_id || member.id), member]));
  const taskMap = new Map(tasks.map(task => [Number(task.id), task]));
  const activeByOwner = new Map();
  const today = new Date().toISOString().slice(0, 10);

  for (const task of tasks) {
    if (task.status !== 'done' && task.owner_id) {
      const list = activeByOwner.get(Number(task.owner_id)) || [];
      list.push(task);
      activeByOwner.set(Number(task.owner_id), list);
    }
    if (!task.owner_id && task.status !== 'done') results.push(risk('ownership', 'medium', `Unowned task: ${task.title}`, 'The task has no responsible owner.', `Task #${task.id} owner_id is empty.`));
    if (task.status === 'blocked') results.push(risk('blocker', 'high', `Blocked task: ${task.title}`, 'The stored task state is blocked.', `Task #${task.id} status=blocked.`));
    if (task.status === 'done' && Number(task.progress) < 100) results.push(risk('conflict', 'high', `Contradictory task record: ${task.title}`, 'A completed task has progress below 100%.', `Task #${task.id} status=done but progress=${task.progress}%.`));
    if (task.status === 'not_started' && Number(task.progress) > 0) results.push(risk('conflict', 'medium', `Contradictory task record: ${task.title}`, 'A not-started task has recorded progress.', `Task #${task.id} status=not_started but progress=${task.progress}%.`));
    if (['high', 'critical'].includes(task.priority) && !clean(task.acceptance_criteria)) results.push(risk('requirement', 'medium', `Missing completion criteria: ${task.title}`, 'A high-priority task lacks acceptance criteria.', `Task #${task.id} acceptance_criteria is empty.`));
    if (task.due_date && task.status !== 'done' && /^\d{4}-\d{2}-\d{2}$/.test(task.due_date) && task.due_date < today) results.push(risk('schedule', 'high', `Overdue task: ${task.title}`, 'The task due date has passed and it is not complete.', `Task #${task.id} due_date=${task.due_date}, status=${task.status}.`));
  }

  for (const [ownerId, ownerTasks] of activeByOwner.entries()) {
    const member = memberMap.get(ownerId);
    const capacity = Number(member?.capacity || 5);
    if (ownerTasks.length > capacity) {
      const name = member?.full_name || `User ${ownerId}`;
      results.push(risk('workload', 'high', `Owner workload exceeds capacity: ${name}`, `${ownerTasks.length} active tasks exceed the stored capacity of ${capacity}.`, `Active task IDs: ${ownerTasks.map(task => task.id).join(', ')}`));
    }
  }

  for (const dependency of dependencies) {
    const task = taskMap.get(Number(dependency.task_id));
    const prerequisite = taskMap.get(Number(dependency.depends_on_task_id));
    if (task && prerequisite && ['in_progress', 'done'].includes(task.status) && prerequisite.status !== 'done') {
      results.push(risk('dependency', 'high', `Unresolved prerequisite for: ${task.title}`, 'Work has advanced while a prerequisite is not complete.', `Task #${task.id} depends on task #${prerequisite.id} with status=${prerequisite.status}.`));
    }
  }
  return results;
}

function externalModelEnabled() {
  return provider.enabled();
}

function aiStatus() {
  return provider.status();
}

function memberSummary(members) {
  return (members || []).map(member => ({
    user_id: Number(member.user_id || member.id),
    full_name: member.full_name || '',
    role: member.role || '',
    department: member.department || 'General',
    capacity: Number(member.capacity || 5)
  }));
}

function projectContext(project, extra = {}) {
  return {
    id: Number(project.id),
    name: clean(project.name),
    objective: clean(project.objective),
    scope: clean(project.scope),
    constraints: clean(project.constraints),
    assumptions: clean(project.assumptions),
    status: clean(project.status),
    ...extra
  };
}

const planSchema = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          phase: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          owner_id: { type: ['integer', 'null'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          acceptance_criteria: { type: 'string' },
          due_date: { type: ['string', 'null'] },
          depends_on_proposal_indexes: { type: 'array', items: { type: 'integer' } }
        },
        required: ['phase', 'title', 'description', 'owner_id', 'priority', 'acceptance_criteria', 'due_date', 'depends_on_proposal_indexes']
      }
    }
  },
  required: ['tasks']
};

async function generatePlan(project, members, brief = '') {
  if (!provider.enabled()) return { items: proposePlan(project, members, brief), provider: 'local_javascript_engine', fallback: true };
  const allowedOwners = new Set(memberSummary(members).map(member => member.user_id));
  try {
    const result = await provider.generateJson({
      system: 'You are a senior project delivery planner. Build a practical, project-specific work breakdown from the supplied facts. Never invent named people, approvals, completed work, or requirements that are not present. Tasks are proposals and must be reviewable by a human.',
      prompt: `Create 6 to 14 sequenced tasks for this project. Make titles concrete, descriptions actionable, and acceptance criteria measurable. Use only owner_id values from the provided members, or null. Dependency indexes are zero-based indexes into the returned tasks array and must only point backward. Use YYYY-MM-DD for a due date only when the supplied project information provides enough schedule information; otherwise use null.\n\nProject:\n${JSON.stringify(projectContext(project, { brief: clean(brief) }))}\n\nMembers:\n${JSON.stringify(memberSummary(members))}`,
      schema: planSchema,
      reason: 'generate_plan',
      context: `project:${project?.id ?? 'draft'}`
    });
    const items = (Array.isArray(result.tasks) ? result.tasks : []).slice(0, 14).map((task, index) => ({
      phase: clean(task.phase).slice(0, 120) || 'Planning',
      title: clean(task.title).slice(0, 220) || `Project task ${index + 1}`,
      description: clean(task.description).slice(0, 10000),
      owner_id: allowedOwners.has(Number(task.owner_id)) ? Number(task.owner_id) : null,
      priority: ['low', 'medium', 'high', 'critical'].includes(task.priority) ? task.priority : 'medium',
      status: 'not_started',
      progress: 0,
      acceptance_criteria: clean(task.acceptance_criteria).slice(0, 10000),
      due_date: /^\d{4}-\d{2}-\d{2}$/.test(clean(task.due_date)) ? clean(task.due_date) : null,
      depends_on_proposal_indexes: [...new Set((Array.isArray(task.depends_on_proposal_indexes) ? task.depends_on_proposal_indexes : [])
        .map(Number).filter(dep => Number.isInteger(dep) && dep >= 0 && dep < index))]
    })).filter(task => task.title);
    if (items.length < 3) throw new Error('AI returned too few usable tasks');
    return { items, provider: `${provider.providerName()}:${config.externalAi.model}`, fallback: false };
  } catch (error) {
    console.error('External AI plan generation failed; using local fallback:', error.message);
    return { items: proposePlan(project, members, brief), provider: 'local_javascript_engine', fallback: true, warning: error.message };
  }
}

const briefAnalysisSchema = {
  type: 'object',
  properties: {
    project: { type: 'object', properties: {
      name: { type: 'string' }, client_name: { type: 'string' }, objective: { type: 'string' }, scope: { type: 'string' },
      constraints: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      start_date: { type: ['string', 'null'] }, due_date: { type: ['string', 'null'] }
    }, required: ['name', 'client_name', 'objective', 'scope', 'constraints', 'priority', 'start_date', 'due_date'] },
    departments: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, source: { type: 'string', enum: ['brief', 'inferred'] }, source_note: { type: 'string' }
    }, required: ['name', 'source', 'source_note'] } },
    milestones: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, due_date: { type: ['string', 'null'] }, source: { type: 'string', enum: ['brief', 'inferred'] }, source_note: { type: 'string' }
    }, required: ['name', 'due_date', 'source', 'source_note'] } },
    risks: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, description: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, source: { type: 'string', enum: ['brief', 'inferred'] }, source_note: { type: 'string' }
    }, required: ['title', 'description', 'severity', 'source', 'source_note'] } },
    assumptions: { type: 'array', items: { type: 'object', properties: {
      text: { type: 'string' }, source: { type: 'string', enum: ['brief', 'inferred'] }, source_note: { type: 'string' }
    }, required: ['text', 'source', 'source_note'] } },
    stories: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, description: { type: 'string' }, department: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      status: { type: 'string', enum: ['not_started', 'in_progress', 'at_risk', 'done'] }, start_date: { type: ['string', 'null'] },
      source: { type: 'string', enum: ['brief', 'inferred'] }, source_note: { type: 'string' },
      team_name: { type: 'string' }, team_confidence: { type: 'integer' }, team_reason: { type: 'string' },
      tasks: { type: 'array', items: { type: 'object', properties: {
        title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        status: { type: 'string', enum: ['not_started', 'in_progress', 'blocked', 'done'] }, due_date: { type: ['string', 'null'] },
        tags: { type: 'array', items: { type: 'string' } }, estimated_hours: { type: ['number', 'null'] },
        source: { type: 'string', enum: ['brief', 'inferred'] }, source_note: { type: 'string' },
        team_name: { type: 'string' }, team_confidence: { type: 'integer' }, team_reason: { type: 'string' },
        subtasks: { type: 'array', items: { type: 'object', properties: {
          title: { type: 'string' }, status: { type: 'string', enum: ['not_started', 'in_progress', 'blocked', 'done'] },
          tags: { type: 'array', items: { type: 'string' } }, estimated_hours: { type: ['number', 'null'] },
          source: { type: 'string', enum: ['brief', 'inferred'] }, source_note: { type: 'string' },
          team_name: { type: 'string' }, team_confidence: { type: 'integer' }, team_reason: { type: 'string' }
        }, required: ['title', 'status', 'tags', 'estimated_hours', 'source', 'source_note', 'team_name', 'team_confidence', 'team_reason'] } }
      }, required: ['title', 'description', 'priority', 'status', 'due_date', 'tags', 'estimated_hours', 'source', 'source_note', 'team_name', 'team_confidence', 'team_reason', 'subtasks'] } }
    }, required: ['name', 'description', 'department', 'priority', 'status', 'start_date', 'source', 'source_note', 'team_name', 'team_confidence', 'team_reason', 'tasks'] } }
  },
  required: ['project', 'departments', 'milestones', 'risks', 'assumptions', 'stories']
};

const storyTasksSchema = { type: 'object', properties: { tasks: briefAnalysisSchema.properties.stories.items.properties.tasks }, required: ['tasks'] };
const taskSubtasksSchema = { type: 'object', properties: { subtasks: briefAnalysisSchema.properties.stories.items.properties.tasks.items.properties.subtasks }, required: ['subtasks'] };

function sanitizeBriefSource(item) {
  return { source: item?.source === 'brief' ? 'brief' : 'inferred', source_note: clean(item?.source_note).slice(0, 500) };
}

// Sanitizes the AI-extracted project-level fields (name/client/objective/scope/constraints/
// priority/dates) the same defensive way team suggestions are handled: never trust raw model
// output, clamp lengths, and only accept dates/priority that match the expected format/enum.
function sanitizeProjectFields(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const validDate = candidate => /^\d{4}-\d{2}-\d{2}$/.test(clean(candidate)) ? clean(candidate) : null;
  return {
    name: clean(value.name).slice(0, 160),
    client_name: clean(value.client_name).slice(0, 160),
    objective: clean(value.objective).slice(0, 2000),
    scope: clean(value.scope).slice(0, 4000),
    constraints: clean(value.constraints).slice(0, 4000),
    priority: ['low', 'medium', 'high', 'critical'].includes(value.priority) ? value.priority : 'medium',
    start_date: validDate(value.start_date),
    due_date: validDate(value.due_date)
  };
}

// Deterministic, no-API-key fallback for project-field extraction: only pulls text that is
// explicitly labeled in the brief (e.g. "Objective: ..."), or the brief's own opening sentence
// for the objective — never invents content, so unlabeled fields are simply left blank.
function localExtractLabeledField(text, labelPattern) {
  const match = text.match(new RegExp(`^[ \\t]*(?:${labelPattern})[ \\t]*:[ \\t]*(.+)$`, 'im'));
  return match ? match[1].trim() : '';
}

function localExtractLabeledDate(text, labelPattern) {
  const value = localExtractLabeledField(text, labelPattern);
  const match = value.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function localProjectFieldExtraction(rawText) {
  const text = String(rawText || '').slice(0, 4000);
  const objectiveLabel = localExtractLabeledField(text, 'objective|goal|purpose');
  const firstSentence = clean(text.split(/(?<=[.!?])\s+/)[0]).slice(0, 300);
  const priorityLabel = localExtractLabeledField(text, 'priority').toLowerCase();
  return {
    name: localExtractLabeledField(text, 'project(?:\\s*name|\\s*title)?').slice(0, 160),
    client_name: localExtractLabeledField(text, 'client|customer|prepared for').slice(0, 160),
    objective: (objectiveLabel || firstSentence).slice(0, 2000),
    scope: localExtractLabeledField(text, 'scope').slice(0, 4000),
    constraints: localExtractLabeledField(text, 'constraints?|limitations?').slice(0, 4000),
    priority: ['low', 'medium', 'high', 'critical'].includes(priorityLabel) ? priorityLabel : (/\b(urgent|critical|asap)\b/i.test(text) ? 'high' : 'medium'),
    start_date: localExtractLabeledDate(text, 'start(?:\\s*date)?'),
    due_date: localExtractLabeledDate(text, 'due(?:\\s*date)?|deadline|end(?:\\s*date)?')
  };
}

function sanitizeGeneratedSubtasks(subtasks, teams = []) {
  return (Array.isArray(subtasks) ? subtasks : []).slice(0, 15).map(subtask => ({
    title: clean(subtask.title).slice(0, 220) || 'Untitled subtask',
    status: ['not_started', 'in_progress', 'blocked', 'done'].includes(subtask.status) ? subtask.status : 'not_started',
    tags: Array.isArray(subtask.tags) ? subtask.tags.map(tag => clean(tag, 40)).filter(Boolean).slice(0, 8) : [],
    estimated_hours: subtask.estimated_hours !== null && subtask.estimated_hours !== undefined && Number.isFinite(Number(subtask.estimated_hours)) && Number(subtask.estimated_hours) >= 0 ? Number(subtask.estimated_hours) : null,
    ...sanitizeBriefSource(subtask),
    ...sanitizeTeamSuggestion(subtask, teams)
  })).filter(subtask => subtask.title);
}

function sanitizeGeneratedTasks(tasks, teams = []) {
  return (Array.isArray(tasks) ? tasks : []).slice(0, 25).map(task => ({
    title: clean(task.title).slice(0, 220) || 'Untitled task',
    description: clean(task.description).slice(0, 4000),
    priority: ['low', 'medium', 'high', 'critical'].includes(task.priority) ? task.priority : 'medium',
    status: ['not_started', 'in_progress', 'blocked', 'done'].includes(task.status) ? task.status : 'not_started',
    due_date: /^\d{4}-\d{2}-\d{2}$/.test(clean(task.due_date)) ? clean(task.due_date) : null,
    tags: Array.isArray(task.tags) ? task.tags.map(tag => clean(tag, 40)).filter(Boolean).slice(0, 8) : [],
    estimated_hours: task.estimated_hours !== null && task.estimated_hours !== undefined && Number.isFinite(Number(task.estimated_hours)) && Number(task.estimated_hours) >= 0 ? Number(task.estimated_hours) : null,
    ...sanitizeBriefSource(task),
    ...sanitizeTeamSuggestion(task, teams),
    subtasks: sanitizeGeneratedSubtasks(task.subtasks, teams)
  })).filter(task => task.title);
}

function sanitizeGeneratedStories(stories, teams = []) {
  return (Array.isArray(stories) ? stories : []).slice(0, 20).map(story => ({
    name: clean(story.name).slice(0, 160) || 'Untitled story',
    description: clean(story.description).slice(0, 4000),
    department: clean(story.department).slice(0, 120),
    priority: ['low', 'medium', 'high', 'critical'].includes(story.priority) ? story.priority : 'medium',
    status: ['not_started', 'in_progress', 'at_risk', 'done'].includes(story.status) ? story.status : 'not_started',
    start_date: /^\d{4}-\d{2}-\d{2}$/.test(clean(story.start_date)) ? clean(story.start_date) : null,
    ...sanitizeBriefSource(story),
    ...sanitizeTeamSuggestion(story, teams),
    tasks: sanitizeGeneratedTasks(story.tasks, teams)
  })).filter(story => story.name && story.tasks.length);
}

function localTeamSuggestion(teams, text) {
  return sanitizeTeamSuggestion(chooseTeamLocally(teams, text), teams);
}

function localBriefAnalysis(project, members, rawText, teams = []) {
  const text = clean(rawText);
  const dateMatches = [...new Set([...text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map(match => match[1]))].slice(0, 8);
  const milestones = dateMatches.map(date => {
    const index = text.indexOf(date);
    const evidence = text.slice(Math.max(0, index - 60), index + 40).trim();
    return { name: `Milestone near ${date}`, due_date: date, source: 'brief', source_note: `Date found in the brief: "...${evidence}..."` };
  });
  const departmentNames = [...new Set(members.map(member => member.department).filter(Boolean))];
  const departments = departmentNames.map(name => ({ name, source: 'inferred', source_note: 'Inferred from existing organization member department assignments, not from the brief text.' }));
  const plan = proposePlan(project, members, rawText);
  const storyGroups = [
    { name: 'Discovery & Planning', phases: ['Discovery', 'Planning'] },
    { name: 'Design & Build', phases: ['Design', 'Build'] },
    { name: 'Quality & Launch', phases: ['Quality', 'Launch'] },
    { name: 'Operations', phases: ['Operations'] }
  ];
  const stories = storyGroups.map(group => ({
    name: group.name,
    description: `${group.name} work for ${clean(project.name)}.`,
    department: '',
    priority: 'medium',
    status: 'not_started',
    start_date: null,
    source: 'inferred',
    source_note: 'Generated from a standard delivery template because no AI provider is configured; not derived from specific brief content.',
    ...localTeamSuggestion(teams, group.name),
    tasks: plan.filter(task => group.phases.includes(task.phase)).map(task => ({
      title: task.title, description: task.description, priority: task.priority, due_date: task.due_date,
      status: 'not_started', tags: [], estimated_hours: null,
      source: 'inferred', source_note: 'Generated from a standard delivery template.',
      ...localTeamSuggestion(teams, `${task.title} ${task.description}`),
      subtasks: []
    }))
  })).filter(story => story.tasks.length);
  return { departments, milestones, risks: [], assumptions: [], stories };
}

// One Project Brief analysis = at most ONE external AI request (previously this fanned out into a
// "chunk digest" request per ~4000 characters of brief text plus one final request, which is what
// was driving briefs into Gemini's free-tier rate limits). The brief is already capped to 20000
// characters below, which comfortably fits a single request for the configured model, so the whole
// document is sent in one shot instead of being pre-digested by additional AI calls.
const ANALYSIS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ANALYSIS_CACHE_MAX_ENTRIES = 200;
const analysisCache = new Map(); // hash -> { result, expiresAt }
const analysisInFlight = new Map(); // hash -> Promise<result>

function briefAnalysisCacheKey(project, text, teams) {
  const teamNames = (teams || []).map(team => clean(team.name).toLowerCase()).sort().join(',');
  return crypto.createHash('sha256')
    .update(String(project?.organization_id ?? ''))
    .update('|').update(teamNames)
    .update('|').update(text)
    .digest('hex');
}

function getCachedBriefAnalysis(key) {
  const entry = analysisCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { analysisCache.delete(key); return null; }
  return entry.result;
}

function setCachedBriefAnalysis(key, result) {
  if (!analysisCache.has(key) && analysisCache.size >= ANALYSIS_CACHE_MAX_ENTRIES) {
    const oldestKey = analysisCache.keys().next().value;
    if (oldestKey !== undefined) analysisCache.delete(oldestKey);
  }
  analysisCache.set(key, { result, expiresAt: Date.now() + ANALYSIS_CACHE_TTL_MS });
}

function emitCachedBriefProgress(onProgress) {
  onProgress('project_info', 'Reading project information from your brief (cached — matches a recent identical brief)');
  onProgress('work_breakdown', 'Drafting stories and work breakdown (cached)');
  onProgress('tasks', 'Structuring tasks & subtasks (cached)');
  onProgress('team_recommendations', 'Reviewing team recommendations (cached)');
  onProgress('assignments', 'Preparing assignment options (cached)');
}

// Public entry point: dedupes identical in-flight analyses (e.g. a double-click or a duplicate
// frontend request for the same brief) onto a single shared request, and serves an exact repeat
// submission of the same brief straight from cache without calling the AI provider again.
async function analyzeProjectBrief(project, members, rawText, onProgress = () => {}, teams = []) {
  const text = clean(rawText).slice(0, 20000);
  if (!text) throw new Error('The brief text is empty.');

  if (!provider.enabled()) {
    return analyzeProjectBriefUncached(project, members, text, onProgress, teams);
  }

  const cacheKey = briefAnalysisCacheKey(project, text, teams);
  const cached = getCachedBriefAnalysis(cacheKey);
  if (cached) {
    emitCachedBriefProgress(onProgress);
    return cached;
  }

  const inFlight = analysisInFlight.get(cacheKey);
  if (inFlight) {
    const result = await inFlight;
    emitCachedBriefProgress(onProgress);
    return result;
  }

  const run = analyzeProjectBriefUncached(project, members, text, onProgress, teams).then(result => {
    if (!result.fallback) setCachedBriefAnalysis(cacheKey, result);
    return result;
  });
  analysisInFlight.set(cacheKey, run);
  try {
    return await run;
  } finally {
    analysisInFlight.delete(cacheKey);
  }
}

async function analyzeProjectBriefUncached(project, members, text, onProgress, teams) {
  if (!provider.enabled()) {
    onProgress('project_info', 'Reading project information from your brief');
    const projectFields = localProjectFieldExtraction(text);
    onProgress('work_breakdown', 'Drafting stories from a local template');
    const item = localBriefAnalysis(project, members, text, teams);
    onProgress('tasks', 'Generating tasks & subtasks');
    onProgress('team_recommendations', 'Matching teams to work items');
    onProgress('assignments', 'Preparing assignment options');
    return { item, project: projectFields, provider: 'local_javascript_engine', fallback: true };
  }
  try {
    onProgress('project_info', 'Extracting project information');
    onProgress('work_breakdown', 'Drafting stories and work breakdown');
    const result = await provider.generateJson({
      system: 'You are a senior delivery planner converting a project brief document into a structured, review-ready project plan. First extract top-level "project" fields: name (a concise project title only if the brief states or clearly implies one, else empty string), client_name (only if a specific client/customer/company name is mentioned, else empty string), objective (one to two sentences, grounded in the brief), scope (what is in scope per the brief), constraints (stated constraints/limitations, else empty string), priority (low/medium/high/critical — only pick something other than medium if urgency is clearly indicated), start_date and due_date (YYYY-MM-DD only if an explicit date or unambiguous timeframe is given, else null). Never invent a name, client, or date that is not supported by the brief — leave the field empty/null instead. Then extract objectives, deliverables, requirements, phases, departments, roles, work packages, milestones, risks, and assumptions. Organize work into Stories, each containing Tasks, each optionally containing Subtasks. For every single item you produce (department, milestone, risk, assumption, story, task, subtask) set "source" to "brief" only if it is explicitly stated or very directly implied by the brief text, and quote or closely paraphrase the supporting text in "source_note". Set "source" to "inferred" for anything you added using general project-delivery judgment rather than the brief itself, and say so plainly in "source_note" (e.g. "Not stated in the brief; added as a standard QA step"). Never invent named people, deadlines, or budgets that are not in the brief. For every story, task, and subtask, also suggest the single best-fit team by setting "team_name" to the EXACT name of one team from the provided list of real teams, or an empty string if none fit well — never invent a team name that is not in that list. Set "team_confidence" to an integer 0-100 reflecting how well the work matches that team’s remit, and "team_reason" to one short sentence. If the team list is empty, always use an empty team_name.',
      prompt: `Project: ${JSON.stringify(projectContext(project))}\nOrganization members (for department context only, do not assign owners): ${JSON.stringify(memberSummary(members))}\nReal teams in this organization (choose team_name only from here, or leave empty): ${JSON.stringify(teamSummary(teams).map(team => team.name))}\n\nBrief content:\n${text}`,
      schema: briefAnalysisSchema,
      reason: 'brief_analysis',
      context: `brief:${project?.id ?? 'draft'}`
    });
    onProgress('tasks', 'Structuring tasks & subtasks');
    const stories = sanitizeGeneratedStories(result.stories, teams);
    if (!stories.length) throw new Error('AI returned no usable stories');
    const sanitizeSource = sanitizeBriefSource;
    const departments = (Array.isArray(result.departments) ? result.departments : []).slice(0, 15).map(item => ({ name: clean(item.name).slice(0, 120), ...sanitizeSource(item) })).filter(item => item.name);
    const milestones = (Array.isArray(result.milestones) ? result.milestones : []).slice(0, 15).map(item => ({ name: clean(item.name).slice(0, 160), due_date: /^\d{4}-\d{2}-\d{2}$/.test(clean(item.due_date)) ? clean(item.due_date) : null, ...sanitizeSource(item) })).filter(item => item.name);
    const risks = (Array.isArray(result.risks) ? result.risks : []).slice(0, 15).map(item => ({ title: clean(item.title).slice(0, 220), description: clean(item.description).slice(0, 2000), severity: ['low', 'medium', 'high', 'critical'].includes(item.severity) ? item.severity : 'medium', ...sanitizeSource(item) })).filter(item => item.title);
    const assumptions = (Array.isArray(result.assumptions) ? result.assumptions : []).slice(0, 15).map(item => ({ text: clean(item.text).slice(0, 1000), ...sanitizeSource(item) })).filter(item => item.text);
    onProgress('team_recommendations', 'Reviewing team recommendations');
    onProgress('assignments', 'Preparing assignment options');
    const projectFields = sanitizeProjectFields(result.project);
    return { item: { departments, milestones, risks, assumptions, stories }, project: projectFields, provider: `${provider.providerName()}:${config.externalAi.model}`, fallback: false };
  } catch (error) {
    console.error('External AI brief analysis failed; using local fallback:', error.message);
    onProgress('project_info', 'Reading project information from your brief');
    const projectFields = localProjectFieldExtraction(text);
    onProgress('work_breakdown', 'Building project structure from a local template');
    const item = localBriefAnalysis(project, members, text, teams);
    onProgress('tasks', 'Generating tasks & subtasks');
    onProgress('team_recommendations', 'Matching teams to work items');
    onProgress('assignments', 'Preparing assignment options');
    return { item, project: projectFields, provider: 'local_javascript_engine', fallback: true, warning: error.message };
  }
}

async function regenerateBriefStory(project, members, rawText, story, teams = []) {
  const fallback = () => ({
    tasks: sanitizeGeneratedTasks([{ title: `Plan ${story.name}`, description: `Break down and plan the work for ${story.name}.`, priority: 'medium', status: 'not_started', due_date: null, tags: [], estimated_hours: null, source: 'inferred', source_note: 'Generated from a local template because no AI provider is configured.', ...localTeamSuggestion(teams, `${story.name} ${story.description || ''}`), subtasks: [] }], teams),
    provider: 'local_javascript_engine', fallback: true
  });
  if (!provider.enabled()) return fallback();
  try {
    const result = await provider.generateJson({
      system: 'You regenerate the Tasks (and their Subtasks) for ONE story within a larger project, using the original brief for context. Keep the story’s intent. For every task/subtask, set "source" to "brief" only if explicitly supported by the brief text (quote or paraphrase it in source_note), else "inferred" with an honest note. Do not invent named people, deadlines, or budgets not present in the brief. Also suggest "team_name" as the EXACT name of the single best-fit team from the provided real team list (or empty if none fit), with an integer 0-100 "team_confidence" and a one-sentence "team_reason". Never invent a team name not in that list.',
      prompt: `Project: ${JSON.stringify(projectContext(project))}\nMembers: ${JSON.stringify(memberSummary(members))}\nReal teams in this organization (choose team_name only from here, or leave empty): ${JSON.stringify(teamSummary(teams).map(team => team.name))}\nStory to regenerate: ${JSON.stringify({ name: story.name, description: story.description })}\n\nOriginal brief text:\n${clean(rawText).slice(0, 20000)}`,
      schema: storyTasksSchema,
      reason: 'regenerate_brief_story',
      context: `project:${project?.id ?? 'draft'}`
    });
    const tasks = sanitizeGeneratedTasks(result.tasks, teams);
    if (!tasks.length) throw new Error('AI returned no usable tasks');
    return { tasks, provider: `${provider.providerName()}:${config.externalAi.model}`, fallback: false };
  } catch (error) {
    console.error('Story regeneration failed; using local fallback:', error.message);
    return { ...fallback(), warning: error.message };
  }
}

async function regenerateBriefTask(project, members, rawText, task, teams = []) {
  const fallback = () => ({
    subtasks: sanitizeGeneratedSubtasks([
      { title: `Plan: ${task.title}`, status: 'not_started', tags: [], estimated_hours: null, source: 'inferred', source_note: 'Generated from a local template because no AI provider is configured.' },
      { title: `Implement: ${task.title}`, status: 'not_started', tags: [], estimated_hours: null, source: 'inferred', source_note: 'Generated from a local template because no AI provider is configured.' },
      { title: `Verify: ${task.title}`, status: 'not_started', tags: [], estimated_hours: null, source: 'inferred', source_note: 'Generated from a local template because no AI provider is configured.' }
    ], teams),
    provider: 'local_javascript_engine', fallback: true
  });
  if (!provider.enabled()) return fallback();
  try {
    const result = await provider.generateJson({
      system: 'You regenerate the Subtasks for ONE task within a larger project, using the original brief for context. For every subtask, set "source" to "brief" only if explicitly supported by the brief text, else "inferred" with an honest note. Do not invent facts not present in the brief. Also suggest "team_name" as the EXACT name of the single best-fit team from the provided real team list (or empty if none fit), with an integer 0-100 "team_confidence" and a one-sentence "team_reason". Never invent a team name not in that list.',
      prompt: `Project: ${JSON.stringify(projectContext(project))}\nReal teams in this organization (choose team_name only from here, or leave empty): ${JSON.stringify(teamSummary(teams).map(team => team.name))}\nTask to regenerate: ${JSON.stringify({ title: task.title, description: task.description })}\n\nOriginal brief text:\n${clean(rawText).slice(0, 20000)}`,
      schema: taskSubtasksSchema,
      reason: 'regenerate_brief_task',
      context: `project:${project?.id ?? 'draft'}`
    });
    const subtasks = sanitizeGeneratedSubtasks(result.subtasks, teams);
    if (!subtasks.length) throw new Error('AI returned no usable subtasks');
    return { subtasks, provider: `${provider.providerName()}:${config.externalAi.model}`, fallback: false };
  } catch (error) {
    console.error('Task regeneration failed; using local fallback:', error.message);
    return { ...fallback(), warning: error.message };
  }
}

async function applyBriefEditCommand(project, members, rawText, item, instruction, teams = []) {
  const cleanInstruction = clean(instruction).slice(0, 500);
  if (!cleanInstruction) throw new Error('Describe what you want the AI to change.');
  const unchanged = () => ({ tasks: sanitizeGeneratedTasks(item.tasks || [], teams), provider: 'local_javascript_engine', fallback: true });
  if (!provider.enabled()) return { ...unchanged(), warning: 'No AI provider is configured; the story was left unchanged.' };
  try {
    const result = await provider.generateJson({
      system: 'You revise ONE story’s Tasks (and Subtasks) inside a larger project, following the user’s specific instruction, using the original brief for supporting context. For every task/subtask, set "source" to "brief" only if explicitly supported by the brief text, else "inferred". Do not invent facts not present in the brief or instruction. Also suggest "team_name" as the EXACT name of the single best-fit team from the provided real team list (or empty if none fit), with an integer 0-100 "team_confidence" and a one-sentence "team_reason". Never invent a team name not in that list.',
      prompt: `Project: ${JSON.stringify(projectContext(project))}\nReal teams in this organization (choose team_name only from here, or leave empty): ${JSON.stringify(teamSummary(teams).map(team => team.name))}\nStory: ${JSON.stringify({ name: item.name, description: item.description })}\nCurrent tasks: ${JSON.stringify((item.tasks || []).map(task => ({ title: task.title, description: task.description })))}\nUser instruction: ${cleanInstruction}\n\nOriginal brief text:\n${clean(rawText).slice(0, 20000)}`,
      schema: storyTasksSchema,
      reason: 'apply_brief_edit_command',
      context: `project:${project?.id ?? 'draft'}`
    });
    const tasks = sanitizeGeneratedTasks(result.tasks, teams);
    if (!tasks.length) throw new Error('AI returned no usable tasks');
    return { tasks, provider: `${provider.providerName()}:${config.externalAi.model}`, fallback: false };
  } catch (error) {
    console.error('AI edit command failed; leaving story unchanged:', error.message);
    return { ...unchanged(), warning: error.message };
  }
}

const suggestionSchema = {
  type: 'object',
  properties: {
    suggestion: { type: 'string' },
    rationale: { type: 'string' }
  },
  required: ['suggestion', 'rationale']
};

function localFieldSuggestion({ fieldName, value, formContext = {} }) {
  const current = clean(value);
  const field = clean(fieldName).toLowerCase();
  const nearby = Object.entries(formContext || {}).filter(([, v]) => clean(v)).map(([k, v]) => `${k}: ${clean(v)}`).join('; ');
  if (field.includes('objective')) return `Deliver a clear, measurable outcome for ${clean(formContext.name) || 'the project'}, with agreed scope, owners, quality checks, and completion criteria.`;
  if (field.includes('scope')) return current || `Define the included deliverables, user-facing outcomes, integrations, quality requirements, and explicit out-of-scope items${nearby ? ` based on ${nearby}` : ''}.`;
  if (field.includes('acceptance')) return current || 'The expected outcome is completed, reviewed, testable, and supported by recorded evidence with no unresolved critical issues.';
  if (field.includes('description')) return current ? `${current}\n\nClarify the expected outcome, owner, dependencies, constraints, and verification evidence before completion.` : `Describe the requested work, expected outcome, dependencies, constraints, and how completion will be verified${nearby ? `. Context: ${nearby}` : '.'}`;
  if (field.includes('meeting')) return current || 'Summarize decisions, action items with owners, blockers, risks, deadlines, and unresolved questions from the meeting.';
  if (field.includes('message') || field === 'body') return current ? `${current}\n\nPlease confirm the owner, deadline, and next step.` : 'Share the update with the key context, current status, blocker (if any), owner, and next action.';
  if (field.includes('title') || field.includes('name')) return current || 'Clear action-oriented title';
  return current || `Add concise, specific information for ${clean(fieldName) || 'this field'}${nearby ? ` using this context: ${nearby}` : ''}.`;
}

async function suggestField({ fieldName, fieldLabel, value, formContext = {}, project = null, userInstruction = '' }) {
  if (!provider.enabled()) {
    return { suggestion: localFieldSuggestion({ fieldName: fieldLabel || fieldName, value, formContext }), rationale: 'Local smart suggestion. Connect an external AI key for fully generative suggestions.', provider: 'local_javascript_engine', fallback: true };
  }
  try {
    const result = await provider.generateJson({
      system: 'You are an inline writing assistant inside a project-management application. Improve or draft only the requested field. Preserve user intent, do not invent facts, and make the text ready to paste into the field.',
      prompt: `Field name: ${clean(fieldName)}\nField label: ${clean(fieldLabel)}\nCurrent value: ${clean(value)}\nOptional user instruction: ${clean(userInstruction)}\nOther fields in the same form: ${JSON.stringify(formContext || {})}\nCurrent project context: ${JSON.stringify(project || {})}\n\nReturn one strong suggestion. Keep short fields concise and textareas appropriately detailed.`,
      schema: suggestionSchema,
      reason: 'suggest_field',
      context: `field:${clean(fieldName).slice(0, 40)}`
    });
    return {
      suggestion: clean(result.suggestion).slice(0, 20000),
      rationale: clean(result.rationale).slice(0, 1000),
      provider: `${provider.providerName()}:${config.externalAi.model}`,
      fallback: false
    };
  } catch (error) {
    console.error('External AI field suggestion failed; using local fallback:', error.message);
    return { suggestion: localFieldSuggestion({ fieldName: fieldLabel || fieldName, value, formContext }), rationale: 'External AI was unavailable, so a local fallback suggestion was generated.', provider: 'local_javascript_engine', fallback: true, warning: error.message };
  }
}

const meetingSchema = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          suggestion_type: { type: 'string', enum: ['task', 'decision', 'risk', 'clarification'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          owner_name: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          evidence: { type: 'string' },
          rationale: { type: 'string' }
        },
        required: ['suggestion_type', 'title', 'detail', 'owner_name', 'priority', 'severity', 'evidence', 'rationale']
      }
    }
  },
  required: ['suggestions']
};

async function generateMeetingSuggestions(notes, members, project = null) {
  if (!provider.enabled()) return { items: parseMeetingNotes(notes, members), provider: 'local_javascript_engine', fallback: true };
  try {
    const result = await provider.generateJson({
      system: 'You convert meeting notes into review-ready project proposals. Use only explicit or strongly supported information from the notes. Evidence must quote or closely point to the relevant note content. If ownership is unclear, leave owner_name empty. Never invent decisions or completion claims.',
      prompt: `Project context: ${JSON.stringify(project || {})}\nKnown members: ${JSON.stringify(memberSummary(members))}\nMeeting notes:\n${notes}`,
      schema: meetingSchema,
      reason: 'meeting_suggestions',
      context: `project:${project?.id ?? 'unknown'}`
    });
    const items = (result.suggestions || []).slice(0, 30).map(item => {
      const type = ['task', 'decision', 'risk', 'clarification'].includes(item.suggestion_type) ? item.suggestion_type : 'clarification';
      if (type === 'task') return { suggestion_type: 'task', payload: { phase: 'Meeting Follow-up', title: clean(item.title).slice(0, 120), description: clean(item.detail), owner_name: clean(item.owner_name), priority: ['low','medium','high','critical'].includes(item.priority) ? item.priority : 'medium', acceptance_criteria: `The follow-up is completed and evidence is recorded: ${clean(item.detail).slice(0, 500)}` }, rationale: clean(item.rationale), evidence: clean(item.evidence) };
      if (type === 'decision') return { suggestion_type: 'decision', payload: { title: clean(item.title).slice(0, 120), detail: clean(item.detail), owner: clean(item.owner_name) }, rationale: clean(item.rationale), evidence: clean(item.evidence) };
      if (type === 'risk') return { suggestion_type: 'risk', payload: { risk_type: 'meeting_note', severity: ['low','medium','high','critical'].includes(item.severity) ? item.severity : 'medium', title: clean(item.title).slice(0, 120), description: clean(item.detail) }, rationale: clean(item.rationale), evidence: clean(item.evidence) };
      return { suggestion_type: 'clarification', payload: { question: clean(item.detail) || clean(item.title) }, rationale: clean(item.rationale), evidence: clean(item.evidence) };
    }).filter(item => item.evidence || item.payload?.question);
    if (!items.length) throw new Error('AI returned no usable meeting suggestions');
    return { items, provider: `${provider.providerName()}:${config.externalAi.model}`, fallback: false };
  } catch (error) {
    console.error('External AI meeting analysis failed; using local fallback:', error.message);
    return { items: parseMeetingNotes(notes, members), provider: 'local_javascript_engine', fallback: true, warning: error.message };
  }
}

const changeSchema = {
  type: 'object',
  properties: {
    impact_scope: { type: 'string' },
    impact_effort: { type: 'string' },
    impact_dependencies: { type: 'string' },
    impact_workload: { type: 'string' }
  },
  required: ['impact_scope', 'impact_effort', 'impact_dependencies', 'impact_workload']
};

async function analyzeChangeWithAi(description, taskCount, activeOwnerCounts, project = null, tasks = []) {
  if (!provider.enabled()) return { item: analyzeChange(description, taskCount, activeOwnerCounts), provider: 'local_javascript_engine', fallback: true };
  try {
    const result = await provider.generateJson({
      system: 'You are a project change-impact analyst. Analyze only the supplied project facts. Distinguish facts from likely effects and do not claim precise effort or dates without evidence.',
      prompt: `Change request: ${description}\nProject: ${JSON.stringify(project || {})}\nExisting task count: ${taskCount}\nActive owner workload counts: ${JSON.stringify(activeOwnerCounts)}\nExisting tasks: ${JSON.stringify((tasks || []).slice(0, 80).map(t => ({ id:t.id,title:t.title,status:t.status,priority:t.priority,owner_id:t.owner_id,phase:t.phase })))}`,
      schema: changeSchema,
      reason: 'analyze_change',
      context: `project:${project?.id ?? 'unknown'}`
    });
    return { item: { impact_scope: clean(result.impact_scope), impact_effort: clean(result.impact_effort), impact_dependencies: clean(result.impact_dependencies), impact_workload: clean(result.impact_workload) }, provider: `${provider.providerName()}:${config.externalAi.model}`, fallback: false };
  } catch (error) {
    console.error('External AI change analysis failed; using local fallback:', error.message);
    return { item: analyzeChange(description, taskCount, activeOwnerCounts), provider: 'local_javascript_engine', fallback: true, warning: error.message };
  }
}

const taskRegenerationSchema = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    acceptance_criteria: { type: 'string' }
  },
  required: ['description', 'acceptance_criteria']
};

async function regenerateTask(task, project, members) {
  const fallback = {
    description: `Complete '${task.title}' using only approved project records. Record evidence, unresolved questions, and verification results.`,
    acceptance_criteria: task.acceptance_criteria || 'The expected outcome is complete, reviewed, and supported by stored evidence.'
  };
  if (!provider.enabled()) return { item: fallback, provider: 'local_javascript_engine', fallback: true };
  try {
    const result = await provider.generateJson({
      system: 'You improve a project task without changing its approved intent. Produce an actionable description and measurable acceptance criteria. Do not invent project facts.',
      prompt: `Project: ${JSON.stringify(projectContext(project))}\nTask: ${JSON.stringify({ id: task.id, phase: task.phase, title: task.title, description: task.description, priority: task.priority, acceptance_criteria: task.acceptance_criteria })}\nMembers: ${JSON.stringify(memberSummary(members))}`,
      schema: taskRegenerationSchema,
      reason: 'regenerate_task',
      context: `task:${task?.id ?? 'unknown'}`
    });
    return { item: { description: clean(result.description).slice(0,10000), acceptance_criteria: clean(result.acceptance_criteria).slice(0,10000) }, provider: `${provider.providerName()}:${config.externalAi.model}`, fallback: false };
  } catch (error) {
    console.error('External AI task regeneration failed; using local fallback:', error.message);
    return { item: fallback, provider: 'local_javascript_engine', fallback: true, warning: error.message };
  }
}


const riskSchema = {
  type: 'object',
  properties: {
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          risk_type: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          title: { type: 'string' },
          description: { type: 'string' },
          evidence: { type: 'string' }
        },
        required: ['risk_type', 'severity', 'title', 'description', 'evidence']
      }
    }
  },
  required: ['risks']
};

async function scanRisksWithAi(tasks, members, dependencies, project = null) {
  const deterministic = scanRisks(tasks, members, dependencies);
  if (!provider.enabled()) return { items: deterministic, provider: 'local_javascript_engine', fallback: true };
  try {
    const result = await provider.generateJson({
      system: 'You are a cautious project risk analyst. Identify only risks supported by stored data. Evidence must reference concrete task IDs, statuses, due dates, ownership, dependencies, or explicit project constraints. Do not invent market, security, staffing, or schedule facts.',
      prompt: `Project: ${JSON.stringify(project || {})}\nMembers: ${JSON.stringify(memberSummary(members))}\nTasks: ${JSON.stringify((tasks || []).slice(0,120).map(t => ({id:t.id,phase:t.phase,title:t.title,owner_id:t.owner_id,priority:t.priority,status:t.status,progress:t.progress,acceptance_criteria:t.acceptance_criteria,due_date:t.due_date})))}\nDependencies: ${JSON.stringify((dependencies || []).slice(0,240))}\n\nReturn the most material evidence-backed risks only.`,
      schema: riskSchema,
      reason: 'scan_risks',
      context: `project:${project?.id ?? 'unknown'}`
    });
    const aiItems = (result.risks || []).slice(0, 25).map(item => ({
      risk_type: clean(item.risk_type).slice(0,80) || 'ai_analysis',
      severity: ['low','medium','high','critical'].includes(item.severity) ? item.severity : 'medium',
      title: clean(item.title).slice(0,220),
      description: clean(item.description).slice(0,10000),
      evidence: clean(item.evidence).slice(0,5000)
    })).filter(item => item.title && item.evidence);
    const combined = [...deterministic];
    const seen = new Set(combined.map(item => `${item.risk_type}|${item.title}`.toLowerCase()));
    for (const item of aiItems) {
      const key = `${item.risk_type}|${item.title}`.toLowerCase();
      if (!seen.has(key)) { seen.add(key); combined.push(item); }
    }
    return { items: combined.slice(0, 40), provider: `${provider.providerName()}:${config.externalAi.model}`, fallback: false };
  } catch (error) {
    console.error('External AI risk scan failed; using local fallback:', error.message);
    return { items: deterministic, provider: 'local_javascript_engine', fallback: true, warning: error.message };
  }
}

module.exports = {
  proposePlan, parseMeetingNotes, analyzeChange, scanRisks, externalModelEnabled, aiStatus,
  generatePlan, suggestField, generateMeetingSuggestions, analyzeChangeWithAi, regenerateTask, scanRisksWithAi,
  analyzeProjectBrief, regenerateBriefStory, regenerateBriefTask, applyBriefEditCommand
};
