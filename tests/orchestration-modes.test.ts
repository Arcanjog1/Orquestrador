/**
 * The two shapes a run can have, end to end.
 *
 * The first is the flow the product is being reoriented around: an objective,
 * an OpenAI orchestrator, two separate Claude workers, a review between each,
 * and DONE - with no folder, no repository, no clone and no server anywhere in
 * it. The second is the coding flow, unchanged and deliberately still strict:
 * a real git repository, a real file written by a worker that really has an
 * executor, evidence collected by the program, a verification re-run from
 * scratch, and only then DONE.
 *
 * Both use scripted agents, so they are deterministic and cost nothing. What
 * they are *not* is proof that a paid API works: a scripted provider proves
 * the loop, the contract and the gates. Only a real call proves the vendor,
 * and that is a human gate - see docs/API_COST_CONTROLS.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ScriptedAgent,
  ScriptedProvider,
  codingCapabilities,
  conversationCapabilities,
  createDesktopFixture,
  type DesktopFixture,
} from './helpers/desktop-fixture.js';
import { createGitFixture, type GitFixture } from './helpers/git-fixture.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';
import type { WorkerSlot } from '../apps/desktop/src/main/services/orchestration-service.js';
import type { AgentInput, InvocationUsage } from '../src/core/types.js';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

/** A run's steps, as the record has them. */
function steps(fixture: DesktopFixture, runId: string): Array<{ phase: string; status: string; summary: string | null }> {
  return fixture.services.database.runs.steps(runId) as Array<{
    phase: string;
    status: string;
    summary: string | null;
  }>;
}

function messages(fixture: DesktopFixture, sessionId: string): Array<{ author: string; body: string }> {
  return fixture.services.database.chat.listMessages(sessionId) as Array<{
    author: string;
    body: string;
  }>;
}

/**
 * Binds a team to a project, the way the interface does.
 *
 * Every project needs one, whatever kind it is, and the loop refuses to start
 * without it - which is correct, and is why the tests do the same thing a
 * person would rather than reaching past it.
 */
async function bindTeam(
  fixture: DesktopFixture,
  workspaceId: string,
  workerNames: string[],
): Promise<Array<{ agentId: string; accountId: string | null }>> {
  for (const name of workerNames) {
    value(await fixture.router.handle('accounts.create', { name, provider: 'anthropic' }));
  }
  const agents = value<Array<{ id: string; role: string; name: string; accountId: string | null }>>(
    await fixture.router.handle('agents.list', null),
  );
  const workers = workerNames.map(
    (name) => agents.find((a) => a.role === 'CODING_WORKER' && a.name === name)!,
  );
  fixture.services.database.workspaces.setTeam(
    workspaceId,
    { agentId: agents.find((a) => a.role === 'ORCHESTRATOR')!.id },
    workers.map((agent, index) => ({ agentId: agent.id, label: workerNames[index]! })),
  );
  return workers.map((agent) => ({ agentId: agent.id, accountId: agent.accountId }));
}

const USAGE: InvocationUsage = {
  billing: 'api-metered',
  inputTokens: 1000,
  outputTokens: 200,
  totalTokens: 1200,
  costUsd: 0.01,
};

/* ================================================================== *
 * Conversation mode
 * ================================================================== */

/**
 * The whole flow of the reorientation, as one deterministic run.
 *
 * OBJECTIVE → orchestrator → Claude 1 → review → Claude 2 → review → DONE,
 * with nothing on disk and no environment provisioned.
 */
