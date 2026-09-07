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

import {
  REQUEST_CHANNELS,
  type IpcMap,
  type IpcResult,
  type RequestChannel,
} from '../shared/ipc-contract.js';
import { IpcValidationError, REQUEST_VALIDATORS } from '../shared/validation.js';
import { RecordNotFoundError } from './core.js';
import type { AppServices } from './services/app-services.js';
import { toMessageView } from './services/views.js';

/** Capabilities the router needs that only the shell can provide. */
export interface ShellBridge {
  /** Opens the native folder picker. Resolves to null when cancelled. */
  selectFolder(): Promise<string | null>;
  appInfo(): {
    appVersion: string;
    electronVersion: string;
    nodeVersion: string;
    chromeVersion: string;
    packaged: boolean;
  };
  /** Hands an already-validated http(s) URL to the system browser. */
  openExternal(url: string): Promise<boolean>;
  /** Opens a folder the application itself recorded, in the file manager. */
  openPath(path: string): Promise<boolean>;
  /** The OS "open at login" item. Null where the platform has none for the app. */
  startWithSystem(): boolean | null;
  setStartWithSystem(enabled: boolean): boolean | null;
}

export type Handler = (payload: unknown) => Promise<unknown> | unknown;

export class IpcRouter {
  private readonly handlers = new Map<RequestChannel, Handler>();

  constructor(
    private readonly services: AppServices,
    private readonly shell: ShellBridge,
  ) {
    this.register();
  }

  get channels(): readonly RequestChannel[] {
    return [...this.handlers.keys()];
  }

