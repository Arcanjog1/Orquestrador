import test from 'node:test';
import assert from 'node:assert/strict';
import type { Baseline, GitEvidence, IterationRecord } from '../src/core/types.js';
import { AcceptanceCriteriaLedger, criterionId } from '../src/orchestrator/acceptance-criteria.js';
import { evaluateDone, formatDoneRejection } from '../src/orchestrator/done-gate.js';
import { Verifier } from '../src/orchestrator/verifier.js';
import { ProcessManager } from '../src/process/process-manager.js';

const baseline: Baseline = {
  capturedAt: '2026-09-01T00:00:00.000Z',
  isGitRepository: true,
  commit: 'abc123',
  branch: 'main',
  statusShort: '',
  unstagedDiff: '',
  stagedDiff: '',
  modifiedFiles: [],
  stagedFiles: [],
  dirty: false,
};

function evidence(changed: boolean): GitEvidence {
  return {
    collectedAt: '2026-09-01T00:10:00.000Z',
    isGitRepository: true,
    commit: 'abc123',
    branch: 'main',
    statusShort: changed ? ' M src/a.ts\n' : '',
    diff: changed ? 'diff --git a/src/a.ts b/src/a.ts\n' : '',
    diffStat: changed ? ' src/a.ts | 2 +-\n' : '',
    changedFiles: changed ? ['src/a.ts'] : [],
    addedFiles: [],
    deletedFiles: [],
    changedSinceBaseline: changed,
  };
}

function okWorker(iteration: number): IterationRecord {
  return {
    iteration,
    startedAt: '2026-09-01T00:00:00.000Z',
    decisionRepairAttempts: 0,
    notes: [],
    worker: {
      agent: 'mock-claude',
      profile: 'personal',
      task: 'do the thing',
      startedAt: '2026-09-01T00:00:00.000Z',
      finishedAt: '2026-09-01T00:01:00.000Z',
      exitCode: 0,
      outcome: 'completed',
      durationMs: 60_000,
    },
  };
}

function makeVerifier(): Verifier {
  return new Verifier({
    cwd: process.cwd(),
    timeoutMs: 30_000,
    processManager: new ProcessManager(),
  });
}

const PASSING = `${process.execPath} -e process.exit(0)`;
const FAILING = `${process.execPath} -e process.exit(1)`;

test('accepts DONE only when every check has objective backing', async () => {
  const ledger = new AcceptanceCriteriaLedger();
  ledger.add(['tests pass'], 1);
  ledger.markByText('tests pass', 'satisfied', 1, 'verified independently');

  const result = await evaluateDone({
    ledger,
    verificationCommands: [PASSING],
    iterations: [okWorker(1)],
    baseline,
    evidence: evidence(true),
    verifier: makeVerifier(),
    allowNoChanges: false,
  });

  assert.equal(result.passed, true, result.failures.join('; '));
  assert.equal(result.failures.length, 0);
  assert.equal(result.verification.length, 1);
});

test('rejects DONE when a verification command fails, naming the command', async () => {
  const result = await evaluateDone({
    ledger: new AcceptanceCriteriaLedger(),
    verificationCommands: [FAILING],
    iterations: [okWorker(1)],
    baseline,
    evidence: evidence(true),
    verifier: makeVerifier(),
    allowNoChanges: false,
  });
  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /exit code 1/);
});

test('rejects DONE while a criterion still lacks evidence', async () => {
  const ledger = new AcceptanceCriteriaLedger();
  ledger.add(['the wall detection is fixed'], 1);

  const result = await evaluateDone({
    ledger,
    verificationCommands: [],
    iterations: [okWorker(1)],
    baseline,
    evidence: evidence(true),
    verifier: makeVerifier(),
    allowNoChanges: false,
  });
  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /no supporting evidence.*wall detection/s);
});

test('rejects DONE for a criterion explicitly recorded as failed', async () => {
  const ledger = new AcceptanceCriteriaLedger();
  ledger.add(['x works'], 1);
  ledger.markByText('x works', 'failed', 2, 'test still red');

  const result = await evaluateDone({
    ledger,
    verificationCommands: [],
    iterations: [okWorker(1)],
    baseline,
    evidence: evidence(true),
    verifier: makeVerifier(),
    allowNoChanges: false,
  });
  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /recorded as failed/);
});