async function conversationTeam(): Promise<{
  fixture: DesktopFixture;
  sessionId: string;
  workspaceId: string;
  orchestrator: ScriptedProvider;
  claudeOne: ScriptedProvider;
  claudeTwo: ScriptedProvider;
  cleanup(): Promise<void>;
}> {
  const orchestrator = new ScriptedProvider(
    'openai-api',
    'Codex',
    [
      // 1. Delegate the analysis to the first Claude, by name.
      JSON.stringify({
        action: 'delegate',
        workerId: 'worker-1',
        requiresTools: false,
        task: 'Analise as duas abordagens e diga qual é mais simples.',
        acceptanceCriteria: ['as duas abordagens foram comparadas', 'há uma recomendação'],
        verificationCommands: [],
        summary: 'Vou pedir a análise ao Claude Trabalho 1.',
      }),
      // 2. Reviewed it; now a second opinion from the other account.
      JSON.stringify({
        action: 'delegate',
        workerId: 'worker-2',
        requiresTools: false,
        task: 'Revise a análise anterior e aponte o que ficou de fora.',
        acceptanceCriteria: [],
        verificationCommands: [],
        satisfiedCriteria: ['as duas abordagens foram comparadas'],
        summary: 'Boa análise. Vou pedir uma revisão ao Claude Trabalho 2.',
      }),
      // 3. Reviewed that too; answer the person.
      JSON.stringify({
        action: 'done',
        acceptanceCriteria: [],
        verificationCommands: [],
        satisfiedCriteria: ['há uma recomendação'],
        summary:
          'A abordagem B é mais simples: menos estado compartilhado e um único ponto de falha. ' +
          'A revisão apontou que o custo de migração não foi considerado, e ele é baixo.',
      }),
    ],
    conversationCapabilities('openai'),
    'conn-openai',
    USAGE,
  );

  const claudeOne = new ScriptedProvider(
    'anthropic-api',
    'Claude Trabalho 1',
    ['A abordagem B tem menos estado compartilhado. Recomendo B.'],
    conversationCapabilities('anthropic'),
    'conn-claude-1',
    USAGE,
  );
  const claudeTwo = new ScriptedProvider(
    'anthropic-api',
    'Claude Trabalho 2',
    ['A análise não considerou o custo de migração, que é baixo.'],
    conversationCapabilities('anthropic'),
    'conn-claude-2',
    USAGE,
  );

  // The slots point at the accounts the team really created, which is what an
  // invocation record references. Bound after the team exists, because a run
  // is only built when one starts.
  let bound: Array<{ agentId: string; accountId: string | null }> = [];
  const slot = (index: number, label: string, runner: ScriptedProvider): WorkerSlot => ({
    id: `worker-${index + 1}`,
    label,
    runner,
    accountId: bound[index]?.accountId ?? null,
    providerId: 'anthropic',
    connectionKind: 'api',
    agentId: bound[index]?.agentId ?? null,
  });

  const fixture = createDesktopFixture({
    createRunners: async () => ({
      orchestrator,
      worker: claudeOne,
      workerAccountId: bound[0]?.accountId ?? null,
      workers: [slot(0, 'Claude Trabalho 1', claudeOne), slot(1, 'Claude Trabalho 2', claudeTwo)],
    }),
    maxIterations: 5,
  });

  const workspace = value<{ id: string; environment: string; localPath: string }>(
    await fixture.router.handle('workspace.createConversation', { name: 'Arquitetura' }),
  );
  assert.equal(workspace.environment, 'conversation');
  assert.equal(workspace.localPath, '', 'a conversation project owns no folder');
  bound = await bindTeam(fixture, workspace.id, ['Claude Trabalho 1', 'Claude Trabalho 2']);

  const session = value<{ id: string }>(
    await fixture.router.handle('chat.createSession', {
      workspaceId: workspace.id,
      title: 'Comparar abordagens',
    }),
  );

  return {
    fixture,
    sessionId: session.id,
    workspaceId: workspace.id,
    orchestrator,
    claudeOne,
    claudeTwo,
    cleanup: () => fixture.cleanup(),
  };
}

