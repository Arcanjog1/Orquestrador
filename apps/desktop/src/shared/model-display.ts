import {EFFORT_ORDER,type AgentPolicy,type ModelCatalogEntry} from './agent-policy.js';
/** Human labels live here; canonical IDs remain unchanged in persistence and adapters. */
export function modelDisplayName(provider:string,id:string,official?:string):string {
 if(official&&official!==id)return official;
 if(provider==='anthropic') {
  const alias=id.match(/^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d[\d.-]*))?$/i);
  if(alias)return alias[1]![0]!.toUpperCase()+alias[1]!.slice(1)+(alias[2]?' '+alias[2].replace(/-\d{8}$/,'').replaceAll('-','.'):'');
 }
 return id.replace(/^gpt-/i,'GPT-').replace(/codex/ig,'Codex').replace(/spark/ig,'Spark');
}
export const REASONING_NAMES:Record<string,string>={none:'Sem raciocínio adicional',minimal:'Mínimo',low:'Baixo',medium:'Médio',high:'Alto',xhigh:'Muito alto',max:'Máximo',ultra:'Ultra'};
export const reasoningName=(value:string|null|undefined)=>value?REASONING_NAMES[value]??value:'Automático';
export const providerName=(provider:string)=>provider==='anthropic'?'Anthropic':provider==='openai'?'OpenAI':provider;
export const ROLE_NAMES:Record<string,string>={ORCHESTRATOR:'Orquestrador',CODING_WORKER:'Programador / Worker',PROGRAMMER:'Programador / Worker',ANALYST:'Analista / Revisor',REVIEWER:'Analista / Revisor',DESIGNER:'Designer / Desenhista',TESTER:'Testador',RESEARCHER:'Pesquisador',IMAGE_GENERATOR:'Gerador de imagens'};

/** Same selection contract for the form and IPC saves. Labels are never trusted as IDs. */
export function selectionProblem(policy:AgentPolicy,models:ModelCatalogEntry[],maxCapability:string|null,maxReasoning:string|null):string|null {
 const tiers=['FAST','BALANCED','STRONG','MAX'];
 for(const id of policy.allowedModels) {
  const model=models.find(m=>m.id===id);
  if(!model)return 'Modelo indisponível nesta conta. Atualize os modelos.';
  if(model.blockedReason)return model.displayName+': '+model.blockedReason;
  if(maxCapability&&(!model.capability||tiers.indexOf(model.capability)>tiers.indexOf(maxCapability)))return 'O modelo está acima do máximo permitido para este agente.';
 }
 const candidates=policy.modelMode==='FIXED'?[policy.primaryModel]:[policy.primaryModel,...policy.fallbackModels];
 if(policy.reasoning&&candidates.some(id=>!models.find(m=>m.id===id)?.reasoning.includes(policy.reasoning!)))return 'Raciocínio incompatível com os modelos desta conta.';
 const ceilings=[policy.reasoningCeiling,maxReasoning?({LOW:'low',MEDIUM:'medium',HIGH:'high',MAX:'ultra'} as Record<string,string>)[maxReasoning]:null];
 if(policy.reasoning&&ceilings.some(c=>c&&EFFORT_ORDER.indexOf(policy.reasoning as typeof EFFORT_ORDER[number])>EFFORT_ORDER.indexOf(c as typeof EFFORT_ORDER[number])))return 'Raciocínio acima do máximo permitido para este agente.';
 return null;
}

export function agentReasoningLimit(policy:string|null,legacy:string|null):string|null {const values=[policy,legacy?({LOW:'low',MEDIUM:'medium',HIGH:'high',MAX:'ultra'} as Record<string,string>)[legacy]:null].filter((v):v is string=>!!v);return values.length?EFFORT_ORDER[Math.min(...values.map(v=>EFFORT_ORDER.indexOf(v as typeof EFFORT_ORDER[number])))]??null:null;}
