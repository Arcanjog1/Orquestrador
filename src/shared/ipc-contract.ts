/**
 * The typed contract between Main and the Renderer.
 *
 * This file is the only thing both sides share. It carries no implementation
 * and no Node import, so the renderer can depend on it without ever reaching
 * the main process's world (spec: `contextIsolation`, `nodeIntegration=false`).
 *
 * Every channel is listed here by name. The preload bridge exposes exactly
 * this list and nothing else, and Main validates every payload before acting
 * on it. Adding a capability means adding it here first, deliberately.
 */

// -- Domain shapes the interface renders -----------------------------------

export type ProviderId = 'openai' | 'anthropic' | 'google' | 'github';

export type AuthState = 'connected' | 'disconnected' | 'ambient-credential' | 'runtime-missing';

export type RuntimeId = 'codex' | 'claude-code' | 'git';

/**
 * The run states the interface knows how to draw.
 *
 * Kept identical to the approved design's state list. `runs.status` in the
 * database is the source of truth; anything it reports that is not in this
 * list is drawn as IDLE rather than invented.
 */
export type RunState =
  | 'IDLE'
  | 'PLANNING'
  | 'DELEGATING'
  | 'WORKER_RUNNING'
  | 'COLLECTING_EVIDENCE'
  | 'VERIFYING'
  | 'REVIEWING'
  | 'RETRYING'
  | 'PAUSING'
  | 'PAUSED'
  | 'NEEDS_HUMAN'
  | 'DONE'
  | 'CANCELLED'
  | 'FAILED';

export interface RuntimeStatusView {
  runtimeId: RuntimeId;
  displayName: string;
  origin: 'managed' | 'system' | 'missing';
  version: string | null;
  healthy: boolean;
  problem?: string;
  remedy?: string;
  canAutoConfigure: boolean;
}

export interface DiagnosticView {
  ready: boolean;
  runtimes: RuntimeStatusView[];
  pending: RuntimeId[];
  checkedAt: string;
}

export interface InstallProgressView {
  runtimeId: RuntimeId;
  phase:
    | 'resolving'
    | 'downloading'
    | 'verifying'
    | 'extracting'
    | 'staging-health-check'
    | 'installing'
    | 'health-check'
    | 'rolled-back'
    | 'done';
  message: string;
  percent?: number;
}

export interface AccountView {
  id: string;
  providerId: ProviderId;
  displayName: string;
  state: AuthState;
  authMethod?: string;
  problem?: string;
  remedy?: string;
  isDefault: boolean;
  /** Effective model for this account, or null when none has been recorded. */
  model: string | null;
  /** Effective reasoning level, or null when none has been recorded. */
  reasoning: string | null;
  createdAt: string;
  lastConnectedAt?: string;
}

export interface LoginProgressView {
  accountId: string;
  phase: 'starting' | 'awaiting-browser' | 'waiting-for-completion' | 'connected' | 'failed' | 'cancelled';
  message: string;
  /** Present so the interface can offer "open the browser again". Never logged. */
  url?: string;
}

export interface WorkspaceView {
  id: string;
  displayName: string;
  localPath: string;
  repositoryUrl: string | null;
  defaultBranch: string | null;
  createdAt: string;
  lastOpenedAt: string | null;
}

export interface BranchView {
  name: string;
  current: boolean;
  /** Relative time as git reported it, e.g. "há 4 min". Never fabricated. */
  updated: string;
}

export interface GitContextView {
  isRepository: boolean;
  branch: string | null;
  head: string | null;
  /** Clean/dirty as git reports it. */
  dirty: boolean;
  changedFiles: number;
  additions: number;
  deletions: number;
  remoteUrl: string | null;
  /** Set when git could not be consulted at all. */
  problem?: string;
}

export interface AgentView {
  id: string;
  role: string;
  providerId: ProviderId;
  displayName: string;
  accountId: string | null;
  accountName: string | null;
  model: string | null;
  reasoning: string | null;
  enabled: boolean;
}

