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
  'app.setStartWithSystem',
  'app.openExternal',

  'settings.all',
  'settings.set',

  'runtime.diagnose',
  'runtime.install',
  'runtime.cancelInstall',

  'accounts.list',
  'accounts.create',
  'accounts.connect',
  'accounts.cancelConnect',
  'accounts.status',
  'accounts.remove',
  'github.status',
  'github.configure',
  'github.connect',
  'github.cancelConnect',
  'github.disconnect',
  'github.repositories',
  'github.branches',
  'github.pullRequestStatus',
  'github.createPullRequest',
  'workspace.fetch',
  'workspace.createBranch',
  'workspace.commit',
  'workspace.push',

  'agents.list',
  'agents.status',

  'repository.analyse',

  'workspace.list',
  'workspace.selectFolder',
  'workspace.openProject',
  'workspace.create',
  'workspace.createCloud',
  'workspace.createConversation',
  'workspace.setPublish',
  'workspace.setBudget',
  'connections.list',
  'connections.addApi',
  'connections.replaceKey',
  'connections.rename',
  'connections.setEnabled',
  'connections.setPreferences',
  'connections.disconnect',
  'connections.test',
  'connections.models',
  'workspace.clone',
  'workspace.setAgents',
  'workspace.setTeam',
  'workspace.changes',
  'workspace.rename',
  'workspace.remove',
  'workspace.branches',
  'workspace.checkout',
  'workspace.openFolder',

  'cloud.status',
  'cloud.connect',
  'cloud.disconnect',
  'cloud.sync',

  'verifications.list',
  'verifications.create',
  'verifications.update',
  'verifications.remove',

  'project.list',
  'project.create',
  'project.rename',
  'project.setWorkspace',
  'project.remove',

  'chat.listSessions',
  'chat.listAllSessions',
  'chat.moveSession',
  'chat.createSession',
  'chat.renameSession',
  'chat.archiveSession',
  'chat.deleteSession',
  'chat.listMessages',
  'chat.sendMessage',

  'run.get',
  'run.list',
  'run.detail',
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
  'run:activity',
  'run:message',
  'connections:changed',
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
  /** Opens at login; null where the OS offers no such setting to the app. */
  readonly startWithSystem: boolean | null;
}

export interface RuntimeStatusView {
  readonly runtimeId: RuntimeId;
  readonly displayName: string;
  /** A managed install behind the tested version; the app updates it itself. */
  readonly outdated: { readonly installed: string; readonly tested: string } | null;
  /** `managed` | `system` | `missing`. */
  readonly origin: string;
  readonly version: string | null;
  readonly ready: boolean;
  readonly canAutoConfigure: boolean;
  /** Already user-facing Portuguese; the renderer never composes these. */
  readonly detail: string;
  /** The only build is an incompatible one on the PATH; the app installs its own beside it. */
  readonly needsManaged: boolean;
  /**
   * Reasoning levels this build accepts by name, for the team form's picker;
   * null when the runtime does not take a level or its version is unknown.
   */
  readonly reasoningLevels: readonly string[] | null;
  /** Why the last install failed, step by step, until one succeeds. */
  readonly lastFailure: { readonly at: string; readonly message: string; readonly detail: string } | null;
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
  /** On `failed`: the steps that failed, safe to show under "Detalhes". */
  readonly detail?: string | null;
}

export interface InstallResultView {
  readonly ok: boolean;
  readonly runtimeId: RuntimeId;
  readonly version: string | null;
  readonly message: string;
  /** On failure: the steps that failed - source, phase, what happened. */
  readonly detail: string | null;
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
  /** On `failed`: what the provider answered (status, content type, error code), scrubbed. */
  readonly detail?: string | null;
}

/**
 * The result of opening a folder.
 *
 * `created` is false when the folder was already a project — which is the
 * ordinary case, and the one that used to be an error message.
 */
export interface OpenFolderView {
  readonly workspace: WorkspaceView;
  readonly projectId: string;
  readonly created: boolean;
}

/**
 * What the application read from a repository, as the screen shows it.
 *
 * `filesRead` is the part that matters: an analysis that names no file is an
 * analysis of the model's memory, and this path exists precisely so that it is
 * not. The content itself does not cross the bridge - it goes into the
 * supervisor's prompt in the main process, and the renderer only needs to know
 * what was read.
 */
export interface RepositoryAnalysisView {
  readonly fullName: string;
  readonly description: string | null;
  readonly primaryLanguage: string | null;
  readonly isPrivate: boolean;
  readonly defaultBranch: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly fileCount: number;
  readonly treeTruncated: boolean;
  readonly filesRead: ReadonlyArray<{ readonly path: string; readonly bytes: number; readonly truncated: boolean }>;
  readonly readAt: string;
}

