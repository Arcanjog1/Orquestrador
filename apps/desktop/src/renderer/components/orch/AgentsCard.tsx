import {useEffect,useState} from 'react';
import {Plus,RefreshCw,Settings2,Search,ChevronRight,Bot,Sparkles,Lock} from 'lucide-react';
import {AGENT_ROLES,EFFORT_ORDER,roleDefinition,defaultAgentPolicy,type ModelCatalogEntry} from '@shared/agent-policy';
import {modelDisplayName,providerName,reasoningName,ROLE_NAMES,selectionProblem,agentReasoningLimit} from '@shared/model-display';
import {AgentPolicyFields} from './AgentPolicyFields';
import {ModelPoliciesCard} from './ModelPoliciesCard';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {api,messageOf} from '@/lib/api';
import type {AccountView,AgentInputView,ManagedAgentView} from '@shared/ipc-contract';
const selectClass='mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40';
const keyOf=(account:string,role:string)=>account+':'+role;
function inputOf(agent:ManagedAgentView):AgentInputView {
 return {name:agent.name,role:agent.role,provider:agent.provider,accountId:agent.accountId,model:agent.model,reasoning:agent.reasoning,maxCapability:agent.maxCapability,maxReasoning:agent.maxReasoning,enabled:agent.enabled,...(agent.policy?{policy:structuredClone(agent.policy)}:{})};
}
export function AgentsCard({accounts,onChanged}:{accounts:readonly AccountView[];onChanged:()=>void}) {
 const [page,setPage]=useState<'agents'|'policies'>('agents');
 const [agents,setAgents]=useState<readonly ManagedAgentView[]>([]);
 const [catalogs,setCatalogs]=useState<Record<string,ModelCatalogEntry[]>>({});
 const [revision,setRevision]=useState(0);
 const [draft,setDraft]=useState<AgentInputView|null>(null);
 const [editing,setEditing]=useState<string|null>(null);
 const [models,setModels]=useState<ModelCatalogEntry[]>([]);
 const [loadingModels,setLoadingModels]=useState(false);
 const [catalogNote,setCatalogNote]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [search,setSearch]=useState('');
 const [roleFilter,setRoleFilter]=useState('');
 const [providerFilter,setProviderFilter]=useState('');
 const [statusFilter,setStatusFilter]=useState('');
 const reload=()=>api.agents.manage().then(setAgents).catch(e=>setError(messageOf(e)));
 useEffect(()=>{void reload();},[accounts]);
 const identities=JSON.stringify([...new Set(agents.map(a=>keyOf(a.accountId,a.role)))]);
 useEffect(()=>{
  let active=true;setCatalogs({});
  for(const key of JSON.parse(identities) as string[]) {
   const [accountId,role]=key.split(':');
   void api.agents.models({accountId:accountId!,role:role!}).then(rows=>{if(active)setCatalogs(current=>({...current,[key]:rows}));}).catch(()=>{});
  }
  return()=>{active=false;};
 },[identities,accounts,revision]);
 useEffect(()=>{
  let active=true;setModels([]);setCatalogNote('');
  if(!draft?.accountId){setLoadingModels(false);return;}
  setLoadingModels(true);
  void api.agents.models({accountId:draft.accountId,role:draft.role}).then(rows=>{if(active){setModels(rows);setCatalogNote(rows.some(m=>m.source==='catalog')?'Catálogo conhecido. A disponibilidade será confirmada ao conectar o runtime.':rows.length?'':'Nenhum modelo informado nesta conexão. Conecte a conta e atualize os modelos.');}}).catch(e=>{if(active)setCatalogNote(messageOf(e));}).finally(()=>{if(active)setLoadingModels(false);});
  return()=>{active=false;};
 },[draft?.accountId,draft?.role,accounts,revision]);
 const create=()=>{setEditing(null);setError('');setDraft({name:'',provider:'anthropic',role:'CODING_WORKER',accountId:'',model:null,reasoning:null,maxCapability:null,maxReasoning:null,enabled:true,policy:defaultAgentPolicy('CODING_WORKER','')});};
 const edit=(a:ManagedAgentView)=>{setEditing(a.id);setError('');const input=inputOf(a);setDraft({...input,policy:input.policy??{...defaultAgentPolicy(a.role,a.model??''),reasoning:a.reasoning}});};
 const mutate=async(action:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await action();await reload();setRevision(r=>r+1);onChanged();return true;}catch(e){setError(messageOf(e));return false;}finally{setBusy(false);}};
 const policy=draft?.policy;
 const candidates=policy?(policy.modelMode==='FIXED'?[policy.primaryModel]:[policy.primaryModel,...policy.fallbackModels]):[];
 const reasoningLimit=agentReasoningLimit(policy?.reasoningCeiling??null,draft?.maxReasoning??null);
 const efforts=models.find(m=>m.id===policy?.primaryModel)?.reasoning.filter(r=>candidates.every(id=>models.find(m=>m.id===id)?.reasoning.includes(r))&&(!reasoningLimit||EFFORT_ORDER.indexOf(r as typeof EFFORT_ORDER[number])<=EFFORT_ORDER.indexOf(reasoningLimit as typeof EFFORT_ORDER[number])))??[];
 const invalidSelection=policy&&draft?selectionProblem(policy,models,draft.maxCapability,draft.maxReasoning):null;
 const canSave=!!draft?.name.trim()&&!!draft.accountId&&!!policy?.primaryModel&&policy.allowedModels.includes(policy.primaryModel)&&!loadingModels&&!invalidSelection;
 const save=async()=>{if(!draft||!canSave||busy)return;const value={...draft,model:policy!.primaryModel,reasoning:policy!.reasoning};if(await mutate(()=>editing?api.agents.update({agentId:editing,agent:value}):api.agents.create(value)))setDraft(null);};
 const toggleModel=(id:string)=>{
  if(!draft||!policy)return;
  const allowed=policy.allowedModels.includes(id)?policy.allowedModels.filter(m=>m!==id):[...policy.allowedModels,id];
  const primary=allowed.includes(policy.primaryModel)?policy.primaryModel:allowed[0]??'';
  setDraft({...draft,model:primary||null,reasoning:null,policy:{...policy,allowedModels:allowed,primaryModel:primary,reasoning:null,fallbackModels:policy.modelMode==='CONTROLLED_AUTO'?allowed.filter(m=>m!==primary):[],blockedModels:policy.blockedModels.filter(m=>!allowed.includes(m))}});
 };
 const statusOf=(a:ManagedAgentView)=>{
  if(!a.enabled)return {label:'Desativado',kind:'disabled',tone:'bg-muted text-muted-foreground',note:''};
  const account=accounts.find(c=>c.id===a.accountId);
  if(!account||account.state!=='connected')return {label:'Indisponível',kind:'unavailable',tone:'bg-amber-400/10 text-amber-500',note:'Conta desconectada'};
  if(roleDefinition(a.role)?.requiresImage)return {label:'Indisponível',kind:'unavailable',tone:'bg-amber-400/10 text-amber-500',note:'Nenhum runtime de imagem conectado'};
  const catalog=catalogs[keyOf(a.accountId,a.role)];const id=a.policy?.primaryModel??a.model;
  const model=catalog?.find(m=>m.id===id);
  if(id&&catalog&&!model)return {label:'Indisponível',kind:'unavailable',tone:'bg-amber-400/10 text-amber-500',note:'Modelo indisponível. Escolha outro modelo ao editar.'};
  if(model?.blockedReason)return {label:'Erro de configuração',kind:'error',tone:'bg-red-400/10 text-red-400',note:model.blockedReason};
  return {label:'Ativo',kind:'active',tone:'bg-emerald-400/10 text-emerald-500',note:model?.source==='catalog'?'Disponibilidade do modelo não confirmada':''};
 };
 const filtered=[...agents].sort((a,b)=>Number(!!b.policy)-Number(!!a.policy)||a.name.localeCompare(b.name)).filter(a=>(a.name+' '+(ROLE_NAMES[a.role]??a.role)+' '+(accounts.find(c=>c.id===a.accountId)?.name??'')).toLowerCase().includes(search.toLowerCase())&&(!roleFilter||a.role===roleFilter)&&(!providerFilter||a.provider===providerFilter)&&(!statusFilter||statusOf(a).kind===statusFilter));
 return <section className="mt-6 space-y-6" data-testid="agents-manager">
  <nav className="flex gap-1 border-b border-border pb-3" aria-label="Configurações de agentes"><Button variant={page==='agents'?'secondary':'ghost'} data-testid="agents-tab" onClick={()=>{setPage('agents');setRevision(r=>r+1);}}>Agentes</Button><Button variant={page==='policies'?'secondary':'ghost'} data-testid="agents-policies-tab" onClick={()=>setPage('policies')}><Settings2 className="size-4 mr-2"/>Política global</Button></nav>
  {page==='policies'?<ModelPoliciesCard/>:<>
   <div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-lg font-semibold">Sua equipe de agentes</h2><p className="mt-1 text-sm text-muted-foreground">Escolha quem participa, sua conta e os modelos que pode usar.</p></div><Button data-testid="agent-create" onClick={create}><Plus className="size-4 mr-2"/>Criar agente</Button></div>
   {agents.length>5&&<div className="flex flex-wrap gap-2" data-testid="agent-filters"><div className="relative min-w-48 flex-1"><Search className="absolute left-3 top-3 size-4 text-muted-foreground"/><Input aria-label="Buscar agentes" className="pl-9" placeholder="Buscar agentes" value={search} onChange={e=>setSearch(e.target.value)}/></div><select aria-label="Filtrar função" className={selectClass+' !mt-0 !w-auto'} value={roleFilter} onChange={e=>setRoleFilter(e.target.value)}><option value="">Todas as funções</option>{[...new Set(agents.map(a=>a.role))].map(role=><option key={role} value={role}>{ROLE_NAMES[role]}</option>)}</select><select aria-label="Filtrar provedor" className={selectClass+' !mt-0 !w-auto'} value={providerFilter} onChange={e=>setProviderFilter(e.target.value)}><option value="">Todos os provedores</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select><select aria-label="Filtrar status" className={selectClass+' !mt-0 !w-auto'} value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="">Todos os status</option><option value="active">Ativo</option><option value="disabled">Desativado</option><option value="unavailable">Indisponível</option><option value="error">Erro de configuração</option></select></div>}
   {error&&!draft&&<p role="alert" className="text-sm text-destructive">{error}</p>}
   <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3" data-testid="agent-card-grid">{filtered.map(a=>{
    const state=statusOf(a);const catalog=catalogs[keyOf(a.accountId,a.role)];const allowed=a.policy?.allowedModels??(a.model?[a.model]:[]);const primary=a.policy?.primaryModel??a.model;
    const label=(id:string)=>catalog?.find(m=>m.id===id)?.displayName??modelDisplayName(a.provider,id);
    return <article key={a.id} data-testid={`agent-card-${a.id}`} className="flex min-w-0 flex-col rounded-2xl border border-border bg-card p-5 shadow-sm transition-colors hover:border-primary/30">
     <div className="flex items-start justify-between gap-3"><div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-label={providerName(a.provider)}>{a.provider==='anthropic'?<Sparkles className="size-5"/>:<Bot className="size-5"/>}</div><span className={'rounded-full px-2.5 py-1 text-xs font-medium '+state.tone}>● {state.label}</span></div>
     <h3 className="mt-2 break-words text-base font-semibold">{a.name}</h3><span className="mt-1 w-fit rounded-md bg-secondary px-2 py-1 text-xs text-secondary-foreground">{ROLE_NAMES[a.role]??a.role}</span>
     <p className="mt-3 text-sm text-muted-foreground">{providerName(a.provider)} · {accounts.find(c=>c.id===a.accountId)?.name??'Conta removida'}</p>
     <p className="mt-3 text-xs font-medium text-muted-foreground">Modelos permitidos</p><div className="mt-2 flex flex-wrap gap-1.5">{allowed.length?allowed.map(id=><span key={id} className="rounded-md border border-border px-2 py-1 text-xs">{label(id)}</span>):<span className="text-sm text-muted-foreground">Definido na conexão</span>}</div>
     <dl className="mt-3 space-y-1 text-sm"><div className="flex justify-between gap-2"><dt className="text-muted-foreground">{a.policy?.modelMode==='CONTROLLED_AUTO'?'Principal':a.policy?'Modelo fixo':'Modelo'}</dt><dd className="min-w-0 break-words text-right">{primary?label(primary):'Definido na conexão'}</dd></div><div className="flex justify-between gap-2"><dt className="text-muted-foreground">Raciocínio</dt><dd>{reasoningName(a.policy?.reasoning??a.reasoning)}</dd></div><div className="flex justify-between gap-2"><dt className="text-muted-foreground">Modo</dt><dd>{a.policy?.modelMode==='CONTROLLED_AUTO'?'Automático':a.policy?'Fixo':'Definido no projeto'}</dd></div></dl>
     {state.note&&<p className="mt-3 text-xs text-amber-500" role="status">{state.note}</p>}
     <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3"><Button variant="ghost" size="sm" disabled={busy} data-testid={`agent-toggle-${a.id}`} onClick={()=>void mutate(()=>api.agents.update({agentId:a.id,agent:{...inputOf(a),enabled:!a.enabled}}))}>{a.enabled?'Desativar':'Ativar'}</Button><Button variant="secondary" size="sm" disabled={busy} data-testid={`agent-edit-${a.id}`} onClick={()=>edit(a)}>Editar<ChevronRight className="ml-1 size-4"/></Button></div>
    </article>;
   })}</div>
   {!agents.length&&<div className="rounded-2xl border border-dashed p-10 text-center text-muted-foreground"><Bot className="mx-auto mb-3 size-8"/><p>Crie seu primeiro agente para montar a equipe.</p></div>}
  </>}
  <Dialog open={!!draft} onOpenChange={open=>{if(!open&&!busy)setDraft(null);}}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{editing?'Editar agente':'Criar agente'}</DialogTitle><DialogDescription>Uma função, uma conta e os modelos escolhidos por você.</DialogDescription></DialogHeader>
   {draft&&policy&&<form className="space-y-6" onSubmit={e=>{e.preventDefault();void save();}}>
    <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2"><legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Identidade</legend><label className="text-sm">Nome do agente<Input autoFocus required data-testid="agent-name" className="mt-1" placeholder="Ex.: Claude Designer" value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label><label className="text-sm">Função<select data-testid="agent-role" className={selectClass} value={draft.role} onChange={e=>{const role=e.target.value,defaults=defaultAgentPolicy(role,policy.primaryModel);setDraft({...draft,role,policy:{...policy,tools:defaults.tools,permissions:defaults.permissions,taskKinds:defaults.taskKinds}});}}>{AGENT_ROLES.filter(r=>!['PROGRAMMER','REVIEWER'].includes(r.id)||draft.role===r.id).map(r=><option key={r.id} value={r.id}>{ROLE_NAMES[r.id]}</option>)}</select></label></fieldset>
    <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2"><legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Conexão</legend><label className="text-sm">Provedor<select data-testid="agent-provider" className={selectClass} value={draft.provider} onChange={e=>setDraft({...draft,provider:e.target.value as AgentInputView['provider'],accountId:'',model:null,reasoning:null,policy:defaultAgentPolicy(draft.role,'')})}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label><label className="text-sm">Conta<select required data-testid="agent-account" className={selectClass} value={draft.accountId} onChange={e=>setDraft({...draft,accountId:e.target.value,model:null,reasoning:null,policy:{...policy,primaryModel:'',allowedModels:[],blockedModels:[],fallbackModels:[],reasoning:null}})}><option value="">Escolha uma conta</option>{accounts.filter(a=>a.provider===draft.provider).map(a=><option key={a.id} value={a.id}>{a.name}{a.state==='connected'?'':' · Desconectada'}</option>)}</select></label></fieldset>
    <fieldset className="space-y-4"><legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Modelo</legend>
     <div className="flex items-center justify-between gap-2"><span className="text-sm">Modelos permitidos</span><Button type="button" variant="ghost" size="sm" disabled={!draft.accountId||loadingModels} data-testid="agent-model-refresh" onClick={()=>setRevision(r=>r+1)}><RefreshCw className={'mr-1 size-3.5 '+(loadingModels?'animate-spin':'')}/>Atualizar modelos</Button></div>
     {!draft.accountId?<p className="text-sm text-muted-foreground">Selecione uma conta para ver seus modelos.</p>:loadingModels?<p role="status" className="text-sm text-muted-foreground">Buscando modelos desta conta…</p>:<div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="agent-model-options">{[...models,...policy.allowedModels.filter(id=>!models.some(m=>m.id===id)).map(id=>({id,provider:draft.provider,source:'catalog' as const,reasoning:[],accountAllowed:false,displayName:modelDisplayName(draft.provider,id),blockedReason:'Modelo indisponível nesta conta.'}))].map(m=><label key={m.id} className={'flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm '+(policy.allowedModels.includes(m.id)?'border-primary/60 bg-primary/5':'border-border')+(m.blockedReason?' opacity-70':'')} title={m.blockedReason??undefined}><input type="checkbox" className="mt-1 accent-primary" data-testid={`agent-allow-${m.id}`} checked={policy.allowedModels.includes(m.id)} disabled={!!m.blockedReason&&!policy.allowedModels.includes(m.id)} onChange={()=>toggleModel(m.id)}/><span className="min-w-0"><span className="flex items-center gap-1 font-medium">{m.blockedReason&&<Lock className="size-3"/>}{m.displayName??modelDisplayName(m.provider,m.id)}{'premium' in m&&m.premium&&<span className="text-[10px] text-amber-500">Premium</span>}</span>{m.blockedReason&&<span className="mt-1 block text-xs">{m.blockedReason}</span>}</span></label>)}</div>}
     {catalogNote&&<p role="status" className="text-xs text-muted-foreground">{catalogNote}</p>}
     <label className="block text-sm">Modelo principal<select data-testid="agent-model" className={selectClass} required value={policy.primaryModel} onChange={e=>setDraft({...draft,model:e.target.value,reasoning:null,policy:{...policy,primaryModel:e.target.value,reasoning:null,fallbackModels:policy.modelMode==='CONTROLLED_AUTO'?policy.allowedModels.filter(m=>m!==e.target.value):[]}})}><option value="">Selecione os modelos acima</option>{policy.allowedModels.map(id=><option key={id} value={id} disabled={!models.some(m=>m.id===id&&!m.blockedReason)}>{models.find(m=>m.id===id)?.displayName??modelDisplayName(draft.provider,id)}</option>)}</select></label>
     <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Modo de modelo">{(['FIXED','CONTROLLED_AUTO'] as const).map(mode=><label key={mode} className={'cursor-pointer rounded-xl border p-3 text-sm '+(policy.modelMode===mode?'border-primary bg-primary/5':'border-border')}><input type="radio" className="mr-2 accent-primary" name="model-mode" data-testid={`agent-mode-${mode}`} checked={policy.modelMode===mode} onChange={()=>setDraft({...draft,policy:{...policy,modelMode:mode,fallbackModels:mode==='CONTROLLED_AUTO'?policy.allowedModels.filter(m=>m!==policy.primaryModel):[],reasoning:null},reasoning:null})}/>{mode==='FIXED'?'Modelo fixo':'Automático entre permitidos'}</label>)}</div>
     <p className="text-xs text-muted-foreground">{policy.modelMode==='FIXED'?'Sempre usa o modelo principal. Se indisponível, a execução para.':'Começa pelo principal e pode usar os alternativos permitidos abaixo.'}</p>
     {policy.modelMode==='CONTROLLED_AUTO'&&<label className="block text-sm">Modelo de fallback<select className={selectClass} data-testid="agent-fallback" value={policy.fallbackModels.length>1?'all':policy.fallbackModels[0]??''} onChange={e=>setDraft({...draft,reasoning:null,policy:{...policy,reasoning:null,fallbackModels:e.target.value==='all'?policy.allowedModels.filter(m=>m!==policy.primaryModel):e.target.value?[e.target.value]:[]}})}><option value="">Sem fallback</option>{policy.allowedModels.filter(id=>id!==policy.primaryModel).length>1&&<option value="all">Todos os alternativos selecionados, na ordem</option>}{policy.allowedModels.filter(id=>id!==policy.primaryModel).map(id=><option key={id} value={id}>{models.find(m=>m.id===id)?.displayName??modelDisplayName(draft.provider,id)}</option>)}</select></label>}
     <label className="block text-sm">Raciocínio<select data-testid="agent-reasoning" className={selectClass} value={policy.reasoning??''} onChange={e=>setDraft({...draft,reasoning:e.target.value||null,policy:{...policy,reasoning:e.target.value||null}})}><option value="">Automático</option>{efforts.map(r=><option key={r} value={r}>{reasoningName(r)}</option>)}</select></label>
     {invalidSelection&&<p role="alert" className="text-sm text-amber-500">{invalidSelection}</p>}
    </fieldset>
    <details className="rounded-xl border border-border p-4" data-testid="agent-advanced"><summary className="cursor-pointer text-sm font-medium">Configurações avançadas</summary><div className="mt-4 space-y-4"><AgentPolicyFields role={draft.role} value={policy} onChange={next=>setDraft({...draft,policy:next})}/><div className="grid grid-cols-2 gap-3"><label className="text-sm">Modelo máximo permitido<select data-testid="agent-maxCapability" className={selectClass} value={draft.maxCapability??''} onChange={e=>setDraft({...draft,maxCapability:e.target.value as AgentInputView['maxCapability']||null})}><option value="">Usar limites da conta</option>{[['FAST','Rápido'],['BALANCED','Equilibrado'],['STRONG','Avançado'],['MAX','Máximo']].map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label className="text-sm">Raciocínio máximo<select data-testid="agent-maxReasoning" className={selectClass} value={reasoningLimit??''} onChange={e=>setDraft({...draft,maxReasoning:null,policy:{...policy,reasoningCeiling:e.target.value||null}})}><option value="">Usar limites da conta</option>{EFFORT_ORDER.map(id=><option key={id} value={id}>{reasoningName(id)}</option>)}</select></label></div>{editing&&<><p className="text-xs text-muted-foreground">Identificador para diagnóstico: {editing}</p><Button type="button" variant="ghost" data-testid={`agent-remove-${editing}`} disabled={busy} onClick={()=>void mutate(()=>api.agents.remove({agentId:editing})).then(ok=>{if(ok)setDraft(null);})}>Remover agente</Button></>}</div></details>
    {roleDefinition(draft.role)?.requiresImage&&<p role="status" className="text-sm text-amber-500">Indisponível: nenhum runtime de imagem conectado.</p>}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="agent-enabled" checked={draft.enabled} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/>Agente ativo</label>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex justify-end gap-2 border-t pt-4"><Button type="button" variant="ghost" disabled={busy} onClick={()=>setDraft(null)}>Cancelar</Button><Button type="submit" data-testid="agent-save" disabled={busy||!canSave}>{busy?'Salvando…':editing?'Salvar alterações':'Criar agente'}</Button></div>
   </form>}
  </DialogContent></Dialog>
 </section>;
}
