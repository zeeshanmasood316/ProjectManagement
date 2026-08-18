'use strict';

// Opt-in demo/test data seeder for manual QA. Talks to a RUNNING server over its normal public
// HTTP API — the exact same requests a real user or the browser frontend would make — so it never
// touches auth, permission, or database logic directly, and never needs to change any of it.
//
// This is intentionally separate from `npm run seed` / `scripts/reset.js`, which wipe the local
// database back to empty (see that file's own comment: "This project no longer creates demo
// records"). This script does the opposite on purpose, and only runs when you explicitly ask for it.
//
// Usage:
//   1. Start the app:            npm run dev
//   2. In another terminal:      node scripts/seed-demo.js
//      (or: npm run seed:demo)
//
// Safe to re-run — every step checks for existing data first and reuses/skips it, so re-running
// this script never creates duplicate accounts, departments, teams, or projects.
//
// Point at a different running instance with SEED_BASE_URL=http://host:port.

const BASE_URL = process.env.SEED_BASE_URL || 'http://127.0.0.1:8000';
const PASSWORD = 'DemoPass123!';
const ORG_NAME = 'Demo Organization';

async function request(pathname, { method = 'GET', token = '', body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(BASE_URL + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data };
}

function isoDate(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

// One flat, deliberately uniform pool of plain first/last names, used for every person in the
// exact same fixed order regardless of role. The CEO, every manager, and every employee are drawn
// from the identical pool with the identical naming style — nothing about a name here signals a
// nationality, ethnicity, religion, or culture, and no role is ever paired with a different-looking
// name pool than any other role.
const PEOPLE = [
  { first: 'Jordan', last: 'Bennett', role: 'ceo' },
  { first: 'Taylor', last: 'Coleman', role: 'manager', department: 'Engineering' },
  { first: 'Morgan', last: 'Sullivan', role: 'manager', department: 'Design' },
  { first: 'Casey', last: 'Whitfield', role: 'manager', department: 'Marketing' },
  { first: 'Riley', last: 'Ashford', role: 'manager', department: 'Operations' },
  { first: 'Alex', last: 'Bishop', role: 'employee', department: 'Engineering' },
  { first: 'Sam', last: 'Pierce', role: 'employee', department: 'Engineering' },
  { first: 'Drew', last: 'Foster', role: 'employee', department: 'Engineering' },
  { first: 'Jamie', last: 'Hartley', role: 'employee', department: 'Design' },
  { first: 'Avery', last: 'Mitchell', role: 'employee', department: 'Design' },
  { first: 'Reese', last: 'Donovan', role: 'employee', department: 'Marketing' },
  { first: 'Quinn', last: 'Lawson', role: 'employee', department: 'Marketing' },
  { first: 'Rowan', last: 'Griffin', role: 'employee', department: 'Operations' },
  { first: 'Skyler', last: 'Brennan', role: 'employee', department: 'Operations' }
];

for (const person of PEOPLE) {
  person.username = `demo.${person.first.toLowerCase()}.${person.last.toLowerCase()}`;
  person.email = `${person.username}@example.com`;
  person.fullName = `${person.first} ${person.last}`;
}

const DEPARTMENTS = ['Engineering', 'Design', 'Marketing', 'Operations'];

async function registerOrLogin(person) {
  const registered = await request('/api/auth/register', {
    method: 'POST',
    body: { username: person.username, email: person.email, full_name: person.fullName, password: PASSWORD }
  });
  if (registered.status === 201) {
    person.userId = registered.data.user.id;
    person.token = registered.data.token;
    return 'created';
  }
  const login = await request('/api/auth/login', { method: 'POST', body: { identifier: person.username, password: PASSWORD } });
  if (login.status !== 200) throw new Error(`Could not register or log in ${person.username}: ${JSON.stringify(login.data)}`);
  person.userId = login.data.user.id;
  person.token = login.data.token;
  return 'existing';
}

async function ensureOrganization(ceo) {
  const list = await request('/api/organizations', { token: ceo.token });
  const existing = (list.data || []).find(org => org.name === ORG_NAME);
  if (existing) return existing.id;
  const created = await request('/api/organizations', { method: 'POST', token: ceo.token, body: { name: ORG_NAME } });
  if (created.status !== 201) throw new Error(`Could not create organization: ${JSON.stringify(created.data)}`);
  return created.data.id;
}

// Every demo account (managers included) is invited and approved with proposed_role "member" —
// in this app's real permission model, "manager" is not a separate organization role; it comes
// entirely from being set as a department's manager_user_id / a team's lead_user_id, exactly like
// an admin would do it from the Teams screen. Only ceo/admin/moderator may send invitations, so
// the CEO sends every invitation here; each person accepts and the CEO approves, same as the UI.
async function ensureMember(orgId, ceo, person) {
  const members = await request(`/api/organizations/${orgId}/members`, { token: ceo.token });
  const existing = (members.data || []).find(m => Number(m.user_id) === Number(person.userId) && m.status === 'active');
  if (existing) return existing;
  const invite = await request(`/api/organizations/${orgId}/invitations`, {
    method: 'POST', token: ceo.token,
    body: { identifier: person.username, proposed_role: 'member', proposed_department: person.department || 'General' }
  });
  if (invite.status !== 201) throw new Error(`Could not invite ${person.username}: ${JSON.stringify(invite.data)}`);
  const accept = await request(`/api/invitations/${invite.data.id}/accept`, { method: 'POST', token: person.token });
  if (accept.status !== 200) throw new Error(`${person.username} could not accept invitation: ${JSON.stringify(accept.data)}`);
  const approve = await request(`/api/invitations/${invite.data.id}/approve`, { method: 'POST', token: ceo.token });
  if (approve.status !== 200) throw new Error(`Could not approve ${person.username}: ${JSON.stringify(approve.data)}`);
  return approve.data.membership;
}

async function ensureDepartment(orgId, ceo, name, managerUserId) {
  const list = await request(`/api/organizations/${orgId}/departments`, { token: ceo.token });
  const existing = (list.data || []).find(d => d.name === name);
  if (existing) return existing;
  const created = await request(`/api/organizations/${orgId}/departments`, {
    method: 'POST', token: ceo.token, body: { name, manager_user_id: managerUserId, description: `${name} department (demo data).` }
  });
  if (created.status !== 201) throw new Error(`Could not create department ${name}: ${JSON.stringify(created.data)}`);
  return created.data;
}

async function ensureTeam(orgId, ceo, name, departmentId, leadUserId) {
  const list = await request(`/api/organizations/${orgId}/teams`, { token: ceo.token });
  const existing = (list.data || []).find(t => t.name === name);
  if (existing) return existing;
  const created = await request(`/api/organizations/${orgId}/teams`, {
    method: 'POST', token: ceo.token, body: { name, department_id: departmentId, lead_user_id: leadUserId, description: `${name} (demo data).` }
  });
  if (created.status !== 201) throw new Error(`Could not create team ${name}: ${JSON.stringify(created.data)}`);
  return created.data;
}

async function ensureTeamMember(teamId, ceo, userId) {
  const list = await request(`/api/teams/${teamId}/members`, { token: ceo.token });
  if ((list.data || []).some(m => Number(m.user_id) === Number(userId))) return;
  const added = await request(`/api/teams/${teamId}/members`, { method: 'POST', token: ceo.token, body: { user_id: userId } });
  if (added.status !== 201) throw new Error(`Could not add member ${userId} to team ${teamId}: ${JSON.stringify(added.data)}`);
}

async function findProjectByName(orgId, ceo, name) {
  const list = await request(`/api/organizations/${orgId}/projects`, { token: ceo.token });
  return (list.data || []).find(p => p.name === name) || null;
}

function directProjectStories(projectName) {
  if (projectName === 'Marketing Campaign Launch') {
    return [
      {
        name: 'Campaign Strategy & Messaging',
        description: 'Define who we are targeting and what we are telling them.',
        tasks: [
          { title: 'Define target audience segments', description: 'Identify and document the primary buyer segments for this launch.', dueInDays: -2, status: 'in_progress', progress: 60 },
          { title: 'Draft core messaging framework', description: 'Write the campaign value proposition and supporting message pillars.', dueInDays: 5,
            subtasks: ['Write value proposition', 'Write three headline variants'] }
        ]
      },
      {
        name: 'Content Production',
        description: 'Produce the creative assets needed for launch day.',
        tasks: [
          { title: 'Produce launch video', description: 'Script, shoot, and edit the 60-second launch video.', dueInDays: 10 },
          { title: 'Design social media asset pack', description: 'Create the sized image set for all launch social posts.', dueInDays: 14, status: 'done', progress: 100 }
        ]
      }
    ];
  }
  if (projectName === 'Internal Onboarding System') {
    return [
      {
        name: 'Onboarding Checklist Automation',
        description: 'Replace the manual onboarding checklist with an automated workflow.',
        tasks: [
          { title: 'Map current onboarding steps', description: 'Document every step a new hire currently goes through in their first two weeks.', dueInDays: -5, status: 'blocked', progress: 30 },
          { title: 'Build automated checklist workflow', description: 'Implement the automated task checklist for new hires.', dueInDays: 12,
            subtasks: ['Set up task templates', 'Connect notification triggers'] }
        ]
      },
      {
        name: 'Equipment & Access Provisioning',
        description: 'Standardize how new hires get equipment and system access.',
        tasks: [
          { title: 'Create IT provisioning form', description: 'Build the intake form IT uses to provision new-hire equipment.', dueInDays: 3 },
          { title: 'Document access request approval flow', description: 'Write the approval chain for granting system access to new hires.', dueInDays: 20 }
        ]
      }
    ];
  }
  return [];
}

async function seedDirectProject(orgId, ceo, projectName, deptName, teamByName, managers, employees, { objective, scope, constraints, priority, dueInDays, milestones }) {
  const existing = await findProjectByName(orgId, ceo, projectName);
  if (existing) {
    console.log(`  Project "${projectName}" already exists — skipping (idempotent).`);
    return { projectId: existing.id, tasks: [] };
  }

  const manager = managers.find(candidate => candidate.department === deptName);
  const teamEmployees = employees.filter(candidate => candidate.department === deptName);
  const team = teamByName[deptName];

  const created = await request(`/api/organizations/${orgId}/projects`, {
    method: 'POST', token: ceo.token,
    body: { name: projectName, objective, scope, constraints, priority, owner_id: manager.userId, start_date: isoDate(-14), due_date: isoDate(dueInDays) }
  });
  if (created.status !== 201) throw new Error(`Could not create project ${projectName}: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;
  console.log(`  Created project "${projectName}" (id ${projectId}), owner ${manager.fullName}`);

  for (const milestone of milestones) {
    await request(`/api/projects/${projectId}/milestones`, {
      method: 'POST', token: ceo.token, body: { name: milestone.name, description: milestone.description, due_date: isoDate(milestone.dueInDays) }
    });
  }

  const createdTasks = [];
  for (const storyDef of directProjectStories(projectName)) {
    const story = await request(`/api/projects/${projectId}/stories`, {
      method: 'POST', token: ceo.token, body: { name: storyDef.name, description: storyDef.description, team_id: team.id, priority: 'medium' }
    });
    if (story.status !== 201) throw new Error(`Could not create story ${storyDef.name}: ${JSON.stringify(story.data)}`);

    for (const [index, taskDef] of storyDef.tasks.entries()) {
      const assignee = teamEmployees[index % teamEmployees.length];
      const task = await request(`/api/projects/${projectId}/tasks`, {
        method: 'POST', token: ceo.token,
        body: { title: taskDef.title, description: taskDef.description, story_id: story.data.id, team_id: team.id, priority: 'medium', due_date: isoDate(taskDef.dueInDays) }
      });
      if (task.status !== 201) throw new Error(`Could not create task ${taskDef.title}: ${JSON.stringify(task.data)}`);
      // Assigning through the MANAGER's own token (not the CEO's) deliberately exercises the
      // real "team manager can assign within their own team" permission path while seeding.
      const assign = await request(`/api/tasks/${task.data.id}`, { method: 'PATCH', token: manager.token, body: { owner_id: assignee.userId } });
      if (assign.status !== 200) throw new Error(`Manager could not assign task ${taskDef.title} within their own team: ${JSON.stringify(assign.data)}`);
      if (taskDef.status) {
        await request(`/api/tasks/${task.data.id}`, { method: 'PATCH', token: assignee.token, body: { status: taskDef.status, progress: taskDef.progress ?? 0 } });
      }
      createdTasks.push({ id: task.data.id, title: taskDef.title, teamId: team.id, assigneeUserId: assignee.userId, assigneeToken: assignee.token });

      for (const subtaskTitle of taskDef.subtasks || []) {
        const subtaskAssignee = teamEmployees[(index + 1) % teamEmployees.length];
        const subtask = await request(`/api/projects/${projectId}/tasks`, {
          method: 'POST', token: ceo.token,
          body: { title: subtaskTitle, parent_task_id: task.data.id, story_id: story.data.id, team_id: team.id, due_date: isoDate(taskDef.dueInDays) }
        });
        if (subtask.status !== 201) throw new Error(`Could not create subtask ${subtaskTitle}: ${JSON.stringify(subtask.data)}`);
        await request(`/api/tasks/${subtask.data.id}`, { method: 'PATCH', token: manager.token, body: { owner_id: subtaskAssignee.userId } });
      }
    }
  }
  return { projectId, tasks: createdTasks };
}

async function seedBriefProject(orgId, ceo, teamByName, employees) {
  const projectName = 'Customer Portal Redesign';
  const existing = await findProjectByName(orgId, ceo, projectName);
  if (existing) {
    console.log(`  Project "${projectName}" already exists — skipping (idempotent).`);
    return;
  }

  // Runs the real "New Project = Project Brief" flow end to end: paste a brief, let the app
  // auto-analyze it (local fallback if no AI provider key is configured), then commit — the same
  // path a real user takes, which is also what exercises the automatic project-field extraction
  // and AI team-routing/manager-notification logic with real demo content.
  const briefText = [
    'Project: Customer Portal Redesign',
    'Client: Ashcombe Retail Group',
    'Objective: Rebuild the customer self-service portal so shoppers can track orders and manage returns without contacting support.',
    'Scope: Redesigned account dashboard, order tracking, and a self-service returns flow.',
    'Constraints: Must integrate with the existing order management API and ship without downtime.',
    'Priority: high',
    `Due date: ${isoDate(75)}`
  ].join('\n');

  const draft = await request(`/api/organizations/${orgId}/client-briefs`, { method: 'POST', token: ceo.token, body: { raw_text: briefText } });
  if (draft.status !== 201) throw new Error(`Could not create brief draft: ${JSON.stringify(draft.data)}`);
  const analyze = await request(`/api/client-briefs/${draft.data.session_id}/analyze`, { method: 'POST', token: ceo.token });
  if (analyze.status !== 200) throw new Error(`Could not analyze demo brief: ${JSON.stringify(analyze.data)}`);

  const plan = analyze.data.plan;
  const engineeringEmployees = employees.filter(candidate => candidate.department === 'Engineering');
  const designEmployees = employees.filter(candidate => candidate.department === 'Design');
  const teamAssignments = [
    { teamName: 'Engineering Team', assignee: engineeringEmployees[0] },
    { teamName: 'Design Team', assignee: designEmployees[0] }
  ];
  plan.stories.slice(0, 2).forEach((story, index) => {
    const routing = teamAssignments[index % teamAssignments.length];
    story.team_name = routing.teamName;
    story.team_confidence = 90;
    story.team_reason = 'Assigned for demo purposes.';
    if (story.tasks[0] && routing.assignee) story.tasks[0].owner_id = routing.assignee.userId;
  });

  const fields = analyze.data.project_fields || {};
  const commit = await request(`/api/brief-sessions/${draft.data.session_id}/commit`, {
    method: 'POST', token: ceo.token,
    body: {
      plan, project_name: projectName, client_name: fields.client_name || 'Ashcombe Retail Group',
      objective: fields.objective, scope: fields.scope, constraints: fields.constraints,
      priority: fields.priority || 'high', owner_id: ceo.userId, start_date: isoDate(-3), due_date: fields.due_date || isoDate(75)
    }
  });
  if (commit.status !== 200) throw new Error(`Could not commit demo brief: ${JSON.stringify(commit.data)}`);
  console.log(`  Created project "${projectName}" (id ${commit.data.project_id}) via the AI brief flow — ${commit.data.storyCount} stories, ${commit.data.taskCount} tasks, ${commit.data.subtaskCount} subtasks.`);

  await request(`/api/projects/${commit.data.project_id}/milestones`, {
    method: 'POST', token: ceo.token, body: { name: 'Design sign-off', description: 'Client approves the new portal design.', due_date: isoDate(25) }
  });
  await request(`/api/projects/${commit.data.project_id}/milestones`, {
    method: 'POST', token: ceo.token, body: { name: 'Portal launch', description: 'New customer portal goes live.', due_date: isoDate(75) }
  });
}

async function verifyPermissions(ceo, marketingResult, operationsResult, managers, employees) {
  console.log('\nVerifying CEO -> Manager -> Employee permissions:');
  const results = [];
  const record = (label, pass, detail = '') => { results.push({ label, pass }); console.log(`  ${pass ? 'PASS' : 'FAIL'} — ${label}${detail ? ` (${detail})` : ''}`); };

  const marketingManager = managers.find(m => m.department === 'Marketing');
  const marketingEmployee = employees.find(e => e.department === 'Marketing');
  const marketingTask = marketingResult.tasks[0];
  const operationsTask = operationsResult.tasks[0];

  if (!marketingTask || !operationsTask) {
    console.log('  SKIPPED — no freshly-created tasks available to verify against (projects already existed from a previous run).');
    return;
  }

  const ceoCrossTeamAssign = await request(`/api/tasks/${operationsTask.id}`, { method: 'PATCH', token: ceo.token, body: { owner_id: operationsTask.assigneeUserId } });
  record('CEO CAN assign any task in any team', ceoCrossTeamAssign.status === 200, `got ${ceoCrossTeamAssign.status}`);

  const managerCrossTeam = await request(`/api/tasks/${operationsTask.id}`, { method: 'PATCH', token: marketingManager.token, body: { owner_id: operationsTask.assigneeUserId } });
  record('Department Manager CANNOT assign a task outside their own team (expect 403)', managerCrossTeam.status === 403, `got ${managerCrossTeam.status}`);

  const managerOwnTeam = await request(`/api/tasks/${marketingTask.id}`, { method: 'PATCH', token: marketingManager.token, body: { owner_id: marketingTask.assigneeUserId } });
  record('Department Manager CAN assign a task within their own team', managerOwnTeam.status === 200, `got ${managerOwnTeam.status}`);

  const employeeAssignAttempt = await request(`/api/tasks/${marketingTask.id}`, { method: 'PATCH', token: marketingEmployee.token, body: { owner_id: marketingEmployee.userId } });
  record('Employee CANNOT reassign any task (expect 403)', employeeAssignAttempt.status === 403, `got ${employeeAssignAttempt.status}`);

  const employeeSelfUpdate = await request(`/api/tasks/${marketingTask.id}`, { method: 'PATCH', token: marketingTask.assigneeToken, body: { status: 'in_progress', progress: 40 } });
  record('Employee CAN update their own assigned task\'s status/progress', employeeSelfUpdate.status === 200, `got ${employeeSelfUpdate.status}`);

  const passCount = results.filter(item => item.pass).length;
  console.log(`  ${passCount}/${results.length} permission checks passed.`);
}

function printCredentials() {
  console.log('\nDemo account credentials (same password for every account):');
  console.log(`  Password: ${PASSWORD}\n`);
  const rows = PEOPLE.map(person => ({
    role: person.role === 'ceo' ? 'CEO' : person.role === 'manager' ? `Manager (${person.department})` : `Employee (${person.department})`,
    name: person.fullName, username: person.username, email: person.email
  }));
  const widths = {
    role: Math.max(...rows.map(r => r.role.length), 4),
    name: Math.max(...rows.map(r => r.name.length), 4),
    username: Math.max(...rows.map(r => r.username.length), 8)
  };
  const pad = (value, width) => String(value).padEnd(width, ' ');
  console.log(`  ${pad('Role', widths.role)}  ${pad('Name', widths.name)}  ${pad('Username', widths.username)}  Email`);
  for (const row of rows) console.log(`  ${pad(row.role, widths.role)}  ${pad(row.name, widths.name)}  ${pad(row.username, widths.username)}  ${row.email}`);
}

async function main() {
  console.log(`Seeding demo data at ${BASE_URL} ...`);
  const health = await request('/api/health').catch(() => null);
  if (!health || health.status !== 200) {
    console.error(`Could not reach ${BASE_URL}. Start the app first (npm run dev) or set SEED_BASE_URL to a running instance.`);
    process.exitCode = 1;
    return;
  }

  console.log('\nCreating demo accounts:');
  for (const person of PEOPLE) {
    const outcome = await registerOrLogin(person);
    console.log(`  ${outcome === 'created' ? 'Created' : 'Found existing'} account: ${person.username}`);
  }

  const ceo = PEOPLE[0];
  const managers = PEOPLE.filter(p => p.role === 'manager');
  const employees = PEOPLE.filter(p => p.role === 'employee');

  const orgId = await ensureOrganization(ceo);
  console.log(`\nOrganization: "${ORG_NAME}" (id ${orgId})`);

  console.log('\nOnboarding managers and employees:');
  for (const manager of managers) await ensureMember(orgId, ceo, manager);

  const teamByName = {};
  for (const deptName of DEPARTMENTS) {
    const manager = managers.find(m => m.department === deptName);
    const department = await ensureDepartment(orgId, ceo, deptName, manager.userId);
    const team = await ensureTeam(orgId, ceo, `${deptName} Team`, department.id, manager.userId);
    teamByName[deptName] = team;
  }

  for (const employee of employees) {
    await ensureMember(orgId, ceo, employee);
    await ensureTeamMember(teamByName[employee.department].id, ceo, employee.userId);
  }
  console.log(`  ${managers.length} department managers and ${employees.length} employees are active members, each on their department's team.`);

  console.log('\nCreating demo projects:');
  await seedBriefProject(orgId, ceo, teamByName, employees);
  const marketingResult = await seedDirectProject(orgId, ceo, 'Marketing Campaign Launch', 'Marketing', teamByName, managers, employees, {
    objective: 'Launch the Q3 product campaign on schedule and on budget.',
    scope: 'Campaign strategy, creative production, and social media rollout.',
    constraints: 'Creative assets must be finalized two weeks before launch day.',
    priority: 'medium', dueInDays: 18,
    milestones: [
      { name: 'Campaign brief approved', description: 'Leadership signs off on the campaign brief.', dueInDays: -3 },
      { name: 'Launch day', description: 'Campaign goes live across all channels.', dueInDays: 18 }
    ]
  });
  const operationsResult = await seedDirectProject(orgId, ceo, 'Internal Onboarding System', 'Operations', teamByName, managers, employees, {
    objective: 'Replace the manual new-hire onboarding checklist with an automated system.',
    scope: 'Onboarding workflow automation and IT provisioning process.',
    constraints: 'Must work with the existing HR system without a data migration.',
    priority: 'medium', dueInDays: 30,
    milestones: [
      { name: 'Process audit complete', description: 'Current onboarding process fully documented.', dueInDays: -1 },
      { name: 'System go-live', description: 'Automated onboarding system available to all new hires.', dueInDays: 30 }
    ]
  });

  await verifyPermissions(ceo, marketingResult, operationsResult, managers, employees);

  printCredentials();
  console.log('\nDone.');
}

main().catch(error => {
  console.error('\nSeed failed:', error.message || error);
  process.exitCode = 1;
});
