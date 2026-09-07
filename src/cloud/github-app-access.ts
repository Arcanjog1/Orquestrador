/**
 * Repository access for a remote workspace, as a GitHub App installation.
 *
 * This is the official short-lived, minimum-scope mechanism, and it is the one
 * the product uses because of what the alternatives would mean:
 *
 *  - a person's own OAuth token would be a durable, broad credential sitting on
 *    a server, able to reach every repository they can;
 *  - a copied desktop credential would be a personal login moved to somewhere
 *    it was never authorised to be.
 *
 * An installation token instead lasts about an hour, is scoped to the single
 * repository being cloned, and carries only the permissions that clone needs.
 * A workspace that outlives one asks again rather than holding one longer.
 *
 * The flow, exactly as GitHub documents it:
 *
 *   1. sign a short-lived RS256 JWT with the App's private key (`iss` = the
 *      App's client id or app id, `exp` at most ten minutes out);
 *   2. `GET /repos/{owner}/{repo}/installation` as the App -> installation id;
 *   3. `POST /app/installations/{id}/access_tokens` with `repositories` and
 *      `permissions` -> a token narrowed to that repository alone.
 *
 * Nothing here logs a token, and nothing writes one to disk. The private key
 * comes from the deployment's own secret store, never from a repository and
 * never from a desktop.
 */

import { createSign, createPrivateKey, type KeyObject } from 'node:crypto';
import type { RepositoryAccess, RepositoryToken } from './provisioner.js';

export interface GitHubAppOptions {
  /** The App's id (numeric) or client id, as `iss`. */
  appId: string;
  /** PEM private key. Held in memory only; never written anywhere. */
  privateKeyPem: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  now?: () => number;
}

/** A token is re-used until this long before it expires, then minted again. */
const RENEW_MARGIN_MS = 5 * 60_000;

export class GitHubAppAccessError extends Error {
  readonly userMessage: string;
  constructor(
    readonly reason: 'NOT_INSTALLED' | 'UNAUTHORIZED' | 'NETWORK' | 'UNEXPECTED',
    userMessage: string,
    readonly detail: string | null = null,
  ) {
    super(detail ? `${userMessage} (${detail})` : userMessage);
    this.name = 'GitHubAppAccessError';
    this.userMessage = detail ? `${userMessage} Detalhe: ${detail}.` : userMessage;
  }
}

export class GitHubAppRepositoryAccess implements RepositoryAccess {
  private readonly key: KeyObject;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly now: () => number;
  /** repository + scope -> the token minted for it, while it is still fresh. */
  private readonly cache = new Map<string, RepositoryToken>();
  /** repository -> installation id, which does not change between calls. */
  private readonly installations = new Map<string, number>();

  constructor(private readonly options: GitHubAppOptions) {
    this.key = createPrivateKey(options.privateKeyPem);
    this.apiBase = options.apiBase ?? 'https://api.github.com';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? 'AI-Orchestrator';
    this.now = options.now ?? (() => Date.now());
  }

  async token(repository: string, scope: 'read' | 'write'): Promise<RepositoryToken> {
    const key = `${repository}:${scope}`;
    const cached = this.cache.get(key);
    if (cached && Date.parse(cached.expiresAt) - this.now() > RENEW_MARGIN_MS) return cached;

    const [owner, name] = repository.split('/');
    if (!owner || !name) {
      throw new GitHubAppAccessError('UNEXPECTED', `"${repository}" não é um repositório owner/nome.`);
    }

    const installationId = await this.installationFor(owner, name);
    const minted = await this.request<{ token?: unknown; expires_at?: unknown }>(
      `/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        body: JSON.stringify({
          // Narrowed to this repository alone, even when the installation has
          // more: a workspace cloning one repository gets access to one.
          repositories: [name],
          // And to the permissions that clone (or push) actually needs.
          permissions: scope === 'write' ? { contents: 'write', pull_requests: 'write' } : { contents: 'read' },
        }),
      },
    );
    if (typeof minted.token !== 'string' || typeof minted.expires_at !== 'string') {
      throw new GitHubAppAccessError('UNEXPECTED', 'O GitHub não devolveu um token de instalação.');
    }
    const token: RepositoryToken = {
      value: minted.token,
      expiresAt: minted.expires_at,
      identity: `installation:${installationId}`,
    };
    this.cache.set(key, token);
    return token;
  }

  /** Forgets every cached token. Called when an installation is revoked. */
  forget(): void {
    this.cache.clear();
    this.installations.clear();
  }

  private async installationFor(owner: string, name: string): Promise<number> {
    const cached = this.installations.get(`${owner}/${name}`);
    if (cached !== undefined) return cached;
    const body = await this.request<{ id?: unknown }>(`/repos/${owner}/${name}/installation`);
    if (typeof body.id !== 'number') {
      throw new GitHubAppAccessError('UNEXPECTED', 'O GitHub não devolveu a instalação do aplicativo.');
    }
    this.installations.set(`${owner}/${name}`, body.id);
    return body.id;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.jwt()}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': this.userAgent,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    } catch (error) {
      throw new GitHubAppAccessError('NETWORK', 'Sem conexão com o GitHub.', (error as Error).message);
    }
    if (response.status === 404) {
      throw new GitHubAppAccessError(
        'NOT_INSTALLED',
        'O aplicativo do GitHub não está instalado neste repositório, ou não tem acesso a ele.',
        'instale o GitHub App na organização e conceda acesso ao repositório',
      );
    }
    if (response.status === 401 || response.status === 403) {
      // 403 here is also how an organisation with SAML SSO answers an
      // installation whose authorisation has not been granted.
      throw new GitHubAppAccessError(
        'UNAUTHORIZED',
        'O GitHub recusou a credencial do aplicativo.',
        `HTTP ${response.status}; verifique a chave privada do App e a autorização SSO da organização`,
      );
    }
    if (!response.ok) {
      throw new GitHubAppAccessError('UNEXPECTED', `O GitHub respondeu ${response.status}.`);
    }
    return (await response.json()) as T;
  }

  /**
   * A JWT signed with the App's private key.
   *
   * Ten minutes is GitHub's documented maximum; `iat` is backdated by sixty
   * seconds because a server clock that is slightly ahead is otherwise
   * rejected outright.
   */
  private jwt(): string {
    const issuedAt = Math.floor(this.now() / 1000) - 60;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: this.options.appId }),
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    signer.end();
    return `${header}.${payload}.${signer.sign(this.key).toString('base64url')}`;
  }
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}
