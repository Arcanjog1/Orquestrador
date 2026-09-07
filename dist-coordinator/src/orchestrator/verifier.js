/**
 * Independent verification (spec 13).
 *
 * When the orchestrator agent supplies `verificationCommands`, the program runs
 * them itself after the worker has finished and records command, stdout,
 * stderr, exit code and duration. The orchestrator sees those results, not the
 * worker's summary of them.
 *
 * Commands are tokenised and spawned directly - no shell. `screenCommand` has
 * already refused anything with shell operators or destructive git, and a
 * refused command is reported as a failure rather than executed.
 */
import { parseCommandLine, screenCommand } from '../git/git-safety.js';
import { resolveExecutable } from '../preflight/preflight.js';
export class Verifier {
    options;
    constructor(options) {
        this.options = options;
    }
    /** Runs every command in order and returns one result per command. */
    async runAll(commands) {
        const results = [];
        for (const command of commands) {
            if (this.options.signal?.aborted)
                break;
            const result = await this.runOne(command);
            results.push(result);
            this.options.onCommandFinish?.(result);
        }
        return results;
    }
    async runOne(commandLine) {
        this.options.onCommandStart?.(commandLine);
        const started = Date.now();
        const screen = screenCommand(commandLine);
        if (!screen.safe) {
            return {
                command: commandLine,
                exitCode: null,
                stdout: '',
                stderr: '',
                durationMs: 0,
                timedOut: false,
                refused: screen.reason ?? 'Refused by the command safety screen.',
            };
        }
        const tokens = parseCommandLine(commandLine);
        const [executable, ...args] = tokens;
        // Resolved by the environment, not by this machine: see `resolveCommand`.
        const resolve = this.options.resolveCommand
            ?? ((command) => resolveExecutable(command, this.options.processManager));
        const resolved = (await resolve(executable)) ?? executable;
        const result = await this.options.processManager.run({
            command: resolved,
            args,
            cwd: this.options.cwd,
            timeoutMs: this.options.timeoutMs,
            ...(this.options.signal ? { signal: this.options.signal } : {}),
        });
        return {
            command: commandLine,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: Date.now() - started,
            timedOut: result.outcome === 'timeout',
            ...(result.outcome === 'spawn-error'
                ? { refused: result.error ?? `Could not start ${executable}.` }
                : {}),
        };
    }
}
/** A command counts as passing only when it actually ran and exited 0. */
export function commandPassed(result) {
    return !result.refused && !result.timedOut && result.exitCode === 0;
}
/** One-line summary used in logs and in the final report. */
export function summariseResults(results) {
    if (results.length === 0)
        return 'no verification commands';
    const passed = results.filter(commandPassed).length;
    return `${passed}/${results.length} verification commands passed`;
}
//# sourceMappingURL=verifier.js.map