test('E2E: objective, orchestrator, Claude 1, review, Claude 2, review, DONE - with no workspace', async () => {
  const t = await conversationTeam();
  try {
    const sent = value<{ run: { id: string } }>(
      await t.fixture.router.handle('chat.sendMessage', {
        sessionId: t.sessionId,
        text: 'Qual das duas abordagens de sincronização é mais simples de manter?',
      }),
    );
    const run = await t.fixture.services.orchestration.waitFor(sent.run.id);

    assert.equal(
      run.status,
      'DONE',
      steps(t.fixture, sent.run.id)
        .map((s) => `${s.phase}/${s.status}: ${s.summary}`)
        .join('\n'),
    );

    // Each account was asked exactly once, and each got its own task.
    assert.equal(t.claudeOne.calls.length, 1);
    assert.equal(t.claudeTwo.calls.length, 1);
    assert.match(t.claudeOne.calls[0]!.prompt, /Analise as duas abordagens/);
    assert.match(t.claudeTwo.calls[0]!.prompt, /Revise a análise anterior/);

    // The orchestrator ran three times: delegate, delegate, done.
    assert.equal(t.orchestrator.calls.length, 3);

    // The second worker's prompt is its own task, and carries nothing from the
    // first account's conversation: two Claude connections never share context.
    assert.ok(
      !t.claudeTwo.calls[0]!.prompt.includes('Analise as duas abordagens'),
      "worker 2's prompt must not carry worker 1's task",
    );

    // The final answer reached the person.
    const said = messages(t.fixture, t.sessionId);
    assert.ok(
      said.some((m) => m.author === 'orchestrator' && /abordagem B é mais simples/.test(m.body)),
      'the final answer must be said to the person',
    );

    // And nothing pretended to be a workspace: no baseline, no evidence, no
    // verification anywhere in the record.
    const phases = steps(t.fixture, sent.run.id).map((s) => s.phase);
    for (const forbidden of ['baseline', 'evidence', 'verification']) {
      assert.ok(!phases.includes(forbidden), `a conversation run must record no ${forbidden}`);
    }
    assert.equal(t.fixture.services.database.runs.verifications(sent.run.id).length, 0);

    const record = t.fixture.services.database.runs.require(sent.run.id) as unknown as {
      kind: string;
      invocation_count: number;
      total_cost_usd: number | null;
    };
    assert.equal(record.kind, 'conversation');
    assert.equal(record.invocation_count, 5, 'three orchestrator calls and two worker calls');
    // Five metered calls at one cent each, summed as they happened.
    assert.equal(Math.round((record.total_cost_usd ?? 0) * 100), 5);

    // What "Detalhes" shows: who answered, reached how, as which team member,
    // and what it consumed. This is the timeline's evidence, and it comes from
    // the record rather than from anything reconstructed for display.
    const detail = t.fixture.services.orchestration.detail(sent.run.id);
    assert.equal(detail.invocations.length, 5);
    const workerCalls = detail.invocations.filter((i) => i.role === 'CODING_WORKER');
    assert.deepEqual(
      workerCalls.map((i) => i.workerId),
      ['worker-1', 'worker-2'],
      'each delegation names the member it went to',
    );
    for (const invocation of detail.invocations) {
      assert.equal(invocation.providerId !== null, true, 'the vendor is on the record');
      assert.equal(invocation.connectionKind, 'api');
      assert.equal(invocation.billing, 'api-metered');
      assert.equal(invocation.totalTokens, 1200);
      assert.equal(invocation.costUsd, 0.01);
      assert.equal(invocation.failureKind, null);
    }
  } finally {
    await t.cleanup();
  }
});

test('a conversation run reports its cost, in words that do not promise a provider-enforced cap', async () => {
  const t = await conversationTeam();
  try {
    const sent = value<{ run: { id: string } }>(
      await t.fixture.router.handle('chat.sendMessage', { sessionId: t.sessionId, text: 'compare' }),
    );
    await t.fixture.services.orchestration.waitFor(sent.run.id);
    const said = messages(t.fixture, t.sessionId);
    assert.ok(
      said.some((m) => /Consumo desta execução: .*chamada\(s\)/.test(m.body)),
      'the run must say what it consumed',
    );
  } finally {
    await t.cleanup();
  }
});

