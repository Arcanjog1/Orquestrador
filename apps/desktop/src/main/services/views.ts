/**
 * Record → view translation.
 *
 * Database rows and view models are deliberately different shapes: the renderer
 * gets camelCase fields it can render directly, and never a column it should
 * not know about (a profile directory, an artifacts path, a payload blob).
 */

import type { ChatSessionRecord, MessageRecord, RunRecord, RunStepRecord } from '../core.js';
import { redact } from '../core.js';
import type {
  ChatMessageView,
  ChatSessionView,
  RunDetailView,
  RunFailureKind,
  RunView,
} from '../../shared/ipc-contract.js';

export function toSessionView(
  record: ChatSessionRecord,
  extra: {
    messageCount: number;
    lastRun: RunRecord | null;
    projectName?: string | null;
    workspaceName?: string | null;
  },
): ChatSessionView {
  return {
    id: record.id,
    workspaceId: record.workspace_id,
    workspaceName: extra.workspaceName ?? null,
    projectId: record.project_id ?? null,
    projectName: extra.projectName ?? null,
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
    routing: routingOfPayload(record.payload),
  };
}

/** The routing a worker message was stored with, if any. Never throws on an odd payload. */
function routingOfPayload(payload: string | null): ChatMessageView['routing'] {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { routing?: Record<string, unknown> };
    const routing = parsed?.routing;
    if (!routing || typeof routing !== 'object') return null;
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    // Stored as the loop's RoutingRecord (resolvedModel / resolvedReasoning).
    return {
      model: str(routing.resolvedModel ?? routing.model),
      reasoning: str(routing.resolvedReasoning ?? routing.reasoning),
      selectionMode: str(routing.selectionMode) ?? 'auto',
      selectionReason: redact(str(routing.selectionReason) ?? ''),
      fallbackUsed: routing.fallbackUsed === true,
    };
  } catch {
    return null;
  }
}

export function toRunView(record: RunRecord, steps: readonly RunStepRecord[]): RunView {
  return {
    id: record.id,
    sessionId: record.session_id ?? '',
    workspaceId: record.workspace_id,
    status: record.status,
    // The loop's own counter, not the number of steps it recorded.
    iterations: record.iteration,
    summary: record.termination_reason,
    objective: record.objective,
    failureKind: record.status === 'FAILED' ? failureKindOf(steps) : null,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
  };
}

/** Reads why a run failed from the last step the loop recorded. */
function failureKindOf(steps: readonly RunStepRecord[]): RunFailureKind {
  const last = steps[steps.length - 1];
  switch (last?.phase) {
    case 'readiness':
      return 'readiness';
    case 'orchestrator':
      return last.status === 'cli-failed' ? 'cli' : 'decision';
    case 'limit':
      return 'limit';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'error';
  }
}

export function toRunDetailView(
  record: RunRecord,
  steps: readonly RunStepRecord[],
  invocations: readonly Record<string, unknown>[],
  verifications: readonly Record<string, unknown>[],
): RunDetailView {
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const flag = (v: unknown): boolean | null =>
    v === 1 || v === true ? true : v === 0 || v === false ? false : null;
  return {
    run: toRunView(record, steps),
    baseline: {
      branch: record.baseline_branch,
      commit: record.baseline_commit,
      dirty: record.baseline_dirty === 1,
    },
    steps: steps.map((step) => ({
      id: step.id,
      iteration: step.iteration,
      phase: step.phase,
      status: step.status,
      summary: step.summary === null ? null : redact(step.summary),
      detail: step.detail === null ? null : redact(step.detail),
      startedAt: step.started_at,
    })),
    invocations: invocations.map((row) => ({
      id: str(row.id) ?? '',
      iteration: num(row.iteration) ?? 0,
      role: str(row.role) ?? '',
      agentId: str(row.agent_id),
      accountId: str(row.account_id),
      task: str(row.task) === null ? null : redact(str(row.task)!).slice(0, 2000),
      outcome: str(row.outcome) ?? '',
      exitCode: num(row.exit_code),
      durationMs: num(row.duration_ms),
      startedAt: str(row.started_at) ?? '',
      requestedCapability: str(row.requested_capability),
      requestedReasoning: str(row.requested_reasoning),
      model: str(row.resolved_model),
      reasoning: str(row.resolved_reasoning),
      selectionMode: str(row.selection_mode),
      selectionReason: str(row.selection_reason) === null ? null : redact(str(row.selection_reason)!),
      fallbackUsed: flag(row.fallback_used),
    })),
    verifications: verifications.map((row) => ({
      iteration: num(row.iteration) ?? 0,
      command: redact(str(row.command) ?? ''),
      exitCode: num(row.exit_code),
      passed: row.passed === 1 || row.passed === true,
      refused: str(row.refused),
      durationMs: num(row.duration_ms),
    })),
  };
}
