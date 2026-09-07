/**
 * The complete IPC surface of the application.
 *
 * Two rules make this file the security boundary of the desktop app:
 *
 *  1. **There is no generic channel.** No `exec`, no `shell`, no `runCommand`,
 *     no pass-through `invoke`. A renderer can only ask for the operations
 *     enumerated here, by name, and every one of them is a *domain* operation
 *     ("install the codex runtime"), never a *machine* operation ("run this
 *     string").
 *  2. **The channel list is closed.** `REQUEST_CHANNELS` is the whole set. The
 *     main process registers exactly these and nothing else; the preload
 *     exposes exactly these and nothing else. Tests assert all three sides
 *     agree, so a channel cannot be added on one side alone.
 */
/* ------------------------------------------------------------------ *
 * Request channels: renderer → main, request/response.
 * ------------------------------------------------------------------ */
export const REQUEST_CHANNELS = [
    'app.info',
    'app.setStartWithSystem',
    'app.openExternal',
    'settings.all',
    'settings.set',
    'runtime.diagnose',
    'runtime.install',
    'runtime.cancelInstall',
    'accounts.list',
    'accounts.create',
    'accounts.connect',
    'accounts.cancelConnect',
    'accounts.status',
    'accounts.remove',
    'github.status',
    'github.configure',
    'github.connect',
    'github.cancelConnect',
    'github.disconnect',
    'github.repositories',
    'github.branches',
    'github.pullRequestStatus',
    'github.createPullRequest',
    'workspace.fetch',
    'workspace.createBranch',
    'workspace.commit',
    'workspace.push',
    'agents.list',
    'workspace.list',
    'workspace.selectFolder',
    'workspace.create',
    'workspace.createCloud',
    'workspace.clone',
    'workspace.setAgents',
    'workspace.setTeam',
    'workspace.changes',
    'workspace.rename',
    'workspace.remove',
    'workspace.branches',
    'workspace.checkout',
    'workspace.openFolder',
    'cloud.status',
    'cloud.connect',
    'cloud.disconnect',
    'cloud.sync',
    'verifications.list',
    'verifications.create',
    'verifications.update',
    'verifications.remove',
    'project.list',
    'project.create',
    'project.rename',
    'project.setWorkspace',
    'project.remove',
    'chat.listSessions',
    'chat.listAllSessions',
    'chat.moveSession',
    'chat.createSession',
    'chat.renameSession',
    'chat.archiveSession',
    'chat.deleteSession',
    'chat.listMessages',
    'chat.sendMessage',
    'run.get',
    'run.list',
    'run.detail',
    'run.cancel',
];
/* ------------------------------------------------------------------ *
 * Event channels: main → renderer, one-way notifications.
 * ------------------------------------------------------------------ */
export const EVENT_CHANNELS = [
    'runtime:progress',
    'account:progress',
    'run:progress',
];
/**
 * The reasoning levels a person can pick by name. Each is validated against
 * the installed CLI before it is sent: a level the CLI does not declare is
 * replaced by the strongest one it does, and the run says so.
 */
export const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
/**
 * How the worker's model is chosen for a project. Mirrors the core's
 * `WORKER_SELECTIONS` (a test keeps them equal); spelled here so the renderer
 * needs nothing from the core.
 *
 *  - `auto`     the router decides per delegation (default)
 *  - `speed`    auto, leaning one tier down when the task is plainly safe
 *  - `quality`  auto, leaning one tier up
 *  - `manual`   the model and reasoning the person typed, exactly
 */
export const WORKER_SELECTIONS = ['auto', 'speed', 'quality', 'manual'];
//# sourceMappingURL=ipc-contract.js.map