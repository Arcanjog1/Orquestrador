import {modelMatchesRule} from '../../shared/model-policy-match.js';
import { EFFORT_ORDER, roleDefinition, type AgentPolicy, type PolicyLayer, type ModelPolicy, type AgentTool } from '../../shared/agent-policy.js';
import { modelCapability, type WorkerRuntimeCapabilities } from '../../../../../src/routing/provider-policy.js';
import { isPremiumModel, type AccountRoutingPolicy } from '../../../../../src/routing/account-policy.js';

export class AgentPolicyError extends Error {
  constructor(readonly code:string, message:string,readonly modelId?:string) { super(message); this.name='AgentPolicyError'; }
}
const deny = (code:string,message:string):never => { throw new AgentPolicyError(code,message); };
const efforts:readonly string[] = EFFORT_ORDER;
const tiers = ['FAST','BALANCED','STRONG','MAX'];
const key=(model:string)=>model.trim().toLowerCase();
const contains=(models:readonly string[],model:string)=>models.some(m=>key(m)===key(model));
export interface PolicyResolutionInput {
  role:string; provider:'openai'|'anthropic'; policy:AgentPolicy;
  layers:PolicyLayer[]; models:ModelPolicy[]; account:AccountRoutingPolicy;
  capabilities:WorkerRuntimeCapabilities; requested:{model:string|null;reasoning:string|null};
  unavailable?:readonly string[]; confirmation?:(model:string)=>boolean;
}
export function validateAgentPolicy(policy:AgentPolicy, role:string): void {
  if (!policy || policy.version!==1 || !['FIXED','CONTROLLED_AUTO'].includes(policy.modelMode)) deny('INVALID_POLICY','Modo de modelo inválido.');
  const definition = roleDefinition(role);
  if (!definition) deny('ROLE','Função desconhecida.');
  for (const key of ['allowedModels','blockedModels','fallbackModels'] as const) {
    if (!Array.isArray(policy[key]) || policy[key].length>200 || policy[key].some(m=>typeof m!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/.test(m))) deny('INVALID_POLICY','Lista de modelos inválida.');
  }
  if (typeof policy.primaryModel!=='string'||!policy.primaryModel.trim()||policy.primaryModel.length>200) deny('INVALID_POLICY','Escolha um modelo principal explícito.');
  if (!policy.allowedModels.includes(policy.primaryModel)||policy.blockedModels.includes(policy.primaryModel)) deny('INVALID_POLICY','O modelo principal deve ser permitido.');
  if (policy.fallbackModels.some(m=>!policy.allowedModels.includes(m)||policy.blockedModels.includes(m))) deny('INVALID_POLICY','Fallback precisa pertencer aos modelos permitidos.');
  if (policy.modelMode==='FIXED' && policy.fallbackModels.length) deny('INVALID_POLICY','FIXED não admite outro modelo como fallback.');
  for (const value of [policy.reasoning,policy.reasoningCeiling]) if(value!==null&&!efforts.includes(value)) deny('INVALID_POLICY','Raciocínio inválido.');
  if (!Number.isInteger(policy.maxAttempts)||policy.maxAttempts<1||policy.maxAttempts>100||!Number.isInteger(policy.timeoutMs)||policy.timeoutMs<1000||policy.timeoutMs>7_200_000) deny('INVALID_POLICY','Tentativas ou timeout inválidos.');
  for(const value of [policy.maxTokens,policy.maxCostUsd]) if(value!==null&&(!Number.isFinite(value)||value<=0)) deny('INVALID_POLICY','Limite de uso inválido.');
  if (!Array.isArray(policy.tools)||policy.tools.some(t=>!definition!.tools.includes(t))) deny('TOOLS','Ferramenta incompatível com a função.');
  if(!policy.permissions||['write','commands','web'].some(k=>typeof policy.permissions[k as keyof typeof policy.permissions]!=='boolean')) deny('INVALID_POLICY','Permissões inválidas.');
  if(typeof policy.parallel!=='boolean'||!Array.isArray(policy.taskKinds)||policy.taskKinds.some(t=>!definition!.taskKinds.includes(t))) deny('INVALID_POLICY','Tipos de tarefa incompatíveis com a função.');
}
/** Pure intersection. FIXED is never demoted, even when a ceiling would otherwise select a cheaper model. */
export function resolveAgentPolicy(input:PolicyResolutionInput) {
  const {policy,layers,models,account,capabilities,provider,role}=input;
  validateAgentPolicy(policy,role);
  if(roleDefinition(role)?.requiresImage) deny('UNAVAILABLE','Nenhum runtime de imagem conectado.');
  const allowed=(model:string):string|null=>{
    if(!contains(policy.allowedModels,model)||policy.blockedModels.some(id=>modelMatchesRule(provider,id,model))||layers.some(l=>(l.blockedModels&&l.blockedModels.some(id=>modelMatchesRule(provider,id,model)))||(l.allowedModels&&!contains(l.allowedModels,model)))) return 'modelo bloqueado';
    const rules=models.filter(m=>m.provider===provider&&modelMatchesRule(provider,m.modelId,model));
    if(rules.some(m=>!m.allowed||(m.allowedRoles.length&&!m.allowedRoles.includes(role)))) return 'política global';
    if((rules.some(m=>m.premium)||isPremiumModel(model))&&!account.allowPremiumModels) return 'premium desativado na conta';
    const tier=rules.find(m=>m.capability)?.capability??modelCapability(provider,model);
    if([account.maxCapability,...layers.map(l=>l.maxCapability)].some(ceiling=>ceiling&&(!tier||tiers.indexOf(tier)>tiers.indexOf(ceiling)))) return 'teto de modelo';
    if(!capabilities.modelFlag) return 'runtime não garante o modelo';
    if(capabilities.declaredModels&&!capabilities.declaredModels.includes(model)) return 'modelo não suportado pelo runtime';
    if(input.unavailable?.includes(model)) return 'modelo indisponível nesta execução';
    return null;
  };
  const candidates=policy.modelMode==='FIXED'?[policy.primaryModel]:[policy.primaryModel,...policy.fallbackModels];
  const model=candidates.find(m=>!allowed(m));
  if(!model) deny('MODEL_BLOCKED',`${policy.modelMode}: ${allowed(policy.primaryModel)} (${policy.primaryModel}).`);
  if(models.some(m=>m.provider===provider&&modelMatchesRule(provider,m.modelId,model!)&&m.confirmationRequired)&&!input.confirmation?.(model!)) throw new AgentPolicyError('CONFIRMATION_REQUIRED',`Confirme o uso de ${model} nesta execução.`,model!);
  const requestedReasoning=policy.reasoning??input.requested.reasoning;
  const ceilings=[policy.reasoningCeiling,...layers.map(l=>l.reasoningCeiling),account.maxReasoning?({LOW:'low',MEDIUM:'medium',HIGH:'high',MAX:'ultra'} as const)[account.maxReasoning]:null].filter((v):v is string=>!!v);
  let reasoning=requestedReasoning;
  if(reasoning&&!efforts.includes(reasoning)) deny('REASONING','Raciocínio desconhecido.');
  if(ceilings.length){
    const ceiling=Math.min(...ceilings.map(c=>efforts.indexOf(c)));
    reasoning=efforts[Math.min(reasoning?efforts.indexOf(reasoning):ceiling,ceiling)]!;
  }
  if(reasoning){
    const supported=capabilities.modelEfforts?.[model!]??capabilities.declaredEfforts;
    if(!capabilities.effortFlag||!supported?.length) deny('REASONING','O runtime não garante o raciocínio solicitado.');
    const max=efforts.indexOf(reasoning);
    reasoning=[...efforts].reverse().find(e=>efforts.indexOf(e)<=max&&supported!.includes(e))??null;
    if(!reasoning) deny('REASONING','Nenhum nível de raciocínio compatível com o teto.');
  }
  const tools=policy.tools.filter(t=>layers.every(l=>!l.tools||l.tools.includes(t))).filter(t=>!['write','commands','web'].includes(t)||policy.permissions[t as keyof typeof policy.permissions]);
  const minimum=(key:'maxAttempts'|'timeoutMs'|'maxTokens'|'maxCostUsd')=>Math.min(...[policy[key],...layers.map(l=>l[key])].filter((v):v is number=>typeof v==='number'));
  return { model:model!,reasoning,requestedModel:policy.primaryModel,requestedReasoning,tools:tools as AgentTool[],
    maxAttempts:minimum('maxAttempts'),timeoutMs:minimum('timeoutMs'),maxTokens:minimum('maxTokens'),maxCostUsd:minimum('maxCostUsd'),
    fallbackReason:model!==policy.primaryModel?allowed(policy.primaryModel):null };
}
