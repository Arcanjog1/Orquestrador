/**
 * The orchestration loop, end to end, against a real git repository.
 *
 * Fake agents, real everything else: real `git` for the evidence, a real child
 * process for the verification, the real DONE gate. These tests exist to prove
 * the product is not a prompt-and-reply toy — that it executes, verifies,
 * corrects and only then finishes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitFixture, type GitFixture } from './helpers/git-fixture.js';
import { createDesktopFixture, HangingAgent, ScriptedAgent } from './helpers/desktop-fixture.js';
import type { DesktopFixture } from './helpers/desktop-fixture.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';
import type { AgentInput } from '../src/core/types.js';

const EXPECTED = 'Olá AI Orchestrator';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

/**
 * A workspace that is a real git repository and carries one registered
 * verification: a script that passes only when hello.txt has the exact content.
 */
function scratchRepository(): GitFixture {
  const repo = createGitFixture('lao-orchestration-');
  repo.write('README.md', '# scratch\n');
  repo.write(
    'check.mjs',
    [
      "import { readFileSync } from 'node:fs';",
      'let actual = null;',
      "try { actual = readFileSync('hello.txt', 'utf8').trim(); } catch { actual = null; }",
      `const expected = ${JSON.stringify(EXPECTED)};`,
      'if (actual !== expected) {',
      "  console.error('hello.txt is ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));",
      '  process.exit(1);',
      '}',
      "console.log('ok');",
    ].join('\n'),
  );
  repo.commitAll('baseline');
  return repo;
}

interface Prepared {
  fixture: DesktopFixture;
  repo: GitFixture;
  sessionId: string;
  cleanup(): Promise<void>;
}

async function prepare(options: {
  orchestratorScript: ReadonlyArray<string | ((input: AgentInput) => string)>;
  workerScript?: ReadonlyArray<string | ((input: AgentInput) => string)>;
  workerAgent?: HangingAgent;
  maxIterations?: number;
}): Promise<Prepared & { orchestrator: ScriptedAgent; worker: ScriptedAgent | HangingAgent }> {
  const repo = scratchRepository();
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', options.orchestratorScript);
  const worker: ScriptedAgent | HangingAgent =
    options.workerAgent ?? new ScriptedAgent('mock-claude', 'Claude', options.workerScript ?? ['']);

  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
  });

  const workspace = value<{ id: string }>(
    await fixture.router.handle('workspace.create', { name: 'Scratch', localPath: repo.dir }),
  );
  fixture.services.database.verifications.upsert({
    id: 'hello-exists',
    workspaceId: workspace.id,
    label: 'hello.txt tem o conteúdo exato',
    command: 'node check.mjs',
  });

  value(await fixture.router.handle('accounts.create', { name: 'Claude Trabalho', provider: 'anthropic' }));
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
    async cleanup() {
      await fixture.cleanup();
      repo.cleanup();
    },
  };
}

const delegate = (task: string): string =>
  JSON.stringify({
    action: 'delegate',
    task,
    acceptanceCriteria: ['hello.txt existe com o conteúdo exato'],
    verificationCommands: ['hello-exists'],
    summary: 'Vou pedir a criação do arquivo.',
  });

const done = (): string =>
  JSON.stringify({
    action: 'done',
    acceptanceCriteria: [],
    verificationCommands: ['hello-exists'],
    summary: 'Tudo pronto.',
  });

/* ------------------------------------------------------------------------ */

