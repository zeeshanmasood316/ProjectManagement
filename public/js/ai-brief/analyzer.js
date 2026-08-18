import { state } from '../state.js';
import { ICONS } from '../format.js';
import { mountDialog, closeDialog, setButtonBusy, toast } from '../ui.js';
import { api } from '../api.js';
import { openBriefReviewDialog } from './review.js';

export function updateBriefProgress(container, step, detail) {
  if (!container) return;
  let line = container.querySelector(`[data-step="${step}"]`);
  if (!line) {
    container.querySelectorAll('li').forEach(el => { el.classList.remove('active'); el.classList.add('done'); const mark = el.querySelector('.step-mark'); if (mark) mark.textContent = '✓'; });
    line = document.createElement('li');
    line.dataset.step = step;
    line.innerHTML = '<span class="step-mark">●</span><span class="step-label"></span>';
    container.appendChild(line);
  }
  line.classList.add('active');
  line.classList.remove('done');
  line.querySelector('.step-label').textContent = detail;
  if (step === 'done') {
    container.querySelectorAll('li').forEach(el => { el.classList.remove('active'); el.classList.add('done'); const mark = el.querySelector('.step-mark'); if (mark) mark.textContent = '✓'; });
  }
}

export function openBriefAnalyzerDialog() {
  const overlay = document.createElement('div');
  overlay.id = 'briefAnalyzerDialog';
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `<div class="dialog-card wide">
    <div class="dialog-head full"><h2 id="briefAnalyzerTitle">AI Project Brief Analyzer</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close" data-tooltip="Close">${ICONS.x}</button></div>
    <form id="briefAnalyzerForm" class="stack">
      <div class="notice">Upload a project brief (.txt, .md, .pdf, or .docx) or paste text below. The AI proposes a structured plan — stories, tasks, subtasks, departments, milestones, risks, and assumptions — for you to review before anything is created. Nothing is written to your project until you accept it.</div>
      <label>Upload document<input type="file" name="file" accept=".txt,.md,.markdown,.pdf,.docx"></label>
      <label class="full">Or paste brief text<textarea name="raw_text" rows="8" placeholder="Paste the project brief here..."></textarea></label>
      <div id="briefProgressWrap" hidden><p class="small muted" style="margin:10px 0 0">Processing…</p><ul class="brief-progress-steps" id="briefProgressSteps"></ul></div>
      <div class="full actions"><button class="primary" type="submit">Analyze brief</button></div>
    </form>
  </div>`;
  mountDialog(overlay, 'briefAnalyzerTitle');
  overlay.querySelector('#briefAnalyzerForm').addEventListener('submit', async event => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const submitter = event.submitter;
    const fileInput = formElement.querySelector('input[type="file"]');
    const textArea = formElement.querySelector('textarea[name="raw_text"]');
    const progressWrap = formElement.querySelector('#briefProgressWrap');
    const progressSteps = formElement.querySelector('#briefProgressSteps');
    setButtonBusy(submitter, true, 'Analyzing…');
    let source = null;
    try {
      let rawText = textArea.value.trim();
      let sourceType = 'paste';
      let sourceFilename = '';
      if (fileInput.files[0]) {
        const uploadBody = new FormData();
        uploadBody.append('file', fileInput.files[0]);
        const uploadResult = await api(`/api/projects/${state.projectId}/brief-analysis/upload`, { method: 'POST', body: uploadBody, timeoutMs: 60_000 });
        rawText = uploadResult.text;
        sourceType = 'upload';
        sourceFilename = uploadResult.filename;
      }
      if (!rawText) throw new Error('Upload a document or paste brief text.');
      progressWrap.hidden = false;
      const token = crypto.randomUUID();
      source = new EventSource(`/api/brief-analysis/progress?token=${encodeURIComponent(token)}`);
      source.onmessage = event => {
        try { const payload = JSON.parse(event.data); updateBriefProgress(progressSteps, payload.step, payload.detail); } catch {}
      };
      await new Promise(resolve => { source.onopen = resolve; setTimeout(resolve, 600); });
      const analysis = await api(`/api/projects/${state.projectId}/brief-analysis`, { method: 'POST', timeoutMs: 120_000, body: JSON.stringify({ source_type: sourceType, source_filename: sourceFilename, raw_text: rawText, stream_token: token }) });
      closeDialog(overlay);
      openBriefReviewDialog(analysis);
      toast(analysis.fallback_used ? 'Brief analyzed with local fallback.' : `Brief analyzed with ${analysis.ai_provider}.`);
    } catch (error) { toast(error.message, true); } finally { source?.close(); setButtonBusy(submitter, false); }
  });
}
