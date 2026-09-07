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

import type { CommandResult } from '../core/types.js';
import { parseCommandLine, screenCommand } from '../git/git-safety.js';
import { ProcessManager } from '../process/process-manager.js';
import type { ProcessRunner } from '../execution/process-runner.js';
import { resolveExecutable } from '../preflight/preflight.js';

export interface VerifierOptions {
  cwd: string;
  timeoutMs: number;
  processManager: ProcessRunner;
  /** Cancels any in-flight command. */
  signal?: AbortSignal;
  /** Called before each command so the CLI can log it. */
  onCommandStart?: (command: string) => void;
  /** Called after each command with its result. */
  onCommandFinish?: (result: CommandResult) => void;
  /**
   * Turns a command name into something the runner can launch.
   *
   * This has to be the *environment's* answer, not this machine's. The local
   * default walks PATH and PATHEXT so `npm` finds `npm.cmd` on Windows and
   * checks the file really exists - all of which are facts about the computer
   * the resolver runs on. Asking them about a command that will execute inside
   * a container answers about the wrong filesystem, and on Windows it also
   * runs `where.exe` in this process's own directory, which is a child process
   * escaping the execution boundary entirely.
   *
   * A remote environment therefore passes a resolver that hands the name
   * straight through: its own spawn resolves PATH inside the workspace, which
   * is the only place that can answer correctly.
   */
  resolveCommand?: (command: string) => Promise<string | null>;
}

export class Verifier {
  constructor(private readonly options: VerifierOptions) {}

  /** Runs every command in order and returns one result per command. */
  async runAll(commands: readonly string[]): Promise<CommandResult[]> {
    const results: CommandResult[] = [];
    for (const command of commands) {
      if (this.options.signal?.aborted) break;
      const result = await this.runOne(command);
      results.push(result);
      this.options.onCommandFinish?.(result);
    }
    return results;
  }

  async runOne(commandLine: string): Promise<CommandResult> {
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
    const [executable, ...args] = tokens as [string, ...string[]];

    // Resolved by the environment, not by this machine: see `resolveCommand`.
    const resolve = this.options.resolveCommand
      ?? ((command: string) => resolveExecutable(command, this.options.processManager));
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
export function commandPassed(result: CommandResult): boolean {
  return !result.refused && !result.timedOut && result.exitCode === 0;
}

/** One-line summary used in logs and in the final report. */
export function summariseResults(results: readonly CommandResult[]): string {
  if (results.length === 0) return 'no verification commands';
  const passed = results.filter(commandPassed).length;
  return `${passed}/${results.length} verification commands passed`;
}
