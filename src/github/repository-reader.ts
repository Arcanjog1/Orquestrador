/**
 * Reading a public repository, without cloning it (spec 9, 11).
 *
 * The ask: paste `https://github.com/owner/repo`, say *"analyse this"*, and
 * get an answer — without having cloned anything first.
 *
 * ## Who actually reads
 *
 * **This service does. Not the agent.** The Codex supervisor runs
 * `--sandbox read-only` and has no network; that is deliberate and is not
 * loosened here. So the application fetches the repository over GitHub's
 * documented REST API, and hands the *content* to the supervisor as part of
 * its prompt. The distinction matters enough to keep saying: an analysis is
 * grounded in bytes this application fetched and can name, never in what a
 * model happens to remember about a well-known repository.
 *
 * That is also why `RepositorySnapshot` carries `filesRead` and a commit sha.
 * A summary that names no file is a summary of the model's memory, and the
 * whole point of this path is that it is not.
 *
 * ## What it does not do
 *
 * - **No clone.** A remote read answers "how does this work?"; cloning is for
 *   when code must actually run, and that is a separate, explicit choice.
 * - **No token for a public repository.** Anonymous reads work and are the
 *   default. A token is used only when one is offered — to lift the rate
 *   limit, or to reach a private repository the person has authorised.
 * - **No execution.** Nothing fetched here is run, sourced, or handed to a
 *   shell. It is text that reaches a prompt, and untrusted text at that.
 * - **No write scope.** Reading asks for nothing beyond reading.
 */

import { GitHubError, GITHUB_ENDPOINTS, type GitHubEndpoints } from './github-client.js';

/** Where a repository lives, as GitHub names it. */
export interface RepositoryRef {
  readonly owner: string;
  readonly repo: string;
  /**
   * What followed `/tree/` or `/blob/` in the URL, verbatim.
   *
   * Deliberately not split into "branch" and "path": a GitHub tree URL is
   * genuinely ambiguous, because branch names may contain slashes.
   * `/tree/claude/new-session-3am7mo` is one branch here and could be the
   * branch `claude` plus the folder `new-session-3am7mo` in another
   * repository — and nothing in the URL says which.
   *
   * So the parser does not guess. It keeps the whole tail and the reader
   * resolves it against the repository, longest first. See `resolveRef`.
   */
  readonly ref: string | null;
}

/**
 * Accepts the shapes a person actually pastes.
 *
 * `https://github.com/owner/repo`, with or without `.git`, a trailing slash,
 * a `/tree/<branch>` suffix or deeper path, `git@github.com:owner/repo.git`,
 * and the bare `owner/repo`.
 *
 * Returns null rather than guessing. A URL for some other host is not a
 * GitHub repository, and quietly treating it as one would send a person's
 * link somewhere they did not ask for.
 */
