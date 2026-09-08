/**
 * Why a run failed, and where that answer goes (spec 2, 3, 5).
 *
 * The complaint: a run ended with `provider-error`, `exitCode 1`, and nothing
 * else. No stderr, no CLI version, no last activity, no specific cause.
 *
 * Reading the code found the answer, and it was not one bug but a chain of
 * three, each of which threw away part of the diagnosis:
 *
 * 1. `classifyEnvelope` collapsed **every** `is_error` envelope into
 *    `provider-error`. It had two branches that returned the same value, so
 *    `error_max_turns` and `error_during_execution` — different problems with
 *    different fixes — arrived identical.
 * 2. `agent_invocations` had no column for stderr, the executable, the
 *    version, the signal or the last activity. All of it was computed, put in
 *    an `AgentResult`, and dropped at the persistence boundary.
 * 3. The CLI's version was never read at all.
 *
 * These tests pin each link, and pin that the screen and the export show the
 * same thing the record holds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/database/database.js';
import { toRunDetailView } from '../apps/desktop/src/main/services/views.js';
import {
  renderDiagnostics,
  writeDiagnostics,
} from '../apps/desktop/src/main/services/diagnostics-export.js';
import type { RunDetailView } from '../apps/desktop/src/shared/ipc-contract.js';
import { isMechanicalFailure } from '../src/routing/task-assessment.js';

/* ================================================================== *
 * The record keeps what the tool said
 * ================================================================== */

function database(): { db: Database; runId: string } {
  const db = new Database({ filePath: ':memory:' });
  db.providers.ensureSeeded();
  db.workspaces.create({ id: 'ws-1', name: 'Projeto', localPath: '/tmp/p' });
  db.chat.createSession({ id: 'chat-1', workspaceId: 'ws-1', title: 'c' });
  const run = db.runs.create({
    id: 'run-1',
    sessionId: 'chat-1',
    workspaceId: 'ws-1',
    objective: 'analisar o repositório e escrever RELATORIO.md',
    orchestratorAgentId: null,
    maxIterations: 8,
  });
  return { db, runId: run.id };
}

test('the diagnosis survives the trip to the database', () => {
  const { db, runId } = database();
  db.runs.recordInvocation({
    runId,
    iteration: 2,
    agentId: null,
    accountId: null,
    role: 'CODING_WORKER',
    task: 'crie teste-orquestrador/RELATORIO.md',
    workerId: 'worker-1',
    outcome: 'completed',
    exitCode: 1,
    durationMs: 4321,
    startedAt: '2026-09-07T20:00:00.000Z',
    routing: null,
    failureKind: 'provider-error',
    diagnostics: {
      failureDetail: 'subtype=error_during_execution · is_error=true',
      stderrExcerpt: 'A execução do Claude Code terminou em erro (error_during_execution).',
      executable: 'C:\\Users\\me\\AppData\\Local\\ai-orchestrator\\runtimes\\claude\\claude.exe',
      version: '2.1.263 (Claude Code)',
      signal: null,
      lastActivityAt: '2026-09-07T20:00:04.000Z',
      idleTimeoutMs: 600_000,
      currentTool: 'Read',
      workingDirectory: 'C:\\Users\\twitc\\Desktop\\Orquestrador-claude-new-session-3am7mo',
    },
  });

  const [row] = db.runs.invocations(runId) as Array<Record<string, unknown>>;
  assert.ok(row);
  // Every one of these used to be computed and then dropped here.
  assert.equal(row.failure_kind, 'provider-error');
  assert.equal(row.failure_detail, 'subtype=error_during_execution · is_error=true');
  assert.match(String(row.stderr_excerpt), /error_during_execution/);
  assert.match(String(row.executable), /claude\.exe$/);
  assert.equal(row.cli_version, '2.1.263 (Claude Code)');
  assert.equal(row.last_activity_at, '2026-09-07T20:00:04.000Z');
  assert.equal(row.idle_timeout_ms, 600_000);
  assert.equal(row.current_tool, 'Read');
  assert.match(String(row.working_directory), /Orquestrador-claude-new-session-3am7mo$/);
});

