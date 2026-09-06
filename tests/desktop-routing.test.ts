/**
 * Automatic worker routing, inside the real loop.
 *
 * The router is unit-tested on its own; these tests prove the loop actually
 * asks it per delegation, hands the answer to the worker on that invocation,
 * records it, tells the orchestrator what ran, and reacts to what the CLI
 * says - a refused model, no progress, a changed account. Fake agents, real
 * git, real database, real DONE gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDesktopFixture, ScriptedAgent, type DesktopFixture } from './helpers/desktop-fixture.js';
import { createGitFixture, type GitFixture } from './helpers/git-fixture.js';
import { makeAgentResult, type AgentRunner } from '../src/agents/agent-runner.js';
import type { AgentInput, AgentResult, HealthStatus } from '../src/core/types.js';
import type { WorkerRuntimeCapabilities } from '../src/routing/provider-policy.js';
import { WORKER_SELECTIONS as CORE_SELECTIONS } from '../src/routing/tiers.js';
import {
  WORKER_SELECTIONS as SHARED_SELECTIONS,
  type IpcResult,
  type RunDetailView,
  type ChatMessageView,
  type WorkspaceView,
} from '../apps/desktop/src/shared/ipc-contract.js';
import type { RunnerPair } from '../apps/desktop/src/main/services/orchestration-service.js';

const EXPECTED = 'Olá AI Orchestrator';

/** Claude Code 2.1.263, as its --help declares it. */
const FULL: WorkerRuntimeCapabilities = {
  modelFlag: true,
  effortFlag: true,
  declaredModels: ['fable', 'opus', 'sonnet'],
  declaredEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
};

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

/** A worker whose behaviour is a function of the call and its routing. */
class RoutedWorker implements AgentRunner {
  readonly kind = 'mock-claude' as const;
  readonly label = 'Claude';
  readonly calls: AgentInput[] = [];
  constructor(private readonly behave: (input: AgentInput, call: number) => Partial<AgentResult> | void) {}
  async run(input: AgentInput): Promise<AgentResult> {
    this.calls.push(input);
    const startedAt = new Date().toISOString();
    const partial = this.behave(input, this.calls.length) ?? {};
    return makeAgentResult({ startedAt, stdout: 'ok', ...partial });
  }
  async cancel(): Promise<void> {}
  async healthCheck(): Promise<HealthStatus> {
    return { healthy: true };
  }
}

const delegate = (
  task: string,
  requirements: { capability: string; reasoning: string } | null,
): string =>
  JSON.stringify({
    action: 'delegate',
    task,
    acceptanceCriteria: ['hello.txt existe com o conteúdo exato'],
    verificationCommands: ['hello-exists'],
    summary: task,
    ...(requirements
      ? { workerRequirements: { ...requirements, rationale: null } }
      : {}),
  });

const done = (): string =>
  JSON.stringify({ action: 'done', acceptanceCriteria: [], verificationCommands: ['hello-exists'], summary: 'Pronto.' });

function writeHello(dir: string): void {
  writeFileSync(join(dir, 'hello.txt'), `${EXPECTED}\n`, 'utf8');
}

interface Prepared {
  fixture: DesktopFixture;
  repo: GitFixture;
  workspaceId: string;
  sessionId: string;
  orchestrator: ScriptedAgent;
  worker: RoutedWorker;
  /** Account ids the capabilities callback was asked for, in order. */
  capabilityReads: Array<string | null>;
  accounts: { first: string; second: string };
  run(text: string): Promise<{ id: string; status: string; summary: string | null }>;
  cleanup(): Promise<void>;
}

/**
 * A scratch repository with the hello.txt verification, one Codex account,
 * two Claude accounts, and runners whose worker routing reads the workspace's
 * persisted team - selection, manual choice and, per account, capabilities.
 */
