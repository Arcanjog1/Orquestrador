/**
 * The folder is the project (spec 1, 2, 3, 13).
 *
 * The complaint: selecting a folder produced a confusing structure with the
 * project and the folder separate, and selecting the same folder again made a
 * duplicate instead of opening what was there.
 *
 * Two causes, both pinned here. Selecting a folder created a *workspace* and
 * no *project*, so the folder appeared in one list and nothing appeared in the
 * other. And the "do I already have this folder?" check compared the spelling
 * of the path, which on Windows the same folder has several of.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { folderKey, sameFolder, suggestedProjectName } from '../src/workspace/folder-identity.js';
import { createDesktopFixture, type DesktopFixture } from './helpers/desktop-fixture.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

/* ================================================================== *
 * Folder identity
 * ================================================================== */

/** No filesystem: these are about the spelling rules, not about real folders. */
const lexical = { realpath: () => null };

test('on Windows, the same folder spelled differently is one folder', () => {
  const win = { platform: 'win32' as const, ...lexical };
  const canonical = folderKey('C:\\Users\\Me\\Proj', win);

  // Case: NTFS is case-insensitive, and the shell hands back either.
  assert.equal(folderKey('c:\\users\\me\\proj', win), canonical);
  // Separator: both are accepted, and a pasted path may use either.
  assert.equal(folderKey('C:/Users/Me/Proj', win), canonical);
  // Trailing separator: not a different folder.
  assert.equal(folderKey('C:\\Users\\Me\\Proj\\', win), canonical);
  // All three at once, which is what actually happens.
  assert.equal(folderKey('c:/USERS/me/proj/', win), canonical);
});

test('on POSIX, case is not folded, because there they really are two folders', () => {
  const posix = { platform: 'posix' as const, ...lexical };
  assert.notEqual(folderKey('/home/me/Proj', posix), folderKey('/home/me/proj', posix));
  // Separators and trailing slashes still normalise.
  assert.equal(folderKey('/home/me/Proj/', posix), folderKey('/home/me/Proj', posix));
});

test('two folders that merely share a name are never the same project', () => {
  const win = { platform: 'win32' as const, ...lexical };
  // The trap the rule exists to avoid: folding these would pour one client's
  // conversations into another's.
  assert.equal(sameFolder('D:\\clientes\\acme\\site', 'D:\\clientes\\beta\\site', win), false);
  assert.equal(sameFolder('/a/site', '/b/site', { platform: 'posix', ...lexical }), false);
});

test('a project with no folder matches nothing, not even another with no folder', () => {
  // Conversation and cloud projects own no folder. If empty matched empty,
  // every one of them would collapse into a single project.
  assert.equal(folderKey(''), '');
  assert.equal(folderKey('   '), '');
  assert.equal(sameFolder('', ''), false);
  assert.equal(sameFolder('', 'C:\\Proj'), false);
});

