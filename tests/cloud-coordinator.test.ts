/**
 * The Run Coordinator.
 *
 * These tests are about the promise that makes cloud mode worth building: the
 * work continues with the computer switched off, and what happened is still
 * there when it comes back on. Nothing here is proved by "the process was
 * still running" - the coordinator is torn down mid-run on purpose, and the
 * evidence is the durable record it left behind.
 *
 * They also pin the things that are only visible when they fail: one tenant
 * cannot read another's run, a retry does not become a second run, and two
 * coordinator processes cannot drive the same loop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../src/database/database.js';
import { ProcessManager } from '../src/process/process-manager.js';
import { createGitFixture } from './helpers/git-fixture.js';
import { RunStore, hashToken } from '../src/cloud/coordinator/store.js';
import { Coordinator } from '../apps/coordinator/src/coordinator.js';
import { createCoordinatorServer } from '../apps/coordinator/src/http.js';
import { Reaper } from '../apps/coordinator/src/reaper.js';
import type { AddressInfo } from 'node:net';
import type {
  ProvisionedWorkspace,
  ProvisionerCapabilities,
  WorkspaceProvisioner,
  WorkspaceRequest,
} from '../src/cloud/provisioner.js';
import type { ProcessResult, ProcessRunner, RunProcessOptions } from '../src/execution/process-runner.js';

function memoryDatabase(): Database {
  return new Database({ filePath: ':memory:' });
}

/**
 * A provisioner that hands back a workspace whose processes are scripted.
 *
 * The point of the coordinator tests is the coordination - leases,
 * idempotency, the event log, recovery - so the agents are answered from a
 * script rather than run. The loop itself is proved end to end elsewhere.
 */
function fakeProvisioner(
  script: (options: RunProcessOptions) => Partial<ProcessResult> = () => ({}),
): WorkspaceProvisioner & { provisioned: string[]; released: string[] } {
  const provisioned: string[] = [];
  const released: string[] = [];
  const capabilities: ProvisionerCapabilities = {
    isolated: true,
    networkPolicy: true,
    resourceLimits: true,
    durable: true,
  };
  const processes: ProcessRunner = {
    async run(options: RunProcessOptions): Promise<ProcessResult> {
      return {
        outcome: 'completed',
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 1,
        truncated: false,
        ...script(options),
      } as ProcessResult;
    },
    async cancelAll() {},
  };
  return {
    id: 'fake',
    capabilities,
    provisioned,
    released,
    async provision(request: WorkspaceRequest): Promise<ProvisionedWorkspace> {
      provisioned.push(request.cloudWorkspaceId);
      return {
        cloudWorkspaceId: request.cloudWorkspaceId,
        handle: `fake-${request.cloudWorkspaceId}`,
        workingDirectory: '/workspace/repo',
        processes,
        commit: 'abc123',
        release: async () => {
          released.push(request.cloudWorkspaceId);
        },
      };
    },
    async reclaim(handle: string) {
      released.push(handle);
    },
  };
}

/* -- identity and isolation ------------------------------------------------ */

test('a token is stored only as a hash, and names exactly one principal', () => {
  const database = memoryDatabase();
  try {
    const store = new RunStore(database);
    const alice = store.createPrincipal({ displayName: 'Alice' });
    const issued = store.issueSession({ principalId: alice.id });

    // The token itself is nowhere in the database.
    const rows = database.driver.all<{ token_hash: string }>('SELECT token_hash FROM desktop_sessions');
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.token_hash, issued.token);
    assert.equal(rows[0]!.token_hash, hashToken(issued.token));

    assert.equal(store.authenticate(issued.token)?.id, alice.id);
    assert.equal(store.authenticate('orq_not_a_real_token'), null);
    assert.equal(store.authenticate(''), null);

    store.revokeSession(issued.id);
    assert.equal(store.authenticate(issued.token), null, 'a revoked token still worked');
  } finally {
    database.close();
  }
});

test('an expired session is refused', () => {
  const database = memoryDatabase();
  try {
    const store = new RunStore(database);
    const principal = store.createPrincipal({ displayName: 'A' });
    const issued = store.issueSession({ principalId: principal.id, ttlMs: -1000 });
    assert.equal(store.authenticate(issued.token), null);
  } finally {
    database.close();
  }
});

