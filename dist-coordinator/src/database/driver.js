/**
 * The SQL driver seam.
 *
 * Everything above this interface - repositories, orchestrator core, agents,
 * workspaces, the UI - depends only on `SqlDriver`. Which SQLite binding sits
 * underneath is an implementation detail that can be replaced without touching
 * any of them, which matters because the packaging story for SQLite under
 * Electron is the part most likely to need changing.
 */
export class DatabaseUnavailableError extends Error {
    userMessage;
    remedy;
    constructor(userMessage, remedy, detail) {
        super(`${userMessage}${detail ? ` (${detail})` : ''}`);
        this.userMessage = userMessage;
        this.remedy = remedy;
        this.name = 'DatabaseUnavailableError';
    }
}
/**
 * Whether the Node build running this process exposes `node:sqlite`.
 *
 * This is the packaging-safest option available: it is part of Node itself, so
 * there is no native module to rebuild against Electron's ABI and no prebuilt
 * binary to ship per architecture. It is checked at runtime rather than
 * assumed, because availability depends on which Node the host embeds.
 */
export function nodeSqliteAvailable() {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return typeof createRequire(import.meta.url)('node:sqlite')?.DatabaseSync === 'function';
    }
    catch {
        return false;
    }
}
import { createRequire } from 'node:module';
//# sourceMappingURL=driver.js.map