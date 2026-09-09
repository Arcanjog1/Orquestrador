import {useEffect,useState} from 'react';
import {api,messageOf} from '@/lib/api';
import type {IpcMap} from '@shared/ipc-contract';
import {Button} from '@/components/ui/button';
const display=(value:unknown)=>value===null||value===undefined?'Não informado':typeof value==='object'?JSON.stringify(value):String(value);
export function AgentCallDetails({runId,updatedAt,onConfirmed}:{runId:string;updatedAt?:string;onConfirmed?:()=>void}) {
 const [calls,setCalls]=useState<IpcMap['agents.calls']['response']>([]);const [error,setError]=useState('');
 useEffect(()=>{let active=true;void api.agents.calls({runId}).then(rows=>{if(active)setCalls(rows);}).catch(e=>{if(active)setError(messageOf(e));});return()=>{active=false;};},[runId,updatedAt]);
 if(!calls.length&&!error)return null;
 return <details className="border-t p-3 max-h-72 overflow-auto" data-testid="agent-call-details"><summary className="cursor-pointer text-sm font-medium">Agentes, modelos e políticas · {calls.length} registros</summary>
 {error&&<p role="alert">{error}</p>}{calls.map(call=>{const s=call.snapshot,o=call.observation;return <article key={call.id} className="border-t py-3 text-xs"><strong>{display(s.agentName)} · {display(s.role)} · {call.status}</strong><p>{display(s.provider)} · Conta {display(s.accountId)} · {call.started_at}</p><dl className="grid grid-cols-2 gap-1 mt-2">{Object.entries({Solicitado:s.requestedModel??s.requested,'Após tetos':{model:s.model,reasoning:s.reasoning},Enviado:o?.sent,Observado:o?.observed,'Tentativa':s.attempt,Fallback:s.fallbackReason,Ferramentas:s.tools,'Duração (ms)':o?.durationMs,Uso:o?.usage,Erro:o?.error}).map(([key,value])=><div key={key}><dt className="text-muted-foreground">{key}</dt><dd className="break-all">{display(value)}</dd></div>)}</dl>{call.status==='CONFIRMATION_REQUIRED'&&onConfirmed&&<Button className="mt-2" onClick={()=>{void api.agents.confirmModel({runId,agentId:String(s.agentId),model:String(s.model)}).then(onConfirmed).catch(e=>setError(messageOf(e)));}}>Confirmar {display(s.model)} nesta execução</Button>}</article>;})}</details>;
}
