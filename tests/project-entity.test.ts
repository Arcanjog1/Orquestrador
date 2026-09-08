/**
 * O projeto como a única entidade — as regras que a sidebar depende de terem
 * sido decididas no lugar certo.
 *
 * A reclamação era que a mesma pasta aparecia como projeto *e* como item
 * independente em "Pastas". Tirar a seção da tela resolve o sintoma; o que
 * resolve o problema é o projeto passar a carregar a identidade que a pessoa
 * reconhece — um repositório, uma pasta, ou nenhum dos dois ainda — e nunca
 * duplicar por causa da grafia de um endereço.
 *
 * O que estes testes protegem, em uma linha cada:
 *
 *  - um repositório é um projeto, escrito de qualquer jeito;
 *  - dois repositórios com o mesmo nome final continuam dois projetos;
 *  - arquivar e restaurar não perdem nada e são reversíveis;
 *  - remover é organização, nunca exclusão de arquivo ou de repositório;
 *  - a branch padrão real é preservada, e nunca inventada como `main`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopFixture } from './helpers/desktop-fixture.js';
import type { IpcResult, ProjectView } from '../apps/desktop/src/shared/ipc-contract.js';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

function error(result: IpcResult<unknown>): string {
  assert.equal(result.ok, false, 'expected a refusal');
  return (result as { ok: false; error: { message: string } }).error.message;
}

test('one repository is one project, however its address is written', async () => {
  const fixture = createDesktopFixture();
  try {
    const first = fixture.services.projects.openRepository({
      url: 'https://github.com/Arcanjog1/Orquestrador',
    });
    assert.equal(first.created, true);
    assert.equal(first.project.repositoryFullName, 'Arcanjog1/Orquestrador');
    assert.equal(first.project.source, 'repository');

    for (const spelling of [
      'https://github.com/Arcanjog1/Orquestrador.git',
      'git@github.com:Arcanjog1/Orquestrador.git',
      'ssh://git@github.com/Arcanjog1/Orquestrador',
      'Arcanjog1/Orquestrador',
      'arcanjog1/orquestrador',
      'https://github.com/Arcanjog1/Orquestrador/tree/alguma/branch',
    ]) {
      const again = fixture.services.projects.openRepository({ url: spelling });
      assert.equal(again.created, false, `${spelling} opened the existing project`);
      assert.equal(again.project.id, first.project.id);
    }
    assert.equal(fixture.services.projects.list().length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('two repositories that share a leaf name stay two projects', async () => {
  const fixture = createDesktopFixture();
  try {
    const mine = fixture.services.projects.openRepository({ url: 'Arcanjog1/site' });
    const theirs = fixture.services.projects.openRepository({ url: 'outra-pessoa/site' });
    assert.notEqual(mine.project.id, theirs.project.id);
    assert.equal(theirs.created, true);
    assert.equal(fixture.services.projects.list().length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('the two repositories in the request are two projects, each with its own conversations', async () => {
  const fixture = createDesktopFixture();
  try {
    const a = value<{ project: ProjectView }>(
      await fixture.router.handle('project.connectRepository', {
        url: 'https://github.com/Arcanjog1/Orquestrador',
      }),
    ).project;
    const b = value<{ project: ProjectView }>(
      await fixture.router.handle('project.connectRepository', {
        url: 'https://github.com/Arcanjog1/MeuBotao.pushbutton',
      }),
    ).project;
    assert.notEqual(a.id, b.id);
    assert.equal(a.name, 'Orquestrador');
    assert.equal(b.name, 'MeuBotao.pushbutton');

    // Each opens into its own workspace, so a conversation in one can never
    // execute in the other.
    const openedA = value<{ workspaceId: string }>(
      await fixture.router.handle('project.open', { projectId: a.id }),
    );
    const openedB = value<{ workspaceId: string }>(
      await fixture.router.handle('project.open', { projectId: b.id }),
    );
    assert.notEqual(openedA.workspaceId, openedB.workspaceId);

    for (const [opened, project] of [
      [openedA, a],
      [openedB, b],
    ] as const) {
      for (const title of ['Primeira', 'Segunda', 'Terceira']) {
        value(
          await fixture.router.handle('chat.createSession', {
            workspaceId: opened.workspaceId,
            title: `${title} de ${project.name}`,
            projectId: project.id,
          }),
        );
      }
    }

    const sessions = value<Array<{ projectId: string | null }>>(
      await fixture.router.handle('chat.listAllSessions', {}),
    );
    assert.equal(sessions.filter((s) => s.projectId === a.id).length, 3);
    assert.equal(sessions.filter((s) => s.projectId === b.id).length, 3);
  } finally {
    await fixture.cleanup();
  }
});

test('opening a project never clones and never writes to a folder', async () => {
  const fixture = createDesktopFixture();
  try {
    const connected = fixture.services.projects.openRepository({
      url: 'https://github.com/Arcanjog1/Orquestrador',
    });
    const opened = value<{ workspaceId: string; workspaceCreated: boolean }>(
      await fixture.router.handle('project.open', { projectId: connected.project.id }),
    );
    assert.equal(opened.workspaceCreated, true);

    // The workspace its runs execute in owns no folder on this computer, and
    // says so - a run there analyses and plans, and touches no file.
    const workspace = fixture.services.database.workspaces.require(opened.workspaceId);
    assert.equal(workspace.environment, 'conversation');
    assert.equal(workspace.local_path, '');
    assert.equal(workspace.path_key, '', 'and it can never be matched against a real folder');

    // Opening again is idempotent: no second workspace.
    const again = value<{ workspaceId: string; workspaceCreated: boolean }>(
      await fixture.router.handle('project.open', { projectId: connected.project.id }),
    );
    assert.equal(again.workspaceCreated, false);
    assert.equal(again.workspaceId, opened.workspaceId);
  } finally {
    await fixture.cleanup();
  }
});

test('archiving hides a project with its conversations, and restoring puts it back exactly', async () => {
  const fixture = createDesktopFixture();
  const dir = mkdtempSync(join(tmpdir(), 'lao-archive-'));
  try {
    const opened = value<{ workspace: { id: string }; projectId: string }>(
      await fixture.router.handle('workspace.openProject', { localPath: dir }),
    );
    value(
      await fixture.router.handle('chat.createSession', {
        workspaceId: opened.workspace.id,
        title: 'Conversa',
        projectId: opened.projectId,
      }),
    );

    const archived = value<ProjectView>(
      await fixture.router.handle('project.setArchived', {
        projectId: opened.projectId,
        archived: true,
      }),
    );
    assert.ok(archived.archivedAt, 'it is archived');

    // The conversation went with it: still filed under the project, still
    // holding its messages. Archiving is not moving anything.
    const sessions = value<Array<{ projectId: string | null }>>(
      await fixture.router.handle('chat.listAllSessions', {}),
    );
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.projectId, opened.projectId);
    // And the folder is still a workspace, untouched.
    assert.ok(fixture.services.database.workspaces.find(opened.workspace.id));

    const restored = value<ProjectView>(
      await fixture.router.handle('project.setArchived', {
        projectId: opened.projectId,
        archived: false,
      }),
    );
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.name, archived.name);
    assert.equal(restored.sessionCount, 1, 'exactly as it was');
  } finally {
    await fixture.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removing a project is organisation: no file, folder or repository is touched', async () => {
  const fixture = createDesktopFixture();
  const dir = mkdtempSync(join(tmpdir(), 'lao-remove-'));
  const canary = join(dir, 'nao-apague.txt');
  try {
    writeFileSync(canary, 'conteúdo que deve sobreviver\n', 'utf8');
    const opened = value<{ workspace: { id: string }; projectId: string }>(
      await fixture.router.handle('workspace.openProject', { localPath: dir }),
    );
    value(
      await fixture.router.handle('project.setRepository', {
        projectId: opened.projectId,
        url: 'https://github.com/Arcanjog1/Orquestrador',
      }),
    );
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', {
        workspaceId: opened.workspace.id,
        title: 'Conversa preservada',
        projectId: opened.projectId,
      }),
    );

    // The plan is told before the act, with the real numbers and paths.
    const plan = value<{
      sessionsAffected: number;
      localPath: string;
      repositoryFullName: string | null;
    }>(await fixture.router.handle('project.removalPlan', { projectId: opened.projectId }));
    assert.equal(plan.sessionsAffected, 1);
    assert.equal(plan.repositoryFullName, 'Arcanjog1/Orquestrador');
    assert.ok(plan.localPath.length > 0);

    const outcome = value<{ removed: boolean; sessionsMoved: number }>(
      await fixture.router.handle('project.remove', { projectId: opened.projectId }),
    );
    assert.equal(outcome.removed, true);
    assert.equal(outcome.sessionsMoved, 1);

    // The four things that must survive.
    assert.equal(existsSync(canary), true, 'the file is still there');
    assert.equal(readFileSync(canary, 'utf8'), 'conteúdo que deve sobreviver\n');
    assert.ok(fixture.services.database.workspaces.find(opened.workspace.id), 'the folder is known');
    const kept = fixture.services.database.chat.requireSession(session.id);
    assert.equal(kept.title, 'Conversa preservada');
    assert.equal(kept.project_id, null, 'moved to "Sem projeto", not deleted');
  } finally {
    await fixture.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real default branch and commit are preserved, and never invented', async () => {
  const fixture = createDesktopFixture();
  try {
    const connected = fixture.services.projects.openRepository({
      url: 'https://github.com/Arcanjog1/Orquestrador',
    });

    // Before anything is read, the branch is unknown - not `main`.
    assert.equal(connected.project.defaultBranch, null);
    assert.equal(connected.project.analysedCommit, null);

    // What GitHub reported is what is stored, whatever it is called. This
    // repository's default branch is deliberately not `main`.
    const withMetadata = fixture.services.projects.recordRepositoryMetadata(connected.project.id, {
      fullName: 'Arcanjog1/Orquestrador',
      isPrivate: false,
      defaultBranch: 'claude/new-session-3am7mo',
    });
    assert.equal(withMetadata.defaultBranch, 'claude/new-session-3am7mo');
    assert.notEqual(withMetadata.defaultBranch, 'main');

    // And what was actually read is recorded as a branch plus a commit, so an
    // analysis names something checkable.
    const analysed = fixture.services.projects.recordAnalysis(connected.project.id, {
      branch: 'claude/ai-orchestrator-buzz-arch-vblrau',
      commit: '61c622e11a4525b1ffb4d3499c22955eb203daf1',
    });
    assert.equal(analysed.analysedBranch, 'claude/ai-orchestrator-buzz-arch-vblrau');
    assert.equal(analysed.analysedCommit, '61c622e11a4525b1ffb4d3499c22955eb203daf1');
    assert.ok(analysed.analysedAt);

    // Pointing the project at a *different* repository clears the branch
    // rather than carrying a stale answer under a fresh label.
    const moved = fixture.services.projects.setRepository(
      connected.project.id,
      'https://github.com/Arcanjog1/MeuBotao.pushbutton',
    );
    assert.equal(moved.defaultBranch, null);
  } finally {
    await fixture.cleanup();
  }
});

test('a repository that already belongs to a project is refused with that project’s name', async () => {
  const fixture = createDesktopFixture();
  try {
    fixture.services.projects.openRepository({
      url: 'https://github.com/Arcanjog1/Orquestrador',
      name: 'O meu orquestrador',
    });
    const other = fixture.services.projects.create({ name: 'Outro' });

    const message = error(
      await fixture.router.handle('project.setRepository', {
        projectId: other.id,
        url: 'arcanjog1/orquestrador',
      }),
    );
    assert.match(message, /O meu orquestrador/, 'the message names where it already is');
  } finally {
    await fixture.cleanup();
  }
});

test('an address that is not a repository is refused, and nothing is created', async () => {
  const fixture = createDesktopFixture();
  try {
    const before = fixture.services.projects.list().length;
    const message = error(
      await fixture.router.handle('project.connectRepository', {
        url: 'https://exemplo.com/nao-e-um-repositorio',
      }),
    );
    assert.match(message, /GitHub/);
    assert.equal(fixture.services.projects.list().length, before, 'no stray project');
  } finally {
    await fixture.cleanup();
  }
});

test('every workspace has a project, so nothing can be invisible now that "Pastas" is gone', async () => {
  const fixture = createDesktopFixture();
  const dir = mkdtempSync(join(tmpdir(), 'lao-visible-'));
  try {
    // The three kinds of workspace that exist, created the three ways.
    value(await fixture.router.handle('workspace.openProject', { localPath: dir }));
    value(await fixture.router.handle('workspace.createConversation', { name: 'Só conversa' }));
    fixture.services.database.workspaces.create({
      id: 'ws-cloud',
      name: 'Na nuvem',
      localPath: '',
      environment: 'cloud',
      repositoryFullName: 'Arcanjog1/Orquestrador',
    });

    const report = fixture.services.workspaces.reconcileFolders(fixture.services.projects);
    assert.ok(report.projectsCreated >= 1);

    const projects = fixture.services.projects.list();
    for (const workspace of fixture.services.database.workspaces.list()) {
      assert.ok(
        projects.some((p) => p.workspaceId === workspace.id),
        `${workspace.display_name} is reachable from the sidebar`,
      );
    }

    // The cloud workspace's repository became the project's identity, so
    // connecting that repository later opens this project instead of making
    // a second one.
    const cloudProject = projects.find((p) => p.workspaceId === 'ws-cloud')!;
    assert.equal(cloudProject.repositoryFullName, 'Arcanjog1/Orquestrador');
    const connected = fixture.services.projects.openRepository({
      url: 'https://github.com/Arcanjog1/Orquestrador',
    });
    assert.equal(connected.created, false);
    assert.equal(connected.project.id, cloudProject.id);
  } finally {
    await fixture.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconciliation never merges two projects that claim one repository', async () => {
  const fixture = createDesktopFixture();
  try {
    // Two projects, both pointing at the same repository - the state an
    // installation can already be in. Deciding which history survives is not
    // a decision a start-up reconciliation gets to make quietly.
    const first = fixture.services.projects.openRepository({ url: 'Arcanjog1/Orquestrador' });
    fixture.services.database.projects.create({
      id: 'proj-duplicate',
      name: 'Cópia antiga',
      repositoryKey: 'github.com/arcanjog1/orquestrador',
      repositoryUrl: 'https://github.com/Arcanjog1/Orquestrador',
      repositoryFullName: 'Arcanjog1/Orquestrador',
      source: 'repository',
    });

    fixture.services.workspaces.reconcileFolders(fixture.services.projects);

    // Both are still there, and both are reported so a person can choose.
    const duplicates = fixture.services.database.projects.duplicateRepositories();
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0]!.projectIds.length, 2);
    assert.ok(fixture.services.database.projects.find(first.project.id));
    assert.ok(fixture.services.database.projects.find('proj-duplicate'));

    // And the oldest wins the lookup: the one whose conversations are in use.
    assert.equal(
      fixture.services.database.projects.findByRepositoryKey('github.com/arcanjog1/orquestrador')?.id,
      first.project.id,
    );
  } finally {
    await fixture.cleanup();
  }
});
