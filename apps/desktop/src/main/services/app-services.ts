/**
 * The service container.
 *
 * One place builds the object graph, and it takes every awkward dependency —
 * where data lives, how a URL is opened, which agent runners a workspace gets —
 * as an option. That is what lets the exact same graph run under Electron and
 * under `node --test` with an in-memory database and fake agents.
 *
 * Nothing in this file, or anything it constructs, imports Electron.
 */

import {
  ClaudeAccountManager,
  CodexAccountManager,
  Database,
  ProcessManager,
  RuntimeManager,
  appPaths,
  isUsable,
} from '../core.js';
import type { AppPaths, WorkspaceWithAgents } from '../core.js';
import { EventBus } from '../events.js';
import { AccountService, type UrlOpener } from './account-service.js';
import { AgentService, workerAgentIdFor } from './agent-service.js';
import { ChatService } from './chat-service.js';
import {
  OrchestrationService,
  type OrchestrationOptions,
  type RunnerFactory,
  type RunnerPair,
} from './orchestration-service.js';
import { RuntimeService } from './runtime-service.js';
import { VerificationService } from './verification-service.js';
import { WorkspaceService } from './workspace-service.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import { DECISION_JSON_SCHEMA } from '../core.js';
import { ClaudeCodeAdapter } from '../adapters/claude-adapter.js';

export interface AppServicesOptions {
  paths?: AppPaths;
  /** `:memory:` in tests. */
  databaseFile?: string;
  /** Opens a sign-in URL. Electron passes `shell.openExternal`. */
  openUrl?: UrlOpener;
  /** Overrides how a workspace's agents are built. Tests pass fakes. */
  createRunners?: RunnerFactory;
  orchestration?: OrchestrationOptions;
}

export class AppServices {
  readonly events = new EventBus();
  readonly paths: AppPaths;
  readonly processManager: ProcessManager;
  readonly runtimeManager: RuntimeManager;
  readonly database: Database;
  readonly accountManager: ClaudeAccountManager;
  readonly codexAccountManager: CodexAccountManager;

  readonly runtimes: RuntimeService;
  readonly accounts: AccountService;
  readonly agents: AgentService;
  readonly workspaces: WorkspaceService;
  /** The project's registered verifications, as the interface configures them. */
  readonly verifications: VerificationService;
  readonly orchestration: OrchestrationService;
  readonly chat: ChatService;

  constructor(options: AppServicesOptions = {}) {
    this.paths = options.paths ?? appPaths();
    this.processManager = new ProcessManager();
    this.runtimeManager = new RuntimeManager({ paths: this.paths });
    this.database = new Database({
      paths: this.paths,
      ...(options.databaseFile ? { filePath: options.databaseFile } : {}),
    });
    this.accountManager = new ClaudeAccountManager({
      runtimeManager: this.runtimeManager,
      paths: this.paths,
      processManager: this.processManager,
    });
    this.codexAccountManager = new CodexAccountManager({
      runtimeManager: this.runtimeManager,
      paths: this.paths,
      processManager: this.processManager,
    });

    this.runtimes = new RuntimeService(this.runtimeManager, this.events, this.database);
    this.accounts = new AccountService(
      this.database,
      { anthropic: this.accountManager, openai: this.codexAccountManager },
      this.events,
      options.openUrl ?? (() => {}),
    );
    this.agents = new AgentService(this.database);
    this.workspaces = new WorkspaceService(this.database, this.runtimes, this.processManager);
    this.verifications = new VerificationService(this.database);
    this.orchestration = new OrchestrationService(
      this.database,
      this.processManager,
      this.events,
      options.createRunners ?? ((workspace) => this.buildRunners(workspace)),
      options.orchestration ?? {},
      // Tests supplying their own runners are supplying their own agents too,
      // so there is nothing to check.
      options.createRunners ? async () => null : (workspace) => this.checkAgentsReady(workspace),
    );
    this.chat = new ChatService(this.database, this.orchestration);

    this.database.providers.ensureSeeded();
    this.agents.sync();
  }

  /**
   * Whether this workspace's agents can actually work.
   *
   * Neither CLI fails fast when it is not signed in, so a run would otherwise
   * hang until its timeout with no explanation. One sentence now beats fifteen
   * silent minutes.
   */
  private async checkAgentsReady(workspace: WorkspaceWithAgents): Promise<string | null> {
    for (const [agentId, what] of [
      [workspace.orchestrator_agent_id, 'que supervisiona'],
      [workspace.worker_agent_id, 'que executa'],
    ] as const) {
      if (!agentId) return `Escolha o agente ${what} neste projeto.`;
      const agent = this.database.agents.find(agentId);
      if (!agent) return `O agente ${what} neste projeto não existe mais.`;

      const runtimeId = agent.adapter_id === 'codex-cli' ? 'codex' : 'claude-code';
      try {
        await this.runtimeManager.getExecutablePath(runtimeId);
      } catch {
        return `${agent.display_name} ainda não está configurado. Configure os runtimes primeiro.`;
      }

      // An agent with no account runs on whatever the machine already has,
      // which is a choice the user made; only a bound account is checked.
      if (!agent.account_id) continue;
      const record = this.database.accounts.find(agent.account_id);
      if (!record) continue;
      const managers = { anthropic: this.accountManager, openai: this.codexAccountManager };
      const manager = managers[record.provider_id as 'anthropic' | 'openai'];
      if (!manager) continue;

      const status = await manager.getStatus({
        id: record.id,
        providerId: record.provider_id as 'anthropic' | 'openai',
        displayName: record.display_name,
        createdAt: record.created_at,
      });
      if (!isUsable(status.state)) {
        return `Conecte a conta "${record.display_name}" antes de enviar uma tarefa.`;
      }
    }
    return null;
  }

  /**
   * The production agent pair: Codex supervises, Claude Code executes with the
   * account the workspace's worker agent is bound to.
   */
  private async buildRunners(workspace: WorkspaceWithAgents): Promise<RunnerPair> {
    const workerAgent = workspace.worker_agent_id
      ? this.database.agents.require(workspace.worker_agent_id)
      : null;
    const accountId = workerAgent?.account_id ?? null;

    const orchestratorAgent = workspace.orchestrator_agent_id
      ? this.database.agents.require(workspace.orchestrator_agent_id)
      : null;
    const orchestratorAccountId = orchestratorAgent?.account_id ?? null;

    const orchestrator = new CodexAdapter({
      processManager: this.processManager,
      resolveExecutable: () => this.runtimeManager.getExecutablePath('codex'),
      // The decision shape is the orchestrator's contract, not the adapter's,
      // so it is handed in rather than baked in.
      outputSchema: DECISION_JSON_SCHEMA,
      buildEnvironment: () =>
        orchestratorAccountId
          ? this.codexAccountManager.buildEnvironment(orchestratorAccountId)
          : {},
    });
    const worker = new ClaudeCodeAdapter({
      processManager: this.processManager,
      resolveExecutable: () => this.runtimeManager.getExecutablePath('claude-code'),
      buildEnvironment: () =>
        accountId ? this.accountManager.buildEnvironment(accountId) : {},
    });
    return { orchestrator, worker, workerAccountId: accountId };
  }

  /** Stops everything still running. Called on quit and on test teardown. */
  async shutdown(): Promise<void> {
    await this.processManager.cancelAll();
    this.database.close();
  }
}

export { workerAgentIdFor };
