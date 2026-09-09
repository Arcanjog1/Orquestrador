import { roleDefinition, type TaskKind } from '../../shared/agent-policy.js';
import { agentConfig, AgentService } from './agent-service.js';
import { AgentExecutionPolicy } from './agent-execution-policy.js';
import { capabilityRank, reasoningRank } from '../../../../../src/routing/tiers.js';
import { orchestratorSelectionOf } from './workspace-service.js';
/**
 * The orchestration loop.
 *
 * ```
 * USER MESSAGE → RUN → BASELINE → CODEX → DECISION → CLAUDE CODE
 *   → EVIDENCE → VERIFICATION → CODEX REVIEW → DONE or a new delegation
 * ```
 *
 * Three rules are load-bearing and are enforced here rather than trusted to the
 * agents:
 *
 *  1. **The orchestrator requests a verification by id, never by command.**
 *     Ids are resolved against `verification_definitions`, which only a human
 *     writes to. An unknown id is reported back as a failure; it is never run.
 *  2. **`done` is a request, not a conclusion.** `evaluateDone` re-runs every
 *     verification from scratch against freshly collected evidence, and a
 *     rejection goes back to the orchestrator verbatim.
 *  3. **Evidence is collected by the program**, straight from git, never taken
 *     from the worker's summary of what it did.
 */

import { readyDelegations } from '../../../../../src/orchestrator/delegation-plan.js';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentResult,
  AgentRunner,
  Baseline,
  ProviderFailureKind,
  CommandResult,
  Database,
  Decision,
  ExecutionEnvironment,
  GitEvidence,
  IterationRecord,
  PreviousAttempt,
  ProcessRunner,
  RouterOutput,
  RoutingProvider,
  RoutingRecord,
  WorkerRuntimeCapabilities,
  WorkerSelection,
  WorkspaceWithAgents,
} from '../core.js';
import {
  AcceptanceCriteriaLedger,
  GitEvidenceCollector,
  Verifier,
  commandPassed,
  decideResumption,
  evaluateConversationDone,
  evaluateDone,
  explainRefusal,
  formatDoneRejection,
  isMechanicalFailure,
  modelUnavailableIn,
  newId,
  parseDecision,
  redact,
  localEnvironment,
  routeWorkerModel,
} from '../core.js';
import type {
  ChatMessageView,
  RunDetailView,
  RunEvidenceView,
  RunProgressEvent,
  RunView,
} from '../../shared/ipc-contract.js';
import type { EventBus } from '../events.js';
import { AgentMessageBus } from '../../../../../src/bus/agent-message-bus.js';
import type { AgentMessageType, PublishInput } from '../../../../../src/bus/message-types.js';
import { describeActivity } from '../../../../../src/agents/activity-monitor.js';
import {
  describeFileCheck,
  describeFileRead,
  runFileChecks,
  runFileReads,
  type FileCheckRequest,
  type FileCheckResult,
  type FileReadResult,
} from '../../../../../src/verification/file-check.js';
import { renderContext, selectContext } from '../../../../../src/context/project-context.js';
import {
  assessPreflight,
  renderPreflight,
  type PreflightResult,
} from '../../../../../src/workspace/preflight.js';
import {
  buildWorkerReport,
  renderWorkerReport,
  type WorkerReport,
} from '../../../../../src/worker/worker-report.js';
import {
  capabilityCeilingOf,
  reasoningCeilingOf,
  DEFAULT_ACCOUNT_POLICY,
  type AccountRoutingPolicy,
} from '../../../../../src/routing/account-policy.js';
import { classifyCreditFailure } from '../../../../../src/routing/credit-failure.js';
import { isReadOnlyObjective, readProofProblems, type QueryEvidence } from '../../../../../src/orchestrator/query-proof.js';
import { classifyObjective } from '../../../../../src/orchestrator/objective-intent.js';
import { RejectedProgressGuard, equivalentAnswer, mechanicalGateFailure, publicGateAnswer } from '../../../../../src/orchestrator/rejected-progress.js';
import { fileContext, missingFilePayload } from '../../../../../src/orchestrator/file-context.js';
import { buildWorkerPrompt } from '../../../../../src/orchestrator/worker-prompt.js';
import type { ContextEntry } from '../../../../../src/context/project-context.js';
import type { ActivitySnapshot } from '../../../../../src/agents/activity-monitor.js';
import type { DeniedToolCall, ResumptionDecision } from '../core.js';
import {
  readChangeProposal,
  proposalInstructions,
} from '../../../../../src/github/change-proposal.js';
import { collectGitHubEvidence } from '../../../../../src/github/github-evidence.js';
import {
  listFiles,
  renderListing,
  renderTreePreview,
} from '../../../../../src/github/repository-tree.js';
import type { RepositoryTree } from '../../../../../src/github/repository-operations.js';
import {
  runGitHubFileChecks,
  runGitHubFileReads,
  type GitHubFileSource,
} from '../../../../../src/github/github-file-checks.js';
import { verifierWithoutExecutor } from '../../../../../src/orchestrator/verifier.js';
import {
  RepositoryConflictError,
  UnsupportedChangeError,
} from '../../../../../src/github/repository-operations.js';
import type { GitHubWorkspaceService } from './github-workspace-service.js';
import { toMessageView, toRunDetailView, toRunView } from './views.js';
import { BudgetLedger, isAgentProvider } from '../core.js';
import type { BudgetLimits, ProviderCapabilities } from '../core.js';

/** Everything a run needs that is not persisted state. */
export interface RunnerPair {
  orchestrator: AgentRunner;
  worker: AgentRunner;
  /** Account backing the worker, recorded on each invocation. */
  workerAccountId: string | null;
  /**
   * How the worker's model is chosen, per delegation. Absent means the
   * worker runs with its own defaults and nothing is routed (the test
   * fixture's scripted agents, for one).
   */
  workerRouting?: WorkerRoutingSource;
  /**
   * The team, when it has more than the one worker above.
   *
   * Absent means a team of one, built from `worker` - which is what every
   * project had before teams could grow, and what every existing caller and
   * test still passes. When present, the first entry is the default target of
   * a delegation that names no worker, so a single-worker team behaves
   * identically either way.
   */
  workers?: readonly WorkerSlot[];
  /** Spending limits for this run. Absent means the ledger only counts. */
  budget?: BudgetLimits;
}

/**
 * One member of the team, as the loop addresses it.
 *
 * `id` is what the orchestrator names in a delegation. It is the application's
 * own id, never a credential and never a model, so a decision can never reach
 * for a connection by guessing at one.
 */
export interface WorkerSlot {
  id: string;
  /** What the person called this worker. Shown in the timeline. */
  label: string;
  runner: AgentRunner;
  accountId: string | null;
  providerId: string | null;
  connectionKind: 'cli' | 'api' | null;
  /** The agent row, for the invocation record. */
  agentId: string | null;
  routing?: WorkerRoutingSource;
}

export interface WorkerRoutingSource {
  provider: RoutingProvider;
  selection: WorkerSelection;
  /** The person's own choice; used only under `manual`. */
  manual: { model: string | null; reasoning: string | null };
  /** What this account's worker CLI declares. Read once per run. */
  capabilities: () => Promise<WorkerRuntimeCapabilities>;
}

/** A worker CLI whose help could not be read: nothing is sent it may not take. */
const NO_CAPABILITIES: WorkerRuntimeCapabilities = {
  modelFlag: false,
  effortFlag: false,
  declaredModels: null,
  declaredEfforts: null,
};

/** Refused models are retried on the next candidate at most this many times per delegation. */
const MODEL_RETRIES = 2;

/**
 * What one run knows about the repository it is working on.
 *
 * Created once, at the top of a GitHub run, and carried through every phase.
 * `baseCommit` is resolved before anything else and never re-read: it is what
 * every later comparison measures against, so a push that lands on the base
 * branch mid-run shows up as a conflict rather than being silently absorbed.
 *
 * `workBranch` is null until the first change is actually applied. A question
 * about a repository must not leave a branch behind.
 */
interface GitHubRunContext {
  readonly service: GitHubWorkspaceService;
  readonly workspaceId: string;
  readonly fullName: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
  /** Null until something has been committed. */
  workBranch: string | null;
  /** The commit the work is at. The base commit until something lands. */
  headCommit: string;
  /** Every commit this run created, oldest first. */
  readonly commits: string[];
  pullRequestUrl: string | null;
  /**
   * The repository's file paths, read once at the top of the run.
   *
   * Without this the supervisor is told to read files and given no way to
   * learn a single path - which is exactly how a question about a repository
   * became a delegation to search an empty folder. Null only when GitHub could
   * not be asked, and that is said rather than hidden.
   */
  tree: RepositoryTree | null;
  /** Why the listing is absent, when it is. */
  treeProblem: string | null;
}

export interface OrchestrationOptions {
  /**
   * How long a delegation may be outstanding before the bus reclaims it.
   *
   * Must exceed the longest legitimate turn: the point is to notice a worker
   * that died, not to interrupt one that is working. Defaults to the bus's own
   * 20 minutes.
   */
  messageLeaseMs?: number;
  /** How often expired leases are reclaimed while a run is going. */
  sweepIntervalMs?: number;
  maxIterations?: number;
  agentTimeoutMs?: number;
  verificationTimeoutMs?: number;
  /** Accepts a run that changed no file. Off by default: see the DONE gate. */
  allowNoChanges?: boolean;
  /**
   * The short path for a small, finished task. On by default.
   *
   * When the application's own evidence and its own verifications already
   * prove a delegation's acceptance criteria, the loop asks the DoneGate
   * directly instead of paying for an orchestrator round trip to agree.
   * Setting this to `false` restores the long path, which is useful for a test
   * that wants to exercise the orchestrator's review.
   */
  fastPath?: boolean;
  /**
   * Resolves the git executable evidence is collected with. The application
   * passes its managed Git so a machine with no git on PATH still gets
   * evidence; when it cannot be resolved, `git` from PATH is tried.
   */
  gitCommand?: () => Promise<string>;
  /**
   * Where a run executes. Omitted means the user's own machine, which is what
   * every existing caller wants and what every existing test asserts.
   */
  environments?: EnvironmentFactory;
  /** Default spending limits, when a project sets none. Absent means none. */
  budget?: BudgetLimits;
  /**
   * The directory a conversation run's agents work in.
   *
   * A conversation project has no folder, and a child process still needs
   * one. Left to `spawn`, an empty string inherits whatever directory the
   * application was launched from - and the official CLIs read the working
   * directory's CLAUDE.md, hooks and MCP servers, so an inherited folder
   * could run another project's configuration in a run that has no project.
   * The application therefore hands them one of its own, which is empty.
   */
  conversationDirectory?: (workspace: WorkspaceWithAgents) => string;
}

/**
 * Builds the agent pair for one run, in the environment that run executes in.
 *
 * The environment is handed in rather than assumed: a remote run's Codex and
 * Claude Code live inside the workspace, not on this computer, so the runners
 * must be built against that runner and that path.
 */
export type RunnerFactory = (
  workspace: WorkspaceWithAgents,
  environment: ExecutionEnvironment,
) => Promise<RunnerPair>;

/**
 * Resolves where a run executes.
 *
 * The default is the user's own machine and the folder the workspace points
 * at - the behaviour this product has always had. A cloud workspace resolves
 * instead to a provisioned, isolated environment whose runner reaches into it.
 * Either way the loop below is the same loop.
 */
export type EnvironmentFactory = (
  workspace: WorkspaceWithAgents,
  signal: AbortSignal,
) => Promise<ExecutionEnvironment>;

/**
 * Checks a workspace can actually run before a run is started.
 *
 * Returns a sentence to show the user, or null when everything is ready.
 * Measured need: an unauthenticated Codex does not fail fast - it prints
 * "Reading prompt from stdin..." and waits - so without this a run would sit
 * there until the agent timeout, showing "Codex preparando a tarefa..." for
 * fifteen minutes. Failing in a second with a reason is better than that.
 */
export type ReadinessCheck = (workspace: WorkspaceWithAgents, supervisorOnly?:boolean) => Promise<string | null>;

const DEFAULTS = {
  maxIterations: 8,
  agentTimeoutMs: 15 * 60_000,
  verificationTimeoutMs: 10 * 60_000,
  /**
   * How often expired leases are reclaimed.
   *
   * Thirty seconds. The lease itself is twenty minutes - comfortably longer
   * than `agentTimeoutMs`, so a turn running to its own hard cap returns
   * normally and is never reclaimed out from under itself. The sweep only has
   * to be prompt enough that a person notices, not instant.
   */
  sweepIntervalMs: 30_000,
};

/**
 * The orchestrator's identity on the bus.
 *
 * A fixed name rather than a workspace-specific id: there is exactly one
 * supervisor per run, and the messages it sends are already scoped by run.
 * Workers are named by their slot id, which is what the team screen shows.
 */
export const ORCHESTRATOR_AGENT = 'orchestrator';

export class OrchestrationService {
  private readonly active = new Map<string, AbortController>();
  /** Runners of in-flight runs, so cancelling can reach the child processes. */
  private readonly branchTasks = new Map<string, {runId: string; iteration: number; taskId: string; slot: WorkerSlot; cancelled: boolean; invocationId?: string}>();
  private readonly runners = new Map<string, RunnerPair>();
  /** Environments of in-flight runs, so each is released exactly once. */
  private readonly environments = new Map<string, ExecutionEnvironment>();

  /**
   * The timer that reclaims expired leases.
   *
   * Runs only while something is running: an idle application has nothing to
   * sweep, and a timer ticking in the background of a window nobody is looking
   * at is a cost with no benefit. Started when the first run starts, stopped
   * when the last one ends.
   */
  private sweeper: NodeJS.Timeout | null = null;

  /**
   * The record of what the agents said to each other.
   *
   * A boundary, not a second engine. The loop below still decides everything;
   * what the bus adds is that each exchange is a committed row with a delivery
   * state, so "the orchestrator delegated and then nothing happened" is a
   * question the interface can answer. Nothing here reads a message back to
   * decide what to do next - that would be a second source of truth for the
   * run, and there is one.
   */
  readonly bus: AgentMessageBus;

  constructor(
    private readonly database: Database,
    private readonly processManager: ProcessRunner,
    private readonly events: EventBus,
    private readonly createRunners: RunnerFactory,
    private readonly options: OrchestrationOptions = {},
    private readonly checkReadiness: ReadinessCheck = async () => null,
  ) {
    this.bus = new AgentMessageBus(this.database.agentMessages, {
      ...(this.options.messageLeaseMs !== undefined ? { leaseMs: this.options.messageLeaseMs } : {}),
      onChange: (message) => {
        this.events.emit('run:message', {
          runId: message.runId,
          conversationId: message.conversationId,
          messageId: message.messageId,
          messageType: message.messageType,
          status: message.status,
          senderAgentId: message.senderAgentId,
          recipientAgentId: message.recipientAgentId,
          iteration: message.iteration,
          attempts: message.attempts,
          failureReason: message.failureReason,
          at: message.updatedAt,
        });
      },
    });
  }

  /**
   * Publishes to the bus without letting it break a run.
   *
   * The bus records the exchange; it does not gate it. The loop's control flow
   * comes from the awaited result of the agent call, exactly as before, so a
   * database hiccup here must cost the history entry and nothing else. It is
   * still recorded as a step, because silently losing the record of a message
   * is the shape of problem this whole layer exists to prevent.
   */
  private record(input: PublishInput): string | null {
    try {
      return this.bus.publish(input).message.messageId;
    } catch (error) {
      this.step(
        input.runId,
        input.iteration,
        'bus',
        'degraded',
        `Não foi possível registrar a mensagem ${input.messageType}: ${describeError(error)}`,
      );
      return null;
    }
  }

  /** Same rule as `record`: the bus must never be the reason a run dies. */
  private busSafely(action: () => void, runId: string, iteration: number): void {
    try {
      action();
    } catch (error) {
      this.step(runId, iteration, 'bus', 'degraded', describeError(error));
    }
  }

  /**
   * Where a run executes, defaulting to this computer.
   *
   * Local is not a special case of remote nor the other way round: it is the
   * factory that is absent, and the folder the workspace already points at
   * with the ProcessManager this service was built with is exactly what the
   * loop used before this boundary existed.
   */
  private async resolveEnvironment(
    workspace: WorkspaceWithAgents,
    signal: AbortSignal,
  ): Promise<ExecutionEnvironment> {
    if (this.options.environments) return this.options.environments(workspace, signal);
    return localEnvironment(workspace.id, workspace.local_path, this.processManager);
  }

  /** True while a run is still cancellable. */
  /**
   * Where a GitHub-backed project reads and writes its code.
   *
   * Bound after construction because the service that holds the GitHub token
   * is built after this one, and because a test that never touches a
   * repository should not have to supply one. Absent means GitHub mode is
   * simply not available, which the loop reports rather than working around.
   */
  private githubWorkspaces: GitHubWorkspaceService | null = null;