  /** Validates, dispatches and wraps. Never throws. */
  async handle(channel: string, rawPayload: unknown): Promise<IpcResult<unknown>> {
    const handler = this.handlers.get(channel as RequestChannel);
    if (!handler) {
      return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: `Unknown channel ${channel}` } };
    }
    try {
      const validate = REQUEST_VALIDATORS[channel as RequestChannel];
      const payload = validate(rawPayload ?? undefined, channel);
      const value = await handler(payload);
      return { ok: true, value: value ?? null };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  }

  private register(): void {
    const s = this.services;

    this.handlers.set('app.setStartWithSystem', (p) => ({
      startWithSystem: this.shell.setStartWithSystem((p as { enabled: boolean }).enabled),
    }));
    this.handlers.set('app.info', () => ({
      ...this.shell.appInfo(),
      startWithSystem: this.shell.startWithSystem(),
      platform: process.platform,
      arch: process.arch,
      sqliteAvailable: s.database.schemaVersion > 0,
    }));

    this.handlers.set('app.openExternal', async (p) => ({
      opened: await this.shell.openExternal((p as { url: string }).url),
    }));

    // The settings table already exists; these two channels are the interface's
    // read and write of it. No new storage, no second source of truth.
    // Encrypted secrets (`*.enc`) stay in the main process: the renderer has
    // no key for them and no reason to hold them.
    this.handlers.set('settings.all', () =>
      Object.fromEntries(Object.entries(s.database.settings.all()).filter(([key]) => !key.endsWith('.enc'))),
    );
    this.handlers.set('settings.set', (p) => {
      const { key, value } = p as { key: string; value: string };
      if (key.endsWith('.enc')) throw new IpcValidationError('payload.key is not a setting the interface may write');
      s.database.settings.set(key, value);
      return { saved: true };
    });

    this.handlers.set('runtime.diagnose', () => s.runtimes.diagnose());
    this.handlers.set('runtime.install', (p) =>
      s.runtimes.install((p as { runtimeId: 'codex' | 'claude-code' | 'git' }).runtimeId),
    );
    this.handlers.set('runtime.cancelInstall', (p) => ({
      cancelled: s.runtimes.cancelInstall(
        (p as { runtimeId: 'codex' | 'claude-code' | 'git' }).runtimeId,
      ),
    }));

    this.handlers.set('accounts.list', () => s.accounts.list());
    this.handlers.set('accounts.create', (p) => {
      const input = p as { name: string; provider: 'anthropic' | 'openai' };
      const view = s.accounts.create(input.name, input.provider);
      s.agents.sync();
      return view;
    });
    this.handlers.set('accounts.connect', (p) => s.accounts.connect((p as { accountId: string }).accountId));
    this.handlers.set('accounts.cancelConnect', (p) => ({
      cancelled: s.accounts.cancelConnect((p as { accountId: string }).accountId),
    }));
    this.handlers.set('accounts.status', (p) => s.accounts.status((p as { accountId: string }).accountId));
    this.handlers.set('accounts.remove', (p) => ({
      removed: s.accounts.remove((p as { accountId: string }).accountId),
    }));

    this.handlers.set('github.status', () => s.github.status());
    this.handlers.set('github.configure', (p) => s.github.configure((p as { clientId: string }).clientId));
    this.handlers.set('github.connect', () => s.github.connect());
    this.handlers.set('github.cancelConnect', () => ({ cancelled: s.github.cancelConnect() }));
    this.handlers.set('github.disconnect', () => s.github.disconnect());
    this.handlers.set('github.repositories', () => s.github.repositories());
    this.handlers.set('github.branches', (p) =>
      s.github.branches((p as { repository: string }).repository),
    );
    this.handlers.set('github.pullRequestStatus', (p) =>
      s.workspaces.pullRequestStatus((p as { workspaceId: string }).workspaceId),
    );
    this.handlers.set('github.createPullRequest', (p) => {
      const input = p as IpcMap['github.createPullRequest']['request'];
      return s.workspaces.createPullRequest(input);
    });
    this.handlers.set('workspace.fetch', (p) => s.workspaces.fetch((p as { workspaceId: string }).workspaceId));
    this.handlers.set('workspace.createBranch', (p) => {
      const input = p as { workspaceId: string; name: string };
      return s.workspaces.createBranch(input.workspaceId, input.name);
    });
    this.handlers.set('workspace.commit', (p) => {
      const input = p as { workspaceId: string; message: string };
      return s.workspaces.commit(input.workspaceId, input.message);
    });
    this.handlers.set('workspace.push', (p) => s.workspaces.push((p as { workspaceId: string }).workspaceId));

    this.handlers.set('workspace.openProject', (payload) =>
      s.workspaces.openFolder((payload as { localPath: string }).localPath, s.projects),
    );
    this.handlers.set('agents.list', () => s.agents.list());
    this.handlers.set('agents.status', () => s.agents.status());

    this.handlers.set('workspace.list', () => s.workspaces.listWithBranches());
    this.handlers.set('workspace.selectFolder', async () => ({
      path: await this.shell.selectFolder(),
    }));
    this.handlers.set('workspace.create', (p) =>
      s.workspaces.create(p as { name: string; localPath: string; repositoryUrl?: string }),
    );
    this.handlers.set('workspace.createCloud', (p) =>
      s.workspaces.createCloud(p as IpcMap['workspace.createCloud']['request']),
    );
    this.handlers.set('workspace.setBudget', (p) => {
      const input = p as IpcMap['workspace.setBudget']['request'];
      return s.workspaces.setBudget(input.workspaceId, {
        maxInvocations: input.maxInvocations,
        maxTokens: input.maxTokens,
        maxCostUsd: input.maxCostUsd,
      });
    });
    this.handlers.set('workspace.createConversation', (p) =>
      s.workspaces.createConversation(p as IpcMap['workspace.createConversation']['request']),
    );

    // Connections. Note what is absent: there is no channel that returns a
    // credential. Keys go in and never come back out.
    this.handlers.set('connections.list', () => s.connections.list());
    this.handlers.set('connections.addApi', (p) =>
      s.connections.addApiConnection(p as IpcMap['connections.addApi']['request']),
    );
    this.handlers.set('connections.replaceKey', (p) => {
      const input = p as IpcMap['connections.replaceKey']['request'];
      return s.connections.replaceKey(input.connectionId, input.apiKey);
    });
    this.handlers.set('connections.rename', (p) => {
      const input = p as IpcMap['connections.rename']['request'];
      return s.connections.rename(input.connectionId, input.displayName);
    });
    this.handlers.set('connections.setEnabled', (p) => {
      const input = p as IpcMap['connections.setEnabled']['request'];
      return s.connections.setApiEnabled(input.connectionId, input.enabled);
    });
    this.handlers.set('connections.setPreferences', (p) => {
      const input = p as IpcMap['connections.setPreferences']['request'];
      return s.connections.setPreferences(input.connectionId, input.model, input.reasoning);
    });
    this.handlers.set('connections.disconnect', (p) =>
      s.connections.disconnect((p as IpcMap['connections.disconnect']['request']).connectionId),
    );
    this.handlers.set('connections.test', async (p) => {
      const status = await s.connections.test(
        (p as IpcMap['connections.test']['request']).connectionId,
      );
      // Only what the interface needs. The connection id and provider are
      // already known to the caller, and nothing else here is worth widening.
      return {
        authenticated: status.authenticated,
        ...(status.method ? { method: status.method } : {}),
        ...(status.problem ? { problem: status.problem } : {}),
        ...(status.remedy ? { remedy: status.remedy } : {}),
        checkedAt: status.checkedAt,
      };
    });
    this.handlers.set('connections.models', async (p) => {
      const models = await s.connections.models(
        (p as IpcMap['connections.models']['request']).connectionId,
      );
      return models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        createdAt: model.createdAt ?? null,
      }));
    });

    this.handlers.set('workspace.setPublish', (p) => {
      const input = p as IpcMap['workspace.setPublish']['request'];
      return s.workspaces.setPublish(input.workspaceId, {
        enabled: input.enabled,
        pullRequest: input.pullRequest,
      });
    });
    this.handlers.set('workspace.clone', (p) =>
      s.workspaces.clone(p as { repositoryUrl: string; parentPath: string; name: string }),
    );
    this.handlers.set('workspace.setAgents', (p) => {
      const input = p as { workspaceId: string; orchestratorAgentId: string; workerAgentId: string };
      return s.workspaces.setAgents(input.workspaceId, input.orchestratorAgentId, input.workerAgentId);
    });
    this.handlers.set('workspace.setTeam', (p) => {
      const input = p as IpcMap['workspace.setTeam']['request'];
      // `workers` wins when it is present; `worker` alone remains the shape a
      // single-worker project saves, and behaves identically.
      return s.workspaces.setTeam(
        input.workspaceId,
        input.orchestrator,
        input.workers && input.workers.length > 0 ? input.workers : input.worker,
      );
    });
    this.handlers.set('workspace.rename', (p) => {
      const input = p as { workspaceId: string; name: string };
      return s.workspaces.rename(input.workspaceId, input.name);
    });
    this.handlers.set('workspace.remove', (p) => ({
      removed: s.workspaces.remove((p as { workspaceId: string }).workspaceId),
    }));
    this.handlers.set('workspace.branches', (p) =>
      s.workspaces.branches((p as { workspaceId: string }).workspaceId),
    );
    this.handlers.set('workspace.checkout', (p) => {
      const input = p as { workspaceId: string; branch: string; allowDirty?: boolean };
      return s.workspaces.checkout(input.workspaceId, input.branch, input.allowDirty ?? false);
    });
    this.handlers.set('workspace.openFolder', async (p) => {
      // The path is the workspace's own, read from the database - the
      // renderer names a project id, never a path.
      const workspace = s.workspaces.require((p as { workspaceId: string }).workspaceId);
      return { opened: await this.shell.openPath(workspace.localPath) };
    });
    this.handlers.set('workspace.changes', (p) =>
      s.workspaces.changes((p as { workspaceId: string }).workspaceId),
    );

    // The project's own verifications: configuration a person writes, which the
    // loop then resolves by id. Four domain operations over the existing
    // `verification_definitions` table - nothing here runs a command.
    this.handlers.set('verifications.list', (p) =>
      s.verifications.list((p as { workspaceId: string }).workspaceId),
    );
    this.handlers.set('verifications.create', (p) =>
      s.verifications.create(
        p as { workspaceId: string; id: string; label: string; command: string },
      ),
    );
    this.handlers.set('verifications.update', (p) =>
      s.verifications.update(
        p as {
          workspaceId: string;
          id: string;
          label?: string;
          command?: string;
          enabled?: boolean;
        },
      ),
    );
    this.handlers.set('verifications.remove', (p) => ({
      removed: s.verifications.remove(p as { workspaceId: string; id: string }),
    }));

    this.handlers.set('chat.listSessions', (p) => {
      const input = p as IpcMap['chat.listSessions']['request'];
      return s.chat.listSessions(input.workspaceId, {
        ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
        ...(input.query !== undefined ? { query: input.query } : {}),
      });
    });
    this.handlers.set('chat.renameSession', (p) => {
      const input = p as IpcMap['chat.renameSession']['request'];
      return s.chat.renameSession(input.sessionId, input.title);
    });
    this.handlers.set('chat.archiveSession', (p) => {
      const input = p as IpcMap['chat.archiveSession']['request'];
      return s.chat.archiveSession(input.sessionId, input.archived);
    });
    this.handlers.set('chat.deleteSession', (p) => ({
      deleted: s.chat.deleteSession((p as { sessionId: string }).sessionId),
    }));
    this.handlers.set('chat.createSession', (p) => {
      const input = p as { workspaceId: string; title: string; projectId?: string | null };
      return s.chat.createSession(input.workspaceId, input.title, input.projectId ?? null);
    });
    this.handlers.set('chat.listAllSessions', (p) => {
      const input = p as IpcMap['chat.listAllSessions']['request'];
      return s.chat.listAllSessions({
        ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
        ...(input.query !== undefined ? { query: input.query } : {}),
      });
    });
    this.handlers.set('chat.moveSession', (p) => {
      const input = p as IpcMap['chat.moveSession']['request'];
      return s.chat.moveSession(input.sessionId, input.projectId);
    });
    this.handlers.set('project.list', () => s.projects.list());
    this.handlers.set('project.create', (p) => s.projects.create(p as IpcMap['project.create']['request']));
    this.handlers.set('project.rename', (p) => {
      const input = p as IpcMap['project.rename']['request'];
      return s.projects.rename(input.projectId, input.name);
    });
    this.handlers.set('project.setWorkspace', (p) => {
      const input = p as IpcMap['project.setWorkspace']['request'];
      return s.projects.setWorkspace(input.projectId, input.workspaceId);
    });
    this.handlers.set('project.remove', (p) => s.projects.remove((p as { projectId: string }).projectId));
    this.handlers.set('chat.listMessages', (p) =>
      s.chat.listMessages((p as { sessionId: string }).sessionId),
    );
    this.handlers.set('chat.sendMessage', async (p) => {
      const input = p as { sessionId: string; text: string };
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
    this.handlers.set('cloud.connect', (p) =>
      s.cloudAccount.connect(p as IpcMap['cloud.connect']['request']),
    );
    this.handlers.set('cloud.disconnect', () => s.cloudAccount.disconnect());
    this.handlers.set('cloud.sync', async () => ({ applied: await s.cloud.syncAll() }));

    this.handlers.set('run.get', (p) => s.orchestration.view((p as { runId: string }).runId));
    this.handlers.set('run.list', (p) =>
      s.orchestration.listForWorkspace((p as { workspaceId: string }).workspaceId),
    );
    this.handlers.set('run.detail', (p) => s.orchestration.detail((p as { runId: string }).runId));
    this.handlers.set('run.cancel', async (p) => {
      const runId = (p as { runId: string }).runId;
      // A cloud run is not executing here, so cancelling it locally would stop
      // nothing and tell the person it had. The cancellation has to reach the
      // coordinator, which is the only thing that can end it - and the only
      // thing that can stop the meter.
      const run = s.database.runs.find(runId);
      if (run?.remote_run_id) return { cancelled: await s.cloud.cancel(runId) };
      return { cancelled: s.orchestration.cancel(runId) };
    });

    assertCoversEveryChannel(this.handlers);
  }
}

