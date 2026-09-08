/**
 * Projects: the one thing a person organises by.
 *
 * The interface used to show three lists — Recentes, Projetos and Pastas —
 * and the same folder could appear in two of them at once, because the folder
 * was a `workspace` row and the organisation was a `project` row and nothing
 * joined them on screen. This service is the join. A project now carries the
 * identity a person recognises it by:
 *
 * - a **folder** on this computer (through its workspace), or
 * - a **repository** on GitHub, or
 * - **neither yet**, to be associated later.
 *
 * What it deliberately is *not* is a second execution model. A run still
 * executes in a workspace, with the workspace's team, budget and verifications.
 * The project says which workspace and remembers what the repository is; it
 * never decides how anything runs.
 *
 * ## The two ways a project can be put away
 *
 * They are different acts and the interface must not blur them:
 *
 * | | What happens to the conversations | Reversible |
 * |---|---|---|
 * | **Arquivar** | stay in the project, hidden with it | yes, exactly as it was |
 * | **Remover** | move to "Sem projeto", kept with messages and runs | the project row is gone |
 *
 * Neither touches a folder on disk, a repository on GitHub, or the git index.
 * Removing a project is an act of organisation, and an act of organisation
 * that could delete somebody's code would be the wrong shape of thing entirely.
 */

import type { Database, ProjectRecord } from '../core.js';
import { newId } from '../core.js';
import type {
  ProjectContextKind,
  ProjectContextView,
  ProjectRemovalPlanView,
  ProjectView,
} from '../../shared/ipc-contract.js';
import {
  displayFullName,
  repositoryKey,
  suggestedRepositoryName,
} from '../../../../../src/github/repository-identity.js';

export class ProjectError extends Error {
  readonly code = 'PROJECT_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ProjectError';
  }
}

const CONTEXT_KINDS: readonly ProjectContextKind[] = [
  'objective',
  'decision',
  'architecture',
  'rule',
  'state',
  'evidence',
];

export class ProjectService {
  constructor(private readonly database: Database) {}

  list(): ProjectView[] {
    return this.database.projects.list().map((record) => this.view(record));
  }

  find(projectId: string): ProjectView | null {
    const record = this.database.projects.find(projectId);
    return record ? this.view(record) : null;
  }

  create(input: {
    name: string;
    workspaceId?: string | null;
    /** Associates a repository at birth. Rejected if another project has it. */
    repositoryUrl?: string | null;
  }): ProjectView {
    const name = cleanName(input.name);
    const workspaceId = this.workspaceOrNull(input.workspaceId);
    const key = repositoryKey(input.repositoryUrl);

    if (key.length > 0) {
      const clash = this.database.projects.findByRepositoryKey(key);
      if (clash) {
        throw new ProjectError(
          `Este repositório já está no projeto "${clash.name}". Abra esse projeto em vez de criar outro.`,
        );
      }
    }

    const record = this.database.projects.create({
      id: newId('proj'),
      name,
      workspaceId,
      repositoryKey: key,
      repositoryUrl: key.length > 0 ? (input.repositoryUrl ?? null) : null,
      repositoryFullName: key.length > 0 ? displayFullName(input.repositoryUrl) : null,
      source: workspaceId ? 'folder' : key.length > 0 ? 'repository' : 'empty',
    });
    return this.view(record);
  }

  /**
   * Opens the project for a repository, creating it only when there is none.
   *
   * The repository twin of `WorkspaceService.openFolder`, and it exists for
   * the same complaint: connecting the same repository twice must open what is
   * already there, not add a second copy of it. The comparison is on the
   * canonical key, so the browser URL, the clone URL, the ssh remote and
   * `owner/name` typed from memory are all one project.
   *
   * Nothing is fetched here and nothing is cloned. This is bookkeeping; the
   * metadata and the real default branch arrive separately, through
   * `recordRepositoryMetadata`, so that a network failure cannot leave the
   * person without their project.
   */
  openRepository(input: { url: string; name?: string }): { project: ProjectView; created: boolean } {
    const key = repositoryKey(input.url);
    if (key.length === 0) {
      throw new ProjectError(
        'Não reconheci esse endereço como um repositório do GitHub. Use https://github.com/dono/nome ou dono/nome.',
      );
    }

    const existing = this.database.projects.findByRepositoryKey(key);
    if (existing) {
      this.database.projects.touch(existing.id);
      return { project: this.view(this.database.projects.require(existing.id)), created: false };
    }

    const record = this.database.projects.create({
      id: newId('proj'),
      name: cleanName(input.name ?? suggestedRepositoryName(input.url)),
      repositoryKey: key,
      repositoryUrl: input.url.trim(),
      repositoryFullName: displayFullName(input.url),
      source: 'repository',
    });
    return { project: this.view(record), created: true };
  }