test("one principal can never read another's run", () => {
  const database = memoryDatabase();
  try {
    const store = new RunStore(database);
    const alice = store.createPrincipal({ displayName: 'Alice' });
    const bob = store.createPrincipal({ displayName: 'Bob' });
    const { run } = store.createRun({
      principal: alice,
      repository: 'alice/private',
      branch: 'main',
      objective: 'segredo',
    });

    assert.equal(store.findRun(run.id, alice)?.id, run.id);
    // Not "forbidden": from Bob's side the run does not exist at all.
    assert.equal(store.findRun(run.id, bob), null);
    assert.deepEqual(store.listRuns(bob), []);
    // And the repository name never leaks through the listing either.
    assert.ok(!JSON.stringify(store.listRuns(bob)).includes('alice/private'));
  } finally {
    database.close();
  }
});

/* -- idempotency ----------------------------------------------------------- */

test('a retried submission returns the same run, not a second one', () => {
  const database = memoryDatabase();
  try {
    const store = new RunStore(database);
    const principal = store.createPrincipal({ displayName: 'A' });
    const input = {
      principal,
      repository: 'o/r',
      branch: 'main',
      objective: 'faça',
      idempotencyKey: 'key-1',
    };
    const first = store.createRun(input);
    const second = store.createRun(input);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.run.id, second.run.id);
    assert.equal(store.listRuns(principal).length, 1);

    // A different key is a different run; that is what a key is for.
    const other = store.createRun({ ...input, idempotencyKey: 'key-2' });
    assert.equal(other.created, true);
    assert.notEqual(other.run.id, first.run.id);

    // And the key is scoped to the principal: another tenant reusing the same
    // string must not be handed someone else's run.
    const bob = store.createPrincipal({ displayName: 'B' });
    const bobs = store.createRun({ ...input, principal: bob });
    assert.equal(bobs.created, true);
    assert.notEqual(bobs.run.id, first.run.id);
  } finally {
    database.close();
  }
});

/* -- leases ---------------------------------------------------------------- */

test('exactly one worker drives a run, and an abandoned one is picked up', () => {
  const database = memoryDatabase();
  try {
    const store = new RunStore(database);
    const principal = store.createPrincipal({ displayName: 'A' });
    const { run } = store.createRun({ principal, repository: 'o/r', branch: 'main', objective: 'x' });

    assert.equal(store.acquireLease(run.id, 'worker-a', 60_000), true);
    // A second process must not get it: two loops would double every agent
    // invocation, and every commit.
    assert.equal(store.acquireLease(run.id, 'worker-b', 60_000), false);
    // The holder can renew.
    assert.equal(store.renewLease(run.id, 'worker-a', 60_000), true);
    assert.equal(store.renewLease(run.id, 'worker-b', 60_000), false);
    // A run whose lease still holds is not abandoned.
    assert.deepEqual(store.listAbandoned().map((r) => r.id), []);

    // Once it lapses, another process may take over.
    store.acquireLease(run.id, 'worker-a', -1);
    assert.deepEqual(store.listAbandoned().map((r) => r.id), [run.id]);
    assert.equal(store.acquireLease(run.id, 'worker-b', 60_000), true);

    // A finished run is never picked up again.
    store.setStatus(run.id, 'DONE');
    store.acquireLease(run.id, 'worker-b', -1);
    assert.deepEqual(store.listAbandoned().map((r) => r.id), []);
  } finally {
    database.close();
  }
});

/* -- the event log --------------------------------------------------------- */

test('the event log is append-only, ordered, and resumes from a cursor', () => {
  const database = memoryDatabase();
  try {
    const store = new RunStore(database);
    const principal = store.createPrincipal({ displayName: 'A' });
    const { run } = store.createRun({ principal, repository: 'o/r', branch: 'main', objective: 'x' });

    // `run.created` is already event 1.
    const seqs = ['a', 'b', 'c'].map((kind) => store.append(run.id, kind, { kind }));
    assert.deepEqual(seqs, [2, 3, 4]);

    const all = store.events(run.id, 0);
    assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4]);
    // A desktop that had applied up to 2 gets 3 and 4 - not a replay of 1.
    const resumed = store.events(run.id, 2);
    assert.deepEqual(resumed.map((e) => e.kind), ['b', 'c']);
    // And asking again with the same cursor is the same answer: catching up is
    // idempotent, so a reconnect cannot duplicate a step.
    assert.deepEqual(store.events(run.id, 2), resumed);
    assert.deepEqual(store.events(run.id, 4), []);
  } finally {
    database.close();
  }
});

