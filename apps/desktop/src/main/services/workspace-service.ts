/**
 * Workspaces: the projects the orchestrator is allowed to work in.
 *
 * Two ways in — point at a folder, or clone a repository — and both end at the
 * same place: a row with an absolute local path. Cloning goes through the
 * managed Git runtime, so a machine with no git on PATH still works.
 */

import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Database, ProcessManager, WorkspaceWithAgents } from '../core.js';
import { isWorkerSelection } from '../core.js';
import { GitEvidenceCollector, newId, parseStatusShort } from '../core.js';
import {
  REASONING_LEVELS,
  type WorkerSelection,
  type ProviderName,
  type ReasoningLevel,
  type TeamMemberInput,
  type TeamMemberView,
  type TeamRole,
  type CheckoutResult,
  type GitOperationResult,
  type PullRequestStatusView,
  type PullRequestView,
  type WorkspaceBranchesView,
  type WorkspaceChangesView,
  type WorkspaceView,
  type ProjectView,
} from '../../shared/ipc-contract.js';
import type { RuntimeService } from './runtime-service.js';
import { AgentService, orchestratorAgentIdFor, workerAgentIdFor } from './agent-service.js';
import type { GitHubService } from './github-service.js';
import { parseGitHubRemote, redact } from '../core.js';
import { folderKey, suggestedProjectName } from '../../../../../src/workspace/folder-identity.js';
import {
  assessPreflight,
  type PreflightResult,
} from '../../../../../src/workspace/preflight.js';
import { displayFullName, repositoryKey } from '../../../../../src/github/repository-identity.js';
import type { ProjectService } from './project-service.js';
import { roleDefinition } from '../../shared/agent-policy.js';


export class WorkspaceError extends Error {
  readonly code = 'WORKSPACE_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export class WorkspaceService {
  constructor(
    private readonly database: Database,
    private readonly runtimes: RuntimeService,
    private readonly processManager: ProcessManager,
    private readonly agents: AgentService = new AgentService(database),
  ) {}

  /** Whether a run is going in a workspace; set by the container once the loop exists. */
  private isBusy: (workspaceId: string) => boolean = () => false;
  /** The GitHub login, for remotes on github.com. Absent in tests that do not need it. */
  private github: GitHubService | null = null;

  bindActivity(isBusy: (workspaceId: string) => boolean): void {
    this.isBusy = isBusy;
  }

  bindGitHub(github: GitHubService): void {
    this.github = github;
  }

  list(): WorkspaceView[] {
    return this.database.workspaces.list().map((record) => this.toView(record));
  }

  require(workspaceId: string): WorkspaceView {
    return this.toView(this.database.workspaces.require(workspaceId));
  }

  rename(workspaceId: string, name: string): WorkspaceView {
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new WorkspaceError('Escolha um nome para o projeto.');
    this.database.workspaces.require(workspaceId);
    return this.toView(this.database.workspaces.rename(workspaceId, trimmed));
  }

  /**
   * Removes the project from the list - and only from the list. Its records
   * (conversations, runs, verifications, team) go with it; the folder and
   * everything in it stay exactly as they are.
   */
  remove(workspaceId: string): boolean {
    this.database.workspaces.require(workspaceId);
    if (this.isBusy(workspaceId)) {
      throw new WorkspaceError('Cancele a execução em andamento antes de remover o projeto.');
    }
    return this.database.workspaces.remove(workspaceId);
  }

