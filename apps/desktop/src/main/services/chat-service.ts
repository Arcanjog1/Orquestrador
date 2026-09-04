/**
 * Chat: where a user's sentence becomes a run.
 *
 * Sending a message is two things at once — a row in `messages` that survives a
 * restart, and the trigger for an orchestration run. The run is started, not
 * awaited: `sendMessage` returns as soon as both exist so the interface can
 * render the message and the "Analisando..." state without blocking.
 */

import type { Database } from '../core.js';
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

  listSessions(workspaceId: string): ChatSessionView[] {
    this.database.workspaces.require(workspaceId);
    return this.database.chat.listSessions(workspaceId).map(toSessionView);
  }

  createSession(workspaceId: string, title: string): ChatSessionView {
    this.database.workspaces.require(workspaceId);
    return toSessionView(
      this.database.chat.createSession({ id: newId('chat'), workspaceId, title }),
    );
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

    const message = toMessageView(
      this.database.chat.addMessage({ sessionId, author: 'user', body: text }),
    );
    const run = this.orchestration.start({ sessionId, objective: text });
    this.database.workspaces.touch(workspace.id);
    return { message, run };
  }
}