export interface AgentView {
  readonly id: string;
  readonly name: string;
  /** `ORCHESTRATOR` | `CODING_WORKER`. */
  readonly role: string;
  readonly runtimeId: RuntimeId;
  readonly accountId: string | null;
}

/**
 * What each agent is, and what it is doing.
 *
 * An agent's *identity* in this application is not a credential. It is a team
 * member with a name, a role, a runtime and a connection - and two workers can
 * sit on two different connections of the same vendor without being two
 * adapters, two keys, or two of anything else. That separation is why "Claude
 * Trabalho 1" and "Claude Trabalho 2" can exist at all.
 *
 * The live half - status, current task, how long, when it last did anything -
 * is what turns a list of names into a panel worth looking at while a run is
 * going.
 */
export interface AgentStatusView {
  readonly agentId: string;
  readonly name: string;
  readonly role: string;
  readonly runtimeId: RuntimeId;
  /** The connection this agent works through. Null means "none bound yet". */
  readonly connectionId: string | null;
  readonly connectionName: string | null;
  readonly provider: ProviderName | null;
  /** `cli` (the vendor's own tool, on the person's plan) or `api` (metered). */
  readonly connectionKind: string | null;
  /**
   * Whether this agent can be used right now.
   *
   * `offline` means the connection is not signed in. It is deliberately not
   * the same as `idle`: one is a problem to fix, the other is a team member
   * waiting for work, and telling a person the wrong one wastes their time.
   */
  readonly status: 'idle' | 'running' | 'offline' | 'blocked';
  /** What it is doing, when it is doing something. */
  readonly currentTask: string | null;
  readonly currentRunId: string | null;
  /** Milliseconds since the current invocation began. */
  readonly runningForMs: number | null;
  /** When this agent last finished anything, ever. */
  readonly lastActiveAt: string | null;
  /** Delegations handed to it and not yet answered, across every run. */
  readonly awaitingReply: number;
}

/**
 * One verification a project owner has registered.
 *
 * `command` is shown so a person can see and edit what will run; it is never
 * something the interface executes, and never something an agent supplies. The
 * loop asks for a verification by `id` and runs the stored command.
 */
export interface VerificationView {
  readonly id: string;
  readonly workspaceId: string;
  readonly label: string;
  readonly command: string;
  /** A disabled verification is invisible to the loop and refused if asked for. */
  readonly enabled: boolean;
  readonly createdAt: string;
}

export type TeamRole = 'ORCHESTRATOR' | 'CODING_WORKER';

/**
 * The reasoning levels a person can pick by name. Each is validated against
 * the installed CLI before it is sent: a level the CLI does not declare is
 * replaced by the strongest one it does, and the run says so.
 */
export const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/**
 * How the worker's model is chosen for a project. Mirrors the core's
 * `WORKER_SELECTIONS` (a test keeps them equal); spelled here so the renderer
 * needs nothing from the core.
 *
 *  - `auto`     the router decides per delegation (default)
 *  - `speed`    auto, leaning one tier down when the task is plainly safe
 *  - `quality`  auto, leaning one tier up
 *  - `manual`   the model and reasoning the person typed, exactly
 */
export const WORKER_SELECTIONS = ['auto', 'speed', 'quality', 'manual'] as const;
export type WorkerSelection = (typeof WORKER_SELECTIONS)[number];

/**
 * One role of a workspace's team, resolved for display.
 *
 * Provider is fixed by the role (Codex supervises, Claude Code executes); the
 * account is one of the user's persisted accounts of that provider, named
 * here so the interface never shows a provider where an account belongs.
 */
/**
 * One worker on the team, with the id a delegation names it by.
 *
 * `workerId` is the application's own id (`worker-1`, `worker-2`), which is
 * what the orchestrator writes in a decision and what the loop validates
 * against the real team. It is never a credential and never a model.
 */
export interface TeamWorkerView extends TeamMemberView {
  readonly workerId: string;
  /** What the person calls this member. Null falls back to the account name. */
  readonly label: string | null;
}

export interface TeamMemberView {
  readonly role: TeamRole;
  readonly provider: ProviderName;
  readonly agentId: string | null;
  readonly accountId: string | null;
  /** The account's display name, e.g. "Codex Trabalho"; null when unbound. */
  readonly accountName: string | null;
  /** Null means the CLI's own default. */
  readonly model: string | null;
  readonly reasoning: ReasoningLevel | null;
  /**
   * How the model is chosen. Worker: `auto` (the router, per task), `speed`,
   * `quality` or `manual`. Orchestrator: `auto` (the Codex CLI's own default)
   * or `manual` (the pinned model and level). `model` and `reasoning` above
   * apply only under `manual`.
   */
  readonly selection: WorkerSelection;
}

