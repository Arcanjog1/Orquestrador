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
  AgentRunner,
  Baseline,
  CommandResult,
  Database,
  Decision,
  GitEvidence,
  IterationRecord,
  ProcessManager,
  WorkspaceWithAgents,
} from '../core.js';
import {
  AcceptanceCriteriaLedger,
  GitEvidenceCollector,
  Verifier,
  commandPassed,
  evaluateDone,
  formatDoneRejection,
  newId,
  parseDecision,
  redact,
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
}

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
}

export type RunnerFactory = (workspace: WorkspaceWithAgents) => Promise<RunnerPair>;

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

  constructor(
    private readonly database: Database,
    private readonly processManager: ProcessManager,
    private readonly events: EventBus,
    private readonly createRunners: RunnerFactory,
    private readonly options: OrchestrationOptions = {},
    private readonly checkReadiness: ReadinessCheck = async () => null,
  ) {}

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

    const runners = await this.createRunners(workspace);
    this.runners.set(runId, runners);
    const gitCommand = await this.options.gitCommand?.().catch(() => undefined);
    const collector = gitCommand
      ? new GitEvidenceCollector(workspace.local_path, this.processManager, gitCommand)
      : new GitEvidenceCollector(workspace.local_path, this.processManager);
    const verifier = new Verifier({
      cwd: workspace.local_path,
      timeoutMs: this.options.verificationTimeoutMs ?? DEFAULTS.verificationTimeoutMs,
      processManager: this.processManager,
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
        runners,
        prompt,
        iteration,
        signal,
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
        this.say(sessionId, runId, 'worker', `Executando: ${task}`);

        const startedAt = new Date().toISOString();
        const result = await runners.worker.run({
          prompt: task,
          workingDirectory: workspace.local_path,
          timeoutMs: this.options.agentTimeoutMs ?? DEFAULTS.agentTimeoutMs,
          runId,
          iteration,
        });
        record.worker = {
          agent: 'claude-code',
          profile: runners.workerAccountId,
          task,
          startedAt,
          finishedAt: result.finishedAt,
          exitCode: result.exitCode,
          outcome: result.outcome,
          durationMs: result.durationMs,
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
        });
        this.step(runId, iteration, 'worker', result.outcome, task.slice(0, 200));
        if (signal.aborted) return this.finishCancelled(runId, sessionId);
      }

      // 3. Collect evidence ourselves, whatever the worker claims.
      this.progress(runId, sessionId, 'evidence', 'Coletando alterações...', 'RUNNING');
      const evidence: GitEvidence = await collector.collectEvidence(baseline);
      record.evidence = evidence;
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
      feedback = this.buildFeedback(evidence, verification, unknownIds);
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
    runners: RunnerPair;
    prompt: string;
    iteration: number;
    signal: AbortSignal;
  }): Promise<{ decision: Decision | null; failure?: string }> {
    const { runId, workspace, runners, iteration, signal } = input;
    let currentPrompt = input.prompt;
    let lastProblem = 'nenhuma resposta';
    let lastExcerpt = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const startedAt = new Date().toISOString();
      const result = await runners.orchestrator.run({
        prompt: currentPrompt,
        workingDirectory: workspace.local_path,
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
      });
      if (signal.aborted) return { decision: null };

      const diagnostics = {
        attempt,
        outcome: result.outcome,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdoutExcerpt: excerpt(result.stdout),
        stderrExcerpt: excerpt(result.stderr),
        ...(result.error ? { error: result.error } : {}),
      };

      if (result.outcome !== 'completed') {
        const problem =
          result.outcome === 'timeout'
            ? `o Codex não respondeu em ${Math.round((this.options.agentTimeoutMs ?? DEFAULTS.agentTimeoutMs) / 60_000)} min`
            : `o Codex não concluiu (${result.outcome}${result.exitCode !== null ? `, código ${result.exitCode}` : ''})`;
        const said = firstLine(result.stderr) || firstLine(result.stdout) || result.error || '';
        this.step(runId, iteration, 'orchestrator', result.outcome, problem, diagnostics);
        return {
          decision: null,
          failure: `${capitalize(problem)}${said ? `: ${redact(said)}` : '.'}`,
        };
      }

      const parsed = parseDecision(result.stdout);
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
      `WORKSPACE: ${input.workspace.local_path}`,
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
      '  "reason": "required for blocked"',
      '}',
      '',
      'Rules: "done" is a request, not a conclusion - it is re-validated against',
      'freshly collected git evidence and by re-running every verification. An',
      'unknown verification id is reported as a failure and never executed.',
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
  ): string {
    const lines: string[] = ['GIT EVIDENCE (collected by the orchestrator, not reported by the agent):'];
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

  private say(sessionId: string, runId: string, author: string, body: string): ChatMessageView {
    const record = this.database.chat.addMessage({ sessionId, runId, author, body });
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
