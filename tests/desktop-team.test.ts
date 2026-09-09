/**
 * The team of a project: real accounts, persisted choices, specific refusals.
 *
 * Seen on the Windows build: the "Account" picker offered the provider ("Codex")
 * where the person expected their account ("Codex Trabalho"), and nothing the
 * dialog saved beyond two agent ids survived a restart. These tests pin the
 * model that replaced it: the interface binds *accounts*; each role's model and
 * reasoning level are stored with the binding; wrong providers are refused by
 * name; and readiness names the account that is missing or not connected.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { AppServices } from '../apps/desktop/src/main/services/app-services.js';
import { createDesktopFixture } from './helpers/desktop-fixture.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type { IpcResult, WorkspaceView } from '../apps/desktop/src/shared/ipc-contract.js';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

function failure(result: IpcResult<unknown>): { code: string; message: string } {
  assert.equal(result.ok, false, 'expected the call to be refused');
  return (result as { ok: false; error: { code: string; message: string } }).error;
}

test('the team is bound by account, keeps model and reasoning, and survives a restart', async () => {
  const repo = createGitFixture();
  const fixture = createDesktopFixture();
  try {
    const workspace = value<WorkspaceView>(
      await fixture.router.handle('workspace.create', { name: 'Projeto', localPath: repo.dir }),
    );
    const codex = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Codex Trabalho', provider: 'openai' }),
    );
    const claude = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Claude Trabalho', provider: 'anthropic' }),
    );

    // Before anything is chosen the view says so, per role, with the provider
    // the role runs on - never a provider dressed up as an account.
    assert.equal(workspace.team.orchestrator.provider, 'openai');
    assert.equal(workspace.team.orchestrator.accountName, null);
    assert.equal(workspace.team.worker.provider, 'anthropic');
    assert.equal(workspace.team.worker.accountName, null);

    const bound = value<WorkspaceView>(
      await fixture.router.handle('workspace.setTeam', {
        workspaceId: workspace.id,
        // A pinned orchestrator: model and level are kept only under manual.
        orchestrator: { accountId: codex.id, model: 'gpt-5.1-codex', reasoning: 'high', selection: 'manual' },
        worker: { accountId: claude.id, model: 'claude-opus-5', selection: 'manual' },
      }),
    );
    assert.equal(bound.team.orchestrator.selection, 'manual');
    assert.equal(bound.team.orchestrator.accountName, 'Codex Trabalho');
    assert.equal(bound.team.orchestrator.accountId, codex.id);
    assert.equal(bound.team.orchestrator.model, 'gpt-5.1-codex');
    assert.equal(bound.team.orchestrator.reasoning, 'high');
    assert.equal(bound.team.worker.accountName, 'Claude Trabalho');
    assert.equal(bound.team.worker.model, 'claude-opus-5');
    assert.equal(bound.team.worker.reasoning, null, 'unset means the CLI default, not a guess');
    // The agent ids the loop already runs on are still there, derived from
    // the account: nothing downstream had to change.
    assert.equal(bound.orchestratorAgentId, `agent-orchestrator-${codex.id}`);
    assert.equal(bound.workerAgentId, `agent-worker-${claude.id}`);

    // A restart: a second service graph on the same app root reads the same
    // database and must show the same team.
    await fixture.services.shutdown();
    const reopened = new AppServices({ paths: fixture.paths, openUrl: () => {} });
    try {
      const again = reopened.workspaces.list().find((w) => w.id === workspace.id)!;
      assert.equal(again.team.orchestrator.accountName, 'Codex Trabalho');
      assert.equal(again.team.orchestrator.selection, 'manual');
      assert.equal(again.team.orchestrator.model, 'gpt-5.1-codex');
      assert.equal(again.team.orchestrator.reasoning, 'high');
      assert.equal(again.team.worker.accountName, 'Claude Trabalho');
      assert.equal(again.team.worker.model, 'claude-opus-5');
      // And the loop's own view of the workspace carries the choices too.
      const record = reopened.database.workspaces.require(workspace.id);
      assert.equal(record.orchestrator_model, 'gpt-5.1-codex');
      assert.equal(record.orchestrator_reasoning, 'high');
      assert.equal(record.worker_model, 'claude-opus-5');
      assert.equal(record.worker_reasoning, null);
    } finally {
      await reopened.shutdown();
    }
  } finally {
    // The fixture's shutdown ran already; cleanup only removes the folder.
    fixture.cleanup().catch(() => undefined);
    repo.cleanup();
  }
});

test('a legacy seed missing the chosen role is refused by name, and the old team stays', async () => {
  const repo = createGitFixture();
  const fixture = createDesktopFixture();
  try {
    const workspace = value<WorkspaceView>(
      await fixture.router.handle('workspace.create', { name: 'Projeto', localPath: repo.dir }),
    );
    const codex = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Codex Trabalho', provider: 'openai' }),
    );
    const claude = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Claude Trabalho', provider: 'anthropic' }),
    );
    value(
      await fixture.router.handle('workspace.setTeam', {
        workspaceId: workspace.id,
        orchestrator: { accountId: codex.id },
        worker: { accountId: claude.id },
      }),
    );

    // Swapped: the Anthropic account offered as orchestrator.
    const refused = failure(
      await fixture.router.handle('workspace.setTeam', {
        workspaceId: workspace.id,
        orchestrator: { accountId: claude.id },
        worker: { accountId: codex.id },
      }),
    );
    assert.equal(refused.code, 'WORKSPACE_ERROR');
    assert.match(refused.message, /"Claude Trabalho"/);
    assert.match(refused.message, /agente/);

    const after = value<WorkspaceView[]>(await fixture.router.handle('workspace.list', null));
    const same = after.find((w) => w.id === workspace.id)!;
    assert.equal(same.team.orchestrator.accountName, 'Codex Trabalho');
    assert.equal(same.team.worker.accountName, 'Claude Trabalho');

    // A removed account, likewise.
    const gone = failure(
      await fixture.router.handle('workspace.setTeam', {
        workspaceId: workspace.id,
        orchestrator: { accountId: 'acc-nope' },
        worker: { accountId: claude.id },
      }),
    );
    assert.match(gone.message, /não existe mais/);
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});

test('the boundary refuses a model that could be read as a flag, and an unknown reasoning level', async () => {
  const fixture = createDesktopFixture();
  try {
    for (const orchestrator of [
      { accountId: 'acc-1', model: '--dangerously-bypass' },
      { accountId: 'acc-1', model: 'gpt 5' },
      { accountId: 'acc-1', reasoning: 'ultra' },
      { accountId: 'acc-1', extra: true },
    ]) {
      const error = failure(
        await fixture.router.handle('workspace.setTeam', {
          workspaceId: 'ws-1',
          orchestrator,
          worker: { accountId: 'acc-2' },
        }),
      );
      assert.equal(error.code, 'INVALID_ARGUMENT', JSON.stringify(orchestrator));
    }
  } finally {
    await fixture.cleanup();
  }
});

test('readiness names the missing account, then the account that is not connected', async () => {
  const repo = createGitFixture();
  const fixture = createDesktopFixture();
  try {
    const workspace = value<WorkspaceView>(
      await fixture.router.handle('workspace.create', { name: 'Projeto', localPath: repo.dir }),
    );
    const claude = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Claude Trabalho', provider: 'anthropic' }),
    );
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'Conversa' }),
    );
    const explanationOf = async () => {
      const messages = value<Array<{ author: string; text: string }>>(
        await fixture.router.handle('chat.listMessages', { sessionId: session.id }),
      );
      return messages.filter((m) => m.author === 'system').at(-1)!.text;
    };

    // No team at all: refused before a run exists.
    const noTeam = failure(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'faça algo' }),
    );
    assert.match(noTeam.message, /supervisiona.*executa/);

    // The accountless default orchestrator, bound the old way, is a gap too:
    // every role runs on one of the person's own accounts, never on whatever
    // credential the machine happens to have.
    value(
      await fixture.router.handle('workspace.setAgents', {
        workspaceId: workspace.id,
        orchestratorAgentId: 'agent-codex-orchestrator',
        workerAgentId: `agent-worker-${claude.id}`,
      }),
    );
    let sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'faça algo' }),
    );
    let run = await fixture.services.orchestration.waitFor(sent.run.id, 20_000);
    assert.equal(run.status, 'FAILED');
    assert.match(await explanationOf(), /Escolha a conta OpenAI \(Codex\) que supervisiona/);

    // A bound but never-connected account, on a machine where the runtime is
    // present: the sentence names the account. The "runtime" is this node,
    // registered the way a managed install is, and `login status` is answered
    // by a stand-in script beside it that says "Not logged in".
    const codex = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Codex Trabalho', provider: 'openai' }),
    );
    value(
      await fixture.router.handle('workspace.setTeam', {
        workspaceId: workspace.id,
        orchestrator: { accountId: codex.id },
        worker: { accountId: claude.id },
      }),
    );
    const installDir = join(fixture.paths.runtimes, 'codex');
    const currentDir = join(installDir, 'current');
    mkdirSync(currentDir, { recursive: true });
    const executableRelativePath = relative(currentDir, process.execPath);
    if (isAbsolute(executableRelativePath)) {
      // Different drives: the managed layout cannot point at this node. The
      // two assertions above still ran; the third has nowhere to run here.
      return;
    }
    writeFileSync(
      join(installDir, 'runtime.json'),
      JSON.stringify({ runtimeId: 'codex', version: '0.153.0', executableRelativePath }),
      'utf8',
    );
    writeFileSync(
      join(fixture.paths.root, 'login'),
      "if (process.argv[2] === 'status') { console.log('Not logged in'); process.exit(1); }\n",
      'utf8',
    );
    sent = value(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'faça algo' }),
    );
    run = await fixture.services.orchestration.waitFor(sent.run.id, 20_000);
    assert.equal(run.status, 'FAILED');
    const text = await explanationOf();
    assert.match(text, /A conta "Codex Trabalho" não está conectada/);
    assert.match(text, /Conecte a conta/);
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});

/* ------------------------------------------------------------------------ *
 * The orchestrator's model: the Codex CLI's own default unless pinned.
 * ------------------------------------------------------------------------ */

