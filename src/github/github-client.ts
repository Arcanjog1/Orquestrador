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

/** One branch of a repository, for the cloud picker. */
export interface GitHubBranch {
  readonly name: string;
  /** True when a rule forbids pushing straight to it. */
  readonly protected: boolean;
  readonly commit: string;
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
    readonly kind:
      | 'auth'
      | 'network'
      | 'denied'
      | 'expired'
      | 'api'
      | 'config'
      // Added for reading repositories, where the interface has to tell these
      // apart: a wrong address is a typo to fix, an exhausted quota is a wait
      // (or a login), and a refusal is neither.
      | 'not-found'
      | 'rate-limit'
      | 'forbidden' = 'api',
    /**
     * What came back, for "Detalhes": HTTP status, content type, the error
     * code and description, a short excerpt of the body. Never a device
     * code or a token - `safeExcerpt` strips them before anything is kept.
     */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** What one device-flow request answered, before it is judged. */
interface Answer {
  readonly status: number;
  readonly contentType: string;
  readonly body: Record<string, unknown>;
  /** A short, redacted excerpt of the raw body, for the record. */
  readonly excerpt: string;
}

/**
 * Removes anything secret from a body before it is kept for the record:
 * device codes, access and refresh tokens, whatever their spelling.
 */
export function safeExcerpt(raw: string, max = 240): string {
  const scrubbed = raw
    .replace(/("?(?:device_code|access_token|refresh_token|id_token)"?\s*[:=]\s*"?)([^"&,\s}]+)/gi, '$1[redacted]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{6,})/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return scrubbed.length > max ? `${scrubbed.slice(0, max)}…` : scrubbed;
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
/** Five hundred branches is already more than a picker can be scrolled through. */
const BRANCHES_MAX_PAGES = 5;

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

