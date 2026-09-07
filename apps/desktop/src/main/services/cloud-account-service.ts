/**
 * This computer's connection to the cloud.
 *
 * A device token is a credential, so it is kept the way the GitHub token
 * already is: encrypted by the shell's secret store, never written in the
 * clear, and never sent back to the renderer. `status` says whether a
 * connection exists and whether it answers; it never says what the token is.
 *
 * The distinction the interface depends on is between *configured* and
 * *reachable*. A coordinator that cannot be reached has not lost anyone's
 * work - the run is still going there - so the sentence a person sees has to
 * be "this window cannot see it", not "it failed".
 */

import type { Database } from '../core.js';
import type { CloudStatusView } from '../../shared/ipc-contract.js';
import type { SecretStore } from './github-service.js';
import { CloudClient } from './cloud-client.js';

const KEYS = {
  endpoint: 'cloud.endpoint',
  token: 'cloud.token',
  label: 'cloud.deviceLabel',
} as const;

export class CloudAccountError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = 'CloudAccountError';
    this.userMessage = userMessage;
  }
}

export class CloudAccountService {
  constructor(
    private readonly database: Database,
    private readonly secrets: SecretStore,
    private readonly makeClient: (endpoint: string, token: () => string | null) => CloudClient = (
      endpoint,
      token,
    ) => new CloudClient({ endpoint, token }),
  ) {}

  /** The endpoint this computer is connected to, or null. */
  endpoint(): string | null {
    return this.database.settings.get(KEYS.endpoint);
  }

  /**
   * The stored token, decrypted.
   *
   * Private to the main process: nothing on the IPC surface returns it, and
   * `status` deliberately reports only that one exists.
   */
  token(): string | null {
    const cipher = this.database.settings.get(KEYS.token);
    if (!cipher) return null;
    try {
      return this.secrets.decrypt(cipher);
    } catch {
      // A store that changed (a new machine, a reset keychain) cannot decrypt
      // what the old one wrote. Treated as "not connected", which is true.
      return null;
    }
  }

  /** A client for a project's coordinator, or null when this is not connected. */
  clientFor(projectEndpoint: string | null): CloudClient | null {
    const endpoint = projectEndpoint ?? this.endpoint();
    if (!endpoint || !this.token()) return null;
    return this.makeClient(endpoint, () => this.token());
  }

  async status(): Promise<CloudStatusView> {
    const endpoint = this.endpoint();
    const configured = Boolean(endpoint && this.token());
    if (!configured) {
      return {
        configured: false,
        reachable: false,
        endpoint,
        deviceLabel: null,
        problem: this.secrets.available
          ? null
          : 'Este sistema não oferece armazenamento protegido, então o acesso à nuvem não pode ser guardado.',
      };
    }
    const client = this.clientFor(null)!;
    const reachable = await client.health();
    return {
      configured: true,
      reachable,
      endpoint,
      deviceLabel: this.database.settings.get(KEYS.label),
      problem: reachable
        ? null
        : 'Sem conexão com a nuvem agora. O trabalho continua lá; esta janela é que não está conseguindo falar com ela.',
    };
  }

  /**
   * Stores a coordinator and a device token, after checking they work.
   *
   * Checked before it is stored: a token that is refused is a mistake to
   * correct now, not a broken connection to discover at the first run.
   */
  async connect(input: { endpoint: string; token: string }): Promise<CloudStatusView> {
    if (!this.secrets.available) {
      throw new CloudAccountError(
        'Este sistema não oferece armazenamento protegido para credenciais, então o acesso à nuvem não pode ser guardado aqui.',
      );
    }
    const endpoint = input.endpoint.replace(/\/$/, '');
    const client = this.makeClient(endpoint, () => input.token);
    if (!(await client.health())) {
      throw new CloudAccountError(`Não foi possível falar com ${endpoint}.`);
    }
    try {
      // Any authenticated call proves the token, and this one reads nothing
      // beyond what this device already owns.
      await client.runs();
    } catch {
      throw new CloudAccountError('A nuvem não aceitou este token. Gere outro no coordenador e cole aqui.');
    }
    this.database.settings.set(KEYS.endpoint, endpoint);
    this.database.settings.set(KEYS.token, this.secrets.encrypt(input.token));
    this.database.settings.set(KEYS.label, endpoint);
    return this.status();
  }

  /**
   * Forgets this computer's access.
   *
   * Local only, and deliberately so: runs already in the cloud keep going, and
   * the history stays where it is. Stopping them is `run.cancel`, which is a
   * different decision and reads like one.
   */
  async disconnect(): Promise<CloudStatusView> {
    this.database.settings.remove(KEYS.token);
    this.database.settings.remove(KEYS.endpoint);
    this.database.settings.remove(KEYS.label);
    return this.status();
  }
}
