/**
 * Evidence for a run that has no working copy.
 *
 * The loop's rule has never changed: **the worker's report is a declaration,
 * and evidence is a measurement.** With a checkout the measurement is `git`
 * looking at the folder. Without one it is GitHub answering "what is different
 * between these two commits?" - which is the same question asked of the only
 * thing that actually holds the code.
 *
 * The shape is deliberately `GitEvidence`, the same record the local collector
 * produces, so the ledger, the report, the DoneGate and the screen all keep
 * working unchanged. This is the seam that lets GitHub mode reuse the engine
 * instead of growing a second one.
 *
 * What it does **not** do is pretend to be a working tree. There is no dirty
 * state, no untracked file and no local edit, because there is no folder for
 * any of those to happen in: everything here is committed or it does not
 * exist. `statusShort` says exactly that rather than inventing a `git status`.
 */

import type { GitEvidence } from '../core/types.js';
import type { RepositoryDiff, RepositoryOperations } from './repository-operations.js';
import type { RepositoryRef } from './repository-reader.js';

export interface GitHubEvidenceInput {
  readonly operations: RepositoryOperations;
  readonly ref: RepositoryRef;
  /** The branch the run publishes to. */
  readonly branch: string;
  /** Where the run started: the commit the work branch was cut from. */
  readonly baseCommit: string;
  readonly token: string | null;
  readonly signal?: AbortSignal;
}

/**
 * What changed on the work branch since the run began, measured at GitHub.
 *
 * A failure to look is reported as a failure to look. "I could not reach
 * GitHub" and "nothing changed" produce identical file lists and must never
 * produce identical evidence: the first sets `source: 'none'` with a problem
 * the orchestrator reads verbatim, and the DoneGate treats it as no proof at
 * all rather than as proof of nothing.
 */
export async function collectGitHubEvidence(input: GitHubEvidenceInput): Promise<GitEvidence> {
  const collectedAt = new Date().toISOString();
  let head: string | null;
  try {
    head = await input.operations.branchHead(input.ref, input.branch, input.token, input.signal);
  } catch (error) {
    return problem(collectedAt, input.branch, `Não consegui ler a branch no GitHub: ${message(error)}`);
  }

  if (head === null) {
    // The branch is not there yet. That is a real, ordinary state at the start
    // of a run - nothing has been published - and it is not a failure.
    return {
      collectedAt,
      isGitRepository: true,
      commit: input.baseCommit,
      branch: input.branch,
      statusShort: 'Nenhuma branch de trabalho publicada ainda.',
      diff: '',
      diffStat: '',
      changedFiles: [],
      addedFiles: [],
      deletedFiles: [],
      changedSinceBaseline: false,
      source: 'git',
      files: null,
    };
  }

  if (head === input.baseCommit) {
    return {
      collectedAt,
      isGitRepository: true,
      commit: head,
      branch: input.branch,
      statusShort: 'A branch de trabalho está no commit de origem: nada foi publicado.',
      diff: '',
      diffStat: '',
      changedFiles: [],
      addedFiles: [],
      deletedFiles: [],
      changedSinceBaseline: false,
      source: 'git',
      files: null,
    };
  }

  let diff: RepositoryDiff;
  try {
    diff = await input.operations.compare(input.ref, input.baseCommit, head, input.token, input.signal);
  } catch (error) {
    return problem(collectedAt, input.branch, `Não consegui comparar os commits no GitHub: ${message(error)}`);
  }

  const added = diff.files.filter((file) => file.status === 'added').map((file) => file.path);
  const removed = diff.files.filter((file) => file.status === 'removed').map((file) => file.path);
  // `changedFiles` is every path the comparison touched, and `addedFiles` is
  // the subset that is new. The local collector has the same overlap and the
  // report subtracts it; keeping the same shape keeps that one rule in one
  // place instead of two.
  const changed = diff.files.map((file) => file.path);

  return {
    collectedAt,
    isGitRepository: true,
    commit: head,
    branch: input.branch,
    statusShort: describeStatus(diff, input.baseCommit, head),
    diff: renderPatches(diff),
    diffStat: diff.files
      .map((file) => `${file.path} | +${file.additions} -${file.deletions} (${file.status})`)
      .join('\n'),
    changedFiles: changed,
    addedFiles: added,
    deletedFiles: removed,
    changedSinceBaseline: diff.files.length > 0,
    source: 'git',
    files: null,
  };
}

function describeStatus(diff: RepositoryDiff, base: string, head: string): string {
  const lines = [
    `${base.slice(0, 12)}..${head.slice(0, 12)}: ${diff.files.length} arquivo(s), ` +
      `${diff.aheadBy} commit(s) à frente.`,
  ];
  if (diff.truncated) {
    // Said out loud: a partial list presented as complete is how a run
    // concludes over changes nobody looked at.
    lines.push(
      'A comparação foi truncada pelo GitHub: esta lista NÃO é completa. Trate como prova parcial.',
    );
  }
  return lines.join('\n');
}

/**
 * The patches, with the ones GitHub did not send named as missing.
 *
 * A binary file and a very large diff both come back without a patch. Leaving
 * them out entirely would make the diff look smaller than the change; saying
 * "sem patch" keeps the file in view and keeps the claim honest.
 */
function renderPatches(diff: RepositoryDiff): string {
  return diff.files
    .map((file) => {
      const header = `--- ${file.previousPath ?? file.path}\n+++ ${file.path}`;
      if (file.patch === null) {
        return `${header}\n(o GitHub não enviou patch para este arquivo: binário ou grande demais)`;
      }
      return `${header}\n${file.patch}`;
    })
    .join('\n\n');
}

function problem(collectedAt: string, branch: string, text: string): GitEvidence {
  return {
    collectedAt,
    isGitRepository: true,
    commit: null,
    branch,
    statusShort: text,
    diff: '',
    diffStat: '',
    changedFiles: [],
    addedFiles: [],
    deletedFiles: [],
    changedSinceBaseline: false,
    source: 'none',
    evidenceProblem: text,
    files: null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
