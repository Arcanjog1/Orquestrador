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
    kind: kindOfPayload(record.payload),
    report: reportOfPayload(record.payload),
  };
}

/** `delegation` or `report`, when the message was stored with one. */
function kindOfPayload(payload: string | null): ChatMessageView['kind'] {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { kind?: unknown };
    return parsed?.kind === 'delegation' || parsed?.kind === 'report' ? parsed.kind : null;
  } catch {
    return null;
  }
}

/**
 * The report a worker message was stored with, if any.
 *
 * Read back as it was written and never repaired: a payload this cannot parse
 * yields null, and the message renders as its text. Inventing a shape here
 * would put fields on the screen that nothing measured.
 */
function reportOfPayload(payload: string | null): ChatMessageView['report'] {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { report?: unknown };
    const report = parsed?.report;
    if (!report || typeof report !== 'object') return null;
    return report as ChatMessageView['report'];
  } catch {
    return null;
  }
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
    case 'no-progress':
      return 'no-progress';
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
  /**
   * The provider sessions of this conversation, with the connection's name.
   *
   * Optional so every existing caller keeps working; absent means "none
   * recorded", which is the truth for a run whose worker reported no session.
   */
  providerSessions: ReadonlyArray<{
    connection_id: string;
    connectionName: string | null;
    adapter_id: string;
    provider_session_id: string;
    working_directory: string;
    updated_at: string;
  }> = [],
): RunDetailView {
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const flag = (v: unknown): boolean | null =>
    v === 1 || v === true ? true : v === 0 || v === false ? false : null;
  return {
    providerSessions: providerSessions.map((session) => ({
      connectionId: session.connection_id,
      connectionName: session.connectionName,
      adapterId: session.adapter_id,
      providerSessionId: session.provider_session_id,
      workingDirectory: session.working_directory,
      updatedAt: session.updated_at,
      // The documented way to continue this exact conversation by hand. A
      // session started with `-p` is resumable only by its id, so this is the
      // only handle there is - and showing it is what turns "where did my
      // execution go?" into something a person can act on.
      resumeCommand: `claude --resume ${session.provider_session_id}`,
    })),
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
      durationMs: step.duration_ms ?? null,
    })),
    invocations: invocations.map((row) => ({
      agentSnapshot: str(row.agent_snapshot),
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
      routingObservation: str(row.routing_observation),
      model: str(row.resolved_model),
      reasoning: str(row.resolved_reasoning),
      selectionMode: str(row.selection_mode),
      selectionReason: str(row.selection_reason) === null ? null : redact(str(row.selection_reason)!),
      fallbackUsed: flag(row.fallback_used),
      providerId: str(row.provider_id),
      connectionKind: str(row.connection_kind),
      workerId: str(row.worker_id),
      // The diagnosis. Already redacted on the way in; `str` keeps a null
      // null, so a field the tool never reported stays "não informado".
      failureDetail: str(row.failure_detail),
      stderrExcerpt: row.stderr_excerpt === null ? null : redact(String(row.stderr_excerpt)),
      executable: str(row.executable),
      cliVersion: str(row.cli_version),
      signal: str(row.signal),
      lastActivityAt: str(row.last_activity_at),
      idleTimeoutMs: num(row.idle_timeout_ms),
      currentTool: str(row.current_tool),
      workingDirectory: str(row.working_directory),
      finishedAt: str(row.finished_at),
      billing: str(row.billing),
      // Nulls stay null all the way to the screen: a provider that reported
      // nothing must not read as an invocation that consumed nothing.
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      totalTokens: num(row.total_tokens),
      costUsd: num(row.cost_usd),
      failureKind: str(row.failure_kind),
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
