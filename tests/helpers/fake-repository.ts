/**
 * A GitHub that is small enough to reason about, and real enough to catch us.
 *
 * This is not a stub that returns whatever the test wants. It keeps blobs,
 * trees, commits and refs the way git does, so the sequence the application
 * performs - blob, tree from a base tree, commit, move the reference - either
 * produces the repository the test expects or it does not. A fake that simply
 * answered `{ok: true}` would pass whatever we wrote, including the bugs.
 *
 * What it deliberately does model:
 *
 *  - **`base_tree`**, so a commit that touches one file leaves the rest alone
 *    and a tree identical to its base comes back with the same sha;
 *  - **`force: false`**, so a reference that moved refuses a non-fast-forward
 *    update, which is the safety property the whole write path rests on;
 *  - **content-addressed shas**, so "did the tree change?" is answered the way
 *    GitHub answers it rather than by a flag the test sets.
 *
 * What it does not model is anything the application does not use: pagination
 * past the first page, submodules, tags, merges, and every endpoint nobody
 * calls. A fake that grew those would be a second implementation to maintain.
 */

import { createHash } from 'node:crypto';

/** The credential the device flow hands out. Never a real one. */
export const FAKE_TOKEN = 'gho_faketoken0000000000000000000000000000';

interface Blob {
  readonly content: Buffer;
}

/** path -> blob sha. Flat, because git's own trees are recovered from it. */
type TreeMap = ReadonlyMap<string, { sha: string; mode: string }>;

interface Commit {
  readonly sha: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly date: string;
}

export interface FakeRepositoryOptions {
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string;
  /** Starting content: path -> UTF-8 text. */
  readonly files: Readonly<Record<string, string>>;
  readonly isPrivate?: boolean;
  /** When false, every write answers 403, as a read-only token would. */
  readonly canWrite?: boolean;
  /**
   * Whether an anonymous read of a **private** repository answers 404.
   *
   * This is what GitHub really does, and modelling it is the only way to test
   * the difference between "you are not signed in" and "it does not exist".
   * Defaults to true; a public repository is unaffected either way.
   */
  readonly hideWhenAnonymous?: boolean;
  /**
   * Whether the credential in hand can see this repository at all.
   *
   * False is GitHub's answer to a valid user-to-server token whose App is not
   * installed here, or is installed without this repository selected: a plain
   * 404, identical to the one a repository that does not exist gets. Which of
   * those it was is decided from the installations, never from the status.
   */
  readonly visibleToCredential?: boolean;
  /**
   * The App installations `GET /user/installations` reports, and what each
   * one covers. Absent means the endpoint answers 404 - which is what an
   * OAuth-App token gets, and which the diagnosis has to survive.
   */
  readonly installations?: readonly {
    readonly id: number;
    readonly account: string;
    readonly repositorySelection?: 'all' | 'selected';
    readonly htmlUrl?: string;
    /** `owner/name` entries this installation includes. */
    readonly repositories: readonly string[];
  }[];
}

export interface FakePullRequest {
  readonly number: number;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string | null;
  readonly draft: boolean;
}

/**
 * One repository, and a `fetch` that serves it.
 *
 * `calls` records every request, so a test can assert what was *not* done -
 * that a refused change sent no blob, that a conflict wrote nothing - which is
 * most of what the safety rules are about.
 */
export class FakeRepository {
  private readonly blobs = new Map<string, Blob>();
  private readonly trees = new Map<string, TreeMap>();
  private readonly commits = new Map<string, Commit>();
  private readonly refs = new Map<string, string>();
  private readonly pulls: FakePullRequest[] = [];
  private clock = 0;

  /**
   * Every request, with whether it carried a credential.
   *
   * `authorised` is there for one rule in particular: a read that fails with a
   * credential must never be retried without one. An anonymous retry against a
   * private repository answers 404, which reads as "it does not exist" - the
   * exact untruth the diagnosis exists to prevent.
   */
  readonly calls: Array<{ method: string; path: string; body: unknown; authorised: boolean }> = [];

