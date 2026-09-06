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
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppServices } from '../apps/desktop/src/main/services/app-services.js';
import { createGitFixture, type GitFixture } from './helpers/git-fixture.js';
import { createDesktopFixture, HangingAgent, ScriptedAgent } from './helpers/desktop-fixture.js';
import { loadTwoStageCheck } from './helpers/two-stage-check.js';
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
  /** The workspace to use instead of the default scratch repository. */
  repository?: () => GitFixture;
  /** The verification to register instead of the default in-workspace check. */
  verification?: { id: string; label: string; command: string };
}): Promise<Prepared & { orchestrator: ScriptedAgent; worker: ScriptedAgent | HangingAgent }> {
  const repo = options.repository ? options.repository() : scratchRepository();
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
    workspaceId: workspace.id,
    ...(options.verification ?? {
      id: 'hello-exists',
      label: 'hello.txt tem o conteúdo exato',
      command: 'node check.mjs',
    }),
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

    // The repair is a *new* CLI process with no memory of the first: it must
    // be given the objective again, and shown what it answered before.
    const repair = prepared.orchestrator.calls[1]!.prompt;
    assert.match(repair, /OBJECTIVE: faça algo/, 'the repair carries the original prompt');
    assert.match(repair, /isto não é JSON/, 'and the answer that was refused');

    // The failure says what happened, not a sentence that fits everything.
    assert.equal(run.failureKind, 'decision');
    assert.match(run.summary ?? '', /respondeu duas vezes, mas não com uma decisão válida/);
    assert.match(run.summary ?? '', /No JSON object/);
    assert.match(run.summary ?? '', /ainda não é JSON/, 'the excerpt shows what came back');

    // And "Detalhes" has the diagnostics of every attempt.
    const detail = value<{
      steps: Array<{ phase: string; status: string; detail: string | null }>;
    }>(await prepared.fixture.router.handle('run.detail', { runId: sent.run.id }));
    const attempts = detail.steps.filter((s) => s.phase === 'orchestrator' && s.status === 'unparsed');
    assert.equal(attempts.length, 2);
    for (const [index, attempt] of attempts.entries()) {
      const parsed = JSON.parse(attempt.detail!) as Record<string, unknown>;
      assert.equal(parsed.attempt, index + 1);
      assert.equal(parsed.outcome, 'completed');
      assert.equal(typeof parsed.parseError, 'string');
      assert.equal(typeof parsed.stdoutExcerpt, 'string');
    }
    assert.equal(detail.steps.at(-1)?.status, 'gave-up');
  } finally {
    await prepared.cleanup();
  }
});

test('a CLI that exits without answering is reported as that, with its own words', async () => {
  const prepared = await prepare({
    orchestratorScript: [],
    maxIterations: 1,
  });
  // An orchestrator whose process gives up: it exits with code 1, an error on
  // stderr, and a header that must never reach the person. That is what a
  // usage limit or an expired login looks like from outside the CLI.
  prepared.orchestrator.run = async () => ({
    outcome: 'completed',
    exitCode: 1,
    signal: null,
    stdout: '',
    stderr: 'Error: usage limit reached for this account\nAuthorization: Bearer abcdefghijklmnop123456\n',
    durationMs: 5,
    truncated: false,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
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
    assert.equal(run.failureKind, 'decision');
    assert.match(run.summary ?? '', /saiu com código 1: Error: usage limit reached/);
    const messages = value<Array<{ author: string; text: string }>>(
      await prepared.fixture.router.handle('chat.listMessages', { sessionId: prepared.sessionId }),
    );
    assert.ok(messages.some((m) => m.author === 'system' && /usage limit reached/.test(m.text)));
    const detail = value<{ steps: Array<{ detail: string | null }> }>(
      await prepared.fixture.router.handle('run.detail', { runId: sent.run.id }),
    );
    const everything = JSON.stringify(detail);
    assert.doesNotMatch(everything, /abcdefghijklmnop123456/, 'the header value is redacted everywhere');
    assert.match(everything, /usage limit reached/);
  } finally {
    await prepared.cleanup();
  }
});

test('a follow-up message in the same conversation is read against what came before', async () => {
  const prepared = await prepare({
    orchestratorScript: [done(), done()],
    maxIterations: 1,
  });
  try {
    const first = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Crie hello.txt com o conteúdo combinado',
      }),
    );
    await prepared.fixture.services.orchestration.waitFor(first.run.id);
    const second = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Continue de onde parou.',
      }),
    );
    await prepared.fixture.services.orchestration.waitFor(second.run.id);

    const prompts = prepared.orchestrator.calls.map((c) => c.prompt);
    assert.doesNotMatch(prompts[0]!, /CONVERSATION BEFORE/, 'the first run has no history');
    assert.match(prompts[1]!, /OBJECTIVE: Continue de onde parou\./);
    assert.match(prompts[1]!, /CONVERSATION BEFORE THIS OBJECTIVE/);
    assert.match(prompts[1]!, /USER: Crie hello\.txt com o conteúdo combinado/);
  } finally {
    await prepared.cleanup();
  }
});

