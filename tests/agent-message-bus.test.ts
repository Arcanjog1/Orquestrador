/**
 * The delivery guarantees, one failure mode at a time (spec 12, spec 21).
 *
 * These tests exist because "the message was sent" is the sentence that hid
 * the original bug. Each one pins a distinction the bus is supposed to make:
 * accepted is not delivered, delivered is not started, started is not done,
 * and a worker that dies must leave a mark rather than a silence.
 *
 * The clock is injected, so nothing here sleeps and nothing is flaky.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/database/database.js';
import { AgentMessageBus } from '../src/bus/agent-message-bus.js';
import { backoffMs, defaultDedupeKey, isDurable } from '../src/bus/message-types.js';

/** A clock a test can move by hand. */
function fixedClock(start = Date.parse('2026-01-01T00:00:00.000Z')) {
  let current = start;
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}

interface Harness {
  database: Database;
  bus: AgentMessageBus;
  clock: ReturnType<typeof fixedClock>;
  runId: string;
  conversationId: string;
  changes: string[];
}

/**
 * A real database with a real run, because the bus's guarantees are the
 * database's: a unique index and a guarded update, not bookkeeping in a Map.
 * Testing it against a stub would test the stub.
 */
function harness(options: { leaseMs?: number; maxAttempts?: number } = {}): Harness {
  const database = new Database({ filePath: ':memory:' });
  const clock = fixedClock();
  const changes: string[] = [];

  database.providers.ensureSeeded();
  const workspace = database.workspaces.create({
    id: 'ws-1',
    name: 'Projeto',
    localPath: '/tmp/projeto',
  });
  const session = database.chat.createSession({
    id: 'chat-1',
    workspaceId: workspace.id,
    title: 'Conversa',
  });
  const run = database.runs.create({
    id: 'run-1',
    sessionId: session.id,
    workspaceId: workspace.id,
    objective: 'objetivo',
    orchestratorAgentId: null,
    maxIterations: 8,
  });

  const bus = new AgentMessageBus(database.agentMessages, {
    now: clock.now,
    // No jitter, so backoff assertions are exact.
    random: () => 0.5,
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    onChange: (message) => changes.push(`${message.messageType}:${message.status}`),
  });

  return { database, bus, clock, runId: run.id, conversationId: session.id, changes };
}

function delegation(h: Harness, overrides: Record<string, unknown> = {}) {
  return {
    runId: h.runId,
    conversationId: h.conversationId,
    iteration: 1,
    messageType: 'DELEGATION' as const,
    payload: { task: 'crie hello.txt' },
    senderAgentId: 'codex-1',
    recipientAgentId: 'claude-1',
    ...overrides,
  };
}

test('a published message is persisted before anyone can receive it', () => {
  const h = harness();
  const { message, created } = h.bus.publish(delegation(h));

  assert.equal(created, true);
  assert.equal(message.status, 'pending');
  // The row exists independently of this object: a crash right here leaves the
  // instruction recorded, not lost.
  const stored = h.database.agentMessages.find(message.messageId);
  assert.ok(stored, 'the message must be a committed row, not an in-memory object');
  assert.equal(stored.status, 'pending');
  assert.equal(stored.attempts, 0);
});

test('publishing the same message twice delivers it once', () => {
  const h = harness();
  const first = h.bus.publish(delegation(h));
  const second = h.bus.publish(delegation(h));

  assert.equal(first.created, true);
  assert.equal(second.created, false, 'a duplicate publish must not create a second message');
  assert.equal(second.message.messageId, first.message.messageId);
  assert.equal(h.database.agentMessages.listForRun(h.runId).length, 1);

  // And the worker is asked once, not twice.
  assert.ok(h.bus.claim('claude-1'));
  assert.equal(h.bus.claim('claude-1'), undefined);
});

test('accepted, delivered, started and completed are four different states', () => {
  const h = harness();
  const { message } = h.bus.publish(delegation(h));
  assert.equal(message.status, 'pending', 'accepted by the bus');

  const delivery = h.bus.claim('claude-1');
  assert.ok(delivery);
  assert.equal(delivery.message.status, 'leased', 'delivered to the agent');
  assert.equal(delivery.message.attempts, 1);

  assert.equal(h.bus.acknowledge(message.messageId), true);
  assert.equal(h.bus.find(message.messageId)?.status, 'started', 'agent began work');

  assert.equal(h.bus.complete(message.messageId), true);
  assert.equal(h.bus.find(message.messageId)?.status, 'completed', 'outcome persisted');
  assert.equal(h.bus.find(message.messageId)?.leaseExpiresAt, null);

  assert.deepEqual(h.changes, [
    'DELEGATION:pending',
    'DELEGATION:leased',
    'DELEGATION:started',
    'DELEGATION:completed',
  ]);
});

