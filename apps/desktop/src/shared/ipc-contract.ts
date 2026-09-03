/**
 * The one place that says what the renderer is allowed to ask for.
 *
 * Every entry here is a *specific operation*. There is deliberately no
 * `exec`, `shell`, `runCommand` or any other channel that would let the
 * renderer turn the main process into a terminal: the renderer asks for
 * "diagnose the runtimes", never for "run this string".
 *
 * Shared by main, preload and renderer so the three cannot drift.
 */

import type {
  InstallPhase,
  InstallProgress,
  RuntimeId,
} from '../../../../src/runtime/types.js';
import type { DiagnosticReport } from '../../../../src/runtime/runtime-manager.js';
import type {
  Account,
  AccountStatus,
  LoginPhase,
  ProviderId,
} from '../../../../src/accounts/account-types.js';

/** Name the preload binds on `window`. */
export const BRIDGE_KEY = 'orchestrator';

/* -------------------------------------------------------------------------- */
/* Invocable channels                                                          */
/* -------------------------------------------------------------------------- */

export const INVOKE_CHANNELS = [
  'app:getInfo',
  'app:getBootstrapState',
  'runtime:diagnose',
  'runtime:install',
  'runtime:repair',
  'runtime:cancelInstall',
  'accounts:list',
  'accounts:create',
  'accounts:remove',
  'accounts:status',
  'accounts:connect',
  'accounts:cancelConnect',
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

/** Events pushed from main to renderer. The renderer can only listen. */
export const EVENT_CHANNELS = ['runtime:progress', 'accounts:loginProgress'] as const;

export type EventChannel = (typeof EVENT_CHANNELS)[number];

/* -------------------------------------------------------------------------- */
/* Payloads                                                                    */
/* -------------------------------------------------------------------------- */

export interface AppInfo {
  name: string;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Shown in the about/developer view, never in the normal flow. */
  versions: { electron: string; node: string; chrome: string; sqlite: string };
}

/** What bootstrap managed to do before the window appeared. */
export interface BootstrapState {
  databaseReady: boolean;
  schemaVersion: number;
  /** User-facing text; present only when something went wrong. */
  problem?: string;
  remedy?: string;
}

export interface RuntimeIdPayload {
  runtimeId: RuntimeId;
}

export interface AccountIdPayload {
  accountId: string;
}

export interface CreateAccountPayload {
  providerId: ProviderId;
  displayName: string;
}

/**
 * The result of an install, trimmed for the interface.
 *
 * The full manifest carries URLs, hosts and checksums. Those belong in the
 * developer view, not in the onboarding screen, so they do not cross the
 * bridge here.
 */
export interface InstallSummary {
  runtimeId: RuntimeId;
  displayName: string;
  version: string;
  healthy: boolean;
  rolledBack: boolean;
  problem?: string;
}

/** Friendly step names. The interface shows these, never the raw phase. */
export const INSTALL_STEPS = [
  'Baixando',
  'Verificando',
  'Instalando',
  'Testando',
  'Concluído',
  'Restaurado',
] as const;

export type InstallStep = (typeof INSTALL_STEPS)[number];

export const PHASE_TO_STEP: Record<InstallPhase, InstallStep> = {
  resolving: 'Baixando',
  downloading: 'Baixando',
  verifying: 'Verificando',
  extracting: 'Instalando',
  'staging-health-check': 'Testando',
  installing: 'Instalando',
  'health-check': 'Testando',
  'rolled-back': 'Restaurado',
  done: 'Concluído',
};

/** What the renderer receives while a runtime is being prepared. */
export interface InstallProgressEvent {
  runtimeId: RuntimeId;
  step: InstallStep;
  message: string;
  percent?: number;
  /** Only populated in developer mode; empty otherwise. */
  diagnostic?: InstallProgress;
}

/**
 * What the renderer receives during a sign-in.
 *
 * `LoginProgress.url` is deliberately absent: the sign-in URL can carry a
 * one-time code, the main process opens the browser itself, and there is no
 * reason for a web page to ever hold it.
 */
export interface LoginProgressEvent {
  accountId: string;
  phase: LoginPhase;
  message: string;
  browserOpened: boolean;
}

/** Every failure crosses the bridge in this shape. Never a stack trace. */
export interface IpcFailure {
  ok: false;
  userMessage: string;
  remedy?: string;
  /** Stable code so the interface can branch without matching on text. */
  code: 'INVALID_REQUEST' | 'RUNTIME_ERROR' | 'ACCOUNT_ERROR' | 'DATABASE_ERROR' | 'INTERNAL';
}

export interface IpcSuccess<T> {
  ok: true;
  data: T;
}

export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

/* -------------------------------------------------------------------------- */
/* Channel -> (request, response) map                                          */
/* -------------------------------------------------------------------------- */

export interface ChannelMap {
  'app:getInfo': { request: void; response: AppInfo };
  'app:getBootstrapState': { request: void; response: BootstrapState };
  'runtime:diagnose': { request: void; response: DiagnosticReport };
  'runtime:install': { request: RuntimeIdPayload; response: InstallSummary };
  'runtime:repair': { request: RuntimeIdPayload; response: InstallSummary };
  'runtime:cancelInstall': { request: RuntimeIdPayload; response: { cancelled: boolean } };
  'accounts:list': { request: void; response: Account[] };
  'accounts:create': { request: CreateAccountPayload; response: Account };
  'accounts:remove': { request: AccountIdPayload; response: { removed: boolean } };
  'accounts:status': { request: AccountIdPayload; response: AccountStatus };
  'accounts:connect': { request: AccountIdPayload; response: AccountStatus };
  'accounts:cancelConnect': { request: AccountIdPayload; response: { cancelled: boolean } };
}

export interface EventMap {
  'runtime:progress': InstallProgressEvent;
  'accounts:loginProgress': LoginProgressEvent;
}

export type Request<C extends InvokeChannel> = ChannelMap[C]['request'];
export type Response<C extends InvokeChannel> = ChannelMap[C]['response'];

/** The shape the preload publishes on `window.orchestrator`. */
export interface OrchestratorBridge {
  app: {
    getInfo(): Promise<IpcResult<AppInfo>>;
    getBootstrapState(): Promise<IpcResult<BootstrapState>>;
  };
  runtime: {
    diagnose(): Promise<IpcResult<DiagnosticReport>>;
    install(runtimeId: RuntimeId): Promise<IpcResult<InstallSummary>>;
    repair(runtimeId: RuntimeId): Promise<IpcResult<InstallSummary>>;
    cancelInstall(runtimeId: RuntimeId): Promise<IpcResult<{ cancelled: boolean }>>;
    onProgress(listener: (event: InstallProgressEvent) => void): () => void;
  };
  accounts: {
    list(): Promise<IpcResult<Account[]>>;
    create(providerId: ProviderId, displayName: string): Promise<IpcResult<Account>>;
    remove(accountId: string): Promise<IpcResult<{ removed: boolean }>>;
    status(accountId: string): Promise<IpcResult<AccountStatus>>;
    connect(accountId: string): Promise<IpcResult<AccountStatus>>;
    cancelConnect(accountId: string): Promise<IpcResult<{ cancelled: boolean }>>;
    onLoginProgress(listener: (event: LoginProgressEvent) => void): () => void;
  };
}
