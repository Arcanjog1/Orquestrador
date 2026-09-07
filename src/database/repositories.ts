/**
 * Repositories for the entities the desktop application works with.
 *
 * Same rule as the rest of `src/database`: SQL stops here. Services, the IPC
 * layer and the renderer see records and nothing else. Ids are generated here
 * too, in a shape the IPC validator accepts, so no caller has to invent one.
 */

import { randomUUID } from 'node:crypto';
import type { SqlDriver, SqlRow, SqlValue } from './driver.js';

/** Ids are `<prefix>-<hex>`: readable in logs, and safe as a folder name. */
export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function now(): string {
  return new Date().toISOString();
}

abstract class Repository {
  constructor(protected readonly getDriver: () => SqlDriver) {}
  protected get db(): SqlDriver {
    return this.getDriver();
  }
}

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

export interface ProviderRecord extends SqlRow {
  id: string;
  display_name: string;
  enabled: number;
  created_at: string;
}

export class ProviderRepository extends Repository {
  /** Inserts the providers the product ships with, once. */
  ensureSeeded(): void {
    const seeds: ReadonlyArray<readonly [string, string]> = [
      ['anthropic', 'Anthropic'],
      ['openai', 'OpenAI'],
      ['google', 'Google'],
    ];
    for (const [id, displayName] of seeds) {
      this.db.run(
        'INSERT INTO providers (id, display_name, enabled, created_at) VALUES (?,?,1,?) ON CONFLICT(id) DO NOTHING',
        [id, displayName, now()],
      );
    }
  }

  list(): ProviderRecord[] {
    return this.db.all<ProviderRecord>('SELECT * FROM providers ORDER BY display_name');
  }
}

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */

export interface AccountRecord extends SqlRow {
  id: string;
  provider_id: string;
  display_name: string;
  profile_directory: string;
  auth_state: string;
  auth_method: string | null;
  last_checked_at: string | null;
  last_connected_at: string | null;
  created_at: string;
  /** `cli` (the vendor's official tool) or `api` (the person's own key). */
  connection_kind: string;
  /** A key *into* the encrypted store. Never a credential. */
  secret_ref: string | null;
  /** The last characters of the key, so it can be recognised, never read. */
  key_hint: string | null;
  base_url: string | null;
  default_model: string | null;
  default_reasoning: string | null;
  /** 0 until the person deliberately switches a metered connection on. */
  api_enabled: number;
}

export class AccountRepository extends Repository {
  create(input: {
    id: string;
    providerId: string;
    displayName: string;
    profileDirectory: string;
    /** Omitted means `cli`: the vendor's official tool, as before. */
    connectionKind?: 'cli' | 'api';
    baseUrl?: string | null;
  }): AccountRecord {
    this.db.run(
      'INSERT INTO accounts (id, provider_id, display_name, profile_directory, auth_state, created_at, connection_kind, base_url) VALUES (?,?,?,?,?,?,?,?)',
      [
        input.id,
        input.providerId,
        input.displayName,
        input.profileDirectory,
        'disconnected',
        now(),
        input.connectionKind ?? 'cli',
        input.baseUrl ?? null,
      ],
    );
    return this.require(input.id);
  }

  list(): AccountRecord[] {
    return this.db.all<AccountRecord>('SELECT * FROM accounts ORDER BY created_at');
  }

  find(id: string): AccountRecord | undefined {
    return this.db.get<AccountRecord>('SELECT * FROM accounts WHERE id = ?', [id]);
  }

  require(id: string): AccountRecord {
    const row = this.find(id);
    if (!row) throw new RecordNotFoundError('account', id);
    return row;
  }

  updateAuth(id: string, state: string, authMethod: string | null): void {
    const timestamp = now();
    this.db.run(
      'UPDATE accounts SET auth_state = ?, auth_method = ?, last_checked_at = ?, last_connected_at = CASE WHEN ? = \'connected\' THEN ? ELSE last_connected_at END WHERE id = ?',
      [state, authMethod, timestamp, state, timestamp, id],
    );
  }

  rename(id: string, displayName: string): void {
    this.db.run('UPDATE accounts SET display_name = ? WHERE id = ?', [displayName, id]);
  }

  /** The model and level this connection prefers when a team does not say. */
  setPreferences(id: string, model: string | null, reasoning: string | null): void {
    this.db.run('UPDATE accounts SET default_model = ?, default_reasoning = ? WHERE id = ?', [
      model,
      reasoning,
      id,
    ]);
  }