test('a run left RUNNING by a closed application is marked interrupted on the next start', async () => {
  const prepared = await prepare({ orchestratorScript: [done()], maxIterations: 1 });
  try {
    const { database } = prepared.fixture.services;
    const session = database.chat.requireSession(prepared.sessionId);
    const run = database.runs.create({
      id: 'run-left-behind',
      sessionId: session.id,
      workspaceId: session.workspace_id,
      objective: 'algo que estava no meio',
      orchestratorAgentId: null,
      maxIterations: 3,
    });
    database.runs.setStatus(run.id, 'RUNNING');
    database.runs.setIteration(run.id, 2);
    await prepared.fixture.services.shutdown();

    const reopened = new AppServices({ paths: prepared.fixture.paths, openUrl: () => {} });
    try {
      const view = reopened.orchestration.view(run.id);
      assert.equal(view.status, 'FAILED');
      assert.equal(view.failureKind, 'interrupted');
      assert.equal(view.iterations, 2, 'the loop counter, not the number of steps');
      assert.match(view.summary ?? '', /o aplicativo foi fechado/);
      const note = database.chat; // closed; read through the reopened graph instead
      void note;
      const messages = reopened.chat.listMessages(session.id);
      assert.ok(messages.some((m) => m.author === 'system' && /fechado durante a execução/.test(m.text)));
      assert.equal(reopened.orchestration.listForWorkspace(session.workspace_id).length, 1);
    } finally {
      await reopened.shutdown();
    }
  } finally {
    prepared.cleanup().catch(() => undefined);
  }
});