  bindGitHub(service: GitHubWorkspaceService): void {
    this.githubWorkspaces = service;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** True while any run of this workspace is still going. */
  hasActiveRunInWorkspace(workspaceId: string): boolean {
    for (const runId of this.active.keys()) {
      if (this.database.runs.find(runId)?.workspace_id === workspaceId) return true;
    }
    return false;
  }

  /**
   * Cancels a run.
   *
   * Two steps, both needed: abort the signal so the loop stops between phases,
   * and tell the runners to stop, which is what actually kills the child
   * process tree. Aborting alone would leave a Codex or Claude process running
   * until its own timeout.
   */
  cancelTask(runId: string, taskId: string): boolean {
    const entry = this.branchTasks.get(runId + ':' + taskId);
    if (!entry || entry.cancelled) return false;
    entry.cancelled = true;
    if (entry.invocationId) this.database.runs.cancelInvocation(entry.invocationId);
    this.step(runId, entry.iteration, 'task-cancel', 'cancelled', 'Subtarefa cancelada.', {taskId, workerId: entry.slot.id});
    void entry.slot.runner.cancel();
    return true;
  }

  cancel(runId: string): boolean {
    for (const entry of this.branchTasks.values()) if(entry.runId===runId) { entry.cancelled=true; void entry.slot.runner.cancel(); }
    // Recorded before anything else, and before any await.
    //
    // Cancelling used to be only an abort signal plus a kill, so the run
    // stayed RUNNING in the database until the loop happened to reach a
    // checkpoint - and on the way there it could still start another
    // delegation. The person had asked twice and watched the work continue
    // both times. The intent is now a fact the loop reads, not a race it has
    // to win, and it survives a restart.
    this.database.runs.requestCancel(runId);
    const controller = this.active.get(runId);
    if (!controller) {
      // A run waiting at the human gate is not running, but it is still
      // open. Cancelling it closes the question: the person chose to stop.
      // A run waiting at a gate is not running, but it is still open.
      // `NEEDS_HUMAN` is one of those gates now that an authorisation can
      // continue a run: cancelling has to close the question for good, so an
      // approval arriving afterwards cannot start the work the person just
      // stopped. `requestCancel` above already settles it, and this makes the
      // state say so rather than leaving a run that looks resumable.
      const run = this.database.runs.find(runId);
      if (run && (run.status === 'BLOCKED' || run.status === 'NEEDS_HUMAN')) {
        const where = run.status === 'BLOCKED' ? 'na revisão humana' : 'enquanto aguardava você';
        this.database.runs.setStatus(runId, 'CANCELLED', `Encerrada pelo usuário ${where}.`);
        this.step(runId, run.iteration, 'cancelled', 'dismissed', `Encerrada ${where}.`);
        if (run.session_id) {
          this.say(run.session_id, runId, 'system', `Execução encerrada ${where}.`);
          this.progress(runId, run.session_id, 'cancelled', 'Encerrada.', 'CANCELLED');
        }
        return true;
      }
      return false;
    }
    controller.abort();
    // Unfinished messages are cancelled; finished ones are left exactly as
    // they are. Cancelling a run does not un-happen what a worker already did,
    // and rewriting those rows would lose the only record of it.
    this.busSafely(
      () => void this.bus.cancelRun(runId, 'Execução cancelada pelo usuário.'),
      runId,
      this.database.runs.find(runId)?.iteration ?? 0,
    );
    const pair = this.runners.get(runId);
    if (pair) {
      void pair.orchestrator.cancel();
      void pair.worker.cancel();
    }
    // A verification or an evidence command may be the thing in flight, and
    // in a remote environment neither agent runner can reach it. The
    // environment can.
    const environment = this.environments.get(runId);
    if (environment && environment.kind !== 'local') void environment.processes.cancelAll();
    // "Cancelando" on the screen, immediately, without waiting for the loop to
    // notice. The terminal state arrives when the loop actually stops.
    const run = this.database.runs.find(runId);
    if (run?.session_id) {
      this.progress(runId, run.session_id, 'cancelling', 'Cancelando...', 'RUNNING');
    }
    return true;
  }

  /**
   * Creates the run row and starts the loop **without** awaiting it.
   *
   * The IPC call that triggered this returns as soon as the run exists, so the
   * interface can render "Analisando..." immediately and keep receiving
   * progress. A run is never awaited on the IPC thread.
   */
  start(input: { sessionId: string; objective: string }): RunView {
    const session = this.database.chat.requireSession(input.sessionId);
    const workspace = this.database.workspaces.require(session.workspace_id);

    const run = this.database.runs.create({
      id: newId('run'),
      sessionId: session.id,
      workspaceId: workspace.id,
      objective: input.objective,
      orchestratorAgentId: workspace.orchestrator_agent_id,
      maxIterations: this.options.maxIterations ?? DEFAULTS.maxIterations,
      // Recorded when the run is created, not derived when it is read: the
      // project could be changed afterwards, and the history must say which
      // gate this particular run actually had to pass.
      kind: isConversation(workspace) ? 'conversation' : 'coding',
    });

    this.launch(run.id, session.id, workspace, input.objective, 1);
    return toRunView(this.database.runs.require(run.id), []);
  }

  /**
   * Continues a run that stopped for an authorisation, now that it has one.
   *
   * The half that was missing. `permission.approve` wrote a grant row and
   * returned; the run stayed at `NEEDS_HUMAN` for ever, while the prompt the
   * worker had been given promised "the task will be delegated again once they
   * do". The person authorised, nothing continued, and the only way forward
   * was to ask again - which created a *second* run with none of the first
   * one's history and a fresh, higher model assessment for a question that had
   * never needed one.
   *
   * `decideResumption` decides, and it decides cancellation first: a run the
   * person stopped is not restarted by an authorisation that lands afterwards.
   * The run continues from the iteration it stopped at, so its budget is the
   * one it had - resuming is not a new run wearing the old one's id.
   */
  resumeAfterModelConfirmation(runId:string):boolean {
    const run=this.database.runs.require(runId);
    if(run.status!=='NEEDS_HUMAN'||run.cancel_requested_at||!run.session_id) throw new Error('Esta execução não pode ser retomada.');
    if(this.active.has(runId)) throw new Error('A execução ainda está finalizando a pausa. Tente novamente em instantes.');
    if(!this.database.driver.get('SELECT 1 FROM model_confirmations WHERE run_id=?',[runId])) throw new Error('Confirmação de modelo ausente.');
    this.launch(runId,run.session_id,this.database.workspaces.require(run.workspace_id),run.objective,Math.max(1,run.iteration),'Modelo confirmado para esta execução. Continue com o objetivo e as políticas originais.');
    return true;
  }

  resumeAfterApproval(runId: string): ResumptionDecision {
    const run = this.database.runs.find(runId);
    if (!run) return { resume: false, because: 'finished' };
    const decision = decideResumption({
      status: run.status,
      // Read from the row, not from an in-memory controller: a cancellation
      // survives a restart, and this decision has to survive one too.
      cancelRequested: this.database.runs.cancelRequested(runId),
      running: this.active.has(runId),
      pending: this.database.permissions
        .forRun(runId)
        .filter((request) => request.status === 'pending').length,
      approvedForRun: this.database.permissions
        .forRun(runId)
        .filter((request) => request.status === 'approved').length,
      grantedRules: this.grantsFor(run.workspace_id),
    });
    if (!decision.resume) {
      // Said out loud, in the conversation, rather than left as silence. The
      // whole defect this fixes was a decision nobody could see.
      if (run.session_id && decision.because !== 'already-running') {
        this.say(run.session_id, runId, 'system', explainRefusal(decision.because));
      }
      return decision;
    }

    const workspace = this.database.workspaces.require(run.workspace_id);
    const sessionId = run.session_id;
    if (!sessionId) return { resume: false, because: 'not-waiting' };
    const approved = this.database.permissions
      .forRun(runId)
      .filter((request) => request.status === 'approved');
    const refused = this.database.permissions
      .forRun(runId)
      .filter((request) => request.status === 'denied');
    const note =
      `Você autorizou ${approved.length === 1 ? '1 operação' : `${approved.length} operações`}` +
      `${approved.length > 0 ? `: ${approved.map((r) => r.approved_rule ?? r.tool_name).join(', ')}` : ''}.` +
      (refused.length > 0
        ? ` Recusou: ${refused.map((r) => r.tool_name).join(', ')} - não peça de novo.`
        : '') +
      ' Continuando a tarefa original de onde ela parou.';
    this.say(sessionId, runId, 'system', note);
    this.step(runId, run.iteration, 'permission', 'resumed', note.slice(0, 500), {
      approvedRules: decision.rules,
    });
    // From the iteration it stopped at, not from one. The run keeps the budget
    // it had left; an authorisation is not a way to buy eight more rounds.
    this.launch(runId, sessionId, workspace, run.objective, Math.max(1, run.iteration), note);
    return decision;
  }

  /**
   * Starts the loop for a run row that already exists, and gives it back
   * whatever it took, on every path out.
   *
   * One place, used by `start` and by `resumeAfterApproval`, because the
   * bookkeeping in the `finally` - the project's standing note, the closed
   * exchange, the released environment - has to happen exactly once per
   * attempt and a second copy of it would eventually drift from this one.
   */
  private launch(
    runId: string,
    sessionId: string,
    workspace: WorkspaceWithAgents,
    objective: string,
    startIteration: number,
    resumptionNote?: string,
  ): void {
    const controller = new AbortController();
    this.active.set(runId, controller);
    this.startSweeping();

    void this.execute(runId, workspace, objective, controller, startIteration, resumptionNote ?? null)
      .catch((error: unknown) => {
        const reason = describeError(error);
        this.database.runs.setStatus(runId, 'FAILED', reason);
        this.step(runId, this.database.runs.require(runId).iteration, 'error', 'failed', reason, {
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        this.say(sessionId, runId, 'system', `Falhou: ${reason}`);
        this.progress(runId, sessionId, 'failed', 'Falhou.', 'FAILED');
      })
      .finally(() => {
        this.active.delete(runId);
        this.runners.delete(runId);
        this.phaseClock.delete(runId);
        // The project's standing note about its own state, written once, from
        // the one place every path out of the loop passes through - so a run
        // that failed leaves a record saying it failed, rather than the
        // project's last note being a success from three runs ago.
        const finished = this.database.runs.find(runId);
        if (finished) {
          this.recordProjectState({
            workspaceId: workspace.id,
            runId,
            objective: finished.objective,
            status: finished.status,
            summary: finished.termination_reason ?? 'sem resumo',
          });
        }
        // The run's ending, on the record, from the one place every path out
        // of the loop passes through. Hooking each `setStatus` instead would
        // mean eleven call sites and a twelfth one day that forgets.
        this.closeExchange(runId, sessionId);
        if (this.active.size === 0) this.stopSweeping();
        // Whatever the run cost - a container, a clone, a lease - is given
        // back exactly once, on every path out of the loop.
        const environment = this.environments.get(runId);
        this.environments.delete(runId);
        void environment?.release?.().catch(() => {});
      });
  }

  /**
   * Called once at start-up: a run the database still shows as running was
   * cut short by the previous process ending. Nothing is executing it now, so
   * the truth is recorded rather than an eternal spinner.
   */
  reconcileInterrupted(): number {
    // Leases the previous process left behind, reclaimed before anything else
    // reads them. This is the boot-time half of the same job.
    this.sweepOnce();
    let count = 0;
    for (const run of this.database.runs.listUnfinished()) {
      if (this.active.has(run.id)) continue;
      const reason = 'Interrompida: o aplicativo foi fechado durante a execução.';
      this.database.runs.setStatus(run.id, 'FAILED', reason);
      this.step(run.id, run.iteration, 'interrupted', 'failed', reason);
      // Whatever was outstanding is outstanding no longer: the child process
      // it was handed to died with the parent. It is closed, not redelivered -
      // re-sending an instruction that may already have written a file is
      // exactly the non-idempotent retry spec 12 forbids. What actually
      // happened is a question for evidence, on the next run.
      this.busSafely(() => void this.bus.cancelRun(run.id, reason), run.id, run.iteration);
      if (run.session_id && this.database.chat.findSession(run.session_id)) {
        this.database.chat.addMessage({ sessionId: run.session_id, runId: run.id, author: 'system', body: reason });
      }
      count += 1;
    }
    return count;
  }

  /** Waits for a run to leave the active set. Used by tests and by shutdown. */
  async waitFor(runId: string, timeoutMs = 120_000): Promise<RunView> {
    const deadline = Date.now() + timeoutMs;
    while (this.active.has(runId)) {
      if (Date.now() > deadline) throw new Error(`Run ${runId} did not finish in time`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.view(runId);
  }

  view(runId: string): RunView {
    const run = this.database.runs.require(runId);
    return toRunView(run, this.database.runs.steps(runId));
  }

  /** The execution history of a project, newest first. */
  listForWorkspace(workspaceId: string): RunView[] {
    this.database.workspaces.require(workspaceId);
    return this.database.runs
      .listForWorkspace(workspaceId)
      .map((run) => toRunView(run, this.database.runs.steps(run.id)));
  }

  /**
   * Everything recorded about one run: steps with their diagnostics,
   * invocations, verification results. What "Detalhes" shows.
   */
  detail(runId: string): RunDetailView {
    const run = this.database.runs.require(runId);
    // The provider sessions this conversation is continuing, with the name of
    // the connection each belongs to. A session created by `claude -p` is
    // deliberately absent from the interactive picker, so its id is the only
    // handle a person has - which makes it worth showing rather than hiding.
    const sessions = run.session_id
      ? this.database.agentSessions.listForChatSession(run.session_id).map((session) => ({
          ...session,
          connectionName: this.database.accounts.find(session.connection_id)?.display_name ?? null,
        }))
      : [];
    return toRunDetailView(
      run,
      this.database.runs.steps(runId),
      this.database.runs.invocations(runId),
      this.database.runs.verifications(runId),
      sessions,
    );
  }

  // -- the loop ------------------------------------------------------------

  private async execute(
    runId: string,
    workspace: WorkspaceWithAgents,
    objective: string,
    controller: AbortController,
    /** Where the loop starts. Above 1 only when a stopped run is continuing. */
    startIteration = 1,
    /** What changed while the run was stopped, for the orchestrator to read. */
    resumptionNote: string | null = null,
  ): Promise<void> {
    const sessionId = this.database.runs.require(runId).session_id!;
    const signal = controller.signal;
    const maxIterations = this.options.maxIterations ?? DEFAULTS.maxIterations;
    const objectiveIntent = classifyObjective(objective);

    this.database.runs.setStatus(runId, 'RUNNING');
    this.progress(runId, sessionId, 'analysing', 'Analisando...', 'RUNNING');
    this.step(runId, startIteration, 'objective-intent', 'classified', objectiveIntent.kind, { intent: objectiveIntent });

    // The person's goal, sent once. Everything the agents say afterwards
    // hangs off this exchange, which is what lets the timeline show a run as
    // one conversation rather than a pile of unrelated calls.
    const runCorrelation = `cor-run-${runId}`;
    // The clock starts here, at the top of the run, so the first step's
    // duration is real. Seeded lazily it would be null, and the startup
    // segment - the one nobody could see - would stay unmeasured.
    this.phaseClock.set(runId, Date.now());
    this.record({
      runId,
      conversationId: sessionId,
      iteration: 0,
      messageType: 'USER_OBJECTIVE',
      payload: { objective },
      correlationId: runCorrelation,
    });

    // Ask before spending fifteen minutes finding out.
    const problem = await this.checkReadiness(workspace,objectiveIntent.kind==='READ_ONLY_QUERY');
    if (problem) {
      this.database.runs.setStatus(runId, 'FAILED', problem);
      this.say(sessionId, runId, 'system', problem);
      this.step(runId, 0, 'readiness', 'blocked', problem);
      this.progress(runId, sessionId, 'failed', problem, 'FAILED');
      return;
    }

    // What kind of run this is. A conversation run has no folder, no git and
    // no commands: analysing a problem, comparing two designs or drafting a
    // plan needs none of them, and demanding them would be the thing that
    // forces a person to clone a repository before they can ask a question.
    const conversation = isConversation(workspace);

    // A project that works straight against GitHub. Resolved before anything
    // else, because everything below measures against the commit it names -
    // and because a repository that cannot be reached is a fact the person
    // needs at the start, not fifteen minutes into a run.
    let github: GitHubRunContext | null = null;
    if (isGitHubProject(workspace)) {
      const problem = await this.openGitHubProject(runId, sessionId, workspace);
      if (problem === null) return;
      github = problem;
    }

    // Where this run executes. Everything below - evidence, verification, both
    // agents - goes through this one environment, so the loop never mixes a
    // remote workspace's path with a local runner or the other way round.
    // A conversation run resolves none, and neither does a GitHub run: there
    // is no folder to provision, which is the whole point of working through
    // the API. Code that must actually *run* is a separate capability, and the
    // interface says so rather than a run discovering it.
    const environment = conversation || github ? null : await this.resolveEnvironment(workspace, signal);
    if (environment) this.environments.set(runId, environment);
    // A conversation run still gives its agents a real directory - an empty
    // one the application owns. See `conversationDirectory`.
    const cwd =
      environment?.workingDirectory ??
      this.options.conversationDirectory?.(workspace) ??
      process.cwd();

    const runners = await this.createRunners(workspace, environment ?? NO_ENVIRONMENT);
    this.runners.set(runId, runners);
    const team = teamOf(runners);
    const budget = new BudgetLedger(runners.budget ?? this.options.budget ?? {});
    // Getting to here - resolving the environment, provisioning it, building
    // the runners - is real time that no step recorded, so it could not be
    // seen and could not be shortened. Now it is one measured segment.
    this.step(
      runId,
      0,
      'startup',
      environment ? environment.kind : 'conversation',
      `${team.length} agente(s) prontos`,
    );

    const gitCommand = conversation
      ? undefined
      : await this.options.gitCommand?.().catch(() => undefined);
    const collector =
      environment && !conversation && !github
        ? gitCommand
          ? new GitEvidenceCollector(cwd, environment.processes, gitCommand)
          : new GitEvidenceCollector(cwd, environment.processes)
        : null;
    const verifier =
      environment && !conversation && !github
        ? new Verifier({
            cwd,
            timeoutMs: this.options.verificationTimeoutMs ?? DEFAULTS.verificationTimeoutMs,
            processManager: environment.processes,
            signal,
            // A remote environment resolves its own commands: walking this
            // computer's PATH would answer about the wrong filesystem, and on
            // Windows it would spawn `where.exe` here - a child process
            // outside the boundary the environment exists to draw.
            ...(environment.kind === 'remote'
              ? { resolveCommand: async (command: string) => command }
              : {}),
          })
        : null;

    // A coding run must have somewhere real to work. Checked here, before the
    // first agent is paid for, because an unwritable or missing folder is a
    // configuration problem with a clear fix - and letting it through means
    // the worker fails, the orchestrator sees "no progress", and the person is
    // told nothing they can act on.
    // Only for a folder on *this* computer. A remote environment's path
    // exists inside that environment, never here, so statting it locally
    // would answer about the wrong filesystem - which is the boundary cloud
    // mode exists to keep.
    if (!conversation && environment?.kind === 'local') {
      const problem = describeWorkspaceProblem(cwd);
      if (problem) {
        this.database.runs.setStatus(runId, 'NEEDS_HUMAN', problem);
        this.step(runId, 0, 'workspace', 'invalid', problem);
        this.say(sessionId, runId, 'system', problem);
        this.progress(runId, sessionId, 'needs-human', 'Pasta do projeto indisponível.', 'NEEDS_HUMAN');
        return;
      }
    }

    const baseline = collector ? await collector.captureBaseline() : EMPTY_BASELINE;
    if (collector) {
      this.database.runs.setBaseline(runId, baseline.branch, baseline.commit, baseline.dirty);
      // What the program can actually observe, said once at the start rather
      // than discovered as silence later.
      this.step(
        runId,
        0,
        'baseline',
        baseline.evidenceProblem ? 'degraded' : 'ok',
        baseline.evidenceProblem ??
          (baseline.isGitRepository
            ? (baseline.commit ?? 'sem commit')
            : 'pasta sem repositório git; alterações serão observadas pelo sistema de arquivos'),
      );
      if (baseline.evidenceProblem) {
        this.say(sessionId, runId, 'system', baseline.evidenceProblem);
      }
    }

    // Is this the folder the objective is about?
    //
    // The incident this answers: a task for `Arcanjog1/Orquestrador` ran in a
    // Desktop folder whose name looked right and which was not a checkout of
    // anything. The baseline said so and the run went ahead regardless - one
    // delegation wrote a baseline document, the next died in 5.3s, and the
    // router escalated on "no progress". No model could have helped: the code
    // was not there.
    //
    // Blocking is deliberately narrow. It happens only when the project
    // itself declares a repository and the folder is provably not it. A
    // project that is only a folder is never measured against a repository,
    // so creating `hello.txt` in a folder with no git keeps working exactly
    // as before.
    let preflight: PreflightResult | null = null;
    if (!conversation && environment?.kind === 'local' && collector) {
      const probe = await collector.probeRepository();
      preflight = assessPreflight({
        workspacePath: cwd,
        // `describeWorkspaceProblem` above already refused a missing or
        // unwritable folder, so reaching here means it is there.
        folderExists: true,
        isGitRepository: probe.isRepository,
        gitProblem: probe.problem,
        remoteUrl: probe.isRepository ? await collector.originUrl() : null,
        branch: baseline.branch,
        dirty: baseline.dirty,
        declaredRepositoryUrl: workspace.repository_url,
        declaredDefaultBranch: workspace.default_branch,
      });
      this.step(
        runId,
        0,
        'preflight',
        preflight.blocksCodeWork ? 'blocked' : 'ok',
        `${preflight.title} ${preflight.detail}`.slice(0, 500),
        { kind: preflight.kind, actions: [...preflight.actions] },
      );
      if (preflight.blocksCodeWork) {
        const reason = `${preflight.title} ${preflight.detail}`;
        this.database.runs.setStatus(runId, 'NEEDS_HUMAN', reason);
        this.say(sessionId, runId, 'system', reason);
        this.progress(runId, sessionId, 'needs-human', preflight.title, 'NEEDS_HUMAN');
        return;
      }
    }

    const ledger = new AcceptanceCriteriaLedger();
    const iterations: IterationRecord[] = [];
    /** Every command actually resolved from an id, deduplicated. */
    const resolvedCommands = new Set<string>();
    /**
     * Every file check the run asked for, deduplicated by its request.
     *
     * The gate re-runs all of them, exactly as it re-runs every command: a
     * file that was right in iteration 2 may have been overwritten in
     * iteration 3, and certifying the earlier read would be certifying a
     * memory rather than the workspace.
     */
    const requestedFileChecks = new Map<string, FileCheckRequest>();
    // A resumed run does not start from nothing: the orchestrator's first
    // round reads what changed while the run was stopped - which operation the
    // person authorised, and which they refused - so it continues the task
    // instead of planning it again from the objective alone.
    let feedback: string | null = resumptionNote
      ? `A EXECUÇÃO FOI RETOMADA. ${resumptionNote}`
      : null;
    /**
     * What happened to a change the worker proposed, when it did not land.
     *
     * Carried separately from `feedback` because it must reach the supervisor
     * *in addition to* whatever the evidence says - a proposal refused for a
     * bad path and a round that changed nothing look identical in a diff, and
     * only one of them is something the next round can fix.
     */
    let proposalFeedback: string | null = null;
    /**
     * Whether the repository listing has already been put in front of the
     * supervisor after it said it was blocked. Once: a second offer of the
     * same list would be a loop, and the second refusal is a real one.
     */
    let listingOffered = false;
    const queryEvidence: QueryEvidence[] = [];
    if(github) {
      const snapshot={repository:github.fullName,branch:github.baseBranch,commit:github.headCommit};
      queryEvidence.push({kind:'REPOSITORY_ACCESS',...snapshot},{kind:'REPOSITORY_METADATA',...snapshot});
      if(github.tree)for(const kind of ['REPOSITORY_TREE','FILE_EXISTENCE'] as const)queryEvidence.push({kind,...snapshot,paths:github.tree.entries.map(e=>e.path),complete:!github.tree.truncated});
      if(objectiveIntent.readProofs.includes('COMMIT')) {
        try {
          const source=await this.githubSource(github,signal);
          const commits=await source.operations.commits(source.ref,source.at,source.token,20,signal);
          queryEvidence.push({kind:'COMMIT',...snapshot,commits});
        } catch(error) {this.step(runId,0,'query-evidence','unavailable',String(error));}
      }
    } else if(baseline.isGitRepository&&baseline.commit&&baseline.branch) {
      const snapshot={repository:String(workspace.repository_url??workspace.name??cwd),branch:baseline.branch,commit:baseline.commit};
      queryEvidence.push({kind:'REPOSITORY_ACCESS',...snapshot},{kind:'REPOSITORY_METADATA',...snapshot});
    }

    // Routing state for this run: what each worker's CLI can take (read once
    // per worker), the attempts so far as the router reads them, the models a
    // CLI refused, and the tree as the last attempt left it.
    const capabilitiesOf = new Map<string, WorkerRuntimeCapabilities>();
    for (const slot of team) {
      capabilitiesOf.set(
        slot.id,
        slot.routing ? await slot.routing.capabilities().catch(() => NO_CAPABILITIES) : NO_CAPABILITIES,
      );
    }
    this.step(runId, 0, 'capabilities', 'read', `${capabilitiesOf.size} worker(s) consultados`);
    const attemptsByWorker = new Map(team.map(slot => [slot.id, [] as PreviousAttempt[]]));
    const unavailableByWorker = new Map(team.map(slot => [slot.id, [] as string[]]));
    let lastDelegatedWorkerId = team[0]?.id ?? 'worker-1';
    /** The last answer a worker gave, which is what a conversation run ends with. */
    let lastWorkerAnswer = '';
    /** This iteration's worker answer, which is what its report is about. */
    let iterationAnswer = '';
    let previousTree = treeKey(baseline.statusShort, baseline.unstagedDiff + baseline.stagedDiff);
    /** Evidence as the previous iteration left it, so a report can subtract it. */
    let previousEvidence: GitEvidence | null = null;
    let warnedOrchestratorLevel = false;
    // The short path is offered once per run. A second attempt would be the
    // loop arguing with a gate that already said no.
    let fastPathTried = false;
    /** Consecutive iterations that asked for unknown ids and proved nothing. */
    let barrenVerifyRounds = 0;
    /** The evidence as the previous iteration left it, and how long it has stood. */
    let previousFingerprint: string | null = null;
    let stagnantRounds = 0;
    const batchSignatures = new Set<string>();
    let unresolvedDelegations = false;
    const rejectedProgress = new RejectedProgressGuard();
    const displayedDoneAnswers = new Set<string>();
    const stopRepeatedRejection=(gate:import('../core.js').DoneGateResult, record:IterationRecord, fresh:GitEvidence):boolean=>{
      if(mechanicalGateFailure(gate))for(const attempts of attemptsByWorker.values()) {
        const last=attempts.at(-1);if(last)last.mechanical=true;
      }
      if(!rejectedProgress.observe({answer:record.decision?.summary??'',evidence:fresh,reads:iterations.flatMap(r=>r.fileReads??[]),criteria:ledger.pending(),gate}))return false;
      const reason='GATE_MISMATCH: duas propostas de conclusão têm a mesma resposta, evidência, critérios e rejeição. A execução foi interrompida sem escalar modelos; falta uma prova compatível com o objetivo.';
      this.database.runs.setStatus(runId,'FAILED',reason);
      this.step(runId,record.iteration,'no-progress','stopped',reason,{failures:gate.failures});
      this.say(sessionId,runId,'system',reason);
      this.progress(runId,sessionId,'failed',reason,'FAILED');
      return true;
    };
    // What was said in this conversation before this run, so a follow-up
    // ("continue", "now also do X") is read against what came before it.
    const history = this.conversationBefore(sessionId, runId);

    for (let iteration = Math.max(1, startIteration); iteration <= maxIterations; iteration += 1) {
      if (this.stopping(runId, signal)) return this.finishCancelled(runId, sessionId);
      this.database.runs.setIteration(runId, iteration);

      iterationAnswer = '';

      const record: IterationRecord = {
        iteration,
        startedAt: new Date().toISOString(),
        decisionRepairAttempts: 0,
        notes: [],
      };
      iterations.push(record);

      // 1. Ask the orchestrator what to do - if the run may still spend.
      //
      // The check is here, before the call, because after it the money is
      // already gone. A run stopped by its own budget is NEEDS_HUMAN, not a
      // failure: nothing went wrong, a limit the person set was reached.
      const verdict = budget.check();
      if (!verdict.allowed) {
        return this.finishAtBudget(runId, sessionId, verdict.reason, budget);
      }
      if (verdict.warning) this.say(sessionId, runId, 'system', verdict.warning);

      this.progress(runId, sessionId, 'orchestrator', 'Orquestrador analisando...', 'RUNNING');
      const supervisorFiles = fileContext(iterations.flatMap(r => r.fileReads ?? []), 'SUPERVISOR');
      const prompt = this.buildOrchestratorPrompt({
        workspace,
        cwd,
        objective,
        baseline,
        iteration,
        feedback,
        iterations,
        history,
        conversation,
        github,
        team,
        preflight,
      }) + '\n\nOBJECTIVE INTENT: '+JSON.stringify(objectiveIntent)+
        '\nMEASURED QUERY EVIDENCE (application-owned, not model claims): '+JSON.stringify(queryEvidence.filter(e=>objectiveIntent.readProofs.includes(e.kind)).map(e=>({...e,...(e.paths?{paths:e.paths.slice(0,200),totalPaths:e.paths.length,complete:e.complete&&e.paths.length<=200}:{})})))+
        '\nA simple query about access, metadata or the tree can be answered with done immediately using these facts. Do not delegate it, invent a change, or ask for a CLI flag. File-content questions still require fileReads and byte-grounded queryProof citations. Mixed requests must prove every requested operation.'+
        '\n\n' + supervisorFiles.text;
      if (supervisorFiles.deliveries.length) this.step(runId, iteration, 'file-context', 'supervisor-carried', 'Conteúdo incluído no prompt do supervisor.', { deliveries: supervisorFiles.deliveries });
      const asked = await this.askForDecision({
        runId,
        workspace,
        cwd,
        runners,
        prompt,
        iteration,
        signal,
        budget,
        onApplied: (applied) => {
          // The orchestrator's fixed level was not what its CLI supports:
          // said once per run, in the words the interface promises.
          if (applied.note && !warnedOrchestratorLevel) {
            warnedOrchestratorLevel = true;
            this.say(sessionId, runId, 'system', applied.note);
          }
        },
      });
      if (this.stopping(runId, signal)) return this.finishCancelled(runId, sessionId);
      if (!asked.decision) {
        // Say exactly what happened - the CLI's exit, or what it answered
        // instead of a decision - rather than a sentence that fits everything.
        const reason = asked.failure ?? 'O orquestrador não devolveu uma decisão válida.';
        this.database.runs.setStatus(runId, asked.policyBlocked ? 'NEEDS_HUMAN' : 'FAILED', reason);
        this.say(sessionId, runId, 'system', reason);
        this.progress(runId, sessionId, asked.policyBlocked ? 'needs-human' : 'failed', reason, asked.policyBlocked ? 'NEEDS_HUMAN' : 'FAILED');
        return;
      }
      const decision = { ...asked.decision,
        ...(asked.decision.reason ? {reason:publicGateAnswer(asked.decision.reason)} : {}),
      };
      record.decision = decision;
      if (decision.action === 'done' && unresolvedDelegations) {
        this.step(runId, iteration, 'done-gate', 'rejected', 'Subtarefas falhas, canceladas ou conflitantes ainda não foram resolvidas.');
        this.database.runs.setStatus(runId, 'NEEDS_HUMAN', 'Revisar os resultados parciais antes de concluir.');
        this.progress(runId, sessionId, 'needs-human', 'Join parcial precisa de revisão.', 'NEEDS_HUMAN');
        return;
      }
      // What the orchestrator decided, as a message rather than only as a log
      // line. The action and the target worker are recorded; the prose is
      // already a chat message, so it is not duplicated here.
      const decisionMessageId = this.record({
        runId,
        conversationId: sessionId,
        iteration,
        messageType: 'ORCHESTRATOR_DECISION',
        payload: { action: decision.action, workerId: decision.workerId ?? null },
        senderAgentId: ORCHESTRATOR_AGENT,
        correlationId: runCorrelation,
      });
      ledger.add(decision.acceptanceCriteria, iteration);

      if (decision.summary) {
        const answer=publicGateAnswer(decision.summary);
        const key=equivalentAnswer(answer);
        if(decision.action!=='done'||!displayedDoneAnswers.has(key))this.say(sessionId, runId, 'orchestrator', answer);
        if(decision.action==='done')displayedDoneAnswers.add(key);
      }

      // Files the supervisor asked to *see*. The application opens them, so
      // nobody has to ask a worker to copy a file into an answer - which is
      // what the run that prompted this did, four files at a time, getting
      // truncated copies back and going round again.
      const fileReads =
        decision.fileReads.length === 0
          ? []
          : github
            ? await runGitHubFileReads(await this.githubSource(github, signal), decision.fileReads)
            : environment?.kind === 'local'
              ? await runFileReads(cwd, decision.fileReads)
              : [];
      if (fileReads.length > 0) {
        record.fileReads = fileReads;
        this.step(
          runId,
          iteration,
          'file-read',
          fileReads.every((read) => read.ok) ? 'read' : 'partial',
          fileReads.map(describeFileRead).join('; ').slice(0, 500),
          { deliveries: fileContext(fileReads, 'WORKER').deliveries.map(d => ({ ...d, state: 'READ', bytesSent: 0, payloadHash: null })) },
        );
      }
      const carriedReads = iterations.flatMap(r => r.fileReads ?? []);
      // 2. Act on it.
      if (decision.action === 'blocked') {
        const reason = decision.reason ?? 'Sem motivo informado.';
        // Stopping for a person is for something the application genuinely
        // cannot get. The file listing is not that: the incident this guards
        // was a run that ended in human review saying it lacked the file tree,
        // while the application held a repository, a branch and a commit and
        // could have fetched it in one request. So it is fetched and offered,
        // once, before anybody is asked to intervene.
        if (github && !listingOffered) {
          listingOffered = true;
          const offered = await this.offerRepositoryListing(runId, iteration, github, signal);
          if (offered) {
            feedback = offered;
            this.step(
              runId,
              iteration,
              'blocked',
              'answered',
              'A pendência era a lista de arquivos, e o aplicativo a obteve; seguindo sem intervenção.',
            );
            continue;
          }
        }
        this.database.runs.setStatus(runId, 'BLOCKED', reason);
        this.say(sessionId, runId, 'orchestrator', `Bloqueado: ${reason}`);
        this.progress(runId, sessionId, 'blocked', 'Bloqueado.', 'BLOCKED');
        return;
      }

      if (decision.action === 'delegate' && decision.delegations?.length) {
        const tasks = decision.delegations;
        const signature=JSON.stringify({tasks,head:github?.headCommit,reads:carriedReads.map(r=>[r.request.path,r.sha256,r.request.offsetBytes])});
        if(batchSignatures.has(signature)) {
          const reason='Sem progresso: o mesmo DAG foi solicitado novamente com os mesmos arquivos e commit. Revise a estratégia antes de repetir.';
          this.step(runId,iteration,'progress','stagnant',reason);
          this.database.runs.setStatus(runId,'NEEDS_HUMAN',reason);this.progress(runId,sessionId,'needs-human',reason,'NEEDS_HUMAN');return;
        }
        batchSignatures.add(signature);
        const chosen = new Map<string, WorkerSlot>();
        for (const task of tasks) {
          const result = this.chooseWorker(team, {...decision, task: task.task, workerId: task.workerId, requiresTools: task.requiresTools, taskKind:task.taskKind}, conversation);
          if (!result.ok) throw new Error(result.reason);
          chosen.set(task.taskId, result.slot);
        }
        const completed = new Set<string>(), pending = new Set(tasks.map(t=>t.taskId));
        const outcomes: { taskId: string; status: string; summary: string; invocationId?: string; changedFiles: string[] }[] = [];
        while (pending.size) {
          if (this.stopping(runId, signal)) return this.finishCancelled(runId, sessionId);
          const wave = readyDelegations(tasks, completed, pending, t => {
            const slot=chosen.get(t.taskId)!;
            const agent=slot.agentId?this.database.agents.find(slot.agentId):undefined;
            const policy=agent?agentConfig(agent.runtime_options).policy:undefined;
            return policy?.parallel ? slot.agentId! : slot.accountId ?? String(team.findIndex(s=>s.runner===slot.runner));
          }, github && budget.unlimited && ![...chosen.values()].some(s=>{const a=s.agentId?this.database.agents.find(s.agentId):undefined;return a&&agentConfig(a.runtime_options).policy?.parallel===false;}) ? 3 : 1);
          if (!wave.length) {
            for(const id of pending) { outcomes.push({taskId:id,status:'blocked',summary:'Dependência falhou ou foi cancelada.',changedFiles:[]}); this.step(runId,iteration,'task-blocked','blocked','Dependência não concluída.',{taskId:id}); }
            break;
          }
          const baseCommit=github?.headCommit;
          const results = await Promise.all(wave.map(async task => {
            pending.delete(task.taskId);
            const slot=chosen.get(task.taskId)!;
            const taskCwd=github ? join(cwd, '.execution-tasks', runId, String(iteration), task.taskId) : cwd;
            if(github) mkdirSync(taskCwd,{recursive:true});
            const key=runId+':'+iteration+'/'+task.taskId;
            const entry={runId,iteration,taskId:iteration+'/'+task.taskId,slot,cancelled:false};
            this.branchTasks.set(key,entry);
            this.step(runId,iteration,'task-start','started',task.task,{taskId:entry.taskId,workerId:slot.id,dependsOn:task.dependsOn.map(id=>iteration+'/'+id),baseCommit});
            try {
              const spend=budget.check(); if(!spend.allowed) throw new Error(spend.reason);
              const result = await this.delegate({runId,sessionId,workspace,cwd:taskCwd,runners,slot,iteration,branchTaskId:entry.taskId,task:task.task+'\nDEPENDENCY RESULTS: '+JSON.stringify(outcomes.filter(o=>task.dependsOn.includes(o.taskId))),decision:{...decision,task:task.task,workerId:task.workerId,requiresTools:task.requiresTools,taskKind:task.taskKind},correlationId:runCorrelation,causationId:decisionMessageId,routing:slot.routing??null,capabilities:capabilitiesOf.get(slot.id)??NO_CAPABILITIES,attempts:[],unavailableModels:[],signal,budget,github,fileReads:carriedReads});
              const cancelled=entry.cancelled || this.stopping(runId,signal);
              const mechanical=carriedReads.length>0 && missingFilePayload(result.answer);
              const status=cancelled?'cancelled':result.record.failure||result.record.exitCode!==0||result.record.outcome!=='completed'||mechanical?'failed':'completed';
              if(mechanical) result.record.mechanical=true;
              this.reportDelegation({runId,sessionId,iteration,worker:result.record,answer:result.answer,evidence:null,previousEvidence:null,readFiles:carriedReads.filter(r=>r.ok).map(r=>r.request.path),verifications:[],unproven:ledger.pending().map(c=>c.text),failedCriteria:[]});
              this.step(runId,iteration,'task-result',status,task.task,{taskId:entry.taskId,workerId:slot.id,invocationId:result.record.invocationId,mechanical});
              return {task,result,status};
            } catch(error) {
              this.step(runId,iteration,'task-result',entry.cancelled?'cancelled':'failed',String(error),{taskId:entry.taskId,workerId:slot.id});
              return {task,result:null,status:entry.cancelled?'cancelled':'failed'};
            } finally { this.branchTasks.delete(key); }
          }));
          if (this.stopping(runId,signal)) return this.finishCancelled(runId,sessionId);
          if (this.database.runs.require(runId).status === 'NEEDS_HUMAN') return;
          const paths=new Set<string>();
          const taskPaths=new Map<string,string[]>();
          const changes: import('../../../../../src/github/repository-operations.js').RepositoryChange[]=[];
          let conflict=false;
          let proposalsApplied=false;
          for(const item of results) {
            const parsed=github && item.result && item.status==='completed' ? readChangeProposal(item.result.answer,baseCommit!) : null;
            if(parsed?.kind==='proposal'&&!this.agentMayWrite(workspace.id,chosen.get(item.task.taskId)?.agentId??null)) {item.status='failed';conflict=true;this.step(runId,iteration,'proposal','refused','A função ou política do agente proíbe escrita.',{taskId:item.task.taskId});continue;}
            if(parsed?.kind==='invalid') {item.status='failed'; this.step(runId,iteration,'proposal','rejected',parsed.problem,{taskId:item.task.taskId});}
            if(parsed?.kind==='proposal') taskPaths.set(item.task.taskId,parsed.proposal.changes.map(c=>c.path));
            if(parsed?.kind==='proposal') for(const change of parsed.proposal.changes) {if(paths.has(change.path)) conflict=true; paths.add(change.path); changes.push(change);}
          }
          if(conflict) this.step(runId,iteration,'task-conflict','conflict','Propostas sobrepõem arquivos. Nenhuma alteração desta rodada foi aplicada; revisão necessária.',{paths:[...paths],tasks:wave.map(t=>t.taskId)});
          if(!conflict && github && changes.length && results.every(r=>r.status==='completed')) {
            const merged='\x60\x60\x60orquestrador-changes\n'+JSON.stringify({baseCommit,message:'Join independent task proposals',changes})+'\n\x60\x60\x60';
            const applied=await this.applyProposal({runId,sessionId,iteration,github,answer:merged,objective,signal});
            proposalsApplied=applied.applied;
            if(applied.feedback) {proposalFeedback=applied.feedback; if(!applied.applied) conflict=true;}
          }
          for(const item of results) {
            const status=conflict?'conflict':taskPaths.has(item.task.taskId)&&!proposalsApplied?'not-applied':item.status;
            if(status==='completed') completed.add(item.task.taskId);
            outcomes.push({taskId:item.task.taskId,status,summary:item.result?.answer.slice(0,6000)??'Sem resultado',invocationId:item.result?.record.invocationId,changedFiles:status==='completed'?(taskPaths.get(item.task.taskId)??[]):[]});
          }
        }
        unresolvedDelegations = outcomes.some(o=>o.status!=='completed');
        this.step(runId,iteration,'task-join',outcomes.every(o=>o.status==='completed')?'completed':'partial','Resultados reunidos para revisão do Codex.',{outcomes});
        feedback='JOIN — review every task status, evidence and pending criteria. Failed/cancelled/conflicting proposals were not applied. Do not repeat mechanical failures.\n'+JSON.stringify(outcomes)+'\n'+(proposalFeedback??'');
        if(outcomes.some(o=>o.status==='failed' && /file|conte[uú]do/i.test(o.summary))) {
          this.database.runs.setStatus(runId,'NEEDS_HUMAN','Falha mecânica no pacote de contexto.');
          this.progress(runId,sessionId,'needs-human','Entrega de contexto precisa de revisão.','NEEDS_HUMAN'); return;
        }
        continue;
      }

      if (decision.action === 'delegate') {
        const task = decision.task ?? objective;

        // Which worker, and can it do what was asked? Both questions are the
        // application's, not the model's: a decision naming a worker the team
        // does not have is answered with the real list, and a delegation that
        // needs files changed is refused for a connection that cannot change
        // them. Neither is silently redirected to some other connection.
        const chosen = this.chooseWorker(team, decision, conversation);
        if (!chosen.ok) {
          this.step(runId, iteration, 'delegation', 'refused', chosen.reason);
          this.say(sessionId, runId, 'system', chosen.reason);
          feedback = chosen.feedback;
          continue;
        }
        const slot = chosen.slot;

        const spend = budget.check();
        if (!spend.allowed) return this.finishAtBudget(runId, sessionId, spend.reason, budget);
        if (spend.warning) this.say(sessionId, runId, 'system', spend.warning);

        this.progress(runId, sessionId, 'worker', `${slot.label} executando...`, 'RUNNING', {
          workerId: slot.id,
          workerLabel: slot.label,
        });
        // The last chance to stop before a model is paid for. A cancellation
        // that arrived while the supervisor was thinking used to be noticed
        // only after the worker had already been started.
        if (this.stopping(runId, signal)) return this.finishCancelled(runId, sessionId);
        lastDelegatedWorkerId = slot.id;
        const delegated = await this.delegate({
          runId,
          sessionId,
          workspace,
          cwd,
          runners,
          slot,
          iteration,
          task,
          decision,
          correlationId: runCorrelation,
          causationId: decisionMessageId,
          routing: slot.routing ?? null,
          capabilities: capabilitiesOf.get(slot.id) ?? NO_CAPABILITIES,
          attempts: attemptsByWorker.get(slot.id)!,
          unavailableModels: unavailableByWorker.get(slot.id)!,
          signal,
          budget,
          github,
          fileReads: carriedReads,
        });
        // A policy/budget pause must not invoke the supervisor again or apply proposals.
        if (this.database.runs.require(runId).status === 'NEEDS_HUMAN') return;
        record.worker = delegated.record;
        iterationAnswer = delegated.answer;
        if (delegated.answer.trim()) lastWorkerAnswer = delegated.answer;

        if (carriedReads.length && missingFilePayload(delegated.answer)) {
          const reason = 'file-read/not-carried: o worker relatou ausência do conteúdo esperado. Entrega de contexto precisa ser reparada; repetir ou escalar não resolve.';
          record.worker.mechanical = true;
          this.reportDelegation({ runId, sessionId, iteration, worker: record.worker, answer: delegated.answer, evidence: null, previousEvidence: null, readFiles: [], verifications: [], unproven: ledger.pending().map(c => c.text), failedCriteria: [] });
          this.step(runId, iteration, 'file-read', 'not-carried', reason);
          this.database.runs.setStatus(runId, 'NEEDS_HUMAN', reason);
          this.say(sessionId, runId, 'system', reason);
          this.progress(runId, sessionId, 'needs-human', reason, 'NEEDS_HUMAN');
          return;
        }

        // The worker described a change; the application performs it. This is
        // the line that keeps a paragraph about an edit from being counted as
        // an edit - and it is where the change becomes real, before any
        // evidence is collected, so the measurement below sees the commit.
        if (github) {
          const applied = await this.applyProposal({
            runId,
            sessionId,
            iteration,
            github,
            answer: delegated.answer,
            objective,
            signal,
            agentId:slot.agentId,
          });
          if (applied.feedback) proposalFeedback = applied.feedback;
        }

        // A provider that will keep refusing must stop the run rather than be
        // asked again eight times: an empty balance and a rejected credential
        // are not made better by another attempt, and each attempt may cost.
        const terminal = terminalFailure(
          delegated.record.failure,
          delegated.record.failureDetail ?? null,
        );
        if (terminal) {
          // A refused tool is the one terminal failure a person can actually
          // resolve, so it gets a request they can answer rather than a
          // sentence telling them to authorise something with no way to.
          const requests =
            delegated.record.failure === 'tool-permission-denied'
              ? this.askForPermission({
                  runId,
                  sessionId,
                  workspaceId: workspace.id,
                  iteration,
                  agentId: chosen.slot.agentId ?? workspace.worker_agent_id,
                  accountId: chosen.slot.accountId,
                  workingDirectory: cwd,
                  calls: delegated.record.deniedCalls ?? [],
                  tools: delegated.record.deniedTools ?? [],
                })
              : [];
          // A delegation that died before answering still gets a report,
          // built from the process rather than from a summary nobody wrote.
          record.workerReport = this.reportDelegation({
            runId,
            sessionId,
            iteration,
            worker: delegated.record,
            answer: delegated.answer,
            evidence: null,
            previousEvidence: null,
            readFiles: [],
            verifications: [],
            unproven: ledger.pending().filter((c) => c.status !== 'failed').map((c) => c.text),
            failedCriteria: ledger.pending().filter((c) => c.status === 'failed').map((c) => c.text),
          });
          const reason =
            requests.length > 0
              ? `${terminal} Há ${requests.length} pedido(s) de autorização aguardando você.`
              : terminal;
          this.database.runs.setStatus(runId, 'NEEDS_HUMAN', reason);
          this.say(sessionId, runId, 'system', reason);
          this.step(runId, iteration, 'worker', 'needs-human', reason, {
            ...(requests.length > 0 ? { permissionRequests: requests.map((r) => r.id) } : {}),
          });
          this.progress(
            runId,
            sessionId,
            requests.length > 0 ? 'awaiting-approval' : 'needs-human',
            reason,
            'NEEDS_HUMAN',
          );
          return;
        }
        if (this.stopping(runId, signal)) return this.finishCancelled(runId, sessionId);
      }

      // 3. Collect evidence ourselves, whatever the worker claims.
      //
      // A conversation run collects none, and says so by having none: it must
      // never report a diff or a changed file, because there is no working
      // copy for one to have happened in.
      if (!collector && !github) {
        // In a conversation run there is no command to run, so the check is
        // the orchestrator's own review of an answer a *different* agent
        // produced. That is still not self-certification: a worker cannot
        // write this field, because only the orchestrator produces decisions.
        for (const criterion of decision.satisfiedCriteria ?? []) {
          ledger.markByText(criterion, 'satisfied', iteration, 'Revisado pelo orquestrador.');
        }
        feedback = this.buildConversationFeedback(record, lastWorkerAnswer);
        if (decision.action === 'done') {
          const gate = await evaluateConversationDone({
            ledger,
            iterations,
            answer: decision.summary ?? lastWorkerAnswer,
          });
          record.doneRejection = gate.passed ? undefined : gate;
          this.step(
            runId,
            iteration,
            'done-gate',
            gate.passed ? 'passed' : 'rejected',
            gate.failures.join('; ').slice(0, 500) || 'resposta final aceita',
          );
          if (gate.passed) {
            const answer = (decision.summary ?? lastWorkerAnswer).trim();
            this.database.runs.setStatus(runId, 'DONE', 'Resposta final validada pelo orquestrador.');
            // The summary of a `done` decision *is* the answer, and it was
            // already said above as this iteration's summary. Saying it again
            // here would show the person the same paragraph twice.
            if (answer && answer !== decision.summary?.trim()) {
              this.say(sessionId, runId, 'orchestrator', answer);
            }
            this.sayCost(sessionId, runId, budget);
            this.progress(runId, sessionId, 'done', 'Concluído.', 'DONE');
            return;
          }
          feedback = formatDoneRejection(gate);
          this.say(sessionId, runId, 'system', 'A revisão final não passou; o orquestrador vai continuar.');
        }
        continue;
      }

      this.progress(runId, sessionId, 'evidence', 'Coletando alterações...', 'RUNNING');
      // The measurement, from whichever thing actually holds the code. Same
      // record either way, so the ledger, the report and the gate below do not
      // know or care which mode this run is.
      const evidence: GitEvidence = collector
        ? await collector.collectEvidence(baseline)
        : await this.collectGitHubEvidence(github!, signal);
      record.evidence = evidence;
      // Progress is measured against the tree the previous attempt left,
      // not against the baseline: an iteration that changes nothing after
      // one that did is "no progress", and the router must hear that.
      const tree = treeKey(evidence.statusShort, evidence.diff);
      if (record.worker) {
        record.worker.progressed = tree !== previousTree || (isReadOnlyObjective(objective) && carriedReads.some(r => r.ok) && !!iterationAnswer.trim());
        attemptsByWorker.get(lastDelegatedWorkerId)!.push({
          iteration,
          capability: record.worker.routing?.requestedCapability ?? 'BALANCED',
          reasoning: record.worker.routing?.requestedReasoning ?? 'MEDIUM',
          model: record.worker.routing?.resolvedModel ?? null,
          outcome: record.worker.outcome,
          exitCode: record.worker.exitCode,
          progressed: record.worker.progressed,
          mechanical: record.worker.mechanical ?? false,
          modelUnavailable: record.worker.modelUnavailable ?? false,
        });
      }
      previousTree = tree;
      this.step(
        runId,
        iteration,
        'evidence',
        evidence.changedSinceBaseline ? 'changed' : 'unchanged',
        `${evidence.changedFiles.length} arquivo(s)`,
      );
      // What the application saw for itself, sent by the application - not by
      // an agent. The sender is null on purpose: this is the one message in
      // the exchange that is not somebody's claim, and `source` records
      // whether git or a filesystem scan answered, because "nothing changed"
      // and "nothing could be observed" must never collapse into one fact.
      this.record({
        runId,
        conversationId: sessionId,
        iteration,
        messageType: 'EVIDENCE_READY',
        payload: {
          changed: evidence.changedSinceBaseline,
          files: evidence.changedFiles.length,
          source: evidence.source ?? null,
          problem: evidence.evidenceProblem ?? null,
        },
        senderAgentId: null,
        recipientAgentId: ORCHESTRATOR_AGENT,
        correlationId: runCorrelation,
      });
      // What actually changed, on the event itself. For a remote run this is
      // the only way a person sees real files and a real diffstat without the
      // repository ever reaching their computer.
      this.progress(
        runId,
        sessionId,
        'evidence',
        `${evidence.changedFiles.length} arquivo(s)`,
        'RUNNING',
        { evidence: toEvidenceView(evidence) },
      );
      if (evidence.changedSinceBaseline) {
        this.say(
          sessionId,
          runId,
          'system',
          `Alterações coletadas: ${describeFiles(evidence)}`,
        );
      }

      // 4. Run the verifications the orchestrator asked for, by id.
      const requested = decision.verificationCommands;
      let verification: CommandResult[] = [];
      let unknownIds: string[] = [];
      if (requested.length > 0) {
        this.progress(runId, sessionId, 'verification', 'Executando verificações...', 'RUNNING');
        const resolution = this.database.verifications.resolve(workspace.id, requested);
        unknownIds = resolution.unknown;
        for (const command of resolution.commands) resolvedCommands.add(command);
        // With no executor the command is refused and never runs, and that is
        // what the round reports. Silence here would leave a criterion the
        // command was meant to prove certified by nothing at all.
        verification = await (verifier ?? verifierWithoutExecutor(NO_EXECUTOR)).runAll(
          resolution.commands,
        );
        record.verification = verification;
        for (const result of verification) {
          this.database.runs.recordVerification({
            runId,
            iteration,
            definitionId: null,
            command: result.command,
            exitCode: result.exitCode,
            passed: commandPassed(result),
            refused: result.refused ?? null,
            durationMs: result.durationMs,
          });
        }
        const passed = verification.filter(commandPassed).length;
        this.step(runId, iteration, 'verification', 'done', `${passed}/${verification.length} passaram`);
        // The checks, re-run by the application. Also sent with a null sender:
        // a verification an agent could write would verify nothing.
        this.record({
          runId,
          conversationId: sessionId,
          iteration,
          messageType: 'VERIFICATION_RESULT',
          payload: { passed, total: verification.length },
          senderAgentId: null,
          recipientAgentId: ORCHESTRATOR_AGENT,
          correlationId: runCorrelation,
        });
      }

      // 4a. The checks the application performs by reading, not by running.
      //
      // A registered verification is a command a person approved once. A file
      // check is a *typed comparison* the main process does itself: open the
      // path, read the bytes, compare. Nothing here reaches a shell, and the
      // rule that only registered verifications may execute commands is
      // untouched - this executes none.
      //
      // It exists because a workspace with no registered verification could
      // not finish *anything*: with no command to run, every criterion the
      // supervisor stated was marked failed, and a failed criterion blocks the
      // gate for ever. A six-byte file was created correctly and the run still
      // died at the iteration limit.
      // The same mechanism against a commit when the project has no folder:
      // the application opens the file at the commit the work is at and
      // compares the same bytes with the same rule. A read is not a check and
      // neither is a functional test, in either mode.
      // The listing the supervisor asked for, answered by the application from
      // the tree it already holds. No worker, no shell, no clone - and no
      // asking the person for a path they should never have to know.
      let listingBlock: string | null = null;
      if (github && decision.listFiles) {
        if (github.tree) {
          const listing = listFiles(github.tree, decision.listFiles);
          listingBlock = renderListing(
            listing,
            github.tree,
            `FILES YOU ASKED FOR (${describeListRequest(decision.listFiles)}), ` +
              `${listing.matched} correspondente(s):`,
          );
          this.step(
            runId,
            iteration,
            'repository-tree',
            'listed',
            `${describeListRequest(decision.listFiles)} -> ${listing.paths.length} de ${listing.matched}`,
          );
        } else {
          // One more attempt, because the supervisor asking is the moment it
          // matters most - and because a run must not stop for something the
          // application can still go and fetch.
          try {
            github.tree = await github.service.tree(github.workspaceId, github.headCommit, signal);
            github.treeProblem = null;
            const listing = listFiles(github.tree, decision.listFiles);
            listingBlock = renderListing(listing, github.tree, 'FILES YOU ASKED FOR:');
            this.step(runId, iteration, 'repository-tree', 'read', `${listing.matched} arquivo(s)`);
          } catch (error) {
            const problem = error instanceof Error ? error.message : String(error);
            github.treeProblem = problem;
            listingBlock =
              `NÃO CONSEGUI LISTAR OS ARQUIVOS: ${problem}. Isso não diz que o repositório está ` +
              'vazio; diz que a listagem falhou.';
            this.step(runId, iteration, 'repository-tree', 'unavailable', problem.slice(0, 500));
          }
        }
      }

      const fileChecks =
        decision.fileChecks.length === 0
          ? []
          : github
            ? await this.githubChecks(github, decision.fileChecks, signal)
            : environment?.kind === 'local'
              ? await runFileChecks(cwd, decision.fileChecks)
              : [];
      for (const request of decision.fileChecks) {
        requestedFileChecks.set(JSON.stringify(request), request);
      }
      if (fileChecks.length > 0) {
        record.fileChecks = fileChecks;
        const passedChecks = fileChecks.filter((check) => check.passed).length;
        this.step(
          runId,
          iteration,
          'file-check',
          passedChecks === fileChecks.length ? 'passed' : 'failed',
          fileChecks.map(describeFileCheck).join('; ').slice(0, 500),
        );
        for (const check of fileChecks) {
          this.database.runs.recordVerification({
            runId,
            iteration,
            definitionId: null,
            // Recorded as what it is - a read, not a command line - so nobody
            // reading the history later mistakes it for something that ran.
            command: `[leitura direta] ${check.request.path}`,
            exitCode: check.passed ? 0 : 1,
            passed: check.passed,
            refused: check.outcome === 'outside-workspace' ? check.problem : null,
            durationMs: null,
          });
        }
        this.record({
          runId,
          conversationId: sessionId,
          iteration,
          messageType: 'VERIFICATION_RESULT',
          payload: { passed: passedChecks, total: fileChecks.length, kind: 'file-check' },
          senderAgentId: null,
          recipientAgentId: ORCHESTRATOR_AGENT,
          correlationId: runCorrelation,
        });
      }

      // Evidence, not assertion, is what marks a criterion satisfied.
      //
      // Two changes here, and the second is the bug that deadlocked the run.
      //
      // A file check settles the criteria it *names*, and only those: binding
      // a result to what it actually proves is the difference between evidence
      // and a blanket assertion.
      for (const check of fileChecks) {
        for (const criterion of check.request.criteria ?? []) {
          ledger.markByText(
            criterion,
            check.passed ? 'satisfied' : 'failed',
            iteration,
            check.problem ?? describeFileCheck(check),
          );
        }
      }

      // A registered command keeps the meaning it always had: it proves the
      // criteria of the decision that asked for it, as a set.
      //
      // A file check deliberately does **not** join that blanket. It settles
      // the criteria it names and nothing else - the difference between "the
      // application read this file and it holds these bytes" and "a file
      // exists, so everything must be fine". A check that names no criteria
      // is recorded and settles nothing, which is the honest reading of it.
      const commandsRan = verification.length > 0;
      const commandsAllPassed =
        commandsRan && verification.every(commandPassed) && unknownIds.length === 0;
      for (const criterion of decision.acceptanceCriteria) {
        // Already decided by something that actually looked at it.
        if (settledByFileCheck(fileChecks, criterion)) continue;
        // And a criterion nothing checked is **unknown**, not failed. Marking
        // it failed said "the evidence is against you" when the truth was
        // "nobody looked" - and since the gate treats failed as final, a
        // workspace with no registered verification could never finish
        // anything at all, however correct the work was.
        if (!commandsRan) continue;
        ledger.markByText(
          criterion,
          commandsAllPassed ? 'satisfied' : 'failed',
          iteration,
          verificationNote(verification),
        );
      }

      let objectiveProofProblems: string[] = [];
      if (decision.action === 'done' && objectiveIntent.readProofs.length) {
        const delivered = iterations.slice(0, -1).flatMap(r => r.fileReads ?? []).flatMap(r => { const d=supervisorFiles.deliveries.find(d=>d.path===r.request.path && d.sha256===r.sha256 && d.range.start===(r.request.offsetBytes??0) && d.state==='SUPERVISOR_CARRIED'); return d && r.text!==null ? [{...r,text:Buffer.from(r.text).subarray(0,d.bytesSent).toString('utf8')}] : []; });
        // Metadata facts are tied to the opened snapshot, never to a worker's
        // proposed write. Content still must have reached the supervisor.
        const currentFacts=queryEvidence.filter(f=>!github||f.commit===github.headCommit);
        const readIntent=objectiveIntent.targets.length?objectiveIntent:{...objectiveIntent,targets:decision.fileChecks.map(c=>c.path)};
        objectiveProofProblems = readProofProblems(readIntent, decision.summary ?? '', decision.queryProof, delivered, currentFacts);
        if(objectiveIntent.kind==='READ_ONLY_QUERY'&&evidence.changedSinceBaseline)objectiveProofProblems.push('A read-only objective unexpectedly changed files.');
        this.step(runId, iteration, 'query-proof', objectiveProofProblems.length ? 'rejected' : 'passed', objectiveProofProblems.join('; ') || 'Consulta comprovada: '+objectiveIntent.readProofs.join(', '), { proof: decision.queryProof, evidence:currentFacts });
        if (!objectiveProofProblems.length) {
          for(const criterion of decision.queryProof?.criteria??decision.acceptanceCriteria) {
            const criterionIntent=classifyObjective(criterion);
            // Auto-proof of metadata cannot certify a test/change criterion.
            if(!decision.queryProof && (criterionIntent.kind!=='READ_ONLY_QUERY'||readProofProblems(criterionIntent,decision.summary??'',undefined,delivered,currentFacts).length))continue;
            ledger.markByText(criterion,'satisfied',iteration,'Consulta comprovada por evidência independente.');
          }
        }
      }

      // 4a. What the worker did, assembled from what already came back.
      if (record.worker) {
        record.workerReport = this.reportDelegation({
          runId,
          sessionId,
          iteration,
          worker: record.worker,
          answer: iterationAnswer,
          evidence,
          previousEvidence,
          readFiles: fileReads.map((read) => read.request.path),
          verifications: [
            ...verification.map((result) => ({
              label: result.command,
              passed: commandPassed(result),
              ...(commandPassed(result)
                ? {}
                : {
                    problem: result.refused
                      ? `recusada: ${result.refused}`
                      : result.timedOut
                        ? 'tempo esgotado'
                        : `exit ${result.exitCode}`,
                  }),
            })),
            ...fileChecks.map((check) => ({
              label: `[leitura direta] ${check.request.path}`,
              passed: check.passed,
              ...(check.passed ? {} : { problem: check.problem ?? describeFileCheck(check) }),
            })),
          ],
          unproven: ledger
            .pending()
            .filter((c) => c.status !== 'failed')
            .map((c) => c.text),
          failedCriteria: ledger
            .pending()
            .filter((c) => c.status === 'failed')
            .map((c) => c.text),
        });
      }

      /** Every proof that actually ran this iteration came back clean. */
      const allPassed =
        (commandsRan || fileChecks.length > 0) &&
        verification.every(commandPassed) &&
        fileChecks.every((check) => check.passed) &&
        unknownIds.length === 0;

      // 4b. The short path for a small, finished task.
      //
      // Measured, not guessed: creating a six-byte file cost **three** CLI
      // invocations (plan, work, review) and ran the verification command
      // **three** times. The third invocation is an orchestrator round trip
      // whose only job is to say `done` about work the *application* has
      // already proved: it collected the evidence itself and ran the
      // verifications itself, and both agreed.
      //
      // So when all of this holds, the loop asks the gate directly:
      //
      //  - the worker just ran and did not fail;
      //  - the application's own evidence shows the tree changed;
      //  - the orchestrator asked for verifications, every id resolved, and
      //    every one of them passed;
      //  - every acceptance criterion of this decision is satisfied.
      //
      // Nothing is weakened by this. The DoneGate is untouched, still
      // independent, and still re-runs every verification from scratch against
      // freshly collected evidence - it is the authority here exactly as it is
      // on the long path. What is skipped is asking a model to agree with a
      // result the application can already see. If the gate rejects, the run
      // continues normally with the rejection as feedback, so the short path
      // can never turn a failure into a success; it can only cost one wasted
      // gate evaluation, once per run.
      const fastPathEligible =
        this.options.fastPath !== false &&
        !fastPathTried &&
        decision.action === 'delegate' &&
        record.worker !== undefined &&
        !record.worker.failure &&
        evidence.changedSinceBaseline &&
        allPassed &&
        decision.acceptanceCriteria.length > 0 &&
        ledger.allSatisfied(decision.acceptanceCriteria);

      if (fastPathEligible) {
        fastPathTried = true;
        this.progress(runId, sessionId, 'review', 'Validação independente...', 'RUNNING');
        const fresh = collector
          ? await collector.collectEvidence(baseline)
          : await this.collectGitHubEvidence(github!, signal);
        const gate = await evaluateDone({
          objectiveIntent,
          objectiveProofProblems: objectiveIntent.readProofs.length ? ['Read obligations require supervisor review.'] : [],
          ledger,
          verificationCommands: [...resolvedCommands],
          iterations,
          baseline,
          evidence: fresh,
          // With no executor a verification command is refused and never runs,
          // which the gate reads as no proof at all. That is the honest answer
          // and the one the person asked for: never an invented PASS.
          verifier: verifier ?? verifierWithoutExecutor(NO_EXECUTOR),
          // Only the requested operations determine whether a diff is required.
          allowNoChanges: !objectiveIntent.requiresChanges,
          fileChecks: [...requestedFileChecks.values()],
          workspaceRoot: cwd,
          ...(github ? { readFileChecks: (requests) => this.githubChecks(github!, requests, signal) } : {}),
        });
        this.step(
          runId,
          iteration,
          'done-gate',
          gate.passed ? 'passed' : 'rejected',
          gate.passed
            ? 'caminho rápido: evidência e verificações já provavam a tarefa'
            : gate.failures.join('; ').slice(0, 500),
        );
        if (gate.passed) {
          record.doneRejection = undefined;
          // The work is on a branch and the person needs somewhere to review
          // it. A pull request is offered, never a merge - and only when this
          // run actually committed something, so a run that changed nothing
          // does not open an empty PR to look productive.
          if (github) await this.publishGitHubWork(runId, sessionId, github, objective, signal);
          this.database.runs.setStatus(runId, 'DONE', 'Validação independente aprovada.');
          this.say(
            sessionId,
            runId,
            'system',
            'Tarefa concluída e verificada. O orquestrador não precisou de outra rodada: ' +
              'as verificações que o aplicativo executou já cobriam os critérios.',
          );
          this.sayCost(sessionId, runId, budget);
          this.progress(runId, sessionId, 'done', 'Tarefa concluída.', 'DONE');
          return;
        }
        // The gate said no. Nothing is lost: the run goes on exactly as it
        // would have, with the gate's reasons as the orchestrator's feedback.
        record.doneRejection = gate;
        if(stopRepeatedRejection(gate,record,fresh))return;
        feedback = formatDoneRejection(gate);
        this.say(sessionId, runId, 'system', 'A validação final não passou; o orquestrador vai revisar.');
        continue;
      }

      // 5. `done` is a request. The gate decides.
      if (decision.action === 'done') {
        this.progress(runId, sessionId, 'review', 'Codex revisando...', 'RUNNING');
        const fresh = collector
          ? await collector.collectEvidence(baseline)
          : await this.collectGitHubEvidence(github!, signal);
        const gate = await evaluateDone({
          objectiveIntent,
          objectiveProofProblems,
          ledger,
          verificationCommands: [...resolvedCommands],
          iterations,
          baseline,
          evidence: fresh,
          // With no executor a verification command is refused and never runs,
          // which the gate reads as no proof at all. That is the honest answer
          // and the one the person asked for: never an invented PASS.
          verifier: verifier ?? verifierWithoutExecutor(NO_EXECUTOR),
          // Only the requested operations determine whether a diff is required.
          allowNoChanges: !objectiveIntent.requiresChanges,
          fileChecks: [...requestedFileChecks.values()],
          workspaceRoot: cwd,
          ...(github ? { readFileChecks: (requests) => this.githubChecks(github!, requests, signal) } : {}),
        });
        record.doneRejection = gate.passed ? undefined : gate;
        this.step(runId, iteration, 'done-gate', gate.passed ? 'passed' : 'rejected', gate.failures.join('; ').slice(0, 500));

        if (gate.passed) {
          // The work is on a branch and the person needs somewhere to review
          // it. A pull request is offered, never a merge - and only when this
          // run actually committed something, so a run that changed nothing
          // does not open an empty PR to look productive.
          if (github) await this.publishGitHubWork(runId, sessionId, github, objective, signal);
          this.database.runs.setStatus(runId, 'DONE', 'Validação independente aprovada.');
          if(objectiveIntent.kind!=='READ_ONLY_QUERY')this.say(sessionId, runId, 'orchestrator', 'Tarefa concluída e verificada.');
          this.sayCost(sessionId, runId, budget);
          this.progress(runId, sessionId, 'done', 'Tarefa concluída.', 'DONE');
          return;
        }
        if(stopRepeatedRejection(gate,record,fresh))return;
        feedback = formatDoneRejection(gate);
        this.say(sessionId, runId, 'system', 'A validação final não passou; o orquestrador vai revisar a prova necessária.');
        continue;
      }

      // 6. Otherwise, feed the results back and go round again - unless going
      //    round again could not possibly help.
      //
      //    An iteration that asked for a verification id nobody registered,
      //    proved nothing, and stated criteria it cannot settle is a loop with
      //    no exit: the same request will be refused the same way. Stopping
      //    here with a concrete reason is better than spending the iteration
      //    budget discovering it, and far better than escalating the model -
      //    no model can register a verification.
      const provedNothingWithUnknownIds =
        unknownIds.length > 0 &&
        verification.length === 0 &&
        fileChecks.length === 0 &&
        ledger.pending().length > 0;
      // The *second* time in a row, not the first. The first refusal is
      // information the orchestrator has not seen yet: it is told which ids do
      // not exist and that file checks need no registration, and it deserves
      // the chance to ask for one. Asking again for ids that still do not
      // exist, having proved nothing, is the loop with no exit.
      barrenVerifyRounds = provedNothingWithUnknownIds ? barrenVerifyRounds + 1 : 0;
      if (barrenVerifyRounds >= 2) {
        const reason =
          `A execução pediu duas vezes seguidas verificações que não existem neste ` +
          `projeto (${unknownIds.join(', ')}) e não produziu nenhuma prova. ` +
          'Cadastre a verificação em Configurações, ou peça uma verificação direta de ' +
          'arquivo — o aplicativo lê o arquivo e compara os bytes sem precisar de cadastro. ' +
          'Repetir a mesma delegação não mudaria nada, então parei aqui.';
        this.database.runs.setStatus(runId, 'NEEDS_HUMAN', reason);
        this.say(sessionId, runId, 'system', reason);
        this.step(runId, iteration, 'verification', 'unavailable', reason, {
          unknownIds: [...unknownIds],
          pending: ledger.pending().map((criterion) => criterion.text),
        });
        this.progress(runId, sessionId, 'needs-human', reason, 'NEEDS_HUMAN');
        return;
      }

      // Two rounds that produced nothing new.
      //
      // The incident: the supervisor asked the worker for the full contents of
      // the same four files, got a truncated answer, kept the same criteria
      // pending, and asked again - climbing to Opus/Alto on the way, for a
      // problem no model was going to solve. Repeating a strategy that has
      // already produced the same evidence twice is not persistence, it is a
      // loop, and it costs a delegation each time round.
      //
      // Measured on *evidence*, not on the decision: two different-sounding
      // instructions that leave the workspace, the verifications and the
      // ledger exactly as they were are the same round twice.
      const fingerprint = evidenceFingerprint({
        tree: tree + JSON.stringify(carriedReads.map(r => [r.request.path, r.sha256, r.request.offsetBytes ?? 0])),
        verification,
        fileChecks,
        pending: ledger.pending().map((criterion) => `${criterion.status}:${criterion.text}`),
      });
      stagnantRounds = fingerprint === previousFingerprint ? stagnantRounds + 1 : 0;
      previousFingerprint = fingerprint;
      if (stagnantRounds >= 2) {
        const pending = ledger.pending().map((criterion) => criterion.text);
        const reason =
          'Duas iterações seguidas não produziram nenhuma evidência nova: o workspace, as ' +
          'verificações e os critérios estão exatamente como estavam. Repetir a mesma ' +
          'estratégia não muda isso, e um modelo mais forte também não. ' +
          (pending.length > 0
            ? `Falta comprovar: ${pending.slice(0, 4).map((c) => `"${c}"`).join('; ')}. `
            : '') +
          'Cadastre uma verificação, aponte uma verificação direta de arquivo, ou diga o que ' +
          'aceitar como prova.';
        this.database.runs.setStatus(runId, 'NEEDS_HUMAN', reason);
        this.say(sessionId, runId, 'system', reason);
        this.step(runId, iteration, 'progress', 'stagnant', reason, { pending });
        this.progress(runId, sessionId, 'needs-human', 'Sem evidência nova', 'NEEDS_HUMAN');
        return;
      }

      // Kept for the next iteration's report, so it can say what *that*
      // delegation changed rather than repeating the run's whole diff.
      previousEvidence = evidence;

      feedback = this.buildFeedback(evidence, verification, unknownIds, record, ledger);
      // The paths the supervisor asked for, in front of it for the next round.
      if (listingBlock) feedback = `${listingBlock}\n\n${feedback}`;
      // A proposal that was refused says something the diff cannot: the next
      // round has to hear *why* nothing landed, or it proposes the same thing
      // again. Consumed here so one refusal is reported once.
      if (proposalFeedback) {
        feedback = `${proposalFeedback}\n\n${feedback}`;
        proposalFeedback = null;
      }
    }

    this.database.runs.setStatus(runId, 'FAILED', `Limite de ${maxIterations} iterações atingido.`);
    this.step(runId, maxIterations, 'limit', 'reached', `Limite de ${maxIterations} iterações atingido.`);
    this.say(sessionId, runId, 'system', `Parei após ${maxIterations} iterações sem concluir.`);
    this.progress(runId, sessionId, 'failed', 'Limite de iterações atingido.', 'FAILED');
  }

  /**
   * The conversation before this run: the person's messages and the loop's
   * own outcomes, bounded. Enough for "continue" to mean something.
   */
  private conversationBefore(sessionId: string, runId: string): string | null {
    const messages = this.database.chat
      .listMessages(sessionId)
      .filter((m) => m.run_id !== runId)
      .filter((m) => m.author === 'user' || m.author === 'orchestrator' || m.author === 'system')
      .slice(-12);
    if (messages.length === 0) return null;
    const lines = messages.map((m) => {
      const who = m.author === 'user' ? 'USER' : m.author === 'orchestrator' ? 'ORCHESTRATOR' : 'SYSTEM';
      return `${who}: ${m.body.replace(/\s+/g, ' ').trim().slice(0, 400)}`;
    });
    const text = lines.join('\n');
    return text.length > 4000 ? `...\n${text.slice(-4000)}` : text;
  }

  /**
   * One parse attempt, then one format-repair attempt, then give up - saying
   * exactly why.
   *
   * The repair is a *new* CLI process with no memory of the first one, so it
   * is sent the original prompt again with the correction appended; a repair
   * request on its own would ask a model that never saw the objective to
   * "repeat the same decision". Every attempt leaves a step with the CLI's
   * outcome, exit code, the parse problem and redacted excerpts of what it
   * printed, which is what "Detalhes" shows.
   */
  private async askForDecision(input: {
    runId: string;
    workspace: WorkspaceWithAgents;
    /** The repository path **inside the environment this run executes in**. */
    cwd: string;
    runners: RunnerPair;
    prompt: string;
    iteration: number;
    signal: AbortSignal;
    /** Counts what each attempt consumed, so a repair round trip is not free. */
    budget: BudgetLedger;
    /** Told what the adapter actually sent for model and level, once per attempt. */
    onApplied?: (applied: NonNullable<AgentResult['applied']>) => void;
  }): Promise<{ decision: Decision | null; failure?: string; policyBlocked?: boolean }> {
    const { runId, workspace, cwd, runners, iteration, signal } = input;
    const accountId = this.orchestratorAccountId(workspace);
    this.checkAgent(workspace.orchestrator_agent_id, accountId);
    const policy = this.policyFor(accountId, workspace.orchestrator_agent_id);
    const agent = workspace.orchestrator_agent_id ? this.database.agents.find(workspace.orchestrator_agent_id) : undefined;
    const config = agent ? agentConfig(agent.runtime_options) : {};
    const pinned = orchestratorSelectionOf(workspace) === 'manual';
    const models = {FAST:'gpt-5.1-codex-mini',BALANCED:'gpt-5.1-codex',STRONG:'gpt-5.3-codex',MAX:'gpt-5.3-codex'};
    const connection = accountId ? this.database.accounts.find(accountId) : undefined;
    const model = config.policy?.primaryModel ?? (pinned ? workspace.orchestrator_model : agent?.model ?? connection?.default_model ?? (policy.maxCapability ? (connection?.provider_id==='anthropic'?{FAST:'haiku',BALANCED:'sonnet',STRONG:'opus',MAX:'opus'}:models)[policy.maxCapability] : null));
    const reasoning = pinned ? workspace.orchestrator_reasoning : config.reasoning ?? connection?.default_reasoning ?? null;
    const route = routeWorkerModel({provider:connection?.provider_id==='anthropic'?'anthropic':'openai', accountId, task:'supervision',requested:null,previousAttempts:[],selection:'manual',
      manual:{model,reasoning},policy,capabilities:{modelFlag:true,effortFlag:true,declaredModels:null,declaredEfforts:['low','medium','high','xhigh','max']}});
    const routeNote = `Orquestrador solicitado ${model ?? 'padrão'}/${reasoning ?? 'padrão'}; teto ${policy.maxCapability ?? 'sem teto'}/${policy.maxReasoning ?? 'sem teto'}; ${route.selectionReason}`;
    this.step(runId,iteration,'routing',route.policyBlocked?'blocked':'resolved',routeNote);
    if (route.policyBlocked && !config.policy) return {decision:null,failure:routeNote,policyBlocked:true};
    let currentPrompt = input.prompt;
    let lastProblem = 'nenhuma resposta';
    let lastExcerpt = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const startedAt = new Date().toISOString();
      let activeInvocationId: string | undefined;
      const beforeInvocation = () => { activeInvocationId ??= this.database.runs.recordInvocation({runId, iteration, agentId: workspace.orchestrator_agent_id, accountId: this.orchestratorAccountId(workspace), role: 'ORCHESTRATOR', task: null, outcome: 'running', exitCode: null, durationMs: null, startedAt}); };
      this.progress(runId, this.database.runs.require(runId).session_id ?? '', 'orchestrator', 'Codex analisando...', 'RUNNING');
      const result = await new AgentExecutionPolicy(this.database).invoke({workspaceId:workspace.id,agentId:workspace.orchestrator_agent_id,accountId,runner:runners.orchestrator,beforeInvocation,args:{
        prompt: currentPrompt,
        routing:{model:route.resolvedModel,reasoning:route.resolvedReasoning},
        strictRouting:!!(policy.maxCapability || policy.maxReasoning),
        workingDirectory: cwd,
        timeoutMs: this.options.agentTimeoutMs ?? DEFAULTS.agentTimeoutMs,
        runId,
        iteration,
      }});
      // Counted before anything is decided about the answer: a repair round
      // trip is a second call and costs a second time.
      if(!result.invocationSkipped) input.budget.record(result.usage ?? null);
      const orchestratorCapabilities = capabilitiesOfRunner(runners.orchestrator);
      if(!result.invocationSkipped) this.database.runs.recordInvocation({
        id: activeInvocationId,
        runId,
        iteration,
        agentId: workspace.orchestrator_agent_id,
        accountId: this.orchestratorAccountId(workspace),
        role: 'ORCHESTRATOR',
        task: null,
        providerId: orchestratorCapabilities?.providerId ?? null,
        connectionKind: orchestratorCapabilities?.connectionKind ?? null,
        usage: result.usage
          ? {
              billing: result.usage.billing,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              totalTokens: result.usage.totalTokens,
              costUsd: result.usage.costUsd,
            }
          : null,
        failureKind: result.failure ?? null,
        outcome: result.outcome,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        startedAt,
        // Same diagnosis as the worker's. A supervisor that fails without
        // explanation is the same blank screen as a worker that does.
        diagnostics: {
          failureDetail: result.failureDetail ?? null,
          stderrExcerpt: result.stderr || null,
          executable: result.executable ?? null,
          version: result.version ?? null,
          signal: result.signal ?? null,
          lastActivityAt: result.activity?.lastActivityAt ?? null,
          idleTimeoutMs: result.activity?.idleTimeoutMs ?? null,
          currentTool: result.activity?.currentTool ?? null,
          workingDirectory: cwd,
        },
        // The orchestrator's model and level are the person's fixed choice;
        // what is recorded is what the adapter really sent, after checking
        // the level against the installed build.
        routing: result.applied
          ? {
              requestedCapability: null,
              requestedReasoning: null,
              resolvedModel: result.applied.model,
              resolvedReasoning: result.applied.reasoning,
              observation:{actualModel:result.observed?.model??null,actualReasoning:result.observed?.reasoning??null,ceiling:`${policy.maxCapability??'sem teto'}/${policy.maxReasoning??'sem teto'}`,capped:`${route.capability}/${route.reasoning}`},
              selectionMode: 'fixed',
              selectionReason: routeNote + '; ' + (result.applied.note
                ? result.applied.note
                : 'configuração fixa do orquestrador' +
                  (workspace.orchestrator_model || workspace.orchestrator_reasoning ? '' : ' (padrão do CLI)')),
              fallbackUsed: result.applied.fallbackUsed,
            }
          : null,
      });
      if (result.applied) input.onApplied?.(result.applied);
      if (signal.aborted) return { decision: null };
      if(result.invocationSkipped) return {decision:null,failure:result.failureDetail??result.stderr,policyBlocked:true};

      const diagnostics = {
        attempt,
        outcome: result.outcome,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ...(result.executable ? { executable: result.executable } : {}),
        stdoutExcerpt: excerpt(result.stdout),
        stderrExcerpt: excerpt(result.stderr),
        ...(result.error ? { error: result.error } : {}),
      };

      if (result.outcome !== 'completed') {
        const problem =
          result.outcome === 'timeout'
            ? `o Codex não respondeu em ${Math.round((this.options.agentTimeoutMs ?? DEFAULTS.agentTimeoutMs) / 60_000)} min`
            : `o Codex não concluiu (${result.outcome}${result.exitCode !== null ? `, código ${result.exitCode}` : ''})`;
        const said = errorLine(result.stderr) || errorLine(result.stdout) || result.error || '';
        this.step(runId, iteration, 'orchestrator', 'cli-failed', problem, diagnostics);
        return {
          decision: null,
          failure: `${capitalize(problem)}${said ? `: ${redact(said)}` : '.'}`,
        };
      }

      const parsed = parseDecision(result.stdout);
      if (!parsed.ok && result.exitCode !== 0) {
        // The CLI itself failed - a crashed models refresh, a refused login,
        // a missing flag. That is what the person must read, in the CLI's
        // own words; a repair prompt would only re-run the same crash.
        const problem = `o Codex saiu com código ${result.exitCode}`;
        const said = errorLine(result.stderr) || errorLine(result.stdout) || '';
        this.step(runId, iteration, 'orchestrator', 'cli-failed', problem, {
          ...diagnostics,
          parseError: parsed.error,
        });
        return {
          decision: null,
          failure: `${capitalize(problem)}${said ? `: ${redact(said)}` : '.'}`,
        };
      }
      if (parsed.ok) {
        this.step(runId, iteration, 'orchestrator', 'ok', parsed.decision.action, {
          response: result.stdout,
          decision: parsed.decision,
          attempt,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });
        return { decision: parsed.decision };
      }
      if (result.exitCode !== null && result.exitCode !== 0) {
        // The CLI ran and gave up - a usage limit, an expired login, a crash.
        // Its own words are the diagnosis; asking it to fix the format would
        // only repeat the same exit.
        const said = firstLine(result.stderr) || firstLine(result.stdout);
        const problem = `o Codex saiu com código ${result.exitCode}`;
        this.step(runId, iteration, 'orchestrator', 'exited', problem, {
          ...diagnostics,
          parseError: parsed.error,
        });
        return {
          decision: null,
          failure: `${capitalize(problem)}${said ? `: ${redact(said)}` : ' sem explicar.'}`,
        };
      }
      lastProblem = parsed.error;
      lastExcerpt = excerpt(result.stdout, 160);
      this.step(runId, iteration, 'orchestrator', 'unparsed', parsed.error, {
        ...diagnostics,
        parseError: parsed.error,
        exitCode: result.exitCode,
      });
      currentPrompt = `${input.prompt}\n\n${parsed.repairPrompt}`;
    }
    const failure =
      `O Codex respondeu duas vezes, mas não com uma decisão válida. ` +
      `Problema: ${lastProblem}` +
      (lastExcerpt ? ` A resposta começava com: "${redact(lastExcerpt)}"` : ' A resposta estava vazia.');
    this.step(runId, iteration, 'orchestrator', 'gave-up', failure);
    return { decision: null, failure };
  }

  private orchestratorAccountId(workspace: WorkspaceWithAgents): string | null {
    if (!workspace.orchestrator_agent_id) return null;
    return this.database.agents.find(workspace.orchestrator_agent_id)?.account_id ?? null;
  }

  private buildOrchestratorPrompt(input: {
    workspace: WorkspaceWithAgents;
    cwd: string;
    objective: string;
    baseline: Baseline;
    iteration: number;
    feedback: string | null;
    iterations: readonly IterationRecord[];
    history?: string | null;
    /** True for a run with no workspace: no git, no commands, no evidence. */
    conversation: boolean;
    /** Set when the project works straight against GitHub. */
    github?: GitHubRunContext | null;
    team: readonly WorkerSlot[];
    /** What the application measured about the folder. Null for a conversation. */
    preflight?: PreflightResult | null;
  }): string {
    const catalogue = input.conversation ? [] : this.database.verifications.list(input.workspace.id);
    const lines: string[] = [
      'You are the orchestrator of an agent team.',
      'You supervise; the workers below do the work. You never do it yourself.',
      '',
      `OBJECTIVE: ${input.objective}`,
      `ITERATION: ${input.iteration}`,
      '',
      // The team, by the ids a delegation may name. Spelling them out is what
      // lets `workerId` be validated instead of guessed at.
      'YOUR TEAM (delegate by "workerId", using exactly these ids):',
      ...input.team.map((slot) => {
        const capabilities = capabilitiesOfRunner(slot.runner);
        const can =
          capabilities === null
            ? 'reads, edits and runs things in the workspace'
            : capabilities.toolExecution
              ? 'reads, edits and runs things in the workspace'
              : 'analyses, plans and reviews only - CANNOT read, edit or run anything';
        const agent=slot.agentId?this.database.agents.find(slot.agentId):undefined;
        const policy=agent?agentConfig(agent.runtime_options).policy:undefined;
        return '  '+slot.id+' - '+slot.label+': role='+(agent?.role??'CODING_WORKER')+' taskKinds='+JSON.stringify(policy?.taskKinds??roleDefinition(agent?.role??'CODING_WORKER')?.taskKinds)+' tools='+JSON.stringify(policy?.tools??roleDefinition(agent?.role??'CODING_WORKER')?.tools)+'. '+can;
      }),
      '',
      // Which repository this project is, when it is one.
      //
      // The incident: a project connected to a GitHub repository asked whether
      // the orchestrator could reach it. The prompt said "there is no
      // repository", so the supervisor delegated a web fetch to find out, the
      // non-interactive runtime refused the tool for lack of authorisation,
      // and the answer came back reading as though the repository might not
      // exist. It did exist, and it was named right here in the project.
      ...(input.workspace.repository_url
        ? [
            `REPOSITORY: ${input.workspace.repository_url}` +
              (input.workspace.default_branch ? ` (branch ${input.workspace.default_branch})` : ''),
            '  This project IS connected to that repository. The application reads it through',
            '  the GitHub API; a worker does not fetch it, and must never be asked to. If you',
            '  need something from the repository that is not in front of you, say which part',
            '  is missing rather than delegating a fetch.',
            '  A refused tool is never evidence about the repository. If a worker reports a',
            '  refusal, that says the worker lacked a permission - nothing about whether the',
            '  repository, a branch or a file exists.',
            '',
          ]
        : []),
      ...(input.github
        ? [
            'THIS PROJECT WORKS DIRECTLY ON GITHUB. There is no checkout on this computer.',
            `  base branch: ${input.github.baseBranch}`,
            `  base commit: ${input.github.baseCommit}`,
            `  work branch: ${input.github.workBranch ?? '(ainda não criada; será criada na primeira alteração)'}`,
            `  current commit: ${input.github.headCommit}`,
            '',
            'What the application can do here, and what it cannot:',
            '  - READ the repository for you: use "fileReads" exactly as you would locally. The',
            '    application opens the file at the commit above and puts its contents in front of',
            '    you. Never ask a worker to fetch or paste a file.',
            '  - PROVE file contents: use "fileChecks" exactly as you would locally. The',
            '    application opens the file at that commit and compares the bytes itself.',
            '  - CHANGE files: delegate the change. The worker proposes it as structured data and',
            '    the application performs it through the GitHub API - one commit on the work',
            '    branch, never on the base branch, never a merge.',
            '  - RUN code: it CANNOT. The GitHub API is not an executor. A verification command',
            '    here is refused and never runs, so a criterion that needs a test executed stays',
            '    unproven and DONE is refused. Do not ask for one, and do not claim a test passed.',
            '',
            'The evidence you will be shown is the diff GitHub itself computes between the base',
            'commit and the work branch. It is a measurement, not a report from the worker.',
            '',
            'HOW TO FIND A FILE. You cannot know a path until you are told one: there is no folder',
            'to look in, and asking a worker to list files would be asking it to search an empty',
            'directory. The paths are below, and "listFiles" gets you more of them:',
            '  "listFiles": {"prefix": "src/", "contains": "login", "limit": 200}',
            'Every field may be null. The application answers it from the tree it already holds -',
            'no worker, no shell, no clone. Then use "fileReads" on the paths you chose.',
            '',
            input.github.tree
              ? renderTreePreview(input.github.tree)
              : 'FILES IN THIS REPOSITORY: não consegui ler a árvore' +
                `${input.github.treeProblem ? ` (${input.github.treeProblem})` : ''}. ` +
                'Isso NÃO significa que o repositório está vazio. Peça "listFiles" para tentar de novo.',
            '',
          ]
        : []),
      ...(input.conversation || input.github
        ? [
            input.github
              ? 'THERE IS NO WORKING FOLDER. Do not delegate anything that would need one, and'
              : 'THIS IS A CONVERSATION RUN. There is no working folder and no command to run.',
            'Nothing you or a worker says will change a file, and you must not claim',
            'otherwise, ask for a verification, or describe a diff. Finish by answering the',
            'objective: reply with action "done", put the final answer for the person in',
            '"summary", and list in "satisfiedCriteria" the criteria your own review of the',
            "worker's answer found satisfied.",
            '',
          ]
        : [
            `WORKSPACE: ${input.cwd}`,
            '',
            // What the folder actually is, measured before the first
            // delegation. Without this the supervisor cannot tell a checkout
            // of the right repository from a same-named folder holding
            // nothing, and it spends delegations finding out.
            ...(input.preflight ? [renderPreflight(input.preflight), ''] : []),
            'BASELINE:',
            `  branch: ${input.baseline.branch ?? '(none)'}`,
            `  commit: ${input.baseline.commit ?? '(none)'}`,
            `  dirty:  ${input.baseline.dirty ? 'yes' : 'no'}`,
            '',
            'AVAILABLE VERIFICATIONS (request them by id, never by command line):',
            ...(catalogue.length > 0
              ? catalogue.map((row) => `  ${row.id} - ${row.label}`)
              : [
                  '  (none registered for this workspace)',
                  '  This is NOT a dead end. Use "fileChecks" below: the application reads the',
                  '  file itself and compares it. Never ask for a verification id that is not',
                  '  listed above - an unknown id is reported as a failure and never executed.',
                ]),
            '',
            // The second kind of proof, and the one that makes a workspace
            // with no registered command usable at all. Described in full
            // because a supervisor that does not know a mechanism exists will
            // not use it - which is exactly how a correct six-byte file ended
            // a run at the iteration limit.
            'DIRECT FILE CHECKS (always available, no registration needed):',
            '  The application opens the path and compares the bytes itself. No shell runs.',
            '  Use them to prove a file\'s contents. Each entry:',
            '    {',
            '      "path": "relative/to/the/project",',
            '      "expectBytesHex": "70726F6E746F",   // exact bytes, or null',
            '      "expectText": null,                 // exact UTF-8 text, or null',
            '      "expectSizeBytes": 6,               // or null',
            '      "forbidBom": true,                  // or null',
            '      "forbidTrailingNewline": true,      // or null',
            '      "mustExist": true,                  // or null',
            '      "criteria": ["the acceptance criteria this check proves, verbatim"]',
            '    }',
            '  Every field is present; one you are not asserting is null. Use expectBytesHex',
            '  OR expectText, never both - set the other to null.',
            '  `criteria` matters: a check settles exactly the criteria it names. A criterion',
            '  nothing checked stays unproven, and an unproven criterion blocks DONE.',
            '  A path outside the project is refused, not read.',
            '',
            'READING A FILE (always available, no registration needed):',
            '  "fileReads": [{"path": "app.js", "maxBytes": null}] - the application opens the',
            '  file and puts its size, its sha256 and its contents in front of you, truncated',
            '  to a budget and marked when truncated.',
            '  Use this instead of asking a worker to paste a file into its answer. A worker',
            '  copying a file is slower, costs a delegation, and comes back truncated without',
            '  saying so - and the application can simply read it.',
            '  Reading proves nothing on its own. A "fileChecks" entry is what settles a',
            '  criterion; a read is how you look.',
            '',
          ]),
      'Answer with a single JSON object and nothing else:',
      '{',
      'For read-only queries, done may include queryProof: {criteria: [exact criterion], citations: [{path, quote}]}. Quote only bytes delivered in FILE CONTENTS and cite each path in summary. This cannot prove edits or tests.',
      '  "action": "delegate" | "verify" | "done" | "blocked",',
      '  "task": "what the coding agent must do (required for delegate)",',
      '  "acceptanceCriteria": ["objective, checkable statements"],',
      '  "verificationCommands": ["verification ids from the list above"],',
      '  "fileReads": [{"path": "...", "maxBytes": null}],',
      '  "fileChecks": [{"path": "...", "mustExist": true, "expectBytesHex": null,',
      '                  "expectText": "...", "expectSizeBytes": null, "forbidBom": null,',
      '                  "forbidTrailingNewline": null, "criteria": ["..."]}],',
      '  "workerId": "which worker this delegation is for, from the team above",',
      '  "requiresTools": true | false,',
      '  "satisfiedCriteria": ["criteria your review found satisfied"],',
      '  "summary": "one line for the user, or the final answer on done",',
      '  "reason": "required for blocked",',
      '  "workerRequirements": {',
      '    "capability": "fast" | "balanced" | "strong" | "max",',
      '    "reasoning": "low" | "medium" | "high" | "max",',
      '    "rationale": "one line, or null"',
      '  }',
      '}',
      '',
      // Measured: a supervisor that believes it must see the file itself will
      // block when it cannot. Codex runs read-only by design, so it cannot -
      // and it does not need to, because the application looks for it. Saying
      // so is what stops "I have no way to verify this" from ending a run
      // whose worker may well have succeeded.
      'You do NOT inspect the workspace yourself, and you do not need to. You run',
      'read-only on purpose. After every delegation the application collects evidence',
      'directly from the workspace - git, or a walk of the folder when there is no',
      'repository - and runs the verifications you name, then puts both in front of you.',
      'The EVIDENCE and VERIFICATION sections below are your source of truth about what',
      'happened. Never answer "blocked" merely because you cannot read a file: say what',
      'you need verified and the application will verify it.',
      '',
      'Rules: "done" is a request, not a conclusion - it is re-validated before the run',
      'can end. In a run with a workspace that means freshly collected git evidence and',
      'every verification re-run from scratch; an unknown verification id is reported as a',
      'failure and never executed. In a conversation run it means a real final answer and',
      'every criterion you set accounted for.',
      '',
      'Never delegate work that needs files changed to a worker the team above says cannot',
      'read, edit or run anything. Such a worker can describe an edit; it cannot make one,',
      'and its answer is never evidence that anything changed.',
      '',
      'workerRequirements says what THIS delegation needs from the coding agent, as',
      'tiers - never a model name; the system maps tiers to models. capability:',
      '  fast     - trivial or mechanical edits, one file, git chores, renames',
      '  balanced - an ordinary feature or fix within one module',
      '  strong   - debugging across modules, subtle or intermittent bugs, larger refactors',
      '  max      - critical architecture, data, security or irreversible changes',
      'reasoning is the deliberation the task deserves, on the same scale. Judge each',
      'delegation on its own: a simple task after a hard one is fast again. If a',
      'previous attempt made no progress, ask for more than last time.',
    ];

    // What the *project* knows, as opposed to what this conversation said.
    //
    // A selection, never the pile: rules and the project's own objective always
    // travel, and the rest competes on relevance to this objective. Every
    // entry carries where it came from, and the block says plainly that none
    // of it is evidence. See src/context/project-context.ts.
    const projectContext = this.projectContextFor(input.workspace.id, input.objective);
    if (projectContext) lines.push('', projectContext);

    if (input.history) {
      lines.push(
        '',
        'CONVERSATION BEFORE THIS OBJECTIVE (for context; the OBJECTIVE above is what to do now):',
        input.history,
      );
    }
    if (input.feedback) {
      lines.push('', 'RESULT OF THE PREVIOUS ITERATION:', input.feedback);
    }
    return lines.join('\n');
  }

  /**
   * The project's standing knowledge, selected for this objective.
   *
   * Null when the workspace has no project or the project has written nothing,
   * which is the normal state of a project that was made five minutes ago -
   * and an empty section would be a heading promising something and delivering
   * nothing.
   */
  private projectContextFor(workspaceId: string, objective: string): string | null {
    try {
      const project = this.database.projects.findByWorkspace(workspaceId);
      if (!project) return null;
      const rows = this.database.projectContext.list(project.id);
      if (rows.length === 0) return null;
      const selection = selectContext(
        rows.map((row) => ({
          id: row.id,
          kind: contextKindOf(row.kind),
          title: row.title,
          body: row.body,
          sourceRef: row.source_ref,
          pinned: row.pinned === 1,
          updatedAt: row.updated_at,
        })),
        objective,
      );
      const rendered = renderContext(selection);
      return rendered.length > 0 ? rendered : null;
    } catch {
      // Context is an improvement to a prompt, never a precondition for one.
      // A run must not fail because a note could not be read.
      return null;
    }
  }

  /**
   * Writes the run's outcome back onto the project, as a claim with a source.
   *
   * Keyed by title so a project accumulates one current state rather than one
   * paragraph per run, and stamped with the run id so the claim can be checked
   * against the run's own evidence. It is written **after** the DoneGate has
   * decided, never before, and nothing reads it back as proof.
   */
  private recordProjectState(input: {
    workspaceId: string;
    runId: string;
    objective: string;
    status: string;
    summary: string;
  }): void {
    try {
      const project = this.database.projects.findByWorkspace(input.workspaceId);
      if (!project) return;
      this.database.projectContext.upsertByTitle({
        id: newId('ctx'),
        projectId: project.id,
        kind: 'state',
        title: 'Última execução',
        body: [
          `Objetivo: ${redact(input.objective).slice(0, 400)}`,
          `Resultado: ${input.status}`,
          `Resumo: ${redact(input.summary).slice(0, 600)}`,
        ].join('\n'),
        sourceRef: `run:${input.runId}`,
      });
    } catch {
      // Same reason as above: bookkeeping must not be able to fail a run that
      // already finished.
    }
  }

  /**
   * Turns refused calls into requests somebody can answer.
   *
   * The gap this closes: the run said "autorize a operação" and offered
   * nothing to authorise. Every field here comes from what the CLI actually
   * reported - the tool, the exact command when it named one, the arguments,
   * the directory - and a field it did not report is stored as NULL so the
   * dialog can say "não informado" instead of showing a guess.
   *
   * A refusal the CLI described only by tool name still produces a request:
   * the person can see *that* PowerShell was refused and deny it, or approve
   * the tool for this workspace after reading what the task was. What they
   * cannot do is approve a command nobody can name, and the dialog says so.
   *
   * Never throws into the loop. A run that has already failed must not fail
   * differently because bookkeeping did.
   */
  private askForPermission(input: {
    runId: string;
    sessionId: string;
    workspaceId: string;
    iteration: number;
    agentId: string | null;
    accountId: string | null;
    workingDirectory: string;
    calls: readonly DeniedToolCall[];
    tools: readonly string[];
  }): Array<{ id: string; toolName: string }> {
    try {
      // Prefer the detailed calls. Fall back to the bare tool names only for
      // tools the detailed list did not already cover, so one refusal never
      // becomes two questions.
      const described = new Set(input.calls.map((call) => call.toolName));
      const entries: DeniedToolCall[] = [
        ...input.calls,
        ...input.tools.filter((tool) => !described.has(tool)).map((toolName) => ({ toolName })),
      ];

      // What the person already refused in this project. Asked once, and not
      // again: "Se o usuário recusar a autorização, respeite a recusa e não
      // solicite a mesma permissão indefinidamente." A refusal outlives the
      // run it was given in, so this is read per workspace.
      const refused = new Set(
        this.database.permissions
          .refusedIn(input.workspaceId)
          .map((row) => `${row.tool_name}\u0000${row.command ?? ''}`),
      );

      const created: Array<{ id: string; toolName: string }> = [];
      for (const call of entries.slice(0, 10)) {
        const key = `${call.toolName}\u0000${call.command ?? ''}`;
        // Already refused. The decision stands; nothing is asked again, and
        // the worker is told about the refusal in its own preamble instead.
        if (refused.has(key)) continue;
        // A question already waiting for this exact call is not asked twice.
        const alreadyAsked = this.database.permissions
          .forRun(input.runId)
          .some(
            (row) =>
              row.status === 'pending' &&
              row.tool_name === call.toolName &&
              (row.command ?? '') === (call.command ?? ''),
          );
        if (alreadyAsked) continue;

        const record = this.database.permissions.createRequest({
          id: newId('perm'),
          runId: input.runId,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          iteration: input.iteration,
          agentId: input.agentId,
          accountId: input.accountId,
          toolName: call.toolName,
          toolUseId: call.toolUseId ?? null,
          command: call.command ?? null,
          arguments: call.arguments ?? null,
          workingDirectory: input.workingDirectory,
          reason: [
            call.description
              ? // The agent's own words for what it was trying to do. It says
                // *why*, which the command alone never does.
                `O worker disse: "${call.description}".`
              : null,
            `O Claude Code pediu para usar ${call.toolName} e a execução não é interativa, ` +
              'então o pedido foi recusado automaticamente. Nada foi executado.',
          ]
            .filter((part): part is string => part !== null)
            .join(' '),
        });
        created.push({ id: record.id, toolName: record.tool_name });
      }
      return created;
    } catch {
      return [];
    }
  }

  /**
   * The permission rules a person has approved for this workspace.
   *
   * Only what somebody actually approved. Nothing is inferred from a failure,
   * and a grant never crosses to another workspace - which is what keeps one
   * project's approval from quietly authorising another's.
   */
  private grantsFor(workspaceId: string): readonly string[] {
    try {
      return this.database.permissions.rulesFor(workspaceId);
    } catch {
      return [];
    }
  }

  /**
   * What the person refused in this project, in words for the worker.
   *
   * The counterpart of `grantsFor`. A refusal that only the application knows
   * about is a refusal the worker keeps walking into: it calls the tool, the
   * call is denied, and - because the same question is never asked twice -
   * nothing on screen explains the loop.
   */
  private refusalsFor(workspaceId: string): readonly string[] {
    try {
      return [
        ...new Set(
          this.database.permissions
            .refusedIn(workspaceId)
            .map((row) => (row.command ? `${row.tool_name}(${row.command})` : row.tool_name)),
        ),
      ].slice(0, 20);
    } catch {
      return [];
    }
  }

  /**
   * Opens the repository a GitHub-backed project points at.
   *
   * Returns the context, or **null** having already ended the run: a project
   * that cannot reach its repository is a configuration problem with a clear
   * fix, and finding that out before the first model call is the difference
   * between a sentence and fifteen wasted minutes.
   *
   * Nothing is created here. The work branch is cut the first time a change is
   * actually applied, so asking a question about a repository leaves no branch
   * behind.
   */
  private async openGitHubProject(
    runId: string,
    sessionId: string,
    workspace: WorkspaceWithAgents,
  ): Promise<GitHubRunContext | null> {
    const service = this.githubWorkspaces;
    const stop = (reason: string): null => {
      this.database.runs.setStatus(runId, 'NEEDS_HUMAN', reason);
      this.step(runId, 0, 'repository', 'unavailable', reason.slice(0, 500));
      this.say(sessionId, runId, 'system', reason);
      this.progress(runId, sessionId, 'needs-human', 'Repositório indisponível.', 'NEEDS_HUMAN');
      return null;
    };
    if (!service) {
      return stop(
        'Este projeto trabalha direto no GitHub, e a integração com o GitHub não está disponível ' +
          'nesta instalação.',
      );
    }
    const capabilities = await service.capabilities(workspace.id).catch((error: unknown) => ({
      canRead: false,
      problem: error instanceof Error ? error.message : String(error),
      fullName: null,
      defaultBranch: null,
      action: null as { label: string; url: string } | null,
    }));
    if (!capabilities.canRead) {
      // `problem` is now the diagnosis, not the status code: which of the four
      // situations a 404 was, and what to do about it. The page that fixes it
      // travels with the sentence, because a person reading this in the
      // conversation has nowhere else to find it.
      const action = 'action' in capabilities && capabilities.action ? capabilities.action : null;
      return stop(
        `Não consegui ler ${workspace.repository_url ?? 'o repositório deste projeto'}. ` +
          `${capabilities.problem ?? 'O GitHub não disse por quê.'}` +
          (action ? `\n\n${action.label}: ${action.url}` : ''),
      );
    }
    const baseBranch =
      workspace.branch?.trim() || workspace.default_branch?.trim() || capabilities.defaultBranch;
    if (!baseBranch) {
      // Never `main`. A branch this application invented is a branch that may
      // not exist, and every later comparison would be against nothing.
      return stop(
        'O GitHub não informou a branch padrão deste repositório. Escolha a branch de origem nas ' +
          'configurações do projeto antes de continuar.',
      );
    }
    let baseCommit: string;
    try {
      const resolved = await service.api.resolveRef(
        service.refFor(workspace.id).ref,
        baseBranch,
        await service.readToken(),
      );
      baseCommit = resolved.commitSha;
    } catch (error) {
      return stop(
        `A branch "${baseBranch}" não pôde ser resolvida no GitHub: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // The file paths, once, at the top of the run. This is the thing whose
    // absence turned "which files are in this repository?" into a delegation
    // to search a folder that does not exist.
    let tree: RepositoryTree | null = null;
    let treeProblem: string | null = null;
    try {
      tree = await service.tree(workspace.id, baseCommit);
      this.step(
        runId,
        0,
        'repository-tree',
        tree.truncated ? 'truncated' : 'read',
        `${tree.entries.filter((entry) => entry.type === 'blob').length} arquivo(s) em ` +
          `${baseCommit.slice(0, 12)}${tree.truncated ? ' (o GitHub truncou a árvore)' : ''}`,
      );
    } catch (error) {
      // Not fatal: a run can still proceed, and the supervisor is told the
      // listing is missing rather than left to conclude the repository is
      // empty.
      treeProblem = error instanceof Error ? error.message : String(error);
      this.step(runId, 0, 'repository-tree', 'unavailable', treeProblem.slice(0, 500));
    }

    this.step(
      runId,
      0,
      'repository',
      'ready',
      `${capabilities.fullName ?? workspace.repository_url}: ${baseBranch} em ${baseCommit.slice(0, 12)}`,
      { baseBranch, baseCommit },
    );
    return {
      service,
      workspaceId: workspace.id,
      fullName: capabilities.fullName ?? String(workspace.repository_url),
      baseBranch,
      baseCommit,
      workBranch: null,
      headCommit: baseCommit,
      commits: [],
      pullRequestUrl: null,
      tree,
      treeProblem,
    };
  }

  /** Where a GitHub run reads files from: one commit, named. */
  private async githubSource(
    github: GitHubRunContext,
    signal: AbortSignal,
  ): Promise<GitHubFileSource> {
    return {
      operations: github.service.api,
      ref: github.service.refFor(github.workspaceId).ref,
      // The commit the work is actually at, never a branch name that could
      // move between the read and the claim about it.
      at: github.headCommit,
      token: await github.service.readToken(),
      signal,
    };
  }

  private async githubChecks(
    github: GitHubRunContext,
    requests: readonly FileCheckRequest[],
    signal: AbortSignal,
  ): Promise<FileCheckResult[]> {
    return runGitHubFileChecks(await this.githubSource(github, signal), requests);
  }

  /**
   * Offers the work for review, and never merges it.
   *
   * A pull request is the deliverable of a run in this mode: the branch is
   * already there, the commits are already there, and the person decides what
   * happens next. Failing to open it does not fail the run - the commits are
   * published either way, and saying "the PR could not be opened, here is the
   * branch" is more useful than throwing away a finished piece of work.
   */
  private async publishGitHubWork(
    runId: string,
    sessionId: string,
    github: GitHubRunContext,
    objective: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (github.workBranch === null || github.commits.length === 0) {
      this.step(runId, 0, 'pull-request', 'skipped', 'Nada foi commitado; nenhum PR foi aberto.');
      return;
    }
    if (github.pullRequestUrl) return;
    try {
      const pull = await github.service.openPullRequest(
        {
          workspaceId: github.workspaceId,
          head: github.workBranch,
          base: github.baseBranch,
          title: objective.split('\n')[0]!.slice(0, 120) || 'Alteração do Orquestrador',
          body: [
            `Objetivo: ${redact(objective).slice(0, 1000)}`,
            '',
            `Base: \`${github.baseBranch}\` em ${github.baseCommit.slice(0, 12)}`,
            `Commits desta execução: ${github.commits.map((sha) => sha.slice(0, 12)).join(', ')}`,
            '',
            'Aberto pelo Orquestrador. Nada foi mesclado.',
          ].join('\n'),
        },
        signal,
      );
      github.pullRequestUrl = pull.htmlUrl;
      this.step(runId, 0, 'pull-request', 'opened', `#${pull.number} ${pull.htmlUrl}`);
      this.say(sessionId, runId, 'system', `Pull request aberto: ${pull.htmlUrl}`);
    } catch (error) {
      const problem = describeGitHubProblem(error);
      this.step(runId, 0, 'pull-request', 'failed', problem.slice(0, 500));
      this.say(
        sessionId,
        runId,
        'system',
        `O trabalho está publicado em \`${github.workBranch}\`, mas o pull request não pôde ser ` +
          `aberto: ${problem}`,
      );
    }
  }

  /**
   * The file listing, fetched if necessary, as feedback for the next round.
   *
   * Returns null when there is genuinely nothing to offer - the tree could not
   * be read - which is when a person actually is the next step.
   */
  private async offerRepositoryListing(
    runId: string,
    iteration: number,
    github: GitHubRunContext,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (!github.tree) {
      try {
        github.tree = await github.service.tree(github.workspaceId, github.headCommit, signal);
        github.treeProblem = null;
      } catch (error) {
        github.treeProblem = error instanceof Error ? error.message : String(error);
        this.step(runId, iteration, 'repository-tree', 'unavailable', github.treeProblem.slice(0, 500));
        return null;
      }
    }
    const listing = listFiles(github.tree, {});
    this.step(runId, iteration, 'repository-tree', 'offered', `${listing.matched} arquivo(s)`);
    return [
      'VOCÊ DISSE QUE ESTAVA BLOQUEADO, E A PENDÊNCIA ERA A LISTA DE ARQUIVOS.',
      'O aplicativo a obteve pela API do GitHub. Não peça a um worker para listar arquivos: não',
      'existe pasta neste computador para ele procurar. Use "listFiles" para filtrar e "fileReads"',
      'para abrir o que escolher.',
      '',
      renderListing(listing, github.tree, `ARQUIVOS EM ${github.headCommit.slice(0, 12)}:`),
    ].join('\n');
  }

  /** The measurement, taken at GitHub rather than in a folder. */
  private async collectGitHubEvidence(
    github: GitHubRunContext,
    signal: AbortSignal,
  ): Promise<GitEvidence> {
    return collectGitHubEvidence({
      operations: github.service.api,
      ref: github.service.refFor(github.workspaceId).ref,
      branch: github.workBranch ?? '(sem branch de trabalho)',
      baseCommit: github.baseCommit,
      token: await github.service.readToken(),
      signal,
    });
  }

  /**
   * Turns a worker's proposal into a commit, or says why it did not.
   *
   * The line this keeps: the worker **describes** a change and the application
   * **performs** it. A proposal that does not parse, names a path outside the
   * repository, or was written against a different commit is not applied and
   * is not reported as applied - it comes back as feedback the next round can
   * act on, which is what makes the loop converge instead of repeating.
   */
  private async applyProposal(input: {
    runId: string;
    sessionId: string;
    iteration: number;
    github: GitHubRunContext;
    answer: string;
    objective: string;
    signal: AbortSignal;
    agentId?: string | null;
  }): Promise<{ applied: boolean; feedback: string | null }> {
    const github = input.github;
    const result = readChangeProposal(input.answer, github.headCommit);
    if (result.kind === 'none') return { applied: false, feedback: null };
    if(input.agentId&&!this.agentMayWrite(this.database.runs.require(input.runId).workspace_id,input.agentId)) {
      const feedback='A função ou política deste agente proíbe escrita; proposta recusada antes de criar branch ou commit.';
      this.step(input.runId,input.iteration,'proposal','refused',feedback);
      return {applied:false,feedback};
    }
    if(!classifyObjective(input.objective).requiresChanges) {
      const feedback='Esta consulta não autoriza alterações. A proposta foi recusada antes de criar branch, commit ou PR; responda usando evidência de leitura/execução.';
      this.step(input.runId,input.iteration,'proposal','refused',feedback);
      return {applied:false,feedback};
    }
    if (result.kind === 'invalid') {
      this.step(input.runId, input.iteration, 'proposal', 'rejected', result.problem.slice(0, 500));
      this.say(input.sessionId, input.runId, 'system', `Alteração não aplicada. ${result.problem}`);
      return { applied: false, feedback: `A ALTERAÇÃO PROPOSTA NÃO FOI APLICADA. ${result.problem}` };
    }

    // The branch is cut here, on the first change, and not before: a run that
    // only answered a question must leave no branch behind.
    if (github.workBranch === null) {
      try {
        const session = await github.service.startWork(
          { workspaceId: github.workspaceId, baseBranch: github.baseBranch, runId: input.runId },
          input.signal,
        );
        github.workBranch = session.workBranch;
        this.step(input.runId, input.iteration, 'branch', 'created', session.workBranch, {
          baseBranch: session.baseBranch,
          baseCommit: session.baseCommit,
        });
        this.say(
          input.sessionId,
          input.runId,
          'system',
          `Criei a branch \`${session.workBranch}\` a partir de \`${session.baseBranch}\`.`,
        );
      } catch (error) {
        const problem = describeGitHubProblem(error);
        this.step(input.runId, input.iteration, 'branch', 'failed', problem.slice(0, 500));
        this.say(input.sessionId, input.runId, 'system', problem);
        return { applied: false, feedback: `NÃO FOI POSSÍVEL CRIAR A BRANCH DE TRABALHO. ${problem}` };
      }
    }

    try {
      const commit = await github.service.apply(
        {
          workspaceId: github.workspaceId,
          branch: github.workBranch,
          expectedHeadSha: github.headCommit,
          message: result.proposal.message,
          changes: result.proposal.changes,
        },
        input.signal,
      );
      if (!commit.committed) {
        // The tree came back identical. Not a failure, and not a commit: the
        // content proposed was already the content in the repository.
        this.step(input.runId, input.iteration, 'commit', 'no-change', commit.note ?? 'sem alteração');
        this.say(input.sessionId, input.runId, 'system', commit.note ?? 'Nada mudou; nenhum commit foi criado.');
        return {
          applied: false,
          feedback:
            'A ALTERAÇÃO PROPOSTA NÃO MUDOU NADA: o conteúdo enviado já era o conteúdo do ' +
            'repositório, então nenhum commit foi criado. Se a tarefa já está feita, diga isso; ' +
            'se não, proponha a alteração que falta.',
        };
      }
      github.headCommit = commit.commitSha!;
      github.commits.push(commit.commitSha!);
      const summary =
        `${commit.commitSha!.slice(0, 12)} em \`${commit.branch}\`: ` +
        `${commit.written.length} escrito(s), ${commit.deleted.length} removido(s)`;
      this.step(input.runId, input.iteration, 'commit', 'created', summary, {
        commit: commit.commitSha,
        written: [...commit.written],
        deleted: [...commit.deleted],
      });
      this.say(input.sessionId, input.runId, 'system', `Commit aplicado: ${summary}.`);
      return { applied: true, feedback: null };
    } catch (error) {
      const problem = describeGitHubProblem(error);
      this.step(input.runId, input.iteration, 'commit', 'failed', problem.slice(0, 500));
      this.say(input.sessionId, input.runId, 'system', `Alteração não aplicada. ${problem}`);
      return { applied: false, feedback: `A ALTERAÇÃO PROPOSTA NÃO FOI APLICADA. ${problem}` };
    }
  }

  /**
   * Assembles, records and shows the account of one delegation.
   *
   * Called from two places on purpose: after the evidence is in, which is the
   * normal path, and on a terminal failure, where there is no evidence and the
   * report is built from the process alone. A delegation that died before
   * answering is exactly the case somebody most needs a report for, and
   * "nothing happened" was all the screen used to say.
   *
   * No second invocation: the envelope, the process outcome, the activity
   * notes, the evidence this loop collected and the verifications it ran are
   * all here already. Asking the worker to write a report about its own report
   * would cost a call and add a second account of the same events - the less
   * reliable one, since it is the account of the party being reported on.
   *
   * The declaration and the measurement stay apart, and nothing here settles a
   * criterion: the ledger did that, from evidence, before this runs.
   */
  private reportDelegation(input: {
    runId: string;
    sessionId: string;
    iteration: number;
    worker: NonNullable<IterationRecord['worker']>;
    answer: string;
    evidence: GitEvidence | null;
    /** The same measurement as the previous iteration left it. */
    previousEvidence: GitEvidence | null;
    /** Files this delegation asked the application to open. */
    readFiles: readonly string[];
    verifications: readonly { label: string; passed: boolean; problem?: string }[];
    unproven: readonly string[];
    failedCriteria: readonly string[];
  }): WorkerReport {
    const worker = input.worker;
    const report = buildWorkerReport({
      worker,
      answer: input.answer,
      evidence: input.evidence,
      previousEvidence: input.previousEvidence,
      readFiles: input.readFiles,
      verifications: input.verifications,
      unproven: input.unproven,
      failedCriteria: input.failedCriteria,
      awaitingApproval: this.database.permissions
        .forRun(input.runId)
        .filter((request) => request.status === 'pending')
        .map((request) => request.tool_name),
      invocationId: worker.invocationId ?? null,
      iteration: input.iteration,
      sessionId: worker.sessionId ?? null,
      // The readable cause and the tool's own words together: one says what
      // kind of problem it is, the other says exactly what the CLI reported,
      // and a person debugging needs both.
      failureDetail: worker.failure
        ? `${failureExplanation(worker.failure)}` +
          (worker.failureDetail ? ` (${worker.failureDetail})` : '')
        : (worker.failureDetail ?? null),
      tools: worker.tools ?? [],
    });
    // In the conversation, as a message from the worker - separate from the
    // task that was sent to it, which is on the delegation message above.
    this.say(input.sessionId, input.runId, 'worker', renderWorkerReport(report), {
      kind: 'report',
      report,
      ...(worker.routing ? { routing: worker.routing } : {}),
    });
    this.step(input.runId, input.iteration, 'worker-report', report.status, report.headline, {
      report,
    });
    if (worker.invocationId) {
      this.database.runs.setInvocationReport(worker.invocationId, report);
    }
    return report;
  }

  /**
   * What one account is allowed to spend on.
   *
   * Defaults are conservative and deliberate: no tier ceiling, so nothing
   * about existing routing changes, and premium models off, because the one
   * default that cannot be right is the one that spends credits nobody agreed
   * to spend. An unreadable account gets the same defaults rather than an
   * exception - a routing decision must not fail on a settings lookup.
   */
  private policyFor(accountId: string | null, agentId?: string | null): AccountRoutingPolicy {
    const account = this.accountPolicyFor(accountId);
    const agent = agentId ? this.database.agents.find(agentId) : undefined;
    const config = agent ? agentConfig(agent.runtime_options) : {};
    const c = config.maxCapability ?? null, r = config.maxReasoning ?? null;
    return {maxCapability: c && (!account.maxCapability || capabilityRank(c)<capabilityRank(account.maxCapability)) ? c : account.maxCapability,
      maxReasoning: r && (!account.maxReasoning || reasoningRank(r)<reasoningRank(account.maxReasoning)) ? r : account.maxReasoning,
      allowPremiumModels: account.allowPremiumModels};
  }

  private checkAgent(agentId: string | null, accountId: string | null): void {
    if (!agentId) return;
    const agent = this.database.agents.find(agentId);
    if (!agent) return; // Scripted fixtures without a persisted agent.
    if (agent.enabled !== 1) throw new Error('O agente foi desativado ou removido. Escolha outro na equipe.');
    if ((accountId !== null || agentConfig(agent.runtime_options).managed) && agent.account_id !== accountId) throw new Error('A conta do agente mudou. Reabra a equipe antes de executar.');
    if (agentConfig(agent.runtime_options).managed && this.database.accounts.find(accountId ?? '')?.auth_state !== 'connected') throw new Error('A conta deste agente não está conectada.');
  }

  private agentMayWrite(workspaceId:string,agentId:string|null):boolean {
    const agent=agentId?this.database.agents.find(agentId):undefined;
    if(!agent) return true; // Legacy fixture / unbound runner, governed by the objective gate.
    const policy=agentConfig(agent.runtime_options).policy;
    const service=new AgentService(this.database);
    const layers=[service.policies().defaults,service.projectPolicy(workspaceId)];
    return agent.enabled===1&&(policy?policy.tools.includes('write')&&policy.permissions.write:roleDefinition(agent.role)?.tools.includes('write')===true)&&layers.every(l=>!l.tools||l.tools.includes('write'));
  }

  private accountPolicyFor(accountId: string | null): AccountRoutingPolicy {
    if (!accountId) return DEFAULT_ACCOUNT_POLICY;
    try {
      const account = this.database.accounts.find(accountId);
      if (!account) return DEFAULT_ACCOUNT_POLICY;
      return {
        maxCapability: capabilityCeilingOf(account.max_capability),
        maxReasoning: reasoningCeilingOf(account.max_reasoning),
        allowPremiumModels: account.allow_premium_models === 1,
      };
    } catch {
      return DEFAULT_ACCOUNT_POLICY;
    }
  }

  private buildFeedback(
    evidence: GitEvidence,
    verification: readonly CommandResult[],
    unknownIds: readonly string[],
    record?: IterationRecord,
    ledger?: AcceptanceCriteriaLedger,
  ): string {
    const lines: string[] = [];
    // What the worker ran as, so the orchestrator's next request is informed
    // by the last one: the tiers it asked, the model that ran, the outcome.
    const worker = record?.worker;
    if (worker) {
      const routing = worker.routing;
      lines.push(
        'WORKER OF THIS ITERATION:',
        `  requested: ${routing ? `${routing.requestedCapability ?? 'default'}/${routing.requestedReasoning ?? 'default'}` : '(not routed)'}`,
        `  ran as: model ${routing?.resolvedModel ?? '(CLI default)'}, reasoning ${routing?.resolvedReasoning ?? '(CLI default)'}` +
          (routing ? ` [${routing.selectionMode}${routing.fallbackUsed ? ', fallback' : ''}]` : ''),
        `  outcome: ${worker.outcome}${worker.exitCode !== null ? ` (exit ${worker.exitCode})` : ''}` +
          (worker.mechanical ? ' - a mechanical failure (binary, login, quota, network), not the model' : '') +
          (worker.modelUnavailable ? ' - the CLI refused the model' : ''),
        `  progressed: ${worker.progressed ? 'yes' : 'no'}`,
        '',
      );
    }
    // The delegation's own report: status, what was declared, what was
    // measured, what is still missing and what to do next. It replaces the
    // free-text guessing that used to happen here - and it keeps the
    // declaration and the evidence in separate sections, so nothing in it can
    // be read as proof of something nobody checked.
    if (record?.workerReport) {
      lines.push('WORKER REPORT:', indent(renderWorkerReport(record.workerReport)), '');
    } else if (worker?.failure) {
      // No report (a run that never got that far). The cause still travels.
      lines.push(
        'WHY THE WORKER DID NOT SUCCEED:',
        `  ${failureExplanation(worker.failure)}`,
        ...(worker.deniedTools && worker.deniedTools.length > 0
          ? [`  tools refused: ${worker.deniedTools.join(', ')}`]
          : []),
        '  This is not something a stronger model or a repeated attempt fixes.',
        '  Say what needs authorising, or answer "blocked" with this as the reason.',
        '',
      );
    }

    lines.push(
      evidence.source === 'filesystem'
        ? 'FILESYSTEM EVIDENCE (collected by the orchestrator by walking the folder, not reported by the agent):'
        : 'GIT EVIDENCE (collected by the orchestrator, not reported by the agent):',
    );
    if (evidence.evidenceProblem) {
      lines.push(
        `  WARNING: ${evidence.evidenceProblem}`,
        '  Treat "no changes" below as "could not be observed", not as proof that nothing happened.',
      );
    }
    lines.push(`  branch: ${evidence.branch ?? '(none)'}`);
    lines.push(`  changed since baseline: ${evidence.changedSinceBaseline ? 'yes' : 'no'}`);
    lines.push(`  changed files: ${evidence.changedFiles.join(', ') || '(none)'}`);
    lines.push(`  added files: ${evidence.addedFiles.join(', ') || '(none)'}`);
    lines.push(`  deleted files: ${evidence.deletedFiles.join(', ') || '(none)'}`);
    if (evidence.diffStat.trim()) lines.push('  diffstat:', indent(evidence.diffStat));

    if (unknownIds.length > 0) {
      lines.push(
        '',
        'REFUSED: these verification ids are not registered for this workspace and were',
        `not executed: ${unknownIds.join(', ')}`,
        'Do not ask for them again. Use "fileChecks" to prove a file\'s contents instead:',
        'the application reads the file itself and no registration is needed.',
      );
    }

    // Bytes are appended once by fileContext, under its shared carry budget.
    for (const read of record?.fileReads ?? []) lines.push(describeFileRead(read));

    // What the application read for itself. Reported before the commands,
    // because in a workspace with no registered verification this is the only
    // proof there is - and a supervisor that cannot see it will keep asking
    // for an id that does not exist.
    const fileChecks = record?.fileChecks ?? [];
    if (fileChecks.length > 0) {
      lines.push('', 'FILE CHECKS (read by the application, no command was run):');
      for (const check of fileChecks) {
        lines.push(`  ${describeFileCheck(check)}`);
        for (const criterion of check.request.criteria ?? []) {
          lines.push(`    settles: "${criterion}"`);
        }
      }
    }

    if (verification.length > 0) {
      lines.push('', 'VERIFICATION RESULTS:');
      for (const result of verification) {
        const verdict = commandPassed(result)
          ? 'PASS'
          : result.refused
            ? `REFUSED (${result.refused})`
            : result.timedOut
              ? 'TIMEOUT'
              : `FAIL (exit ${result.exitCode})`;
        lines.push(`  ${verdict}: ${result.command}`);
        const output = (result.stderr || result.stdout).trim();
        if (verdict !== 'PASS' && output) lines.push(indent(output.slice(0, 2000)));
      }
    }

    // What is still missing, said out loud, every round.
    //
    // The gate already lists unproven criteria - but only after `done` has
    // been refused, which is one wasted round trip at best and, in the run
    // that started this, four. The supervisor cannot see the ledger, so
    // without this block "what do I still have to prove?" is a guess, and a
    // guess is what produced a `verify` for an id that does not exist.
    //
    // The two states are kept apart on purpose. `unproven` means nobody
    // looked; `failed` means something looked and said no. Collapsing them is
    // the exact defect that made a correct file unfinishable.
    if (ledger && ledger.size > 0) {
      const pending = ledger.pending();
      if (pending.length === 0) {
        lines.push(
          '',
          'CRITERIA: all ' + ledger.size + ' proven by the checks above. Nothing is outstanding,',
          'so a further delegation would repeat work that is already done.',
        );
      } else {
        lines.push('', 'CRITERIA STILL WITHOUT PROOF (each one blocks "done"):');
        for (const criterion of pending) {
          const state = criterion.status === 'failed' ? 'failed  ' : 'unproven';
          lines.push(
            `  [${state}] "${criterion.text}"` +
              (criterion.status === 'failed' && criterion.note ? ` - ${criterion.note}` : ''),
          );
        }
        lines.push(
          '  unproven = nothing has checked it yet. failed = something checked it and it did not hold.',
          '  Prove each one with a "fileChecks" entry that names it in "criteria", or with a',
          '  verification id from the list you were given. Never with an id that is not on that list.',
        );
      }
    }
    return lines.join('\n');
  }

  /**
   * One delegation: route the model, run the worker, record the invocation.
   *
   * The model is chosen here, for this task, from what the orchestrator asked
   * and what happened before - and fixed for the invocation. A CLI that
   * refuses the model by name is given the next candidate, at most twice;
   * every attempt is on the record with its own routing.
   */
  private async delegate(input: {
    runId: string;
    sessionId: string;
    workspace: WorkspaceWithAgents;
    /** The repository path **inside the environment this run executes in**. */
    cwd: string;
    runners: RunnerPair;
    /** The team member this delegation is for, already validated. */
    slot: WorkerSlot;
    iteration: number;
    task: string;
    decision: Decision;
    /** Ties this delegation to the run's exchange. */
    correlationId: string;
    /** The decision that caused it, when the bus recorded one. */
    causationId: string | null;
    routing: WorkerRoutingSource | null;
    capabilities: WorkerRuntimeCapabilities;
    attempts: readonly PreviousAttempt[];
    unavailableModels: string[];
    signal: AbortSignal;
    budget: BudgetLedger;
    branchTaskId?: string;
    fileReads?: readonly FileReadResult[];
    /** Set when the project has no checkout and changes go through the API. */
    github?: GitHubRunContext | null;
  }): Promise<{ record: NonNullable<IterationRecord['worker']>; answer: string }> {
    const { runId, sessionId, workspace, cwd, runners, slot, iteration, task } = input;
    let last: NonNullable<IterationRecord['worker']> | null = null;
    let answer = '';

    // The instruction the worker actually receives.
    //
    // It used to be the tool policy plus the supervisor's free text, and
    // nothing else - so a task saying "confira os critérios abaixo" arrived
    // with no list, three times in one run. The criteria existed: they were in
    // the decision, in the ledger and in the gate. They were simply never sent.
    const workerPrompt = buildWorkerPrompt({
      preamble: [
        toolPolicyPreamble(
          this.grantsFor(workspace.id),
          this.refusalsFor(workspace.id),
          workspace.repository_url,
        ),
        // Without a checkout the worker cannot write a file, and must not say
        // that it did. The contract for proposing a change lives beside the
        // parser that reads it, so the instruction and the code enforcing it
        // cannot drift apart.
        input.github
          ? proposalInstructions({
              fullName: input.github.fullName,
              branch: input.github.workBranch ?? input.github.baseBranch,
              commitSha: input.github.headCommit,
            })
          : null,
      ]
        .filter((part): part is string => part !== null)
        .join('\n\n'),
      task,
      criteria: input.decision.acceptanceCriteria,
      fileReads: input.fileReads,
    });
    if (workerPrompt.deliveries.length) {
      this.step(runId, iteration, 'file-context', workerPrompt.deliveries.some(d=>d.state==='NOT_CARRIED') ? 'not-carried' : 'worker-carried', 'Validação do conteúdo no prompt do worker.', { deliveries: workerPrompt.deliveries });
      if (workerPrompt.deliveries.some(d => d.state === 'NOT_CARRIED')) {
        throw new Error('file-read/not-carried: conteúdo indisponível ou excedeu o orçamento; reduza as leituras antes de delegar.');
      }
    }
    if (workerPrompt.danglingReference) {
      // The supervisor pointed at a list it did not define. Recorded, because
      // a run where this keeps happening is a run going in circles.
      this.step(
        runId,
        iteration,
        'delegation',
        'dangling-criteria',
        'A tarefa cita uma lista de critérios que a decisão não definiu; o worker foi avisado.',
      );
    }

    for (let attempt = 0; attempt <= MODEL_RETRIES; attempt += 1) {
      this.checkAgent(slot.agentId ?? workspace.worker_agent_id, slot.accountId);
      const persistedAgent = slot.agentId ? this.database.agents.find(slot.agentId) : undefined;
      const agentOptions = persistedAgent ? agentConfig(persistedAgent.runtime_options) : {};
      const agentManual = persistedAgent?.model ? {model:persistedAgent.model,reasoning:agentOptions.reasoning ?? null} : undefined;
      let routed: RouterOutput | null = input.routing
        ? routeWorkerModel({
            provider: input.routing.provider,
            accountId: slot.accountId,
            task,
            requested: input.decision.workerRequirements ?? null,
            previousAttempts: input.attempts,
            capabilities: input.capabilities,
            selection: agentManual ? 'manual' : input.routing.selection,
            manual: agentManual ?? input.routing.manual,
            unavailableModels: input.unavailableModels,
            // What this account is allowed to spend on. Read per delegation,
            // from the account actually being used, so two Claude accounts can
            // hold different ceilings and neither is a global switch.
            policy: this.policyFor(slot.accountId,slot.agentId),
          })
        : null;

      if (routed && !routed.policyBlocked && !agentManual && agentOptions.reasoning && input.routing) {
        const fixed = routeWorkerModel({provider:input.routing.provider,accountId:slot.accountId,task,
          requested:input.decision.workerRequirements??null,previousAttempts:[],capabilities:input.capabilities,
          selection:'manual',manual:{model:routed.resolvedModel,reasoning:agentOptions.reasoning},policy:this.policyFor(slot.accountId,slot.agentId)});
        routed={...routed,resolvedReasoning:fixed.resolvedReasoning,policyBlocked:fixed.policyBlocked,
          fallbackUsed:routed.fallbackUsed||fixed.fallbackUsed,selectionReason:routed.selectionReason+'; raciocínio do agente: '+fixed.selectionReason};
      }

      // The policy left nothing to run. That is a question for the person, not
      // a model choice: falling through to the CLI default here would run the
      // model the policy exists to keep out.
      if (routed?.policyBlocked && !agentOptions.policy) {
        const reason =
          'A tarefa pede uma capacidade que a política desta conta não permite. ' +
          `${routed.selectionReason}. Ajuste o teto da conta em Contas e integrações, ` +
          'ou aprove o uso de créditos extras para esta conta.';
        this.database.runs.setStatus(runId, 'NEEDS_HUMAN', reason);
        this.say(sessionId, runId, 'system', reason);
        this.step(runId, iteration, 'routing', 'blocked', reason, {
          requestedCapability: routed.requestedCapability,
          requestedReasoning: routed.requestedReasoning,
        });
        this.progress(runId, sessionId, 'needs-human', 'Política da conta', 'NEEDS_HUMAN');
        return {
          record: last ?? {
            agent: slot.runner.kind,
            profile: slot.accountId,
            task,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            exitCode: null,
            outcome: 'cancelled',
            durationMs: 0,
            mechanical: true,
          },
          answer,
        };
      }

      const planned: RoutingRecord | null = routed
        ? {
            requestedCapability: routed.requestedCapability,
            requestedReasoning: routed.requestedReasoning,
            resolvedModel: routed.resolvedModel,
            resolvedReasoning: routed.resolvedReasoning,
            selectionMode: routed.selectionMode,
            selectionReason: routed.selectionReason,
            fallbackUsed: routed.fallbackUsed,
          }
        : null;

      // The task, labelled as the task. This message used to read as the
      // worker's own words - the instruction sent to it, under its name, with
      // nothing saying which it was - and the answer never appeared at all.
      // What comes back is the report, posted after the evidence is in.
      this.say(
        sessionId,
        runId,
        'worker',
        attempt === 0
          ? `${slot.label} — tarefa enviada:\n${task}`
          : `${slot.label} — tarefa reenviada com outro modelo:\n${task}`,
        {
          kind: 'delegation',
          workerId: slot.id,
          workerLabel: slot.label,
          ...(planned ? { routing: planned } : {}),
        },
      );

      // The session this worker already has in this conversation, if any.
      // Looked up per connection, so one account's session is never handed to
      // another - and only when the working directory matches, because both
      // tools store sessions per project.
      const previousSession = slot.accountId
        ? this.database.agentSessions.find(input.sessionId, slot.accountId, cwd, agentOptions.managed ? slot.agentId ?? '' : '')
        : undefined;

      const startedAt = new Date().toISOString();

      // The delegation, on the record before the worker is asked.
      //
      // Persisted first, deliberately: if this process dies between here and
      // the worker answering, the row is what says a delegation was
      // outstanding. The attempt number is part of the key, so a second model
      // attempt is a second message rather than a duplicate of the first.
      const delegationId = this.record({
        runId,
        conversationId: sessionId,
        iteration,
        stepId: `${input.branchTaskId ?? slot.id}#${attempt}`,
        messageType: 'DELEGATION',
        payload: { task, workerId: slot.id },
        senderAgentId: ORCHESTRATOR_AGENT,
        recipientAgentId: slot.id,
        correlationId: input.correlationId,
        causationId: input.causationId,
      });
      // Claim it for this worker, then acknowledge: "handed over" and "began"
      // are two facts, and a run stuck between them is a different problem
      // from one stuck before the hand-over.
      if (delegationId) {
        this.busSafely(
          () => {
            this.bus.claim(slot.id);
            this.bus.acknowledge(delegationId);
          },
          runId,
          iteration,
        );
      }

      let activeInvocationId: string | undefined;
      const beforeInvocation = () => { activeInvocationId ??= this.database.runs.recordInvocation({runId, iteration, agentId: slot.agentId ?? workspace.worker_agent_id, accountId: slot.accountId, role: 'CODING_WORKER', workerId: slot.id, task, outcome: 'running', exitCode: null, durationMs: null, startedAt, routing: planned}); };
      if (input.branchTaskId) { const entry=this.branchTasks.get(runId+':'+input.branchTaskId); if(entry) entry.invocationId=activeInvocationId; }
      this.progress(runId, sessionId, 'worker', slot.label + ' executando...', 'RUNNING');
      const invoke = (resumeSessionId: string | null) =>
        new AgentExecutionPolicy(this.database).invoke({workspaceId:workspace.id,agentId:slot.agentId??workspace.worker_agent_id,accountId:slot.accountId,runner:slot.runner,capabilities:input.capabilities,beforeInvocation:()=>{beforeInvocation();if(input.branchTaskId){const entry=this.branchTasks.get(runId+':'+input.branchTaskId);if(entry)entry.invocationId=activeInvocationId;}},args:{
          prompt: workerPrompt.text,
          workingDirectory: cwd,
          timeoutMs: this.options.agentTimeoutMs ?? DEFAULTS.agentTimeoutMs,
          runId,
          iteration,
          // Liveness, straight to the window. Ephemeral: nothing here is
          // stored, because a row per heartbeat would bloat the history and
          // add nothing a reader could not already see.
          onActivity: (snapshot) => this.sayActivity(runId, sessionId, slot, snapshot),
          ...(resumeSessionId ? { resumeSessionId } : {}),
          ...(routed
            ? { routing: { model: routed.resolvedModel, reasoning: routed.resolvedReasoning }, strictRouting: !!(this.policyFor(slot.accountId,slot.agentId).maxCapability || this.policyFor(slot.accountId,slot.agentId).maxReasoning || (input.routing?.provider === 'anthropic' && !this.policyFor(slot.accountId,slot.agentId).allowPremiumModels)) }
            : {}),
        }});

      let result = await invoke(previousSession?.provider_session_id ?? null);
      const branchCancelled = input.branchTaskId && this.branchTasks.get(runId+':'+input.branchTaskId)?.cancelled;
      if(branchCancelled) result = {...result,outcome:'cancelled'};

      // A session the tool no longer has is not a failed delegation - it is a
      // stale id. Sessions expire (Claude Code prunes them after 30 days by
      // default) and a person can clear them, so an id recorded weeks ago can
      // simply be gone. Forget it and do the same delegation once more with a
      // fresh session, rather than failing a run over bookkeeping.
      if (!branchCancelled && !this.stopping(runId,input.signal) && previousSession && sessionMissing(result)) {
        this.database.agentSessions.forget(input.sessionId, slot.accountId!, agentOptions.managed ? slot.agentId ?? '' : '');
        this.step(runId, iteration, 'worker', 'session-expired', `${slot.label}: sessão anterior expirou`, {
          workerId: slot.id,
        });
        result = await invoke(null);
      }

      // The id the tool reported for the session it just ran, so the next
      // delegation to this same connection continues it instead of meeting
      // the codebase again.
      if (result.sessionId && slot.accountId) {
        this.database.agentSessions.remember({
          chatSessionId: input.sessionId,
          connectionId: slot.accountId,
          agentScope: agentOptions.managed ? slot.agentId ?? '' : '',
          providerSessionId: result.sessionId,
          adapterId: slot.runner.kind,
          workingDirectory: cwd,
        });
      }

      // What was actually sent wins over what was planned: the adapter may
      // have dropped a flag its build does not take.
      const recorded: RoutingRecord | null = planned
        ? {
            ...planned,
            observation:{actualModel:result.observed?.model??null,actualReasoning:result.observed?.reasoning??null,ceiling:`${this.policyFor(slot.accountId,slot.agentId).maxCapability??'sem teto'}/${this.policyFor(slot.accountId,slot.agentId).maxReasoning??'sem teto'}`,capped:`${routed?.capability??'não informado'}/${routed?.reasoning??'não informado'}`},
            resolvedModel: result.applied ? result.applied.model : planned.resolvedModel,
            resolvedReasoning: result.applied ? result.applied.reasoning : planned.resolvedReasoning,
            fallbackUsed: planned.fallbackUsed || (result.applied?.fallbackUsed ?? false),
            selectionReason: result.applied?.note
              ? `${planned.selectionReason}; ${result.applied.note}`
              : planned.selectionReason,
          }
        : null;

      const modelUnavailable =
        routed?.resolvedModel !== null && routed?.resolvedModel !== undefined && modelUnavailableIn(result);
      const mechanical =
        !modelUnavailable &&
        isMechanicalFailure({
          outcome: result.outcome,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          ...(result.failure ? { failure: result.failure } : {}),
        });

      if(!result.invocationSkipped) input.budget.record(result.usage ?? null);
      // The worker's answer is what a conversation run finishes with, and it
      // is only ever *an answer*: nothing here treats it as evidence that a
      // file changed. In a coding run the evidence collector, not this string,
      // decides what happened.
      if (result.stdout.trim()) answer = result.stdout;

      const slotCapabilities = capabilitiesOfRunner(slot.runner);
      last = {
        agent: slot.runner.kind,
        profile: slot.accountId,
        task,
        startedAt,
        finishedAt: result.finishedAt,
        exitCode: result.exitCode,
        outcome: result.outcome,
        durationMs: result.durationMs,
        ...(recorded ? { routing: recorded } : {}),
        mechanical,
        modelUnavailable,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.failure ? { failure: result.failure } : {}),
        ...(result.permissionDenials && result.permissionDenials.length > 0
          ? { deniedTools: [...result.permissionDenials] }
          : {}),
        ...(result.deniedCalls && result.deniedCalls.length > 0
          ? { deniedCalls: [...result.deniedCalls] }
          : {}),
        // What the report needs and nothing else read: the CLI's own session,
        // its own words for the failure, and the tools the runtime saw. All
        // three already existed on the result and were dropped here.
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.failureDetail ? { failureDetail: result.failureDetail } : {}),
        ...(toolsUsed(result.activity).length > 0 ? { tools: toolsUsed(result.activity) } : {}),
      };
      const invocationId = result.invocationSkipped ? undefined : this.database.runs.recordInvocation({
        id: activeInvocationId,
        runId,
        iteration,
        agentId: slot.agentId ?? workspace.worker_agent_id,
        accountId: slot.accountId,
        role: 'CODING_WORKER',
        task,
        workerId: slot.id,
        providerId: slotCapabilities?.providerId ?? slot.providerId,
        connectionKind: slotCapabilities?.connectionKind ?? slot.connectionKind,
        usage: result.usage
          ? {
              billing: result.usage.billing,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              totalTokens: result.usage.totalTokens,
              costUsd: result.usage.costUsd,
            }
          : null,
        failureKind: result.failure ?? null,
        outcome: result.outcome,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        startedAt,
        routing: recorded,
        // The diagnosis, kept with the invocation a person opens.
        //
        // All of this was computed and then dropped here, which is why a
        // failed run could show "provider-error, exit 1" and nothing that
        // said what the CLI reported, which build ran, or when it last did
        // anything. Absent fields stay absent and render "não informado".
        diagnostics: {
          failureDetail: result.failureDetail ?? null,
          stderrExcerpt: result.stderr || null,
          executable: result.executable ?? null,
          version: result.version ?? null,
          signal: result.signal ?? null,
          lastActivityAt: result.activity?.lastActivityAt ?? null,
          idleTimeoutMs: result.activity?.idleTimeoutMs ?? null,
          currentTool: result.activity?.currentTool ?? null,
          workingDirectory: cwd,
        },
      });
      // The row the report will be attached to, once the evidence exists.
      last.invocationId = invocationId;

      // Authorisation, proven at the runtime.
      //
      // The rule the person approved either was on the command line or was
      // not, and until this step existed nobody could tell: the grant row said
      // `approved` whether the rules reached the CLI (they did not - nothing
      // supplied them) and whether the rule was one the CLI can match (it was
      // not - it carried a URL). Both failures looked identical from the
      // database, and both produced the same "you haven't granted it yet".
      if (result.authorisedTools) {
        const sent = new Set(result.authorisedTools);
        const granted = this.grantsFor(workspace.id);
        const missing = granted.filter((rule) => !sent.has(rule));
        this.step(
          runId,
          iteration,
          'permission',
          missing.length > 0 ? 'not-carried' : 'carried',
          missing.length > 0
            ? `Regras autorizadas que NÃO foram enviadas ao CLI: ${missing.join(', ')}.`
            : `Enviadas ao CLI: ${result.authorisedTools.join(', ') || 'nenhuma'}.`,
          { authorisedTools: [...result.authorisedTools], granted: [...granted] },
        );
      }
      // Close the delegation, and publish what came back.
      //
      // The distinction that matters: `complete` means this message's
      // lifecycle ended, never that the work was correct or that a file
      // changed. Evidence and verification answer that, below, and a
      // WORKER_RESULT row is a claim by an agent - the same untrusted input it
      // has always been.
      if (delegationId) {
        this.busSafely(
          () => {
            const failed = result.outcome !== 'completed' || result.exitCode !== 0;
            if (failed) {
              // A mechanical failure is not retried by the bus either: another
              // delivery of the same instruction cannot grant a refused
              // permission, and each attempt may cost money.
              this.bus.fail(
                delegationId,
                result.failure ? failureExplanation(result.failure) : `saída ${result.exitCode ?? 'nula'}`,
                { retryable: !mechanical },
              );
            } else {
              this.bus.complete(delegationId);
            }
            this.record({
              runId,
              conversationId: sessionId,
              iteration,
              stepId: `${input.branchTaskId ?? slot.id}#${attempt}`,
              messageType: 'WORKER_RESULT',
              payload: {
                outcome: result.outcome,
                exitCode: result.exitCode,
                failure: result.failure ?? null,
                reportedBytes: result.stdout.length,
                deniedTools: result.permissionDenials ?? [],
              },
              senderAgentId: slot.id,
              recipientAgentId: ORCHESTRATOR_AGENT,
              correlationId: input.correlationId,
              causationId: delegationId,
            });
          },
          runId,
          iteration,
        );
      }

      this.step(runId, iteration, 'worker', result.outcome, task.slice(0, 200), {
        attempt: attempt + 1,
        workerId: slot.id,
        // Whether this delegation continued a session or started one. The
        // difference is visible in the record rather than inferred.
        continuedSession: previousSession ? true : false,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ...(result.executable ? { executable: result.executable } : {}),
        ...(recorded ? { routing: recorded } : {}),
        ...(modelUnavailable ? { modelUnavailable: true } : {}),
        ...(mechanical ? { mechanical: true } : {}),
        // The three facts that answer "why did nothing change?" from the
        // record alone, without anyone opening a terminal.
        ...(result.failure ? { failure: result.failure } : {}),
        ...(result.permissionDenials && result.permissionDenials.length > 0
          ? { deniedTools: [...result.permissionDenials] }
          : {}),
        workingDirectory: cwd,
        stderrExcerpt: excerpt(result.stderr),
      });

      // A failure that another model cannot fix - no balance, a rejected key -
      // must not be answered by trying another model, which would only spend
      // again to be refused again.
      if (terminalFailure(result.failure, `${result.failureDetail ?? ''}\n${result.stderr}`)) {
        return { record: last, answer };
      }
      if (input.signal.aborted || !modelUnavailable || !routed?.resolvedModel) {
        return { record: last, answer };
      }
      if (attempt === MODEL_RETRIES || routed.alternatives.length === 0) {
        return { record: last, answer };
      }

      // The CLI refused the model by name: remember it for the whole run
      // and try the next candidate, with the router saying why.
      input.unavailableModels.push(routed.resolvedModel);
      this.say(
        sessionId,
        runId,
        'system',
        `O modelo ${routed.resolvedModel} não está disponível nesta conta; tentando ${routed.alternatives[0]}.`,
      );
    }
    return { record: last!, answer };
  }