  /**
   * Turns a metered connection on or off.
   *
   * Off is the state a connection is born in, and the only thing that turns it
   * on is a person choosing to. Nothing is ever sent to a paid API by a
   * connection whose `api_enabled` is 0.
   */
  setApiEnabled(id: string, enabled: boolean): void {
    this.db.run('UPDATE accounts SET api_enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  }

  /**
   * Records that a credential was stored, with only enough of it to recognise.
   *
   * The ciphertext goes to `provider_secrets`; what lands here is a reference
   * and four characters. After this call the full key is not readable from any
   * screen, and it is not in this table at all.
   */
  setCredentialReference(id: string, secretRef: string | null, keyHint: string | null): void {
    this.db.run('UPDATE accounts SET secret_ref = ?, key_hint = ? WHERE id = ?', [
      secretRef,
      keyHint,
      id,
    ]);
  }

  remove(id: string): boolean {
    return this.db.run('DELETE FROM accounts WHERE id = ?', [id]).changes > 0;
  }
}

/**
 * Encrypted credentials, kept apart from the connection metadata.
 *
 * Listing connections must never need to touch a secret, which is why this is
 * a separate table and a separate repository: the only code path that reads
 * ciphertext is the one that is about to make a call with it.
 */
export class ProviderSecretRepository extends Repository {
  put(accountId: string, ciphertext: string): void {
    const timestamp = now();
    this.db.run(
      'INSERT INTO provider_secrets (account_id, ciphertext, created_at, updated_at) VALUES (?,?,?,?) ' +
        'ON CONFLICT(account_id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at',
      [accountId, ciphertext, timestamp, timestamp],
    );
  }

  get(accountId: string): string | null {
    const row = this.db.get<{ ciphertext: string }>(
      'SELECT ciphertext FROM provider_secrets WHERE account_id = ?',
      [accountId],
    );
    return row?.ciphertext ?? null;
  }

  has(accountId: string): boolean {
    return this.get(accountId) !== null;
  }

  /** Forgets the credential on this computer. The account itself stays. */
  remove(accountId: string): boolean {
    return this.db.run('DELETE FROM provider_secrets WHERE account_id = ?', [accountId]).changes > 0;
  }
}

/**
 * The provider's own session, per conversation and per connection.
 *
 * Only ids of sessions this application started are ever written here. There
 * is deliberately no code that enumerates a tool's stored sessions: neither
 * CLI offers a non-interactive way to list them, and reading their transcript
 * files directly is documented as liable to break on any release.
 */
export interface AgentSessionRecord extends SqlRow {
  chat_session_id: string;
  connection_id: string;
  provider_session_id: string;
  adapter_id: string;
  working_directory: string;
  created_at: string;
  updated_at: string;
}

export class AgentSessionRepository extends Repository {
  /**
   * The session to continue for this conversation and connection, if any.
   *
   * The working directory must match: both tools store sessions per project,
   * and handing a session from one workspace to a run in another is not
   * something to do silently.
   */
  find(
    chatSessionId: string,
    connectionId: string,
    workingDirectory: string,
  ): AgentSessionRecord | undefined {
    const row = this.db.get<AgentSessionRecord>(
      'SELECT * FROM agent_sessions WHERE chat_session_id = ? AND connection_id = ?',
      [chatSessionId, connectionId],
    );
    if (!row) return undefined;
    return row.working_directory === workingDirectory ? row : undefined;
  }

  /** Records the id the tool reported, replacing any earlier one. */
  remember(input: {
    chatSessionId: string;
    connectionId: string;
    providerSessionId: string;
    adapterId: string;
    workingDirectory: string;
  }): void {
    const timestamp = now();
    this.db.run(
      'INSERT INTO agent_sessions (chat_session_id, connection_id, provider_session_id, adapter_id, working_directory, created_at, updated_at) ' +
        'VALUES (?,?,?,?,?,?,?) ON CONFLICT(chat_session_id, connection_id) DO UPDATE SET ' +
        'provider_session_id = excluded.provider_session_id, adapter_id = excluded.adapter_id, ' +
        'working_directory = excluded.working_directory, updated_at = excluded.updated_at',
      [
        input.chatSessionId,
        input.connectionId,
        input.providerSessionId,
        input.adapterId,
        input.workingDirectory,
        timestamp,
        timestamp,
      ],
    );
  }

  /** Every session recorded for one conversation. What the details view shows. */
  listForChatSession(chatSessionId: string): AgentSessionRecord[] {
    return this.db.all<AgentSessionRecord>(
      'SELECT * FROM agent_sessions WHERE chat_session_id = ? ORDER BY updated_at DESC',
      [chatSessionId],
    );
  }

  /** Forgets a session, so the next delegation starts a fresh one. */
  forget(chatSessionId: string, connectionId: string): boolean {
    return (
      this.db.run('DELETE FROM agent_sessions WHERE chat_session_id = ? AND connection_id = ?', [
        chatSessionId,
        connectionId,
      ]).changes > 0
    );
  }
}

/* ------------------------------------------------------------------ *
 * Agents
 * ------------------------------------------------------------------ */

export type AgentRoleName = 'ORCHESTRATOR' | 'CODING_WORKER';

export interface AgentRecord extends SqlRow {
  id: string;
  display_name: string;
  provider_id: string;
  account_id: string | null;
  adapter_id: string;
  role: string;
  model: string | null;
  enabled: number;
  priority: number;
  capabilities: string;
  runtime_options: string;
  created_at: string;
}

export class AgentRepository extends Repository {
  create(input: {
    id: string;
    displayName: string;
    providerId: string;
    accountId: string | null;
    adapterId: string;
    role: AgentRoleName;
  }): AgentRecord {
    this.db.run(
      'INSERT INTO agents (id, display_name, provider_id, account_id, adapter_id, role, created_at) VALUES (?,?,?,?,?,?,?)',
      [
        input.id,
        input.displayName,
        input.providerId,
        input.accountId,
        input.adapterId,
        input.role,
        now(),
      ],
    );
    return this.require(input.id);
  }

  /** Creates the agent if an equivalent one is not already there. */
  ensure(input: {
    id: string;
    displayName: string;
    providerId: string;
    accountId: string | null;
    adapterId: string;
    role: AgentRoleName;
  }): AgentRecord {
    const existing = this.find(input.id);
    if (existing) return existing;
    return this.create(input);
  }

  list(): AgentRecord[] {
    return this.db.all<AgentRecord>('SELECT * FROM agents WHERE enabled = 1 ORDER BY role, display_name');
  }

  find(id: string): AgentRecord | undefined {
    return this.db.get<AgentRecord>('SELECT * FROM agents WHERE id = ?', [id]);
  }

  require(id: string): AgentRecord {
    const row = this.find(id);
    if (!row) throw new RecordNotFoundError('agent', id);
    return row;
  }

  setAccount(id: string, accountId: string | null): void {
    this.db.run('UPDATE agents SET account_id = ? WHERE id = ?', [accountId, id]);
  }
}

/* ------------------------------------------------------------------ *
 * Workspaces
 * ------------------------------------------------------------------ */

export interface WorkspaceRecord extends SqlRow {
  id: string;
  display_name: string;
  /**
   * The folder on this computer, for a `local` workspace.
   *
   * Empty for a `cloud` workspace: there is no folder on this computer, which
   * is the whole point of cloud mode. Read `environment` before this.
   */
  local_path: string;
  repository_url: string | null;
  default_branch: string | null;
  instructions: string | null;
  created_at: string;
  updated_at: string | null;
  last_opened_at: string | null;
  /** `local` (this computer) or `cloud` (an isolated workspace elsewhere). */
  environment: string;
  /** `owner/name`, as GitHub names it. Set for cloud workspaces. */
  repository_full_name: string | null;
  /** 1 when the selected repository is private. */
  repository_private: number | null;
  /** The branch a cloud run starts from. */
  branch: string | null;
  /** The coordinator runs are sent to; null means the configured default. */
  cloud_endpoint: string | null;
  /** 1 when a cloud run pushes its work to a branch. Default 1. */
  publish_enabled: number;
  /** 1 when a cloud run also opens a pull request. Default 0. */
  publish_pull_request: number;
}

export interface WorkspaceWithAgents extends WorkspaceRecord {
  orchestrator_agent_id: string | null;
  worker_agent_id: string | null;
  /** Model the orchestrator runs with; null leaves the CLI's default alone. */
  orchestrator_model: string | null;
  /** Reasoning level for the orchestrator (`low` | `medium` | `high`), or null. */
  orchestrator_reasoning: string | null;
  /**
   * `auto` (the CLI's own default; model and reasoning ignored) or `manual`
   * (the person's pinned model and level). Null on rows from before the
   * column existed: read as manual when a model or level was saved.
   */
  orchestrator_selection: string | null;
  worker_model: string | null;
  worker_reasoning: string | null;
  /** `auto` | `speed` | `quality` | `manual`; null is auto. */
  worker_selection: string | null;
}

/** One role's binding, as `setTeam` takes it. */
export interface TeamMemberInput {
  agentId: string;
  model?: string | null;
  reasoning?: string | null;
  selection?: string | null;
  /** What the person calls this member. Null falls back to the agent's name. */
  label?: string | null;
}

/** One team member as it comes back out, with its slot. */
export interface TeamMemberRecord {
  agentId: string;
  role: string;
  model: string | null;
  reasoning: string | null;
  selection: string | null;
  slot: number;
  label: string | null;
}

export class WorkspaceRepository extends Repository {
  create(input: {
    id: string;
    name: string;
    /** Empty for a cloud workspace: there is no folder on this computer. */
    localPath: string;
    repositoryUrl?: string | null;
    defaultBranch?: string | null;
    /** `local` (default) or `cloud`. */
    environment?: string;
    repositoryFullName?: string | null;
    repositoryPrivate?: boolean | null;
    branch?: string | null;
    cloudEndpoint?: string | null;
  }): WorkspaceWithAgents {
    const timestamp = now();
    this.db.run(
      `INSERT INTO workspaces
         (id, display_name, local_path, repository_url, default_branch, created_at, updated_at,
          environment, repository_full_name, repository_private, branch, cloud_endpoint)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.id,
        input.name,
        input.localPath,
        input.repositoryUrl ?? null,
        input.defaultBranch ?? null,
        timestamp,
        timestamp,
        input.environment ?? 'local',
        input.repositoryFullName ?? null,
        input.repositoryPrivate === null || input.repositoryPrivate === undefined
          ? null
          : input.repositoryPrivate
            ? 1
            : 0,
        input.branch ?? null,
        input.cloudEndpoint ?? null,
      ],
    );
    return this.require(input.id);
  }

  /** How a cloud project's work is published when a run ends. */
  setPublish(id: string, input: { enabled: boolean; pullRequest: boolean }): void {
    this.db.run(
      'UPDATE workspaces SET publish_enabled = ?, publish_pull_request = ?, updated_at = ? WHERE id = ?',
      [input.enabled ? 1 : 0, input.pullRequest ? 1 : 0, now(), id],
    );
  }

  list(): WorkspaceWithAgents[] {
    return this.db
      .all<WorkspaceRecord>('SELECT * FROM workspaces ORDER BY COALESCE(updated_at, created_at) DESC')
      .map((row) => this.withAgents(row));
  }

  find(id: string): WorkspaceWithAgents | undefined {
    const row = this.db.get<WorkspaceRecord>('SELECT * FROM workspaces WHERE id = ?', [id]);
    return row ? this.withAgents(row) : undefined;
  }

  require(id: string): WorkspaceWithAgents {
    const row = this.find(id);
    if (!row) throw new RecordNotFoundError('workspace', id);
    return row;
  }

  findByPath(localPath: string): WorkspaceWithAgents | undefined {
    const row = this.db.get<WorkspaceRecord>('SELECT * FROM workspaces WHERE local_path = ?', [
      localPath,
    ]);
    return row ? this.withAgents(row) : undefined;
  }

  /**
   * Binds one agent per role. A workspace has exactly one orchestrator and one
   * worker, so the previous binding for the role is replaced rather than added
   * to.
   */
  setAgents(workspaceId: string, orchestratorAgentId: string, workerAgentId: string): WorkspaceWithAgents {
    return this.setTeam(workspaceId, { agentId: orchestratorAgentId }, { agentId: workerAgentId });
  }

  /**
   * The full binding: who supervises, who executes, and with which model and
   * reasoning level each. `setAgents` is this with the defaults.
   */
  setTeam(
    workspaceId: string,
    orchestrator: TeamMemberInput,
    /**
     * The workers, in order. A single member keeps the two-argument shape every
     * existing caller uses; several are stored in slots, and slot 0 remains
     * `worker_agent_id`, so nothing that reads one worker has to change.
     */
    workers: TeamMemberInput | readonly TeamMemberInput[],
  ): WorkspaceWithAgents {
    const list = Array.isArray(workers) ? workers : [workers as TeamMemberInput];
    this.db.transaction(() => {
      this.db.run('DELETE FROM workspace_agents WHERE workspace_id = ?', [workspaceId]);
      this.db.run(
        'INSERT INTO workspace_agents (workspace_id, agent_id, role, model, reasoning, selection, slot, label) VALUES (?,?,?,?,?,?,0,?)',
        [
          workspaceId,
          orchestrator.agentId,
          'ORCHESTRATOR',
          blankToNull(orchestrator.model),
          blankToNull(orchestrator.reasoning),
          blankToNull(orchestrator.selection),
          blankToNull(orchestrator.label),
        ],
      );
      list.forEach((member, slot) => {
        this.db.run(
          'INSERT INTO workspace_agents (workspace_id, agent_id, role, model, reasoning, selection, slot, label) VALUES (?,?,?,?,?,?,?,?)',
          [
            workspaceId,
            member.agentId,
            'CODING_WORKER',
            blankToNull(member.model),
            blankToNull(member.reasoning),
            blankToNull(member.selection),
            slot,
            blankToNull(member.label),
          ],
        );
      });
      this.touch(workspaceId);
    });
    return this.require(workspaceId);
  }

  touch(workspaceId: string): void {
    this.db.run('UPDATE workspaces SET updated_at = ? WHERE id = ?', [now(), workspaceId]);
  }

  /** Spending limits for metered connections. Null in a field means no limit. */
  setBudget(
    workspaceId: string,
    budget: { maxInvocations: number | null; maxTokens: number | null; maxCostUsd: number | null },
  ): void {
    this.db.run(
      'UPDATE workspaces SET budget_max_invocations = ?, budget_max_tokens = ?, budget_max_cost_usd = ? WHERE id = ?',
      [budget.maxInvocations, budget.maxTokens, budget.maxCostUsd, workspaceId] as SqlValue[],
    );
    this.touch(workspaceId);
  }

  /**
   * The team, in slot order.
   *
   * A separate read rather than a field on the workspace row, because a row is
   * flat by construction and a team is a list. `worker_agent_id` on the row
   * remains slot 0, so a caller that wants one worker still gets one.
   */
  team(workspaceId: string): TeamMemberRecord[] {
    return this.db
      .all<{
        agent_id: string;
        role: string;
        model: string | null;
        reasoning: string | null;
        selection: string | null;
        slot: number | null;
        label: string | null;
      }>(
        'SELECT agent_id, role, model, reasoning, selection, slot, label FROM workspace_agents ' +
          'WHERE workspace_id = ? ORDER BY role, slot',
        [workspaceId],
      )
      .map((row) => ({
        agentId: row.agent_id,
        role: row.role,
        model: row.model,
        reasoning: row.reasoning,
        selection: row.selection,
        slot: row.slot ?? 0,
        label: row.label,
      }));
  }

  rename(workspaceId: string, name: string): WorkspaceWithAgents {
    this.db.run('UPDATE workspaces SET display_name = ?, updated_at = ? WHERE id = ?', [
      name,
      now(),
      workspaceId,
    ]);
    return this.require(workspaceId);
  }

  /**
   * Forgets the workspace: its row, and by cascade its team bindings,
   * verifications, conversations and runs. The folder on disk is not this
   * class's to touch, and it never is.
   */
  remove(workspaceId: string): boolean {
    const result = this.db.run('DELETE FROM workspaces WHERE id = ?', [workspaceId]);
    return Number(result.changes) > 0;
  }

  private withAgents(row: WorkspaceRecord): WorkspaceWithAgents {
    const bindings = this.db.all<{
      agent_id: string;
      role: string;
      model: string | null;
      reasoning: string | null;
      selection: string | null;
      slot: number | null;
      label: string | null;
    }>(
      'SELECT agent_id, role, model, reasoning, selection, slot, label FROM workspace_agents WHERE workspace_id = ?',
      [row.id],
    );
    const orchestrator = bindings.find((b) => b.role === 'ORCHESTRATOR');
    const workers = bindings
      .filter((b) => b.role === 'CODING_WORKER')
      .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
    // Slot 0 stays `worker_agent_id`: everything written before teams could
    // grow reads one worker, and for a team of one this is the same worker.
    const worker = workers[0];
    return {
      ...row,
      orchestrator_agent_id: orchestrator?.agent_id ?? null,
      worker_agent_id: worker?.agent_id ?? null,
      orchestrator_model: orchestrator?.model ?? null,
      orchestrator_reasoning: orchestrator?.reasoning ?? null,
      orchestrator_selection: orchestrator?.selection ?? null,
      worker_model: worker?.model ?? null,
      worker_reasoning: worker?.reasoning ?? null,
      worker_selection: worker?.selection ?? null,
    };
  }
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */

export interface ProjectRecord extends SqlRow {
  id: string;
  name: string;
  /** The folder new conversations of this project work in; null for none. */
  workspace_id: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Projects: the organisation of conversations, distinct from workspaces
 * (the folders agents work in). One project may point at one workspace, or
 * at none; a conversation belongs to at most one project.
 */
export class ProjectRepository extends Repository {
  create(input: { id: string; name: string; workspaceId?: string | null; metadata?: unknown }): ProjectRecord {
    const timestamp = now();
    this.db.run(
      'INSERT INTO projects (id, name, workspace_id, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      [
        input.id,
        input.name,
        input.workspaceId ?? null,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
        timestamp,
        timestamp,
      ] as SqlValue[],
    );
    return this.require(input.id);
  }

  list(): ProjectRecord[] {
    return this.db.all<ProjectRecord>('SELECT * FROM projects ORDER BY updated_at DESC, name');
  }

  find(id: string): ProjectRecord | undefined {
    return this.db.get<ProjectRecord>('SELECT * FROM projects WHERE id = ?', [id]);
  }

  require(id: string): ProjectRecord {
    const row = this.find(id);
    if (!row) throw new Error(`Project ${id} does not exist.`);
    return row;
  }

  rename(id: string, name: string): ProjectRecord {
    this.db.run('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?', [name, now(), id]);
    return this.require(id);
  }

  setWorkspace(id: string, workspaceId: string | null): ProjectRecord {
    this.db.run('UPDATE projects SET workspace_id = ?, updated_at = ? WHERE id = ?', [workspaceId, now(), id]);
    return this.require(id);
  }

  touch(id: string): void {
    this.db.run('UPDATE projects SET updated_at = ? WHERE id = ?', [now(), id]);
  }

  countSessions(id: string, includeArchived = false): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM chat_sessions WHERE project_id = ?${includeArchived ? '' : ' AND archived_at IS NULL'}`,
      [id],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * Forgets the project. Its conversations are kept and become "Sem projeto"
   * (the foreign key sets their project to NULL); no workspace, repository
   * or file is touched. Returns how many conversations were moved.
   */
  remove(id: string): { removed: boolean; sessionsMoved: number } {
    const sessionsMoved = this.countSessions(id, true);
    const result = this.db.run('DELETE FROM projects WHERE id = ?', [id]);
    return { removed: Number(result.changes) > 0, sessionsMoved };
  }
}

export interface ChatSessionRecord extends SqlRow {
  id: string;
  workspace_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  /** Set when the conversation was archived; null while it is in the list. */
  archived_at: string | null;
  /** The project this conversation is filed under; null is "Sem projeto". */
  project_id: string | null;
}

export interface ListSessionsOptions {
  /** Archived conversations are hidden unless asked for. */
  includeArchived?: boolean;
  /** Case-insensitive match on the title. */
  query?: string;
  /** Only this project's conversations; `null` for the ones without a project. */
  projectId?: string | null;
}

export interface MessageRecord extends SqlRow {
  id: string;
  session_id: string;
  run_id: string | null;
  kind: string;
  author: string;
  agent_id: string | null;
  body: string;
  payload: string | null;
  created_at: string;
}

export class ChatRepository extends Repository {
  createSession(input: {
    id: string;
    workspaceId: string;
    title: string;
    projectId?: string | null;
  }): ChatSessionRecord {
    const timestamp = now();
    this.db.run(
      'INSERT INTO chat_sessions (id, workspace_id, title, project_id, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      [input.id, input.workspaceId, input.title, input.projectId ?? null, timestamp, timestamp],
    );
    return this.requireSession(input.id);
  }

  listSessions(workspaceId: string, options: ListSessionsOptions = {}): ChatSessionRecord[] {
    return this.query(['workspace_id = ?'], [workspaceId], options);
  }

  /** Every conversation, of every workspace: what the project tree shows. */
  listAllSessions(options: ListSessionsOptions = {}): ChatSessionRecord[] {
    return this.query([], [], options);
  }

  /** Files a conversation under a project, or under none. */
  setSessionProject(id: string, projectId: string | null): ChatSessionRecord {
    this.db.run('UPDATE chat_sessions SET project_id = ? WHERE id = ?', [projectId, id]);
    return this.requireSession(id);
  }

  private query(where: string[], params: SqlValue[], options: ListSessionsOptions): ChatSessionRecord[] {
    const clauses = [...where];
    const values = [...params];
    if (!options.includeArchived) clauses.push('archived_at IS NULL');
    if (options.projectId === null) clauses.push('project_id IS NULL');
    else if (options.projectId !== undefined) {
      clauses.push('project_id = ?');
      values.push(options.projectId);
    }
    const rows = this.db.all<ChatSessionRecord>(
      `SELECT * FROM chat_sessions${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC`,
      values,
    );
    // Matched here rather than with LIKE: SQLite folds case for ASCII only, and
    // titles are written in Portuguese. The list is small.
    const query = options.query?.trim().toLocaleLowerCase() ?? '';
    if (query.length === 0) return rows;
    return rows.filter((row) => row.title.toLocaleLowerCase().includes(query));
  }

  renameSession(id: string, title: string): ChatSessionRecord {
    this.db.run('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?', [title, now(), id]);
    return this.requireSession(id);
  }

  /** Archiving hides; it never deletes. `false` brings the conversation back. */
  setSessionArchived(id: string, archived: boolean): ChatSessionRecord {
    this.db.run('UPDATE chat_sessions SET archived_at = ? WHERE id = ?', [archived ? now() : null, id]);
    return this.requireSession(id);
  }

  /**
   * Removes the conversation and its messages. Runs are kept: their
   * `session_id` becomes NULL through the foreign key, so the execution history
   * and its evidence stay whole after the conversation is gone.
   */
  deleteSession(id: string): boolean {
    const result = this.db.run('DELETE FROM chat_sessions WHERE id = ?', [id]);
    return Number(result.changes) > 0;
  }

  countMessages(sessionId: string): number {
    const row = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', [
      sessionId,
    ]);
    return Number(row?.n ?? 0);
  }

  findSession(id: string): ChatSessionRecord | undefined {
    return this.db.get<ChatSessionRecord>('SELECT * FROM chat_sessions WHERE id = ?', [id]);
  }

  requireSession(id: string): ChatSessionRecord {
    const row = this.findSession(id);
    if (!row) throw new RecordNotFoundError('chat session', id);
    return row;
  }

  addMessage(input: {
    sessionId: string;
    author: string;
    kind?: string;
    body: string;
    runId?: string | null;
    agentId?: string | null;
    payload?: unknown;
  }): MessageRecord {
    const id = newId('msg');
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO messages (id, session_id, run_id, kind, author, agent_id, body, payload, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [
          id,
          input.sessionId,
          input.runId ?? null,
          input.kind ?? 'text',
          input.author,
          input.agentId ?? null,
          input.body,
          input.payload === undefined ? null : JSON.stringify(input.payload),
          timestamp,
        ] as SqlValue[],
      );
      this.db.run('UPDATE chat_sessions SET updated_at = ? WHERE id = ?', [timestamp, input.sessionId]);
    });
    return this.db.get<MessageRecord>('SELECT * FROM messages WHERE id = ?', [id])!;
  }