async function prepare(options: {
  orchestratorScript: ReadonlyArray<string | ((input: AgentInput) => string)>;
  worker: RoutedWorker;
  capabilitiesFor?: (accountId: string | null) => WorkerRuntimeCapabilities;
  orchestratorRunner?: AgentRunner;
}): Promise<Prepared> {
  const repo = createGitFixture('lao-routing-');
  repo.write('README.md', '# scratch\n');
  repo.write(
    'check.mjs',
    [
      "import { readFileSync } from 'node:fs';",
      'let actual = null;',
      "try { actual = readFileSync('hello.txt', 'utf8').trim(); } catch { actual = null; }",
      `if (actual !== ${JSON.stringify(EXPECTED)}) { console.error('wrong: ' + actual); process.exit(1); }`,
      "console.log('ok');",
    ].join('\n'),
  );
  repo.commitAll('baseline');

  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', options.orchestratorScript);
  const capabilityReads: Array<string | null> = [];
  const fixture = createDesktopFixture({
    createRunners: async (workspace): Promise<RunnerPair> => {
      const agent = workspace.worker_agent_id
        ? fixture.services.database.agents.find(workspace.worker_agent_id)
        : undefined;
      const accountId = agent?.account_id ?? null;
      return {
        orchestrator: options.orchestratorRunner ?? orchestrator,
        worker: options.worker,
        workerAccountId: accountId,
        workerRouting: {
          provider: 'anthropic',
          selection: (workspace.worker_selection as 'auto' | 'manual') ?? 'auto',
          manual: { model: workspace.worker_model, reasoning: workspace.worker_reasoning },
          capabilities: async () => {
            capabilityReads.push(accountId);
            return options.capabilitiesFor ? options.capabilitiesFor(accountId) : FULL;
          },
        },
      };
    },
  });

  const workspace = value<WorkspaceView>(
    await fixture.router.handle('workspace.create', { name: 'Roteado', localPath: repo.dir }),
  );
  fixture.services.database.verifications.upsert({
    workspaceId: workspace.id,
    id: 'hello-exists',
    label: 'hello.txt tem o conteúdo exato',
    command: 'node check.mjs',
  });
  const codex = value<{ id: string }>(
    await fixture.router.handle('accounts.create', { name: 'Codex Trabalho', provider: 'openai' }),
  );
  const first = value<{ id: string }>(
    await fixture.router.handle('accounts.create', { name: 'Claude Trabalho', provider: 'anthropic' }),
  );
  const second = value<{ id: string }>(
    await fixture.router.handle('accounts.create', { name: 'Claude Pessoal', provider: 'anthropic' }),
  );
  value(
    await fixture.router.handle('workspace.setTeam', {
      workspaceId: workspace.id,
      orchestrator: { accountId: codex.id },
      worker: { accountId: first.id },
    }),
  );
  const session = value<{ id: string }>(
    await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'Conversa' }),
  );

  return {
    fixture,
    repo,
    workspaceId: workspace.id,
    sessionId: session.id,
    orchestrator,
    worker: options.worker,
    capabilityReads,
    accounts: { first: first.id, second: second.id },
    async run(text) {
      const sent = value<{ run: { id: string } }>(
        await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text }),
      );
      return fixture.services.orchestration.waitFor(sent.run.id, 60_000);
    },
    async cleanup() {
      await fixture.cleanup();
      repo.cleanup();
    },
  };
}

/** The recorded worker invocations of a run, oldest first. */
async function workerRows(prepared: Prepared, runId: string) {
  const detail = value<RunDetailView>(await prepared.fixture.router.handle('run.detail', { runId }));
  return detail.invocations.filter((inv) => inv.role === 'CODING_WORKER');
}

async function chat(prepared: Prepared): Promise<ChatMessageView[]> {
  return value<ChatMessageView[]>(
    await prepared.fixture.router.handle('chat.listMessages', { sessionId: prepared.sessionId }),
  );
}

test('the shared contract spells the worker selections exactly as the core does', () => {
  assert.deepEqual([...SHARED_SELECTIONS], [...CORE_SELECTIONS]);
});

