/**
 * Record → view translation.
 *
 * Database rows and view models are deliberately different shapes: the renderer
 * gets camelCase fields it can render directly, and never a column it should
 * not know about (a profile directory, an artifacts path, a payload blob).
 */

import type { ChatSessionRecord, MessageRecord, RunRecord } from '../core.js';
import type { ChatMessageView, ChatSessionView, RunView } from '../../shared/ipc-contract.js';

export function toSessionView(
  record: ChatSessionRecord,
  extra: { messageCount: number; lastRun: RunRecord | null },
): ChatSessionView {
  return {
    id: record.id,
    workspaceId: record.workspace_id,
    title: record.title,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    archivedAt: record.archived_at ?? null,
    messageCount: extra.messageCount,
    lastRun: extra.lastRun ? { id: extra.lastRun.id, status: extra.lastRun.status } : null,
  };
}

export function toMessageView(record: MessageRecord): ChatMessageView {
  return {
    id: record.id,
    sessionId: record.session_id,
    author: record.author,
    text: record.body,
    createdAt: record.created_at,
    runId: record.run_id,
  };
}

export function toRunView(record: RunRecord, iterations: number): RunView {
  return {
    id: record.id,
    sessionId: record.session_id ?? '',
    workspaceId: record.workspace_id,
    status: record.status,
    iterations,
    summary: record.termination_reason,
    objective: record.objective,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
  };
}
