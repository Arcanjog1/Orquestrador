/**
 * The path that failed the first real run, case by case.
 *
 * A person asked for one file containing `pronto`. The worker exited 0, the
 * application saw no changed files and no report, the orchestrator escalated
 * to the top tier, and the run stopped with nobody able to say why. Each check
 * here pins one link of that chain so it cannot come back:
 *
 *  - evidence that could not look must say so, not answer "nothing changed";
 *  - a worker refused a tool must arrive as a refused tool;
 *  - a refused tool must not escalate the model;
 *  - a task that merely *mentions* permissions is not a security task.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitEvidenceCollector } from '../src/git/git-evidence-collector.js';
import { snapshotWorkspace, diffSnapshots } from '../src/git/workspace-snapshot.js';
import { assessTask, isMechanicalFailure, workLines } from '../src/routing/task-assessment.js';
import { routeWorkerModel } from '../src/routing/model-router.js';
import type { PreviousAttempt } from '../src/routing/model-router.js';
import type { WorkerRuntimeCapabilities } from '../src/routing/provider-policy.js';
import { describeWorkspaceProblem } from '../apps/desktop/src/main/services/orchestration-service.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type { ProcessRunner } from '../src/execution/process-runner.js';
import type { ProcessResult, RunProcessOptions } from '../src/process/process-manager.js';

const CLAUDE: WorkerRuntimeCapabilities = {
  modelFlag: true,
  effortFlag: true,
  declaredModels: ['fable', 'opus', 'sonnet', 'haiku'],
  declaredEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  version: '2.1.263',
};

/** A process runner that answers as a machine with no usable git would. */
function gitMissing(): ProcessRunner {
  return {
    async run(options: RunProcessOptions): Promise<ProcessResult> {
      return {
        outcome: 'spawn-error',
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: `spawn ${options.command} ENOENT`,
        durationMs: 1,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        truncated: false,
        error: 'ENOENT',
      } as ProcessResult;
    },
    async cancelAll() {},
  };
}

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/* ---------------------------------------------------------- evidence */

