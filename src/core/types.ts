/**
 * Shared domain types for the Local Agent Orchestrator.
 *
 * Nothing in here is specific to Codex or to Claude Code: agent-specific
 * details live behind the `AgentRunner` implementations (see `src/agents`).
 */

/** Which role an agent plays in a run. */
export type AgentRole = 'orchestrator' | 'worker';

/**
 * Stable identifiers for the agents this application knows about.
 *
 * The `-api` kinds are the same two vendors reached over their HTTP APIs
 * instead of their CLIs. They are separate kinds because who pays is
 * different, and that difference is recorded on every invocation.
 */
export type AgentKind =
  | 'codex'
  | 'claude-code'
  | 'openai-api'
  | 'anthropic-api'
  | 'mock-codex'
  | 'mock-claude';

/**
 * Who pays for an invocation.
 *
 * `subscription` is the person's existing plan, reached through the vendor's
 * official tool. `api-metered` is a separate per-token bill. The two are never
 * conflated and one never silently becomes the other.
 */
export type BillingModel = 'subscription' | 'api-metered' | 'unknown';

/**
 * A provider failure the loop can act on, rather than a string it must guess at.
 *
 * The distinction carries money: `insufficient-credit` must never be retried in
 * a loop, and `rate-limit` must never be answered by escalating to a costlier
 * model.
 */
export type ProviderFailureKind =
  | 'authentication'
  | 'permission'
  | 'insufficient-credit'
  | 'rate-limit'
  | 'timeout'
  | 'network'
  | 'invalid-request'
  | 'model-unavailable'
  | 'schema'
  | 'provider-error'
  | 'cancelled'
  | 'budget-exceeded'
  /**
   * A tool the worker needed was refused.
   *
   * Distinct from `permission`, which is about the *credential* not being
   * allowed to call the provider. This one is the agent being allowed to run
   * and then told it may not write the file - and a stronger model cannot fix
   * it, so the loop must not escalate on it.
   */
  | 'tool-permission-denied'
  /** The run needed a person to approve something, and nobody could. */
  | 'approval-required'
  /** The agent ran and produced nothing at all to act on. */
  | 'empty-response'
  /** The workspace could not be used: missing, not a folder, not writable. */
  | 'workspace-invalid'
  /** The program could not observe the workspace, so it cannot say what changed. */
  | 'evidence-unavailable'
  /**
   * The agent was alive but produced nothing for long enough to call it stuck.
   *
   * Distinct from `timeout`, which is "this took longer than allowed". This one
   * is "nothing happened at all", and it is the one the person actually hit:
   * the window sat on "executando automaticamente" because silence had no name.
   */
  | 'no-activity';

/**
 * What one invocation consumed.
 *
 * `costUsd` is null whenever it cannot be known - a subscription invocation, or
 * a model no price table covers. A null is rendered as "não informado", never
 * as zero: a run that spent something unknown must not look free.
 */
export interface InvocationUsage {
  billing: BillingModel;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  /** True when the provider reported the cost rather than a price table. */
  costReported?: boolean;
}

/** The four decisions the orchestrator agent is allowed to return (spec 10). */
export type DecisionAction = 'delegate' | 'verify' | 'done' | 'blocked';

/** A single acceptance criterion tracked across the whole run. */
export interface AcceptanceCriterion {
  /** Stable id derived from the text, so repeats across iterations collapse. */
  id: string;
  text: string;
  /** `unknown` until some evidence has been recorded for it. */
  status: 'unknown' | 'satisfied' | 'failed';
  /** Iteration number that last changed this criterion's status. */
  lastUpdatedIteration: number;
  /** Free-text note explaining the current status (redacted before persisting). */
  note?: string;
}

import type {
  FileCheckRequest,
  FileCheckResult,
  FileReadRequest,
  FileReadResult,
} from '../verification/file-check.js';
import type { WorkerReport } from '../worker/worker-report.js';
import type { CapabilityTier, ReasoningTier, WorkerRequirements } from '../routing/tiers.js';

