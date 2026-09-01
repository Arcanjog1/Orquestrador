import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { GitEvidenceCollector, parseStatusShort } from '../src/git/git-evidence-collector.js';
import { UnsafeGitCommandError } from '../src/git/git-safety.js';
import { ProcessManager } from '../src/process/process-manager.js';
import { createGitFixture, createPlainDir } from './helpers/git-fixture.js';

test('captures a baseline from a clean repository', async () => {
  const repo = createGitFixture();
  try {
    repo.write('a.txt', 'one\n');
    repo.commitAll('initial');
    const collector = new GitEvidenceCollector(repo.dir, new ProcessManager(), 'git');

    const baseline = await collector.captureBaseline();
    assert.equal(baseline.isGitRepository, true);
    assert.equal(baseline.commit, repo.head());
    assert.equal(baseline.branch, 'main');
    assert.equal(baseline.dirty, false);
    assert.equal(baseline.statusShort.trim(), '');
    assert.deepEqual(baseline.modifiedFiles, []);
  } finally {
    repo.cleanup();
  }
});

test('records a dirty working tree without touching it (spec 9)', async () => {
  const repo = createGitFixture();
  try {
    repo.write('a.txt', 'one\n');
    repo.commitAll('initial');
    // The user's own uncommitted work, present before the run starts.
    repo.write('a.txt', 'one\nuser edit\n');
    repo.write('untracked.txt', 'mine\n');
    repo.write('staged.txt', 'staged\n');
    repo.git('add', 'staged.txt');

    const collector = new GitEvidenceCollector(repo.dir, new ProcessManager(), 'git');
    const baseline = await collector.captureBaseline();

    assert.equal(baseline.dirty, true);
    assert.ok(baseline.modifiedFiles.includes('a.txt'));
    assert.ok(baseline.stagedFiles.includes('staged.txt'));
    assert.match(baseline.unstagedDiff, /user edit/);
    assert.match(baseline.stagedDiff, /staged/);

    // Nothing was cleaned: the user's edits are still on disk afterwards.
    assert.match(repo.git('status', '--short'), /untracked\.txt/);
    assert.match(repo.git('diff'), /user edit/);
  } finally {
    repo.cleanup();
  }
});

test('collects evidence and detects changes since the baseline', async () => {
  const repo = createGitFixture();
  try {
    repo.write('a.txt', 'one\n');
    repo.commitAll('initial');
    const collector = new GitEvidenceCollector(repo.dir, new ProcessManager(), 'git');
    const baseline = await collector.captureBaseline();

    // Simulate what a worker would do.
    repo.write('a.txt', 'one\ntwo\n');
    repo.write('new.txt', 'created\n');
    rmSync(join(repo.dir, 'a.txt.missing'), { force: true });

    const evidence = await collector.collectEvidence(baseline);
    assert.equal(evidence.changedSinceBaseline, true);
    assert.ok(evidence.changedFiles.includes('a.txt'));
    assert.ok(evidence.changedFiles.includes('new.txt'));
    assert.ok(evidence.addedFiles.includes('new.txt'));
    assert.match(evidence.diff, /\+two/);
    assert.ok(evidence.diffStat.includes('a.txt'));
  } finally {
    repo.cleanup();
  }
});

test('reports no change when the worker did nothing', async () => {
  const repo = createGitFixture();
  try {
    repo.write('a.txt', 'one\n');
    repo.commitAll('initial');
    const collector = new GitEvidenceCollector(repo.dir, new ProcessManager(), 'git');
    const baseline = await collector.captureBaseline();
    const evidence = await collector.collectEvidence(baseline);
    assert.equal(evidence.changedSinceBaseline, false);
    assert.deepEqual(evidence.changedFiles, []);
  } finally {
    repo.cleanup();
  }
});

test('a tree that was already dirty is not mistaken for a change', async () => {
  const repo = createGitFixture();
  try {
    repo.write('a.txt', 'one\n');
    repo.commitAll('initial');
    repo.write('a.txt', 'one\nuser edit\n');

    const collector = new GitEvidenceCollector(repo.dir, new ProcessManager(), 'git');
    const baseline = await collector.captureBaseline();
    const evidence = await collector.collectEvidence(baseline);

    // The tree is dirty, but nothing moved since the baseline was taken.
    assert.equal(baseline.dirty, true);
    assert.equal(evidence.changedSinceBaseline, false);
  } finally {
    repo.cleanup();
  }
});

test('detects deletions', async () => {
  const repo = createGitFixture();
  try {
    repo.write('a.txt', 'one\n');
    repo.write('b.txt', 'two\n');
    repo.commitAll('initial');
    const collector = new GitEvidenceCollector(repo.dir, new ProcessManager(), 'git');
    const baseline = await collector.captureBaseline();

    rmSync(join(repo.dir, 'b.txt'));
    const evidence = await collector.collectEvidence(baseline);
    assert.ok(evidence.deletedFiles.includes('b.txt'));
  } finally {
    repo.cleanup();
  }
});

test('handles a repository with no commits yet', async () => {
  const repo = createGitFixture();
  try {
    const collector = new GitEvidenceCollector(repo.dir, new ProcessManager(), 'git');
    const baseline = await collector.captureBaseline();
    assert.equal(baseline.isGitRepository, true);
    assert.equal(baseline.commit, null);
    assert.equal(baseline.branch, 'main');
  } finally {
    repo.cleanup();
  }
});

test('handles a project that is not a git repository', async () => {
  const plain = createPlainDir();
  try {
    const collector = new GitEvidenceCollector(plain.dir, new ProcessManager(), 'git');
    const baseline = await collector.captureBaseline();
    assert.equal(baseline.isGitRepository, false);
    const evidence = await collector.collectEvidence(baseline);
    assert.equal(evidence.isGitRepository, false);
    assert.equal(evidence.changedSinceBaseline, false);
  } finally {
    plain.cleanup();
  }
});

test('the collector physically cannot run a mutating git command', async () => {
  const repo = createGitFixture();
  try {
    const collector = new GitEvidenceCollector(repo.dir, new ProcessManager(), 'git');
    await assert.rejects(() => collector.git(['reset', '--hard']), UnsafeGitCommandError);
    await assert.rejects(() => collector.git(['clean', '-fd']), UnsafeGitCommandError);
  } finally {
    repo.cleanup();
  }
});

test('parseStatusShort understands renames, untracked files and quoted paths', () => {
  const entries = parseStatusShort(
    ['R  old.txt -> new.txt', '?? untracked.txt', ' M modified.txt', 'A  added.txt', '"quoted name.txt"'].join('\n'),
  );
  const rename = entries.find((e) => e.path === 'new.txt');
  assert.equal(rename?.renamedFrom, 'old.txt');
  assert.ok(entries.some((e) => e.path === 'untracked.txt' && e.indexStatus === '?'));
  assert.ok(entries.some((e) => e.path === 'modified.txt' && e.worktreeStatus === 'M'));
  assert.ok(entries.some((e) => e.path === 'added.txt' && e.indexStatus === 'A'));
});
