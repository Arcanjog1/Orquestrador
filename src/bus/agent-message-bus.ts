/**
 * The agent message bus (spec 5, 11, 12).
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a **communication boundary**: it accepts a message, persists it before
 * anyone can act on it, hands it to exactly one recipient at a time, and knows
 * — at every moment — whether that message was merely accepted, actually
 * delivered, started, finished, or abandoned.
 *
 * It is **not a second orchestration engine**. It has no idea what a
 * delegation means, when a run is done, or which worker should get what.
 * `OrchestrationService` decides all of that and remains the only thing that
 * does; there is one loop and one DoneGate. If this file ever grows a rule
 * about *what happens next*, that rule is in the wrong file.
 *
 * It is also **not a second source of truth for run state**. The `runs` table
 * answers "how is the run doing". These rows answer "what was said, to whom,
 * and did it arrive" — a different question, and the one that was previously
 * unanswerable when the window sat on "executando automaticamente".
 *
 * ## Why it is local
 *
 * Buzz routes agent traffic through a Nostr relay with Postgres and Redis
 * behind it, because Buzz is a hosted multi-tenant product where the agents
 * and the humans are on different machines. None of that is true here: both
 * agents are child processes of this application, on this computer, talking
 * over stdio. The smallest thing that gives the same *behaviour* — durable
 * ordering, one in-flight per worker, acks, timeouts, retries, dedup,
 * recovery — is a table and this class. So that is what this is. No relay, no
 * broker, no port, no daemon, nothing for a person to install or configure.
 *
 * ## What it guarantees
 *
 * - **Persist before deliver.** A message is a committed row before any
 *   recipient can see it. A crash between publish and delivery leaves a
 *   `pending` row, not a lost instruction.
 * - **At most one in flight per (run, recipient).** A worker is never asked to
 *   do two things at once, so a retry cannot race the original.
 * - **Idempotent publish.** Same `dedupeKey`, same message. Re-publishing after
 *   a crash returns the existing row rather than duplicating the work.
 * - **Leases, not hopes.** Delivery takes a lease with a deadline. A worker
 *   that dies silently leaves an expired lease, which is a fact the
 *   application can see and act on.
 * - **Nothing is dropped in silence.** Retries are bounded; the bound is
 *   `dead`, a status with a reason attached, not a deletion.
 *
 * ## What it does not retry
 *
 * Redelivery re-sends a *message*, which is safe. It does not re-run whatever
 * side effect the recipient performed, and it must not be used as if it did:
 * spec 12 is explicit that a non-idempotent write is never repeated without
 * reconciling the real state first. That reconciliation is EVIDENCE and
 * VERIFICATION's job, and they run after every delegation regardless.
 */

import { randomUUID } from 'node:crypto';
import {
  backoffMs,
  defaultDedupeKey,
  scopeKey,
  type AgentMessage,
  type AgentMessageStatus,
  type AgentMessageType,
  type DeliveryScope,
  type PublishInput,
} from './message-types.js';

/** The storage the bus needs. `AgentMessageRepository` implements it. */
export interface AgentMessageStore {
  publish(input: {
    messageId: string;
    runId: string;
    conversationId: string;
    iteration: number;
    stepId: string | null;
    invocationId: string | null;
    senderAgentId: string | null;
    recipientAgentId: string | null;
    messageType: string;
    payload: string;
    correlationId: string;
    causationId: string | null;
    dedupeKey: string;
    availableAt: string;
  }): { row: AgentMessageRowLike; created: boolean };
  find(messageId: string): AgentMessageRowLike | undefined;
  claimNext(input: {
    recipientAgentId: string | null;
    now: string;
    leaseExpiresAt: string;
    busyRunIds: readonly string[];
  }): AgentMessageRowLike | undefined;
  transition(input: {
    messageId: string;
    from: readonly string[];
    to: string;
    failureReason?: string | null;
    clearLease?: boolean;
  }): boolean;
  requeue(input: {
    messageId: string;
    availableAt: string;
    failureReason: string | null;
  }): boolean;
  expiredLeases(now: string, limit?: number): AgentMessageRowLike[];
  listForRun(runId: string): AgentMessageRowLike[];
  listForCorrelation(correlationId: string): AgentMessageRowLike[];
  cancelRun(runId: string, reason: string): number;
  unfinished(limit?: number): AgentMessageRowLike[];
  countByStatus(runId: string): Record<string, number>;
}

