'use strict';

const client = require('./client');

const SCHEMA_SQL = `

    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      full_name TEXT NOT NULL,
      avatar_url TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ip_address TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS organizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('ceo','admin','moderator','member')),
      department TEXT NOT NULL DEFAULT 'General',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
      joined_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      invited_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invited_by INTEGER NOT NULL REFERENCES users(id),
      proposed_role TEXT NOT NULL DEFAULT 'member' CHECK(proposed_role IN ('admin','moderator','member')),
      proposed_department TEXT NOT NULL DEFAULT 'General',
      status TEXT NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','awaiting_approval','approved','rejected','declined','cancelled')),
      user_responded_at TEXT,
      approved_by INTEGER REFERENCES users(id),
      approved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_open_invitation
      ON invitations(organization_id, invited_user_id)
      WHERE status IN ('invited','awaiting_approval');

    CREATE TABLE IF NOT EXISTS user_presence (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      presence_mode TEXT NOT NULL DEFAULT 'auto' CHECK(presence_mode IN ('auto','online','away','dnd','offline')),
      status_key TEXT NOT NULL DEFAULT 'available',
      status_label TEXT NOT NULL DEFAULT 'Available',
      status_emoji TEXT NOT NULL DEFAULT '🟢',
      custom_status TEXT NOT NULL DEFAULT '',
      status_expires_at TEXT,
      last_seen_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme TEXT NOT NULL DEFAULT 'light' CHECK(theme IN ('light','dark','system')),
      workspace_notifications INTEGER NOT NULL DEFAULT 1 CHECK(workspace_notifications IN (0,1)),
      mention_notifications INTEGER NOT NULL DEFAULT 1 CHECK(mention_notifications IN (0,1)),
      invitation_notifications INTEGER NOT NULL DEFAULT 1 CHECK(invitation_notifications IN (0,1)),
      activity_notifications INTEGER NOT NULL DEFAULT 1 CHECK(activity_notifications IN (0,1)),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      notification_type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      action_view TEXT NOT NULL DEFAULT '',
      read_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
      activity_type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(organization_id, name COLLATE NOCASE)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      constraints TEXT NOT NULL DEFAULT '',
      assumptions TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      record_type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      phase TEXT NOT NULL DEFAULT 'General',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
      status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','blocked','done')),
      progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
      acceptance_criteria TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      source_type TEXT NOT NULL DEFAULT 'manual',
      ai_generated INTEGER NOT NULL DEFAULT 0,
      approved INTEGER NOT NULL DEFAULT 1,
      rejected INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE(task_id, depends_on_task_id)
    );

    CREATE TABLE IF NOT EXISTS risks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      risk_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      ai_generated INTEGER NOT NULL DEFAULT 1,
      approved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'approved',
      source TEXT NOT NULL DEFAULT 'manual',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      note TEXT NOT NULL,
      update_type TEXT NOT NULL DEFAULT 'progress',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      impact_scope TEXT NOT NULL DEFAULT '',
      impact_effort TEXT NOT NULL DEFAULT '',
      impact_dependencies TEXT NOT NULL DEFAULT '',
      impact_workload TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      suggestion_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      rationale TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      actor_user_id INTEGER REFERENCES users(id),
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_reset_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','at_risk','done')),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT
    );

    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      manager_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, name COLLATE NOCASE)
    );

    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      lead_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, name COLLATE NOCASE)
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_in_team TEXT NOT NULL DEFAULT '',
      joined_at TEXT NOT NULL,
      UNIQUE(team_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS job_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(organization_id, name COLLATE NOCASE)
    );

    CREATE TABLE IF NOT EXISTS stories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
      status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','at_risk','done')),
      start_date TEXT,
      due_date TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS board_columns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '',
      maps_to_status TEXT NOT NULL DEFAULT 'not_started' CHECK(maps_to_status IN ('not_started','in_progress','blocked','done')),
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS direct_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS direct_conversation_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_at TEXT,
      UNIQUE(conversation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS direct_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_brief_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      client_name TEXT NOT NULL DEFAULT '',
      project_name TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'paste' CHECK(source_type IN ('upload','paste')),
      source_filename TEXT NOT NULL DEFAULT '',
      file_mime TEXT NOT NULL DEFAULT '',
      file_size INTEGER NOT NULL DEFAULT 0,
      original_file BLOB,
      raw_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'uploaded' CHECK(status IN ('uploaded','analyzing','ready_for_review','converted','failed','discarded')),
      generated_json TEXT NOT NULL DEFAULT '{}',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_stories_project ON stories(project_id, position);
    CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(organization_id, department_id);
    CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
    CREATE INDEX IF NOT EXISTS idx_dm_conversation_members_user ON direct_conversation_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_direct_messages_conversation ON direct_messages(conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id, due_date);
    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, id);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, revoked_at, expires_at);
    CREATE INDEX IF NOT EXISTS idx_password_reset_codes_user ON password_reset_codes(user_id, used_at, expires_at);
    CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organization_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
    CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON user_presence(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_user ON account_activity(user_id, created_at);

`;

