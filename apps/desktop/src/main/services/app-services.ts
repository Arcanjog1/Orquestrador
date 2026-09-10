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

import {selectionProblem} from '../../shared/model-display.js';
import {AccountModelAvailability,parseAccountModelListing,UNVERIFIED_DETAIL} from './account-model-availability.js';
import {decorateAgentModels,knownAgentModels} from './agent-model-catalog.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {PROBE_PROMPT,probeArguments,classifyProbe,diagnostic} from './model-probe.js';
import { join } from 'node:path';
import {
  ClaudeAccountManager,
  CodexAccountManager,
  Database,
  ProcessManager,
  RuntimeManager,
  appPaths,
  isUsable,
} from '../core.js';
import type {
  AgentProvider,
  AppPaths,
  BudgetLimits,
  TeamMemberRecord,
  WorkspaceWithAgents,
} from '../core.js';
import { isWorkerSelection } from '../core.js';
import type { HttpTransport } from '../core.js';
import { EventBus } from '../events.js';
import { AccountService, type UrlOpener } from './account-service.js';
import { AgentService, workerAgentIdFor } from './agent-service.js';
import { ChatService } from './chat-service.js';
import { ProjectService } from './project-service.js';
import { PermissionService } from './permission-service.js';
import { GitHubWorkspaceService } from './github-workspace-service.js';
import { RepositoryAnalysisService } from './repository-analysis-service.js';
import {
  OrchestrationService,
  isConversation,
  type OrchestrationOptions,
  type RunnerFactory,
  type RunnerPair,
  type WorkerSlot,
} from './orchestration-service.js';
import { ConnectionService } from './connection-service.js';
import { RuntimeService } from './runtime-service.js';
import { VerificationService } from './verification-service.js';
import { WorkspaceService, orchestratorSelectionOf } from './workspace-service.js';
import { GitHubService, type SecretStore } from './github-service.js';
import { CloudAccountService } from './cloud-account-service.js';
import { CloudService } from './cloud-service.js';
import type { GitHubClientOptions } from '../core.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import { DECISION_JSON_SCHEMA } from '../core.js';
import { ClaudeCodeAdapter } from '../adapters/claude-adapter.js';
import { RepositoryOperations } from '../../../../../src/github/repository-operations.js';

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
  /** HTTP for the provider APIs; tests point it at a scripted transport. */
  providerTransport?: HttpTransport;
}

/**
 * What the orchestrator is, when it runs through an API rather than a CLI.
 *
 * The Codex CLI carries its own supervising posture; a bare model API does
 * not, so it is told here. The decision contract itself still comes from the
 * prompt the loop builds, which is the same prompt either way.
 */
const ORCHESTRATOR_INSTRUCTIONS =
  'You are the orchestrator of an agent team. You supervise and decide; the workers do the ' +
  'work. You never edit files yourself, and you never claim work was done that you did not ' +
  'see evidence for. Answer with a single JSON object and nothing else.';

/**
 * What a worker reached through a model API is, and what it must not pretend.
 *
 * Said plainly because it is the failure this product refuses to have: a model
 * that narrates an edit it could not make, whose narration is then mistaken
 * for the edit.
 */
