/**
 * Closing the application and coming back.
 *
 * The promise is not "the run kept going" alone - it is that when the person
 * reopens the window, what they see is what happened, once. So these tests are
 * about the failure modes of *catching up*, which are quieter and worse than a
 * run that simply fails:
 *
 *  - a replay that duplicates every step and message;
 *  - a partial sync that loses the middle of a run;
 *  - a submission that timed out on the network and became two runs, two
 *    commits and two pull requests for one press of a button.
 *
 * The coordinator here is real: a real store, a real HTTP server, a real event
 * log. What is faked is the workspace, because isolation is the cloud E2E gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/database/database.js';
import { RunStore } from '../src/cloud/coordinator/store.js';
import { Coordinator } from '../apps/coordinator/src/coordinator.js';
import { createCoordinatorServer } from '../apps/coordinator/src/http.js';
import { CloudClient, CloudError } from '../apps/desktop/src/main/services/cloud-client.js';
import { CloudService } from '../apps/desktop/src/main/services/cloud-service.js';
import { EventBus } from '../apps/desktop/src/main/events.js';
import { newId } from '../src/database/repositories.js';
import { createDesktopFixture, fakeSecretStore } from './helpers/desktop-fixture.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';
import type { ProvisionedWorkspace, WorkspaceProvisioner } from '../src/cloud/provisioner.js';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

function memoryDatabase(): Database {
  return new Database({ filePath: ':memory:' });
}

/** A provisioner that never finishes: the run stays in flight for the test. */
const stalling: WorkspaceProvisioner = {
  id: 'stalling',
  capabilities: { isolated: true, networkPolicy: true, resourceLimits: true, durable: true },
  async provision(request): Promise<ProvisionedWorkspace> {
    await new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
    throw new Error('unreachable');
  },
  async reclaim() {},
};

/**
 * A desktop and a coordinator, each with its own database, talking over a real
 * socket - which is the arrangement the product actually has.
 */
async function twoSides(): Promise<{
  desktop: Database;
  cloud: Database;
  service: CloudService;
  store: RunStore;
  coordinator: Coordinator;
  workspaceId: string;
  sessionId: string;
  close(): Promise<void>;
}> {
  const cloud = memoryDatabase();
  const coordinator = new Coordinator({
    database: cloud,
    provisioner: stalling,
    credentials: { openaiApiKey: 'sk-test' },
  });
  const store = coordinator.store;
  const principal = store.createPrincipal({ displayName: 'Pessoa' });
  const token = store.issueSession({ principalId: principal.id }).token;

  const server = createCoordinatorServer({ coordinator });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const desktop = memoryDatabase();
  const workspace = desktop.workspaces.create({
    id: newId('ws'),
    name: 'Arcanjog1/Orquestrador',
    localPath: '',
    environment: 'cloud',
    repositoryFullName: 'Arcanjog1/Orquestrador',
    repositoryPrivate: true,
    branch: 'main',
  });
  const session = desktop.chat.createSession({
    id: newId('chat'),
    workspaceId: workspace.id,
    title: 'Conversa',
    projectId: null,
  });

  const client = new CloudClient({ endpoint: `http://127.0.0.1:${port}`, token: () => token });
  const service = new CloudService({
    database: desktop,
    events: new EventBus(),
    clientFor: () => client,
  });

  return {
    desktop,
    cloud,
    service,
    store,
    coordinator,
    workspaceId: workspace.id,
    sessionId: session.id,
    async close() {
      service.stopPolling();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await coordinator.shutdown();
      desktop.close();
      cloud.close();
    },
  };
}

