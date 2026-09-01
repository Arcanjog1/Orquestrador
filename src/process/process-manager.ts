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

import { spawn, type ChildProcess } from 'node:child_process';
import { extname } from 'node:path';

export type ProcessOutcome = 'completed' | 'timeout' | 'cancelled' | 'spawn-error';

export interface ProcessResult {
  outcome: ProcessOutcome;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  /** True when output hit `maxOutputBytes` and was cut short. */
  truncated: boolean;
  error?: string;
}

export interface RunProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  /** Overlay applied on top of `process.env`. `undefined` values delete keys. */
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  /** Hard timeout. Omit or pass 0 to disable. */
  timeoutMs?: number;
  /** How long a graceful stop is given before the tree is force-killed. */
  graceMs?: number;
  /** Output capture cap per stream. Default 10 MiB. */
  maxOutputBytes?: number;
  /** Cancels the process; the result comes back with outcome `cancelled`. */
  signal?: AbortSignal;
  /** Live output callbacks, invoked per chunk. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /**
   * `pipe` (default) captures output. `inherit` hands the terminal to the
   * child - required for interactive flows such as `claude auth login`.
   */
  stdio?: 'pipe' | 'inherit';
}

export const DEFAULT_GRACE_MS = 5_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** What will actually be handed to `child_process.spawn`. */
export interface SpawnPlan {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

export class UnsafeArgumentError extends Error {
  constructor(
    readonly argument: string,
    reason: string,
  ) {
    super(`Refusing to pass argument to cmd.exe: ${reason}`);
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
export function buildSpawnPlan(
  command: string,
  args: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
  comSpec: string = process.env.ComSpec ?? 'cmd.exe',
): SpawnPlan {
  const isCmdLauncher =
    platform === 'win32' && CMD_LAUNCHER_EXTENSIONS.has(extname(command).toLowerCase());

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
export function quoteForCmd(token: string): string {
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
export function buildChildEnv(
  overlay: Record<string, string | undefined> | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (!overlay) return env;
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Owns every child process the orchestrator starts, so a Ctrl+C can take the
 * whole tree down deterministically.
 */
export class ProcessManager {
  private readonly live = new Set<ChildProcess>();
  /**
   * Why a given child was stopped. Written by `terminate`, read by `run` once
   * the child closes - without it, a child killed by `cancelAll` would report
   * a perfectly ordinary `completed` outcome.
   */
  private readonly terminationReason = new WeakMap<ChildProcess, ProcessOutcome>();
  private cancelled = false;

  /** Number of child processes currently running. */
  get liveCount(): number {
    return this.live.size;
  }

  /** True once `cancelAll` has been called; new runs refuse to start. */
  get isCancelled(): boolean {
    return this.cancelled;
  }

  async run(options: RunProcessOptions): Promise<ProcessResult> {
    const startedAt = new Date();
    const start = Date.now();
    const finish = (
      outcome: ProcessOutcome,
      partial: Partial<ProcessResult> = {},
    ): ProcessResult => ({
      outcome,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: Date.now() - start,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      ...partial,
    });

    if (this.cancelled) {
      return finish('cancelled', { error: 'Orchestrator was cancelled before the process started.' });
    }
    if (options.signal?.aborted) {
      return finish('cancelled', { error: 'Aborted before the process started.' });
    }

    let plan: SpawnPlan;
    try {
      plan = buildSpawnPlan(options.command, options.args ?? []);
    } catch (err) {
      return finish('spawn-error', { error: (err as Error).message });
    }

    const stdio = options.stdio ?? 'pipe';
    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;

    let child: ChildProcess;
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
    } catch (err) {
      return finish('spawn-error', { error: describeSpawnError(err, options.command) });
    }

    this.live.add(child);

    const out = new OutputBuffer(maxBytes);
    const err = new OutputBuffer(maxBytes);
    let outcome: ProcessOutcome = 'completed';
    let errorMessage: string | undefined;

    if (stdio === 'pipe') {
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        out.push(chunk);
        options.onStdout?.(chunk);
      });
      child.stderr?.on('data', (chunk: string) => {
        err.push(chunk);
        options.onStderr?.(chunk);
      });
    }

    // stdin is how prompts are delivered - never the command line.
    if (child.stdin) {
      child.stdin.on('error', () => {
        // A child that exits without reading stdin gives EPIPE; not fatal.
      });
      if (options.stdin !== undefined) child.stdin.end(options.stdin, 'utf8');
      else child.stdin.end();
    }

    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise) => {
        let settled = false;
        const settle = (code: number | null, sig: NodeJS.Signals | null): void => {
          if (settled) return;
          settled = true;
          resolvePromise({ code, signal: sig });
        };

        child.on('error', (e: Error) => {
          if (outcome === 'completed') {
            outcome = 'spawn-error';
            errorMessage = describeSpawnError(e, options.command);
          }
          settle(null, null);
        });
        child.on('close', (code, sig) => settle(code, sig));

        if (options.timeoutMs && options.timeoutMs > 0) {
          timer = setTimeout(() => {
            outcome = 'timeout';
            errorMessage = `Process exceeded its ${Math.round(options.timeoutMs! / 1000)}s timeout.`;
            void this.terminate(child, graceMs, 'timeout');
          }, options.timeoutMs);
        }

        if (options.signal) {
          onAbort = (): void => {
            if (outcome === 'completed') {
              outcome = 'cancelled';
              errorMessage = 'Cancelled by the orchestrator.';
            }
            void this.terminate(child, graceMs, 'cancelled');
          };
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      },
    );

    if (timer) clearTimeout(timer);
    if (onAbort && options.signal) options.signal.removeEventListener('abort', onAbort);
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
  async cancelAll(graceMs: number = DEFAULT_GRACE_MS): Promise<void> {
    this.cancelled = true;
    const children = [...this.live];
    await Promise.all(children.map((child) => this.terminate(child, graceMs, 'cancelled')));
  }

  /** Allows a manager to be reused after a cancellation (used by `resume`). */
  reset(): void {
    this.cancelled = false;
  }

  /**
   * Graceful stop, escalating to a forced tree kill.
   *
   * Windows has no signals, so `taskkill /T` is the only reliable way to reach
   * grandchildren (a `.cmd` launcher spawns node, which spawns more).
   */
  private async terminate(
    child: ChildProcess,
    graceMs: number,
    reason: ProcessOutcome = 'cancelled',
  ): Promise<void> {
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    this.terminationReason.set(child, reason);

    if (process.platform === 'win32') {
      // Ask politely first (no /F), then force the tree.
      await runTaskkill(['/pid', String(pid), '/T']);
      if (await waitForExit(child, graceMs)) return;
      await runTaskkill(['/pid', String(pid), '/T', '/F']);
      await waitForExit(child, graceMs);
      return;
    }

    // POSIX: signal the whole process group (negative pid). `detached: true`
    // at spawn time made the child a group leader.
    killGroup(pid, 'SIGTERM');
    if (await waitForExit(child, graceMs)) return;
    killGroup(pid, 'SIGKILL');
    await waitForExit(child, graceMs);
  }
}

/** Accumulates output up to a byte cap without unbounded memory growth. */
class OutputBuffer {
  private readonly chunks: string[] = [];
  private bytes = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  push(chunk: string): void {
    if (this.truncated) return;
    const size = Buffer.byteLength(chunk, 'utf8');
    if (this.bytes + size > this.maxBytes) {
      this.truncated = true;
      this.chunks.push('\n...[output truncated by the orchestrator]...\n');
      return;
    }
    this.bytes += size;
    this.chunks.push(chunk);
  }

  text(): string {
    return this.chunks.join('');
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group may already be gone; fall back to the single process.
    try {
      process.kill(pid, signal);
    } catch {
      /* already exited */
    }
  }
}

async function runTaskkill(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    try {
      const killer = spawn('taskkill.exe', args, { stdio: 'ignore', shell: false });
      killer.on('close', () => resolvePromise());
      killer.on('error', () => resolvePromise());
    } catch {
      resolvePromise();
    }
  });
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(() => {
      child.off('close', onClose);
      resolvePromise(false);
    }, ms);
    const onClose = (): void => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    child.once('close', onClose);
  });
}

function describeSpawnError(err: unknown, command: string): string {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === 'ENOENT') {
    return `Command not found: ${command}. Check that it is installed and on PATH.`;
  }
  if (e?.code === 'EACCES') return `Command is not executable: ${command}.`;
  if (e?.code === 'EINVAL') {
    return `Windows refused to spawn ${command} directly. .cmd and .bat launchers must go through cmd.exe.`;
  }
  return `Failed to start ${command}: ${e?.message ?? String(err)}`;
}
