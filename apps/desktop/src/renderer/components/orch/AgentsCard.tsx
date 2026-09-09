import {AGENT_ROLES,roleDefinition,defaultAgentPolicy,type ModelCatalogEntry} from '@shared/agent-policy';
import {AgentPolicyFields} from './AgentPolicyFields';
import {ModelPoliciesCard} from './ModelPoliciesCard';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {api,messageOf} from '@/lib/api';
import {ACCOUNT_CAPABILITY_TIERS,ACCOUNT_REASONING_TIERS,REASONING_LEVELS} from '@shared/ipc-contract';
import type {AccountView,AgentInputView,ManagedAgentView} from '@shared/ipc-contract';

export function AgentsCard({accounts,onChanged}:{accounts:readonly AccountView[];onChanged:()=>void}) {
 const [models,setModels]=useState<ModelCatalogEntry[]>([]);
 const [catalogRevision,setCatalogRevision]=useState(0);
 const [catalogNote,setCatalogNote]=useState('');
 const [agents,setAgents]=useState<readonly ManagedAgentView[]>([]);
 const [draft,setDraft]=useState<AgentInputView|null>(null);
 const [editing,setEditing]=useState<string|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState<string|null>(null);
 useEffect(()=>{let active=true;setModels([]);if(draft?.accountId)void api.agents.models({accountId:draft.accountId}).then(rows=>{if(active){setModels(rows);setCatalogNote(rows.length?'Modelos declarados pelo runtime/provedor. A disponibilidade na conta será validada na chamada.':'Catálogo não informado pelo runtime. Informe um ID explícito.');}}).catch(e=>{if(active)setCatalogNote(messageOf(e));});return ()=>{active=false;};},[draft?.accountId,catalogRevision]);
 const reload=()=>api.agents.manage().then(setAgents).catch(e=>setError(messageOf(e)));
 useEffect(()=>{void reload();},[accounts]);
 const create=()=>{setEditing(null);setError(null);setDraft({name:'',provider:'anthropic',role:'CODING_WORKER',accountId:accounts.find(a=>a.provider==='anthropic')?.id??'',model:null,reasoning:null,maxCapability:null,maxReasoning:null,enabled:true});};
 const save=async()=>{if(!draft || busy)return;setBusy(true);setError(null);try{if(editing)await api.agents.update({agentId:editing,agent:draft});else await api.agents.create(draft);await reload();setDraft(null);onChanged();}catch(e){setError(messageOf(e));}finally{setBusy(false);}};
 const remove=async(id:string)=>{setBusy(true);setError(null);try{await api.agents.remove({agentId:id});await reload();onChanged();}catch(e){setError(messageOf(e));}finally{setBusy(false);}};
 return <section className="space-y-4" data-testid="agents-manager">
  <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Agentes e modelos</h2><Button data-testid="agent-create" onClick={create}>Criar agente</Button></div>
  <p className="text-sm text-muted-foreground">A conta fornece o acesso. Cada agente tem nome, papel e configuração próprios. O menor teto entre agente e conta vale em todas as chamadas.</p>
  {error && !draft && <p role="alert" className="text-destructive">{error}</p>}
  {agents.map(a=><div key={a.id} data-testid={`agent-card-${a.id}`} className="rounded-lg border border-border p-4 flex items-center gap-3">
   <div className="flex-1"><strong>{a.name}</strong><p className="text-xs text-muted-foreground">{roleDefinition(a.role)?.label??a.role} · {accounts.find(c=>c.id===a.accountId)?.name??'Conta removida'} · {a.availability??(a.enabled?'ACTIVE':'DISABLED')}</p><p className="text-xs">{a.policy?.modelMode??'Legado'} · {a.policy?.primaryModel??a.model??'Automático'} / {a.policy?.reasoning??a.reasoning??'Automático'} · Teto {a.maxCapability??'da conta'} / {a.maxReasoning??'da conta'}</p><p className="text-xs text-muted-foreground">{a.id}</p></div>
   <Button variant="secondary" disabled={busy} data-testid={`agent-edit-${a.id}`} onClick={()=>{setEditing(a.id);const {id,runtimeId,availability,unavailableReason,...input}=a;setDraft(input);setError(null);}}>Editar</Button>
   <Button variant="ghost" disabled={busy} data-testid={`agent-remove-${a.id}`} onClick={()=>void remove(a.id)}>Remover</Button>
  </div>)}
  <Dialog open={draft!==null} onOpenChange={open=>{if(!open&&!busy)setDraft(null);}}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{editing?'Editar agente':'Criar agente'}</DialogTitle><DialogDescription>O histórico permanece após remover. Contas desconectadas podem ser configuradas; conecte antes de executar.</DialogDescription></DialogHeader>
   {draft&&<form className="space-y-3" onSubmit={e=>{e.preventDefault();void save();}}>
    <label className="block text-sm">Nome<Input autoFocus required data-testid="agent-name" value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
    <label className="block text-sm">Função<select aria-label="Papel" data-testid="agent-role" className="block w-full rounded border bg-surface p-2" value={draft.role} onChange={e=>setDraft({...draft,role:e.target.value,...(draft.policy?{policy:defaultAgentPolicy(e.target.value,draft.policy.primaryModel)}:{})})}>{AGENT_ROLES.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
    <label className="block text-sm">Provedor<select aria-label="Provedor" data-testid="agent-provider" className="block w-full rounded border bg-surface p-2" value={draft.provider} onChange={e=>{const provider=e.target.value as AgentInputView['provider'];setDraft({...draft,provider,accountId:accounts.find(a=>a.provider===provider)?.id??'',model:null,policy:undefined});}}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label>
    {roleDefinition(draft.role)?.requiresImage&&<p role="status">Indisponível: nenhum runtime de imagem conectado.</p>}
    <label className="block text-sm">Conta<select required aria-label="Conta do agente" data-testid="agent-account" className="block w-full rounded border bg-surface p-2" value={draft.accountId} onChange={e=>setDraft({...draft,accountId:e.target.value})}><option value="">Escolha uma conta</option>{accounts.filter(a=>a.provider===draft.provider).map(a=><option key={a.id} value={a.id}>{a.name} · {a.state==='connected'?'Conectada':'Não conectada'}</option>)}</select></label>
    <label className="block text-sm">Modelo principal<Input list="agent-model-catalog" data-testid="agent-model" value={draft.policy?.primaryModel??draft.model??''} onChange={e=>{const model=e.target.value;const policy=draft.policy??defaultAgentPolicy(draft.role,model);setDraft({...draft,model:model||null,policy:{...policy,primaryModel:model,allowedModels:policy.modelMode==='FIXED'?(model?[model]:[]):[...new Set([...policy.allowedModels,model])].filter(Boolean)}});}} placeholder="ID do modelo ou alias do runtime"/><datalist id="agent-model-catalog">{models.map(m=><option key={m.id} value={m.id}/>)}</datalist></label>
    <p className="text-xs text-muted-foreground">{catalogNote}</p><Button type="button" variant="ghost" onClick={()=>setCatalogRevision(r=>r+1)}>Atualizar catálogo do runtime</Button>
    {draft.policy&&<AgentPolicyFields reasoningOptions={models.find(m=>m.id===draft.policy?.primaryModel)?.reasoning??[]} role={draft.role} value={draft.policy} onChange={policy=>setDraft({...draft,policy})}/>}
    <div className="grid grid-cols-3 gap-3">{(['reasoning','maxCapability','maxReasoning'] as const).map(key=><label key={key} className="text-xs">{key==='reasoning'?'Raciocínio':key==='maxCapability'?'Teto de modelo':'Teto de raciocínio'}<select aria-label={key} data-testid={`agent-${key}`} className="block w-full rounded border bg-surface p-2" value={draft[key]??''} onChange={e=>setDraft({...draft,[key]:e.target.value||null})}><option value="">Automático</option>{(key==='reasoning'?REASONING_LEVELS:key==='maxCapability'?ACCOUNT_CAPABILITY_TIERS:ACCOUNT_REASONING_TIERS).map(v=><option key={v}>{v}</option>)}</select></label>)}</div>
    <label className="flex gap-2 text-sm"><input data-testid="agent-enabled" type="checkbox" checked={draft.enabled} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/>Agente ativo</label>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button type="submit" data-testid="agent-save" disabled={busy||!draft.name.trim()||!draft.accountId}>{busy?'Salvando…':'Salvar'}</Button>
   </form>}
  </DialogContent></Dialog>
  <ModelPoliciesCard/>
 </section>;
}