  /**
   * Whether the credential can see the repository. Writable, so a test can
   * grant access between two measurements and prove the second one measured
   * again rather than remembering the first.
   */
  visible = true;
  /** Set by a test to make the next matching request fail. */
  failNext: { method: string; pathIncludes: string; status: number; message?: string } | null = null;
  /** Set by a test to move the branch behind the application's back. */
  onBeforeRefUpdate: (() => void) | null = null;

  constructor(private readonly options: FakeRepositoryOptions) {
    this.visible = options.visibleToCredential !== false;
    const tree = new Map<string, { sha: string; mode: string }>();
    for (const [path, text] of Object.entries(options.files)) {
      tree.set(path, { sha: this.putBlob(Buffer.from(text, 'utf8')), mode: '100644' });
    }
    const treeSha = this.putTree(tree);
    const commit = this.putCommit(treeSha, [], 'inicial');
    this.refs.set(options.defaultBranch, commit);
  }

  /** The commit a branch points at, for a test to assert against. */
  head(branch = this.options.defaultBranch): string | null {
    return this.refs.get(branch) ?? null;
  }

  /** The repository as a branch has it now: path -> text. */
  snapshot(branch = this.options.defaultBranch): Record<string, string> {
    const commit = this.refs.get(branch);
    if (!commit) return {};
    const tree = this.trees.get(this.commits.get(commit)!.tree)!;
    const out: Record<string, string> = {};
    for (const [path, entry] of tree) {
      out[path] = this.blobs.get(entry.sha)!.content.toString('utf8');
    }
    return out;
  }

  branches(): string[] {
    return [...this.refs.keys()].sort();
  }

  pullRequests(): readonly FakePullRequest[] {
    return this.pulls;
  }

  /** Moves a branch directly, as another person's push would. */
  pushDirectly(branch: string, files: Readonly<Record<string, string>>, message = 'outra pessoa'): string {
    const parent = this.refs.get(branch);
    const base = parent ? this.trees.get(this.commits.get(parent)!.tree)! : new Map();
    const next = new Map(base);
    for (const [path, text] of Object.entries(files)) {
      next.set(path, { sha: this.putBlob(Buffer.from(text, 'utf8')), mode: '100644' });
    }
    const commit = this.putCommit(this.putTree(next), parent ? [parent] : [], message);
    this.refs.set(branch, commit);
    return commit;
  }

  /** The `fetch` to hand the application under test. */
  readonly fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    // A cancelled request never reaches a server, and this fake must not be
    // gentler than the real one: a run cancelled mid-write has to stop, not
    // finish quietly and publish.
    if (init?.signal?.aborted === true) {
      const aborted = new Error('This operation was aborted');
      aborted.name = 'AbortError';
      throw aborted;
    }
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    // The REST API is JSON; the device flow is form-encoded. Parsing both as
    // JSON is how this fake used to answer a perfectly good login request with
    // a parse error.
    const contentType = String(
      (init?.headers as Record<string, string> | undefined)?.['Content-Type'] ?? '',
    );
    const raw = init?.body ? String(init.body) : null;
    const body: unknown =
      raw === null
        ? null
        : contentType.includes('json')
          ? (JSON.parse(raw) as unknown)
          : Object.fromEntries(new URLSearchParams(raw));
    const path = url.pathname;
    this.calls.push({
      method,
      path: `${path}${url.search}`,
      body,
      authorised: Boolean((init?.headers as Record<string, string> | undefined)?.Authorization),
    });

    if (this.failNext && this.failNext.method === method && path.includes(this.failNext.pathIncludes)) {
      const failure = this.failNext;
      this.failNext = null;
      return this.json({ message: failure.message ?? 'falhou' }, failure.status);
    }

