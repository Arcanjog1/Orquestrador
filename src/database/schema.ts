/**
 * Database schema, as ordered migrations.
 *
 * Plain SQL so it stays driver-agnostic. Migrations are applied in order and
 * recorded, so an existing installation upgrades rather than being rebuilt.
 *
 * What lives here is *metadata*: things worth querying, listing and joining.
 * Large payloads - diffs, agent stdout, patches, images - stay on disk under
 * the application's artifacts folder, with a row here pointing at them. Putting
 * megabyte diffs in table cells would make the run history slow for no benefit.
 */

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial-schema',
    sql: `
-- Providers are the vendors; accounts are individual logins with them.
CREATE TABLE providers (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE accounts (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  display_name      TEXT NOT NULL,
  -- Directory this account owns, becoming CLAUDE_CONFIG_DIR for Claude Code.
  -- Never a credential: the CLI owns what is inside.
  profile_directory TEXT NOT NULL,
  auth_state        TEXT NOT NULL DEFAULT 'disconnected',
  auth_method       TEXT,
  last_checked_at   TEXT,
  last_connected_at TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (provider_id, display_name)
);
CREATE INDEX idx_accounts_provider ON accounts(provider_id);

-- Which runtime build is installed, where it came from and how far it is trusted.
CREATE TABLE runtime_installations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  runtime_id         TEXT NOT NULL,
  version            TEXT NOT NULL,
  source_id          TEXT NOT NULL,
  source_label       TEXT NOT NULL,
  contract           TEXT NOT NULL,
  trust_level        TEXT NOT NULL,
  integrity_strategy TEXT NOT NULL,
  integrity_verified INTEGER NOT NULL,
  integrity_detail   TEXT,
  observed_publisher TEXT,
  url                TEXT NOT NULL,
  host               TEXT NOT NULL,
  platform           TEXT NOT NULL,
  arch               TEXT NOT NULL,
  bytes              INTEGER NOT NULL,
  sha256             TEXT NOT NULL,
  executable_path    TEXT NOT NULL,
  license_files      TEXT,
  previous_version   TEXT,
  update_status      TEXT NOT NULL DEFAULT 'current',
  health_status      TEXT NOT NULL DEFAULT 'unknown',
  health_detail      TEXT,
  installed_at       TEXT NOT NULL,
  superseded_at      TEXT
);
CREATE INDEX idx_runtime_installations_runtime ON runtime_installations(runtime_id, installed_at DESC);

-- An agent binds a provider account to an adapter, a role and capabilities.
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  provider_id     TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  account_id      TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  adapter_id      TEXT NOT NULL,
  role            TEXT NOT NULL,
  model           TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  priority        INTEGER NOT NULL DEFAULT 0,
  fallback_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  capabilities    TEXT NOT NULL DEFAULT '{}',
  runtime_options TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_agents_role ON agents(role, enabled);

CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  local_path      TEXT NOT NULL,
  repository_url  TEXT,
  default_branch  TEXT,
  instructions    TEXT,
  created_at      TEXT NOT NULL,
  last_opened_at  TEXT
);

CREATE TABLE workspace_agents (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  PRIMARY KEY (workspace_id, role, agent_id)
);

-- Commands a workspace owner has explicitly approved. An orchestrator agent
-- requests one BY ID; it never supplies a command line of its own.
CREATE TABLE verification_definitions (
  id           TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  command      TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE chat_sessions (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_chat_sessions_workspace ON chat_sessions(workspace_id, updated_at DESC);

-- Messages are typed events, not plain text, so the UI can render each kind.
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  run_id          TEXT REFERENCES runs(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL,
  author          TEXT NOT NULL,
  agent_id        TEXT REFERENCES agents(id) ON DELETE SET NULL,
  body            TEXT NOT NULL,
  payload         TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id, created_at);

CREATE TABLE runs (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  objective           TEXT NOT NULL,
  status              TEXT NOT NULL,
  orchestrator_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  iteration           INTEGER NOT NULL DEFAULT 0,
  max_iterations      INTEGER NOT NULL,
  baseline_commit     TEXT,
  baseline_branch     TEXT,
  baseline_dirty      INTEGER NOT NULL DEFAULT 0,
  termination_reason  TEXT,
  -- Directory holding this run's evidence, diffs and logs.
  artifacts_path      TEXT,
  started_at          TEXT NOT NULL,
  finished_at         TEXT
);
CREATE INDEX idx_runs_workspace ON runs(workspace_id, started_at DESC);

CREATE TABLE run_steps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  iteration    INTEGER NOT NULL,
  phase        TEXT NOT NULL,
  status       TEXT NOT NULL,
  summary      TEXT,
  detail       TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX idx_run_steps_run ON run_steps(run_id, iteration);

CREATE TABLE agent_invocations (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  iteration       INTEGER NOT NULL,
  agent_id        TEXT REFERENCES agents(id) ON DELETE SET NULL,
  account_id      TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  role            TEXT NOT NULL,
  task            TEXT,
  outcome         TEXT NOT NULL,
  exit_code       INTEGER,
  duration_ms     INTEGER,
  -- Set when a fallback agent was used, so the substitution is never silent.
  substituted_for_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  substitution_reason      TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT
);
CREATE INDEX idx_agent_invocations_run ON agent_invocations(run_id, iteration);

CREATE TABLE verification_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  iteration     INTEGER NOT NULL,
  definition_id TEXT,
  command       TEXT NOT NULL,
  exit_code     INTEGER,
  passed        INTEGER NOT NULL,
  refused       TEXT,
  duration_ms   INTEGER,
  output_path   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_verification_results_run ON verification_results(run_id, iteration);

-- Files produced by a run. The bytes live on disk; this is the index.
CREATE TABLE artifacts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id    TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
  run_id        TEXT REFERENCES runs(id) ON DELETE CASCADE,
  invocation_id TEXT REFERENCES agent_invocations(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL,
  label         TEXT,
  relative_path TEXT NOT NULL,
  mime_type     TEXT,
  bytes         INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_artifacts_run ON artifacts(run_id);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    name: 'workspace-updated-at',
    sql: `
