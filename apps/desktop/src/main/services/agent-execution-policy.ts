import { createHash } from 'node:crypto';
import {AccountModelAvailability} from './account-model-availability.js';
import type { Database } from '../core.js';
import { newId } from '../core.js';
import type { AgentInput, AgentResult } from '../../../../../src/core/types.js';
import type { AgentRunner } from '../../../../../src/agents/agent-runner.js';
import type { WorkerRuntimeCapabilities } from '../../../../../src/routing/provider-policy.js';
import { capabilityCeilingOf, reasoningCeilingOf } from '../../../../../src/routing/account-policy.js';
import { AgentService, agentConfig } from './agent-service.js';
import { AgentPolicyError, resolveAgentPolicy } from './agent-policy-resolver.js';
import { defaultAgentPolicy, roleDefinition } from '../../shared/agent-policy.js';

/** A single boundary for supervision, delegation, repair, session retry and resume. */
export class AgentExecutionPolicy {
  constructor(private readonly database:Database) {}
  private fingerprint(agentId:string,workspaceId:string) {
    const agents=new AgentService(this.database);
    const agent=this.database.agents.require(agentId);
    const account=agent.account_id?this.database.accounts.find(agent.account_id):undefined;
    return createHash('sha256').update(JSON.stringify([agent.id,agent.role,agent.account_id,agent.provider_id,agent.enabled,agent.model,agent.runtime_options,account?.max_capability,account?.max_reasoning,account?.allow_premium_models,account?.api_enabled,agents.policies(),agents.projectPolicy(workspaceId)])).digest('hex');
  }
  confirm(runId:string,agentId:string,model:string):boolean {
    const run=this.database.runs.require(runId);
    if(!['NEEDS_HUMAN','BLOCKED'].includes(run.status)) throw new Error('Esta execução não aguarda confirmação.');
    const pending=this.database.driver.all<{id:string;snapshot:string}>("SELECT id,snapshot FROM agent_policy_calls WHERE run_id=? AND agent_id=? AND status='CONFIRMATION_REQUIRED'",[runId,agentId]);
    const fingerprint=this.fingerprint(agentId,run.workspace_id);
    const matching=pending.filter(row=>{const snapshot=JSON.parse(row.snapshot);return snapshot.model===model&&snapshot.policyFingerprint===fingerprint;});
    if(!matching.length) throw new Error('Não há confirmação pendente válida para esta política, agente e modelo.');
    this.database.driver.run('INSERT OR IGNORE INTO model_confirmations VALUES (?,?,?,?,?)',[runId,agentId,model,fingerprint,new Date().toISOString()]);
    for(const row of matching)this.database.driver.run("UPDATE agent_policy_calls SET status='CONFIRMED' WHERE id=?",[row.id]);
    return true;
  }
  calls(runId:string) { this.database.runs.require(runId); return this.database.driver.all<{id:string;snapshot:string;observation:string|null;status:string;started_at:string;finished_at:string|null}>('SELECT id,snapshot,observation,status,started_at,finished_at FROM agent_policy_calls WHERE run_id=? ORDER BY started_at,id',[runId]).map(row=>({...row,snapshot:JSON.parse(row.snapshot) as Record<string,unknown>,observation:row.observation?JSON.parse(row.observation) as Record<string,unknown>:null})); }