  /** Links a message to the run it started, once the run exists. */
  setMessageRun(messageId: string, runId: string): void {
    this.db.run('UPDATE messages SET run_id = ? WHERE id = ?', [runId, messageId]);
  }

  listMessages(sessionId: string, limit = 500): MessageRecord[] {
    return this.db.all<MessageRecord>(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid LIMIT ?',
      [sessionId, limit],
    );
  }
}

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

export type RunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED'
  | 'BLOCKED'
  /**
   * Stopped and waiting for a person, with nothing wrong.
   *
   * A budget the person set was reached, a subscription hit its limit, or a
   * credential needs attention. It is deliberately not FAILED: nothing broke,
   * and the difference decides what the interface offers next - "raise the
   * limit and continue" rather than "something went wrong".
   */
  | 'NEEDS_HUMAN';

export interface RunRecord extends SqlRow {
  id: string;
  session_id: string | null;
  workspace_id: string;
  objective: string;
  status: string;
  orchestrator_agent_id: string | null;
  iteration: number;
  max_iterations: number;
  baseline_commit: string | null;
  baseline_branch: string | null;
  baseline_dirty: number;
  termination_reason: string | null;
  artifacts_path: string | null;
  started_at: string;
  finished_at: string | null;
  /** The remote workspace this ran in, for a cloud run. */
  cloud_workspace_id: string | null;
  /** The coordinator's own id for this run. Null for a local run. */
  remote_run_id: string | null;
  /** The last event sequence this desktop applied. Null before the first sync. */
  remote_cursor: number | null;
  /** `coding` (needs evidence to finish) or `conversation` (needs an answer). */
  kind: string;
  invocation_count: number;
  total_tokens: number | null;
  total_cost_usd: number | null;
}