-- The interface lists workspaces most-recently-touched first, which needs a
-- column that moves when anything about the workspace changes. The existing
-- last_opened_at column means something narrower and is kept as it is.
ALTER TABLE workspaces ADD COLUMN updated_at TEXT;
UPDATE workspaces SET updated_at = created_at WHERE updated_at IS NULL;
`,
  },
  {
    id: 3,
    name: 'team-and-conversations',
    sql: `
-- A workspace's team is more than two agent ids: each role also names the
-- model and the reasoning level the person chose, and those must survive a
-- restart. Both are optional - NULL means "the CLI's own default".
ALTER TABLE workspace_agents ADD COLUMN model TEXT;
ALTER TABLE workspace_agents ADD COLUMN reasoning TEXT;
-- Conversations can be archived: hidden from the recents list, never deleted
-- by that action. NULL means visible.
ALTER TABLE chat_sessions ADD COLUMN archived_at TEXT;
`,
  },
  {
    id: 4,
    name: 'worker-routing',
    sql: `
-- How the worker's model is chosen for a project: auto (the router, per
-- delegation), speed, quality, or manual (the model and reasoning columns,
-- exactly). NULL means auto. The orchestrator's row ignores it.
ALTER TABLE workspace_agents ADD COLUMN selection TEXT;
-- What each invocation asked for and what it ran with, so "why this model?"
-- is on the record. NULL on rows from before routing existed.
ALTER TABLE agent_invocations ADD COLUMN requested_capability TEXT;
ALTER TABLE agent_invocations ADD COLUMN requested_reasoning TEXT;
ALTER TABLE agent_invocations ADD COLUMN resolved_model TEXT;
ALTER TABLE agent_invocations ADD COLUMN resolved_reasoning TEXT;
ALTER TABLE agent_invocations ADD COLUMN selection_mode TEXT;
ALTER TABLE agent_invocations ADD COLUMN selection_reason TEXT;
ALTER TABLE agent_invocations ADD COLUMN fallback_used INTEGER;
`,
  },
  {
    id: 5,
    name: 'projects',
    sql: `
