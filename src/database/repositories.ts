/**
 * Typed access to the entities the interface reads.
 *
 * These tables already exist (schema v1). Nothing here adds a table, a column
 * or a second place where a fact lives - it is the read/write surface over
 * what `schema.ts` already defines, so the interface never has to hold state
 * the database is already holding.
 */

import { randomUUID } from 'node:crypto';
import type { SqlDriver, SqlRow, SqlValue } from './driver.js';

abstract class Repository {
  constructor(protected readonly getDriver: () => SqlDriver) {}
  protected get db(): SqlDriver {
    return this.getDriver();
  }
}

// -- Providers and accounts -------------------------------------------------

export interface ProviderRecord extends SqlRow {
  id: string;
  display_name: string;
  enabled: number;
  created_at: string;
}

export class ProviderRepository extends Repository {
  /** Inserts the vendors the application knows about. Idempotent. */
  ensure(providers: { id: string; displayName: string }[]): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const p of providers) {
        this.db.run(
          'INSERT INTO providers (id, display_name, enabled, created_at) VALUES (?,?,1,?) ON CONFLICT(id) DO NOTHING',
          [p.id, p.displayName, now],
        );
      }
    });
  }

  all(): ProviderRecord[] {
    return this.db.all<ProviderRecord>('SELECT * FROM providers ORDER BY id');
  }
}

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
}

export class AccountRepository extends Repository {
  all(): AccountRecord[] {
    return this.db.all<AccountRecord>(
      'SELECT * FROM accounts ORDER BY provider_id, created_at',
    );
  }

  byProvider(providerId: string): AccountRecord[] {
    return this.db.all<AccountRecord>(
      'SELECT * FROM accounts WHERE provider_id = ? ORDER BY created_at',
      [providerId],
    );
  }

  get(id: string): AccountRecord | undefined {
    return this.db.get<AccountRecord>('SELECT * FROM accounts WHERE id = ?', [id]);
  }

  insert(record: {
    id: string;
    providerId: string;
    displayName: string;
    profileDirectory: string;
  }): AccountRecord {
    this.db.run(
      `INSERT INTO accounts (id, provider_id, display_name, profile_directory, auth_state, created_at)
       VALUES (?,?,?,?,'disconnected',?)`,
      [record.id, record.providerId, record.displayName, record.profileDirectory, new Date().toISOString()],
    );
    return this.get(record.id)!;
  }

  rename(id: string, displayName: string): void {
    this.db.run('UPDATE accounts SET display_name = ? WHERE id = ?', [displayName, id]);
  }