export function parseRepositoryUrl(input: string): RepositoryRef | null {
  const text = input.trim();
  if (text.length === 0) return null;

  // owner/repo, with nothing else. Deliberately strict: two segments, no
  // scheme, no dots that would make it look like a host.
  const shorthand = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(text);
  if (shorthand && !text.includes('://') && !text.includes('@')) {
    return { owner: shorthand[1]!, repo: shorthand[2]!, ref: null };
  }

  const patterns = [
    /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^\s?#]+))?\/?(?:[?#].*)?$/i,
    /^git@github\.com:([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const repo = match[2]!;
    // `.` and `..` are not repository names, and would build a path that
    // escapes the endpoint it is interpolated into.
    if (repo === '.' || repo === '..') return null;
    return { owner: match[1]!, repo, ref: match[3] ? decodeURIComponent(match[3]) : null };
  }
  return null;
}

/** One file the reader actually fetched. */
export interface ReadFile {
  readonly path: string;
  readonly bytes: number;
  readonly content: string;
  /** True when the file was longer than the cap and only its head was kept. */
  readonly truncated: boolean;
}

/** What the application read, and can point at. */
export interface RepositorySnapshot {
  readonly owner: string;
  readonly repo: string;
  readonly fullName: string;
  readonly description: string | null;
  readonly primaryLanguage: string | null;
  readonly isPrivate: boolean;
  readonly defaultBranch: string;
  /** The ref that was read: a branch name, tag, or sha. */
  readonly ref: string;
  /** The exact commit the analysis is about. Cited, so it can be checked. */
  readonly commitSha: string;
  /** Every path in the tree, capped. */
  readonly paths: readonly string[];
  /** True when the tree itself was larger than GitHub returns in one call. */
  readonly treeTruncated: boolean;
  /** The files whose content was fetched. Named in the analysis. */
  readonly filesRead: readonly ReadFile[];
  readonly readAt: string;
}

/** What the rate limit said, when GitHub said anything about it. */
export interface RateLimitInfo {
  readonly limit: number | null;
  readonly remaining: number | null;
  /** When the window resets, ISO-8601. */
  readonly resetAt: string | null;
  /** True when a token would raise the ceiling — i.e. the read was anonymous. */
  readonly anonymous: boolean;
}

export class RateLimitedError extends GitHubError {
  constructor(
    message: string,
    readonly rateLimit: RateLimitInfo,
  ) {
    super(message, 403, 'rate-limit');
    this.name = 'RateLimitedError';
  }
}

export interface RepositoryReaderOptions {
  endpoints?: GitHubEndpoints;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** Total bytes of file content to fetch. Keeps a prompt affordable. */
  maxTotalBytes?: number;
  /** Bytes kept per file; the rest is dropped and the file marked truncated. */
  maxFileBytes?: number;
  /** How many files to open. */
  maxFiles?: number;
  /** Paths listed from the tree. */
  maxPaths?: number;
}

const DEFAULTS = {
  // Roughly 60k of source is already a long prompt; past that the supervisor
  // is paying to read boilerplate rather than to understand a structure.
  maxTotalBytes: 240_000,
  maxFileBytes: 60_000,
  maxFiles: 24,
  maxPaths: 2_000,
};

export class RepositoryReader {
  private readonly endpoints: GitHubEndpoints;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly limits: typeof DEFAULTS;

  constructor(options: RepositoryReaderOptions = {}) {
    this.endpoints = options.endpoints ?? GITHUB_ENDPOINTS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? 'AI-Orchestrator';
    this.limits = {
      maxTotalBytes: options.maxTotalBytes ?? DEFAULTS.maxTotalBytes,
      maxFileBytes: options.maxFileBytes ?? DEFAULTS.maxFileBytes,
      maxFiles: options.maxFiles ?? DEFAULTS.maxFiles,
      maxPaths: options.maxPaths ?? DEFAULTS.maxPaths,
    };
  }

  /**
   * Reads a repository well enough to explain it.
   *
   * Metadata, then the commit the default branch points at, then the file
   * tree, then the files worth opening. Every step is a documented REST call;
   * nothing is scraped and nothing is cloned.
   *
   * `token` is optional and stays optional: a public repository is read
   * anonymously, because asking someone to sign in to read something the
   * whole world can read is a toll, not a security measure.
   */
  async read(
    ref: RepositoryRef,
    options: { token?: string | null; signal?: AbortSignal } = {},
  ): Promise<RepositorySnapshot> {
    const token = options.token ?? null;
    const meta = await this.get<{
      full_name?: unknown;
      description?: unknown;
      language?: unknown;
      private?: unknown;
      default_branch?: unknown;
    }>(`/repos/${enc(ref.owner)}/${enc(ref.repo)}`, token, options.signal);

    const defaultBranch = typeof meta.default_branch === 'string' ? meta.default_branch : 'main';

    // The exact commit, so the analysis names something checkable rather than
    // "the repository", which drifts the moment somebody pushes.
    const resolved = await this.resolveRef(ref, ref.ref ?? defaultBranch, token, options.signal);
    const wanted = resolved.ref;
    const commitSha = resolved.sha;

    const tree = await this.get<{ tree?: unknown; truncated?: unknown }>(
      `/repos/${enc(ref.owner)}/${enc(ref.repo)}/git/trees/${enc(commitSha)}?recursive=1`,
      token,
      options.signal,
    );
    const entries = Array.isArray(tree.tree) ? tree.tree : [];
    const files = entries
      .filter((entry): entry is { path: string; type: string; size?: number } => {
        if (!entry || typeof entry !== 'object') return false;
        const candidate = entry as { path?: unknown; type?: unknown };
        return typeof candidate.path === 'string' && candidate.type === 'blob';
      })
      .map((entry) => ({ path: entry.path, size: typeof entry.size === 'number' ? entry.size : 0 }));

    const paths = files.slice(0, this.limits.maxPaths).map((entry) => entry.path);
    const chosen = chooseFiles(files, this.limits.maxFiles, this.limits.maxFileBytes);

    const filesRead: ReadFile[] = [];
    let budget = this.limits.maxTotalBytes;
    for (const candidate of chosen) {
      if (budget <= 0) break;
      const file = await this.readFile(ref, candidate.path, commitSha, token, options.signal, budget);
      if (!file) continue;
      filesRead.push(file);
      budget -= file.bytes;
    }

    return {
      owner: ref.owner,
      repo: ref.repo,
      fullName: typeof meta.full_name === 'string' ? meta.full_name : `${ref.owner}/${ref.repo}`,
      description: typeof meta.description === 'string' ? meta.description : null,
      primaryLanguage: typeof meta.language === 'string' ? meta.language : null,
      isPrivate: meta.private === true,
      defaultBranch,
      ref: wanted,
      commitSha,
      paths,
      treeTruncated: tree.truncated === true || files.length > this.limits.maxPaths,
      filesRead,
      readAt: new Date().toISOString(),
    };
  }

  /**
   * Turns the tail of a URL into a ref that exists, and the commit it points at.
   *
   * A GitHub tree URL cannot be parsed unambiguously, because branch names
   * contain slashes: `/tree/claude/new-session-3am7mo` is one branch in this
   * repository and would be a branch plus a folder in another. Guessing gets
   * it wrong roughly whenever it matters.
   *
   * So it asks. The longest candidate first, then progressively shorter ones,
   * and the first that resolves wins. `claude/new-session-3am7mo` is tried
   * before `claude`, which is the right order: the more specific reading is
   * the one the person's URL meant.
   *
   * A ref that resolves nowhere is reported as itself, not silently replaced
   * with the default branch - reading a different branch than the one asked
   * for and saying nothing would be worse than failing.
   */
  private async resolveRef(
    repository: RepositoryRef,
    candidate: string,
    token: string | null,
    signal: AbortSignal | undefined,
  ): Promise<{ ref: string; sha: string }> {
    const segments = candidate.split('/').filter((part) => part.length > 0);
    // Longest first, then shorter. Bounded: a ref with more than four
    // segments is not a branch name anyone maintains.
    const candidates: string[] = [];
    for (let length = Math.min(segments.length, 4); length >= 1; length -= 1) {
      candidates.push(segments.slice(0, length).join('/'));
    }

    let lastError: unknown = null;
    for (const attempt of candidates) {
      try {
        const commit = await this.get<{ sha?: unknown }>(
          `/repos/${enc(repository.owner)}/${enc(repository.repo)}/commits/${encodePath(attempt)}`,
          token,
          signal,
        );
        if (typeof commit.sha === 'string') return { ref: attempt, sha: commit.sha };
      } catch (error) {
        // A rate limit will hit every remaining attempt, so stop rather than
        // burning the rest of the quota discovering the same thing.
        if (error instanceof RateLimitedError) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new GitHubError(`Não foi possível resolver "${candidate}" neste repositório.`, 404, 'not-found');
  }

  /** One file's text. Null when it is binary, missing, or too large to help. */
  private async readFile(
    ref: RepositoryRef,
    path: string,
    commitSha: string,
    token: string | null,
    signal: AbortSignal | undefined,
    budget: number,
  ): Promise<ReadFile | null> {
    let body: { content?: unknown; encoding?: unknown; size?: unknown };
    try {
      body = await this.get(
        `/repos/${enc(ref.owner)}/${enc(ref.repo)}/contents/${encodePath(path)}?ref=${enc(commitSha)}`,
        token,
        signal,
      );
    } catch (error) {
      // One unreadable file must not lose the whole analysis. A rate limit is
      // different: it will hit every remaining file, so it is not swallowed.
      if (error instanceof RateLimitedError) throw error;
      return null;
    }
    if (body.encoding !== 'base64' || typeof body.content !== 'string') return null;

    const decoded = Buffer.from(body.content, 'base64');
    // A file with a NUL byte in its head is binary. Putting an image into a
    // prompt spends money to say nothing.
    if (decoded.subarray(0, 8_000).includes(0)) return null;

    const cap = Math.min(this.limits.maxFileBytes, budget);
    const truncated = decoded.byteLength > cap;
    const content = decoded.subarray(0, cap).toString('utf8');
    return { path, bytes: Buffer.byteLength(content, 'utf8'), content, truncated };
  }

  /**
   * One documented REST call.
   *
   * Sends a token only when there is one. `Authorization` is never added
   * empty, because an empty credential header is refused where an absent one
   * is simply anonymous.
   */
  private async get<T>(path: string, token: string | null, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoints.apiBase}${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': this.userAgent,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new GitHubError(`Sem conexão com o GitHub: ${(error as Error).message}`, 0, 'network');
    }

    if (response.status === 404) {
      // Deliberately one sentence covering both cases, because GitHub answers
      // both the same way on purpose: telling an anonymous caller apart would
      // leak which private repositories exist.
      throw new GitHubError(
        'Repositório não encontrado. Verifique o endereço — e, se ele for privado, ' +
          'conecte a conta do GitHub que tem acesso a ele.',
        404,
        'not-found',
      );
    }
    if (response.status === 401) {
      throw new GitHubError('O GitHub não aceitou este login. Conecte novamente.', 401, 'auth');
    }
    if (response.status === 403 || response.status === 429) {
      const rate = readRateLimit(response, token === null);
      if (rate.remaining === 0) {
        throw new RateLimitedError(describeRateLimit(rate), rate);
      }
      throw new GitHubError('O GitHub recusou a leitura deste repositório.', response.status, 'forbidden');
    }
    if (!response.ok) {
      throw new GitHubError(`O GitHub respondeu ${response.status}.`, response.status);
    }
    return (await response.json()) as T;
  }
}

/** The rate-limit headers, as GitHub documents them. */
export function readRateLimit(response: Response, anonymous: boolean): RateLimitInfo {
  const number = (name: string): number | null => {
    const raw = response.headers.get(name);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const reset = number('x-ratelimit-reset');
  return {
    limit: number('x-ratelimit-limit'),
    remaining: number('x-ratelimit-remaining'),
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    anonymous,
  };
}

/**
 * The rate limit, in words, with the real numbers.
 *
 * Says what the ceiling was and when it lifts, and offers the login the
 * application already has — but only when signing in would actually help. An
 * authenticated caller who has run out is told to wait, because telling them
 * to sign in again would be nonsense.
 */
export function describeRateLimit(rate: RateLimitInfo): string {
  const when = rate.resetAt
    ? ` O limite é reposto em ${new Date(rate.resetAt).toLocaleTimeString('pt-BR')}.`
    : '';
  const ceiling = rate.limit === null ? '' : ` (limite de ${rate.limit} chamadas por hora)`;
  if (rate.anonymous) {
    return (
      `O GitHub recusou mais leituras sem login${ceiling}.${when} ` +
      'Conectar a conta do GitHub em Configurações → Contas eleva bastante esse limite.'
    );
  }
  return `O GitHub recusou mais leituras nesta conta${ceiling}.${when} Tente de novo depois disso.`;
}

/**
 * Which files are worth opening.
 *
 * The order is what a person reads to understand an unfamiliar repository:
 * what it says it is, how it is built, then the shape of its source. Bounded
 * by count and by size, because the point is to understand a structure, not to
 * pay to ship a codebase through a prompt.
 */
export function chooseFiles(
  files: ReadonlyArray<{ path: string; size: number }>,
  maxFiles: number,
  maxFileBytes: number,
): Array<{ path: string; size: number }> {
  const scored = files
    // A file bigger than the per-file cap would arrive as a fragment anyway;
    // a lockfile is enormous and says nothing a human would ask about.
    .filter((file) => file.size <= maxFileBytes * 4 && !isNoise(file.path))
    .map((file) => ({ file, score: scoreOf(file.path) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.length - b.file.path.length);

  const chosen: Array<{ path: string; size: number }> = [];
  const seenDirectories = new Set<string>();
  for (const entry of scored) {
    if (chosen.length >= maxFiles) break;
    // Spread across the tree rather than taking twenty files from one folder:
    // breadth is what explains an architecture.
    const directory = entry.file.path.split('/').slice(0, -1).join('/');
    const fromHere = seenDirectories.has(directory);
    if (fromHere && chosen.length > maxFiles / 2) continue;
    seenDirectories.add(directory);
    chosen.push(entry.file);
  }
  return chosen;
}

function scoreOf(path: string): number {
  const lower = path.toLowerCase();
  const name = lower.split('/').pop() ?? lower;
  const depth = path.split('/').length;

  // What the repository says it is.
  if (/^readme(\.|$)/.test(name)) return depth === 1 ? 100 : 40;
  if (/^(architecture|design|contributing|agents|claude)\.md$/.test(name)) return depth <= 2 ? 90 : 35;
  // How it is built and what it depends on.
  if (/^(package\.json|cargo\.toml|pyproject\.toml|go\.mod|pom\.xml|build\.gradle|gemfile|composer\.json|requirements\.txt)$/.test(name)) {
    return depth === 1 ? 85 : 30;
  }
  if (/^(tsconfig\.json|dockerfile|makefile|justfile)$/.test(name)) return depth === 1 ? 55 : 20;
  // Documentation, then source.
  if (lower.startsWith('docs/') && lower.endsWith('.md')) return 50;
  if (/^(src|lib|app|apps|cmd|internal|pkg)\//.test(lower) && isSource(name)) {
    // Entry points explain more per byte than a leaf module.
    if (/^(main|index|app|mod|lib|cli)\.[a-z]+$/.test(name)) return 45 - depth;
    return 25 - depth;
  }
  if (isSource(name) && depth === 1) return 30;
  return 0;
}

function isSource(name: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|cs|swift|c|h|cc|cpp|hpp|sh|sql)$/.test(name);
}

function isNoise(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    /(^|\/)(node_modules|dist|build|out|target|vendor|\.git|coverage|\.venv|__pycache__)\//.test(lower) ||
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.lock|poetry\.lock|composer\.lock|go\.sum)$/.test(lower) ||
    /\.(png|jpe?g|gif|svg|ico|webp|pdf|zip|gz|tar|exe|dll|so|dylib|woff2?|ttf|eot|mp4|mp3|wav)$/.test(lower)
  );
}

/** A path segment, encoded once. */
function enc(value: string): string {
  return encodeURIComponent(value);
}

/** A repository path: each segment encoded, the separators kept. */
function encodePath(path: string): string {
  return path.split('/').map(enc).join('/');
}
