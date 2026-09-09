/**
 * A project whose code lives on GitHub and nowhere else on this computer.
 *
 * ## What this is for
 *
 * "Quero trabalhar diretamente com meus repositórios GitHub, sem precisar
 * clonar manualmente cada projeto." This service is how: it holds the
 * connected account's token, resolves a project to a repository, and performs
 * the documented API operations on the application's behalf.
 *
 * ## The three capabilities, kept apart
 *
 * A project can read its repository, edit it, and - separately, and only
 * sometimes - run its code. The first two happen here, through the REST API,
 * with no folder anywhere. The third does not happen here at all and cannot:
 * the GitHub API is not an executor. `capabilities()` answers all three
 * honestly, and the interface shows the answer rather than discovering it
 * halfway through a run.
 *
 * ## The rules that do not bend
 *
 * - **The token stays here.** It is fetched when an operation needs it and
 *   never returned, logged, put in a prompt, or handed to the renderer.
 * - **Reading does not require a login.** A public repository is read
 *   anonymously; being asked to sign in to read something the world can read
 *   is a toll, not a security measure.
 * - **Writing never touches the base branch.** Work happens on a branch this
 *   application created, and a pull request is offered - never a merge.
 * - **Nothing is guessed.** The default branch comes from GitHub.
 */

import type { Database, WorkspaceWithAgents } from '../core.js';
import {
  RepositoryOperations,
  type CommitResult,
  type CommitSummary,
  type FileContent,
  type PullRequestSummary,
  type RepositoryChange,
  type RepositoryDiff,
  type RepositoryTree,
} from '../../../../../src/github/repository-operations.js';
import { parseRepositoryUrl, type RepositoryRef } from '../../../../../src/github/repository-reader.js';
import { GitHubError } from '../../../../../src/github/github-client.js';
import {
  diagnoseAccess,
  type AccessAction,
  type AccessDiagnosis,
  type AccessProblem,
  type RequestOutcome,
} from '../../../../../src/github/access-diagnosis.js';
import type { GitHubService } from './github-service.js';

export class GitHubWorkspaceError extends Error {
  constructor(
    message: string,
    readonly code:
      /** The project is not connected to a repository at all. */
      | 'NO_REPOSITORY'
      /** The stored address is not a GitHub repository this can parse. */
      | 'BAD_REPOSITORY'
      /** Nobody is signed in, and this operation needs a credential. */
      | 'NOT_CONNECTED' = 'NO_REPOSITORY',
  ) {
    super(message);
    this.name = 'GitHubWorkspaceError';
  }
}

/**
 * What a project can actually do, told before a run rather than during one.
 *
 * `execute` is the honest one. Reading and editing are properties of the
 * repository and the token; running code is a property of having somewhere to
 * run it, which GitHub is not.
 */
export interface RepositoryCapabilities {
  readonly fullName: string | null;
  readonly defaultBranch: string | null;
  readonly isPrivate: boolean | null;
  /** True when this application can read the repository right now. */
  readonly canRead: boolean;
  /** True when a credential able to write is connected. Null when unknown. */
  readonly canWrite: boolean | null;
  /** Why reading or writing is unavailable, in words for a person. */
  readonly problem: string | null;
  /**
   * Which of the situations a 404 can mean, once they have been told apart.
   *
   * `problem` used to be the raw GitHub sentence - "o GitHub respondeu não
   * encontrado" - for a private repository the person had just created and
   * authorised. That is four different situations wearing one status code, and
   * three of them are fixable. This says which, and `action` says where.
   */
  readonly access: AccessProblem;
  /** The official GitHub page that fixes it, when there is one. */
  readonly action: AccessAction | null;
  /** Where code would run, if a task needed code run. Never "the API". */
  readonly execution: 'none' | 'local-temporary';
}

export interface WorkSession {
  readonly fullName: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
  readonly workBranch: string;
}

export class GitHubWorkspaceService {
  private readonly operations: RepositoryOperations;