test('the first controlled task: Codex delegates, Claude creates, the gate approves', async () => {
  const prepared = await prepare({
    orchestratorScript: [delegate('Crie hello.txt'), done()],
    workerScript: [
      (input: AgentInput) => {
        writeFileSync(join(input.workingDirectory, 'hello.txt'), `${EXPECTED}\n`, 'utf8');
        return 'arquivo criado';
      },
    ],
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

    // Evidence was collected by the program, from git, not claimed by the agent.
    const steps = prepared.fixture.services.database.runs.steps(sent.run.id);
    const evidence = steps.filter((s) => s.phase === 'evidence');
    assert.ok(evidence.length > 0);
    assert.equal(evidence.at(-1)!.status, 'changed');

    // The verification really ran, and the gate re-ran it before approving.
    const verifications = prepared.fixture.services.database.runs.verifications(sent.run.id);
    assert.ok(verifications.length >= 1);
    assert.equal((verifications[0] as { passed: number }).passed, 1);
    assert.equal(steps.find((s) => s.phase === 'done-gate')?.status, 'passed');

    const messages = value<Array<{ author: string; text: string }>>(
      await prepared.fixture.router.handle('chat.listMessages', { sessionId: prepared.sessionId }),
    );
    assert.ok(messages.some((m) => /concluída/i.test(m.text)), 'the chat says the task is done');
  } finally {
    await prepared.cleanup();
  }
});

test('a wrong result is caught by verification and corrected on the next pass', async () => {
  let attempt = 0;
  const prepared = await prepare({
    orchestratorScript: [
      delegate('Crie hello.txt'),
      delegate('Corrija o conteúdo de hello.txt'),
      done(),
    ],
    workerScript: [
      (input: AgentInput) => {
        attempt += 1;
        // First attempt gets it wrong; the correction gets it right.
        const contents = attempt === 1 ? 'Ola AI Orchestrator (errado)' : EXPECTED;
        writeFileSync(join(input.workingDirectory, 'hello.txt'), `${contents}\n`, 'utf8');
        return 'feito';
      },
    ],
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
    assert.equal(attempt, 2, 'the worker had to be sent back once');

    const verifications = prepared.fixture.services.database.runs.verifications(sent.run.id) as Array<{
      passed: number;
      iteration: number;
    }>;
    assert.equal(verifications[0]!.passed, 0, 'the first verification failed');
    assert.ok(
      verifications.some((v) => v.passed === 1),
      'a later verification passed',
    );

    // The failure was fed back to the orchestrator verbatim, not summarised away.
    const secondPrompt = prepared.orchestrator.calls[1]!.prompt;
    assert.match(secondPrompt, /VERIFICATION RESULTS/);
    assert.match(secondPrompt, /FAIL \(exit 1\)/);
    assert.equal(readFileSync(join(prepared.repo.dir, 'hello.txt'), 'utf8').trim(), EXPECTED);
  } finally {
    await prepared.cleanup();
  }
});

test('DONE is refused when nothing changed, however confidently it is claimed', async () => {
  const prepared = await prepare({
    orchestratorScript: [done(), JSON.stringify({ action: 'blocked', reason: 'desisto' })],
    maxIterations: 2,
  });

  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Diga que está pronto sem fazer nada',
      }),
    );
    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    assert.notEqual(run.status, 'DONE');
    const steps = prepared.fixture.services.database.runs.steps(sent.run.id);
    const gate = steps.find((s) => s.phase === 'done-gate');
    assert.equal(gate?.status, 'rejected');
    assert.match(gate!.summary ?? '', /No file changed|Verification command/);

    // The rejection, in full, is what the orchestrator saw next.
    assert.match(prepared.orchestrator.calls[1]!.prompt, /DONE_REJECTED/);
  } finally {
    await prepared.cleanup();
  }
});

test('a verification id nobody registered is refused, never executed', async () => {
  const prepared = await prepare({
    orchestratorScript: [
      JSON.stringify({
        action: 'verify',
        acceptanceCriteria: [],
        verificationCommands: ['rm -rf /', 'hello-exists'],
      }),
      JSON.stringify({ action: 'blocked', reason: 'parei' }),
    ],
    maxIterations: 2,
  });

  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'verifique',
      }),
    );
    await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    const commands = (
      prepared.fixture.services.database.runs.verifications(sent.run.id) as Array<{ command: string }>
    ).map((row) => row.command);
    assert.deepEqual(commands, ['node check.mjs'], 'only the registered command ran');

    const feedback = prepared.orchestrator.calls[1]!.prompt;
    assert.match(feedback, /REFUSED/);
    assert.match(feedback, /rm -rf \//);
  } finally {
    await prepared.cleanup();
  }
});