test('the orchestrator cannot end a conversation run without an answer', async () => {
  const orchestrator = new ScriptedProvider(
    'openai-api',
    'Codex',
    [
      // Says done, but with nothing to show the person and a criterion it
      // declared and never addressed.
      JSON.stringify({
        action: 'done',
        acceptanceCriteria: ['a recomendação está justificada'],
        verificationCommands: [],
        summary: 'ok',
      }),
      JSON.stringify({ action: 'blocked', reason: 'não consigo responder', acceptanceCriteria: [], verificationCommands: [] }),
    ],
    conversationCapabilities('openai'),
    'conn-openai',
  );
  const worker = new ScriptedProvider(
    'anthropic-api',
    'Claude',
    ['...'],
    conversationCapabilities('anthropic'),
    'conn-claude',
  );
  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    maxIterations: 2,
  });
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.createConversation', { name: 'Conversa' }),
    );
    await bindTeam(fixture, workspace.id, ['Claude Trabalho 1']);
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'x' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'responda' }),
    );
    const run = await fixture.services.orchestration.waitFor(sent.run.id);

    assert.notEqual(run.status, 'DONE');
    const gate = steps(fixture, sent.run.id).find((s) => s.phase === 'done-gate');
    assert.equal(gate?.status, 'rejected');
    // Rejected for the two real reasons, and for no invented one: the gate
    // must not mention a diff or a test in a run that had neither.
    assert.match(gate!.summary ?? '', /final answer|never addressed/);
    assert.doesNotMatch(gate!.summary ?? '', /No file changed|Verification command/);
    // And the rejection went back to the orchestrator verbatim.
    assert.match(orchestrator.calls[1]!.prompt, /DONE_REJECTED/);
  } finally {
    await fixture.cleanup();
  }
});

test('a worker that cannot execute tools is refused a coding delegation, and told why', async () => {
  const orchestrator = new ScriptedProvider(
    'openai-api',
    'Codex',
    [
      // Asks a model-API worker to change a file. This must not be attempted.
      JSON.stringify({
        action: 'delegate',
        workerId: 'worker-1',
        requiresTools: true,
        task: 'Edite src/app.ts e corrija o bug.',
        acceptanceCriteria: [],
        verificationCommands: [],
      }),
      JSON.stringify({
        action: 'blocked',
        reason: 'nenhum worker deste projeto edita arquivos',
        acceptanceCriteria: [],
        verificationCommands: [],
      }),
    ],
    conversationCapabilities('openai'),
    'conn-openai',
  );
  const apiWorker = new ScriptedProvider(
    'anthropic-api',
    'Claude Trabalho 1',
    ['Editei o arquivo com sucesso.'], // exactly the claim that must not count
    conversationCapabilities('anthropic'),
    'conn-claude-1',
  );
  const fixture = createDesktopFixture({
    createRunners: async () => ({
      orchestrator,
      worker: apiWorker,
      workerAccountId: null,
      workers: [
        {
          id: 'worker-1',
          label: 'Claude Trabalho 1',
          runner: apiWorker,
          accountId: null,
          providerId: 'anthropic',
          connectionKind: 'api',
          agentId: null,
        },
      ],
    }),
    maxIterations: 2,
  });
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.createConversation', { name: 'Conversa' }),
    );
    await bindTeam(fixture, workspace.id, ['Claude Trabalho 1']);
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'x' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'corrija' }),
    );
    await fixture.services.orchestration.waitFor(sent.run.id);

    // The worker was never called: the refusal happens before the invocation.
    assert.equal(apiWorker.calls.length, 0, 'a worker without an executor must not be asked to edit');
    const refusal = steps(fixture, sent.run.id).find((s) => s.phase === 'delegation');
    assert.equal(refusal?.status, 'refused');
    assert.match(refusal!.summary ?? '', /não edita arquivos/);
    // And the orchestrator was told, in terms it can act on.
    assert.match(orchestrator.calls[1]!.prompt, /WORKER_CANNOT_EXECUTE_TOOLS/);
  } finally {
    await fixture.cleanup();
  }
});

test('a delegation to a worker the team does not have is refused with the real list', async () => {
  const orchestrator = new ScriptedProvider(
    'openai-api',
    'Codex',
    [
      JSON.stringify({
        action: 'delegate',
        workerId: 'worker-9',
        requiresTools: false,
        task: 'faça algo',
        acceptanceCriteria: [],
        verificationCommands: [],
      }),
      JSON.stringify({ action: 'blocked', reason: 'errei o worker', acceptanceCriteria: [], verificationCommands: [] }),
    ],
    conversationCapabilities('openai'),
    'conn-openai',
  );
  const worker = new ScriptedProvider(
    'anthropic-api',
    'Claude Trabalho 1',
    ['pronto'],
    conversationCapabilities('anthropic'),
    'conn-claude-1',
  );
  const fixture = createDesktopFixture({
    createRunners: async () => ({
      orchestrator,
      worker,
      workerAccountId: null,
      workers: [
        {
          id: 'worker-1',
          label: 'Claude Trabalho 1',
          runner: worker,
          accountId: null,
          providerId: 'anthropic',
          connectionKind: 'api',
          agentId: null,
        },
      ],
    }),
    maxIterations: 2,
  });
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.createConversation', { name: 'Conversa' }),
    );
    await bindTeam(fixture, workspace.id, ['Claude Trabalho 1']);
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'x' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'vai' }),
    );
    await fixture.services.orchestration.waitFor(sent.run.id);

    assert.equal(worker.calls.length, 0, 'an unknown worker id is never silently redirected');
    assert.match(orchestrator.calls[1]!.prompt, /UNKNOWN_WORKER/);
    assert.match(orchestrator.calls[1]!.prompt, /worker-1 \(Claude Trabalho 1\)/);
  } finally {
    await fixture.cleanup();
  }
});

