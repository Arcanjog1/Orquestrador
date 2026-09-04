/**
 * Workspaces: the projects the orchestrator is allowed to work in.
 *
 * Two ways in — point at a folder, or clone a repository — and both end at the
 * same place: a row with an absolute local path. Cloning goes through the
 * managed Git runtime, so a machine with no git on PATH still works.
 */

import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Database, ProcessManager, WorkspaceWithAgents } from '../core.js';
import { newId } from '../core.js';
import type { WorkspaceView } from '../../shared/ipc-contract.js';
import type { RuntimeService } from './runtime-service.js';

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
  ) {}

  list(): WorkspaceView[] {
    return this.database.workspaces.list().map(toView);
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
    return toView(record);
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
    return toView(this.database.workspaces.setAgents(workspaceId, orchestratorAgentId, workerAgentId));
  }
}

function toView(record: WorkspaceWithAgents): WorkspaceView {
  return {
    id: record.id,
    name: record.display_name,
    localPath: record.local_path,
    repositoryUrl: record.repository_url,
    defaultBranch: record.default_branch,
    orchestratorAgentId: record.orchestrator_agent_id,
    workerAgentId: record.worker_agent_id,
    createdAt: record.created_at,
    updatedAt: record.updated_at ?? record.created_at,
  };
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
