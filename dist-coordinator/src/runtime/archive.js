/**
 * Archive extraction and executable discovery.
 *
 * Extraction uses the `tar` that ships with the operating system - Windows 10
 * 1803 and later include bsdtar as `tar.exe`, which reads both .tar.gz and
 * .zip. That keeps the application free of native archive dependencies.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ProcessManager } from '../process/process-manager.js';
export class ExtractionError extends Error {
    constructor(archivePath, detail) {
        super(`Could not extract ${archivePath}: ${detail}`);
        this.name = 'ExtractionError';
    }
}
/** Extracts an archive into `destination`, which must already exist. */
export async function extractArchive(options) {
    if (options.kind === 'raw')
        return; // A bare executable needs no extraction.
    const pm = options.processManager ?? new ProcessManager();
    const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
    // `-xf` lets bsdtar/GNU tar detect the compression itself, which covers both
    // .tgz and .zip without branching on the format here.
    const result = await pm.run({
        command: tar,
        args: ['-xf', options.archivePath, '-C', options.destination],
        cwd: options.destination,
        timeoutMs: options.timeoutMs ?? 180_000,
    });
    if (result.outcome !== 'completed' || result.exitCode !== 0) {
        throw new ExtractionError(options.archivePath, result.error ?? result.stderr.split(/\r?\n/)[0] ?? `tar exited ${result.exitCode}`);
    }
}
/**
 * Finds an executable inside an extracted tree.
 *
 * `candidateNames` describes the *target* platform, not the host: the
 * application may well be preparing a Windows build, and on a case-sensitive
 * filesystem `codex` would not match `codex.exe`. Names are compared
 * case-insensitively for the same reason.
 */
export function findExecutable(root, candidateNames) {
    const wanted = candidateNames.map((n) => n.toLowerCase());
    // Breadth-first: a top-level `bin/codex.exe` should win over something buried
    // deeper in a vendored tree.
    const queue = [root];
    while (queue.length > 0) {
        const dir = queue.shift();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        const directories = [];
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                directories.push(full);
            }
            else if (wanted.includes(entry.name.toLowerCase())) {
                return full;
            }
        }
        queue.push(...directories);
    }
    return null;
}
/**
 * Decides which directory to promote as the runtime.
 *
 * Some builds ship the executable alongside sibling folders it needs at
 * runtime - the Windows Codex build keeps `codex-resources` and `codex-path`
 * next to `bin` - so promoting only the executable's own folder would break it.
 * The whole extracted tree is promoted, and the executable is recorded as a
 * path relative to it.
 */
export function planPromotion(extractedRoot, executablePath) {
    return {
        promoteDir: extractedRoot,
        executableRelativePath: relative(extractedRoot, executablePath),
    };
}
/** Total size of a directory tree, for reporting. */
export function directorySize(root) {
    let total = 0;
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory())
                stack.push(full);
            else {
                try {
                    total += statSync(full).size;
                }
                catch {
                    /* skip unreadable entries */
                }
            }
        }
    }
    return total;
}
//# sourceMappingURL=archive.js.map