/* ================================================================== *
 * Cost controls, in the loop
 * ================================================================== */

test('a run stops at its cost limit, as NEEDS_HUMAN, without making the next call', async () => {
  const expensive: InvocationUsage = {
    billing: 'api-metered',
    inputTokens: 100_000,
    outputTokens: 10_000,
    totalTokens: 110_000,
    costUsd: 0.6,
  };
  const orchestrator = new ScriptedProvider(
    'openai-api',
    'Codex',
    [
      JSON.stringify({
        action: 'delegate',
        requiresTools: false,
        task: 'pense muito',
        acceptanceCriteria: [],
        verificationCommands: [],
      }),
    ],
    conversationCapabilities('openai'),
    'conn-openai',
    expensive,
  );
  const worker = new ScriptedProvider(
    'anthropic-api',
    'Claude',
    ['pensei'],
    conversationCapabilities('anthropic'),
    'conn-claude',
    expensive,
  );
  const fixture = createDesktopFixture({
    createRunners: async () => ({
      orchestrator,
      worker,
      workerAccountId: null,
      budget: { maxCostUsd: 1 },
    }),
    maxIterations: 8,
  });
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.createConversation', { name: 'Conversa' }),
    );
    await bindTeam(fixture, workspace.id, ['Claude Trabalho 1']);
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'x' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'pense' }),
    );
    const run = await fixture.services.orchestration.waitFor(sent.run.id);

    // Two calls at $0.60 is $1.20; the third is refused before it is made.
    assert.equal(orchestrator.calls.length + worker.calls.length, 2);
    assert.equal(run.status, 'NEEDS_HUMAN', 'a budget stop is not a failure');
    const stop = steps(fixture, sent.run.id).find((s) => s.phase === 'budget');
    assert.equal(stop?.status, 'stopped');
    assert.match(stop!.summary ?? '', /Nenhuma nova chamada foi feita/);
    assert.match(stop!.summary ?? '', /não é um teto cobrado pelo provider/);
  } finally {
    await fixture.cleanup();
  }
});

test('an empty balance stops the run instead of being retried until the iteration limit', async () => {
  const orchestrator = new ScriptedProvider(
    'openai-api',
    'Codex',
    [
      JSON.stringify({
        action: 'delegate',
        requiresTools: false,
        task: 'faça',
        acceptanceCriteria: [],
        verificationCommands: [],
      }),
    ],
    conversationCapabilities('openai'),
    'conn-openai',
  );
  // A worker whose provider is out of credit, every time.
  const broke = new (class extends ScriptedProvider {
    override async run(input: AgentInput) {
      const result = await super.run(input);
      return {
        ...result,
        outcome: 'spawn-error' as const,
        exitCode: 400,
        stdout: '',
        stderr: 'sem saldo',
        error: 'A conta está sem saldo.',
        failure: 'insufficient-credit' as const,
      };
    }
  })('anthropic-api', 'Claude', [''], conversationCapabilities('anthropic'), 'conn-claude');

  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker: broke, workerAccountId: null }),
    maxIterations: 8,
  });
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.createConversation', { name: 'Conversa' }),
    );
    await bindTeam(fixture, workspace.id, ['Claude Trabalho 1']);
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'x' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'vai' }),
    );
    const run = await fixture.services.orchestration.waitFor(sent.run.id);

    assert.equal(run.status, 'NEEDS_HUMAN');
    assert.equal(broke.calls.length, 1, 'an empty balance is never retried');
    assert.ok(
      messages(fixture, session.id).some((m) => /sem saldo ou fora da cota/.test(m.body)),
      'the person is told what actually stopped it',
    );
  } finally {
    await fixture.cleanup();
  }
});

