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
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.id;
