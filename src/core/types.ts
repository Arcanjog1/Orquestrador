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
  | 'budget-exceeded';

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
  /** Run/iteration labels, used only for logging and artifact naming. */
  runId: string;
  iteration: number;
  /** Extra environment for the child process (e.g. CLAUDE_CONFIG_DIR). */
  env?: Record<string, string | undefined>;
  /** Model and reasoning for this invocation; absent means the adapter's defaults. */
  routing?: InvocationRouting;
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
}

/** Outcome of the independent DONE validation (spec 15). */
export interface DoneGateResult {
  passed: boolean;
  /** Exact list of what failed, sent back to the orchestrator verbatim. */
  failures: string[];
  checkedAt: string;
  verification: CommandResult[];
}

/** A worker slot. The MVP runs `workers[0]`; the array keeps spec 23 open. */
export interface WorkerSpec {
  id: string;
  agent: AgentKind;
  /** Claude Code profile id. `null` for agents without profiles. */
  profile: string | null;
}
