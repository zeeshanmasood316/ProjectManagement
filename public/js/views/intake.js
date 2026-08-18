import { state } from '../state.js';
import { escapeHtml, ICONS, canManage, formatFileSize } from '../format.js';
import { pageHead } from '../dispatch.js';

// Intake wizard state is shared across this render module, the central event dispatcher
// (events.js), and the AI brief review dialog (ai-brief/review.js). It is kept as a single
// mutable object (rather than several module-level `let`s) so every module that needs to
// mutate a field can do so through the same live object reference.
export const intakeState = {
  step: 'brief', // 'brief' | 'details'
  sessionId: null,
  analysis: null,
  guessed: { clientName: '', projectName: '' },
  extractedFields: null,
  details: null,
  attachedFile: null
};

export function resetIntakeState() {
  intakeState.step = 'brief';
  intakeState.sessionId = null;
  intakeState.analysis = null;
  intakeState.guessed = { clientName: '', projectName: '' };
  intakeState.extractedFields = null;
  intakeState.details = null;
  intakeState.attachedFile = null;
}

export function renderIntake() {
  if (!canManage()) return '<div class="notice danger">Only CEO, admin, or moderator can create a project.</div>';
  return intakeState.step === 'details' && intakeState.analysis ? renderIntakeDetailsStep() : renderIntakeBriefStep();
}

export function renderIntakeBriefStep() {
  const attached = intakeState.attachedFile
    ? `<div class="intake-attached-file"><span>${ICONS.fileText} ${escapeHtml(intakeState.attachedFile.name)} <span class="small muted">(${formatFileSize(intakeState.attachedFile.size)})</span></span><button type="button" class="icon-button" data-action="intake-remove-file" aria-label="Remove file" data-tooltip="Remove file">${ICONS.x}</button></div>`
    : '';
  return `${pageHead('New project', 'Describe the project or attach a brief — VibeManagement drafts the Stories, Tasks and Subtasks automatically.')}
  <div class="card intake-composer">
    <form id="intakeBriefForm" class="stack">
      <textarea name="raw_text" rows="7" placeholder="Describe this project in your own words — goals, scope, key deliverables, deadlines... Or attach a brief file below." autofocus ${intakeState.attachedFile ? 'disabled' : ''}></textarea>
      <input type="file" id="intakeFileInput" accept=".txt,.md,.markdown,.pdf,.docx" hidden>
      ${attached}
      <div class="actions" style="justify-content:space-between;align-items:center">
        <button type="button" class="secondary" data-action="intake-attach">${ICONS.upload} Attach brief file</button>
        <button type="submit" class="primary">${ICONS.send} Send</button>
      </div>
      <div id="intakeProgressWrap" hidden><p class="small muted" style="margin:10px 0 0">Analyzing Project Brief…</p><ul class="brief-progress-steps" id="intakeProgressSteps"></ul></div>
    </form>
  </div>`;
}

export function renderIntakeDetailsStep() {
  const ownerOptions = `<option value="">Me (${escapeHtml(state.user.full_name)})</option>${state.members.filter(member => member.status === 'active' && Number(member.user_id) !== Number(state.user.id)).map(member => `<option value="${member.user_id}">${escapeHtml(member.full_name)} (${escapeHtml(member.role)})</option>`).join('')}`;
  const plan = intakeState.analysis?.plan;
  const taskCount = plan ? (plan.stories || []).reduce((sum, story) => sum + (story.tasks || []).length, 0) : 0;
  const fields = intakeState.extractedFields || {};
  const autoFilledAnything = Boolean(fields.objective || fields.scope || fields.constraints || fields.start_date || fields.due_date || (fields.priority && fields.priority !== 'medium'));
  const summaryLine = plan
    ? `<div class="notice">Drafted ${(plan.stories || []).length} stories and ${taskCount} tasks from your brief.${autoFilledAnything ? ' We’ve also pre-filled the project details below from what your brief mentioned — review and adjust anything before continuing.' : ' Add a few project details below, then continue to review the breakdown and assign teams/workers.'}</div>`
    : '';
  const backAction = `<button type="button" class="secondary" data-action="intake-back-to-brief">${ICONS.arrowLeft} Back</button>`;
  return `${pageHead('Project details', 'A few details before we create the project.', backAction)}
  ${summaryLine}
  <form id="intakeDetailsForm" class="card form-grid">
    <label>Project name<input name="name" required value="${escapeHtml(intakeState.guessed.projectName || '')}"></label>
    <label>Client name<input name="client_name" value="${escapeHtml(intakeState.guessed.clientName || '')}"></label>
    <label>Objective<input name="objective" value="${escapeHtml(fields.objective || '')}"></label>
    <label class="full">Scope<textarea name="scope">${escapeHtml(fields.scope || '')}</textarea></label>
    <label>Constraints<textarea name="constraints">${escapeHtml(fields.constraints || '')}</textarea></label>
    <label>Assigned To<select name="owner_id">${ownerOptions}</select></label>
    <label>Priority<select name="priority">${['low', 'medium', 'high', 'critical'].map(value => `<option value="${value}" ${(fields.priority || 'medium') === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
    <label>Start date<input name="start_date" type="date" value="${escapeHtml(fields.start_date || '')}"></label>
    <label>Due date<input name="due_date" type="date" value="${escapeHtml(fields.due_date || '')}"></label>
    <div class="full actions"><button class="primary" type="submit">Continue to Stories &amp; Assignment</button></div>
  </form>`;
}
