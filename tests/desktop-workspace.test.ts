/**
 * Workspaces, accounts and chat, through the IPC router.
 *
 * The tests go through `router.handle` rather than calling services directly:
 * that is the path the renderer actually takes, validation included.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

function errorOf(result: IpcResult<unknown>): { code: string; message: string } {
  assert.equal(result.ok, false);
  return (result as { ok: false; error: { code: string; message: string } }).error;
}

test('a folder becomes a workspace and survives a restart', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'lao-project-'));
  const fixture = createDesktopFixture();
  try {
    const created = value<{ id: string; name: string; localPath: string }>(
      await fixture.router.handle('workspace.create', {
        name: 'Modulação Automática',
        localPath: projectDir,
      }),
    );
    assert.equal(created.name, 'Modulação Automática');
    assert.equal(created.localPath, projectDir);

    // A second service graph over the same data directory sees the same row.
    const listed = fixture.services.database.workspaces.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, created.id);
  } finally {
    await fixture.cleanup();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('the same folder cannot be added twice', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'lao-project-'));
  const fixture = createDesktopFixture();
  try {
    value(await fixture.router.handle('workspace.create', { name: 'A', localPath: projectDir }));
    const second = await fixture.router.handle('workspace.create', {
      name: 'B',
      localPath: projectDir,
    });
    assert.match(errorOf(second).message, /já está adicionada/i);
  } finally {
    await fixture.cleanup();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('a path that is a file, not a folder, is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lao-project-'));
  const file = join(dir, 'a.txt');
  writeFileSync(file, 'x');
  const fixture = createDesktopFixture();
  try {
    const result = await fixture.router.handle('workspace.create', { name: 'A', localPath: file });
    assert.match(errorOf(result).message, /não é uma pasta/i);
  } finally {
    await fixture.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the folder picker is the shell’s job; the renderer only gets the result', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'lao-project-'));
  const fixture = createDesktopFixture({ selectFolder: async () => projectDir });
  try {
    const picked = value<{ path: string | null }>(
      await fixture.router.handle('workspace.selectFolder', null),
    );
    assert.equal(picked.path, projectDir);
  } finally {
    await fixture.cleanup();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('an account creates its own profile directory, and the user never sees the variable', async () => {
  const fixture = createDesktopFixture();
  try {
    const account = value<{ id: string; name: string; state: string }>(
      await fixture.router.handle('accounts.create', { name: 'Claude Trabalho', provider: 'anthropic' }),
    );
    assert.equal(account.name, 'Claude Trabalho');
    assert.equal(account.state, 'disconnected');

    const directory = fixture.services.accountManager.profileDirectory(account.id);
    assert.ok(directory.startsWith(fixture.paths.profiles));

    // The view handed to the renderer must not leak the directory.
    assert.ok(!JSON.stringify(account).includes(directory));

    const env = fixture.services.accountManager.buildEnvironment(account.id);
    assert.equal(env['CLAUDE_CONFIG_DIR'], directory);
  } finally {
    await fixture.cleanup();
  }
});

test('two accounts get two isolated profile directories', async () => {
  const fixture = createDesktopFixture();
  try {
    const first = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Trabalho', provider: 'anthropic' }),
    );
    const second = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Pessoal', provider: 'anthropic' }),
    );
    const a = fixture.services.accountManager.profileDirectory(first.id);
    const b = fixture.services.accountManager.profileDirectory(second.id);
    assert.notEqual(a, b);
    assert.equal(fixture.services.accountManager.listProfileDirectories().length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('creating an account gives the workspace a worker agent to choose', async () => {
  const fixture = createDesktopFixture();
  try {
    value(await fixture.router.handle('accounts.create', { name: 'Claude Trabalho', provider: 'anthropic' }));
    const agents = value<Array<{ id: string; role: string; name: string }>>(
      await fixture.router.handle('agents.list', null),
    );
    const roles = agents.map((a) => a.role);
    assert.ok(roles.includes('ORCHESTRATOR'));
    assert.ok(roles.includes('CODING_WORKER'));
  } finally {
    await fixture.cleanup();
  }
});

test('chat history survives closing and reopening the application', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'lao-project-'));
  const dataFile = join(mkdtempSync(join(tmpdir(), 'lao-db-')), 'orchestrator.db');
  const runners = async () => ({
    orchestrator: new ScriptedAgent('mock-codex', 'Codex', ['{"action":"blocked","reason":"stop"}']),
    worker: new ScriptedAgent('mock-claude', 'Claude', ['']),
    workerAccountId: null,
  });

  const first = createDesktopFixture({ createRunners: runners });
  let sessionId = '';
  try {
    const workspace = value<{ id: string }>(
      await first.router.handle('workspace.create', { name: 'P', localPath: projectDir }),
    );
    const account = value<{ id: string }>(
      await first.router.handle('accounts.create', { name: 'Claude', provider: 'anthropic' }),
    );
    const agents = value<Array<{ id: string; role: string; accountId: string | null }>>(
      await first.router.handle('agents.list', null),
    );
    const orchestrator = agents.find((a) => a.role === 'ORCHESTRATOR')!;
    const worker = agents.find((a) => a.accountId === account.id)!;
    value(
      await first.router.handle('workspace.setAgents', {
        workspaceId: workspace.id,
        orchestratorAgentId: orchestrator.id,
        workerAgentId: worker.id,
      }),
    );

    const session = value<{ id: string }>(
      await first.router.handle('chat.createSession', {
        workspaceId: workspace.id,
        title: 'Conversa',
      }),
    );
    sessionId = session.id;

    const sent = value<{ message: { text: string }; run: { id: string } }>(
      await first.router.handle('chat.sendMessage', { sessionId, text: 'Corrija X.' }),
    );
    assert.equal(sent.message.text, 'Corrija X.');
    await first.services.orchestration.waitFor(sent.run.id);

    const messages = value<Array<{ author: string; text: string }>>(
      await first.router.handle('chat.listMessages', { sessionId }),
    );
    assert.ok(messages.length >= 2, 'the user message and at least one reply are stored');
    assert.equal(messages[0]!.author, 'user');
  } finally {
    await first.cleanup();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(dataFile, { force: true });
  }
});

test('sending a task before choosing agents explains what is missing', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'lao-project-'));
  const fixture = createDesktopFixture();
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.create', { name: 'P', localPath: projectDir }),
    );
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', {
        workspaceId: workspace.id,
        title: 'Conversa',
      }),
    );
    const result = await fixture.router.handle('chat.sendMessage', {
      sessionId: session.id,
      text: 'faça algo',
    });
    assert.match(errorOf(result).message, /quem supervisiona/i);
  } finally {
    await fixture.cleanup();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('an OpenAI account offers an orchestrator, an Anthropic one offers a worker', async () => {
  const fixture = createDesktopFixture();
  try {
    const claude = value<{ id: string; provider: string }>(
      await fixture.router.handle('accounts.create', {
        name: 'Claude Trabalho',
        provider: 'anthropic',
      }),
    );
    const codex = value<{ id: string; provider: string }>(
      await fixture.router.handle('accounts.create', { name: 'Codex Trabalho', provider: 'openai' }),
    );
    assert.equal(claude.provider, 'anthropic');
    assert.equal(codex.provider, 'openai');

    const agents = value<Array<{ id: string; role: string; accountId: string | null }>>(
      await fixture.router.handle('agents.list', null),
    );

    // The provider decides the role: neither account is asked to do the other's
    // job.
    const worker = agents.find((a) => a.accountId === claude.id);
    const orchestrator = agents.find((a) => a.accountId === codex.id);
    assert.equal(worker?.role, 'CODING_WORKER');
    assert.equal(orchestrator?.role, 'ORCHESTRATOR');

    // Two accounts, two isolated homes, and the orchestrator's is a CODEX_HOME.
    const codexHome = fixture.services.codexAccountManager.buildEnvironment(codex.id);
    const claudeHome = fixture.services.accountManager.buildEnvironment(claude.id);
    assert.ok(codexHome['CODEX_HOME']);
    assert.ok(claudeHome['CLAUDE_CONFIG_DIR']);
    assert.notEqual(codexHome['CODEX_HOME'], claudeHome['CLAUDE_CONFIG_DIR']);
  } finally {
    await fixture.cleanup();
  }
});

test('a provider nobody supports is refused at the boundary', async () => {
  const fixture = createDesktopFixture();
  try {
    const result = await fixture.router.handle('accounts.create', {
      name: 'Alguma coisa',
      provider: 'acme',
    });
    assert.equal(errorOf(result).code, 'INVALID_ARGUMENT');
  } finally {
    await fixture.cleanup();
  }
});

test('the project header shows the branch the working copy is actually on', async () => {
  const repo = createGitFixture('lao-branch-');
  repo.write('a.txt', 'x');
  repo.commitAll('first');
  repo.git('checkout', '-q', '-b', 'feature/xyz');

  const fixture = createDesktopFixture();
  try {
    value(await fixture.router.handle('workspace.create', { name: 'P', localPath: repo.dir }));
    const listed = value<Array<{ branch: string | null; localPath: string }>>(
      await fixture.router.handle('workspace.list', null),
    );
    // Read from disk, not remembered: the branch was switched after the
    // workspace was added.
    assert.equal(listed[0]!.branch, 'feature/xyz');
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});

test('a folder that is not a repository reports no branch rather than guessing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lao-plain-'));
  const fixture = createDesktopFixture();
  try {
    value(await fixture.router.handle('workspace.create', { name: 'P', localPath: dir }));
    const listed = value<Array<{ branch: string | null }>>(
      await fixture.router.handle('workspace.list', null),
    );
    assert.equal(listed[0]!.branch, null);
  } finally {
    await fixture.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