  async invoke(input:{workspaceId:string;agentId:string|null;accountId:string|null;runner:AgentRunner;args:AgentInput;capabilities?:WorkerRuntimeCapabilities;beforeInvocation?:()=>void}):Promise<AgentResult> {
    const {runner,args,workspaceId,agentId,accountId}=input;
    const agent=agentId?this.database.agents.find(agentId):undefined;
    const service=new AgentService(this.database);
    const global=service.policies();
    const project=service.projectPolicy(workspaceId);
    const options=agent?agentConfig(agent.runtime_options):{};
    const accountEvidence=accountId&&agent?new AccountModelAvailability(this.database.settings).read(accountId,agent.provider_id):null;
    const restricted=accountEvidence?.denied.length || options.policy || global.models.length || Object.keys(global.defaults).length || Object.keys(project).length || (agent&&((roleDefinition(agent.role)?.id!=='CODING_WORKER'&&roleDefinition(agent.role)?.lane==='delegate')||(agent.role==='ORCHESTRATOR'&&agent.provider_id==='anthropic')));
    if(!restricted) {input.beforeInvocation?.();return runner.run(args);}
    const startedAt=new Date().toISOString();
    const id=newId('policy-call');
    let invoked=false;
    let snapshot:Record<string,unknown>={agentId,agentName:agent?.display_name,role:agent?.role,accountId,provider:agent?.provider_id,requested:args.routing??null};
    try {
      if(!agent||agent.enabled!==1||agent.account_id!==accountId) throw new AgentPolicyError('AGENT_UNAVAILABLE','Agente desativado, removido ou associado a outra conta.');
      const account=accountId?this.database.accounts.find(accountId):undefined;
      if(!account||account.provider_id!==agent.provider_id||account.auth_state!=='connected') throw new AgentPolicyError('ACCOUNT','A conta deste agente não está conectada.');
      if(account.connection_kind==='api'&&account.api_enabled!==1) throw new AgentPolicyError('ACCOUNT','A API desta conta não está habilitada.');
      const capabilities=input.capabilities ?? await (runner as AgentRunner & {describeCapabilities?:(cwd:string)=>Promise<WorkerRuntimeCapabilities>}).describeCapabilities?.(args.workingDirectory);
      if(!capabilities) throw new AgentPolicyError('CAPABILITIES','O runtime não declara capacidades suficientes para garantir esta política.');
      const policy=options.policy??defaultAgentPolicy(agent.role,args.routing?.model??agent.model??account.default_model??'');
      const rows=this.database.driver.all<{snapshot:string;observation:string|null;status:string}>('SELECT snapshot,observation,status FROM agent_policy_calls WHERE run_id=? AND agent_id=?',[args.runId,agent.id]);
      const actual=rows.filter(row=>['RUNNING','COMPLETED','FAILED','CANCELLED'].includes(row.status));
      const observations=actual.map(row=>row.observation?JSON.parse(row.observation) as {failure?:string;model?:string;usage?:{totalTokens:number|null;costUsd:number|null}}:null);
      const unavailable=[...actual.filter(row=>JSON.parse(row.snapshot).accountId===account.id).map(row=>row.observation?JSON.parse(row.observation):null).filter(o=>o?.failure==='model-unavailable').map(o=>o.model),...(new AccountModelAvailability(this.database.settings).read(account.id,account.provider_id)?.denied??[])];
      const fingerprint=this.fingerprint(agent.id,workspaceId);
      snapshot={...snapshot,accountName:account.display_name,policyFingerprint:fingerprint,policy,globalPolicy:global,projectPolicy:project};
      // Model confirmation is tied to the entire policy and the run, not an enduring credit grant.
      const resolved=resolveAgentPolicy({role:agent.role,provider:agent.provider_id as 'openai'|'anthropic',policy,
        layers:[global.defaults,project,{maxCapability:options.maxCapability??null,reasoningCeiling:options.maxReasoning?({LOW:'low',MEDIUM:'medium',HIGH:'high',MAX:'ultra'} as const)[options.maxReasoning]:null}],models:global.models,
        account:{maxCapability:capabilityCeilingOf(account.max_capability),maxReasoning:reasoningCeilingOf(account.max_reasoning),allowPremiumModels:account.allow_premium_models===1},
        capabilities,requested:args.routing??{model:null,reasoning:null},unavailable,
        confirmation:model=>!!this.database.driver.get('SELECT 1 FROM model_confirmations WHERE run_id=? AND agent_id=? AND model_id=? AND policy_hash=?',[args.runId,agent.id,model,fingerprint])});
      snapshot={...snapshot,policy,globalPolicy:global,projectPolicy:project,accountCeiling:{model:account.max_capability,reasoning:account.max_reasoning},...resolved,attempt:actual.length+1,adapter:agent.adapter_id,connectionKind:account.connection_kind};
      if(actual.length>=resolved.maxAttempts) throw new AgentPolicyError('ATTEMPTS','Limite de tentativas deste agente atingido nesta execução.');
      if(!policy.parallel&&actual.some(row=>row.status==='RUNNING')) throw new AgentPolicyError('PARALLEL','Este agente não permite invocações simultâneas.');
      for(const [limit,key] of [[resolved.maxTokens,'totalTokens'],[resolved.maxCostUsd,'costUsd']] as const) {
        if(!Number.isFinite(limit)) continue;
        if(actual.some(row=>row.status==='RUNNING')) throw new AgentPolicyError('USAGE','Limite de uso requer execução sequencial para contabilização.');
        if(observations.some(o=>o?.usage?.[key]==null)) throw new AgentPolicyError('USAGE_UNKNOWN','O provedor não informou o consumo necessário para garantir o limite.');
        if(observations.reduce((sum,o)=>sum+(o?.usage?.[key]??0),0)>=limit) throw new AgentPolicyError('USAGE','Limite de uso deste agente atingido.');
      }
      // Cancellation is checked immediately before the provider call, including schema repair.
      const run=this.database.runs.require(args.runId);
      if(run.cancel_requested_at||run.status==='CANCELLED') throw new AgentPolicyError('CANCELLED','Execução cancelada.');
      this.database.driver.run('INSERT INTO agent_policy_calls(id,run_id,agent_id,snapshot,started_at,status) VALUES (?,?,?,?,?,?)',[id,args.runId,agent.id,JSON.stringify(snapshot),startedAt,'RUNNING']);
      input.beforeInvocation?.();
      invoked=true;
      const result=await runner.run({...args,routing:{model:resolved.model,reasoning:resolved.reasoning},strictRouting:true,toolPolicy:resolved.tools,timeoutMs:Math.min(args.timeoutMs,resolved.timeoutMs)});
      const observation={model:resolved.model,sent:result.applied??null,observed:result.observed??null,usage:result.usage??null,failure:result.failure??null,durationMs:result.durationMs,outcome:result.outcome};
      this.database.driver.run('UPDATE agent_policy_calls SET finished_at=?,observation=?,status=? WHERE id=?',[new Date().toISOString(),JSON.stringify(observation),result.outcome==='cancelled'?'CANCELLED':result.exitCode===0?'COMPLETED':'FAILED',id]);
      return result;
    } catch(error) {
      const code=error instanceof AgentPolicyError?error.code:'RUNTIME_POLICY';
      const message=error instanceof Error?error.message:String(error);
      if(code==='CONFIRMATION_REQUIRED') snapshot={...snapshot,model:(error as AgentPolicyError).modelId??options.policy?.primaryModel??args.routing?.model};
      this.database.driver.run('INSERT INTO agent_policy_calls(id,run_id,agent_id,snapshot,started_at,finished_at,observation,status) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at,observation=excluded.observation,status=excluded.status',[id,args.runId,agentId??'unbound',JSON.stringify(snapshot),startedAt,new Date().toISOString(),JSON.stringify({error:message,code}),invoked?'FAILED':code]);
      const internalStop = ['ATTEMPTS','PARALLEL','RUNTIME_POLICY'].includes(code);
      if(code!=='CANCELLED') this.database.runs.setStatus(args.runId,internalStop ? 'FAILED' : 'NEEDS_HUMAN',message);
      return {invocationSkipped:!invoked,outcome:code==='CANCELLED'?'cancelled':'completed',exitCode:1,signal:null,truncated:false,stdout:'',stderr:message,durationMs:0,startedAt,finishedAt:new Date().toISOString(),failure:code==='CONFIRMATION_REQUIRED'?'approval-required':'permission',failureDetail:message};
    }
  }
}