  /**
   * Which worker a delegation is for, and whether it can actually do it.
   *
   * Two refusals, both of them the application's job rather than the model's:
   *
   *  - A worker id the team does not have. The orchestrator is told the real
   *    ids instead of having its delegation quietly sent somewhere else.
   *  - A delegation that needs files changed, aimed at a connection that
   *    cannot change them. This is the rule that stops a model API's account
   *    of an edit from standing in for an edit.
   */
  private chooseWorker(
    team: readonly WorkerSlot[],
    decision: Decision,
    conversation: boolean,
  ):
    | { ok: true; slot: WorkerSlot }
    | { ok: false; reason: string; feedback: string } {
    if (team.length === 0) {
      const reason = 'Nenhum worker está configurado para este projeto. Escolha um em Equipe.';
      return { ok: false, reason, feedback: `NO_WORKER_CONFIGURED\n\n${reason}` };
    }
    const wanted = decision.workerId;
    const kind=decision.taskKind as TaskKind|undefined;
    const configured=new AgentService(this.database).policies().routing;
    const compatible=(entry:WorkerSlot)=>{
      const agent=entry.agentId?this.database.agents.find(entry.agentId):undefined;
      if(!agent) return !kind || kind==='IMPLEMENTATION';
      const config=agentConfig(agent.runtime_options);
      return agent.enabled===1&&!roleDefinition(agent.role)?.requiresImage&&(!kind || ((config.policy?.taskKinds??roleDefinition(agent.role)?.taskKinds??[]).includes(kind)&&(!configured[kind]||configured[kind]!.includes(agent.role))));
    };
    const slot = wanted ? team.find(entry=>entry.id===wanted) : team.find(compatible);
    if(slot&&!compatible(slot)) return {ok:false,reason:'O agente não está ativo ou não atende ao tipo de tarefa solicitado.',feedback:'ROLE_INCOMPATIBLE: choose an active agent with the required role.'};
    if (!slot) {
      const known = team.map((entry) => `${entry.id} (${entry.label})`).join(', ');
      return {
        ok: false,
        reason: `O orquestrador pediu um worker que não existe nesta equipe: "${wanted}".`,
        feedback:
          `UNKNOWN_WORKER\n\nYou delegated to "${wanted}", which is not on this team. ` +
          `The workers available are: ${known}. Delegate again naming one of these, ` +
          'or answer "blocked" with a reason.',
      };
    }

    // Does this delegation need a real executor, and does this worker have one?
    const needsTools = decision.requiresTools ?? !conversation;
    if (!needsTools) return { ok: true, slot };
    const capabilities = capabilitiesOfRunner(slot.runner);
    if (!capabilities || capabilities.toolExecution) return { ok: true, slot };
    const alternatives = team
      .filter((entry) => capabilitiesOfRunner(entry.runner)?.toolExecution !== false)
      .map((entry) => `${entry.id} (${entry.label})`);
    return {
      ok: false,
      reason:
        `"${slot.label}" responde e analisa, mas não edita arquivos: é uma conexão de API, ` +
        'sem executor. Esta tarefa precisa de um worker com ferramentas.',
      feedback:
        `WORKER_CANNOT_EXECUTE_TOOLS\n\nWorker "${slot.id}" (${slot.label}) is a model API ` +
        'connection. It can analyse, plan and review, but it cannot read, edit or run ' +
        'anything: it has no tool executor. Do not ask it to change files, and do not treat ' +
        'any answer as evidence that a file changed.\n' +
        (alternatives.length > 0
          ? `Workers on this team that can execute tools: ${alternatives.join(', ')}.`
          : 'No worker on this team can execute tools. Answer "blocked" explaining that the ' +
            'project needs a coding worker configured in Equipe.'),
    };
  }

