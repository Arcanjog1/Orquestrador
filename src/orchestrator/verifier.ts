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
import { resolveExecutable } from '../preflight/preflight.js';

export interface VerifierOptions {
  cwd: string;
  timeoutMs: number;
  processManager: ProcessManager;
  /** Cancels any in-flight command. */
  signal?: AbortSignal;
  /** Called before each command so the CLI can log it. */
  onCommandStart?: (command: string) => void;
  /** Called after each command with its result. */
  onCommandFinish?: (result: CommandResult) => void;
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

    // Resolve through PATH/PATHEXT so `npm` finds `npm.cmd` on Windows, and so
    // the ProcessManager gets a concrete path it knows how to launch.
    const resolved = (await resolveExecutable(executable, this.options.processManager)) ?? executable;

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
