/**
 * Cancelar é uma operação de controle, não uma tarefa para a IA.
 *
 * ## O que aconteceu
 *
 * A pessoa digitou *"pare tudo q esteja fazendo"* e depois *"pare oq o claude
 * esta fazendo"*. As duas viraram **novas runs**: o supervisor foi planejar
 * como parar, e o worker foi delegado a confirmar que tinha parado. A execução
 * que ela queria parar continuou.
 *
 * E o botão também não bastava: `cancel()` abortava o sinal e matava os
 * processos, mas **não marcava nada**. A run continuava `RUNNING` no banco até
 * o laço alcançar um dos três pontos de verificação — e no caminho até lá ele
 * ainda podia começar outra delegação.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/database/database.js';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import type { AgentInput } from '../src/core/types.js';
import type { ChatMessageView, IpcResult, RunView } from '../apps/desktop/src/shared/ipc-contract.js';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

/**
 * A fixture whose worker waits until the test lets it finish, so a
 * cancellation can land while a delegation is genuinely in flight.
 */
async function prepare(options: {
  orchestratorScript: readonly string[];
  onWorkerStart?: () => void;
  hold?: Promise<void>;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'lao-cancel-'));
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', options.orchestratorScript);
  const worker = new ScriptedAgent('mock-claude', 'Claude', [
    async (_input: AgentInput) => {
      options.onWorkerStart?.();
      if (options.hold) await options.hold;
      return 'feito';
    },
  ]);
  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    maxIterations: 4,
  });
  const workspace = value<{ id: string }>(
    await fixture.router.handle('workspace.create', { name: 'C', localPath: dir }),
  );
  value(await fixture.router.handle('accounts.create', { name: 'C', provider: 'anthropic' }));
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
    await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'C' }),
  );
  return {
    fixture,
    orchestrator,
    worker,
    dir,
    sessionId: session.id,
    workspaceId: workspace.id,
    async send(text: string) {
      return fixture.router.handle('chat.sendMessage', { sessionId: session.id, text });
    },
    messages(): readonly ChatMessageView[] {
      return value<readonly ChatMessageView[]>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (fixture.router as any).handleSync?.('chat.listMessages', { sessionId: session.id }) ?? { ok: true, value: [] },
      );
    },
    async cleanup() {
      await fixture.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const delegate = JSON.stringify({
  action: 'delegate',
  task: 'Crie os quatro arquivos',
  acceptanceCriteria: ['index.html existe'],
  verificationCommands: [],
  fileChecks: [],
  summary: 'vou pedir',
});

test('cancelling during a delegation stops it, and no model is called to confirm', async () => {
  let release: (() => void) | null = null;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const prepared = await prepare({
    orchestratorScript: [delegate, delegate, delegate, delegate],
    onWorkerStart: () => {
      started = true;
    },
    hold,
  });
  try {
    const sent = value<{ run: { id: string } }>(await prepared.send('crie o miniaplicativo'));
    // Wait for the worker to actually be inside its delegation.
    const until = Date.now() + 10_000;
    while (!started && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.equal(started, true, 'the worker is running');

    const orchestratorCallsBefore = prepared.orchestrator.calls.length;
    const workerCallsBefore = prepared.worker.calls.length;

    value(await prepared.fixture.router.handle('run.cancel', { runId: sent.run.id }));

    // The intent is a fact immediately, before the loop notices anything.
    assert.equal(prepared.fixture.services.database.runs.cancelRequested(sent.run.id), true);

    release!();
    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);
    assert.equal(run.status, 'CANCELLED');

    // Not one extra invocation: cancelling asked nobody anything.
    assert.equal(prepared.orchestrator.calls.length, orchestratorCallsBefore);
    assert.equal(prepared.worker.calls.length, workerCallsBefore);

    // And no step is left spinning.
    const steps = prepared.fixture.services.database.runs.steps(sent.run.id);
    assert.equal(
      steps.some((s) => s.status === 'running' || s.status === 'started'),
      false,
      'no step is left in progress',
    );
  } finally {
    await prepared.cleanup();
  }
});

test('a cancelled run cannot be written back to RUNNING or DONE by a late result', async () => {
  const prepared = await prepare({ orchestratorScript: [delegate] });
  try {
    const sent = value<{ run: { id: string } }>(await prepared.send('faça'));
    await prepared.fixture.services.orchestration.waitFor(sent.run.id);
    const runs = prepared.fixture.services.database.runs;

    runs.setStatus(sent.run.id, 'CANCELLED', 'Cancelado pelo usuário.');
    // Exactly what a late result does.
    runs.setStatus(sent.run.id, 'RUNNING');
    assert.equal(runs.require(sent.run.id).status, 'CANCELLED');
    runs.setStatus(sent.run.id, 'DONE', 'Tarefa concluída e verificada.');
    assert.equal(runs.require(sent.run.id).status, 'CANCELLED');
    assert.match(runs.require(sent.run.id).termination_reason ?? '', /Cancelado pelo usuário/);
  } finally {
    await prepared.cleanup();
  }
});

test('"pare tudo" cancels the run instead of starting one', async () => {
  let release: (() => void) | null = null;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const prepared = await prepare({
    orchestratorScript: [delegate, delegate, delegate, delegate],
    onWorkerStart: () => {
      started = true;
    },
    hold,
  });
  try {
    const sent = value<{ run: { id: string } }>(await prepared.send('crie o miniaplicativo'));
    const until = Date.now() + 10_000;
    while (!started && Date.now() < until) await new Promise((r) => setTimeout(r, 20));

    const runsBefore = prepared.fixture.services.database.runs.listForSession(prepared.sessionId).length;
    const orchestratorBefore = prepared.orchestrator.calls.length;

    const stop = value<{ run: RunView }>(await prepared.send('pare tudo q esteja fazendo'));

    // No new run, and the message points at the run that was stopped.
    const runsAfter = prepared.fixture.services.database.runs.listForSession(prepared.sessionId);
    assert.equal(runsAfter.length, runsBefore, 'no run was created to stop a run');
    assert.equal(stop.run.id, sent.run.id);
    assert.equal(prepared.orchestrator.calls.length, orchestratorBefore, 'nobody was asked');

    release!();
    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);
    assert.equal(run.status, 'CANCELLED');
  } finally {
    await prepared.cleanup();
  }
});