  /**
   * Writes what GitHub actually said about the repository.
   *
   * Separated from `openRepository` on purpose: the default branch is a fact
   * that belongs to the server, and until the server has been asked, the
   * column stays NULL and the interface says "não informado". It never
   * defaults to `main` — this repository's default branch is not called main,
   * and a guess that looks like an answer is worse than no answer.
   */
  recordRepositoryMetadata(
    projectId: string,
    metadata: {
      fullName?: string | null;
      isPrivate?: boolean | null;
      defaultBranch?: string | null;
      url?: string | null;
    },
  ): ProjectView {
    const current = this.require(projectId);
    const record = this.database.projects.setRepository(projectId, {
      key: current.repository_key,
      url: metadata.url ?? current.repository_url,
      fullName: metadata.fullName ?? current.repository_full_name,
      isPrivate: metadata.isPrivate === undefined ? boolOrNull(current.repository_private) : metadata.isPrivate,
      defaultBranch: metadata.defaultBranch ?? current.default_branch,
    });
    return this.view(record);
  }

  /** Records the branch and commit an analysis actually read. */
  recordAnalysis(projectId: string, analysis: { branch: string | null; commit: string | null }): ProjectView {
    this.require(projectId);
    return this.view(this.database.projects.setAnalysis(projectId, analysis));
  }

  /** Associates a repository with an existing project, or clears the association. */
  setRepository(projectId: string, url: string | null): ProjectView {
    const current = this.require(projectId);
    if (url === null || url.trim().length === 0) {
      return this.view(
        this.database.projects.setRepository(projectId, {
          key: '',
          url: null,
          fullName: null,
          isPrivate: null,
          // The branch belonged to the repository that is being removed.
          defaultBranch: null,
        }),
      );
    }

    const key = repositoryKey(url);
    if (key.length === 0) {
      throw new ProjectError(
        'Não reconheci esse endereço como um repositório do GitHub. Use https://github.com/dono/nome ou dono/nome.',
      );
    }
    const clash = this.database.projects.findByRepositoryKey(key);
    if (clash && clash.id !== projectId) {
      throw new ProjectError(`Este repositório já está no projeto "${clash.name}".`);
    }

    return this.view(
      this.database.projects.setRepository(projectId, {
        key,
        url: url.trim(),
        fullName: displayFullName(url),
        isPrivate: boolOrNull(current.repository_private),
        // A different repository has a different default branch, and keeping
        // the old one would be a stale answer wearing a fresh label.
        defaultBranch: key === current.repository_key ? current.default_branch : null,
      }),
    );
  }

  rename(projectId: string, name: string): ProjectView {
    this.require(projectId);
    return this.view(this.database.projects.rename(projectId, cleanName(name)));
  }

  /** Points the project at a workspace, or at none. Existing conversations keep theirs. */
  setWorkspace(projectId: string, workspaceId: string | null): ProjectView {
    this.require(projectId);
    return this.view(this.database.projects.setWorkspace(projectId, this.workspaceOrNull(workspaceId)));
  }

  /**
   * Puts the project away, or brings it back.
   *
   * Its conversations go with it and come back with it, still filed under it,
   * still holding their messages and runs. This is the operation for "I am not
   * working on this now", and it is the one the interface should offer first,
   * because it is the one that cannot lose anything.
   */
  setArchived(projectId: string, archived: boolean): ProjectView {
    this.require(projectId);
    return this.view(this.database.projects.setArchived(projectId, archived));
  }

  /**
   * What removing this project would do, so it can be said before it is done.
   *
   * Named so the interface cannot show a vague warning: it gets the count of
   * conversations that will move, the folder that will stay, and the
   * repository that will stay.
   */
  removalPlan(projectId: string): ProjectRemovalPlanView {
    const record = this.require(projectId);
    const workspace = record.workspace_id ? this.database.workspaces.find(record.workspace_id) : undefined;
    return {
      projectId: record.id,
      projectName: record.name,
      sessionsAffected: this.database.projects.countSessions(record.id, true),
      localPath: workspace?.local_path ?? '',
      repositoryFullName: record.repository_full_name,
    };
  }

  /**
   * Forgets the project. Its conversations become "Sem projeto" and are kept,
   * with their messages and runs; no workspace, folder, repository or file is
   * removed, and no git command runs. Says how many conversations moved, so
   * the interface can say it too.
   */
  remove(projectId: string): { removed: boolean; sessionsMoved: number } {
    this.require(projectId);
    return this.database.projects.remove(projectId);
  }

