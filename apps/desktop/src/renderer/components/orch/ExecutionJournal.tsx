import { Flag, ScrollText, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { chronologicalTrace } from '@shared/execution-trace';
import type { RunDetailView } from '@shared/ipc-contract';
import type { ExecutionNode } from '@shared/execution-graph';
import { heroState, questStatus, briefText } from '@shared/hero-identity';
import { HeroPortrait } from './HeroPortrait';

export function TraceCard({node,compact=false,onOpenRunDetail}:{node:ExecutionNode;compact?:boolean;onOpenRunDetail?:(runId:string)=>void}) {
  const [expanded,setExpanded]=useState(false);
  let snapshotRole:string|undefined;try{snapshotRole=JSON.parse(node.invocation?.agentSnapshot ?? '{}').role;}catch{}
  const role=snapshotRole ?? node.invocation?.role ?? (node.kind==='worker'?'CODING_WORKER':'ORCHESTRATOR');
  return <article className={`trace-card ${node.kind==='done'?'trace-final':''} ${compact?'trace-compact team-response':''}`} data-trace-id={node.id} data-source-ids={node.sourceIds.join(',')} data-status={node.status}>
    <header>{node.kind==='user'?<Flag size={24}/>:node.kind==='evidence'?<ScrollText size={24}/>:node.kind==='verification'?<ShieldCheck size={24}/>:<HeroPortrait role={role} state={heroState(node.status)} size={36}/>}<div><strong>{node.label}</strong><small>{questStatus(node.status)} · {new Date(node.finishedAt ?? node.startedAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</small></div></header>
    <p>{node.kind==='done' ? node.summary : briefText(node.summary, compact ? 170 : 280)}</p>
    <button type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'Recolher detalhes':'Ver completo'}</button>
    {node.kind==='done'&&onOpenRunDetail&&<button type="button" data-testid="trace-run-details" onClick={()=>onOpenRunDetail(node.runId)}>Registro da execução</button>}
    {expanded&&<div className="trace-expanded"><pre>{node.fullText}</pre>{!!node.metadata && <details><summary>Evidências e registros</summary><pre>{JSON.stringify(node.metadata,null,2)}</pre></details>}</div>}
  </article>;
}

export function ExecutionJournal({detail,onOpenRunDetail}:{detail:RunDetailView;onOpenRunDetail?:(runId:string)=>void}) {
  const nodes=chronologicalTrace(detail), bottom=useRef<HTMLDivElement>(null), follow=useRef(true);
  useEffect(()=>{follow.current=true;},[detail.run.id]);
  useEffect(()=>{if(follow.current)bottom.current?.scrollIntoView({block:'nearest'});},[detail.run.id,nodes.length]);
  return <section onScroll={event=>{const el=event.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<80;}} className="execution-journal" data-testid="execution-journal" aria-label="Raciocínio em linha · Diário da missão">
    <h2>Diário da missão</h2><p className="trace-description">O mesmo caminho do mapa: plano, equipe, evidências e resultado.</p>
    {nodes.map(node=><TraceCard key={node.id} node={node} onOpenRunDetail={onOpenRunDetail}/>)}<div ref={bottom}/>
  </section>;
}
