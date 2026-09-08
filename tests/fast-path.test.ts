/**
 * The short path for a small, finished task — and the four things that must
 * stay true while it exists.
 *
 * The complaint was that creating a six-byte file took too long. Measuring it
 * (see `docs/SMALL_TASK_COST.md`) found the run cost three CLI invocations —
 * plan, work, review — and ran the verification command three times. The third
 * invocation asked a model to agree with something the *application* had
 * already proved for itself: it collected the evidence and it ran the checks.
 *
 * So the loop now goes straight to the DoneGate when its own evidence and its
 * own verifications settle every acceptance criterion of the delegation. These
 * tests exist to make sure that shortcut never becomes a way to pass:
 *
 *  1. it really is shorter — one iteration, two invocations, two check runs;
 *  2. the DoneGate still runs, still independently, still re-running commands;
 *  3. a gate rejection continues the run instead of ending it;
 *  4. it never fires on a failed verification, an unchanged tree, or a
 *     criterion the application did not settle itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitFixture, type GitFixture } from './helpers/git-fixture.js';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import type { DesktopFixture } from './helpers/desktop-fixture.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';
import type { AgentInput } from '../src/core/types.js';

const EXPECTED = 'Olá AI Orchestrator';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

/**
 * A repository whose verification records every execution of itself.
 *
 * Counting the runs is the point: "the check ran three times for one file" is
 * a claim, and a claim about a command is only worth what the command itself
 * says about it.
 */
function repositoryCountingChecks(): { repo: GitFixture; runs: () => number } {
  const repo = createGitFixture('lao-fast-path-');
  repo.write('README.md', '# scratch\n');
  const log = join(repo.dir, '.check-runs');
  repo.write(
    'check.mjs',
    [
      "import { readFileSync, appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(log)}, 'x');`,
      'let actual = null;',
      "try { actual = readFileSync('hello.txt', 'utf8').trim(); } catch { actual = null; }",
      `const expected = ${JSON.stringify(EXPECTED)};`,
      'if (actual !== expected) {',
      "  console.error('hello.txt is ' + JSON.stringify(actual));",
      '  process.exit(1);',
      '}',
      "console.log('ok');",
    ].join('\n'),
  );
  repo.commitAll('baseline');
  return {
    repo,
    // The log lives inside the repository but is written only while a check
    // runs, so it is never part of the baseline commit.
    runs: () => (existsSync(log) ? readFileSync(log, 'utf8').length : 0),
  };
}

interface Prepared {
  fixture: DesktopFixture;
  repo: GitFixture;
  sessionId: string;
  orchestrator: ScriptedAgent;
  worker: ScriptedAgent;
  checkRuns: () => number;
  cleanup(): Promise<void>;
}

async function prepare(options: {
  orchestratorScript: ReadonlyArray<string | ((input: AgentInput) => string)>;
  workerScript: ReadonlyArray<string | ((input: AgentInput) => string)>;
  fastPath?: boolean;
  maxIterations?: number;
}): Promise<Prepared> {
  const { repo, runs } = repositoryCountingChecks();
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', options.orchestratorScript);
  const worker = new ScriptedAgent('mock-claude', 'Claude', options.workerScript);

  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    ...(options.fastPath !== undefined ? { fastPath: options.fastPath } : {}),
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
  });

  const workspace = value<{ id: string }>(
    await fixture.router.handle('workspace.create', { name: 'Scratch', localPath: repo.dir }),
  );
  fixture.services.database.verifications.upsert({
    workspaceId: workspace.id,
    id: 'hello-exists',
    label: 'hello.txt tem o conteúdo exato',
    command: 'node check.mjs',
  });
  value(await fixture.router.handle('accounts.create', { name: 'Claude', provider: 'anthropic' }));
  const agents = value<Array<{ id: string; role: string }>>(
    await fixture.router.handle('agents.list', null),
  );
  value(
    await fixture.router.handle('workspace.setAgents', {
      workspaceId: workspace.id,
      orchestratorAgentId: agents.find((a) => a.role === 'ORCHESTRATOR')!.id,
      workerAgentId: agents.find((a) => a.role === 'CODING_WORKER')!.id,
    }),
  );
  const session = value<{ id: string }>(
    await fixture.router.handle('chat.createSession', {
      workspaceId: workspace.id,
      title: 'Conversa',
    }),
  );

  return {
    fixture,
    repo,
    orchestrator,
    worker,
    sessionId: session.id,
    checkRuns: runs,
    async cleanup() {
      await fixture.cleanup();
      repo.cleanup();
    },
  };
}

