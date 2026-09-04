import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/database/database.js';

/**
 * The repositories added so the interface can read what the schema already
 * holds. The point of these tests is that they add no state of their own:
 * every fact is written to, and read back from, the existing tables.
 */

function db(): Database {
  return new Database({ filePath: ':memory:' });
}

function seedWorkspace(database: Database) {
  return database.workspaces.ensure({ displayName: 'Projeto', localPath: '/tmp/projeto' });
}

test('ensure() registers a folder once and returns the same workspace after', () => {
  const database = db();
  const first = seedWorkspace(database);
  const second = database.workspaces.ensure({ displayName: 'Outro nome', localPath: '/tmp/projeto' });
  assert.equal(second.id, first.id, 'the same path must not become a second workspace');
  assert.equal(database.workspaces.all().length, 1);
  database.close();
});

test('providers are seeded idempotently', () => {
  const database = db();
  const providers = [{ id: 'anthropic', displayName: 'Anthropic' }];
  database.providers.ensure(providers);
  database.providers.ensure(providers);
  assert.equal(database.providers.all().filter((p) => p.id === 'anthropic').length, 1);
  database.close();
});

test('an account records its auth state and stamps the connection only when connected', () => {
  const database = db();
  database.providers.ensure([{ id: 'anthropic', displayName: 'Anthropic' }]);
  database.accounts.insert({
    id: 'a1',
    providerId: 'anthropic',
    displayName: 'Claude Trabalho',
    profileDirectory: '/profiles/a1',
  });

  database.accounts.recordStatus('a1', 'ambient-credential', 'env');
  const ambient = database.accounts.get('a1');
  assert.equal(ambient?.auth_state, 'ambient-credential');
  assert.equal(ambient?.last_connected_at, null, 'ambient credential is not a connection');

  database.accounts.recordStatus('a1', 'connected', 'oauth');
  const connected = database.accounts.get('a1');
  assert.equal(connected?.auth_state, 'connected');
  assert.ok(connected?.last_connected_at, 'connecting must stamp the time');
  database.close();
});

test('removing an account detaches it from agents instead of deleting them', () => {
  const database = db();
  database.providers.ensure([{ id: 'anthropic', displayName: 'Anthropic' }]);
  database.accounts.insert({
    id: 'a1',
    providerId: 'anthropic',
    displayName: 'Claude',
    profileDirectory: '/profiles/a1',
  });
  database.agents.upsert({
    id: 'worker',
    displayName: 'Claude',
    providerId: 'anthropic',
    accountId: 'a1',
    adapterId: 'claude-code',
    role: 'CODING_WORKER',
    model: null,
  });

  database.agents.clearAccount('a1');
  database.accounts.remove('a1');

  const agent = database.agents.get('worker');
  assert.ok(agent, 'the agent must survive its account being removed');
  assert.equal(agent?.account_id, null);
  database.close();
});

test('active() reports an open run and stops reporting one that finished', () => {
  const database = db();
  const workspace = seedWorkspace(database);
  const run = database.runs.create({
    workspaceId: workspace.id,
    sessionId: null,
    objective: 'Objetivo',
    maxIterations: 20,
  });

  assert.equal(database.runs.active(workspace.id)?.id, run.id);

  database.runs.setStatus(run.id, 'DONE', 'Verificado.');
  assert.equal(database.runs.active(workspace.id), undefined, 'a finished run is not active');
  assert.equal(database.runs.latest(workspace.id)?.id, run.id, 'but it is still the latest');

  const finished = database.runs.get(run.id);
  assert.ok(finished?.finished_at, 'a terminal status must stamp finished_at');
  assert.equal(finished?.termination_reason, 'Verificado.');
  database.close();
});