/**
 * The contract lists the channels; this proves the router implements all of
 * them and nothing more. It runs at construction, so a mismatch is a crash on
 * boot rather than a channel that silently returns UNKNOWN_CHANNEL in the field.
 */
function assertCoversEveryChannel(handlers: ReadonlyMap<RequestChannel, Handler>): void {
  const missing = REQUEST_CHANNELS.filter((channel) => !handlers.has(channel));
  const extra = [...handlers.keys()].filter(
    (channel) => !(REQUEST_CHANNELS as readonly string[]).includes(channel),
  );
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `IPC router does not match the contract. Missing: ${missing.join(', ') || 'none'}; ` +
        `unexpected: ${extra.join(', ') || 'none'}`,
    );
  }
}

function describe(error: unknown): { code: string; message: string } {
  if (error instanceof IpcValidationError) return { code: error.code, message: error.message };
  if (error instanceof RecordNotFoundError) {
    return { code: error.code, message: 'Esse item não existe mais.' };
  }
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; userMessage?: unknown; message?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code : 'ERROR';
    const message =
      typeof candidate.userMessage === 'string'
        ? candidate.userMessage
        : typeof candidate.message === 'string'
          ? candidate.message
          : 'Algo deu errado.';
    return { code, message };
  }
  return { code: 'ERROR', message: 'Algo deu errado.' };
}