    // The device flow, so a test can connect the account through the real
    // service instead of reaching into its storage. Writing to a repository
    // needs a credential, and a test that faked one would not be testing the
    // thing that refuses without it.
    if (method === 'POST' && path === '/login/device/code') {
      return this.json({
        device_code: 'device-code-fake',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 0,
      });
    }
    if (method === 'POST' && path === '/login/oauth/access_token') {
      return this.json({ access_token: FAKE_TOKEN, token_type: 'bearer', scope: 'repo' });
    }
    // Creating a repository, as `POST /user/repos` does. The fake keeps only
    // what the application reads back; a second repository is not modelled,
    // because nothing here works on two at once.
    if (method === 'POST' && path === '/user/repos') {
      const input = body as { name?: string; private?: boolean; auto_init?: boolean };
      const name = String(input.name ?? '');
      return this.json(
        {
          full_name: `${this.options.owner}/${name}`,
          name,
          private: input.private !== false,
          default_branch: input.auto_init === false ? null : this.options.defaultBranch,
          html_url: `https://github.com/${this.options.owner}/${name}`,
        },
        201,
      );
    }
    if (method === 'GET' && path === '/user/repos') {
      return this.json([
        {
          full_name: `${this.options.owner}/${this.options.repo}`,
          name: this.options.repo,
          private: this.options.isPrivate === true,
          default_branch: this.options.defaultBranch,
          html_url: `https://github.com/${this.options.owner}/${this.options.repo}`,
          permissions: { push: this.options.canWrite !== false, admin: false },
        },
      ]);
    }
    if (method === 'GET' && path === '/user') {
      return this.json({ login: 'arcanjo', name: 'Arcanjo', avatar_url: '', html_url: '' });
    }
    // The App installations, and what each covers. Without them the
    // application cannot tell "installed elsewhere" from "does not exist" -
    // GitHub answers 404 to both on purpose.
    if (method === 'GET' && path === '/user/installations') {
      if (!this.options.installations) return this.json({ message: 'Not Found' }, 404);
      return this.json({
        total_count: this.options.installations.length,
        installations: this.options.installations.map((installation) => ({
          id: installation.id,
          app_slug: 'orquestrador',
          account: { login: installation.account },
          repository_selection: installation.repositorySelection ?? 'selected',
          html_url:
            installation.htmlUrl ?? `https://github.com/settings/installations/${installation.id}`,
        })),
      });
    }
    const covers = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
    if (method === 'GET' && covers) {
      const installation = (this.options.installations ?? []).find(
        (row) => row.id === Number(covers[1]),
      );
      if (!installation) return this.json({ message: 'Not Found' }, 404);
      return this.json({
        total_count: installation.repositories.length,
        repositories: installation.repositories.map((fullName) => ({ full_name: fullName })),
      });
    }

    const prefix = `/repos/${this.options.owner}/${this.options.repo}`;
    if (!path.startsWith(prefix)) return this.json({ message: 'Not Found' }, 404);
    const rest = path.slice(prefix.length);

    // A private repository read without a credential is "não encontrado", the
    // same answer a repository that does not exist gets. GitHub does this so a
    // token cannot be used to discover which private repositories exist, and a
    // fake that answered helpfully here would hide the bug being tested.
    const authorised = Boolean(
      (init?.headers as Record<string, string> | undefined)?.Authorization,
    );
    if (
      this.options.isPrivate === true &&
      this.options.hideWhenAnonymous !== false &&
      !authorised
    ) {
      return this.json({ message: 'Not Found' }, 404);
    }
    // Authorised, and still invisible: the App is not installed here, or is
    // installed without this repository. GitHub says 404 to both.
    if (this.visible !== true) return this.json({ message: 'Not Found' }, 404);

    if (method !== 'GET' && this.options.canWrite === false) {
      return this.json({ message: 'Resource not accessible by integration' }, 403);
    }

