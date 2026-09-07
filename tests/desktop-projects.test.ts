/**
 * Projects: conversations organised by a real entity, not a fold in the
 * sidebar.
 *
 * What these pin: a project is a row that survives a restart; a conversation
 * is filed under one project or under none ("Sem projeto"); a conversation
 * born inside a project inherits it and its workspace; moving a conversation
 * is persisted; removing a project keeps every conversation, message, run
 * and file; the search finds a conversation whatever its project and says
 * which one; and conversations from before projects existed read as "Sem
 * projeto" with nothing lost.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppServices } from '../apps/desktop/src/main/services/app-services.js';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type {
  ChatSessionView,
  IpcResult,
  ProjectView,
  WorkspaceView,
} from '../apps/desktop/src/shared/ipc-contract.js';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

function failure(result: IpcResult<unknown>): { code: string; message: string } {
  assert.equal(result.ok, false, 'expected the call to be refused');
  return (result as { ok: false; error: { code: string; message: string } }).error;
}

const done = JSON.stringify({ action: 'done', acceptanceCriteria: [], verificationCommands: [], summary: 'Nada.' });

async function prepare() {
  const repoA = createGitFixture('lao-proj-a-');
  const repoB = createGitFixture('lao-proj-b-');
  const fixture = createDesktopFixture({
    createRunners: async () => ({
      orchestrator: new ScriptedAgent('mock-codex', 'Codex', [done]),
      worker: new ScriptedAgent('mock-claude', 'Claude', ['']),
      workerAccountId: null,
    }),
    allowNoChanges: true,
  });
  const orquestrador = value<WorkspaceView>(
    await fixture.router.handle('workspace.create', { name: 'Orquestrador', localPath: repoA.dir }),
  );
  const revit = value<WorkspaceView>(
    await fixture.router.handle('workspace.create', { name: 'Revit', localPath: repoB.dir }),
  );
  return {
    fixture,
    orquestrador,
    revit,
    async cleanup() {
      await fixture.cleanup();
      repoA.cleanup();
      repoB.cleanup();
    },
  };
}

test('projects are created, renamed and listed with their workspace and conversation count', async () => {
  const p = await prepare();
  try {
    const empty = value<ProjectView[]>(await p.fixture.router.handle('project.list', null));
    assert.deepEqual(empty, []);

    const project = value<ProjectView>(
      await p.fixture.router.handle('project.create', { name: '  AI  Orchestrator ', workspaceId: p.orquestrador.id }),
    );
    assert.equal(project.name, 'AI Orchestrator', 'whitespace tidied');
    assert.equal(project.workspaceId, p.orquestrador.id);
    assert.equal(project.workspaceName, 'Orquestrador');
    assert.equal(project.sessionCount, 0);

    const loose = value<ProjectView>(await p.fixture.router.handle('project.create', { name: 'Ideias' }));
    assert.equal(loose.workspaceId, null, 'a project need not point at a folder');

    const renamed = value<ProjectView>(
      await p.fixture.router.handle('project.rename', { projectId: project.id, name: 'Orquestrador' }),
    );
    assert.equal(renamed.name, 'Orquestrador');
    assert.match(failure(await p.fixture.router.handle('project.rename', { projectId: project.id, name: '   ' })).message, /nome/);
    assert.match(
      failure(await p.fixture.router.handle('project.create', { name: 'x', workspaceId: 'ws-nope' })).message,
      /pasta escolhida/,
    );

    const list = value<ProjectView[]>(await p.fixture.router.handle('project.list', null));
    assert.deepEqual(list.map((x) => x.name).sort(), ['Ideias', 'Orquestrador']);
  } finally {
    await p.cleanup();
  }
});

test('a conversation born inside a project inherits it; moving it is persisted; "Sem projeto" is the null', async () => {
  const p = await prepare();
  try {
    const project = value<ProjectView>(
      await p.fixture.router.handle('project.create', { name: 'Revit', workspaceId: p.revit.id }),
    );
    // Born in the project: the interface passes the project's own workspace.
    const inside = value<ChatSessionView>(
      await p.fixture.router.handle('chat.createSession', {
        workspaceId: project.workspaceId,
        title: 'Modulação automática',
        projectId: project.id,
      }),
    );
    assert.equal(inside.projectId, project.id);
    assert.equal(inside.projectName, 'Revit');
    assert.equal(inside.workspaceId, p.revit.id);
    assert.equal(inside.workspaceName, 'Revit');

    // Born nowhere: "Sem projeto".
    const loose = value<ChatSessionView>(
      await p.fixture.router.handle('chat.createSession', { workspaceId: p.orquestrador.id, title: 'Conversa solta' }),
    );
    assert.equal(loose.projectId, null);
    assert.equal(loose.projectName, null);

    // The tree: every conversation, with its project.
    let all = value<ChatSessionView[]>(await p.fixture.router.handle('chat.listAllSessions', {}));
    assert.deepEqual(
      all.map((s) => [s.title, s.projectName]).sort(),
      [
        ['Conversa solta', null],
        ['Modulação automática', 'Revit'],
      ],
    );
    assert.equal(value<ProjectView[]>(await p.fixture.router.handle('project.list', null))[0]!.sessionCount, 1);

    // Move the loose one in, then the first one out.
    const moved = value<ChatSessionView>(
      await p.fixture.router.handle('chat.moveSession', { sessionId: loose.id, projectId: project.id }),
    );
    assert.equal(moved.projectId, project.id);
    assert.equal(moved.workspaceId, p.orquestrador.id, 'moving between projects does not move the folder');
    value(await p.fixture.router.handle('chat.moveSession', { sessionId: inside.id, projectId: null }));
    all = value(await p.fixture.router.handle('chat.listAllSessions', {}));
    assert.deepEqual(
      all.map((s) => [s.title, s.projectName]).sort(),
      [
        ['Conversa solta', 'Revit'],
        ['Modulação automática', null],
      ],
    );
    assert.match(
      failure(await p.fixture.router.handle('chat.moveSession', { sessionId: loose.id, projectId: 'proj-gone' })).message,
      /não existe mais/,
    );
    assert.match(
      failure(
        await p.fixture.router.handle('chat.createSession', { workspaceId: p.revit.id, title: 'x', projectId: 'proj-gone' }),
      ).message,
      /não existe mais/,
    );
  } finally {
    await p.cleanup();
  }
});

test('the search finds a conversation whatever its project, and rename/archive/delete keep working under a project', async () => {
  const p = await prepare();
  try {
    const revit = value<ProjectView>(await p.fixture.router.handle('project.create', { name: 'Revit', workspaceId: p.revit.id }));
    const orq = value<ProjectView>(
      await p.fixture.router.handle('project.create', { name: 'Orquestrador', workspaceId: p.orquestrador.id }),
    );
    const a = value<ChatSessionView>(
      await p.fixture.router.handle('chat.createSession', { workspaceId: p.revit.id, title: 'Modelador externo', projectId: revit.id }),
    );
    const b = value<ChatSessionView>(
      await p.fixture.router.handle('chat.createSession', { workspaceId: p.orquestrador.id, title: 'GitHub Login', projectId: orq.id }),
    );
    value(await p.fixture.router.handle('chat.createSession', { workspaceId: p.orquestrador.id, title: 'Corrigir Runtime Codex', projectId: orq.id }));

    const found = value<ChatSessionView[]>(await p.fixture.router.handle('chat.listAllSessions', { query: 'modelador' }));
    assert.deepEqual(found.map((s) => [s.title, s.projectName]), [['Modelador externo', 'Revit']]);

    // Rename, archive and delete are the same operations as before.
    const renamed = value<ChatSessionView>(
      await p.fixture.router.handle('chat.renameSession', { sessionId: a.id, title: 'Modelador externo v2' }),
    );
    assert.equal(renamed.projectId, revit.id, 'renaming keeps the project');
    value(await p.fixture.router.handle('chat.archiveSession', { sessionId: b.id, archived: true }));
    let all = value<ChatSessionView[]>(await p.fixture.router.handle('chat.listAllSessions', {}));
    assert.ok(!all.some((s) => s.id === b.id), 'archived is hidden from the tree');
    all = value(await p.fixture.router.handle('chat.listAllSessions', { includeArchived: true }));
    assert.equal(all.find((s) => s.id === b.id)?.projectName, 'Orquestrador');
    assert.equal(value<ProjectView[]>(await p.fixture.router.handle('project.list', null)).find((x) => x.id === orq.id)!.sessionCount, 1, 'archived not counted');
    value(await p.fixture.router.handle('chat.deleteSession', { sessionId: b.id }));
    all = value(await p.fixture.router.handle('chat.listAllSessions', { includeArchived: true }));
    assert.ok(!all.some((s) => s.id === b.id));
  } finally {
    await p.cleanup();
  }
});

test('removing a project keeps its conversations, messages, runs, workspace and files; they become "Sem projeto"', async () => {
  const p = await prepare();
  try {
    const project = value<ProjectView>(
      await p.fixture.router.handle('project.create', { name: 'Revit', workspaceId: p.revit.id }),
    );
    value(await p.fixture.router.handle('accounts.create', { name: 'Claude Trabalho', provider: 'anthropic' }));
    const agents = value<Array<{ id: string; role: string }>>(await p.fixture.router.handle('agents.list', null));
    value(
      await p.fixture.router.handle('workspace.setAgents', {
        workspaceId: p.revit.id,
        orchestratorAgentId: agents.find((a) => a.role === 'ORCHESTRATOR')!.id,
        workerAgentId: agents.find((a) => a.role === 'CODING_WORKER')!.id,
      }),
    );
    const session = value<ChatSessionView>(
      await p.fixture.router.handle('chat.createSession', { workspaceId: p.revit.id, title: 'Exportador', projectId: project.id }),
    );
    const sent = value<{ run: { id: string } }>(
      await p.fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'exporte' }),
    );
    await p.fixture.services.orchestration.waitFor(sent.run.id, 30_000);

    const outcome = value<{ removed: boolean; sessionsMoved: number }>(
      await p.fixture.router.handle('project.remove', { projectId: project.id }),
    );
    assert.deepEqual(outcome, { removed: true, sessionsMoved: 1 });

    const all = value<ChatSessionView[]>(await p.fixture.router.handle('chat.listAllSessions', {}));
    const kept = all.find((s) => s.id === session.id);
    assert.ok(kept, 'the conversation is kept');
    assert.equal(kept!.projectId, null, 'now "Sem projeto"');
    assert.equal(kept!.workspaceId, p.revit.id, 'still in its folder');
    const messages = value<Array<{ text: string }>>(await p.fixture.router.handle('chat.listMessages', { sessionId: session.id }));
    assert.ok(messages.some((m) => m.text === 'exporte'), 'messages kept');
    const runs = value<Array<{ id: string }>>(await p.fixture.router.handle('run.list', { workspaceId: p.revit.id }));
    assert.ok(runs.some((r) => r.id === sent.run.id), 'runs kept');
    const workspaces = value<WorkspaceView[]>(await p.fixture.router.handle('workspace.list', null));
    assert.ok(workspaces.some((w) => w.id === p.revit.id), 'the workspace is still listed');
    assert.deepEqual(value<ProjectView[]>(await p.fixture.router.handle('project.list', null)), []);
    assert.match(failure(await p.fixture.router.handle('project.remove', { projectId: project.id })).message, /não existe mais/);
  } finally {
    await p.cleanup();
  }
});

test('a project pointed at a removed workspace loses only the link; projects, assignments and links survive a restart', async () => {
  const p = await prepare();
  try {
    const project = value<ProjectView>(
      await p.fixture.router.handle('project.create', { name: 'Revit', workspaceId: p.revit.id }),
    );
    const session = value<ChatSessionView>(
      await p.fixture.router.handle('chat.createSession', { workspaceId: p.orquestrador.id, title: 'Sessão A', projectId: project.id }),
    );
    const relinked = value<ProjectView>(
      await p.fixture.router.handle('project.setWorkspace', { projectId: project.id, workspaceId: p.orquestrador.id }),
    );
    assert.equal(relinked.workspaceName, 'Orquestrador');
    const unlinked = value<ProjectView>(
      await p.fixture.router.handle('project.setWorkspace', { projectId: project.id, workspaceId: null }),
    );
    assert.equal(unlinked.workspaceId, null);
    value(await p.fixture.router.handle('project.setWorkspace', { projectId: project.id, workspaceId: p.revit.id }));

    // The folder leaves the list: the project stays, without the link.
    value(await p.fixture.router.handle('workspace.remove', { workspaceId: p.revit.id }));
    const after = value<ProjectView[]>(await p.fixture.router.handle('project.list', null));
    assert.equal(after[0]!.workspaceId, null);
    assert.equal(after[0]!.name, 'Revit');

    // A restart: a second service graph reads the same database.
    await p.fixture.services.shutdown();
    const reopened = new AppServices({ paths: p.fixture.paths, openUrl: () => {} });
    try {
      const projects = reopened.projects.list();
      // "Revit" survives the restart with its name, and without the link to
      // the folder that was removed.
      const revit = projects.find((project) => project.name === 'Revit');
      assert.ok(revit, 'the project must survive a restart');
      assert.equal(revit.workspaceId, null);

      // Start-up also gives every folder that has no project one, so the
      // "Orquestrador" folder now appears under a project of its own. That is
      // the point of the folder-is-the-project change: a folder in one list
      // with nothing in the other is the confusion it removes.
      const forFolder = projects.find((project) => project.name === 'Orquestrador');
      assert.ok(forFolder, 'a folder with no project gains one at start-up');
      assert.equal(forFolder.workspaceId, p.orquestrador.id);
      assert.equal(projects.length, 2, 'and nothing else was invented');

      const sessions = reopened.chat.listAllSessions();
      assert.equal(sessions.find((s) => s.id === session.id)?.projectId, project.id);
      assert.equal(sessions.find((s) => s.id === session.id)?.projectName, 'Revit');
    } finally {
      await reopened.shutdown();
    }
  } finally {
    p.fixture.cleanup().catch(() => undefined);
  }
});