export interface ChatSessionView {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageView {
  id: string;
  sessionId: string;
  runId: string | null;
  kind: string;
  author: string;
  agentId: string | null;
  body: string;
  payload: unknown;
  createdAt: string;
}

export interface AgentInvocationView {
  id: string;
  runId: string;
  iteration: number;
  role: string;
  agentId: string | null;
  agentName: string | null;
  providerId: ProviderId | null;
  accountName: string | null;
  model: string | null;
  reasoning: string | null;
  task: string | null;
  outcome: string;
  exitCode: number | null;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface RunStepView {
  id: number;
  runId: string;
  iteration: number;
  phase: string;
  status: string;
  summary: string | null;
  detail: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface VerificationResultView {
  id: number;
  runId: string;
  iteration: number;
  definitionId: string | null;
  label: string;
  command: string;
  exitCode: number | null;
  passed: boolean;
  refused: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface ArtifactView {
  id: string;
  runId: string | null;
  kind: string;
  label: string | null;
  relativePath: string;
  bytes: number | null;
  createdAt: string;
}

export interface RunView {
  id: string;
  sessionId: string | null;
  workspaceId: string;
  objective: string;
  status: RunState;
  iteration: number;
  maxIterations: number;
  baselineBranch: string | null;
  baselineCommit: string | null;
  terminationReason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Everything the timeline, the activity panel and the done state read from. */
export interface RunDetailView {
  run: RunView;
  steps: RunStepView[];
  invocations: AgentInvocationView[];
  verifications: VerificationResultView[];
  artifacts: ArtifactView[];
  messages: MessageView[];
  git: GitContextView | null;
}

export interface AppStateView {
  /** Null until onboarding has chosen a workspace. */
  workspace: WorkspaceView | null;
  workspaces: WorkspaceView[];
  sessions: ChatSessionView[];
  accounts: AccountView[];
  agents: AgentView[];
  diagnostics: DiagnosticView;
  git: GitContextView | null;
  /** True once runtimes are ready, an account is connected and a workspace is set. */
  onboarded: boolean;
  settings: Record<string, string>;
  appVersion: string;
  /** Set when the database could not be opened; the interface degrades honestly. */
  databaseProblem?: string;
}

// -- Channels ---------------------------------------------------------------

/**
 * Request/response channels, invoked from the renderer.
 *
 * The key is the channel name used on the wire; the value describes its
 * argument and result. Keeping them in one map is what lets the preload
 * bridge and Main stay in step without either of them re-declaring anything.
 */
export interface InvokeChannels {
  'app:state': { request: void; response: AppStateView };
  'app:openExternal': { request: { url: string }; response: void };

  'runtime:diagnose': { request: void; response: DiagnosticView };
  'runtime:install': { request: { runtimeId: RuntimeId }; response: { ok: boolean; problem?: string } };
  'runtime:repair': { request: { runtimeId: RuntimeId }; response: { ok: boolean; problem?: string } };

  'accounts:list': { request: void; response: AccountView[] };
  'accounts:create': { request: { providerId: ProviderId; displayName: string }; response: AccountView };
  'accounts:connect': { request: { accountId: string }; response: AccountView };
  'accounts:cancelConnect': { request: { accountId: string }; response: void };
  'accounts:disconnect': { request: { accountId: string }; response: AccountView };
  'accounts:remove': { request: { accountId: string }; response: void };
  'accounts:setDefault': { request: { accountId: string }; response: void };
  'accounts:rename': { request: { accountId: string; displayName: string }; response: AccountView };

  'workspaces:list': { request: void; response: WorkspaceView[] };
  'workspaces:choose': { request: void; response: WorkspaceView | null };
  'workspaces:open': { request: { workspaceId: string }; response: WorkspaceView };

  'git:context': { request: { workspaceId: string }; response: GitContextView };
  'git:branches': { request: { workspaceId: string }; response: BranchView[] };

  'sessions:list': { request: { workspaceId: string }; response: ChatSessionView[] };
  'sessions:create': { request: { workspaceId: string; title: string }; response: ChatSessionView };
  'sessions:messages': { request: { sessionId: string }; response: MessageView[] };

  'runs:list': { request: { workspaceId: string }; response: RunView[] };
  'runs:detail': { request: { runId: string }; response: RunDetailView | null };
  'runs:active': { request: { workspaceId: string }; response: RunDetailView | null };
  'runs:start': { request: { workspaceId: string; sessionId: string | null; objective: string }; response: { runId: string } };
  'runs:pause': { request: { runId: string }; response: void };
  'runs:resume': { request: { runId: string }; response: void };
  'runs:cancel': { request: { runId: string }; response: void };
  'runs:resolveHumanReview': { request: { runId: string; option: string; instruction?: string }; response: void };

  'settings:all': { request: void; response: Record<string, string> };
  'settings:set': { request: { key: string; value: string }; response: void };
}

export type InvokeChannel = keyof InvokeChannels;
export type InvokeRequest<C extends InvokeChannel> = InvokeChannels[C]['request'];
export type InvokeResponse<C extends InvokeChannel> = InvokeChannels[C]['response'];

/** Push channels, main → renderer. */
export interface EventChannels {
  'runtime:progress': InstallProgressView;
  'accounts:loginProgress': LoginProgressView;
  'app:stateChanged': void;
  'runs:changed': { runId: string };
}

export type EventChannel = keyof EventChannels;

export const INVOKE_CHANNELS: readonly InvokeChannel[] = [
  'app:state',
  'app:openExternal',
  'runtime:diagnose',
  'runtime:install',
  'runtime:repair',
  'accounts:list',
  'accounts:create',
  'accounts:connect',
  'accounts:cancelConnect',
  'accounts:disconnect',
  'accounts:remove',
  'accounts:setDefault',
  'accounts:rename',
  'workspaces:list',
  'workspaces:choose',
  'workspaces:open',
  'git:context',
  'git:branches',
  'sessions:list',
  'sessions:create',
  'sessions:messages',
  'runs:list',
  'runs:detail',
  'runs:active',
  'runs:start',
  'runs:pause',
  'runs:resume',
  'runs:cancel',
  'runs:resolveHumanReview',
  'settings:all',
  'settings:set',
] as const;

export const EVENT_CHANNELS: readonly EventChannel[] = [
  'runtime:progress',
  'accounts:loginProgress',
  'app:stateChanged',
  'runs:changed',
] as const;

/** The shape the preload bridge puts on `window.orchestrator`. */
export interface OrchestratorBridge {
  invoke<C extends InvokeChannel>(channel: C, request: InvokeRequest<C>): Promise<InvokeResponse<C>>;
  on<C extends EventChannel>(channel: C, listener: (payload: EventChannels[C]) => void): () => void;
}