/** A decision returned by the orchestrator agent, after validation. */
export interface Decision {
  action: DecisionAction;
  /** Present (and required) when `action === 'delegate'`. */
  task?: string;
  /** Criteria the orchestrator wants satisfied. May be empty. */
  acceptanceCriteria: string[];
  /** Commands the orchestrator wants run independently after the worker. */
  verificationCommands: string[];
  /**
   * Files the application should read and compare for itself.
   *
   * A *typed comparison*, never a command: the main process opens the path,
   * reads the bytes and compares them. It exists so a workspace with no
   * registered verification can still prove "this file contains exactly these
   * bytes" - which is most of what a small task is - without anybody first
   * registering a shell command for it.
   *
   * Each entry names the acceptance criteria it proves, so a result settles
   * what it actually demonstrates and nothing else.
   */
  fileChecks: FileCheckRequest[];
  /**
   * A request for the repository's file paths.
   *
   * The gap this closes: in a project that works directly on GitHub there is
   * no folder to look in, and `fileReads` needs a path the supervisor has no
   * way to learn. It was told to read files and given no way to find out what
   * files there are - so it delegated the search to a worker whose working
   * directory is deliberately empty, the worker correctly said so, and the run
   * ended in human review over a listing the application could have fetched.
   *
   * Null when nothing is being asked for.
   */
  listFiles?: {
    readonly prefix?: string | null;
    readonly contains?: string | null;
    readonly limit?: number | null;
  } | null;
  /**
   * Files the supervisor wants to *see*.
   *
   * The application opens them and puts a bounded excerpt, the size and the
   * hash in front of the supervisor. It exists because the supervisor was
   * asking the worker to copy whole files into the chat - answers came back
   * truncated, the criteria stayed pending, and the run went round again for
   * something the application could read for itself.
   *
   * Reading is not proof of anything: a read shows content, a check settles a
   * criterion, and they are separate fields for that reason.
   */
  fileReads: FileReadRequest[];
  /** Optional human-readable rationale. Never model reasoning; a one-liner. */
  summary?: string;
  /** Present (and required) when `action === 'blocked'`. */
  reason?: string;
  /** Files the orchestrator considers relevant for the worker. */
  relevantFiles?: string[];
  /**
   * What the coding worker needs for this task, in capability tiers - never
   * a model name. Absent on decisions from before this field existed; the
   * router then falls back to BALANCED/MEDIUM.
   */
  workerRequirements?: WorkerRequirements;
  /**
   * Which team member this delegation is for.
   *
   * Names a worker the team actually has. The application validates it - a
   * decision naming a worker that does not exist is answered with a structured
   * error listing the real ones, never silently redirected to some other
   * connection. Absent means the team's first worker, which is what every
   * single-worker project gets and what every decision written before this
   * field existed means.
   */
  workerId?: string;
  /**
   * Whether this delegation needs to change files.
   *
   * The orchestrator says what the task needs; the application decides whether
   * the chosen worker can supply it. A worker whose provider declares
   * `toolExecution: false` is refused this delegation with a reason, rather
   * than being asked to describe an edit it cannot make.
   */
  requiresTools?: boolean;
  /**
   * Criteria the orchestrator judged satisfied when it reviewed the answer.
   *
   * Only meaningful in a conversation run, where there is no command to run
   * and the orchestrator's independent review *is* the check. It is still not
   * self-certification: the worker cannot write this field, because only the
   * orchestrator produces decisions, and the DONE gate re-reads the ledger
   * afterwards. In a coding run this is ignored - there, evidence decides.
   */
  satisfiedCriteria?: string[];
}

/** The model and reasoning resolved for one invocation, as the CLI takes them. */
export interface InvocationRouting {
  model: string | null;
  reasoning: string | null;
}

/**
 * How an invocation's model and reasoning were chosen. Persisted with the
 * invocation, shown in the timeline and the run's details.
 */
export interface RoutingRecord {
  requestedCapability: CapabilityTier | null;
  requestedReasoning: ReasoningTier | null;
  resolvedModel: string | null;
  resolvedReasoning: string | null;
  /** `auto` (router), `manual` (the person's override), `fixed` (the orchestrator's own config). */
  selectionMode: 'auto' | 'manual' | 'fixed';
  selectionReason: string;
  fallbackUsed: boolean;
}

