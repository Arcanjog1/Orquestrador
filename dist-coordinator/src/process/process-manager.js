/**
 * Child process management (spec 38, 39, 40).
 *
 * Design constraints this module exists to satisfy:
 *
 *  1. `shell: true` is never used. Prompts are delivered over **stdin**, so no
 *     model-authored text is ever interpolated into a command line.
 *  2. `.cmd` / `.bat` launchers - what npm installs produce on Windows - cannot
 *     be spawned directly by Node (it throws EINVAL since the 2024 argument
 *     injection fix), so they are wrapped in `cmd.exe /d /s /c` explicitly and
 *     with deliberate quoting, rather than by handing the string to a shell.
 *  3. Timeouts and cancellation kill the whole process *tree*, so a cancelled
 *     run leaves no orphaned node/claude/codex/cmd processes behind.
 */
import { spawn } from 'node:child_process';
import { extname } from 'node:path';
export const DEFAULT_GRACE_MS = 5_000;
/** How long `close` may lag `exit` before the result is settled without it. */
export const EXIT_CLOSE_GRACE_MS = 5_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export class UnsafeArgumentError extends Error {
    argument;
    constructor(argument, reason) {
        super(`Refusing to pass argument to cmd.exe: ${reason}`);
        this.argument = argument;
        this.name = 'UnsafeArgumentError';
    }
}
const CMD_LAUNCHER_EXTENSIONS = new Set(['.cmd', '.bat']);
/**
 * Decides how to spawn `command`.
 *
 * Exported (and platform-parameterised) so the Windows path can be unit tested
 * from any host OS.
 */
export function buildSpawnPlan(command, args = [], platform = process.platform, comSpec = process.env.ComSpec ?? 'cmd.exe') {
    const isCmdLauncher = platform === 'win32' && CMD_LAUNCHER_EXTENSIONS.has(extname(command).toLowerCase());
    if (!isCmdLauncher) {
        // Direct spawn: Node handles argv quoting, no shell is involved.
        return { file: command, args: [...args], windowsVerbatimArguments: false };
    }
    // cmd.exe /d (skip AutoRun) /s (take the rest of the line literally after
    // stripping the outer quotes) /c (run then exit). Everything after /c is one
    // pre-quoted string, and windowsVerbatimArguments stops Node re-quoting it.
    const line = [command, ...args].map(quoteForCmd).join(' ');
    return {
        file: comSpec,
        args: ['/d', '/s', '/c', `"${line}"`],
        windowsVerbatimArguments: true,
    };
}
/**
 * Quotes one token for a `cmd.exe /c` command line.
 *
 * Arguments reaching this function are orchestrator-controlled (flags and
 * paths) - prompts travel over stdin - so rather than attempting to escape
 * every cmd metacharacter, anything genuinely unquotable is rejected loudly.
 */
export function quoteForCmd(token) {
    if (/[\0\r\n]/.test(token)) {
        throw new UnsafeArgumentError(token, 'it contains a NUL or newline character');
    }
    if (/%[^%\s]*%/.test(token)) {
        // cmd expands %VAR% even inside double quotes and `^` cannot escape it.
        throw new UnsafeArgumentError(token, 'it looks like a %VARIABLE% reference');
    }
    // Backslashes preceding the closing quote must be doubled, otherwise they
    // escape it. Embedded double quotes are backslash-escaped.
    const escaped = token.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
    return `"${escaped}"`;
}
/** Builds the child environment, deleting keys whose overlay value is undefined. */
export function buildChildEnv(overlay, base = process.env) {
    const env = { ...base };
    if (!overlay)
        return env;
    for (const [key, value] of Object.entries(overlay)) {
        if (value === undefined)
            delete env[key];
        else
            env[key] = value;
    }
    return env;
}
/**
 * Owns every child process the orchestrator starts, so a Ctrl+C can take the
 * whole tree down deterministically.
 */
