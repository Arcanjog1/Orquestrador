/**
 * Independent git evidence collection (spec 9, 12).
 *
 * The orchestrator agent must never have to take the worker's word for what
 * changed. Everything here is gathered by the program itself, straight from
 * git, after the worker has finished.
 *
 * Every invocation goes through `assertReadOnlyGitArgs`, so this collector
 * cannot mutate the repository even if a future change tried to make it.
 */

import type { Baseline, GitEvidence } from '../core/types.js';
import { assertReadOnlyGitArgs } from './git-safety.js';
import { diffSnapshots, snapshotWorkspace } from './workspace-snapshot.js';
import { ProcessManager } from '../process/process-manager.js';
import type { ProcessRunner } from '../execution/process-runner.js';

const GIT_TIMEOUT_MS = 120_000;

export interface GitCommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  ok: boolean;
}

export class GitEvidenceCollector {
  constructor(
    private readonly projectPath: string,
    private readonly processManager: ProcessRunner = new ProcessManager(),
    private readonly gitCommand: string = process.platform === 'win32' ? 'git.exe' : 'git',
  ) {}

  /** Runs a read-only git command. Throws if the arguments are not read-only. */
  async git(args: string[]): Promise<GitCommandOutput> {
    assertReadOnlyGitArgs(args);
    const result = await this.processManager.run({
      command: this.gitCommand,
      args,
      cwd: this.projectPath,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      ok: result.outcome === 'completed' && result.exitCode === 0,
    };
  }

  async isGitRepository(): Promise<boolean> {
    return (await this.probeRepository()).isRepository;
  }

  /**
   * Whether this folder is a git repository - and, when it is not, whether
   * that is because it genuinely is not one or because git could not run.
   *
   * These were the same answer until now, and that was the bug: a machine
   * where the git executable cannot be resolved produced "not a repository",
   * which produced empty evidence, which the loop read as "the worker changed
   * nothing". A worker that really did the work was reported as having failed,
   * every iteration, with no way for anyone to see why.
   */
  async probeRepository(): Promise<{ isRepository: boolean; problem: string | null }> {
    const result = await this.git(['rev-parse', '--is-inside-work-tree']);
    if (result.ok) {
      return { isRepository: result.stdout.trim() === 'true', problem: null };
    }
    // git ran and said no. That is a real answer about a real folder.
    if (result.exitCode !== null && /not a git repository/i.test(result.stderr)) {
      return { isRepository: false, problem: null };
    }
    // git did not run, or failed in a way that says nothing about the folder.
    const said = firstLine(result.stderr) || firstLine(result.stdout);
    return {
      isRepository: false,
      problem:
        `O git não pôde ser executado nesta pasta (${this.gitCommand}` +
        `${result.exitCode !== null ? `, código ${result.exitCode}` : ', não iniciou'})` +
        `${said ? `: ${said}` : '.'}`,
    };
  }

  /**
   * Records the project's state before anything is allowed to touch it.
   *
   * A dirty working tree is recorded, never cleaned: the user's uncommitted
   * work is preserved untouched (spec 9).
   */
  async captureBaseline(): Promise<Baseline> {
    const capturedAt = new Date().toISOString();
    const probe = await this.probeRepository();
    if (!probe.isRepository) {
      // No repository, or no usable git. Either way the program still looks -
      // it walks the folder itself - so that a file the worker really creates
      // is still seen by something other than the worker's own account of it.
      return {
        capturedAt,
        isGitRepository: false,
        commit: null,
        branch: null,
        statusShort: '',
        unstagedDiff: '',
        stagedDiff: '',
        modifiedFiles: [],
        stagedFiles: [],
        dirty: false,
        source: 'filesystem',
        evidenceProblem: probe.problem,
        files: this.snapshot(),
      };
    }

    const [head, branch, status, diff, cached] = await Promise.all([
      this.git(['rev-parse', 'HEAD']),
      this.git(['branch', '--show-current']),
      this.git(['status', '--short']),
      this.git(['diff']),
      this.git(['diff', '--cached']),
    ]);

    const statusShort = status.stdout;
    const entries = parseStatusShort(statusShort);

    return {
      capturedAt,
      isGitRepository: true,
      // A repository with no commits yet has no HEAD; that is not an error.
      commit: head.ok ? head.stdout.trim() : null,
      branch: branch.ok ? branch.stdout.trim() || null : null,
      statusShort,
      unstagedDiff: diff.stdout,
      stagedDiff: cached.stdout,
      modifiedFiles: entries.filter((e) => e.worktreeStatus !== ' ').map((e) => e.path),
      stagedFiles: entries.filter((e) => e.indexStatus !== ' ' && e.indexStatus !== '?').map((e) => e.path),
      dirty: entries.length > 0,
      source: 'git',
      evidenceProblem: null,
      // Kept alongside git's answer so an ignored file - which `git status`
      // deliberately never mentions - is still noticed when it appears.
      files: this.snapshot(),
    };
  }

  /** Collects the post-worker state and diffs it against the baseline. */
  async collectEvidence(baseline: Baseline): Promise<GitEvidence> {
    const collectedAt = new Date().toISOString();
    const probe = await this.probeRepository();
    if (!probe.isRepository) {
      const files = this.snapshot();
      const before = baseline.files ?? { entries: {}, truncated: false, skipped: [] };
      const diff = diffSnapshots(before, files);
      return {
        collectedAt,
        isGitRepository: false,
        commit: null,
        branch: null,
        statusShort: '',
        diff: '',
        diffStat: describeSnapshotDiff(diff),
        changedFiles: [...diff.added, ...diff.modified, ...diff.removed],
        addedFiles: diff.added,
        deletedFiles: diff.removed,
        changedSinceBaseline: diff.changed,
        source: 'filesystem',
        evidenceProblem: probe.problem,
        files,
      };
    }

    const [head, branch, status, diff, stat] = await Promise.all([
      this.git(['rev-parse', 'HEAD']),
      this.git(['branch', '--show-current']),
      this.git(['status', '--short']),
      this.git(['diff']),
      this.git(['diff', '--stat']),
    ]);

    const statusShort = status.stdout;
    const entries = parseStatusShort(statusShort);
    const baselineEntries = parseStatusShort(baseline.statusShort);
    const baselinePaths = new Set(baselineEntries.map((e) => e.path));

    // The walk runs even inside a repository, because `git status` is silent
    // about ignored files and a task can legitimately create one.
    const files = this.snapshot();
    const ignoredChanges = diffSnapshots(
      baseline.files ?? { entries: {}, truncated: false, skipped: [] },
      files,
    );

    const addedFiles = entries
      .filter((e) => (e.indexStatus === 'A' || e.indexStatus === '?') && !baselinePaths.has(e.path))
      .map((e) => e.path);
    const deletedFiles = entries
      .filter((e) => e.indexStatus === 'D' || e.worktreeStatus === 'D')
      .map((e) => e.path);

    return {
      collectedAt,
      isGitRepository: true,
      commit: head.ok ? head.stdout.trim() : null,
      branch: branch.ok ? branch.stdout.trim() || null : null,
      statusShort,
      diff: diff.stdout,
      diffStat: stat.stdout,
      changedFiles: [...new Set([...entries.map((e) => e.path), ...ignoredChanges.added, ...ignoredChanges.modified])],
      addedFiles: [...new Set([...addedFiles, ...ignoredChanges.added])],
      deletedFiles: [...new Set([...deletedFiles, ...ignoredChanges.removed])],
      // Either git noticed, or the walk did. A file the repository ignores is
      // invisible to `git status` by design, and a worker asked to create one
      // would otherwise look like a worker that did nothing.
      changedSinceBaseline:
        hasChangedSinceBaseline(baseline, statusShort, diff.stdout) || ignoredChanges.changed,
      source: 'git',
      evidenceProblem: null,
      files,
    };
  }

  /**
   * The folder as a bounded file list, or an empty one when it cannot be read.
   *
   * Never throws: this is a fallback, and a fallback that can fail the run it
   * exists to rescue would be worse than not having it.
   */
  private snapshot() {
    try {
      return snapshotWorkspace(this.projectPath);
    } catch {
      return { entries: {}, truncated: false, skipped: [] };
    }
  }
}

/** A one-line diffstat for a filesystem comparison, in git's spirit. */
function describeSnapshotDiff(diff: { added: string[]; modified: string[]; removed: string[] }): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`${diff.added.length} novo(s)`);
  if (diff.modified.length > 0) parts.push(`${diff.modified.length} alterado(s)`);
  if (diff.removed.length > 0) parts.push(`${diff.removed.length} removido(s)`);
  return parts.length > 0 ? parts.join(', ') : '';
}

