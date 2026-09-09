/**
 * Working on a repository without a checkout.
 *
 * ## What this is, and what it is not
 *
 * Three capabilities get confused with one another, and the confusion is the
 * whole reason this file says so at the top:
 *
 *  - **reading** a repository - metadata, branches, trees, files, commits,
 *    diffs - which the documented REST API does completely;
 *  - **editing** it - blobs, trees, commits, refs, pull requests - which the
 *    documented REST API also does completely, atomically, and without a
 *    working copy anywhere;
 *  - **running code** - installing dependencies, executing tests, starting a
 *    browser - which the GitHub API does **not** do at all, and no amount of
 *    this file will make it.
 *
 * A project can want all three. This module provides the first two and is
 * deliberately silent about the third: something else runs code, and the
 * interface says where.
 *
 * ## The rules that do not bend
 *
 * - **A write is a compare-and-set.** Every commit names the head it expects,
 *   and the reference is moved with `force: false`, so a branch somebody else
 *   moved in the meantime produces a conflict rather than a lost change.
 * - **A change set is one commit.** Blobs, then one tree from the base tree,
 *   then one commit, then one reference update. Never a file at a time: a
 *   sequence of independent commits leaves the branch in states nobody asked
 *   for, and half of them survive a failure.
 * - **No empty commit.** If the tree comes back identical to the base tree,
 *   nothing changed, and nothing is committed to make a run look productive.
 * - **Nothing is guessed.** The default branch comes from GitHub. A file that
 *   is too large, or of a kind this cannot handle, is refused by name - never
 *   silently skipped and never reported as written.
 * - **The token never leaves this layer.** It is supplied per call by the
 *   application, and no model, prompt, renderer or log ever sees it.
 */

import { GitHubError, GITHUB_ENDPOINTS, type GitHubEndpoints } from './github-client.js';
import {
  RateLimitedError,
  describeRateLimit,
  readRateLimit,
  type RepositoryRef,
} from './repository-reader.js';

/** A file mode. Only the two a normal edit produces are ever written. */
const FILE_MODE = '100644';
const EXECUTABLE_MODE = '100755';

export const OPERATION_LIMITS = {
  /** Files in one change set. A commit past this is a checkout's job. */
  maxFiles: 100,
  /** One file. The blob API takes more; a desktop edit that big is a mistake. */
  maxFileBytes: 1024 * 1024,
  /** Everything in one change set, so one commit cannot become an upload. */
  maxTotalBytes: 8 * 1024 * 1024,
  /** A path, in characters. */
  maxPathLength: 400,
} as const;

/** What the application asks the repository to become. */
export type RepositoryChange =
  | {
      readonly op: 'write';
      readonly path: string;
      /** UTF-8 text. Exactly one of `text` and `base64` is given. */
      readonly text?: string;
      /** Any bytes, base64-encoded, for a file that is not text. */
      readonly base64?: string;
      /** True for a file git should mark executable. */
      readonly executable?: boolean;
    }
  | { readonly op: 'delete'; readonly path: string };

export interface CommitRequest {
  readonly branch: string;
  /**
   * The commit the change was written against.
   *
   * The heart of the safety rule: if the branch no longer points here,
   * somebody else moved it, and this commit is refused rather than applied on
   * top of work it never saw.
   */
  readonly expectedHeadSha: string;
  readonly message: string;
  readonly changes: readonly RepositoryChange[];
}

export interface CommitResult {
  readonly committed: boolean;
  /** Null when nothing changed, which is not a failure. */
  readonly commitSha: string | null;
  readonly treeSha: string | null;
  readonly branch: string;
  readonly parentSha: string;
  /** The paths this commit actually wrote or removed. */
  readonly written: readonly string[];
  readonly deleted: readonly string[];
  /** Said out loud when the tree came back identical to the base tree. */
  readonly note: string | null;
}

/** A branch that moved under us. Recoverable, and never resolved by force. */
export class RepositoryConflictError extends Error {
  readonly code = 'REPOSITORY_CONFLICT';
  constructor(
    message: string,
    readonly branch: string,
    readonly expectedSha: string,
    readonly actualSha: string | null,
  ) {
    super(message);
    this.name = 'RepositoryConflictError';
  }
}

