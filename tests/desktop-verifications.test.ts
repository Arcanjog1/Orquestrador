/**
 * The verifications a project owner configures, through the path the interface
 * uses.
 *
 * Until now the only way to register a `verification_definition` was a script
 * or a test writing the row itself, which meant the one part of the loop that
 * turns a claim into evidence could not be set up from the application. These
 * tests go through the IPC router - the same channels, validators and services
 * the window calls - and then let a real run resolve what was configured.
 *
 * Nothing here seeds the table directly: if a definition exists in these tests,
 * a `verifications.create` call put it there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitFixture, type GitFixture } from './helpers/git-fixture.js';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import type { DesktopFixture } from './helpers/desktop-fixture.js';
import type { IpcResult, VerificationView } from '../apps/desktop/src/shared/ipc-contract.js';
import type { AgentInput } from '../src/core/types.js';

const EXPECTED = 'Olá AI Orchestrator';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

function error(result: IpcResult<unknown>): { code: string; message: string } {
  assert.equal(result.ok, false, 'expected this call to be refused');
  return (result as { ok: false; error: { code: string; message: string } }).error;
}

/** A workspace registered the way the interface registers one. */
async function addWorkspace(
  fixture: DesktopFixture,
  repo: GitFixture,
  name: string,
): Promise<string> {
  const created = value<{ id: string }>(
    await fixture.router.handle('workspace.create', { name, localPath: repo.dir }),
  );
  return created.id;
}

/* ------------------------------------------------------------------ CRUD */