test('a junction or symlink and its target are one folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'lao-link-'));
  try {
    const real = join(root, 'real');
    mkdirSync(real);
    const link = join(root, 'link');
    try {
      symlinkSync(real, link, 'junction');
    } catch {
      return; // No permission to create links here; the rule is still tested above.
    }
    // The filesystem is asked, so the two paths answer with one identity.
    assert.equal(sameFolder(link, real), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a folder that does not exist still has a stable identity', () => {
  // Nothing to ask the filesystem about, so the lexical form is used - and it
  // is consistent, which is what matters for "have I seen this before?".
  const missing = join(tmpdir(), 'lao-does-not-exist-abc123');
  assert.equal(folderKey(missing), folderKey(missing));
  assert.ok(folderKey(missing).length > 0);
});

test('the suggested name is the folder, and a root is named by the root', () => {
  // The ordinary case: the leaf, which is what a person calls the folder.
  assert.equal(suggestedProjectName(`${sep}home${sep}me${sep}Orquestrador`), 'Orquestrador');
  assert.equal(suggestedProjectName(`${sep}home${sep}me${sep}Orquestrador${sep}`), 'Orquestrador');

  // A root has no leaf. On Windows it resolves to a drive root such as `D:\`,
  // and naming the project after the drive is the honest answer - `D:` alone
  // would be punctuation, and inventing "Projeto" would name it after nothing.
  // What matters is that the name is readable and identifies the folder, so
  // that is what this asserts rather than a rule about one character.
  const root = suggestedProjectName(sep);
  assert.ok(root.length > 0, 'a root must still get a name');
  assert.notEqual(root, sep, 'a bare separator is not a name');
  assert.ok(/[A-Za-z0-9]/.test(root), `a name must be readable, got ${JSON.stringify(root)}`);

  // And a name is never derived from anything but the path itself.
  assert.equal(suggestedProjectName(`${sep}a${sep}site`), 'site');
  assert.equal(suggestedProjectName(`${sep}b${sep}site`), 'site');
});

/* ================================================================== *
 * Folder → project → sessions
 * ================================================================== */

function folder(prefix = 'lao-proj-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function open(fixture: DesktopFixture, localPath: string) {
  return value<{ workspace: { id: string; name: string; localPath: string }; projectId: string; created: boolean }>(
    await fixture.router.handle('workspace.openProject', { localPath }),
  );
}

test('selecting a folder gives it a project, in one step', async () => {
  const fixture = createDesktopFixture();
  const f = folder();
  try {
    const opened = await open(fixture, f.dir);

    assert.equal(opened.created, true);
    assert.equal(opened.workspace.localPath, f.dir);
    // The thing that was missing: a project exists for the folder, so the
    // folder is not in one list with nothing in the other.
    const projects = value<Array<{ id: string; name: string; workspaceId: string | null }>>(
      await fixture.router.handle('project.list', null),
    );
    const project = projects.find((p) => p.id === opened.projectId);
    assert.ok(project, 'the folder must have a project');
    assert.equal(project.workspaceId, opened.workspace.id, 'and it must point at the folder');
  } finally {
    await fixture.cleanup();
    f.cleanup();
  }
});

test('selecting the same folder again opens it, and never duplicates it', async () => {
  const fixture = createDesktopFixture();
  const f = folder();
  try {
    const first = await open(fixture, f.dir);
    const second = await open(fixture, f.dir);

    assert.equal(second.created, false, 'the second time is an open, not a create');
    assert.equal(second.workspace.id, first.workspace.id);
    assert.equal(second.projectId, first.projectId);

    const workspaces = value<Array<{ id: string }>>(await fixture.router.handle('workspace.list', null));
    assert.equal(workspaces.length, 1, 'one folder, one workspace');
    const projects = value<Array<{ id: string }>>(await fixture.router.handle('project.list', null));
    assert.equal(projects.length, 1, 'one folder, one project');
  } finally {
    await fixture.cleanup();
    f.cleanup();
  }
});

test('the same folder spelled differently is still the same project', async () => {
  const fixture = createDesktopFixture();
  const f = folder();
  try {
    const first = await open(fixture, f.dir);
    // A trailing separator, and a detour through `.` - both are things a real
    // path picker and a pasted path produce.
    const second = await open(fixture, `${f.dir}${sep}`);
    const third = await open(fixture, join(f.dir, '.'));

    assert.equal(second.workspace.id, first.workspace.id);
    assert.equal(third.workspace.id, first.workspace.id);
    assert.equal(
      value<unknown[]>(await fixture.router.handle('workspace.list', null)).length,
      1,
    );
  } finally {
    await fixture.cleanup();
    f.cleanup();
  }
});

test('two different folders are two projects, even with the same folder name', async () => {
  const fixture = createDesktopFixture();
  const a = folder('lao-a-');
  const b = folder('lao-b-');
  try {
    // Same leaf name under two different parents: the case that must not fold.
    const leafA = join(a.dir, 'site');
    const leafB = join(b.dir, 'site');
    mkdirSync(leafA);
    mkdirSync(leafB);

    const first = await open(fixture, leafA);
    const second = await open(fixture, leafB);

    assert.notEqual(first.workspace.id, second.workspace.id);
    assert.notEqual(first.projectId, second.projectId);
    assert.equal(value<unknown[]>(await fixture.router.handle('project.list', null)).length, 2);
  } finally {
    await fixture.cleanup();
    a.cleanup();
    b.cleanup();
  }
});

test('several sessions live in one project, and each keeps its own history', async () => {
  const fixture = createDesktopFixture();
  const f = folder();
  try {
    const opened = await open(fixture, f.dir);

    const first = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', {
        workspaceId: opened.workspace.id,
        title: 'Corrigir atualização',
        projectId: opened.projectId,
      }),
    );
    const second = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', {
        workspaceId: opened.workspace.id,
        title: 'Melhorar interface',
        projectId: opened.projectId,
      }),
    );

    // Two conversations, one project, and still exactly one project.
    assert.notEqual(first.id, second.id);
    assert.equal(value<unknown[]>(await fixture.router.handle('project.list', null)).length, 1);

    const sessions = value<Array<{ id: string; projectId: string | null }>>(
      await fixture.router.handle('chat.listAllSessions', {}),
    );
    const mine = sessions.filter((s) => s.projectId === opened.projectId);
    assert.equal(mine.length, 2);

    // Their histories are separate: a message in one is not in the other.
    fixture.services.database.chat.addMessage({
      sessionId: first.id,
      runId: null,
      author: 'user',
      body: 'só nesta',
    });
    const firstMessages = value<unknown[]>(
      await fixture.router.handle('chat.listMessages', { sessionId: first.id }),
    );
    const secondMessages = value<unknown[]>(
      await fixture.router.handle('chat.listMessages', { sessionId: second.id }),
    );
    assert.equal(firstMessages.length, 1);
    assert.equal(secondMessages.length, 0, 'a project is shared; a history is not');
  } finally {
    await fixture.cleanup();
    f.cleanup();
  }
});