test('within one run the model follows each delegation: STRONG then FAST, both on the record', async () => {
  const worker = new RoutedWorker((input, call) => {
    if (call === 1) writeFileSync(join(input.workingDirectory, 'notes.md'), 'investigado\n', 'utf8');
    if (call === 2) writeHello(input.workingDirectory);
  });
  const prepared = await prepare({
    orchestratorScript: [
      delegate('Depure a falha intermitente entre módulos que impede o arquivo', { capability: 'strong', reasoning: 'high' }),
      delegate(`Crie hello.txt contendo exatamente: ${EXPECTED}`, { capability: 'fast', reasoning: 'low' }),
      done(),
    ],
    worker,
  });
  try {
    const run = await prepared.run('faça');
    assert.equal(run.status, 'DONE', run.summary ?? '');

    // What the worker was handed, invocation by invocation.
    assert.deepEqual(worker.calls[0]!.routing, { model: 'opus', reasoning: 'high' });
    assert.deepEqual(worker.calls[1]!.routing, { model: 'haiku', reasoning: 'low' });

    // What the record says.
    const rows = await workerRows(prepared, run.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.model, 'opus');
    assert.equal(rows[0]!.reasoning, 'high');
    assert.equal(rows[0]!.requestedCapability, 'STRONG');
    assert.equal(rows[0]!.requestedReasoning, 'HIGH');
    assert.equal(rows[0]!.selectionMode, 'auto');
    assert.equal(rows[0]!.fallbackUsed, false);
    assert.match(rows[0]!.selectionReason ?? '', /Codex pediu STRONG\/HIGH/);
    assert.equal(rows[1]!.model, 'haiku');
    assert.equal(rows[1]!.requestedCapability, 'FAST');

    // What the timeline shows: the worker's message carries its routing.
    const workerMessages = (await chat(prepared)).filter((m) => m.author === 'worker');
    assert.equal(workerMessages[0]!.routing?.model, 'opus');
    assert.equal(workerMessages[1]!.routing?.model, 'haiku');
    assert.equal(workerMessages[1]!.routing?.selectionMode, 'auto');

    // What the orchestrator was told before deciding again.
    const second = prepared.orchestrator.calls[1]!.prompt;
    assert.match(second, /WORKER OF THIS ITERATION/);
    assert.match(second, /ran as: model opus, reasoning high \[auto\]/);
    assert.match(second, /requested: STRONG\/HIGH/);
    assert.match(second, /progressed: yes/);
    // And the prompt asks for tiers, never a model name.
    assert.match(second, /"workerRequirements"/);
    assert.match(second, /never a model name/);
  } finally {
    await prepared.cleanup();
  }
});

test('a decision without workerRequirements falls back to BALANCED/MEDIUM, and says so', async () => {
  const worker = new RoutedWorker((input) => writeHello(input.workingDirectory));
  const prepared = await prepare({
    orchestratorScript: [delegate('Crie hello.txt', null), done()],
    worker,
  });
  try {
    const run = await prepared.run('faça');
    assert.equal(run.status, 'DONE', run.summary ?? '');
    assert.deepEqual(worker.calls[0]!.routing, { model: 'sonnet', reasoning: 'medium' });
    const [row] = await workerRows(prepared, run.id);
    assert.equal(row!.requestedCapability, 'BALANCED');
    assert.equal(row!.requestedReasoning, 'MEDIUM');
    assert.match(row!.selectionReason ?? '', /sem requisitos/);
  } finally {
    await prepared.cleanup();
  }
});

test('a model the CLI refuses is retried on the next candidate, both attempts on the record', async () => {
  const worker = new RoutedWorker((input) => {
    if (input.routing?.model === 'haiku') {
      return { exitCode: 1, stdout: '', stderr: 'Error: model "haiku" not found for this account' };
    }
    writeHello(input.workingDirectory);
  });
  const prepared = await prepare({
    orchestratorScript: [delegate('Crie hello.txt', { capability: 'fast', reasoning: 'low' }), done()],
    worker,
  });
  try {
    const run = await prepared.run('faça');
    assert.equal(run.status, 'DONE', run.summary ?? '');
    assert.equal(worker.calls[0]!.routing?.model, 'haiku');
    assert.equal(worker.calls[1]!.routing?.model, 'sonnet');

    const rows = await workerRows(prepared, run.id);
    assert.equal(rows.length, 2, 'both attempts are invocations of iteration 1');
    assert.equal(rows[0]!.iteration, 1);
    assert.equal(rows[1]!.iteration, 1);
    assert.equal(rows[0]!.exitCode, 1);
    assert.equal(rows[1]!.model, 'sonnet');
    assert.equal(rows[1]!.fallbackUsed, true);
    assert.match(rows[1]!.selectionReason ?? '', /indisponível nesta execução: haiku/);

    const messages = await chat(prepared);
    assert.ok(messages.some((m) => m.author === 'system' && /haiku não está disponível/.test(m.text)));
  } finally {
    await prepared.cleanup();
  }
});

