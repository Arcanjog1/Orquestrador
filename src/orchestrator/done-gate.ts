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
import type { ObjectiveIntent } from './objective-intent.js';
import {
  describeFileCheck,
  runFileChecks,
  type FileCheckRequest,
  type FileCheckResult,
} from '../verification/file-check.js';

export interface DoneGateInput {
  /** The desktop derives this once from the user's objective, never from a model. */
  objectiveIntent?: ObjectiveIntent;
  /** Independent read-proof evaluation. An omitted evaluation is not a PASS. */
  objectiveProofProblems?: readonly string[];
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
  /**
   * File checks to re-run, from scratch, before finishing.
   *
   * Deduplicated across the run by the caller, exactly like
   * `verificationCommands`. The gate re-reads every one of them: a file that
   * was right in iteration 2 may have been overwritten in iteration 3, and a
   * gate that trusted the earlier read would be certifying a memory.
   */
  fileChecks?: readonly FileCheckRequest[];
  /** Where the file checks resolve against. Required when there are any. */
  workspaceRoot?: string;
  /**
   * Where the gate re-reads files from, when it is not this computer.
   *
   * A project working straight against GitHub has no folder for
   * `workspaceRoot` to name, and the files it must re-check live at a commit.
   * Supplying this replaces *where* the gate looks and nothing else: it still
   * re-reads every check from scratch, still compares the same bytes with the
   * same rule, and still refuses to certify a criterion nothing proved.
   */
  readFileChecks?: (requests: readonly FileCheckRequest[]) => Promise<FileCheckResult[]>;
}

export async function evaluateDone(input: DoneGateInput): Promise<DoneGateResult> {
  const failures: string[] = [];
  if(input.objectiveIntent?.readProofs.length) {
    failures.push(...(input.objectiveProofProblems ?? ['Read obligations were not independently checked.']));
  }

  // 1. Re-run every verification command from scratch. Nothing is taken on
  //    trust from an earlier iteration.
  const verification = await input.verifier.runAll(input.verificationCommands);
  if(input.objectiveIntent?.requiresExecution && verification.length===0)failures.push('Execution was requested, but no command was independently executed.');
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

  // 1b. Re-read every file the run claimed something about. Same rule as the
  //     commands above: nothing is taken on trust from an earlier iteration,
  //     because the gate certifies the state of the workspace *now*.
  const fileChecks =
    input.fileChecks && input.fileChecks.length > 0
      ? input.readFileChecks
        ? await input.readFileChecks(input.fileChecks)
        : input.workspaceRoot
          ? await runFileChecks(input.workspaceRoot, input.fileChecks)
          : []
      : [];
  for (const check of fileChecks) {
    if (check.passed) continue;
    failures.push(`File check failed: ${describeFileCheck(check)}`);
  }

  // 2. Criteria still lacking evidence block completion. A criterion that was
  //    only ever asserted by the worker never reaches `satisfied` here.
  for (const criterion of input.ledger.pending()) {
    const state = criterion.status === 'failed' ? 'is recorded as failed' : 'has no supporting evidence';
    failures.push(`Acceptance criterion ${state}: "${criterion.text}"`);
  }

  // 3. Something must actually have changed, unless the objective is read-only
  //    or the application has read the result for itself.
  //
  //    That second exemption is the point of a file check. If the gate has
  //    just opened the file and found exactly the bytes the objective asked
  //    for, "nothing changed" is not a reason to refuse - the file being
  //    already correct is the goal, reached. Demanding a diff there would mean
  //    demanding a pointless rewrite to manufacture one.
  const provenByReading = fileChecks.length > 0 && fileChecks.every((check) => check.passed);
  if (
    (input.objectiveIntent ? input.objectiveIntent.requiresChanges : !input.allowNoChanges) &&
    !provenByReading &&
    (input.evidence.isGitRepository || input.objectiveIntent?.requiresChanges) &&
    !input.evidence.changedSinceBaseline
  ) {
    failures.push(
      'No file changed relative to the baseline. A change objective needs a measured change or a matching independent file check.',
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
    ...(fileChecks.length > 0 ? { fileChecks } : {}),
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
    'Do not answer `done` again without new evidence. Check the objective-specific proof requirements.',
    'A query needs reading evidence, never manufactured edits. Delegate changes only when requested.',
    'If the application cannot supply the required proof, report the concrete blocker; a stronger model does not fix infrastructure.',
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