test('a new sequence continues after a restart rather than starting again at one', () => {
  const database = memoryDatabase();
  try {
    const principal = new RunStore(database).createPrincipal({ displayName: 'A' });
    const { run } = new RunStore(database).createRun({
      principal,
      repository: 'o/r',
      branch: 'main',
      objective: 'x',
    });
    new RunStore(database).append(run.id, 'a', {});
    // A different RunStore object stands for a different process on the same
    // durable store. If the sequence lived in memory this would collide.
    const seq = new RunStore(database).append(run.id, 'b', {});
    assert.equal(seq, 3);
  } finally {
    database.close();
  }
});

/* -- the coordinator, end to end through its API --------------------------- */

async function withServer<T>(
  coordinator: Coordinator,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = createCoordinatorServer({ coordinator });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('the API refuses everything without a token, and scopes everything with one', async () => {
  const database = memoryDatabase();
  const provisioner = fakeProvisioner();
  const coordinator = new Coordinator({
    database,
    provisioner,
    credentials: { openaiApiKey: 'sk-test', anthropicApiKey: 'sk-ant-test' },
  });
  try {
    const alice = coordinator.store.createPrincipal({ displayName: 'Alice' });
    const bob = coordinator.store.createPrincipal({ displayName: 'Bob' });
    const aliceToken = coordinator.store.issueSession({ principalId: alice.id }).token;
    const bobToken = coordinator.store.issueSession({ principalId: bob.id }).token;

    await withServer(coordinator, async (base) => {
      // Health is the only open route, and it discloses nothing.
      const health = await fetch(`${base}/v1/health`);
      assert.equal(health.status, 200);

      assert.equal((await fetch(`${base}/v1/runs`)).status, 401);
      assert.equal(
        (await fetch(`${base}/v1/runs`, { headers: { authorization: 'Bearer nope' } })).status,
        401,
      );

      const created = await fetch(`${base}/v1/runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repository: 'alice/secret', branch: 'main', objective: 'faça algo' }),
      });
      assert.equal(created.status, 201);
      const { run } = (await created.json()) as { run: { id: string; status: string } };

      // Bob, with a perfectly valid token of his own, cannot see it.
      const asBob = await fetch(`${base}/v1/runs/${run.id}`, {
        headers: { authorization: `Bearer ${bobToken}` },
      });
      assert.equal(asBob.status, 404);
      const bobList = await (
        await fetch(`${base}/v1/runs`, { headers: { authorization: `Bearer ${bobToken}` } })
      ).json();
      assert.deepEqual((bobList as { runs: unknown[] }).runs, []);

      // There is no generic execution endpoint to find.
      for (const path of ['/v1/exec', '/v1/shell', '/v1/runs/../../etc/passwd']) {
        const probe = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${aliceToken}` },
        });
        assert.ok(probe.status === 404 || probe.status === 400, `${path} answered ${probe.status}`);
      }
    });
  } finally {
    await coordinator.shutdown();
    database.close();
  }
});

test('an Idempotency-Key header absorbs a retry instead of starting a second run', async () => {
  const database = memoryDatabase();
  const coordinator = new Coordinator({
    database,
    provisioner: fakeProvisioner(),
    credentials: { openaiApiKey: 'sk-test' },
  });
  try {
    const principal = coordinator.store.createPrincipal({ displayName: 'A' });
    const token = coordinator.store.issueSession({ principalId: principal.id }).token;

    await withServer(coordinator, async (base) => {
      const post = () =>
        fetch(`${base}/v1/runs`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'idempotency-key': 'the-same-key',
          },
          body: JSON.stringify({ repository: 'o/r', branch: 'main', objective: 'x' }),
        });

      const first = await post();
      const second = await post();
      assert.equal(first.status, 201, 'the first submission created a run');
      assert.equal(second.status, 200, 'the retry must not create a second run');
      const a = (await first.json()) as { run: { id: string }; created: boolean };
      const b = (await second.json()) as { run: { id: string }; created: boolean };
      assert.equal(a.run.id, b.run.id);
      assert.equal(b.created, false);
      assert.equal(coordinator.store.listRuns(principal).length, 1);
    });
  } finally {
    await coordinator.shutdown();
    database.close();
  }
});

