/**
 * Um projeto do GitHub tem identidade antes de ter um checkout.
 *
 * Conectar um repositório cria o projeto; não cria uma pasta de código. Dava
 * para conversar sobre o repositório e não dava para selecionar o projeto e
 * começar a codar — e foi por essa fresta que uma tarefa destinada a um
 * repositório acabou executando numa pasta da Área de Trabalho com nome
 * parecido e sem Git nenhum.
 *
 * `prepare` fecha a fresta com duas ações, e as duas preservam o projeto: o
 * mesmo `projectId`, as mesmas conversas, o mesmo histórico. Nenhuma delas
 * escreve na pasta que recebe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import { createGitFixture, createPlainDir } from './helpers/git-fixture.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';
import type { PreflightResultView, ProjectView } from '../apps/desktop/src/shared/ipc-contract.js';

const REPO = 'https://github.com/Arcanjog1/Orquestrador';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

function failure(result: IpcResult<unknown>): string {
  assert.equal(result.ok, false, 'expected this to be refused');
  return result.ok === false ? result.error.message : '';
}

/** A checkout of `REPO`, made with the real git binary. */
function checkoutOf(url: string, prefix: string) {
  const repo = createGitFixture(prefix);
  repo.write('README.md', '# x\n');
  repo.commitAll('base');
  repo.git('remote', 'add', 'origin', url);
  return repo;
}

test('a repository project starts with no folder, and says so with what to do about it', async () => {
  const fixture = createDesktopFixture();
  try {
    const connected = value<{ project: ProjectView }>(
      await fixture.router.handle('project.connectRepository', { url: REPO }),
    );
    const state = value<PreflightResultView>(
      await fixture.router.handle('project.preflight', { projectId: connected.project.id }),
    );
    assert.equal(state.kind, 'no-workspace');
    assert.equal(state.blocksCodeWork, true);
    assert.deepEqual([...state.actions], ['clone-repository', 'associate-folder']);
    assert.match(state.detail, /Clone o repositório ou associe uma pasta/);
  } finally {
    await fixture.cleanup();
  }
});

test('associating a real checkout prepares the project, and does not make a second one', async () => {
  const fixture = createDesktopFixture();
  const repo = checkoutOf(REPO, 'lao-prep-ok-');
  try {
    const connected = value<{ project: ProjectView }>(
      await fixture.router.handle('project.connectRepository', { url: REPO }),
    );
    const before = value<readonly ProjectView[]>(await fixture.router.handle('project.list', null));

    const prepared = value<{ project: ProjectView; workspaceId: string; preflight: PreflightResultView }>(
      await fixture.router.handle('project.prepare', {
        projectId: connected.project.id,
        mode: 'associate',
        localPath: repo.dir,
      }),
    );

    assert.equal(prepared.project.id, connected.project.id, 'the same project, not a new one');
    assert.equal(prepared.preflight.kind, 'ready');
    assert.equal(prepared.preflight.blocksCodeWork, false);
    assert.equal(prepared.preflight.branch, 'main');

    const after = value<readonly ProjectView[]>(await fixture.router.handle('project.list', null));
    assert.equal(after.length, before.length, 'no duplicate project appeared');
    assert.equal(after.find((p) => p.id === connected.project.id)?.workspaceId, prepared.workspaceId);
  } finally {
    repo.cleanup();
    await fixture.cleanup();
  }
});

test('associating a folder that is not this repository is refused, and nothing is attached', async () => {
  const fixture = createDesktopFixture();
  // The incident, reproduced: a folder whose name looks right and which is
  // not a checkout of anything.
  const lookalike = createPlainDir('lao-Orquestrador-claude-new-session-');
  const otherRepo = checkoutOf('https://github.com/Arcanjog1/MeuBotao.pushbutton', 'lao-prep-other-');
  try {
    const connected = value<{ project: ProjectView }>(
      await fixture.router.handle('project.connectRepository', { url: REPO }),
    );

    const notARepo = failure(
      await fixture.router.handle('project.prepare', {
        projectId: connected.project.id,
        mode: 'associate',
        localPath: lookalike.dir,
      }),
    );
    assert.match(notARepo, /não é um checkout deste repositório|não é um repositório Git/);

    const wrongRepo = failure(
      await fixture.router.handle('project.prepare', {
        projectId: connected.project.id,
        mode: 'associate',
        localPath: otherRepo.dir,
      }),
    );
    assert.match(wrongRepo, /MeuBotao\.pushbutton/);

    // And after two refusals the project is exactly where it was.
    const state = value<PreflightResultView>(
      await fixture.router.handle('project.preflight', { projectId: connected.project.id }),
    );
    assert.equal(state.kind, 'no-workspace');
    // Neither folder was touched.
    assert.equal(existsSync(lookalike.dir), true);
    assert.equal(existsSync(join(otherRepo.dir, '.git')), true);
  } finally {
    lookalike.cleanup();
    otherRepo.cleanup();
    await fixture.cleanup();
  }
});

