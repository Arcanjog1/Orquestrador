/**
 * Final DONE validation (spec 15).
 *
 * This is the rule the whole design exists to enforce: an orchestrator agent
 * answering `{"action": "done"}` does not end the run. The program re-checks,
 * independently, and only finishes when there is objective evidence. When there
 * is not, the run continues and the agent is told exactly what failed.
 */

import type { Baseline, DoneGateResult, GitEvidence, IterationRecord } from '../core/types.js';
import { AcceptanceCriteriaLedger } from './acceptance-criteria.js';
import { commandPassed, Verifier } from './verifier.js';

export interface DoneGateInput {
  ledger: AcceptanceCriteriaLedger;
  /** Every verification command seen across the run, deduplicated. */
  verificationCommands: readonly string[];
  iterations: readonly IterationRecord[];
  baseline: Baseline;
  /** Freshly collected evidence, gathered right before the gate runs. */
  evidence: GitEvidence;
  verifier: Verifier;
  /**
   * When true, a run that changed nothing is accepted. Set for objectives that
   * are genuinely read-only (an audit, an investigation).
   */
  allowNoChanges: boolean;
}

export async function evaluateDone(input: DoneGateInput): Promise<DoneGateResult> {
  const failures: string[] = [];

  // 1. Re-run every verification command from scratch. Nothing is taken on
  //    trust from an earlier iteration.
  const verification = await input.verifier.runAll(input.verificationCommands);
  for (const result of verification) {
    if (commandPassed(result)) continue;
    if (result.refused) {
      failures.push(`Verification command was refused and never ran: "${result.command}" - ${result.refused}`);
    } else if (result.timedOut) {
      failures.push(`Verification command timed out: "${result.command}"`);
    } else {
      failures.push(
        `Verification command failed with exit code ${result.exitCode}: "${result.command}"` +
          firstErrorLine(result.stderr || result.stdout),
      );
    }
  }

  // 2. Criteria still lacking evidence block completion. A criterion that was
  //    only ever asserted by the worker never reaches `satisfied` here.
  for (const criterion of input.ledger.pending()) {
    const state = criterion.status === 'failed' ? 'is recorded as failed' : 'has no supporting evidence';
    failures.push(`Acceptance criterion ${state}: "${criterion.text}"`);
  }

  // 3. Something must actually have changed, unless the objective is read-only.
  if (!input.allowNoChanges && input.evidence.isGitRepository && !input.evidence.changedSinceBaseline) {
    failures.push(
      'No file changed relative to the baseline. If the objective genuinely requires no code ' +
        'changes, re-run with --allow-no-changes.',
    );
  }

  // 4. An iteration that ended in a timeout or a crash, and was never followed
  //    by a successful one, is unfinished business.
  const unresolved = findUnresolvedWorkerFailure(input.iterations);
  if (unresolved) failures.push(unresolved);

  return {
    passed: failures.length === 0,
    failures,
    checkedAt: new Date().toISOString(),
    verification,
  };
}

/**
 * Reports a worker failure only when it is the *last* thing that happened -
 * an earlier crash that a later iteration fixed is not a reason to block.
 */
function findUnresolvedWorkerFailure(iterations: readonly IterationRecord[]): string | null {
  for (let i = iterations.length - 1; i >= 0; i -= 1) {
    const worker = iterations[i]?.worker;
    if (!worker) continue;
    if (worker.outcome === 'completed' && worker.exitCode === 0) return null;
    return (
      `The last worker task did not complete cleanly (iteration ${iterations[i]!.iteration}, ` +
      `outcome ${worker.outcome}, exit code ${worker.exitCode}).`
    );
  }
  return null;
}

function firstErrorLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? ` - ${line.slice(0, 200)}` : '';
}

/** Renders the gate's verdict for the next orchestrator prompt (spec 15). */
export function formatDoneRejection(result: DoneGateResult): string {
  return [
    'DONE_REJECTED',
    '',
    'You answered `done`, but the orchestrator ran its own final validation and it did not pass.',
    'These checks failed:',
    '',
    ...result.failures.map((f, i) => `${i + 1}. ${f}`),
    '',
    'Do not answer `done` again until these are addressed. Delegate the work needed to fix them,',
    'or answer `blocked` with a reason if they cannot be fixed.',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Conversation runs
 * ------------------------------------------------------------------ */

export interface ConversationDoneInput {
  ledger: AcceptanceCriteriaLedger;
  iterations: readonly IterationRecord[];
  /** The orchestrator's final answer, as it will be shown to the person. */
  answer: string;
}

/**
 * The DONE gate for a run that never touches a workspace.
 *
 * The coding gate is not loosened for these runs - it is the *wrong* gate for
 * them. Demanding a git diff from a run whose objective was "compare two
 * approaches" would either block every such run or, worse, invite someone to
 * relax the real gate until it let a coding run through on an assertion. So a
 * conversation run gets its own, and this one refuses to invent evidence it
 * does not have: it never reports a diff, never claims a test ran, and never
 * says a file changed.
 *
 * What it does demand is real:
 *
 *  1. There is an answer, of substance, not an empty string.
 *  2. Every criterion the orchestrator itself set is accounted for. A
 *     criterion it declared and then left unaddressed blocks DONE here exactly
 *     as it does in a coding run.
 *  3. The last worker invocation actually completed. A run whose final
 *     delegation timed out has not finished, however confident the summary is.
 */
export async function evaluateConversationDone(
  input: ConversationDoneInput,
): Promise<DoneGateResult> {
  const failures: string[] = [];

  const answer = input.answer.trim();
  if (answer.length < MINIMUM_ANSWER_LENGTH) {
    failures.push(
      'The run proposed `done` without a final answer. Provide the answer the person asked ' +
        'for, in the `summary` of your `done` decision.',
    );
  }

  for (const criterion of input.ledger.pending()) {
    const state = criterion.status === 'failed' ? 'is recorded as failed' : 'was never addressed';
    failures.push(`Acceptance criterion ${state}: "${criterion.text}"`);
  }

  const unresolved = findUnresolvedWorkerFailure(input.iterations);
  if (unresolved) failures.push(unresolved);

  return {
    passed: failures.length === 0,
    failures,
    checkedAt: new Date().toISOString(),
    // Deliberately empty, and it must stay empty: a conversation run ran no
    // verification, and reporting one it did not run is the exact dishonesty
    // this gate exists to prevent.
    verification: [],
  };
}

/** Short enough to allow a terse answer, long enough to reject "ok". */
const MINIMUM_ANSWER_LENGTH = 20;