test('a folder that is not a repository still shows the file the worker created', async () => {
  const dir = scratch('lao-evidence-plain-');
  try {
    writeFileSync(join(dir, 'README.md'), '# scratch\n');
    // No `git init` here: a plain folder, which a person is entitled to pick.
    const collector = new GitEvidenceCollector(dir);
    const baseline = await collector.captureBaseline();
    assert.equal(baseline.isGitRepository, false);
    assert.equal(baseline.source, 'filesystem');
    assert.equal(baseline.evidenceProblem, null, 'git answered; there is simply no repository');

    // The worker does the work.
    writeFileSync(join(dir, 'hello.txt'), 'pronto');

    const evidence = await collector.collectEvidence(baseline);
    assert.equal(evidence.source, 'filesystem');
    assert.equal(
      evidence.changedSinceBaseline,
      true,
      'the file exists; "nothing changed" would be a false report',
    );
    assert.deepEqual(evidence.addedFiles, ['hello.txt']);
    assert.ok(evidence.changedFiles.includes('hello.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a git that cannot run is reported as such, never as "nothing changed"', async () => {
  const dir = scratch('lao-evidence-nogit-');
  try {
    const collector = new GitEvidenceCollector(dir, gitMissing(), 'git-that-does-not-exist');
    const baseline = await collector.captureBaseline();
    assert.equal(baseline.isGitRepository, false);
    assert.match(
      baseline.evidenceProblem ?? '',
      /git não pôde ser executado/i,
      'the person must be told git is the problem, not their work',
    );

    writeFileSync(join(dir, 'hello.txt'), 'pronto');
    const evidence = await collector.collectEvidence(baseline);
    assert.match(evidence.evidenceProblem ?? '', /git não pôde ser executado/i);
    // And the fallback still sees the file, so the run is not blinded.
    assert.equal(evidence.changedSinceBaseline, true);
    assert.deepEqual(evidence.addedFiles, ['hello.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inside a repository, an untracked file and an ignored file are both seen', async () => {
  const repo = createGitFixture('lao-evidence-repo-');
  try {
    repo.write('.gitignore', 'segredo.txt\n');
    repo.commitAll('baseline');
    const collector = new GitEvidenceCollector(repo.dir);
    const baseline = await collector.captureBaseline();
    assert.equal(baseline.isGitRepository, true);
    assert.equal(baseline.source, 'git');

    repo.write('hello.txt', 'pronto');
    // `git status` says nothing about this one, by design.
    repo.write('segredo.txt', 'valor');

    const evidence = await collector.collectEvidence(baseline);
    assert.equal(evidence.changedSinceBaseline, true);
    assert.ok(evidence.changedFiles.includes('hello.txt'), 'untracked file is seen by git');
    assert.ok(
      evidence.changedFiles.includes('segredo.txt'),
      'an ignored file is invisible to git status and must still be observed',
    );
  } finally {
    repo.cleanup();
  }
});

test('a clean working tree after a run that changed nothing still reports no change', async () => {
  const repo = createGitFixture('lao-evidence-clean-');
  try {
    repo.write('README.md', '# scratch\n');
    repo.commitAll('baseline');
    const collector = new GitEvidenceCollector(repo.dir);
    const baseline = await collector.captureBaseline();
    const evidence = await collector.collectEvidence(baseline);
    assert.equal(evidence.changedSinceBaseline, false, 'nothing happened, and that is the truth');
    assert.equal(evidence.evidenceProblem, null);
  } finally {
    repo.cleanup();
  }
});

test('the workspace walk is bounded, and says when it stopped', () => {
  const dir = scratch('lao-snapshot-bound-');
  try {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
    writeFileSync(join(dir, 'a.txt'), 'a');
    writeFileSync(join(dir, 'b.txt'), 'b');

    const full = snapshotWorkspace(dir);
    assert.deepEqual(Object.keys(full.entries).sort(), ['a.txt', 'b.txt']);
    assert.ok(full.skipped.includes('node_modules'), 'heavy directories are skipped by name');
    assert.equal(full.truncated, false);

    const capped = snapshotWorkspace(dir, { maxFiles: 1 });
    assert.equal(capped.truncated, true, 'a walk that stopped must admit it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file whose content changes is noticed even though its path did not', () => {
  const dir = scratch('lao-snapshot-content-');
  try {
    writeFileSync(join(dir, 'hello.txt'), 'errado');
    const before = snapshotWorkspace(dir);
    writeFileSync(join(dir, 'hello.txt'), 'pronto');
    const after = snapshotWorkspace(dir);
    const diff = diffSnapshots(before, after);
    assert.deepEqual(diff.modified, ['hello.txt']);
    assert.equal(diff.changed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------- workspace */

test('an empty, missing or non-directory workspace is refused with a reason, not "no progress"', () => {
  assert.match(describeWorkspaceProblem('') ?? '', /não tem uma pasta definida/);
  assert.match(
    describeWorkspaceProblem(join(tmpdir(), 'lao-does-not-exist-xyz')) ?? '',
    /não foi encontrada/,
  );

  const dir = scratch('lao-workspace-file-');
  try {
    const file = join(dir, 'a-file.txt');
    writeFileSync(file, 'x');
    assert.match(describeWorkspaceProblem(file) ?? '', /não é uma pasta/);
    // A usable folder passes and leaves nothing behind.
    assert.equal(describeWorkspaceProblem(dir), null);
    assert.deepEqual(
      snapshotWorkspace(dir).entries,
      { 'a-file.txt': snapshotWorkspace(dir).entries['a-file.txt']! },
      'the write probe is removed',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a folder this process cannot write to is refused before any agent is paid for', {
  // Root ignores the permission bits, so the probe would succeed and prove
  // nothing; on Windows the bits do not answer this question at all.
  skip:
    process.platform === 'win32'
      ? 'POSIX permission bits'
      : typeof process.getuid === 'function' && process.getuid() === 0
        ? 'running as root, which can write regardless of the mode'
        : false,
}, () => {
  const dir = scratch('lao-workspace-ro-');
  try {
    chmodSync(dir, 0o500);
    const problem = describeWorkspaceProblem(dir);
    assert.match(problem ?? '', /não consegue escrever/);
    assert.match(problem ?? '', /permissões da pasta/);
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------- routing */

test('a refused tool is mechanical, so no stronger model is spent on it', () => {
  // Exactly the shape the adapter now produces for an exit-0 run whose
  // envelope reported a refusal.
  assert.equal(
    isMechanicalFailure({
      outcome: 'completed',
      exitCode: 1,
      stdout: 'Não consegui criar o arquivo.',
      stderr: 'Ferramentas recusadas nesta execução: Write.',
      failure: 'tool-permission-denied',
    }),
    true,
  );
  // And a plain clean run is still not a failure at all.
  assert.equal(
    isMechanicalFailure({ outcome: 'completed', exitCode: 0, stdout: 'feito', stderr: '' }),
    false,
  );
});

test('creating one file stays a cheap task even when the delegation talks about permissions', () => {
  // The real second delegation: it mentions permissions and diagnosis because
  // the first attempt failed, not because this is security work.
  const task = [
    'Crie hello.txt na raiz do projeto com exatamente o texto pronto.',
    'A tentativa anterior falhou por permissão negada ao escrever; diagnostique a causa.',
    'Não contorne permissões e não exponha credenciais.',
  ].join('\n');

  const assessment = assessTask(task);
  assert.equal(
    assessment.minimumCapability,
    'FAST',
    `a one-file task must not be floored upward; signals were: ${assessment.signals.join(', ')}`,
  );
  assert.equal(assessment.minimumReasoning, 'LOW');
  assert.deepEqual(assessment.signals, []);

  // The prohibition line is not read as the work at all.
  assert.ok(!workLines(task).includes('Não contorne'));

  // But real security work is still floored up.
  const real = assessTask('Implemente autenticação por token no endpoint de login.');
  assert.equal(real.minimumCapability, 'STRONG');
  assert.ok(real.signals.length > 0);
});

test('a run whose worker was refused a tool does not climb the model tiers', () => {
  const attempts: PreviousAttempt[] = [
    {
      iteration: 1,
      capability: 'FAST',
      reasoning: 'LOW',
      model: 'haiku',
      outcome: 'completed',
      exitCode: 1,
      progressed: false,
      // Classified by the adapter from the envelope: not a model problem.
      mechanical: true,
      modelUnavailable: false,
    },
    {
      iteration: 2,
      capability: 'FAST',
      reasoning: 'LOW',
      model: 'haiku',
      outcome: 'completed',
      exitCode: 1,
      progressed: false,
      mechanical: true,
      modelUnavailable: false,
    },
  ];

  const routed = routeWorkerModel({
    provider: 'anthropic',
    accountId: 'acc-1',
    task: 'Crie hello.txt com exatamente o texto pronto.',
    requested: { capability: 'FAST', reasoning: 'LOW' },
    previousAttempts: attempts,
    capabilities: CLAUDE,
    selection: 'auto',
    manual: { model: null, reasoning: null },
    unavailableModels: [],
  });

  // `capability` is what was actually used; `requestedCapability` is only what
  // the orchestrator asked for, so it is the wrong field to prove this with.
  assert.equal(
    routed.capability,
    'FAST',
    `two mechanical failures are not two failures of reasoning (${routed.selectionReason})`,
  );
  assert.equal(routed.reasoning, 'LOW');
  assert.notEqual(routed.resolvedModel, 'opus');
  assert.notEqual(routed.resolvedModel, 'fable');
});

test('genuine no-progress still escalates, so the fix does not blunt the router', () => {
  const attempts: PreviousAttempt[] = [1, 2].map((iteration) => ({
    iteration,
    capability: 'BALANCED' as const,
    reasoning: 'MEDIUM' as const,
    model: 'sonnet',
    outcome: 'completed' as const,
    exitCode: 0,
    progressed: false,
    mechanical: false,
    modelUnavailable: false,
  }));

  const routed = routeWorkerModel({
    provider: 'anthropic',
    accountId: 'acc-1',
    task: 'Corrija o bug intermitente no agendador.',
    requested: { capability: 'BALANCED', reasoning: 'MEDIUM' },
    previousAttempts: attempts,
    capabilities: CLAUDE,
    selection: 'auto',
    manual: { model: null, reasoning: null },
    unavailableModels: [],
  });

  assert.notEqual(
    routed.capability,
    'BALANCED',
    `real no-progress still escalates (${routed.selectionReason})`,
  );
});
