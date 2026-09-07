/**
 * The typed contract for messages between agents (spec 11).
 *
 * This is a *communication* boundary, not an orchestration engine. Nothing in
 * this file decides what happens next in a run: `OrchestrationService` does
 * that, and it stays the only thing that does. What lives here is the envelope
 * — who sent what to whom, about which run, and how far that message got.
 *
 * Two rules shape the whole design.
 *
 * **A message is not a result.** "Sent" is not "delivered", "delivered" is not
 * "started", and "started" is not "done". Each of those is a separate,
 * observable state, because the failure the user actually hit — the window
 * sitting on "executando automaticamente" — is exactly the case where one of
 * them silently never became the next.
 *
 * **The bus is not a second source of truth.** The run's state lives in the
 * `runs` table and the orchestrator's own loop. These rows record the
 * conversation *about* that state so it can be replayed, audited and resumed;
 * they never replace it. Reading a `WORKER_RESULT` row tells you what the
 * worker said, never that the work was verified — that answer belongs to
 * EVIDENCE and VERIFICATION, and to the DoneGate that reads them.
 */

/**
 * What a message is for.
 *
 * The set is deliberately small and matches the vocabulary the loop already
 * uses. Adding a type is cheap; a type that duplicates a run status is not,
 * because then two things claim to know the same fact.
 */
export type AgentMessageType =
  /** The person's goal, sent once, at the top of a run. */
  | 'USER_OBJECTIVE'
  /** What the orchestrator decided to do this iteration. */
  | 'ORCHESTRATOR_DECISION'
  /** A unit of work handed to a named worker. */
  | 'DELEGATION'
  /** The worker acknowledged the delegation and began. */
  | 'WORKER_STARTED'
  /** The worker is alive and doing something. Ephemeral by nature; see below. */
  | 'WORKER_PROGRESS'
  /** What the worker reported back. A claim, never a proof. */
  | 'WORKER_RESULT'
  /** The application observed the workspace itself. */
  | 'EVIDENCE_READY'
  /** The registered checks ran, and this is what they said. */
  | 'VERIFICATION_RESULT'
  /** The run cannot continue without a person. */
  | 'HUMAN_APPROVAL_REQUIRED'
  /** A person answered. */
  | 'HUMAN_APPROVAL_RESOLVED'
  | 'RUN_COMPLETED'
  | 'RUN_FAILED'
  | 'RUN_CANCELLED';

/**
 * Message types that are worth keeping forever.
 *
 * `WORKER_PROGRESS` is not one of them. A run that emits a durable row per
 * token would turn the history into a write-amplification problem and tell the
 * reader nothing the timeline does not already show, so progress travels on
 * the ephemeral channel (`EventBus`) and only its *summary* — last activity,
 * current tool — is kept, on the invocation row that already exists.
 */
export const DURABLE_MESSAGE_TYPES: readonly AgentMessageType[] = [
  'USER_OBJECTIVE',
  'ORCHESTRATOR_DECISION',
  'DELEGATION',
  'WORKER_STARTED',
  'WORKER_RESULT',
  'EVIDENCE_READY',
  'VERIFICATION_RESULT',
  'HUMAN_APPROVAL_REQUIRED',
  'HUMAN_APPROVAL_RESOLVED',
  'RUN_COMPLETED',
  'RUN_FAILED',
  'RUN_CANCELLED',
];

export function isDurable(type: AgentMessageType): boolean {
  return DURABLE_MESSAGE_TYPES.includes(type);
}

/**
 * How far a message got.
 *
 * These are the six distinctions spec 12 asks for, and they are distinct on
 * purpose:
 *
 * | status       | means                                                  |
 * |--------------|--------------------------------------------------------|
 * | `pending`    | accepted by the bus, persisted, nobody has it yet      |
 * | `leased`     | handed to a recipient; the lease has a deadline        |
 * | `started`    | the recipient acknowledged and began real work         |
 * | `completed`  | the recipient finished and the outcome is persisted    |
 * | `failed`     | this attempt failed; it may be retried                 |
 * | `dead`       | retries exhausted — kept, named, never silently dropped |
 * | `cancelled`  | the run was cancelled before this message finished     |
 *
 * A message never leaves the table. `dead` exists precisely so that "we gave
 * up" is a row someone can read, rather than an absence someone has to infer.
 */
export type AgentMessageStatus =
  | 'pending'
  | 'leased'
  | 'started'
  | 'completed'
  | 'failed'
  | 'dead'
  | 'cancelled';