/* ================================================================== *
 * Coding mode: still strict
 * ================================================================== */

test('E2E: a coding run finishes only on a real file, real evidence and a re-run verification', async () => {
  const repo: GitFixture = createGitFixture('lao-modes-');
  repo.write('README.md', '# scratch\n');
  repo.write(
    'check.mjs',
    [
      "import { existsSync, readFileSync, readdirSync } from 'node:fs';",
      "let actual = null;",
      "try { actual = readFileSync('hello.txt', 'utf8').trim(); } catch { actual = null; }",
      "if (actual !== 'pronto') { console.error('hello.txt is ' + JSON.stringify(actual)); process.exit(1); }",
      "console.log('ok');",
    ].join('\n'),
  );
  repo.commitAll('baseline');

  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', [
    JSON.stringify({
      action: 'delegate',
      workerId: 'worker-1',
      requiresTools: true,
      task: 'Crie hello.txt com "pronto".',
      acceptanceCriteria: ['hello.txt existe com o conteúdo exato'],
      verificationCommands: ['hello-exists'],
    }),
    JSON.stringify({
      action: 'done',
      acceptanceCriteria: ['hello.txt existe com o conteúdo exato'],
      verificationCommands: ['hello-exists'],
      summary: 'Feito.',
    }),
  ]);

  // A worker that declares a real executor - and actually uses one: it writes
  // the file. That is the difference this whole design turns on.
  const worker = new ScriptedProvider(
    'claude-code',
    'Claude Code',
    [
      (input: AgentInput) => {
        repo.write('hello.txt', 'pronto\n');
        return `escrevi hello.txt em ${input.workingDirectory}`;
      },
    ],
    codingCapabilities('anthropic'),
    'conn-claude-cli',
  );

  const fixture = createDesktopFixture({
    createRunners: async () => ({
      orchestrator,
      worker,
      workerAccountId: null,
      workers: [
        {
          id: 'worker-1',
          label: 'Claude Code',
          runner: worker,
          accountId: null,
          providerId: 'anthropic',
          connectionKind: 'cli',
          agentId: null,
        },
      ],
    }),
    maxIterations: 3,
  });

  try {
    const workspace = value<{ id: string; environment: string }>(
      await fixture.router.handle('workspace.create', { name: 'Scratch', localPath: repo.dir }),
    );
    assert.equal(workspace.environment, 'local', 'the local mode is untouched');
    await bindTeam(fixture, workspace.id, ['Claude Code']);
    fixture.services.database.verifications.upsert({
      workspaceId: workspace.id,
      id: 'hello-exists',
      label: 'hello.txt tem o conteúdo exato',
      command: 'node check.mjs',
    });
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'x' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', {
        sessionId: session.id,
        text: 'Crie hello.txt',
      }),
    );
    const run = await fixture.services.orchestration.waitFor(sent.run.id);

    assert.equal(run.status, 'DONE');
    // The file is really there, with the content the verification demanded.
    assert.equal(readFileSync(join(repo.dir, 'hello.txt'), 'utf8').trim(), 'pronto');

    const record = fixture.services.database.runs.require(sent.run.id) as unknown as { kind: string };
    assert.equal(record.kind, 'coding', 'a project with a folder runs the coding gate');

    const phases = steps(fixture, sent.run.id);
    assert.ok(phases.some((s) => s.phase === 'baseline'), 'a coding run captures a baseline');
    assert.ok(
      phases.some((s) => s.phase === 'evidence' && s.status === 'changed'),
      'evidence is collected from git, not taken from the worker',
    );
    assert.equal(phases.find((s) => s.phase === 'done-gate')?.status, 'passed');
    // The verification really ran, and is on the record.
    const verifications = fixture.services.database.runs.verifications(sent.run.id) as Array<{
      command: string;
      passed: number;
    }>;
    assert.ok(verifications.length > 0);
    assert.ok(verifications.every((v) => v.passed === 1));
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});

