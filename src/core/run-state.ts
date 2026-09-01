/**
 * Explicit run state machine (spec 42).
 *
 * Run status is always read from `state.json`, never inferred from log output.
 * `assertTransition` is the single choke point: every status change in the
 * orchestrator goes through `StateManager`, which calls it.
 */

export const RUN_STATUSES = [
  'CREATED',
  'BASELINING',
  'ORCHESTRATING',
  'DELEGATING',
  'WORKER_RUNNING',
  'COLLECTING_EVIDENCE',
  'VERIFYING',
  'WAITING_ORCHESTRATOR',
  'DONE_PENDING_VERIFICATION',
  'DONE',
  'BLOCKED',
  'CANCELLED',
  'FAILED',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/** Statuses from which a run can no longer proceed. */
export const TERMINAL_STATUSES: readonly RunStatus[] = ['DONE', 'BLOCKED', 'CANCELLED', 'FAILED'];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Statuses a run may be resumed from. Terminal runs are never resumed; a new
 * run is started instead.
 */
export function isResumable(status: RunStatus): boolean {
  return !isTerminal(status);
}

/**
 * Allowed forward transitions. `CANCELLED` and `FAILED` are reachable from any
 * non-terminal status and are handled separately in `assertTransition`.
 */
const ALLOWED: Record<RunStatus, readonly RunStatus[]> = {
  CREATED: ['BASELINING'],
  BASELINING: ['ORCHESTRATING'],
  ORCHESTRATING: ['DELEGATING', 'VERIFYING', 'DONE_PENDING_VERIFICATION', 'BLOCKED'],
  DELEGATING: ['WORKER_RUNNING'],
  WORKER_RUNNING: ['COLLECTING_EVIDENCE'],
  COLLECTING_EVIDENCE: ['VERIFYING', 'WAITING_ORCHESTRATOR'],
  VERIFYING: ['WAITING_ORCHESTRATOR', 'DONE_PENDING_VERIFICATION'],
  WAITING_ORCHESTRATOR: ['ORCHESTRATING', 'BLOCKED'],
  // The DONE gate either accepts (DONE) or rejects and hands control back.
  DONE_PENDING_VERIFICATION: ['DONE', 'WAITING_ORCHESTRATOR', 'BLOCKED'],
  DONE: [],
  BLOCKED: [],
  CANCELLED: [],
  FAILED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
  ) {
    super(`Invalid run status transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true;
  // A run can be abandoned from any live status.
  if ((to === 'CANCELLED' || to === 'FAILED') && !isTerminal(from)) return true;
  return (ALLOWED[from] ?? []).includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Human-readable label used by `orchestrator status`. */
export function describeStatus(status: RunStatus): string {
  switch (status) {
    case 'CREATED':
      return 'Created, not started';
    case 'BASELINING':
      return 'Capturing project baseline';
    case 'ORCHESTRATING':
      return 'Waiting for orchestrator decision';
    case 'DELEGATING':
      return 'Preparing worker task';
    case 'WORKER_RUNNING':
      return 'Worker running';
    case 'COLLECTING_EVIDENCE':
      return 'Collecting git evidence';
    case 'VERIFYING':
      return 'Running verification commands';
    case 'WAITING_ORCHESTRATOR':
      return 'Reporting results back to orchestrator';
    case 'DONE_PENDING_VERIFICATION':
      return 'DONE proposed, running final validation';
    case 'DONE':
      return 'Completed';
    case 'BLOCKED':
      return 'Blocked, needs human review';
    case 'CANCELLED':
      return 'Cancelled';
    case 'FAILED':
      return 'Failed';
  }
}
