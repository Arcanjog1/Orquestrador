import test from 'node:test';
import assert from 'node:assert/strict';
import {decorateAgentModels,knownAgentModels} from '../apps/desktop/src/main/services/agent-model-catalog.js';
import {modelDisplayName,reasoningName,selectionProblem} from '../apps/desktop/src/shared/model-display.js';
import {defaultAgentPolicy,type ModelCatalogEntry,type PolicyConfiguration} from '../apps/desktop/src/shared/agent-policy.js';
import {createDesktopFixture} from './helpers/desktop-fixture.js';
const account={provider_id:'anthropic',max_capability:null,max_reasoning:null,allow_premium_models:1};
const config:PolicyConfiguration={models:[],defaults:{},routing:{}};
const rows=(ids:string[],provider:'anthropic'|'openai'='anthropic'):ModelCatalogEntry[]=>ids.map(id=>({id,provider,source:'runtime',reasoning:['low','medium','high'],accountAllowed:null}));
test('model display names are centralized and canonical IDs never change',()=>{assert.equal(modelDisplayName('anthropic','opus'),'Claude Opus (versão da conexão)');assert.equal(modelDisplayName('anthropic','claude-sonnet-4-6','Sonnet 4.6'),'Sonnet 4.6');assert.equal(modelDisplayName('openai','gpt-5.3-codex-spark'),'GPT-5.3 Codex Spark');assert.equal(reasoningName('xhigh'),'Muito alto');const r=decorateAgentModels(rows(['opus','sonnet','haiku']),account,config);assert.deepEqual(r.map(m=>m.id),['opus','sonnet','haiku']);assert.deepEqual(r.map(m=>m.displayName),['Claude Opus (versão da conexão)','Claude Sonnet (versão da conexão)','Claude Haiku (versão da conexão)']);});
test('catalog fallback is explicit and does not invent account access or reasoning',()=>{for(const provider of ['openai','anthropic'] as const){for(const model of knownAgentModels(provider)){assert.equal(model.source,'catalog');assert.equal(model.accountAllowed,null);assert.deepEqual(model.reasoning,[]);}}});
test('catalog decoration filters providers and explains global blocks, roles and ceilings',()=>{const c={...config,models:[{provider:'anthropic' as const,modelId:'fable',allowed:false,premium:true,confirmationRequired:false,allowedRoles:[],capability:null}]};const r=decorateAgentModels([...rows(['sonnet','fable']),...rows(['gpt-test'],'openai')],account,c,'DESIGNER');assert.equal(r.length,2);assert.match(r[1]!.blockedReason!,/política global/);assert.equal(r[1]!.premium,true);assert.deepEqual(decorateAgentModels(rows(['sonnet']),{...account,max_reasoning:'MEDIUM'},config)[0]!.reasoning,['low','medium']);});
test('IPC save revalidates provider account catalog and reasoning; disconnected agent is unavailable',async()=>{const f=createDesktopFixture();try{
 const a=f.services.accounts.create('Claude 1','anthropic'),b=f.services.accounts.create('Claude 2','anthropic');
 f.services.agentModels=async(id)=>rows(id===a.id?['opus','sonnet']:['sonnet','haiku']);
 const input={name:'Designer',role:'DESIGNER',provider:'anthropic' as const,accountId:b.id,model:'sonnet',reasoning:'medium',maxCapability:null,maxReasoning:null,enabled:true,policy:{...defaultAgentPolicy('DESIGNER','sonnet'),modelMode:'CONTROLLED_AUTO' as const,allowedModels:['sonnet','haiku'],fallbackModels:['haiku'],reasoning:'medium'}};
 const result=await f.router.handle('agents.create',input);assert.equal(result.ok,true,JSON.stringify(result));
 const saved=f.services.agents.manage().find(a=>a.name==='Designer')!;assert.equal(saved.accountId,b.id);assert.equal(saved.availability,'UNAVAILABLE');assert.match(saved.unavailableReason!,/Conta desconectada/);
 assert.equal((await f.router.handle('agents.create',{...input,accountId:a.id})).ok,false);
 assert.equal((await f.router.handle('agents.create',{...input,provider:'openai'})).ok,false);
 assert.equal((await f.router.handle('agents.create',{...input,reasoning:'max',policy:{...input.policy,reasoning:'max'}})).ok,false);
 f.services.agentModels=async()=>rows(['sonnet']);assert.equal((await f.router.handle('agents.update',{agentId:saved.id,agent:{...input,name:'Renamed',enabled:false}})).ok,true,'can deactivate unavailable model without silently replacing it');
}finally{await f.cleanup();}});
test('global model policy still rejects manipulated IPC saves before persistence',async()=>{const f=createDesktopFixture();try{
 const a=f.services.accounts.create('Claude','anthropic');const c={...config,models:[{provider:'anthropic' as const,modelId:'fable',allowed:false,premium:true,confirmationRequired:false,allowedRoles:[],capability:null}]};f.services.agents.savePolicies(c);
 f.services.agentModels=async()=>decorateAgentModels(rows(['fable']),account,f.services.agents.policies());
 const result=await f.router.handle('agents.create',{name:'Forged',role:'CODING_WORKER',provider:'anthropic',accountId:a.id,model:'fable',reasoning:null,maxCapability:null,maxReasoning:null,enabled:true,policy:defaultAgentPolicy('CODING_WORKER','fable')});assert.equal(result.ok,false);assert.ok(!f.services.agents.manage().some(a=>a.name==='Forged'));
}finally{await f.cleanup();}});

