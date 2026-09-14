import type { ExecutionEvent } from '../../../../src/execution/events.js';
import type { RunDetailView } from './ipc-contract.js';
import type { ExecutionGraph, ExecutionNode, GraphKind } from './execution-graph.js';
import { isRunOver } from './activity.js';
import { HEROES, heroKey } from './hero-identity.js';

/** The single projection consumed by tree, chronological journal and Activity. */
export function executionTrace(detail: RunDetailView): ExecutionGraph {
  const events=detail.executionEvents ?? [], nodes:ExecutionNode[]=[], edges:ExecutionGraph['edges']=[];
  const bySource=new Map<string,ExecutionNode>(), byInvocation=new Map<string,ExecutionNode>();
  const terminal=isRunOver(detail.run.status);
  const kindOf=(e:ExecutionEvent):GraphKind=>e.type==='USER_OBJECTIVE'?'user':e.type==='FINAL_RESPONSE'?'done':
    ['NEEDS_HUMAN','BLOCKED'].includes(e.type)?'human':e.type==='EVIDENCE_CREATED'?'evidence':
    e.type==='REVIEW_RESULT'?'verification':e.type==='AGENT_STARTED'&&e.role!=='ORCHESTRATOR'?'worker':'orchestrator';
  for(const event of events) {
    if(event.type==='AGENT_SELECTED') continue;
    if(event.type==='AGENT_PROGRESS'||event.type==='AGENT_RESULT') {
      const node=event.invocationId ? byInvocation.get(event.invocationId) : undefined;
      if(node) {
        node.sourceIds.push(event.id); bySource.set(event.id,node);
        node.summary=event.summary;
        node.fullText=String(event.data.fullOutput ?? event.summary);
        node.metadata=event.data;
        if(event.type==='AGENT_RESULT') {
          node.status=event.status;node.finishedAt=event.timestamp;
          // Place the result where it returned, not where its parallel call started.
          nodes.splice(nodes.indexOf(node),1);nodes.push(node);
        }
        continue;
      }
    }
    const kind=kindOf(event), hero=HEROES[heroKey(event.role) ?? 'orchestrator'];
    const invocation=event.type==='AGENT_STARTED'?detail.invocations.find(i=>i.id===event.invocationId):undefined;
    const node:ExecutionNode={id:event.type==='USER_OBJECTIVE'?`run:${event.runId}`:event.type==='FINAL_RESPONSE'?`end:${event.runId}`:event.type==='AGENT_STARTED'?`inv:${event.invocationId}`:event.id,
      runId:event.runId,kind,status:event.status,label:event.type==='USER_OBJECTIVE'?'Você':event.type==='PLAN_CREATED'?'Plano da missão':event.type==='DELEGATION_STARTED'?`Orquestrador → ${event.data.agentName ?? hero.role}`:event.type==='FINAL_RESPONSE'?'Orquestrador · resposta final':event.type==='EVIDENCE_CREATED'?'Evidência':event.type==='REVIEW_RESULT'?'Revisão · DoneGate':String(event.data.agentName ?? hero.role),
      summary:event.summary,fullText:String(event.data.fullOutput ?? (event.type==='PLAN_CREATED'?JSON.stringify(event.data,null,2):event.summary)),
      startedAt:event.timestamp,finishedAt:event.status==='running'?null:event.timestamp,iteration:event.iteration,
      sourceIds:[event.id],metadata:event.data,lane:0,row:nodes.length,
      ...(invocation?{invocation:{...invocation,role:event.role}}:{}),
      ...(typeof event.data.taskId==='string'?{taskId:event.data.taskId}:{}),
    };
    nodes.push(node);bySource.set(event.id,node);
    if(event.type==='AGENT_STARTED'&&event.invocationId)byInvocation.set(event.invocationId,node);
  }
  for(const event of events) {
    const to=bySource.get(event.id), from=event.parentId?bySource.get(event.parentId):undefined;
    if(from && to && from!==to&&!edges.some(e=>e.from===from.id&&e.to===to.id))edges.push({id:`${from.id}>${to.id}`,from:from.id,to:to.id,kind:event.type==='DELEGATION_STARTED'?'delegation':event.type==='REVIEW_RESULT'?'review':'sequence'});
  }
  for(const event of events.filter(e=>e.type==='DELEGATION_STARTED')) {
    const target=bySource.get(event.id);
    for(const task of (event.data.dependsOn ?? []) as string[]) {
      const source=nodes.find(n=>n.kind==='worker'&&n.taskId===task);
      if(source&&target&&!edges.some(e=>e.from===source.id&&e.to===target.id))edges.push({id:source.id+'>'+target.id,from:source.id,to:target.id,kind:'dependency'});
    }
  }
  // Reviews join their wave; the final answer consolidates all completed branches,
  // including work performed in earlier iterations than the final review.
  for(const node of nodes.filter(n=>n.kind==='verification'||n.kind==='done')) {
    for(const worker of nodes.filter(n=>n.kind==='worker'&&(node.kind==='done'||n.iteration===node.iteration)&&n.finishedAt&&nodes.indexOf(n)<nodes.indexOf(node))) {
      const existing=edges.find(e=>e.from===worker.id&&e.to===node.id);
      if(existing)existing.kind='join';
      else edges.push({id:`${worker.id}>${node.id}`,from:worker.id,to:node.id,kind:'join'});
    }
  }
  for (const node of nodes) {
    if (terminal && ['running','started','pending'].includes(node.status)) {
      node.status = 'stopped'; node.finishedAt = detail.run.finishedAt;
    }
  }
  return foldMission({nodes, edges}, events);
}