const delegate = JSON.stringify({
  action: 'delegate',
  task: 'Crie hello.txt',
  acceptanceCriteria: ['hello.txt existe com o conteúdo exato'],
  verificationCommands: ['hello-exists'],
  summary: 'Vou pedir a criação do arquivo.',
});

const done = JSON.stringify({
  action: 'done',
  acceptanceCriteria: [],
  verificationCommands: ['hello-exists'],
  summary: 'Tudo pronto.',
});

const writesTheFile = (input: AgentInput): string => {
  writeFileSync(join(input.workingDirectory, 'hello.txt'), `${EXPECTED}\n`, 'utf8');
  return 'arquivo criado';
};

/* ------------------------------------------------------------------------ */

test('the six-byte task costs one orchestrator turn, not two', async () => {
  const prepared = await prepare({
    orchestratorScript: [delegate, done],
    workerScript: [writesTheFile],
  });
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: `Crie hello.txt contendo exatamente: ${EXPECTED}`,
      }),
    );
    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    assert.equal(run.status, 'DONE');
    assert.equal(readFileSync(join(prepared.repo.dir, 'hello.txt'), 'utf8').trim(), EXPECTED);
    assert.equal(run.iterations, 1, 'one iteration, not two');

    // The measurement, as counts rather than as a feeling. Before the short
    // path this was 2 orchestrator turns and 3 executions of the command.
    assert.equal(prepared.orchestrator.calls.length, 1, 'one orchestrator invocation');
    assert.equal(prepared.worker.calls.length, 1, 'one worker invocation');
    assert.equal(prepared.checkRuns(), 2, 'the loop ran the check once; the gate re-ran it once');

    // The second scripted answer was never needed - which is the saving.
    assert.equal(prepared.orchestrator.calls[1], undefined);
  } finally {
    await prepared.cleanup();
  }
});

test('the DoneGate still decides, and still re-runs the verification itself', async () => {
  const prepared = await prepare({
    orchestratorScript: [delegate, done],
    workerScript: [writesTheFile],
  });
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Crie hello.txt',
      }),
    );
    await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    const steps = prepared.fixture.services.database.runs.steps(sent.run.id);
    const gate = steps.filter((s) => s.phase === 'done-gate');
    assert.equal(gate.length, 1, 'the gate ran');
    assert.equal(gate[0]!.status, 'passed');

    // Two executions of one command: the loop's, and the gate's own. The
    // gate re-running from scratch is what makes it independent, and the
    // short path must not have quietly turned that into a cached result.
    assert.equal(prepared.checkRuns(), 2);
  } finally {
    await prepared.cleanup();
  }
});

test('a gate rejection continues the run instead of ending it', async () => {
  // The worker writes the wrong thing, so the verification fails and the
  // criterion is never settled: the short path must not fire at all, and the
  // run must go round again with the failure as feedback.
  let attempt = 0;
  const prepared = await prepare({
    orchestratorScript: [delegate, delegate, done],
    workerScript: [
      (input: AgentInput) => {
        attempt += 1;
        writeFileSync(
          join(input.workingDirectory, 'hello.txt'),
          attempt === 1 ? 'errado\n' : `${EXPECTED}\n`,
          'utf8',
        );
        return 'escrevi';
      },
    ],
    maxIterations: 3,
  });
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Crie hello.txt',
      }),
    );
    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    assert.equal(run.status, 'DONE');
    assert.equal(readFileSync(join(prepared.repo.dir, 'hello.txt'), 'utf8').trim(), EXPECTED);
    // Two iterations: the first could not take the short path because its
    // verification failed, so the orchestrator was asked again - exactly the
    // behaviour the long path has.
    assert.equal(run.iterations, 2);
    assert.equal(prepared.orchestrator.calls.length, 2);
  } finally {
    await prepared.cleanup();
  }
});