const WORKER_INSTRUCTIONS =
  'You are a worker on an agent team. You have no file access and no shell: you can analyse, ' +
  'plan, review, compare and draft. Never state that you edited a file, ran a command or ' +
  'changed a repository - you cannot, and saying so would be taken as false evidence. If the ' +
  'task requires changing files, say so plainly and stop.';

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
  readonly projects: ProjectService;
  readonly permissions: PermissionService;
  /** Reading and editing a repository straight through the GitHub API. */
  readonly githubWorkspaces: GitHubWorkspaceService;
  readonly github: GitHubService;
  /** Provider connections: the vendors' official CLIs and the person's API keys. */
  readonly connections: ConnectionService;
  /** This computer's connection to a Run Coordinator. */
  readonly cloudAccount: CloudAccountService;
  /** Cloud runs: submitting them, and catching up with them. */
  readonly cloud: CloudService;

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
    this.connections = new ConnectionService({
      database: this.database,
      secrets: options.secrets ?? NO_SECRET_STORE,
      events: this.events,
      ...(options.providerTransport ? { transport: options.providerTransport } : {}),
    });
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
      options.createRunners ? async () => null : (workspace,supervisorOnly) => this.checkAgentsReady(workspace,supervisorOnly),
    );
    this.chat = new ChatService(this.database, this.orchestration);
    this.projects = new ProjectService(this.database);
    // The orchestrator is the resumer: answering an authorisation has to
    // continue the task that stopped for it, not just record a row.
    this.permissions = new PermissionService(this.database, this.orchestration);
    this.workspaces.bindActivity((workspaceId) => this.orchestration.hasActiveRunInWorkspace(workspaceId));
    this.github = new GitHubService(
      this.database,
      options.secrets ?? NO_SECRET_STORE,
      this.events,
      options.openUrl ?? (() => {}),
      options.github ?? {},
    );
    this.workspaces.bindGitHub(this.github);
    // Reading and editing a repository with no checkout on this computer. The
    // token stays inside this service; the orchestrator gets the service, not
    // the credential.
    this.githubWorkspaces = new GitHubWorkspaceService(
      this.database,
      this.github,
      // A test points the whole GitHub surface at its own fake; the same
      // endpoints and transport that serve the client serve this.
      options.github?.fetchImpl || options.github?.endpoints
        ? new RepositoryOperations({
            ...(options.github.fetchImpl ? { fetchImpl: options.github.fetchImpl } : {}),
            ...(options.github.endpoints ? { endpoints: options.github.endpoints } : {}),
          })
        : undefined,
    );
    this.orchestration.bindGitHub(this.githubWorkspaces);
    // Reads a public repository over the documented API. Uses the GitHub
    // connection's token when there is one, and works without it when there
    // is not - a public repository must never be made to ask for a login.
    this.repositoryAnalysis = new RepositoryAnalysisService({ github: this.github });
    this.cloudAccount = new CloudAccountService(this.database, options.secrets ?? NO_SECRET_STORE);
    this.cloud = new CloudService({
      database: this.database,
      events: this.events,
      clientFor: (endpoint) => this.cloudAccount.clientFor(endpoint),
    });

    this.database.providers.ensureSeeded();
    this.agents.sync();
    // Folders that had no identity and folders that had no project: both are
    // filled in here, additively. Nothing is merged, renamed or deleted; two
    // workspaces on one folder are reported, not resolved. See
    // `reconcileFolders`.
    this.folderReconciliation = this.workspaces.reconcileFolders(this.projects);
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
      // One empty directory per conversation project, owned by the
      // application. Empty is the point: nothing there for a CLI to read as
      // project configuration, and a stable place for it to keep the session.
      conversationDirectory: (workspace) => {
        const directory = join(this.paths.conversations, workspace.id);
        mkdirSync(directory, { recursive: true });
        return directory;
      },
      ...(explicit.allowNoChanges !== undefined ? { allowNoChanges: explicit.allowNoChanges } : {}),
      // The short path to the DoneGate. This builder names every option it
      // forwards, so one it does not name is silently dropped - which has now
      // happened to three of them, and is why each addition gets a line here.
      ...(explicit.fastPath !== undefined ? { fastPath: explicit.fastPath } : {}),
      // Where runs execute. Absent means this computer, which is the default
      // for every workspace that has a folder on it.
      ...(explicit.environments ? { environments: explicit.environments } : {}),
      // How long a delegation may be outstanding, and how often expired ones
      // are reclaimed. This builder names every option it forwards, so one it
      // does not name is silently dropped - which is what happened to these
      // two the first time.
      ...(explicit.messageLeaseMs !== undefined ? { messageLeaseMs: explicit.messageLeaseMs } : {}),
      ...(explicit.sweepIntervalMs !== undefined
        ? { sweepIntervalMs: explicit.sweepIntervalMs }
        : {}),
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
  private async checkAgentsReady(workspace: WorkspaceWithAgents,supervisorOnly=false): Promise<string | null> {
    const team = this.database.workspaces.team(workspace.id);
    const workers = team.filter((member) => member.role === 'CODING_WORKER');
    const roles: Array<readonly [string | null, string, string]> = [
      [workspace.orchestrator_agent_id, 'que supervisiona', 'OpenAI (Codex)'],
      ...(workers.length > 0
        ? workers.map(
            (member) => [member.agentId, 'que executa', 'Anthropic (Claude)'] as const,
          )
        : [[workspace.worker_agent_id, 'que executa', 'Anthropic (Claude)'] as const]),
    ];

    for (const [agentId, what, provider] of (supervisorOnly?roles.slice(0,1):roles)) {
      if (!agentId) return `Escolha a conta ${what} este projeto em Equipe.`;
      const agent = this.database.agents.find(agentId);
      if (!agent) return `O agente ${what} este projeto não existe mais. Escolha a conta em Equipe.`;

      if (agent.enabled !== 1) return 'O agente foi desativado ou removido. Escolha outro em Equipe.';
      // Every role runs on one of the user's own accounts, in that account's
      // isolated profile. A credential the machine happens to have is never
      // used, so an unbound agent is a configuration gap, not a fallback.
      const record = agent.account_id ? this.database.accounts.find(agent.account_id) : undefined;
      if (!record) {
        return `Escolha a conta ${provider} ${what} este projeto em Equipe.`;
      }

      // An API connection has no CLI to install and no CLI login to check.
      // Asking a person to install a runtime they will never run would be the
      // very obstacle the API path exists to remove.
      if (record.connection_kind === 'api') {
        if (record.api_enabled !== 1) {
          return (
            `A conexão "${record.display_name}" usa uma API com cobrança separada e ainda não ` +
            'foi habilitada. Habilite-a em Contas e integrações antes de enviar.'
          );
        }
        if (!this.database.providerSecrets.has(record.id)) {
          return `A conexão "${record.display_name}" ainda não tem uma chave de API salva.`;
        }
        continue;
      }

      const runtimeId = agent.adapter_id === 'codex-cli' ? 'codex' : 'claude-code';
      try {
        await this.runtimeManager.getExecutablePath(runtimeId);
      } catch (error) {
        // "Codex 0.130.0 is not compatible" and "Codex is not configured" are
        // different problems with different fixes; the runtime says which.
        const message = (error as { userMessage?: unknown }).userMessage;
        return typeof message === 'string'
          ? `${message} Abra Configurações → Componentes e atualize.`
          : `${agent.display_name} ainda não está configurado. Configure os runtimes primeiro.`;
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
   * The production team.
   *
   * One place decides, per role, whether a member runs through the vendor's
   * official CLI on the person's subscription or through the vendor's API on
   * the person's key. The loop below is the same loop either way: it is handed
   * runners, and a runner is a runner.
   *
   * The CLI path stays the default and the preferred one, because it is the
   * one that costs nothing beyond the subscription the person already pays.
   */
  private async buildRunners(workspace: WorkspaceWithAgents): Promise<RunnerPair> {
    const team = this.database.workspaces.team(workspace.id);
    const workerBindings = team.filter((member) => member.role === 'CODING_WORKER');

    const workerAgent = workspace.worker_agent_id
      ? this.database.agents.require(workspace.worker_agent_id)
      : null;
    const accountId = workerAgent?.account_id ?? null;

    const orchestratorAgent = workspace.orchestrator_agent_id
      ? this.database.agents.require(workspace.orchestrator_agent_id)
      : null;
    const orchestratorAccountId = orchestratorAgent?.account_id ?? null;

    // An orchestrator bound to an API connection speaks the same decision
    // contract as the Codex CLI: same schema, same parser, same DONE gate.
    const orchestratorApi = this.apiProviderFor(orchestratorAccountId, ORCHESTRATOR_INSTRUCTIONS);
    if (orchestratorApi) {
      return {
        orchestrator: orchestratorApi,
        ...(await this.buildWorkers(workspace, workerBindings, accountId)),
      };
    }

    const orchestrator = orchestratorAgent?.provider_id==='anthropic'
      ? this.claudeAdapterFor(workspace,orchestratorAccountId,null)
      : new CodexAdapter({
      processManager: this.processManager,
      resolveExecutable: () => this.runtimeManager.getExecutablePath('codex'),
      // The decision shape is the orchestrator's contract, not the adapter's,
      // so it is handed in rather than baked in.
      outputSchema: DECISION_JSON_SCHEMA,
      // The account's profile, plus whatever the managed build's manifest
      // says its processes must not inherit (an OPENSSL_ia32cap that makes
      // AWS-LC abort). Child-local: the machine's variables stay as they are.
      buildEnvironment: () => ({
        ...this.runtimeManager.childEnvironmentOverlay('codex'),
        ...(orchestratorAccountId
          ? this.codexAccountManager.buildEnvironment(orchestratorAccountId)
          : {}),
      }),
      // The person's pinned choice, only under manual selection; "Padrão do
      // CLI" leaves both alone, whatever an older row still carries.
      model: orchestratorSelectionOf(workspace) === 'manual' ? workspace.orchestrator_model : null,
      reasoningEffort: orchestratorSelectionOf(workspace) === 'manual' ? workspace.orchestrator_reasoning : null,
    });
    // The worker's model and reasoning are chosen per delegation by the
    // loop's router, from what the orchestrator asks and what this account's
    // Claude Code declares. The person's own model and level apply only
    // under manual selection; they are still the adapter's defaults so a
    // direct invocation behaves the same way.
    const selection = isWorkerSelection(workspace.worker_selection)
      ? workspace.worker_selection
      : 'auto';
    const worker = new ClaudeCodeAdapter({
      processManager: this.processManager,
      resolveExecutable: () => this.runtimeManager.getExecutablePath('claude-code'),
      buildEnvironment: () => ({
        ...this.runtimeManager.childEnvironmentOverlay('claude-code'),
        ...(accountId ? this.accountManager.buildEnvironment(accountId) : {}),
      }),
      model: selection === 'manual' ? workspace.worker_model : null,
      effort: selection === 'manual' ? workspace.worker_reasoning : null,
      // What the person authorised in this project, read at spawn time.
      //
      // This option existed and nothing ever supplied it, so every grant a
      // person approved was written to the database and never reached the
      // command line. That is half of why authorising changed nothing; the
      // other half was the rule syntax. Read here, per invocation, so an
      // approval given a second ago applies to the next delegation without
      // rebuilding anything.
      allowedTools: () => this.database.permissions.rulesFor(workspace.id),
    });
    const workers = await this.buildWorkers(workspace, workerBindings, accountId, {
      runner: worker,
      routing: {
        provider: 'anthropic',
        selection,
        manual: { model: workspace.worker_model, reasoning: workspace.worker_reasoning },
        // Read from the binary in this account's environment, once per run:
        // a changed account or an updated Claude Code is read again.
        capabilities: () => worker.describeCapabilities(workspace.local_path),
      },
    });
    return { orchestrator, ...workers };
  }

  /**
   * The workers, in the order the team lists them.
   *
   * Each binding becomes one slot with a stable id the orchestrator addresses
   * it by. Two bindings on the same Anthropic provider with different
   * connections are two slots and two credentials - not two adapters, and with
   * nothing shared between them.
   */
  private async buildWorkers(
    workspace: WorkspaceWithAgents,
    bindings: readonly TeamMemberRecord[],
    firstAccountId: string | null,
    cli?: { runner: ClaudeCodeAdapter; routing: RunnerPair['workerRouting'] },
  ): Promise<Omit<RunnerPair, 'orchestrator'>> {
    const slots: WorkerSlot[] = [];
    for (const [index, binding] of bindings.entries()) {
      const agent = this.database.agents.find(binding.agentId);
      const connectionId = agent?.account_id ?? null;
      const account = connectionId ? this.database.accounts.find(connectionId) : undefined;
      const label = binding.label ?? agent?.display_name ?? `Worker ${index + 1}`;
      const id = `worker-${index + 1}`;

      const api = this.apiProviderFor(connectionId, WORKER_INSTRUCTIONS);
      if (api) {
        slots.push({
          id,
          label,
          runner: api,
          accountId: connectionId,
          providerId: account?.provider_id ?? null,
          connectionKind: 'api',
          agentId: binding.agentId,
          routing:{provider:account?.provider_id==='openai'?'openai':'anthropic',selection:'manual',manual:{model:binding.model??agent?.model??account?.default_model??null,reasoning:binding.reasoning??account?.default_reasoning??null},capabilities:()=>api.describeCapabilities!()},
        });
        continue;
      }
      // Not an API connection: the official CLI, on the person's subscription.
      // The first slot reuses the adapter already built above, so a
      // single-worker project behaves exactly as it always has.
      if (index === 0 && cli && account?.provider_id!=='openai') {
        slots.push({
          id,
          label,
          runner: cli.runner,
          accountId: firstAccountId,
          providerId: account?.provider_id ?? 'anthropic',
          connectionKind: 'cli',
          agentId: binding.agentId,
          ...(cli.routing ? { routing: cli.routing } : {}),
        });
        continue;
      }
      const adapter = account?.provider_id==='openai' ? this.codexAdapterFor(connectionId) : this.claudeAdapterFor(workspace, connectionId, binding);
      slots.push({
        id,
        label,
        runner: adapter,
        accountId: connectionId,
        providerId: account?.provider_id ?? 'anthropic',
        connectionKind: 'cli',
        agentId: binding.agentId,
        routing: {
          provider: account?.provider_id==='openai'?'openai':'anthropic',
          selection: isWorkerSelection(binding.selection) ? binding.selection : 'auto',
          manual: { model: binding.model, reasoning: binding.reasoning },
          capabilities: () => adapter.describeCapabilities(workspace.local_path || process.cwd()),
        },
      });
    }

    const first = slots[0];
    return {
      // `worker` remains the first slot: every caller and test that reads one
      // worker keeps reading the same one.
      worker: first?.runner ?? cli?.runner ?? this.claudeAdapterFor(workspace, firstAccountId, null),
      workerAccountId: first?.accountId ?? firstAccountId,
      ...(first?.routing ? { workerRouting: first.routing } : {}),
      workers: slots,
      budget: this.budgetOf(workspace),
    };
  }

  private codexAdapterFor(connectionId:string|null):CodexAdapter {
    return new CodexAdapter({processManager:this.processManager,
      resolveExecutable:()=>this.runtimeManager.getExecutablePath('codex'),
      buildEnvironment:()=>({...this.runtimeManager.childEnvironmentOverlay('codex'),...(connectionId?this.codexAccountManager.buildEnvironment(connectionId):{})})});
  }

  async agentModels(accountId:string,role?:string):Promise<import('../../shared/agent-policy.js').ModelCatalogEntry[]> {
    const account=this.database.accounts.require(accountId);
    const decorate=(rows:import('../../shared/agent-policy.js').ModelCatalogEntry[])=>{
      // A previously saved model is still known when a partial listing or cache omits it.
      const saved=this.agents.manage().filter(a=>a.accountId===accountId).flatMap(a=>a.policy?.allowedModels??(a.model?[a.model]:[]));
      for(const id of new Set(saved))if(!rows.some(m=>m.id===id))rows.push({id,provider:account.provider_id as 'openai'|'anthropic',source:'catalog',reasoning:[],accountAllowed:null});
      const known=knownAgentModels(account.provider_id as 'openai'|'anthropic');
      rows=[...rows,...known.filter(m=>!rows.some(row=>row.id===m.id))];
      const availability=new AccountModelAvailability(this.database.settings);
      const evidence=availability.read(accountId,account.provider_id);
      for(const id of new Set([...(evidence?.confirmed??[]),...(evidence?.denied??[])]))if(!rows.some(row=>row.id===id))rows.push({id,provider:account.provider_id as 'openai'|'anthropic',source:account.connection_kind==='api'?'provider':'runtime',reasoning:[],accountAllowed:null});
      return decorateAgentModels(availability.apply(accountId,account.provider_id,rows),account,this.agents.policies(),role);
    };
    if(account.connection_kind==='api') {
      const api=this.apiProviderFor(accountId,'');
      if(!api) return decorate(knownAgentModels(account.provider_id as 'openai'|'anthropic'));
      let models:Awaited<ReturnType<typeof api.getAvailableModels>>;
      try {models=await api.getAvailableModels();} catch {return decorate(knownAgentModels(account.provider_id as 'openai'|'anthropic'));}
      return decorate(models.map(m=>({id:m.id,displayName:m.displayName,provider:account.provider_id as 'openai'|'anthropic',source:'provider' as const,reasoning:[],accountAllowed:true})));
    }
    const adapter=account.provider_id==='openai'?this.codexAdapterFor(accountId):this.claudeAdapterFor({local_path:'',id:''} as WorkspaceWithAgents,accountId,null);
    let capabilities:import('../../../../../src/routing/provider-policy.js').WorkerRuntimeCapabilities;
    try {capabilities=await adapter.describeCapabilities();} catch {return decorate(knownAgentModels(account.provider_id as 'openai'|'anthropic'));}
    const cached=adapter instanceof CodexAdapter?adapter.cachedModels():[];
    return decorate(capabilities.declaredModels?.length?capabilities.declaredModels.map(id=>({id,displayName:cached.find(m=>m.id===id)?.displayName,provider:account.provider_id as 'openai'|'anthropic',source:'runtime' as const,reasoning:[...(cached.find(m=>m.id===id)?.reasoning??capabilities.declaredEfforts??[])],accountAllowed:null})):knownAgentModels(account.provider_id as 'openai'|'anthropic',capabilities));
  }

  /** Explicit, account-bound metadata check. No prompt, exec, chat or completion is ever sent. */
  async verifyAgentModels(agentId:string):Promise<import('../../shared/model-availability.js').AccountModelVerification> {
    const agent=this.database.agents.require(agentId);
    if(!agent.account_id)throw new Error('Vincule uma conta ao agente.');
    const account=this.database.accounts.require(agent.account_id);
    const provider=account.provider_id as 'openai'|'anthropic';
    const result:import('../../shared/model-availability.js').AccountModelVerification={accountId:account.id,provider,checkedAt:new Date().toISOString(),confirmed:[],denied:[],detail:account.connection_kind==='api'?'A conexão não informou modelos disponíveis nesta conta. Os modelos do catálogo continuam não verificados. Nenhuma chamada ao modelo foi feita.':UNVERIFIED_DETAIL};
    try {
      if(account.connection_kind==='api') {
        const api=this.apiProviderFor(account.id,'');
        if(api)result.confirmed=(await api.getAvailableModels()).map(m=>m.id);
      } else {
        const runtime=provider==='openai'?'codex':'claude-code';
        const command=await this.runtimeManager.getExecutablePath(runtime);
        const env={...this.runtimeManager.childEnvironmentOverlay(runtime),...(provider==='openai'?this.codexAccountManager:this.accountManager).buildEnvironment(account.id)};
        const run=(args:string[])=>this.processManager.run({command,args,env,cwd:this.paths.root,timeoutMs:10_000});
        // Auth status is a known non-inference command; model-list commands are only used when advertised.
        const help=await run(['--help']);
        const probes:string[][]=[];
        if(help.exitCode===0&&help.outcome==='completed'&&/^\s+models\s/m.test(help.stdout)) {
          const modelsHelp=await run(['models','--help']);
          if(modelsHelp.exitCode===0&&modelsHelp.outcome==='completed'&&/^\s+list\s/m.test(modelsHelp.stdout)) {
            const listHelp=await run(['models','list','--help']);
            if(listHelp.exitCode===0&&listHelp.outcome==='completed'&&listHelp.stdout.includes('--json'))probes.push(['models','list','--json']);
          }
        }
        if(provider==='anthropic')probes.push(['auth','status','--json']);
        for(const args of probes) {
          const response=await run(args);
          if(response.exitCode!==0||response.outcome!=='completed'||response.truncated)continue;
          const listing=parseAccountModelListing(response.stdout,account.id);
          if(listing){result.confirmed=listing.confirmed;result.denied=listing.denied;break;}
        }
      }
      if(result.confirmed.length||result.denied.length)result.detail='Verificação concluída somente para esta conta. Modelos sem informação continuam não verificados. Nenhuma chamada ao modelo foi feita.';
    } catch {result.detail='Não foi possível concluir a verificação desta conta. Tente novamente. Nenhum modelo foi marcado como indisponível e nenhuma chamada ao modelo foi feita.';}
    // A relink while the check was running must not update the newly linked account.
    if(this.database.agents.require(agentId).account_id!==account.id)throw new Error('A conta do agente mudou. Verifique novamente.');
    const availability=new AccountModelAvailability(this.database.settings);
    const selected=this.agents.manage().find(a=>a.id===agentId);
    const model=selected?.policy?.primaryModel??selected?.model;
    let saved=result;
    for(const modelId of new Set([...result.confirmed,...result.denied,...(model?[model]:[])])) {
      saved=availability.record({providerId:provider,accountId:account.id,agentId,modelId,requestedModel:modelId,timestamp:result.checkedAt,verifiedAt:result.checkedAt,verificationMethod:'free-introspection',source:account.connection_kind==='api'?'provider models':'CLI metadata',state:result.denied.includes(modelId)?'UNAVAILABLE':result.confirmed.includes(modelId)?'CONFIRMED_FOR_ACCOUNT':'KNOWN_BUT_UNVERIFIED',reason:result.detail});
    }
    return saved;
  }

  /** Explicit probes never pass through routing, fallback or normal run history. */
  private readonly activeModelProbes=new Set<string>();
  async testAgentModel(input:import('../../shared/model-availability.js').ModelProbeRequest):Promise<import('../../shared/model-availability.js').AccountModelVerification> {
    if(input.authorised!==true)throw new Error('Confirme o teste antes de consumir uso.');
    const assertSelection=()=>{
      const agent=this.agents.manage().find(a=>a.id===input.agentId);
      if(!agent||agent.accountId!==input.accountId||(agent.policy?.primaryModel??agent.model)!==input.modelId)throw new Error('A conta ou o modelo do agente mudou. Verifique novamente.');
      return agent;
    };
    const agent=assertSelection();
    const account=this.database.accounts.require(input.accountId);
    if(account.provider_id!==agent.provider)throw new Error('O provider da conta não corresponde ao agente.');
    if(this.activeModelProbes.has(account.id))throw new Error('Já existe um teste em andamento nesta conta.');
    this.activeModelProbes.add(account.id);
    const provider=agent.provider;
    let state:import('../../shared/model-availability.js').ModelAvailability='KNOWN_BUT_UNVERIFIED';
    let reason='Não foi possível iniciar o teste. Verifique a conexão e a instalação do runtime.';
    let args:string[]=[];
    let cwd:string|undefined;
    try {
      if(account.connection_kind==='api') {
        ({state,reason}=await this.connections.probeModel(account.id,input.modelId));
      } else {
        const runtime=provider==='openai'?'codex':'claude-code';
        const manager=provider==='openai'?this.codexAccountManager:this.accountManager;
        if(!manager.hasOwnCredentials(account.id)){reason='Conecte esta conta antes de testar. Nenhuma chamada ao modelo foi feita.';throw new Error('Missing account credentials');}
        const command=await this.runtimeManager.getExecutablePath(runtime);
        const env={...this.runtimeManager.childEnvironmentOverlay(runtime),...manager.buildEnvironment(account.id)};
        cwd=mkdtempSync(join(tmpdir(),'orchestrator-model-probe-'));
        // This check is metadata only. Old CLIs must not silently drop isolation/model flags.
        const help=await this.processManager.run({command,args:provider==='openai'?['exec','--help']:['--help'],env,cwd,timeoutMs:10_000});
        const required=provider==='openai'?['--model','--json','--ephemeral','--ignore-user-config','--ignore-rules','--sandbox']:['--model','--output-format','--bare','--tools','--strict-mcp-config','--no-session-persistence','--max-turns'];
        if(help.exitCode!==0||help.outcome!=='completed'||required.some(flag=>!help.stdout.includes(flag))) {
          reason='Atualize o CLI para testar com isolamento e sem ferramentas. Nenhuma chamada ao modelo foi feita.';
        } else {
          assertSelection();
          args=probeArguments(provider,input.modelId);
          const result=await this.processManager.run({command,args,env,cwd,stdin:PROBE_PROMPT,timeoutMs:30_000,maxOutputBytes:128*1024});
          ({state,reason}=classifyProbe(provider,input.modelId,result));
        }
      }
    } catch (error) {
      // Never persist stderr, credentials, environment or arbitrary provider text.
      if(error instanceof Error&&error.message!=='Missing account credentials')reason=diagnostic(error.message);
    } finally {
      this.activeModelProbes.delete(account.id);
      // A temporary Windows file lock must not lose the verification result.
      if(cwd)try {rmSync(cwd,{recursive:true,force:true});} catch { /* OS temp cleanup can reclaim it. */ }
    }
    assertSelection();
    const timestamp=new Date().toISOString();
    return new AccountModelAvailability(this.database.settings).record({providerId:provider,accountId:account.id,agentId:agent.id,modelId:input.modelId,requestedModel:input.modelId,timestamp,verifiedAt:timestamp,verificationMethod:'minimal-probe',source:account.connection_kind==='api'?'provider API':provider==='openai'?'codex exec':'claude print',state,reason,arguments:args});
  }

  /** All renderer saves re-read the selected account's catalog; no trust in submitted labels/capabilities. */
  async saveAgent(input:import('../../shared/ipc-contract.js').AgentInputView,id?:string) {
    if(input.policy&&input.model&&input.policy.primaryModel!==input.model)throw new Error('O modelo principal deve corresponder à seleção salva.');
    const previous=id?this.agents.manage().find(a=>a.id===id):undefined;
    const unchangedModel=previous&&previous.accountId===input.accountId&&previous.provider===input.provider&&previous.role===input.role&&previous.model===input.model&&previous.reasoning===input.reasoning&&JSON.stringify(previous.policy)===JSON.stringify(input.policy)&&previous.maxCapability===input.maxCapability&&previous.maxReasoning===input.maxReasoning;
    // A disconnected/missing model must not prevent deactivation or a name-only edit.
    if(!unchangedModel&&(input.policy||input.model)) {
      const rows=await this.agentModels(input.accountId,input.role);
      const ids=input.policy?.allowedModels??(input.model?[input.model]:[]);
      for(const model of ids) {
        const row=rows.find(m=>m.id===model&&m.provider===input.provider);
        if(!row)throw new Error('O modelo selecionado não está no catálogo desta conta. Atualize os modelos.');
        if(row.blockedReason)throw new Error(row.displayName+': '+row.blockedReason);
      }
      const policy=input.policy;
      if(policy){const problem=selectionProblem(policy,rows,input.maxCapability,input.maxReasoning);if(problem)throw new Error(problem);}
      const reasoning=policy?.reasoning??input.reasoning;
      const candidates=policy?(policy.modelMode==='FIXED'?[policy.primaryModel]:[policy.primaryModel,...policy.fallbackModels]):[input.model];
      if(reasoning&&candidates.some(model=>!rows.find(m=>m.id===model)?.reasoning.includes(reasoning)))throw new Error('Este raciocínio não é compatível com os modelos selecionados nesta conta.');
    }
    return id?this.agents.update(id,input):this.agents.create(input);
  }

  /** One Claude Code adapter, bound to one connection's isolated profile. */
  private claudeAdapterFor(
    workspace: WorkspaceWithAgents,
    connectionId: string | null,
    binding: TeamMemberRecord | null,
  ): ClaudeCodeAdapter {
    const selection = isWorkerSelection(binding?.selection) ? binding!.selection : 'auto';
    return new ClaudeCodeAdapter({
      processManager: this.processManager,
      resolveExecutable: () => this.runtimeManager.getExecutablePath('claude-code'),
      buildEnvironment: () => ({
        ...this.runtimeManager.childEnvironmentOverlay('claude-code'),
        ...(connectionId ? this.accountManager.buildEnvironment(connectionId) : {}),
      }),
      model: selection === 'manual' ? (binding?.model ?? workspace.worker_model) : null,
      effort: selection === 'manual' ? (binding?.reasoning ?? workspace.worker_reasoning) : null,
      // Same reason as above. `workspace.id` is empty on the capability probe,
      // which asks the binary about itself and runs nothing, so it authorises
      // nothing either.
      allowedTools: () => (workspace.id ? this.database.permissions.rulesFor(workspace.id) : []),
    });
  }

  /**
   * Whether this connection's installed Claude Code can continue a session.
   *
   * Answered by the binary's own help page, never assumed: a build without
   * `--resume` or without `--output-format` simply starts fresh each time,
   * and the interface says so rather than promising continuity it cannot
   * deliver.
   */
  async supportsSessionResume(connectionId: string | null): Promise<boolean> {
    const account = connectionId ? this.database.accounts.find(connectionId) : undefined;
    if (!account || account.connection_kind !== 'cli') return false;
    try {
      const adapter = this.claudeAdapterFor(
        { local_path: '' } as WorkspaceWithAgents,
        connectionId,
        null,
      );
      return await adapter.supportsResume();
    } catch {
      return false;
    }
  }

  /**
   * The API provider for a connection, or null when it is not one.
   *
   * Null covers three cases that must all fall back to the CLI path: there is
   * no connection, the connection is a CLI one, or it is an API connection the
   * person has not enabled. The last is the important one - a saved key that
   * was never switched on must not start costing money.
   */
  private apiProviderFor(connectionId: string | null, instructions: string): AgentProvider | null {
    if (!connectionId) return null;
    const account = this.database.accounts.find(connectionId);
    if (!account || account.connection_kind !== 'api' || account.api_enabled !== 1) return null;
    try {
      return this.connections.providerFor(connectionId, { system: instructions });
    } catch {
      // A connection that cannot be built is not a reason to fail the run
      // here: the readiness check reports it in words the person can act on.
      return null;
    }
  }

  /** This project's spending limits. Absent columns mean no limit. */
  private budgetOf(workspace: WorkspaceWithAgents): BudgetLimits {
    return {
      maxInvocations: numberOrNull(workspace.budget_max_invocations),
      maxTokens: numberOrNull(workspace.budget_max_tokens),
      maxCostUsd: numberOrNull(workspace.budget_max_cost_usd),
    };
  }

  /** Stops everything still running. Called on quit and on test teardown. */
  /**
   * What the folder reconciliation did at start-up.
   *
   * Kept so the interface can say it rather than have it happen invisibly -
   * particularly the duplicates, which are the case a person has to resolve.
   */
  /** Reads a public repository so the supervisor can analyse it. */
  readonly repositoryAnalysis!: RepositoryAnalysisService;

  folderReconciliation: {
    keysBackfilled: number;
    projectsCreated: number;
    duplicateFolders: Array<{ pathKey: string; workspaceIds: string[] }>;
  } = { keysBackfilled: 0, projectsCreated: 0, duplicateFolders: [] };

  async shutdown(): Promise<void> {
    this.cloud.stopPolling();
    // Before the database closes: the sweep reads it, and a tick that fires
    // against a closed handle would throw on the way out.
    this.orchestration.dispose();
    // And a run still going reads it too. Stopping the loops and waiting for
    // them is the difference between a clean shutdown and a rejected promise
    // saying "database is not open" from somewhere nobody is watching.
    await this.orchestration.drain();
    await this.processManager.cancelAll();
    this.database.close();
  }
}

export { workerAgentIdFor };

/** A stored limit, or null when the column is empty or nonsensical. */
function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