/** A change this layer will not attempt, said by name rather than skipped. */
export class UnsupportedChangeError extends Error {
  readonly code = 'UNSUPPORTED_CHANGE';
  constructor(
    message: string,
    readonly path: string,
    readonly reason:
      | 'too-large'
      | 'too-many-files'
      | 'total-too-large'
      | 'invalid-path'
      | 'both-encodings'
      | 'missing-content',
  ) {
    super(message);
    this.name = 'UnsupportedChangeError';
  }
}

export interface TreeEntry {
  readonly path: string;
  readonly type: 'blob' | 'tree';
  readonly size: number | null;
  readonly sha: string;
}

export interface RepositoryTree {
  readonly ref: string;
  readonly commitSha: string;
  readonly entries: readonly TreeEntry[];
  /** GitHub's own flag: the tree was too big to return whole. */
  readonly truncated: boolean;
}

export interface FileContent {
  readonly path: string;
  readonly ref: string;
  readonly commitSha: string;
  /** The blob sha, which is what a later write compares against. */
  readonly sha: string;
  readonly bytes: number;
  /** Null when the file is not valid UTF-8 text; `bytes` still says its size. */
  readonly text: string | null;
  readonly isBinary: boolean;
  readonly truncated: boolean;
}

export interface CommitSummary {
  readonly sha: string;
  readonly message: string;
  readonly author: string | null;
  readonly date: string | null;
  readonly htmlUrl: string | null;
}

export interface FileDiff {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  /** GitHub omits the patch for large or binary files; null says so. */
  readonly patch: string | null;
  readonly previousPath: string | null;
}

export interface RepositoryDiff {
  readonly base: string;
  readonly head: string;
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly files: readonly FileDiff[];
  readonly truncated: boolean;
}

export interface PullRequestSummary {
  readonly number: number;
  readonly htmlUrl: string;
  readonly state: string;
  readonly title: string;
  readonly head: string;
  readonly base: string;
  readonly draft: boolean;
}

export interface RepositoryOperationsOptions {
  readonly endpoints?: GitHubEndpoints;
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
  readonly limits?: Partial<typeof OPERATION_LIMITS>;
}

/**
 * Every documented operation this application performs on a repository.
 *
 * The token is a parameter of each call rather than state of the object: it
 * comes from the secret store at the moment it is needed, and nothing here
 * keeps it, prints it, or hands it anywhere else.
 */
export class RepositoryOperations {
  private readonly endpoints: GitHubEndpoints;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly limits: typeof OPERATION_LIMITS;

  constructor(options: RepositoryOperationsOptions = {}) {
    this.endpoints = options.endpoints ?? GITHUB_ENDPOINTS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? 'AI-Orchestrator';
    this.limits = { ...OPERATION_LIMITS, ...(options.limits ?? {}) };
  }

  // -- Reading ---------------------------------------------------------------

  /**
   * The commit a ref points at, whatever kind of ref it is.
   *
   * A branch name, a tag, a sha or `HEAD`: the commits endpoint resolves all
   * of them, which is why this asks it rather than assuming a branch. Nothing
   * here ever falls back to `main`.
   */
  async resolveRef(
    ref: RepositoryRef,
    which: string,
    token: string | null,
    signal?: AbortSignal,
  ): Promise<{ ref: string; commitSha: string; treeSha: string }> {
    const commit = await this.send<{ sha?: unknown; commit?: { tree?: { sha?: unknown } } }>(
      'GET',
      `/repos/${enc(ref.owner)}/${enc(ref.repo)}/commits/${encodeURIComponent(which)}`,
      token,
      null,
      signal,
    );
    const sha = typeof commit.sha === 'string' ? commit.sha : null;
    const treeSha = typeof commit.commit?.tree?.sha === 'string' ? commit.commit.tree.sha : null;
    if (!sha || !treeSha) {
      throw new GitHubError(`O GitHub não resolveu "${which}" para um commit.`, 502, 'api');
    }
    return { ref: which, commitSha: sha, treeSha };
  }

