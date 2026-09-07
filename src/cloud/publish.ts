/**
 * Publishing a remote run's work.
 *
 * A cloud workspace is disposable, and that is a problem the local product
 * never had: when the workspace is reclaimed, anything not pushed is gone. A
 * run that edits files, passes its verifications, satisfies the DONE gate and
 * then evaporates has produced nothing.
 *
 * So a remote run **publishes before it is released**. The rules:
 *
 *  - the branch name is derived from the run's own id, so it is unique per run
 *    and a retry pushes the same commits to the same branch - which is a
 *    no-op, not a second branch and not a second pull request;
 *  - nothing is ever force-pushed, and no existing branch is written to unless
 *    the caller named it;
 *  - the write token is minted for this push alone, and reaches git through
 *    the same askpass file the clone uses - never a URL, never argv;
 *  - a run that changed nothing publishes nothing, rather than an empty commit.
 */

import { randomUUID } from 'node:crypto';
import type { ProcessRunner } from '../execution/process-runner.js';
import type { RepositoryAccess } from './provisioner.js';

const SECRET_DIR = '/run/orchestrator';

export interface PublishRequest {
  readonly processes: ProcessRunner;
  /** The repository's path inside the workspace. */
  readonly workingDirectory: string;
  readonly repository: string;
  /** The branch the run started from; the pull request's base. */
  readonly baseBranch: string;
  /** The run's id: what makes the branch name unique and the push idempotent. */
  readonly runId: string;
  readonly objective: string;
  readonly repositoryAccess: RepositoryAccess;
  /** Branch to push to. Defaults to one derived from the run id. */
  readonly branch?: string | null;
  readonly signal?: AbortSignal;
}

export interface PublishResult {
  /** False when the run changed nothing: there was nothing to publish. */
  readonly published: boolean;
  readonly branch: string | null;
  readonly commit: string | null;
  /** Why nothing was published, when nothing was. */
  readonly reason: string | null;
}

export class PublishError extends Error {
  readonly userMessage: string;
  constructor(
    readonly reason: 'NOTHING_TO_PUBLISH' | 'COMMIT_FAILED' | 'PUSH_REJECTED' | 'UNAUTHORIZED',
    userMessage: string,
    readonly detail: string | null = null,
  ) {
    super(detail ? `${userMessage} (${detail})` : userMessage);
    this.name = 'PublishError';
    this.userMessage = detail ? `${userMessage} Detalhe: ${detail}.` : userMessage;
  }
}

/** The branch a run publishes to when the caller names none. */
export function branchForRun(runId: string): string {
  // The run id is already unique and already in the record, so the branch can
  // always be found again from the run - and two runs never collide.
  return `ai-orchestrator/${runId.replace(/[^A-Za-z0-9._-]/g, '-')}`;
}

export async function publishRun(request: PublishRequest): Promise<PublishResult> {
  const { processes, workingDirectory: cwd } = request;
  const run = async (args: string[], env?: Record<string, string | undefined>) =>
    processes.run({
      command: 'git',
      args,
      cwd,
      timeoutMs: 10 * 60_000,
      ...(env ? { env } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });

  // Nothing changed? Then nothing is published, and an empty commit is not
  // made to pretend otherwise.
  const status = await run(['status', '--porcelain']);
  if (status.exitCode !== 0) {
    throw new PublishError('COMMIT_FAILED', 'Não foi possível ler o estado do repositório remoto.', firstLine(status.stderr));
  }
  if (status.stdout.trim().length === 0) {
    return { published: false, branch: null, commit: null, reason: 'nada mudou nesta execução' };
  }

  const branch = request.branch?.trim() || branchForRun(request.runId);
  // `-B` rather than `-b`: re-publishing the same run reuses its own branch
  // instead of failing on the second attempt.
  const checkout = await run(['checkout', '-B', branch]);
  if (checkout.exitCode !== 0) {
    throw new PublishError('COMMIT_FAILED', `Não foi possível criar a branch ${branch}.`, firstLine(checkout.stderr));
  }

  const add = await run(['add', '-A']);
  if (add.exitCode !== 0) {
    throw new PublishError('COMMIT_FAILED', 'Não foi possível preparar as alterações.', firstLine(add.stderr));
  }

  // The identity is the application's, stated rather than inherited: a commit
  // that claimed to be from the person would be a lie about who wrote it.
  const commit = await run([
    '-c',
    'user.name=AI Orchestrator',
    '-c',
    'user.email=ai-orchestrator@users.noreply.github.com',
    'commit',
    '-m',
    commitMessage(request.objective, request.runId),
  ]);
  if (commit.exitCode !== 0) {
    // "nothing to commit" here means another attempt already committed these
    // changes, which is success, not failure.
    if (/nothing to commit|nada a submeter/i.test(`${commit.stdout}${commit.stderr}`)) {
      const head = await run(['rev-parse', 'HEAD']);
      return {
        published: true,
        branch,
        commit: head.exitCode === 0 ? head.stdout.trim() : null,
        reason: null,
      };
    }
    throw new PublishError('COMMIT_FAILED', 'Não foi possível registrar as alterações.', firstLine(commit.stderr));
  }

  // A write token, minted for this push alone and reaching git through the
  // askpass file - never a URL, never argv.
  const token = await request.repositoryAccess.token(request.repository, 'write');
  const secretFile = `${SECRET_DIR}/${randomUUID()}`;
  const wrote = await processes.run({
    command: '/usr/local/bin/orq-write-secret',
    args: [secretFile],
    cwd,
    stdin: token.value,
    timeoutMs: 30_000,
  });
  if (wrote.exitCode !== 0) {
    throw new PublishError('UNAUTHORIZED', 'Não foi possível preparar a credencial de escrita.', firstLine(wrote.stderr));
  }

  try {
    // Never `--force`, never `--force-with-lease`: this branch belongs to this
    // run, and anything already on it that we did not put there is somebody's
    // work.
    const push = await run(['push', '--set-upstream', 'origin', branch], {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/local/bin/orq-askpass',
      ORQ_TOKEN_FILE: secretFile,
      ORQ_TOKEN_USER: 'x-access-token',
    });
    if (push.exitCode !== 0) {
      const output = `${push.stdout}${push.stderr}`;
      if (/403|permission|denied|protected branch/i.test(output)) {
        throw new PublishError(
          'UNAUTHORIZED',
          `O GitHub recusou o push para ${branch}.`,
          firstLine(push.stderr),
        );
      }
      throw new PublishError('PUSH_REJECTED', `O push da branch ${branch} não foi aceito.`, firstLine(push.stderr));
    }
  } finally {
    await processes
      .run({ command: 'rm', args: ['-f', secretFile], cwd, timeoutMs: 30_000 })
      .catch(() => {});
  }

  const head = await run(['rev-parse', 'HEAD']);
  return {
    published: true,
    branch,
    commit: head.exitCode === 0 ? head.stdout.trim() : null,
    reason: null,
  };
}

function commitMessage(objective: string, runId: string): string {
  const summary = objective.replace(/\s+/g, ' ').trim().slice(0, 72) || 'Alterações da execução';
  // The run id in the trailer is what ties a commit back to the record of how
  // it was produced - what was asked, what ran, and what verified it.
  return `${summary}\n\nAI-Orchestrator-Run: ${runId}\n`;
}

function firstLine(text: string): string | null {
  for (const line of (text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}