test('agent limits are checked before save without silently changing the selection',()=>{const models=decorateAgentModels(rows(['opus','sonnet']),account,config);const policy={...defaultAgentPolicy('CODING_WORKER','opus'),reasoning:'high'};assert.match(selectionProblem(policy,models,'FAST',null)!,/máximo/);assert.match(selectionProblem(policy,models,null,'LOW')!,/Raciocínio/);assert.equal(policy.primaryModel,'opus');assert.equal(policy.reasoning,'high');});

test('official fallback names include both complete provider lineups and preserve canonical IDs',()=>{
 assert.deepEqual(knownAgentModels('openai').map(m=>m.displayName),['GPT-6 Astra','GPT-5.6 Sol','GPT-5.6 Terra','GPT-5.6 Luna','GPT-5.5','GPT-5.3 Codex Spark']);
 assert.deepEqual(knownAgentModels('anthropic').map(m=>m.displayName),['Claude Fable 5.1','Claude Opus 5','Claude Sonnet 5','Claude Haiku 4.5']);
 assert.equal(knownAgentModels('anthropic')[2]!.id,'claude-sonnet-5');
 assert.equal(modelDisplayName('anthropic','claude-haiku-4-5-20251001'),'Claude Haiku 4.5');
 assert.equal(modelDisplayName('openai','gpt-6-astra'),'GPT-6 Astra');
 assert.equal(modelDisplayName('openai','smoke-model'),'Modelo não reconhecido');
});

test('legacy family blocks still cover canonical model choices in catalog and execution',async()=>{
 const {resolveAgentPolicy}=await import('../apps/desktop/src/main/services/agent-policy-resolver.js');
 const rule={provider:'anthropic' as const,modelId:'fable',allowed:false,premium:true,confirmationRequired:false,allowedRoles:[],capability:null};
 const catalog=decorateAgentModels(knownAgentModels('anthropic'),account,{...config,models:[rule]});
 assert.match(catalog.find(m=>m.id==='claude-fable-5-1')!.blockedReason!,/global/);
 assert.throws(()=>resolveAgentPolicy({role:'CODING_WORKER',provider:'anthropic',policy:defaultAgentPolicy('CODING_WORKER','claude-fable-5-1'),layers:[],models:[rule],account:{maxCapability:null,maxReasoning:null,allowPremiumModels:true},capabilities:{modelFlag:true,effortFlag:true,declaredModels:null,declaredEfforts:null},requested:{model:null,reasoning:null}}),/política global/);
 const blocked=decorateAgentModels(knownAgentModels('anthropic'),account,{...config,defaults:{blockedModels:['fable']}});
 assert.match(blocked.find(m=>m.id==='claude-fable-5-1')!.blockedReason!,/global/);
});

test('canonical Claude choices expose only model efforts confirmed by the installed CLI',()=>{
 const catalog=knownAgentModels('anthropic',{effortFlag:true,modelEfforts:{'claude-sonnet-5':['low','medium','high'],'claude-haiku-4-5-20251001':[]}});
 assert.deepEqual(catalog.find(m=>m.id==='claude-sonnet-5')!.reasoning,['low','medium','high']);
 assert.deepEqual(catalog.find(m=>m.id==='claude-haiku-4-5-20251001')!.reasoning,[]);
 assert.deepEqual(knownAgentModels('anthropic',{effortFlag:false,modelEfforts:{'claude-sonnet-5':['high']}}).find(m=>m.id==='claude-sonnet-5')!.reasoning,[]);
});
