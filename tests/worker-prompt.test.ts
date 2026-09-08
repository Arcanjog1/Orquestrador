/**
 * "Confira os critérios abaixo" — e nenhuma lista embaixo.
 *
 * O worker relatou isso **três vezes na mesma execução**, e estava certo. O
 * prompt de delegação era a política de ferramentas mais o texto livre do
 * supervisor, e mais nada:
 *
 *     `${toolPolicyPreamble(...)}\n\n${task}`
 *
 * Os `acceptanceCriteria` da decisão existiam — ficavam no ledger, apareciam na
 * interface e eram checados pelo gate. Simplesmente nunca eram enviados ao
 * worker. O supervisor escrevia um ponteiro; nada deste lado resolvia.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerPrompt } from '../src/orchestrator/worker-prompt.js';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import { createPlainDir } from './helpers/git-fixture.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';

const PREAMBLE = 'FERRAMENTAS: Write e Read estão autorizadas.';

test('the criteria the decision names are in the prompt, numbered', () => {
  const built = buildWorkerPrompt({
    preamble: PREAMBLE,
    task: 'Crie o miniaplicativo e confira os critérios abaixo.',
    criteria: ['index.html existe', 'style.css existe', 'app.js existe', 'README.md existe'],
  });
  assert.equal(built.criteriaSent, 4);
  assert.equal(built.danglingReference, false);
  assert.match(built.text, /CRITÉRIOS DE ACEITE DESTA TAREFA/);
  assert.match(built.text, /1\. index\.html existe/);
  assert.match(built.text, /4\. README\.md existe/);
  // The task and the policy are still there, in that order.
  assert.ok(built.text.indexOf(PREAMBLE) < built.text.indexOf('Crie o miniaplicativo'));
  assert.ok(built.text.indexOf('Crie o miniaplicativo') < built.text.indexOf('CRITÉRIOS DE ACEITE'));
});

test('the incident: a reference with nothing to reference is corrected, not left dangling', () => {
  for (const task of [
    'Confira os critérios abaixo.',
    'Revise os quatro critérios abaixo e reporte.',
    'Verifique os requisitos listados a seguir.',
    'Check the criteria below.',
  ]) {
    const built = buildWorkerPrompt({ preamble: PREAMBLE, task, criteria: [] });
    assert.equal(built.danglingReference, true, task);
    assert.match(built.text, /OBSERVAÇÃO DO APLICATIVO/);
    assert.match(built.text, /nenhuma foi enviada com esta delegação/);
    // And it never invents a list to fill the hole.
    assert.doesNotMatch(built.text, /CRITÉRIOS DE ACEITE DESTA TAREFA/);
    assert.match(built.text, /Não tente adivinhar/);
  }
});

test('a task that does not point at a list gets no note', () => {
  const built = buildWorkerPrompt({
    preamble: PREAMBLE,
    task: 'Crie hello.txt com o texto pronto.',
    criteria: [],
  });
  assert.equal(built.danglingReference, false);
  assert.doesNotMatch(built.text, /OBSERVAÇÃO DO APLICATIVO/);
  assert.doesNotMatch(built.text, /CRITÉRIOS/);
});

test('empty criteria are dropped rather than sent as blank lines', () => {
  const built = buildWorkerPrompt({
    preamble: PREAMBLE,
    task: 'faça',
    criteria: ['  ', '', 'index.html existe'],
  });
  assert.equal(built.criteriaSent, 1);
  assert.match(built.text, /1\. index\.html existe/);
  assert.doesNotMatch(built.text, /2\./);
});

/* ---- through the real delegation --------------------------------------- */

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

test('a real delegation carries the decision\'s criteria to the worker', async () => {
  const dir = createPlainDir('lao-criteria-');
  const criteria = ['index.html existe', 'style.css existe', 'app.js existe', 'README.md existe'];
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', [
    JSON.stringify({
      action: 'delegate',
      task: 'Crie o miniaplicativo e confira os critérios abaixo.',
      acceptanceCriteria: criteria,
      verificationCommands: [],
      fileChecks: [],
      summary: 'vou pedir',
    }),
    JSON.stringify({ action: 'blocked', reason: 'parei' }),
  ]);
  const worker = new ScriptedAgent('mock-claude', 'Claude', ['feito']);
  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    maxIterations: 2,
  });
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.create', { name: 'C', localPath: dir.dir }),
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
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'crie' }),
    );
    await fixture.services.orchestration.waitFor(sent.run.id);

    const prompt = worker.calls[0]!.prompt;
    assert.match(prompt, /CRITÉRIOS DE ACEITE DESTA TAREFA/);
    for (const criterion of criteria) assert.ok(prompt.includes(criterion), criterion);
    assert.doesNotMatch(prompt, /OBSERVAÇÃO DO APLICATIVO/);
  } finally {
    await fixture.cleanup();
    dir.cleanup();
  }
});