/* -- the promise: the computer is off and the work continues --------------- */

/**
 * A workspace whose agent CLIs are scripted but whose git, node and shell are
 * real, against a real checkout.
 *
 * This is as close to a remote run as can be reached without a host: the real
 * `CodexAdapter` and `ClaudeCodeAdapter` (capability probes included), the real
 * `GitEvidenceCollector`, the real `Verifier` and the real DONE gate, all
 * driven through the environment boundary. What is *not* proved here is the
 * isolation itself - that needs a container runtime, and it is the cloud E2E
 * gate. What is proved is that the coordinator finishes the work, and records
 * it, with nobody watching.
 */
function workspaceOverRepository(repoPath: string, script: Map<string, string[]>) {
  const manager = new ProcessManager();
  const remoteRoot = '/workspace/repo';
  const taken = new Map<string, number>();
  const runner: ProcessRunner = {
    async run(options: RunProcessOptions): Promise<ProcessResult> {
      const key = `${options.command} ${(options.args ?? []).join(' ')}`;
      for (const [prefix, answers] of script) {
        if (!key.startsWith(prefix)) continue;
        const index = taken.get(prefix) ?? 0;
        taken.set(prefix, index + 1);
        const stdout = answers[Math.min(index, answers.length - 1)] ?? '';
        return {
          outcome: 'completed',
          exitCode: 0,
          signal: null,
          stdout,
          stderr: '',
          durationMs: 1,
          truncated: false,
        } as ProcessResult;
      }
      // Everything else - git, node - really runs, in the real checkout.
      const cwd = options.cwd.startsWith(remoteRoot)
        ? repoPath + options.cwd.slice(remoteRoot.length)
        : repoPath;
      return manager.run({ ...options, cwd });
    },
    async cancelAll() {
      await manager.cancelAll();
    },
  };
  return { runner, remoteRoot };
}

const CODEX_HELP = 'Usage: codex [OPTIONS]\n\nCommands:\n  exec     Run Codex non-interactively\n\nOptions:\n  -h, --help  Print help\n';
const CODEX_EXEC_HELP =
  'Usage: codex exec [OPTIONS]\n\nOptions:\n      --skip-git-repo-check\n          Allow running outside a repo\n  -o, --output-last-message <FILE>\n          Write the last message\n';
const CLAUDE_HELP = 'Usage: claude [options]\n\nOptions:\n  -p, --print   Print response and exit\n';