test('repeated no-progress escalates - more reasoning, then a stronger model - and the next simple task goes back down', async () => {
  const worker = new RoutedWorker((input, call) => {
    if (call === 3) writeHello(input.workingDirectory);
    if (call === 4) writeFileSync(join(input.workingDirectory, 'README.md'), '# scratch\n\nnovo\n', 'utf8');
    return { stdout: call < 3 ? 'não consegui' : 'feito' };
  });
  const prepared = await prepare({
    orchestratorScript: [
      delegate('Corrija o conteúdo de hello.txt', { capability: 'balanced', reasoning: 'medium' }),
      delegate('Corrija o conteúdo de hello.txt', { capability: 'balanced', reasoning: 'medium' }),
      delegate('Corrija o conteúdo de hello.txt', { capability: 'balanced', reasoning: 'medium' }),
      delegate('Atualize o README com a nova instrução', { capability: 'fast', reasoning: 'low' }),
      done(),
    ],
    worker,
  });
  try {
    const run = await prepared.run('faça');
    assert.equal(run.status, 'DONE', run.summary ?? '');
    const routed = worker.calls.map((c) => c.routing);
    assert.deepEqual(routed[0], { model: 'sonnet', reasoning: 'medium' }, 'first attempt: as asked');
    assert.deepEqual(routed[1], { model: 'sonnet', reasoning: 'high' }, 'one attempt without progress: think harder');
    assert.deepEqual(routed[2], { model: 'opus', reasoning: 'max' }, 'two without progress: a stronger model');
    assert.deepEqual(routed[3], { model: 'haiku', reasoning: 'low' }, 'progress made, simple task: back down');

    const rows = await workerRows(prepared, run.id);
    assert.match(rows[2]!.selectionReason ?? '', /escalado .* após 2 tentativa/);
    assert.doesNotMatch(rows[3]!.selectionReason ?? '', /escalado/);
    // The orchestrator was told there was no progress.
    assert.match(prepared.orchestrator.calls[1]!.prompt, /progressed: no/);
  } finally {
    await prepared.cleanup();
  }
});

test('a changed worker account re-reads the capabilities, and the routing follows them', async () => {
  // Each run must change the tree relative to its own baseline: hello.txt is
  // the same both times, so a marker file carries the difference.
  const worker = new RoutedWorker((input, call) => {
    writeHello(input.workingDirectory);
    writeFileSync(join(input.workingDirectory, 'notes.md'), `tentativa ${call}\n`, 'utf8');
  });
  const prepared = await prepare({
    orchestratorScript: [delegate('Crie hello.txt', { capability: 'fast', reasoning: 'low' }), done()],
    worker,
    // The second account's Claude Code is an older build with no --effort.
    capabilitiesFor: (accountId) =>
      accountId === prepared.accounts.second ? { ...FULL, effortFlag: false } : FULL,
  });
  try {
    const first = await prepared.run('faça');
    assert.equal(first.status, 'DONE', first.summary ?? '');
    assert.deepEqual(worker.calls[0]!.routing, { model: 'haiku', reasoning: 'low' });

    // Switch the worker to the other account; nothing else changes.
    const codexAccount = prepared.fixture.services.database.accounts
      .list()
      .find((a) => a.provider_id === 'openai')!;
    value(
      await prepared.fixture.router.handle('workspace.setTeam', {
        workspaceId: prepared.workspaceId,
        orchestrator: { accountId: codexAccount.id },
        worker: { accountId: prepared.accounts.second },
      }),
    );
    // Commit what the first run left, so the second run's evidence is its
    // own (a rewrite of an untracked file is invisible to git's diff).
    prepared.repo.commitAll('primeira execução');
    // The same script again for the second run.
    prepared.orchestrator['index' as never] = 0 as never;
    const second = await prepared.run('de novo');
    assert.equal(second.status, 'DONE', second.summary ?? '');
    assert.deepEqual(worker.calls[1]!.routing, { model: 'haiku', reasoning: null });

    assert.deepEqual(prepared.capabilityReads, [prepared.accounts.first, prepared.accounts.second]);
    const rows = await workerRows(prepared, second.id);
    assert.equal(rows[0]!.reasoning, null);
    assert.match(rows[0]!.selectionReason ?? '', /não aceita nível de raciocínio/);
  } finally {
    await prepared.cleanup();
  }
});

