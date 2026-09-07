/**
 * Provider connections: the identities the orchestrator and the workers run as.
 *
 * A connection is an account plus how it authenticates. Two of them may be the
 * same vendor with different credentials - "Claude Trabalho 1" and "Claude
 * Trabalho 2" - which is the whole reason this is keyed by connection and not
 * by provider. There is no second adapter for the second Claude: there are two
 * connections, and the adapter is built once per connection.
 *
 * Two kinds:
 *
 *  - `cli` - the vendor's official tool, signed in by the person through the
 *    tool's own flow. This is what every account created before this file
 *    existed is, it keeps working untouched, and it is the path that runs on a
 *    subscription. The application never sees the credential.
 *  - `api` - the vendor's HTTP API with a key the person pastes. Metered,
 *    billed apart from any subscription, and **off until switched on**.
 *
 * The rules about the key, enforced here rather than trusted to callers:
 *
 *  1. The plaintext is written to the encrypted store and nowhere else. Not to
 *     `accounts`, not to a log, not to a URL, not to argv, not to a project
 *     file, not to the renderer's state.
 *  2. It is never returned. `list()` returns a hint - the last four characters
 *     - and nothing that could be sent anywhere.
 *  3. Removing a connection removes its secret. Migrating never removes one.
 */

import type { Database } from '../core.js';
import { newId } from '../core.js';
import type { SecretStore } from './github-service.js';
import type { EventBus } from '../events.js';
import { OpenAiApiProvider } from '../../../../../src/providers/openai-provider.js';
import { AnthropicApiProvider } from '../../../../../src/providers/anthropic-provider.js';
import { fetchTransport, type HttpTransport } from '../../../../../src/providers/provider-http.js';
import type {
  AgentProvider,
  AuthenticationStatus,
  ModelDescriptor,
} from '../../../../../src/providers/provider-types.js';

/** What the interface shows about one connection. Never a credential. */
export interface ConnectionView {
  id: string;
  displayName: string;
  providerId: string;
  connectionKind: 'cli' | 'api';
  /** `subscription` for a CLI connection, `api-metered` for a key. */
  billing: 'subscription' | 'api-metered';
  /** True when a credential is stored for this connection. */
  hasCredential: boolean;
  /** The last characters of the key, so it can be told apart. Never the key. */
  keyHint: string | null;
  /** False until the person deliberately enables a metered connection. */
  apiEnabled: boolean;
  authState: string;
  defaultModel: string | null;
  defaultReasoning: string | null;
  baseUrl: string | null;
  createdAt: string;
}