test('a run waiting at the human gate can be closed by the person, and stays closed', async () => {
  const prepared = await prepare({
    orchestratorScript: [
      JSON.stringify({ action: 'blocked', reason: 'Preciso saber a senha do banco.', acceptanceCriteria: [], verificationCommands: [] }),
    ],
  });
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'migre o banco',
      }),
    );
    const blocked = await prepared.fixture.services.orchestration.waitFor(sent.run.id);
    assert.equal(blocked.status, 'BLOCKED');

    const dismissed = value<{ cancelled: boolean }>(
      await prepared.fixture.router.handle('run.cancel', { runId: sent.run.id }),
    );
    assert.equal(dismissed.cancelled, true);
    const after = value<{ status: string; summary: string | null }>(
      await prepared.fixture.router.handle('run.get', { runId: sent.run.id }),
    );
    assert.equal(after.status, 'CANCELLED');
    assert.match(after.summary ?? '', /revisão humana/);
    // A second cancel finds nothing open.
    assert.equal(
      value<{ cancelled: boolean }>(
        await prepared.fixture.router.handle('run.cancel', { runId: sent.run.id }),
      ).cancelled,
      false,
    );
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
    const codex = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Codex', provider: 'openai' }),
    );
    const claude = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Claude', provider: 'anthropic' }),
    );
    value(
      await fixture.router.handle('workspace.setTeam', {
        workspaceId: workspace.id,
        orchestrator: { accountId: codex.id },
        worker: { accountId: claude.id },
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

/* ------------------------------------------------------------------------ *
 * The autonomous loop.
 *
 * The test above proves the worker is sent back a second time, but its
 * orchestrator answers from a fixed script: the corrective instruction was
 * written by the test, not derived by the orchestrator. This one closes that
 * gap. Its orchestrator has no script for the second turn - it reads the
 * feedback the loop handed it and composes the next instruction from what the
 * verification actually reported.
 *
 * That is the claim being tested: a second prompt reaches the worker, carrying
 * information that existed nowhere until the first attempt failed, with no
 * second message from the user.
 * ------------------------------------------------------------------------ */

/** The wrong content the first attempt writes. Nothing else in the run knows it. */
const WRONG = 'Ola AI Orchestrator (sem acento)';

test('the loop composes the second worker prompt from its own review of the first', async () => {
  const orchestratorPrompts: string[] = [];

  const prepared = await prepare({
    // No fixed second instruction: each answer is computed from what arrived.
    orchestratorScript: [
      (input: AgentInput) => {
        orchestratorPrompts.push(input.prompt);
        assert.doesNotMatch(
          input.prompt,
          /RESULT OF THE PREVIOUS ITERATION/,
          'the first turn has no previous result to review',
        );
        return delegate('Crie hello.txt com o conteúdo combinado');
      },
      (input: AgentInput) => {
        orchestratorPrompts.push(input.prompt);
        // The loop must have handed over the failure before this runs.
        assert.match(input.prompt, /RESULT OF THE PREVIOUS ITERATION/);
        assert.match(input.prompt, /VERIFICATION RESULTS/);
        assert.match(input.prompt, /FAIL \(exit 1\)/);

        // Read what the verification actually observed, and correct *that*.
        // The value is only knowable from the first attempt's failure.
        const observed = /hello\.txt is "([^"]*)"/.exec(input.prompt)?.[1];
        assert.equal(observed, WRONG, 'the real observed value reached the orchestrator');

        return delegate(
          `A tentativa anterior gravou ${JSON.stringify(observed)}. ` +
            `Corrija hello.txt para conter exatamente ${JSON.stringify(EXPECTED)}.`,
        );
      },
      (input: AgentInput) => {
        orchestratorPrompts.push(input.prompt);
        assert.match(input.prompt, /PASS: node check\.mjs/, 'the passing run was reported back');
        return done();
      },
    ],
    workerScript: [
      // The worker obeys its instruction rather than a counter: the first says
      // nothing about content, the second carries the exact string to write.
      (input: AgentInput) => {
        const wanted = /exatamente "([^"]*)"/.exec(input.prompt)?.[1];
        writeFileSync(
          join(input.workingDirectory, 'hello.txt'),
          `${wanted ?? WRONG}\n`,
          'utf8',
        );
        return wanted ? 'corrigido' : 'criado';
      },
    ],
  });

  try {
    // One message from the user. Nothing else is sent for the rest of the run.
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Crie hello.txt com o texto combinado',
      }),
    );
    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    // -- the worker really was invoked twice, as the database recorded it ----
    const invocations = prepared.fixture.services.database.runs.invocations(sent.run.id) as Array<{
      role: string;
      iteration: number;
      outcome: string;
    }>;
    const workerInvocations = invocations.filter((i) => i.role === 'CODING_WORKER');
    assert.equal(workerInvocations.length, 2, 'the worker ran twice');
    assert.deepEqual(
      workerInvocations.map((i) => i.iteration),
      [1, 2],
      'the second turn is a real second iteration, not a retry of the first',
    );

    // -- and the second prompt was composed, not scripted --------------------
    const worker = prepared.worker as ScriptedAgent;
    assert.equal(worker.calls.length, 2);
    const firstWorkerPrompt = worker.calls[0]!.prompt;
    const secondWorkerPrompt = worker.calls[1]!.prompt;

    assert.notEqual(secondWorkerPrompt, firstWorkerPrompt);
    assert.doesNotMatch(firstWorkerPrompt, /tentativa anterior/);
    // The wrong value existed nowhere before the first attempt ran, so its
    // presence here is the proof that the chain closed by itself:
    // worker result -> evidence -> verification -> orchestrator -> worker.
    assert.match(secondWorkerPrompt, /A tentativa anterior gravou/);
    assert.ok(
      secondWorkerPrompt.includes(WRONG),
      'the second instruction carries what the verification observed',
    );
    assert.ok(
      secondWorkerPrompt.includes(EXPECTED),
      'the second instruction says what to write instead',
    );

    // -- the user sent one message; the loop produced the rest ---------------
    const messages = prepared.fixture.services.database.chat.listMessages(prepared.sessionId) as Array<{
      author: string;
    }>;
    assert.equal(
      messages.filter((m) => m.author === 'user').length,
      1,
      'no second message from the user',
    );

    // -- and only then did the gate let it finish ----------------------------
    assert.equal(orchestratorPrompts.length, 3, 'three orchestrator turns: delegate, review, done');
    assert.equal(run.status, 'DONE');
    assert.equal(readFileSync(join(prepared.repo.dir, 'hello.txt'), 'utf8').trim(), EXPECTED);
  } finally {
    await prepared.cleanup();
  }
});