export interface RunStepRecord extends SqlRow {
  id: number;
  run_id: string;
  iteration: number;
  phase: string;
  status: string;
  summary: string | null;
  detail: string | null;
  started_at: string;
  finished_at: string | null;
}

export class RunRepository extends Repository {
  create(input: {
    id: string;
    sessionId: string | null;
    workspaceId: string;
    objective: string;
    orchestratorAgentId: string | null;
    maxIterations: number;
    artifactsPath?: string | null;
    /** Omitted means `coding`, which is what every run was before run kinds. */
    kind?: 'coding' | 'conversation';
  }): RunRecord {
    this.db.run(
      'INSERT INTO runs (id, session_id, workspace_id, objective, status, orchestrator_agent_id, iteration, max_iterations, artifacts_path, started_at, kind) VALUES (?,?,?,?,?,?,0,?,?,?,?)',
      [
        input.id,
        input.sessionId,
        input.workspaceId,
        input.objective,
        'PENDING',
        input.orchestratorAgentId,
        input.maxIterations,
        input.artifactsPath ?? null,
        now(),
        input.kind ?? 'coding',
      ],
    );
    return this.require(input.id);
  }

  find(id: string): RunRecord | undefined {
    return this.db.get<RunRecord>('SELECT * FROM runs WHERE id = ?', [id]);
  }