  /** The branches of the working copy, read with git. */
  async branches(workspaceId: string): Promise<WorkspaceBranchesView> {
    const workspace = this.database.workspaces.require(workspaceId);
    const none: WorkspaceBranchesView = {
      isRepository: false,
      current: null,
      local: [],
      remote: [],
      dirtyFiles: 0,
    };
    let git: string;
    try {
      git = await this.runtimes.executablePath('git');
    } catch {
      return none;
    }
    const collector = new GitEvidenceCollector(workspace.local_path, this.processManager, git);
    if (!(await collector.isGitRepository())) return none;
    const [current, local, remote, status] = await Promise.all([
      collector.git(['branch', '--show-current']),
      collector.git(['branch', '--format=%(refname:short)']),
      collector.git(['branch', '-r', '--format=%(refname:short)']),
      collector.git(['status', '--porcelain']),
    ]);
    const names = (out: string): string[] =>
      out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.endsWith('/HEAD'));
    return {
      isRepository: true,
      current: current.ok ? current.stdout.trim() || null : null,
      local: local.ok ? names(local.stdout) : [],
      remote: remote.ok ? names(remote.stdout) : [],
      dirtyFiles: parseStatusShort(status.stdout).length,
    };
  }

  /**
   * `git switch <branch>`, with two locks: a dirty tree is refused unless the
   * person said to go ahead (and git itself still refuses a switch that would
   * lose a change), and nothing is switched under a running loop.
   */
  async checkout(workspaceId: string, branch: string, allowDirty: boolean): Promise<CheckoutResult> {
    const workspace = this.database.workspaces.require(workspaceId);
    if (this.isBusy(workspaceId)) {
      throw new WorkspaceError('Cancele a execução em andamento antes de trocar de branch.');
    }
    const known = await this.branches(workspaceId);
    if (!known.isRepository) throw new WorkspaceError('Esta pasta não é um repositório git.');
    // A remote-tracking name becomes its local branch: `git switch feature`
    // creates `feature` tracking `origin/feature` when that is unambiguous.
    const target = known.local.includes(branch)
      ? branch
      : (known.remote.find((r) => r === branch) ?? branch).replace(/^[^/]+\//, '');
    if (!known.local.includes(target) && !known.remote.some((r) => r.endsWith(`/${target}`))) {
      throw new WorkspaceError(`A branch "${branch}" não existe neste repositório.`);
    }
    if (known.dirtyFiles > 0 && !allowDirty) {
      return {
        switched: false,
        dirtyFiles: known.dirtyFiles,
        message: `Há ${known.dirtyFiles} alteração(ões) não commitada(s) no projeto.`,
      };
    }
    const git = await this.runtimes.executablePath('git');
    const result = await this.processManager.run({
      command: git,
      // `switch` takes a branch, never a path, which is what makes it the
      // safe spelling here; the validator already refused a leading dash.
      args: ['switch', target],
      cwd: workspace.local_path,
      timeoutMs: 60_000,
    });
    if (result.outcome !== 'completed' || result.exitCode !== 0) {
      throw new WorkspaceError(`O git recusou a troca de branch.${firstLine(result.stderr)}`);
    }
    this.database.workspaces.touch(workspaceId);
    return {
      switched: true,
      workspace: {
        ...this.toView(this.database.workspaces.require(workspaceId)),
        branch: await this.currentBranch(workspace.local_path),
      },
    };
  }

  /**
   * The same list, with each working copy's current branch.
   *
   * Read from disk rather than remembered, because the user can switch branches
   * outside the application and a stale answer would be worse than none. A
   * folder that is not a repository, or a git that cannot answer, gives null.
   */
  async listWithBranches(): Promise<WorkspaceView[]> {
    const records = this.database.workspaces.list();
    return Promise.all(
      records.map(async (record) => ({
        ...this.toView(record),
        // A cloud or GitHub project's branch is the one it was created for:
        // there is no working copy on this computer to read it from, and
        // running `git` in a folder that does not exist would answer about
        // nothing.
        branch:
          record.environment === 'cloud' || record.environment === 'github'
            ? record.branch
            : record.environment === 'conversation'
              ? null
              : await this.currentBranch(record.local_path),
      })),
    );
  }

  private async currentBranch(localPath: string): Promise<string | null> {
    let git: string;
    try {
      git = await this.runtimes.executablePath('git');
    } catch {
      return null;
    }
    try {
      const result = await this.processManager.run({
        command: git,
        args: ['branch', '--show-current'],
        cwd: localPath,
        timeoutMs: 15_000,
      });
      if (result.outcome !== 'completed' || result.exitCode !== 0) return null;
      const branch = result.stdout.trim();
      return branch.length > 0 ? branch : null;
    } catch {
      return null;
    }
  }

  create(input: {
    name: string;
    localPath: string;
    repositoryUrl?: string;
    defaultBranch?: string;
  }): WorkspaceView {
    const localPath = resolve(input.localPath);
    assertUsableDirectory(localPath);

    // Matched by folder identity, not by the spelling of the path. Two
    // spellings of one folder are one project; that is the whole point of
    // `folderKey`.
    const key = folderKey(localPath);
    const existing = this.database.workspaces.findByPathKey(key);
    if (existing) throw new WorkspaceError('Esta pasta já está adicionada como projeto.');

    const record = this.database.workspaces.create({
      id: newId('ws'),
      name: input.name,
      localPath,
      pathKey: key,
      repositoryUrl: input.repositoryUrl ?? null,
      defaultBranch: input.defaultBranch ?? null,
    });
    return this.toView(record);
  }

  /**
   * Opens the project for a folder, creating it only if there is none.
   *
   * The operation the interface was missing. Before this, selecting a folder
   * called `create`, which *refused* when the folder was already known - so
   * the answer to "open my project again" was an error message. And because
   * the match was on the spelling of the path, the same folder spelled another
   * way was not "already known" at all, and a second project appeared.
   *
   * Now: one folder, one workspace, one project, whichever way the path is
   * spelled and however many times it is selected. The project is created
   * alongside the workspace in the same transaction, because a folder with a
   * workspace and no project is exactly the split the person described - a
   * folder in one list and a project in another, with nothing joining them.
   *
   * Never destructive: an existing project is returned as it is, with its
   * name, its conversations and its team untouched.
   */
  openFolder(
    localPath: string,
    projects: ProjectService,
  ): { workspace: WorkspaceView; projectId: string; created: boolean } {
    const resolved = resolve(localPath);
    assertUsableDirectory(resolved);
    const key = folderKey(resolved);

    const existing = this.database.workspaces.findByPathKey(key);
    if (existing) {
      // The folder is known. Make sure it has a project - an installation
      // from before this existed has workspaces with none - and open it.
      const project = this.projectForWorkspace(existing.id, existing.display_name, projects);
      this.database.workspaces.touch(existing.id);
      return { workspace: this.toView(existing), projectId: project, created: false };
    }

    const record = this.database.workspaces.create({
      id: newId('ws'),
      name: suggestedProjectName(resolved),
      localPath: resolved,
      pathKey: key,
    });
    const project = projects.create({
      name: clampName(record.display_name),
      workspaceId: record.id,
    });
    return { workspace: this.toView(record), projectId: project.id, created: true };
  }

  /**
   * Brings an existing installation up to the folder-identity model.
   *
   * Runs once per start, and is additive in the strictest sense: it writes a
   * `path_key` where there was none, and creates a project for a local folder
   * that has none. It **never** deletes, merges, renames or moves anything.
   *
   * The reconciliation the person asked for stops exactly there. Where two
   * workspaces turn out to name the same folder, both are kept and both are
   * reported: each carries its own conversations, runs and evidence, and
   * deciding which history survives is not a decision a migration gets to
   * make silently. The interface shows them so a person can choose.
   *
   * Returns what it did, so the result can be said out loud rather than
   * happening invisibly at start-up.
   */
  reconcileFolders(projects: ProjectService): {
    keysBackfilled: number;
    projectsCreated: number;
    repositoriesLinked: number;
    duplicateFolders: Array<{ pathKey: string; workspaceIds: string[] }>;
  } {
    let keysBackfilled = 0;
    let projectsCreated = 0;
    let repositoriesLinked = 0;

    for (const workspace of this.database.workspaces.list()) {
      // Only a folder on this computer has a folder identity. A conversation
      // project owns none and a cloud project's path exists somewhere else;
      // giving either a key would let them be matched against a real folder.
      const isLocalFolder =
        (workspace.environment ?? 'local') === 'local' && workspace.local_path.trim().length > 0;

      if (isLocalFolder) {
        const key = folderKey(workspace.local_path);
        if (key.length > 0 && workspace.path_key !== key) {
          this.database.workspaces.setPathKey(workspace.id, key);
          keysBackfilled += 1;
        }
      }

      const outcome = this.ensureProjectFor(workspace.id, projects);
      if (outcome.projectCreated) projectsCreated += 1;
      if (outcome.repositoryLinked) repositoriesLinked += 1;
    }

    return {
      keysBackfilled,
      projectsCreated,
      repositoriesLinked,
      duplicateFolders: this.database.workspaces.duplicateFolders(),
    };
  }

  /**
   * Makes sure this workspace is reachable from the sidebar, and only that.
   *
   * **Every** workspace gets a project, not only a local folder. This changed
   * when "Pastas" left the sidebar: while that section existed, a cloud or
   * conversation workspace with no project was merely filed oddly - it still
   * appeared, under Pastas. With one tree there is nowhere else to appear, so
   * a workspace without a project would simply vanish from the interface,
   * taking its conversations with it. Nothing is deleted by that, but a person
   * cannot see the difference between "hidden" and "gone", and they should
   * never have to.
   *
   * Called from two places, and it must be both: at start-up for everything
   * that already exists, and the moment a workspace is created, because a
   * folder cloned at eleven o'clock must not be invisible until the next
   * restart.
   *
   * Idempotent. A workspace that already has a project keeps it, whatever it
   * is named.
   */
  ensureProjectFor(
    workspaceId: string,
    projects: ProjectService,
  ): { projectId: string; projectCreated: boolean; repositoryLinked: boolean } {
    const workspace = this.database.workspaces.require(workspaceId);
    let project = this.database.projects.findByWorkspace(workspace.id);
    let projectCreated = false;
    if (!project) {
      const created = projects.create({
        // Clamped, not passed through. A workspace row can hold a name longer
        // than a project accepts - one written by an older version, or a
        // folder with a very long leaf - and letting `create` refuse it would
        // leave a workspace with no project, which since "Pastas" left the
        // sidebar means a workspace nobody can see.
        name: clampName(workspace.display_name),
        workspaceId: workspace.id,
      });
      project = this.database.projects.require(created.id);
      projectCreated = true;
    }

    // A cloud or cloned workspace already knows its repository. Copying that
    // identity onto the project is what stops the same repository from
    // becoming a second project the first time it is connected from the
    // dialog.
    let repositoryLinked = false;
    const repositoryUrl =
      workspace.repository_url ?? repositoryUrlOfFullName(workspace.repository_full_name);
    const key = repositoryKey(repositoryUrl);
    if (key.length > 0 && project.repository_key.length === 0) {
      // Where two projects would claim one repository, neither is changed and
      // both are kept: choosing between them is not a decision this gets to
      // make quietly. `duplicateRepositories()` reports them instead.
      if (!this.database.projects.findByRepositoryKey(key)) {
        this.database.projects.setRepository(project.id, {
          key,
          url: repositoryUrl,
          fullName: workspace.repository_full_name ?? displayFullName(repositoryUrl),
          isPrivate:
            workspace.repository_private === null ? null : workspace.repository_private === 1,
          // `default_branch` only, never `branch`.
          //
          // They are different facts and conflating them is exactly the guess
          // this project forbids: `branch` is the branch a cloud run was told
          // to start from - a person picked it from a list - while
          // `default_branch` is what the repository's default actually is.
          // Copying the first into the second made a project whose default
          // branch read `main` because somebody chose to work on main, and a
          // test caught it saying so. Where there is no recorded default, it
          // stays unknown until GitHub is asked.
          defaultBranch: workspace.default_branch ?? null,
        });
        repositoryLinked = true;
      }
    }

    return { projectId: project.id, projectCreated, repositoryLinked };
  }

  /**
   * The project bound to this workspace, creating one if it has none.
   *
   * Reuses an existing binding rather than adding a second: a workspace that
   * already appears under a project keeps that project, whatever it is named.
   */
  private projectForWorkspace(
    workspaceId: string,
    fallbackName: string,
    projects: ProjectService,
  ): string {
    const bound = this.database.projects.findByWorkspace(workspaceId);
    if (bound) return bound.id;
    return projects.create({ name: clampName(fallbackName), workspaceId }).id;
  }

  /**
   * The workspace a project's runs execute in, creating one if it has none.
   *
   * A project connected from a repository has no folder on this computer, and
   * a project created empty has nothing at all. Both still need somewhere for
   * a run to happen, and the honest answer for a project with no working copy
   * is a `conversation` workspace: its runs analyse, plan and review, and
   * touch no file anywhere. That is a real mode this application already has,
   * not a placeholder.
   *
   * What it deliberately does **not** do is clone. Turning "open my project"
   * into a silent `git clone` would write to somebody's disk because they
   * clicked a name in a sidebar. Associating a folder is a separate, explicit
   * act, and until it happens the project says what it can and cannot do.
   */
  ensureWorkspaceForProject(
    projectId: string,
    projects: ProjectService,
  ): { workspace: WorkspaceView; created: boolean } {
    const project = projects.require(projectId);
    if (project.workspace_id) {
      const existing = this.database.workspaces.find(project.workspace_id);
      if (existing) {
        this.database.workspaces.touch(existing.id);
        return { workspace: this.toView(existing), created: false };
      }
      // The workspace was removed but the project still points at it. Falling
      // through creates a new one rather than failing to open the project.
    }

    const record = this.database.workspaces.create({
      id: newId('ws'),
      name: project.name,
      // No folder, and never resolved: this project does not have one yet.
      localPath: '',
      environment: 'conversation',
      ...(project.repository_url ? { repositoryUrl: project.repository_url } : {}),
      // Only what GitHub actually reported. Null stays null.
      ...(project.default_branch ? { defaultBranch: project.default_branch } : {}),
    });
    projects.setWorkspace(projectId, record.id);
    return { workspace: this.toView(record), created: true };
  }

  /**
   * What the application can say about a project's folder, measured now.
   *
   * The interface asks this before offering "codar": a project connected from
   * a repository has an identity long before it has a checkout, and the
   * difference between "ready" and "there is no folder yet" is the difference
   * between starting work and starting it in the wrong place.
   */
  async preflight(projectId: string, projects: ProjectService): Promise<PreflightResult> {
    const project = projects.require(projectId);
    const workspace = project.workspace_id
      ? this.database.workspaces.find(project.workspace_id)
      : null;
    const path = workspace?.local_path?.trim() ?? '';
    const declaredRepositoryUrl = project.repository_url ?? workspace?.repository_url ?? null;
    const declaredDefaultBranch = project.default_branch ?? workspace?.default_branch ?? null;
    if (path.length === 0) {
      return assessPreflight({
        workspacePath: '',
        folderExists: false,
        isGitRepository: false,
        gitProblem: null,
        remoteUrl: null,
        branch: null,
        dirty: false,
        declaredRepositoryUrl,
        declaredDefaultBranch,
      });
    }
    if (!exists(path)) {
      return assessPreflight({
        workspacePath: path,
        folderExists: false,
        isGitRepository: false,
        gitProblem: null,
        remoteUrl: null,
        branch: null,
        dirty: false,
        declaredRepositoryUrl,
        declaredDefaultBranch,
      });
    }
    const facts = await this.gitFacts(path);
    return assessPreflight({
      workspacePath: path,
      folderExists: true,
      ...facts,
      declaredRepositoryUrl,
      declaredDefaultBranch,
    });
  }

  /**
   * Gives a project a folder to work in: one it already has, or a fresh clone.
   *
   * Both paths keep the project. `projectId` never changes, its conversations
   * and history stay attached to it, and no second project appears - which is
   * what "o projeto GitHub e seu checkout local devem continuar sendo o MESMO
   * projeto" means in code.
   *
   * Nothing here is destructive. Associating reads the folder and never
   * writes to it; cloning refuses a destination that already exists rather
   * than merging into or clearing it. Neither ever checks out, pulls or
   * resets, so local changes cannot be lost.
   */
  async prepare(
    input:
      | { projectId: string; mode: 'associate'; localPath: string }
      | { projectId: string; mode: 'clone'; parentPath: string; folderName?: string },
    projects: ProjectService,
  ): Promise<{ workspace: WorkspaceView; project: ProjectView; reusedWorkspace: boolean }> {
    const project = projects.require(input.projectId);

    if (input.mode === 'clone') {
      const url = project.repository_url;
      if (!url) {
        throw new WorkspaceError(
          'Este projeto não está ligado a um repositório, então não há o que clonar. ' +
            'Associe uma pasta existente.',
        );
      }
      const workspace = await this.clone({
        repositoryUrl: url,
        parentPath: input.parentPath,
        name: input.folderName?.trim() || project.name,
      });
      // The clone already recorded the repository on the workspace. The
      // default branch stays whatever GitHub reported for the project: it is
      // never filled in with `main` on a guess.
      return {
        workspace,
        project: projects.setWorkspace(project.id, workspace.id),
        reusedWorkspace: false,
      };
    }

    const resolved = resolve(input.localPath);
    assertUsableDirectory(resolved);

    // The identity check, and the reason this is not just `setWorkspace`. A
    // project that declares a repository must not be pointed at a folder that
    // is something else - which is precisely how a task for one repository
    // came to run in a Desktop folder that only shared part of its name.
    if (project.repository_url) {
      const facts = await this.gitFacts(resolved);
      const verdict = assessPreflight({
        workspacePath: resolved,
        folderExists: true,
        ...facts,
        declaredRepositoryUrl: project.repository_url,
        declaredDefaultBranch: project.default_branch,
      });
      if (verdict.blocksCodeWork) {
        throw new WorkspaceError(`${verdict.title} ${verdict.detail}`);
      }
    }

    const key = folderKey(resolved);
    const existing = this.database.workspaces.findByPathKey(key);
    if (existing) {
      // The folder is already known. Reuse it rather than making a second
      // workspace for the same directory - unless another project owns it,
      // in which case taking it would silently move somebody's work.
      const owner = this.database.projects
        .list()
        .find((p) => p.workspace_id === existing.id && p.id !== project.id);
      if (owner) {
        throw new WorkspaceError(
          `Esta pasta já pertence ao projeto "${owner.name}". Um projeto por pasta: ` +
            'abra aquele projeto, ou escolha outra pasta.',
        );
      }
      this.database.workspaces.touch(existing.id);
      return {
        workspace: this.toView(existing),
        project: projects.setWorkspace(project.id, existing.id),
        reusedWorkspace: true,
      };
    }

    const record = this.database.workspaces.create({
      id: newId('ws'),
      name: project.name,
      localPath: resolved,
      pathKey: key,
      repositoryUrl: project.repository_url,
      defaultBranch: project.default_branch,
    });
    return {
      workspace: this.toView(record),
      project: projects.setWorkspace(project.id, record.id),
      reusedWorkspace: false,
    };
  }

  /** Git's own answers about a folder: is it a checkout, of what, on which branch. */
  private async gitFacts(path: string): Promise<{
    isGitRepository: boolean;
    gitProblem: string | null;
    remoteUrl: string | null;
    branch: string | null;
    dirty: boolean;
  }> {
    let git: string;
    try {
      git = await this.runtimes.executablePath('git');
    } catch (error) {
      return {
        isGitRepository: false,
        gitProblem: error instanceof Error ? error.message : String(error),
        remoteUrl: null,
        branch: null,
        dirty: false,
      };
    }
    const collector = new GitEvidenceCollector(path, this.processManager, git);
    const probe = await collector.probeRepository();
    if (!probe.isRepository) {
      return {
        isGitRepository: false,
        gitProblem: probe.problem,
        remoteUrl: null,
        branch: null,
        dirty: false,
      };
    }
    const [remoteUrl, branch, status] = await Promise.all([
      collector.originUrl(),
      collector.git(['branch', '--show-current']),
      collector.git(['status', '--porcelain']),
    ]);
    return {
      isGitRepository: true,
      gitProblem: null,
      remoteUrl,
      branch: branch.ok ? branch.stdout.trim() || null : null,
      dirty: status.ok && status.stdout.trim().length > 0,
    };
  }

  /**
   * A project that is only a conversation.
   *
   * No folder, no repository, no server. This is the shape the main experience
   * starts in: a person opens the application, names a team, writes an
   * objective and sends it. Asking them to choose a folder or clone a
   * repository first, for a run that will read no file and write none, is the
   * obstacle this project kind exists to remove.
   *
   * It is a real project like any other: it has a team, conversations, run
   * history and a budget. What it does not have is a working copy, which is
   * why nothing here resolves or checks a path.
   */
  createConversation(input: { name: string }): WorkspaceView {
    const name = input.name.trim();
    if (!name) throw new WorkspaceError('Escolha um nome para o projeto.');
    const record = this.database.workspaces.create({
      id: newId('ws'),
      name,
      // Deliberately empty, and never resolved: there is no folder.
      localPath: '',
      environment: 'conversation',
    });
    return this.toView(record);
  }

  /**
   * A project whose runs execute in the cloud.
   *
   * No folder is asked for and none is checked, because there is none: the
   * repository is cloned inside the remote workspace when a run starts. That
   * is the whole promise of cloud mode, and a hidden `resolve(localPath)`
   * here would quietly break it - which is exactly what the first version of
   * this did.
   */
  /**
   * A project whose code lives on GitHub and nowhere on this computer.
   *
   * One project per repository, deliberately - not one per branch. A branch is
   * where a piece of work starts, and the person changes it; the repository is
   * what the project *is*. Three entries in the sidebar for one repository is
   * exactly what the request said not to build.
   *
   * `default_branch` stays unset here. It is a fact about the repository that
   * only GitHub can state, and writing the chosen branch into it would make a
   * pull request open against the branch it came from.
   */
  createGitHub(input: {
    name?: string;
    /** `owner/name`, as GitHub names it. */
    repository: string;
    /** Where work starts. Null means the repository's real default branch. */
    branch?: string | null;
    repositoryPrivate?: boolean;
  }): WorkspaceView {
    const repository = input.repository.trim();
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
      throw new WorkspaceError('Escolha um repositório no formato dono/nome.');
    }
    const existing = this.database.workspaces
      .list()
      .find(
        (w) =>
          w.environment === 'github' &&
          (w.repository_full_name ?? '').toLowerCase() === repository.toLowerCase(),
      );
    if (existing) {
      // The same repository is the same project. Opening it again opens the
      // one that is already there, with its conversations and its history.
      return this.toView(existing);
    }
    const record = this.database.workspaces.create({
      id: newId('ws'),
      name: input.name?.trim() || repository,
      // Deliberately empty. Nothing on this computer belongs to this project,
      // which is the whole point: no clone, no folder to choose, no PATH.
      localPath: '',
      environment: 'github',
      repositoryFullName: repository,
      repositoryPrivate: input.repositoryPrivate ?? null,
      branch: input.branch?.trim() || null,
      repositoryUrl: `https://github.com/${repository}`,
    });
    return this.toView(record);
  }

  createCloud(input: {
    name?: string;
    /** `owner/name`, as GitHub names it. */
    repository: string;
    branch: string;
    repositoryPrivate?: boolean;
    /** The coordinator to send runs to. Null uses the configured default. */
    endpoint?: string | null;
  }): WorkspaceView {
    const repository = input.repository.trim();
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
      throw new WorkspaceError('Escolha um repositório no formato dono/nome.');
    }
    const branch = input.branch.trim();
    if (!branch) throw new WorkspaceError('Escolha a branch em que o trabalho começa.');

    // One project per repository *and* branch: two branches of the same
    // repository are two lines of work, and merging them into one project
    // would mix their conversations and their history.
    const existing = this.database.workspaces
      .list()
      .find((w) => w.environment === 'cloud' && w.repository_full_name === repository && w.branch === branch);
    if (existing) {
      throw new WorkspaceError(`${repository} (${branch}) já está adicionado como projeto de nuvem.`);
    }

    const record = this.database.workspaces.create({
      id: newId('ws'),
      name: input.name?.trim() || repository,
      // Deliberately empty. Nothing on this computer belongs to this project.
      localPath: '',
      environment: 'cloud',
      repositoryFullName: repository,
      repositoryPrivate: input.repositoryPrivate ?? null,
      branch,
      repositoryUrl: `https://github.com/${repository}`,
      // `default_branch` is deliberately not set from `branch`. They are two
      // different facts: `branch` is where this cloud project's work starts,
      // chosen by a person from a list, and `default_branch` is what the
      // repository's default actually is. Writing the first into the second
      // made a project whose "default branch" was whatever branch somebody
      // picked - and prefilled a pull request's base with the branch it was
      // opened *from*. It stays unknown until GitHub is asked.
      cloudEndpoint: input.endpoint ?? null,
    });
    return this.toView(record);
  }

  /**
   * What happens to a cloud project's work when a run ends.
   *
   * Only meaningful for a cloud project: a local one has a working copy the
   * person commits and pushes themselves, and nothing here would apply.
   */
  setPublish(workspaceId: string, input: { enabled: boolean; pullRequest: boolean }): WorkspaceView {
    const workspace = this.database.workspaces.require(workspaceId);
    if (workspace.environment !== 'cloud') {
      throw new WorkspaceError('Só um projeto de nuvem publica o resultado automaticamente.');
    }
    this.database.workspaces.setPublish(workspaceId, input);
    return this.toView(this.database.workspaces.require(workspaceId));
  }

  /**
   * Clones into `parentPath/name` using the managed git.
   *
   * The destination must not exist yet: refusing is safer than merging into
   * whatever happens to be there, and far safer than clearing it.
   */
  async clone(input: {
    repositoryUrl: string;
    parentPath: string;
    name: string;
  }): Promise<WorkspaceView> {
    const parent = resolve(input.parentPath);
    assertUsableDirectory(parent);

    const folder = safeFolderName(input.name);
    const destination = join(parent, folder);
    if (exists(destination)) {
      throw new WorkspaceError(`Já existe uma pasta chamada "${folder}" nesse local.`);
    }

    const git = await this.runtimes.executablePath('git');
    const result = await this.processManager.run({
      command: git,
      // `--` keeps a repository URL that starts with a dash from being read as
      // an option; the validator already refuses those, this is the second lock.
      args: ['clone', '--', input.repositoryUrl, destination],
      cwd: parent,
      timeoutMs: 30 * 60_000,
      // The GitHub login rides in the environment as a per-process header:
      // never in the URL, so `.git/config` holds the plain remote.
      env: this.gitEnvironmentFor(input.repositoryUrl),
    });

    if (result.outcome !== 'completed' || result.exitCode !== 0) {
      throw new WorkspaceError(
        `Não foi possível clonar o repositório.${firstLine(result.stderr)}`,
      );
    }

    return this.create({
      name: input.name,
      localPath: destination,
      repositoryUrl: input.repositoryUrl,
    });
  }

  setAgents(workspaceId: string, orchestratorAgentId: string, workerAgentId: string): WorkspaceView {
    const orchestrator = this.database.agents.require(orchestratorAgentId);
    const worker = this.database.agents.require(workerAgentId);
    if (orchestrator.enabled!==1 || worker.enabled!==1) throw new WorkspaceError('Escolha agentes ativos.');
    if (orchestrator.role !== 'ORCHESTRATOR') {
      throw new WorkspaceError('O agente escolhido para supervisionar não é um orquestrador.');
    }
    if (roleDefinition(worker.role)?.lane !== 'delegate') {
      throw new WorkspaceError('O agente escolhido para executar não é um agente de execução.');
    }
    return this.toView(
      this.database.workspaces.setAgents(workspaceId, orchestratorAgentId, workerAgentId),
    );
  }

  /** Resolve a chosen agent, or the legacy default, without conflating identity and account. */
  private memberAgent(role: TeamRole, accountId: string, agentId?: string): string {
    const id = agentId ?? (role==='ORCHESTRATOR' ? orchestratorAgentIdFor(accountId) : workerAgentIdFor(accountId));
    const row = this.database.agents.find(id);
    if(!row) throw new WorkspaceError('A conta "'+this.database.accounts.find(accountId)?.display_name+'" não possui agente para esta função. Crie um agente em Agentes e modelos e selecione-o explicitamente.');
    if (row.enabled!==1 || row.account_id!==accountId || roleDefinition(row.role)?.lane!==(role==='ORCHESTRATOR'?'supervisor':'delegate')) throw new WorkspaceError('Escolha um agente ativo ligado à conta e ao papel corretos.');
    return id;
  }

  setTeam(
    workspaceId: string,
    orchestrator: TeamMemberInput,
    /**
     * The workers, in order. A single member keeps the shape every existing
     * caller uses; several are stored in slots, and slot 0 stays the project's
     * `worker`, so nothing that reads one worker has to change.
     */
    workers: TeamMemberInput | readonly TeamMemberInput[],
  ): WorkspaceView {
    this.database.workspaces.require(workspaceId);
    const list = Array.isArray(workers) ? workers : [workers as TeamMemberInput];
    if (list.length === 0) {
      throw new WorkspaceError('Escolha pelo menos um worker para este projeto.');
    }
    const seen = new Set<string>();
    for (const member of list) {
      const identity = member.agentId ?? workerAgentIdFor(member.accountId);
      if (seen.has(identity)) throw new WorkspaceError('Dois workers usam o mesmo agente na mesma conexão. Escolha agentes diferentes.');
      seen.add(identity);
    }
    const orchestratorAccount = this.accountForRole('ORCHESTRATOR', orchestrator.accountId);
    const workerAccounts = list.map((member) => this.accountForRole('CODING_WORKER', member.accountId));
    // Makes sure the per-account agents exist before they are bound.
    this.agents.sync();
    // The orchestrator is either the CLI's default or a pinned choice; the
    // worker's strategies do not apply to it.
    const orchestratorSelection = orchestrator.selection === 'manual' ? 'manual' : 'auto';
    if (orchestrator.selection && !['auto', 'manual'].includes(orchestrator.selection)) {
      throw new WorkspaceError('O orquestrador aceita apenas "Padrão do CLI" ou "Manual".');
    }
    const record = this.database.workspaces.setTeam(
      workspaceId,
      {
        agentId: this.memberAgent('ORCHESTRATOR',orchestratorAccount.id,orchestrator.agentId),
        model: orchestratorSelection === 'manual' ? (orchestrator.model ?? null) : null,
        reasoning: orchestratorSelection === 'manual' ? reasoningOrNull(orchestrator.reasoning) : null,
        selection: orchestratorSelection,
      },
      list.map((member, index) => ({
        agentId: this.memberAgent('CODING_WORKER',workerAccounts[index]!.id,member.agentId),
        model: member.model ?? null,
        reasoning: reasoningOrNull(member.reasoning),
        // Absent means automatic; the orchestrator's row never carries one.
        selection: isWorkerSelection(member.selection) ? member.selection : 'auto',
        // What the person calls this member in the timeline. Falls back to
        // the connection's own name.
        label: member.label ?? workerAccounts[index]!.display_name,
      })),
    );
    return this.toView(record);
  }

  /**
   * The project's spending limits for metered connections.
   *
   * Every field may be null, which means no limit - and is what every project
   * has until someone sets one. A limit stops *this application* from making
   * the next call; it is not a ceiling the provider enforces, and the screen
   * that writes these says so in those words.
   */
  setBudget(
    workspaceId: string,
    budget: { maxInvocations: number | null; maxTokens: number | null; maxCostUsd: number | null },
  ): WorkspaceView {
    this.database.workspaces.require(workspaceId);
    this.database.workspaces.setBudget(workspaceId, budget);
    return this.toView(this.database.workspaces.require(workspaceId));
  }

  /**
   * What changed in the working copy, read with git and never remembered.
   *
   * Read-only by construction: `GitEvidenceCollector.git` refuses any argument
   * that could write. The diff is bounded so a huge tree cannot flood the
   * window; the file list is always complete.
   */
  async changes(workspaceId: string): Promise<WorkspaceChangesView> {
    const workspace = this.database.workspaces.require(workspaceId);
    const none: WorkspaceChangesView = {
      isRepository: false,
      branch: null,
      head: null,
      files: [],
      diffStat: '',
      diff: '',
      truncated: false,
    };
    let git: string;
    try {
      git = await this.runtimes.executablePath('git');
    } catch {
      return none;
    }
    const collector = new GitEvidenceCollector(workspace.local_path, this.processManager, git);
    if (!(await collector.isGitRepository())) return none;

    const [head, branch, status, stat, diff, untracked] = await Promise.all([
      collector.git(['rev-parse', 'HEAD']),
      collector.git(['branch', '--show-current']),
      collector.git(['status', '--porcelain']),
      collector.git(['diff', 'HEAD', '--stat']),
      collector.git(['diff', 'HEAD']),
      collector.git(['ls-files', '--others', '--exclude-standard']),
    ]);
    const files = parseStatusShort(status.stdout).map((entry) => ({
      path: entry.path,
      status: describeStatus(entry.indexStatus, entry.worktreeStatus),
    }));

    // Untracked files have no diff of their own; show them as additions so a
    // new file the worker wrote is visible, not just named.
    let text = diff.ok ? diff.stdout : '';
    for (const path of untracked.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0)) {
      const content = readTextIfSmall(join(workspace.local_path, path));
      if (content === null) continue;
      text += `${text.endsWith('\n') || text.length === 0 ? '' : '\n'}diff --git a/${path} b/${path}\nnew file\n--- /dev/null\n+++ b/${path}\n`;
      text += content
        .split(/\r?\n/)
        .map((line) => `+${line}`)
        .join('\n');
      text += '\n';
    }
    const truncated = text.length > DIFF_LIMIT;
    return {
      isRepository: true,
      branch: branch.ok ? branch.stdout.trim() || null : null,
      head: head.ok ? head.stdout.trim() : null,
      files,
      diffStat: stat.ok ? stat.stdout : '',
      diff: truncated ? `${text.slice(0, DIFF_LIMIT)}\n… (diff truncado)` : text,
      truncated,
    };
  }

  // -- git on the project: fetch, branch, commit, push ------------------------

  /** The remote git actually has, read from the working copy; the recorded URL is the fallback. */
  private async remoteUrl(workspace: WorkspaceWithAgents): Promise<string | null> {
    try {
      const git = await this.runtimes.executablePath('git');
      const collector = new GitEvidenceCollector(workspace.local_path, this.processManager, git);
      const result = await collector.git(['config', '--get', 'remote.origin.url']);
      const url = result.ok ? result.stdout.trim() : '';
      return url.length > 0 ? url : workspace.repository_url;
    } catch {
      return workspace.repository_url;
    }
  }

  private gitEnvironmentFor(remoteUrl: string | null): Record<string, string> {
    return { GIT_TERMINAL_PROMPT: '0', ...(this.github?.gitEnvironmentFor(remoteUrl) ?? {}) };
  }

  /**
   * Runs one mutating git command on the project and reports it. Every
   * argument is fixed here; the only user text that reaches argv is a branch
   * name the validator accepted or a commit message after `-m`.
   */
  private async runGit(
    workspaceId: string,
    args: string[],
    summaryOk: string,
    summaryFail: string,
    options: { timeoutMs?: number; extraEnv?: Record<string, string> } = {},
  ): Promise<GitOperationResult> {
    const workspace = this.database.workspaces.require(workspaceId);
    if (this.isBusy(workspaceId)) {
      throw new WorkspaceError('Cancele a execução em andamento antes de mexer no git do projeto.');
    }
    const git = await this.runtimes.executablePath('git');
    const remote = await this.remoteUrl(workspace);
    const result = await this.processManager.run({
      command: git,
      args,
      cwd: workspace.local_path,
      timeoutMs: options.timeoutMs ?? 10 * 60_000,
      env: { ...this.gitEnvironmentFor(remote), ...(options.extraEnv ?? {}) },
    });
    const ok = result.outcome === 'completed' && result.exitCode === 0;
    const output = redact(`${result.stdout}\n${result.stderr}`.trim()).slice(0, 4000);
    if (ok) this.database.workspaces.touch(workspaceId);
    return {
      ok,
      summary: ok ? summaryOk : `${summaryFail}${firstLine(result.stderr || result.stdout)}`,
      output,
      workspace: {
        ...this.toView(this.database.workspaces.require(workspaceId)),
        branch: await this.currentBranch(workspace.local_path),
      },
    };
  }

  fetch(workspaceId: string): Promise<GitOperationResult> {
    return this.runGit(workspaceId, ['fetch', '--prune'], 'Remoto atualizado.', 'O fetch falhou.');
  }

  createBranch(workspaceId: string, name: string): Promise<GitOperationResult> {
    return this.runGit(
      workspaceId,
      ['switch', '--create', name],
      `Branch "${name}" criada e ativa.`,
      'Não foi possível criar a branch.',
    );
  }

  /**
   * Stages everything and commits. Author identity comes from the repository
   * or the person's git config; when neither has one, the GitHub login is
   * used with GitHub's no-reply address, so the commit is still theirs.
   */
  async commit(workspaceId: string, message: string): Promise<GitOperationResult> {
    const staged = await this.runGit(workspaceId, ['add', '--all'], 'Alterações preparadas.', 'Não foi possível preparar as alterações.');
    if (!staged.ok) return staged;
    const login = this.github?.status().login ?? null;
    // The repository's own identity wins when it has one: the environment
    // is only consulted by git when config has nothing.
    const configured = await this.hasIdentity(workspaceId);
    if (!configured && !login) {
      // Git would refuse too, in its own words. Saying it first keeps the
      // person from staging and then reading "Please tell me who you are".
      return {
        ok: false,
        summary:
          'O git não sabe quem você é. Conecte o GitHub em Contas e integrações, ou configure user.name e user.email no git.',
        output: '',
        workspace: staged.workspace,
      };
    }
    const identity: Record<string, string> = login
      ? {
          GIT_AUTHOR_NAME: login,
          GIT_AUTHOR_EMAIL: `${login}@users.noreply.github.com`,
          GIT_COMMITTER_NAME: login,
          GIT_COMMITTER_EMAIL: `${login}@users.noreply.github.com`,
        }
      : {};
    return this.runGit(
      workspaceId,
      ['commit', '--message', message],
      'Commit criado.',
      'O commit não foi criado.',
      { extraEnv: configured ? {} : identity },
    );
  }

  private async hasIdentity(workspaceId: string): Promise<boolean> {
    const workspace = this.database.workspaces.require(workspaceId);
    try {
      const git = await this.runtimes.executablePath('git');
      const collector = new GitEvidenceCollector(workspace.local_path, this.processManager, git);
      const [name, email] = await Promise.all([
        collector.git(['config', '--get', 'user.name']),
        collector.git(['config', '--get', 'user.email']),
      ]);
      return name.ok && email.ok && name.stdout.trim().length > 0 && email.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Pushes the current branch, setting its upstream the first time. */
  push(workspaceId: string): Promise<GitOperationResult> {
    return this.runGit(
      workspaceId,
      ['push', '--set-upstream', 'origin', 'HEAD'],
      'Push concluído.',
      'O push falhou.',
    );
  }

  async pullRequestStatus(workspaceId: string): Promise<PullRequestStatusView> {
    const workspace = this.database.workspaces.require(workspaceId);
    const remoteUrl = await this.remoteUrl(workspace);
    const remote = parseGitHubRemote(remoteUrl);
    const branch = await this.currentBranch(workspace.local_path);
    if (!remote || !this.github || !branch || !this.github.status().connected) {
      return { repository: remote ? `${remote.owner}/${remote.repo}` : null, branch, pullRequests: [], checks: null };
    }
    const [pullRequests, checks] = await Promise.all([
      this.github.pullRequestsFor(remoteUrl!, branch),
      this.github.checksFor(remoteUrl!, branch).catch(() => null),
    ]);
    return { repository: `${remote.owner}/${remote.repo}`, branch, pullRequests, checks };
  }

  async createPullRequest(input: {
    workspaceId: string;
    title: string;
    body?: string;
    base?: string;
  }): Promise<PullRequestView> {
    const workspace = this.database.workspaces.require(input.workspaceId);
    if (!this.github) throw new WorkspaceError('O GitHub não está disponível.');
    const remoteUrl = await this.remoteUrl(workspace);
    if (!remoteUrl) throw new WorkspaceError('Este projeto não tem um remoto configurado.');
    const head = await this.currentBranch(workspace.local_path);
    if (!head) throw new WorkspaceError('O projeto não está em uma branch.');
    const base = input.base ?? workspace.default_branch ?? (await this.defaultBranchOf(workspace)) ?? 'main';
    if (base === head) throw new WorkspaceError(`A branch atual já é "${base}"; crie uma branch para o pull request.`);
    return this.github.createPullRequest({
      remoteUrl,
      head,
      base,
      title: input.title,
      body: input.body ?? '',
    });
  }

  private async defaultBranchOf(workspace: WorkspaceWithAgents): Promise<string | null> {
    try {
      const git = await this.runtimes.executablePath('git');
      const collector = new GitEvidenceCollector(workspace.local_path, this.processManager, git);
      const result = await collector.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      return result.ok ? result.stdout.trim().replace(/^origin\//, '') || null : null;
    } catch {
      return null;
    }
  }

  private accountForRole(role: TeamRole, accountId: string) {
    const account = this.database.accounts.find(accountId);
    if (!account) throw new WorkspaceError('Essa conta não existe mais.');
    return account;
  }

  private toView(record: WorkspaceWithAgents): WorkspaceView {
    return {
      id: record.id,
      name: record.display_name,
      // Every kind this application knows, named. Anything else falls back to
      // `local`, which is the only one that could touch a file on this
      // computer - the safe way round for a value nobody recognises.
      environment:
        record.environment === 'cloud'
          ? 'cloud'
          : record.environment === 'conversation'
            ? 'conversation'
            : record.environment === 'github'
              ? 'github'
              : 'local',
      localPath: record.local_path,
      repository: record.repository_full_name,
      repositoryPrivate: record.repository_private === 1,
      publish: {
        enabled: record.publish_enabled !== 0,
        pullRequest: record.publish_pull_request === 1,
      },
      repositoryUrl: record.repository_url,
      defaultBranch: record.default_branch,
      // For a local project this is filled in by `listWithBranches`, which
      // reads the working copy; a plain view does not touch the disk. For a
      // cloud project there is no disk here to read, and the branch its work
      // starts from is simply a recorded fact - so it is reported, rather than
      // the interface showing "—" for something it knows.
      branch: (record.environment ?? 'local') === 'cloud' ? record.branch : null,
      orchestratorAgentId: record.orchestrator_agent_id,
      workerAgentId: record.worker_agent_id,
      team: {
        orchestrator: this.memberView(
          'ORCHESTRATOR',
          record.orchestrator_agent_id,
          record.orchestrator_model,
          record.orchestrator_reasoning,
          orchestratorSelectionOf(record),
        ),
        worker: this.memberView(
          'CODING_WORKER',
          record.worker_agent_id,
          record.worker_model,
          record.worker_reasoning,
          isWorkerSelection(record.worker_selection) ? record.worker_selection : 'auto',
        ),
        // Every worker, in slot order. `worker` above is slot 0, kept so that
        // everything written before teams could grow reads the same member.
        workers: this.database.workspaces
          .team(record.id)
          .filter((member) => member.role === 'CODING_WORKER')
          .map((member) => ({
            ...this.memberView(
              'CODING_WORKER',
              member.agentId,
              member.model,
              member.reasoning,
              isWorkerSelection(member.selection) ? member.selection : 'auto',
            ),
            workerId: `worker-${member.slot + 1}`,
            label: member.label,
          })),
      },
      budget: {
        maxInvocations: positiveOrNull(record.budget_max_invocations),
        maxTokens: positiveOrNull(record.budget_max_tokens),
        maxCostUsd: positiveOrNull(record.budget_max_cost_usd),
      },
      createdAt: record.created_at,
      updatedAt: record.updated_at ?? record.created_at,
    };
  }

  private memberView(
    role: TeamRole,
    agentId: string | null,
    model: string | null,
    reasoning: string | null,
    selection: WorkerSelection,
  ): TeamMemberView {
    const agent = agentId ? this.database.agents.find(agentId) : undefined;
    const account = agent?.account_id ? this.database.accounts.find(agent.account_id) : undefined;
    return {
      role,
      provider: (account?.provider_id ?? agent?.provider_id ?? (role==='ORCHESTRATOR'?'openai':'anthropic')) as ProviderName,
      agentId: agent?.id ?? null,
      accountId: account?.id ?? null,
      accountName: account?.display_name ?? null,
      model,
      reasoning: reasoningOrNull(reasoning),
      selection,
    };
  }
}

/** The diff view is for reading; beyond this a person uses their tools. */
const DIFF_LIMIT = 200_000;

function describeStatus(index: string, worktree: string): string {
  if (index === '?' || worktree === '?') return 'novo';
  if (index === 'A') return 'adicionado';
  if (index === 'D' || worktree === 'D') return 'removido';
  if (index === 'R') return 'renomeado';
  if (index === 'M' || worktree === 'M') return 'modificado';
  return `${index}${worktree}`.trim() || 'alterado';
}

function readTextIfSmall(path: string): string | null {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > 64_000) return null;
    const text = readFileSync(path, 'utf8');
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

/**
 * The orchestrator's selection, read from its row: `manual` when saved so,
 * or - on a row from before the column existed - when a model or a level was
 * pinned, so an older team keeps behaving as it did.
 */
export function orchestratorSelectionOf(record: {
  orchestrator_selection: string | null;
  orchestrator_model: string | null;
  orchestrator_reasoning: string | null;
}): 'auto' | 'manual' {
  if (record.orchestrator_selection === 'manual') return 'manual';
  if (record.orchestrator_selection === null && (record.orchestrator_model || record.orchestrator_reasoning)) return 'manual';
  return 'auto';
}

function reasoningOrNull(value: string | null | undefined): ReasoningLevel | null {
  return (REASONING_LEVELS as readonly string[]).includes(value ?? '')
    ? (value as ReasoningLevel)
    : null;
}

function assertUsableDirectory(path: string): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new WorkspaceError('Essa pasta não existe mais.');
  }
  if (!stats.isDirectory()) throw new WorkspaceError('O caminho escolhido não é uma pasta.');
  try {
    readdirSync(path);
  } catch {
    throw new WorkspaceError('Sem permissão para ler essa pasta.');
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Keeps a user-typed project name from becoming a path of its own. */
export function safeFolderName(name: string): string {
  const cleaned = basename(name.trim())
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^\.+/, '')
    .trim();
  if (cleaned.length === 0) throw new WorkspaceError('Escolha um nome de projeto válido.');
  return cleaned;
}

/** Exposed for the shell, which creates the parent folder before cloning. */
export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? ` ${line.slice(0, 200)}` : '';
}

/** A stored limit, or null when the column is empty or nonsensical. */
function positiveOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `owner/name` back to the canonical URL, for a cloud workspace that stored only the name. */
function repositoryUrlOfFullName(fullName: string | null): string | null {
  if (!fullName || fullName.trim().length === 0) return null;
  return `https://github.com/${fullName.trim()}`;
}

/**
 * A workspace's name, shortened to what a project will accept.
 *
 * The two limits are the same number, so this normally does nothing. It
 * matters for the case where they are not: a folder whose leaf is longer than
 * 120 characters, or a row written before the limit existed. Refusing there
 * would mean refusing to open somebody's folder over the length of its name.
 */
function clampName(name: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return 'Projeto';
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 119)}…`;
}