test('a folder already known is reused, and a folder another project owns is refused', async () => {
  const fixture = createDesktopFixture();
  const repo = checkoutOf(REPO, 'lao-prep-reuse-');
  try {
    // The folder is opened first, which creates its own project.
    const opened = value<{ workspace: { id: string }; projectId: string }>(
      await fixture.router.handle('workspace.openProject', { localPath: repo.dir }),
    );
    const connected = value<{ project: ProjectView }>(
      await fixture.router.handle('project.connectRepository', { url: REPO }),
    );

    const refused = failure(
      await fixture.router.handle('project.prepare', {
        projectId: connected.project.id,
        mode: 'associate',
        localPath: repo.dir,
      }),
    );
    assert.match(refused, /já pertence ao projeto/, 'taking it would move somebody else\'s work');

    // The project that owns the folder can be prepared with it, and that is a
    // reuse rather than a second workspace for the same directory.
    const prepared = value<{ workspaceId: string; reusedWorkspace: boolean }>(
      await fixture.router.handle('project.prepare', {
        projectId: opened.projectId,
        mode: 'associate',
        localPath: repo.dir,
      }),
    );
    assert.equal(prepared.reusedWorkspace, true);
    assert.equal(prepared.workspaceId, opened.workspace.id);
  } finally {
    repo.cleanup();
    await fixture.cleanup();
  }
});

test('a plain folder project is never measured against a repository', async () => {
  const fixture = createDesktopFixture();
  const plain = createPlainDir('lao-prep-plain-');
  try {
    const opened = value<{ projectId: string }>(
      await fixture.router.handle('workspace.openProject', { localPath: plain.dir }),
    );
    const state = value<PreflightResultView>(
      await fixture.router.handle('project.preflight', { projectId: opened.projectId }),
    );
    // No git, no repository declared, nothing blocked: this is the hello.txt
    // case and it has to keep working.
    assert.equal(state.kind, 'ready-without-git');
    assert.equal(state.blocksCodeWork, false);
  } finally {
    plain.cleanup();
    await fixture.cleanup();
  }
});

test('cloning refuses a project with no repository, and never merges into an existing folder', async () => {
  const fixture = createDesktopFixture();
  const plain = createPlainDir('lao-prep-clone-');
  const parent = mkdtempSync(join(tmpdir(), 'lao-prep-parent-'));
  try {
    const opened = value<{ projectId: string }>(
      await fixture.router.handle('workspace.openProject', { localPath: plain.dir }),
    );
    const refused = failure(
      await fixture.router.handle('project.prepare', {
        projectId: opened.projectId,
        mode: 'clone',
        parentPath: parent,
      }),
    );
    assert.match(refused, /não está ligado a um repositório/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    plain.cleanup();
    await fixture.cleanup();
  }
});

test('a run whose folder is not the declared repository stops before delegating anything', async () => {
  // The incident end to end. The project says `Arcanjog1/Orquestrador`; the
  // folder is a checkout of something else. Before this, the run went ahead:
  // one delegation wrote a baseline document, the next failed, and the router
  // escalated on "no progress". None of that can happen now, because nothing
  // is delegated at all.
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', ['{"action":"done"}']);
  const worker = new ScriptedAgent('mock-claude', 'Claude', ['feito']);
  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    maxIterations: 4,
  });
  const otherRepo = checkoutOf('https://github.com/Arcanjog1/MeuBotao.pushbutton', 'lao-prep-run-');
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.create', {
        name: 'Orquestrador',
        localPath: otherRepo.dir,
        repositoryUrl: REPO,
      }),
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
        text: 'Implemente o relatório estruturado do worker',
      }),
    );
    const run = await fixture.services.orchestration.waitFor(sent.run.id);

    assert.equal(run.status, 'NEEDS_HUMAN');
    assert.match(run.summary ?? '', /outro repositório/i);
    assert.match(run.summary ?? '', /MeuBotao\.pushbutton/);
    assert.equal(orchestrator.calls.length, 0, 'not one model call was paid for');
    assert.equal(worker.calls.length, 0, 'and nothing was delegated');

    const steps = fixture.services.database.runs.steps(sent.run.id);
    const preflight = steps.find((step) => step.phase === 'preflight');
    assert.equal(preflight?.status, 'blocked');
    assert.match(preflight?.summary ?? '', /Esta pasta é de outro repositório/);

    // And no attempt was recorded, so there is nothing for the router to
    // escalate on: a wrong workspace never buys a stronger model.
    const invocations = fixture.services.database.runs.invocations(sent.run.id);
    assert.equal(invocations.length, 0);
  } finally {
    otherRepo.cleanup();
    await fixture.cleanup();
  }
});
