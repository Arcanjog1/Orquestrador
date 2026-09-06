/**
 * GitHub, over HTTPS, with nothing hidden in it.
 *
 * Two things live here and nothing else: the OAuth **device flow** (the one
 * sign-in a desktop application without a secret can do, documented at
 * docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 * and, for GitHub Apps, .../generating-a-user-access-token-for-a-github-app)
 * and the handful of REST calls the product needs.
 *
 * The client never logs, never stores and never prints a token. It receives
 * one per call from whoever holds it, and the endpoints are injectable so the
 * whole flow runs against a local fake in tests.
 *
 * The device flow, as documented:
 *   POST {oauth}/login/device/code        client_id, scope
 *     -> device_code, user_code, verification_uri, expires_in, interval
 *   POST {oauth}/login/oauth/access_token  client_id, device_code,
 *                                          grant_type=urn:ietf:params:oauth:grant-type:device_code
 *     -> access_token | error: authorization_pending | slow_down | expired_token | access_denied
 * Polling waits `interval` seconds between attempts, five more after a
 * slow_down, and stops when the code expires, the person denies, or the
 * caller aborts.
 */

export interface GitHubEndpoints {
  /** `https://github.com` - the OAuth pages and the device endpoints. */
  readonly oauthBase: string;
  /** `https://api.github.com` */
  readonly apiBase: string;
}

export const GITHUB_ENDPOINTS: GitHubEndpoints = {
  oauthBase: 'https://github.com',
  apiBase: 'https://api.github.com',
};

/**
 * What an OAuth App is asked for. A GitHub App ignores `scope` (its
 * permissions are fixed when it is registered), so the same request serves
 * both kinds of registration.
 */
export const DEVICE_FLOW_SCOPE = 'repo read:org read:user user:email';

export interface DeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

export interface GitHubToken {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly scope: string;
  /** Present for GitHub Apps with expiring user tokens. */
  readonly refreshToken?: string;
  /** Epoch milliseconds; absent when the token does not expire. */
  readonly expiresAt?: number;
}

export interface GitHubUser {
  readonly login: string;
  readonly name: string | null;
  readonly avatarUrl: string;
  readonly htmlUrl: string;
}

export interface GitHubRepository {
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly private: boolean;
  readonly description: string | null;
  readonly defaultBranch: string;
  readonly htmlUrl: string;
  /** The https clone URL, without any credential in it. */
  readonly cloneUrl: string;
  readonly updatedAt: string;
  readonly permissions: { readonly push: boolean; readonly admin: boolean };
}

export interface PullRequest {
  readonly number: number;
  readonly htmlUrl: string;
  readonly title: string;
  readonly state: string;
}

