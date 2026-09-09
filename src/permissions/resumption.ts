/**
 * Whether an answered authorisation continues the task it stopped.
 *
 * ## What went wrong
 *
 * The person asked whether the orchestrator could reach a GitHub repository.
 * The worker reached for a tool, the non-interactive run refused it, the
 * application asked for authorisation and said, in the very prompt it sends
 * the worker:
 *
 * > the task will be delegated again once they do
 *
 * The person authorised it. **Nothing happened.** `permission.approve` wrote a
 * grant row and returned; the run stayed at `NEEDS_HUMAN` for ever. So they
 * typed "tente novamente", which created a *second* run - a new plan, a new
 * assessment, and a simple read-only question routed to a stronger model than
 * it ever needed, because the first run's history was not the new run's.
 *
 * The authorisation was never the problem. The missing half was this one.
 *
 * ## Why a separate function
 *
 * Resuming touches the two things that must never be got wrong together:
 * a cancelled run must stay cancelled, and a refusal must stay refused. Both
 * are decided here, from facts, with no service, no database and no clock - so
 * every case can be stated as a test rather than reproduced as an incident.
 */

export type ResumptionRefusal =
  /** The person cancelled. Their decision outranks any pending authorisation. */
  | 'cancelled'
  /** DONE, FAILED or CANCELLED. A finished run is not restarted from here. */
  | 'finished'
  /** The run never stopped for a person; there is nothing to continue. */
  | 'not-waiting'
  /** It is already going. Resuming would run the same objective twice. */
  | 'already-running'
  /** Other questions are still open; continuing would only stop again. */
  | 'still-waiting-on-answers'
  /** Everything was refused. The refusal stands, and is not asked again. */
  | 'nothing-authorised';

export type ResumptionDecision =
  | { readonly resume: true; readonly rules: readonly string[] }
  | { readonly resume: false; readonly because: ResumptionRefusal };

export interface ResumptionFacts {
  /** The run's status, as the database holds it now. */
  readonly status: string;
  /** Whether a cancellation has been *requested*, decided or not. */
  readonly cancelRequested: boolean;
  /** Whether the loop for this run is executing at this moment. */
  readonly running: boolean;
  /** Authorisation questions of this run still waiting for a person. */
  readonly pending: number;
  /**
   * How many of *this run's* questions the person approved.
   *
   * Not "are there grants in this project": a project can hold grants from
   * last week, and a person who refuses today's question has refused it. Only
   * an approval for something this run was actually stopped on is a reason to
   * continue it.
   */
  readonly approvedForRun: number;
  /**
   * The rules in force for this run's workspace, as they will be sent to the
   * CLI. Carried so the caller can show, and record, exactly what the resumed
   * delegation is authorised to do.
   */
  readonly grantedRules: readonly string[];
}

const FINISHED = new Set(['DONE', 'FAILED', 'CANCELLED']);

/**
 * The decision, in the order the rules actually rank.
 *
 * Cancellation is first on purpose. The person said stop; an authorisation
 * that arrives afterwards - theirs or anyone's - does not restart the work,
 * and a run whose cancellation is merely *requested* counts as cancelled here
 * even before the loop has written the terminal state.
 */
export function decideResumption(facts: ResumptionFacts): ResumptionDecision {
  if (facts.cancelRequested) return { resume: false, because: 'cancelled' };
  if (FINISHED.has(facts.status)) return { resume: false, because: 'finished' };
  if (facts.running) return { resume: false, because: 'already-running' };
  if (facts.status !== 'NEEDS_HUMAN') return { resume: false, because: 'not-waiting' };
  if (facts.pending > 0) return { resume: false, because: 'still-waiting-on-answers' };
  if (facts.approvedForRun === 0) return { resume: false, because: 'nothing-authorised' };
  return { resume: true, rules: [...facts.grantedRules] };
}

/** What the person is told, when the answer is "not from here". */
export function explainRefusal(because: ResumptionRefusal): string {
  switch (because) {
    case 'cancelled':
      return 'Esta execução foi cancelada. A autorização foi registrada e vale para as próximas, mas não reinicia esta.';
    case 'finished':
      return 'Esta execução já terminou. A autorização foi registrada e vale para as próximas.';
    case 'not-waiting':
      return 'Esta execução não estava parada esperando por você, então não há o que continuar.';
    case 'already-running':
      return 'Esta execução já está em andamento; a autorização vale a partir da próxima delegação.';
    case 'still-waiting-on-answers':
      return 'Ainda há pedidos de autorização sem resposta nesta execução. Ela continua quando você responder a todos.';
    case 'nothing-authorised':
      return 'Nada foi autorizado, então a execução não continua. A recusa foi registrada e não será perguntada de novo.';
  }
}
