import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidTransitionError } from '../src/core/run-state.js';
import { SessionManager } from '../src/sessions/session-manager.js';
import { createInitialState, StateManager, STATE_VERSION } from '../src/sessions/state-manager.js';
import { buildFinalReport, formatDuration } from '../src/sessions/final-report.js';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'lao-session-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function newState(runId: string) {
  return createInitialState({
    runId,
    objective: 'Fix the wall detection',
    objectiveSource: 'objective.md',
    projectPath: 'C:\\Projetos\\MeuProjeto',
    maxIterations: 20,
    mode: 'mock',
    worker: { id: 'worker-01', agent: 'mock-claude', profile: 'personal' },
    claudeProfile: 'personal',
    allowNoChanges: false,
  });
}

test('allocates dated, sequential run ids and the documented directory layout', () => {
  withTempDir((dir) => {
    const sessions = new SessionManager(join(dir, '.sessions'));
    const first = sessions.createRun(new Date('2026-09-01T10:00:00Z'));
    const second = sessions.createRun(new Date('2026-09-01T11:00:00Z'));

    assert.equal(first.runId, '2026-09-01-001');
    assert.equal(second.runId, '2026-09-01-002');
    assert.ok(existsSync(join(first.dir, 'iterations')));
    assert.ok(existsSync(join(first.dir, 'logs')));

    const nextDay = sessions.createRun(new Date('2026-09-02T09:00:00Z'));
    assert.equal(nextDay.runId, '2026-09-02-001');

    assert.deepEqual(sessions.listRunIds(), ['2026-09-01-001', '2026-09-01-002', '2026-09-02-001']);
    assert.equal(sessions.latestRunId(), '2026-09-02-001');
  });
});

test('writes iteration artifacts under a zero-padded directory', () => {
  withTempDir((dir) => {
    const sessions = new SessionManager(join(dir, '.sessions'));
    const { runId } = sessions.createRun(new Date('2026-09-01T10:00:00Z'));

    sessions.writeIterationText(runId, 1, 'claude-input.md', 'task text');
    sessions.writeIterationJson(runId, 1, 'tests.json', [{ command: 'npm test', exitCode: 0 }]);

    const base = join(sessions.runDir(runId), 'iterations', '001');
    assert.equal(readFileSync(join(base, 'claude-input.md'), 'utf8'), 'task text');
    assert.match(readFileSync(join(base, 'tests.json'), 'utf8'), /npm test/);
  });
});

test('redacts secrets before any artifact reaches disk', () => {
  withTempDir((dir) => {
    const sessions = new SessionManager(join(dir, '.sessions'));
    const { runId } = sessions.createRun();
    sessions.writeIterationText(runId, 1, 'claude-output.txt', 'used sk-ant-api03-LEAKEDSECRET99 ok');
    const written = readFileSync(
      join(sessions.runDir(runId), 'iterations', '001', 'claude-output.txt'),
      'utf8',
    );
    assert.ok(!written.includes('LEAKEDSECRET99'), written);
    assert.match(written, /\[REDACTED\]/);
  });
});

test('persists state on every transition and reloads it verbatim', () => {
  withTempDir((dir) => {
    const sessions = new SessionManager(join(dir, '.sessions'));
    const { runId, dir: runDir } = sessions.createRun();
    const manager = StateManager.create(runDir, newState(runId));

    assert.ok(existsSync(join(runDir, 'state.json')));
    manager.transition('BASELINING');
    manager.transition('ORCHESTRATING', (s) => {
      s.iteration = 1;
    });

    // A separate process reading the file mid-run sees the latest state.
    const reloaded = StateManager.load(runDir);
    assert.equal(reloaded.status, 'ORCHESTRATING');
    assert.equal(reloaded.current.iteration, 1);
    assert.equal(reloaded.current.version, STATE_VERSION);
    assert.equal(reloaded.current.objective, 'Fix the wall detection');
  });
});

test('refuses an invalid transition instead of corrupting state', () => {
  withTempDir((dir) => {
    const sessions = new SessionManager(join(dir, '.sessions'));
    const { runId, dir: runDir } = sessions.createRun();
    const manager = StateManager.create(runDir, newState(runId));
    assert.throws(() => manager.transition('DONE'), InvalidTransitionError);
    assert.equal(StateManager.load(runDir).status, 'CREATED');
  });
});

