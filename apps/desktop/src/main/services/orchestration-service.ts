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
} from '../core.js';
import type { ChatMessageView, RunView } from '../../shared/ipc-contract.js';
import type { EventBus } from '../events.js';
import { toMessageView, toRunView } from './views.js';

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
    if (!controller) return false;
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
        this.database.runs.setStatus(run.id, 'FAILED', describeError(error));
        this.say(session.id, run.id, 'system', `Falhou: ${describeError(error)}`);
        this.progress(run.id, session.id, 'failed', 'Falhou.', 'FAILED');
      })
      .finally(() => {
        this.active.delete(run.id);
        this.runners.delete(run.id);
      });

    return toRunView(this.database.runs.require(run.id), 0);
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
    return toRunView(run, this.database.runs.steps(runId).length);
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
    const collector = new GitEvidenceCollector(workspace.local_path, this.processManager);
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
      });
      const decision = await this.askForDecision({
        runId,
        workspace,
        runners,
        prompt,
        iteration,
        signal,
      });
      if (signal.aborted) return this.finishCancelled(runId, sessionId);
      if (!decision) {
        this.database.runs.setStatus(runId, 'FAILED', 'O orquestrador não devolveu uma decisão válida.');
        this.say(sessionId, runId, 'system', 'O orquestrador não devolveu uma decisão válida.');
        this.progress(runId, sessionId, 'failed', 'Falhou.', 'FAILED');
        return;
      }
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
    this.say(sessionId, runId, 'system', `Parei após ${maxIterations} iterações sem concluir.`);
    this.progress(runId, sessionId, 'failed', 'Limite de iterações atingido.', 'FAILED');
  }

  /** One parse attempt, then one format-repair attempt, then give up. */
  private async askForDecision(input: {
    runId: string;
    workspace: WorkspaceWithAgents;
    runners: RunnerPair;
    prompt: string;
    iteration: number;
    signal: AbortSignal;
  }): Promise<Decision | null> {
    const { runId, workspace, runners, iteration, signal } = input;
    let currentPrompt = input.prompt;
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
        accountId: null,
        role: 'ORCHESTRATOR',
        task: null,
        outcome: result.outcome,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        startedAt,
      });
      if (signal.aborted) return null;
      if (result.outcome !== 'completed') {
        this.step(runId, iteration, 'orchestrator', result.outcome, result.error ?? '');
        return null;
      }

      const parsed = parseDecision(result.stdout);
      if (parsed.ok) {
        this.step(runId, iteration, 'orchestrator', 'ok', parsed.decision.action);
        return parsed.decision;
      }
      this.step(runId, iteration, 'orchestrator', 'unparsed', parsed.error);
      currentPrompt = parsed.repairPrompt;
    }
    return null;
  }

  private buildOrchestratorPrompt(input: {
    workspace: WorkspaceWithAgents;
    objective: string;
    baseline: Baseline;
    iteration: number;
    feedback: string | null;
    iterations: readonly IterationRecord[];
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

  private step(runId: string, iteration: number, phase: string, status: string, summary: string): void {
    this.database.runs.addStep({ runId, iteration, phase, status, summary });
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
