/**
 * What the Activity panel is allowed to say about a run.
 *
 * ## What went wrong
 *
 * A run that stopped for a person - `NEEDS_HUMAN`, with no agent ever
 * invoked - was drawn as a run in progress: two steps spinning for ever, a
 * clock still counting, and a "Equipe" section listing every agent registered
 * in the application as though each had taken part. None of it was true, and
 * all of it came from the same mistake: the panel described the *application*
 * instead of describing the *run on screen*.
 *
 * The three rules here are the whole fix, and they are deliberately pure
 * functions rather than conditions inside the component:
 *
 *  1. **A finished run has no moving parts.** When the run is over, no step is
 *     `running`. The step is not hidden and it is not silently marked done -
 *     it becomes `stopped`, which is what actually happened to it. Nothing is
 *     masked with CSS: the spinner element is never rendered, because the
 *     status it belongs to is gone.
 *  2. **A participant is an agent that was invoked.** The roster is the
 *     application's; the participants are this run's. An agent with no
 *     invocation in this run is not on the panel at all.
 *  3. **Live facts belong to the run that produced them.** An agent busy in
 *     *another* run is not "running" here, and a finished run has nothing in
 *     flight - so the task, the timer and the waiting-delegation count are
 *     dropped rather than borrowed from elsewhere.
 */

/** Run statuses after which nothing more happens on its own. */
export const TERMINAL_RUN_STATUSES = ['DONE', 'FAILED', 'CANCELLED', 'BLOCKED', 'NEEDS_HUMAN'] as const;

/** True when the run has stopped, whatever the reason. */
export function isRunOver(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * The stages the run reported, in the shape the progress event delivers them.
 */
export interface StageReport {
  readonly stage: string;
  readonly label: string;
  readonly status: string;
}

export type StepStatus = 'done' | 'failed' | 'running' | 'pending' | 'stopped';

export interface ActivityStep {
  readonly label: string;
  readonly status: StepStatus;
  readonly time: string;
}

/**
 * Step rows for the panel.
 *
 * `runOver` is the run's own status, not a guess from the stages: the last
 * stage of a run stopped at the iteration limit is `needs-human`, but the two
 * stages *before* it are still marked `RUNNING`, and those are the spinners
 * that used to turn for ever.
 */
export function stepsFrom(stages: readonly StageReport[], runOver: boolean): ActivityStep[] {
  return stages.map((stage) => ({
    label: stage.label,
    status: stepStatus(stage.status, runOver),
    time: '—',
  }));
}

function stepStatus(status: string, runOver: boolean): StepStatus {
  switch (status) {
    case 'RUNNING':
      // The one that mattered: a stage still open when the run ended did not
      // finish, so it is neither done nor still going.
      return runOver ? 'stopped' : 'running';
    case 'FAILED':
      return 'failed';
    case 'PENDING':
      return 'pending';
    // A run that stopped for a person, or was cancelled, did not complete this
    // stage either - and a green tick beside "Bloqueado." says it did.
    case 'BLOCKED':
    case 'NEEDS_HUMAN':
    case 'CANCELLED':
      return 'stopped';
    default:
      return 'done';
  }
}

/** The part of an agent row this module reads and rewrites. */
export interface LiveAgent {
  readonly agentId: string;
  readonly status: 'idle' | 'running' | 'offline' | 'blocked';
  readonly currentTask: string | null;
  readonly currentRunId: string | null;
  readonly runningForMs: number | null;
  readonly awaitingReply: number;
}

/** An invocation, as far as participation is concerned. */
export interface InvocationRef {
  readonly agentId: string | null;
}

/**
 * The agents that actually took part in this run, with this run's facts.
 *
 * An empty answer is the correct answer for a run that invoked nobody, and it
 * is the one the reported incident needed: a `NEEDS_HUMAN` run with zero
 * invocations listed both registered agents as participants.
 */
export function participantsOf<T extends LiveAgent>(
  roster: readonly T[],
  invocations: readonly InvocationRef[],
  runId: string | null,
  runOver: boolean,
): T[] {
  const took = new Set(invocations.map((row) => row.agentId).filter((id): id is string => Boolean(id)));
  return roster
    .filter((agent) => took.has(agent.agentId))
    .map((agent) => {
      // Busy elsewhere, or busy nowhere: either way not busy *here*.
      const hereAndNow = !runOver && agent.status === 'running' && runId !== null && agent.currentRunId === runId;
      if (hereAndNow) return agent;
      return {
        ...agent,
        // `offline` and `blocked` are facts about the connection, not about
        // this run, so they survive; `running` does not.
        status: agent.status === 'running' ? 'idle' : agent.status,
        currentTask: null,
        currentRunId: null,
        runningForMs: null,
        awaitingReply: 0,
      };
    });
}