test('a coding run is still refused when the worker only claims to have changed something', async () => {
  const repo: GitFixture = createGitFixture('lao-modes-liar-');
  repo.write('README.md', '# scratch\n');
  repo.commitAll('baseline');

  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', [
    JSON.stringify({
      action: 'delegate',
      requiresTools: true,
      task: 'Crie hello.txt.',
      acceptanceCriteria: ['hello.txt existe'],
      verificationCommands: [],
    }),
    JSON.stringify({
      action: 'done',
      acceptanceCriteria: ['hello.txt existe'],
      verificationCommands: [],
      summary: 'Feito.',
    }),
    JSON.stringify({ action: 'blocked', reason: 'não consegui', acceptanceCriteria: [], verificationCommands: [] }),
  ]);
  // Says it wrote the file. Writes nothing. The gate must not believe it.
  const liar = new ScriptedAgent('mock-claude', 'Claude', ['Criei hello.txt com sucesso.']);

  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker: liar, workerAccountId: null }),
    maxIterations: 3,
  });
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.create', { name: 'Scratch', localPath: repo.dir }),
    );
    await bindTeam(fixture, workspace.id, ['Claude Trabalho 1']);
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'x' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'crie' }),
    );
    const run = await fixture.services.orchestration.waitFor(sent.run.id);

    assert.notEqual(run.status, 'DONE');
    const gate = steps(fixture, sent.run.id).find((s) => s.phase === 'done-gate');
    assert.equal(gate?.status, 'rejected');
    assert.match(gate!.summary ?? '', /No file changed/);
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});

/* ================================================================== *
 * Session continuity
 * ================================================================== */

test('a worker continues its own session between delegations, and never another account\'s', async () => {
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', [
    JSON.stringify({
      action: 'delegate',
      workerId: 'worker-1',
      requiresTools: false,
      task: 'primeira tarefa',
      acceptanceCriteria: [],
      verificationCommands: [],
    }),
    JSON.stringify({
      action: 'delegate',
      workerId: 'worker-2',
      requiresTools: false,
      task: 'tarefa do outro worker',
      acceptanceCriteria: [],
      verificationCommands: [],
    }),
    JSON.stringify({
      action: 'delegate',
      workerId: 'worker-1',
      requiresTools: false,
      task: 'segunda tarefa para o primeiro',
      acceptanceCriteria: [],
      verificationCommands: [],
    }),
    JSON.stringify({
      action: 'done',
      acceptanceCriteria: [],
      verificationCommands: [],
      summary: 'Pronto, com uma resposta final de tamanho suficiente.',
    }),
  ]);

  const one = new ScriptedAgent('mock-claude', 'Claude Trabalho 1', ['ok 1']);
  one.sessionId = 'session-of-account-one';
  const two = new ScriptedAgent('mock-claude', 'Claude Trabalho 2', ['ok 2']);
  two.sessionId = 'session-of-account-two';

  let bound: Array<{ agentId: string; accountId: string | null }> = [];
  const fixture = createDesktopFixture({
    createRunners: async () => ({
      orchestrator,
      worker: one,
      workerAccountId: bound[0]?.accountId ?? null,
      workers: [
        {
          id: 'worker-1',
          label: 'Claude Trabalho 1',
          runner: one,
          accountId: bound[0]?.accountId ?? null,
          providerId: 'anthropic',
          connectionKind: 'cli',
          agentId: bound[0]?.agentId ?? null,
        },
        {
          id: 'worker-2',
          label: 'Claude Trabalho 2',
          runner: two,
          accountId: bound[1]?.accountId ?? null,
          providerId: 'anthropic',
          connectionKind: 'cli',
          agentId: bound[1]?.agentId ?? null,
        },
      ],
    }),
    maxIterations: 5,
  });

  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.createConversation', { name: 'Conversa' }),
    );
    bound = await bindTeam(fixture, workspace.id, ['Claude Trabalho 1', 'Claude Trabalho 2']);
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'x' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'vai' }),
    );
    await fixture.services.orchestration.waitFor(sent.run.id);

    // Worker 1's first call started a session; its second continued that one.
    assert.equal(one.calls.length, 2);
    assert.equal(one.calls[0]!.resumeSessionId ?? null, null, 'the first call starts a session');
    assert.equal(
      one.calls[1]!.resumeSessionId,
      'session-of-account-one',
      'the second call continues the session this worker made',
    );

    // Worker 2 started its own, and was never handed worker 1's.
    assert.equal(two.calls.length, 1);
    assert.equal(two.calls[0]!.resumeSessionId ?? null, null);

    // And the record keeps them apart: one row per connection.
    const stored = fixture.services.database.agentSessions.listForChatSession(session.id);
    assert.equal(stored.length, 2);
    const byConnection = new Map(stored.map((r) => [r.connection_id, r.provider_session_id]));
    assert.equal(byConnection.get(bound[0]!.accountId!), 'session-of-account-one');
    assert.equal(byConnection.get(bound[1]!.accountId!), 'session-of-account-two');
  } finally {
    await fixture.cleanup();
  }
});