/** Input handed to an `AgentRunner`. */
export interface AgentInput {
  /**
   * The full prompt. It is delivered to the child process over **stdin**, never
   * interpolated into a shell string (spec 40).
   */
  prompt: string;
  /** Absolute path the agent should treat as its working directory. */
  workingDirectory: string;
  /** Hard timeout for this invocation. */
  timeoutMs: number;
  /**
   * How long this invocation may produce nothing before it is stopped.
   *
   * Separate from `timeoutMs` on purpose. A large refactor legitimately takes
   * a long time; no healthy agent goes silent for ten minutes. Conflating the
   * two is what let a hung child look exactly like a busy one.
   *
   * Omitted means the adapter's default; 0 disables it.
   */
  idleTimeoutMs?: number;
  /**
   * Called as the agent does things, for the interface to show.
   *
   * Ephemeral by design: this is the streaming channel, not the durable one.
   * Nothing on it is a record of what happened - that is what the message bus
   * and the invocation row are for.
   */
  onActivity?: (snapshot: import('../agents/activity-monitor.js').ActivitySnapshot) => void;
  /** Run/iteration labels, used only for logging and artifact naming. */
  runId: string;
  iteration: number;
  /** Extra environment for the child process (e.g. CLAUDE_CONFIG_DIR). */
  env?: Record<string, string | undefined>;
  /** Model and reasoning for this invocation; absent means the adapter's defaults. */
  routing?: InvocationRouting;
  /**
   * The provider-side session this invocation should continue.
   *
   * Only meaningful for a runner whose tool supports it - `claude -p --resume
   * <session-id>` is the documented case. Absent means a fresh session, which
   * is what every invocation was before this field existed.
   */
  resumeSessionId?: string | null;
}

/** How an agent invocation ended. */
export type AgentOutcome = 'completed' | 'timeout' | 'cancelled' | 'spawn-error';

/** Result of an `AgentRunner.run` call. */
export interface AgentResult {
  outcome: AgentOutcome;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  /** True when stdout/stderr were truncated because of the capture cap. */
  truncated: boolean;
  /**
   * The tool's own words for why it failed, when it gave any.
   *
   * `failure` is this application's classification, and it is coarse on
   * purpose - the loop branches on a handful of kinds. This is the raw thing
   * underneath it: `error_during_execution`, `error_max_turns`, an exit
   * message, whatever the CLI actually said.
   *
   * It exists because the classification was swallowing the cause. Every
   * envelope reporting an error became `provider-error`, which renders as
   * "erro do provider" - true, useless, and indistinguishable from a dozen
   * different real problems. The classification decides what the loop does;
   * this decides what a person reads.
   */
  failureDetail?: string;
  /**
   * The version of the tool that ran, as it reported it.
   *
   * Absent when the tool could not be asked. Never guessed: "não informado" is
   * a real answer and a fabricated version number is not.
   */
  version?: string;
  /**
   * What the agent was observed doing, and when it last did anything.
   *
   * Present only for adapters that can see inside a turn. Absent is a real
   * answer - "this runtime does not report progress" - and is never rendered
   * as "idle", which would be a claim the application cannot support.
   */
  activity?: import('../agents/activity-monitor.js').ActivitySnapshot;
  /** Human-readable failure description when `outcome !== 'completed'`. */
  error?: string;
  /** The executable that ran, so a failure names the binary it came from. */
  executable?: string;
  /**
   * What the adapter actually sent for model and reasoning, after checking
   * them against the CLI - with a note when it had to change something.
   */
  applied?: InvocationRouting & { fallbackUsed: boolean; note: string | null };
  /** Tokens and estimated cost, when the provider reports them. */
  usage?: InvocationUsage;
  /**
   * Why a provider invocation failed, classified. Absent for a CLI adapter and
   * for any successful call. The loop reads this to decide whether trying
   * again could possibly help - and to stop dead on `insufficient-credit`.
   */
  failure?: ProviderFailureKind;
  /** Seconds the provider asked us to wait, from its `retry-after`. */
  retryAfterSeconds?: number;
  /**
   * Tools the agent asked for and was refused, as the tool itself reported.
   *
   * The concrete answer to "why did nothing change?", which is otherwise
   * unavailable to anyone: the agent knows, and this is where it says so.
   */
  permissionDenials?: readonly string[];
  /**
   * What was actually refused, with the detail a person needs to decide.
   *
   * Separate from `permissionDenials`, which is the list of tool *names* every
   * existing caller already reads. This carries the exact command and the
   * arguments where the CLI reported them - a name alone cannot be approved,
   * because "approve PowerShell" is not a decision anybody should be asked to
   * make. A field the CLI did not report is absent, never invented.
   */
  deniedCalls?: readonly DeniedToolCall[];
  /**
   * The `--allowedTools` rules this invocation actually carried.
   *
   * Authorisation proven at the runtime rather than in the database. A person
   * approved an operation, the row said `approved`, and the next call was
   * refused anyway - twice over: the rules were never passed to the CLI at
   * all, and the one that would have been passed used a syntax the CLI does
   * not match. Neither was visible from the grant row, which said the same
   * thing in both cases. This is what was on the command line.
   *
   * Absent for an adapter that has no such flag; empty is a real answer.
   */
  authorisedTools?: readonly string[];
  /**
   * The provider's own id for the session this invocation ran in.
   *
   * Recorded so the next delegation to the *same* connection can continue it.
   * Never shared between connections: two accounts' sessions live in two
   * config directories and are two different rows.
   */
  sessionId?: string;
}