test('reports a corrupt or unknown-version state file clearly', () => {
  withTempDir((dir) => {
    const sessions = new SessionManager(join(dir, '.sessions'));
    const { runId, dir: runDir } = sessions.createRun();
    StateManager.create(runDir, newState(runId));

    writeFileSync(join(runDir, 'state.json'), '{ broken');
    assert.throws(() => StateManager.load(runDir), /Corrupt state\.json/);

    writeFileSync(join(runDir, 'state.json'), JSON.stringify({ ...newState(runId), version: 99 }));
    assert.throws(() => StateManager.load(runDir), /state version 99/);

    rmSync(join(runDir, 'state.json'));
    assert.throws(() => StateManager.load(runDir), /No state\.json/);
  });
});

test('the final report covers every section the spec asks for', () => {
  const state = newState('2026-09-01-001');
  state.status = 'DONE';
  state.iteration = 2;
  state.finishedAt = new Date(new Date(state.createdAt).getTime() + 1_063_000).toISOString();
  state.baseline = {
    capturedAt: state.createdAt,
    isGitRepository: true,
    commit: 'abc123def456',
    branch: 'main',
    statusShort: '',
    unstagedDiff: '',
    stagedDiff: '',
    modifiedFiles: [],
    stagedFiles: [],
    dirty: false,
  };
  state.criteria = [
    { id: 'c1', text: 'npm test passes', status: 'satisfied', lastUpdatedIteration: 2 },
    { id: 'c2', text: 'nothing else broke', status: 'unknown', lastUpdatedIteration: 1 },
  ];
  state.iterations = [
    {
      iteration: 1,
      startedAt: state.createdAt,
      decisionRepairAttempts: 0,
      notes: [],
      decision: { action: 'delegate', task: 'fix it', acceptanceCriteria: [], verificationCommands: [], fileChecks: [], fileReads: [] },
      worker: {
        agent: 'mock-claude',
        profile: 'personal',
        task: 'fix it',
        startedAt: state.createdAt,
        finishedAt: state.createdAt,
        exitCode: 0,
        outcome: 'completed',
        durationMs: 1000,
      },
      verification: [
        { command: 'npm test', exitCode: 1, stdout: '', stderr: '', durationMs: 1200, timedOut: false },
      ],
    },
  ];

  const report = buildFinalReport({
    state,
    finalEvidence: {
      collectedAt: state.finishedAt,
      isGitRepository: true,
      commit: 'abc123def456',
      branch: 'main',
      statusShort: ' M src/walls.ts\n',
      diff: '',
      diffStat: ' src/walls.ts | 4 ++--\n',
      changedFiles: ['src/walls.ts'],
      addedFiles: [],
      deletedFiles: [],
      changedSinceBaseline: true,
    },
    warnings: ['A verification command was refused.'],
  });

  for (const heading of [
    '## Objective',
    '## Status',
    '## Iterations',
    '## Claude profiles used',
    '## Files changed',
    '## Tests executed',
    '## Acceptance criteria',
    '## Evidence',
    '## Remaining warnings',
    '## Baseline commit',
    '## Final git status',
  ]) {
    assert.ok(report.includes(heading), `missing section: ${heading}`);
  }
  assert.match(report, /Fix the wall detection/);
  assert.match(report, /abc123def456/);
  assert.match(report, /src\/walls\.ts/);
  assert.match(report, /- \[x\] npm test passes/);
  assert.match(report, /- \[ \] nothing else broke \*\(no evidence\)\*/);
  assert.match(report, /00:17:43/);
  assert.match(report, /Nothing was committed, pushed or merged/);
});

test('the final report survives a run with no iterations', () => {
  const state = newState('2026-09-01-002');
  state.status = 'CANCELLED';
  state.terminationReason = 'Cancelled by the user.';
  const report = buildFinalReport({ state, finalEvidence: null, warnings: [] });
  assert.match(report, /CANCELLED/);
  assert.match(report, /No iteration was recorded/);
  assert.match(report, /Cancelled by the user/);
});

test('formatDuration renders hh:mm:ss', () => {
  assert.equal(formatDuration('2026-09-01T00:00:00Z', '2026-09-01T00:17:43Z'), '00:17:43');
  assert.equal(formatDuration('2026-09-01T00:00:00Z', '2026-09-01T02:00:00Z'), '02:00:00');
  // A clock skew must not produce a negative duration.
  assert.equal(formatDuration('2026-09-01T01:00:00Z', '2026-09-01T00:00:00Z'), '00:00:00');
});