    if (rest === '') return this.json(this.repositoryBody());

    // GET /commits/{ref}
    const commitMatch = /^\/commits\/(.+)$/.exec(rest);
    if (method === 'GET' && commitMatch && !rest.startsWith('/commits?')) {
      const sha = this.resolve(decodeURIComponent(commitMatch[1]!));
      if (!sha) return this.json({ message: 'No commit found' }, 404);
      const commit = this.commits.get(sha)!;
      return this.json({
        sha,
        html_url: `https://github.com/${this.options.owner}/${this.options.repo}/commit/${sha}`,
        commit: { message: commit.message, tree: { sha: commit.tree }, author: { name: 'Fake', date: commit.date } },
      });
    }

    // GET /commits?sha=...
    if (method === 'GET' && rest.startsWith('/commits')) {
      const which = url.searchParams.get('sha') ?? this.options.defaultBranch;
      const start = this.resolve(which);
      if (!start) return this.json({ message: 'No commit found' }, 404);
      const out: unknown[] = [];
      let cursor: string | undefined = start;
      while (cursor && out.length < Number(url.searchParams.get('per_page') ?? 20)) {
        const commit: Commit = this.commits.get(cursor)!;
        out.push({
          sha: commit.sha,
          html_url: `https://github.com/${this.options.owner}/${this.options.repo}/commit/${commit.sha}`,
          commit: { message: commit.message, author: { name: 'Fake', date: commit.date } },
        });
        cursor = commit.parents[0];
      }
      return this.json(out);
    }

    // POST /git/commits
    if (method === 'POST' && rest === '/git/commits') {
      const input = body as { message?: string; tree?: string; parents?: string[] };
      if (!input.tree || !this.trees.has(input.tree)) {
        return this.json({ message: 'Tree does not exist' }, 422);
      }
      for (const parent of input.parents ?? []) {
        if (!this.commits.has(parent)) return this.json({ message: 'Parent does not exist' }, 422);
      }
      const sha = this.putCommit(input.tree, input.parents ?? [], String(input.message ?? ''));
      return this.json({ sha, tree: { sha: input.tree } }, 201);
    }

    // GET /git/trees/{sha}
    const treeMatch = /^\/git\/trees\/([^/?]+)/.exec(rest);
    if (method === 'GET' && treeMatch) {
      const tree = this.trees.get(decodeURIComponent(treeMatch[1]!));
      if (!tree) return this.json({ message: 'Not Found' }, 404);
      return this.json({
        sha: decodeURIComponent(treeMatch[1]!),
        truncated: false,
        tree: [...tree].map(([entryPath, entry]) => ({
          path: entryPath,
          mode: entry.mode,
          type: 'blob',
          sha: entry.sha,
          size: this.blobs.get(entry.sha)!.content.byteLength,
        })),
      });
    }

    // POST /git/trees
    if (method === 'POST' && rest === '/git/trees') {
      const input = body as { base_tree?: string; tree?: Array<Record<string, unknown>> };
      const base = input.base_tree ? this.trees.get(input.base_tree) : undefined;
      if (input.base_tree && !base) return this.json({ message: 'base_tree not found' }, 422);
      const next = new Map(base ?? new Map());
      for (const entry of input.tree ?? []) {
        const entryPath = String(entry.path);
        if (entry.sha === null) {
          if (!next.has(entryPath)) {
            return this.json({ message: `${entryPath} does not exist in the base tree` }, 422);
          }
          next.delete(entryPath);
          continue;
        }
        next.set(entryPath, { sha: String(entry.sha), mode: String(entry.mode ?? '100644') });
      }
      return this.json({ sha: this.putTree(next) }, 201);
    }