/** The row shape the bus reads. Mirrors `AgentMessageRow` without importing it. */
export interface AgentMessageRowLike {
  message_id: string;
  run_id: string;
  conversation_id: string;
  iteration: number;
  step_id: string | null;
  invocation_id: string | null;
  sender_agent_id: string | null;
  recipient_agent_id: string | null;
  message_type: string;
  payload: string;
  status: string;
  correlation_id: string;
  causation_id: string | null;
  dedupe_key: string;
  attempts: number;
  lease_expires_at: string | null;
  available_at: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusOptions {
  /**
   * How long a delivery may hold a message before the lease is considered lost.
   *
   * Must exceed the longest legitimate turn, or a slow-but-healthy worker gets
   * declared dead. Buzz derives the same number the same way — its in-flight
   * deadline is `max_turn_duration + buffer` — for exactly this reason.
   */
  leaseMs?: number;
  /** Attempts before a message is dead-lettered rather than retried again. */
  maxAttempts?: number;
  /** First backoff step; doubles per attempt up to `backoffCapMs`. */
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Injected for tests, so backoff and expiry are deterministic. */
  now?: () => Date;
  random?: () => number;
  /** Called whenever a message changes state. The UI's ephemeral channel. */
  onChange?: (message: AgentMessage) => void;
}

const DEFAULTS = {
  /** 20 minutes: longer than any single turn the loop allows. */
  leaseMs: 20 * 60_000,
  maxAttempts: 5,
  backoffBaseMs: 1_000,
  backoffCapMs: 60_000,
};

/** A message handed to a recipient, together with the lease that came with it. */
export interface Delivery {
  readonly message: AgentMessage;
  /** When the lease expires. After this the bus may reclaim the message. */
  readonly leaseExpiresAt: string;
}

/** What a sweep found and did. Reported so the UI can say it out loud. */
export interface SweepResult {
  /** Messages whose lease expired and which were returned for another attempt. */
  readonly requeued: readonly AgentMessage[];
  /** Messages whose lease expired and which had no attempts left. */
  readonly dead: readonly AgentMessage[];
}

export class AgentMessageBus {
  private readonly options: Required<Omit<BusOptions, 'onChange'>> & Pick<BusOptions, 'onChange'>;

  /**
   * Scopes with a message currently in flight.
   *
   * Held in memory as a fast guard; the database is still the authority, since
   * a leased row is a leased row whether or not this process remembers it.
   * Rebuilt from the table by `recover()`, which is what makes the invariant
   * survive a restart.
   */
  private readonly inFlight = new Map<string, DeliveryScope>();

  constructor(
    private readonly store: AgentMessageStore,
    options: BusOptions = {},
  ) {
    this.options = {
      leaseMs: options.leaseMs ?? DEFAULTS.leaseMs,
      maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
      backoffBaseMs: options.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
      backoffCapMs: options.backoffCapMs ?? DEFAULTS.backoffCapMs,
      now: options.now ?? (() => new Date()),
      random: options.random ?? Math.random,
      ...(options.onChange ? { onChange: options.onChange } : {}),
    };
  }

  private nowIso(): string {
    return this.options.now().toISOString();
  }

  private isoIn(ms: number): string {
    return new Date(this.options.now().getTime() + ms).toISOString();
  }

  /**
   * Accepts a message and persists it.
   *
   * Returns `created: false` when a message with this `dedupeKey` already
   * exists — the caller's message *is* that row, and no second copy was made.
   * This is what makes it safe for a recovering run to re-publish everything
   * it believes it sent.
   */
  publish(input: PublishInput): { message: AgentMessage; created: boolean } {
    const dedupeKey = input.dedupeKey ?? defaultDedupeKey(input);
    const { row, created } = this.store.publish({
      messageId: `msg-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      runId: input.runId,
      conversationId: input.conversationId,
      iteration: input.iteration,
      stepId: input.stepId ?? null,
      invocationId: input.invocationId ?? null,
      senderAgentId: input.senderAgentId ?? null,
      recipientAgentId: input.recipientAgentId ?? null,
      messageType: input.messageType,
      payload: serialise(input.payload),
      correlationId: input.correlationId ?? `cor-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      causationId: input.causationId ?? null,
      dedupeKey,
      availableAt: this.isoIn(input.delayMs ?? 0),
    });
    const message = toMessage(row);
    if (created) this.emit(message);
    return { message, created };
  }