test('the orchestrator is "Padrão do CLI" unless pinned; a pinned model is kept and an old row reads as pinned', async () => {
  const repo = createGitFixture();
  const fixture = createDesktopFixture();
  try {
    const workspace = value<WorkspaceView>(
      await fixture.router.handle('workspace.create', { name: 'Projeto', localPath: repo.dir }),
    );
    const codex = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Codex Trabalho', provider: 'openai' }),
    );
    const claude = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Claude Trabalho', provider: 'anthropic' }),
    );

    // Default: auto, and a model typed without choosing manual is not kept.
    let saved = value<WorkspaceView>(
      await fixture.router.handle('workspace.setTeam', {
        workspaceId: workspace.id,
        orchestrator: { accountId: codex.id, model: 'gpt-5.1-codex' },
        worker: { accountId: claude.id },
      }),
    );
    assert.equal(saved.team.orchestrator.selection, 'auto');
    assert.equal(saved.team.orchestrator.model, null, 'the CLI default ignores a stray model');
    let record = fixture.services.database.workspaces.require(workspace.id);
    assert.equal(record.orchestrator_selection, 'auto');
    assert.equal(record.orchestrator_model, null);

    // Pinned: kept, with the level.
    saved = value(
      await fixture.router.handle('workspace.setTeam', {
        workspaceId: workspace.id,
        orchestrator: { accountId: codex.id, model: 'gpt-5.1-codex', reasoning: 'xhigh', selection: 'manual' },
        worker: { accountId: claude.id },
      }),
    );
    assert.equal(saved.team.orchestrator.selection, 'manual');
    assert.equal(saved.team.orchestrator.model, 'gpt-5.1-codex');
    assert.equal(saved.team.orchestrator.reasoning, 'xhigh');

    // The worker's strategies are not the orchestrator's.
    const refused = await fixture.router.handle('workspace.setTeam', {
      workspaceId: workspace.id,
      orchestrator: { accountId: codex.id, selection: 'speed' },
      worker: { accountId: claude.id },
    });
    assert.equal(refused.ok, false);
    assert.match((refused as { ok: false; error: { message: string } }).error.message, /Padrão do CLI.*Manual/);

    // A row from before the column existed, with a model: still pinned.
    fixture.services.database.driver.run(
      "UPDATE workspace_agents SET selection = NULL WHERE workspace_id = ? AND role = 'ORCHESTRATOR'",
      [workspace.id],
    );
    record = fixture.services.database.workspaces.require(workspace.id);
    assert.equal(record.orchestrator_selection, null);
    const again = fixture.services.workspaces.list().find((w) => w.id === workspace.id)!;
    assert.equal(again.team.orchestrator.selection, 'manual');
    assert.equal(again.team.orchestrator.model, 'gpt-5.1-codex');
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * The agent panel's data
 * ------------------------------------------------------------------ */

test('every agent reports what it is, which connection it works through, and what it is doing', async () => {
  const fixture = createDesktopFixture();
  try {
    // Two Claude connections. This is the case the whole identity model exists
    // for: two team members, two accounts, one adapter - not two keys, not two
    // adapters, and never one session shared between them.
    value(await fixture.router.handle('accounts.create', { name: 'Claude Trabalho 1', provider: 'anthropic' }));
    value(await fixture.router.handle('accounts.create', { name: 'Claude Trabalho 2', provider: 'anthropic' }));

    const agents = value<
      Array<{
        agentId: string;
        name: string;
        role: string;
        runtimeId: string;
        connectionId: string | null;
        connectionName: string | null;
        provider: string | null;
        connectionKind: string | null;
        status: string;
        currentTask: string | null;
        runningForMs: number | null;
        awaitingReply: number;
      }>
    >(await fixture.router.handle('agents.status', null));

    const workers = agents.filter((agent) => agent.role === 'CODING_WORKER');
    assert.equal(workers.length, 2);
    assert.deepEqual(
      workers.map((agent) => agent.name).sort(),
      ['Claude Trabalho 1', 'Claude Trabalho 2'],
    );
    // Two identities, two connections. One would mean they could hand each
    // other a session, which is exactly what must not happen.
    assert.equal(new Set(workers.map((agent) => agent.connectionId)).size, 2);
    for (const worker of workers) {
      assert.equal(worker.provider, 'anthropic');
      assert.equal(worker.runtimeId, 'claude-code');
      assert.equal(worker.connectionName, worker.name);
      // Signed out, not idle. One is a problem to fix and the other is a team
      // member waiting for work; sending a person to the wrong screen because
      // the panel conflated them is the failure this distinction prevents.
      assert.equal(worker.status, 'offline');
      assert.equal(worker.currentTask, null);
      assert.equal(worker.runningForMs, null);
      assert.equal(worker.awaitingReply, 0);
    }

    // The orchestrator that exists before anyone signs in has no connection,
    // and is therefore not "offline": there is nothing to sign in to.
    const codex = agents.find((agent) => agent.role === 'ORCHESTRATOR' && agent.connectionId === null);
    assert.ok(codex);
    assert.equal(codex.status, 'idle');
    assert.equal(codex.runtimeId, 'codex');
  } finally {
    await fixture.cleanup();
  }
});

test('an agent connected but not working is idle, and never shows a stale task', async () => {
  const fixture = createDesktopFixture();
  try {
    const account = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Claude Trabalho 1', provider: 'anthropic' }),
    );
    fixture.services.database.accounts.updateAuth(account.id, 'connected', 'cli');

    const agents = value<Array<{ role: string; status: string; currentTask: string | null }>>(
      await fixture.router.handle('agents.status', null),
    );
    const worker = agents.find((agent) => agent.role === 'CODING_WORKER');
    assert.ok(worker);
    assert.equal(worker.status, 'idle');
    assert.equal(worker.currentTask, null);
  } finally {
    await fixture.cleanup();
  }
});