/** The first non-empty line, bounded. */
function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0)
      ?.slice(0, 300) ?? ''
  );
}

/** One parsed line of `git status --short`. */
export interface StatusEntry {
  indexStatus: string;
  worktreeStatus: string;
  path: string;
  /** Original path for a rename, when git reported one. */
  renamedFrom?: string;
}

/**
 * Parses porcelain v1 short status.
 *
 * Lines look like `XY path`, where X is the index status and Y the working
 * tree status. Renames appear as `R  old -> new`; quoted paths (non-ASCII or
 * spaces, with `core.quotePath` on) are unquoted.
 */
export function parseStatusShort(output: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.trim() === '') continue;
    const indexStatus = rawLine[0] ?? ' ';
    const worktreeStatus = rawLine[1] ?? ' ';
    const rest = rawLine.slice(3);
    const arrow = rest.indexOf(' -> ');
    if (arrow >= 0) {
      entries.push({
        indexStatus,
        worktreeStatus,
        renamedFrom: unquoteGitPath(rest.slice(0, arrow)),
        path: unquoteGitPath(rest.slice(arrow + 4)),
      });
    } else {
      entries.push({ indexStatus, worktreeStatus, path: unquoteGitPath(rest) });
    }
  }
  return entries;
}

/** Undoes git's C-style path quoting. */
function unquoteGitPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  const inner = trimmed.slice(1, -1);
  return inner.replace(/\\(\\|"|[0-7]{3})/g, (_match, escape: string) => {
    if (escape === '\\' || escape === '"') return escape;
    return String.fromCharCode(parseInt(escape, 8));
  });
}

/**
 * Whether the working tree moved since the baseline.
 *
 * The baseline may already have been dirty, so this is a comparison against
 * that recorded state, not a plain "is dirty" check.
 */
function hasChangedSinceBaseline(baseline: Baseline, statusShort: string, diff: string): boolean {
  const normalise = (text: string): string =>
    text
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l !== '')
      .sort()
      .join('\n');
  if (normalise(statusShort) !== normalise(baseline.statusShort)) return true;
  return diff.trim() !== baseline.unstagedDiff.trim();
}
