import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isResumable,
  isTerminal,
  RUN_STATUSES,
  describeStatus,
} from '../src/core/run-state.js';

test('happy path transitions are allowed', () => {
  const path = [
    'CREATED',
    'BASELINING',
    'ORCHESTRATING',
    'DELEGATING',
    'WORKER_RUNNING',
    'COLLECTING_EVIDENCE',
    'VERIFYING',
    'WAITING_ORCHESTRATOR',
    'ORCHESTRATING',
    'DONE_PENDING_VERIFICATION',
    'DONE',
  ] as const;
  for (let i = 0; i < path.length - 1; i += 1) {
    assert.ok(canTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`);
  }
});

test('rejected DONE hands control back to the orchestrator', () => {
  assert.ok(canTransition('DONE_PENDING_VERIFICATION', 'WAITING_ORCHESTRATOR'));
});

test('skipping stages is rejected', () => {
  assert.equal(canTransition('CREATED', 'DONE'), false);
  assert.throws(() => assertTransition('CREATED', 'DONE'), InvalidTransitionError);
});

test('cancel and fail are reachable from any live status', () => {
  for (const status of RUN_STATUSES) {
    if (isTerminal(status)) continue;
    assert.ok(canTransition(status, 'CANCELLED'), status);
    assert.ok(canTransition(status, 'FAILED'), status);
  }
});

test('terminal statuses cannot transition further', () => {
  for (const status of ['DONE', 'BLOCKED', 'CANCELLED', 'FAILED'] as const) {
    assert.ok(isTerminal(status));
    assert.equal(isResumable(status), false);
    assert.equal(canTransition(status, 'ORCHESTRATING'), false);
  }
});

test('self-transitions are allowed (idempotent saves)', () => {
  assert.ok(canTransition('WORKER_RUNNING', 'WORKER_RUNNING'));
});

test('every status has a description', () => {
  for (const status of RUN_STATUSES) {
    assert.ok(describeStatus(status).length > 0, status);
  }
});
