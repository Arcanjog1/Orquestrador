/** Portable domain contract shared by the desktop, persistence and execution boundary. */
export type AgentTool = 'read' | 'diff' | 'evidence' | 'write' | 'commands' | 'web' | 'image';
export type TaskKind = 'IMPLEMENTATION' | 'CODE_REVIEW' | 'UI_UX' | 'TESTING' | 'RESEARCH' | 'IMAGE';
export interface RoleDefinition {
  id: string; label: string; lane: 'supervisor' | 'delegate';
  taskKinds: TaskKind[]; tools: AgentTool[]; requiresImage?: boolean;
}
export const AGENT_ROLES: readonly RoleDefinition[] = [
  { id:'ORCHESTRATOR', label:'Orquestrador', lane:'supervisor', taskKinds:[], tools:['read','diff','evidence'] },
  { id:'CODING_WORKER', label:'Programador / Worker', lane:'delegate', taskKinds:['IMPLEMENTATION'], tools:['read','diff','evidence','write','commands'] },
  { id:'PROGRAMMER', label:'Programador', lane:'delegate', taskKinds:['IMPLEMENTATION'], tools:['read','diff','evidence','write','commands'] },
  { id:'ANALYST', label:'Analista / Reviewer', lane:'delegate', taskKinds:['CODE_REVIEW'], tools:['read','diff','evidence'] },
  { id:'REVIEWER', label:'Reviewer', lane:'delegate', taskKinds:['CODE_REVIEW'], tools:['read','diff','evidence'] },
  { id:'DESIGNER', label:'Designer', lane:'delegate', taskKinds:['UI_UX'], tools:['read','diff','evidence','write'] },
  { id:'TESTER', label:'Tester', lane:'delegate', taskKinds:['TESTING'], tools:['read','diff','evidence','commands'] },
  { id:'RESEARCHER', label:'Pesquisador', lane:'delegate', taskKinds:['RESEARCH'], tools:['read','web'] },
  { id:'IMAGE_GENERATOR', label:'Gerador de imagens', lane:'delegate', taskKinds:['IMAGE'], tools:['image'], requiresImage:true },
];
export const roleDefinition = (id: string): RoleDefinition | undefined => AGENT_ROLES.find(role => role.id === id);
export interface AgentPolicy {
  version: 1;
  modelMode: 'FIXED' | 'CONTROLLED_AUTO';
  primaryModel: string;
  allowedModels: string[];
  blockedModels: string[];
  fallbackModels: string[];
  reasoning: string | null;
  reasoningCeiling: string | null;
  tools: AgentTool[];
  permissions: { write: boolean; commands: boolean; web: boolean };
  maxAttempts: number;
  timeoutMs: number;
  maxTokens: number | null;
  maxCostUsd: number | null;
  parallel: boolean;
  taskKinds: TaskKind[];
}
export interface ModelPolicy {
  provider: 'openai' | 'anthropic'; modelId: string; allowed: boolean;
  premium: boolean; confirmationRequired: boolean; allowedRoles: string[];
  capability: 'FAST' | 'BALANCED' | 'STRONG' | 'MAX' | null;
}
export interface PolicyLayer {
  allowedModels?: string[]; blockedModels?: string[]; reasoningCeiling?: string | null;
  maxCapability?: 'FAST' | 'BALANCED' | 'STRONG' | 'MAX' | null;
  tools?: AgentTool[]; maxAttempts?: number; timeoutMs?: number;
  maxTokens?: number | null; maxCostUsd?: number | null;
}
export interface PolicyConfiguration {
  defaultTeam?: {orchestrator:string;agents:string[]};
  models: ModelPolicy[];
  defaults: PolicyLayer;
  routing: Partial<Record<TaskKind, string[]>>;
}
export interface ModelCatalogEntry {
  id:string; provider:'openai'|'anthropic'; source:'runtime'|'provider'|'catalog';
  reasoning:string[]; accountAllowed:boolean | null;
  displayName?:string; premium?:boolean; blockedReason?:string|null; capability?:ModelPolicy['capability'];
}
export const EFFORT_ORDER = ['none','minimal','low','medium','high','xhigh','max','ultra'] as const;
export const DEFAULT_POLICY_CONFIGURATION: PolicyConfiguration = { models:[], defaults:{}, routing:{} };
export function defaultAgentPolicy(role: string, model: string): AgentPolicy {
  const definition = roleDefinition(role);
  const tools = [...(definition?.tools ?? [])];
  return { version:1, modelMode:'FIXED', primaryModel:model, allowedModels:model?[model]:[],
    blockedModels:[], fallbackModels:[], reasoning:null, reasoningCeiling:null, tools,
    permissions:{write:tools.includes('write'),commands:tools.includes('commands'),web:tools.includes('web')},
    maxAttempts:8, timeoutMs:600_000, maxTokens:null,maxCostUsd:null,parallel:false,
    taskKinds:[...(definition?.taskKinds ?? [])] };
}