/** Statuses from which no further work will happen on this message. */
export const TERMINAL_STATUSES: readonly AgentMessageStatus[] = [
  'completed',
  'dead',
  'cancelled',
];

export function isTerminal(status: AgentMessageStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * A message as the bus stores it.
 *
 * `payload` is JSON the sender chose. The bus does not interpret it and must
 * not: a payload is *data from an agent*, which spec 24 requires be treated as
 * untrusted for any purpose touching permissions or execution. Nothing here
 * turns a payload field into a command, a path, or an argument.
 */
export interface AgentMessage {
  /** Stable id, generated by the bus. */
  readonly messageId: string;
  /** The run this message belongs to. Cancelling a run cancels its messages. */
  readonly runId: string;
  /** The conversation, so the timeline can show the exchange in place. */
  readonly conversationId: string;
  /** The iteration of the orchestration loop, for ordering and for the UI. */
  readonly iteration: number;
  /** Which delegation within the iteration, when there is more than one. */
  readonly stepId: string | null;
  /** The provider invocation this message produced or came from, once known. */
  readonly invocationId: string | null;
  /** Agent identity that sent it. `null` means the application itself. */
  readonly senderAgentId: string | null;
  /** Agent identity it is addressed to. `null` means "the application". */
  readonly recipientAgentId: string | null;
  readonly messageType: AgentMessageType;
  readonly payload: unknown;
  readonly status: AgentMessageStatus;
  /**
   * Groups every message belonging to one logical exchange.
   *
   * A delegation and the result that answers it share a `correlationId`, so
   * "what happened to that request?" is one query rather than a reconstruction.
   */
  readonly correlationId: string;
  /** The message that caused this one, when there is one. */
  readonly causationId: string | null;
  /**
   * The idempotency key.
   *
   * Two publishes with the same key are the same message. This is what makes a
   * retry safe: re-publishing a delegation after a crash returns the row that
   * already exists instead of asking a worker to do the work twice.
   */
  readonly dedupeKey: string;
  /** How many delivery attempts have been made. */
  readonly attempts: number;
  /** When the current lease expires, if the message is leased. */
  readonly leaseExpiresAt: string | null;
  /** Not eligible for delivery before this time. Backoff lives here. */
  readonly availableAt: string;
  /** Why this message failed or died, in words a person can read. */
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a caller supplies to publish. Everything else the bus fills in. */
export interface PublishInput {
  runId: string;
  conversationId: string;
  iteration: number;
  messageType: AgentMessageType;
  payload: unknown;
  senderAgentId?: string | null;
  recipientAgentId?: string | null;
  stepId?: string | null;
  invocationId?: string | null;
  correlationId?: string;
  causationId?: string | null;
  /**
   * Overrides the derived idempotency key.
   *
   * The default — `runId:iteration:type:recipient:step` — is right for the
   * loop, where one iteration produces at most one delegation per worker.
   * Supply your own when that is not true.
   */
  dedupeKey?: string;
  /** Delay before this message may be delivered. Used by retry backoff. */
  delayMs?: number;
}

/**
 * The scope within which at most one message is in flight.
 *
 * Buzz enforces one in-flight prompt per channel; the same invariant here is
 * per (run, recipient): one worker, one run, one thing at a time. Without it a
 * requeue could put two copies of the same delegation in front of the same
 * worker, and "idempotent" would be a word rather than a property.
 */
export interface DeliveryScope {
  runId: string;
  recipientAgentId: string | null;
}

/**
 * The separator inside a scope key.
 *
 * Explicit rather than a bare space, because a key that is assembled in one
 * place and taken apart in another is a bug waiting to happen — and did happen
 * once. Nothing takes these apart any more; the separator only has to be a
 * character that cannot appear in an id.
 */
const SCOPE_SEPARATOR = '\u0000';

export function scopeKey(scope: DeliveryScope): string {
  return `${scope.runId}${SCOPE_SEPARATOR}${scope.recipientAgentId ?? ''}`;
}

/** Default idempotency key. See `PublishInput.dedupeKey`. */
export function defaultDedupeKey(input: PublishInput): string {
  return [
    input.runId,
    String(input.iteration),
    input.messageType,
    input.recipientAgentId ?? '-',
    input.stepId ?? '-',
  ].join(':');
}

/**
 * Backoff for a redelivery, in milliseconds.
 *
 * Exponential from `baseMs`, capped at `capMs`, then jittered by up to ±25%.
 * The jitter matters even locally: two workers whose leases expire in the same
 * second should not both retry in the same second forever.
 */
export function backoffMs(
  attempt: number,
  baseMs = 1_000,
  capMs = 60_000,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exponential * 0.25 * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}