export class ProcessManager {
    live = new Set();
    /**
     * Why a given child was stopped. Written by `terminate`, read by `run` once
     * the child closes - without it, a child killed by `cancelAll` would report
     * a perfectly ordinary `completed` outcome.
     */
    terminationReason = new WeakMap();
    /** Every stop attempt made on a child, for its trace. */
    terminationLog = new WeakMap();
    cancelled = false;
    /** Number of child processes currently running. */
    get liveCount() {
        return this.live.size;
    }
    /** True once `cancelAll` has been called; new runs refuse to start. */
    get isCancelled() {
        return this.cancelled;
    }
    async run(options) {
        const startedAt = new Date();
        const start = Date.now();
        const trace = {
            pid: null,
            spawnedAt: startedAt.toISOString(),
            startedAt: null,
            firstStdoutAt: null,
            firstStderrAt: null,
            stdoutBytes: 0,
            stderrBytes: 0,
            exitedAt: null,
            closedAt: null,
            errorAt: null,
            errorCode: null,
            streamsLingered: false,
            survivedTermination: false,
            termination: null,
        };
        const finish = (outcome, partial = {}) => ({
            outcome,
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: '',
            truncated: false,
            durationMs: Date.now() - start,
            startedAt: startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            trace,
            ...partial,
        });
        if (this.cancelled) {
            return finish('cancelled', { error: 'Orchestrator was cancelled before the process started.' });
        }
        if (options.signal?.aborted) {
            return finish('cancelled', { error: 'Aborted before the process started.' });
        }
        let plan;
        try {
            plan = buildSpawnPlan(options.command, options.args ?? []);
        }
        catch (err) {
            return finish('spawn-error', { error: err.message });
        }
        const stdio = options.stdio ?? 'pipe';
        const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
        let child;
        try {
            child = spawn(plan.file, plan.args, {
                cwd: options.cwd,
                env: buildChildEnv(options.env),
                // Never `true`: no shell interpretation of anything we pass.
                shell: false,
                windowsVerbatimArguments: plan.windowsVerbatimArguments,
                // A dedicated process group on POSIX lets us signal the whole tree.
                detached: process.platform !== 'win32',
                stdio: stdio === 'inherit' ? 'inherit' : ['pipe', 'pipe', 'pipe'],
            });
        }
        catch (err) {
            trace.errorAt = new Date().toISOString();
            trace.errorCode = err?.code ?? null;
            return finish('spawn-error', { error: describeSpawnError(err, options.command) });
        }
        this.live.add(child);
        trace.pid = child.pid ?? null;
        trace.spawnedAt = new Date().toISOString();
        child.once('spawn', () => {
            trace.startedAt = new Date().toISOString();
        });
        const out = new OutputBuffer(maxBytes);
        const err = new OutputBuffer(maxBytes);
        let outcome = 'completed';
        let errorMessage;
        if (stdio === 'pipe') {
            child.stdout?.setEncoding('utf8');
            child.stderr?.setEncoding('utf8');
            child.stdout?.on('data', (chunk) => {
                trace.firstStdoutAt ??= new Date().toISOString();
                trace.stdoutBytes += Buffer.byteLength(chunk, 'utf8');
                out.push(chunk);
                options.onStdout?.(chunk);
            });
            child.stderr?.on('data', (chunk) => {
                trace.firstStderrAt ??= new Date().toISOString();
                trace.stderrBytes += Buffer.byteLength(chunk, 'utf8');
                err.push(chunk);
                options.onStderr?.(chunk);
            });
        }
        // stdin is how prompts are delivered - never the command line.
        if (child.stdin) {
            child.stdin.on('error', () => {
                // A child that exits without reading stdin gives EPIPE; not fatal.
            });
            if (options.stdin !== undefined)
                child.stdin.end(options.stdin, 'utf8');
            else
                child.stdin.end();
        }
        let timer;
        let onAbort;
        let lingerTimer;
        // A stop in flight when the child closes: waited for before returning, so
        // the trace carries every attempt rather than the ones made so far.
        let pendingStop = null;
        const exit = await new Promise((resolvePromise) => {
            let settled = false;
            const settle = (code, sig) => {
                if (settled)
                    return;
                settled = true;
                resolvePromise({ code, signal: sig });
            };
            // A stop that leaves the child alive must still let `run` return:
            // the result says the child survived, and the trace says what was
            // tried. Waiting for a `close` that never comes helps nobody.
            const stop = (reason) => {
                pendingStop = (async () => {
                    await this.terminate(child, graceMs, reason);
                    if (!settled && child.exitCode === null && child.signalCode === null) {
                        trace.survivedTermination = true;
                        settle(null, null);
                    }
                })();
            };
            child.on('error', (e) => {
                trace.errorAt = new Date().toISOString();
                trace.errorCode = e.code ?? null;
                if (outcome === 'completed') {
                    outcome = 'spawn-error';
                    errorMessage = describeSpawnError(e, options.command);
                }
                settle(null, null);
            });
            child.on('exit', (code, sig) => {
                trace.exitedAt = new Date().toISOString();
                // `close` normally follows within milliseconds. When it does not,
                // something else holds the pipes; the output so far is the answer.
                lingerTimer = setTimeout(() => {
                    trace.streamsLingered = true;
                    settle(code, sig);
                }, EXIT_CLOSE_GRACE_MS);
            });
            child.on('close', (code, sig) => {
                trace.closedAt = new Date().toISOString();
                settle(code, sig);
            });
            if (options.timeoutMs && options.timeoutMs > 0) {
                timer = setTimeout(() => {
                    outcome = 'timeout';
                    errorMessage = `Process exceeded its ${Math.round(options.timeoutMs / 1000)}s timeout.`;
                    stop('timeout');
                }, options.timeoutMs);
            }
            if (options.signal) {
                onAbort = () => {
                    if (outcome === 'completed') {
                        outcome = 'cancelled';
                        errorMessage = 'Cancelled by the orchestrator.';
                    }
                    stop('cancelled');
                };
                options.signal.addEventListener('abort', onAbort, { once: true });
            }
        });
        if (timer)
            clearTimeout(timer);
        if (lingerTimer)
            clearTimeout(lingerTimer);
        if (pendingStop)
            await pendingStop;
        const attempts = this.terminationLog.get(child);
        const reason = this.terminationReason.get(child);
        if (reason && attempts)
            trace.termination = { reason, attempts };
        if (onAbort && options.signal)
            options.signal.removeEventListener('abort', onAbort);
        this.live.delete(child);
        // A child stopped by `cancelAll` closes normally from `run`'s point of
        // view, so the reason recorded by `terminate` wins over the exit status.
        const externalReason = this.terminationReason.get(child);
        if (externalReason && outcome === 'completed') {
            outcome = externalReason;
            errorMessage ??=
                externalReason === 'cancelled'
                    ? 'Cancelled by the orchestrator.'
                    : 'Terminated by the orchestrator.';
        }
        return finish(outcome, {
            exitCode: exit.code,
            signal: exit.signal,
            stdout: out.text(),
            stderr: err.text(),
            truncated: out.truncated || err.truncated,
            ...(errorMessage ? { error: errorMessage } : {}),
        });
    }
    /**
     * Stops every live child, tree included. Called by the Ctrl+C handler.
     * Never touches the filesystem or git (spec 31).
     */
    async cancelAll(graceMs = DEFAULT_GRACE_MS) {
        this.cancelled = true;
        const children = [...this.live];
        await Promise.all(children.map((child) => this.terminate(child, graceMs, 'cancelled')));
    }
    /** Allows a manager to be reused after a cancellation (used by `resume`). */
    reset() {
        this.cancelled = false;
    }
    /**
     * Graceful stop, escalating to a forced tree kill.
     *
     * Windows has no signals, so `taskkill /T` is the only reliable way to reach
     * grandchildren (a `.cmd` launcher spawns node, which spawns more).
     */
    async terminate(child, graceMs, reason = 'cancelled') {
        const pid = child.pid;
        if (pid === undefined || child.exitCode !== null || child.signalCode !== null)
            return;
        this.terminationReason.set(child, reason);
        const attempts = [];
        this.terminationLog.set(child, attempts);
        const record = (method, exited) => {
            attempts.push({ method, at: new Date().toISOString(), exited });
        };
        if (process.platform === 'win32') {
            // Ask politely first (no /F), then force the tree.
            await runTaskkill(['/pid', String(pid), '/T']);
            const polite = await waitForExit(child, graceMs);
            record(`taskkill /pid ${pid} /T`, polite);
            if (polite)
                return;
            await runTaskkill(['/pid', String(pid), '/T', '/F']);
            record(`taskkill /pid ${pid} /T /F`, await waitForExit(child, graceMs));
            return;
        }
        // POSIX: signal the whole process group (negative pid). `detached: true`
        // at spawn time made the child a group leader.
        killGroup(pid, 'SIGTERM');
        const term = await waitForExit(child, graceMs);
        record('SIGTERM (process group)', term);
        if (term)
            return;
        killGroup(pid, 'SIGKILL');
        record('SIGKILL (process group)', await waitForExit(child, graceMs));
    }
}
/** Accumulates output up to a byte cap without unbounded memory growth. */
class OutputBuffer {
    maxBytes;
    chunks = [];
    bytes = 0;
    truncated = false;
    constructor(maxBytes) {
        this.maxBytes = maxBytes;
    }
    push(chunk) {
        if (this.truncated)
            return;
        const size = Buffer.byteLength(chunk, 'utf8');
        if (this.bytes + size > this.maxBytes) {
            this.truncated = true;
            this.chunks.push('\n...[output truncated by the orchestrator]...\n');
            return;
        }
        this.bytes += size;
        this.chunks.push(chunk);
    }
    text() {
        return this.chunks.join('');
    }
}
function killGroup(pid, signal) {
    try {
        process.kill(-pid, signal);
    }
    catch {
        // The group may already be gone; fall back to the single process.
        try {
            process.kill(pid, signal);
        }
        catch {
            /* already exited */
        }
    }
}
async function runTaskkill(args) {
    await new Promise((resolvePromise) => {
        try {
            const killer = spawn('taskkill.exe', args, { stdio: 'ignore', shell: false });
            killer.on('close', () => resolvePromise());
            killer.on('error', () => resolvePromise());
        }
        catch {
            resolvePromise();
        }
    });
}
function waitForExit(child, ms) {
    if (child.exitCode !== null || child.signalCode !== null)
        return Promise.resolve(true);
    return new Promise((resolvePromise) => {
        const timer = setTimeout(() => {
            child.off('exit', onExit);
            resolvePromise(false);
        }, ms);
        // `exit` is the process being gone, which is the question here; `close`
        // also needs the pipes, which another process may be holding.
        const onExit = () => {
            clearTimeout(timer);
            resolvePromise(true);
        };
        child.once('exit', onExit);
    });
}
function describeSpawnError(err, command) {
    const e = err;
    if (e?.code === 'ENOENT') {
        return `Command not found: ${command}. Check that it is installed and on PATH.`;
    }
    if (e?.code === 'EACCES')
        return `Command is not executable: ${command}.`;
    if (e?.code === 'EINVAL') {
        return `Windows refused to spawn ${command} directly. .cmd and .bat launchers must go through cmd.exe.`;
    }
    return `Failed to start ${command}: ${e?.message ?? String(err)}`;
}
//# sourceMappingURL=process-manager.js.map