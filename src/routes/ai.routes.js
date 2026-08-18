'use strict';

const ai = require('../ai/engine');
const { route } = require('../middleware/router');
const { jsonResponse } = require('../middleware/http');
const { cleanString, integer } = require('../utils/validation');
const { projectWithAccess } = require('../services/access');

route('GET', '/api/ai/status', async ({ res }) => {
  jsonResponse(res, 200, ai.aiStatus());
});

route('POST', '/api/ai/suggest', async ({ res, user, body }) => {
  const fieldName = cleanString(body.field_name, 120);
  const fieldLabel = cleanString(body.field_label, 160);
  const value = cleanString(body.value, 20000);
  const userInstruction = cleanString(body.instruction, 1000);
  const rawContext = body.form_context && typeof body.form_context === 'object' && !Array.isArray(body.form_context) ? body.form_context : {};
  const formContext = {};
  for (const [key, rawValue] of Object.entries(rawContext).slice(0, 30)) {
    formContext[cleanString(key, 80)] = cleanString(rawValue, 4000);
  }
  let project = null;
  if (body.project_id) {
    const projectId = integer(body.project_id, 'project id');
    const access = await projectWithAccess(user.id, projectId);
    project = {
      id: access.project.id,
      name: access.project.name,
      objective: access.project.objective,
      scope: access.project.scope,
      constraints: access.project.constraints,
      assumptions: access.project.assumptions,
      status: access.project.status
    };
  }
  const result = await ai.suggestField({ fieldName, fieldLabel, value, formContext, project, userInstruction });
  jsonResponse(res, 200, result);
});