  require(id: string): RunRecord {
    const row = this.find(id);
    if (!row) throw new RecordNotFoundError('run', id);
    return row;
  }

  listForSession(sessionId: string): RunRecord[] {
    return this.db.all<RunRecord>('SELECT * FROM runs WHERE session_id = ? ORDER BY started_at', [
      sessionId,
    ]);
  }

  /** Runs the database still shows as going. After a restart, none really is. */
  listUnfinished(): RunRecord[] {
    return this.db.all<RunRecord>("SELECT * FROM runs WHERE status IN ('PENDING','RUNNING') ORDER BY started_at");
  }

  /** Every run of a workspace, newest first, whether or not its conversation still exists. */
  listForWorkspace(workspaceId: string, limit = 200): RunRecord[] {
    return this.db.all<RunRecord>(
      'SELECT * FROM runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?',
      [workspaceId, limit],
    );
  }

  setStatus(id: string, status: RunStatus, terminationReason?: string | null): void {
    const finished = status === 'RUNNING' || status === 'PENDING' ? null : now();
    this.db.run(
      'UPDATE runs SET status = ?, termination_reason = COALESCE(?, termination_reason), finished_at = ? WHERE id = ?',
      [status, terminationReason ?? null, finished, id],
    );
  }

  setBaseline(id: string, branch: string | null, commit: string | null, dirty: boolean): void {
    this.db.run(
      'UPDATE runs SET baseline_branch = ?, baseline_commit = ?, baseline_dirty = ? WHERE id = ?',
      [branch, commit, dirty ? 1 : 0, id],
    );
  }

  setIteration(id: string, iteration: number): void {
    this.db.run('UPDATE runs SET iteration = ? WHERE id = ?', [iteration, id]);
  }

  /** Binds a local run to the remote one that is actually executing it. */
  bindRemote(id: string, input: { remoteRunId: string; cloudWorkspaceId?: string | null }): void {
    this.db.run('UPDATE runs SET remote_run_id = ?, cloud_workspace_id = ? WHERE id = ?', [
      input.remoteRunId,
      input.cloudWorkspaceId ?? null,
      id,
    ]);
  }

  /**
   * How far this desktop has caught up with a remote run's event log.
   *
   * Stored rather than remembered, so an application that was closed for a
   * week resumes from the same place as one closed for a second - and neither
   * replays a step it already applied.
   */
  remoteCursor(id: string): number {
    return this.db.get<{ remote_cursor: number | null }>('SELECT remote_cursor FROM runs WHERE id = ?', [id])
      ?.remote_cursor ?? 0;
  }

  /** Advances the cursor. Never moves backwards: a stale sync cannot rewind it. */
  setRemoteCursor(id: string, cursor: number): void {
    this.db.run('UPDATE runs SET remote_cursor = MAX(COALESCE(remote_cursor, 0), ?) WHERE id = ?', [
      cursor,
      id,
    ]);
  }

  /** Local runs bound to a remote one that has not finished here yet. */
  listUnfinishedRemote(): RunRecord[] {
    return this.db.all<RunRecord>(
      `SELECT * FROM runs
        WHERE remote_run_id IS NOT NULL AND status NOT IN ('DONE','FAILED','CANCELLED')
        ORDER BY started_at ASC`,
    );
  }

  addStep(input: {
    runId: string;
    iteration: number;
    phase: string;
    status: string;
    summary?: string | null;
    detail?: string | null;
  }): number {
    const result = this.db.run(
      'INSERT INTO run_steps (run_id, iteration, phase, status, summary, detail, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?)',
      [
        input.runId,
        input.iteration,
        input.phase,
        input.status,
        input.summary ?? null,
        input.detail ?? null,
        now(),
        now(),
      ],
    );
    return Number(result.lastInsertRowid);
  }

  steps(runId: string): RunStepRecord[] {
    return this.db.all<RunStepRecord>('SELECT * FROM run_steps WHERE run_id = ? ORDER BY id', [runId]);
  }

