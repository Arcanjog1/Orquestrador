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
  const seen = new Set<string>();
  // Only the public preview is condensed. Original output stays in event data.
  const value = text.trim().split('\n').map(line => line.split(/(?<=[.!?])\s+/).filter(sentence => {
    const key = sentence.replace(/\s+/g,' ').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).join(' ')).filter(Boolean).slice(0, 4).join('\n');
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
}

export const terminalExecutionStatuses = ['DONE', 'PARTIAL', 'NEEDS_HUMAN', 'BLOCKED', 'FAILED', 'CANCELLED'];
