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

import { ClaudeAccountManager, Database, ProcessManager, RuntimeManager, appPaths } from '../core.js';
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
import { WorkspaceService } from './workspace-service.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
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

  readonly runtimes: RuntimeService;
  readonly accounts: AccountService;
  readonly agents: AgentService;
  readonly workspaces: WorkspaceService;
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

    this.runtimes = new RuntimeService(this.runtimeManager, this.events, this.database);
    this.accounts = new AccountService(
      this.database,
      this.accountManager,
      this.events,
      options.openUrl ?? (() => {}),
    );
    this.agents = new AgentService(this.database);
    this.workspaces = new WorkspaceService(this.database, this.runtimes, this.processManager);
    this.orchestration = new OrchestrationService(
      this.database,
      this.processManager,
      this.events,
      options.createRunners ?? ((workspace) => this.buildRunners(workspace)),
      options.orchestration ?? {},
    );
    this.chat = new ChatService(this.database, this.orchestration);

    this.database.providers.ensureSeeded();
    this.agents.sync();
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

    const orchestrator = new CodexAdapter({
      processManager: this.processManager,
      resolveExecutable: () => this.runtimeManager.getExecutablePath('codex'),
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