  /**
   * Ends a run because its own budget said stop.
   *
   * NEEDS_HUMAN rather than FAILED: nothing broke. The person set a limit, the
   * limit was reached, and what happens next is their decision.
   */
  private finishAtBudget(
    runId: string,
    sessionId: string,
    reason: string,
    budget: BudgetLedger,
  ): void {
    this.database.runs.setStatus(runId, 'NEEDS_HUMAN', reason);
    this.step(runId, this.database.runs.require(runId).iteration, 'budget', 'stopped', reason);
    this.say(sessionId, runId, 'system', reason);
    this.sayCost(sessionId, runId, budget);
    this.progress(runId, sessionId, 'needs-human', 'Limite atingido.', 'NEEDS_HUMAN', {
      usage: usageView(budget),
    });
  }

  /** What the run consumed, said once at the end, in the ledger's own words. */
  private sayCost(sessionId: string, runId: string, budget: BudgetLedger): void {
    const totals = budget.snapshot;
    if (totals.invocations === 0) return;
    this.say(sessionId, runId, 'system', `Consumo desta execução: ${budget.describe()}.`);
  }

  /**
   * What to tell the orchestrator after a conversation delegation.
   *
   * It carries the worker's answer and nothing else - no git section, no
   * verification section, no "changed files: (none)". Printing an empty
   * evidence report for a run that has no working copy would invite the
   * orchestrator to reason about a repository that is not there.
   */
  private buildConversationFeedback(record: IterationRecord, answer: string): string {
    const lines: string[] = [];
    const worker = record.worker;
    if (worker) {
      lines.push(
        'WORKER OF THIS ITERATION:',
        `  outcome: ${worker.outcome}${worker.exitCode !== null ? ` (exit ${worker.exitCode})` : ''}`,
        `  ran as: model ${worker.routing?.resolvedModel ?? '(provider default)'}`,
        '',
      );
    }
    lines.push(
      "WORKER'S ANSWER (this is a conversation run: no files were changed and no command was run):",
      answer.trim() ? indent(answer.trim().slice(0, 12_000)) : '    (the worker returned nothing)',
      '',
      'Review it. If it answers the objective, reply with action "done" and put the final answer',
      'for the person in "summary", listing in "satisfiedCriteria" the criteria your review found',
      'satisfied. If it does not, delegate again with what is missing.',
    );
    return lines.join('\n');
  }

