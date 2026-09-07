/**
 * GitHub, as the application holds it.
 *
 * One login, by device flow, for the whole application. The token lives in
 * the settings table **encrypted** by the shell's secret store (Electron's
 * `safeStorage`, which on Windows is DPAPI); without a working store the
 * login is refused rather than stored in the clear. What leaves this class
 * is a status - login, name, avatar - and, for git, an environment that
 * carries the token as a per-process header. The token itself never reaches
 * the renderer, a log line, a remote URL or `.git/config`.
 *
 * The device-flow progress goes out on `account:progress` with the id
 * `github`, so the same sign-in dialog that shows a Codex code shows this one.
 */

import type { Database } from '../core.js';
import {
  GitHubClient,
  GitHubError,
  gitAuthEnvironment,
  isGitHubHttpsRemote,
  parseGitHubRemote,
  type CheckSummary,
  type DeviceCode,
  type GitHubClientOptions,
  type GitHubRepository,
  type GitHubToken,
  type PullRequest,
} from '../core.js';
import type { GitHubStatusView } from '../../shared/ipc-contract.js';
import type { EventBus } from '../events.js';
import type { UrlOpener } from './account-service.js';

/**
 * Encrypts what must not be readable at rest. Electron provides one on
 * `safeStorage`; tests provide a reversible fake. `available` is false where
 * the OS offers no protection, and then no token is ever written.
 */
export interface SecretStore {
  readonly available: boolean;
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

export const GITHUB_ACCOUNT_ID = 'github';

const KEYS = {
  clientId: 'github.clientId',
  token: 'github.token.enc',
  refreshToken: 'github.refreshToken.enc',
  expiresAt: 'github.expiresAt',
  login: 'github.login',
  name: 'github.name',
  avatarUrl: 'github.avatarUrl',
  scope: 'github.scope',
} as const;

export class GitHubServiceError extends Error {
  readonly code: string;
  constructor(message: string, code = 'GITHUB_ERROR') {
    super(message);
    this.name = 'GitHubServiceError';
    this.code = code;
  }
}

export class GitHubService {
  private readonly client: GitHubClient;
  private connecting: AbortController | null = null;

  constructor(
    private readonly database: Database,
    private readonly secrets: SecretStore,
    private readonly events: EventBus,
    private readonly openUrl: UrlOpener,
    clientOptions: GitHubClientOptions = {},
  ) {
    this.client = new GitHubClient(clientOptions);
  }

  status(): GitHubStatusView {
    const settings = this.database.settings;
    const clientId = settings.get(KEYS.clientId);
    const connected = settings.get(KEYS.token) !== null;
    return {
      configured: clientId !== null && clientId.length > 0,
      clientId: clientId ?? null,
      storageAvailable: this.secrets.available,
      connected,
      login: connected ? settings.get(KEYS.login) : null,
      name: connected ? settings.get(KEYS.name) : null,
      avatarUrl: connected ? settings.get(KEYS.avatarUrl) : null,
      connecting: this.connecting !== null,
    };
  }

  /**
   * The Client ID of the person's own GitHub App or OAuth App. Not a secret.
   *
   * The mistakes a person makes on that page get their own sentence: the
   * App ID (a number), the example from the help text, the client secret.
   * Each of them would otherwise reach GitHub and come back as 404.
   */
  configure(clientId: string): GitHubStatusView {
    const trimmed = clientId.trim();
    if (trimmed.length === 0) {
      throw new GitHubServiceError('Informe o Client ID do seu GitHub App.');
    }
    if (/^\d+$/.test(trimmed)) {
      throw new GitHubServiceError(
        'Isso parece o App ID (um número). O Client ID é o texto que começa com "Iv1." ou "Iv23li", na mesma página do app.',
      );
    }
    if (/abc123|example|exemplo|your[-_ ]?client|xxx|<|>/i.test(trimmed)) {
      throw new GitHubServiceError('Isso é o exemplo da ajuda, não o seu Client ID. Copie o Client ID da página do seu GitHub App.');
    }
    if (/^ghp_|^gho_|^github_pat_/.test(trimmed) || trimmed.length > 60) {
      throw new GitHubServiceError('Isso parece um token ou um Client secret. Aqui vai só o Client ID (curto, começa com "Iv1." ou "Iv23li").');
    }
    if (!/^[A-Za-z0-9._-]{4,100}$/.test(trimmed)) {
      throw new GitHubServiceError('Esse não parece um Client ID do GitHub.');
    }
    this.database.settings.set(KEYS.clientId, trimmed);
    return this.status();
  }