-- A project organises conversations; it is not a folder. It may point at a
-- workspace (the folder agents work in), which new conversations inherit,
-- or at none. Removing a project never removes anything else: its
-- conversations go to "Sem projeto" through the foreign key, and no
-- workspace, repository or file is touched.
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  workspace_id  TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  -- Explicit context a person writes for the project (JSON). Never merged
  -- into prompts silently.
  metadata      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_projects_updated ON projects(updated_at DESC);
-- Conversations from before this migration keep NULL: "Sem projeto".
ALTER TABLE chat_sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX idx_chat_sessions_project ON chat_sessions(project_id, updated_at DESC);
`,
  },
  {
    id: 6,
    name: 'cloud-execution',
    sql: `
-- Where a workspace's runs execute. 'local' is the folder on this computer,
-- which is what every existing row is and what the column defaults to, so an
-- installation upgrading to this version keeps working exactly as it did.
-- 'cloud' means an isolated workspace provisioned somewhere else: there is no
-- folder on this computer at all, which is why local_path becomes optional
-- from here on (SQLite cannot drop NOT NULL, so cloud rows carry '').
ALTER TABLE workspaces ADD COLUMN environment TEXT NOT NULL DEFAULT 'local';
-- The repository a cloud workspace works on, as GitHub names it, and the
-- branch runs start from. Local workspaces already have repository_url and
-- default_branch; these are the selection a person made in the interface.
ALTER TABLE workspaces ADD COLUMN repository_full_name TEXT;
ALTER TABLE workspaces ADD COLUMN repository_private INTEGER;
ALTER TABLE workspaces ADD COLUMN branch TEXT;
-- The coordinator this workspace's runs are sent to. NULL means the built-in
-- one; a self-hosted deployment names its own.
ALTER TABLE workspaces ADD COLUMN cloud_endpoint TEXT;

-- A remote workspace: one isolated checkout, provisioned for one session.
-- The row outlives the process that made it, which is what lets a desktop
-- that was closed find its work again.
CREATE TABLE cloud_workspaces (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id     TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
  -- Which provisioner made it, so a row is never handed to the wrong one.
  provisioner    TEXT NOT NULL,
  -- The provisioner's own handle (a container id, a machine name). Opaque here.
  handle         TEXT,
  repository     TEXT NOT NULL,
  branch         TEXT NOT NULL,
  -- The repository's absolute path INSIDE the environment. Never a path here.
  working_dir    TEXT NOT NULL,
  status         TEXT NOT NULL,
  status_detail  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  -- When the environment may be reclaimed. Enforced by the coordinator's
  -- reaper, not by the desktop: the desktop may be closed.
  expires_at     TEXT,
  released_at    TEXT
);
CREATE INDEX idx_cloud_workspaces_workspace ON cloud_workspaces(workspace_id, updated_at DESC);
CREATE INDEX idx_cloud_workspaces_status ON cloud_workspaces(status, expires_at);