/**
 * The human gate.
 *
 * A run that stops for a person is not a failure, and the difference has to
 * survive the trip to the interface: the status the loop sets is the status
 * `run.get` reports, so the timeline can draw the review card instead of an
 * error. Ordinary failures - a failing test, a wrong implementation - must not
 * come here; those go round the loop again, which the test above covers.
 */
test('a run that stops for a person reports BLOCKED, distinct from a failure', async () => {
  const prepared = await prepare({
    orchestratorScript: [
      JSON.stringify({
        action: 'blocked',
        acceptanceCriteria: [],
        verificationCommands: [],
        summary: 'Preciso de uma decisão sua.',
        reason: 'O requisito permite duas interpretações incompatíveis.',
      }),
    ],
  });

  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Faça a coisa ambígua',
      }),
    );
    await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    // Read it back the way the renderer does, not out of the database.
    const view = value<{ status: string; summary: string | null }>(
      await prepared.fixture.router.handle('run.get', { runId: sent.run.id }),
    );
    assert.equal(view.status, 'BLOCKED');
    assert.notEqual(view.status, 'FAILED', 'a human gate is not a failure');
    assert.match(view.summary ?? '', /duas interpretações/);

    // And the worker was never asked to guess.
    const invocations = prepared.fixture.services.database.runs.invocations(sent.run.id) as Array<{
      role: string;
    }>;
    assert.equal(invocations.filter((i) => i.role === 'CODING_WORKER').length, 0);
  } finally {
    await prepared.cleanup();
  }
});

/* ------------------------------------------------------------------------ *
 * Persistence.
 *
 * The loop's record has to outlive the process that produced it: the
 * interface reads history after a restart, and the real-provider smoke reads
 * its evidence back from the database. The reopen test in desktop-workspace
 * covers chat messages; this one closes the database after a full
 * two-iteration run, opens the same files again through a fresh AppServices,
 * and checks that every table the loop writes to still tells the whole story -
 * including the second worker prompt, which is the artefact that proves the
 * reprompt was automatic.
 * ------------------------------------------------------------------------ */

