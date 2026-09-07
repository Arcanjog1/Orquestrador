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
import type { ProcessRunner } from '../execution/process-runner.js';
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
  /** What happened to the child, step by step: for a record a person can read. */
  trace: ProcessTrace;
}

/** One attempt to stop a child, and whether the child was gone afterwards. */
export interface TerminationAttempt {
  method: string;
  at: string;
  exited: boolean;
}

/**
 * The lifecycle of one child, with timestamps, so "it did not answer" can be
 * told apart from "it never started", "it started and printed nothing", "it
 * died with an access violation" and "it exited but something kept its pipes".
 */
export interface ProcessTrace {
  /** Null when the operating system refused to create the process. */
  pid: number | null;
  /** When `spawn()` returned. */
  spawnedAt: string;
  /** The `spawn` event: the process really exists. Null if it never did. */
  startedAt: string | null;
  firstStdoutAt: string | null;
  firstStderrAt: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  /** The `exit` event. */
  exitedAt: string | null;
  /** The `close` event: exit and every pipe closed. */
  closedAt: string | null;
  errorAt: string | null;
  errorCode: string | null;
  /**
   * True when the child exited but its pipes stayed open past the grace
   * period: another process inherited them (on Windows, a handle leaked to a
   * concurrently spawned child). The result carries what had arrived.
   */
  streamsLingered: boolean;
  /** True when the child was still alive after every stop attempt. */
  survivedTermination: boolean;
  /**
   * True when the child was stopped for producing nothing, not for taking too
   * long. Kept apart so the diagnosis names which deadline was crossed.
   */
  idleTimedOut: boolean;
  /** The last moment the child produced any output. */
  lastActivityAt: string | null;
  termination: { reason: ProcessOutcome; attempts: TerminationAttempt[] } | null;
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
  /**
   * How long the child may produce nothing at all before it is stopped.
   *
   * Different from `timeoutMs`, and the difference is the point. A hard
   * timeout answers "has this taken too long?", which a large, legitimate
   * piece of work fails; an idle timeout answers "is anything still
   * happening?", which only a stuck process fails. Any byte on stdout or
   * stderr resets it.
   *
   * This is why the window could sit on "executando automaticamente"
   * indefinitely: a child that hangs before its hard timeout produced no
   * output, and nothing was watching for the absence.
   *
   * Omit or pass 0 to disable.
   */
  idleTimeoutMs?: number;
  /**
   * Called on the first byte and then at most once per `idleTimeoutMs / 4`.
   *
   * The liveness signal the interface shows: "last activity 3s ago" is a
   * different fact from "running for 40 minutes", and a person watching a run
   * needs both.
   */
  onActivity?: (at: Date) => void;
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
/** How long `close` may lag `exit` before the result is settled without it. */
export const EXIT_CLOSE_GRACE_MS = 5_000;
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
export class ProcessManager implements ProcessRunner {
  private readonly live = new Set<ChildProcess>();
  /**
   * Why a given child was stopped. Written by `terminate`, read by `run` once
   * the child closes - without it, a child killed by `cancelAll` would report
   * a perfectly ordinary `completed` outcome.
   */
  private readonly terminationReason = new WeakMap<ChildProcess, ProcessOutcome>();
  /** Every stop attempt made on a child, for its trace. */
  private readonly terminationLog = new WeakMap<ChildProcess, TerminationAttempt[]>();
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
    const trace: ProcessTrace = {
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
      idleTimedOut: false,
      lastActivityAt: null,
      termination: null,
    };
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
      trace,
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
      trace.errorAt = new Date().toISOString();
      trace.errorCode = (err as NodeJS.ErrnoException)?.code ?? null;
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
    let outcome: ProcessOutcome = 'completed';
    let errorMessage: string | undefined;

    // Liveness. `resetIdle` is installed below, once the timer exists; until
    // then activity is still recorded, which matters because a child can write
    // before the timers are wired.
    let resetIdle: (() => void) | null = null;
    let lastReportedActivity = 0;
    const activityReportEveryMs = Math.max(250, Math.floor((options.idleTimeoutMs ?? 0) / 4));
    const noteActivity = (): void => {
      const at = new Date();
      trace.lastActivityAt = at.toISOString();
      resetIdle?.();
      // Throttled: a chatty stream must not turn into one IPC message per
      // chunk. The interface needs to know activity is happening, not how
      // many bytes arrived.
      if (options.onActivity && at.getTime() - lastReportedActivity >= activityReportEveryMs) {
        lastReportedActivity = at.getTime();
        try {
          options.onActivity(at);
        } catch {
          // A watcher that throws must never kill the process it is watching.
        }
      }
    };