  /** Records what the CLI reported. `connected` also stamps the connection time. */
  recordStatus(id: string, state: string, authMethod: string | null): void {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE accounts SET auth_state = ?, auth_method = ?, last_checked_at = ?,
         last_connected_at = CASE WHEN ? = 'connected' THEN ? ELSE last_connected_at END
       WHERE id = ?`,
      [state, authMethod, now, state, now, id],
    );
  }

  remove(id: string): void {
    this.db.run('DELETE FROM accounts WHERE id = ?', [id]);
  }
}

// -- Agents -----------------------------------------------------------------

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
  all(): AgentRecord[] {
    return this.db.all<AgentRecord>('SELECT * FROM agents ORDER BY priority DESC, created_at');
  }

  get(id: string): AgentRecord | undefined {
    return this.db.get<AgentRecord>('SELECT * FROM agents WHERE id = ?', [id]);
  }

  byRole(role: string): AgentRecord[] {
    return this.db.all<AgentRecord>(
      'SELECT * FROM agents WHERE role = ? AND enabled = 1 ORDER BY priority DESC',
      [role],
    );
  }

  upsert(record: {
    id: string;
    displayName: string;
    providerId: string;
    accountId: string | null;
    adapterId: string;
    role: string;
    model: string | null;
    runtimeOptions?: Record<string, unknown>;
  }): void {
    this.db.run(
      `INSERT INTO agents (id, display_name, provider_id, account_id, adapter_id, role, model,
                           enabled, priority, capabilities, runtime_options, created_at)
       VALUES (?,?,?,?,?,?,?,1,0,'{}',?,?)
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         account_id   = excluded.account_id,
         model        = excluded.model,
         runtime_options = excluded.runtime_options`,
      [
        record.id,
        record.displayName,
        record.providerId,
        record.accountId,
        record.adapterId,
        record.role,
        record.model,
        JSON.stringify(record.runtimeOptions ?? {}),
        new Date().toISOString(),
      ] as SqlValue[],
    );
  }

  /** Detaches an account from every agent that used it, without deleting the agent. */
  clearAccount(accountId: string): void {
    this.db.run('UPDATE agents SET account_id = NULL WHERE account_id = ?', [accountId]);
  }
}

// -- Workspaces -------------------------------------------------------------

export interface WorkspaceRecord extends SqlRow {
  id: string;
  display_name: string;
  local_path: string;
  repository_url: string | null;
  default_branch: string | null;
  instructions: string | null;
  created_at: string;
  last_opened_at: string | null;
}

export class WorkspaceRepository extends Repository {
  all(): WorkspaceRecord[] {
    return this.db.all<WorkspaceRecord>(
      'SELECT * FROM workspaces ORDER BY last_opened_at DESC NULLS LAST, created_at DESC',
    );
  }

  get(id: string): WorkspaceRecord | undefined {
    return this.db.get<WorkspaceRecord>('SELECT * FROM workspaces WHERE id = ?', [id]);
  }

  byPath(localPath: string): WorkspaceRecord | undefined {
    return this.db.get<WorkspaceRecord>('SELECT * FROM workspaces WHERE local_path = ?', [localPath]);
  }

  /** Registers a folder as a workspace, or returns the one already registered. */
  ensure(record: { displayName: string; localPath: string; repositoryUrl?: string | null }): WorkspaceRecord {
    const existing = this.byPath(record.localPath);
    if (existing) return existing;
    const id = randomUUID();
    this.db.run(
      `INSERT INTO workspaces (id, display_name, local_path, repository_url, created_at)
       VALUES (?,?,?,?,?)`,
      [id, record.displayName, record.localPath, record.repositoryUrl ?? null, new Date().toISOString()],
    );
    return this.get(id)!;
  }

  touch(id: string): void {
    this.db.run('UPDATE workspaces SET last_opened_at = ? WHERE id = ?', [new Date().toISOString(), id]);
  }
}

// -- Chat sessions and messages ---------------------------------------------

export interface ChatSessionRecord extends SqlRow {
  id: string;
  workspace_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export class ChatSessionRepository extends Repository {
  byWorkspace(workspaceId: string, limit = 50): ChatSessionRecord[] {
    return this.db.all<ChatSessionRecord>(
      'SELECT * FROM chat_sessions WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ?',
      [workspaceId, limit],
    );
  }

  get(id: string): ChatSessionRecord | undefined {
    return this.db.get<ChatSessionRecord>('SELECT * FROM chat_sessions WHERE id = ?', [id]);
  }

  create(workspaceId: string, title: string): ChatSessionRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO chat_sessions (id, workspace_id, title, created_at, updated_at) VALUES (?,?,?,?,?)',
      [id, workspaceId, title, now, now],
    );
    return this.get(id)!;
  }

  touch(id: string): void {
    this.db.run('UPDATE chat_sessions SET updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);
  }
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

export class MessageRepository extends Repository {
  bySession(sessionId: string): MessageRecord[] {
    return this.db.all<MessageRecord>(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid',
      [sessionId],
    );
  }

  append(record: {
    sessionId: string;
    runId?: string | null;
    kind: string;
    author: string;
    agentId?: string | null;
    body: string;
    payload?: unknown;
  }): MessageRecord {
    const id = randomUUID();
    this.db.run(
      `INSERT INTO messages (id, session_id, run_id, kind, author, agent_id, body, payload, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        id,
        record.sessionId,
        record.runId ?? null,
        record.kind,
        record.author,
        record.agentId ?? null,
        record.body,
        record.payload === undefined ? null : JSON.stringify(record.payload),
        new Date().toISOString(),
      ],
    );
    return this.db.get<MessageRecord>('SELECT * FROM messages WHERE id = ?', [id])!;
  }
}

// -- Runs and everything hanging off them -----------------------------------

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
}

/** Statuses that mean the run is still the workspace's active one. */
const OPEN_STATUSES = [
  'PLANNING',
  'DELEGATING',
  'WORKER_RUNNING',
  'COLLECTING_EVIDENCE',
  'VERIFYING',
  'REVIEWING',
  'RETRYING',
  'PAUSING',
  'PAUSED',
  'NEEDS_HUMAN',
];