  recordInvocation(input: {
    runId: string;
    iteration: number;
    agentId: string | null;
    accountId: string | null;
    role: string;
    task: string | null;
    outcome: string;
    exitCode: number | null;
    durationMs: number | null;
    startedAt: string;
    /** How the model was chosen; absent for an invocation that was not routed. */
    routing?: {
      requestedCapability: string | null;
      requestedReasoning: string | null;
      resolvedModel: string | null;
      resolvedReasoning: string | null;
      selectionMode: string;
      selectionReason: string;
      fallbackUsed: boolean;
    } | null;
    /** Which vendor, reached how, and as which team member. */
    providerId?: string | null;
    connectionKind?: string | null;
    workerId?: string | null;
    /** Tokens and estimated cost. Every field null when nothing reported them. */
    usage?: {
      billing: string;
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      costUsd: number | null;
    } | null;
    /** The classified provider failure, when there was one. */
    failureKind?: string | null;
  }): string {
    const id = newId('inv');
    const routing = input.routing ?? null;
    const usage = input.usage ?? null;
    this.db.run(
      'INSERT INTO agent_invocations (id, run_id, iteration, agent_id, account_id, role, task, outcome, exit_code, duration_ms, started_at, finished_at, requested_capability, requested_reasoning, resolved_model, resolved_reasoning, selection_mode, selection_reason, fallback_used, provider_id, connection_kind, worker_id, billing, input_tokens, output_tokens, total_tokens, cost_usd, failure_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.runId,
        input.iteration,
        input.agentId,
        input.accountId,
        input.role,
        input.task,
        input.outcome,
        input.exitCode,
        input.durationMs,
        input.startedAt,
        now(),
        routing?.requestedCapability ?? null,
        routing?.requestedReasoning ?? null,
        routing?.resolvedModel ?? null,
        routing?.resolvedReasoning ?? null,
        routing?.selectionMode ?? null,
        routing ? routing.selectionReason.slice(0, 1000) : null,
        routing ? (routing.fallbackUsed ? 1 : 0) : null,
        input.providerId ?? null,
        input.connectionKind ?? null,
        input.workerId ?? null,
        usage?.billing ?? null,
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        usage?.totalTokens ?? null,
        usage?.costUsd ?? null,
        input.failureKind ?? null,
      ] as SqlValue[],
    );
    this.addConsumption(input.runId, usage);
    return id;
  }

  /**
   * Adds one invocation's consumption to the run's running totals.
   *
   * Counted on every invocation, including a failed one: a call that was
   * refused after the tokens were read still cost something, and a run that
   * ended badly must not look cheaper than one that ended well.
   *
   * `NULL + n` is NULL in SQL, which is exactly right here: a run whose
   * providers reported nothing keeps NULL totals and is rendered as "não
   * informado", never as zero.
   */
  private addConsumption(
    runId: string,
    usage: { totalTokens: number | null; costUsd: number | null } | null,
  ): void {
    this.db.run(
      'UPDATE runs SET invocation_count = invocation_count + 1, ' +
        'total_tokens = CASE WHEN ? IS NULL THEN total_tokens ELSE COALESCE(total_tokens, 0) + ? END, ' +
        'total_cost_usd = CASE WHEN ? IS NULL THEN total_cost_usd ELSE COALESCE(total_cost_usd, 0) + ? END ' +
        'WHERE id = ?',
      [
        usage?.totalTokens ?? null,
        usage?.totalTokens ?? null,
        usage?.costUsd ?? null,
        usage?.costUsd ?? null,
        runId,
      ] as SqlValue[],
    );
  }

  invocations(runId: string): SqlRow[] {
    return this.db.all<SqlRow>(
      'SELECT * FROM agent_invocations WHERE run_id = ? ORDER BY started_at',
      [runId],
    );
  }

  recordVerification(input: {
    runId: string;
    iteration: number;
    definitionId: string | null;
    command: string;
    exitCode: number | null;
    passed: boolean;
    refused?: string | null;
    durationMs: number | null;
  }): void {
    this.db.run(
      'INSERT INTO verification_results (run_id, iteration, definition_id, command, exit_code, passed, refused, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [
        input.runId,
        input.iteration,
        input.definitionId,
        input.command,
        input.exitCode,
        input.passed ? 1 : 0,
        input.refused ?? null,
        input.durationMs,
        now(),
      ] as SqlValue[],
    );
  }

  verifications(runId: string): SqlRow[] {
    return this.db.all<SqlRow>(
      'SELECT * FROM verification_results WHERE run_id = ? ORDER BY id',
      [runId],
    );
  }
}

/* ------------------------------------------------------------------ *
 * Verification definitions
 * ------------------------------------------------------------------ */

export interface VerificationDefinitionRecord extends SqlRow {
  id: string;
  workspace_id: string;
  label: string;
  command: string;
  enabled: number;
  created_at: string;
}

/**
 * The commands a workspace owner has approved.
 *
 * An orchestrator agent asks for a verification **by id**; it never supplies a
 * command line. This repository is the only place a command string can enter
 * the system, and it only ever gets there because a human put it there.
 */
export class VerificationDefinitionRepository extends Repository {
  upsert(input: { id: string; workspaceId: string; label: string; command: string }): void {
    this.db.run(
      'INSERT INTO verification_definitions (id, workspace_id, label, command, enabled, created_at) VALUES (?,?,?,?,1,?) ON CONFLICT(workspace_id, id) DO UPDATE SET label = excluded.label, command = excluded.command',
      [input.id, input.workspaceId, input.label, input.command, now()],
    );
  }

  /**
   * The definitions an orchestrator may ask for: enabled ones only.
   *
   * A disabled definition is deliberately invisible here, so `resolve` reports
   * it as unknown and the loop refuses it rather than running it. The interface
   * uses `listAll` instead, which is the only place a disabled row is seen.
   */
  list(workspaceId: string): VerificationDefinitionRecord[] {
    return this.db.all<VerificationDefinitionRecord>(
      'SELECT * FROM verification_definitions WHERE workspace_id = ? AND enabled = 1 ORDER BY id',
      [workspaceId],
    );
  }

  /** Every definition of one workspace, enabled or not, for the interface. */
  listAll(workspaceId: string): VerificationDefinitionRecord[] {
    return this.db.all<VerificationDefinitionRecord>(
      'SELECT * FROM verification_definitions WHERE workspace_id = ? ORDER BY id',
      [workspaceId],
    );
  }

  /**
   * One definition, looked up by workspace *and* id.
   *
   * The workspace is part of the key, so a caller holding an id from another
   * project gets nothing back rather than someone else's row.
   */
  find(workspaceId: string, id: string): VerificationDefinitionRecord | undefined {
    return this.db.get<VerificationDefinitionRecord>(
      'SELECT * FROM verification_definitions WHERE workspace_id = ? AND id = ?',
      [workspaceId, id],
    );
  }

  /**
   * Adds a definition, refusing to overwrite one that already exists.
   *
   * `upsert` is the loader used by scripts and tests, where replacing is the
   * point. A person adding a verification in the interface means to add one, so
   * a clash is an error they can see rather than a silent replacement of the
   * command a run may already depend on.
   */
  create(input: {
    id: string;
    workspaceId: string;
    label: string;
    command: string;
    enabled?: boolean;
  }): VerificationDefinitionRecord {
    this.db.run(
      'INSERT INTO verification_definitions (id, workspace_id, label, command, enabled, created_at) VALUES (?,?,?,?,?,?)',
      [
        input.id,
        input.workspaceId,
        input.label,
        input.command,
        input.enabled === false ? 0 : 1,
        now(),
      ],
    );
    return this.require(input.workspaceId, input.id);
  }

  /** Changes label, command and/or enabled on an existing definition. */
  update(
    workspaceId: string,
    id: string,
    changes: { label?: string; command?: string; enabled?: boolean },
  ): VerificationDefinitionRecord {
    const existing = this.require(workspaceId, id);
    const label = changes.label ?? existing.label;
    const command = changes.command ?? existing.command;
    const enabled = changes.enabled === undefined ? existing.enabled : changes.enabled ? 1 : 0;
    this.db.run(
      'UPDATE verification_definitions SET label = ?, command = ?, enabled = ? WHERE workspace_id = ? AND id = ?',
      [label, command, enabled, workspaceId, id],
    );
    return this.require(workspaceId, id);
  }

