import {useEffect,useState} from 'react';
import {Input} from '@/components/ui/input';
import {EFFORT_ORDER,roleDefinition,type AgentPolicy,type PolicyLayer} from '@shared/agent-policy';
const split=(text:string)=>[...new Set(text.split(',').map(s=>s.trim()).filter(Boolean))];
export function AgentPolicyFields({value,role,onChange,reasoningOptions=[]}:{value:AgentPolicy;role:string;onChange:(value:AgentPolicy)=>void;reasoningOptions?:string[]}) {
 const update=(patch:Partial<AgentPolicy>)=>onChange({...value,...patch});
 return <fieldset className="space-y-3 border-t pt-3" data-testid="agent-policy-fields"><legend className="font-medium">Ferramentas e limites</legend>
  <div className="space-y-2"><p className="text-sm">Ferramentas e permissões</p>{roleDefinition(role)?.tools.map(tool=><label className="inline-flex gap-1 mr-3 text-xs" key={tool}><input type="checkbox" checked={value.tools.includes(tool)} onChange={e=>update({tools:e.target.checked?[...value.tools,tool]:value.tools.filter(t=>t!==tool),permissions:{...value.permissions,...(['write','commands','web'].includes(tool)?{[tool]:e.target.checked}:{})}})}/>{({read:'Leitura',diff:'Diff',evidence:'Evidências',write:'Escrita',commands:'Comandos',web:'Web',image:'Imagens'})[tool]}</label>)}</div>
  <div className="grid grid-cols-2 gap-3">{(['maxAttempts','timeoutMs','maxTokens','maxCostUsd'] as const).map(key=><label key={key} className="text-xs">{({maxAttempts:'Máximo de chamadas por execução',timeoutMs:'Timeout por chamada (ms)',maxTokens:'Limite de tokens',maxCostUsd:'Limite de custo (USD)'})[key]}<Input type="number" min={key==='timeoutMs'?1000:key==='maxCostUsd'?0.01:1} step={key==='maxCostUsd'?0.01:1} value={value[key]??''} onChange={e=>update({[key]:e.target.value?Number(e.target.value):null})}/></label>)}</div>
  <p className="text-xs text-muted-foreground">Limites de uso são verificados entre chamadas. Uma chamada pode ultrapassar o saldo; consumo não informado impede novas chamadas quando há limite.</p>
  <label className="flex gap-2 text-sm"><input type="checkbox" checked={value.parallel} onChange={e=>update({parallel:e.target.checked})}/>Permitir execução paralela</label>
  <div className="text-xs">Tipos de tarefa: {roleDefinition(role)?.taskKinds.map(kind=><label className="inline-flex gap-1 mr-3" key={kind}><input type="checkbox" checked={value.taskKinds.includes(kind)} onChange={e=>update({taskKinds:e.target.checked?[...value.taskKinds,kind]:value.taskKinds.filter(t=>t!==kind)})}/>{kind}</label>)}</div>
 </fieldset>;
}

export function PolicyLayerFields({value,onChange}:{value:PolicyLayer;onChange:(value:PolicyLayer)=>void}) {
 return <div className="grid grid-cols-2 gap-3">{(['allowedModels','blockedModels'] as const).map(key=><label className="text-xs" key={key}>{key==='allowedModels'?'Restringir aos modelos':'Bloquear modelos'}<ModelList value={value[key]??[]} onChange={models=>{const next={...value};if(models.length)next[key]=models;else delete next[key];onChange(next);}}/></label>)}
 <label className="text-xs">Teto de modelo<select className="block w-full rounded border bg-surface p-2" value={value.maxCapability??''} onChange={e=>onChange({...value,maxCapability:e.target.value as PolicyLayer['maxCapability']||null})}><option value="">Sem teto adicional</option>{['FAST','BALANCED','STRONG','MAX'].map(t=><option key={t}>{t}</option>)}</select></label>
 <label className="text-xs">Teto de raciocínio<select className="block w-full rounded border bg-surface p-2" value={value.reasoningCeiling??''} onChange={e=>onChange({...value,reasoningCeiling:e.target.value||null})}><option value="">Sem teto adicional</option>{EFFORT_ORDER.map(t=><option key={t}>{t}</option>)}</select></label>
 {(['maxAttempts','timeoutMs','maxTokens','maxCostUsd'] as const).map(key=><label key={key} className="text-xs">{({maxAttempts:"Máximo de chamadas",timeoutMs:"Timeout por chamada (ms)",maxTokens:"Limite de tokens",maxCostUsd:"Limite de custo (USD)"})[key]}<Input type="number" min={key==='timeoutMs'?1000:key==='maxCostUsd'?0.01:1} step={key==='maxCostUsd'?0.01:1} value={value[key]??''} onChange={e=>{const next={...value};if(e.target.value)next[key]=Number(e.target.value);else delete next[key];onChange(next);}}/></label>)}
 </div>;
}

function ModelList({value,onChange,disabled,testId}:{value:string[];onChange:(value:string[])=>void;disabled?:boolean;testId?:string}) {
 const [text,setText]=useState(value.join(', '));const serialized=JSON.stringify(value);
 useEffect(()=>{if(JSON.stringify(split(text))!==serialized)setText(value.join(', '));},[serialized]);
 return <Input data-testid={testId} disabled={disabled} value={text} placeholder="IDs separados por vírgula" onChange={e=>{setText(e.target.value);onChange(split(e.target.value));}}/>;
}