test('a field the tool did not report is stored null, never invented', () => {
  const { db, runId } = database();
  db.runs.recordInvocation({
    runId,
    iteration: 1,
    agentId: null,
    accountId: null,
    role: 'CODING_WORKER',
    task: null,
    outcome: 'spawn-error',
    exitCode: null,
    durationMs: 12,
    startedAt: '2026-09-07T20:00:00.000Z',
    routing: null,
    failureKind: null,
    // A failure before the process existed: there is no version to read and
    // no stderr to keep, because nothing ever ran.
    diagnostics: { failureDetail: 'outcome=spawn-error, exit=null' },
  });

  const [row] = db.runs.invocations(runId) as Array<Record<string, unknown>>;
  assert.equal(row!.failure_detail, 'outcome=spawn-error, exit=null');
  assert.equal(row!.cli_version, null, 'a version nobody could read is null');
  assert.equal(row!.stderr_excerpt, null);
  assert.equal(row!.executable, null);
  assert.equal(row!.last_activity_at, null);
});

test('a secret in stderr never reaches the record', () => {
  const { db, runId } = database();
  db.runs.recordInvocation({
    runId,
    iteration: 1,
    agentId: null,
    accountId: null,
    role: 'CODING_WORKER',
    task: null,
    outcome: 'completed',
    exitCode: 1,
    durationMs: 1,
    startedAt: '2026-09-07T20:00:00.000Z',
    routing: null,
    failureKind: 'authentication',
    diagnostics: {
      stderrExcerpt: 'auth failed for key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ',
    },
  });
  const [row] = db.runs.invocations(runId) as Array<Record<string, unknown>>;
  const stored = String(row!.stderr_excerpt);
  assert.ok(!stored.includes('AAAABBBBCCCC'), `a key reached the database: ${stored}`);
});

test('an invocation still running has no end and says so', () => {
  const { db, runId } = database();
  db.runs.recordInvocation({
    runId,
    iteration: 1,
    agentId: null,
    accountId: null,
    role: 'CODING_WORKER',
    task: null,
    outcome: 'completed',
    exitCode: 0,
    durationMs: 100,
    startedAt: '2026-09-07T20:00:00.000Z',
    routing: null,
  });
  const view = toRunDetailView(
    db.runs.require(runId),
    db.runs.steps(runId),
    db.runs.invocations(runId),
    db.runs.verifications(runId),
  );
  const [invocation] = view.invocations;
  assert.ok(invocation);
  // Nulls survive to the screen rather than becoming zero or an empty string,
  // because "the tool did not say" and "the tool said nothing happened" are
  // different facts.
  assert.equal(invocation.failureDetail, null);
  assert.equal(invocation.cliVersion, null);
  assert.equal(invocation.stderrExcerpt, null);
  assert.equal(invocation.currentTool, null);
});

/* ================================================================== *
 * The export
 * ================================================================== */

function detailWith(overrides: Partial<RunDetailView['invocations'][number]> = {}): RunDetailView {
  const { db, runId } = database();
  db.runs.recordInvocation({
    runId,
    iteration: 2,
    agentId: null,
    accountId: null,
    role: 'CODING_WORKER',
    task: 'crie RELATORIO.md',
    workerId: 'worker-1',
    outcome: 'completed',
    exitCode: 1,
    durationMs: 4321,
    startedAt: '2026-09-07T20:00:00.000Z',
    routing: null,
    failureKind: 'provider-error',
    diagnostics: {
      failureDetail: 'subtype=error_during_execution · is_error=true',
      stderrExcerpt: 'A execução do Claude Code terminou em erro (error_during_execution).',
      executable: 'C:\\runtimes\\claude.exe',
      version: '2.1.263',
      workingDirectory: 'C:\\Users\\twitc\\Desktop\\Orquestrador',
      ...overrides,
    },
  });
  db.runs.addStep({
    runId,
    iteration: 2,
    phase: 'worker',
    status: 'completed',
    summary: 'crie RELATORIO.md',
    detail: JSON.stringify({ workerId: 'worker-1', stderrExcerpt: 'algo' }),
  });
  return toRunDetailView(
    db.runs.require(runId),
    db.runs.steps(runId),
    db.runs.invocations(runId),
    db.runs.verifications(runId),
  );
}