test('a run can be cancelled, and the agents are told to stop', async () => {
  const hanging = new HangingAgent();
  const prepared = await prepare({
    orchestratorScript: [delegate('trabalhe para sempre')],
    workerAgent: hanging,
  });

  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'comece algo longo',
      }),
    );

    // Wait until the worker is genuinely mid-task before cancelling.
    const deadline = Date.now() + 5_000;
    while (hanging.started === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(hanging.started, 1);

    const cancelled = value<{ cancelled: boolean }>(
      await prepared.fixture.router.handle('run.cancel', { runId: sent.run.id }),
    );
    assert.equal(cancelled.cancelled, true);

    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id, 20_000);
    assert.equal(run.status, 'CANCELLED');
    assert.equal(hanging.cancelled, 1, 'the worker was asked to stop, not just abandoned');
  } finally {
    await prepared.cleanup();
  }
});

test('the interface is fed live progress, in words a person can read', async () => {
  const prepared = await prepare({
    orchestratorScript: [delegate('Crie hello.txt'), done()],
    workerScript: [
      (input: AgentInput) => {
        writeFileSync(join(input.workingDirectory, 'hello.txt'), `${EXPECTED}\n`, 'utf8');
        return 'ok';
      },
    ],
  });

  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Crie hello.txt',
      }),
    );
    await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    const labels = prepared.fixture.events
      .filter((e) => e.channel === 'run:progress')
      .map((e) => (e.payload as { label: string }).label);

    for (const expected of [
      'Analisando...',
      'Codex preparando a tarefa...',
      'Claude executando...',
      'Coletando alterações...',
      'Executando verificações...',
      'Codex revisando...',
      'Tarefa concluída.',
    ]) {
      assert.ok(labels.includes(expected), `missing progress label: ${expected}`);
    }
  } finally {
    await prepared.cleanup();
  }
});

test('an unparsable answer is asked to fix its format once, then the run fails cleanly', async () => {
  const prepared = await prepare({
    orchestratorScript: ['isto não é JSON', 'ainda não é JSON'],
    maxIterations: 1,
  });

  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'faça algo',
      }),
    );
    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    assert.equal(run.status, 'FAILED');
    assert.equal(prepared.orchestrator.calls.length, 2, 'exactly one repair attempt');
    assert.match(prepared.orchestrator.calls[1]!.prompt, /JSON/);
  } finally {
    await prepared.cleanup();
  }
});

test('a run refuses to start when a runtime or account is not ready, instead of hanging', async () => {
  // Measured, not imagined: an unauthenticated Codex prints "Reading prompt
  // from stdin..." and waits. Without this check the interface would show
  // "Codex preparando a tarefa..." until the agent timeout.
  //
  // No `createRunners` override here on purpose: supplying one means supplying
  // your own agents, which switches the readiness check off. This exercises the
  // real one, against a throwaway app root where no runtime is installed.
  const repo = scratchRepository();
  const fixture = createDesktopFixture();

  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.create', { name: 'Scratch', localPath: repo.dir }),
    );
    value(
      await fixture.router.handle('accounts.create', { name: 'Claude', provider: 'anthropic' }),
    );
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

    const started = Date.now();
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'faça algo' }),
    );
    const run = await fixture.services.orchestration.waitFor(sent.run.id, 20_000);

    assert.equal(run.status, 'FAILED');
    assert.ok(Date.now() - started < 15_000, 'it must give up quickly, not wait for a timeout');

    const messages = value<Array<{ author: string; text: string }>>(
      await fixture.router.handle('chat.listMessages', { sessionId: session.id }),
    );
    const explanation = messages.find((m) => m.author === 'system');
    assert.ok(explanation, 'the chat must say why nothing happened');
    assert.match(explanation!.text, /não está configurado|Conecte a conta/i);

    // And nothing was ever asked of an agent.
    assert.equal(fixture.services.database.runs.invocations(sent.run.id).length, 0);
    const steps = fixture.services.database.runs.steps(sent.run.id);
    assert.equal(steps.at(-1)?.phase, 'readiness');
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});
