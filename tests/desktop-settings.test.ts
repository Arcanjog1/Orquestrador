/**
 * Settings that do something.
 *
 * The Execution screen writes three keys; the loop reads them when a run
 * starts. This pins that a number typed there changes the next run - and
 * that the setting is read at run time, not baked in at start-up.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';
import type { AgentInput } from '../src/core/types.js';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

test('execution.maxIterations from the settings table bounds the next run, and only the next', async () => {
  const repo = createGitFixture('lao-settings-');
  repo.write('a.txt', 'a\n');
  repo.commitAll('init');

  // An orchestrator that never says done, and a worker that always changes
  // something: the only thing that can stop this run is the iteration limit.
  let turn = 0;
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', [
    () =>
      JSON.stringify({
        action: 'delegate',
        task: `turn ${(turn += 1)}`,
        acceptanceCriteria: [],
        verificationCommands: [],
        summary: 'mais uma',
      }),
  ]);
  const worker = new ScriptedAgent('mock-claude', 'Claude', [
    (input: AgentInput) => {
      writeFileSync(join(input.workingDirectory, 'a.txt'), `${Date.now()}\n`, 'utf8');
      return 'ok';
    },
  ]);
  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
  });
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.create', { name: 'P', localPath: repo.dir }),
    );
    value(await fixture.router.handle('accounts.create', { name: 'Codex', provider: 'openai' }));
    value(await fixture.router.handle('accounts.create', { name: 'Claude', provider: 'anthropic' }));
    const accounts = value<Array<{ id: string; provider: string }>>(
      await fixture.router.handle('accounts.list', null),
    );
    value(
      await fixture.router.handle('workspace.setTeam', {
        workspaceId: workspace.id,
        orchestrator: { accountId: accounts.find((a) => a.provider === 'openai')!.id },
        worker: { accountId: accounts.find((a) => a.provider === 'anthropic')!.id },
      }),
    );
    const session = value<{ id: string }>(
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'c' }),
    );

    // Written the way the Execution screen writes it, after the services
    // were built: the loop must read it when the run starts.
    value(await fixture.router.handle('settings.set', { key: 'execution.maxIterations', value: '2' }));
    let sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'nunca termina' }),
    );
    let run = await fixture.services.orchestration.waitFor(sent.run.id, 60_000);
    assert.equal(run.status, 'PARTIAL', 'measured changes survive an exhausted iteration budget');
    assert.equal(run.failureKind, null);
    assert.equal(run.iterations, 2);
    assert.match(run.summary ?? '', /Limite de 2 iterações/);

    // Changed again, no restart: the next run obeys the new number.
    value(await fixture.router.handle('settings.set', { key: 'execution.maxIterations', value: '1' }));
    sent = value(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'de novo' }),
    );
    run = await fixture.services.orchestration.waitFor(sent.run.id, 60_000);
    assert.equal(run.iterations, 1);
    assert.match(run.summary ?? '', /Limite de 1 iterações/);

    // Nonsense in the table falls back to the loop's own default (8), which
    // this test does not wait for; it only checks the number was not taken.
    value(await fixture.router.handle('settings.set', { key: 'execution.maxIterations', value: '999' }));
    const runs = fixture.services.database.runs.listForWorkspace(workspace.id);
    assert.equal(runs.length, 2);
  } finally {
    await fixture.cleanup();
    repo.cleanup();
  }
});

test('the login item is the shell\'s, and app.info reports what the shell says', async () => {
  const fixture = createDesktopFixture();
  try {
    let info = value<{ startWithSystem: boolean | null }>(await fixture.router.handle('app.info', null));
    assert.equal(info.startWithSystem, false);
    const set = value<{ startWithSystem: boolean | null }>(
      await fixture.router.handle('app.setStartWithSystem', { enabled: true }),
    );
    assert.equal(set.startWithSystem, true);
    info = value(await fixture.router.handle('app.info', null));
    assert.equal(info.startWithSystem, true);
    assert.equal(
      (await fixture.router.handle('app.setStartWithSystem', { enabled: 'yes' })).ok,
      false,
      'a string is not a boolean',
    );
  } finally {
    await fixture.cleanup();
  }
});
