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
  {
    id: 9,
    name: 'provider-connections-and-run-kinds',
    sql: `
-- A connection is an account plus how it authenticates. Everything that
-- existed before this migration authenticates through the vendor's official
-- CLI, signed in by the person, which is why the column defaults to 'cli':
-- an installation upgrading to this version keeps every account it had,
-- working exactly as it did, and nothing is re-authenticated.
--
-- 'api' is the new kind: the vendor's HTTP API with the person's own key,
-- billed separately from any subscription. Two connections may be the same
-- provider with different credentials - "Claude Trabalho 1" and "Claude
-- Trabalho 2" - which is why nothing here is keyed by provider alone.
ALTER TABLE accounts ADD COLUMN connection_kind TEXT NOT NULL DEFAULT 'cli';
-- Where the secret lives, NOT the secret. The value is a key into the
-- encrypted store; the ciphertext is in provider_secrets and the plaintext is
-- never in this database, in a log, in a URL, in argv or in the renderer.
ALTER TABLE accounts ADD COLUMN secret_ref TEXT;
-- The last four characters, for recognising a key without revealing it. A key
-- is shown in full exactly once - while the person is typing it - and never
-- again after it is saved.
ALTER TABLE accounts ADD COLUMN key_hint TEXT;
-- An override for a compatible endpoint. NULL means the vendor's documented
-- host, which is the only thing this application talks to by default.
ALTER TABLE accounts ADD COLUMN base_url TEXT;
-- What this connection prefers when a team does not say. NULL leaves the
-- choice to the router, or to the CLI's own default.
ALTER TABLE accounts ADD COLUMN default_model TEXT;
ALTER TABLE accounts ADD COLUMN default_reasoning TEXT;
-- Whether the person has enabled a metered connection. A row starts at 0:
-- the API path is OFF until it is switched on deliberately, so no key can
-- start costing money merely by having been saved.
ALTER TABLE accounts ADD COLUMN api_enabled INTEGER NOT NULL DEFAULT 0;

-- Encrypted credentials, one row per connection, apart from the metadata so
-- that listing connections never reads a secret.
CREATE TABLE provider_secrets (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  ciphertext  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- What kind of work a run is, which is what the DONE gate branches on.
--
-- 'coding' is every run that existed before this migration and every run that
-- changes files: DONE demands real git evidence and re-run verifications.
-- 'conversation' is analysis, planning and review with no workspace at all:
-- DONE is a final answer the orchestrator accepted, and the gate never
-- invents a git diff or a test that does not exist.
ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'coding';
-- What the run consumed, summed as it goes, so the history shows cost without
-- re-reading every invocation. NULL means nothing reported it.
ALTER TABLE runs ADD COLUMN invocation_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN total_tokens INTEGER;
ALTER TABLE runs ADD COLUMN total_cost_usd REAL;

-- Per-invocation provenance and consumption. Every one of these is NULL on
-- rows written before this migration, and on any provider that does not
-- report the figure - which is rendered as "não informado", never as zero.
ALTER TABLE agent_invocations ADD COLUMN provider_id TEXT;
ALTER TABLE agent_invocations ADD COLUMN connection_kind TEXT;
ALTER TABLE agent_invocations ADD COLUMN worker_id TEXT;
ALTER TABLE agent_invocations ADD COLUMN billing TEXT;
ALTER TABLE agent_invocations ADD COLUMN input_tokens INTEGER;
ALTER TABLE agent_invocations ADD COLUMN output_tokens INTEGER;
ALTER TABLE agent_invocations ADD COLUMN total_tokens INTEGER;
ALTER TABLE agent_invocations ADD COLUMN cost_usd REAL;
-- The classified provider failure, so "why did this stop?" is answerable from
-- the record rather than from a string in a log.
ALTER TABLE agent_invocations ADD COLUMN failure_kind TEXT;

-- A team may have more than two members. The primary key already allowed
-- several agents in one role; this says in which order they are offered, and
-- gives each a stable name the orchestrator can address by.
ALTER TABLE workspace_agents ADD COLUMN slot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_agents ADD COLUMN label TEXT;

-- Per-project spending limits for metered connections. NULL means no limit,
-- which is what every existing project gets: this migration changes no
-- behaviour on its own.
ALTER TABLE workspaces ADD COLUMN budget_max_invocations INTEGER;
ALTER TABLE workspaces ADD COLUMN budget_max_tokens INTEGER;
ALTER TABLE workspaces ADD COLUMN budget_max_cost_usd REAL;
`,
  },
  {
    id: 10,
    name: 'agent-sessions',
    sql: `
-- The provider's own session, per conversation and per connection.
--
-- Both official CLIs can continue a session by id ("claude -p --resume <id>",
-- "codex exec resume <id>"). Keeping the id lets a worker carry what it
-- learned from one delegation into the next, instead of meeting the codebase
-- again every turn.
--
-- The key is (chat_session, connection) and that is the whole point: two
-- Claude connections in one conversation get two rows, so Claude Trabalho 1's
-- session can never be handed to Claude Trabalho 2. Their transcripts already
-- live in two different CLAUDE_CONFIG_DIRs; this makes the same separation
-- true of what the application asks for.
--
-- What is stored is an identifier the tool gave us for a session the
-- application itself started. Nothing here reads another program's storage,
-- and nothing parses a transcript file: that format is internal to the tool
-- and documented as liable to change on any release.
CREATE TABLE agent_sessions (
  chat_session_id      TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  connection_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The id as the tool reported it.
  provider_session_id  TEXT NOT NULL,
  -- Which tool, so a resume is never attempted with the wrong CLI.
  adapter_id           TEXT NOT NULL,
  -- The directory the session belongs to. A session started in one workspace
  -- is not offered for another: the tool stores sessions per project, and
  -- resuming across them is not something to do behind a person's back.
  working_directory    TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (chat_session_id, connection_id)
);
CREATE INDEX idx_agent_sessions_connection ON agent_sessions(connection_id, updated_at DESC);
`,
  },
  {
    id: 11,
    name: 'agent-messages',
    sql: `
-- The durable record of what the agents said to each other.
--
-- This table is a *communication* log, not a second copy of the run state.
-- The run's status lives in \`runs\`; what lives here is the exchange that
-- produced it, so that "the orchestrator delegated and then nothing happened"
-- is a question with an answer instead of a blank window.
--
-- Persisted BEFORE delivery, always. A message that was accepted but never
-- handed to anyone is a row in 'pending'; a message handed over and never
-- answered is a row in 'leased' with an expired lease. Both are visible.
-- Neither can be mistaken for success, and neither disappears.
--
-- Nothing is deleted on failure. A message that exhausted its retries becomes
-- 'dead' and keeps its reason, because a result that is silently dropped is
-- the failure mode this whole table exists to make impossible.
CREATE TABLE agent_messages (
  message_id         TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  conversation_id    TEXT NOT NULL,
  iteration          INTEGER NOT NULL DEFAULT 0,
  step_id            TEXT,
  invocation_id      TEXT,
  -- NULL sender or recipient means the application itself, which is a real
  -- participant: it is what publishes USER_OBJECTIVE and what collects
  -- evidence. Modelling it as an agent would make it look like something a
  -- model could impersonate.
  sender_agent_id    TEXT,
  recipient_agent_id TEXT,
  message_type       TEXT NOT NULL,
  -- JSON chosen by the sender. Never interpreted as a command, a path or an
  -- argument: agent output is untrusted input (spec 24).
  payload            TEXT NOT NULL,
  status             TEXT NOT NULL,
  correlation_id     TEXT NOT NULL,
  causation_id       TEXT,
  -- The idempotency key. UNIQUE is the whole mechanism: publishing the same
  -- logical message twice returns the first row rather than asking a worker
  -- to do the same work again.
  dedupe_key         TEXT NOT NULL UNIQUE,
  attempts           INTEGER NOT NULL DEFAULT 0,
  -- Set while leased. A lease that passes its deadline is how the application
  -- finds out that a worker died without saying so.
  lease_expires_at   TEXT,
  -- Backoff lives here: a message is not offered for delivery before this.
  available_at       TEXT NOT NULL,
  failure_reason     TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
-- The claim query: oldest ready message for a recipient in a run.
CREATE INDEX idx_agent_messages_claim
  ON agent_messages(recipient_agent_id, status, available_at);
-- The timeline query, and the cancel-a-run sweep.
CREATE INDEX idx_agent_messages_run ON agent_messages(run_id, created_at);
CREATE INDEX idx_agent_messages_conversation
  ON agent_messages(conversation_id, created_at);
-- Finding the answer to a request.
CREATE INDEX idx_agent_messages_correlation ON agent_messages(correlation_id);
-- The expiry sweep, which is what turns a dead worker into a visible fact.
CREATE INDEX idx_agent_messages_lease ON agent_messages(status, lease_expires_at);
`,
  },
  {
    id: 12,
    name: 'workspace-folder-identity',
    sql: `
-- The stable identity of the folder a project works in.
--
-- Selecting a folder used to compare \`local_path\` as plain text, so
-- "C:\\Users\\Me\\Proj" and "c:/users/me/proj/" were two different projects for
-- the same folder on disk. This column holds the canonicalised form (see
-- src/workspace/folder-identity.ts): lower-cased and back-slashed on Windows,
-- trailing separator removed, and resolved through the filesystem when the
-- folder exists, so a junction and its target are one project.
--
-- Empty for a conversation or cloud project. Those own no folder, and an
-- empty key deliberately matches nothing - not even another empty key, or
-- every conversation project would collapse into one.
--
-- NOT unique, on purpose. An installation upgrading to this version may
-- already contain two workspaces for the same folder, and a unique index
-- would make the migration fail on exactly the people who need it most.
-- Uniqueness is enforced where it belongs - when a folder is opened - and
-- duplicates that already exist are shown to the person to resolve, never
-- merged automatically. Merging would mean deciding which conversations to
-- keep, and that is not a decision to make behind somebody's back.
ALTER TABLE workspaces ADD COLUMN path_key TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_workspaces_path_key ON workspaces(path_key);
`,
  },
  {
    id: 13,
    name: 'invocation-diagnostics',
    sql: `
-- The diagnosis of one invocation, kept where the invocation is.
--
-- Everything below was already captured in \`AgentResult\` and then dropped at
-- this boundary: the row recorded outcome, exit code and a classified failure
-- kind, and nothing else. So a run could end with "provider-error, exit 1" and
-- the person had no way to learn what the CLI actually said, which build said
-- it, or when it last did anything - the information existed and was thrown
-- away one function short of being useful.
--
-- Redacted before it is written. \`stderr_excerpt\` goes through the same
-- redactor as every other stored diagnostic, and is capped: this is a field a
-- person reads, not a log file.
ALTER TABLE agent_invocations ADD COLUMN failure_detail TEXT;
ALTER TABLE agent_invocations ADD COLUMN stderr_excerpt TEXT;
ALTER TABLE agent_invocations ADD COLUMN executable TEXT;
ALTER TABLE agent_invocations ADD COLUMN cli_version TEXT;
ALTER TABLE agent_invocations ADD COLUMN signal TEXT;
-- Liveness at the moment the invocation ended, so "it just stopped" has a
-- timestamp rather than being an absence.
ALTER TABLE agent_invocations ADD COLUMN last_activity_at TEXT;
ALTER TABLE agent_invocations ADD COLUMN idle_timeout_ms INTEGER;
ALTER TABLE agent_invocations ADD COLUMN current_tool TEXT;
-- The working directory the process really ran in. Already shown on a step;
-- kept here too because the invocation is what a person opens.
ALTER TABLE agent_invocations ADD COLUMN working_directory TEXT;
`,
  },
  {
    id: 14,
    name: 'project-as-the-entity',
    sql: `
-- The project becomes the one thing a person organises by.
--
-- Until now the interface had three lists - Recentes, Projetos and Pastas -
-- and the same folder could appear in two of them, because the folder lived
-- in \`workspaces\` and the organisation lived in \`projects\` with nothing
-- joining them on screen. Nothing below moves data between those tables:
-- \`workspaces\` stays exactly what it is, the place a run executes, with its
-- team, its budget and its verifications. What the project gains is the
-- identity a person recognises it by - a repository, a folder, or neither.
--
-- Every column is added, none is dropped or rewritten, and every one has a
-- default that is what an existing row already means. An installation that
-- upgrades and never connects a repository is unchanged in every observable
-- way.

-- Archiving. Hiding a project must be reversible, and it must be a different
-- act from removing it: 'remove' forgets the organisation, 'archive' puts it
-- away with its conversations intact and offers it back.
ALTER TABLE projects ADD COLUMN archived_at TEXT;

-- The repository this project is, when it is one.
--
-- \`repository_key\` is the canonical identity: host + owner + name, folded to
-- lower case (see src/github/repository-identity.ts). It is what stops the
-- same repository from becoming two projects when it is pasted as an https
-- URL one day and as owner/name the next. Empty means the project is not a
-- repository, and an empty key deliberately matches nothing.
--
-- NOT unique, for the same reason \`workspaces.path_key\` is not: an
-- installation may already hold two projects for one repository, and a unique
-- index would make the migration fail on exactly the person who needs it.
-- Uniqueness is enforced where the decision is made - when a repository is
-- connected - and anything already duplicated is shown, never merged behind
-- somebody's back.
ALTER TABLE projects ADD COLUMN repository_key TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN repository_url TEXT;
ALTER TABLE projects ADD COLUMN repository_full_name TEXT;
ALTER TABLE projects ADD COLUMN repository_private INTEGER;

-- The real default branch, as GitHub reported it. Never a guess, and never
-- the string 'main' written by this application: a repository whose default
-- branch has not been read keeps NULL, and the interface says it does not
-- know rather than showing a name that may not exist.
ALTER TABLE projects ADD COLUMN default_branch TEXT;

-- What was actually read, the last time the repository was analysed. A branch
-- and a commit, so "the project was analysed" is a claim with a sha attached.
ALTER TABLE projects ADD COLUMN analysed_branch TEXT;
ALTER TABLE projects ADD COLUMN analysed_commit TEXT;
ALTER TABLE projects ADD COLUMN analysed_at TEXT;

-- How the project came to exist: 'folder' (a directory was opened),
-- 'repository' (a repository was connected), or 'empty' (created with
-- neither, to be associated later). Existing rows are folders or empties;
-- 'folder' is the honest default because every project that exists today was
-- created next to a workspace.
ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'folder';

CREATE INDEX idx_projects_repository_key ON projects(repository_key);
CREATE INDEX idx_projects_archived ON projects(archived_at);

-- What the agents are told about the project, and where each piece came from.
--
-- This is the shared context: the objective, the decisions taken, the shape of
-- the architecture, the rules that do not bend, the current state, and the
-- evidence that was actually verified. It is deliberately a table of small
-- typed entries and not one long document, because the point is to send a
-- *selection* to an agent instead of pouring every conversation into every
-- prompt.
--
-- \`source_ref\` is where the entry comes from - a run id, a commit, a file
-- path. An entry with no source is something a person wrote. An entry a model
-- produced is still only a claim: nothing here is evidence that a file
-- changed, and the DoneGate does not read this table.
CREATE TABLE project_context (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 'objective' | 'decision' | 'architecture' | 'rule' | 'state' | 'evidence'
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  source_ref  TEXT,
  -- Pinned entries are always included; the rest are chosen by relevance.
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_project_context_project ON project_context(project_id, kind, updated_at DESC);
`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.id;