  /** The whole tree at a ref, in one call, with GitHub's truncation flag kept. */
  async tree(
    ref: RepositoryRef,
    which: string,
    token: string | null,
    signal?: AbortSignal,
  ): Promise<RepositoryTree> {
    const resolved = await this.resolveRef(ref, which, token, signal);
    const body = await this.send<{ tree?: unknown; truncated?: unknown }>(
      'GET',
      `/repos/${enc(ref.owner)}/${enc(ref.repo)}/git/trees/${enc(resolved.treeSha)}?recursive=1`,
      token,
      null,
      signal,
    );
    const rows = Array.isArray(body.tree) ? body.tree : [];
    const entries: TreeEntry[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const entry = row as { path?: unknown; type?: unknown; size?: unknown; sha?: unknown };
      if (typeof entry.path !== 'string' || typeof entry.sha !== 'string') continue;
      if (entry.type !== 'blob' && entry.type !== 'tree') continue;
      entries.push({
        path: entry.path,
        type: entry.type,
        size: typeof entry.size === 'number' ? entry.size : null,
        sha: entry.sha,
      });
    }
    return {
      ref: which,
      commitSha: resolved.commitSha,
      entries,
      truncated: body.truncated === true,
    };
  }

  /**
   * One file, at one ref.
   *
   * The metadata comes from the contents endpoint and the bytes from the blob
   * endpoint, because the contents endpoint refuses to return a file over
   * 1 MB - and answering "I could not read that" for a file the repository
   * plainly has would be a statement about the endpoint dressed up as a
   * statement about the repository.
   *
   * Text and bytes are told apart by decoding: a blob that does not round-trip
   * as UTF-8 is reported as binary with its size, never as mangled text.
   */
  async readFile(
    ref: RepositoryRef,
    path: string,
    which: string,
    token: string | null,
    signal?: AbortSignal,
    maxBytes = this.limits.maxFileBytes,
  ): Promise<FileContent> {
    const resolved = await this.resolveRef(ref, which, token, signal);
    const meta = await this.send<{ sha?: unknown; size?: unknown; type?: unknown }>(
      'GET',
      `/repos/${enc(ref.owner)}/${enc(ref.repo)}/contents/${path
        .split('/')
        .map((part) => enc(part))
        .join('/')}?ref=${enc(resolved.commitSha)}`,
      token,
      null,
      signal,
    );
    if (meta.type !== 'file') {
      throw new GitHubError(`"${path}" não é um arquivo neste commit.`, 400, 'api');
    }
    const sha = typeof meta.sha === 'string' ? meta.sha : null;
    const size = typeof meta.size === 'number' ? meta.size : 0;
    if (!sha) throw new GitHubError(`O GitHub não informou o sha de "${path}".`, 502, 'api');

    if (size > maxBytes) {
      return {
        path,
        ref: which,
        commitSha: resolved.commitSha,
        sha,
        bytes: size,
        text: null,
        isBinary: false,
        truncated: true,
      };
    }

    const blob = await this.send<{ content?: unknown; encoding?: unknown }>(
      'GET',
      `/repos/${enc(ref.owner)}/${enc(ref.repo)}/git/blobs/${enc(sha)}`,
      token,
      null,
      signal,
    );
    const raw =
      typeof blob.content === 'string' && blob.encoding === 'base64'
        ? Buffer.from(blob.content, 'base64')
        : Buffer.alloc(0);
    const text = decodeUtf8(raw);
    return {
      path,
      ref: which,
      commitSha: resolved.commitSha,
      sha,
      bytes: raw.byteLength,
      text,
      isBinary: text === null,
      truncated: false,
    };
  }