test('a run submitted from the desktop keeps its identity across a reconnection', async () => {
  const sides = await twoSides();
  try {
    const run = await sides.service.start({ sessionId: sides.sessionId, objective: 'faça algo' });
    const local = sides.desktop.runs.require(run.id);
    assert.ok(local.remote_run_id, 'the local run was not bound to a remote one');
    assert.equal(local.status, 'RUNNING');

    // The coordinator knows which local run this is, so a desktop that lost
    // its own record could still match them up.
    const remote = sides.store.requireRunUnscoped(local.remote_run_id!);
    assert.equal(remote.client_run_id, run.id);
    assert.equal(remote.client_session_id, sides.sessionId);
  } finally {
    await sides.close();
  }
});

test('a submission that timed out but arrived does not become a second run', async () => {
  const sides = await twoSides();
  try {
    const run = await sides.service.start({ sessionId: sides.sessionId, objective: 'faça algo' });
    const remoteId = sides.desktop.runs.require(run.id).remote_run_id!;

    // The desktop re-sends with the same key - which is the local run's id, so
    // it is the same after a crash, a restart, or a network timeout.
    const principal = sides.store.listRuns(sides.store.createPrincipal({ displayName: 'x' }));
    assert.deepEqual(principal, [], 'sanity: a fresh principal owns nothing');

    const beforeCount = sides.cloud.driver.all('SELECT id FROM remote_runs').length;
    // Two more attempts, exactly as a flaky connection would produce.
    await sides.service.sync(run.id);
    await sides.service.sync(run.id);
    const afterCount = sides.cloud.driver.all('SELECT id FROM remote_runs').length;
    assert.equal(afterCount, beforeCount, 'a retry created another run');
    assert.equal(sides.desktop.runs.require(run.id).remote_run_id, remoteId);
  } finally {
    await sides.close();
  }
});

test('syncing twice applies each event once: no duplicated steps or messages', async () => {
  const sides = await twoSides();
  try {
    const run = await sides.service.start({ sessionId: sides.sessionId, objective: 'faça algo' });
    const remoteId = sides.desktop.runs.require(run.id).remote_run_id!;

    // The remote loop publishes progress and a message, as it does for real.
    sides.store.append(remoteId, 'orchestration.run:progress', {
      stage: 'orchestrator',
      label: 'Codex preparando a tarefa...',
    });
    sides.store.append(remoteId, 'orchestration.run:progress', {
      stage: 'message',
      label: 'Executando',
      message: { id: 'msg-remote-1', author: 'worker', text: 'Executando: criar o arquivo' },
    });
    sides.store.append(remoteId, 'workspace.phase', { phase: 'cloning', detail: 'Arcanjog1/Orquestrador' });

    // Everything the coordinator has logged so far, including its own
    // `run.created` and the status it set before these three.
    const logged = sides.store.events(remoteId, 0).length;
    const first = await sides.service.sync(run.id);
    assert.equal(first, logged, 'the first sync must apply the whole log');
    const stepsAfterFirst = sides.desktop.runs.steps(run.id).length;
    const messagesAfterFirst = sides.desktop.chat.listMessages(sides.sessionId).length;
    assert.ok(messagesAfterFirst >= 1, 'the remote message was not mirrored');

    // Asking again from the stored cursor brings nothing new.
    assert.equal(await sides.service.sync(run.id), 0);
    assert.equal(sides.desktop.runs.steps(run.id).length, stepsAfterFirst);
    assert.equal(sides.desktop.chat.listMessages(sides.sessionId).length, messagesAfterFirst);

    // And a sync forced from the beginning - what an interrupted one that
    // never stored its cursor would do - still applies nothing twice.
    sides.desktop.driver.run('UPDATE runs SET remote_cursor = 0 WHERE id = ?', [run.id]);
    await sides.service.sync(run.id);
    assert.equal(sides.desktop.runs.steps(run.id).length, stepsAfterFirst, 'steps were duplicated');
    assert.equal(
      sides.desktop.chat.listMessages(sides.sessionId).length,
      messagesAfterFirst,
      'messages were duplicated',
    );
  } finally {
    await sides.close();
  }
});