test('a finished two-iteration run survives closing and reopening the application', async () => {
  const prepared = await prepare({
    orchestratorScript: [
      () => delegate('Crie hello.txt'),
      (input: AgentInput) => {
        const observed = /hello\.txt is "([^"]*)"/.exec(input.prompt)?.[1];
        return delegate(
          `A tentativa anterior gravou ${JSON.stringify(observed)}. ` +
            `Corrija hello.txt para conter exatamente ${JSON.stringify(EXPECTED)}.`,
        );
      },
      () => done(),
    ],
    workerScript: [
      (input: AgentInput) => {
        const wanted = /exatamente "([^"]*)"/.exec(input.prompt)?.[1];
        writeFileSync(join(input.workingDirectory, 'hello.txt'), `${wanted ?? WRONG}\n`, 'utf8');
        return wanted ? 'corrigido' : 'criado';
      },
    ],
  });

  const { fixture, repo, sessionId } = prepared;
  let reopened: AppServices | null = null;
  try {
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId, text: 'Crie hello.txt' }),
    );
    const finished = await fixture.services.orchestration.waitFor(sent.run.id);
    assert.equal(finished.status, 'DONE');

    // Close everything, then open the same data directory as a new process would.
    await fixture.services.shutdown();
    reopened = new AppServices({ paths: fixture.paths });
    const db = reopened.database;

    const run = db.runs.require(sent.run.id);
    assert.equal(run.status, 'DONE');
    assert.ok(run.iteration >= 2, `the run reached iteration ${run.iteration}`);
    assert.ok(run.finished_at, 'the finish time was persisted');

    // Steps: the loop's own trace, by iteration and phase.
    const steps = db.runs.steps(sent.run.id);
    const phasesAt = (iteration: number) =>
      steps.filter((s) => s.iteration === iteration).map((s) => s.phase);
    assert.ok(phasesAt(0).includes('baseline'));
    for (const iteration of [1, 2]) {
      for (const phase of ['orchestrator', 'worker', 'evidence', 'verification']) {
        assert.ok(phasesAt(iteration).includes(phase), `iteration ${iteration} recorded ${phase}`);
      }
    }
    assert.deepEqual(
      steps.filter((s) => s.phase === 'orchestrator').map((s) => s.summary),
      ['delegate', 'delegate', 'done'],
      'every orchestrator decision was recorded, in order',
    );
    assert.equal(steps.filter((s) => s.phase === 'done-gate').at(-1)?.status, 'passed');

    // Invocations: both agents, every turn, with the worker's prompts intact.
    const invocations = db.runs.invocations(sent.run.id) as Array<{
      role: string;
      iteration: number;
      task: string | null;
      outcome: string;
      exit_code: number | null;
      duration_ms: number | null;
    }>;
    const workers = invocations.filter((i) => i.role === 'CODING_WORKER');
    const orchestrators = invocations.filter((i) => i.role === 'ORCHESTRATOR');
    assert.equal(workers.length, 2);
    assert.equal(orchestrators.length, 3);
    assert.deepEqual(workers.map((i) => i.iteration), [1, 2]);
    assert.ok(invocations.every((i) => i.outcome === 'completed' && i.exit_code === 0));
    assert.ok(invocations.every((i) => typeof i.duration_ms === 'number'));
    // The persisted second prompt is the proof that the reprompt was automatic,
    // and it must still be there after the restart.
    assert.equal(workers[0]!.task, 'Crie hello.txt');
    assert.ok(workers[1]!.task?.includes(WRONG), 'the second prompt still carries the observed value');
    assert.ok(workers[1]!.task?.includes(EXPECTED));

    // Verifications: the failure and the pass, each on its own iteration.
    const verifications = db.runs.verifications(sent.run.id) as Array<{
      iteration: number;
      passed: number;
      exit_code: number | null;
    }>;
    assert.equal(verifications.find((v) => v.iteration === 1)?.passed, 0);
    assert.equal(verifications.find((v) => v.iteration === 1)?.exit_code, 1);
    assert.equal(verifications.find((v) => v.iteration === 2)?.passed, 1);

    // Chat: one message from the user, the rest from the loop.
    const messages = db.chat.listMessages(sessionId);
    assert.equal(messages.filter((m) => m.author === 'user').length, 1);
    assert.ok(messages.some((m) => m.author === 'orchestrator'));
    assert.ok(messages.some((m) => m.author === 'worker'));
    assert.ok(messages.every((m) => m.run_id === sent.run.id || m.author === 'user'));
  } finally {
    // The fixture's own cleanup would close a database that is already closed,
    // so the teardown is done by hand: stop the reopened services, then remove
    // both directories.
    await reopened?.shutdown();
    rmSync(fixture.paths.root, { recursive: true, force: true });
    repo.cleanup();
  }
});

