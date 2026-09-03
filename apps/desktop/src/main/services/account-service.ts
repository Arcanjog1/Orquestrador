/**
 * What the interface is allowed to do with provider accounts.
 *
 * The user types "Claude Trabalho" and presses Conectar. Everything after
 * that - the account id, the private profile directory, the environment the
 * CLI is spawned with, the browser that opens - is the application's job, and
 * none of it reaches the renderer. In particular the sign-in URL never
 * crosses the bridge: it can carry a one-time code, the main process opens it
 * itself, and a web page has no reason to hold one.
 */

import type { Database } from '../../../../../src/database/database.js';
import type { ClaudeAccountManager } from '../../../../../src/accounts/claude-account-manager.js';
import {
  AccountError,
  type Account,
  type AccountStatus,
  type LoginProgress,
  type ProviderId,
} from '../../../../../src/accounts/account-types.js';
import type { LoginProgressEvent } from '../../shared/ipc-contract.js';
import { deriveAccountId } from '../../shared/validation.js';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

export interface AccountServiceOptions {
  database: Database;
  claudeAccounts: ClaudeAccountManager;
  emitLoginProgress: (event: LoginProgressEvent) => void;
  /** Opens a URL in the system browser. Electron passes `shell.openExternal`. */
  openExternal: (url: string) => void | Promise<void>;
}

export class AccountService {
  private readonly db: Database;
  private readonly claude: ClaudeAccountManager;
  private readonly emit: (event: LoginProgressEvent) => void;
  private readonly openExternal: (url: string) => void | Promise<void>;
  private readonly signingIn = new Map<string, AbortController>();

  constructor(options: AccountServiceOptions) {
    this.db = options.database;
    this.claude = options.claudeAccounts;
    this.emit = options.emitLoginProgress;
    this.openExternal = options.openExternal;
  }

  list(): Account[] {
    return this.db.accounts.list().map(toAccount);
  }

  /**
   * Creates an account from the name the user typed.
   *
   * The id is derived here and never accepted from the renderer, so no
   * caller can steer the profile directory.
   */
  create(providerId: ProviderId, displayName: string): Account {
    if (providerId !== 'anthropic') {
      throw new AccountError(
        'new',
        `${PROVIDER_LABELS[providerId]} ainda não pode ser conectado.`,
        'Voltar',
        `provider ${providerId} has no account manager in this phase`,
      );
    }

    const taken = this.db.accounts.list().map((row) => row.id);
    if (this.db.accounts.list(providerId).some((row) => row.display_name === displayName)) {
      throw new AccountError(
        'new',
        'Já existe uma conta com esse nome.',
        'Escolher outro nome',
        'display_name is unique per provider',
      );
    }

    const id = deriveAccountId(displayName, taken);
    const profileDirectory = this.claude.profileDirectory(id);

    this.db.accounts.ensureProvider(providerId, PROVIDER_LABELS[providerId]);
    const record = this.db.accounts.create({ id, providerId, displayName, profileDirectory });
    this.claude.createAccount(toAccount(record));
    return toAccount(record);
  }

  remove(accountId: string): { removed: boolean } {
    const record = this.requireAccount(accountId);
    // The manager refuses any path outside the profiles folder, so the
    // filesystem side goes first: a failure there must not orphan a row.
    this.claude.removeAccount(record.id);
    return { removed: this.db.accounts.remove(record.id) };
  }

  async status(accountId: string): Promise<AccountStatus> {
    const account = toAccount(this.requireAccount(accountId));
    const status = await this.claude.getStatus(account);
    this.db.accounts.recordStatus(account.id, status.state, status.authMethod ?? null);
    return status;
  }

  /**
   * Runs a sign-in, driven entirely from the interface.
   *
   * The URL the CLI prints is handed to `openExternal` here in the main
   * process; the renderer only learns that a browser was opened.
   */
  async connect(accountId: string): Promise<AccountStatus> {
    const account = toAccount(this.requireAccount(accountId));
    if (this.signingIn.has(account.id)) {
      throw new AccountError(
        account.id,
        'Esta conta já está sendo conectada.',
        'Aguardar',
        'a sign-in is already running for this account',
      );
    }

    const controller = new AbortController();
    this.signingIn.set(account.id, controller);
    let browserOpened = false;

    try {
      const status = await this.claude.connect(account, {
        signal: controller.signal,
        onProgress: (progress: LoginProgress) => {
          if (progress.url) browserOpened = true;
          this.emit({
            accountId: progress.accountId,
            phase: progress.phase,
            message: progress.message,
            browserOpened,
          });
        },
        openUrl: async (url) => {
          browserOpened = true;
          await this.openExternal(url);
        },
      });
      this.db.accounts.recordStatus(account.id, status.state, status.authMethod ?? null);
      return status;
    } finally {
      this.signingIn.delete(account.id);
    }
  }

  cancelConnect(accountId: string): { cancelled: boolean } {
    const controller = this.signingIn.get(accountId);
    if (!controller) return { cancelled: false };
    controller.abort();
    return { cancelled: true };
  }

  private requireAccount(accountId: string): ReturnType<Database['accounts']['find']> & object {
    const record = this.db.accounts.find(accountId);
    if (!record) {
      throw new AccountError(
        accountId,
        'Esta conta não existe mais.',
        'Atualizar',
        'no account row with that id',
      );
    }
    return record;
  }
}

function toAccount(record: {
  id: string;
  provider_id: string;
  display_name: string;
  last_connected_at: string | null;
  created_at: string;
}): Account {
  return {
    id: record.id,
    providerId: record.provider_id as ProviderId,
    displayName: record.display_name,
    createdAt: record.created_at,
    ...(record.last_connected_at ? { lastConnectedAt: record.last_connected_at } : {}),
  };
}