test('the cursor never moves backwards, so a stale answer cannot rewind history', async () => {
  const sides = await twoSides();
  try {
    const run = await sides.service.start({ sessionId: sides.sessionId, objective: 'x' });
    const remoteId = sides.desktop.runs.require(run.id).remote_run_id!;
    for (let index = 0; index < 5; index += 1) sides.store.append(remoteId, 'note', { index });
    await sides.service.sync(run.id);
    const reached = sides.desktop.runs.remoteCursor(run.id);
    assert.ok(reached >= 5);

    sides.desktop.runs.setRemoteCursor(run.id, 1);
    assert.equal(sides.desktop.runs.remoteCursor(run.id), reached, 'the cursor was rewound');
  } finally {
    await sides.close();
  }
});

test('a run that finished while the desktop was closed is found finished', async () => {
  const sides = await twoSides();
  try {
    const run = await sides.service.start({ sessionId: sides.sessionId, objective: 'x' });
    const remoteId = sides.desktop.runs.require(run.id).remote_run_id!;

    // The window is closed here. The work carries on and ends.
    sides.store.append(remoteId, 'orchestration.run:progress', { stage: 'worker', label: 'Claude executando...' });
    sides.store.append(remoteId, 'orchestration.run:progress', { stage: 'review', label: 'Codex revisando...' });
    sides.store.setStatus(remoteId, 'DONE');

    // The window opens again. `syncAll` is what runs then.
    const applied = await sides.service.syncAll();
    assert.ok(applied >= 3);
    const local = sides.desktop.runs.require(run.id);
    assert.equal(local.status, 'DONE');
    // The whole story is on the local timeline, not just the ending.
    const summaries = sides.desktop.runs.steps(run.id).map((s) => s.summary ?? '');
    assert.ok(summaries.some((s) => s.includes('Claude executando')));
    assert.ok(summaries.some((s) => s.includes('Codex revisando')));

    // And a finished run is not polled forever.
    assert.equal(await sides.service.syncAll(), 0);
    assert.deepEqual(sides.desktop.runs.listUnfinishedRemote(), []);
  } finally {
    await sides.close();
  }
});

test('a run that needs a person comes back as the human gate, not as a failure', async () => {
  const sides = await twoSides();
  try {
    const run = await sides.service.start({ sessionId: sides.sessionId, objective: 'x' });
    const remoteId = sides.desktop.runs.require(run.id).remote_run_id!;
    sides.store.setStatus(remoteId, 'NEEDS_HUMAN', 'O orquestrador pediu uma decisão.');
    await sides.service.sync(run.id);
    assert.equal(sides.desktop.runs.require(run.id).status, 'BLOCKED');
  } finally {
    await sides.close();
  }
});

test('a coordinator that cannot be reached leaves the run alone rather than failing it', async () => {
  const desktop = memoryDatabase();
  try {
    const workspace = desktop.workspaces.create({
      id: newId('ws'),
      name: 'o/r',
      localPath: '',
      environment: 'cloud',
      repositoryFullName: 'o/r',
      branch: 'main',
    });
    const session = desktop.chat.createSession({
      id: newId('chat'),
      workspaceId: workspace.id,
      title: 'c',
      projectId: null,
    });
    // Nothing is listening on this port.
    const client = new CloudClient({ endpoint: 'http://127.0.0.1:1', token: () => 'tok' });
    const service = new CloudService({ database: desktop, events: new EventBus(), clientFor: () => client });

    await assert.rejects(service.start({ sessionId: session.id, objective: 'x' }));

    // A local row exists and is NOT marked failed: the submission may have
    // arrived, and the same idempotency key makes re-sending safe.
    const runs = desktop.runs.listForSession(session.id);
    assert.equal(runs.length, 1);
    assert.notEqual(runs[0]!.status, 'FAILED');
    const steps = desktop.runs.steps(runs[0]!.id);
    assert.ok(steps.some((s) => s.status === 'unsent'));

    // And an unreachable coordinator does not make syncAll throw.
    assert.equal(await service.syncAll(), 0);
  } finally {
    desktop.close();
  }
});