  /**
   * Hands the next ready message for a recipient over, under a lease.
   *
   * Returns `undefined` when there is nothing ready — either the queue is
   * empty, everything is waiting out a backoff, or this recipient already has
   * something in flight for that run.
   */
  claim(recipientAgentId: string | null): Delivery | undefined {
    const leaseExpiresAt = this.isoIn(this.options.leaseMs);
    const busyRunIds = this.busyRunIdsFor(recipientAgentId);
    const row = this.store.claimNext({
      recipientAgentId,
      now: this.nowIso(),
      leaseExpiresAt,
      busyRunIds,
    });
    if (!row) return undefined;
    const message = toMessage(row);
    const scope: DeliveryScope = { runId: message.runId, recipientAgentId };
    this.inFlight.set(scopeKey(scope), scope);
    this.emit(message);
    return { message, leaseExpiresAt };
  }

  /**
   * The recipient acknowledged the message and began real work.
   *
   * This is the distinction spec 12 insists on: "delivered" and "started" are
   * not the same event, and a run stuck between them is a different problem
   * from one stuck before delivery. Both are now visible.
   */
  acknowledge(messageId: string): boolean {
    const moved = this.store.transition({
      messageId,
      from: ['leased'],
      to: 'started',
    });
    if (moved) this.emitById(messageId);
    return moved;
  }

  /**
   * The recipient finished, and the outcome is persisted.
   *
   * Note what this does *not* mean: not that the work was correct, not that a
   * file changed, not that the run may finish. It means this message's
   * lifecycle is over. Evidence and verification answer the rest.
   */
  complete(messageId: string): boolean {
    const row = this.store.find(messageId);
    const moved = this.store.transition({
      messageId,
      from: ['leased', 'started'],
      to: 'completed',
      clearLease: true,
      failureReason: null,
    });
    if (moved && row) {
      this.inFlight.delete(
        scopeKey({ runId: row.run_id, recipientAgentId: row.recipient_agent_id }),
      );
      this.emitById(messageId);
    }
    return moved;
  }

  /**
   * The attempt failed. Retried with backoff, or dead-lettered if spent.
   *
   * `retryable: false` is for failures that another attempt cannot fix — a
   * refused permission, a rejected credential, an empty balance. Retrying
   * those costs money and changes nothing, which is the mistake the routing
   * fix in the previous session was about.
   */
  fail(messageId: string, reason: string, options: { retryable?: boolean } = {}): AgentMessage | undefined {
    const row = this.store.find(messageId);
    if (!row) return undefined;
    this.inFlight.delete(scopeKey({ runId: row.run_id, recipientAgentId: row.recipient_agent_id }));

    const retryable = options.retryable ?? true;
    const spent = row.attempts >= this.options.maxAttempts;
    if (!retryable || spent) {
      const why = retryable
        ? `${reason} (sem novas tentativas após ${row.attempts})`
        : reason;
      this.store.transition({
        messageId,
        from: ['leased', 'started', 'pending', 'failed'],
        to: 'dead',
        failureReason: why,
        clearLease: true,
      });
      return this.emitById(messageId);
    }

    this.store.requeue({
      messageId,
      availableAt: this.isoIn(
        backoffMs(row.attempts, this.options.backoffBaseMs, this.options.backoffCapMs, this.options.random),
      ),
      failureReason: reason,
    });
    return this.emitById(messageId);
  }

  /**
   * Reclaims leases that passed their deadline.
   *
   * This is the answer to "if the worker dies, the application must know".
   * A process that exits without a word, a machine that sleeps, a turn that
   * hangs past every timeout: all of them leave a leased row whose deadline
   * has passed, and this turns that into either another attempt or a named
   * dead letter. What it never does is leave the run waiting forever.
   */
  sweep(): SweepResult {
    const requeued: AgentMessage[] = [];
    const dead: AgentMessage[] = [];
    for (const row of this.store.expiredLeases(this.nowIso())) {
      const outcome = this.fail(
        row.message_id,
        `Sem resposta do destinatário dentro do prazo de ${Math.round(this.options.leaseMs / 1000)}s.`,
      );
      if (!outcome) continue;
      (outcome.status === 'dead' ? dead : requeued).push(outcome);
    }
    return { requeued, dead };
  }