  constructor(
    private readonly database: Database,
    private readonly github: GitHubService,
    operations?: RepositoryOperations,
  ) {
    this.operations = operations ?? new RepositoryOperations();
  }

  /** The repository a project points at, refusing rather than guessing. */
  refFor(workspaceId: string): { ref: RepositoryRef; workspace: WorkspaceWithAgents } {
    const workspace = this.database.workspaces.require(workspaceId);
    const url = workspace.repository_url;
    if (!url) {
      throw new GitHubWorkspaceError(
        'Este projeto não está conectado a um repositório do GitHub.',
        'NO_REPOSITORY',
      );
    }
    const ref = parseRepositoryUrl(url);
    if (!ref) {
      throw new GitHubWorkspaceError(
        `"${url}" não é um endereço de repositório do GitHub que eu saiba ler.`,
        'BAD_REPOSITORY',
      );
    }
    return { ref, workspace };
  }

  /**
   * What this project can do, measured rather than assumed.
   *
   * One request. It asks GitHub for the repository, which answers three things
   * at once: whether it can be reached with the credential in hand, what the
   * default branch really is, and whether the token's permissions include
   * writing. A project that cannot be read says why, and does not pretend the
   * cause is something the person can fix by choosing a folder.
   */
  async capabilities(workspaceId: string, signal?: AbortSignal): Promise<RepositoryCapabilities> {
    let ref: RepositoryRef;
    try {
      ref = this.refFor(workspaceId).ref;
    } catch (error) {
      return {
        fullName: null,
        defaultBranch: null,
        isPrivate: null,
        canRead: false,
        canWrite: null,
        problem: error instanceof Error ? error.message : String(error),
        // The project has no readable address at all, so no GitHub page fixes
        // it: this one is settled in the project's own settings.
        access: 'unknown',
        action: null,
        execution: 'none',
      };
    }
    const token = await this.github.accessTokenIfConnected();
    try {
      const meta = await this.operations.repository(ref, token, signal);
      return {
        fullName: meta.fullName,
        defaultBranch: meta.defaultBranch,
        isPrivate: meta.isPrivate,
        canRead: true,
        // GitHub reports the viewer's permissions on the repository. Absent
        // for an anonymous read, and null then rather than false: "I do not
        // know" is a different answer from "you may not".
        canWrite: meta.canPush,
        problem: null,
        access: 'ok',
        action: null,
        execution: 'none',
      };
    } catch (error) {
      // Never the raw status. What a person can do about it is the answer.
      const diagnosis = await this.diagnose(ref, error, signal);
      return {
        fullName: null,
        defaultBranch: null,
        isPrivate: null,
        canRead: false,
        canWrite: null,
        problem: diagnosis.summary,
        access: diagnosis.problem,
        action: diagnosis.action,
        execution: 'none',
      };
    }
  }

