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
/** The user's own computer: the runner is the local ProcessManager. */
export function localEnvironment(id, workingDirectory, processes) {
    return { kind: 'local', id, workingDirectory, processes };
}
//# sourceMappingURL=process-runner.js.map