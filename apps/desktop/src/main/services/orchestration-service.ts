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
  evaluateConversationDone,
  evaluateDone,
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

export interface OrchestrationOptions {
  maxIterations?: number;
  agentTimeoutMs?: number;
  verificationTimeoutMs?: number;
  /** Accepts a run that changed no file. Off by default: see the DONE gate. */
  allowNoChanges?: boolean;
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
export type ReadinessCheck = (workspace: WorkspaceWithAgents) => Promise<string | null>;

const DEFAULTS = {
  maxIterations: 8,
  agentTimeoutMs: 15 * 60_000,
  verificationTimeoutMs: 10 * 60_000,
};

export class OrchestrationService {
  private readonly active = new Map<string, AbortController>();
  /** Runners of in-flight runs, so cancelling can reach the child processes. */
  private readonly runners = new Map<string, RunnerPair>();
  /** Environments of in-flight runs, so each is released exactly once. */
  private readonly environments = new Map<string, ExecutionEnvironment>();

  constructor(
    private readonly database: Database,
    private readonly processManager: ProcessRunner,
    private readonly events: EventBus,
    private readonly createRunners: RunnerFactory,
    private readonly options: OrchestrationOptions = {},
    private readonly checkReadiness: ReadinessCheck = async () => null,
  ) {}

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
  cancel(runId: string): boolean {
    const controller = this.active.get(runId);
    if (!controller) {
      // A run waiting at the human gate is not running, but it is still
      // open. Cancelling it closes the question: the person chose to stop.
      const run = this.database.runs.find(runId);
      if (run && run.status === 'BLOCKED') {
        this.database.runs.setStatus(runId, 'CANCELLED', 'Encerrada pelo usuário na revisão humana.');
        this.step(runId, run.iteration, 'cancelled', 'dismissed', 'Encerrada na revisão humana.');
        if (run.session_id) {
          this.say(run.session_id, runId, 'system', 'Execução encerrada na revisão humana.');
          this.progress(runId, run.session_id, 'cancelled', 'Encerrada.', 'CANCELLED');
        }
        return true;
      }
      return false;
    }
    controller.abort();
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
    });

    const controller = new AbortController();
    this.active.set(run.id, controller);