test('renaming the project does not rename the folder', async () => {
  const fixture = createDesktopFixture();
  const f = folder();
  try {
    const opened = await open(fixture, f.dir);
    value(await fixture.router.handle('project.rename', { projectId: opened.projectId, name: 'Orquestrador' }));

    const projects = value<Array<{ id: string; name: string }>>(
      await fixture.router.handle('project.list', null),
    );
    assert.equal(projects.find((p) => p.id === opened.projectId)?.name, 'Orquestrador');
    // The folder on disk is exactly where it was, under its own name.
    const workspaces = value<Array<{ id: string; localPath: string }>>(
      await fixture.router.handle('workspace.list', null),
    );
    assert.equal(workspaces.find((w) => w.id === opened.workspace.id)?.localPath, f.dir);
    // And opening the folder again still finds the renamed project.
    const again = await open(fixture, f.dir);
    assert.equal(again.projectId, opened.projectId);
    assert.equal(again.created, false);
  } finally {
    await fixture.cleanup();
    f.cleanup();
  }
});

test('a path that is not a usable folder is refused with a reason', async () => {
  const fixture = createDesktopFixture();
  try {
    const missing = join(tmpdir(), 'lao-nope-98765', 'sub');
    const result = await fixture.router.handle('workspace.openProject', { localPath: missing });
    assert.equal(result.ok, false);
    if (result.ok === false) {
      // A sentence about the folder, not a stack trace.
      assert.match(result.error.message, /pasta|não existe|não encontr/i);
    }
    // And nothing was half-created on the way to failing.
    assert.equal(value<unknown[]>(await fixture.router.handle('workspace.list', null)).length, 0);
    assert.equal(value<unknown[]>(await fixture.router.handle('project.list', null)).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

/* ================================================================== *
 * Migration
 * ================================================================== */

test('an installation from before this keeps its sessions and gains a project', async () => {
  const first = createDesktopFixture();
  const f = folder();
  let workspaceId = '';
  let sessionId = '';
  let runId = '';
  try {
    // The old shape, written the way an upgraded database really holds it:
    // a workspace row with no project and no `path_key`. Going through the
    // service would use today's code, which fills both in - and would test
    // the new path rather than the migration.
    workspaceId = 'ws-legacy-1';
    first.services.database.workspaces.create({
      id: workspaceId,
      name: 'Antigo',
      localPath: f.dir,
    });
    const session = value<{ id: string }>(
      await first.router.handle('chat.createSession', { workspaceId, title: 'Conversa antiga' }),
    );
    sessionId = session.id;
    first.services.database.chat.addMessage({
      sessionId,
      runId: null,
      author: 'user',
      body: 'histórico que não pode sumir',
    });
    const run = first.services.database.runs.create({
      id: 'run-legacy-1',
      sessionId,
      workspaceId,
      objective: 'algo antigo',
      orchestratorAgentId: null,
      maxIterations: 4,
    });
    runId = run.id;

    // The reconciliation the next start-up performs.
    const report = first.services.workspaces.reconcileFolders(first.services.projects);
    assert.equal(report.projectsCreated, 1, 'the folder gains a project');
    assert.ok(report.keysBackfilled >= 1, 'and a folder identity');
    assert.deepEqual(report.duplicateFolders, []);

    // Nothing was lost.
    assert.equal(
      value<unknown[]>(await first.router.handle('chat.listMessages', { sessionId })).length,
      1,
      'messages survive',
    );
    assert.ok(first.services.database.runs.find(runId), 'runs survive');
    const sessions = value<Array<{ id: string }>>(
      await first.router.handle('chat.listAllSessions', {}),
    );
    assert.ok(sessions.some((s) => s.id === sessionId), 'sessions survive');

    // And the folder now opens the project it was given, rather than making one.
    const opened = await open(first, f.dir);
    assert.equal(opened.created, false);
    assert.equal(opened.workspace.id, workspaceId);
  } finally {
    await first.cleanup();
    f.cleanup();
  }
});

test('the reconciliation is idempotent: running it twice changes nothing the second time', async () => {
  const fixture = createDesktopFixture();
  const f = folder();
  try {
    fixture.services.database.workspaces.create({
      id: 'ws-legacy-2',
      name: 'Antigo',
      localPath: f.dir,
    });

    const first = fixture.services.workspaces.reconcileFolders(fixture.services.projects);
    const second = fixture.services.workspaces.reconcileFolders(fixture.services.projects);

    assert.equal(first.projectsCreated, 1);
    assert.equal(second.projectsCreated, 0, 'a second start-up must not add a second project');
    assert.equal(second.keysBackfilled, 0);
    assert.equal(value<unknown[]>(await fixture.router.handle('project.list', null)).length, 1);
  } finally {
    await fixture.cleanup();
    f.cleanup();
  }
});

test('two workspaces on one folder are reported, never merged', async () => {
  const fixture = createDesktopFixture();
  const f = folder();
  try {
    // The shape an older installation can already be in: two rows, two sets
    // of conversations, one folder. Written straight to the database, because
    // the service now refuses to create the second one.
    const database = fixture.services.database;
    for (const [id, name] of [
      ['ws-dup-1', 'Primeiro'],
      ['ws-dup-2', 'Segundo'],
    ] as const) {
      database.workspaces.create({ id, name, localPath: f.dir });
      database.chat.createSession({ id: `chat-${id}`, workspaceId: id, title: `Conversa de ${name}` });
    }

    const report = fixture.services.workspaces.reconcileFolders(fixture.services.projects);

    assert.equal(report.duplicateFolders.length, 1, 'the clash is reported');
    assert.deepEqual(report.duplicateFolders[0]!.workspaceIds, ['ws-dup-1', 'ws-dup-2']);
    // Both are still there, with their conversations. Choosing which history
    // survives is not a migration's decision.
    assert.equal(value<unknown[]>(await fixture.router.handle('workspace.list', null)).length, 2);
    const sessions = value<Array<{ id: string }>>(
      await fixture.router.handle('chat.listAllSessions', {}),
    );
    assert.equal(sessions.length, 2, 'no conversation was deleted');

    // Opening the folder picks the older one - the one the history belongs to.
    const opened = await open(fixture, f.dir);
    assert.equal(opened.workspace.id, 'ws-dup-1');
    assert.equal(opened.created, false);
  } finally {
    await fixture.cleanup();
    f.cleanup();
  }
});

test('a conversation project is never matched against a folder', async () => {
  const fixture = createDesktopFixture();
  const f = folder();
  try {
    const conversation = value<{ id: string }>(
      await fixture.router.handle('workspace.createConversation', { name: 'Só conversa' }),
    );
    // It *does* get a project, and it gets it immediately - not at the next
    // start-up. With "Pastas" gone from the sidebar, a workspace with no
    // project is invisible, and invisible reads as deleted however carefully
    // the rows are preserved. A project created five seconds ago must not
    // wait for a restart to appear.
    assert.ok(
      fixture.services.database.projects.findByWorkspace(conversation.id),
      'the project exists as soon as the workspace does',
    );

    // So reconciliation, which exists for installations that predate this,
    // finds nothing left to do.
    const report = fixture.services.workspaces.reconcileFolders(fixture.services.projects);
    assert.equal(report.projectsCreated, 0);
    assert.deepEqual(report.duplicateFolders, []);

    // What it must never get is a folder identity. This is the assertion the
    // test is really for: an empty key would let a project that owns no
    // directory be matched against a real one.
    const record = fixture.services.database.workspaces.require(conversation.id);
    assert.equal(record.path_key, '');

    // And opening a real folder does not attach itself to it: a second
    // workspace, a second project, no merging.
    const opened = await open(fixture, f.dir);
    assert.equal(opened.created, true);
    assert.equal(value<unknown[]>(await fixture.router.handle('workspace.list', null)).length, 2);
    const projects = fixture.services.projects.list();
    assert.equal(projects.length, 2);
    assert.notEqual(
      projects.find((p) => p.workspaceId === conversation.id)?.id,
      projects.find((p) => p.workspaceId === opened.workspace.id)?.id,
    );
  } finally {
    await fixture.cleanup();
    f.cleanup();
  }
});

/* ================================================================== *
 * The provider session, surfaced (spec 5, 6)
 * ================================================================== */

test('the real session id and its resume command reach the details screen', async () => {
  const fixture = createDesktopFixture();
  const f = folder();
  try {
    const opened = await open(fixture, f.dir);
    const account = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Claude Trabalho 1', provider: 'anthropic' }),
    );
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', {
        workspaceId: opened.workspace.id,
        title: 'Sessão',
        projectId: opened.projectId,
      }),
    );
    const run = fixture.services.database.runs.create({
      id: 'run-session-1',
      sessionId: session.id,
      workspaceId: opened.workspace.id,
      objective: 'algo',
      orchestratorAgentId: null,
      maxIterations: 4,
    });
    // What the adapter records after the CLI reports a session id.
    fixture.services.database.agentSessions.remember({
      chatSessionId: session.id,
      connectionId: account.id,
      providerSessionId: 'sess-abc-123',
      adapterId: 'claude-code',
      workingDirectory: f.dir,
    });

    const detail = value<{
      providerSessions: Array<{
        connectionName: string | null;
        providerSessionId: string;
        workingDirectory: string;
        resumeCommand: string;
        adapterId: string;
      }>;
    }>(await fixture.router.handle('run.detail', { runId: run.id }));

    assert.equal(detail.providerSessions.length, 1);
    const [only] = detail.providerSessions;
    // A `-p` session is deliberately absent from Claude Code's own picker, so
    // its id is the only handle a person has. Hiding it is what made the whole
    // thing look like it was not really using Claude Code.
    assert.equal(only!.providerSessionId, 'sess-abc-123');
    assert.equal(only!.connectionName, 'Claude Trabalho 1');
    assert.equal(only!.workingDirectory, f.dir);
    assert.equal(only!.adapterId, 'claude-code');
    // The documented command, ready to copy. Shown, never run by the app.
    assert.equal(only!.resumeCommand, 'claude --resume sess-abc-123');
  } finally {
    await fixture.cleanup();
    f.cleanup();
  }
});

