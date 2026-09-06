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

export class ChatError extends Error {
  readonly code = 'CHAT_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ChatError';
  }
}

export class ChatService {
  constructor(
    private readonly database: Database,
    private readonly orchestration: OrchestrationService,
  ) {}

  listSessions(workspaceId: string, options: ListSessionsOptions = {}): ChatSessionView[] {
    this.database.workspaces.require(workspaceId);
    return this.database.chat.listSessions(workspaceId, options).map((s) => this.view(s));
  }

  createSession(workspaceId: string, title: string): ChatSessionView {
    this.database.workspaces.require(workspaceId);
    return this.view(this.database.chat.createSession({ id: newId('chat'), workspaceId, title }));
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
    return toSessionView(record, {
      messageCount: this.database.chat.countMessages(record.id),
      lastRun: this.database.runs.listForSession(record.id).at(-1) ?? null,
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

    const message = toMessageView(
      this.database.chat.addMessage({ sessionId, author: 'user', body: text }),
    );
    const run = this.orchestration.start({ sessionId, objective: text });
    this.database.workspaces.touch(workspace.id);
    return { message, run };
  }
}