test('a run finishes and is recorded with no desktop connected at any point', async () => {
  const repo = createGitFixture('lao-coordinator-');
  repo.write('README.md', '# repo\n');
  repo.write(
    'check.mjs',
    [
      "import { existsSync } from 'node:fs';",
      "if (!existsSync('feito.txt')) { console.error('feito.txt não existe'); process.exit(1); }",
      "console.log('ok');",
    ].join('\n'),
  );
  repo.commitAll('baseline');

  const script = new Map<string, string[]>([
    ['/usr/local/bin/codex --version', ['codex-cli 0.153.4']],
    ['/usr/local/bin/codex --help', [CODEX_HELP]],
    ['/usr/local/bin/codex exec --help', [CODEX_EXEC_HELP]],
    ['/usr/local/bin/codex login', ['']],
    [
      '/usr/local/bin/codex exec',
      [
        JSON.stringify({
          action: 'delegate',
          task: 'crie feito.txt',
          acceptanceCriteria: ['feito.txt existe'],
          verificationCommands: ['feito-existe'],
        }),
        JSON.stringify({
          action: 'done',
          acceptanceCriteria: ['feito.txt existe'],
          verificationCommands: ['feito-existe'],
        }),
      ],
    ],
    ['/usr/local/bin/claude --help', [CLAUDE_HELP]],
    ['/usr/local/bin/claude --print', ['arquivo criado']],
  ]);
  const { runner, remoteRoot } = workspaceOverRepository(repo.dir, script);

  // The worker's edit: made when its scripted invocation is asked for.
  const workerRunner: ProcessRunner = {
    async run(options) {
      if (options.command.endsWith('/claude') && (options.args ?? []).includes('--print')) {
        repo.write('feito.txt', 'pronto\n');
      }
      return runner.run(options);
    },
    async cancelAll() {
      await runner.cancelAll();
    },
  };

  const provisioner: WorkspaceProvisioner = {
    id: 'test-workspace',
    capabilities: { isolated: true, networkPolicy: true, resourceLimits: true, durable: true },
    async provision(request) {
      return {
        cloudWorkspaceId: request.cloudWorkspaceId,
        handle: `h-${request.cloudWorkspaceId}`,
        workingDirectory: remoteRoot,
        processes: workerRunner,
        commit: repo.head(),
        release: async () => {},
      };
    },
    async reclaim() {},
  };

  const database = memoryDatabase();
  const coordinator = new Coordinator({
    database,
    provisioner,
    credentials: { openaiApiKey: 'sk-test', anthropicApiKey: 'sk-ant-test' },
    maxIterations: 4,
    agentTimeoutMs: 30_000,
  });

  try {
    const principal = coordinator.store.createPrincipal({ displayName: 'Ausente' });
    const { run } = await coordinator.submit({
      principal,
      repository: 'Arcanjog1/Orquestrador',
      branch: 'main',
      objective: 'crie feito.txt',
      // The team, as the interface configured it. The check travels with the
      // run because the DONE gate re-runs it, remotely, before accepting.
      team: {
        verifications: [{ id: 'feito-existe', label: 'feito.txt existe', command: 'node check.mjs' }],
      },
    });

    // From here on nothing watches. No desktop, no subscriber, no polling loop
    // holding the run open - exactly the state of an application that was
    // closed the moment after it pressed send.
    const deadline = Date.now() + 60_000;
    let finished = coordinator.store.requireRunUnscoped(run.id);
    while (!['DONE', 'FAILED', 'CANCELLED', 'NEEDS_HUMAN'].includes(finished.status)) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
      finished = coordinator.store.requireRunUnscoped(run.id);
    }

    assert.equal(finished.status, 'DONE', finished.failure_reason ?? 'não terminou');
    // The worker really edited the checkout, and the loop really saw it.
    assert.ok(existsSync(join(repo.dir, 'feito.txt')), 'the worker never wrote the file');

    // What a desktop coming back finds: the whole story, from sequence 1.
    const events = coordinator.store.events(run.id, 0);
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes('run.created'));
    assert.ok(kinds.includes('run.started'));
    assert.ok(
      kinds.some((k) => k.startsWith('orchestration.')),
      'the loop published nothing durable',
    );
    assert.equal(kinds.at(-1), 'run.status');
    // Sequences are dense and ordered, so a cursor cannot skip an event.
    assert.deepEqual(
      events.map((e) => e.seq),
      events.map((_, index) => index + 1),
    );

    // And a desktop that had already seen the first few resumes exactly.
    const resumed = coordinator.store.events(run.id, 3);
    assert.deepEqual(resumed.map((e) => e.seq), events.slice(3).map((e) => e.seq));
  } finally {
    await coordinator.shutdown();
    database.close();
    repo.cleanup();
  }
});

test('a coordinator that died mid-run is replaced, and the run is not started twice', async () => {
  const database = memoryDatabase();
  // Never resolves: the run is still in flight when the process "dies".
  const stalling: WorkspaceProvisioner = {
    id: 'stalling',
    capabilities: { isolated: true, networkPolicy: true, resourceLimits: true, durable: true },
    async provision(request) {
      // Never finishes on its own; a shutdown must be able to stop it, which
      // is what the signal is for.
      await new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
      throw new Error('unreachable');
    },
    async reclaim() {},
  };

  const first = new Coordinator({
    database,
    provisioner: stalling,
    credentials: { openaiApiKey: 'sk-test' },
    owner: 'coord-1',
    leaseTtlMs: 250,
  });
  const principal = first.store.createPrincipal({ displayName: 'A' });
  const { run } = await first.submit({
    principal,
    repository: 'o/r',
    branch: 'main',
    objective: 'x',
  });

  // It took the lease and is holding it.
  await waitUntil(() => first.store.listAbandoned().length === 0);
  const second = new Coordinator({
    database,
    provisioner: stalling,
    credentials: { openaiApiKey: 'sk-test' },
    owner: 'coord-2',
    leaseTtlMs: 250,
  });
  // While the first still holds it, the second finds nothing to take over -
  // two coordinators driving one run would double every agent invocation.
  assert.equal(await second.recover(), 0);

  // The first process dies. Its lease is no longer renewed.
  await first.shutdown();
  await waitUntil(() => second.store.listAbandoned().some((r) => r.id === run.id), 5_000);

  assert.equal(await second.recover(), 1, 'the abandoned run was not picked up');
  const events = second.store.events(run.id, 0);
  assert.ok(events.some((e) => e.kind === 'run.recovered'));
  // Recovered, not restarted: the run is the same row, with its history intact.
  assert.equal(second.store.requireRunUnscoped(run.id).id, run.id);
  assert.equal(events.filter((e) => e.kind === 'run.created').length, 1);

  await second.shutdown();
  database.close();
});