test('one worker is never given two things at once in the same run', () => {
  const h = harness();
  h.bus.publish(delegation(h, { iteration: 1 }));
  h.bus.publish(delegation(h, { iteration: 2 }));

  const first = h.bus.claim('claude-1');
  assert.ok(first);
  assert.equal(h.bus.claim('claude-1'), undefined, 'the second must wait for the first');

  h.bus.complete(first.message.messageId);
  const second = h.bus.claim('claude-1');
  assert.ok(second, 'and it is offered as soon as the first finishes');
  assert.equal(second.message.iteration, 2);
});

test('two workers are separate queues', () => {
  const h = harness();
  h.bus.publish(delegation(h, { recipientAgentId: 'claude-1' }));
  h.bus.publish(delegation(h, { recipientAgentId: 'claude-2' }));

  const one = h.bus.claim('claude-1');
  const two = h.bus.claim('claude-2');
  assert.ok(one);
  assert.ok(two);
  assert.equal(one.message.recipientAgentId, 'claude-1');
  assert.equal(two.message.recipientAgentId, 'claude-2');
  assert.notEqual(one.message.messageId, two.message.messageId);
});

test('a worker that dies without a word leaves an expired lease, not a silence', () => {
  const h = harness({ leaseMs: 60_000 });
  const { message } = h.bus.publish(delegation(h));
  h.bus.claim('claude-1');
  h.bus.acknowledge(message.messageId);

  // Nothing is wrong yet: the turn is simply still running.
  assert.deepEqual(h.bus.sweep(), { requeued: [], dead: [] });

  h.clock.advance(60_001);
  const swept = h.bus.sweep();
  assert.equal(swept.requeued.length, 1, 'the application must find out');
  assert.equal(swept.dead.length, 0);
  assert.match(swept.requeued[0]!.failureReason ?? '', /Sem resposta/);
  assert.equal(h.bus.find(message.messageId)?.status, 'pending', 'and it is queued again');
});

test('retries back off, and the last one is a named dead letter rather than a drop', () => {
  const h = harness({ leaseMs: 1_000, maxAttempts: 3 });
  const { message } = h.bus.publish(delegation(h));

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const delivery = h.bus.claim('claude-1');
    assert.ok(delivery, `attempt ${attempt} must be offered`);
    assert.equal(delivery.message.attempts, attempt);
    h.bus.fail(message.messageId, 'o processo saiu sem responder');
    // Backoff: not available again until the delay has passed.
    if (attempt < 3) {
      assert.equal(h.bus.claim('claude-1'), undefined, 'a backoff must actually delay');
      h.clock.advance(backoffMs(attempt, 1_000, 60_000, () => 0.5) + 1);
    }
  }

  const dead = h.bus.find(message.messageId);
  assert.equal(dead?.status, 'dead');
  assert.match(dead?.failureReason ?? '', /o processo saiu sem responder/);
  // The message is still there. Nothing was discarded quietly.
  assert.equal(h.database.agentMessages.listForRun(h.runId).length, 1);
});

test('a failure another attempt cannot fix is not retried', () => {
  const h = harness({ maxAttempts: 5 });
  const { message } = h.bus.publish(delegation(h));
  h.bus.claim('claude-1');

  // A refused permission is not made better by asking again, and each attempt
  // may cost money.
  h.bus.fail(message.messageId, 'ferramenta recusada: Write', { retryable: false });

  assert.equal(h.bus.find(message.messageId)?.status, 'dead');
  assert.equal(h.bus.claim('claude-1'), undefined);
});

test('cancelling a run stops what is unfinished and keeps what already happened', () => {
  const h = harness();
  const done = h.bus.publish(delegation(h, { iteration: 1 }));
  h.bus.claim('claude-1');
  h.bus.complete(done.message.messageId);
  const inFlight = h.bus.publish(delegation(h, { iteration: 2 }));
  h.bus.claim('claude-1');
  const queued = h.bus.publish(delegation(h, { iteration: 3 }));

  const cancelled = h.bus.cancelRun(h.runId);
  assert.equal(cancelled, 2);

  assert.equal(h.bus.find(done.message.messageId)?.status, 'completed', 'history is not rewritten');
  assert.equal(h.bus.find(inFlight.message.messageId)?.status, 'cancelled');
  assert.equal(h.bus.find(queued.message.messageId)?.status, 'cancelled');
  assert.equal(h.bus.claim('claude-1'), undefined);
});

test('after a crash, what was in flight is reported rather than assumed', () => {
  const h = harness();
  const leased = h.bus.publish(delegation(h, { iteration: 1 }));
  h.bus.claim('claude-1');
  h.bus.acknowledge(leased.message.messageId);
  h.bus.publish(delegation(h, { iteration: 2 }));

  // A new process over the same database: the in-memory set is empty, the rows
  // are not.
  const restarted = new AgentMessageBus(h.database.agentMessages, { now: h.clock.now });
  const recovered = restarted.recover();

  assert.equal(recovered.interrupted.length, 1);
  assert.equal(recovered.interrupted[0]!.messageId, leased.message.messageId);
  assert.equal(recovered.pending.length, 1);
  // The interrupted one is not silently re-run: the caller decides, against
  // evidence, because redelivering a write that may already have happened is
  // exactly what spec 12 forbids.
  assert.equal(restarted.find(leased.message.messageId)?.status, 'started');
});