test('two Claude connections in one conversation keep two separate sessions', async () => {
  const fixture = createDesktopFixture();
  const f = folder();
  try {
    const opened = await open(fixture, f.dir);
    const first = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Claude Trabalho 1', provider: 'anthropic' }),
    );
    const second = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Claude Trabalho 2', provider: 'anthropic' }),
    );
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', {
        workspaceId: opened.workspace.id,
        title: 'Sessão',
        projectId: opened.projectId,
      }),
    );
    for (const [account, id] of [
      [first.id, 'sess-conta-1'],
      [second.id, 'sess-conta-2'],
    ] as const) {
      fixture.services.database.agentSessions.remember({
        chatSessionId: session.id,
        connectionId: account,
        providerSessionId: id,
        adapterId: 'claude-code',
        workingDirectory: f.dir,
      });
    }

    // Two rows, and each connection finds only its own. One account's session
    // can never be handed to the other: their transcripts already live in two
    // different CLAUDE_CONFIG_DIRs, and this makes the same separation true of
    // what the application asks for.
    const sessions = fixture.services.database.agentSessions.listForChatSession(session.id);
    assert.equal(sessions.length, 2);
    assert.equal(
      fixture.services.database.agentSessions.find(session.id, first.id, f.dir)?.provider_session_id,
      'sess-conta-1',
    );
    assert.equal(
      fixture.services.database.agentSessions.find(session.id, second.id, f.dir)?.provider_session_id,
      'sess-conta-2',
    );
  } finally {
    await fixture.cleanup();
    f.cleanup();
  }
});

