/**
 * Claude accounts, driven entirely from the interface.
 *
 * The user types a name. Everything else — the profile directory, the value of
 * CLAUDE_CONFIG_DIR, the auth subprocess, the sign-in URL — is the
 * application's business and never appears in the interface.
 *
 * `openUrl` is injected rather than imported so this service stays free of
 * Electron: the shell passes `shell.openExternal`, a test passes a spy.
 */

import type { Account, AuthState, Database, ProviderAccountManager } from '../core.js';
import { newId } from '../core.js';
import type { AccountView, ProviderName } from '../../shared/ipc-contract.js';
import type { EventBus } from '../events.js';
import {
  capabilityCeilingOf,
  reasoningCeilingOf,
  PREMIUM_MODELS,
} from '../../../../../src/routing/account-policy.js';

export type UrlOpener = (url: string) => void | Promise<void>;

/**
 * One manager per provider.
 *
 * They implement the same shape - own directory, own credential, ambient
 * credential never reported as connected - so everything below this line is
 * provider-agnostic and the service never branches on a vendor name.
 */
export interface AccountManagers {
  readonly anthropic: ProviderAccountManager;
  readonly openai: ProviderAccountManager;
}

const STAGE_LABELS: Record<string, string> = {
  starting: 'Preparando a conexão...',
  'awaiting-browser': 'Abrindo o navegador para você entrar...',
  'waiting-for-completion': 'Aguardando você concluir no navegador...',
  connected: 'Conta conectada.',
  failed: 'Não foi possível conectar.',
  cancelled: 'Conexão cancelada.',
};

export class AccountService {
  private readonly connecting = new Map<string, AbortController>();

  constructor(
    private readonly database: Database,
    private readonly managers: AccountManagers,
    private readonly events: EventBus,
    private readonly openUrl: UrlOpener,
  ) {}

  /** The manager that owns an account, chosen by its provider. */
  private managerFor(provider: string): ProviderAccountManager {
    const manager = (this.managers as unknown as Record<string, ProviderAccountManager | undefined>)[
      provider
    ];
    if (!manager) throw new Error(`No account manager for provider ${provider}`);
    return manager;
  }

  private managerForAccount(accountId: string): ProviderAccountManager {
    return this.managerFor(this.database.accounts.require(accountId).provider_id);
  }

  list(): AccountView[] {
    return this.database.accounts.list().map((row) => ({
      id: row.id,
      name: row.display_name,
      provider: row.provider_id,
      state: row.auth_state as AuthState,
      detail: detailFor(row.auth_state as AuthState),
      routing: routingViewOf(row),
    }));
  }

  /** Creates the account and the directory it owns, in that order. */
  create(name: string, provider: ProviderName = 'anthropic'): AccountView {
    const id = newId('acc');
    const manager = this.managerFor(provider);
    const account: Account = {
      id,
      providerId: provider,
      displayName: name,
      createdAt: new Date().toISOString(),
    };
    manager.createAccount(account);
    const record = this.database.accounts.create({
      id,
      providerId: provider,
      displayName: name,
      profileDirectory: manager.profileDirectory(id),
    });
    return {
      id: record.id,
      name: record.display_name,
      provider: record.provider_id,
      state: 'disconnected',
      detail: detailFor('disconnected'),
      routing: routingViewOf(record),
    };
  }

