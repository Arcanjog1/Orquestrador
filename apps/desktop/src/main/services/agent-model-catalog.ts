import {modelMatchesRule} from '../../shared/model-policy-match.js';
import {OFFICIAL_MODELS} from '../../shared/official-models.js';
import type {ModelCatalogEntry,PolicyConfiguration} from '../../shared/agent-policy.js';
import {EFFORT_ORDER} from '../../shared/agent-policy.js';
import {modelDisplayName} from '../../shared/model-display.js';
import {modelCapability} from '../../../../../src/routing/provider-policy.js';
import {isPremiumModel} from '../../../../../src/routing/account-policy.js';
export interface CatalogAccount {provider_id:string;max_capability:string|null;max_reasoning:string|null;allow_premium_models:number;}
/** Presentation is derived from the same restrictions; execution still resolves its policy at every call. */
export function decorateAgentModels(rows:ModelCatalogEntry[],account:CatalogAccount,config:PolicyConfiguration,role?:string):ModelCatalogEntry[] {
 const tiers=['FAST','BALANCED','STRONG','MAX'];
 return rows.filter(row=>row.provider===account.provider_id).map(row=>{
  const rules=config.models.filter(r=>r.provider===row.provider&&modelMatchesRule(row.provider,r.modelId,row.id));
  const premium=rules.some(r=>r.premium)||isPremiumModel(row.id);
  const has=(values:string[]|undefined)=>values?.some(v=>v.toLowerCase()===row.id.toLowerCase());
  let blockedReason:string|null=null;
  if(rules.some(r=>!r.allowed)||config.defaults.blockedModels?.some(id=>modelMatchesRule(row.provider,id,row.id))||(config.defaults.allowedModels&&!has(config.defaults.allowedModels)))blockedReason='Bloqueado pela política global.';
  else if(role&&rules.some(r=>r.allowedRoles.length&&!r.allowedRoles.includes(role)))blockedReason='Não permitido para esta função pela política global.';
  else if(premium&&account.allow_premium_models!==1)blockedReason='Modelos premium não estão habilitados nesta conta.';
  else if(row.accountAllowed===false)blockedReason='Não disponível nesta conta.';
  const tier=rules.find(r=>r.capability)?.capability??modelCapability(row.provider,row.id);
  if(!blockedReason&&[account.max_capability,config.defaults.maxCapability].some(c=>c&&(!tier||tiers.indexOf(tier)>tiers.indexOf(c))))blockedReason='Acima do modelo máximo permitido pela conta ou política global.';
  const ceilings=[config.defaults.reasoningCeiling,account.max_reasoning?({LOW:'low',MEDIUM:'medium',HIGH:'high',MAX:'ultra'} as Record<string,string>)[account.max_reasoning]:null].filter((x):x is string=>!!x);
  const reasoning=row.reasoning.filter(r=>ceilings.every(c=>EFFORT_ORDER.indexOf(r as typeof EFFORT_ORDER[number])<=EFFORT_ORDER.indexOf(c as typeof EFFORT_ORDER[number])));
  return {...row,displayName:modelDisplayName(row.provider,row.id,row.displayName),premium,blockedReason,reasoning,capability:tier};
 });
}
/** A labelled fallback, only when the runtime cannot enumerate. Never advertised as confirmed access. */
export function knownAgentModels(provider:'openai'|'anthropic',capabilities?:{effortFlag:boolean;modelEfforts?:Readonly<Record<string,readonly string[]>>}):ModelCatalogEntry[] {
 return OFFICIAL_MODELS[provider].map(model=>({id:model.id,provider,source:'catalog',displayName:model.name,reasoning:capabilities?.effortFlag?[...(capabilities.modelEfforts?.[model.id]??[])]:[],accountAllowed:null}));
}