-- A run that executes remotely. The local run row stays the one source of
-- truth for the person; this records where its work is happening and how far
-- the desktop has caught up with it.
ALTER TABLE runs ADD COLUMN cloud_workspace_id TEXT REFERENCES cloud_workspaces(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN remote_run_id TEXT;
-- The last event sequence number this desktop has applied. Reconnecting asks
-- for everything after it, which is what makes catching up idempotent rather
-- than a replay that duplicates steps.
ALTER TABLE runs ADD COLUMN remote_cursor INTEGER;
CREATE INDEX idx_runs_remote ON runs(remote_run_id);
`,
  },
  {
    id: 7,
    name: 'run-coordinator',
    sql: `
-- Who a request is acting as. A desktop presents a token; the token names the
-- principal. Nothing the renderer sends - least of all an accountId - is ever
-- taken as authorisation.
CREATE TABLE principals (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  -- Everything this principal owns is scoped to its tenant, and every query
  -- that reads another principal's data has to say so explicitly.
  tenant_id    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_principals_tenant ON principals(tenant_id);

-- Desktop sessions, as tokens. Only the hash is stored: a stolen database
-- does not yield a usable token, and revoking is a row update.
CREATE TABLE desktop_sessions (
  id             TEXT PRIMARY KEY,
  principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  label          TEXT,
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT,
  expires_at     TEXT,
  revoked_at     TEXT
);
CREATE INDEX idx_desktop_sessions_principal ON desktop_sessions(principal_id);

-- A run the coordinator owns. It exists whether or not any desktop is
-- connected, which is the whole point: the work continues with the computer
-- switched off, and the row is what the desktop finds when it comes back.
CREATE TABLE remote_runs (
  id                 TEXT PRIMARY KEY,
  principal_id       TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  tenant_id          TEXT NOT NULL,
  -- The desktop's own ids, so a reconnecting desktop can match its rows.
  client_run_id      TEXT,
  client_session_id  TEXT,
  repository         TEXT NOT NULL,
  branch             TEXT NOT NULL,
  objective          TEXT NOT NULL,
  status             TEXT NOT NULL,
  failure_reason     TEXT,
  cloud_workspace_id TEXT REFERENCES cloud_workspaces(id) ON DELETE SET NULL,
  -- The team, as the desktop configured it.
  team               TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  finished_at        TEXT
);
CREATE INDEX idx_remote_runs_principal ON remote_runs(principal_id, created_at DESC);
CREATE INDEX idx_remote_runs_status ON remote_runs(status);

-- Idempotency. A desktop that times out and retries, or reconnects and asks
-- again, must not get a second run - and must not get a second commit, push
-- or pull request either. The key is the client's; the answer is ours.
CREATE TABLE idempotency_keys (
  key          TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL,
  result_id    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (principal_id, scope, key)
);

-- The durable event log. Every event a desktop would have seen live is
-- written here first, with a per-run sequence number. A desktop that was
-- closed asks for everything after the last sequence it applied, so catching
-- up is exact rather than a replay that duplicates steps.
CREATE TABLE remote_run_events (
  run_id     TEXT NOT NULL REFERENCES remote_runs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- Exactly one worker may drive a run at a time. A lease is taken to start and
-- renewed while working; an expired lease is what lets another coordinator
-- process pick up a run whose owner died, without two of them running the
-- same loop.
CREATE TABLE run_leases (
  run_id     TEXT PRIMARY KEY REFERENCES remote_runs(id) ON DELETE CASCADE,
  owner      TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_run_leases_expiry ON run_leases(expires_at);
`,
  },
  {
    id: 8,
    name: 'cloud-publish-choice',
    sql: `
-- What happens to a cloud run's work when it ends.
--
-- A cloud workspace is disposable, so a run that is not published produces
-- nothing: the edits go with the workspace. Publishing therefore defaults to
-- ON, and turning it off is a deliberate choice for a run whose point is only
-- to look. Opening a pull request defaults to OFF, because that is an
-- outward-facing act on somebody's repository and should be a choice a person
-- made, not something that happens because a run finished.
--
-- Both are ignored by a local project, which has a working copy the person
-- commits and pushes themselves.
ALTER TABLE workspaces ADD COLUMN publish_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workspaces ADD COLUMN publish_pull_request INTEGER NOT NULL DEFAULT 0;
`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.id;