/** Fold coordination into its milestone without losing source records.
 * All views use identical nodes, summaries, full text and source IDs. */
function foldMission(graph: ExecutionGraph, events: readonly ExecutionEvent[]): ExecutionGraph {
  const owner = new Map(graph.nodes.map(n => [n.id, n]));
  const eventById = new Map(events.map(event => [event.id, event]));
  const merged = new Set<string>();
  function merge(target: ExecutionNode, source: ExecutionNode) {
    if (target === source || merged.has(source.id)) return;
    target.sourceIds = [...new Set([...target.sourceIds, ...source.sourceIds])];
    target.fullText += '\n\n' + source.label + ':\n' + source.fullText;
    const previous = target.metadata as Record<string, unknown> | undefined;
    target.metadata = {...previous, records: [...(Array.isArray(previous?.records) ? previous.records : []),
      {id: source.id, label: source.label, summary: source.summary, invocation: source.invocation, data: source.metadata}]};
    if (!target.invocation && source.invocation) target.invocation = source.invocation;
    owner.set(source.id, target); merged.add(source.id);
  }
  for (const event of events.filter(e => e.type === 'DELEGATION_STARTED')) {
    const source = graph.nodes.find(n => n.sourceIds.includes(event.id));
    const worker = graph.nodes.find(n => n.id === `inv:${event.invocationId}`);
    if (source && worker) merge(worker, source);
  }
  const plan = graph.nodes.find(n => n.sourceIds.some(id => eventById.get(id)?.type === 'PLAN_CREATED'));
  if (plan) {
    for (const call of graph.nodes.filter(n => n.invocation?.role === 'ORCHESTRATOR' && graph.nodes.indexOf(n) < graph.nodes.indexOf(plan))) merge(plan, call);
  }
  for (const event of events.filter(e => e.type === 'REVIEW_REQUESTED')) {
    const source = graph.nodes.find(n => n.sourceIds.includes(event.id));
    // Contract toward the decision's direct parent, never past its workers:
    // contracting across intervening work would introduce a graph cycle.
    const parent = graph.nodes.find(n => n.sourceIds.includes(event.parentId ?? ''));
    if (source && parent) merge(owner.get(parent.id) ?? parent, source);
  }
  const trivial = events.find(e => e.type === 'PLAN_CREATED')?.data.complexityClass === 'TRIVIAL' &&
    graph.nodes.filter(n => n.kind === 'worker').length <= 1 &&
    !events.some(e => ['BLOCKED','NEEDS_HUMAN'].includes(e.type) || e.type === 'REVIEW_RESULT' && e.status === 'rejected');
  if (trivial) {
    const proofs = graph.nodes.filter(n => ['evidence','verification'].includes(n.kind));
    const validation = proofs.at(-1);
    if (validation) {
      validation.kind = 'verification'; validation.label = 'Validação';
      for (const proof of proofs) merge(validation, proof);
    }
  }
  const resolve = (id: string): ExecutionNode => {
    let node = owner.get(id)!;
    const seen = new Set<string>();
    while (owner.get(node.id) !== node && !seen.has(node.id)) { seen.add(node.id); node = owner.get(node.id)!; }
    return node;
  };
  const nodes = graph.nodes.filter(n => !merged.has(n.id));
  const edges: ExecutionGraph['edges'] = [];
  for (const edge of graph.edges) {
    const from = resolve(edge.from), to = resolve(edge.to);
    if (from !== to && !edges.some(e => e.from === from.id && e.to === to.id)) edges.push({...edge, id: from.id+'>'+to.id, from: from.id, to: to.id});
  }
  // Dependency order, independent of the order parallel calls return.
  const pending = new Set(nodes.map(n => n.id)), placed = new Map<string, ExecutionNode>();
  while (pending.size) {
    const ready = nodes.filter(n => pending.has(n.id) && edges.filter(e => e.to === n.id).every(e => !pending.has(e.from)));
    if (!ready.length) {
      // Corrupt historical relations must never hang the interface.
      for (const n of nodes.filter(n => pending.has(n.id))) { n.row = placed.size; placed.set(n.id,n); pending.delete(n.id); }
      break;
    }
    for (const n of ready) {
      const parents = edges.filter(e => e.to === n.id).map(e => placed.get(e.from)).filter((p): p is ExecutionNode => !!p);
      n.row = parents.length ? Math.max(...parents.map(p => p.row)) + 1 : 0;
      placed.set(n.id,n); pending.delete(n.id);
    }
  }
  const rows = new Map<number, ExecutionNode[]>();
  for (const n of nodes) rows.set(n.row,[...(rows.get(n.row) ?? []),n]);
  for (const row of rows.values()) row.forEach((n,i) => { n.lane = row.length === 1 ? 0 : i+1; });
  return {nodes, edges};
}

export function chronologicalTrace(detail: RunDetailView): ExecutionNode[] {
  // SQLite sequence is authoritative; timestamps can tie or move backwards.
  return executionTrace(detail).nodes;
}

export function activityTrace(detail: RunDetailView): ExecutionNode[] {
  return chronologicalTrace(detail).filter(n=>!!n.invocation || n.kind==='done');
}
