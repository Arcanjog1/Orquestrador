/**
 * The Activity panel, on a run that stopped.
 *
 * The incident: a run that ended in `NEEDS_HUMAN` having invoked nobody was
 * drawn as a run in progress - two steps spinning, a clock counting, and both
 * registered agents listed under "Equipe" as though they had taken part. Each
 * of those is a separate untruth with a separate cause, so each has its own
 * test here, and every one of them fails against the previous behaviour.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRunOver,
  participantsOf,
  stepsFrom,
  TERMINAL_RUN_STATUSES,
  type LiveAgent,
  type StageReport,
} from '../apps/desktop/src/shared/activity.js';

/** The stages the incident run actually reported, in order. */
const INCIDENT_STAGES: StageReport[] = [
  { stage: 'analysing', label: 'Analisando...', status: 'RUNNING' },
  { stage: 'orchestrator', label: 'Orquestrador analisando...', status: 'RUNNING' },
  { stage: 'needs-human', label: 'Limite atingido.', status: 'NEEDS_HUMAN' },
];

/* ---- steps -------------------------------------------------------------- */

test('a run that stopped has no step still running', () => {
  const steps = stepsFrom(INCIDENT_STAGES, true);
  assert.equal(
    steps.filter((step) => step.status === 'running').length,
    0,
    'a spinner after the run ended is the defect this replaces',
  );
  // And it is not quietly promoted to done either: neither stage finished.
  assert.deepEqual(
    steps.map((step) => step.status),
    ['stopped', 'stopped', 'stopped'],
  );
});

test('while the run is going, a running stage is running', () => {
  const steps = stepsFrom(INCIDENT_STAGES.slice(0, 2), false);
  assert.deepEqual(
    steps.map((step) => step.status),
    ['running', 'running'],
  );
});

test('a terminal stage is never a green tick', () => {
  for (const status of ['BLOCKED', 'NEEDS_HUMAN', 'CANCELLED']) {
    const [step] = stepsFrom([{ stage: 'x', label: 'Parou.', status }], true);
    assert.equal(step!.status, 'stopped', `${status} is not "done"`);
  }
  const [failed] = stepsFrom([{ stage: 'x', label: 'Falhou.', status: 'FAILED' }], true);
  assert.equal(failed!.status, 'failed');
  const [done] = stepsFrom([{ stage: 'x', label: 'Concluído.', status: 'DONE' }], true);
  assert.equal(done!.status, 'done');
});

test('the labels and the order are the run\'s own, untouched', () => {
  const steps = stepsFrom(INCIDENT_STAGES, true);
  assert.deepEqual(
    steps.map((step) => step.label),
    ['Analisando...', 'Orquestrador analisando...', 'Limite atingido.'],
  );
});

/* ---- when a run is over ------------------------------------------------- */

test('every status that ends a run counts as over', () => {
  for (const status of TERMINAL_RUN_STATUSES) assert.equal(isRunOver(status), true, status);
  for (const status of ['RUNNING', 'PENDING']) assert.equal(isRunOver(status), false, status);
  assert.equal(isRunOver(null), false);
  assert.equal(isRunOver(undefined), false);
});

/* ---- participants ------------------------------------------------------- */

const CODEX: LiveAgent = {
  agentId: 'codex',
  status: 'idle',
  currentTask: null,
  currentRunId: null,
  runningForMs: null,
  awaitingReply: 0,
};
const CLAUDE: LiveAgent = { ...CODEX, agentId: 'claude' };

test('a run that invoked nobody has no participants', () => {
  // The incident, exactly: NEEDS_HUMAN, zero invocations, two agents
  // registered in the application.
  assert.deepEqual(participantsOf([CODEX, CLAUDE], [], 'run-1', true), []);
});

test('only the agents this run invoked are listed', () => {
  const rows = participantsOf([CODEX, CLAUDE], [{ agentId: 'codex' }, { agentId: 'codex' }], 'run-1', true);
  assert.deepEqual(rows.map((row) => row.agentId), ['codex']);
});

test('an invocation with no agent recorded adds nobody', () => {
  assert.deepEqual(participantsOf([CODEX, CLAUDE], [{ agentId: null }], 'run-1', true), []);
});

test('an agent busy in another run is not busy in this one', () => {
  const busyElsewhere: LiveAgent = {
    ...CLAUDE,
    status: 'running',
    currentTask: 'outra conversa',
    currentRunId: 'run-2',
    runningForMs: 40_000,
    awaitingReply: 3,
  };
  const [row] = participantsOf([busyElsewhere], [{ agentId: 'claude' }], 'run-1', false);
  assert.equal(row!.status, 'idle');
  assert.equal(row!.currentTask, null, 'another run\'s task is not this run\'s');
  assert.equal(row!.runningForMs, null);
  assert.equal(row!.awaitingReply, 0);
});

test('an agent running in this run keeps its live facts', () => {
  const busyHere: LiveAgent = {
    ...CLAUDE,
    status: 'running',
    currentTask: 'editando README.md',
    currentRunId: 'run-1',
    runningForMs: 12_000,
    awaitingReply: 1,
  };
  const [row] = participantsOf([busyHere], [{ agentId: 'claude' }], 'run-1', false);
  assert.deepEqual(row, busyHere);
});

test('nothing is running once the run is over, even for its own agents', () => {
  const stale: LiveAgent = {
    ...CLAUDE,
    status: 'running',
    currentTask: 'editando README.md',
    currentRunId: 'run-1',
    runningForMs: 12_000,
    awaitingReply: 2,
  };
  const [row] = participantsOf([stale], [{ agentId: 'claude' }], 'run-1', true);
  assert.equal(row!.status, 'idle');
  assert.equal(row!.runningForMs, null);
  assert.equal(row!.awaitingReply, 0, 'a finished run has nothing awaiting a reply');
});

test('a connection problem survives, because it is not about this run', () => {
  const offline: LiveAgent = { ...CLAUDE, status: 'offline' };
  const [row] = participantsOf([offline], [{ agentId: 'claude' }], 'run-1', true);
  assert.equal(row!.status, 'offline', 'sign in: still true after the run ended');
});
