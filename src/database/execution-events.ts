import type { SqlDriver } from './driver.js';
import { redact } from '../security/secret-redactor.js';
import { traceSummary, type EventInput, type ExecutionEvent } from '../execution/events.js';

/** Redact values before encoding. Redacting serialized JSON can remove quotes. */
export function encodeEventData(value: unknown): string {
  function clean(v: unknown, key = ''): unknown {
    if (typeof v === 'string') return /^(token|secret|password|authorization|cookie|apiKey)$/i.test(key) ? '[REDACTED]' : redact(v);
    if (Array.isArray(v)) return v.map(x=>clean(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,clean(x,k)]));
    return v;
  }
  return JSON.stringify(clean(value));
}

/** Idempotent durable writes, ordered by SQLite sequence even when clocks tie. */
export class ExecutionEventRepository {
  constructor(private readonly db: SqlDriver) {}

  append(input: EventInput): string {
    const id = `${input.runId}:${input.key}`;
    this.db.run(`INSERT INTO execution_events
      (id,run_id,type,timestamp,parent_id,iteration,agent_id,invocation_id,role,status,summary,data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, [
      id,input.runId,input.type,input.timestamp ?? new Date().toISOString(),input.parentId ?? null,
      input.iteration,input.agentId ?? null,input.invocationId ?? null,input.role ?? 'ORCHESTRATOR',
      input.status,redact(traceSummary(input.summary)),encodeEventData(input.data ?? {}),
    ]);
    return id;
  }

  list(runId: string): ExecutionEvent[] {
    return this.db.all('SELECT * FROM execution_events WHERE run_id=? ORDER BY sequence', [runId]).map(r => ({
      id: String(r.id),sequence:Number(r.sequence),runId:String(r.run_id),type:r.type as ExecutionEvent['type'],
      timestamp:String(r.timestamp),parentId:r.parent_id as string|null,iteration:Number(r.iteration),
      agentId:r.agent_id as string|null,invocationId:r.invocation_id as string|null,role:String(r.role),
      status:String(r.status),summary:String(r.summary),data:JSON.parse(String(r.data)),
    }));
  }
}