/** Health of an agent CLI, produced by `AgentRunner.healthCheck`. */
export interface HealthStatus {
  healthy: boolean;
  /** Resolved executable path, when it could be located. */
  executable?: string;
  version?: string;
  /** Why the agent is unhealthy. Present only when `healthy === false`. */
  problem?: string;
  /** Actionable hint shown to the user alongside `problem`. */
  hint?: string;
}

/** Result of one independently executed verification command (spec 13). */
export interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Set when the command was refused by the git-safety screen (spec 33). */
  refused?: string;
  timedOut: boolean;
}

/**
 * How the program was able to observe the workspace.
 *
 * The distinction this exists to make: "nothing changed" and "I could not
 * look" are completely different answers, and conflating them is how a run
 * that really did the work gets reported as having done nothing. Every
 * evidence collection says which one it is.
 */
export type EvidenceSource =
  /** A git repository, read with git. The richest answer. */
  | 'git'
  /** No repository here, so the filesystem was walked instead. */
  | 'filesystem'
  /** Nothing could be observed. `evidenceProblem` says why. */
  | 'none';

/** Snapshot of the project's git state before anything runs (spec 9). */
export interface Baseline {
  capturedAt: string;
  isGitRepository: boolean;
  commit: string | null;
  branch: string | null;
  /** Raw `git status --short` output. */
  statusShort: string;
  /** Raw `git diff` at baseline time. */
  unstagedDiff: string;
  /** Raw `git diff --cached` at baseline time. */
  stagedDiff: string;
  modifiedFiles: string[];
  stagedFiles: string[];
  /** True when the user already had uncommitted work before the run. */
  dirty: boolean;
  /** How this snapshot was taken. */
  source?: EvidenceSource;
  /**
   * Why git could not be used, when it could not.
   *
   * Set when the git executable itself failed to run - which is a different
   * thing from the folder not being a repository, and must never be reported
   * as "no changes".
   */
  evidenceProblem?: string | null;
  /** The filesystem snapshot, when `source` is `filesystem`. */
  files?: FileSnapshot | null;
}

/**
 * The workspace as a plain list of files, for a project that is not a git
 * repository - or where git could not run.
 *
 * Bounded on purpose: a workspace can contain a node_modules with a hundred
 * thousand files, and walking it on every iteration would cost more than the
 * run. What matters is being able to say "this path appeared and it contains
 * these bytes", which a bounded walk answers.
 */
export interface FileSnapshot {
  /** Relative path to size-and-digest, for every file the walk covered. */
  entries: Record<string, string>;
  /** True when the walk stopped at its limit, so absence proves nothing. */
  truncated: boolean;
  /** Directories skipped by name, so a reader knows what was not looked at. */
  skipped: readonly string[];
}

/** Git evidence collected independently after a worker runs (spec 12). */
export interface GitEvidence {
  collectedAt: string;
  isGitRepository: boolean;
  commit: string | null;
  branch: string | null;
  statusShort: string;
  diff: string;
  diffStat: string;
  changedFiles: string[];
  /** Files that exist now but did not at baseline (untracked additions). */
  addedFiles: string[];
  /** Files tracked at baseline that are now deleted. */
  deletedFiles: string[];
  /** True when the working tree changed relative to the baseline. */
  changedSinceBaseline: boolean;
  /** How this evidence was gathered. */
  source?: EvidenceSource;
  /**
   * Why nothing could be observed, when nothing could.
   *
   * Present only with `source: 'none'`. The loop puts this in front of the
   * orchestrator verbatim, because "I could not look" is a fact it must act
   * on differently from "nothing changed".
   */
  evidenceProblem?: string | null;
  files?: FileSnapshot | null;
}