test('a delegation that changes nothing never takes the short path', async () => {
  const prepared = await prepare({
    // The worker reports success and writes nothing at all.
    orchestratorScript: [delegate, JSON.stringify({ action: 'blocked', reason: 'desisto' })],
    workerScript: [() => 'não fiz nada, mas digo que fiz'],
    maxIterations: 2,
  });
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Crie hello.txt',
      }),
    );
    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    // Not DONE, and the gate was never reached by the short path: with no
    // change there is nothing for evidence to show, and a worker's word is
    // not evidence.
    assert.notEqual(run.status, 'DONE');
    assert.equal(existsSync(join(prepared.repo.dir, 'hello.txt')), false);
    const steps = prepared.fixture.services.database.runs.steps(sent.run.id);
    assert.equal(steps.filter((s) => s.phase === 'done-gate').length, 0);
    // The orchestrator was asked a second time, as it would have been before.
    assert.equal(prepared.orchestrator.calls.length, 2);
  } finally {
    await prepared.cleanup();
  }
});

test('a delegation with no verification of its own never takes the short path', async () => {
  const noChecks = JSON.stringify({
    action: 'delegate',
    task: 'Crie hello.txt',
    acceptanceCriteria: ['hello.txt existe'],
    // Nothing to run: the application has no way to settle the criterion
    // itself, so there is nothing to be shorter than the orchestrator's word.
    verificationCommands: [],
    summary: 'Vou pedir a criação do arquivo.',
  });
  const prepared = await prepare({
    orchestratorScript: [noChecks, done],
    workerScript: [writesTheFile],
    maxIterations: 2,
  });
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Crie hello.txt',
      }),
    );
    await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    // Two orchestrator turns: the long path, because the short one was not
    // available. Whether this particular run then passes the gate is the long
    // path's business - and here it does not, because a criterion the
    // application was given no way to check is a criterion it will not
    // certify. What matters for *this* test is that no shortcut was taken.
    assert.equal(prepared.orchestrator.calls.length, 2);
    const steps = prepared.fixture.services.database.runs.steps(sent.run.id);
    const gates = steps.filter((s) => s.phase === 'done-gate');
    assert.equal(gates.length, 1, 'the gate ran once, on the orchestrator’s own `done`');
    assert.equal(gates[0]!.iteration, 2, 'and in the second iteration, not the first');
    assert.equal(/caminho rápido/.test(gates[0]!.summary ?? ''), false);
  } finally {
    await prepared.cleanup();
  }
});

test('every phase of a run is timed, and the timings add up to the run', async () => {
  const prepared = await prepare({
    orchestratorScript: [delegate, done],
    workerScript: [writesTheFile],
  });
  try {
    const startedAt = Date.now();
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Crie hello.txt',
      }),
    );
    await prepared.fixture.services.orchestration.waitFor(sent.run.id);
    const wallClock = Date.now() - startedAt;

    const steps = prepared.fixture.services.database.runs.steps(sent.run.id);
    const phases = steps.map((s) => s.phase);

    // The two segments that used to be invisible: getting the environment and
    // the runners ready, and probing what each worker's CLI can take. Both are
    // real time, and neither could be shortened while nothing measured them.
    assert.ok(phases.includes('startup'), 'the startup segment is measured');
    assert.ok(phases.includes('capabilities'), 'the capability probe is measured');

    const measured = steps.reduce((total, step) => total + (step.duration_ms ?? 0), 0);
    assert.ok(
      steps.every((s) => s.duration_ms === null || s.duration_ms >= 0),
      'no negative duration',
    );
    assert.ok(measured > 0, 'something was measured');
    assert.ok(
      measured <= wallClock,
      `the measured segments (${measured}ms) fit inside the run (${wallClock}ms)`,
    );
  } finally {
    await prepared.cleanup();
  }
});
