/**
 * The exchange, end to end (spec 22).
 *
 * The thing the person asked for is that they send an objective once and the
 * agents talk to each other from there. That already happens; what did not
 * exist was any way to *see* it happening, or to tell an exchange that stalled
 * from one that was merely slow.
 *
 * These tests run the whole loop with scripted agents and then read the
 * message table, because the table is the claim: every delegation the
 * orchestrator made, every answer that came back, what the application
 * observed for itself, and how the run ended.
 *
 * Scripted agents prove the loop, the contract and the gates. They prove
 * nothing at all about a vendor: only a real call does that, and that is a
 * human gate. See docs/PROVIDER_IMPLEMENTATION_HANDOFF.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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

const USAGE: InvocationUsage = {
  billing: 'api-metered',
  inputTokens: 500,
  outputTokens: 100,
  totalTokens: 600,
  costUsd: 0.005,
};

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

/** The exchange, as `type:status` pairs in order. */
function exchange(fixture: DesktopFixture, runId: string): string[] {
  return fixture.services.orchestration.bus
    .listForRun(runId)
    .map((message) => `${message.messageType}:${message.status}`);
}

function ofType(fixture: DesktopFixture, runId: string, type: string) {
  return fixture.services.orchestration.bus
    .listForRun(runId)
    .filter((message) => message.messageType === type);
}

/* ================================================================== *
 * The two-worker exchange
 * ================================================================== */