  /** Removes one definition. Past results keep their own copy of the command. */
  remove(workspaceId: string, id: string): boolean {
    this.require(workspaceId, id);
    this.db.run('DELETE FROM verification_definitions WHERE workspace_id = ? AND id = ?', [
      workspaceId,
      id,
    ]);
    return true;
  }

  require(workspaceId: string, id: string): VerificationDefinitionRecord {
    const found = this.find(workspaceId, id);
    if (!found) throw new RecordNotFoundError('verification_definition', id);
    return found;
  }

  /** Resolves requested ids to commands, reporting the ones that do not exist. */
  resolve(
    workspaceId: string,
    ids: readonly string[],
  ): { commands: string[]; unknown: string[] } {
    const known = new Map(this.list(workspaceId).map((row) => [row.id, row.command]));
    const commands: string[] = [];
    const unknown: string[] = [];
    for (const id of ids) {
      const command = known.get(id);
      if (command === undefined) unknown.push(id);
      else commands.push(command);
    }
    return { commands, unknown };
  }
}

export class RecordNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(
    readonly entity: string,
    readonly entityId: string,
  ) {
    super(`No ${entity} with id ${entityId}`);
    this.name = 'RecordNotFoundError';
  }
}

/* ------------------------------------------------------------------------- *
 * Cloud execution
 * ------------------------------------------------------------------------- */

/**
 * One isolated workspace provisioned somewhere that is not this computer.
 *
 * The row is the durable part. Whatever the provisioner made - a container, a
 * machine, a directory on a host - is named only by `handle`, which this layer
 * never interprets. That is what lets the same table describe a workspace made
 * by a local container runtime today and by a managed service later, and what
 * lets a desktop that was closed find work that kept going without it.
 */
export interface CloudWorkspaceRecord extends SqlRow {
  id: string;
  workspace_id: string;
  session_id: string | null;
  provisioner: string;
  handle: string | null;
  repository: string;
  branch: string;
  /** The repository's absolute path **inside the environment**. */
  working_dir: string;
  /** `provisioning` | `ready` | `failed` | `released`. */
  status: string;
  status_detail: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  released_at: string | null;
}

export type CloudWorkspaceStatus = 'provisioning' | 'ready' | 'failed' | 'released';

export class CloudWorkspaceRepository extends Repository {
  create(input: {
    id: string;
    workspaceId: string;
    sessionId?: string | null;
    provisioner: string;
    repository: string;
    branch: string;
    workingDir: string;
    /** How long the environment may live before the reaper may reclaim it. */
    ttlMs?: number | null;
  }): CloudWorkspaceRecord {
    const timestamp = now();
    this.db.run(
      `INSERT INTO cloud_workspaces
         (id, workspace_id, session_id, provisioner, handle, repository, branch, working_dir,
          status, status_detail, created_at, updated_at, expires_at, released_at)
       VALUES (?,?,?,?,NULL,?,?,?,'provisioning',NULL,?,?,?,NULL)`,
      [
        input.id,
        input.workspaceId,
        input.sessionId ?? null,
        input.provisioner,
        input.repository,
        input.branch,
        input.workingDir,
        timestamp,
        timestamp,
        input.ttlMs ? new Date(Date.now() + input.ttlMs).toISOString() : null,
      ],
    );
    return this.require(input.id);
  }

  find(id: string): CloudWorkspaceRecord | undefined {
    return this.db.get<CloudWorkspaceRecord>('SELECT * FROM cloud_workspaces WHERE id = ?', [id]);
  }

  require(id: string): CloudWorkspaceRecord {
    const row = this.find(id);
    if (!row) throw new RecordNotFoundError('cloud workspace', id);
    return row;
  }

  /** The workspaces of one project, newest first. */
  list(workspaceId: string): CloudWorkspaceRecord[] {
    return this.db.all<CloudWorkspaceRecord>(
      'SELECT * FROM cloud_workspaces WHERE workspace_id = ? ORDER BY updated_at DESC',
      [workspaceId],
    );
  }

  /**
   * The live workspace of one session, if it still has one.
   *
   * Sessions get their own: two conversations in the same project must not
   * write over each other's uncommitted work.
   */
  findLiveForSession(sessionId: string): CloudWorkspaceRecord | undefined {
    return this.db.get<CloudWorkspaceRecord>(
      `SELECT * FROM cloud_workspaces
        WHERE session_id = ? AND status IN ('provisioning','ready')
        ORDER BY updated_at DESC LIMIT 1`,
      [sessionId],
    );
  }

  setHandle(id: string, handle: string): void {
    this.db.run('UPDATE cloud_workspaces SET handle = ?, updated_at = ? WHERE id = ?', [
      handle,
      now(),
      id,
    ]);
  }

  setStatus(id: string, status: CloudWorkspaceStatus, detail?: string | null): void {
    this.db.run(
      `UPDATE cloud_workspaces
          SET status = ?, status_detail = ?, updated_at = ?,
              released_at = CASE WHEN ? = 'released' THEN ? ELSE released_at END
        WHERE id = ?`,
      [status, detail ?? null, now(), status, now(), id],
    );
  }

  /**
   * Workspaces the reaper may reclaim: past their expiry, or left behind by a
   * process that ended. Cleanup is the coordinator's job precisely because the
   * desktop may be closed when the time comes.
   */
  listReclaimable(nowIso = now()): CloudWorkspaceRecord[] {
    return this.db.all<CloudWorkspaceRecord>(
      `SELECT * FROM cloud_workspaces
        WHERE status IN ('provisioning','ready')
          AND expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY expires_at ASC`,
      [nowIso],
    );
  }

  /** Everything still holding resources, whatever its session. */
  listLive(): CloudWorkspaceRecord[] {
    return this.db.all<CloudWorkspaceRecord>(
      "SELECT * FROM cloud_workspaces WHERE status IN ('provisioning','ready') ORDER BY created_at ASC",
    );
  }
}

/* ------------------------------------------------------------------ *
 * Agent messages
 * ------------------------------------------------------------------ */