test('the client refuses a token the coordinator does not know, and says which it is', async () => {
  const cloud = memoryDatabase();
  const coordinator = new Coordinator({
    database: cloud,
    provisioner: stalling,
    credentials: { openaiApiKey: 'sk-test' },
  });
  const server = createCoordinatorServer({ coordinator });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const client = new CloudClient({ endpoint: `http://127.0.0.1:${port}`, token: () => 'orq_wrong' });
    assert.equal(await client.health(), true, 'health must not need a token');
    await assert.rejects(client.runs(), (error: unknown) => {
      assert.ok(error instanceof CloudError);
      assert.equal(error.reason, 'UNAUTHORIZED');
      return true;
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await coordinator.shutdown();
    cloud.close();
  }
});

/* -- the interface's own path ---------------------------------------------- */

test('sending a message in a cloud project goes to the cloud, not to a local folder', async () => {
  // The rule the interface depends on: where work goes is a property of the
  // project, not of which button was pressed. A cloud project with no folder
  // on this computer must never fall through to the local loop, which would
  // fail on a path that does not exist - or, far worse, succeed against one
  // that happens to.
  const cloud = memoryDatabase();
  const coordinator = new Coordinator({
    database: cloud,
    provisioner: stalling,
    credentials: { openaiApiKey: 'sk-test' },
  });
  const principal = coordinator.store.createPrincipal({ displayName: 'Pessoa' });
  const token = coordinator.store.issueSession({ principalId: principal.id }).token;
  const server = createCoordinatorServer({ coordinator });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const fixture = createDesktopFixture({ secrets: fakeSecretStore() });
  try {
    const status = value<{ configured: boolean }>(
      await fixture.router.handle('cloud.connect', {
        endpoint: `http://127.0.0.1:${port}`,
        token,
      }),
    );
    assert.equal(status.configured, true);
    // The token is stored, never handed back.
    assert.ok(!JSON.stringify(status).includes(token), 'the device token was echoed to the renderer');

    const workspace = value<{ id: string; environment: string; localPath: string }>(
      await fixture.router.handle('workspace.createCloud', {
        repository: 'Arcanjog1/Orquestrador',
        branch: 'main',
        repositoryPrivate: true,
      }),
    );
    assert.equal(workspace.environment, 'cloud');
    assert.equal(workspace.localPath, '', 'a cloud project must not claim a folder on this computer');

    value(await fixture.router.handle('accounts.create', { name: 'Claude', provider: 'anthropic' }));
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
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'c' }),
    );

    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', {
        sessionId: session.id,
        text: 'faça algo na nuvem',
      }),
    );

    // It reached the coordinator, and the local row knows which run it is.
    const local = fixture.services.database.runs.require(sent.run.id);
    assert.ok(local.remote_run_id, 'the message never reached the cloud');
    const remote = coordinator.store.requireRunUnscoped(local.remote_run_id!);
    assert.equal(remote.repository, 'Arcanjog1/Orquestrador');
    assert.equal(remote.branch, 'main');
    assert.equal(remote.objective, 'faça algo na nuvem');

    // Disconnecting is local: the run in the cloud is untouched.
    value(await fixture.router.handle('cloud.disconnect', null));
    const after = value<{ configured: boolean }>(await fixture.router.handle('cloud.status', null));
    assert.equal(after.configured, false);
    assert.equal(coordinator.store.requireRunUnscoped(local.remote_run_id!).status, remote.status);
  } finally {
    await fixture.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await coordinator.shutdown();
    cloud.close();
  }
});

