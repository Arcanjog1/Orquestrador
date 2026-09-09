/** Agents have independent identities and persisted configuration; legacy per-account seeds remain compatible. */

import { newId } from '../core.js';
import { modelCapability } from '../../../../../src/routing/provider-policy.js';
import type { AgentInputView, ManagedAgentView } from '../../shared/ipc-contract.js';
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

  manage(): ManagedAgentView[] {
    this.sync();
    return this.database.agents.allManaged().filter(row => row.account_id !== null).map(row => {
      const config = agentConfig(row.runtime_options);
      return { id:row.id, name:row.display_name, role:row.role as ManagedAgentView['role'],
        provider:row.provider_id as ProviderName, runtimeId:row.adapter_id==='codex-cli'?'codex':'claude-code',
        accountId:row.account_id!, model:row.model, reasoning:config.reasoning ?? null,
        maxCapability:config.maxCapability ?? null, maxReasoning:config.maxReasoning ?? null, enabled:row.enabled===1 };
    });
  }

  create(input: AgentInputView): ManagedAgentView {
    this.validate(input);
    const id = newId('agent');
    this.database.agents.create({id, displayName:input.name.trim(), providerId:input.provider,
      accountId:input.accountId, adapterId:input.provider==='openai'?'codex-cli':'claude-code-cli',role:input.role});
    return this.update(id, input);
  }

  update(id: string, input: AgentInputView): ManagedAgentView {
    const row = this.database.agents.require(id);
    if (row.enabled < 0) throw new Error('Este agente foi removido.');
    if (this.database.agents.busy(id)) throw new Error('Cancele a execução antes de alterar este agente.');
    this.validate(input);
    this.database.agents.configure(id,{...input,name:input.name.trim(),options:JSON.stringify({managed:true,
      reasoning:input.reasoning,maxCapability:input.maxCapability,maxReasoning:input.maxReasoning})});
    return this.manage().find(agent=>agent.id===id)!;
  }

  remove(id: string): boolean {
    this.database.agents.require(id);
    if (this.database.agents.busy(id)) throw new Error('Cancele a execução antes de remover este agente.');
    // Tombstone preserves invocation identity and stops automatic sync resurrecting a removed seed.
    this.database.agents.archive(id);
    return true;
  }

  private validate(input: AgentInputView): void {
    if (!input.name.trim() || input.name.length>200) throw new Error('Escolha um nome de até 200 caracteres.');
    if (!['ORCHESTRATOR','CODING_WORKER'].includes(input.role)) throw new Error('Papel inválido.');
    const provider = input.role==='ORCHESTRATOR'?'openai':'anthropic';
    if (input.provider!==provider) throw new Error('O provedor não corresponde ao papel escolhido.');
    const account = this.database.accounts.find(input.accountId);
    if (!account || account.provider_id!==provider) throw new Error('Escolha uma conta do provedor correto.');
    if (input.model && !modelCapability(provider,input.model)) throw new Error('Modelo desconhecido nesta política. Use um alias reconhecido.');
    if (input.reasoning && !['low','medium','high','xhigh','max'].includes(input.reasoning)) throw new Error('Raciocínio inválido.');
    if (input.maxCapability && !['FAST','BALANCED','STRONG','MAX'].includes(input.maxCapability)) throw new Error('Teto de modelo inválido.');
    if (input.maxReasoning && !['LOW','MEDIUM','HIGH','MAX'].includes(input.maxReasoning)) throw new Error('Teto de raciocínio inválido.');
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

export function agentConfig(raw: string): Partial<Pick<AgentInputView,'reasoning'|'maxCapability'|'maxReasoning'>> & {managed?:boolean} {
  try { return JSON.parse(raw); } catch { return {}; }
}