  /**
   * The device flow, end to end: ask for a code, show it, open the browser,
   * wait, store the token encrypted, read who signed in.
   */
  async connect(): Promise<GitHubStatusView> {
    const clientId = this.database.settings.get(KEYS.clientId);
    if (!clientId) {
      throw new GitHubServiceError('Informe o Client ID do seu GitHub App antes de conectar.');
    }
    if (!this.secrets.available) {
      throw new GitHubServiceError(
        'Este sistema não oferece armazenamento protegido para o login do GitHub, então ele não será guardado.',
      );
    }
    if (this.connecting) return this.status();

    const controller = new AbortController();
    this.connecting = controller;
    const report = (stage: string, label: string, code?: DeviceCode, detail?: string | null) =>
      this.events.emit('account:progress', {
        accountId: GITHUB_ACCOUNT_ID,
        stage,
        label,
        ...(code ? { url: code.verificationUri, code: code.userCode } : {}),
        ...(detail ? { detail } : {}),
      });

    try {
      report('starting', 'Pedindo um código ao GitHub...');
      const code = await this.client.requestDeviceCode(clientId);
      report('awaiting-browser', 'Abrindo o navegador para você entrar...', code);
      await this.openUrl(code.verificationUri);
      report('waiting-for-completion', 'Aguardando você concluir no navegador...', code);

      const token = await this.client.pollForToken(clientId, code, controller.signal);
      // A token is not a login: the account behind it must answer, and the
      // repositories must be reachable, before anything is stored.
      report('validating', 'Confirmando a conta no GitHub...');
      const user = await this.client.user(token.accessToken);
      const sample = await this.client.repositories(token.accessToken, 1);
      this.storeToken(token);
      this.database.settings.set(KEYS.login, user.login);
      this.database.settings.set(KEYS.name, user.name ?? '');
      this.database.settings.set(KEYS.avatarUrl, user.avatarUrl);
      report(
        'connected',
        `GitHub conectado como ${user.login}` +
          (sample.length > 0 ? ` (${sample.length}${sample.length >= 100 ? '+' : ''} repositórios visíveis).` : '. Nenhum repositório visível: instale o GitHub App na sua conta.'),
      );
      return this.status();
    } catch (error) {
      if (controller.signal.aborted) {
        report('cancelled', 'Conexão cancelada.');
      } else {
        report('failed', describe(error), undefined, detailOf(error));
      }
      return this.status();
    } finally {
      if (this.connecting === controller) this.connecting = null;
    }
  }

  cancelConnect(): boolean {
    if (!this.connecting) return false;
    this.connecting.abort();
    return true;
  }

  /** Forgets the token and who it belonged to. The Client ID stays. */
  disconnect(): GitHubStatusView {
    for (const key of [KEYS.token, KEYS.refreshToken, KEYS.expiresAt, KEYS.login, KEYS.name, KEYS.avatarUrl, KEYS.scope]) {
      this.database.settings.remove(key);
    }
    return this.status();
  }

  async repositories(): Promise<GitHubRepository[]> {
    return this.client.repositories(await this.accessToken());
  }

  /**
   * The branches of one repository, default first.
   *
   * The cloud picker needs this because a cloud project has no working copy to
   * read branches from - the repository lives only on GitHub until a run
   * clones it remotely.
   */
  async branches(repository: string): Promise<{ name: string; protected: boolean; isDefault: boolean }[]> {
    const [owner, name] = repository.split('/');
    if (!owner || !name) throw new GitHubServiceError('Escolha um repositório no formato dono/nome.');
    const token = await this.accessToken();
    const repositories = await this.client.repositories(token);
    const known = repositories.find((r) => r.fullName.toLowerCase() === repository.toLowerCase());
    const fallback = known?.defaultBranch ?? 'main';
    const branches = await this.client.branches(token, owner, name);
    return branches
      .map((branch) => ({
        name: branch.name,
        protected: branch.protected,
        isDefault: branch.name === fallback,
      }))
      // The default branch is what a person means nine times out of ten;
      // scrolling for it every time is a small daily tax.
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  }

