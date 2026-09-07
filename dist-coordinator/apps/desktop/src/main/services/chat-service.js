/**
 * Chat: where a user's sentence becomes a run.
 *
 * Sending a message is two things at once — a row in `messages` that survives a
 * restart, and the trigger for an orchestration run. The run is started, not
 * awaited: `sendMessage` returns as soon as both exist so the interface can
 * render the message and the "Analisando..." state without blocking.
 */
import { newId } from '../core.js';
import { toMessageView, toSessionView } from './views.js';
export class ChatError extends Error {
    code = 'CHAT_ERROR';
    constructor(message) {
        super(message);
        this.name = 'ChatError';
    }
}
export class ChatService {
    database;
    orchestration;
    constructor(database, orchestration) {
        this.database = database;
        this.orchestration = orchestration;
    }
    listSessions(workspaceId, options = {}) {
        this.database.workspaces.require(workspaceId);
        return this.database.chat.listSessions(workspaceId, options).map((s) => this.view(s));
    }
    /**
     * A new conversation, in a workspace and - when asked - under a project.
     * Started from inside a project, it is born there; the workspace is the
     * one the caller names (the project's own, by default, in the interface).
     */
    createSession(workspaceId, title, projectId = null) {
        this.database.workspaces.require(workspaceId);
        if (projectId && !this.database.projects.find(projectId)) {
            throw new ChatError('Este projeto não existe mais.');
        }
        const record = this.database.chat.createSession({ id: newId('chat'), workspaceId, title, projectId });
        if (projectId)
            this.database.projects.touch(projectId);
        return this.view(record);
    }
    /** Every conversation of every workspace, for the project tree and the search. */
    listAllSessions(options = {}) {
        return this.database.chat.listAllSessions(options).map((s) => this.view(s));
    }
    /** Files the conversation under another project, or under none. Persisted. */
    moveSession(sessionId, projectId) {
        this.database.chat.requireSession(sessionId);
        if (projectId && !this.database.projects.find(projectId)) {
            throw new ChatError('Este projeto não existe mais.');
        }
        const record = this.database.chat.setSessionProject(sessionId, projectId);
        if (projectId)
            this.database.projects.touch(projectId);
        return this.view(record);
    }
    renameSession(sessionId, title) {
        this.database.chat.requireSession(sessionId);
        return this.view(this.database.chat.renameSession(sessionId, title));
    }
    /** Hides a conversation from the list, or brings it back. Never deletes. */
    archiveSession(sessionId, archived) {
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
    deleteSession(sessionId) {
        this.database.chat.requireSession(sessionId);
        const live = this.database.runs
            .listForSession(sessionId)
            .find((run) => run.status === 'RUNNING' || run.status === 'PENDING');
        if (live) {
            throw new ChatError('Cancele a execução em andamento antes de apagar esta conversa.');
        }
        return this.database.chat.deleteSession(sessionId);
    }
    view(record) {
        const project = record.project_id ? this.database.projects.find(record.project_id) : undefined;
        const workspace = this.database.workspaces.find(record.workspace_id);
        return toSessionView(record, {
            messageCount: this.database.chat.countMessages(record.id),
            lastRun: this.database.runs.listForSession(record.id).at(-1) ?? null,
            projectName: project?.name ?? null,
            workspaceName: workspace?.display_name ?? null,
        });
    }
    listMessages(sessionId) {
        this.database.chat.requireSession(sessionId);
        return this.database.chat.listMessages(sessionId).map(toMessageView);
    }
    sendMessage(sessionId, text) {
        const session = this.database.chat.requireSession(sessionId);
        const workspace = this.database.workspaces.require(session.workspace_id);
        if (!workspace.orchestrator_agent_id || !workspace.worker_agent_id) {
            throw new ChatError('Escolha quem supervisiona e quem executa neste projeto antes de enviar uma tarefa.');
        }
        // Writing to an archived conversation reopens it: a person who found it in
        // the archive and sent something expects to see it in the list again.
        if (session.archived_at)
            this.database.chat.setSessionArchived(sessionId, false);
        const record = this.database.chat.addMessage({ sessionId, author: 'user', body: text });
        const run = this.orchestration.start({ sessionId, objective: text });
        // The message that started the run carries its id, so the history of a
        // later run can leave this one out, and the interface can pair them.
        this.database.chat.setMessageRun(record.id, run.id);
        this.database.workspaces.touch(workspace.id);
        return { message: toMessageView({ ...record, run_id: run.id }), run };
    }
}
//# sourceMappingURL=chat-service.js.map