test('a worker that reports no session simply starts fresh, with nothing promised', async () => {
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', [
    JSON.stringify({
      action: 'delegate',
      requiresTools: false,
      task: 'a',
      acceptanceCriteria: [],
      verificationCommands: [],
    }),
    JSON.stringify({
      action: 'delegate',
      requiresTools: false,
      task: 'b',
      acceptanceCriteria: [],
      verificationCommands: [],
    }),
    JSON.stringify({
      action: 'done',
      acceptanceCriteria: [],
      verificationCommands: [],
      summary: 'Uma resposta final suficientemente longa.',
    }),
  ]);
  // No sessionId: a build without --resume, or one that did not report one.
  const worker = new ScriptedAgent('mock-claude', 'Claude', ['ok']);

  let bound: Array<{ agentId: string; accountId: string | null }> = [];
  const fixture = createDesktopFixture({
    createRunners: async () => ({
      orchestrator,
      worker,
      workerAccountId: bound[0]?.accountId ?? null,
      workers: [
        {
          id: 'worker-1',
          label: 'Claude',
          runner: worker,
          accountId: bound[0]?.accountId ?? null,
          providerId: 'anthropic',
          connectionKind: 'cli',
          agentId: bound[0]?.agentId ?? null,
        },
      ],
    }),
    maxIterations: 4,
  });
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.createConversation', { name: 'Conversa' }),
    );
    bound = await bindTeam(fixture, workspace.id, ['Claude']);
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'x' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'vai' }),
    );
    await fixture.services.orchestration.waitFor(sent.run.id);

    assert.equal(worker.calls.length, 2);
    for (const call of worker.calls) {
      assert.equal(call.resumeSessionId ?? null, null, 'nothing is resumed that was never reported');
    }
    assert.equal(fixture.services.database.agentSessions.listForChatSession(session.id).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('a conversation run gives its agents an empty directory the app owns, never the one it was launched from', async () => {
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', [
    JSON.stringify({
      action: 'delegate',
      requiresTools: false,
      task: 'analise',
      acceptanceCriteria: [],
      verificationCommands: [],
    }),
    JSON.stringify({
      action: 'done',
      acceptanceCriteria: [],
      verificationCommands: [],
      summary: 'Uma resposta final suficientemente longa para o gate.',
    }),
  ]);
  const worker = new ScriptedAgent('mock-claude', 'Claude', ['respondi']);

  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    maxIterations: 3,
  });
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.createConversation', { name: 'Conversa' }),
    );
    await bindTeam(fixture, workspace.id, ['Claude']);
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'x' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'analise' }),
    );
    await fixture.services.orchestration.waitFor(sent.run.id);

    // Both agents ran somewhere real, under the application's own root, and
    // not in whatever directory this process happens to be in. The official
    // CLIs read the working directory's CLAUDE.md, hooks and MCP servers, so
    // an inherited folder would run another project's configuration in a run
    // that has no project.
    const expected = join(fixture.paths.conversations, workspace.id);
    for (const call of [...orchestrator.calls, ...worker.calls]) {
      assert.equal(call.workingDirectory, expected);
    }
    assert.notEqual(expected, process.cwd());
    assert.ok(existsSync(expected), 'and the directory really exists');
    // Empty is the point: there is nothing in it for a CLI to pick up.
    assert.deepEqual(readdirSync(expected), []);
  } finally {
    await fixture.cleanup();
  }
});