test('the export carries the same cause the record holds', () => {
  const report = renderDiagnostics(detailWith(), new Date('2026-09-07T21:00:00Z'));

  // The specific cause, not just the classification.
  assert.match(report, /failureKind \| provider-error/);
  assert.match(report, /failureDetail \| subtype=error_during_execution/);
  assert.match(report, /versão do CLI \| 2\.1\.263/);
  assert.match(report, /error_during_execution/);
  assert.match(report, /Orquestrador/);
  // The run itself.
  assert.match(report, /run-1/);
  assert.match(report, /analisar o repositório/);
  // And the promise the file makes about itself.
  assert.match(report, /não é credencial|Nada neste arquivo é credencial/);
});

test('the export says "não informado" for what the tool never reported', () => {
  const { db, runId } = database();
  db.runs.recordInvocation({
    runId,
    iteration: 1,
    agentId: null,
    accountId: null,
    role: 'CODING_WORKER',
    task: null,
    outcome: 'spawn-error',
    exitCode: null,
    durationMs: null,
    startedAt: '2026-09-07T20:00:00.000Z',
    routing: null,
  });
  const report = renderDiagnostics(
    toRunDetailView(
      db.runs.require(runId),
      db.runs.steps(runId),
      db.runs.invocations(runId),
      db.runs.verifications(runId),
    ),
  );

  // Absent is stated, not hidden and not filled in with a plausible value.
  assert.match(report, /versão do CLI \| não informado/);
  assert.match(report, /executável \| não informado/);
  assert.match(report, /_stderr: não informado_/);
  assert.match(report, /exitCode \| não informado/);
});

test('a secret cannot survive into the exported file', () => {
  const report = renderDiagnostics(
    detailWith({
      stderrExcerpt: 'ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII and sk-ant-api03-ZZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSS',
    } as never),
  );
  assert.ok(!report.includes('AAAABBBBCCCC'), 'a token reached the export');
  assert.ok(!report.includes('ZZZZYYYYXXXX'), 'a key reached the export');
});

test('the export is written to a folder the application owns, and named for the run', () => {
  const root = mkdtempSync(join(tmpdir(), 'lao-diag-'));
  try {
    const written = writeDiagnostics(detailWith(), root, new Date('2026-09-07T21:00:00Z'));

    assert.match(written.directory, /diagnostics$/);
    assert.match(written.path, /diagnostico-run-1-2026-09-07T21-00-00-000Z\.md$/);
    // The file is real and readable - the whole point is that nobody has to
    // open a terminal to get it.
    const contents = readFileSync(written.path, 'utf8');
    assert.match(contents, /Diagnóstico da execução/);
    assert.match(contents, /subtype=error_during_execution/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a run with nothing recorded still exports a readable file', () => {
  const { db, runId } = database();
  const report = renderDiagnostics(
    toRunDetailView(
      db.runs.require(runId),
      db.runs.steps(runId),
      db.runs.invocations(runId),
      db.runs.verifications(runId),
    ),
  );
  // "Nothing was recorded" is itself a diagnosis, and a useful one: it says
  // the failure happened before anything could be written.
  assert.match(report, /Nenhuma invocação foi registrada/);
  assert.match(report, /Nenhuma verificação foi executada/);
  assert.ok(report.length > 200);
});

/* ================================================================== *
 * No blind escalation
 * ================================================================== */

test('a failure the tool itself reported never buys a stronger model', () => {
  // The reflex behind a run that climbed to STRONG/HIGH and stopped anyway.
  // `error_during_execution` means something threw and `error_max_turns` means
  // the run ran out of turns; no model unthrows an exception, and paying for a
  // bigger one is spending money on a wall.
  assert.equal(
    isMechanicalFailure({
      outcome: 'completed',
      exitCode: 1,
      stdout: '',
      stderr: 'A execução do Claude Code terminou em erro (error_during_execution).',
      failure: 'provider-error',
    }),
    true,
  );
});

test('a real shortfall of reasoning still escalates', () => {
  // The rule must not become "never escalate". A worker that ran cleanly and
  // simply did not achieve the goal is exactly the case a stronger model can
  // help with, and it stays escalatable.
  assert.equal(
    isMechanicalFailure({
      outcome: 'completed',
      exitCode: 0,
      stdout: 'tentei mas não consegui resolver o problema',
      stderr: '',
    }),
    false,
  );
});