  /**
   * Reclaims leases that passed their deadline, while anything is running.
   *
   * This is what makes "if the worker dies, the application must know" true
   * rather than merely intended. The loop awaits each delegation, so in the
   * healthy case the result arrives and the lease is returned; this exists for
   * the case where it does not - a child that is killed from outside, a
   * machine that sleeps, a turn that outlives every deadline it was given.
   *
   * Without it the reclaim logic would be code that only tests ever ran.
   */
  private startSweeping(): void {
    // Once immediately, and before the guard below.
    //
    // The immediate pass matters more than the timer: an orphan left by an
    // earlier run sits in an application that has gone idle, and an idle
    // application runs no timer. Waiting for a tick would mean a short run
    // starting, finishing and stopping the sweeper without ever having swept.
    //
    // Unconditional, because the previous run's timer may not have been
    // cleared yet when the next one starts - and skipping the sweep on that
    // basis would make whether an orphan is noticed depend on a race.
    this.sweepOnce();
    if (this.sweeper) return;
    const everyMs = this.options.sweepIntervalMs ?? DEFAULTS.sweepIntervalMs;
    this.sweeper = setInterval(() => this.sweepOnce(), everyMs);
    // Never hold the process open on account of a timer.
    this.sweeper.unref?.();
  }

  private sweepOnce(): void {
    try {
      const swept = this.bus.sweep();
      for (const message of [...swept.requeued, ...swept.dead]) {
        // Said out loud rather than only recorded: a delegation nobody
        // answered is exactly the fact a person was previously left to infer
        // from a window that never changed.
        this.step(
          message.runId,
          message.iteration,
          'bus',
          message.status === 'dead' ? 'dead-letter' : 'requeued',
          message.failureReason ?? 'sem resposta dentro do prazo',
          { messageType: message.messageType, recipient: message.recipientAgentId },
        );
      }
    } catch {
      // A sweep that throws must never take the runs down with it.
    }
  }

