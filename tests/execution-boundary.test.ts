/**
 * The execution boundary.
 *
 * The loop's only dependency on the machine it runs on is that it starts child
 * processes in a directory. `ExecutionEnvironment` names that dependency, so
 * the same `OrchestrationService` - the same DONE gate, the same evidence
 * collection, the same automatic second delegation - can drive a workspace
 * that is not on this computer. There is no second loop for the cloud.
 *
 * What these tests pin is that the boundary is *complete*: given a non-local
 * environment, nothing in the loop reaches around it to the local
 * ProcessManager or to `workspace.local_path`. One call that did would be the
 * bug that makes cloud mode quietly run half a run on the user's own machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGitFixture, type GitFixture } from './helpers/git-fixture.js';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';
import type { AgentInput } from '../src/core/types.js';
import type {
  ExecutionEnvironment,
  ProcessResult,
  ProcessRunner,
  RunProcessOptions,
} from '../src/execution/process-runner.js';
import { ProcessManager } from '../src/process/process-manager.js';

const EXPECTED = 'Olá da nuvem';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

function scratchRepository(): GitFixture {
  const repo = createGitFixture('lao-boundary-');
  repo.write('README.md', '# scratch\n');
  repo.write(
    'check.mjs',
    [
      "import { readFileSync } from 'node:fs';",
      'let actual = null;',
      "try { actual = readFileSync('hello.txt', 'utf8').trim(); } catch { actual = null; }",
      `if (actual !== ${JSON.stringify(EXPECTED)}) { console.error('nope: ' + actual); process.exit(1); }`,
      "console.log('ok');",
    ].join('\n'),
  );
  repo.commitAll('baseline');
  return repo;
}

/**
 * A runner that behaves like a remote one: it accepts only paths inside the
 * environment, and maps them onto the real checkout before executing. Real git
 * and a real child process still run, so the evidence and the verification are
 * genuine - they simply arrive through the boundary rather than around it.
 */
function remoteLikeRunner(realPath: string, remotePath: string) {
  const manager = new ProcessManager();
  const calls: RunProcessOptions[] = [];
  const runner: ProcessRunner = {
    async run(options: RunProcessOptions): Promise<ProcessResult> {
      calls.push(options);
      assert.ok(
        options.cwd === remotePath || options.cwd.startsWith(`${remotePath}/`),
        `the loop asked to run in ${options.cwd}, which is outside the environment (${remotePath})`,
      );
      return manager.run({ ...options, cwd: realPath + options.cwd.slice(remotePath.length) });
    },
    async cancelAll() {
      await manager.cancelAll();
    },
  };
  return { runner, calls };
}


/** Binds the workspace's orchestrator and worker, as the interface makes a person do. */
async function bindTeam(
  fixture: { router: { handle(channel: string, payload: unknown): Promise<IpcResult<unknown>> } },
  workspaceId: string,
): Promise<void> {
  value(await fixture.router.handle('accounts.create', { name: 'Claude Trabalho', provider: 'anthropic' }));
  const agents = value<Array<{ id: string; role: string }>>(await fixture.router.handle('agents.list', null));
  value(
    await fixture.router.handle('workspace.setAgents', {
      workspaceId,
      orchestratorAgentId: agents.find((a) => a.role === 'ORCHESTRATOR')!.id,
      workerAgentId: agents.find((a) => a.role === 'CODING_WORKER')!.id,
    }),
  );
}

const delegate = (task: string): string =>
  JSON.stringify({
    action: 'delegate',
    task,
    acceptanceCriteria: ['hello.txt existe com o conteúdo exato'],
    verificationCommands: ['hello-exists'],
  });

const done = (): string =>
  JSON.stringify({ action: 'done', acceptanceCriteria: [], verificationCommands: ['hello-exists'] });