    // GET /git/blobs/{sha}
    const blobMatch = /^\/git\/blobs\/([^/?]+)/.exec(rest);
    if (method === 'GET' && blobMatch) {
      const blob = this.blobs.get(decodeURIComponent(blobMatch[1]!));
      if (!blob) return this.json({ message: 'Not Found' }, 404);
      return this.json({
        sha: decodeURIComponent(blobMatch[1]!),
        size: blob.content.byteLength,
        encoding: 'base64',
        content: blob.content.toString('base64'),
      });
    }

    // POST /git/blobs
    if (method === 'POST' && rest === '/git/blobs') {
      const input = body as { content?: string; encoding?: string };
      const bytes =
        input.encoding === 'base64'
          ? Buffer.from(input.content ?? '', 'base64')
          : Buffer.from(input.content ?? '', 'utf8');
      return this.json({ sha: this.putBlob(bytes) }, 201);
    }

    // GET /contents/{path}
    const contentsMatch = /^\/contents\/(.+)$/.exec(rest);
    if (method === 'GET' && contentsMatch) {
      const wanted = decodeURIComponent(contentsMatch[1]!.split('?')[0]!)
        .split('/')
        .map((part) => decodeURIComponent(part))
        .join('/');
      const which = url.searchParams.get('ref') ?? this.options.defaultBranch;
      const sha = this.resolve(which);
      if (!sha) return this.json({ message: 'Not Found' }, 404);
      const tree = this.trees.get(this.commits.get(sha)!.tree)!;
      const entry = tree.get(wanted);
      if (!entry) return this.json({ message: 'Not Found' }, 404);
      return this.json({
        type: 'file',
        path: wanted,
        sha: entry.sha,
        size: this.blobs.get(entry.sha)!.content.byteLength,
      });
    }