test('the in-flight guard is rebuilt from the database, not from memory', () => {
  const h = harness();
  h.bus.publish(delegation(h, { iteration: 1 }));
  h.bus.claim('claude-1');

  const restarted = new AgentMessageBus(h.database.agentMessages, { now: h.clock.now });
  restarted.recover();
  // The row is still leased, so the claim query must not offer it again even
  // though this process never handed it out.
  assert.equal(restarted.claim('claude-1'), undefined);
});

test('a request and its answer share one correlation id', () => {
  const h = harness();
  const request = h.bus.publish(delegation(h));
  h.bus.publish({
    runId: h.runId,
    conversationId: h.conversationId,
    iteration: 1,
    messageType: 'WORKER_RESULT',
    payload: { report: 'criado' },
    senderAgentId: 'claude-1',
    recipientAgentId: 'codex-1',
    correlationId: request.message.correlationId,
    causationId: request.message.messageId,
  });

  const exchange = h.bus.listForCorrelation(request.message.correlationId);
  assert.equal(exchange.length, 2);
  assert.deepEqual(
    exchange.map((m) => m.messageType),
    ['DELEGATION', 'WORKER_RESULT'],
  );
  assert.equal(exchange[1]!.causationId, request.message.messageId);
});

test('an empty answer is a message, not an absence', () => {
  const h = harness();
  const { message } = h.bus.publish({
    runId: h.runId,
    conversationId: h.conversationId,
    iteration: 1,
    messageType: 'WORKER_RESULT',
    payload: { report: '' },
    senderAgentId: 'claude-1',
  });
  assert.equal(message.status, 'pending');
  assert.deepEqual(h.bus.find(message.messageId)?.payload, { report: '' });
});

test('progress is not durable, and the types that are say so', () => {
  assert.equal(isDurable('WORKER_PROGRESS'), false);
  assert.equal(isDurable('WORKER_RESULT'), true);
  assert.equal(isDurable('DELEGATION'), true);
  assert.equal(isDurable('VERIFICATION_RESULT'), true);
});

test('the default idempotency key separates iterations, workers and steps', () => {
  const base = {
    runId: 'run-1',
    conversationId: 'chat-1',
    iteration: 1,
    messageType: 'DELEGATION' as const,
    payload: {},
  };
  assert.equal(
    defaultDedupeKey({ ...base, recipientAgentId: 'claude-1' }),
    'run-1:1:DELEGATION:claude-1:-',
  );
  assert.notEqual(
    defaultDedupeKey({ ...base, recipientAgentId: 'claude-1' }),
    defaultDedupeKey({ ...base, recipientAgentId: 'claude-2' }),
  );
  assert.notEqual(
    defaultDedupeKey({ ...base, iteration: 1, recipientAgentId: 'claude-1' }),
    defaultDedupeKey({ ...base, iteration: 2, recipientAgentId: 'claude-1' }),
  );
});

test('backoff grows, is capped, and is jittered', () => {
  const noJitter = () => 0.5;
  assert.equal(backoffMs(1, 1_000, 60_000, noJitter), 1_000);
  assert.equal(backoffMs(2, 1_000, 60_000, noJitter), 2_000);
  assert.equal(backoffMs(3, 1_000, 60_000, noJitter), 4_000);
  assert.equal(backoffMs(20, 1_000, 60_000, noJitter), 60_000, 'capped');
  // Jitter moves it, and never below zero.
  assert.ok(backoffMs(3, 1_000, 60_000, () => 0) < 4_000);
  assert.ok(backoffMs(3, 1_000, 60_000, () => 1) > 4_000);
  assert.ok(backoffMs(1, 0, 60_000, () => 0) >= 0);
});

test('a backed-off message does not block a different run for the same worker', () => {
  const h = harness({ leaseMs: 1_000 });
  const other = h.database.runs.create({
    id: 'run-2',
    sessionId: h.conversationId,
    workspaceId: 'ws-1',
    objective: 'outro',
    orchestratorAgentId: null,
    maxIterations: 8,
  });

  const first = h.bus.publish(delegation(h));
  h.bus.claim('claude-1');
  h.bus.fail(first.message.messageId, 'falhou');

  const second = h.bus.claim('claude-1');
  assert.equal(second, undefined, 'the failed run is waiting out its backoff');

  h.bus.publish(delegation(h, { runId: other.id }));
  const claimed = h.bus.claim('claude-1');
  assert.ok(claimed, 'but another run is not held hostage by it');
  assert.equal(claimed.message.runId, other.id);
});

test('counts by status are what a panel can show without reading every row', () => {
  const h = harness();
  const a = h.bus.publish(delegation(h, { iteration: 1 }));
  h.bus.claim('claude-1');
  h.bus.complete(a.message.messageId);
  h.bus.publish(delegation(h, { iteration: 2 }));

  assert.deepEqual(h.bus.countByStatus(h.runId), { completed: 1, pending: 1 });
});
