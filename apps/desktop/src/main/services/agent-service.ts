/**
 * Agents, at the minimum the first testable orchestrator needs.
 *
 * There are exactly two roles for now: ORCHESTRATOR (Codex) and CODING_WORKER
 * (Claude Code, bound to one of the user's accounts). The full Agents screen is
 * deliberately not built yet — what exists here is what a workspace needs to
 * name who supervises and who executes.
 */

import type { Database } from '../core.js';
import type { AgentStatusView, AgentView, ProviderName } from '../../shared/ipc-contract.js';

/**
 * The orchestrator that exists before anyone has signed in.
 *
 * Codex can run without an account on a machine that already has one
 * configured, so this keeps the workspace screen usable from the first launch.
 * Once a Codex account exists, an agent bound to it is offered alongside.
 */
export const CODEX_ORCHESTRATOR_ID = 'agent-codex-orchestrator';

export class AgentService {
  constructor(private readonly database: Database) {}

  /**
   * Makes sure the agents implied by the current runtimes and accounts exist.
   *
   * Called on boot and after an account changes, so the workspace screen always
   * has something to offer without a separate "create agent" step.
   */
  sync(): void {
    this.database.providers.ensureSeeded();
    this.database.agents.ensure({
      id: CODEX_ORCHESTRATOR_ID,
      displayName: 'Codex',
      providerId: 'openai',
      accountId: null,
      adapterId: 'codex-cli',
      role: 'ORCHESTRATOR',
    });
    for (const account of this.database.accounts.list()) {
      // The provider decides the role: an Anthropic account can do the work, an
      // OpenAI one can supervise. Neither is asked to do the other's job.
      if (account.provider_id === 'anthropic') {
        this.database.agents.ensure({
          id: workerAgentIdFor(account.id),
          displayName: account.display_name,
          providerId: account.provider_id,
          accountId: account.id,
          adapterId: 'claude-code-cli',
          role: 'CODING_WORKER',
        });
      } else if (account.provider_id === 'openai') {
        this.database.agents.ensure({
          id: orchestratorAgentIdFor(account.id),
          displayName: account.display_name,
          providerId: account.provider_id,
          accountId: account.id,
          adapterId: 'codex-cli',
          role: 'ORCHESTRATOR',
        });
      }
    }
  }

  list(): AgentView[] {
    this.sync();
    return this.database.agents.list().map((row) => ({
      id: row.id,
      name: row.display_name,
      role: row.role,
      runtimeId: row.adapter_id === 'codex-cli' ? ('codex' as const) : ('claude-code' as const),
      accountId: row.account_id,
    }));
  }

  /**
   * Every agent, with what it is and what it is doing.
   *
   * The panel's data. Identity and credential are kept apart on purpose: an
   * agent has a connection, and two agents on two connections of the same
   * vendor are two team members rather than two adapters or two keys. Nothing
   * here reads a credential, and nothing here can: connections are named, and
   * their secrets live in a table this never touches.
   */
  status(): AgentStatusView[] {
    this.sync();
    const accounts = new Map(this.database.accounts.list().map((row) => [row.id, row]));
    const lastActive = this.database.runs.lastActivityByAgent();
    // Which agent is inside which run right now, read from the invocations of
    // the runs the database still shows as unfinished.
    const inFlight = new Map<string, { runId: string; task: string; startedAt: string }>();
    for (const run of this.database.runs.listUnfinished()) {
      if (run.status !== 'RUNNING') continue;
      for (const invocation of this.database.runs.invocations(run.id)) {
        const finished = invocation.finished_at ?? invocation.duration_ms;
        if (finished !== null && finished !== undefined) continue;
        const agentId = invocation.agent_id;
        if (typeof agentId !== 'string') continue;
        inFlight.set(agentId, {
          runId: run.id,
          task: String(invocation.task ?? '').slice(0, 200),
          startedAt: String(invocation.started_at ?? ''),
        });
      }
    }

    const now = Date.now();
    return this.database.agents.list().map((row) => {
      const account = row.account_id ? accounts.get(row.account_id) : undefined;
      const current = inFlight.get(row.id);
      // Four states, and the difference between two of them matters most:
      // `offline` is a connection that is not signed in, which a person has to
      // fix; `idle` is a team member waiting for work, which needs nothing.
      // Telling someone the wrong one sends them to the wrong screen.
      const status: AgentStatusView['status'] = current
        ? 'running'
        : row.account_id && account?.auth_state !== 'connected'
          ? 'offline'
          : 'idle';
      const startedAt = current?.startedAt ? Date.parse(current.startedAt) : NaN;
      return {
        agentId: row.id,
        name: row.display_name,
        role: row.role,
        runtimeId: row.adapter_id === 'codex-cli' ? ('codex' as const) : ('claude-code' as const),
        connectionId: row.account_id,
        connectionName: account?.display_name ?? null,
        provider: (account?.provider_id as ProviderName | undefined) ?? null,
        connectionKind: account?.connection_kind ?? null,
        status,
        currentTask: current?.task ?? null,
        currentRunId: current?.runId ?? null,
        runningForMs: Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : null,
        lastActiveAt: lastActive.get(row.id) ?? null,
        awaitingReply: this.database.agentMessages.awaitingReply(row.id),
      };
    });
  }
}

/** Deterministic, so syncing twice does not create a second worker agent. */
export function workerAgentIdFor(accountId: string): string {
  return `agent-worker-${accountId}`;
}

/** Likewise for the orchestrator bound to a Codex account. */
export function orchestratorAgentIdFor(accountId: string): string {
  return `agent-orchestrator-${accountId}`;
}