  /**
   * The environment git needs to reach a github.com remote as this login.
   * Empty for any other remote, and when nobody is signed in - git then
   * behaves exactly as it would without the application.
   */
  gitEnvironmentFor(remoteUrl: string | null | undefined): Record<string, string> {
    if (!isGitHubHttpsRemote(remoteUrl)) return {};
    const token = this.storedToken();
    return token ? gitAuthEnvironment(token.accessToken) : {};
  }

  async createPullRequest(input: {
    remoteUrl: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequest> {
    const remote = parseGitHubRemote(input.remoteUrl);
    if (!remote) throw new GitHubServiceError('O remoto deste projeto não é um repositório do GitHub.');
    return this.client.createPullRequest(await this.accessToken(), {
      owner: remote.owner,
      repo: remote.repo,
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
    });
  }

  async pullRequestsFor(remoteUrl: string, branch: string): Promise<PullRequest[]> {
    const remote = parseGitHubRemote(remoteUrl);
    if (!remote) return [];
    return this.client.pullRequestsFor(await this.accessToken(), remote.owner, remote.repo, branch);
  }

  async checksFor(remoteUrl: string, ref: string): Promise<CheckSummary | null> {
    const remote = parseGitHubRemote(remoteUrl);
    if (!remote) return null;
    return this.client.checks(await this.accessToken(), remote.owner, remote.repo, ref);
  }

  // -- the token, never outside this class -----------------------------------

  private storeToken(token: GitHubToken): void {
    const settings = this.database.settings;
    settings.set(KEYS.token, this.secrets.encrypt(token.accessToken));
    if (token.refreshToken) settings.set(KEYS.refreshToken, this.secrets.encrypt(token.refreshToken));
    else settings.remove(KEYS.refreshToken);
    if (token.expiresAt) settings.set(KEYS.expiresAt, String(token.expiresAt));
    else settings.remove(KEYS.expiresAt);
    settings.set(KEYS.scope, token.scope);
  }

  private storedToken(): { accessToken: string; refreshToken: string | null; expiresAt: number | null } | null {
    const cipher = this.database.settings.get(KEYS.token);
    if (!cipher) return null;
    try {
      const refresh = this.database.settings.get(KEYS.refreshToken);
      const expires = this.database.settings.get(KEYS.expiresAt);
      return {
        accessToken: this.secrets.decrypt(cipher),
        refreshToken: refresh ? this.secrets.decrypt(refresh) : null,
        expiresAt: expires ? Number(expires) : null,
      };
    } catch {
      // Another machine's key, or a corrupted row: the login is gone.
      return null;
    }
  }

  /**
   * The token when GitHub is connected, and null when it is not.
   *
   * For reads that work without one. A public repository must never be made
   * to ask for a login, so "not connected" is an ordinary answer here rather
   * than the error `accessToken` raises for operations that genuinely need a
   * credential.
   */
  async accessTokenIfConnected(): Promise<string | null> {
    if (!this.storedToken()) return null;
    try {
      return await this.accessToken();
    } catch {
      // A refresh that failed is not a reason to abandon an anonymous read.
      return null;
    }
  }

  private async accessToken(): Promise<string> {
    const stored = this.storedToken();
    if (!stored) throw new GitHubServiceError('Conecte o GitHub em Contas e integrações.', 'GITHUB_NOT_CONNECTED');
    if (stored.expiresAt && stored.expiresAt - Date.now() < 60_000 && stored.refreshToken) {
      const clientId = this.database.settings.get(KEYS.clientId);
      if (clientId) {
        const renewed = await this.client.refresh(clientId, stored.refreshToken);
        this.storeToken(renewed);
        return renewed.accessToken;
      }
    }
    return stored.accessToken;
  }
}

function describe(error: unknown): string {
  if (error instanceof GitHubError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** The answer behind a failure, already scrubbed of codes and tokens. */
function detailOf(error: unknown): string | null {
  if (error instanceof GitHubError) return error.detail ?? (error.status ? `HTTP ${error.status}` : null);
  return error instanceof Error ? `${error.name}: ${error.message}` : null;
}
