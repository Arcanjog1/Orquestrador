/**
 * Publishing a remote run's work.
 *
 * A cloud workspace is disposable, which creates a failure the local product
 * never had: a run that edits files, passes its verifications and satisfies the
 * DONE gate, and is then reclaimed, has produced *nothing*. So publishing
 * happens before release, and these tests are about the ways that could go
 * quietly wrong - a second pull request from a retry, a force-push over
 * somebody's work, a credential in a URL, an empty commit pretending something
 * happened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublishError, branchForRun, publishRun } from '../src/cloud/publish.js';
import type { RepositoryAccess } from '../src/cloud/provisioner.js';
import type { ProcessResult, ProcessRunner, RunProcessOptions } from '../src/execution/process-runner.js';

const TOKEN = 'ghs_theWriteTokenForThisPushAlone';

const access: RepositoryAccess = {
  async token(_repository, scope) {
    return { value: `${TOKEN}:${scope}`, expiresAt: '', identity: 'installation:1' };
  },
};

function fakeWorkspace(script: (key: string, options: RunProcessOptions) => Partial<ProcessResult>) {
  const calls: RunProcessOptions[] = [];
  const processes: ProcessRunner = {
    async run(options: RunProcessOptions): Promise<ProcessResult> {
      calls.push(options);
      const key = [options.command, ...(options.args ?? [])].join(' ');
      return {
        outcome: 'completed',
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 1,
        truncated: false,
        ...script(key, options),
      } as ProcessResult;
    },
    async cancelAll() {},
  };
  return { processes, calls };
}

const request = (processes: ProcessRunner, overrides: Record<string, unknown> = {}) => ({
  processes,
  workingDirectory: '/workspace/repo',
  repository: 'Arcanjog1/Orquestrador',
  baseBranch: 'main',
  runId: 'rr_1234',
  objective: 'Crie o arquivo que faltava',
  repositoryAccess: access,
  ...overrides,
});

const happy = (key: string): Partial<ProcessResult> => {
  if (key.includes('status --porcelain')) return { stdout: ' M src/app.ts\n?? novo.txt\n' };
  if (key.includes('rev-parse HEAD')) return { stdout: 'deadbeef1234\n' };
  return {};
};

const flatten = (calls: RunProcessOptions[]): string =>
  calls.map((c) => [c.command, ...(c.args ?? [])].join(' ')).join('\n');

test('a run that changed something is committed and pushed to a branch of its own', async () => {
  const { processes, calls } = fakeWorkspace(happy);
  const result = await publishRun(request(processes));

  assert.equal(result.published, true);
  assert.equal(result.branch, branchForRun('rr_1234'));
  assert.equal(result.commit, 'deadbeef1234');

  const everything = flatten(calls);
  // The branch carries the run id, so it can always be found again from the
  // record - and two runs never collide.
  assert.match(everything, /checkout -B ai-orchestrator\/rr_1234/);
  assert.match(everything, /push --set-upstream origin ai-orchestrator\/rr_1234/);

  // The commit is the application's, stated rather than inherited: one that
  // claimed to be the person's would be a lie about who wrote it.
  const commit = calls.find((c) => (c.args ?? []).includes('commit'))!;
  assert.ok((commit.args ?? []).includes('user.name=AI Orchestrator'));
  // The run id ties the commit back to the record of how it was produced.
  assert.match((commit.args ?? []).join(' '), /AI-Orchestrator-Run: rr_1234/);
});

test('nothing is ever force-pushed', async () => {
  // The branch belongs to this run, and anything on it we did not put there is
  // somebody's work.
  const { processes, calls } = fakeWorkspace(happy);
  await publishRun(request(processes));
  const push = calls.find((c) => (c.args ?? []).includes('push'))!;
  const args = (push.args ?? []).join(' ');
  assert.ok(!args.includes('--force'), args);
  assert.ok(!args.includes('-f'), args);
});

test('the write token never reaches a URL or an argument', async () => {
  const { processes, calls } = fakeWorkspace(happy);
  await publishRun(request(processes));

  const everything = flatten(calls);
  assert.ok(!everything.includes(TOKEN), 'the token appeared in an argument vector');
  assert.ok(!/https:\/\/[^\s]*@github\.com/.test(everything), 'a credential was embedded in a URL');

  // It went to a protected file over stdin, and was removed afterwards.
  const wrote = calls.find((c) => c.command.endsWith('orq-write-secret'))!;
  assert.ok(wrote, 'the token was never written to a protected file');
  assert.equal(wrote.stdin, `${TOKEN}:write`, 'the push must use a write-scoped token');
  assert.match(everything, /rm -f \/run\/orchestrator\//);

  // git authenticates through the askpass helper.
  const push = calls.find((c) => (c.args ?? []).includes('push'))!;
  assert.equal(push.env?.GIT_ASKPASS, '/usr/local/bin/orq-askpass');
  assert.equal(push.env?.GIT_TERMINAL_PROMPT, '0');
});

test('a run that changed nothing publishes nothing, rather than an empty commit', async () => {
  const { processes, calls } = fakeWorkspace((key) =>
    key.includes('status --porcelain') ? { stdout: '' } : {},
  );
  const result = await publishRun(request(processes));
  assert.equal(result.published, false);
  assert.match(result.reason ?? '', /nada mudou/);
  assert.ok(!flatten(calls).includes('commit'), 'an empty commit was made');
  assert.ok(!flatten(calls).includes('push'), 'nothing changed, yet something was pushed');
});

test('publishing the same run twice writes the same branch, not a second one', async () => {
  // The retry a timeout produces. `checkout -B` reuses the run's own branch,
  // and a commit that finds nothing new is success, not failure.
  const { processes, calls } = fakeWorkspace((key) => {
    if (key.includes('status --porcelain')) return { stdout: ' M src/app.ts\n' };
    if (key.includes('commit')) return { exitCode: 1, stdout: 'nothing to commit, working tree clean' };
    if (key.includes('rev-parse HEAD')) return { stdout: 'deadbeef1234\n' };
    return {};
  });
  const result = await publishRun(request(processes));
  assert.equal(result.published, true);
  assert.equal(result.branch, branchForRun('rr_1234'));
  assert.equal(result.commit, 'deadbeef1234');
  // And it did not go on to push a branch it had nothing new for.
  assert.ok(!flatten(calls).includes('push'));
});

test('a protected branch is reported as a refusal to act on, not as a crash', async () => {
  const { processes } = fakeWorkspace((key) => {
    if (key.includes('status --porcelain')) return { stdout: ' M a\n' };
    if (key.includes('push')) {
      return { exitCode: 1, stderr: 'remote: error: GH006: Protected branch update failed' };
    }
    return {};
  });
  await assert.rejects(publishRun(request(processes)), (error: unknown) => {
    assert.ok(error instanceof PublishError);
    assert.equal(error.reason, 'UNAUTHORIZED');
    return true;
  });
});

test('a named branch is honoured instead of the derived one', async () => {
  const { processes, calls } = fakeWorkspace(happy);
  const result = await publishRun(request(processes, { branch: 'feature/minha-branch' }));
  assert.equal(result.branch, 'feature/minha-branch');
  assert.match(flatten(calls), /checkout -B feature\/minha-branch/);
});