    if (stdio === 'pipe') {
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        trace.firstStdoutAt ??= new Date().toISOString();
        trace.stdoutBytes += Buffer.byteLength(chunk, 'utf8');
        out.push(chunk);
        noteActivity();
        options.onStdout?.(chunk);
      });
      child.stderr?.on('data', (chunk: string) => {
        trace.firstStderrAt ??= new Date().toISOString();
        trace.stderrBytes += Buffer.byteLength(chunk, 'utf8');
        err.push(chunk);
        noteActivity();
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
    let idleTimer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    let lingerTimer: NodeJS.Timeout | undefined;
    // A stop in flight when the child closes: waited for before returning, so
    // the trace carries every attempt rather than the ones made so far.
    let pendingStop: Promise<void> | null = null;
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise) => {
        let settled = false;
        const settle = (code: number | null, sig: NodeJS.Signals | null): void => {
          if (settled) return;
          settled = true;
          resolvePromise({ code, signal: sig });
        };

        // A stop that leaves the child alive must still let `run` return:
        // the result says the child survived, and the trace says what was
        // tried. Waiting for a `close` that never comes helps nobody.
        const stop = (reason: ProcessOutcome): void => {
          pendingStop = (async () => {
            await this.terminate(child, graceMs, reason);
            if (!settled && child.exitCode === null && child.signalCode === null) {
              trace.survivedTermination = true;
              settle(null, null);
            }
          })();
        };

        child.on('error', (e: Error) => {
          trace.errorAt = new Date().toISOString();
          trace.errorCode = (e as NodeJS.ErrnoException).code ?? null;
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
            errorMessage = `Process exceeded its ${Math.round(options.timeoutMs! / 1000)}s timeout.`;
            stop('timeout');
          }, options.timeoutMs);
        }

        // The idle deadline: stopped for saying nothing, not for taking long.
        // Reported separately from the hard timeout so the diagnosis can name
        // which one was crossed - "40 minutes of work" and "40 minutes of
        // silence" call for opposite responses.
        if (options.idleTimeoutMs && options.idleTimeoutMs > 0) {
          const idleMs = options.idleTimeoutMs;
          const fire = (): void => {
            outcome = 'timeout';
            trace.idleTimedOut = true;
            errorMessage =
              `Process produced no output for ${Math.round(idleMs / 1000)}s` +
              (trace.lastActivityAt ? ` (last activity ${trace.lastActivityAt}).` : ' and never started.');
            stop('timeout');
          };
          idleTimer = setTimeout(fire, idleMs);
          resetIdle = (): void => {
            if (settled) return;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(fire, idleMs);
          };
        }

        if (options.signal) {
          onAbort = (): void => {
            if (outcome === 'completed') {
              outcome = 'cancelled';
              errorMessage = 'Cancelled by the orchestrator.';
            }
            stop('cancelled');
          };
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      },
    );

    if (timer) clearTimeout(timer);
    if (idleTimer) clearTimeout(idleTimer);
    resetIdle = null;
    if (lingerTimer) clearTimeout(lingerTimer);
    if (pendingStop) await pendingStop;
    const attempts = this.terminationLog.get(child);
    const reason = this.terminationReason.get(child);
    if (reason && attempts) trace.termination = { reason, attempts };
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
    const attempts: TerminationAttempt[] = [];
    this.terminationLog.set(child, attempts);
    const record = (method: string, exited: boolean): void => {
      attempts.push({ method, at: new Date().toISOString(), exited });
    };

    if (process.platform === 'win32') {
      // Ask politely first (no /F), then force the tree.
      await runTaskkill(['/pid', String(pid), '/T']);
      const polite = await waitForExit(child, graceMs);
      record(`taskkill /pid ${pid} /T`, polite);
      if (polite) return;
      await runTaskkill(['/pid', String(pid), '/T', '/F']);
      record(`taskkill /pid ${pid} /T /F`, await waitForExit(child, graceMs));
      return;
    }

    // POSIX: signal the whole process group (negative pid). `detached: true`
    // at spawn time made the child a group leader.
    killGroup(pid, 'SIGTERM');
    const term = await waitForExit(child, graceMs);
    record('SIGTERM (process group)', term);
    if (term) return;
    killGroup(pid, 'SIGKILL');
    record('SIGKILL (process group)', await waitForExit(child, graceMs));
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
      child.off('exit', onExit);
      resolvePromise(false);
    }, ms);
    // `exit` is the process being gone, which is the question here; `close`
    // also needs the pipes, which another process may be holding.
    const onExit = (): void => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    child.once('exit', onExit);
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