  // ---- Shared context -----------------------------------------------------

  listContext(projectId: string): ProjectContextView[] {
    this.require(projectId);
    return this.database.projectContext.list(projectId).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      kind: (CONTEXT_KINDS.includes(row.kind as ProjectContextKind) ? row.kind : 'state') as ProjectContextKind,
      title: row.title,
      body: row.body,
      sourceRef: row.source_ref,
      pinned: row.pinned === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  addContext(input: {
    projectId: string;
    kind: ProjectContextKind;
    title: string;
    body: string;
    sourceRef?: string | null;
    pinned?: boolean;
  }): ProjectContextView {
    this.require(input.projectId);
    if (!CONTEXT_KINDS.includes(input.kind)) throw new ProjectError('Tipo de contexto desconhecido.');
    const title = input.title.trim();
    const body = input.body.trim();
    if (title.length === 0) throw new ProjectError('Dê um título a esta anotação.');
    if (body.length === 0) throw new ProjectError('Escreva o conteúdo desta anotação.');
    if (body.length > 8000) throw new ProjectError('Esta anotação é longa demais (máximo 8000 caracteres).');
    const record = this.database.projectContext.create({
      id: newId('ctx'),
      projectId: input.projectId,
      kind: input.kind,
      title,
      body,
      sourceRef: input.sourceRef ?? null,
      pinned: input.pinned ?? false,
    });
    return this.contextView(record.id);
  }

  updateContext(
    entryId: string,
    input: { title?: string; body?: string; pinned?: boolean },
  ): ProjectContextView {
    this.database.projectContext.require(entryId);
    this.database.projectContext.update(entryId, {
      title: input.title?.trim(),
      body: input.body?.trim(),
      pinned: input.pinned,
    });
    return this.contextView(entryId);
  }

  removeContext(entryId: string): { removed: boolean } {
    return { removed: this.database.projectContext.remove(entryId) };
  }

  require(projectId: string): ProjectRecord {
    const record = this.database.projects.find(projectId);
    if (!record) throw new ProjectError('Este projeto não existe mais.');
    return record;
  }

  private contextView(entryId: string): ProjectContextView {
    const row = this.database.projectContext.require(entryId);
    return {
      id: row.id,
      projectId: row.project_id,
      kind: (CONTEXT_KINDS.includes(row.kind as ProjectContextKind) ? row.kind : 'state') as ProjectContextKind,
      title: row.title,
      body: row.body,
      sourceRef: row.source_ref,
      pinned: row.pinned === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private workspaceOrNull(workspaceId: string | null | undefined): string | null {
    if (!workspaceId) return null;
    if (!this.database.workspaces.find(workspaceId)) {
      throw new ProjectError('A pasta escolhida não está mais na lista de projetos.');
    }
    return workspaceId;
  }

  private view(record: ProjectRecord): ProjectView {
    const workspace = record.workspace_id ? this.database.workspaces.find(record.workspace_id) : undefined;
    return {
      id: record.id,
      name: record.name,
      workspaceId: workspace?.id ?? null,
      workspaceName: workspace?.display_name ?? null,
      sessionCount: this.database.projects.countSessions(record.id),
      createdAt: record.created_at,
      updatedAt: record.updated_at,
      source: sourceOf(record),
      archivedAt: record.archived_at ?? null,
      localPath: workspace?.local_path ?? '',
      environment: workspace ? ((workspace.environment ?? 'local') as 'local' | 'cloud' | 'conversation') : null,
      repositoryFullName: record.repository_full_name ?? null,
      repositoryUrl: record.repository_url ?? null,
      repositoryPrivate: boolOrNull(record.repository_private),
      defaultBranch: record.default_branch ?? null,
      analysedBranch: record.analysed_branch ?? null,
      analysedCommit: record.analysed_commit ?? null,
      analysedAt: record.analysed_at ?? null,
    };
  }
}

function sourceOf(record: ProjectRecord): 'folder' | 'repository' | 'empty' {
  const declared = record.source;
  if (declared === 'folder' || declared === 'repository' || declared === 'empty') return declared;
  // A row from before the column existed: read it from what it actually has.
  if (record.workspace_id) return 'folder';
  return (record.repository_key ?? '').length > 0 ? 'repository' : 'empty';
}

function boolOrNull(value: number | null | undefined): boolean | null {
  if (value === null || value === undefined) return null;
  return value === 1;
}

function cleanName(name: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) throw new ProjectError('Dê um nome ao projeto.');
  if (trimmed.length > 120) throw new ProjectError('O nome do projeto é longo demais (máximo 120 caracteres).');
  return trimmed;
}
