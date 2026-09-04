/**
 * The IPC handlers.
 *
 * One handler per channel in the shared contract. Each of them validates its
 * payload before touching anything, then delegates to a service that already
 * exists. No handler contains orchestration logic of its own: this file is a
 * translation layer between the contract's view shapes and the real services,
 * and nothing more.
 *
 * The rule everything here follows: a fact the application does not have is
 * reported as absent - null, an empty list, a named problem - and never
 * approximated. The interface has an empty state for every one of them.
 */

import { dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { basename } from 'node:path';
import { GitEvidenceCollector } from '../git/git-evidence-collector.js';
import { RuntimeError } from '../runtime/types.js';
import { AccountError } from '../accounts/account-types.js';
import type { Account } from '../accounts/account-types.js';
import type { Services } from './services.js';
import type {
  AccountView,
  AgentInvocationView,
  AgentView,
  AppStateView,
  ArtifactView,
  BranchView,
  ChatSessionView,
  DiagnosticView,
  EventChannels,
  GitContextView,
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
  MessageView,
  ProviderId,
  RunDetailView,
  RunState,
  RunStepView,
  RunView,
  RuntimeId,
  VerificationResultView,
  WorkspaceView,
} from '../shared/ipc-contract.js';
import type {
  AccountRecord,
  AgentInvocationRecord,
  AgentRecord,
  ArtifactRecord,
  ChatSessionRecord,
  MessageRecord,
  RunRecord,
  RunStepRecord,
  VerificationResultRecord,
  WorkspaceRecord,
} from '../database/repositories.js';

const RUN_STATES: readonly RunState[] = [
  'IDLE',
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
  'DONE',
  'CANCELLED',
  'FAILED',
];

const RUNTIME_IDS: readonly RuntimeId[] = ['codex', 'claude-code', 'git'];
const PROVIDER_IDS: readonly ProviderId[] = ['openai', 'anthropic', 'google', 'github'];

const SETTING_ACTIVE_WORKSPACE = 'workspace.active';
const SETTING_DEFAULT_ACCOUNT = 'accounts.default';
const SETTING_MAX_ITERATIONS = 'execution.maxIterations';
const DEFAULT_MAX_ITERATIONS = 20;

// -- Payload validation -----------------------------------------------------
//
// The renderer is not trusted to send well-formed payloads: a bug there must
// not be able to reach a service with a malformed argument.

class InvalidPayloadError extends Error {
  constructor(what: string) {
    super(`Pedido inválido: ${what}`);
    this.name = 'InvalidPayloadError';
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidPayloadError('era esperado um objeto');
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, field: string, max = 100_000): string {
  const record = asObject(value);
  const raw = record[field];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new InvalidPayloadError(`"${field}" deve ser um texto`);
  }
  if (raw.length > max) throw new InvalidPayloadError(`"${field}" é longo demais`);
  return raw;
}

function optionalStr(value: unknown, field: string, max = 100_000): string | undefined {
  const record = asObject(value);
  const raw = record[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new InvalidPayloadError(`"${field}" deve ser um texto`);
  if (raw.length > max) throw new InvalidPayloadError(`"${field}" é longo demais`);
  return raw;
}

function nullableStr(value: unknown, field: string): string | null {
  return optionalStr(value, field) ?? null;
}

function runtimeId(value: unknown): RuntimeId {
  const raw = str(value, 'runtimeId');
  if (!RUNTIME_IDS.includes(raw as RuntimeId)) {
    throw new InvalidPayloadError(`runtime desconhecido "${raw}"`);
  }
  return raw as RuntimeId;
}

function providerId(value: unknown): ProviderId {
  const raw = str(value, 'providerId');
  if (!PROVIDER_IDS.includes(raw as ProviderId)) {
    throw new InvalidPayloadError(`provider desconhecido "${raw}"`);
  }
  return raw as ProviderId;
}

/** Only http(s) is ever handed to the system browser. */
function externalUrl(value: unknown): string {
  const raw = str(value, 'url', 4_000);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new InvalidPayloadError('URL malformada');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new InvalidPayloadError('somente http(s) pode ser aberto');
  }
  return parsed.toString();
}

// -- Record -> view mapping -------------------------------------------------

/** Anything the database reports that the interface cannot draw becomes IDLE. */
function toRunState(status: string): RunState {
  return RUN_STATES.includes(status as RunState) ? (status as RunState) : 'IDLE';
}

function toProviderId(value: string): ProviderId | null {
  return PROVIDER_IDS.includes(value as ProviderId) ? (value as ProviderId) : null;
}

function workspaceView(record: WorkspaceRecord): WorkspaceView {
  return {
    id: record.id,
    displayName: record.display_name,
    localPath: record.local_path,
    repositoryUrl: record.repository_url,
    defaultBranch: record.default_branch,
    createdAt: record.created_at,
    lastOpenedAt: record.last_opened_at,
  };
}

function sessionView(record: ChatSessionRecord): ChatSessionView {
  return {
    id: record.id,
    workspaceId: record.workspace_id,
    title: record.title,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function messageView(record: MessageRecord): MessageView {
  let payload: unknown = null;
  if (record.payload) {
    try {
      payload = JSON.parse(record.payload);
    } catch {
      payload = null;
    }
  }
  return {
    id: record.id,
    sessionId: record.session_id,
    runId: record.run_id,
    kind: record.kind,
    author: record.author,
    agentId: record.agent_id,
    body: record.body,
    payload,
    createdAt: record.created_at,
  };
}

function runView(record: RunRecord): RunView {
  return {
    id: record.id,
    sessionId: record.session_id,
    workspaceId: record.workspace_id,
    objective: record.objective,
    status: toRunState(record.status),
    iteration: record.iteration,
    maxIterations: record.max_iterations,
    baselineBranch: record.baseline_branch,
    baselineCommit: record.baseline_commit,
    terminationReason: record.termination_reason,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
  };
}

function runStepView(record: RunStepRecord): RunStepView {
  return {
    id: record.id,
    runId: record.run_id,
    iteration: record.iteration,
    phase: record.phase,
    status: record.status,
    summary: record.summary,
    detail: record.detail,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
  };
}

function verificationView(
  record: VerificationResultRecord,
  labels: Map<string, string>,
): VerificationResultView {
  return {
    id: record.id,
    runId: record.run_id,
    iteration: record.iteration,
    definitionId: record.definition_id,
    // The definition's label when the workspace registered one; otherwise the
    // command itself. Never an invented friendly name.
    label: (record.definition_id ? labels.get(record.definition_id) : undefined) ?? record.command,
    command: record.command,
    exitCode: record.exit_code,
    passed: record.passed === 1,
    refused: record.refused,
    durationMs: record.duration_ms,
    createdAt: record.created_at,
  };
}

function artifactView(record: ArtifactRecord): ArtifactView {
  return {
    id: record.id,
    runId: record.run_id,
    kind: record.kind,
    label: record.label,
    relativePath: record.relative_path,
    bytes: record.bytes,
    createdAt: record.created_at,
  };
}

/** Reasoning is stored in the agent's `runtime_options`, or it is simply absent. */
function reasoningOf(agent: AgentRecord | undefined): string | null {
  if (!agent) return null;
  try {
    const options = JSON.parse(agent.runtime_options) as Record<string, unknown>;
    const value = options['reasoning'];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function agentView(record: AgentRecord, accounts: Map<string, AccountRecord>): AgentView {
  const account = record.account_id ? accounts.get(record.account_id) : undefined;
  return {
    id: record.id,
    role: record.role,
    providerId: toProviderId(record.provider_id) ?? 'openai',
    displayName: record.display_name,
    accountId: record.account_id,
    accountName: account?.display_name ?? null,
    model: record.model,
    reasoning: reasoningOf(record),
    enabled: record.enabled === 1,
  };
}

function invocationView(
  record: AgentInvocationRecord,
  agents: Map<string, AgentRecord>,
  accounts: Map<string, AccountRecord>,
): AgentInvocationView {
  const agent = record.agent_id ? agents.get(record.agent_id) : undefined;
  const account = record.account_id ? accounts.get(record.account_id) : undefined;
  return {
    id: record.id,
    runId: record.run_id,
    iteration: record.iteration,
    role: record.role,
    agentId: record.agent_id,
    agentName: agent?.display_name ?? null,
    providerId: agent ? toProviderId(agent.provider_id) : null,
    accountName: account?.display_name ?? null,
    model: agent?.model ?? null,
    reasoning: reasoningOf(agent),
    task: record.task,
    outcome: record.outcome,
    exitCode: record.exit_code,
    durationMs: record.duration_ms,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
  };
}

// -- Git --------------------------------------------------------------------

/**
 * The project's real git state.
 *
 * Read through `GitEvidenceCollector`, which routes every argument through
 * `assertReadOnlyGitArgs` - so nothing the interface asks for can mutate the
 * repository. When git is unavailable the shape says so instead of guessing.
 */
async function gitContext(services: Services, localPath: string): Promise<GitContextView> {
  const empty: GitContextView = {
    isRepository: false,
    branch: null,
    head: null,
    dirty: false,
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    remoteUrl: null,
  };

  let gitCommand: string;
  try {
    gitCommand = await services.runtimeManager.getExecutablePath('git');
  } catch (error) {
    return {
      ...empty,
      problem: error instanceof RuntimeError ? error.userMessage : 'O Git ainda não está configurado.',
    };
  }

  const collector = new GitEvidenceCollector(localPath, services.processManager, gitCommand);
  try {
    if (!(await collector.isGitRepository())) return empty;

    const [head, branch, status, numstat, remote] = await Promise.all([
      collector.git(['rev-parse', '--short', 'HEAD']),
      collector.git(['branch', '--show-current']),
      collector.git(['status', '--short']),
      collector.git(['diff', '--numstat', 'HEAD']),
      collector.git(['remote', 'get-url', 'origin']),
    ]);

    let additions = 0;
    let deletions = 0;
    let changed = 0;
    for (const line of numstat.stdout.split('\n')) {
      const parts = line.trim().split('\t');
      if (parts.length < 3) continue;
      changed += 1;
      // "-" marks a binary file: counted as changed, never as a line count.
      const added = Number(parts[0]);
      const removed = Number(parts[1]);
      if (Number.isFinite(added)) additions += added;
      if (Number.isFinite(removed)) deletions += removed;
    }

    const statusLines = status.stdout.split('\n').filter((l) => l.trim().length > 0);

    return {
      isRepository: true,
      branch: branch.ok ? branch.stdout.trim() || null : null,
      head: head.ok ? head.stdout.trim() || null : null,
      dirty: statusLines.length > 0,
      changedFiles: changed > 0 ? changed : statusLines.length,
      additions,
      deletions,
      remoteUrl: remote.ok ? remote.stdout.trim() || null : null,
    };
  } catch (error) {
    return { ...empty, problem: error instanceof Error ? error.message : 'Não foi possível ler o Git.' };
  }
}

async function gitBranches(services: Services, localPath: string): Promise<BranchView[]> {
  let gitCommand: string;
  try {
    gitCommand = await services.runtimeManager.getExecutablePath('git');
  } catch {
    return [];
  }

  const collector = new GitEvidenceCollector(localPath, services.processManager, gitCommand);
  try {
    if (!(await collector.isGitRepository())) return [];
    const result = await collector.git([
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)%09%(HEAD)%09%(committerdate:relative)',
      'refs/heads',
    ]);
    if (!result.ok) return [];
    return result.stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((parts): parts is [string, string, string] => parts.length === 3 && parts[0]!.length > 0)
      .map(([name, head, updated]) => ({ name, current: head.trim() === '*', updated: updated.trim() }));
  } catch {
    return [];
  }
}

// -- Accounts ---------------------------------------------------------------

function accountView(record: AccountRecord, defaultAccountId: string | null, agents: AgentRecord[]): AccountView {
  // Model and reasoning are the agent's, not the account's: the account has no
  // model of its own, so it borrows from the agent bound to it, or shows none.
  const agent = agents.find((a) => a.account_id === record.id);
  const view: AccountView = {
    id: record.id,
    providerId: (toProviderId(record.provider_id) ?? 'anthropic') as ProviderId,
    displayName: record.display_name,
    state: (['connected', 'disconnected', 'ambient-credential', 'runtime-missing'] as const).includes(
      record.auth_state as never,
    )
      ? (record.auth_state as AccountView['state'])
      : 'disconnected',
    isDefault: record.id === defaultAccountId,
    model: agent?.model ?? null,
    reasoning: reasoningOf(agent),
    createdAt: record.created_at,
  };
  if (record.auth_method) view.authMethod = record.auth_method;
  if (record.last_connected_at) view.lastConnectedAt = record.last_connected_at;
  return view;
}

function toAccount(record: AccountRecord): Account {
  const account: Account = {
    id: record.id,
    providerId: record.provider_id as Account['providerId'],
    displayName: record.display_name,
    createdAt: record.created_at,
  };
  if (record.last_connected_at) account.lastConnectedAt = record.last_connected_at;
  return account;
}

/**
 * Refreshes one account's authentication against the real CLI.
 *
 * Only Anthropic has a manager today. An OpenAI account is left with whatever
 * the database recorded rather than being reported as connected on no evidence.
 */
async function refreshAccount(services: Services, record: AccountRecord): Promise<AccountRecord> {
  if (record.provider_id !== 'anthropic') return record;
  const db = services.database();
  try {
    const status = await services.claudeAccounts.getStatus(toAccount(record));
    db.accounts.recordStatus(record.id, status.state, status.authMethod ?? null);
    return db.accounts.get(record.id) ?? record;
  } catch {
    // A failed check is not evidence of being signed out; the stored state stands.
    return record;
  }
}

async function listAccounts(services: Services): Promise<AccountView[]> {
  const db = services.database();
  const defaultAccountId = db.settings.get(SETTING_DEFAULT_ACCOUNT);
  const agents = db.agents.all();
  const records = db.accounts.all();
  const refreshed = await Promise.all(records.map((r) => refreshAccount(services, r)));
  return refreshed.map((r) => accountView(r, defaultAccountId, agents));
}

// -- Diagnostics ------------------------------------------------------------

async function diagnose(services: Services): Promise<DiagnosticView> {
  const report = await services.runtimeManager.diagnose();
  return {
    ready: report.ready,
    pending: report.pending,
    checkedAt: report.checkedAt,
    runtimes: report.runtimes.map((r) => {
      const view: DiagnosticView['runtimes'][number] = {
        runtimeId: r.runtimeId,
        displayName: r.displayName,
        origin: r.detection.origin,
        version: r.detection.version,
        healthy: r.health.healthy,
        canAutoConfigure: r.canAutoConfigure,
      };
      if (r.health.problem) view.problem = r.health.problem;
      if (r.health.remedy) view.remedy = r.health.remedy;
      return view;
    }),
  };
}

// -- Run detail -------------------------------------------------------------

async function runDetail(services: Services, runId: string): Promise<RunDetailView | null> {
  const db = services.database();
  const record = db.runs.get(runId);
  if (!record) return null;

  const agents = new Map(db.agents.all().map((a) => [a.id, a]));
  const accounts = new Map(db.accounts.all().map((a) => [a.id, a]));
  const workspace = db.workspaces.get(record.workspace_id);
  const definitionLabels = new Map(
    workspace ? db.verificationDefinitions.byWorkspace(workspace.id).map((d) => [d.id, d.label]) : [],
  );

  return {
    run: runView(record),
    steps: db.runSteps.byRun(runId).map(runStepView),
    invocations: db.agentInvocations.byRun(runId).map((i) => invocationView(i, agents, accounts)),
    verifications: db.verificationResults.byRun(runId).map((v) => verificationView(v, definitionLabels)),
    artifacts: db.artifacts.byRun(runId).map(artifactView),
    messages: record.session_id ? db.messages.bySession(record.session_id).map(messageView) : [],
    git: workspace ? await gitContext(services, workspace.local_path) : null,
  };
}

// -- Registration -----------------------------------------------------------

export interface IpcContext {
  services: Services;
  getWindow: () => BrowserWindow | null;
}

export function registerIpcHandlers(context: IpcContext): void {
  const { services, getWindow } = context;

  const emit = <C extends keyof EventChannels>(channel: C, payload: EventChannels[C]): void => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };

  const handle = <C extends InvokeChannel>(
    channel: C,
    handler: (request: InvokeRequest<C>) => Promise<InvokeResponse<C>> | InvokeResponse<C>,
  ): void => {
    ipcMain.handle(channel, async (_event, request: unknown) => {
      try {
        return await handler(request as InvokeRequest<C>);
      } catch (error) {
        // Errors cross the bridge as a message the interface can show. The
        // stack stays in Main: the renderer has no use for it.
        if (error instanceof RuntimeError) throw new Error(error.userMessage);
        if (error instanceof AccountError) throw new Error(error.userMessage);
        throw new Error(error instanceof Error ? error.message : 'Ocorreu um erro inesperado.');
      }
    });
  };

  const activeWorkspace = (): WorkspaceRecord | null => {
    if (!services.databaseAvailable) return null;
    const db = services.database();
    const id = db.settings.get(SETTING_ACTIVE_WORKSPACE);
    const chosen = id ? db.workspaces.get(id) : undefined;
    return chosen ?? db.workspaces.all()[0] ?? null;
  };

  // -- App state ------------------------------------------------------------

  handle('app:state', async (): Promise<AppStateView> => {
    const diagnostics = await diagnose(services);

    if (!services.databaseAvailable) {
      const state: AppStateView = {
        workspace: null,
        workspaces: [],
        sessions: [],
        accounts: [],
        agents: [],
        diagnostics,
        git: null,
        onboarded: false,
        settings: {},
        appVersion: process.env['npm_package_version'] ?? '0.1.0',
      };
      if (services.databaseProblem) state.databaseProblem = services.databaseProblem;
      return state;
    }

    const db = services.database();
    const workspace = activeWorkspace();
    const accounts = await listAccounts(services);
    const accountRecords = new Map(db.accounts.all().map((a) => [a.id, a]));

    return {
      workspace: workspace ? workspaceView(workspace) : null,
      workspaces: db.workspaces.all().map(workspaceView),
      sessions: workspace ? db.chatSessions.byWorkspace(workspace.id).map(sessionView) : [],
      accounts,
      agents: db.agents.all().map((a) => agentView(a, accountRecords)),
      diagnostics,
      git: workspace ? await gitContext(services, workspace.local_path) : null,
      // Onboarded means all three are true, each read from its real source.
      onboarded: diagnostics.ready && accounts.some((a) => a.state === 'connected') && workspace !== null,
      settings: db.settings.all(),
      appVersion: process.env['npm_package_version'] ?? '0.1.0',
    };
  });

  handle('app:openExternal', async (request) => {
    await shell.openExternal(externalUrl(request));
  });

  // -- Runtimes -------------------------------------------------------------

  handle('runtime:diagnose', () => diagnose(services));

  const prepareRuntime = async (
    id: RuntimeId,
    action: 'install' | 'repair',
  ): Promise<{ ok: boolean; problem?: string }> => {
    try {
      await services.runtimeManager[action](id, (progress) => emit('runtime:progress', progress));
      emit('app:stateChanged', undefined);
      return { ok: true };
    } catch (error) {
      const problem =
        error instanceof RuntimeError
          ? error.userMessage
          : error instanceof Error
            ? error.message
            : 'Não foi possível preparar este componente.';
      emit('runtime:progress', { runtimeId: id, phase: 'done', message: problem });
      return { ok: false, problem };
    }
  };

  handle('runtime:install', (request) => prepareRuntime(runtimeId(request), 'install'));
  handle('runtime:repair', (request) => prepareRuntime(runtimeId(request), 'repair'));

  // -- Accounts -------------------------------------------------------------

  handle('accounts:list', () => listAccounts(services));

  handle('accounts:create', async (request) => {
    const provider = providerId(request);
    const displayName = str(request, 'displayName', 200).trim();
    if (provider !== 'anthropic') {
      // Only Claude accounts have a manager that can own a profile directory.
      // Creating a row for a provider nothing can sign into would be a promise
      // the application cannot keep.
      throw new Error(
        `Contas ${provider === 'openai' ? 'OpenAI' : provider} ainda não podem ser gerenciadas por este aplicativo.`,
      );
    }

    const db = services.database();
    const id = services.newId();
    const profileDirectory = services.claudeAccounts.profileDirectory(id);
    services.claudeAccounts.createAccount({
      id,
      providerId: 'anthropic',
      displayName,
      createdAt: new Date().toISOString(),
    });
    const record = db.accounts.insert({ id, providerId: provider, displayName, profileDirectory });

    if (!db.settings.get(SETTING_DEFAULT_ACCOUNT)) db.settings.set(SETTING_DEFAULT_ACCOUNT, id);
    emit('app:stateChanged', undefined);
    return accountView(record, db.settings.get(SETTING_DEFAULT_ACCOUNT), db.agents.all());
  });

  handle('accounts:connect', async (request) => {
    const accountId = str(request, 'accountId', 200);
    const db = services.database();
    const record = db.accounts.get(accountId);
    if (!record) throw new Error('Conta não encontrada.');
    if (record.provider_id !== 'anthropic') {
      throw new Error('O login desta conta ainda não está disponível neste aplicativo.');
    }

    const controller = new AbortController();
    services.logins.get(accountId)?.abort();
    services.logins.set(accountId, controller);

    try {
      const status = await services.claudeAccounts.connect(toAccount(record), {
        signal: controller.signal,
        onProgress: (progress) => emit('accounts:loginProgress', progress),
        // The application opens the browser; the user never copies a URL.
        openUrl: (url) => {
          void shell.openExternal(url);
        },
      });
      db.accounts.recordStatus(accountId, status.state, status.authMethod ?? null);
      emit('app:stateChanged', undefined);
      return accountView(db.accounts.get(accountId)!, db.settings.get(SETTING_DEFAULT_ACCOUNT), db.agents.all());
    } finally {
      services.logins.delete(accountId);
    }
  });

  handle('accounts:cancelConnect', (request) => {
    const accountId = str(request, 'accountId', 200);
    services.logins.get(accountId)?.abort();
    services.logins.delete(accountId);
  });

  handle('accounts:disconnect', async (request) => {
    const accountId = str(request, 'accountId', 200);
    const db = services.database();
    const record = db.accounts.get(accountId);
    if (!record) throw new Error('Conta não encontrada.');
    // Disconnect records the state; the profile folder is deliberately kept,
    // which is exactly the difference between Disconnect and Remove.
    db.accounts.recordStatus(accountId, 'disconnected', null);
    emit('app:stateChanged', undefined);
    return accountView(db.accounts.get(accountId)!, db.settings.get(SETTING_DEFAULT_ACCOUNT), db.agents.all());
  });

  handle('accounts:remove', (request) => {
    const accountId = str(request, 'accountId', 200);
    const db = services.database();
    const record = db.accounts.get(accountId);
    if (!record) return;
    if (record.provider_id === 'anthropic') services.claudeAccounts.removeAccount(accountId);
    db.agents.clearAccount(accountId);
    db.accounts.remove(accountId);
    if (db.settings.get(SETTING_DEFAULT_ACCOUNT) === accountId) {
      const next = db.accounts.all()[0];
      db.settings.set(SETTING_DEFAULT_ACCOUNT, next?.id ?? '');
    }
    emit('app:stateChanged', undefined);
  });

  handle('accounts:setDefault', (request) => {
    const accountId = str(request, 'accountId', 200);
    const db = services.database();
    if (!db.accounts.get(accountId)) throw new Error('Conta não encontrada.');
    db.settings.set(SETTING_DEFAULT_ACCOUNT, accountId);
    emit('app:stateChanged', undefined);
  });

  handle('accounts:rename', (request) => {
    const accountId = str(request, 'accountId', 200);
    const displayName = str(request, 'displayName', 200).trim();
    const db = services.database();
    if (!db.accounts.get(accountId)) throw new Error('Conta não encontrada.');
    db.accounts.rename(accountId, displayName);
    emit('app:stateChanged', undefined);
    return accountView(db.accounts.get(accountId)!, db.settings.get(SETTING_DEFAULT_ACCOUNT), db.agents.all());
  });

  // -- Workspaces -----------------------------------------------------------

  handle('workspaces:list', () => services.database().workspaces.all().map(workspaceView));

  handle('workspaces:choose', async () => {
    const window = getWindow();
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: 'Escolher pasta do projeto',
          properties: ['openDirectory'],
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });

    const localPath = result.canceled ? undefined : result.filePaths[0];
    if (!localPath) return null;

    const db = services.database();
    const git = await gitContext(services, localPath);
    const record = db.workspaces.ensure({
      displayName: basename(localPath),
      localPath,
      repositoryUrl: git.remoteUrl,
    });
    db.settings.set(SETTING_ACTIVE_WORKSPACE, record.id);
    db.workspaces.touch(record.id);
    emit('app:stateChanged', undefined);
    return workspaceView(record);
  });

  handle('workspaces:open', (request) => {
    const workspaceId = str(request, 'workspaceId', 200);
    const db = services.database();
    const record = db.workspaces.get(workspaceId);
    if (!record) throw new Error('Projeto não encontrado.');
    db.settings.set(SETTING_ACTIVE_WORKSPACE, workspaceId);
    db.workspaces.touch(workspaceId);
    emit('app:stateChanged', undefined);
    return workspaceView(record);
  });

  // -- Git ------------------------------------------------------------------

  handle('git:context', async (request) => {
    const workspaceId = str(request, 'workspaceId', 200);
    const record = services.database().workspaces.get(workspaceId);
    if (!record) throw new Error('Projeto não encontrado.');
    return gitContext(services, record.local_path);
  });

  handle('git:branches', async (request) => {
    const workspaceId = str(request, 'workspaceId', 200);
    const record = services.database().workspaces.get(workspaceId);
    if (!record) throw new Error('Projeto não encontrado.');
    return gitBranches(services, record.local_path);
  });

  // -- Sessions -------------------------------------------------------------

  handle('sessions:list', (request) => {
    const workspaceId = str(request, 'workspaceId', 200);
    return services.database().chatSessions.byWorkspace(workspaceId).map(sessionView);
  });

  handle('sessions:create', (request) => {
    const workspaceId = str(request, 'workspaceId', 200);
    const title = str(request, 'title', 500).trim();
    const db = services.database();
    if (!db.workspaces.get(workspaceId)) throw new Error('Projeto não encontrado.');
    const record = db.chatSessions.create(workspaceId, title);
    emit('app:stateChanged', undefined);
    return sessionView(record);
  });

  handle('sessions:messages', (request) => {
    const sessionId = str(request, 'sessionId', 200);
    return services.database().messages.bySession(sessionId).map(messageView);
  });

  // -- Runs -----------------------------------------------------------------

  handle('runs:list', (request) => {
    const workspaceId = str(request, 'workspaceId', 200);
    return services.database().runs.byWorkspace(workspaceId).map(runView);
  });

  handle('runs:detail', (request) => runDetail(services, str(request, 'runId', 200)));

  handle('runs:active', async (request) => {
    const workspaceId = str(request, 'workspaceId', 200);
    const db = services.database();
    // The open run if there is one, otherwise the most recent, so a finished
    // run stays on screen instead of the workspace snapping back to empty.
    const record = db.runs.active(workspaceId) ?? db.runs.latest(workspaceId);
    return record ? runDetail(services, record.id) : null;
  });

  handle('runs:start', async (request) => {
    const workspaceId = str(request, 'workspaceId', 200);
    const objective = str(request, 'objective', 20_000).trim();
    const sessionId = nullableStr(request, 'sessionId');

    const db = services.database();
    const workspace = db.workspaces.get(workspaceId);
    if (!workspace) throw new Error('Projeto não encontrado.');
    if (db.runs.active(workspaceId)) {
      throw new Error('Já existe uma execução em andamento neste projeto.');
    }

    // A session is required so the objective is persisted as chat history.
    const session = sessionId
      ? (db.chatSessions.get(sessionId) ?? db.chatSessions.create(workspaceId, objective.slice(0, 80)))
      : db.chatSessions.create(workspaceId, objective.slice(0, 80));

    const maxIterations = Number(db.settings.get(SETTING_MAX_ITERATIONS) ?? DEFAULT_MAX_ITERATIONS);

    // The baseline is captured for real, from git, before anything else -
    // the run's evidence starts from a fact, not from an assumption.
    let baselineBranch: string | null = null;
    let baselineCommit: string | null = null;
    let baselineDirty = false;
    try {
      const gitCommand = await services.runtimeManager.getExecutablePath('git');
      const collector = new GitEvidenceCollector(workspace.local_path, services.processManager, gitCommand);
      const baseline = await collector.captureBaseline();
      baselineBranch = baseline.branch;
      baselineCommit = baseline.commit;
      baselineDirty = baseline.dirty;
    } catch {
      // Git not ready: recorded as absent, never as a clean tree.
    }

    const run = db.runs.create({
      workspaceId,
      sessionId: session.id,
      objective,
      maxIterations: Number.isFinite(maxIterations) ? maxIterations : DEFAULT_MAX_ITERATIONS,
      baselineBranch,
      baselineCommit,
      baselineDirty,
    });

    db.messages.append({
      sessionId: session.id,
      runId: run.id,
      kind: 'USER_MESSAGE',
      author: 'user',
      body: objective,
    });

    const stepId = db.runSteps.start({
      runId: run.id,
      iteration: 0,
      phase: 'baseline',
      summary: 'Estado inicial do projeto registrado.',
    });
    db.runSteps.finish(
      stepId,
      baselineCommit ? 'passed' : 'skipped',
      baselineCommit
        ? `Baseline ${baselineCommit.slice(0, 7)} em ${baselineBranch ?? 'HEAD'}${baselineDirty ? ' (árvore suja)' : ''}`
        : 'O Git ainda não está configurado; nenhum baseline foi registrado.',
    );

    // The loop that drives Codex -> Claude -> Evidence -> Verification ->
    // Codex -> DoneGate is not part of this build. Rather than leave the run
    // spinning on a promise nothing will keep, it stops here and says so: a
    // real state, with a real reason, that the interface already draws.
    db.runs.setStatus(
      run.id,
      'NEEDS_HUMAN',
      'O motor de orquestração ainda não está conectado nesta versão. O objetivo, o baseline do Git e o histórico foram registrados; nenhum agente foi executado.',
    );
    db.chatSessions.touch(session.id);

    emit('runs:changed', { runId: run.id });
    emit('app:stateChanged', undefined);
    return { runId: run.id };
  });

  const setRunStatus = (request: unknown, status: RunState, reason?: string): void => {
    const runId = str(request, 'runId', 200);
    const db = services.database();
    if (!db.runs.get(runId)) throw new Error('Execução não encontrada.');
    db.runs.setStatus(runId, status, reason ?? null);
    emit('runs:changed', { runId });
    emit('app:stateChanged', undefined);
  };

  handle('runs:pause', (request) => setRunStatus(request, 'PAUSED'));
  handle('runs:resume', (request) => setRunStatus(request, 'PLANNING'));

  handle('runs:cancel', async (request) => {
    // Cancel is a real stop: every process this run could have started is
    // killed before the status changes, so nothing is left orphaned.
    await services.processManager.cancelAll();
    setRunStatus(request, 'CANCELLED', 'Cancelado pelo usuário.');
  });

  handle('runs:resolveHumanReview', (request) => {
    const runId = str(request, 'runId', 200);
    const option = str(request, 'option', 2_000);
    const instruction = optionalStr(request, 'instruction', 20_000);

    const db = services.database();
    const run = db.runs.get(runId);
    if (!run) throw new Error('Execução não encontrada.');

    // The decision is written to history before anything acts on it, so the
    // record of what the human chose survives regardless of what follows.
    if (run.session_id) {
      db.messages.append({
        sessionId: run.session_id,
        runId,
        kind: 'HUMAN_REVIEW',
        author: 'user',
        body: instruction ? `${option}: ${instruction}` : option,
        payload: { option, instruction: instruction ?? null },
      });
    }
    const stepId = db.runSteps.start({
      runId,
      iteration: run.iteration,
      phase: 'human-review',
      summary: option,
    });
    db.runSteps.finish(stepId, 'passed', option, instruction ?? null);

    emit('runs:changed', { runId });
    emit('app:stateChanged', undefined);
  });

  // -- Settings -------------------------------------------------------------

  handle('settings:all', () => services.database().settings.all());

  handle('settings:set', (request) => {
    const key = str(request, 'key', 200);
    // An empty value is legitimate here (clearing a setting), so `str` - which
    // rejects the empty string - is deliberately not used for it.
    const raw = asObject(request)['value'];
    if (typeof raw !== 'string' || raw.length > 10_000) {
      throw new InvalidPayloadError('"value" deve ser um texto');
    }
    const value = raw;
    services.database().settings.set(key, value);
    emit('app:stateChanged', undefined);
  });
}
