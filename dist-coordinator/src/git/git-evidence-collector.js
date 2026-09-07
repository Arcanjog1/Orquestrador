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
import { assertReadOnlyGitArgs } from './git-safety.js';
import { ProcessManager } from '../process/process-manager.js';
const GIT_TIMEOUT_MS = 120_000;
export class GitEvidenceCollector {
    projectPath;
    processManager;
    gitCommand;
    constructor(projectPath, processManager = new ProcessManager(), gitCommand = process.platform === 'win32' ? 'git.exe' : 'git') {
        this.projectPath = projectPath;
        this.processManager = processManager;
        this.gitCommand = gitCommand;
    }
    /** Runs a read-only git command. Throws if the arguments are not read-only. */
    async git(args) {
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
    async isGitRepository() {
        const result = await this.git(['rev-parse', '--is-inside-work-tree']);
        return result.ok && result.stdout.trim() === 'true';
    }
    /**
     * Records the project's state before anything is allowed to touch it.
     *
     * A dirty working tree is recorded, never cleaned: the user's uncommitted
     * work is preserved untouched (spec 9).
     */
    async captureBaseline() {
        const capturedAt = new Date().toISOString();
        if (!(await this.isGitRepository())) {
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
        };
    }
    /** Collects the post-worker state and diffs it against the baseline. */
    async collectEvidence(baseline) {
        const collectedAt = new Date().toISOString();
        if (!(await this.isGitRepository())) {
            return {
                collectedAt,
                isGitRepository: false,
                commit: null,
                branch: null,
                statusShort: '',
                diff: '',
                diffStat: '',
                changedFiles: [],
                addedFiles: [],
                deletedFiles: [],
                changedSinceBaseline: false,
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
            changedFiles: entries.map((e) => e.path),
            addedFiles,
            deletedFiles,
            changedSinceBaseline: hasChangedSinceBaseline(baseline, statusShort, diff.stdout),
        };
    }
}
/**
 * Parses porcelain v1 short status.
 *
 * Lines look like `XY path`, where X is the index status and Y the working
 * tree status. Renames appear as `R  old -> new`; quoted paths (non-ASCII or
 * spaces, with `core.quotePath` on) are unquoted.
 */
export function parseStatusShort(output) {
    const entries = [];
    for (const rawLine of output.split(/\r?\n/)) {
        if (rawLine.trim() === '')
            continue;
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
        }
        else {
            entries.push({ indexStatus, worktreeStatus, path: unquoteGitPath(rest) });
        }
    }
    return entries;
}
/** Undoes git's C-style path quoting. */
function unquoteGitPath(path) {
    const trimmed = path.trim();
    if (!trimmed.startsWith('"') || !trimmed.endsWith('"'))
        return trimmed;
    const inner = trimmed.slice(1, -1);
    return inner.replace(/\\(\\|"|[0-7]{3})/g, (_match, escape) => {
        if (escape === '\\' || escape === '"')
            return escape;
        return String.fromCharCode(parseInt(escape, 8));
    });
}
/**
 * Whether the working tree moved since the baseline.
 *
 * The baseline may already have been dirty, so this is a comparison against
 * that recorded state, not a plain "is dirty" check.
 */
function hasChangedSinceBaseline(baseline, statusShort, diff) {
    const normalise = (text) => text
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter((l) => l !== '')
        .sort()
        .join('\n');
    if (normalise(statusShort) !== normalise(baseline.statusShort))
        return true;
    return diff.trim() !== baseline.unstagedDiff.trim();
}
//# sourceMappingURL=git-evidence-collector.js.map