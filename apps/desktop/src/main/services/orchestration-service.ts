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
import type { ChatMessageView, RunDetailView, RunView } from '../../shared/ipc-contract.js';
import type { EventBus } from '../events.js';
import { toMessageView, toRunDetailView, toRunView } from './views.js';

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

    // Where this run executes. Everything below - evidence, verification, both
    // agents - goes through this one environment, so the loop never mixes a
    // remote workspace's path with a local runner or the other way round.
    const environment = await this.resolveEnvironment(workspace, signal);
    this.environments.set(runId, environment);
    const cwd = environment.workingDirectory;

    const runners = await this.createRunners(workspace, environment);
    this.runners.set(runId, runners);
    const gitCommand = await this.options.gitCommand?.().catch(() => undefined);
    const collector = gitCommand
      ? new GitEvidenceCollector(cwd, environment.processes, gitCommand)
      : new GitEvidenceCollector(cwd, environment.processes);
    const verifier = new Verifier({
      cwd,
      timeoutMs: this.options.verificationTimeoutMs ?? DEFAULTS.verificationTimeoutMs,
      processManager: environment.processes,
      signal,
    });

    const baseline = await collector.captureBaseline();
    this.database.runs.setBaseline(runId, baseline.branch, baseline.commit, baseline.dirty);
    this.step(runId, 0, 'baseline', 'ok', baseline.commit ?? 'sem commit');

    const ledger = new AcceptanceCriteriaLedger();
    const iterations: IterationRecord[] = [];
    /** Every command actually resolved from an id, deduplicated. */
    const resolvedCommands = new Set<string>();
    let feedback: string | null = null;

    // Routing state for this run: what the worker's CLI can take (read once,
    // for this account), the attempts so far as the router reads them, the
    // models the CLI refused, and the tree as the last attempt left it.
    const routing = runners.workerRouting ?? null;
    const capabilities = routing
      ? await routing.capabilities().catch(() => NO_CAPABILITIES)
      : NO_CAPABILITIES;
    const attempts: PreviousAttempt[] = [];
    const unavailableModels: string[] = [];
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

      // 1. Ask the orchestrator what to do.
      this.progress(runId, sessionId, 'orchestrator', 'Codex preparando a tarefa...', 'RUNNING');
      const prompt = this.buildOrchestratorPrompt({
        workspace,
        cwd,
        objective,
        baseline,
        iteration,
        feedback,
        iterations,
        history,
      });
      const asked = await this.askForDecision({
        runId,
        workspace,
        cwd,
        runners,
        prompt,
        iteration,
        signal,
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
        this.progress(runId, sessionId, 'worker', 'Claude executando...', 'RUNNING');
        record.worker = await this.delegate({
          runId,
          sessionId,
          workspace,
          cwd,
          runners,
          iteration,
          task,
          decision,
          routing,
          capabilities,
          attempts,
          unavailableModels,
          signal,
        });
        if (signal.aborted) return this.finishCancelled(runId, sessionId);
      }

      // 3. Collect evidence ourselves, whatever the worker claims.
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
        verification = await verifier.runAll(resolution.commands);
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
          verifier,
          allowNoChanges: this.options.allowNoChanges ?? false,
        });
        record.doneRejection = gate.passed ? undefined : gate;
        this.step(runId, iteration, 'done-gate', gate.passed ? 'passed' : 'rejected', gate.failures.join('; ').slice(0, 500));

        if (gate.passed) {
          this.database.runs.setStatus(runId, 'DONE', 'Validação independente aprovada.');
          this.say(sessionId, runId, 'orchestrator', 'Tarefa concluída e verificada.');
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
      this.database.runs.recordInvocation({
        runId,
        iteration,
        agentId: workspace.orchestrator_agent_id,
        accountId: this.orchestratorAccountId(workspace),
        role: 'ORCHESTRATOR',
        task: null,
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
  }): string {
    const catalogue = this.database.verifications.list(input.workspace.id);
    const lines: string[] = [
      'You are the orchestrator of a local coding agent system.',
      'You supervise; a separate coding agent executes. You never edit files yourself.',
      '',
      `OBJECTIVE: ${input.objective}`,
      `WORKSPACE: ${input.cwd}`,
      `ITERATION: ${input.iteration}`,
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
      'Answer with a single JSON object and nothing else:',
      '{',
      '  "action": "delegate" | "verify" | "done" | "blocked",',
      '  "task": "what the coding agent must do (required for delegate)",',
      '  "acceptanceCriteria": ["objective, checkable statements"],',
      '  "verificationCommands": ["verification ids from the list above"],',
      '  "summary": "one line for the user",',
      '  "reason": "required for blocked",',
      '  "workerRequirements": {',
      '    "capability": "fast" | "balanced" | "strong" | "max",',
      '    "reasoning": "low" | "medium" | "high" | "max",',
      '    "rationale": "one line, or null"',
      '  }',
      '}',
      '',
      'Rules: "done" is a request, not a conclusion - it is re-validated against',
      'freshly collected git evidence and by re-running every verification. An',
      'unknown verification id is reported as a failure and never executed.',
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
    iteration: number;
    task: string;
    decision: Decision;
    routing: WorkerRoutingSource | null;
    capabilities: WorkerRuntimeCapabilities;
    attempts: readonly PreviousAttempt[];
    unavailableModels: string[];
    signal: AbortSignal;
  }): Promise<NonNullable<IterationRecord['worker']>> {
    const { runId, sessionId, workspace, cwd, runners, iteration, task } = input;
    let last: NonNullable<IterationRecord['worker']> | null = null;

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
        attempt === 0 ? `Executando: ${task}` : `Tentando outro modelo: ${task}`,
        planned ? { routing: planned } : undefined,
      );

      const startedAt = new Date().toISOString();
      const result = await runners.worker.run({
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

      last = {
        agent: 'claude-code',
        profile: runners.workerAccountId,
        task,
        startedAt,
        finishedAt: result.finishedAt,
        exitCode: result.exitCode,
        outcome: result.outcome,
        durationMs: result.durationMs,
        ...(recorded ? { routing: recorded } : {}),
        mechanical,
        modelUnavailable,
      };
      this.database.runs.recordInvocation({
        runId,
        iteration,
        agentId: workspace.worker_agent_id,
        accountId: runners.workerAccountId,
        role: 'CODING_WORKER',
        task,
        outcome: result.outcome,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        startedAt,
        routing: recorded,
      });
      this.step(runId, iteration, 'worker', result.outcome, task.slice(0, 200), {
        attempt: attempt + 1,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ...(result.executable ? { executable: result.executable } : {}),
        ...(recorded ? { routing: recorded } : {}),
        ...(modelUnavailable ? { modelUnavailable: true } : {}),
        ...(mechanical ? { mechanical: true } : {}),
        stderrExcerpt: excerpt(result.stderr),
      });

      if (input.signal.aborted || !modelUnavailable || !routed?.resolvedModel) return last;
      if (attempt === MODEL_RETRIES || routed.alternatives.length === 0) return last;

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
    return last!;
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

  private progress(runId: string, sessionId: string, stage: string, label: string, status: string): void {
    this.events.emit('run:progress', { runId, sessionId, stage, label, status });
  }
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