  /**
   * Rebuilds the in-flight set after a restart, and reports what was in flight.
   *
   * A message that was `leased` when the process died belongs to nobody now:
   * the child process it was handed to is gone with the parent. Rather than
   * guess whether the work happened, the bus returns those rows to the caller,
   * which is the only party that can reconcile them against real evidence.
   */
  recover(): { pending: AgentMessage[]; interrupted: AgentMessage[] } {
    this.inFlight.clear();
    const pending: AgentMessage[] = [];
    const interrupted: AgentMessage[] = [];
    for (const row of this.store.unfinished()) {
      const message = toMessage(row);
      if (message.status === 'leased' || message.status === 'started') {
        // Still held by nobody: the process it was handed to died with the
        // parent. The row stays as it is until the caller reconciles it, and
        // the scope stays marked busy so nothing else is sent to that worker
        // for that run in the meantime.
        const scope: DeliveryScope = {
          runId: message.runId,
          recipientAgentId: message.recipientAgentId,
        };
        this.inFlight.set(scopeKey(scope), scope);
        interrupted.push(message);
      } else {
        pending.push(message);
      }
    }
    return { pending, interrupted };
  }

  /**
   * Cancels every unfinished message of a run.
   *
   * Terminal messages are untouched: a result that already arrived stays
   * recorded, because cancelling a run does not un-happen what a worker did,
   * and pretending otherwise would lose the only trace of it.
   */
  cancelRun(runId: string, reason = 'Execução cancelada.'): number {
    const changed = this.store.cancelRun(runId, reason);
    for (const [key, scope] of [...this.inFlight]) {
      if (scope.runId === runId) this.inFlight.delete(key);
    }
    for (const row of this.store.listForRun(runId)) {
      if (row.status === 'cancelled') this.emit(toMessage(row));
    }
    return changed;
  }

  /** Every message of a run, oldest first. */
  listForRun(runId: string): AgentMessage[] {
    return this.store.listForRun(runId).map(toMessage);
  }

  /** The request and whatever answered it. */
  listForCorrelation(correlationId: string): AgentMessage[] {
    return this.store.listForCorrelation(correlationId).map(toMessage);
  }

  /** How many messages of a run sit in each status. */
  countByStatus(runId: string): Record<string, number> {
    return this.store.countByStatus(runId);
  }

  find(messageId: string): AgentMessage | undefined {
    const row = this.store.find(messageId);
    return row ? toMessage(row) : undefined;
  }

  /** Whether a recipient currently holds something for this run. */
  isBusy(scope: DeliveryScope): boolean {
    return this.inFlight.has(scopeKey(scope));
  }

  /**
   * The runs this recipient already has something in flight for.
   *
   * Read from the stored scopes rather than by taking a key apart. An earlier
   * version parsed the key back into its pieces and got the separator wrong,
   * which silently disabled the one-in-flight guard: the guard reported busy
   * and the query was still handed an empty exclusion list. A key that is only
   * ever built, never parsed, cannot fail that way.
   */
  private busyRunIdsFor(recipientAgentId: string | null): string[] {
    const runIds: string[] = [];
    for (const scope of this.inFlight.values()) {
      if (scope.recipientAgentId === recipientAgentId) runIds.push(scope.runId);
    }
    return runIds;
  }

  private emit(message: AgentMessage): AgentMessage {
    try {
      this.options.onChange?.(message);
    } catch {
      // A watcher that throws must never break the exchange it is watching.
    }
    return message;
  }

  private emitById(messageId: string): AgentMessage | undefined {
    const row = this.store.find(messageId);
    return row ? this.emit(toMessage(row)) : undefined;
  }
}

/** Row to message. `payload` round-trips through JSON; bad JSON stays a string. */
export function toMessage(row: AgentMessageRowLike): AgentMessage {
  return {
    messageId: row.message_id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    iteration: row.iteration,
    stepId: row.step_id,
    invocationId: row.invocation_id,
    senderAgentId: row.sender_agent_id,
    recipientAgentId: row.recipient_agent_id,
    messageType: row.message_type as AgentMessageType,
    payload: deserialise(row.payload),
    status: row.status as AgentMessageStatus,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    dedupeKey: row.dedupe_key,
    attempts: row.attempts,
    leaseExpiresAt: row.lease_expires_at,
    availableAt: row.available_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serialise(payload: unknown): string {
  try {
    return JSON.stringify(payload ?? null) ?? 'null';
  } catch {
    // A payload that will not serialise is a bug in the caller, but losing the
    // message over it would be worse than recording that it happened.
    return JSON.stringify({ unserialisable: true });
  }
}

function deserialise(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}
