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
import { GitEvidenceCollector, newId, parseStatusShort } from '../core.js';
import {
  REASONING_LEVELS,
  type ProviderName,
  type ReasoningLevel,
  type TeamMemberInput,
  type TeamMemberView,
  type TeamRole,
  type WorkspaceChangesView,
  type WorkspaceView,
} from '../../shared/ipc-contract.js';
import type { RuntimeService } from './runtime-service.js';
import { AgentService, orchestratorAgentIdFor, workerAgentIdFor } from './agent-service.js';

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

  list(): WorkspaceView[] {
    return this.database.workspaces.list().map((record) => this.toView(record));
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
        branch: await this.currentBranch(record.local_path),
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
    const record = this.database.workspaces.setTeam(
      workspaceId,
      {
        agentId: orchestratorAgentIdFor(orchestratorAccount.id),
        model: orchestrator.model ?? null,
        reasoning: reasoningOrNull(orchestrator.reasoning),
      },
      {
        agentId: workerAgentIdFor(workerAccount.id),
        model: worker.model ?? null,
        reasoning: reasoningOrNull(worker.reasoning),
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
      localPath: record.local_path,
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
        ),
        worker: this.memberView(
          'CODING_WORKER',
          record.worker_agent_id,
          record.worker_model,
          record.worker_reasoning,
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