    // GET /git/ref/heads/{branch}
    const refMatch = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (method === 'GET' && refMatch) {
      const branch = decodeURIComponent(refMatch[1]!)
        .split('/')
        .map((part) => decodeURIComponent(part))
        .join('/');
      const sha = this.refs.get(branch);
      if (!sha) return this.json({ message: 'Not Found' }, 404);
      return this.json({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }

    // POST /git/refs
    if (method === 'POST' && rest === '/git/refs') {
      const input = body as { ref?: string; sha?: string };
      const branch = String(input.ref ?? '').replace(/^refs\/heads\//, '');
      if (this.refs.has(branch)) {
        return this.json({ message: 'Reference already exists' }, 422);
      }
      if (!input.sha || !this.commits.has(input.sha)) {
        return this.json({ message: 'Object does not exist' }, 422);
      }
      this.refs.set(branch, input.sha);
      return this.json({ ref: `refs/heads/${branch}`, object: { sha: input.sha } }, 201);
    }

    // PATCH /git/refs/heads/{branch}
    const patchMatch = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
    if (method === 'PATCH' && patchMatch) {
      const branch = decodeURIComponent(patchMatch[1]!)
        .split('/')
        .map((part) => decodeURIComponent(part))
        .join('/');
      // The hook a test uses to move the branch between the check and the
      // update - the race the `force: false` rule exists for.
      this.onBeforeRefUpdate?.();
      const input = body as { sha?: string; force?: boolean };
      const current = this.refs.get(branch);
      if (!current) return this.json({ message: 'Reference does not exist' }, 422);
      const target = String(input.sha);
      if (!this.commits.has(target)) return this.json({ message: 'Object does not exist' }, 422);
      if (input.force !== true && !this.isDescendant(target, current)) {
        return this.json({ message: 'Update is not a fast forward' }, 422);
      }
      this.refs.set(branch, target);
      return this.json({ ref: `refs/heads/${branch}`, object: { sha: target } });
    }

    // GET /compare/{base}...{head}
    const compareMatch = /^\/compare\/(.+)$/.exec(rest);
    if (method === 'GET' && compareMatch) {
      const [baseRef, headRef] = decodeURIComponent(compareMatch[1]!).split('...');
      const baseSha = this.resolve(baseRef ?? '');
      const headSha = this.resolve(headRef ?? '');
      if (!baseSha || !headSha) return this.json({ message: 'Not Found' }, 404);
      const before = this.trees.get(this.commits.get(baseSha)!.tree)!;
      const after = this.trees.get(this.commits.get(headSha)!.tree)!;
      const paths = new Set([...before.keys(), ...after.keys()]);
      const files: unknown[] = [];
      for (const entryPath of [...paths].sort()) {
        const a = before.get(entryPath);
        const b = after.get(entryPath);
        if (a?.sha === b?.sha) continue;
        files.push({
          filename: entryPath,
          status: !a ? 'added' : !b ? 'removed' : 'modified',
          additions: b ? 1 : 0,
          deletions: a ? 1 : 0,
          patch: `@@ ${entryPath} @@`,
        });
      }
      return this.json({ ahead_by: files.length, behind_by: 0, files });
    }

    // POST /pulls
    if (method === 'POST' && rest === '/pulls') {
      const input = body as { head?: string; base?: string; title?: string; body?: string; draft?: boolean };
      if (!this.refs.has(String(input.head))) {
        return this.json({ message: `Head branch does not exist` }, 422);
      }
      const pull: FakePullRequest = {
        number: this.pulls.length + 1,
        head: String(input.head),
        base: String(input.base),
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : null,
        draft: input.draft === true,
      };
      this.pulls.push(pull);
      return this.json(
        {
          number: pull.number,
          html_url: `https://github.com/${this.options.owner}/${this.options.repo}/pull/${pull.number}`,
          state: 'open',
          title: pull.title,
          draft: pull.draft,
        },
        201,
      );
    }

    return this.json({ message: `Not Found: ${method} ${rest}` }, 404);
  }) as typeof fetch;

  // -- git, in miniature -----------------------------------------------------

  private putBlob(content: Buffer): string {
    const sha = createHash('sha1').update('blob').update(content).digest('hex');
    this.blobs.set(sha, { content });
    return sha;
  }

  /**
   * A tree's sha is a hash of its contents, exactly as git's is.
   *
   * This is what makes "the tree came back identical to the base tree" a real
   * observation rather than a flag: writing a file's existing bytes produces
   * the same tree sha, and the application's no-empty-commit rule is then
   * being tested against the same signal GitHub gives it.
   */
  private putTree(entries: TreeMap): string {
    const canonical = [...entries]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, entry]) => `${entry.mode} ${path} ${entry.sha}`)
      .join('\n');
    const sha = createHash('sha1').update('tree').update(canonical).digest('hex');
    this.trees.set(sha, new Map(entries));
    return sha;
  }

  private putCommit(tree: string, parents: readonly string[], message: string): string {
    this.clock += 1;
    const date = new Date(Date.UTC(2026, 0, 1, 0, 0, this.clock)).toISOString();
    const sha = createHash('sha1')
      .update('commit')
      .update(`${tree}\n${parents.join(',')}\n${message}\n${date}`)
      .digest('hex');
    this.commits.set(sha, { sha, tree, parents: [...parents], message, date });
    return sha;
  }

  private resolve(which: string): string | null {
    if (this.commits.has(which)) return which;
    const branch = this.refs.get(which);
    if (branch) return branch;
    if (which === 'HEAD') return this.refs.get(this.options.defaultBranch) ?? null;
    return null;
  }

  /** True when `candidate` has `ancestor` somewhere behind it. */
  private isDescendant(candidate: string, ancestor: string): boolean {
    const seen = new Set<string>();
    const stack = [candidate];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      stack.push(...(this.commits.get(sha)?.parents ?? []));
    }
    return false;
  }

  private repositoryBody(): Record<string, unknown> {
    return {
      full_name: `${this.options.owner}/${this.options.repo}`,
      description: null,
      private: this.options.isPrivate === true,
      default_branch: this.options.defaultBranch,
    };
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      },
    });
  }
}
