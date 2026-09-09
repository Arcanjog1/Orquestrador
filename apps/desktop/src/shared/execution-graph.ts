import type { ChatMessageView, RunDetailView, RunInvocationView } from './ipc-contract.js';
import { isRunOver } from './activity.js';

export type GraphKind = 'user' | 'orchestrator' | 'worker' | 'tool' | 'evidence' | 'verification' | 'human' | 'error' | 'done' | 'join';
export interface ExecutionNode {
  id: string; runId: string; kind: GraphKind; status: string; label: string; summary: string;
  fullText: string; startedAt: string; finishedAt: string | null; iteration: number;
  taskId?: string;
  sourceIds: string[]; invocation?: RunInvocationView; metadata?: unknown;
  lane: number; row: number;
}
export interface ExecutionEdge { id: string; from: string; to: string; kind: 'sequence' | 'delegation' | 'join' | 'evidence' | 'review' | 'dependency' }
export interface ExecutionGraph { nodes: ExecutionNode[]; edges: ExecutionEdge[] }

export function compactText(text: string): string {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !/^```/.test(l));
  const value = lines.slice(0, 3).join(' ');
  return value.length > 220 ? value.slice(0, 217) + '…' : value;
}

/** Pure projection. IDs, order and relations survive closing the application. */
export function executionGraph(detail: RunDetailView, messages: readonly ChatMessageView[] = []): ExecutionGraph {
  const { run } = detail;
  const terminal = isRunOver(run.status);
  const nodes: ExecutionNode[] = [];
  const edges: ExecutionEdge[] = [];
  const add = (node: Omit<ExecutionNode, 'runId' | 'lane' | 'row'>) => {
    const result: ExecutionNode = { ...node, runId: run.id, lane: 0, row: nodes.length };
    nodes.push(result); return result;
  };
  const link = (from: ExecutionNode, to: ExecutionNode, kind: ExecutionEdge['kind']) => {
    if (from.id !== to.id && !edges.some(e => e.from === from.id && e.to === to.id)) edges.push({id: `${from.id}>${to.id}`, from: from.id, to: to.id, kind});
  };
  let tail = add({ id: `run:${run.id}`, kind: 'user', status: 'completed', label: 'Objetivo', summary: compactText(run.objective), fullText: run.objective, startedAt: run.startedAt, finishedAt: run.startedAt, iteration: 0, sourceIds: [run.id] });
  const runMessages = messages.filter(m => m.runId === run.id);
  const rounds = [...new Set([...detail.steps.map(s => s.iteration), ...detail.invocations.map(i => i.iteration)])].sort((a,b) => a-b);
  for (const iteration of rounds) {
    const invocations = detail.invocations.filter(i => i.iteration === iteration).sort((a,b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
    const events: ExecutionNode[] = [];
    for (const invocation of invocations) {
      const worker = invocation.role === 'CODING_WORKER';
      const report = runMessages.find(m => m.report?.invocationId === invocation.id)?.report;
      const taskStep=[...detail.steps].reverse().find(s=>s.iteration===iteration && s.phase==='task-start' && safeJson(s.detail)?.workerId===invocation.workerId && s.startedAt<=invocation.startedAt);
      const taskId=safeJson(taskStep?.detail)?.taskId as string | undefined;
      const original=detail.steps.find(s=>s.iteration===iteration && s.phase==='orchestrator');
      const fullText = report?.declared ?? invocation.task ?? safeJson(original?.detail)?.response as string ?? original?.summary ?? '';
      const status = !invocation.finishedAt && terminal ? 'stopped' : invocation.failureKind || invocation.exitCode && invocation.exitCode !== 0 ? 'failed' : invocation.outcome;
      const node = add({taskId, id: `inv:${invocation.id}`, kind: worker ? 'worker' : 'orchestrator', status, label: worker ? (invocation.workerId ?? 'Worker') : 'Codex · revisão e decisão', summary: compactText(report?.headline ?? (worker ? fullText : safeJson(original?.detail)?.decision?.summary ?? fullText)), fullText, startedAt: invocation.startedAt, finishedAt: invocation.finishedAt ?? (terminal ? run.finishedAt : null), iteration, sourceIds: [invocation.id], invocation, metadata: report});
      events.push(node);
    }
    // Low-level calls are a single expandable group; evidence and gates remain visible.
    const groups = new Map<string, typeof detail.steps[number][]>();
    for (const step of detail.steps.filter(s => s.iteration === iteration)) {
      if (['worker', 'worker-report', 'orchestrator'].includes(step.phase) && invocations.length) continue;
      const group = /evidence|verification|file-check|done-gate|query-proof|task-join|task-conflict|permission|human/.test(step.phase) ? step.phase : 'tools';
      groups.set(group, [...(groups.get(group) ?? []), step]);
    }
    for (const [group, steps] of groups) {
      const last = steps[steps.length - 1]!;
      const failed = steps.some(s => ['failed', 'rejected', 'not-carried', 'conflict'].includes(s.status));
      const active = !terminal && steps.some(s => s.status === 'running');
      const kind: GraphKind = /permission|human/.test(group) ? 'human' : group === 'task-join' ? 'join' : group === 'task-conflict' ? 'error' : group === 'evidence' ? 'evidence' : /verification|file-check|gate|proof/.test(group) ? 'verification' : 'tool';
      events.push(add({id: `step:${steps[0]!.id}`, kind, status: failed ? 'failed' : active ? 'running' : last.status === 'running' ? 'stopped' : last.status, label: group === 'tools' ? `${steps.length} operações` : group === 'task-join' ? 'Join · resultados reunidos' : group, summary: compactText(last.summary ?? last.status), fullText: steps.map(s => `${s.phase} · ${s.status}\n${s.summary ?? ''}\n${s.detail ?? ''}`).join('\n\n'), startedAt: steps[0]!.startedAt, finishedAt: active ? null : last.startedAt, iteration, sourceIds: steps.map(s => String(s.id)), metadata: steps}));
    }
    events.sort((a,b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
    // Only measured overlapping worker intervals occupy simultaneous lanes.
    for (let i = 0; i < events.length; i++) {
      const node = events[i]!;
      if (node.kind === 'worker') {
        const workers = [node];
        while (i + 1 < events.length && events[i+1]!.kind === 'worker' && events[i+1]!.startedAt < (node.finishedAt ?? '\uffff')) workers.push(events[++i]!);
        const parent = tail;
        workers.forEach((worker, lane) => { worker.lane = lane + 1; worker.row = parent.row + 1; link(parent, worker, 'delegation'); });
        const next = events[i+1];
        if (workers.length > 1 && next) {
          next.row = Math.max(...workers.map(w => w.row)) + 1;
          workers.forEach(w => link(w, next, 'join'));
          tail = next; i++;
        } else { tail = workers[workers.length - 1]!; }
      } else {
        node.row = tail.row + 1;
        link(tail, node, node.kind === 'orchestrator' ? 'review' : node.kind === 'evidence' ? 'evidence' : 'sequence');
        tail = node;
      }
    }
  }
  if (terminal) {
    const kind: GraphKind = run.status === 'DONE' ? 'done' : ['BLOCKED', 'NEEDS_HUMAN'].includes(run.status) ? 'human' : 'error';
    const lastAnswer = [...runMessages].reverse().find(m => m.author === 'orchestrator' && m.text !== 'Tarefa concluída e verificada.');
    const fullText = [run.summary, lastAnswer?.text].filter(Boolean).join('\n\n');
    const end = add({id: `end:${run.id}`, kind, status: run.status.toLowerCase(), label: run.status === 'NEEDS_HUMAN' ? 'Revisão humana' : run.status, summary: compactText(fullText), fullText, startedAt: run.finishedAt ?? run.startedAt, finishedAt: run.finishedAt, iteration: run.iterations, sourceIds: [run.id], metadata: detail.verifications});
    end.row = tail.row + 1; link(tail, end, 'sequence');
  }
  return { nodes, edges };
}

function safeJson(text: string | null | undefined): Record<string, any> | null { try {return text ? JSON.parse(text) : null;} catch {return null;} }