test('a non-terminal status does not stamp finished_at', () => {
  const database = db();
  const workspace = seedWorkspace(database);
  const run = database.runs.create({
    workspaceId: workspace.id,
    sessionId: null,
    objective: 'Objetivo',
    maxIterations: 20,
  });
  database.runs.setStatus(run.id, 'PAUSED');
  assert.equal(database.runs.get(run.id)?.finished_at, null);
  database.close();
});

test('steps, invocations and verifications come back ordered by iteration', () => {
  const database = db();
  const workspace = seedWorkspace(database);
  const run = database.runs.create({
    workspaceId: workspace.id,
    sessionId: null,
    objective: 'Objetivo',
    maxIterations: 20,
  });

  for (const iteration of [2, 1]) {
    const step = database.runSteps.start({ runId: run.id, iteration, phase: 'verify' });
    database.runSteps.finish(step, 'passed', `iteração ${iteration}`);
    database.agentInvocations.start({
      runId: run.id,
      iteration,
      role: 'CODING_WORKER',
      agentId: null,
      accountId: null,
      task: null,
    });
    database.verificationResults.record({
      runId: run.id,
      iteration,
      definitionId: null,
      command: 'npm test',
      exitCode: 0,
      passed: iteration === 1,
    });
  }

  assert.deepEqual(
    database.runSteps.byRun(run.id).map((s) => s.iteration),
    [1, 2],
  );
  assert.deepEqual(
    database.agentInvocations.byRun(run.id).map((i) => i.iteration),
    [1, 2],
  );
  const results = database.verificationResults.byRun(run.id);
  assert.deepEqual(results.map((r) => r.iteration), [1, 2]);
  assert.equal(results[0]?.passed, 1);
  assert.equal(results[1]?.passed, 0);
  database.close();
});

test('an invocation records its measured duration and outcome', () => {
  const database = db();
  const workspace = seedWorkspace(database);
  const run = database.runs.create({
    workspaceId: workspace.id,
    sessionId: null,
    objective: 'Objetivo',
    maxIterations: 20,
  });
  const id = database.agentInvocations.start({
    runId: run.id,
    iteration: 1,
    role: 'ORCHESTRATOR',
    agentId: null,
    accountId: null,
    task: 'Analisar',
  });
  assert.equal(database.agentInvocations.byRun(run.id)[0]?.outcome, 'running');

  database.agentInvocations.finish(id, 'completed', 0, 1900);
  const done = database.agentInvocations.byRun(run.id)[0];
  assert.equal(done?.outcome, 'completed');
  assert.equal(done?.duration_ms, 1900);
  assert.ok(done?.finished_at);
  database.close();
});

test('messages round-trip their payload as JSON and stay in order', () => {
  const database = db();
  const workspace = seedWorkspace(database);
  const session = database.chatSessions.create(workspace.id, 'Tarefa');

  database.messages.append({
    sessionId: session.id,
    kind: 'USER_MESSAGE',
    author: 'user',
    body: 'Primeiro',
  });
  database.messages.append({
    sessionId: session.id,
    kind: 'HUMAN_REVIEW',
    author: 'user',
    body: 'Segundo',
    payload: { option: 'Aprovar', instruction: null },
  });

  const messages = database.messages.bySession(session.id);
  assert.deepEqual(messages.map((m) => m.body), ['Primeiro', 'Segundo']);
  assert.deepEqual(JSON.parse(messages[1]!.payload!), { option: 'Aprovar', instruction: null });
  database.close();
});

test('deleting a workspace takes its runs and sessions with it', () => {
  const database = db();
  const workspace = seedWorkspace(database);
  const session = database.chatSessions.create(workspace.id, 'Tarefa');
  database.runs.create({
    workspaceId: workspace.id,
    sessionId: session.id,
    objective: 'Objetivo',
    maxIterations: 20,
  });

  database.driver.run('DELETE FROM workspaces WHERE id = ?', [workspace.id]);
  assert.equal(database.runs.byWorkspace(workspace.id).length, 0);
  assert.equal(database.chatSessions.byWorkspace(workspace.id).length, 0);
  database.close();
});