/* ------------------------------------------------------------------------ *
 * A second iteration by construction.
 *
 * The reactive test above proves the reprompt closes the chain, but it makes
 * the first attempt fall short by having the worker write the wrong value.
 * A real worker would not: it writes "Olá" correctly first time, verification
 * passes, and a two-iteration proof never happens. So the real-provider smoke
 * uses a different scenario, and this test is that scenario run with fake
 * agents - the same check script, from the same source, kept outside the
 * workspace.
 *
 * The verification has two stages. The objective names only the first
 * (hello.txt). The second (bye.txt) is reported only once the first holds,
 * by a script neither agent can see: the orchestrator is shown a
 * verification's id and label, never its command, and the worker is shown
 * only the task it is given. A worker that follows every instruction to the
 * letter therefore still fails the first verification, and the only place
 * the second requirement ever appears before the second prompt is that
 * failure's output. If a second worker prompt carries it, it came through
 * verification -> feedback -> orchestrator -> decision.task, and nowhere else.
 * ------------------------------------------------------------------------ */

const SECOND_STAGE = { file: 'bye.txt', content: 'Tchau' };

test('a two-stage verification forces a second iteration from a worker that follows every instruction', async () => {
  const { writeTwoStageCheck } = await loadTwoStageCheck();
  const check = writeTwoStageCheck({ hello: EXPECTED, then: SECOND_STAGE, prefix: 'lao-two-stage-check-' });

  // What the orchestrator answered, turn by turn, to compare with what the
  // loop then handed the worker.
  const decisions: Array<{ action: string; task?: string }> = [];
  const decide = (decision: { action: string; task?: string }): string => {
    decisions.push(decision);
    return JSON.stringify({
      acceptanceCriteria: [],
      verificationCommands: ['two-stage'],
      summary: decision.action,
      ...decision,
    });
  };

  // The one message from the user. It says nothing about the second stage.
  const objective =
    `Crie hello.txt contendo exatamente "${EXPECTED}". A verificação registrada é o critério ` +
    'completo: peça-a por id e, se ela falhar, delegue a correção que ela reportar.';

  const prepared = await prepare({
    repository: () => {
      const repo = createGitFixture('lao-two-stage-');
      repo.write('README.md', '# scratch\n');
      repo.commitAll('baseline');
      return repo;
    },
    verification: { id: 'two-stage', label: 'o workspace passa na verificação registrada', command: check.command },
    orchestratorScript: [
      (input: AgentInput) => {
        assert.doesNotMatch(input.prompt, /RESULT OF THE PREVIOUS ITERATION/);
        assert.doesNotMatch(input.prompt, /check\.mjs/, 'the command line is never shown to the orchestrator');
        return decide({ action: 'delegate', task: `Crie hello.txt contendo exatamente "${EXPECTED}"` });
      },
      (input: AgentInput) => {
        assert.match(input.prompt, /FAIL \(exit 1\)/, 'the first verification failed');
        // Read what is missing from the verification's own output, and ask
        // for exactly that. The file name and content exist nowhere else.
        const missing = /(\S+) is null, expected "([^"]*)"/.exec(input.prompt);
        assert.ok(missing, 'the failure names what is missing');
        return decide({ action: 'delegate', task: `Crie ${missing[1]} contendo exatamente "${missing[2]}"` });
      },
      (input: AgentInput) => {
        assert.match(input.prompt, /PASS: node /, 'the second verification passed');
        return decide({ action: 'done' });
      },
    ],
    workerScript: [
      // A perfect worker: it does exactly what it is told, every time.
      (input: AgentInput) => {
        const order = /Crie (\S+) contendo exatamente "([^"]*)"/.exec(input.prompt);
        assert.ok(order, 'the worker only ever receives a concrete instruction');
        writeFileSync(join(input.workingDirectory, order[1]!), `${order[2]}\n`, 'utf8');
        return 'feito';
      },
    ],
  });

  try {
    // The script is outside the workspace, so nothing in the repository can
    // reveal the second stage.
    assert.equal(existsSync(join(prepared.repo.dir, 'check.mjs')), false);
    assert.ok(!check.dir.startsWith(prepared.repo.dir));
    assert.doesNotMatch(objective, new RegExp(`${SECOND_STAGE.file}|${SECOND_STAGE.content}`));

    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: objective,
      }),
    );
    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);
    assert.equal(run.status, 'DONE', run.summary ?? '');

    // -- two worker turns, from one message, on consecutive iterations ------
    const db = prepared.fixture.services.database;
    const invocations = db.runs.invocations(sent.run.id) as Array<{
      role: string;
      iteration: number;
      task: string | null;
    }>;
    const workers = invocations.filter((i) => i.role === 'CODING_WORKER');
    assert.equal(workers.length, 2, 'the worker ran exactly twice');
    assert.deepEqual(workers.map((i) => i.iteration), [1, 2]);
    assert.equal(invocations.filter((i) => i.role === 'ORCHESTRATOR').length, 3);
    assert.equal(db.chat.listMessages(prepared.sessionId).filter((m) => m.author === 'user').length, 1);

    // -- the first prompt could not have known about the second stage -------
    const worker = prepared.worker as ScriptedAgent;
    const [first, second] = worker.calls.map((c) => c.prompt);
    assert.doesNotMatch(first!, new RegExp(`${SECOND_STAGE.file}|${SECOND_STAGE.content}`));

    // -- and the second is the orchestrator's decision, verbatim ------------
    assert.equal(decisions[1]!.action, 'delegate');
    assert.equal(second, decisions[1]!.task, 'the worker received decision.task unchanged');
    assert.equal(workers[1]!.task, decisions[1]!.task, 'and the database recorded the same');
    assert.notEqual(second, objective, 'not the objective handed down again');
    assert.equal(second, `Crie ${SECOND_STAGE.file} contendo exatamente "${SECOND_STAGE.content}"`);

    // -- the verdicts that drove it: a failure, then a pass -----------------
    const verifications = db.runs.verifications(sent.run.id) as Array<{
      iteration: number;
      command: string;
      passed: number;
      exit_code: number | null;
    }>;
    assert.equal(verifications.find((v) => v.iteration === 1)?.passed, 0);
    assert.equal(verifications.find((v) => v.iteration === 1)?.exit_code, 1);
    assert.equal(verifications.find((v) => v.iteration === 2)?.passed, 1);
    assert.ok(verifications.every((v) => v.command === check.command), 'only the registered command ran');

    // -- the evidence the loop collected itself, not the agents' word -------
    const evidence = db.runs.steps(sent.run.id).filter((s) => s.phase === 'evidence');
    assert.deepEqual(
      evidence.map((s) => `${s.iteration}:${s.status}:${s.summary}`),
      ['1:changed:1 arquivo(s)', '2:changed:2 arquivo(s)', '3:changed:2 arquivo(s)'],
    );
    assert.equal(readFileSync(join(prepared.repo.dir, 'hello.txt'), 'utf8').trim(), EXPECTED);
    assert.equal(readFileSync(join(prepared.repo.dir, SECOND_STAGE.file), 'utf8').trim(), SECOND_STAGE.content);
  } finally {
    await prepared.cleanup();
    rmSync(check.dir, { recursive: true, force: true });
  }
});