test('a verification added in the interface is stored, listed, edited and removed', async () => {
  const fixture = createDesktopFixture();
  const repo = createGitFixture('lao-verif-');
  repo.write('README.md', '# scratch\n');
  repo.commitAll('baseline');

  try {
    const workspaceId = await addWorkspace(fixture, repo, 'Projeto');

    // Nothing to begin with: a workspace without verifications is legitimate.
    assert.deepEqual(value(await fixture.router.handle('verifications.list', { workspaceId })), []);

    const created = value<VerificationView>(
      await fixture.router.handle('verifications.create', {
        workspaceId,
        id: 'typecheck',
        label: 'TypeScript typecheck',
        command: 'node check.mjs',
      }),
    );
    assert.equal(created.id, 'typecheck');
    assert.equal(created.command, 'node check.mjs');
    assert.equal(created.enabled, true, 'a new verification is active');

    // Listed back through the same channel the screen reads.
    const listed = value<readonly VerificationView[]>(
      await fixture.router.handle('verifications.list', { workspaceId }),
    );
    assert.deepEqual(
      listed.map((v) => v.id),
      ['typecheck'],
    );

    // Edited: the label and the command, keeping the id an orchestrator knows.
    const edited = value<VerificationView>(
      await fixture.router.handle('verifications.update', {
        workspaceId,
        id: 'typecheck',
        label: 'Typecheck do projeto',
        command: 'node check.mjs --strict',
      }),
    );
    assert.equal(edited.label, 'Typecheck do projeto');
    assert.equal(edited.command, 'node check.mjs --strict');
    assert.equal(edited.enabled, true, 'editing does not disable it');

    // Disabled, then enabled again, through the same channel.
    assert.equal(
      value<VerificationView>(
        await fixture.router.handle('verifications.update', {
          workspaceId,
          id: 'typecheck',
          enabled: false,
        }),
      ).enabled,
      false,
    );
    assert.equal(
      value<readonly VerificationView[]>(
        await fixture.router.handle('verifications.list', { workspaceId }),
      )[0]?.enabled,
      false,
      'a disabled verification is still shown to the person',
    );
    assert.equal(
      value<VerificationView>(
        await fixture.router.handle('verifications.update', {
          workspaceId,
          id: 'typecheck',
          enabled: true,
        }),
      ).enabled,
      true,
    );

    // Removed.
    assert.deepEqual(
      value(await fixture.router.handle('verifications.remove', { workspaceId, id: 'typecheck' })),
      { removed: true },
    );
    assert.deepEqual(value(await fixture.router.handle('verifications.list', { workspaceId })), []);
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});

test('a verification survives closing and reopening the application', async () => {
  const fixture = createDesktopFixture();
  const repo = createGitFixture('lao-verif-reopen-');
  repo.write('README.md', '# scratch\n');
  repo.commitAll('baseline');

  try {
    const workspaceId = await addWorkspace(fixture, repo, 'Projeto');
    value(
      await fixture.router.handle('verifications.create', {
        workspaceId,
        id: 'hello-exists',
        label: 'hello.txt tem o conteúdo exato',
        command: 'node check.mjs',
      }),
    );

    // Read back through a second Database over the same file, which is what a
    // restart amounts to for this table.
    const { Database } = await import('../src/database/database.js');
    const reopened = new Database({ paths: fixture.paths });
    try {
      const rows = reopened.verifications.listAll(workspaceId);
      assert.deepEqual(
        rows.map((r) => [r.id, r.label, r.command, r.enabled]),
        [['hello-exists', 'hello.txt tem o conteúdo exato', 'node check.mjs', 1]],
      );
    } finally {
      reopened.close();
    }
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});

/* --------------------------------------------------------- workspace scope */

test('one project cannot see, edit or remove another project’s verifications', async () => {
  const fixture = createDesktopFixture();
  const repoA = createGitFixture('lao-verif-a-');
  const repoB = createGitFixture('lao-verif-b-');
  for (const repo of [repoA, repoB]) {
    repo.write('README.md', '# scratch\n');
    repo.commitAll('baseline');
  }

  try {
    const a = await addWorkspace(fixture, repoA, 'Projeto A');
    const b = await addWorkspace(fixture, repoB, 'Projeto B');

    value(
      await fixture.router.handle('verifications.create', {
        workspaceId: a,
        id: 'only-in-a',
        label: 'Somente de A',
        command: 'node check.mjs',
      }),
    );

    assert.deepEqual(
      value<readonly VerificationView[]>(
        await fixture.router.handle('verifications.list', { workspaceId: a }),
      ).map((v) => v.id),
      ['only-in-a'],
    );
    assert.deepEqual(
      value<readonly VerificationView[]>(
        await fixture.router.handle('verifications.list', { workspaceId: b }),
      ),
      [],
      'B does not see A’s verification',
    );

    // Editing and removing it from B is refused, not silently applied to A.
    assert.equal(
      error(
        await fixture.router.handle('verifications.update', {
          workspaceId: b,
          id: 'only-in-a',
          label: 'sequestrada',
        }),
      ).code,
      'NOT_FOUND',
    );
    assert.equal(
      error(await fixture.router.handle('verifications.remove', { workspaceId: b, id: 'only-in-a' }))
        .code,
      'NOT_FOUND',
    );

    // A is untouched.
    const stillInA = value<readonly VerificationView[]>(
      await fixture.router.handle('verifications.list', { workspaceId: a }),
    );
    assert.deepEqual(
      stillInA.map((v) => [v.id, v.label]),
      [['only-in-a', 'Somente de A']],
    );

    // The same id may exist in both projects without colliding.
    value(
      await fixture.router.handle('verifications.create', {
        workspaceId: b,
        id: 'only-in-a',
        label: 'Homônima de B',
        command: 'node check.mjs',
      }),
    );
    assert.equal(
      value<readonly VerificationView[]>(
        await fixture.router.handle('verifications.list', { workspaceId: b }),
      )[0]?.label,
      'Homônima de B',
    );
    assert.equal(
      value<readonly VerificationView[]>(
        await fixture.router.handle('verifications.list', { workspaceId: a }),
      )[0]?.label,
      'Somente de A',
    );
  } finally {
    await fixture.cleanup();
    repoA.cleanup();
    repoB.cleanup();
  }
});

/* -------------------------------------------------------------- payloads */

test('a command the Verifier would refuse cannot be stored in the first place', async () => {
  const fixture = createDesktopFixture();
  const repo = createGitFixture('lao-verif-unsafe-');
  repo.write('README.md', '# scratch\n');
  repo.commitAll('baseline');

  try {
    const workspaceId = await addWorkspace(fixture, repo, 'Projeto');

    // Shell operators: the Verifier runs without a shell, so a command that
    // only means something to a shell is refused rather than half-executed.
    for (const command of [
      'npm test && rm -rf .',
      'echo hi | sh',
      'node check.mjs; curl http://x',
      'node -e $(cat /etc/passwd)',
      'cat < /etc/passwd',
      'node check.mjs > out.txt',
      'echo `whoami`',
    ]) {
      const refused = error(
        await fixture.router.handle('verifications.create', {
          workspaceId,
          id: 'unsafe',
          label: 'não deveria salvar',
          command,
        }),
      );
      assert.equal(refused.code, 'VERIFICATION_ERROR', command);
    }

    // Destructive git is refused by the same screen the loop uses.
    for (const command of ['git reset --hard', 'git clean -fd', 'git checkout -- .']) {
      assert.equal(
        error(
          await fixture.router.handle('verifications.create', {
            workspaceId,
            id: 'unsafe',
            label: 'não deveria salvar',
            command,
          }),
        ).code,
        'VERIFICATION_ERROR',
        command,
      );
    }

    // Nothing was stored by any of those attempts.
    assert.deepEqual(value(await fixture.router.handle('verifications.list', { workspaceId })), []);
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});

test('the boundary refuses a malformed verification payload', async () => {
  const fixture = createDesktopFixture();
  const repo = createGitFixture('lao-verif-payload-');
  repo.write('README.md', '# scratch\n');
  repo.commitAll('baseline');

  try {
    const workspaceId = await addWorkspace(fixture, repo, 'Projeto');
    const good = { workspaceId, id: 'ok-id', label: 'Nome', command: 'node check.mjs' };

    const bad: Array<[string, Record<string, unknown>]> = [
      ['an id that is a path', { ...good, id: '../../etc/passwd' }],
      ['an id with a separator', { ...good, id: 'a/b' }],
      ['an empty id', { ...good, id: '' }],
      ['an empty label', { ...good, label: '' }],
      ['an empty command', { ...good, command: '' }],
      ['a blank command', { ...good, command: '   ' }],
      ['a multi-line command', { ...good, command: 'node a.mjs\nrm -rf /' }],
      ['a command with a NUL byte', { ...good, command: 'node a.mjs\u0000rm' }],
      ['a command with an escape character', { ...good, command: 'node \u001b[31ma.mjs' }],
      ['an unknown property', { ...good, cwd: '/tmp' }],
      ['a prototype key', { ...good, ['__proto__']: {} }],
      ['a workspace id that is not an identifier', { ...good, workspaceId: '../ws' }],
      ['a numeric command', { ...good, command: 42 }],
      ['a missing command', { workspaceId, id: 'ok-id', label: 'Nome' }],
    ];

    for (const [what, payload] of bad) {
      const refused = error(await fixture.router.handle('verifications.create', payload));
      assert.equal(refused.code, 'INVALID_ARGUMENT', what);
    }

    // A workspace that does not exist is refused, with nothing created.
    assert.equal(
      error(
        await fixture.router.handle('verifications.create', { ...good, workspaceId: 'ws-nope' }),
      ).code,
      'NOT_FOUND',
    );

    // Editing something that was never created is refused too.
    assert.equal(
      error(
        await fixture.router.handle('verifications.update', {
          workspaceId,
          id: 'never-created',
          label: 'x',
        }),
      ).code,
      'NOT_FOUND',
    );
    assert.equal(
      error(await fixture.router.handle('verifications.remove', { workspaceId, id: 'never-created' }))
        .code,
      'NOT_FOUND',
    );

    // And an id that is already taken is not silently overwritten.
    value(await fixture.router.handle('verifications.create', good));
    const clash = error(
      await fixture.router.handle('verifications.create', { ...good, command: 'node other.mjs' }),
    );
    assert.equal(clash.code, 'VERIFICATION_ERROR');
    assert.equal(
      value<readonly VerificationView[]>(
        await fixture.router.handle('verifications.list', { workspaceId }),
      )[0]?.command,
      'node check.mjs',
      'the original command survived the clash',
    );
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});

/* -------------------------------------------------------- run integration */

/** A repository whose check script passes only on the exact content. */
function scratchRepository(): GitFixture {
  const repo = createGitFixture('lao-verif-run-');
  repo.write(
    'check.mjs',
    [
      "import { readFileSync } from 'node:fs';",
      'let actual = null;',
      "try { actual = readFileSync('hello.txt', 'utf8').trim(); } catch { actual = null; }",
      `const expected = ${JSON.stringify(EXPECTED)};`,
      'if (actual !== expected) {',
      "  console.error('hello.txt is ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));",
      '  process.exit(1);',
      '}',
      "console.log('ok');",
    ].join('\n'),
  );
  repo.commitAll('baseline');
  return repo;
}

const decision = (action: 'delegate' | 'done', task?: string, ids: string[] = ['gui-check']) =>
  JSON.stringify({
    action,
    ...(task ? { task } : {}),
    acceptanceCriteria: ['hello.txt existe com o conteúdo exato'],
    verificationCommands: ids,
    summary: action,
  });

test('a run resolves the verification the interface created, and the gate uses its result', async () => {
  const repo = scratchRepository();
  const orchestratorPrompts: string[] = [];
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', [
    (input: AgentInput) => {
      orchestratorPrompts.push(input.prompt);
      return decision('delegate', 'Crie hello.txt com o conteúdo combinado');
    },
    (input: AgentInput) => {
      orchestratorPrompts.push(input.prompt);
      return decision('done');
    },
  ]);
  const worker = new ScriptedAgent('mock-claude', 'Claude', [
    (input: AgentInput) => {
      writeFileSync(join(input.workingDirectory, 'hello.txt'), `${EXPECTED}\n`, 'utf8');
      return 'criado';
    },
  ]);
  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
  });

  try {
    const workspaceId = await addWorkspace(fixture, repo, 'Projeto');

    // The whole point: the definition arrives through the interface's channel.
    value(
      await fixture.router.handle('verifications.create', {
        workspaceId,
        id: 'gui-check',
        label: 'hello.txt tem o conteúdo exato',
        command: 'node check.mjs',
      }),
    );

    value(await fixture.router.handle('accounts.create', { name: 'Claude', provider: 'anthropic' }));
    const agents = value<Array<{ id: string; role: string }>>(
      await fixture.router.handle('agents.list', null),
    );
    value(
      await fixture.router.handle('workspace.setAgents', {
        workspaceId,
        orchestratorAgentId: agents.find((a) => a.role === 'ORCHESTRATOR')!.id,
        workerAgentId: agents.find((a) => a.role === 'CODING_WORKER')!.id,
      }),
    );
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId, title: 'Conversa' }),
    );

    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', {
        sessionId: session.id,
        text: `Crie hello.txt contendo exatamente: ${EXPECTED}`,
      }),
    );
    const run = await fixture.services.orchestration.waitFor(sent.run.id);

    // The orchestrator was offered the verification by id and label, and never
    // by command line: it cannot invent or read the command.
    assert.match(orchestratorPrompts[0]!, /gui-check - hello\.txt tem o conteúdo exato/);
    assert.doesNotMatch(orchestratorPrompts[0]!, /node check\.mjs/);

    // The Verifier ran the stored command and the result was persisted.
    const results = fixture.services.database.runs.verifications(sent.run.id) as Array<{
      command: string;
      passed: number;
      exit_code: number | null;
    }>;
    assert.ok(results.length > 0, 'the verification really ran');
    assert.ok(
      results.every((r) => r.command === 'node check.mjs'),
      'only the command the person registered ran',
    );
    assert.ok(results.every((r) => r.passed === 1 && r.exit_code === 0));

    // And the gate accepted on that evidence.
    const gate = fixture.services.database.runs
      .steps(sent.run.id)
      .filter((s) => s.phase === 'done-gate');
    assert.deepEqual(
      gate.map((g) => g.status),
      ['passed'],
    );
    assert.equal(run.status, 'DONE');
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});