export class ConnectionError extends Error {
  constructor(
    message: string,
    readonly code = 'CONNECTION_ERROR',
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export interface ConnectionServiceOptions {
  database: Database;
  secrets: SecretStore;
  events: EventBus;
  /** Injected so tests drive the providers without a network. */
  transport?: HttpTransport;
}

export class ConnectionService {
  private readonly transport: HttpTransport;

  constructor(private readonly options: ConnectionServiceOptions) {
    this.transport = options.transport ?? fetchTransport;
  }

  /** Every connection, CLI and API alike. The screen shows one list. */
  list(): ConnectionView[] {
    return this.options.database.accounts.list().map((row) => this.toView(row.id));
  }

  /**
   * Creates an API connection and stores its key, in one step.
   *
   * One step because a connection with no credential is not a connection, and
   * leaving a half-made one behind is how a person ends up with a list of
   * things that look configured and are not.
   *
   * It starts **disabled**. Saving a key must not, by itself, make anything
   * cost money; `setApiEnabled` is a separate, deliberate act.
   */
  addApiConnection(input: {
    providerId: 'anthropic' | 'openai';
    displayName: string;
    apiKey: string;
    baseUrl?: string | null;
  }): ConnectionView {
    const name = input.displayName.trim();
    if (!name) throw new ConnectionError('Dê um nome a esta conexão.', 'NAME_REQUIRED');
    const key = input.apiKey.trim();
    if (!key) throw new ConnectionError('Cole a chave de API desta conexão.', 'KEY_REQUIRED');
    if (!this.options.secrets.available) {
      // Better to refuse than to keep a key somewhere it should not be.
      throw new ConnectionError(
        'Este computador não oferece armazenamento seguro, então a chave não pode ser guardada com segurança.',
        'NO_SECRET_STORE',
      );
    }
    const taken = this.options.database.accounts
      .list()
      .some((row) => row.provider_id === input.providerId && row.display_name === name);
    if (taken) {
      throw new ConnectionError('Já existe uma conexão com esse nome neste provider.', 'NAME_TAKEN');
    }

    const id = newId('conn');
    const account = this.options.database.transaction(() => {
      const created = this.options.database.accounts.create({
        id,
        providerId: input.providerId,
        displayName: name,
        // An API connection owns no profile directory: there is no CLI here.
        profileDirectory: '',
        connectionKind: 'api',
        baseUrl: input.baseUrl?.trim() || null,
      });
      this.options.database.providerSecrets.put(id, this.options.secrets.encrypt(key));
      this.options.database.accounts.setCredentialReference(id, `provider.key.${id}`, hintOf(key));
      this.options.database.accounts.updateAuth(id, 'connected', 'api-key');
      return created;
    });
    this.options.events.emit('connections:changed', { connectionId: account.id });
    return this.toView(account.id);
  }

  /**
   * Replaces the key of an existing connection.
   *
   * Kept separate from creating one so that rotating a key does not disturb
   * the teams, projects and history that point at this connection.
   */
  replaceKey(connectionId: string, apiKey: string): ConnectionView {
    const account = this.requireApi(connectionId);
    const key = apiKey.trim();
    if (!key) throw new ConnectionError('Cole a chave de API desta conexão.', 'KEY_REQUIRED');
    if (!this.options.secrets.available) {
      throw new ConnectionError(
        'Este computador não oferece armazenamento seguro, então a chave não pode ser guardada com segurança.',
        'NO_SECRET_STORE',
      );
    }
    this.options.database.transaction(() => {
      this.options.database.providerSecrets.put(account.id, this.options.secrets.encrypt(key));
      this.options.database.accounts.setCredentialReference(
        account.id,
        `provider.key.${account.id}`,
        hintOf(key),
      );
      this.options.database.accounts.updateAuth(account.id, 'connected', 'api-key');
    });
    this.options.events.emit('connections:changed', { connectionId: account.id });
    return this.toView(account.id);
  }

  rename(connectionId: string, displayName: string): ConnectionView {
    const name = displayName.trim();
    if (!name) throw new ConnectionError('Dê um nome a esta conexão.', 'NAME_REQUIRED');
    this.options.database.accounts.require(connectionId);
    this.options.database.accounts.rename(connectionId, name);
    this.options.events.emit('connections:changed', { connectionId: connectionId });
    return this.toView(connectionId);
  }

  setPreferences(
    connectionId: string,
    model: string | null,
    reasoning: string | null,
  ): ConnectionView {
    this.options.database.accounts.require(connectionId);
    this.options.database.accounts.setPreferences(connectionId, model, reasoning);
    return this.toView(connectionId);
  }

  /**
   * Switches a metered connection on or off.
   *
   * This is the gate the whole cost requirement rests on. Until it is on, the
   * connection exists, is listed, and is used by nothing.
   */
  setApiEnabled(connectionId: string, enabled: boolean): ConnectionView {
    const account = this.requireApi(connectionId);
    if (enabled && !this.options.database.providerSecrets.has(account.id)) {
      throw new ConnectionError(
        'Adicione a chave de API antes de habilitar esta conexão.',
        'KEY_REQUIRED',
      );
    }
    this.options.database.accounts.setApiEnabled(account.id, enabled);
    this.options.events.emit('connections:changed', { connectionId: account.id });
    return this.toView(account.id);
  }

  /**
   * Forgets the credential on this computer, keeping the connection itself.
   *
   * The account, the teams that name it and the history that mentions it all
   * stay: disconnecting is not deleting, and a person who pastes the key again
   * finds their project exactly as they left it.
   */
  disconnect(connectionId: string): ConnectionView {
    const account = this.options.database.accounts.require(connectionId);
    this.options.database.transaction(() => {
      this.options.database.providerSecrets.remove(account.id);
      this.options.database.accounts.setCredentialReference(account.id, null, null);
      this.options.database.accounts.setApiEnabled(account.id, false);
      this.options.database.accounts.updateAuth(account.id, 'disconnected', null);
    });
    this.options.events.emit('connections:changed', { connectionId: account.id });
    return this.toView(account.id);
  }

  /** Checks the credential against the provider, without doing any work. */
  async test(connectionId: string): Promise<AuthenticationStatus> {
    const provider = this.providerFor(connectionId, { ignoreEnabled: true });
    const status = await provider.getAuthenticationStatus();
    this.options.database.accounts.updateAuth(
      connectionId,
      status.authenticated ? 'connected' : 'disconnected',
      status.method ?? null,
    );
    this.options.events.emit('connections:changed', { connectionId: connectionId });
    return status;
  }

  /** The models this connection's account really has. Never a constant list. */
  async models(connectionId: string): Promise<ModelDescriptor[]> {
    return this.providerFor(connectionId, { ignoreEnabled: true }).getAvailableModels();
  }

  /**
   * Builds the provider for a connection.
   *
   * The key is read here, at call time, and handed to the adapter as a
   * *function* rather than a value: a revoked or replaced credential is picked
   * up on the next call, and no long-lived object holds a secret in a field.
   */
  providerFor(
    connectionId: string,
    options: { ignoreEnabled?: boolean; system?: string | null } = {},
  ): AgentProvider {
    const account = this.requireApi(connectionId);
    if (!options.ignoreEnabled && account.api_enabled !== 1) {
      throw new ConnectionError(
        `A conexão "${account.display_name}" usa uma API com cobrança separada e ainda não foi habilitada.`,
        'API_DISABLED',
      );
    }
    const readKey = () => this.readKey(account.id);
    const shared = {
      connectionId: account.id,
      apiKey: readKey,
      transport: this.transport,
      ...(account.base_url ? { baseUrl: account.base_url } : {}),
      model: account.default_model,
      reasoningEffort: account.default_reasoning,
    };
    if (account.provider_id === 'openai') {
      return new OpenAiApiProvider({
        ...shared,
        ...(options.system ? { instructions: options.system } : {}),
      });
    }
    if (account.provider_id === 'anthropic') {
      return new AnthropicApiProvider({
        ...shared,
        ...(options.system ? { system: options.system } : {}),
      });
    }
    throw new ConnectionError(
      `Este aplicativo ainda não fala com o provider "${account.provider_id}".`,
      'PROVIDER_UNSUPPORTED',
    );
  }

  /** The decrypted key, for the one code path about to make a call with it. */
  private readKey(connectionId: string): string {
    const ciphertext = this.options.database.providerSecrets.get(connectionId);
    if (!ciphertext) return '';
    try {
      return this.options.secrets.decrypt(ciphertext);
    } catch {
      // A store that cannot decrypt (a new machine, a reset keychain) is a
      // missing credential, not a crash: the adapter reports "no key saved"
      // and the person is asked to paste it again.
      return '';
    }
  }

  private requireApi(connectionId: string) {
    const account = this.options.database.accounts.require(connectionId);
    if (account.connection_kind !== 'api') {
      throw new ConnectionError(
        `A conexão "${account.display_name}" usa a ferramenta oficial do provider, não uma chave de API.`,
        'NOT_AN_API_CONNECTION',
      );
    }
    return account;
  }

  private toView(connectionId: string): ConnectionView {
    const row = this.options.database.accounts.require(connectionId);
    const kind = row.connection_kind === 'api' ? ('api' as const) : ('cli' as const);
    return {
      id: row.id,
      displayName: row.display_name,
      providerId: row.provider_id,
      connectionKind: kind,
      billing: kind === 'api' ? 'api-metered' : 'subscription',
      hasCredential:
        kind === 'api'
          ? this.options.database.providerSecrets.has(row.id)
          : row.auth_state === 'connected',
      keyHint: row.key_hint,
      apiEnabled: row.api_enabled === 1,
      authState: row.auth_state,
      defaultModel: row.default_model,
      defaultReasoning: row.default_reasoning,
      baseUrl: row.base_url,
      createdAt: row.created_at,
    };
  }
}

/**
 * Enough of a key to recognise it, and no more.
 *
 * Four characters cannot be used to call anything. Showing a prefix as well
 * would be friendlier and would also leak the key's type and organisation, so
 * only the tail is kept.
 */
function hintOf(key: string): string {
  return `…${key.slice(-4)}`;
}