test('the panel counts a delegation nobody answered, so it cannot be missed', async () => {
  const fixture = createDesktopFixture();
  try {
    const account = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Claude Trabalho 1', provider: 'anthropic' }),
    );
    const agents = value<Array<{ agentId: string; role: string }>>(
      await fixture.router.handle('agents.status', null),
    );
    const worker = agents.find((agent) => agent.role === 'CODING_WORKER')!;

    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.createConversation', { name: 'Projeto' }),
    );
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'c' }),
    );
    const run = fixture.services.database.runs.create({
      id: 'run-panel-1',
      sessionId: session.id,
      workspaceId: workspace.id,
      objective: 'algo',
      orchestratorAgentId: null,
      maxIterations: 4,
    });
    // A delegation handed over and never answered - the shape a crash leaves.
    fixture.services.orchestration.bus.publish({
      runId: run.id,
      conversationId: session.id,
      iteration: 1,
      messageType: 'DELEGATION',
      payload: { task: 'crie hello.txt' },
      senderAgentId: 'orchestrator',
      recipientAgentId: worker.agentId,
    });

    const after = value<Array<{ agentId: string; awaitingReply: number }>>(
      await fixture.router.handle('agents.status', null),
    );
    assert.equal(
      after.find((agent) => agent.agentId === worker.agentId)?.awaitingReply,
      1,
      'a delegation with no answer must be visible as one',
    );
    assert.ok(account.id);
  } finally {
    await fixture.cleanup();
  }
});
