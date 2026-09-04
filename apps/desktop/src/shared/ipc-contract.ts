/**
 * The complete IPC surface of the application.
 *
 * Two rules make this file the security boundary of the desktop app:
 *
 *  1. **There is no generic channel.** No `exec`, no `shell`, no `runCommand`,
 *     no pass-through `invoke`. A renderer can only ask for the operations
 *     enumerated here, by name, and every one of them is a *domain* operation
 *     ("install the codex runtime"), never a *machine* operation ("run this
 *     string").
 *  2. **The channel list is closed.** `REQUEST_CHANNELS` is the whole set. The
 *     main process registers exactly these and nothing else; the preload
 *     exposes exactly these and nothing else. Tests assert all three sides
 *     agree, so a channel cannot be added on one side alone.
 */

/* ------------------------------------------------------------------ *
 * Request channels: renderer → main, request/response.
 * ------------------------------------------------------------------ */

export const REQUEST_CHANNELS = [
  'app.info',

  'runtime.diagnose',
  'runtime.install',
  'runtime.cancelInstall',

  'accounts.list',
  'accounts.create',
  'accounts.connect',
  'accounts.cancelConnect',
  'accounts.status',
  'accounts.remove',

  'agents.list',

  'workspace.list',
  'workspace.selectFolder',
  'workspace.create',
  'workspace.clone',
  'workspace.setAgents',

  'chat.listSessions',
  'chat.createSession',
  'chat.listMessages',
  'chat.sendMessage',

  'run.get',
  'run.cancel',
] as const;

export type RequestChannel = (typeof REQUEST_CHANNELS)[number];

/* ------------------------------------------------------------------ *
 * Event channels: main → renderer, one-way notifications.
 * ------------------------------------------------------------------ */

export const EVENT_CHANNELS = [
  'runtime:progress',
  'account:progress',
  'run:progress',
] as const;

export type EventChannel = (typeof EVENT_CHANNELS)[number];

/* ------------------------------------------------------------------ *
 * Payload types.
 * ------------------------------------------------------------------ */

export type RuntimeId = 'codex' | 'claude-code' | 'git';

/** The providers a user can hold an account with today. */
export type ProviderName = 'anthropic' | 'openai';

export interface AppInfo {
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly nodeVersion: string;
  readonly chromeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly sqliteAvailable: boolean;
  readonly packaged: boolean;
}

export interface RuntimeStatusView {
  readonly runtimeId: RuntimeId;
  readonly displayName: string;
  /** `managed` | `system` | `missing`. */
  readonly origin: string;
  readonly version: string | null;
  readonly ready: boolean;
  readonly canAutoConfigure: boolean;
  /** Already user-facing Portuguese; the renderer never composes these. */
  readonly detail: string;
}

export interface DiagnosticView {
  readonly ready: boolean;
  readonly runtimes: readonly RuntimeStatusView[];
  readonly pending: readonly RuntimeId[];
  readonly checkedAt: string;
}

/** Install phases translated for the interface. `percent` may be absent. */
export interface RuntimeProgressEvent {
  readonly runtimeId: RuntimeId;
  readonly phase: string;
  /** Friendly label: "Baixando", "Verificando", "Instalando", ... */
  readonly label: string;
  readonly message: string;
  readonly percent: number | null;
}

export interface InstallResultView {
  readonly ok: boolean;
  readonly runtimeId: RuntimeId;
  readonly version: string | null;
  readonly message: string;
}

export type AuthStateView =
  | 'connected'
  | 'disconnected'
  | 'ambient-credential'
  | 'runtime-missing';

export interface AccountView {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly state: AuthStateView;
  readonly detail: string;
}

export interface AccountProgressEvent {
  readonly accountId: string;
  readonly stage: string;
  readonly label: string;
  /** Present only when the user must be sent to the browser. */
  readonly url?: string;
  /** Short confirmation code shown by a device-code sign-in, when there is one. */
  readonly code?: string;
}