    void this.execute(run.id, workspace, input.objective, controller)
      .catch((error: unknown) => {
        const reason = describeError(error);
        this.database.runs.setStatus(run.id, 'FAILED', reason);
        this.step(run.id, this.database.runs.require(run.id).iteration, 'error', 'failed', reason, {
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        this.say(session.id, run.id, 'system', `Falhou: ${reason}`);
        this.progress(run.id, session.id, 'failed', 'Falhou.', 'FAILED');
      })
      .finally(() => {
        this.active.delete(run.id);
        this.runners.delete(run.id);
        // Whatever the run cost - a container, a clone, a lease - is given
        // back exactly once, on every path out of the loop.
        const environment = this.environments.get(run.id);
        this.environments.delete(run.id);
        void environment?.release?.().catch(() => {});
      });

    return toRunView(this.database.runs.require(run.id), []);
  }

  /**
   * Called once at start-up: a run the database still shows as running was
   * cut short by the previous process ending. Nothing is executing it now, so
   * the truth is recorded rather than an eternal spinner.
   */
  reconcileInterrupted(): number {
    let count = 0;
    for (const run of this.database.runs.listUnfinished()) {
      if (this.active.has(run.id)) continue;
      const reason = 'Interrompida: o aplicativo foi fechado durante a execução.';
      this.database.runs.setStatus(run.id, 'FAILED', reason);
      this.step(run.id, run.iteration, 'interrupted', 'failed', reason);
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
    return toRunDetailView(
      run,
      this.database.runs.steps(runId),
      this.database.runs.invocations(runId),
      this.database.runs.verifications(runId),
    );
  }

  // -- the loop ------------------------------------------------------------

  private async execute(
    runId: string,
    workspace: WorkspaceWithAgents,
    objective: string,
    controller: AbortController,
  ): Promise<void> {
    const sessionId = this.database.runs.require(runId).session_id!;
    const signal = controller.signal;
    const maxIterations = this.options.maxIterations ?? DEFAULTS.maxIterations;

    this.database.runs.setStatus(runId, 'RUNNING');
    this.progress(runId, sessionId, 'analysing', 'Analisando...', 'RUNNING');

    // Ask before spending fifteen minutes finding out.
    const problem = await this.checkReadiness(workspace);
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

    // Where this run executes. Everything below - evidence, verification, both
    // agents - goes through this one environment, so the loop never mixes a
    // remote workspace's path with a local runner or the other way round.
    // A conversation run resolves none: there is nothing to provision, so
    // nothing is provisioned and nothing is charged for.
    const environment = conversation ? null : await this.resolveEnvironment(workspace, signal);
    if (environment) this.environments.set(runId, environment);
    const cwd = environment?.workingDirectory ?? '';

    const runners = await this.createRunners(workspace, environment ?? NO_ENVIRONMENT);
    this.runners.set(runId, runners);
    const team = teamOf(runners);
    const budget = new BudgetLedger(runners.budget ?? this.options.budget ?? {});

    const gitCommand = conversation
      ? undefined
      : await this.options.gitCommand?.().catch(() => undefined);
    const collector =
      environment && !conversation
        ? gitCommand
          ? new GitEvidenceCollector(cwd, environment.processes, gitCommand)
          : new GitEvidenceCollector(cwd, environment.processes)
        : null;
    const verifier =
      environment && !conversation
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

    const baseline = collector ? await collector.captureBaseline() : EMPTY_BASELINE;
    if (collector) {
      this.database.runs.setBaseline(runId, baseline.branch, baseline.commit, baseline.dirty);
      this.step(runId, 0, 'baseline', 'ok', baseline.commit ?? 'sem commit');
    }

    const ledger = new AcceptanceCriteriaLedger();
    const iterations: IterationRecord[] = [];
    /** Every command actually resolved from an id, deduplicated. */
    const resolvedCommands = new Set<string>();
    let feedback: string | null = null;

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
    const attempts: PreviousAttempt[] = [];
    const unavailableModels: string[] = [];
    /** The last answer a worker gave, which is what a conversation run ends with. */
    let lastWorkerAnswer = '';
    let previousTree = treeKey(baseline.statusShort, baseline.unstagedDiff + baseline.stagedDiff);
    let warnedOrchestratorLevel = false;
    // What was said in this conversation before this run, so a follow-up
    // ("continue", "now also do X") is read against what came before it.
    const history = this.conversationBefore(sessionId, runId);

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (signal.aborted) return this.finishCancelled(runId, sessionId);
      this.database.runs.setIteration(runId, iteration);

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
        team,
      });
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
      if (signal.aborted) return this.finishCancelled(runId, sessionId);
      if (!asked.decision) {
        // Say exactly what happened - the CLI's exit, or what it answered
        // instead of a decision - rather than a sentence that fits everything.
        const reason = asked.failure ?? 'O orquestrador não devolveu uma decisão válida.';
        this.database.runs.setStatus(runId, 'FAILED', reason);
        this.say(sessionId, runId, 'system', `Falhou: ${reason}`);
        this.progress(runId, sessionId, 'failed', 'Falhou.', 'FAILED');
        return;
      }
      const decision = asked.decision;
      record.decision = decision;
      ledger.add(decision.acceptanceCriteria, iteration);

      if (decision.summary) {
        this.say(sessionId, runId, 'orchestrator', decision.summary);
      }

      // 2. Act on it.
      if (decision.action === 'blocked') {
        const reason = decision.reason ?? 'Sem motivo informado.';
        this.database.runs.setStatus(runId, 'BLOCKED', reason);
        this.say(sessionId, runId, 'orchestrator', `Bloqueado: ${reason}`);
        this.progress(runId, sessionId, 'blocked', 'Bloqueado.', 'BLOCKED');
        return;
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
          routing: slot.routing ?? null,
          capabilities: capabilitiesOf.get(slot.id) ?? NO_CAPABILITIES,
          attempts,
          unavailableModels,
          signal,
          budget,
        });
        record.worker = delegated.record;
        if (delegated.answer.trim()) lastWorkerAnswer = delegated.answer;