  /**
   * Why the repository could not be read, measured rather than assumed.
   *
   * Everything here is a fact the application went and got: how the request
   * ended, whether a credential was actually sent, who GitHub says that
   * credential is, and what the App installation covers. A stored token is
   * never taken as proof of access - that assumption is exactly what made a
   * private repository look like a missing one.
   */
  private async diagnose(
    ref: RepositoryRef,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<AccessDiagnosis> {
    const repository = `${ref.owner}/${ref.repo}`;
    const outcome = outcomeOf(error);
    const { state } = await this.github.credential();
    // With no usable credential the answer is already decided, and asking
    // GitHub who we are would be a request with nothing to send.
    if (state !== 'usable') {
      return diagnoseAccess({
        repository,
        owner: ref.owner,
        credential: state,
        identity: null,
        outcome,
        installations: null,
        repositoryInInstallation: null,
      });
    }
    const identity = await this.github.identity().catch(() => null);
    const installations = await this.github.installations().catch(() => null);
    let repositoryInInstallation: boolean | null = null;
    for (const installation of installations ?? []) {
      if ((installation.account ?? '').toLowerCase() !== ref.owner.toLowerCase()) continue;
      const covers = await this.github.installationCovers(installation.id, repository).catch(() => null);
      if (covers === true) {
        repositoryInInstallation = true;
        break;
      }
      if (covers === false) repositoryInInstallation = false;
    }
    void signal;
    return diagnoseAccess({
      repository,
      owner: ref.owner,
      credential: state,
      identity,
      outcome,
      installations,
      repositoryInInstallation,
    });
  }

  /**
   * Creates a repository through the connection the person already authorised.
   *
   * The point is to remove an errand, not to add a credential: this uses the
   * same login already connected in Contas e integrações, and asks for nothing
   * else. No token is ever requested, pasted or stored by this path.
   *
   * When the connection cannot do it, the refusal says which of the two
   * reasons it is and what the official fix is. A GitHub App genuinely cannot
   * create a repository in a personal account - that is a property of the app
   * kind, not a setting somebody forgot - and pretending otherwise would send
   * a person hunting through settings for a switch that does not exist.
   */
  async createRepository(
    input: { name: string; private?: boolean; description?: string },
    signal?: AbortSignal,
  ): Promise<{ fullName: string; defaultBranch: string | null; htmlUrl: string; isPrivate: boolean }> {
    const token = await this.writeToken();
    try {
      return await this.operations.createRepository(
        {
          name: input.name,
          private: input.private !== false,
          ...(input.description ? { description: input.description } : {}),
          // With a first commit, so the repository has a default branch and a
          // tree to cut a work branch from. Without one it would be created
          // and still unusable.
          autoInit: true,
        },
        token,
        signal,
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 403) {
        throw new GitHubWorkspaceError(
          'A conexão do GitHub que você autorizou não pode criar repositórios. Isso costuma ser o ' +
            'tipo da conexão, não uma configuração esquecida: um GitHub App não cria repositórios ' +
            'em uma conta pessoal, e um OAuth App só cria com o escopo "repo". ' +
            'Crie o repositório em github.com/new — privado, com README — e depois selecione-o aqui ' +
            'em Adicionar projeto → Repositório. Nenhum token precisa ser informado em lugar nenhum.',
          'NOT_CONNECTED',
        );
      }
      if (status === 422) {
        throw new GitHubWorkspaceError(
          `Já existe um repositório com o nome "${input.name}" nesta conta, ou o nome não é aceito ` +
            'pelo GitHub. Escolha outro nome.',
          'BAD_REPOSITORY',
        );
      }
      throw error;
    }
  }

  // -- Reading ---------------------------------------------------------------

  async tree(workspaceId: string, ref: string, signal?: AbortSignal): Promise<RepositoryTree> {
    const { ref: repository } = this.refFor(workspaceId);
    return this.operations.tree(repository, ref, await this.readToken(), signal);
  }

  async readFile(
    workspaceId: string,
    path: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<FileContent> {
    const { ref: repository } = this.refFor(workspaceId);
    return this.operations.readFile(repository, path, ref, await this.readToken(), signal);
  }

  async commits(
    workspaceId: string,
    ref: string,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<CommitSummary[]> {
    const { ref: repository } = this.refFor(workspaceId);
    return this.operations.commits(repository, ref, await this.readToken(), limit, signal);
  }

  async diff(
    workspaceId: string,
    base: string,
    head: string,
    signal?: AbortSignal,
  ): Promise<RepositoryDiff> {
    const { ref: repository } = this.refFor(workspaceId);
    return this.operations.compare(repository, base, head, await this.readToken(), signal);
  }

  // -- Writing ---------------------------------------------------------------

  /**
   * Cuts a work branch from the branch the person chose.
   *
   * The base commit is resolved *first* and carried forward: every later
   * operation compares against it, so a push that lands on the base branch
   * mid-run is noticed rather than silently absorbed.
   *
   * The name is derived from the run, so two runs never share a branch, and a
   * name already taken is a refusal rather than a takeover.
   */
  async startWork(
    input: { workspaceId: string; baseBranch?: string | null; runId: string },
    signal?: AbortSignal,
  ): Promise<WorkSession> {
    const { ref, workspace } = this.refFor(input.workspaceId);
    const token = await this.writeToken();
    const meta = await this.operations.repository(ref, token, signal);
    const baseBranch =
      input.baseBranch?.trim() ||
      workspace.branch?.trim() ||
      workspace.default_branch?.trim() ||
      meta.defaultBranch;
    if (!baseBranch) {
      throw new GitHubWorkspaceError(
        'O GitHub não informou a branch padrão deste repositório, e nenhuma foi escolhida. ' +
          'Escolha a branch de origem antes de alterar o código.',
        'BAD_REPOSITORY',
      );
    }
    const base = await this.operations.resolveRef(ref, baseBranch, token, signal);
    const workBranch = workBranchName(input.runId);
    await this.operations.createBranch(ref, workBranch, base.commitSha, token, signal);
    return {
      fullName: meta.fullName,
      baseBranch,
      baseCommit: base.commitSha,
      workBranch,
    };
  }

  /** Applies a validated change set as one commit on the work branch. */
  async apply(
    input: {
      workspaceId: string;
      branch: string;
      expectedHeadSha: string;
      message: string;
      changes: readonly RepositoryChange[];
    },
    signal?: AbortSignal,
  ): Promise<CommitResult> {
    const { ref } = this.refFor(input.workspaceId);
    return this.operations.commit(
      ref,
      {
        branch: input.branch,
        expectedHeadSha: input.expectedHeadSha,
        message: input.message,
        changes: input.changes,
      },
      await this.writeToken(),
      signal,
    );
  }

  async openPullRequest(
    input: { workspaceId: string; head: string; base: string; title: string; body?: string },
    signal?: AbortSignal,
  ): Promise<PullRequestSummary> {
    const { ref } = this.refFor(input.workspaceId);
    return this.operations.openPullRequest(
      ref,
      {
        head: input.head,
        base: input.base,
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
      },
      await this.writeToken(),
      signal,
    );
  }

  /** The operations object, for the loop's own evidence collection. */
  get api(): RepositoryOperations {
    return this.operations;
  }

  /** A token for reading. Null is fine: a public repository needs none. */
  async readToken(): Promise<string | null> {
    return this.github.accessTokenIfConnected();
  }

  /**
   * A token for writing, or a refusal that says which of the four things is
   * missing.
   *
   * Authentication, repository access, write permission and a branch conflict
   * are four different problems with four different fixes, and collapsing them
   * into "erro do GitHub" is what sends a person to the wrong setting.
   */
  async writeToken(): Promise<string> {
    const token = await this.github.accessTokenIfConnected();
    if (!token) {
      throw new GitHubWorkspaceError(
        'Alterar o repositório precisa da conta do GitHub conectada. Conecte em Contas e integrações.',
        'NOT_CONNECTED',
      );
    }
    return token;
  }
}

/**
 * The branch a run publishes to.
 *
 * Prefixed and derived from the run id, so it is obvious where it came from,
 * two runs never collide, and nothing this application creates can be mistaken
 * for a branch a person made.
 */
export function workBranchName(runId: string): string {
  const suffix = runId.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `orquestrador/${suffix || 'run'}`;
}

/** How the repository request ended, in the diagnosis's vocabulary. */
function outcomeOf(error: unknown): RequestOutcome {
  if (!(error instanceof GitHubError)) return 'network';
  switch (error.kind) {
    case 'auth':
    case 'expired':
      return 'auth';
    case 'forbidden':
    case 'denied':
      return 'forbidden';
    case 'not-found':
      return 'not-found';
    case 'rate-limit':
      return 'rate-limit';
    case 'network':
      return 'network';
    default:
      return 'api';
  }
}
