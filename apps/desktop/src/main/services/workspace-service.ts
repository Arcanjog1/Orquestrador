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
} from '../../shared/ipc-contract.js';
import type { RuntimeService } from './runtime-service.js';
import { AgentService, orchestratorAgentIdFor, workerAgentIdFor } from './agent-service.js';
import type { GitHubService } from './github-service.js';
import { parseGitHubRemote, redact } from '../core.js';

/** Which provider each role runs on. Fixed: Codex supervises, Claude Code executes. */
const PROVIDER_OF_ROLE: Record<TeamRole, ProviderName> = {
  ORCHESTRATOR: 'openai',
  CODING_WORKER: 'anthropic',
};

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
        // A cloud project's branch is the one it was created for; there is no
        // working copy on this computer to read it from.
        branch:
          record.environment === 'cloud'
            ? record.branch
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

    const existing = this.database.workspaces.findByPath(localPath);
    if (existing) throw new WorkspaceError('Esta pasta já está adicionada como projeto.');

    const record = this.database.workspaces.create({
      id: newId('ws'),
      name: input.name,
      localPath,
      repositoryUrl: input.repositoryUrl ?? null,
      defaultBranch: input.defaultBranch ?? null,
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
      defaultBranch: branch,
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
    if (orchestrator.role !== 'ORCHESTRATOR') {
      throw new WorkspaceError('O agente escolhido para supervisionar não é um orquestrador.');
    }
    if (worker.role !== 'CODING_WORKER') {
      throw new WorkspaceError('O agente escolhido para executar não é um agente de execução.');
    }
    return this.toView(
      this.database.workspaces.setAgents(workspaceId, orchestratorAgentId, workerAgentId),
    );
  }

  /**
   * Binds the team by account.
   *
   * The interface offers accounts, because that is what a person has: "Codex
   * Trabalho", "Claude Trabalho". Each account already has exactly one agent
   * for its role (`AgentService.sync`), so the account decides the agent. An
   * account of the wrong provider is refused with a sentence that says so.
   */
  setTeam(workspaceId: string, orchestrator: TeamMemberInput, worker: TeamMemberInput): WorkspaceView {
    this.database.workspaces.require(workspaceId);
    const orchestratorAccount = this.accountForRole('ORCHESTRATOR', orchestrator.accountId);
    const workerAccount = this.accountForRole('CODING_WORKER', worker.accountId);
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
        agentId: orchestratorAgentIdFor(orchestratorAccount.id),
        model: orchestratorSelection === 'manual' ? (orchestrator.model ?? null) : null,
        reasoning: orchestratorSelection === 'manual' ? reasoningOrNull(orchestrator.reasoning) : null,
        selection: orchestratorSelection,
      },
      {
        agentId: workerAgentIdFor(workerAccount.id),
        model: worker.model ?? null,
        reasoning: reasoningOrNull(worker.reasoning),
        // Absent means automatic; the orchestrator's row never carries one.
        selection: isWorkerSelection(worker.selection) ? worker.selection : 'auto',
      },
    );
    return this.toView(record);
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
    const expected = PROVIDER_OF_ROLE[role];
    if (account.provider_id !== expected) {
      const job = role === 'ORCHESTRATOR' ? 'supervisionar' : 'executar';
      const provider = expected === 'openai' ? 'OpenAI (Codex)' : 'Anthropic (Claude)';
      throw new WorkspaceError(
        `A conta "${account.display_name}" não pode ${job}: esta função precisa de uma conta ${provider}.`,
      );
    }
    return account;
  }

  private toView(record: WorkspaceWithAgents): WorkspaceView {
    return {
      id: record.id,
      name: record.display_name,
      environment: record.environment === 'cloud' ? 'cloud' : 'local',
      localPath: record.local_path,
      repository: record.repository_full_name,
      repositoryPrivate: record.repository_private === 1,
      publish: {
        enabled: record.publish_enabled !== 0,
        pullRequest: record.publish_pull_request === 1,
      },
      repositoryUrl: record.repository_url,
      defaultBranch: record.default_branch,
      // Filled in by `listWithBranches`; a plain view does not touch the disk.
      branch: null,
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
      provider: PROVIDER_OF_ROLE[role],
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