  /**
   * Runs the sign-in. Resolves when the CLI reports a usable credential, or
   * when it gives up; either way the account row is updated so a restart shows
   * the truth rather than an optimistic "connected".
   */
  async connect(accountId: string): Promise<AccountView> {
    const record = this.database.accounts.require(accountId);
    if (this.connecting.has(accountId)) {
      return this.viewOf(accountId, record.auth_state as AuthState, 'Conexão já em andamento.');
    }

    const controller = new AbortController();
    this.connecting.set(accountId, controller);

    const account: Account = {
      id: record.id,
      providerId: record.provider_id as Account['providerId'],
      displayName: record.display_name,
      createdAt: record.created_at,
    };

    try {
      const status = await this.managerForAccount(accountId).connect(account, {
        signal: controller.signal,
        openUrl: this.openUrl,
        onProgress: (progress) => {
          this.events.emit('account:progress', {
            accountId,
            stage: progress.phase,
            label: STAGE_LABELS[progress.phase] ?? progress.message,
            ...(progress.url ? { url: progress.url } : {}),
            ...(progress.code ? { code: progress.code } : {}),
          });
        },
      });
      this.database.accounts.updateAuth(accountId, status.state, status.authMethod ?? null);
      return this.viewOf(accountId, status.state, status.problem);
    } catch (error) {
      const message = userMessageFor(error);
      this.events.emit('account:progress', {
        accountId,
        stage: 'failed',
        label: message,
      });
      this.database.accounts.updateAuth(accountId, 'disconnected', null);
      return this.viewOf(accountId, 'disconnected', message);
    } finally {
      this.connecting.delete(accountId);
    }
  }

  cancelConnect(accountId: string): boolean {
    const controller = this.connecting.get(accountId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Asks the CLI, rather than trusting the stored row. */
  async status(accountId: string): Promise<AccountView> {
    const record = this.database.accounts.require(accountId);
    const status = await this.managerForAccount(accountId).getStatus({
      id: record.id,
      providerId: record.provider_id as Account['providerId'],
      displayName: record.display_name,
      createdAt: record.created_at,
    });
    this.database.accounts.updateAuth(accountId, status.state, status.authMethod ?? null);
    return this.viewOf(accountId, status.state, status.problem);
  }

  remove(accountId: string): boolean {
    const manager = this.managerForAccount(accountId);
    manager.removeAccount(accountId);
    return this.database.accounts.remove(accountId);
  }

  /**
   * Sets what one account is allowed to spend on.
   *
   * The tiers are validated at the IPC boundary; this stores them and returns
   * the account as the screen will show it. Nothing here touches any other
   * account - a ceiling is a property of the account, not a global setting.
   */
  setRoutingPolicy(input: {
    accountId: string;
    maxCapability: string | null;
    maxReasoning: string | null;
    allowPremiumModels: boolean;
  }): AccountView {
    const record = this.database.accounts.require(input.accountId);
    this.database.accounts.setRoutingPolicy(input.accountId, {
      maxCapability: capabilityCeilingOf(input.maxCapability),
      maxReasoning: reasoningCeilingOf(input.maxReasoning),
      allowPremiumModels: input.allowPremiumModels,
    });
    return this.viewOf(record.id, record.auth_state as AuthState);
  }

  private viewOf(accountId: string, state: AuthState, detail?: string): AccountView {
    const record = this.database.accounts.require(accountId);
    return {
      id: record.id,
      name: record.display_name,
      provider: record.provider_id,
      state,
      detail: detail ?? detailFor(state),
      routing: routingViewOf(record),
    };
  }
}

/**
 * The account's ceiling, as the screen reads it.
 *
 * `premiumModels` travels with it so the interface can name the models the
 * switch is about, instead of the person having to guess what "extra credits"
 * refers to.
 */
function routingViewOf(record: {
  max_capability: string | null;
  max_reasoning: string | null;
  allow_premium_models: number;
}): AccountView['routing'] {
  return {
    maxCapability: capabilityCeilingOf(record.max_capability),
    maxReasoning: reasoningCeilingOf(record.max_reasoning),
    allowPremiumModels: record.allow_premium_models === 1,
    premiumModels: [...PREMIUM_MODELS],
  };
}

function detailFor(state: AuthState): string {
  switch (state) {
    case 'connected':
      return 'Conta conectada.';
    case 'ambient-credential':
      return 'Entrou com uma credencial que não é desta conta. Conecte novamente para isolá-la.';
    case 'runtime-missing':
      return 'O runtime desta conta ainda não está configurado.';
    default:
      return 'Não conectada.';
  }
}

function userMessageFor(error: unknown): string {
  if (error && typeof error === 'object' && 'userMessage' in error) {
    const message = (error as { userMessage?: unknown }).userMessage;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'Não foi possível conectar a conta.';
}