export interface AgentMessageRow extends SqlRow {
  message_id: string;
  run_id: string;
  conversation_id: string;
  iteration: number;
  step_id: string | null;
  invocation_id: string | null;
  sender_agent_id: string | null;
  recipient_agent_id: string | null;
  message_type: string;
  payload: string;
  status: string;
  correlation_id: string;
  causation_id: string | null;
  dedupe_key: string;
  attempts: number;
  lease_expires_at: string | null;
  available_at: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Storage for the agent message bus.
 *
 * Every method here is a single statement or a single transaction, because the
 * bus's guarantees are the database's: a claim that both reads and writes must
 * not be able to hand the same row to two callers, and an insert that must not
 * be able to create a second copy of a message that already exists.
 *
 * SQL stops here, as everywhere else in this folder. `AgentMessageBus` sees
 * rows and nothing else.
 */
export class AgentMessageRepository extends Repository {
  /**
   * Inserts a message, or returns the one already stored under this key.
   *
   * This is the idempotency guarantee, and it is the database's rather than
   * the caller's: `dedupe_key` is UNIQUE, so a concurrent second publish loses
   * the race and reads the winner's row instead of creating a twin.
   */
  publish(input: {
    messageId: string;
    runId: string;
    conversationId: string;
    iteration: number;
    stepId: string | null;
    invocationId: string | null;
    senderAgentId: string | null;
    recipientAgentId: string | null;
    messageType: string;
    payload: string;
    correlationId: string;
    causationId: string | null;
    dedupeKey: string;
    availableAt: string;
    /** `pending` for a request; `completed` for a notice. See `isRequest`. */
    status: string;
  }): { row: AgentMessageRow; created: boolean } {
    const timestamp = now();
    const result = this.db.run(
      'INSERT INTO agent_messages (message_id, run_id, conversation_id, iteration, step_id, invocation_id, ' +
        'sender_agent_id, recipient_agent_id, message_type, payload, status, correlation_id, causation_id, ' +
        'dedupe_key, attempts, lease_expires_at, available_at, failure_reason, created_at, updated_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,NULL,?,?) ' +
        'ON CONFLICT(dedupe_key) DO NOTHING',
      [
        input.messageId,
        input.runId,
        input.conversationId,
        input.iteration,
        input.stepId,
        input.invocationId,
        input.senderAgentId,
        input.recipientAgentId,
        input.messageType,
        input.payload,
        input.status,
        input.correlationId,
        input.causationId,
        input.dedupeKey,
        input.availableAt,
        timestamp,
        timestamp,
      ],
    );
    const row = this.db.get<AgentMessageRow>('SELECT * FROM agent_messages WHERE dedupe_key = ?', [
      input.dedupeKey,
    ])!;
    return { row, created: result.changes > 0 };
  }

  find(messageId: string): AgentMessageRow | undefined {
    return this.db.get<AgentMessageRow>('SELECT * FROM agent_messages WHERE message_id = ?', [
      messageId,
    ]);
  }

  /**
   * Takes the oldest ready message for a recipient and leases it.
   *
   * One transaction, and the UPDATE is guarded on `status = 'pending'`, so two
   * callers racing for the same row cannot both come away holding it: the
   * loser's update changes nothing and it looks again.
   *
   * `busyScopes` carries the "one in flight per (run, recipient)" invariant.
   * Passing the runs that already have a leased message keeps a requeue from
   * putting a second copy of the same work in front of a busy worker.
   */
  claimNext(input: {
    recipientAgentId: string | null;
    now: string;
    leaseExpiresAt: string;
    busyRunIds: readonly string[];
  }): AgentMessageRow | undefined {
    return this.db.transaction(() => {
      const recipientClause =
        input.recipientAgentId === null
          ? 'recipient_agent_id IS NULL'
          : 'recipient_agent_id = ?';
      const params: SqlValue[] =
        input.recipientAgentId === null ? [input.now] : [input.recipientAgentId, input.now];
      let busyClause = '';
      if (input.busyRunIds.length > 0) {
        busyClause = ` AND run_id NOT IN (${input.busyRunIds.map(() => '?').join(',')})`;
        params.push(...input.busyRunIds);
      }
      const candidate = this.db.get<AgentMessageRow>(
        `SELECT * FROM agent_messages WHERE ${recipientClause} AND status = 'pending' ` +
          `AND available_at <= ?${busyClause} ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        params,
      );
      if (!candidate) return undefined;

      const claimed = this.db.run(
        "UPDATE agent_messages SET status = 'leased', attempts = attempts + 1, " +
          'lease_expires_at = ?, updated_at = ? WHERE message_id = ? AND status = \'pending\'',
        [input.leaseExpiresAt, now(), candidate.message_id],
      );
      if (claimed.changes === 0) return undefined;
      return this.find(candidate.message_id);
    });
  }

  /** Moves a leased message to a new status, guarded on the status it is in. */
  transition(input: {
    messageId: string;
    from: readonly string[];
    to: string;
    failureReason?: string | null;
    clearLease?: boolean;
  }): boolean {
    const placeholders = input.from.map(() => '?').join(',');
    const result = this.db.run(
      `UPDATE agent_messages SET status = ?, updated_at = ?` +
        (input.clearLease ? ', lease_expires_at = NULL' : '') +
        (input.failureReason === undefined ? '' : ', failure_reason = ?') +
        ` WHERE message_id = ? AND status IN (${placeholders})`,
      [
        input.to,
        now(),
        ...(input.failureReason === undefined ? [] : [input.failureReason]),
        input.messageId,
        ...input.from,
      ],
    );
    return result.changes > 0;
  }

  /** Returns a message to the queue with a backoff, keeping its attempt count. */
  requeue(input: { messageId: string; availableAt: string; failureReason: string | null }): boolean {
    return (
      this.db.run(
        "UPDATE agent_messages SET status = 'pending', lease_expires_at = NULL, available_at = ?, " +
          "failure_reason = ?, updated_at = ? WHERE message_id = ? AND status IN ('leased','started','failed')",
        [input.availableAt, input.failureReason, now(), input.messageId],
      ).changes > 0
    );
  }

  /**
   * Leases that passed their deadline.
   *
   * This is how a worker that died without a word stops being invisible: its
   * message is still `leased`, its deadline is in the past, and the sweep can
   * say so rather than leaving the run to wait forever.
   */
  expiredLeases(now: string, limit = 100): AgentMessageRow[] {
    return this.db.all<AgentMessageRow>(
      "SELECT * FROM agent_messages WHERE status IN ('leased','started') AND lease_expires_at IS NOT NULL " +
        'AND lease_expires_at <= ? ORDER BY lease_expires_at ASC LIMIT ?',
      [now, limit],
    );
  }

  /** Every message of a run, oldest first. What the timeline reads. */
  listForRun(runId: string): AgentMessageRow[] {
    return this.db.all<AgentMessageRow>(
      'SELECT * FROM agent_messages WHERE run_id = ? ORDER BY created_at ASC, rowid ASC',
      [runId],
    );
  }

  /** Every message of one exchange: the request and whatever answered it. */
  listForCorrelation(correlationId: string): AgentMessageRow[] {
    return this.db.all<AgentMessageRow>(
      'SELECT * FROM agent_messages WHERE correlation_id = ? ORDER BY created_at ASC, rowid ASC',
      [correlationId],
    );
  }

  /**
   * Marks every unfinished message of a run cancelled.
   *
   * Terminal rows are left exactly as they are: a result that already arrived
   * is not unmade by the run being cancelled afterwards, and rewriting it
   * would lose the only record that the work happened.
   */
  cancelRun(runId: string, reason: string): number {
    return this.db.run(
      "UPDATE agent_messages SET status = 'cancelled', lease_expires_at = NULL, failure_reason = ?, " +
        "updated_at = ? WHERE run_id = ? AND status NOT IN ('completed','dead','cancelled')",
      [reason, now(), runId],
    ).changes;
  }

  /** Messages still in flight, across every run. Used by crash recovery. */
  unfinished(limit = 500): AgentMessageRow[] {
    return this.db.all<AgentMessageRow>(
      "SELECT * FROM agent_messages WHERE status IN ('pending','leased','started','failed') " +
        'ORDER BY created_at ASC LIMIT ?',
      [limit],
    );
  }

  /** How many messages of a run sit in each status. What the panel counts. */
  countByStatus(runId: string): Record<string, number> {
    const rows = this.db.all<{ status: string; total: number }>(
      'SELECT status, COUNT(*) AS total FROM agent_messages WHERE run_id = ? GROUP BY status',
      [runId],
    );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = row.total;
    return counts;
  }
}