export class RunRepository extends Repository {
  byWorkspace(workspaceId: string, limit = 100): RunRecord[] {
    return this.db.all<RunRecord>(
      'SELECT * FROM runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?',
      [workspaceId, limit],
    );
  }

  get(id: string): RunRecord | undefined {
    return this.db.get<RunRecord>('SELECT * FROM runs WHERE id = ?', [id]);
  }

  /** The run the workspace is currently living in, if any. */
  active(workspaceId: string): RunRecord | undefined {
    const placeholders = OPEN_STATUSES.map(() => '?').join(',');
    return this.db.get<RunRecord>(
      `SELECT * FROM runs WHERE workspace_id = ? AND status IN (${placeholders})
       ORDER BY started_at DESC LIMIT 1`,
      [workspaceId, ...OPEN_STATUSES],
    );
  }

  /** The most recent run overall, so a finished run stays on screen. */
  latest(workspaceId: string): RunRecord | undefined {
    return this.db.get<RunRecord>(
      'SELECT * FROM runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 1',
      [workspaceId],
    );
  }

  create(record: {
    workspaceId: string;
    sessionId: string | null;
    objective: string;
    maxIterations: number;
    orchestratorAgentId?: string | null;
    baselineBranch?: string | null;
    baselineCommit?: string | null;
    baselineDirty?: boolean;
    artifactsPath?: string | null;
  }): RunRecord {
    const id = randomUUID();
    this.db.run(
      `INSERT INTO runs (id, session_id, workspace_id, objective, status, orchestrator_agent_id,
                         iteration, max_iterations, baseline_commit, baseline_branch, baseline_dirty,
                         artifacts_path, started_at)
       VALUES (?,?,?,?,'PLANNING',?,0,?,?,?,?,?,?)`,
      [
        id,
        record.sessionId,
        record.workspaceId,
        record.objective,
        record.orchestratorAgentId ?? null,
        record.maxIterations,
        record.baselineCommit ?? null,
        record.baselineBranch ?? null,
        record.baselineDirty ? 1 : 0,
        record.artifactsPath ?? null,
        new Date().toISOString(),
      ] as SqlValue[],
    );
    return this.get(id)!;
  }

  setStatus(id: string, status: string, terminationReason?: string | null): void {
    const terminal = ['DONE', 'CANCELLED', 'FAILED'].includes(status);
    this.db.run(
      `UPDATE runs SET status = ?, termination_reason = COALESCE(?, termination_reason),
         finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
       WHERE id = ?`,
      [status, terminationReason ?? null, terminal ? 1 : 0, new Date().toISOString(), id],
    );
  }

  setIteration(id: string, iteration: number): void {
    this.db.run('UPDATE runs SET iteration = ? WHERE id = ?', [iteration, id]);
  }
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

export class RunStepRepository extends Repository {
  byRun(runId: string): RunStepRecord[] {
    return this.db.all<RunStepRecord>(
      'SELECT * FROM run_steps WHERE run_id = ? ORDER BY iteration, id',
      [runId],
    );
  }

  start(record: { runId: string; iteration: number; phase: string; summary?: string | null }): number {
    const result = this.db.run(
      `INSERT INTO run_steps (run_id, iteration, phase, status, summary, started_at)
       VALUES (?,?,?,'running',?,?)`,
      [record.runId, record.iteration, record.phase, record.summary ?? null, new Date().toISOString()],
    );
    return Number(result.lastInsertRowid);
  }

  finish(id: number, status: string, summary?: string | null, detail?: string | null): void {
    this.db.run(
      `UPDATE run_steps SET status = ?, summary = COALESCE(?, summary), detail = COALESCE(?, detail),
         finished_at = ? WHERE id = ?`,
      [status, summary ?? null, detail ?? null, new Date().toISOString(), id],
    );
  }
}

export interface AgentInvocationRecord extends SqlRow {
  id: string;
  run_id: string;
  iteration: number;
  agent_id: string | null;
  account_id: string | null;
  role: string;
  task: string | null;
  outcome: string;
  exit_code: number | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
}

export class AgentInvocationRepository extends Repository {
  byRun(runId: string): AgentInvocationRecord[] {
    return this.db.all<AgentInvocationRecord>(
      'SELECT * FROM agent_invocations WHERE run_id = ? ORDER BY iteration, started_at, rowid',
      [runId],
    );
  }

