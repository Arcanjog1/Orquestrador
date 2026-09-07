/**
 * Cloud runs, from the desktop's side.
 *
 * Submitting is the easy half. The half that matters is **coming back**: the
 * application was closed, the run kept going, and now the person expects to
 * see what happened as if they had been watching. That is the whole of `sync`.
 *
 * Three rules make coming back safe rather than approximately right:
 *
 *  1. **The cursor decides, not the clock.** The desktop stores the last event
 *     sequence it applied and asks for everything after it. Reconnecting after
 *     a week and after a second take the same path.
 *  2. **Applying is idempotent.** Asking twice with the same cursor returns the
 *     same events, and applying them again must change nothing - so an
 *     interrupted sync is simply retried.
 *  3. **Submitting is idempotent too.** The key is the local run's own id, so
 *     a submission that timed out on the network but arrived does not become a
 *     second run - and therefore not a second commit, push or pull request.
 */

import type { Database } from '../core.js';
import { newId } from '../core.js';
import type { EventBus } from '../events.js';
import type { RunView } from '../../shared/ipc-contract.js';
import { CloudClient, CloudError, type CloudEvent } from './cloud-client.js';
import { toRunView } from './views.js';

export interface CloudServiceOptions {
  database: Database;
  events: EventBus;
  /** Builds a client for one project's coordinator. */
  clientFor: (endpoint: string | null) => CloudClient | null;
  /** How often an unfinished remote run is re-read while a window is open. */
  pollIntervalMs?: number;
}

export class CloudServiceError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = 'CloudServiceError';
    this.userMessage = userMessage;
  }
}