async function conversationTeam(): Promise<{
  fixture: DesktopFixture;
  sessionId: string;
  cleanup(): Promise<void>;
}> {
  const orchestrator = new ScriptedProvider(
    'openai-api',
    'Codex',
    [
      JSON.stringify({
        action: 'delegate',
        workerId: 'worker-1',
        requiresTools: false,
        task: 'Analise as duas abordagens.',
        acceptanceCriteria: ['as abordagens foram comparadas', 'há uma recomendação'],
        verificationCommands: [],
        summary: 'Vou pedir a análise ao Claude Trabalho 1.',
      }),
      JSON.stringify({
        action: 'delegate',
        workerId: 'worker-2',
        requiresTools: false,
        task: 'Revise a análise anterior.',
        acceptanceCriteria: [],
        verificationCommands: [],
        satisfiedCriteria: ['as abordagens foram comparadas'],
        summary: 'Vou pedir uma revisão ao Claude Trabalho 2.',
      }),
      JSON.stringify({
        action: 'done',
        acceptanceCriteria: [],
        verificationCommands: [],
        satisfiedCriteria: ['há uma recomendação'],
        summary: 'A abordagem B é mais simples, e a revisão confirmou o custo baixo de migração.',
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

  const workspace = value<{ id: string }>(
    await fixture.router.handle('workspace.createConversation', { name: 'Arquitetura' }),
  );
  bound = await bindTeam(fixture, workspace.id, ['Claude Trabalho 1', 'Claude Trabalho 2']);
  const session = value<{ id: string }>(
    await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'Comparar' }),
  );

  return { fixture, sessionId: session.id, cleanup: () => fixture.cleanup() };
}

test('E2E: one objective, and the whole exchange is on the record without anyone copying a prompt', async () => {
  const t = await conversationTeam();
  try {
    // The person acts once. Everything after this is the application.
    const sent = value<{ run: { id: string } }>(
      await t.fixture.router.handle('chat.sendMessage', {
        sessionId: t.sessionId,
        text: 'Qual das duas abordagens é mais simples de manter?',
      }),
    );
    const run = await t.fixture.services.orchestration.waitFor(sent.run.id);
    assert.equal(run.status, 'DONE');

    // Codex → Claude 1 → Codex → Claude 2 → Codex → DONE, as messages.
    // A notice is final when it is written; only a delegation is a request
    // somebody owes an answer to, and each of those was answered.
    assert.deepEqual(exchange(t.fixture, run.id), [
      'USER_OBJECTIVE:completed',
      'ORCHESTRATOR_DECISION:completed',
      'DELEGATION:completed',
      'WORKER_RESULT:completed',
      'ORCHESTRATOR_DECISION:completed',
      'DELEGATION:completed',
      'WORKER_RESULT:completed',
      'ORCHESTRATOR_DECISION:completed',
      'RUN_COMPLETED:completed',
    ]);
    // Nothing in a successful run is left looking abandoned.
    assert.equal(
      exchange(t.fixture, run.id).filter((entry) => entry.endsWith(':cancelled')).length,
      0,
      'a run that went perfectly must not read as one that was aborted',
    );

    // Each delegation went to the worker the orchestrator named, and each was
    // delivered, started and finished rather than merely sent.
    const delegations = ofType(t.fixture, run.id, 'DELEGATION');
    assert.deepEqual(
      delegations.map((message) => message.recipientAgentId),
      ['worker-1', 'worker-2'],
    );
    for (const delegation of delegations) {
      assert.equal(delegation.senderAgentId, 'orchestrator');
      assert.equal(delegation.attempts, 1, 'delivered exactly once');
      assert.equal(delegation.leaseExpiresAt, null, 'and the lease was given back');
    }

    // Every answer is tied to the request that caused it.
    const results = ofType(t.fixture, run.id, 'WORKER_RESULT');
    assert.deepEqual(
      results.map((message) => message.causationId),
      delegations.map((message) => message.messageId),
    );
    // And the whole run is one exchange, so the timeline is one thread.
    const correlations = new Set(
      t.fixture.services.orchestration.bus.listForRun(run.id).map((m) => m.correlationId),
    );
    assert.equal(correlations.size, 1);
  } finally {
    await t.cleanup();
  }
});

test('nothing is left looking outstanding when the run ends', async () => {
  const t = await conversationTeam();
  try {
    const sent = value<{ run: { id: string } }>(
      await t.fixture.router.handle('chat.sendMessage', { sessionId: t.sessionId, text: 'Compare.' }),
    );
    const run = await t.fixture.services.orchestration.waitFor(sent.run.id);

    const stuck = t.fixture.services.orchestration.bus
      .listForRun(run.id)
      .filter((message) => message.status === 'leased' || message.status === 'started');
    assert.deepEqual(stuck, [], 'a finished run must leave nothing in flight');
    // The run's ending is itself a message, so "it just stopped" is not a
    // state the history can be in.
    assert.equal(ofType(t.fixture, run.id, 'RUN_COMPLETED').length, 1);
  } finally {
    await t.cleanup();
  }
});

/* ================================================================== *
 * The coding exchange
 * ================================================================== */

test('E2E: hello.txt, with the exchange, the evidence and the verification on the record', async () => {
  const repo: GitFixture = createGitFixture('lao-exchange-');
  repo.write('README.md', '# scratch\n');
  // A verification that reads the bytes, so DONE rests on the file's content
  // and not on anyone's report of it.
  repo.write(
    'check.mjs',
    [
      "import { readFileSync } from 'node:fs';",
      'let actual = null;',
      "try { actual = readFileSync('hello.txt', 'utf8'); } catch { actual = null; }",
      "if (actual !== 'pronto') { console.error('hello.txt is ' + JSON.stringify(actual)); process.exit(1); }",
      "console.log('ok');",
    ].join('\n'),
  );
  repo.commitAll('baseline');
  const written = join(repo.dir, 'hello.txt');

  const orchestrator = new ScriptedProvider(
    'openai-api',
    'Codex',
    [
      JSON.stringify({
        action: 'delegate',
        workerId: 'worker-1',
        requiresTools: true,
        task: 'Crie hello.txt com exatamente o texto pronto.',
        acceptanceCriteria: ['hello.txt existe com o conteúdo pronto'],
        verificationCommands: ['hello-exists'],
        summary: 'Vou pedir ao Claude que crie o arquivo.',
      }),
      JSON.stringify({
        action: 'done',
        acceptanceCriteria: ['hello.txt existe com o conteúdo pronto'],
        verificationCommands: ['hello-exists'],
        satisfiedCriteria: ['hello.txt existe com o conteúdo pronto'],
        summary: 'O arquivo existe, a evidência mostra a mudança e a verificação confere o conteúdo.',
      }),
    ],
    conversationCapabilities('openai'),
    'conn-openai',
    USAGE,
  );
  // A worker with a real executor: it writes the file, which is the only thing
  // that makes the evidence below real.
  const claude = new ScriptedProvider(
    'claude-code',
    'Claude Trabalho 1',
    [
      async (input: AgentInput) => {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(join(input.workingDirectory, 'hello.txt'), 'pronto', 'utf8');
        return 'Criei hello.txt.';
      },
    ],
    codingCapabilities('anthropic'),
    'conn-claude-1',
    USAGE,
  );

  let bound: Array<{ agentId: string; accountId: string | null }> = [];
  const fixture = createDesktopFixture({
    createRunners: async () => ({
      orchestrator,
      worker: claude,
      workerAccountId: bound[0]?.accountId ?? null,
      workers: [
        {
          id: 'worker-1',
          label: 'Claude Trabalho 1',
          runner: claude,
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
      await fixture.router.handle('workspace.create', { name: 'Projeto', localPath: repo.dir }),
    );
    bound = await bindTeam(fixture, workspace.id, ['Claude Trabalho 1']);
    fixture.services.database.verifications.upsert({
      workspaceId: workspace.id,
      id: 'hello-exists',
      label: 'hello.txt tem exatamente o conteúdo pronto',
      command: 'node check.mjs',
    });
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'hello' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', {
        sessionId: session.id,
        text: 'Crie hello.txt com o texto pronto.',
      }),
    );
    const run = await fixture.services.orchestration.waitFor(sent.run.id);

    // The file is real, byte for byte.
    assert.ok(existsSync(written), 'the worker must have written a real file');
    assert.deepEqual([...readFileSync(written)], [0x70, 0x72, 0x6f, 0x6e, 0x74, 0x6f]);
    assert.equal(run.status, 'DONE');

    // And the record says how it got there.
    const types = exchange(fixture, run.id).map((entry) => entry.split(':')[0]);
    assert.ok(types.includes('DELEGATION'));
    assert.ok(types.includes('WORKER_RESULT'));
    assert.ok(types.includes('EVIDENCE_READY'));
    assert.ok(types.includes('VERIFICATION_RESULT'));
    assert.ok(types.includes('RUN_COMPLETED'));

    // The verification really ran, and passed on the real bytes.
    const verified = ofType(fixture, run.id, 'VERIFICATION_RESULT');
    assert.equal(verified[0]!.senderAgentId, null, 'a check an agent could sign checks nothing');
    const counts = verified.at(-1)!.payload as { passed: number; total: number };
    assert.ok(counts.total >= 1);
    assert.equal(counts.passed, counts.total);

    // The evidence message is the application's own observation, not an
    // agent's claim - which is exactly why it has no sender.
    const evidence = ofType(fixture, run.id, 'EVIDENCE_READY');
    assert.ok(evidence.length >= 1);
    assert.equal(evidence[0]!.senderAgentId, null, 'evidence is never signed by an agent');
    const payload = evidence[0]!.payload as { changed: boolean; files: number; source: string | null };
    assert.equal(payload.changed, true);
    assert.ok(payload.files >= 1);
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});

/* ================================================================== *
 * When it goes wrong
 * ================================================================== */

test('a refused tool closes the delegation as dead, and is not delivered again', async () => {
  const orchestrator = new ScriptedProvider(
    'openai-api',
    'Codex',
    [
      JSON.stringify({
        action: 'delegate',
        workerId: 'worker-1',
        requiresTools: true,
        task: 'Crie hello.txt.',
        acceptanceCriteria: ['hello.txt existe'],
        verificationCommands: [],
        summary: 'Vou pedir ao Claude.',
      }),
    ],
    conversationCapabilities('openai'),
    'conn-openai',
    USAGE,
  );
  // Exactly what the adapter produces from an exit-0 envelope reporting a
  // refusal: a named failure, and the tool that was refused.
  const refused = new (class extends ScriptedProvider {
    override async run(input: AgentInput) {
      const result = await super.run(input);
      return {
        ...result,
        exitCode: 1,
        stdout: 'Não consegui criar o arquivo.',
        stderr: 'Ferramentas recusadas nesta execução: Write.',
        failure: 'tool-permission-denied' as const,
        permissionDenials: ['Write'],
      };
    }
  })(
    'claude-code',
    'Claude Trabalho 1',
    [''],
    codingCapabilities('anthropic'),
    'conn-claude-1',
    USAGE,
  );

  const repo = createGitFixture('lao-exchange-denied-');
  repo.write('README.md', '# scratch\n');
  repo.commitAll('baseline');
  let bound: Array<{ agentId: string; accountId: string | null }> = [];
  const fixture = createDesktopFixture({
    createRunners: async () => ({
      orchestrator,
      worker: refused,
      workerAccountId: bound[0]?.accountId ?? null,
      workers: [
        {
          id: 'worker-1',
          label: 'Claude Trabalho 1',
          runner: refused,
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
      await fixture.router.handle('workspace.create', { name: 'Projeto', localPath: repo.dir }),
    );
    bound = await bindTeam(fixture, workspace.id, ['Claude Trabalho 1']);
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'hello' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'Crie hello.txt.' }),
    );
    const run = await fixture.services.orchestration.waitFor(sent.run.id);

    assert.equal(run.status, 'NEEDS_HUMAN');
    const delegations = ofType(fixture, run.id, 'DELEGATION');
    assert.equal(delegations.length, 1, 'a refused permission is asked for once, not five times');
    assert.equal(delegations[0]!.status, 'dead');
    assert.match(delegations[0]!.failureReason ?? '', /refused a tool|recusad/i);
    // Nothing is waiting to be tried again: another delivery cannot grant a
    // permission that was denied.
    assert.equal(fixture.services.orchestration.bus.claim('worker-1'), undefined);
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});

test('cancelling a run stops the exchange and keeps what already happened', async () => {
  const t = await conversationTeam();
  try {
    const sent = value<{ run: { id: string } }>(
      await t.fixture.router.handle('chat.sendMessage', { sessionId: t.sessionId, text: 'Compare.' }),
    );
    const run = await t.fixture.services.orchestration.waitFor(sent.run.id);

    // Cancelling a finished run must not rewrite its history.
    const before = exchange(t.fixture, run.id);
    t.fixture.services.orchestration.bus.cancelRun(run.id, 'teste');
    assert.deepEqual(exchange(t.fixture, run.id), before, 'terminal messages are never reopened');
  } finally {
    await t.cleanup();
  }
});

test('a run interrupted by the application closing leaves nothing pretending to be in flight', async () => {
  const t = await conversationTeam();
  try {
    const sent = value<{ run: { id: string } }>(
      await t.fixture.router.handle('chat.sendMessage', { sessionId: t.sessionId, text: 'Compare.' }),
    );
    const run = await t.fixture.services.orchestration.waitFor(sent.run.id);

    // A message the previous process left behind, of the kind a crash creates.
    const orphan = t.fixture.services.orchestration.bus.publish({
      runId: run.id,
      conversationId: t.sessionId,
      iteration: 99,
      messageType: 'DELEGATION',
      payload: { task: 'algo que nunca foi respondido' },
      senderAgentId: 'orchestrator',
      recipientAgentId: 'worker-1',
    });
    t.fixture.services.orchestration.bus.claim('worker-1');
    t.fixture.services.database.runs.setStatus(run.id, 'RUNNING');

    const reconciled = t.fixture.services.orchestration.reconcileInterrupted();
    assert.ok(reconciled >= 1);
    // Closed, not redelivered: re-sending an instruction that may already have
    // written a file is the non-idempotent retry the design forbids.
    const after = t.fixture.services.orchestration.bus.find(orphan.message.messageId);
    assert.equal(after?.status, 'cancelled');
    assert.match(after?.failureReason ?? '', /Interrompida/);
  } finally {
    await t.cleanup();
  }
});

/* ================================================================== *
 * Liveness reaches the window
 * ================================================================== */

test('while a worker works, the window is told how long and on what', async () => {
  const orchestrator = new ScriptedProvider(
    'openai-api',
    'Codex',
    [
      JSON.stringify({
        action: 'delegate',
        workerId: 'worker-1',
        requiresTools: false,
        task: 'Pense um pouco.',
        acceptanceCriteria: ['pensou'],
        verificationCommands: [],
        summary: 'Vou pedir ao Claude.',
      }),
      JSON.stringify({
        action: 'done',
        acceptanceCriteria: [],
        verificationCommands: [],
        satisfiedCriteria: ['pensou'],
        summary: 'Pronto.',
      }),
    ],
    conversationCapabilities('openai'),
    'conn-openai',
    USAGE,
  );
  // A worker that reports progress the way a streaming adapter does.
  const chatty = new ScriptedProvider(
    'anthropic-api',
    'Claude Trabalho 1',
    [
      (input: AgentInput) => {
        input.onActivity?.({
          startedAt: new Date().toISOString(),
          elapsedMs: 240_000,
          lastActivityAt: new Date().toISOString(),
          idleMs: 0,
          currentTool: 'Write',
          recent: [],
          idleTimeoutMs: 600_000,
        });
        return 'Pensei.';
      },
    ],
    conversationCapabilities('anthropic'),
    'conn-claude-1',
    USAGE,
  );

  let bound: Array<{ agentId: string; accountId: string | null }> = [];
  const fixture = createDesktopFixture({
    createRunners: async () => ({
      orchestrator,
      worker: chatty,
      workerAccountId: bound[0]?.accountId ?? null,
      workers: [
        {
          id: 'worker-1',
          label: 'Claude Trabalho 1',
          runner: chatty,
          accountId: bound[0]?.accountId ?? null,
          providerId: 'anthropic',
          connectionKind: 'api',
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
    bound = await bindTeam(fixture, workspace.id, ['Claude Trabalho 1']);
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'c' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'Pense.' }),
    );
    await fixture.services.orchestration.waitFor(sent.run.id);

    const activity = fixture.events.filter((event) => event.channel === 'run:activity');
    assert.equal(activity.length, 1, 'the interface must hear about a working agent');
    const payload = activity[0]!.payload as { label: string; currentTool: string | null; idleMs: number };
    // The sentence that replaces "executando automaticamente".
    assert.match(payload.label, /Claude Trabalho 1/);
    assert.match(payload.label, /executando há 4m00s/);
    assert.match(payload.label, /ferramenta: Write/);
    assert.equal(payload.currentTool, 'Write');

    // And it is ephemeral: liveness is not a row in the history.
    const stored = fixture.services.orchestration.bus
      .listForRun(sent.run.id)
      .map((message) => message.messageType);
    assert.ok(!stored.includes('WORKER_PROGRESS'), 'a heartbeat is not a durable message');
  } finally {
    await fixture.cleanup();
  }
});

test('the message events reach the window as the exchange happens', async () => {
  const t = await conversationTeam();
  try {
    const sent = value<{ run: { id: string } }>(
      await t.fixture.router.handle('chat.sendMessage', { sessionId: t.sessionId, text: 'Compare.' }),
    );
    await t.fixture.services.orchestration.waitFor(sent.run.id);

    const emitted = t.fixture.events
      .filter((event) => event.channel === 'run:message')
      .map((event) => (event.payload as { messageType: string; status: string }));
    assert.ok(emitted.length >= 8, `expected the exchange on the wire, saw ${emitted.length}`);
    // Delivered and finished are separate events, which is the point.
    assert.ok(emitted.some((e) => e.messageType === 'DELEGATION' && e.status === 'leased'));
    assert.ok(emitted.some((e) => e.messageType === 'DELEGATION' && e.status === 'started'));
    assert.ok(emitted.some((e) => e.messageType === 'DELEGATION' && e.status === 'completed'));
    // No payload rides on the event: the body is already a chat message.
    for (const event of t.fixture.events.filter((e) => e.channel === 'run:message')) {
      assert.ok(!('payload' in (event.payload as object) && (event.payload as { payload?: unknown }).payload));
    }
  } finally {
    await t.cleanup();
  }
});
