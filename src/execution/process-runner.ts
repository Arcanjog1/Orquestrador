/**
 * The execution boundary.
 *
 * Everything the orchestration loop does to a workspace - collecting git
 * evidence, running a verification, invoking Codex or Claude Code - it does by
 * starting a child process in a working directory. That is the *whole* of its
 * dependency on the machine it runs on.
 *
 * Naming that dependency as an interface is what lets the same loop run in two
 * places without a second loop:
 *
 *   - `ProcessManager` (local): spawns on this computer, in a folder the user
 *     chose. This is what the desktop has always done and still does.
 *   - a remote runner: forwards the same request into an isolated workspace
 *     somewhere else, and brings back the same result.
 *
 * `ProcessManager` already had exactly this shape; the interface simply says so
 * out loud, so a caller can be handed either without a cast. Nothing about the
 * local path changes.
 *
 * Note what is *not* on this interface: no shell, no "run this string". A
 * caller supplies a command and an argument vector, which is what keeps
 * model-authored text out of a command line - a property that must survive the
 * trip to a remote environment, not be given up at its border.
 */

import type { ProcessResult, RunProcessOptions } from '../process/process-manager.js';

export type { ProcessResult, RunProcessOptions };

/** Starts child processes somewhere. Local and remote both implement this. */
export interface ProcessRunner {
  /**
   * Runs one process to completion and reports what happened.
   *
   * Never rejects for a process that failed: a non-zero exit, a timeout, a
   * crash and a refused spawn all come back as a `ProcessResult` whose
   * `outcome` says which. Rejection is reserved for the runner itself being
   * unable to ask - a lost connection to a remote environment, say.
   */
  run(options: RunProcessOptions): Promise<ProcessResult>;
  /** Stops everything this runner still has in flight. */
  cancelAll(): Promise<void>;
}

/**
 * Where one run executes: a working directory and the runner that reaches it.
 *
 * The pair travels together on purpose. A path is meaningless without the
 * runner it belongs to - `/workspace/repo` inside a remote container is not a
 * path on the user's computer, and handing one to the other is the exact
 * mistake this type exists to make impossible.
 */
export interface ExecutionEnvironment {
  /** `local` for the user's own machine, `remote` for an isolated workspace. */
  readonly kind: 'local' | 'remote';
  /**
   * Identifies the environment for the record: the workspace id for a local
   * folder, the remote workspace id for a provisioned one.
   */
  readonly id: string;
  /** The absolute path of the repository **within this environment**. */
  readonly workingDirectory: string;
  readonly processes: ProcessRunner;
  /**
   * Releases whatever the environment holds. Local releases nothing; remote
   * returns the workspace so it can be reused, retained or torn down.
   */
  release?(): Promise<void>;
}

/** The user's own computer: the runner is the local ProcessManager. */
export function localEnvironment(
  id: string,
  workingDirectory: string,
  processes: ProcessRunner,
): ExecutionEnvironment {
  return { kind: 'local', id, workingDirectory, processes };
}