test('a session recorded for another folder is not offered for this one', async () => {
  const fixture = createDesktopFixture();
  const a = folder('lao-ws-a-');
  const b = folder('lao-ws-b-');
  try {
    const opened = await open(fixture, a.dir);
    const account = value<{ id: string }>(
      await fixture.router.handle('accounts.create', { name: 'Claude Trabalho 1', provider: 'anthropic' }),
    );
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', {
        workspaceId: opened.workspace.id,
        title: 'Sessão',
        projectId: opened.projectId,
      }),
    );
    fixture.services.database.agentSessions.remember({
      chatSessionId: session.id,
      connectionId: account.id,
      providerSessionId: 'sess-da-pasta-a',
      adapterId: 'claude-code',
      workingDirectory: a.dir,
    });

    // Claude Code itself would now resume this id from any directory on the
    // machine. The application is deliberately stricter: a session belongs to
    // the folder it was started in, and offering it elsewhere is how a run
    // silently continues the wrong project's context.
    assert.equal(
      fixture.services.database.agentSessions.find(session.id, account.id, a.dir)?.provider_session_id,
      'sess-da-pasta-a',
    );
    assert.equal(
      fixture.services.database.agentSessions.find(session.id, account.id, b.dir),
      undefined,
      'a session from another folder must not be offered',
    );
  } finally {
    await fixture.cleanup();
    a.cleanup();
    b.cleanup();
  }
});
