/**
 * The IPC router: one place where every renderer request is validated and
 * dispatched.
 *
 * Every handler is reached the same way — look up the validator for the
 * channel, validate, call the service, wrap the outcome. A channel with no
 * entry in `REQUEST_VALIDATORS` cannot be registered, and a payload that fails
 * validation never reaches a service.
 *
 * Errors are turned into `{ ok: false, error }` data rather than thrown across
 * the bridge: an Electron IPC rejection stringifies the whole stack into the
 * renderer, which is both useless to a user and a needless leak of internals.
 */
import { REQUEST_CHANNELS, } from '../shared/ipc-contract.js';
import { IpcValidationError, REQUEST_VALIDATORS } from '../shared/validation.js';
import { RecordNotFoundError } from './core.js';
import { toMessageView } from './services/views.js';
export class IpcRouter {
    services;
    shell;
    handlers = new Map();
    constructor(services, shell) {
        this.services = services;
        this.shell = shell;
        this.register();
    }
    get channels() {
        return [...this.handlers.keys()];
    }
    /** Validates, dispatches and wraps. Never throws. */
    async handle(channel, rawPayload) {
        const handler = this.handlers.get(channel);
        if (!handler) {
            return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: `Unknown channel ${channel}` } };
        }
        try {
            const validate = REQUEST_VALIDATORS[channel];
            const payload = validate(rawPayload ?? undefined, channel);
            const value = await handler(payload);
            return { ok: true, value: value ?? null };
        }
        catch (error) {
            return { ok: false, error: describe(error) };
        }
    }
    register() {
        const s = this.services;
        this.handlers.set('app.setStartWithSystem', (p) => ({
            startWithSystem: this.shell.setStartWithSystem(p.enabled),
        }));
        this.handlers.set('app.info', () => ({
            ...this.shell.appInfo(),
            startWithSystem: this.shell.startWithSystem(),
            platform: process.platform,
            arch: process.arch,
            sqliteAvailable: s.database.schemaVersion > 0,
        }));
        this.handlers.set('app.openExternal', async (p) => ({
            opened: await this.shell.openExternal(p.url),
        }));
        // The settings table already exists; these two channels are the interface's
        // read and write of it. No new storage, no second source of truth.
        // Encrypted secrets (`*.enc`) stay in the main process: the renderer has
        // no key for them and no reason to hold them.
        this.handlers.set('settings.all', () => Object.fromEntries(Object.entries(s.database.settings.all()).filter(([key]) => !key.endsWith('.enc'))));
        this.handlers.set('settings.set', (p) => {
            const { key, value } = p;
            if (key.endsWith('.enc'))
                throw new IpcValidationError('payload.key is not a setting the interface may write');
            s.database.settings.set(key, value);
            return { saved: true };
        });
        this.handlers.set('runtime.diagnose', () => s.runtimes.diagnose());
        this.handlers.set('runtime.install', (p) => s.runtimes.install(p.runtimeId));
        this.handlers.set('runtime.cancelInstall', (p) => ({
            cancelled: s.runtimes.cancelInstall(p.runtimeId),
        }));
        this.handlers.set('accounts.list', () => s.accounts.list());
        this.handlers.set('accounts.create', (p) => {
            const input = p;
            const view = s.accounts.create(input.name, input.provider);
            s.agents.sync();
            return view;
        });
        this.handlers.set('accounts.connect', (p) => s.accounts.connect(p.accountId));
        this.handlers.set('accounts.cancelConnect', (p) => ({
            cancelled: s.accounts.cancelConnect(p.accountId),
        }));
        this.handlers.set('accounts.status', (p) => s.accounts.status(p.accountId));
        this.handlers.set('accounts.remove', (p) => ({
            removed: s.accounts.remove(p.accountId),
        }));
        this.handlers.set('github.status', () => s.github.status());
        this.handlers.set('github.configure', (p) => s.github.configure(p.clientId));
        this.handlers.set('github.connect', () => s.github.connect());
        this.handlers.set('github.cancelConnect', () => ({ cancelled: s.github.cancelConnect() }));
        this.handlers.set('github.disconnect', () => s.github.disconnect());
        this.handlers.set('github.repositories', () => s.github.repositories());
        this.handlers.set('github.branches', (p) => s.github.branches(p.repository));
        this.handlers.set('github.pullRequestStatus', (p) => s.workspaces.pullRequestStatus(p.workspaceId));
        this.handlers.set('github.createPullRequest', (p) => {
            const input = p;
            return s.workspaces.createPullRequest(input);
        });
        this.handlers.set('workspace.fetch', (p) => s.workspaces.fetch(p.workspaceId));
        this.handlers.set('workspace.createBranch', (p) => {
            const input = p;
            return s.workspaces.createBranch(input.workspaceId, input.name);
        });
        this.handlers.set('workspace.commit', (p) => {
            const input = p;
            return s.workspaces.commit(input.workspaceId, input.message);
        });
        this.handlers.set('workspace.push', (p) => s.workspaces.push(p.workspaceId));
        this.handlers.set('agents.list', () => s.agents.list());
        this.handlers.set('workspace.list', () => s.workspaces.listWithBranches());
        this.handlers.set('workspace.selectFolder', async () => ({
            path: await this.shell.selectFolder(),
        }));
        this.handlers.set('workspace.create', (p) => s.workspaces.create(p));
        this.handlers.set('workspace.createCloud', (p) => s.workspaces.createCloud(p));
        this.handlers.set('workspace.clone', (p) => s.workspaces.clone(p));
        this.handlers.set('workspace.setAgents', (p) => {
            const input = p;
            return s.workspaces.setAgents(input.workspaceId, input.orchestratorAgentId, input.workerAgentId);
        });
        this.handlers.set('workspace.setTeam', (p) => {
            const input = p;
            return s.workspaces.setTeam(input.workspaceId, input.orchestrator, input.worker);
        });
        this.handlers.set('workspace.rename', (p) => {
            const input = p;
            return s.workspaces.rename(input.workspaceId, input.name);
        });
        this.handlers.set('workspace.remove', (p) => ({
            removed: s.workspaces.remove(p.workspaceId),
        }));
        this.handlers.set('workspace.branches', (p) => s.workspaces.branches(p.workspaceId));
        this.handlers.set('workspace.checkout', (p) => {
            const input = p;
            return s.workspaces.checkout(input.workspaceId, input.branch, input.allowDirty ?? false);
        });
        this.handlers.set('workspace.openFolder', async (p) => {
            // The path is the workspace's own, read from the database - the
            // renderer names a project id, never a path.
            const workspace = s.workspaces.require(p.workspaceId);
            return { opened: await this.shell.openPath(workspace.localPath) };
        });
        this.handlers.set('workspace.changes', (p) => s.workspaces.changes(p.workspaceId));
        // The project's own verifications: configuration a person writes, which the
        // loop then resolves by id. Four domain operations over the existing
        // `verification_definitions` table - nothing here runs a command.
        this.handlers.set('verifications.list', (p) => s.verifications.list(p.workspaceId));
        this.handlers.set('verifications.create', (p) => s.verifications.create(p));
        this.handlers.set('verifications.update', (p) => s.verifications.update(p));
        this.handlers.set('verifications.remove', (p) => ({
            removed: s.verifications.remove(p),
        }));
        this.handlers.set('chat.listSessions', (p) => {
            const input = p;
            return s.chat.listSessions(input.workspaceId, {
                ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
                ...(input.query !== undefined ? { query: input.query } : {}),
            });
        });
        this.handlers.set('chat.renameSession', (p) => {
            const input = p;
            return s.chat.renameSession(input.sessionId, input.title);
        });
        this.handlers.set('chat.archiveSession', (p) => {
            const input = p;
            return s.chat.archiveSession(input.sessionId, input.archived);
        });
        this.handlers.set('chat.deleteSession', (p) => ({
            deleted: s.chat.deleteSession(p.sessionId),
        }));
        this.handlers.set('chat.createSession', (p) => {
            const input = p;
            return s.chat.createSession(input.workspaceId, input.title, input.projectId ?? null);
        });
        this.handlers.set('chat.listAllSessions', (p) => {
            const input = p;
            return s.chat.listAllSessions({
                ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
                ...(input.query !== undefined ? { query: input.query } : {}),
            });
        });
        this.handlers.set('chat.moveSession', (p) => {
            const input = p;
            return s.chat.moveSession(input.sessionId, input.projectId);
        });
        this.handlers.set('project.list', () => s.projects.list());
        this.handlers.set('project.create', (p) => s.projects.create(p));
        this.handlers.set('project.rename', (p) => {
            const input = p;
            return s.projects.rename(input.projectId, input.name);
        });
        this.handlers.set('project.setWorkspace', (p) => {
            const input = p;
            return s.projects.setWorkspace(input.projectId, input.workspaceId);
        });
        this.handlers.set('project.remove', (p) => s.projects.remove(p.projectId));
        this.handlers.set('chat.listMessages', (p) => s.chat.listMessages(p.sessionId));
        this.handlers.set('chat.sendMessage', async (p) => {
            const input = p;
            // Where the message goes is a property of the project, not of the
            // button: a cloud project's work is submitted to the coordinator, and
            // this window is then free to close.
            const session = s.database.chat.requireSession(input.sessionId);
            const workspace = s.database.workspaces.require(session.workspace_id);
            if (workspace.environment === 'cloud') {
                const message = s.database.chat.addMessage({
                    sessionId: session.id,
                    author: 'user',
                    body: input.text,
                });
                const run = await s.cloud.start({ sessionId: session.id, objective: input.text });
                s.database.chat.setMessageRun(message.id, run.id);
                return { message: toMessageView(message), run };
            }
            return s.chat.sendMessage(input.sessionId, input.text);
        });
        this.handlers.set('cloud.status', () => s.cloudAccount.status());
        this.handlers.set('cloud.connect', (p) => s.cloudAccount.connect(p));
        this.handlers.set('cloud.disconnect', () => s.cloudAccount.disconnect());
        this.handlers.set('cloud.sync', async () => ({ applied: await s.cloud.syncAll() }));
        this.handlers.set('run.get', (p) => s.orchestration.view(p.runId));
        this.handlers.set('run.list', (p) => s.orchestration.listForWorkspace(p.workspaceId));
        this.handlers.set('run.detail', (p) => s.orchestration.detail(p.runId));
        this.handlers.set('run.cancel', (p) => ({
            cancelled: s.orchestration.cancel(p.runId),
        }));
        assertCoversEveryChannel(this.handlers);
    }
}
/**
 * The contract lists the channels; this proves the router implements all of
 * them and nothing more. It runs at construction, so a mismatch is a crash on
 * boot rather than a channel that silently returns UNKNOWN_CHANNEL in the field.
 */
function assertCoversEveryChannel(handlers) {
    const missing = REQUEST_CHANNELS.filter((channel) => !handlers.has(channel));
    const extra = [...handlers.keys()].filter((channel) => !REQUEST_CHANNELS.includes(channel));
    if (missing.length > 0 || extra.length > 0) {
        throw new Error(`IPC router does not match the contract. Missing: ${missing.join(', ') || 'none'}; ` +
            `unexpected: ${extra.join(', ') || 'none'}`);
    }
}
function describe(error) {
    if (error instanceof IpcValidationError)
        return { code: error.code, message: error.message };
    if (error instanceof RecordNotFoundError) {
        return { code: error.code, message: 'Esse item não existe mais.' };
    }
    if (error && typeof error === 'object') {
        const candidate = error;
        const code = typeof candidate.code === 'string' ? candidate.code : 'ERROR';
        const message = typeof candidate.userMessage === 'string'
            ? candidate.userMessage
            : typeof candidate.message === 'string'
                ? candidate.message
                : 'Algo deu errado.';
        return { code, message };
    }
    return { code: 'ERROR', message: 'Algo deu errado.' };
}
//# sourceMappingURL=ipc-router.js.map