  /** The most recent commits touching a ref, newest first. */
  async commits(
    ref: RepositoryRef,
    which: string,
    token: string | null,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<CommitSummary[]> {
    const rows = await this.send<unknown[]>(
      'GET',
      `/repos/${enc(ref.owner)}/${enc(ref.repo)}/commits?sha=${enc(which)}&per_page=${Math.min(
        Math.max(limit, 1),
        100,
      )}`,
      token,
      null,
      signal,
    );
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const item = row as {
        sha?: unknown;
        html_url?: unknown;
        commit?: { message?: unknown; author?: { name?: unknown; date?: unknown } };
      };
      if (typeof item.sha !== 'string') return [];
      return [
        {
          sha: item.sha,
          message: typeof item.commit?.message === 'string' ? item.commit.message : '',
          author: typeof item.commit?.author?.name === 'string' ? item.commit.author.name : null,
          date: typeof item.commit?.author?.date === 'string' ? item.commit.author.date : null,
          htmlUrl: typeof item.html_url === 'string' ? item.html_url : null,
        },
      ];
    });
  }

  /**
   * What changed between two refs, as GitHub itself computes it.
   *
   * This is the evidence for a run in this mode: the application asks the
   * repository what happened, rather than believing a report about it.
   */
  async compare(
    ref: RepositoryRef,
    base: string,
    head: string,
    token: string | null,
    signal?: AbortSignal,
  ): Promise<RepositoryDiff> {
    const body = await this.send<{ ahead_by?: unknown; behind_by?: unknown; files?: unknown }>(
      'GET',
      `/repos/${enc(ref.owner)}/${enc(ref.repo)}/compare/${encodeURIComponent(
        base,
      )}...${encodeURIComponent(head)}`,
      token,
      null,
      signal,
    );
    const rows = Array.isArray(body.files) ? body.files : [];
    const files: FileDiff[] = rows.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const item = row as {
        filename?: unknown;
        status?: unknown;
        additions?: unknown;
        deletions?: unknown;
        patch?: unknown;
        previous_filename?: unknown;
      };
      if (typeof item.filename !== 'string') return [];
      return [
        {
          path: item.filename,
          status: typeof item.status === 'string' ? item.status : 'modified',
          additions: typeof item.additions === 'number' ? item.additions : 0,
          deletions: typeof item.deletions === 'number' ? item.deletions : 0,
          // Absent for a binary file and for a diff GitHub judged too large.
          // Null says "not provided", which is not the same as "no change".
          patch: typeof item.patch === 'string' ? item.patch : null,
          previousPath: typeof item.previous_filename === 'string' ? item.previous_filename : null,
        },
      ];
    });
    return {
      base,
      head,
      aheadBy: typeof body.ahead_by === 'number' ? body.ahead_by : files.length,
      behindBy: typeof body.behind_by === 'number' ? body.behind_by : 0,
      files,
      // The comparison endpoint pages its file list at 300; more than that and
      // the list in hand is not the whole story, and must not be presented as
      // though it were.
      truncated: files.length >= 300,
    };
  }

  // -- Writing ---------------------------------------------------------------

  /**
   * Creates a branch at a commit.
   *
   * Refused, not overwritten, when the branch already exists: taking over a
   * name somebody else is using is the kind of surprise this whole layer is
   * built to avoid. The caller picks another name and says so.
   */
  async createBranch(
    ref: RepositoryRef,
    branch: string,
    fromCommitSha: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<{ branch: string; commitSha: string }> {
    const body = await this.send<{ object?: { sha?: unknown } }>(
      'POST',
      `/repos/${enc(ref.owner)}/${enc(ref.repo)}/git/refs`,
      token,
      { ref: `refs/heads/${branch}`, sha: fromCommitSha },
      signal,
    );
    const sha = typeof body.object?.sha === 'string' ? body.object.sha : fromCommitSha;
    return { branch, commitSha: sha };
  }

  /** The commit a branch points at, or null when the branch does not exist. */
  async branchHead(
    ref: RepositoryRef,
    branch: string,
    token: string | null,
    signal?: AbortSignal,
  ): Promise<string | null> {
    try {
      const body = await this.send<{ object?: { sha?: unknown } }>(
        'GET',
        `/repos/${enc(ref.owner)}/${enc(ref.repo)}/git/ref/heads/${branch
          .split('/')
          .map((part) => enc(part))
          .join('/')}`,
        token,
        null,
        signal,
      );
      return typeof body.object?.sha === 'string' ? body.object.sha : null;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * One commit, from a whole change set, on a branch that has not moved.
   *
   * The sequence is the documented one, and every step of it is checked:
   *
   *  1. the branch still points at `expectedHeadSha` - otherwise a conflict,
   *     with both shas named, and nothing written;
   *  2. a blob per written file;
   *  3. one tree, built on the base tree, so untouched files stay untouched;
   *  4. **if the tree is the base tree, stop** - nothing changed, and an empty
   *     commit to show progress is exactly the dishonesty this refuses;
   *  5. one commit with the expected head as its only parent;
   *  6. the reference moved with `force: false`, so a branch that moved
   *     between step 1 and step 6 still cannot be overwritten.
   */
  async commit(
    ref: RepositoryRef,
    request: CommitRequest,
    token: string,
    signal?: AbortSignal,
  ): Promise<CommitResult> {
    const changes = this.validate(request.changes);

    const head = await this.branchHead(ref, request.branch, token, signal);
    if (head !== request.expectedHeadSha) {
      throw new RepositoryConflictError(
        head === null
          ? `A branch "${request.branch}" não existe mais. Nada foi escrito.`
          : `A branch "${request.branch}" mudou desde que esta alteração foi preparada ` +
            `(esperado ${short(request.expectedHeadSha)}, encontrado ${short(head)}). Nada foi escrito.`,
        request.branch,
        request.expectedHeadSha,
        head,
      );
    }

    const base = await this.resolveRef(ref, request.expectedHeadSha, token, signal);

    // A delete of a path the tree does not have is refused by GitHub, and the
    // message it gives is not one a person can act on. Checked here so the
    // answer names the file.
    const deletes = changes.filter((change) => change.op === 'delete');
    if (deletes.length > 0) {
      const existing = new Set(
        (await this.tree(ref, request.expectedHeadSha, token, signal)).entries
          .filter((entry) => entry.type === 'blob')
          .map((entry) => entry.path),
      );
      const missing = deletes.map((change) => change.path).filter((path) => !existing.has(path));
      if (missing.length > 0) {
        throw new UnsupportedChangeError(
          `Não dá para remover o que não existe em ${short(request.expectedHeadSha)}: ` +
            `${missing.join(', ')}. Nada foi escrito.`,
          missing[0]!,
          'invalid-path',
        );
      }
    }

    const entries: Array<Record<string, unknown>> = [];
    const written: string[] = [];
    const deleted: string[] = [];
    for (const change of changes) {
      if (change.op === 'delete') {
        // The documented way to remove a path from a tree: the entry is
        // present, and its sha is null.
        entries.push({ path: change.path, mode: FILE_MODE, type: 'blob', sha: null });
        deleted.push(change.path);
        continue;
      }
      const blob = await this.send<{ sha?: unknown }>(
        'POST',
        `/repos/${enc(ref.owner)}/${enc(ref.repo)}/git/blobs`,
        token,
        change.text !== undefined
          ? { content: change.text, encoding: 'utf-8' }
          : { content: change.base64, encoding: 'base64' },
        signal,
      );
      if (typeof blob.sha !== 'string') {
        throw new GitHubError(`O GitHub não devolveu um blob para "${change.path}".`, 502, 'api');
      }
      entries.push({
        path: change.path,
        mode: change.executable === true ? EXECUTABLE_MODE : FILE_MODE,
        type: 'blob',
        sha: blob.sha,
      });
      written.push(change.path);
    }

    const tree = await this.send<{ sha?: unknown }>(
      'POST',
      `/repos/${enc(ref.owner)}/${enc(ref.repo)}/git/trees`,
      token,
      { base_tree: base.treeSha, tree: entries },
      signal,
    );
    if (typeof tree.sha !== 'string') {
      throw new GitHubError('O GitHub não devolveu uma árvore.', 502, 'api');
    }

    // Nothing changed. Not a failure, and not a commit either.
    if (tree.sha === base.treeSha) {
      return {
        committed: false,
        commitSha: null,
        treeSha: tree.sha,
        branch: request.branch,
        parentSha: request.expectedHeadSha,
        written: [],
        deleted: [],
        note:
          'A árvore resultante é idêntica à de origem: o conteúdo enviado já era o conteúdo do ' +
          'repositório. Nenhum commit foi criado.',
      };
    }

    const commit = await this.send<{ sha?: unknown }>(
      'POST',
      `/repos/${enc(ref.owner)}/${enc(ref.repo)}/git/commits`,
      token,
      { message: request.message, tree: tree.sha, parents: [request.expectedHeadSha] },
      signal,
    );
    if (typeof commit.sha !== 'string') {
      throw new GitHubError('O GitHub não devolveu um commit.', 502, 'api');
    }

    try {
      await this.send(
        'PATCH',
        `/repos/${enc(ref.owner)}/${enc(ref.repo)}/git/refs/heads/${request.branch
          .split('/')
          .map((part) => enc(part))
          .join('/')}`,
        token,
        // `force: false` is the whole safety property, and it is stated
        // explicitly rather than left to a default: a non-fast-forward update
        // is refused by GitHub, so a branch that moved between step 1 and here
        // still cannot be overwritten.
        { sha: commit.sha, force: false },
        signal,
      );
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 422 || error.status === 409)) {
        throw new RepositoryConflictError(
          `A branch "${request.branch}" mudou enquanto o commit era criado, e mover a referência ` +
            'exigiria sobrescrever esse trabalho. Nada foi publicado.',
          request.branch,
          request.expectedHeadSha,
          null,
        );
      }
      throw error;
    }

    return {
      committed: true,
      commitSha: commit.sha,
      treeSha: tree.sha,
      branch: request.branch,
      parentSha: request.expectedHeadSha,
      written,
      deleted,
      note: null,
    };
  }

  /** Opens a pull request from one branch to another. Never merges it. */
  async openPullRequest(
    ref: RepositoryRef,
    input: { head: string; base: string; title: string; body?: string; draft?: boolean },
    token: string,
    signal?: AbortSignal,
  ): Promise<PullRequestSummary> {
    const body = await this.send<{
      number?: unknown;
      html_url?: unknown;
      state?: unknown;
      title?: unknown;
      draft?: unknown;
    }>(
      'POST',
      `/repos/${enc(ref.owner)}/${enc(ref.repo)}/pulls`,
      token,
      {
        title: input.title,
        head: input.head,
        base: input.base,
        ...(input.body ? { body: input.body } : {}),
        ...(input.draft ? { draft: true } : {}),
      },
      signal,
    );
    if (typeof body.number !== 'number' || typeof body.html_url !== 'string') {
      throw new GitHubError('O GitHub não devolveu um pull request utilizável.', 502, 'api');
    }
    return {
      number: body.number,
      htmlUrl: body.html_url,
      state: typeof body.state === 'string' ? body.state : 'open',
      title: typeof body.title === 'string' ? body.title : input.title,
      head: input.head,
      base: input.base,
      draft: body.draft === true,
    };
  }

  // -- Internals -------------------------------------------------------------

  /**
   * Checks a change set before a single byte is sent.
   *
   * Every refusal here names the file and the reason. The one thing this must
   * never do is drop a change quietly: a run that reports success while one of
   * its files was skipped is worse than a run that failed.
   */
  private validate(changes: readonly RepositoryChange[]): readonly RepositoryChange[] {
    if (changes.length === 0) {
      throw new UnsupportedChangeError('Nenhuma alteração foi enviada.', '', 'missing-content');
    }
    if (changes.length > this.limits.maxFiles) {
      throw new UnsupportedChangeError(
        `Esta alteração toca ${changes.length} arquivos, e o limite por commit é ` +
          `${this.limits.maxFiles}. Divida a tarefa, ou use um executor com checkout.`,
        changes[0]!.path,
        'too-many-files',
      );
    }
    const seen = new Set<string>();
    let total = 0;
    for (const change of changes) {
      const problem = pathProblem(change.path, this.limits.maxPathLength);
      if (problem) throw new UnsupportedChangeError(problem, change.path, 'invalid-path');
      if (seen.has(change.path)) {
        throw new UnsupportedChangeError(
          `"${change.path}" aparece duas vezes na mesma alteração. Qual das duas vale não é uma ` +
            'pergunta que este programa deva responder sozinho.',
          change.path,
          'invalid-path',
        );
      }
      seen.add(change.path);
      if (change.op === 'delete') continue;
      const hasText = typeof change.text === 'string';
      const hasBase64 = typeof change.base64 === 'string';
      if (hasText && hasBase64) {
        throw new UnsupportedChangeError(
          `"${change.path}" veio com texto e com base64 ao mesmo tempo. Nada foi escrito.`,
          change.path,
          'both-encodings',
        );
      }
      if (!hasText && !hasBase64) {
        throw new UnsupportedChangeError(
          `"${change.path}" não trouxe conteúdo nenhum. Para remover um arquivo, use a operação ` +
            '"delete": um arquivo vazio e um arquivo removido não são a mesma coisa.',
          change.path,
          'missing-content',
        );
      }
      const bytes = hasText
        ? Buffer.byteLength(change.text!, 'utf8')
        : Buffer.from(change.base64!, 'base64').byteLength;
      if (bytes > this.limits.maxFileBytes) {
        throw new UnsupportedChangeError(
          `"${change.path}" tem ${bytes} bytes, acima do limite de ${this.limits.maxFileBytes} por ` +
            'arquivo nesta modalidade. Uma alteração desse tamanho precisa de um executor com checkout.',
          change.path,
          'too-large',
        );
      }
      total += bytes;
    }
    if (total > this.limits.maxTotalBytes) {
      throw new UnsupportedChangeError(
        `A alteração soma ${total} bytes, acima do limite de ${this.limits.maxTotalBytes} por commit.`,
        changes[0]!.path,
        'total-too-large',
      );
    }
    return changes;
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
    path: string,
    token: string | null,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoints.apiBase}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': this.userAgent,
          ...(body !== null && body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== null && body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new GitHubError(`Sem conexão com o GitHub: ${(error as Error).message}`, 0, 'network');
    }

    if (response.status === 404) {
      throw new GitHubError(
        'O GitHub respondeu "não encontrado". Pode ser o endereço, a branch, o arquivo — ou uma ' +
          'conta sem acesso a um repositório privado: o GitHub responde igual nos dois casos, de propósito.',
        404,
        'not-found',
      );
    }
    if (response.status === 401) {
      throw new GitHubError('O GitHub não aceitou este login. Conecte a conta novamente.', 401, 'auth');
    }
    if (response.status === 403 || response.status === 429) {
      const rate = readRateLimit(response, token === null);
      if (rate.remaining === 0) throw new RateLimitedError(describeRateLimit(rate), rate);
      throw new GitHubError(
        method === 'GET'
          ? 'O GitHub recusou esta leitura. A conta conectada pode não ter acesso a este repositório.'
          : 'O GitHub recusou esta escrita. A conta conectada pode não ter permissão de escrita ' +
            'neste repositório, ou a branch pode estar protegida.',
        response.status,
        'forbidden',
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GitHubError(
        `O GitHub respondeu ${response.status}. ${firstMessage(text) ?? ''}`.trim(),
        response.status,
        'api',
        text.slice(0, 400),
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

/** Why a path cannot be written, or null when it can. */
export function pathProblem(path: string, maxLength = OPERATION_LIMITS.maxPathLength): string | null {
  const value = path.trim();
  if (value.length === 0) return 'Um caminho vazio não é um arquivo.';
  if (value.length > maxLength) return `O caminho "${value.slice(0, 60)}…" é longo demais.`;
  if (value !== path) return `"${path}" começa ou termina com espaço, o que quase nunca é intencional.`;
  if (value.startsWith('/')) return `"${path}" é absoluto. Um caminho de repositório é relativo à raiz.`;
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return `"${path}" é um caminho do Windows, não um caminho do repositório.`;
  }
  if (value.includes('\\')) return `"${path}" usa "\\". Caminhos de repositório usam "/".`;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return `"${path}" sai da raiz do repositório ou tem um segmento vazio.`;
  }
  if (segments[0] === '.git') return 'O diretório .git não é conteúdo do repositório.';
  // A control character in a path is either a mistake or an attempt to make one
  // thing look like another on screen.
  if (/[\u0000-\u001f\u007f]/.test(value)) return `"${path}" contém caracteres de controle.`;
  return null;
}

/** The text of a blob, or null when the bytes are not valid UTF-8. */
function decodeUtf8(bytes: Buffer): string | null {
  if (bytes.byteLength === 0) return '';
  // A NUL byte is the oldest and most reliable "this is not text" signal, and
  // it is one `TextDecoder` would happily pass through.
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function firstMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    /* not JSON; the excerpt carries it */
  }
  return null;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

function enc(value: string): string {
  return encodeURIComponent(value);
}
