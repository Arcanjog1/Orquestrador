/**
 * Conversations a person can manage.
 *
 * Seen on the Windows build: a conversation, once created, could not be
 * renamed, hidden or removed. These tests pin what replaced that - rename,
 * archive/restore, delete with real removal, title search - and the two rules
 * that make delete safe: the runs a conversation started stay in the
 * execution history with their evidence, and nothing in the project folder is
 * touched. Fake agents, real database, real git.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDesktopFixture, HangingAgent, ScriptedAgent } from './helpers/desktop-fixture.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type { ChatSessionView, IpcResult, RunView } from '../apps/desktop/src/shared/ipc-contract.js';
import type { AgentInput } from '../src/core/types.js';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

function failure(result: IpcResult<unknown>): { code: string; message: string } {
  assert.equal(result.ok, false, 'expected the call to be refused');
  return (result as { ok: false; error: { code: string; message: string } }).error;
}

const done = JSON.stringify({
  action: 'done',
  acceptanceCriteria: [],
  verificationCommands: [],
  summary: 'Nada a fazer.',
});

async function prepare(worker: ScriptedAgent | HangingAgent = new ScriptedAgent('mock-claude', 'Claude', [''])) {
  const repo = createGitFixture('lao-conv-');
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', [
    JSON.stringify({
      action: 'delegate',
      task: 'Crie hello.txt',
      acceptanceCriteria: [],
      verificationCommands: [],
      summary: 'Delegando.',
    }),
    done,
  ]);
  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    allowNoChanges: true,
  });
  const workspace = value<{ id: string }>(
    await fixture.router.handle('workspace.create', { name: 'Projeto', localPath: repo.dir }),
  );
  value(await fixture.router.handle('accounts.create', { name: 'Claude Trabalho', provider: 'anthropic' }));
  const agents = value<Array<{ id: string; role: string }>>(await fixture.router.handle('agents.list', null));
  value(
    await fixture.router.handle('workspace.setAgents', {
      workspaceId: workspace.id,
      orchestratorAgentId: agents.find((a) => a.role === 'ORCHESTRATOR')!.id,
      workerAgentId: agents.find((a) => a.role === 'CODING_WORKER')!.id,
    }),
  );
  const list = async (extra: Record<string, unknown> = {}) =>
    value<ChatSessionView[]>(
      await fixture.router.handle('chat.listSessions', { workspaceId: workspace.id, ...extra }),
    );
  const create = async (title: string) =>
    value<ChatSessionView>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title }),
    );
  return {
    fixture,
    repo,
    workspace,
    list,
    create,
    async cleanup() {
      await fixture.cleanup();
      repo.cleanup();
    },
  };
}

test('rename, archive, restore and search are real changes the list reflects', async () => {
  const t = await prepare();
  try {
    const a = await t.create('Primeira ideia');
    const b = await t.create('Relatório de 50% do trabalho');
    assert.equal(a.archivedAt, null);
    assert.equal(a.messageCount, 0);
    assert.equal(a.lastRun, null);

    // Rename: the title changes, the row moves to the top, nothing else moves.
    const renamed = value<ChatSessionView>(
      await t.fixture.router.handle('chat.renameSession', { sessionId: a.id, title: '  Ideia revisada  ' }),
    );
    assert.equal(renamed.title, 'Ideia revisada', 'trimmed, as typed');
    assert.equal((await t.list())[0]!.id, a.id, 'a renamed conversation is the most recent one');

    // Archive: gone from the default list, present when asked for, restorable.
    value(await t.fixture.router.handle('chat.archiveSession', { sessionId: b.id, archived: true }));
    assert.deepEqual((await t.list()).map((s) => s.id), [a.id]);
    const withArchived = await t.list({ includeArchived: true });
    assert.deepEqual(withArchived.map((s) => s.id).sort(), [a.id, b.id].sort());
    assert.ok(withArchived.find((s) => s.id === b.id)!.archivedAt, 'marked, not deleted');
    value(await t.fixture.router.handle('chat.archiveSession', { sessionId: b.id, archived: false }));
    assert.equal((await t.list()).length, 2);

    // Search: by title, case-insensitive, with the user's wildcard taken literally.
    assert.deepEqual((await t.list({ query: 'revisada' })).map((s) => s.id), [a.id]);
    assert.deepEqual((await t.list({ query: 'RELATÓRIO' })).map((s) => s.id), [b.id]);
    assert.deepEqual((await t.list({ query: '50%' })).map((s) => s.id), [b.id]);
    assert.deepEqual((await t.list({ query: '%' })).map((s) => s.id), [b.id], '% is not "everything"');
    assert.deepEqual(await t.list({ query: 'nada disso' }), []);

    // The boundary: a blank or multi-line title is refused before the service.
    assert.equal(
      failure(await t.fixture.router.handle('chat.renameSession', { sessionId: a.id, title: '   ' })).code,
      'INVALID_ARGUMENT',
    );
    assert.equal(
      failure(await t.fixture.router.handle('chat.renameSession', { sessionId: a.id, title: 'a\nb' })).code,
      'INVALID_ARGUMENT',
    );
    assert.equal(
      failure(await t.fixture.router.handle('chat.renameSession', { sessionId: 'chat-nope', title: 'x' })).code,
      'NOT_FOUND',
    );
  } finally {
    await t.cleanup();
  }
});

test('deleting a conversation removes it and its messages, keeps its runs, and touches no file', async () => {
  const t = await prepare(
    new ScriptedAgent('mock-claude', 'Claude', [
      (input: AgentInput) => {
        writeFileSync(join(input.workingDirectory, 'hello.txt'), 'olá\n', 'utf8');
        return 'ok';
      },
    ]),
  );
  try {
    const session = await t.create('Vai embora');
    const sent = value<{ run: RunView }>(
      await t.fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'Crie hello.txt' }),
    );
    const run = await t.fixture.services.orchestration.waitFor(sent.run.id, 20_000);
    assert.equal(run.status, 'DONE');
    const file = join(t.repo.dir, 'hello.txt');
    assert.ok(existsSync(file), 'the worker really wrote the file');

    const before = (await t.list()).find((s) => s.id === session.id)!;
    assert.ok(before.messageCount > 0);
    assert.equal(before.lastRun?.id, sent.run.id);
    assert.equal(before.lastRun?.status, 'DONE');

    const removed = value<{ deleted: boolean }>(
      await t.fixture.router.handle('chat.deleteSession', { sessionId: session.id }),
    );
    assert.equal(removed.deleted, true);

    // Gone: from the list, from the archive, and its messages with it.
    assert.deepEqual(await t.list({ includeArchived: true }), []);
    assert.equal(
      failure(await t.fixture.router.handle('chat.listMessages', { sessionId: session.id })).code,
      'NOT_FOUND',
    );
    assert.equal(t.fixture.services.database.chat.countMessages(session.id), 0);

    // Kept: the run, its steps and its evidence, now without a conversation.
    const kept = value<RunView>(await t.fixture.router.handle('run.get', { runId: sent.run.id }));
    assert.equal(kept.status, 'DONE');
    assert.equal(kept.sessionId, '', 'the conversation is gone; the run is not');
    assert.equal(kept.objective, 'Crie hello.txt');
    assert.ok(t.fixture.services.database.runs.steps(sent.run.id).length > 0);
    const history = value<RunView[]>(
      await t.fixture.router.handle('run.list', { workspaceId: t.workspace.id }),
    );
    assert.deepEqual(history.map((r) => r.id), [sent.run.id]);

    // Untouched: the project folder.
    assert.equal(readFileSync(file, 'utf8'), 'olá\n');

    // Twice is a not-found, not a silent success.
    assert.equal(
      failure(await t.fixture.router.handle('chat.deleteSession', { sessionId: session.id })).code,
      'NOT_FOUND',
    );
  } finally {
    await t.cleanup();
  }
});

test('a conversation with a run still going cannot be deleted; cancel first', async () => {
  const hanging = new HangingAgent();
  const t = await prepare(hanging);
  try {
    const session = await t.create('Em andamento');
    const sent = value<{ run: RunView }>(
      await t.fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'demore' }),
    );
    const deadline = Date.now() + 5_000;
    while (hanging.started === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(hanging.started, 1);

    const refused = failure(await t.fixture.router.handle('chat.deleteSession', { sessionId: session.id }));
    assert.equal(refused.code, 'CHAT_ERROR');
    assert.match(refused.message, /Cancele a execução/);
    assert.equal((await t.list()).length, 1, 'still there');

    value(await t.fixture.router.handle('run.cancel', { runId: sent.run.id }));
    await t.fixture.services.orchestration.waitFor(sent.run.id, 20_000);
    assert.equal(
      value<{ deleted: boolean }>(
        await t.fixture.router.handle('chat.deleteSession', { sessionId: session.id }),
      ).deleted,
      true,
    );
  } finally {
    await t.cleanup();
  }
});

test('writing to an archived conversation brings it back to the list', async () => {
  const t = await prepare();
  try {
    const session = await t.create('Arquivada');
    value(await t.fixture.router.handle('chat.archiveSession', { sessionId: session.id, archived: true }));
    assert.deepEqual(await t.list(), []);
    const sent = value<{ run: RunView }>(
      await t.fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'de novo' }),
    );
    await t.fixture.services.orchestration.waitFor(sent.run.id, 20_000);
    const back = await t.list();
    assert.deepEqual(back.map((s) => s.id), [session.id]);
    assert.equal(back[0]!.archivedAt, null);
    assert.equal(back[0]!.lastRun?.id, sent.run.id);
  } finally {
    await t.cleanup();
  }
});
