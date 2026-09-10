import type { ExecutionEvent } from '../../../../src/execution/events.js';
import type { RunDetailView } from './ipc-contract.js';
import type { ExecutionGraph, ExecutionNode, GraphKind } from './execution-graph.js';
import { isRunOver } from './activity.js';
import { HEROES, heroKey } from './hero-identity.js';

/** The single projection consumed by tree, chronological journal and Activity. */
export function executionTrace(detail: RunDetailView, journal = false): ExecutionGraph {
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
  for(const node of nodes) {
    if(terminal&&['running','started','pending'].includes(node.status)){node.status='stopped';node.finishedAt=detail.run.finishedAt;}
    const parents=edges.filter(e=>e.to===node.id).map(e=>nodes.find(n=>n.id===e.from)).filter((n):n is ExecutionNode=>!!n&&nodes.indexOf(n)<nodes.indexOf(node));
    node.row=parents.length?Math.max(...parents.map(n=>n.row))+1:node.kind==='user'?0:1;
  }
  // Parallel columns come only from common dependency parents, never from role.
  const occupied=new Map<number,number>();
  for(const node of nodes){const count=occupied.get(node.row)??0;occupied.set(node.row,count+1);node.lane=count+1;}
  const plan = events.find(e => e.type === 'PLAN_CREATED');
  const compact = plan?.data.complexityClass === 'TRIVIAL' && nodes.filter(n => n.kind === 'worker').length <= 1 &&
    !events.some(e => ['BLOCKED','NEEDS_HUMAN'].includes(e.type) || e.type === 'REVIEW_RESULT' && e.status === 'rejected');
  return compact ? compactMission({nodes,edges}, journal) : {nodes,edges};
}

/** Fold mechanical transitions into their result while retaining every source
 * event and full diagnostic payload. A short map is a small execution, not a
 * truncation of a large execution. No CSS/assets or RPG layout is changed. */
function compactMission(graph: ExecutionGraph, journal: boolean): ExecutionGraph {
  const user = graph.nodes.find(n => n.kind === 'user');
  const final = graph.nodes.find(n => n.kind === 'done');
  const worker = graph.nodes.find(n => n.kind === 'worker');
  const plan = graph.nodes.find(n => n.id.endsWith(':plan'));
  if (!user || !plan) return graph;
  const delegation = graph.nodes.find(n => n.label.startsWith('Orquestrador →'));
  if (delegation) {delegation.label='Orquestrador → Programador';delegation.summary='Crie o arquivo conforme a especificação.';}
  const proofs = graph.nodes.filter(n => n.kind === 'evidence' || n.kind === 'verification');
  const validation = proofs.at(-1);
  const merge = (target: ExecutionNode, sources: ExecutionNode[]) => {
    const all = [target, ...sources.filter(n => n !== target)];
    target.sourceIds = [...new Set(all.flatMap(n => n.sourceIds))];
    target.fullText = all.map(n => n.fullText).join('\n\n');
    target.metadata = {facts:all.map(n => n.metadata)};
  };
  const plannerCalls = graph.nodes.filter(n => n.kind === 'orchestrator' && n !== plan && n !== delegation);
  plan.invocation = plannerCalls.find(n => n.invocation)?.invocation;
  merge(plan, plannerCalls); plan.label = 'Orquestrador';
  if (worker) {
    worker.label = 'Programador';
    if (!journal && delegation) merge(worker,[delegation]);
  }
  if (validation) {
    const meta = validation.metadata as {fileChecks?: {passed:boolean;sizeBytes:number;request:{path:string};measurement?:{comparedExactBytes:boolean}}[]};
    const checks = meta?.fileChecks ?? [];
    validation.kind = 'verification'; validation.label = 'Validação';
    if (checks.length && checks.every(c => c.passed)) validation.summary = checks.map(c => `${c.measurement?.comparedExactBytes ? '✓ Conteúdo correto' : '✓ Arquivo verificado'} · ${c.request.path}\n✓ ${c.sizeBytes} bytes`).join('\n');
    merge(validation,proofs);
  }
  const nodes = [user,plan,...(journal && delegation ? [delegation] : []),...(worker ? [worker] : []),...(validation ? [validation] : []),...(final ? [final] : [])];
  const edges: ExecutionGraph['edges'] = [];
  nodes.forEach((n,i) => {n.row=i;n.lane=1;if(i)edges.push({id:nodes[i-1]!.id+'>'+n.id,from:nodes[i-1]!.id,to:n.id,kind:'sequence'});});
  return {nodes,edges};
}

export function chronologicalTrace(detail: RunDetailView): ExecutionNode[] {
  // SQLite sequence is authoritative; timestamps can tie or move backwards.
  return executionTrace(detail, true).nodes;
}

export function activityTrace(detail: RunDetailView): ExecutionNode[] {
  return chronologicalTrace(detail).filter(n=>!!n.invocation || n.kind==='done');
}
