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
import { GitHubService, type SecretStore } from './github-service.js';
import type { GitHubClientOptions } from '../core.js';
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
  /** Encrypts the GitHub token at rest. Electron passes `safeStorage`; absent means no storage. */
  secrets?: SecretStore;
  /** Endpoints and transport for GitHub; tests point them at a local fake. */
  github?: GitHubClientOptions;
}

/** The settings keys the loop reads. The Execution screen writes the same ones. */
export const SETTING = {
  maxIterations: 'execution.maxIterations',
  agentTimeoutMinutes: 'execution.agentTimeoutMinutes',
  verificationTimeoutMinutes: 'execution.verificationTimeoutMinutes',
} as const;

/** The store used when the shell offers none: nothing can be kept. */
const NO_SECRET_STORE: SecretStore = {
  available: false,
  encrypt() {
    throw new Error('no secret store');
  },
  decrypt() {
    throw new Error('no secret store');
  },
};

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
  readonly github: GitHubService;

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
    this.workspaces = new WorkspaceService(
      this.database,
      this.runtimes,
      this.processManager,
      this.agents,
    );
    this.verifications = new VerificationService(this.database);
    this.orchestration = new OrchestrationService(
      this.database,
      this.processManager,
      this.events,
      options.createRunners ?? ((workspace) => this.buildRunners(workspace)),
      this.orchestrationOptions(options.orchestration ?? {}),
      // Tests supplying their own runners are supplying their own agents too,
      // so there is nothing to check.
      options.createRunners ? async () => null : (workspace) => this.checkAgentsReady(workspace),
    );
    this.chat = new ChatService(this.database, this.orchestration);
    this.workspaces.bindActivity((workspaceId) => this.orchestration.hasActiveRunInWorkspace(workspaceId));
    this.github = new GitHubService(
      this.database,
      options.secrets ?? NO_SECRET_STORE,
      this.events,
      options.openUrl ?? (() => {}),
      options.github ?? {},
    );
    this.workspaces.bindGitHub(this.github);

    this.database.providers.ensureSeeded();
    this.agents.sync();
    // A run the previous process left as RUNNING is not running now.
    this.orchestration.reconcileInterrupted();
  }

  /**
   * The loop's limits, read from the settings table at the moment they are
   * used, so a change on the Execution screen applies to the next run without
   * a restart. An explicit option (tests) wins; a stored setting comes next;
   * the loop's own default last.
   */
  private orchestrationOptions(explicit: OrchestrationOptions): OrchestrationOptions {
    const setting = (key: string, min: number, max: number): number | undefined => {
      const raw = this.database.settings.get(key);
      if (raw === null) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
    };
    return {
      // Evidence is collected with the managed Git when there is one.
      gitCommand: () => this.runtimeManager.getExecutablePath('git'),
      ...(explicit.allowNoChanges !== undefined ? { allowNoChanges: explicit.allowNoChanges } : {}),
      get maxIterations() {
        return explicit.maxIterations ?? setting(SETTING.maxIterations, 1, 50);
      },
      get agentTimeoutMs() {
        const minutes = setting(SETTING.agentTimeoutMinutes, 1, 180);
        return explicit.agentTimeoutMs ?? (minutes !== undefined ? minutes * 60_000 : undefined);
      },
      get verificationTimeoutMs() {
        const minutes = setting(SETTING.verificationTimeoutMinutes, 1, 180);
        return explicit.verificationTimeoutMs ?? (minutes !== undefined ? minutes * 60_000 : undefined);
      },
    };
  }

  /**
   * Whether this workspace's agents can actually work.
   *
   * Neither CLI fails fast when it is not signed in, so a run would otherwise
   * hang until its timeout with no explanation. One sentence now beats fifteen
   * silent minutes.
   */
  private async checkAgentsReady(workspace: WorkspaceWithAgents): Promise<string | null> {
    for (const [agentId, what, provider] of [
      [workspace.orchestrator_agent_id, 'que supervisiona', 'OpenAI (Codex)'],
      [workspace.worker_agent_id, 'que executa', 'Anthropic (Claude)'],
    ] as const) {
      if (!agentId) return `Escolha a conta ${what} este projeto em Equipe.`;
      const agent = this.database.agents.find(agentId);
      if (!agent) return `O agente ${what} este projeto não existe mais. Escolha a conta em Equipe.`;

      // Every role runs on one of the user's own accounts, in that account's
      // isolated profile. A credential the machine happens to have is never
      // used, so an unbound agent is a configuration gap, not a fallback.
      const record = agent.account_id ? this.database.accounts.find(agent.account_id) : undefined;
      if (!record) {
        return `Escolha a conta ${provider} ${what} este projeto em Equipe.`;
      }

      const runtimeId = agent.adapter_id === 'codex-cli' ? 'codex' : 'claude-code';
      try {
        await this.runtimeManager.getExecutablePath(runtimeId);
      } catch {
        return `${agent.display_name} ainda não está configurado. Configure os runtimes primeiro.`;
      }

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
        return `A conta "${record.display_name}" não está conectada. Conecte a conta em Contas e integrações antes de enviar.`;
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
      // The team's choices for this role; null leaves the CLI's default alone.
      model: workspace.orchestrator_model,
      reasoningEffort: workspace.orchestrator_reasoning,
    });
    const worker = new ClaudeCodeAdapter({
      processManager: this.processManager,
      resolveExecutable: () => this.runtimeManager.getExecutablePath('claude-code'),
      buildEnvironment: () =>
        accountId ? this.accountManager.buildEnvironment(accountId) : {},
      model: workspace.worker_model,
      effort: workspace.worker_reasoning,
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
