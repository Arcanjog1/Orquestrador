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

    this.handlers.set('app.info', () => ({
      ...this.shell.appInfo(),
      platform: process.platform,
      arch: process.arch,
      sqliteAvailable: s.database.schemaVersion > 0,
    }));

    this.handlers.set('app.openExternal', async (p) => ({
      opened: await this.shell.openExternal((p as { url: string }).url),
    }));

    // The settings table already exists; these two channels are the interface's
    // read and write of it. No new storage, no second source of truth.
    this.handlers.set('settings.all', () => s.database.settings.all());
    this.handlers.set('settings.set', (p) => {
      const { key, value } = p as { key: string; value: string };
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

    this.handlers.set('agents.list', () => s.agents.list());

    this.handlers.set('workspace.list', () => s.workspaces.listWithBranches());
    this.handlers.set('workspace.selectFolder', async () => ({
      path: await this.shell.selectFolder(),
    }));
    this.handlers.set('workspace.create', (p) =>
      s.workspaces.create(p as { name: string; localPath: string; repositoryUrl?: string }),
    );
    this.handlers.set('workspace.clone', (p) =>
      s.workspaces.clone(p as { repositoryUrl: string; parentPath: string; name: string }),
    );
    this.handlers.set('workspace.setAgents', (p) => {
      const input = p as { workspaceId: string; orchestratorAgentId: string; workerAgentId: string };
      return s.workspaces.setAgents(input.workspaceId, input.orchestratorAgentId, input.workerAgentId);
    });
    this.handlers.set('workspace.setTeam', (p) => {
      const input = p as IpcMap['workspace.setTeam']['request'];
      return s.workspaces.setTeam(input.workspaceId, input.orchestrator, input.worker);
    });

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
      const input = p as { workspaceId: string; title: string };
      return s.chat.createSession(input.workspaceId, input.title);
    });
    this.handlers.set('chat.listMessages', (p) =>
      s.chat.listMessages((p as { sessionId: string }).sessionId),
    );
    this.handlers.set('chat.sendMessage', (p) => {
      const input = p as { sessionId: string; text: string };
      return s.chat.sendMessage(input.sessionId, input.text);
    });

    this.handlers.set('run.get', (p) => s.orchestration.view((p as { runId: string }).runId));
    this.handlers.set('run.list', (p) =>
      s.orchestration.listForWorkspace((p as { workspaceId: string }).workspaceId),
    );
    this.handlers.set('run.cancel', (p) => ({
      cancelled: s.orchestration.cancel((p as { runId: string }).runId),
    }));

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
