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

  'workspace.list',
  'workspace.selectFolder',
  'workspace.create',
  'workspace.createCloud',
  'workspace.setPublish',
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

export interface AgentView {
  readonly id: string;
  readonly name: string;
  /** `ORCHESTRATOR` | `CODING_WORKER`. */
  readonly role: string;
  readonly runtimeId: RuntimeId;
  readonly accountId: string | null;
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
   */
  readonly environment: 'local' | 'cloud';
  /** Empty for a cloud project. Read `environment` before this. */
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
    readonly worker: TeamMemberView;
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

  'workspace.list': { request: void; response: readonly WorkspaceView[] };
  'workspace.selectFolder': { request: void; response: { path: string | null } };
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
  'workspace.setPublish': {
    request: { workspaceId: string; enabled: boolean; pullRequest: boolean };
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
  /**
   * Binds the team by *account*: the orchestrator to an OpenAI account, the
   * worker to an Anthropic one, each with an optional model and reasoning
   * level. An account of the wrong provider is refused.
   */
  'workspace.setTeam': {
    request: { workspaceId: string; orchestrator: TeamMemberInput; worker: TeamMemberInput };
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
}

/** Every response crosses the bridge wrapped, so a rejection is data. */
export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