  start(record: {
    runId: string;
    iteration: number;
    role: string;
    agentId: string | null;
    accountId: string | null;
    task: string | null;
  }): string {
    const id = randomUUID();
    this.db.run(
      `INSERT INTO agent_invocations (id, run_id, iteration, agent_id, account_id, role, task, outcome, started_at)
       VALUES (?,?,?,?,?,?,?,'running',?)`,
      [
        id,
        record.runId,
        record.iteration,
        record.agentId,
        record.accountId,
        record.role,
        record.task,
        new Date().toISOString(),
      ],
    );
    return id;
  }

  finish(id: string, outcome: string, exitCode: number | null, durationMs: number | null): void {
    this.db.run(
      'UPDATE agent_invocations SET outcome = ?, exit_code = ?, duration_ms = ?, finished_at = ? WHERE id = ?',
      [outcome, exitCode, durationMs, new Date().toISOString(), id],
    );
  }
}

export interface VerificationResultRecord extends SqlRow {
  id: number;
  run_id: string;
  iteration: number;
  definition_id: string | null;
  command: string;
  exit_code: number | null;
  passed: number;
  refused: string | null;
  duration_ms: number | null;
  output_path: string | null;
  created_at: string;
}

export class VerificationResultRepository extends Repository {
  byRun(runId: string): VerificationResultRecord[] {
    return this.db.all<VerificationResultRecord>(
      'SELECT * FROM verification_results WHERE run_id = ? ORDER BY iteration, id',
      [runId],
    );
  }

  record(entry: {
    runId: string;
    iteration: number;
    definitionId: string | null;
    command: string;
    exitCode: number | null;
    passed: boolean;
    refused?: string | null;
    durationMs?: number | null;
    outputPath?: string | null;
  }): void {
    this.db.run(
      `INSERT INTO verification_results (run_id, iteration, definition_id, command, exit_code,
                                         passed, refused, duration_ms, output_path, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        entry.runId,
        entry.iteration,
        entry.definitionId,
        entry.command,
        entry.exitCode,
        entry.passed ? 1 : 0,
        entry.refused ?? null,
        entry.durationMs ?? null,
        entry.outputPath ?? null,
        new Date().toISOString(),
      ] as SqlValue[],
    );
  }
}

export interface VerificationDefinitionRecord extends SqlRow {
  id: string;
  workspace_id: string;
  label: string;
  command: string;
  enabled: number;
  created_at: string;
}

export class VerificationDefinitionRepository extends Repository {
  byWorkspace(workspaceId: string): VerificationDefinitionRecord[] {
    return this.db.all<VerificationDefinitionRecord>(
      'SELECT * FROM verification_definitions WHERE workspace_id = ? ORDER BY id',
      [workspaceId],
    );
  }
}

export interface ArtifactRecord extends SqlRow {
  id: string;
  workspace_id: string | null;
  session_id: string | null;
  run_id: string | null;
  invocation_id: string | null;
  kind: string;
  label: string | null;
  relative_path: string;
  mime_type: string | null;
  bytes: number | null;
  created_at: string;
}

export class ArtifactRepository extends Repository {
  byRun(runId: string): ArtifactRecord[] {
    return this.db.all<ArtifactRecord>(
      'SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at',
      [runId],
    );
  }

  record(entry: {
    workspaceId: string | null;
    sessionId?: string | null;
    runId: string | null;
    invocationId?: string | null;
    kind: string;
    label?: string | null;
    relativePath: string;
    mimeType?: string | null;
    bytes?: number | null;
  }): string {
    const id = randomUUID();
    this.db.run(
      `INSERT INTO artifacts (id, workspace_id, session_id, run_id, invocation_id, kind, label,
                              relative_path, mime_type, bytes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        entry.workspaceId,
        entry.sessionId ?? null,
        entry.runId,
        entry.invocationId ?? null,
        entry.kind,
        entry.label ?? null,
        entry.relativePath,
        entry.mimeType ?? null,
        entry.bytes ?? null,
        new Date().toISOString(),
      ] as SqlValue[],
    );
    return id;
  }
}
