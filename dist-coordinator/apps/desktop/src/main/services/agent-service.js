/**
 * Agents, at the minimum the first testable orchestrator needs.
 *
 * There are exactly two roles for now: ORCHESTRATOR (Codex) and CODING_WORKER
 * (Claude Code, bound to one of the user's accounts). The full Agents screen is
 * deliberately not built yet — what exists here is what a workspace needs to
 * name who supervises and who executes.
 */
/**
 * The orchestrator that exists before anyone has signed in.
 *
 * Codex can run without an account on a machine that already has one
 * configured, so this keeps the workspace screen usable from the first launch.
 * Once a Codex account exists, an agent bound to it is offered alongside.
 */
export const CODEX_ORCHESTRATOR_ID = 'agent-codex-orchestrator';
export class AgentService {
    database;
    constructor(database) {
        this.database = database;
    }
    /**
     * Makes sure the agents implied by the current runtimes and accounts exist.
     *
     * Called on boot and after an account changes, so the workspace screen always
     * has something to offer without a separate "create agent" step.
     */
    sync() {
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
            }
            else if (account.provider_id === 'openai') {
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
    list() {
        this.sync();
        return this.database.agents.list().map((row) => ({
            id: row.id,
            name: row.display_name,
            role: row.role,
            runtimeId: row.adapter_id === 'codex-cli' ? 'codex' : 'claude-code',
            accountId: row.account_id,
        }));
    }
}
/** Deterministic, so syncing twice does not create a second worker agent. */
export function workerAgentIdFor(accountId) {
    return `agent-worker-${accountId}`;
}
/** Likewise for the orchestrator bound to a Codex account. */
export function orchestratorAgentIdFor(accountId) {
    return `agent-orchestrator-${accountId}`;
}
//# sourceMappingURL=agent-service.js.map