/**
 * Chat: where a user's sentence becomes a run.
 *
 * Sending a message is two things at once — a row in `messages` that survives a
 * restart, and the trigger for an orchestration run. The run is started, not
 * awaited: `sendMessage` returns as soon as both exist so the interface can
 * render the message and the "Analisando..." state without blocking.
 */

import type { ChatSessionRecord, Database, ListSessionsOptions } from '../core.js';
import { newId } from '../core.js';
import type { ChatMessageView, ChatSessionView, RunView } from '../../shared/ipc-contract.js';
import type { OrchestrationService } from './orchestration-service.js';
import { toMessageView, toSessionView } from './views.js';
import { readStopIntent } from '../../../../../src/orchestrator/stop-intent.js';

export class ChatError extends Error {
  readonly code = 'CHAT_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ChatError';
  }
}

/** The most recent run of a conversation, for a message that needs one. */
function lastRunOf(
  database: Database,
  sessionId: string,
  orchestration: OrchestrationService,
): RunView | null {
  const runs = database.runs.listForSession(sessionId);
  const last = runs[runs.length - 1];
  return last ? orchestration.view(last.id) : null;
}

export class ChatService {
  constructor(
    private readonly database: Database,
    private readonly orchestration: OrchestrationService,
  ) {}

  /**
   * Cancels this conversation's run, if one is going.
   *
   * Returns the run it stopped so the caller can point the message at it.
   * Nothing here calls a model: it goes straight to the orchestration
   * service's own control path, which aborts the loop and kills the child
   * processes.
   */
  private stopActiveRun(sessionId: string): RunView | null {
    for (const run of this.database.runs.listForSession(sessionId)) {
      if (run.status !== 'RUNNING' && run.status !== 'PENDING' && run.status !== 'BLOCKED') continue;
      if (!this.orchestration.cancel(run.id)) continue;
      return this.orchestration.view(run.id);
    }
    return null;
  }

  listSessions(workspaceId: string, options: ListSessionsOptions = {}): ChatSessionView[] {
    this.database.workspaces.require(workspaceId);
    return this.database.chat.listSessions(workspaceId, options).map((s) => this.view(s));
  }

  /**
   * A new conversation, in a workspace and - when asked - under a project.
   * Started from inside a project, it is born there; the workspace is the
   * one the caller names (the project's own, by default, in the interface).
   */
  createSession(workspaceId: string, title: string, projectId: string | null = null): ChatSessionView {
    this.database.workspaces.require(workspaceId);
    if (projectId && !this.database.projects.find(projectId)) {
      throw new ChatError('Este projeto não existe mais.');
    }
    const record = this.database.chat.createSession({ id: newId('chat'), workspaceId, title, projectId });
    if (projectId) this.database.projects.touch(projectId);
    return this.view(record);
  }

  /** Every conversation of every workspace, for the project tree and the search. */
  listAllSessions(options: ListSessionsOptions = {}): ChatSessionView[] {
    return this.database.chat.listAllSessions(options).map((s) => this.view(s));
  }

  /** Files the conversation under another project, or under none. Persisted. */
  moveSession(sessionId: string, projectId: string | null): ChatSessionView {
    this.database.chat.requireSession(sessionId);
    if (projectId && !this.database.projects.find(projectId)) {
      throw new ChatError('Este projeto não existe mais.');
    }
    const record = this.database.chat.setSessionProject(sessionId, projectId);
    if (projectId) this.database.projects.touch(projectId);
    return this.view(record);
  }

  renameSession(sessionId: string, title: string): ChatSessionView {
    this.database.chat.requireSession(sessionId);
    return this.view(this.database.chat.renameSession(sessionId, title));
  }

  /** Hides a conversation from the list, or brings it back. Never deletes. */
  archiveSession(sessionId: string, archived: boolean): ChatSessionView {
    this.database.chat.requireSession(sessionId);
    return this.view(this.database.chat.setSessionArchived(sessionId, archived));
  }

  /**
   * Deletes the conversation and its messages.
   *
   * Its runs stay in the execution history (their `session_id` becomes NULL)
   * so evidence and verdicts are never lost with a conversation, and nothing in
   * the project folder is touched. A conversation with a run still going is
   * refused: cancel first, then delete.
   */
  deleteSession(sessionId: string): boolean {
    this.database.chat.requireSession(sessionId);
    const live = this.database.runs
      .listForSession(sessionId)
      .find((run) => run.status === 'RUNNING' || run.status === 'PENDING');
    if (live) {
      throw new ChatError('Cancele a execução em andamento antes de apagar esta conversa.');
    }
    return this.database.chat.deleteSession(sessionId);
  }

  private view(record: ChatSessionRecord): ChatSessionView {
    const project = record.project_id ? this.database.projects.find(record.project_id) : undefined;
    const workspace = this.database.workspaces.find(record.workspace_id);
    return toSessionView(record, {
      messageCount: this.database.chat.countMessages(record.id),
      lastRun: this.database.runs.listForSession(record.id).at(-1) ?? null,
      projectName: project?.name ?? null,
      workspaceName: workspace?.display_name ?? null,
    });
  }

  listMessages(sessionId: string): ChatMessageView[] {
    this.database.chat.requireSession(sessionId);
    return this.database.chat.listMessages(sessionId).map(toMessageView);
  }

  sendMessage(sessionId: string, text: string): { message: ChatMessageView; run: RunView } {
    const session = this.database.chat.requireSession(sessionId);
    const workspace = this.database.workspaces.require(session.workspace_id);
    if (!workspace.orchestrator_agent_id || !workspace.worker_agent_id) {
      throw new ChatError(
        'Escolha quem supervisiona e quem executa neste projeto antes de enviar uma tarefa.',
      );
    }

    // Writing to an archived conversation reopens it: a person who found it in
    // the archive and sent something expects to see it in the list again.
    if (session.archived_at) this.database.chat.setSessionArchived(sessionId, false);

    const record = this.database.chat.addMessage({ sessionId, author: 'user', body: text });

    // "pare tudo q esteja fazendo" is not a task.
    //
    // Both of the person's stop requests became new runs: the supervisor was
    // asked to plan how to stop and the worker was delegated the job of
    // confirming that it had. The run they wanted stopped kept going.
    //
    // Cancelling is a control operation. It reaches the process manager
    // directly, no model is asked, and no run is created - which is why this
    // returns the run it *stopped*, or the last one, rather than a new one.
    if (readStopIntent(text) === 'stop') {
      const stopped = this.stopActiveRun(sessionId);
      this.database.chat.addMessage({
        sessionId,
        author: 'system',
        body: stopped
          ? 'Cancelando a execução em andamento. Nenhum agente foi chamado para isso.'
          : 'Não há nenhuma tarefa em andamento nesta conversa. Nada foi iniciado.',
        ...(stopped ? { runId: stopped.id } : {}),
      });
      this.database.workspaces.touch(workspace.id);
      const view = stopped ?? lastRunOf(this.database, sessionId, this.orchestration);
      if (view) {
        return { message: toMessageView({ ...record, run_id: view.id }), run: view };
      }
      // Nothing to stop and nothing to point at. The message stands on its
      // own; no run is invented to carry it.
      throw new ChatError('Não há nenhuma tarefa em andamento nesta conversa.');
    }

    const run = this.orchestration.start({ sessionId, objective: text });
    // The message that started the run carries its id, so the history of a
    // later run can leave this one out, and the interface can pair them.
    this.database.chat.setMessageRun(record.id, run.id);
    this.database.workspaces.touch(workspace.id);
    return { message: toMessageView({ ...record, run_id: run.id }), run };
  }
}
