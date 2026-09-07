/**
 * Filesystem moves and removals that survive Windows.
 *
 * On Windows a file that was just executed, or just written, is often still
 * held open for a moment by something else - the antivirus scanning a fresh
 * executable, the search indexer, a process handle not yet released. Renaming
 * or deleting it then fails with EPERM/EBUSY/ENOTEMPTY, and a pipeline that
 * treats that as fatal reports "could not prepare" for a build that is
 * perfectly fine. These helpers retry for a bounded time and, when the two
 * paths sit on different volumes (a redirected AppData, say), copy instead.
 */
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES', 'EMFILE']);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function codeOf(error) {
    return error?.code;
}
/** Removes a tree, retrying transient Windows refusals. Never throws when `force`. */
export async function removeTreeWithRetry(path, options = {}) {
    const sleep = options.sleep ?? defaultSleep;
    const deadline = Date.now() + (options.maxWaitMs ?? 15_000);
    let delay = 100;
    for (;;) {
        try {
            rmSync(path, { recursive: true, force: true });
            return true;
        }
        catch (error) {
            if (!RETRYABLE.has(codeOf(error) ?? '') || Date.now() >= deadline) {
                if (options.force !== false)
                    return false;
                throw error;
            }
            await sleep(delay);
            delay = Math.min(delay * 2, 2000);
        }
    }
}
/**
 * Moves a directory, retrying transient refusals, and copying across volumes
 * when `rename` cannot (EXDEV). The destination must not exist.
 */
export async function moveDirectoryWithRetry(from, to, options = {}) {
    const sleep = options.sleep ?? defaultSleep;
    const rename = options.rename ?? renameSync;
    const deadline = Date.now() + (options.maxWaitMs ?? 15_000);
    let delay = 100;
    for (;;) {
        try {
            rename(from, to);
            return;
        }
        catch (error) {
            const code = codeOf(error) ?? '';
            if (code === 'EXDEV') {
                // Different volumes: a rename is impossible, a copy is not.
                cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
                await removeTreeWithRetry(from, options);
                return;
            }
            if (!RETRYABLE.has(code) || Date.now() >= deadline) {
                throw error;
            }
            // A half-made destination from a failed attempt must not block the next.
            if (existsSync(to))
                await removeTreeWithRetry(to, options);
            await sleep(delay);
            delay = Math.min(delay * 2, 2000);
        }
    }
}
//# sourceMappingURL=fs-retry.js.map