test('a run in a non-local environment never touches the local path or the local runner', async () => {
  const repo = scratchRepository();
  const remotePath = '/workspace/repo';
  // The workspace row points at an empty folder that is not a git repository.
  // (Cloud workspaces have no local folder at all; today's WorkspaceService
  // still insists on one, which is the next block.) Anything in the loop that
  // read this path instead of the environment would fail loudly on the
  // baseline rather than quietly succeed against the wrong tree.
  const neverUsed = mkdtempSync(join(tmpdir(), 'lao-never-used-'));

  const { runner, calls } = remoteLikeRunner(repo.dir, remotePath);
  let released = 0;
  const environment: ExecutionEnvironment = {
    kind: 'remote',
    id: 'ws-remote-1',
    workingDirectory: remotePath,
    processes: runner,
    async release() {
      released += 1;
    },
  };

  const seen: string[] = [];
  const record = (input: AgentInput): void => {
    seen.push(input.workingDirectory);
  };
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', [
    (input: AgentInput) => {
      record(input);
      return delegate('Crie hello.txt');
    },
    (input: AgentInput) => {
      record(input);
      return done();
    },
  ]);
  const worker = new ScriptedAgent('mock-claude', 'Claude', [
    (input: AgentInput) => {
      record(input);
      // The worker writes into the path it was told to work in. That path is
      // the environment's, so this only works if the boundary held.
      assert.equal(input.workingDirectory, remotePath);
      writeFileSync(join(repo.dir, 'hello.txt'), `${EXPECTED}\n`, 'utf8');
      return 'arquivo criado';
    },
  ]);

  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    environments: async () => environment,
    maxIterations: 4,
  });

  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.create', { name: 'Nuvem', localPath: neverUsed }),
    );
    fixture.services.database.verifications.upsert({
      workspaceId: workspace.id,
      id: 'hello-exists',
      label: 'hello.txt tem o conteúdo exato',
      command: 'node check.mjs',
    });
    await bindTeam(fixture, workspace.id);
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'c' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'crie o arquivo' }),
    );
    const run = await fixture.services.orchestration.waitFor(sent.run.id);

    assert.equal(run.status, 'DONE', run.summary ?? '');
    assert.equal(readFileSync(join(repo.dir, 'hello.txt'), 'utf8').trim(), EXPECTED);

    // Every child process the loop started went through the environment...
    assert.ok(calls.length > 0, 'the environment ran nothing at all');
    // ...and not one of them named the local folder.
    for (const call of calls) {
      assert.ok(!call.cwd.includes(neverUsed), `a command escaped to the local path: ${call.cwd}`);
    }
    // Both agents were pointed at the environment, never at the workspace row.
    assert.ok(seen.length >= 3, 'the loop did not reach a second delegation');
    for (const workingDirectory of seen) assert.equal(workingDirectory, remotePath);

    // The evidence and the verification are real, collected through the boundary.
    assert.ok(calls.some((c) => c.args?.[0] === 'rev-parse'), 'no baseline was taken');
    assert.ok(calls.some((c) => (c.args ?? []).includes('check.mjs')), 'the verification did not run');
    const verifications = fixture.services.database.runs.verifications(sent.run.id);
    assert.ok(verifications.length >= 1);

    assert.equal(released, 1, 'the environment must be released exactly once');
  } finally {
    await fixture.cleanup();
    repo.cleanup();
    rmSync(neverUsed, { recursive: true, force: true });
  }
});

test('local mode is unchanged: no environment factory means this computer', async () => {
  const repo = scratchRepository();
  const seen: string[] = [];
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', [
    (input: AgentInput) => {
      seen.push(input.workingDirectory);
      return delegate('Crie hello.txt');
    },
    (input: AgentInput) => {
      seen.push(input.workingDirectory);
      return done();
    },
  ]);
  const worker = new ScriptedAgent('mock-claude', 'Claude', [
    (input: AgentInput) => {
      seen.push(input.workingDirectory);
      writeFileSync(join(input.workingDirectory, 'hello.txt'), `${EXPECTED}\n`, 'utf8');
      return 'ok';
    },
  ]);

  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    maxIterations: 4,
  });
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.create', { name: 'Local', localPath: repo.dir }),
    );
    fixture.services.database.verifications.upsert({
      workspaceId: workspace.id,
      id: 'hello-exists',
      label: 'hello.txt tem o conteúdo exato',
      command: 'node check.mjs',
    });
    await bindTeam(fixture, workspace.id);
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'c' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'crie' }),
    );
    const run = await fixture.services.orchestration.waitFor(sent.run.id);
    assert.equal(run.status, 'DONE', run.summary ?? '');
    // The workspace folder is still what the agents are handed locally.
    for (const workingDirectory of seen) assert.equal(workingDirectory, repo.dir);
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});