test('rejects DONE when nothing changed, unless the run allows it', async () => {
  const args = {
    ledger: new AcceptanceCriteriaLedger(),
    verificationCommands: [],
    iterations: [okWorker(1)],
    baseline,
    evidence: evidence(false),
    verifier: makeVerifier(),
  };

  const rejected = await evaluateDone({ ...args, allowNoChanges: false });
  assert.equal(rejected.passed, false);
  assert.match(rejected.failures.join('\n'), /No file changed/);

  const accepted = await evaluateDone({ ...args, allowNoChanges: true });
  assert.equal(accepted.passed, true, accepted.failures.join('; '));
});

test('rejects DONE when the last worker run ended badly', async () => {
  const crashed: IterationRecord = {
    ...okWorker(2),
    worker: { ...okWorker(2).worker!, outcome: 'timeout', exitCode: null },
  };
  const result = await evaluateDone({
    ledger: new AcceptanceCriteriaLedger(),
    verificationCommands: [],
    iterations: [okWorker(1), crashed],
    baseline,
    evidence: evidence(true),
    verifier: makeVerifier(),
    allowNoChanges: false,
  });
  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /did not complete cleanly/);
});

test('an earlier worker failure that a later iteration fixed does not block', async () => {
  const crashed: IterationRecord = {
    ...okWorker(1),
    worker: { ...okWorker(1).worker!, outcome: 'timeout', exitCode: null },
  };
  const result = await evaluateDone({
    ledger: new AcceptanceCriteriaLedger(),
    verificationCommands: [],
    iterations: [crashed, okWorker(2)],
    baseline,
    evidence: evidence(true),
    verifier: makeVerifier(),
    allowNoChanges: false,
  });
  assert.equal(result.passed, true, result.failures.join('; '));
});

test('a refused verification command blocks DONE rather than counting as a pass', async () => {
  const result = await evaluateDone({
    ledger: new AcceptanceCriteriaLedger(),
    verificationCommands: ['git reset --hard'],
    iterations: [okWorker(1)],
    baseline,
    evidence: evidence(true),
    verifier: makeVerifier(),
    allowNoChanges: false,
  });
  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /refused and never ran/);
});

test('the rejection message tells the orchestrator exactly what failed', () => {
  const text = formatDoneRejection({
    passed: false,
    failures: ['Verification command failed with exit code 1: "npm test"', 'Criterion X has no evidence'],
    checkedAt: '2026-09-01T00:00:00.000Z',
    verification: [],
  });
  assert.match(text, /^DONE_REJECTED/);
  assert.match(text, /1\. Verification command failed/);
  assert.match(text, /2\. Criterion X/);
  assert.match(text, /Do not answer `done` again/);
});

test('the ledger deduplicates criteria and tracks their status', () => {
  const ledger = new AcceptanceCriteriaLedger();
  ledger.add(['Tests pass', 'tests   PASS'], 1);
  assert.equal(ledger.size, 1, 'whitespace and case should collapse');

  ledger.add(['Another thing'], 2);
  assert.equal(ledger.size, 2);
  assert.equal(ledger.pending().length, 2);

  ledger.markByText('tests pass', 'satisfied', 2, 'npm test exited 0');
  assert.equal(ledger.satisfied().length, 1);
  assert.equal(ledger.pending().length, 1);
  assert.equal(ledger.get(criterionId('Tests pass'))?.note, 'npm test exited 0');

  ledger.markAllUnknown('satisfied', 3, 'all verification passed');
  assert.equal(ledger.pending().length, 0);
});

test('the ledger survives a round trip through persisted state', () => {
  const original = new AcceptanceCriteriaLedger();
  original.add(['a', 'b'], 1);
  original.markByText('a', 'satisfied', 1);

  const restored = new AcceptanceCriteriaLedger(JSON.parse(JSON.stringify(original.all())));
  assert.equal(restored.size, 2);
  assert.equal(restored.satisfied().length, 1);
});
