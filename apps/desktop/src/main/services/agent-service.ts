/**
 * Agents, at the minimum the first testable orchestrator needs.
 *
 * There are exactly two roles for now: ORCHESTRATOR (Codex) and CODING_WORKER
 * (Claude Code, bound to one of the user's accounts). The full Agents screen is
 * deliberately not built yet — what exists here is what a workspace needs to
 * name who supervises and who executes.
 */

import type { Database } from '../core.js';
import type { AgentView } from '../../shared/ipc-contract.js';

/** The orchestrator is a single fixed agent until more providers arrive. */
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
      this.database.agents.ensure({
        id: workerAgentIdFor(account.id),
        displayName: account.display_name,
        providerId: account.provider_id,
        accountId: account.id,
        adapterId: 'claude-code-cli',
        role: 'CODING_WORKER',
      });
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
}

/** Deterministic, so syncing twice does not create a second worker agent. */
export function workerAgentIdFor(accountId: string): string {
  return `agent-worker-${accountId}`;
}