  /**
   * Step one of the device flow, as documented: `POST /login/device/code`
   * with `client_id` (and `scope`, which a GitHub App ignores), `Accept:
   * application/json`. A good answer carries `device_code` and `user_code`.
   *
   * Everything else is named for what it is. GitHub answers a Client ID it
   * does not know with HTTP 404 `{"error":"Not Found"}` - no description, so
   * the old "resposta inesperada" was the whole story a person got for a
   * pasted App ID. An app whose device flow is off answers
   * `device_flow_disabled`. Each case has its own sentence, and the raw
   * answer - status, content type, a redacted excerpt - travels along for
   * "Detalhes".
   */
  async requestDeviceCode(clientId: string): Promise<DeviceCode> {
    const answer = await this.form(`${this.endpoints.oauthBase}/login/device/code`, {
      client_id: clientId,
      scope: DEVICE_FLOW_SCOPE,
    });
    const code = answer.body;
    if (typeof code.device_code === 'string' && typeof code.user_code === 'string') {
      return {
        deviceCode: code.device_code,
        userCode: code.user_code,
        verificationUri: String(code.verification_uri ?? `${this.endpoints.oauthBase}/login/device`),
        expiresInSeconds: Number(code.expires_in ?? 900),
        intervalSeconds: Number(code.interval ?? 5),
      };
    }
    throw classifyDeviceStart(answer);
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

      const answer = await this.form(`${this.endpoints.oauthBase}/login/oauth/access_token`, {
        client_id: clientId,
        device_code: code.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      const body = answer.body;

      if (typeof body.access_token === 'string') return tokenOf(body);
      const detail = describeAnswer(answer);
      switch (body.error) {
        case 'authorization_pending':
          continue;
        case 'slow_down':
          // The documented rule: the interval grows by five seconds, or to
          // what GitHub says when it says.
          interval = Math.max(interval + 5000, Number(body.interval ?? 0) * 1000);
          continue;
        case 'expired_token':
          throw new GitHubError('O código expirou antes de o login ser concluído.', 400, 'expired', detail);
        case 'access_denied':
          throw new GitHubError('O login foi recusado no GitHub.', 403, 'denied', detail);
        case 'incorrect_client_credentials':
          throw new GitHubError(
            'O GitHub não aceitou o Client ID durante o login. Confira o Client ID do GitHub App.',
            401,
            'config',
            detail,
          );
        case 'incorrect_device_code':
          throw new GitHubError('O GitHub não reconheceu o código deste login. Tente conectar de novo.', 400, 'auth', detail);
        case 'unsupported_grant_type':
          throw new GitHubError('O GitHub não aceitou o tipo de login pedido (grant_type).', 400, 'api', detail);
        case 'device_flow_disabled':
          throw new GitHubError(
            'O fluxo de dispositivo está desligado neste GitHub App. Ative "Enable Device Flow" na página do app.',
            400,
            'config',
            detail,
          );
        default:
          throw new GitHubError(
            `O GitHub recusou o login: ${String(body.error_description ?? body.error ?? `HTTP ${answer.status}`)}`,
            answer.status || 400,
            'auth',
            detail,
          );
      }
    }
    throw new GitHubError('O código expirou antes de o login ser concluído.', 400, 'expired');
  }

  /** GitHub Apps with expiring tokens: exchanges the refresh token for a new pair. */
  async refresh(clientId: string, refreshToken: string): Promise<GitHubToken> {
    const answer = await this.form(`${this.endpoints.oauthBase}/login/oauth/access_token`, {
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const body = answer.body;
    if (typeof body.access_token !== 'string') {
      throw new GitHubError('O GitHub não renovou o login. Conecte novamente.', 401, 'auth', describeAnswer(answer));
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
  async repositories(token: string, maxPages = REPOS_MAX_PAGES): Promise<GitHubRepository[]> {
    const out: GitHubRepository[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
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

  /**
   * The branches of one repository, so the cloud picker offers what exists
   * rather than a free-text field a typo turns into a failed clone.
   *
   * The repository's default branch is listed first: it is what a person
   * means nine times out of ten, and scrolling for it is a small daily tax.
   */
  async branches(token: string, owner: string, repo: string, maxPages = BRANCHES_MAX_PAGES): Promise<GitHubBranch[]> {
    const out: GitHubBranch[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const rows = (await this.api(
        token,
        `/repos/${owner}/${repo}/branches?per_page=${REPOS_PAGE_SIZE}&page=${page}`,
      )) as Array<Record<string, unknown>>;
      if (!Array.isArray(rows)) break;
      for (const row of rows) {
        out.push({
          name: String(row.name ?? ''),
          protected: row.protected === true,
          commit: String((row.commit as Record<string, unknown> | undefined)?.sha ?? ''),
        });
      }
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

  /**
   * One device-flow request. The body is sent form-encoded and the answer is
   * asked for as JSON, both as documented; the answer is still read by its
   * own content type, because GitHub answers form-encoded when the Accept
   * header is missing and a proxy can answer HTML. Whatever comes back is
   * returned with its status for the caller to judge - never thrown away
   * as "unexpected".
   */
  private async form(url: string, fields: Record<string, string>): Promise<Answer> {
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
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const reason = (error as { name?: string; message?: string }).name === 'TimeoutError'
        ? 'a resposta demorou mais de 30 s'
        : (error as Error).message;
      throw new GitHubError(`Sem conexão com o GitHub: ${reason}`, 0, 'network', `POST ${url}: ${reason}`);
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const raw = await response.text();
    return { status: response.status, contentType, body: parseAnswerBody(raw, contentType), excerpt: safeExcerpt(raw) };
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

/** Reads a device-flow body by its content type: JSON, form-encoded, or nothing. */
export function parseAnswerBody(raw: string, contentType: string): Record<string, unknown> {
  const text = raw.trim();
  if (text.length === 0) return {};
  if (contentType.includes('json') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      /* fall through: not JSON after all */
    }
  }
  if (contentType.includes('x-www-form-urlencoded') || /^[A-Za-z0-9_]+=[^\s]*(&[A-Za-z0-9_]+=[^\s]*)*$/.test(text)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of new URLSearchParams(text)) out[key] = value;
    return out;
  }
  return {};
}

/** The record line for an answer: status, content type, error code, excerpt. */
function describeAnswer(answer: Answer): string {
  const parts = [`HTTP ${answer.status}`, `content-type: ${answer.contentType || '(none)'}`];
  if (typeof answer.body.error === 'string') parts.push(`error: ${answer.body.error}`);
  if (typeof answer.body.error_description === 'string') parts.push(`error_description: ${answer.body.error_description}`);
  if (answer.excerpt) parts.push(`body: ${answer.excerpt}`);
  return parts.join(' · ');
}

/**
 * Names the reason a device flow did not start, in the person's words, from
 * what GitHub answered.
 */
function classifyDeviceStart(answer: Answer): GitHubError {
  const detail = describeAnswer(answer);
  const error = typeof answer.body.error === 'string' ? answer.body.error : '';
  const description = typeof answer.body.error_description === 'string' ? answer.body.error_description : '';

  if (answer.status === 404 || /^not found$/i.test(error) || error === 'unauthorized_client' || error === 'incorrect_client_credentials') {
    return new GitHubError(
      'O GitHub não reconhece este Client ID. Confira em GitHub → Settings → Developer settings → GitHub Apps → seu app: ' +
        'o Client ID começa com "Iv1." ou "Iv23li" — não é o App ID (número) nem o Client secret.',
      answer.status || 404,
      'config',
      detail,
    );
  }
  if (error === 'device_flow_disabled') {
    return new GitHubError(
      'O fluxo de dispositivo está desligado neste GitHub App. Na página do app no GitHub, marque "Enable Device Flow" e salve.',
      answer.status || 400,
      'config',
      detail,
    );
  }
  if (answer.status === 429 || (answer.status === 403 && /rate limit/i.test(answer.excerpt))) {
    return new GitHubError('O GitHub limitou as tentativas de login por enquanto. Aguarde alguns minutos e tente de novo.', answer.status, 'api', detail);
  }
  if (answer.contentType.includes('text/html')) {
    return new GitHubError(
      `O GitHub devolveu uma página em vez da resposta do login (HTTP ${answer.status}). Um proxy, firewall ou antivírus pode estar interferindo na conexão.`,
      answer.status,
      'network',
      detail,
    );
  }
  if (description || error) {
    return new GitHubError(`O GitHub não iniciou o login: ${description || error}.`, answer.status || 400, 'auth', detail);
  }
  return new GitHubError(
    `O GitHub não iniciou o login: a resposta não trouxe o código do dispositivo (HTTP ${answer.status}).`,
    answer.status || 400,
    'api',
    detail,
  );
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