test('"pare" with nothing running says so, and starts no agents', async () => {
  const prepared = await prepare({ orchestratorScript: [delegate] });
  try {
    const result = await prepared.send('pare tudo');
    assert.equal(result.ok, false, 'there is nothing to stop and nothing is invented');
    assert.equal(prepared.orchestrator.calls.length, 0);
    assert.equal(prepared.worker.calls.length, 0);
    assert.equal(prepared.fixture.services.database.runs.listForSession(prepared.sessionId).length, 0);
  } finally {
    await prepared.cleanup();
  }
});

test('a question about cancelling is still a task, not a cancellation', async () => {
  const prepared = await prepare({ orchestratorScript: [JSON.stringify({ action: 'blocked', reason: 'x' })] });
  try {
    const sent = value<{ run: { id: string } }>(await prepared.send('como eu cancelo uma tarefa?'));
    assert.ok(sent.run.id, 'it started a run like any other message');
    await prepared.fixture.services.orchestration.waitFor(sent.run.id);
  } finally {
    await prepared.cleanup();
  }
});

test('the cancellation survives reopening the application', async () => {
  const prepared = await prepare({ orchestratorScript: [delegate] });
  try {
    const sent = value<{ run: { id: string } }>(await prepared.send('faça'));
    await prepared.fixture.services.orchestration.waitFor(sent.run.id);
    value(await prepared.fixture.router.handle('run.cancel', { runId: sent.run.id }));

    const reopened = new Database({ paths: prepared.fixture.paths });
    try {
      assert.equal(reopened.runs.cancelRequested(sent.run.id), true);
    } finally {
      reopened.close();
    }
  } finally {
    await prepared.cleanup();
  }
});

/* ---- two rounds with no new evidence ------------------------------------ */

test('two iterations that prove nothing new stop for a person, without escalating', async () => {
  // The shape of the incident: the supervisor keeps asking for the same thing,
  // the workspace does not change, the criteria stay pending. Repeating that is
  // a loop, and a stronger model does not break it.
  const verify = JSON.stringify({
    action: 'verify',
    acceptanceCriteria: ['index.html existe'],
    verificationCommands: [],
    fileChecks: [{ path: 'index.html', mustExist: true, criteria: [] }],
    fileReads: [],
    summary: 'quero ver de novo',
  });
  const prepared = await prepare({ orchestratorScript: [verify, verify, verify, verify] });
  try {
    const sent = value<{ run: { id: string } }>(await prepared.send('faça'));
    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    assert.equal(run.status, 'NEEDS_HUMAN');
    assert.match(run.summary ?? '', /não produziram nenhuma evidência nova/);
    const steps = prepared.fixture.services.database.runs.steps(sent.run.id);
    assert.equal(steps.find((s) => s.phase === 'progress')?.status, 'stagnant');

    // It stopped early rather than spending the whole budget.
    assert.ok(
      prepared.orchestrator.calls.length <= 3,
      `stopped after ${prepared.orchestrator.calls.length} rounds`,
    );
  } finally {
    await prepared.cleanup();
  }
});