export interface TeamMemberInput {
  readonly accountId: string;
  readonly model?: string;
  readonly reasoning?: ReasoningLevel;
  /** Absent means `auto`. The orchestrator accepts `auto` and `manual` only. */
  readonly selection?: WorkerSelection;
}

export interface WorkspaceView {
  readonly id: string;
  readonly name: string;
  /**
   * Where a run executes.
   *
   * `local` is a folder on this computer. `cloud` is an isolated workspace
   * provisioned elsewhere, and then there is **no folder on this computer at
   * all** - `localPath` is empty, and the interface must not offer to open it.
   * `conversation` is a project with no working copy anywhere: its runs
   * analyse, plan and review, and never touch a file. It needs no folder, no
   * repository and no server, which is what lets a person start by writing an
   * objective instead of by choosing a directory.
   */
  readonly environment: 'local' | 'cloud' | 'conversation';
  /** Empty for a cloud or conversation project. Read `environment` first. */
  readonly localPath: string;
  /** `owner/name` for a cloud project; null for a local one. */
  readonly repository: string | null;
  readonly repositoryPrivate: boolean;
  /**
   * What happens to a cloud project's work when a run ends.
   *
   * A cloud workspace is disposable, so a run that is not published produces
   * nothing - hence `enabled` defaults on. `pullRequest` defaults off: opening
   * one is an outward-facing act on somebody's repository.
   */
  readonly publish: { readonly enabled: boolean; readonly pullRequest: boolean };
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
  readonly team: {
    readonly orchestrator: TeamMemberView;
    /** Slot 0. Kept so a caller that wants one worker still gets one. */
    readonly worker: TeamMemberView;
    /** Every worker, in the order the orchestrator is offered them. */
    readonly workers: readonly TeamWorkerView[];
  };
  /** Spending limits for metered connections. Null in a field means no limit. */
  readonly budget: {
    readonly maxInvocations: number | null;
    readonly maxTokens: number | null;
    readonly maxCostUsd: number | null;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A project: the organisation of conversations. Not a folder - it may point
 * at one workspace (the folder agents work in) that its new conversations
 * inherit, or at none.
 */
export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly workspaceId: string | null;
  readonly workspaceName: string | null;
  /** Conversations filed under it, archived ones not counted. */
  readonly sessionCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChatSessionView {
  readonly id: string;
  /** The folder the agents work in for this conversation. */
  readonly workspaceId: string;
  readonly workspaceName: string | null;
  /** The project it is filed under; null is "Sem projeto". */
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly title: string;
  readonly createdAt: string;
  /** Moves whenever a message lands or the title changes; the recents order. */
  readonly updatedAt: string;
  /** Non-null while the conversation is archived (hidden, not deleted). */
  readonly archivedAt: string | null;
  readonly messageCount: number;
  /** The latest run this conversation started, when there is one. */
  readonly lastRun: { readonly id: string; readonly status: string } | null;
}

/** How a worker message's invocation was routed; shown on its agent card. */
export interface MessageRoutingView {
  readonly model: string | null;
  readonly reasoning: string | null;
  /** `auto` | `manual` | `fixed`. */
  readonly selectionMode: string;
  readonly selectionReason: string;
  readonly fallbackUsed: boolean;
}

export interface ChatMessageView {
  readonly id: string;
  readonly sessionId: string;
  /** `user` | `orchestrator` | `worker` | `system`. */
  readonly author: string;
  readonly text: string;
  readonly createdAt: string;
  readonly runId: string | null;
  /** Present on a worker message whose invocation was routed. */
  readonly routing: MessageRoutingView | null;
}

export interface RunView {
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  /**
   * `PENDING` | `RUNNING` | `DONE` | `FAILED` | `CANCELLED` | `BLOCKED`.
   *
   * `BLOCKED` is the human gate: the orchestrator stopped and asked for a
   * person. It is a real terminal state the loop already sets, and it is
   * listed here so the interface can tell it apart from a failure.
   */
  readonly status: string;
  readonly iterations: number;
  readonly summary: string | null;
  /** What the person asked for, as sent. Survives the conversation's deletion. */
  readonly objective: string;
  /**
   * Why a FAILED run failed, from the last step the loop recorded:
   * `readiness` (an account or runtime was not ready), `decision` (the
   * orchestrator answered but not with a usable decision), `cli` (the
   * orchestrator's CLI failed on its own), `limit` (the
   * iteration limit was reached), `interrupted` (the application closed),
   * `error` (an exception). Null for any other status.
   */
  readonly failureKind: RunFailureKind | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/**
 * `cli` is the orchestrator's CLI failing on its own (non-zero exit, timeout,
 * spawn error) - distinct from `decision`, where the CLI answered but not
 * with a usable decision.
 */
export type RunFailureKind = 'readiness' | 'cli' | 'decision' | 'limit' | 'interrupted' | 'error';

/** One recorded step of a run, with its diagnostics when it left any. */
export interface RunStepView {
  readonly id: number;
  readonly iteration: number;
  readonly phase: string;
  readonly status: string;
  readonly summary: string | null;
  /** Redacted JSON diagnostics (outcome, exit code, excerpts), or null. */
  readonly detail: string | null;
  readonly startedAt: string;
}

export interface RunInvocationView {
  readonly id: string;
  readonly iteration: number;
  readonly role: string;
  readonly agentId: string | null;
  readonly accountId: string | null;
  /** The worker's instruction, bounded. Null for the orchestrator. */
  readonly task: string | null;
  readonly outcome: string;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly startedAt: string;
  /** What the orchestrator asked for, as tiers; null before routing existed. */
  readonly requestedCapability: string | null;
  readonly requestedReasoning: string | null;
  /** What the CLI was given. Null means its own default. */
  readonly model: string | null;
  readonly reasoning: string | null;
  /** `auto` | `manual` | `fixed`; null before routing existed. */
  readonly selectionMode: string | null;
  readonly selectionReason: string | null;
  readonly fallbackUsed: boolean | null;
  /** Which vendor answered, and reached how. Null on rows from before this. */
  readonly providerId: string | null;
  readonly connectionKind: string | null;
  /** Which team member this was, by the id the orchestrator delegates with. */
  readonly workerId: string | null;
  /** `subscription` or `api-metered`. Null when nothing said. */
  readonly billing: string | null;
  /**
   * What this invocation consumed. Every field may be null, and null means
   * "not reported" - rendered as such, never as zero.
   */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  /** The classified provider failure, when there was one. */
  readonly failureKind: string | null;
}

export interface RunVerificationView {
  readonly iteration: number;
  readonly command: string;
  readonly exitCode: number | null;
  readonly passed: boolean;
  readonly refused: string | null;
  readonly durationMs: number | null;
}

/** Everything recorded about one run. What "Detalhes" and Evidence show. */
export interface RunDetailView {
  readonly run: RunView;
  readonly baseline: { readonly branch: string | null; readonly commit: string | null; readonly dirty: boolean };
  readonly steps: readonly RunStepView[];
  readonly invocations: readonly RunInvocationView[];
  readonly verifications: readonly RunVerificationView[];
}

/** The working copy right now, read with git. What the diff view shows. */
export interface WorkspaceChangesView {
  readonly isRepository: boolean;
  readonly branch: string | null;
  readonly head: string | null;
  readonly files: readonly { readonly path: string; readonly status: string }[];
  readonly diffStat: string;
  /** Unified diff of tracked changes plus untracked files, bounded. */
  readonly diff: string;
  readonly truncated: boolean;
}

/**
 * A switch either happened, or was held because the tree is dirty and the
 * person has not said to go ahead. A held switch is an answer, not an error:
 * the bridge carries an error's message but not its code, so the reason
 * travels as data.
 */
export type CheckoutResult =
  | { readonly switched: true; readonly workspace: WorkspaceView }
  | { readonly switched: false; readonly dirtyFiles: number; readonly message: string };

export interface GitHubStatusView {
  /** A Client ID was entered. */
  readonly configured: boolean;
  readonly clientId: string | null;
  /** The OS offers protected storage; without it no token is ever kept. */
  readonly storageAvailable: boolean;
  readonly connected: boolean;
  readonly connecting: boolean;
  readonly login: string | null;
  readonly name: string | null;
  readonly avatarUrl: string | null;
}

export interface GitHubRepositoryView {
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly private: boolean;
  readonly description: string | null;
  readonly defaultBranch: string;
  readonly htmlUrl: string;
  readonly cloneUrl: string;
  readonly updatedAt: string;
  readonly permissions: { readonly push: boolean; readonly admin: boolean };
}

/** One branch of a repository, for the cloud picker. */
export interface GitHubBranchView {
  readonly name: string;
  readonly protected: boolean;
  /** True when this is the repository's default branch. */
  readonly isDefault: boolean;
}

/**
 * Whether this computer can reach the cloud, and as whom.
 *
 * `configured` is about this application; `reachable` is about the network.
 * Keeping them apart is what lets the interface say "the work is still going,
 * this window just cannot see it" instead of "failed".
 */
export interface CloudStatusView {
  readonly configured: boolean;
  readonly reachable: boolean;
  readonly endpoint: string | null;
  /** How the coordinator names this device. Never the token. */
  readonly deviceLabel: string | null;
  readonly problem: string | null;
}

export interface PullRequestView {
  readonly number: number;
  readonly htmlUrl: string;
  readonly title: string;
  readonly state: string;
}

export interface PullRequestStatusView {
  /** `owner/repo` when the project's remote is on GitHub. */
  readonly repository: string | null;
  readonly branch: string | null;
  readonly pullRequests: readonly PullRequestView[];
  readonly checks: {
    readonly total: number;
    readonly completed: number;
    readonly success: number;
    readonly failure: number;
    readonly checks: ReadonlyArray<{
      readonly name: string;
      readonly status: string;
      readonly conclusion: string | null;
      readonly htmlUrl: string | null;
    }>;
  } | null;
}

/** What one git command did, in the words of the interface and of git. */
export interface GitOperationResult {
  readonly ok: boolean;
  readonly summary: string;
  /** git's own output, bounded and redacted, for "Detalhes". */
  readonly output: string;
  readonly workspace: WorkspaceView;
}

/** The branches git knows in this working copy. */
export interface WorkspaceBranchesView {
  readonly isRepository: boolean;
  readonly current: string | null;
  /** Local branches, by name. */
  readonly local: readonly string[];
  /** Remote-tracking branches, e.g. `origin/feature`. */
  readonly remote: readonly string[];
  /** Uncommitted changes in the working copy, as git counts them. */
  readonly dirtyFiles: number;
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
  /**
   * What actually changed, when this step collected evidence.
   *
   * Carried on the event so a **remote** run's timeline can show real files
   * and a real diffstat without the repository ever reaching this computer -
   * which is the whole point of cloud mode. A local run puts the same shape
   * here; the interface reads one thing either way.
   */
  readonly evidence?: RunEvidenceView;
  /** Which team member this step is about, so the timeline can name them. */
  readonly workerId?: string;
  readonly workerLabel?: string;
  /** What this run has consumed so far, when anything reported it. */
  readonly usage?: RunUsageView;
}

/**
 * A run's consumption, as the timeline and the history show it.
 *
 * Every field may be null, and null is rendered as "não informado" rather than
 * as zero: a run whose providers report nothing must not look free.
 */
export interface RunUsageView {
  readonly invocations: number;
  readonly tokens: number | null;
  /** Estimated US dollars for metered calls only. Plan calls contribute none. */
  readonly costUsd: number | null;
  /** Metered calls whose price this build does not know. */
  readonly unpriced: number;
}

/**
 * One connection, as the interface renders it.
 *
 * Everything here is safe to show and safe to log. There is no field that
 * could be sent to a provider as a credential, by design.
 */
export interface ConnectionView {
  readonly id: string;
  readonly displayName: string;
  readonly providerId: string;
  /** `cli` runs on the person's subscription; `api` is billed separately. */
  readonly connectionKind: 'cli' | 'api';
  readonly billing: 'subscription' | 'api-metered';
  readonly hasCredential: boolean;
  /** The last four characters of a key. Never the key. */
  readonly keyHint: string | null;
  readonly apiEnabled: boolean;
  readonly authState: string;
  readonly defaultModel: string | null;
  readonly defaultReasoning: string | null;
  readonly baseUrl: string | null;
  readonly createdAt: string;
}

/** The shape of one evidence collection, as the timeline shows it. */
export interface RunEvidenceView {
  readonly changed: boolean;
  readonly changedFiles: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
  /** `git diff --stat`, as git printed it. Truncated for the wire. */
  readonly diffstat: string;
  readonly branch: string | null;
  readonly commit: string | null;
}

/* ------------------------------------------------------------------ *
 * Request/response map. One entry per channel; both sides use it.
 * ------------------------------------------------------------------ */

export interface IpcMap {
  'app.info': { request: void; response: AppInfo };
  /** The OS login item, set by the shell; the answer is what the OS now says. */
  'app.setStartWithSystem': { request: { enabled: boolean }; response: { startWithSystem: boolean | null } };
  /**
   * Hands one http(s) URL to the system browser.
   *
   * Not a general "open" capability: the main process re-checks the scheme, so
   * a `file:` or custom-scheme URL from the renderer cannot launch anything.
   */
  'app.openExternal': { request: { url: string }; response: { opened: boolean } };

  /** The `settings` table, which the interface reads and writes as a whole. */
  'settings.all': { request: void; response: Readonly<Record<string, string>> };
  'settings.set': { request: { key: string; value: string }; response: { saved: boolean } };

  'runtime.diagnose': { request: void; response: DiagnosticView };
  'runtime.install': { request: { runtimeId: RuntimeId }; response: InstallResultView };
  'runtime.cancelInstall': { request: { runtimeId: RuntimeId }; response: { cancelled: boolean } };

  'accounts.list': { request: void; response: readonly AccountView[] };
  'accounts.create': { request: { name: string; provider: ProviderName }; response: AccountView };
  'accounts.connect': { request: { accountId: string }; response: AccountView };
  'accounts.cancelConnect': { request: { accountId: string }; response: { cancelled: boolean } };
  'accounts.status': { request: { accountId: string }; response: AccountView };
  'accounts.remove': { request: { accountId: string }; response: { removed: boolean } };

  /**
   * GitHub, one login for the application, by OAuth device flow.
   *
   * The token never crosses this boundary: what the renderer gets is who is
   * signed in. Progress goes out on `account:progress` with the id `github`.
   */
  'github.status': { request: void; response: GitHubStatusView };
  'github.configure': { request: { clientId: string }; response: GitHubStatusView };
  'github.connect': { request: void; response: GitHubStatusView };
  'github.cancelConnect': { request: void; response: { cancelled: boolean } };
  'github.disconnect': { request: void; response: GitHubStatusView };
  'github.repositories': { request: void; response: readonly GitHubRepositoryView[] };
  'github.branches': {
    request: { repository: string };
    response: readonly GitHubBranchView[];
  };
  'github.pullRequestStatus': { request: { workspaceId: string }; response: PullRequestStatusView };
  'github.createPullRequest': {
    request: { workspaceId: string; title: string; body?: string; base?: string };
    response: PullRequestView;
  };

  /** Git, on the project, with the GitHub login when the remote is github.com. */
  'workspace.fetch': { request: { workspaceId: string }; response: GitOperationResult };
  'workspace.createBranch': { request: { workspaceId: string; name: string }; response: GitOperationResult };
  'workspace.commit': { request: { workspaceId: string; message: string }; response: GitOperationResult };
  'workspace.push': { request: { workspaceId: string }; response: GitOperationResult };

  'agents.list': { request: void; response: readonly AgentView[] };
  'agents.status': { request: void; response: readonly AgentStatusView[] };

  /**
   * Reads a public GitHub repository so it can be analysed.
   *
   * Read-only and remote: nothing is cloned, nothing is written, and no write
   * scope is asked for. A public repository needs no login.
   */
  'repository.analyse': { request: { url: string }; response: RepositoryAnalysisView };

  'workspace.list': { request: void; response: readonly WorkspaceView[] };
  'workspace.selectFolder': { request: void; response: { path: string | null } };
  /**
   * Opens the project for a folder, creating it only if there is none.
   *
   * One call, because "find or create" is one decision and splitting it
   * across two round trips is how the interface ended up creating a second
   * project for a folder it already had.
   */
  'workspace.openProject': {
    request: { localPath: string };
    response: OpenFolderView;
  };
  'workspace.create': {
    request: { name: string; localPath: string; repositoryUrl?: string; defaultBranch?: string };
    response: WorkspaceView;
  };
  'workspace.createCloud': {
    request: {
      repository: string;
      branch: string;
      name?: string;
      repositoryPrivate?: boolean;
      endpoint?: string | null;
    };
    response: WorkspaceView;
  };
  /** A project with no folder, no repository and no server. */
  'workspace.createConversation': {
    request: { name: string };
    response: WorkspaceView;
  };
  'workspace.setPublish': {
    request: { workspaceId: string; enabled: boolean; pullRequest: boolean };
    response: WorkspaceView;
  };
  /**
   * Spending limits for this project's metered connections.
   *
   * A null field means no limit. These stop the application from making the
   * next call; they are not a ceiling the provider enforces.
   */
  'workspace.setBudget': {
    request: {
      workspaceId: string;
      maxInvocations: number | null;
      maxTokens: number | null;
      maxCostUsd: number | null;
    };
    response: WorkspaceView;
  };

  /**
   * Connections.
   *
   * No channel here ever carries a credential *out*. `addApi` and
   * `replaceKey` take one in, once; everything that comes back is metadata
   * plus a four-character hint. There is deliberately no "read the key"
   * channel, so the renderer cannot hold one even if it wanted to.
   */
  'connections.list': { request: void; response: ConnectionView[] };
  'connections.addApi': {
    request: {
      providerId: 'anthropic' | 'openai';
      displayName: string;
      apiKey: string;
      baseUrl?: string | null;
    };
    response: ConnectionView;
  };
  'connections.replaceKey': {
    request: { connectionId: string; apiKey: string };
    response: ConnectionView;
  };
  'connections.rename': {
    request: { connectionId: string; displayName: string };
    response: ConnectionView;
  };
  /** Turns a metered connection on. Nothing is ever sent by a disabled one. */
  'connections.setEnabled': {
    request: { connectionId: string; enabled: boolean };
    response: ConnectionView;
  };
  'connections.setPreferences': {
    request: { connectionId: string; model: string | null; reasoning: string | null };
    response: ConnectionView;
  };
  /** Forgets the credential on this computer. The connection itself stays. */
  'connections.disconnect': { request: { connectionId: string }; response: ConnectionView };
  'connections.test': {
    request: { connectionId: string };
    response: {
      authenticated: boolean;
      method?: string;
      problem?: string;
      remedy?: string;
      checkedAt: string;
    };
  };
  /** The models this connection's account really has, asked of the provider. */
  'connections.models': {
    request: { connectionId: string };
    response: Array<{ id: string; displayName: string; createdAt?: string | null }>;
  };
  'workspace.clone': {
    request: { repositoryUrl: string; parentPath: string; name: string };
    response: WorkspaceView;
  };
  'workspace.setAgents': {
    request: { workspaceId: string; orchestratorAgentId: string; workerAgentId: string };
    response: WorkspaceView;
  };
  /**
   * Binds the team by *account*: the orchestrator to an OpenAI account, the
   * worker to an Anthropic one, each with an optional model and reasoning
   * level. An account of the wrong provider is refused.
   */
  'workspace.setTeam': {
    request: {
      workspaceId: string;
      orchestrator: TeamMemberInput;
      /** Slot 0, kept for callers that bind a single worker. */
      worker: TeamMemberInput;
      /**
       * The full worker list, when the team has more than one. When present it
       * replaces `worker`; when absent the team is just `worker`, which is
       * what every project had before teams could grow.
       */
      workers?: readonly TeamMemberInput[];
    };
    response: WorkspaceView;
  };
  /** Read-only: what changed in the working copy, straight from git. */
  'workspace.changes': { request: { workspaceId: string }; response: WorkspaceChangesView };
  'workspace.rename': { request: { workspaceId: string; name: string }; response: WorkspaceView };
  /** Removes the project from the list. The folder on disk is never touched. */
  'workspace.remove': { request: { workspaceId: string }; response: { removed: boolean } };
  'workspace.branches': { request: { workspaceId: string }; response: WorkspaceBranchesView };
  /**
   * Switches the working copy to a branch. With a dirty tree the call is
   * refused (code DIRTY_TREE) unless `allowDirty` is set, and git itself still
   * refuses a switch that would overwrite a change.
   */
  'workspace.checkout': {
    request: { workspaceId: string; branch: string; allowDirty?: boolean };
    response: CheckoutResult;
  };
  /** Opens the project folder in the system file manager. */
  'workspace.openFolder': { request: { workspaceId: string }; response: { opened: boolean } };

  /**
   * The verifications of one project: read, add, change, remove.
   *
   * Domain operations over `verification_definitions`, not a way to run
   * anything. Nothing here executes a command: the loop resolves an id to the
   * stored command when a run asks for it.
   */
  'cloud.status': { request: void; response: CloudStatusView };
  'cloud.connect': {
    /** The coordinator and the device token a person pasted from it. */
    request: { endpoint: string; token: string };
    response: CloudStatusView;
  };
  'cloud.disconnect': { request: void; response: CloudStatusView };
  /** Catches every unfinished cloud run up. Returns how many events applied. */
  'cloud.sync': { request: void; response: { applied: number } };

  'verifications.list': {
    request: { workspaceId: string };
    response: readonly VerificationView[];
  };
  'verifications.create': {
    request: { workspaceId: string; id: string; label: string; command: string };
    response: VerificationView;
  };
  'verifications.update': {
    request: {
      workspaceId: string;
      id: string;
      label?: string;
      command?: string;
      enabled?: boolean;
    };
    response: VerificationView;
  };
  'verifications.remove': {
    request: { workspaceId: string; id: string };
    response: { removed: boolean };
  };

  /**
   * Conversations of one project, newest activity first. Archived ones are
   * left out unless asked for; `query` narrows by title.
   */
  'chat.listSessions': {
    request: { workspaceId: string; includeArchived?: boolean; query?: string };
    response: readonly ChatSessionView[];
  };
  /**
   * Every conversation of every workspace, for the project tree; `query`
   * searches across projects and each row says which project it is in.
   */
  'chat.listAllSessions': {
    request: { includeArchived?: boolean; query?: string };
    response: readonly ChatSessionView[];
  };
  /** Files a conversation under a project (`null` = "Sem projeto"). Persisted. */
  'chat.moveSession': {
    request: { sessionId: string; projectId: string | null };
    response: ChatSessionView;
  };
  'chat.createSession': {
    request: { workspaceId: string; title: string; projectId?: string | null };
    response: ChatSessionView;
  };

  'project.list': { request: void; response: readonly ProjectView[] };
  'project.create': { request: { name: string; workspaceId?: string | null }; response: ProjectView };
  'project.rename': { request: { projectId: string; name: string }; response: ProjectView };
  'project.setWorkspace': { request: { projectId: string; workspaceId: string | null }; response: ProjectView };
  /**
   * Forgets the project. Its conversations are kept and move to "Sem
   * projeto"; no workspace, repository or file is touched.
   */
  'project.remove': { request: { projectId: string }; response: { removed: boolean; sessionsMoved: number } };
  'chat.renameSession': { request: { sessionId: string; title: string }; response: ChatSessionView };
  /** Hides or brings back a conversation. Nothing is deleted either way. */
  'chat.archiveSession': {
    request: { sessionId: string; archived: boolean };
    response: ChatSessionView;
  };
  /**
   * Removes the conversation and its messages for good. Runs it started are
   * kept in the execution history, with their evidence; files in the project
   * are never touched. Refused while one of its runs is still going.
   */
  'chat.deleteSession': { request: { sessionId: string }; response: { deleted: boolean } };
  'chat.listMessages': { request: { sessionId: string }; response: readonly ChatMessageView[] };
  'chat.sendMessage': {
    request: { sessionId: string; text: string };
    response: { message: ChatMessageView; run: RunView };
  };

  'run.get': { request: { runId: string }; response: RunView };
  /** Every run of a project, newest first - the execution history. */
  'run.list': { request: { workspaceId: string }; response: readonly RunView[] };
  'run.detail': { request: { runId: string }; response: RunDetailView };
  'run.cancel': { request: { runId: string }; response: { cancelled: boolean } };
}

export interface EventMap {
  'runtime:progress': RuntimeProgressEvent;
  'account:progress': AccountProgressEvent;
  'run:progress': RunProgressEvent;
  /**
   * Liveness, while an agent works. The ephemeral channel.
   *
   * Deliberately not persisted: one row per heartbeat would bloat the history
   * and tell a later reader nothing the timeline does not already show. What
   * *is* kept is the summary on the invocation, and the durable exchange in
   * `agent_messages`.
   */
  'run:activity': RunActivityEvent;
  /** A message between agents changed state. The durable channel. */
  'run:message': AgentMessageEvent;
  /** A connection was added, renamed, enabled, or had its credential changed. */
  'connections:changed': ConnectionsChangedEvent;
}

/**
 * What an agent is doing right now.
 *
 * This event is the answer to the window that used to say "executando
 * automaticamente" and nothing more. It carries the two numbers a person needs
 * to decide whether to keep waiting - how long it has been running, and how
 * long since it last did anything - plus the tool it is inside when the
 * runtime says so.
 */
export interface RunActivityEvent {
  readonly runId: string;
  readonly sessionId: string;
  /** The team member this is about. */
  readonly agentId: string;
  readonly agentLabel: string;
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly lastActivityAt: string;
  readonly idleMs: number;
  /** The tool in flight, when the runtime reports one. Never its arguments. */
  readonly currentTool: string | null;
  /** How long silence may last before this invocation is stopped, if capped. */
  readonly idleTimeoutMs: number | null;
  /** A ready-made sentence, e.g. "executando há 4m · ferramenta: Write". */
  readonly label: string;
}

/**
 * A message between agents, as the timeline shows it.
 *
 * Carries no payload: the body of a delegation or a report is already a chat
 * message, and duplicating it here would mean two places to keep in step. What
 * this adds is the delivery fact - was it accepted, delivered, started,
 * finished, or abandoned - which nothing else records.
 */
export interface AgentMessageEvent {
  readonly runId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly messageType: string;
  readonly status: string;
  readonly senderAgentId: string | null;
  readonly recipientAgentId: string | null;
  readonly iteration: number;
  readonly attempts: number;
  /** Why it failed or was abandoned, in words. Null while nothing is wrong. */
  readonly failureReason: string | null;
  readonly at: string;
}

/**
 * Something about a connection changed.
 *
 * Deliberately carries only an id: the renderer re-reads the list through IPC,
 * so no credential, hint or state can travel on an event by accident.
 */
export interface ConnectionsChangedEvent {
  readonly connectionId: string;
}

/** Every response crosses the bridge wrapped, so a rejection is data. */
export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
