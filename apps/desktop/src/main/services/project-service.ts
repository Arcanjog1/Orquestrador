/**
 * Projects: how conversations are organised.
 *
 * A project is a real row, not a fold in the sidebar. It groups conversations,
 * may point at a workspace (the folder the agents work in) that new
 * conversations inherit, and carries nothing else: the team belongs to the
 * workspace, and a conversation's context stays its own - a project never
 * pours the messages of one conversation into another.
 *
 * Removing a project is the safe operation the person expects: the
 * conversations move to "Sem projeto" and are kept, the workspace stays on
 * the list, and nothing on disk is touched.
 */

import type { Database, ProjectRecord } from '../core.js';
import { newId } from '../core.js';
import type { ProjectView } from '../../shared/ipc-contract.js';

export class ProjectError extends Error {
  readonly code = 'PROJECT_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ProjectError';
  }
}

export class ProjectService {
  constructor(private readonly database: Database) {}

  list(): ProjectView[] {
    return this.database.projects.list().map((record) => this.view(record));
  }

  create(input: { name: string; workspaceId?: string | null }): ProjectView {
    const name = cleanName(input.name);
    const workspaceId = this.workspaceOrNull(input.workspaceId);
    const record = this.database.projects.create({ id: newId('proj'), name, workspaceId });
    return this.view(record);
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
   * Forgets the project. Its conversations become "Sem projeto" and are
   * kept, with their messages and runs; no workspace, repository or file is
   * removed. Says how many conversations moved, so the interface can.
   */
  remove(projectId: string): { removed: boolean; sessionsMoved: number } {
    this.require(projectId);
    return this.database.projects.remove(projectId);
  }

  require(projectId: string): ProjectRecord {
    const record = this.database.projects.find(projectId);
    if (!record) throw new ProjectError('Este projeto não existe mais.');
    return record;
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
    };
  }
}

function cleanName(name: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) throw new ProjectError('Dê um nome ao projeto.');
  if (trimmed.length > 120) throw new ProjectError('O nome do projeto é longo demais (máximo 120 caracteres).');
  return trimmed;
}
