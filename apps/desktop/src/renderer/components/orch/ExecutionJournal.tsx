import { useEffect, useRef, useState } from 'react';
import { chronologicalTrace } from '@shared/execution-trace';
import type { RunDetailView } from '@shared/ipc-contract';
import type { ExecutionNode } from '@shared/execution-graph';
import { heroState, questStatus } from '@shared/hero-identity';
import { HeroPortrait } from './HeroPortrait';

export function TraceCard({node,compact=false,onOpenRunDetail}:{node:ExecutionNode;compact?:boolean;onOpenRunDetail?:(runId:string)=>void}) {
  const [expanded,setExpanded]=useState(false);
  let snapshotRole:string|undefined;try{snapshotRole=JSON.parse(node.invocation?.agentSnapshot ?? '{}').role;}catch{}
  const role=snapshotRole ?? node.invocation?.role ?? (node.kind==='worker'?'CODING_WORKER':'ORCHESTRATOR');
  return <article className={`trace-card ${node.kind==='done'?'trace-final':''} ${compact?'trace-compact':''}`} data-trace-id={node.id} data-source-ids={node.sourceIds.join(',')} data-status={node.status}>
    <header>{node.kind!=='user'&&<HeroPortrait role={role} state={heroState(node.status)} size={36}/>}<div><strong>{node.label}</strong><small>{questStatus(node.status)}</small></div></header>
    <p>{node.summary}</p>
    <button type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'Recolher detalhes':node.kind==='done'?'Ver relatório completo':'Ver resposta completa'}</button>
    {node.kind==='done'&&onOpenRunDetail&&<button type="button" data-testid="trace-run-details" onClick={()=>onOpenRunDetail(node.runId)}>Registro da execução</button>}
    {expanded&&<pre>{node.fullText}</pre>}
  </article>;
}

export function ExecutionJournal({detail,onOpenRunDetail}:{detail:RunDetailView;onOpenRunDetail?:(runId:string)=>void}) {
  const nodes=chronologicalTrace(detail), bottom=useRef<HTMLDivElement>(null);
  useEffect(()=>{bottom.current?.scrollIntoView({block:'nearest'});},[detail.run.id,nodes.length]);
  return <section className="execution-journal" data-testid="execution-journal" aria-label="Raciocínio em linha · Diário da missão">
    <h2>Diário da missão</h2><p className="trace-description">Plano, delegações, resultados e evidências da execução.</p>
    {nodes.map(node=><TraceCard key={node.id} node={node} onOpenRunDetail={onOpenRunDetail}/>)}<div ref={bottom}/>
  </section>;
}
