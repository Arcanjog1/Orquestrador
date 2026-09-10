/** Public execution trace. Provider reasoning and token streams never belong here. */
export type ExecutionEventType =
  | 'USER_OBJECTIVE' | 'PLAN_CREATED' | 'AGENT_SELECTED' | 'DELEGATION_STARTED'
  | 'AGENT_STARTED' | 'AGENT_PROGRESS' | 'AGENT_RESULT' | 'EVIDENCE_CREATED'
  | 'REVIEW_REQUESTED' | 'REVIEW_RESULT' | 'RETRY_REQUESTED' | 'BLOCKED'
  | 'NEEDS_HUMAN' | 'TASK_COMPLETED' | 'FINAL_RESPONSE';

export interface ExecutionEvent {
  id: string;
  sequence: number;
  runId: string;
  type: ExecutionEventType;
  timestamp: string;
  parentId: string | null;
  iteration: number;
  agentId: string | null;
  invocationId: string | null;
  role: string;
  status: string;
  summary: string;
  data: Record<string, unknown>;
}

export type EventInput = Omit<ExecutionEvent, 'id' | 'sequence' | 'timestamp' | 'parentId' | 'agentId' | 'invocationId' | 'role' | 'data'> & {
  key: string;
  timestamp?: string;
  parentId?: string | null;
  agentId?: string | null;
  invocationId?: string | null;
  role?: string;
  data?: Record<string, unknown>;
};

export function traceSummary(text: string, limit = 280): string {
  const value = text.trim().split('\n').filter(Boolean).slice(0, 4).join('\n');
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
}

export const terminalExecutionStatuses = ['DONE', 'PARTIAL', 'NEEDS_HUMAN', 'BLOCKED', 'FAILED', 'CANCELLED'];