  private stopSweeping(): void {
    if (!this.sweeper) return;
    clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /** Stops the timer. Called on shutdown, so nothing outlives the window. */
  dispose(): void {
    this.stopSweeping();
  }

  /**
   * Stops every run that is still going, and waits for it to actually stop.
   *
   * Called on the way down, before the database closes. Without it a loop
   * mid-iteration keeps reading a handle that is about to be pulled out from
   * under it, and the failure surfaces as "database is not open" from a
   * rejected promise nobody is waiting on - which is exactly what made CI red
   * once the run resumed on approval instead of ending there.
   *
   * Bounded: a runner that will not stop must not hold the shutdown for ever.
   */
  async drain(timeoutMs = 10_000): Promise<void> {
    for (const runId of [...this.active.keys()]) this.cancel(runId);
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /**
   * Records how a run ended, and closes anything it left in flight.
   *
   * Called from `finally`, so it runs on every exit - a clean finish, a throw,
   * a cancellation, a budget stop. A message still `pending` or `leased` when
   * the loop is gone belongs to nobody, and leaving it looking outstanding
   * would be a lie the next start-up would have to unpick.
   */
  private closeExchange(runId: string, sessionId: string): void {
    const run = this.database.runs.find(runId);
    if (!run) return;
    const type: AgentMessageType =
      run.status === 'DONE'
        ? 'RUN_COMPLETED'
        : run.status === 'CANCELLED'
          ? 'RUN_CANCELLED'
          : 'RUN_FAILED';
    this.busSafely(
      () => {
        this.bus.cancelRun(runId, `A execução terminou como ${run.status}.`);
        this.record({
          runId,
          conversationId: sessionId,
          iteration: run.iteration,
          messageType: type,
          payload: { status: run.status, iterations: run.iteration },
          senderAgentId: null,
          correlationId: `cor-run-${runId}`,
        });
      },
      runId,
      run.iteration,
    );
  }

  private finishCancelled(runId: string, sessionId: string): void {
    this.database.runs.setStatus(runId, 'CANCELLED', 'Cancelado pelo usuário.');
    // Every step still open gets a terminal status. A step left `running` is
    // what the interface draws as a spinner, and a cancelled run that kept
    // showing "Analisando" and "Revisando" is how a person lost track of which
    // run was finished, cancelled or still going.
    this.database.runs.closePendingSteps(runId, 'cancelled');
    this.say(sessionId, runId, 'system', 'Execução cancelada.');
    this.progress(runId, sessionId, 'cancelled', 'Cancelado.', 'CANCELLED');
  }

  /**
   * True when this run must not do anything else.
   *
   * Read from the database rather than only from the abort signal, so a
   * cancellation that arrived while an agent was running is seen even though
   * the signal fired inside an await nobody was checking.
   */
  private stopping(runId: string, signal: AbortSignal): boolean {
    if (signal.aborted) return true;
    try {
      return this.database.runs.cancelRequested(runId);
    } catch {
      return false;
    }
  }

  /**
   * Where the time went in each run, so it can be measured rather than guessed.
   *
   * Keyed by run id; each entry is the moment the previous step finished.
   * Every step's duration is the gap since then, so the durations of a run add
   * up to the run and no segment can hide between two of them.
   */
  private readonly phaseClock = new Map<string, number>();

  private step(
    runId: string,
    iteration: number,
    phase: string,
    status: string,
    summary: string,
    detail?: Record<string, unknown>,
  ): void {
    const finishedAt = Date.now();
    const startedAt = this.phaseClock.get(runId);
    this.phaseClock.set(runId, finishedAt);
    this.database.runs.addStep({
      runId,
      iteration,
      phase,
      status,
      summary: redact(summary).slice(0, 1000),
      // Diagnostics are stored redacted: a CLI's stderr can echo a header.
      detail: detail ? redact(JSON.stringify(detail)) : null,
      // The first step of a run has no predecessor, so it has no duration.
      // Reporting zero there would put a real segment at zero milliseconds.
      durationMs: startedAt === undefined ? null : finishedAt - startedAt,
    });
    this.events.emit('run:graph', {runId});
  }

  private say(
    sessionId: string,
    runId: string,
    author: string,
    body: string,
    payload?: Record<string, unknown>,
  ): ChatMessageView {
    const record = this.database.chat.addMessage({
      sessionId,
      runId,
      author,
      body,
      ...(payload ? { payload } : {}),
    });
    const view = toMessageView(record);
    this.events.emit('run:progress', {
      runId,
      sessionId,
      stage: 'message',
      label: body,
      status: 'RUNNING',
      message: view,
    });
    return view;
  }

  private progress(
    runId: string,
    sessionId: string,
    stage: string,
    label: string,
    status: string,
    extra: Partial<RunProgressEvent> = {},
  ): void {
    this.events.emit('run:progress', { runId, sessionId, stage, label, status, ...extra });
  }

  /**
   * Liveness, to the window, while the worker works.
   *
   * The ephemeral channel: nothing here is persisted, and nothing here is a
   * record of what happened. It exists so the interface can replace
   * "executando automaticamente" with how long the worker has been going, when
   * it last did anything, and what it is inside - the three facts that decide
   * whether waiting is reasonable.
   */
  private sayActivity(
    runId: string,
    sessionId: string,
    slot: WorkerSlot,
    snapshot: ActivitySnapshot,
  ): void {
    this.events.emit('run:activity', {
      runId,
      sessionId,
      agentId: slot.id,
      agentLabel: slot.label,
      startedAt: snapshot.startedAt,
      elapsedMs: snapshot.elapsedMs,
      lastActivityAt: snapshot.lastActivityAt,
      idleMs: snapshot.idleMs,
      currentTool: snapshot.currentTool,
      idleTimeoutMs: snapshot.idleTimeoutMs,
      label: `${slot.label}: ${describeActivity(snapshot)}`,
    });
  }
}

/**
 * True when this project is a conversation: no folder, no git, no commands.
 *
 * The environment column already said where a run executes; `conversation` is
 * the third answer - nowhere, because nothing needs executing. Reading it here
 * rather than from a second flag keeps one column as the single source of
 * "what kind of project is this".
 */
export function isConversation(workspace: WorkspaceWithAgents): boolean {
  return workspace.environment === 'conversation';
}

/**
 * A project whose code lives on GitHub and nowhere on this computer.
 *
 * Not a third kind of project in the sidebar - the same project, with a
 * different way of reaching its code. The loop is the same loop: the
 * orchestrator plans, the worker proposes, the application performs the
 * change, and evidence is measured rather than believed. What changes is where
 * the measurement comes from: GitHub instead of a folder.
 */
export function isGitHubProject(workspace: WorkspaceWithAgents): boolean {
  return workspace.environment === 'github' && Boolean(workspace.repository_url);
}

/**
 * The environment handed to `createRunners` for a conversation run.
 *
 * A factory still needs *something* to build against, and this says plainly
 * what is true: no working directory, and a process manager that refuses. If a
 * conversation run ever tried to spawn a process, this would throw rather than
 * quietly reach the user's machine.
 */
const NO_ENVIRONMENT: ExecutionEnvironment = {
  kind: 'local',
  id: '',
  workingDirectory: '',
  processes: {
    run: async () => {
      throw new Error('Uma conversa não executa processos.');
    },
    cancelAll: async () => {},
  },
};

/** The baseline of a run that has no working copy: everything empty, nothing dirty. */
const EMPTY_BASELINE: Baseline = {
  capturedAt: new Date(0).toISOString(),
  isGitRepository: false,
  commit: null,
  branch: null,
  statusShort: '',
  unstagedDiff: '',
  stagedDiff: '',
  modifiedFiles: [],
  stagedFiles: [],
  dirty: false,
};

/**
 * The team, as one list.
 *
 * A pair with no explicit team is a team of one built from `worker`, so every
 * caller written before teams could grow keeps working and behaves identically.
 */
export function teamOf(runners: RunnerPair): readonly WorkerSlot[] {
  if (runners.workers && runners.workers.length > 0) return runners.workers;
  return [
    {
      id: 'worker-1',
      label: 'Worker',
      runner: runners.worker,
      accountId: runners.workerAccountId,
      providerId: null,
      connectionKind: null,
      agentId: null,
      ...(runners.workerRouting ? { routing: runners.workerRouting } : {}),
    },
  ];
}

/**
 * The failures that must end a run rather than be tried again.
 *
 * Retrying an empty balance or a rejected key cannot succeed, and each attempt
 * may cost. Stopping with a sentence is the honest outcome; eight more
 * identical refusals is not.
 */
export function terminalFailure(
  failure: ProviderFailureKind | undefined,
  /**
   * What the provider or CLI actually said, when anything was captured.
   *
   * Used only to say the *right* thing about credits: "out of usage credits"
   * is not "the subscription ran out", and a run that reported the second
   * when the provider said the first would send somebody to fix the wrong
   * thing. When the text says nothing precise, the general sentence stands.
   */
  detail?: string | null,
): string | null {
  switch (failure) {
    case 'tool-permission-denied':
      return (
        'O worker foi impedido de usar uma ferramenta de que precisava (ver "Ferramentas ' +
        'recusadas" em Detalhes). Repetir a mesma tarefa não muda isso, e um modelo mais ' +
        'forte também não: é uma permissão, não uma dificuldade. Autorize a operação e ' +
        'continue quando quiser.'
      );
    case 'approval-required':
      return (
        'A execução precisa de uma aprovação que ninguém pode dar em modo não interativo. ' +
        'Autorize a operação e continue quando quiser.'
      );
    case 'workspace-invalid':
      return (
        'A pasta deste projeto não pôde ser usada para escrever. Verifique o caminho e as ' +
        'permissões da pasta em Projeto, e continue quando quiser.'
      );
    case 'insufficient-credit': {
      const read = classifyCreditFailure(detail);
      if (read.cause !== 'unknown') {
        return `${read.message} A execução parou aqui: insistir só repetiria a recusa.`;
      }
      return (
        'A conexão foi recusada por saldo, cota ou direito de uso, e a mensagem do provedor ' +
        'não diz qual dos três. A execução parou aqui: insistir só repetiria a recusa.'
      );
    }
    case 'authentication':
      return 'A credencial desta conexão não foi aceita. Atualize a chave em Contas e continue quando quiser.';
    case 'permission':
      return 'Esta conexão não tem permissão para o que foi pedido. Verifique a conta no provider.';
    default:
      return null;
  }
}

/**
 * What a runner declares it can do, or null when it declares nothing.
 *
 * Null is the honest answer for the CLI adapters and the tests' scripted
 * agents: they predate the capability declaration, and *absence of a
 * declaration is not a declaration of absence*. Only an explicit
 * `toolExecution: false` refuses a delegation.
 */
export function capabilitiesOfRunner(runner: AgentRunner): ProviderCapabilities | null {
  return isAgentProvider(runner) ? runner.getCapabilities() : null;
}

/** The ledger, as the interface renders it. Nulls stay nulls. */
export function usageView(budget: BudgetLedger): {
  invocations: number;
  tokens: number | null;
  costUsd: number | null;
  unpriced: number;
} {
  const totals = budget.snapshot;
  return {
    invocations: totals.invocations,
    tokens: totals.tokens > 0 ? totals.tokens : null,
    costUsd: totals.costUsd > 0 ? totals.costUsd : null,
    unpriced: totals.unpricedInvocations,
  };
}

/**
 * True when the tool says the session we asked it to continue is gone.
 *
 * Narrow on purpose. This must not swallow a real failure into a silent
 * retry, so it matches the tool's own wording for this one case - Claude Code
 * prints `No conversation found with session ID: <id>` - and nothing broader.
 * Anything else is reported as the failure it is.
 */
export function sessionMissing(result: AgentResult): boolean {
  if (result.exitCode === 0) return false;
  const said = `${result.stderr}\n${result.stdout}`;
  return (
    /no conversation found with session id/i.test(said) ||
    /session .{0,80}(not found|does not exist)/i.test(said)
  );
}

/** A classified failure, in the words the orchestrator should reason with. */
export function failureExplanation(failure: ProviderFailureKind): string {
  switch (failure) {
    case 'tool-permission-denied':
      return 'The worker was refused a tool it needed. Its permission, not its ability, is what stopped it.';
    case 'approval-required':
      return 'The work needs a human approval that cannot be given in a non-interactive run.';
    case 'empty-response':
      return 'The worker ran and returned nothing to act on.';
    case 'workspace-invalid':
      return 'The project folder could not be used for writing.';
    case 'evidence-unavailable':
      return 'The program could not observe the workspace, so it cannot say what changed.';
    case 'authentication':
      return "The worker's credential was not accepted.";
    case 'insufficient-credit':
      return (
        "The worker's account refused the call for credit or quota reasons. This is not a " +
        'reasoning failure, so do not answer it by asking for a stronger model - a stronger ' +
        'model is usually the more expensive one, and it is what caused this.'
      );
    case 'rate-limit':
      return 'The provider asked to wait before the next call.';
    case 'timeout':
      return 'The worker did not answer within the time allowed.';
    case 'no-activity':
      return (
        'The worker was running but produced nothing at all for long enough to be ' +
        'considered stuck. This says nothing about the difficulty of the task, so do ' +
        'not answer it by asking for a stronger model.'
      );
    case 'model-unavailable':
      return 'The model requested is not available to this account.';
    default:
      return `The worker failed: ${failure}.`;
  }
}

/**
 * Why this folder cannot be worked in, or null when it can.
 *
 * Three separate questions, because they have three different fixes: the path
 * is empty (no project folder chosen), the path is not a usable directory
 * (moved, deleted, a file), or the directory cannot be written (permissions,
 * a read-only volume). Answering "no progress" to any of them, which is what
 * happened before this existed, tells the person nothing.
 *
 * The write check writes and removes a probe file rather than reading a
 * permission bit: on Windows the bits do not answer the question, and the
 * thing that matters is whether *this* process can create a file here - which
 * is exactly what the worker is about to try.
 */
export function describeWorkspaceProblem(cwd: string): string | null {
  if (!cwd || cwd.trim() === '') {
    return 'Este projeto não tem uma pasta definida. Escolha a pasta do projeto antes de enviar uma tarefa de código.';
  }
  let stats;
  try {
    stats = statSync(cwd);
  } catch {
    return `A pasta do projeto não foi encontrada: ${cwd}. Escolha-a novamente em Projeto.`;
  }
  if (!stats.isDirectory()) {
    return `O caminho do projeto não é uma pasta: ${cwd}.`;
  }
  const probe = join(cwd, `.ai-orchestrator-write-probe-${process.pid}`);
  try {
    writeFileSync(probe, '');
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    return (
      `O aplicativo não consegue escrever na pasta do projeto (${cwd}${code ? `, ${code}` : ''}). ` +
      'O worker não conseguiria criar ou alterar arquivos ali. Verifique as permissões da pasta.'
    );
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      // The probe is best-effort cleanup; a leftover empty file is harmless
      // and must not turn a usable workspace into a refused one.
    }
  }
  return null;
}

/** A cheap fingerprint of the working tree, to tell one attempt's outcome from the next. */
function treeKey(statusShort: string, diff: string): string {
  return `${statusShort.trim()}\n${diff.length}:${diff.slice(0, 4000)}`;
}

function verificationNote(results: readonly CommandResult[]): string {
  if (results.length === 0) return 'Nenhuma verificação foi executada nesta iteração.';
  const failed = results.filter((r) => !commandPassed(r)).map((r) => r.command);
  return failed.length === 0 ? 'Todas as verificações passaram.' : `Falharam: ${failed.join(', ')}`;
}

/**
 * Evidence as the timeline shows it.
 *
 * The full diff is deliberately left behind: it can be megabytes, it is
 * already on disk under the run's artifacts, and putting it on every event
 * would make a remote run's log grow with the size of the change rather than
 * with what happened. The diffstat is what a person reads at a glance.
 */
function toEvidenceView(evidence: GitEvidence): RunEvidenceView {
  const stat = evidence.diffStat ?? '';
  const totals = /(\d+) insertions?\(\+\)|(\d+) deletions?\(-\)/g;
  let insertions = 0;
  let deletions = 0;
  for (const match of stat.matchAll(totals)) {
    if (match[1]) insertions = Number(match[1]);
    if (match[2]) deletions = Number(match[2]);
  }
  return {
    changed: evidence.changedSinceBaseline,
    changedFiles: evidence.changedFiles.slice(0, 200),
    insertions,
    deletions,
    diffstat: stat.length > 8000 ? `${stat.slice(0, 8000)}\n…` : stat,
    branch: evidence.branch,
    commit: evidence.commit,
  };
}

function describeFiles(evidence: GitEvidence): string {
  const files = evidence.changedFiles.slice(0, 8).join(', ');
  const extra = evidence.changedFiles.length > 8 ? ` (+${evidence.changedFiles.length - 8})` : '';
  return files.length > 0 ? `${files}${extra}` : 'nenhum arquivo';
}

/** A bounded, single-string excerpt of what a CLI printed. */
function excerpt(text: string, max = 600): string {
  const trimmed = text.replace(/\r/g, '').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * The line a person should read first: the CLI's own ERROR line when it
 * printed one, otherwise the first non-empty line. A crashing Codex prints
 * warnings before the error that explains the exit, and the warning is not
 * the story.
 */
function errorLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const error = lines.find((l) => /\b(ERROR|error:|Error:|panicked)\b/.test(l));
  return (error ?? lines[0] ?? '').slice(0, 400);
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0)
      ?.slice(0, 300) ?? ''
  );
}