        // A provider that will keep refusing must stop the run rather than be
        // asked again eight times: an empty balance and a rejected credential
        // are not made better by another attempt, and each attempt may cost.
        const terminal = terminalFailure(delegated.record.failure);
        if (terminal) {
          this.database.runs.setStatus(runId, 'NEEDS_HUMAN', terminal);
          this.say(sessionId, runId, 'system', terminal);
          this.step(runId, iteration, 'worker', 'needs-human', terminal);
          this.progress(runId, sessionId, 'needs-human', terminal, 'NEEDS_HUMAN');
          return;
        }
        if (signal.aborted) return this.finishCancelled(runId, sessionId);
      }

      // 3. Collect evidence ourselves, whatever the worker claims.
      //
      // A conversation run collects none, and says so by having none: it must
      // never report a diff or a changed file, because there is no working
      // copy for one to have happened in.
      if (!collector) {
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
            if (answer) this.say(sessionId, runId, 'orchestrator', answer);
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
      const evidence: GitEvidence = await collector.collectEvidence(baseline);
      record.evidence = evidence;
      // Progress is measured against the tree the previous attempt left,
      // not against the baseline: an iteration that changes nothing after
      // one that did is "no progress", and the router must hear that.
      const tree = treeKey(evidence.statusShort, evidence.diff);
      if (record.worker) {
        record.worker.progressed = tree !== previousTree;
        attempts.push({
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
        verification = await verifier!.runAll(resolution.commands);
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
      }

      // Evidence, not assertion, is what marks a criterion satisfied.
      const allPassed =
        verification.length > 0 && verification.every(commandPassed) && unknownIds.length === 0;
      for (const criterion of decision.acceptanceCriteria) {
        ledger.markByText(
          criterion,
          allPassed ? 'satisfied' : 'failed',
          iteration,
          verificationNote(verification),
        );
      }

      // 5. `done` is a request. The gate decides.
      if (decision.action === 'done') {
        this.progress(runId, sessionId, 'review', 'Codex revisando...', 'RUNNING');
        const fresh = await collector.collectEvidence(baseline);
        const gate = await evaluateDone({
          ledger,
          verificationCommands: [...resolvedCommands],
          iterations,
          baseline,
          evidence: fresh,
          verifier: verifier!,
          allowNoChanges: this.options.allowNoChanges ?? false,
        });
        record.doneRejection = gate.passed ? undefined : gate;
        this.step(runId, iteration, 'done-gate', gate.passed ? 'passed' : 'rejected', gate.failures.join('; ').slice(0, 500));

        if (gate.passed) {
          this.database.runs.setStatus(runId, 'DONE', 'Validação independente aprovada.');
          this.say(sessionId, runId, 'orchestrator', 'Tarefa concluída e verificada.');
          this.sayCost(sessionId, runId, budget);
          this.progress(runId, sessionId, 'done', 'Tarefa concluída.', 'DONE');
          return;
        }
        feedback = formatDoneRejection(gate);
        this.say(sessionId, runId, 'system', 'A validação final não passou; o orquestrador vai corrigir.');
        continue;
      }

      // 6. Otherwise, feed the results back and go round again.
      feedback = this.buildFeedback(evidence, verification, unknownIds, record);
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
  }): Promise<{ decision: Decision | null; failure?: string }> {
    const { runId, workspace, cwd, runners, iteration, signal } = input;
    let currentPrompt = input.prompt;
    let lastProblem = 'nenhuma resposta';
    let lastExcerpt = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const startedAt = new Date().toISOString();
      const result = await runners.orchestrator.run({
        prompt: currentPrompt,
        workingDirectory: cwd,
        timeoutMs: this.options.agentTimeoutMs ?? DEFAULTS.agentTimeoutMs,
        runId,
        iteration,
      });
      // Counted before anything is decided about the answer: a repair round
      // trip is a second call and costs a second time.
      input.budget.record(result.usage ?? null);
      const orchestratorCapabilities = capabilitiesOfRunner(runners.orchestrator);
      this.database.runs.recordInvocation({
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
        // The orchestrator's model and level are the person's fixed choice;
        // what is recorded is what the adapter really sent, after checking
        // the level against the installed build.
        routing: result.applied
          ? {
              requestedCapability: null,
              requestedReasoning: null,
              resolvedModel: result.applied.model,
              resolvedReasoning: result.applied.reasoning,
              selectionMode: 'fixed',
              selectionReason: result.applied.note
                ? result.applied.note
                : 'configuração fixa do orquestrador' +
                  (workspace.orchestrator_model || workspace.orchestrator_reasoning ? '' : ' (padrão do CLI)'),
              fallbackUsed: result.applied.fallbackUsed,
            }
          : null,
      });
      if (result.applied) input.onApplied?.(result.applied);
      if (signal.aborted) return { decision: null };

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
    team: readonly WorkerSlot[];
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
        return `  ${slot.id} - ${slot.label}: ${can}`;
      }),
      '',
      ...(input.conversation
        ? [
            'THIS IS A CONVERSATION RUN. There is no workspace, no repository and no command',
            'to run. Nothing you or a worker says will change a file, and you must not claim',
            'otherwise, ask for a verification, or describe a diff. Finish by answering the',
            'objective: reply with action "done", put the final answer for the person in',
            '"summary", and list in "satisfiedCriteria" the criteria your own review of the',
            "worker's answer found satisfied.",
            '',
          ]
        : [
            `WORKSPACE: ${input.cwd}`,
            '',
            'BASELINE:',
            `  branch: ${input.baseline.branch ?? '(none)'}`,
            `  commit: ${input.baseline.commit ?? '(none)'}`,
            `  dirty:  ${input.baseline.dirty ? 'yes' : 'no'}`,
            '',
            'AVAILABLE VERIFICATIONS (request them by id, never by command line):',
            ...(catalogue.length > 0
              ? catalogue.map((row) => `  ${row.id} - ${row.label}`)
              : ['  (none registered for this workspace)']),
            '',
          ]),
      'Answer with a single JSON object and nothing else:',
      '{',
      '  "action": "delegate" | "verify" | "done" | "blocked",',
      '  "task": "what the coding agent must do (required for delegate)",',
      '  "acceptanceCriteria": ["objective, checkable statements"],',
      '  "verificationCommands": ["verification ids from the list above"],',
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

  private buildFeedback(
    evidence: GitEvidence,
    verification: readonly CommandResult[],
    unknownIds: readonly string[],
    record?: IterationRecord,
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
    lines.push('GIT EVIDENCE (collected by the orchestrator, not reported by the agent):');
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
      );
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
    routing: WorkerRoutingSource | null;
    capabilities: WorkerRuntimeCapabilities;
    attempts: readonly PreviousAttempt[];
    unavailableModels: string[];
    signal: AbortSignal;
    budget: BudgetLedger;
  }): Promise<{ record: NonNullable<IterationRecord['worker']>; answer: string }> {
    const { runId, sessionId, workspace, cwd, runners, slot, iteration, task } = input;
    let last: NonNullable<IterationRecord['worker']> | null = null;
    let answer = '';

    for (let attempt = 0; attempt <= MODEL_RETRIES; attempt += 1) {
      const routed: RouterOutput | null = input.routing
        ? routeWorkerModel({
            provider: input.routing.provider,
            accountId: runners.workerAccountId,
            task,
            requested: input.decision.workerRequirements ?? null,
            previousAttempts: input.attempts,
            capabilities: input.capabilities,
            selection: input.routing.selection,
            manual: input.routing.manual,
            unavailableModels: input.unavailableModels,
          })
        : null;

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

      this.say(
        sessionId,
        runId,
        'worker',
        attempt === 0 ? `${slot.label}: ${task}` : `${slot.label}, tentando outro modelo: ${task}`,
        { workerId: slot.id, workerLabel: slot.label, ...(planned ? { routing: planned } : {}) },
      );

      const startedAt = new Date().toISOString();
      const result = await slot.runner.run({
        prompt: task,
        workingDirectory: cwd,
        timeoutMs: this.options.agentTimeoutMs ?? DEFAULTS.agentTimeoutMs,
        runId,
        iteration,
        ...(routed ? { routing: { model: routed.resolvedModel, reasoning: routed.resolvedReasoning } } : {}),
      });

      // What was actually sent wins over what was planned: the adapter may
      // have dropped a flag its build does not take.
      const recorded: RoutingRecord | null = planned
        ? {
            ...planned,
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
      const mechanical = !modelUnavailable && isMechanicalFailure(result);

      input.budget.record(result.usage ?? null);
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
      };
      this.database.runs.recordInvocation({
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
      });
      this.step(runId, iteration, 'worker', result.outcome, task.slice(0, 200), {
        attempt: attempt + 1,
        workerId: slot.id,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ...(result.executable ? { executable: result.executable } : {}),
        ...(recorded ? { routing: recorded } : {}),
        ...(modelUnavailable ? { modelUnavailable: true } : {}),
        ...(mechanical ? { mechanical: true } : {}),
        stderrExcerpt: excerpt(result.stderr),
      });

      // A failure that another model cannot fix - no balance, a rejected key -
      // must not be answered by trying another model, which would only spend
      // again to be refused again.
      if (terminalFailure(result.failure)) return { record: last, answer };
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
    const slot = wanted ? team.find((entry) => entry.id === wanted) : team[0];
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

  private finishCancelled(runId: string, sessionId: string): void {
    this.database.runs.setStatus(runId, 'CANCELLED', 'Cancelado pelo usuário.');
    this.say(sessionId, runId, 'system', 'Execução cancelada.');
    this.progress(runId, sessionId, 'cancelled', 'Cancelado.', 'CANCELLED');
  }

  private step(
    runId: string,
    iteration: number,
    phase: string,
    status: string,
    summary: string,
    detail?: Record<string, unknown>,
  ): void {
    this.database.runs.addStep({
      runId,
      iteration,
      phase,
      status,
      summary: redact(summary).slice(0, 1000),
      // Diagnostics are stored redacted: a CLI's stderr can echo a header.
      detail: detail ? redact(JSON.stringify(detail)) : null,
    });
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
export function terminalFailure(failure: ProviderFailureKind | undefined): string | null {
  switch (failure) {
    case 'insufficient-credit':
      return (
        'A conexão está sem saldo ou fora da cota do provider. A execução parou aqui: ' +
        'insistir só repetiria a recusa. Resolva o saldo e continue quando quiser.'
      );
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

function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'userMessage' in error) {
    const message = (error as { userMessage?: unknown }).userMessage;
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : String(error);
}