export class CloudService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: CloudServiceOptions) {}

  private get database(): Database {
    return this.options.database;
  }

  /**
   * Starts a run in the cloud and returns the local row that mirrors it.
   *
   * The local run exists first, and its id is the idempotency key. That
   * ordering is deliberate: a crash between "row created" and "submitted"
   * leaves a run that can be submitted again safely, whereas the other order
   * leaves work running in the cloud that this desktop has no record of.
   */
  async start(input: { sessionId: string; objective: string }): Promise<RunView> {
    const session = this.database.chat.requireSession(input.sessionId);
    const workspace = this.database.workspaces.require(session.workspace_id);
    if (workspace.environment !== 'cloud') {
      throw new CloudServiceError('Este projeto não é de nuvem.');
    }
    if (!workspace.repository_full_name || !workspace.branch) {
      throw new CloudServiceError('Escolha o repositório e a branch deste projeto antes de enviar uma tarefa.');
    }
    const client = this.options.clientFor(workspace.cloud_endpoint);
    if (!client) {
      throw new CloudServiceError('Conecte este computador à nuvem antes de enviar uma tarefa.');
    }

    const run = this.database.runs.create({
      id: newId('run'),
      sessionId: session.id,
      workspaceId: workspace.id,
      objective: input.objective,
      orchestratorAgentId: workspace.orchestrator_agent_id,
      maxIterations: 8,
    });
    this.step(run.id, 0, 'cloud', 'submitting', 'Enviando para a nuvem...');

    try {
      const { run: remote } = await client.submit({
        repository: workspace.repository_full_name,
        branch: workspace.branch,
        objective: input.objective,
        // The local run's own id: stable across retries and across restarts.
        idempotencyKey: run.id,
        clientRunId: run.id,
        clientSessionId: session.id,
        team: this.teamOf(workspace.id),
      });
      this.database.runs.bindRemote(run.id, { remoteRunId: remote.id });
      this.database.runs.setStatus(run.id, 'RUNNING');
      this.step(run.id, 0, 'cloud', 'accepted', `Execução ${remote.id} aceita pela nuvem.`);
      this.emit(run.id);
      return this.view(run.id);
    } catch (error) {
      const reason = error instanceof CloudError ? error.userMessage : String(error);
      // Not FAILED: the submission may have arrived. Left as it is, `retry`
      // re-sends with the same key, and the coordinator answers with the run
      // it already made rather than starting a second one.
      this.step(run.id, 0, 'cloud', 'unsent', reason);
      this.emit(run.id);
      throw new CloudServiceError(reason);
    }
  }

  /**
   * Catches one local run up with its remote.
   *
   * Returns how many events were applied, so "nothing changed" is a fact
   * rather than an assumption.
   */
  async sync(localRunId: string): Promise<number> {
    const run = this.database.runs.require(localRunId);
    if (!run.remote_run_id) return 0;
    const workspace = this.database.workspaces.require(run.workspace_id);
    const client = this.options.clientFor(workspace.cloud_endpoint);
    if (!client) return 0;

    let applied = 0;
    let cursor = this.database.runs.remoteCursor(localRunId);
    for (;;) {
      const page = await client.events(run.remote_run_id, cursor);
      if (page.events.length === 0) {
        this.applyStatus(localRunId, page.status);
        break;
      }
      for (const event of page.events) {
        this.apply(localRunId, run.session_id, event);
        applied += 1;
      }
      cursor = page.cursor;
      // Written after each page, not at the end: a sync interrupted halfway
      // resumes from the page it reached rather than repeating the lot.
      this.database.runs.setRemoteCursor(localRunId, cursor);
      this.applyStatus(localRunId, page.status);
      if (page.events.length < 500) break;
    }
    if (applied > 0) this.emit(localRunId);
    return applied;
  }

  /**
   * Catches up everything that was in flight.
   *
   * Called when a window opens. This is what turns "I closed the application"
   * into "it was all there when I came back".
   */
  async syncAll(): Promise<number> {
    let total = 0;
    for (const run of this.database.runs.listUnfinishedRemote()) {
      try {
        total += await this.sync(run.id);
      } catch {
        // One unreachable coordinator must not stop the others. The run is
        // still going; this window simply could not read it yet.
      }
    }
    return total;
  }

  /** Polls unfinished remote runs while a window is open. */
  startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.syncAll().catch(() => {});
    }, this.options.pollIntervalMs ?? 5_000);
    this.timer.unref?.();
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async cancel(localRunId: string): Promise<boolean> {
    const run = this.database.runs.require(localRunId);
    if (!run.remote_run_id) return false;
    const workspace = this.database.workspaces.require(run.workspace_id);
    const client = this.options.clientFor(workspace.cloud_endpoint);
    if (!client) throw new CloudServiceError('Sem conexão com a nuvem para cancelar.');
    const cancelled = await client.cancel(run.remote_run_id);
    if (cancelled) await this.sync(localRunId).catch(() => {});
    return cancelled;
  }

  // -- applying one event ---------------------------------------------------

  /**
   * Writes one remote event into the local record.
   *
   * Every branch here must be safe to run twice on the same event, because a
   * sync that is interrupted after applying a page but before its cursor is
   * stored will do exactly that.
   */
  private apply(localRunId: string, sessionId: string | null, event: CloudEvent): void {
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    if (event.kind === 'run.status') {
      this.applyStatus(localRunId, String(payload.status ?? ''), payload.failureReason);
      return;
    }
    if (event.kind === 'workspace.phase') {
      this.stepOnce(localRunId, event.seq, 'workspace', phraseFor(payload));
      return;
    }
    if (event.kind === 'run.error') {
      this.stepOnce(localRunId, event.seq, 'error', String(payload.reason ?? ''));
      return;
    }
    if (event.kind === 'orchestration.run:progress') {
      const stage = String(payload.stage ?? '');
      const label = String(payload.label ?? '');
      // The remote loop's own progress, replayed onto the local timeline. The
      // sequence number is the step's identity, so re-applying replaces rather
      // than appends.
      this.stepOnce(localRunId, event.seq, stage, label);
      if (sessionId && payload.message && typeof payload.message === 'object') {
        this.messageOnce(sessionId, localRunId, event.seq, payload.message as Record<string, unknown>);
      }
      return;
    }
    // Anything else is recorded verbatim rather than dropped: a coordinator
    // that learns a new event kind must not make an older desktop lose history.
    this.stepOnce(localRunId, event.seq, event.kind, summarise(payload));
  }

  private applyStatus(localRunId: string, status: string, failureReason?: unknown): void {
    const mapped = LOCAL_STATUS[status];
    if (!mapped) return;
    const current = this.database.runs.require(localRunId);
    if (current.status === mapped) return;
    this.database.runs.setStatus(
      localRunId,
      mapped,
      typeof failureReason === 'string' ? failureReason : null,
    );
  }

  /**
   * A step keyed by the remote sequence number.
   *
   * `detail` carries the sequence so the same event never becomes two rows -
   * which is what makes the whole sync safe to retry.
   */
  // Every mirrored event goes through here. `step` below writes the desktop's
  // *own* rows - submitting, accepted, unsent - which have no remote sequence
  // and are never replayed; mixing the two is how a re-sync duplicates a
  // timeline, so the split is deliberate rather than incidental.
  private stepOnce(localRunId: string, seq: number, phase: string, summary: string): void {
    const marker = `seq:${seq}`;
    const already = this.database.runs
      .steps(localRunId)
      .some((step) => step.detail === marker);
    if (already) return;
    this.database.runs.addStep({
      runId: localRunId,
      iteration: 0,
      phase,
      status: 'remote',
      summary,
      detail: marker,
    });
  }

  /**
   * A conversation message from the remote loop, added at most once.
   *
   * The remote sequence number travels in the message's payload, so the check
   * is an identity rather than a comparison of text - two identical worker
   * lines in one run are two messages, and the same line replayed by an
   * interrupted sync is one.
   */
  private messageOnce(
    sessionId: string,
    runId: string,
    seq: number,
    message: Record<string, unknown>,
  ): void {
    const text = typeof message.text === 'string' ? message.text : null;
    if (!text) return;
    const already = this.database.chat
      .listMessages(sessionId)
      .some((row) => remoteSeqOf(row.payload) === seq);
    if (already) return;
    this.database.chat.addMessage({
      sessionId,
      runId,
      author: typeof message.author === 'string' ? message.author : 'system',
      body: text,
      payload: { remoteSeq: seq },
    });
  }

  private step(runId: string, iteration: number, phase: string, status: string, summary: string): void {
    this.database.runs.addStep({ runId, iteration, phase, status, summary });
  }

  private teamOf(workspaceId: string): unknown {
    return {
      verifications: this.database.verifications.list(workspaceId).map((v) => ({
        id: v.id,
        label: v.label,
        command: v.command,
      })),
    };
  }

  private view(runId: string): RunView {
    const run = this.database.runs.require(runId);
    return toRunView(run, this.database.runs.steps(runId));
  }

  private emit(runId: string): void {
    const run = this.database.runs.require(runId);
    if (!run.session_id) return;
    this.options.events.emit('run:progress', {
      runId,
      sessionId: run.session_id,
      stage: 'cloud',
      label: 'Nuvem',
      status: run.status,
    });
  }
}