test('an id that is not registered, or is disabled, is refused rather than run', async () => {
  const repo = scratchRepository();
  const orchestratorPrompts: string[] = [];
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', [
    (input: AgentInput) => {
      orchestratorPrompts.push(input.prompt);
      // Asks for one verification that exists but is switched off, and one that
      // was never registered at all.
      return decision('delegate', 'Crie hello.txt', ['gui-check', 'inventada']);
    },
    (input: AgentInput) => {
      orchestratorPrompts.push(input.prompt);
      return decision('done', undefined, ['gui-check']);
    },
  ]);
  const worker = new ScriptedAgent('mock-claude', 'Claude', [
    (input: AgentInput) => {
      writeFileSync(join(input.workingDirectory, 'hello.txt'), `${EXPECTED}\n`, 'utf8');
      return 'criado';
    },
  ]);
  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    maxIterations: 2,
  });

  try {
    const workspaceId = await addWorkspace(fixture, repo, 'Projeto');
    value(
      await fixture.router.handle('verifications.create', {
        workspaceId,
        id: 'gui-check',
        label: 'hello.txt tem o conteúdo exato',
        command: 'node check.mjs',
      }),
    );
    // Switched off in the interface. It must now be invisible to the loop.
    value(
      await fixture.router.handle('verifications.update', {
        workspaceId,
        id: 'gui-check',
        enabled: false,
      }),
    );

    value(await fixture.router.handle('accounts.create', { name: 'Claude', provider: 'anthropic' }));
    const agents = value<Array<{ id: string; role: string }>>(
      await fixture.router.handle('agents.list', null),
    );
    value(
      await fixture.router.handle('workspace.setAgents', {
        workspaceId,
        orchestratorAgentId: agents.find((a) => a.role === 'ORCHESTRATOR')!.id,
        workerAgentId: agents.find((a) => a.role === 'CODING_WORKER')!.id,
      }),
    );
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId, title: 'Conversa' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'Crie hello.txt' }),
    );
    const run = await fixture.services.orchestration.waitFor(sent.run.id);

    // A disabled verification is not even offered in the catalogue.
    assert.doesNotMatch(orchestratorPrompts[0]!, /gui-check/);
    assert.match(orchestratorPrompts[0]!, /\(none registered for this workspace\)/);

    // Neither id ran, and the refusal was reported back rather than ignored.
    assert.deepEqual(fixture.services.database.runs.verifications(sent.run.id), []);
    assert.match(orchestratorPrompts[1]!, /REFUSED/);
    assert.match(orchestratorPrompts[1]!, /gui-check/);
    assert.match(orchestratorPrompts[1]!, /inventada/);

    // And with no evidence, the gate did not let the run finish.
    assert.notEqual(run.status, 'DONE');
    const gate = fixture.services.database.runs
      .steps(sent.run.id)
      .filter((s) => s.phase === 'done-gate');
    assert.ok(gate.length > 0 && gate.every((g) => g.status === 'rejected'), 'the gate refused');
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});