test('manual selection saved on the team is sent exactly, and the default is automatic', async () => {
  const worker = new RoutedWorker((input) => writeHello(input.workingDirectory));
  const prepared = await prepare({
    orchestratorScript: [delegate('Crie hello.txt', { capability: 'fast', reasoning: 'low' }), done()],
    worker,
  });
  try {
    const before = prepared.fixture.services.workspaces.list().find((w) => w.id === prepared.workspaceId)!;
    assert.equal(before.team.worker.selection, 'auto', 'automatic unless the person says otherwise');
    assert.equal(before.team.orchestrator.selection, 'auto', 'the orchestrator runs on the CLI default');

    const codexAccount = prepared.fixture.services.database.accounts
      .list()
      .find((a) => a.provider_id === 'openai')!;
    const saved = value<WorkspaceView>(
      await prepared.fixture.router.handle('workspace.setTeam', {
        workspaceId: prepared.workspaceId,
        orchestrator: { accountId: codexAccount.id },
        worker: { accountId: prepared.accounts.first, model: 'claude-opus-5', reasoning: 'high', selection: 'manual' },
      }),
    );
    assert.equal(saved.team.worker.selection, 'manual');
    assert.equal(saved.team.worker.model, 'claude-opus-5');

    const run = await prepared.run('faça');
    assert.equal(run.status, 'DONE', run.summary ?? '');
    assert.deepEqual(worker.calls[0]!.routing, { model: 'claude-opus-5', reasoning: 'high' });
    const [row] = await workerRows(prepared, run.id);
    assert.equal(row!.selectionMode, 'manual');
    assert.equal(row!.model, 'claude-opus-5');

    // The validator refuses a selection it does not know.
    const refused = await prepared.fixture.router.handle('workspace.setTeam', {
      workspaceId: prepared.workspaceId,
      orchestrator: { accountId: codexAccount.id },
      worker: { accountId: prepared.accounts.first, selection: 'cheapest' },
    });
    assert.equal(refused.ok, false);
  } finally {
    await prepared.cleanup();
  }
});

test("the orchestrator's fixed level the CLI does not support is replaced and said once, in the promised words", async () => {
  const NOTE = 'Este nível não é suportado pela versão atual. Usando "xhigh" no lugar de "max".';
  const scripted = new ScriptedAgent('mock-codex', 'Codex', [
    delegate('Crie hello.txt', { capability: 'fast', reasoning: 'low' }),
    done(),
  ]);
  // A Codex whose adapter checked the saved level and had to replace it.
  const orchestrator: AgentRunner = {
    kind: 'mock-codex',
    label: 'Codex',
    async run(input) {
      const result = await scripted.run(input);
      return { ...result, applied: { model: 'gpt-5.1-codex', reasoning: 'xhigh', fallbackUsed: true, note: NOTE } };
    },
    async cancel() {},
    async healthCheck() {
      return { healthy: true };
    },
  };
  const worker = new RoutedWorker((input) => writeHello(input.workingDirectory));
  const prepared = await prepare({ orchestratorScript: [], worker, orchestratorRunner: orchestrator });
  try {
    const run = await prepared.run('faça');
    assert.equal(run.status, 'DONE', run.summary ?? '');
    const notes = (await chat(prepared)).filter((m) => m.author === 'system' && m.text === NOTE);
    assert.equal(notes.length, 1, 'said once per run, not per decision');

    const detail = value<RunDetailView>(await prepared.fixture.router.handle('run.detail', { runId: run.id }));
    const orchestratorRows = detail.invocations.filter((inv) => inv.role === 'ORCHESTRATOR');
    assert.ok(orchestratorRows.length >= 2);
    assert.equal(orchestratorRows[0]!.selectionMode, 'fixed');
    assert.equal(orchestratorRows[0]!.model, 'gpt-5.1-codex');
    assert.equal(orchestratorRows[0]!.reasoning, 'xhigh');
    assert.equal(orchestratorRows[0]!.fallbackUsed, true);
    assert.equal(orchestratorRows[0]!.selectionReason, NOTE);
  } finally {
    await prepared.cleanup();
  }
});