test('a coordinator reached over plain http on a real network is refused', async () => {
  // A device token in clear on a network is the credential gone, and there is
  // no option to allow it. Loopback is the one exception, for a self-hosted
  // coordinator on the same machine.
  const fixture = createDesktopFixture({ secrets: fakeSecretStore() });
  try {
    const refused = await fixture.router.handle('cloud.connect', {
      endpoint: 'http://coordenador.exemplo.invalid',
      token: 'orq_aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    assert.equal(refused.ok, false);
    assert.match(
      refused.ok === false ? refused.error.message : '',
      /https/i,
      'the refusal must say why',
    );
    // And a credential smuggled into the URL is refused as well.
    const withCredential = await fixture.router.handle('cloud.connect', {
      endpoint: 'https://user:secret@coordenador.exemplo.invalid',
      token: 'orq_aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    assert.equal(withCredential.ok, false);
  } finally {
    await fixture.cleanup();
  }
});

test('a remote run shows real changed files and a real diffstat, with no repository here', async () => {
  // The point of cloud mode's timeline: the person sees what actually changed
  // without the repository ever reaching their computer. So the evidence has
  // to travel on the event, and survive the catch-up.
  const sides = await twoSides();
  try {
    const run = await sides.service.start({ sessionId: sides.sessionId, objective: 'x' });
    const remoteId = sides.desktop.runs.require(run.id).remote_run_id!;

    sides.store.append(remoteId, 'orchestration.run:progress', {
      stage: 'evidence',
      label: '2 arquivo(s)',
      evidence: {
        changed: true,
        changedFiles: ['src/app.ts', 'tests/app.test.ts'],
        insertions: 42,
        deletions: 7,
        diffstat: ' src/app.ts        | 30 +++++++++\n tests/app.test.ts | 19 ++++--',
        branch: 'main',
        commit: 'abc1234',
      },
    });
    await sides.service.sync(run.id);

    const step = sides.desktop.runs.steps(run.id).find((s) => s.phase === 'evidence');
    assert.ok(step, 'the evidence step never arrived');
    const detail = step.detail ?? '';
    assert.match(detail, /src\/app\.ts/);
    assert.match(detail, /tests\/app\.test\.ts/);
    assert.match(detail, /\+42/);
    assert.match(detail, /7/);
    assert.match(detail, /branch: main/);

    // And a second sync does not duplicate it, evidence and all.
    const before = sides.desktop.runs.steps(run.id).length;
    sides.desktop.driver.run('UPDATE runs SET remote_cursor = 0 WHERE id = ?', [run.id]);
    await sides.service.sync(run.id);
    assert.equal(sides.desktop.runs.steps(run.id).length, before, 'the evidence step was duplicated');

    // An iteration that changed nothing carries no evidence, rather than an
    // empty block that reads like a failure to collect any.
    sides.store.append(remoteId, 'orchestration.run:progress', {
      stage: 'evidence',
      label: '0 arquivo(s)',
      evidence: { changed: false, changedFiles: [], insertions: 0, deletions: 0, diffstat: '', branch: 'main' },
    });
    await sides.service.sync(run.id);
    const unchanged = sides.desktop.runs
      .steps(run.id)
      .filter((s) => s.phase === 'evidence')
      .at(-1)!;
    assert.equal(unchanged.detail?.includes('\n'), false, 'a no-change step carried an evidence block');
  } finally {
    await sides.close();
  }
});

test('cancelling a cloud run reaches the coordinator, not only this window', async () => {
  // Cancelling locally would stop nothing and report that it had - and would
  // leave the workspace running, and billing.
  const cloud = memoryDatabase();
  const coordinator = new Coordinator({
    database: cloud,
    provisioner: stalling,
    credentials: { openaiApiKey: 'sk-test' },
  });
  const principal = coordinator.store.createPrincipal({ displayName: 'Pessoa' });
  const token = coordinator.store.issueSession({ principalId: principal.id }).token;
  const server = createCoordinatorServer({ coordinator });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const fixture = createDesktopFixture({ secrets: fakeSecretStore() });
  try {
    value(
      await fixture.router.handle('cloud.connect', { endpoint: `http://127.0.0.1:${port}`, token }),
    );
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.createCloud', {
        repository: 'Arcanjog1/Orquestrador',
        branch: 'main',
      }),
    );
    value(await fixture.router.handle('accounts.create', { name: 'Claude', provider: 'anthropic' }));
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
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'c' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'faça' }),
    );
    const remoteId = fixture.services.database.runs.require(sent.run.id).remote_run_id!;

    const result = value<{ cancelled: boolean }>(
      await fixture.router.handle('run.cancel', { runId: sent.run.id }),
    );
    assert.equal(result.cancelled, true);
    // The coordinator - the only thing that can actually end it - knows.
    assert.equal(coordinator.store.requireRunUnscoped(remoteId).status, 'CANCELLED');
    assert.ok(
      coordinator.store.events(remoteId, 0).some(
        (e) => e.kind === 'run.status' && (e.payload as { status?: string }).status === 'CANCELLED',
      ),
      'the cancellation never reached the durable log',
    );

    // And the run does not later turn into a failure: the person's decision is
    // already the outcome, and overwriting it with FAILED would report their
    // own choice as an error.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(coordinator.store.requireRunUnscoped(remoteId).status, 'CANCELLED');
  } finally {
    await fixture.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await coordinator.shutdown();
    cloud.close();
  }
});