/** Everything recorded about a single orchestration iteration. */
export interface IterationRecord {
  iteration: number;
  startedAt: string;
  finishedAt?: string;
  /** The validated decision, when one was obtained. */
  decision?: Decision;
  /** Set when the orchestrator's output could not be parsed (spec 10). */
  decisionError?: string;
  /** How many format-repair round trips were needed. */
  decisionRepairAttempts: number;
  worker?: WorkerRecord;
  evidence?: GitEvidence;
  verification?: CommandResult[];
  /** Populated when the iteration proposed `done` and the gate rejected it. */
  doneRejection?: DoneGateResult;
  /** Files the application read and compared for itself in this iteration. */
  fileChecks?: readonly FileCheckResult[];
  /** Files the application opened and showed to the supervisor. */
  fileReads?: readonly FileReadResult[];
  /** The normalised account of what the worker did, and what was measured. */
  workerReport?: WorkerReport;
  notes: string[];
}

/** Per-task worker bookkeeping (spec 27). Credentials are never recorded. */
export interface WorkerRecord {
  agent: AgentKind;
  /** Claude Code profile id, when the worker is Claude Code. */
  profile: string | null;
  task: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  outcome: AgentOutcome;
  durationMs: number;
  /** How the model was chosen for this attempt. */
  routing?: RoutingRecord;
  /** The tree changed relative to the previous attempt's evidence. */
  progressed?: boolean;
  /** A failure a better model would not fix (missing binary, login, quota). */
  mechanical?: boolean;
  /** The CLI refused the model by name. */
  modelUnavailable?: boolean;
  /** What this attempt consumed, when the provider says. */
  usage?: InvocationUsage;
  /** The classified provider failure, when the attempt failed on one. */
  failure?: ProviderFailureKind;
  /** Tools this attempt was refused, as the worker's own tool reported them. */
  deniedTools?: readonly string[];
  /**
   * The same refusals with the command attached, when the provider named one.
   *
   * This is what an approval dialog is built from. A tool name alone is not a
   * decision a person can make: "allow PowerShell" is a different question
   * from "allow `Set-Content .\hello.txt`", and only the second one is the
   * scope somebody should be asked to authorise.
   */
  deniedCalls?: readonly DeniedToolCall[];
  /** The invocation row this attempt was recorded as, so a report can bind to it. */
  invocationId?: string;
  /** The CLI's own session id, when it reported one. */
  sessionId?: string;
  /** The tool's own account of the failure, in its words. */
  failureDetail?: string;
  /** Tools the runtime observed the worker inside, oldest first. */
  tools?: readonly string[];
}

/** Outcome of the independent DONE validation (spec 15). */
export interface DoneGateResult {
  passed: boolean;
  /** Exact list of what failed, sent back to the orchestrator verbatim. */
  failures: string[];
  checkedAt: string;
  verification: CommandResult[];
  /** Files the gate re-read for itself, when the run asked for any. */
  fileChecks?: readonly FileCheckResult[];
}

/** A worker slot. The MVP runs `workers[0]`; the array keeps spec 23 open. */
export interface WorkerSpec {
  id: string;
  agent: AgentKind;
  /** Claude Code profile id. `null` for agents without profiles. */
  profile: string | null;
}

/**
 * One tool call a provider refused, as far as the provider described it.
 *
 * Every field but `toolName` is optional because the shape of a denial is not
 * fully documented: the reader takes what is there and leaves the rest absent,
 * so the interface can say "não informado" instead of showing a guess.
 */
export interface DeniedToolCall {
  readonly toolName: string;
  /** The provider's own id for the call, when it gave one. */
  readonly toolUseId?: string;
  /** The exact command, for a shell tool that reported one. */
  readonly command?: string;
  /** The remaining arguments, as JSON text. Redacted and capped by the caller. */
  readonly arguments?: string;
  /**
   * The agent's own one-line description of what it was trying to do.
   *
   * Claude Code sends this alongside a Bash command - "Create hello.txt with
   * content 'pronto' via node" - and it is the single most useful line in an
   * approval dialog: the command says *what*, this says *why*. Absent when the
   * provider did not send one.
   */
  readonly description?: string;
}