/** The coordinator's vocabulary, mapped onto the one the local tables use. */
const LOCAL_STATUS: Record<string, 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED' | 'BLOCKED'> = {
  QUEUED: 'PENDING',
  PROVISIONING: 'RUNNING',
  RUNNING: 'RUNNING',
  DONE: 'DONE',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  NEEDS_HUMAN: 'BLOCKED',
};

const PHASE_PHRASE: Record<string, string> = {
  preparing: 'Preparando o ambiente...',
  cloning: 'Clonando o repositório...',
  'installing-runtimes': 'Preparando as ferramentas...',
  ready: 'Ambiente pronto.',
  releasing: 'Liberando o ambiente...',
};

function phraseFor(payload: Record<string, unknown>): string {
  const phase = String(payload.phase ?? '');
  const detail = typeof payload.detail === 'string' && payload.detail ? ` ${payload.detail}` : '';
  return `${PHASE_PHRASE[phase] ?? phase}${detail}`;
}

/** The remote sequence a mirrored message carries, or null for a local one. */
function remoteSeqOf(payload: string | null): number | null {
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    const seq = (parsed as { remoteSeq?: unknown } | null)?.remoteSeq;
    return typeof seq === 'number' ? seq : null;
  } catch {
    return null;
  }
}

function summarise(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload);
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}