export interface AgentView {
  readonly id: string;
  readonly name: string;
  /** `ORCHESTRATOR` | `CODING_WORKER`. */
  readonly role: string;
  readonly runtimeId: RuntimeId;
  readonly accountId: string | null;
}

export interface WorkspaceView {
  readonly id: string;
  readonly name: string;
  readonly localPath: string;
  readonly repositoryUrl: string | null;
  readonly defaultBranch: string | null;
  /**
   * The branch checked out right now, read from the working copy.
   *
   * Null when the folder is not a repository, or when git could not answer -
   * the interface says so rather than showing a stale guess.
   */
  readonly branch: string | null;
  readonly orchestratorAgentId: string | null;
  readonly workerAgentId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChatSessionView {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly createdAt: string;
}

export interface ChatMessageView {
  readonly id: string;
  readonly sessionId: string;
  /** `user` | `orchestrator` | `worker` | `system`. */
  readonly author: string;
  readonly text: string;
  readonly createdAt: string;
  readonly runId: string | null;
}

export interface RunView {
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  /** `PENDING` | `RUNNING` | `DONE` | `FAILED` | `CANCELLED`. */
  readonly status: string;
  readonly iterations: number;
  readonly summary: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface RunProgressEvent {
  readonly runId: string;
  readonly sessionId: string;
  readonly stage: string;
  /** Already-friendly Portuguese, e.g. "Claude executando...". */
  readonly label: string;
  readonly status: string;
  /** Set when the step produced a chat message the renderer should append. */
  readonly message?: ChatMessageView;
}

/* ------------------------------------------------------------------ *
 * Request/response map. One entry per channel; both sides use it.
 * ------------------------------------------------------------------ */

export interface IpcMap {
  'app.info': { request: void; response: AppInfo };

  'runtime.diagnose': { request: void; response: DiagnosticView };
  'runtime.install': { request: { runtimeId: RuntimeId }; response: InstallResultView };
  'runtime.cancelInstall': { request: { runtimeId: RuntimeId }; response: { cancelled: boolean } };

  'accounts.list': { request: void; response: readonly AccountView[] };
  'accounts.create': { request: { name: string; provider: ProviderName }; response: AccountView };
  'accounts.connect': { request: { accountId: string }; response: AccountView };
  'accounts.cancelConnect': { request: { accountId: string }; response: { cancelled: boolean } };
  'accounts.status': { request: { accountId: string }; response: AccountView };
  'accounts.remove': { request: { accountId: string }; response: { removed: boolean } };

  'agents.list': { request: void; response: readonly AgentView[] };

  'workspace.list': { request: void; response: readonly WorkspaceView[] };
  'workspace.selectFolder': { request: void; response: { path: string | null } };
  'workspace.create': {
    request: { name: string; localPath: string; repositoryUrl?: string; defaultBranch?: string };
    response: WorkspaceView;
  };
  'workspace.clone': {
    request: { repositoryUrl: string; parentPath: string; name: string };
    response: WorkspaceView;
  };
  'workspace.setAgents': {
    request: { workspaceId: string; orchestratorAgentId: string; workerAgentId: string };
    response: WorkspaceView;
  };

  'chat.listSessions': { request: { workspaceId: string }; response: readonly ChatSessionView[] };
  'chat.createSession': {
    request: { workspaceId: string; title: string };
    response: ChatSessionView;
  };
  'chat.listMessages': { request: { sessionId: string }; response: readonly ChatMessageView[] };
  'chat.sendMessage': {
    request: { sessionId: string; text: string };
    response: { message: ChatMessageView; run: RunView };
  };

  'run.get': { request: { runId: string }; response: RunView };
  'run.cancel': { request: { runId: string }; response: { cancelled: boolean } };
}

export interface EventMap {
  'runtime:progress': RuntimeProgressEvent;
  'account:progress': AccountProgressEvent;
  'run:progress': RunProgressEvent;
}

/** Every response crosses the bridge wrapped, so a rejection is data. */
export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
