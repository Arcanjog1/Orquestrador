/**
 * O relatório atravessa o laço, a conversa e o banco.
 *
 * O teste unitário prova o formato. Este prova o caminho: que o relatório é
 * produzido **sem uma segunda chamada ao modelo**, que aparece na conversa como
 * mensagem do worker e separado da tarefa que foi enviada a ele, que chega ao
 * supervisor junto das evidências, que sobrevive a reabrir o aplicativo, e que
 * o DoneGate continua decidindo por conta própria — um relatório dizendo
 * "concluí" não satisfaz critério nenhum.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../src/database/database.js';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type { AgentInput } from '../src/core/types.js';
import type { ChatMessageView, IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';

const PRONTO_HEX = '70726F6E746F';
const CRITERION = 'hello.txt contém exatamente os bytes 70 72 6F 6E 74 6F';
const CHECK = {
  path: 'hello.txt',
  expectBytesHex: PRONTO_HEX,
  forbidBom: true,
  forbidTrailingNewline: true,
  criteria: [CRITERION],
};

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

async function runWith(options: {
  orchestratorScript: readonly string[];
  workerScript: ReadonlyArray<string | ((input: AgentInput) => string)>;
  maxIterations?: number;
}) {
  const repo = createGitFixture('lao-report-');
  repo.write('README.md', '# x\n');
  repo.commitAll('base');

  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', options.orchestratorScript);
  const worker = new ScriptedAgent('mock-claude', 'Claude', options.workerScript);
  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    maxIterations: options.maxIterations ?? 4,
  });
  const workspace = value<{ id: string }>(
    await fixture.router.handle('workspace.create', { name: 'S', localPath: repo.dir }),
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
  const sent = value<{ run: { id: string } }>(
    await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'Crie hello.txt' }),
  );
  const run = await fixture.services.orchestration.waitFor(sent.run.id);
  const messages = value<readonly ChatMessageView[]>(
    await fixture.router.handle('chat.listMessages', { sessionId: session.id }),
  );
  return {
    run,
    repo,
    fixture,
    orchestrator,
    worker,
    messages,
    runId: sent.run.id,
    sessionId: session.id,
    async cleanup() {
      await fixture.cleanup();
      repo.cleanup();
    },
  };
}

const delegate = JSON.stringify({
  action: 'delegate',
  task: 'Crie hello.txt',
  acceptanceCriteria: [CRITERION],
  verificationCommands: [],
  fileChecks: [CHECK],
  summary: 'vou pedir',
});

const writesFile = (input: AgentInput) => {
  writeFileSync(join(input.workingDirectory, 'hello.txt'), Buffer.from(PRONTO_HEX, 'hex'));
  return 'Criei hello.txt com os seis bytes pedidos.';
};

test('a completed delegation reports itself, in the conversation, without a second model call', async () => {
  const prepared = await runWith({ orchestratorScript: [delegate], workerScript: [writesFile] });
  try {
    assert.equal(prepared.run.status, 'DONE');
    // The point of doing this from the result that already came back: no
    // invocation exists whose only job was to write the report.
    assert.equal(prepared.orchestrator.calls.length, 1);
    assert.equal(prepared.worker.calls.length, 1);

    const workerMessages = prepared.messages.filter((m) => m.author === 'worker');
    const delegation = workerMessages.find((m) => m.kind === 'delegation');
    const report = workerMessages.find((m) => m.kind === 'report');

    // The task that was sent is labelled as the task - it used to appear under
    // the worker's name with nothing saying which it was.
    assert.ok(delegation, 'the delegation is on the record');
    assert.match(delegation!.text, /tarefa enviada:/);
    assert.equal(delegation!.report, null);

    assert.ok(report, 'and the worker reported back');
    assert.equal(report!.report?.status, 'completed');
    assert.match(report!.text, /O QUE O WORKER RELATOU/);
    assert.match(report!.text, /O QUE O APLICATIVO MEDIU/);
    assert.match(report!.text, /criados:\s+hello\.txt/);
    assert.deepEqual([...(report!.report?.evidenceFiles.created ?? [])], ['hello.txt']);

    // Bound to the invocation, and to the run's step history.
    const invocations = prepared.fixture.services.database.runs.invocations(prepared.runId) as Array<
      Record<string, unknown>
    >;
    const workerRow = invocations.find((row) => row.role === 'CODING_WORKER');
    assert.ok(workerRow?.report_json, 'the report is on the invocation row');
    assert.equal(JSON.parse(String(workerRow!.report_json)).status, 'completed');

    const steps = prepared.fixture.services.database.runs.steps(prepared.runId);
    assert.equal(steps.find((s) => s.phase === 'worker-report')?.status, 'completed');
  } finally {
    await prepared.cleanup();
  }
});

test('the report survives reopening the application', async () => {
  const prepared = await runWith({ orchestratorScript: [delegate], workerScript: [writesFile] });
  try {
    const file = join(prepared.fixture.paths.data, 'orchestrator.db');
    // A second connection to the same file: what happens when the window is
    // closed and opened again.
    const reopened = new Database({ paths: prepared.fixture.paths });
    try {
      const messages = reopened.chat.listMessages(prepared.sessionId);
      const report = messages.find((m) => m.author === 'worker' && /O QUE O APLICATIVO MEDIU/.test(m.body));
      assert.ok(report, 'the report is still in the conversation');
      const payload = JSON.parse(report!.payload ?? '{}') as { kind?: string; report?: { status?: string } };
      assert.equal(payload.kind, 'report');
      assert.equal(payload.report?.status, 'completed');

      const rows = reopened.runs.invocations(prepared.runId) as Array<Record<string, unknown>>;
      assert.ok(rows.some((row) => row.report_json), 'and still on the invocation');
    } finally {
      reopened.close();
    }
    assert.ok(file.length > 0);
  } finally {
    await prepared.cleanup();
  }
});

test('the supervisor is handed the report and the evidence, not a transcript', async () => {
  // The worker writes the wrong bytes, so a second round happens and the
  // second prompt is the one carrying the review package.
  const wrong = (input: AgentInput) => {
    writeFileSync(join(input.workingDirectory, 'hello.txt'), 'errado');
    return 'Escrevi hello.txt.';
  };
  const prepared = await runWith({
    orchestratorScript: [delegate, JSON.stringify({ action: 'blocked', reason: 'parei aqui' })],
    workerScript: [wrong],
    maxIterations: 2,
  });
  try {
    const second = prepared.orchestrator.calls[1]!.prompt;
    assert.match(second, /WORKER REPORT:/);
    assert.match(second, /\[PARCIAL\]/);
    assert.match(second, /O QUE O WORKER RELATOU \(declaração, não prova\)/);
    assert.match(second, /O QUE O APLICATIVO MEDIU \(evidência\)/);
    assert.match(second, /PRÓXIMO PASSO:/);
    // The measurement contradicts the claim, and the package says which decides.
    assert.match(second, /FALHOU: \[leitura direta\] hello\.txt/);
    assert.match(second, /CRITERIA STILL WITHOUT PROOF/);
  } finally {
    await prepared.cleanup();
  }
});

test('a report saying it finished does not satisfy a criterion; the gate still decides', async () => {
  // The worker claims success and writes nothing. The report records the
  // claim; the DoneGate refuses, because nothing measured it.
  const liar = () => 'Criei hello.txt exatamente como pedido.';
  const prepared = await runWith({
    orchestratorScript: [
      delegate,
      JSON.stringify({
        action: 'done',
        acceptanceCriteria: [CRITERION],
        verificationCommands: [],
        fileChecks: [],
        satisfiedCriteria: [CRITERION],
        summary: 'o worker disse que terminou',
      }),
      JSON.stringify({ action: 'blocked', reason: 'sem prova' }),
    ],
    workerScript: [liar],
    maxIterations: 3,
  });
  try {
    assert.notEqual(prepared.run.status, 'DONE', 'a claim is not evidence');
    const report = prepared.messages.find((m) => m.kind === 'report');
    assert.equal(report?.report?.status, 'partial');
    // The claim is kept, as a claim, and the disagreement is named.
    assert.match(report!.text, /Criei hello\.txt exatamente como pedido/);
    assert.match(report!.text, /DIVERGÊNCIA/);
    assert.match(report!.text, /A evidência decide/);
  } finally {
    await prepared.cleanup();
  }
});

test('a refused tool stops the run and still reports, from the process alone', async () => {
  // The terminal path: the delegation never got to do the work, so there is no
  // evidence to collect. A report is built from the process anyway - this is
  // exactly the case where "nothing happened" used to be all the screen said.
  const repo = createGitFixture('lao-report-denied-');
  repo.write('README.md', '# x\n');
  repo.commitAll('base');
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', [delegate]);
  const worker = new ScriptedAgent('mock-claude', 'Claude', ['']);
  worker.denyNext = [
    { toolName: 'Bash', toolUseId: 'tu-1', command: 'echo pronto > hello.txt' },
  ];
  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    maxIterations: 2,
  });
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.create', { name: 'S', localPath: repo.dir }),
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
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', {
        sessionId: session.id,
        text: 'Crie hello.txt',
      }),
    );
    const run = await fixture.services.orchestration.waitFor(sent.run.id);
    assert.equal(run.status, 'NEEDS_HUMAN');

    const messages = value<readonly ChatMessageView[]>(
      await fixture.router.handle('chat.listMessages', { sessionId: session.id }),
    );
    const report = messages.find((m) => m.kind === 'report');
    assert.ok(report, 'a delegation that never got to work still reports');
    assert.equal(report!.report?.status, 'blocked');
    assert.deepEqual([...(report!.report?.deniedTools ?? [])], ['Bash']);
    assert.match(report!.text, /AUTORIZAÇÕES:/);
    assert.match(report!.text, /recusada: Bash/);
    assert.match(report!.text, /Autorize/);
    assert.match(
      report!.text,
      /nenhum modelo recebe uma permissão que foi negada/,
      'and it says so instead of suggesting a bigger model',
    );
    assert.equal(report!.report?.evidenceUnavailable, true);
    // The worker ran once and was refused; nothing tried again with more model.
    assert.equal(worker.calls.length, 1);
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});