function capitalize(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
}

function indent(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join('\n');
}

/**
 * The tools the runtime observed, in order, without repeats.
 *
 * Best effort by design: an activity note is a status line, so a runtime that
 * reports none produces an empty list and the report says nothing about tools
 * rather than guessing at them.
 */
function toolsUsed(activity: ActivitySnapshot | undefined): string[] {
  if (!activity) return [];
  const seen: string[] = [];
  for (const note of activity.recent) {
    // Only `tool` notes carry a tool name; the detail of an `output` note is a
    // fragment of the worker's own text and has no business in this list.
    if (note.kind !== 'tool') continue;
    const tool = note.detail.trim();
    if (tool && !seen.includes(tool)) seen.push(tool);
  }
  if (activity.currentTool && !seen.includes(activity.currentTool)) seen.push(activity.currentTool);
  return seen;
}

/**
 * A stable summary of everything an iteration proved.
 *
 * Deliberately built from *measurements* - the tree, the verifications the
 * application ran, the files it read, and how the ledger stands - and not from
 * anything an agent said. Two iterations whose prose differed but whose
 * evidence is identical must hash the same, because that is exactly the case
 * this exists to catch.
 */
function evidenceFingerprint(input: {
  tree: string;
  verification: readonly CommandResult[];
  fileChecks: readonly FileCheckResult[];
  pending: readonly string[];
}): string {
  const parts = [
    input.tree,
    ...input.verification.map((result) => `${result.command}=${result.exitCode}:${result.refused ?? ''}`),
    ...input.fileChecks.map((check) => `${check.request.path}=${check.outcome}:${check.sha256 ?? ''}`),
    ...[...input.pending].sort(),
  ];
  return createHash('sha1').update(parts.join('\u0000')).digest('hex');
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'userMessage' in error) {
    const message = (error as { userMessage?: unknown }).userMessage;
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** A stored kind string back to the union, defaulting to the neutral one. */
function contextKindOf(kind: string): ContextEntry['kind'] {
  switch (kind) {
    case 'objective':
    case 'decision':
    case 'architecture':
    case 'rule':
    case 'state':
    case 'evidence':
      return kind;
    default:
      return 'state';
  }
}

/**
 * What the worker is allowed to do, said before the task.
 *
 * A worker that does not know its own permissions spends a turn discovering
 * them: it reaches for a shell, is refused, and the run ends with nothing
 * written. This is three sentences of fact - the tools that run without a
 * prompt, the ones that do not, and what to do when it needs one - and it
 * costs a few dozen tokens against a wasted 42-second invocation.
 *
 * It is deliberately not an instruction to avoid shells. A task that genuinely
 * needs a command run should ask for one and be refused *visibly*, so a person
 * can approve it. What this prevents is reaching for PowerShell to write six
 * bytes that `Write` writes without asking anyone.
 */
export function toolPolicyPreamble(
  grants: readonly string[],
  refusals: readonly string[] = [],
  repository: string | null = null,
): string {
  const lines = [
    'TOOL POLICY FOR THIS DELEGATION (from the application, not from the task):',
    '- Read, Write, Edit, Glob and Grep run without asking, inside the working directory.',
    '  Use them for file content. Creating or changing a file needs no shell.',
    '- Bash and PowerShell are NOT pre-approved. This is a non-interactive run, so a',
    '  permission prompt cannot be answered and the call is refused outright.',
  ];
  if (grants.length > 0) {
    lines.push(
      `- Approved by the person for this project, and only these: ${grants.join(', ')}.`,
    );
  }
  // What the person said no to. Without this the worker reaches for the same
  // tool every round, the application declines to ask again - because a
  // refusal is a decision - and the run goes in circles with nobody saying
  // why.
  if (refusals.length > 0) {
    lines.push(
      `- REFUSED by the person, and not up for asking again: ${refusals.join(', ')}.`,
      '  Do not call these. Do the task another way, or say what is missing.',
    );
  }
  // A repository question is answered by the application, not by the worker
  // fetching a web page. The incident: a read-only question about a GitHub
  // repository sent the worker to WebFetch, the runtime refused it for lack
  // of authorisation, and the answer that came back read as though the
  // repository might not exist. It did exist. A refused tool says nothing
  // whatsoever about a repository.
  if (repository) {
    lines.push(
      `- This project is connected to the repository ${repository}. The application reads it`,
      '  through the GitHub API and puts what it read in your task. You do NOT need WebFetch,',
      '  curl or a browser for it. If something about the repository is missing from your task,',
      '  say which part is missing rather than fetching it yourself.',
    );
  }
  lines.push(
    '- If the task genuinely needs a command run, say so plainly in your answer and name',
    '  the exact command. The application will ask the person to approve that command,',
    '  and the task will be delegated again once they do. Do not work around a refusal.',
    '- Never conclude that something does not exist because a tool was refused. A refusal is',
    '  about permission, not about the world: report that you could not check, and why.',
  );
  return lines.join('\n');
}

/**
 * A GitHub failure, in the words that name which of the four things went wrong.
 *
 * Authentication, repository access, write permission and a branch conflict
 * have four different fixes, and "erro do GitHub" sends a person to the wrong
 * setting. A conflict in particular is not an error the run should retry
 * blindly: somebody else's work is there, and it stays.
 */
export function describeGitHubProblem(error: unknown): string {
  if (error instanceof RepositoryConflictError) {
    return (
      `${error.message} Outra pessoa (ou outra execução) publicou nessa branch. ` +
      'Releia o estado atual antes de propor a alteração de novo; nada foi sobrescrito.'
    );
  }
  if (error instanceof UnsupportedChangeError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why a command did not run in a project that has no executor.
 *
 * Said in one place so the gate, the report and the screen all give the person
 * the same sentence - and so it names the alternative rather than stopping at
 * "não deu".
 */
const NO_EXECUTOR =
  'Este projeto trabalha direto no GitHub, e a API do GitHub não executa código: ' +
  'este comando não foi executado. Para rodar testes ou ferramentas, use um executor ' +
  'temporário neste computador.';

/** One line naming what a listing request asked for. */
export function describeListRequest(request: {
  prefix?: string | null;
  contains?: string | null;
  limit?: number | null;
}): string {
  const parts = [
    request.prefix ? `prefix "${request.prefix}"` : null,
    request.contains ? `contains "${request.contains}"` : null,
    request.limit ? `limite ${request.limit}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(', ') : 'árvore inteira';
}

/** True when a file check already decided this criterion, either way. */
function settledByFileCheck(checks: readonly FileCheckResult[], criterion: string): boolean {
  const wanted = criterion.trim();
  return checks.some((check) => (check.request.criteria ?? []).some((c) => c.trim() === wanted));
}