export interface CheckSummary {
  readonly total: number;
  readonly completed: number;
  readonly success: number;
  readonly failure: number;
  readonly checks: ReadonlyArray<{ name: string; status: string; conclusion: string | null; htmlUrl: string | null }>;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: 'auth' | 'network' | 'denied' | 'expired' | 'api' = 'api',
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface GitHubClientOptions {
  endpoints?: GitHubEndpoints;
  fetchImpl?: typeof fetch;
  /** Overridable so the polling loop runs in milliseconds under test. */
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

const REPOS_PAGE_SIZE = 100;
/** A thousand repositories is more than a person will scroll; the picker searches. */
const REPOS_MAX_PAGES = 10;

export class GitHubClient {
  private readonly endpoints: GitHubEndpoints;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;

  constructor(options: GitHubClientOptions = {}) {
    this.endpoints = options.endpoints ?? GITHUB_ENDPOINTS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.userAgent = options.userAgent ?? 'AI-Orchestrator';
  }

  // -- Device flow -----------------------------------------------------------

  async requestDeviceCode(clientId: string): Promise<DeviceCode> {
    const body = await this.form(`${this.endpoints.oauthBase}/login/device/code`, {
      client_id: clientId,
      scope: DEVICE_FLOW_SCOPE,
    });
    const code = body as Record<string, unknown>;
    if (typeof code.device_code !== 'string' || typeof code.user_code !== 'string') {
      const error = typeof code.error_description === 'string' ? code.error_description : 'resposta inesperada';
      throw new GitHubError(`O GitHub não iniciou o login: ${error}`, 400, 'auth');
    }
    return {
      deviceCode: code.device_code,
      userCode: code.user_code,
      verificationUri: String(code.verification_uri ?? `${this.endpoints.oauthBase}/login/device`),
      expiresInSeconds: Number(code.expires_in ?? 900),
      intervalSeconds: Number(code.interval ?? 5),
    };
  }

  /**
   * Waits for the person to finish in the browser.
   *
   * Resolves with the token, or throws a GitHubError of kind `denied`,
   * `expired` or `auth`. Aborting the signal rejects with kind `auth` and the
   * message "cancelled" - the caller reads that as its own decision.
   */
  async pollForToken(clientId: string, code: DeviceCode, signal?: AbortSignal): Promise<GitHubToken> {
    const deadline = Date.now() + code.expiresInSeconds * 1000;
    let interval = Math.max(1, code.intervalSeconds) * 1000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new GitHubError('cancelled', 0, 'auth');
      await this.sleep(interval);
      if (signal?.aborted) throw new GitHubError('cancelled', 0, 'auth');

      const body = (await this.form(`${this.endpoints.oauthBase}/login/oauth/access_token`, {
        client_id: clientId,
        device_code: code.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      })) as Record<string, unknown>;

      if (typeof body.access_token === 'string') return tokenOf(body);
      switch (body.error) {
        case 'authorization_pending':
          continue;
        case 'slow_down':
          interval += 5000;
          continue;
        case 'expired_token':
          throw new GitHubError('O código expirou antes de o login ser concluído.', 400, 'expired');
        case 'access_denied':
          throw new GitHubError('O login foi recusado no GitHub.', 403, 'denied');
        default:
          throw new GitHubError(
            `O GitHub recusou o login: ${String(body.error_description ?? body.error ?? 'erro desconhecido')}`,
            400,
            'auth',
          );
      }
    }
    throw new GitHubError('O código expirou antes de o login ser concluído.', 400, 'expired');
  }

  /** GitHub Apps with expiring tokens: exchanges the refresh token for a new pair. */
  async refresh(clientId: string, refreshToken: string): Promise<GitHubToken> {
    const body = (await this.form(`${this.endpoints.oauthBase}/login/oauth/access_token`, {
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })) as Record<string, unknown>;
    if (typeof body.access_token !== 'string') {
      throw new GitHubError('O GitHub não renovou o login. Conecte novamente.', 401, 'auth');
    }
    return tokenOf(body);
  }

  // -- REST ------------------------------------------------------------------

  async user(token: string): Promise<GitHubUser> {
    const body = (await this.api(token, '/user')) as Record<string, unknown>;
    return {
      login: String(body.login),
      name: typeof body.name === 'string' ? body.name : null,
      avatarUrl: String(body.avatar_url ?? ''),
      htmlUrl: String(body.html_url ?? ''),
    };
  }

  /**
   * Every repository the person can reach - own, collaborator, organisation -
   * private ones included, newest activity first.
   */
  async repositories(token: string): Promise<GitHubRepository[]> {
    const out: GitHubRepository[] = [];
    for (let page = 1; page <= REPOS_MAX_PAGES; page += 1) {
      const rows = (await this.api(
        token,
        `/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=${REPOS_PAGE_SIZE}&page=${page}`,
      )) as Array<Record<string, unknown>>;
      if (!Array.isArray(rows)) break;
      for (const row of rows) out.push(repositoryOf(row));
      if (rows.length < REPOS_PAGE_SIZE) break;
    }
    return out;
  }

  async createPullRequest(
    token: string,
    input: { owner: string; repo: string; title: string; body: string; head: string; base: string },
  ): Promise<PullRequest> {
    const body = (await this.api(token, `/repos/${input.owner}/${input.repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base }),
    })) as Record<string, unknown>;
    return {
      number: Number(body.number),
      htmlUrl: String(body.html_url ?? ''),
      title: String(body.title ?? input.title),
      state: String(body.state ?? 'open'),
    };
  }

  /** Open pull requests whose head is this branch, if any. */
  async pullRequestsFor(token: string, owner: string, repo: string, branch: string): Promise<PullRequest[]> {
    const rows = (await this.api(
      token,
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    )) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
      number: Number(row.number),
      htmlUrl: String(row.html_url ?? ''),
      title: String(row.title ?? ''),
      state: String(row.state ?? 'open'),
    }));
  }

  /** The check runs on one ref, summarised. */
  async checks(token: string, owner: string, repo: string, ref: string): Promise<CheckSummary> {
    const body = (await this.api(
      token,
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    )) as Record<string, unknown>;
    const runs = Array.isArray(body.check_runs) ? (body.check_runs as Array<Record<string, unknown>>) : [];
    const checks = runs.map((run) => ({
      name: String(run.name ?? ''),
      status: String(run.status ?? ''),
      conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
      htmlUrl: typeof run.html_url === 'string' ? run.html_url : null,
    }));
    return {
      total: checks.length,
      completed: checks.filter((c) => c.status === 'completed').length,
      success: checks.filter((c) => c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral').length,
      failure: checks.filter((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'cancelled').length,
      checks,
    };
  }

  // -- transport ---------------------------------------------------------------

  private async form(url: string, fields: Record<string, string>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': this.userAgent,
        },
        body: new URLSearchParams(fields).toString(),
      });
    } catch (error) {
      throw new GitHubError(`Sem conexão com o GitHub: ${(error as Error).message}`, 0, 'network');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GitHubError(`O GitHub respondeu ${response.status} sem um corpo legível.`, response.status);
    }
    // The device endpoints answer 200 with an `error` field for the expected
    // cases; a non-2xx here is a real refusal (a wrong client id, say).
    if (!response.ok && !(body && typeof body === 'object' && 'error' in body)) {
      throw new GitHubError(`O GitHub respondeu ${response.status}.`, response.status, 'auth');
    }
    return body;
  }

  private async api(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoints.apiBase}${path}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': this.userAgent,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    } catch (error) {
      throw new GitHubError(`Sem conexão com o GitHub: ${(error as Error).message}`, 0, 'network');
    }
    if (response.status === 401) {
      throw new GitHubError('O GitHub não aceitou mais este login. Conecte novamente.', 401, 'auth');
    }
    if (!response.ok) {
      let detail = '';
      try {
        const body = (await response.json()) as { message?: unknown };
        if (typeof body.message === 'string') detail = `: ${body.message}`;
      } catch {
        // The status is enough.
      }
      throw new GitHubError(`O GitHub respondeu ${response.status}${detail}`, response.status);
    }
    if (response.status === 204) return null;
    return response.json();
  }
}

function tokenOf(body: Record<string, unknown>): GitHubToken {
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in);
  return {
    accessToken: String(body.access_token),
    tokenType: String(body.token_type ?? 'bearer'),
    scope: String(body.scope ?? ''),
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
  };
}

function repositoryOf(row: Record<string, unknown>): GitHubRepository {
  const owner = row.owner as Record<string, unknown> | undefined;
  const permissions = (row.permissions as Record<string, unknown> | undefined) ?? {};
  return {
    fullName: String(row.full_name ?? ''),
    owner: String(owner?.login ?? String(row.full_name ?? '').split('/')[0] ?? ''),
    name: String(row.name ?? ''),
    private: Boolean(row.private),
    description: typeof row.description === 'string' ? row.description : null,
    defaultBranch: String(row.default_branch ?? 'main'),
    htmlUrl: String(row.html_url ?? ''),
    cloneUrl: String(row.clone_url ?? `${String(row.html_url ?? '')}.git`),
    updatedAt: String(row.updated_at ?? row.pushed_at ?? ''),
    permissions: { push: Boolean(permissions.push), admin: Boolean(permissions.admin) },
  };
}

/** "owner/repo" from a GitHub remote, https or ssh, or null for any other remote. */
export function parseGitHubRemote(remoteUrl: string | null | undefined): { owner: string; repo: string } | null {
  if (!remoteUrl) return null;
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
    remoteUrl.trim(),
  );
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

/**
 * The environment that lets git authenticate to github.com with a token
 * without the token ever touching argv, `.git/config` or a remote URL.
 *
 * `GIT_CONFIG_COUNT`/`KEY`/`VALUE` (git 2.31+) inject one configuration entry
 * for this process only; `http.extraheader` adds the Authorization header to
 * every request of that process. `GIT_TERMINAL_PROMPT=0` makes a missing or
 * refused credential fail fast instead of waiting for a terminal that a
 * desktop application does not have.
 */
export function gitAuthEnvironment(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    // An empty helper resets the list: the OS credential manager is not
    // asked too, so it cannot answer with another person's login.
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** True for a remote git would reach on github.com over https. */
export function isGitHubHttpsRemote(remoteUrl: string | null | undefined): boolean {
  return /^https:\/\/(?:[^@/]+@)?github\.com\//i.test(remoteUrl?.trim() ?? '');
}