test('the publish choice a person makes is what the run carries into the cloud', async () => {
  // A cloud workspace is disposable, so a run that does not publish produces
  // nothing. The choice therefore has to reach the coordinator, not stay a
  // checkbox in a window that is about to close.
  const cloud = memoryDatabase();
  const coordinator = new Coordinator({
    database: cloud,
    provisioner: stalling,
    credentials: { openaiApiKey: 'sk-test' },
  });
  const principal = coordinator.store.createPrincipal({ displayName: 'Pessoa' });
  const token = coordinator.store.issueSession({ principalId: principal.id }).token;
  const server = createCoordinatorServer({ coordinator });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const fixture = createDesktopFixture({ secrets: fakeSecretStore() });
  try {
    value(
      await fixture.router.handle('cloud.connect', { endpoint: `http://127.0.0.1:${port}`, token }),
    );
    const workspace = value<{ id: string; publish: { enabled: boolean; pullRequest: boolean } }>(
      await fixture.router.handle('workspace.createCloud', {
        repository: 'Arcanjog1/Orquestrador',
        branch: 'main',
      }),
    );
    // Publishing defaults on, the pull request defaults off.
    assert.deepEqual(workspace.publish, { enabled: true, pullRequest: false });

    const updated = value<{ publish: { enabled: boolean; pullRequest: boolean } }>(
      await fixture.router.handle('workspace.setPublish', {
        workspaceId: workspace.id,
        enabled: true,
        pullRequest: true,
      }),
    );
    assert.deepEqual(updated.publish, { enabled: true, pullRequest: true });

    value(await fixture.router.handle('accounts.create', { name: 'Claude', provider: 'anthropic' }));
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
      await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'c' }),
    );
    const sent = value<{ run: { id: string } }>(
      await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'faça' }),
    );

    const remoteId = fixture.services.database.runs.require(sent.run.id).remote_run_id!;
    const team = JSON.parse(coordinator.store.requireRunUnscoped(remoteId).team) as {
      publish?: { enabled?: boolean; pullRequest?: boolean };
    };
    assert.deepEqual(team.publish, { enabled: true, pullRequest: true });
  } finally {
    await fixture.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await coordinator.shutdown();
    cloud.close();
  }
});

test('a local project has no publish choice to make', async () => {
  // It has a working copy the person commits and pushes themselves; a switch
  // that did nothing would be worse than none.
  const fixture = createDesktopFixture();
  const dir = mkdtempSync(join(tmpdir(), 'lao-local-publish-'));
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.create', { name: 'Local', localPath: dir }),
    );
    const refused = await fixture.router.handle('workspace.setPublish', {
      workspaceId: workspace.id,
      enabled: false,
      pullRequest: false,
    });
    assert.equal(refused.ok, false);
  } finally {
    await fixture.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