async function waitUntil(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/* -- costs: nothing is left running ---------------------------------------- */

test('the reaper reclaims what expired and what a crash left behind', async () => {
  const database = memoryDatabase();
  try {
    const store = new RunStore(database);
    const provisioner = fakeProvisioner();
    const reaper = new Reaper({ database, store, provisioner });
    const principal = store.createPrincipal({ displayName: 'A' });

    const workspaceId = database.workspaces.create({
      id: 'ws-1',
      name: 'o/r',
      localPath: '',
      environment: 'cloud',
      repositoryFullName: 'o/r',
      branch: 'main',
    }).id;

    // 1. Past its ceiling while its run is still going: stopped by the clock,
    //    which is the only thing that stops a run that will not end itself.
    const expired = database.cloudWorkspaces.create({
      id: 'cw-expired',
      workspaceId,
      provisioner: 'fake',
      repository: 'o/r',
      branch: 'main',
      workingDir: '/workspace/repo',
      ttlMs: -1000,
    });
    database.cloudWorkspaces.setHandle(expired.id, 'handle-expired');
    database.cloudWorkspaces.setStatus(expired.id, 'ready');

    // 2. Its run finished, but the release never happened - what a crash
    //    between the two leaves behind, and what nothing else would clear.
    const orphan = database.cloudWorkspaces.create({
      id: 'cw-orphan',
      workspaceId,
      provisioner: 'fake',
      repository: 'o/r',
      branch: 'main',
      workingDir: '/workspace/repo',
      ttlMs: 60 * 60_000,
    });
    database.cloudWorkspaces.setHandle(orphan.id, 'handle-orphan');
    database.cloudWorkspaces.setStatus(orphan.id, 'ready');
    const { run: finished } = store.createRun({
      principal,
      repository: 'o/r',
      branch: 'main',
      objective: 'x',
    });
    store.setCloudWorkspace(finished.id, orphan.id);
    store.setStatus(finished.id, 'DONE');

    // 3. A live workspace of a run still going, well inside its ceiling: not
    //    the reaper's business, and reclaiming it would kill working runs.
    const live = database.cloudWorkspaces.create({
      id: 'cw-live',
      workspaceId,
      provisioner: 'fake',
      repository: 'o/r',
      branch: 'main',
      workingDir: '/workspace/repo',
      ttlMs: 60 * 60_000,
    });
    database.cloudWorkspaces.setStatus(live.id, 'ready');
    const { run: running } = store.createRun({
      principal,
      repository: 'o/r',
      branch: 'main',
      objective: 'y',
    });
    store.setCloudWorkspace(running.id, live.id);
    store.setStatus(running.id, 'RUNNING');

    const swept = await reaper.sweep();
    assert.deepEqual(swept.expired, ['cw-expired']);
    assert.deepEqual(swept.orphaned, ['cw-orphan']);
    assert.deepEqual(provisioner.released.sort(), ['handle-expired', 'handle-orphan']);

    assert.equal(database.cloudWorkspaces.require('cw-expired').status, 'released');
    assert.equal(database.cloudWorkspaces.require('cw-orphan').status, 'released');
    assert.equal(database.cloudWorkspaces.require('cw-live').status, 'ready', 'a working run was reclaimed');

    // A second sweep finds nothing: reclaiming is not repeated per pass.
    assert.deepEqual(await reaper.sweep(), { expired: [], orphaned: [] });
  } finally {
    database.close();
  }
});