async function initDb() {
  const { all, run, execScript, utcnow } = client;
  await execScript(SCHEMA_SQL);

  // Safe migrations for databases created by earlier iterations.
  const userColumns = new Set((await all('PRAGMA table_info(users)')).map(column => column.name));
  if (!userColumns.has('avatar_url')) await run("ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''");

  const membershipColumns = new Set((await all('PRAGMA table_info(memberships)')).map(column => column.name));
  if (!membershipColumns.has('department')) await run("ALTER TABLE memberships ADD COLUMN department TEXT NOT NULL DEFAULT 'General'");

  const invitationColumns = new Set((await all('PRAGMA table_info(invitations)')).map(column => column.name));
  if (!invitationColumns.has('proposed_department')) await run("ALTER TABLE invitations ADD COLUMN proposed_department TEXT NOT NULL DEFAULT 'General'");

  const presenceColumns = new Set((await all('PRAGMA table_info(user_presence)')).map(column => column.name));
  if (!presenceColumns.has('status_key')) await run("ALTER TABLE user_presence ADD COLUMN status_key TEXT NOT NULL DEFAULT 'available'");
  if (!presenceColumns.has('status_label')) await run("ALTER TABLE user_presence ADD COLUMN status_label TEXT NOT NULL DEFAULT 'Available'");
  if (!presenceColumns.has('status_emoji')) await run("ALTER TABLE user_presence ADD COLUMN status_emoji TEXT NOT NULL DEFAULT '🟢'");
  if (!presenceColumns.has('status_expires_at')) await run('ALTER TABLE user_presence ADD COLUMN status_expires_at TEXT');

  const taskColumns = new Set((await all('PRAGMA table_info(tasks)')).map(column => column.name));
  if (!taskColumns.has('parent_task_id')) await run('ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id)');
  if (!taskColumns.has('start_date')) await run('ALTER TABLE tasks ADD COLUMN start_date TEXT');
  if (!taskColumns.has('milestone_id')) await run('ALTER TABLE tasks ADD COLUMN milestone_id INTEGER REFERENCES milestones(id)');

  const projectColumns = new Set((await all('PRAGMA table_info(projects)')).map(column => column.name));
  if (!projectColumns.has('owner_id')) await run('ALTER TABLE projects ADD COLUMN owner_id INTEGER REFERENCES users(id)');
  if (!projectColumns.has('priority')) await run("ALTER TABLE projects ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'");
  if (!projectColumns.has('start_date')) await run('ALTER TABLE projects ADD COLUMN start_date TEXT');
  if (!projectColumns.has('due_date')) await run('ALTER TABLE projects ADD COLUMN due_date TEXT');
  if (!projectColumns.has('health_override')) await run('ALTER TABLE projects ADD COLUMN health_override TEXT');
  await run('UPDATE projects SET owner_id=created_by WHERE owner_id IS NULL');

  await run('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)');

  if (!taskColumns.has('story_id')) await run('ALTER TABLE tasks ADD COLUMN story_id INTEGER REFERENCES stories(id)');
  if (!taskColumns.has('tags')) await run("ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.has('estimated_hours')) await run('ALTER TABLE tasks ADD COLUMN estimated_hours REAL');
  if (!taskColumns.has('column_id')) await run('ALTER TABLE tasks ADD COLUMN column_id INTEGER REFERENCES board_columns(id)');
  if (!taskColumns.has('board_position')) await run('ALTER TABLE tasks ADD COLUMN board_position INTEGER NOT NULL DEFAULT 0');
  await run('CREATE INDEX IF NOT EXISTS idx_tasks_column ON tasks(column_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_board_columns_project ON board_columns(project_id)');

  const membershipColumns2 = new Set((await all('PRAGMA table_info(memberships)')).map(column => column.name));
  if (!membershipColumns2.has('department_id')) {
    await run('ALTER TABLE memberships ADD COLUMN department_id INTEGER REFERENCES departments(id)');
    const distinctDepartments = await all("SELECT DISTINCT organization_id, department FROM memberships WHERE department IS NOT NULL AND department <> ''");
    for (const row of distinctDepartments) {
      const now = utcnow();
      await run('INSERT OR IGNORE INTO departments(organization_id,name,created_at,updated_at) VALUES(?,?,?,?)', [row.organization_id, row.department, now, now]);
    }
    await run('UPDATE memberships SET department_id = (SELECT id FROM departments d WHERE d.organization_id = memberships.organization_id AND d.name = memberships.department) WHERE department_id IS NULL');
  }
  if (!membershipColumns2.has('manager_user_id')) await run('ALTER TABLE memberships ADD COLUMN manager_user_id INTEGER REFERENCES users(id)');
  if (!membershipColumns2.has('job_role_id')) await run('ALTER TABLE memberships ADD COLUMN job_role_id INTEGER REFERENCES job_roles(id)');

  const settingsColumns = new Set((await all('PRAGMA table_info(user_settings)')).map(column => column.name));
  if (!settingsColumns.has('dashboard_layout')) await run("ALTER TABLE user_settings ADD COLUMN dashboard_layout TEXT NOT NULL DEFAULT ''");

  const projectColumns2 = new Set((await all('PRAGMA table_info(projects)')).map(column => column.name));
  if (!projectColumns2.has('client_name')) await run("ALTER TABLE projects ADD COLUMN client_name TEXT NOT NULL DEFAULT ''");

  const briefSessionInfo = await all('PRAGMA table_info(ai_brief_sessions)');
  const briefSessionColumns = new Set(briefSessionInfo.map(column => column.name));
  const projectIdInfo = briefSessionInfo.find(column => column.name === 'project_id');
  if (projectIdInfo && projectIdInfo.notnull === 1) {
    // Rebuild: project_id must become nullable so a brief can exist before any project does.
    await run(`
      CREATE TABLE ai_brief_sessions_rebuild (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        client_name TEXT NOT NULL DEFAULT '',
        project_name TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'paste' CHECK(source_type IN ('upload','paste')),
        source_filename TEXT NOT NULL DEFAULT '',
        file_mime TEXT NOT NULL DEFAULT '',
        file_size INTEGER NOT NULL DEFAULT 0,
        original_file BLOB,
        raw_text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'uploaded' CHECK(status IN ('uploaded','analyzing','ready_for_review','converted','failed','discarded')),
        generated_json TEXT NOT NULL DEFAULT '{}',
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL
      )
    `);
    await run(`
      INSERT INTO ai_brief_sessions_rebuild(id,project_id,organization_id,project_name,source_type,source_filename,raw_text,status,generated_json,created_by,created_at)
      SELECT s.id, s.project_id, p.organization_id, p.name,
        s.source_type, s.source_filename, s.raw_text,
        CASE s.status WHEN 'generated' THEN 'ready_for_review' WHEN 'committed' THEN 'converted' ELSE s.status END,
        s.generated_json, s.created_by, s.created_at
      FROM ai_brief_sessions s JOIN projects p ON p.id = s.project_id
    `);
    await run('DROP TABLE ai_brief_sessions');
    await run('ALTER TABLE ai_brief_sessions_rebuild RENAME TO ai_brief_sessions');
  } else if (!briefSessionColumns.has('organization_id')) {
    // Table already rebuilt in a prior boot but is missing newer columns (shouldn't normally happen; additive safety net).
    await run('ALTER TABLE ai_brief_sessions ADD COLUMN organization_id INTEGER REFERENCES organizations(id)');
    await run('ALTER TABLE ai_brief_sessions ADD COLUMN client_name TEXT NOT NULL DEFAULT \'\'');
    await run('ALTER TABLE ai_brief_sessions ADD COLUMN project_name TEXT NOT NULL DEFAULT \'\'');
    await run('ALTER TABLE ai_brief_sessions ADD COLUMN file_mime TEXT NOT NULL DEFAULT \'\'');
    await run('ALTER TABLE ai_brief_sessions ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0');
    await run('ALTER TABLE ai_brief_sessions ADD COLUMN original_file BLOB');
    await run(`UPDATE ai_brief_sessions SET organization_id = (SELECT organization_id FROM projects WHERE projects.id = ai_brief_sessions.project_id) WHERE organization_id IS NULL AND project_id IS NOT NULL`);
  }

  const storyColumns2 = new Set((await all('PRAGMA table_info(stories)')).map(column => column.name));
  if (!storyColumns2.has('team_id')) await run('ALTER TABLE stories ADD COLUMN team_id INTEGER REFERENCES teams(id)');
  if (!storyColumns2.has('ai_team_confidence')) await run('ALTER TABLE stories ADD COLUMN ai_team_confidence INTEGER');
  if (!storyColumns2.has('ai_team_reason')) await run("ALTER TABLE stories ADD COLUMN ai_team_reason TEXT NOT NULL DEFAULT ''");

  const taskColumns2 = new Set((await all('PRAGMA table_info(tasks)')).map(column => column.name));
  if (!taskColumns2.has('team_id')) await run('ALTER TABLE tasks ADD COLUMN team_id INTEGER REFERENCES teams(id)');
  if (!taskColumns2.has('ai_team_confidence')) await run('ALTER TABLE tasks ADD COLUMN ai_team_confidence INTEGER');
  if (!taskColumns2.has('ai_team_reason')) await run("ALTER TABLE tasks ADD COLUMN ai_team_reason TEXT NOT NULL DEFAULT ''");

  await run('CREATE INDEX IF NOT EXISTS idx_stories_team ON stories(team_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_tasks_team ON tasks(team_id)');
}

module.exports = { SCHEMA_SQL, initDb };
