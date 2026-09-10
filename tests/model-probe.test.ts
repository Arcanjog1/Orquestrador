import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopFixture} from './helpers/desktop-fixture.js';
import {defaultAgentPolicy} from '../apps/desktop/src/shared/agent-policy.js';
import {AccountModelAvailability} from '../apps/desktop/src/main/services/account-model-availability.js';
import {classifyProbe,probeArguments} from '../apps/desktop/src/main/services/model-probe.js';
import type {ProcessResult} from '../src/process/process-manager.js';
const model='claude-opus-5';
const result=(stdout:string,extra:Partial<ProcessResult>={})=>({outcome:'completed',exitCode:0,stdout,stderr:'',truncated:false,...extra}) as ProcessResult;
const success=JSON.stringify({type:'result',subtype:'success',is_error:false,result:'OK',modelUsage:{[model]:{inputTokens:8,outputTokens:1}}});
for(const provider of ['anthropic','openai'] as const)for(const scenario of ['success','denied','timeout','network','cancelled','malformed','wrong-model','generic-exit'] as const)test(`minimal probe ${provider}: ${scenario}`,async()=>{
 const f=createDesktopFixture();try {
 const a=f.services.accounts.create('A',provider),b=f.services.accounts.create('B',provider);
 const id=provider==='openai'?'gpt-5.3-codex-spark':model;
 const agent=f.services.agents.create({name:'Probe',provider,accountId:a.id,role:'CODING_WORKER',model:id,reasoning:null,maxCapability:null,maxReasoning:null,enabled:true,policy:defaultAgentPolicy('CODING_WORKER',id)});
 const manager=provider==='openai'?f.services.codexAccountManager:f.services.accountManager;
 manager.hasOwnCredentials=()=>true;
 f.services.runtimeManager.getExecutablePath=async()=>'/fixture/runtime';
 const calls:any[]=[];
 f.services.processManager.run=async options=>{
 calls.push(options);
 if(options.args?.includes('--help'))return result(probeArguments(provider,id).join(' '));
 assert.equal(options.env?.[provider==='openai'?'CODEX_HOME':'CLAUDE_CONFIG_DIR'],manager.buildEnvironment(a.id)[provider==='openai'?'CODEX_HOME':'CLAUDE_CONFIG_DIR']);
 assert.equal(options.env?.[provider==='openai'?'OPENAI_API_KEY':'ANTHROPIC_API_KEY'],undefined);
 assert.equal(options.args?.[options.args.indexOf('--model')+1],id);
 assert.ok(options.cwd.includes('orchestrator-model-probe-'));assert.equal(options.stdin,'Responda apenas OK. Não use ferramentas.');
 if(scenario==='timeout'||scenario==='cancelled')return result('',{outcome:scenario,exitCode:null});
 if(scenario==='network')return result('',{exitCode:1,stderr:'ENOTFOUND'});
 if(scenario==='malformed'||scenario==='generic-exit')return result(scenario==='malformed'?'not json':'{}');
 if(scenario==='denied')return result(JSON.stringify({type:'error',error:{code:'model_not_allowed',model:id}}),{exitCode:1});
 if(provider==='anthropic')return result(scenario==='wrong-model'?success.replaceAll(model,'claude-sonnet-5'):success);
 return result([{type:'thread.started',thread_id:'fixture'},{type:'item.completed',item:{type:'agent_message',text:'OK',...(scenario==='wrong-model'?{model:'other'}:{})}},{type:'turn.completed',usage:{input_tokens:8,output_tokens:1}}].map(e=>JSON.stringify(e)).join('\n'));
 };
 const input={agentId:agent.id,accountId:a.id,modelId:id,authorised:true};
 assert.equal((await f.router.handle('agents.testModel',{...input,authorised:false})).ok,false);assert.equal(calls.length,0);
 assert.equal((await f.router.handle('agents.testModel',{...input,accountId:b.id})).ok,false);assert.equal(calls.length,0);
 assert.equal((await f.router.handle('agents.testModel',{...input,modelId:'different'})).ok,false);assert.equal(calls.length,0);
 const response=await f.router.handle('agents.testModel',input);assert.equal(response.ok,true,JSON.stringify(response));
 assert.equal(calls.filter(c=>!c.args.includes('--help')).length,1);
 const store=new AccountModelAvailability(f.services.database.settings),saved=store.read(a.id,provider)!;
 const evidence=saved.evidence!.at(-1)!;
 assert.equal(evidence.state,scenario==='success'?'CONFIRMED_FOR_ACCOUNT':scenario==='denied'?'UNAVAILABLE':'KNOWN_BUT_UNVERIFIED');
 assert.equal(evidence.accountId,a.id);assert.equal(evidence.modelId,id);assert.equal(evidence.agentId,agent.id);assert.equal(evidence.requestedModel,id);assert.equal(evidence.verificationMethod,'minimal-probe');
 assert.equal(store.read(b.id,provider),null);assert.equal(f.services.agents.manage().find(v=>v.id===agent.id)?.policy?.primaryModel,id);
 }finally{await f.cleanup();}
});
test('generic access errors and assistant text never deny a model',()=>{
 for(const value of [{type:'result',is_error:true,result:'model not available'},{error:{code:'rate_limit_exceeded',message:'unsupported model'}},{error:{code:'authentication_error'}},{error:{code:'model_not_found',model:'other'}}])assert.equal(classifyProbe('anthropic',model,result(JSON.stringify(value),{exitCode:1})).state,'KNOWN_BUT_UNVERIFIED');
});
test('per-model history survives other probes, free checks and age without consuming usage',()=>{
 const values=new Map<string,string>();const store=new AccountModelAvailability({get:k=>values.get(k)??null,set:(k,v)=>{values.set(k,v);}});
 const evidence={providerId:'anthropic' as const,accountId:'A',agentId:'agent',modelId:model,requestedModel:model,timestamp:'2020-01-01T00:00:00Z',verifiedAt:'2020-01-01T00:00:00Z',verificationMethod:'minimal-probe' as const,source:'fixture',state:'CONFIRMED_FOR_ACCOUNT' as const,reason:'OK'};
 store.record(evidence);store.record({...evidence,modelId:'claude-sonnet-5'});
 assert.deepEqual(store.read('A','anthropic')?.confirmed,[model,'claude-sonnet-5']);
});

for(const provider of ['openai','anthropic'] as const)test(`API minimal probe ${provider} sends one bounded request on the selected credential`,async()=>{
 const {fakeSecretStore}=await import('./helpers/desktop-fixture.js');
 const id=provider==='openai'?'gpt-5.3-codex-spark':model;
 const calls:any[]=[];
 const f=createDesktopFixture({secrets:fakeSecretStore(),providerTransport:async(url,init)=>{
   calls.push({url,...init});
   return {status:200,ok:true,headers:{get:()=>null},text:async()=>JSON.stringify(provider==='openai'?{model:id,status:'completed',output:[{content:[{text:'OK'}]}]}:{model:id,stop_reason:'end_turn',content:[{text:'OK'}]})};
 }});
 try {
 const created=await f.router.handle('connections.addApi',{providerId:provider,displayName:'API A',apiKey:'sk-test-probe-secret'});assert.equal(created.ok,true);
 if(!created.ok)throw new Error('fixture');const accountId=(created.value as {id:string}).id;
 await f.router.handle('connections.setEnabled',{connectionId:accountId,enabled:true});
 const agent=f.services.agents.create({name:'API probe',provider,accountId,role:'CODING_WORKER',model:id,reasoning:null,maxCapability:null,maxReasoning:null,enabled:true,policy:defaultAgentPolicy('CODING_WORKER',id)});
 calls.length=0;
 const input={agentId:agent.id,accountId,modelId:id,authorised:true};
 await f.router.handle('agents.testModel',{...input,authorised:false});assert.equal(calls.length,0);
 const response=await f.router.handle('agents.testModel',input);assert.equal(response.ok,true,JSON.stringify(response));assert.equal(calls.length,1);
 const body=JSON.parse(calls[0].body);assert.equal(body.model,id);assert.deepEqual(body.tools,[]);assert.ok((body.max_tokens??body.max_output_tokens)<=32);
 assert.equal(calls[0].headers[provider==='openai'?'authorization':'x-api-key'],provider==='openai'?'Bearer sk-test-probe-secret':'sk-test-probe-secret');
 const saved=new AccountModelAvailability(f.services.database.settings).read(accountId,provider)!;assert.deepEqual(saved.confirmed,[id]);assert.ok(!JSON.stringify(saved).includes('sk-test'));
 }finally{await f.cleanup();}
});

test('unsupported CLI, missing own credentials, concurrency and changed selection send no extra inference',async()=>{
 const f=createDesktopFixture();try {
 const a=f.services.accounts.create('Guard A','anthropic');
 const agent=f.services.agents.create({name:'Guard',provider:'anthropic',accountId:a.id,role:'CODING_WORKER',model,reasoning:null,maxCapability:null,maxReasoning:null,enabled:true,policy:defaultAgentPolicy('CODING_WORKER',model)});
 const input={agentId:agent.id,accountId:a.id,modelId:model,authorised:true};let calls=0;
 f.services.runtimeManager.getExecutablePath=async()=>'/fixture/claude';
 f.services.processManager.run=async()=>{calls++;return result('Usage: old CLI');};
 f.services.accountManager.hasOwnCredentials=()=>false;
 await f.services.testAgentModel(input);assert.equal(calls,0);
 f.services.accountManager.hasOwnCredentials=()=>true;
 await f.services.testAgentModel(input);assert.equal(calls,1,'only help');
 let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
 f.services.processManager.run=async options=>{calls++;if(options.args?.includes('--help')){await barrier;return result(probeArguments('anthropic',model).join(' '));}return result(success);};
 const pending=f.services.testAgentModel(input);
 await assert.rejects(f.services.testAgentModel(input),/andamento/);
 release();await pending;assert.equal(calls,3,'one help plus exactly one inference');
 }finally{await f.cleanup();}
});

test('Claude subscription probe preserves OAuth: safe mode, never bare mode',()=>{
 const args=probeArguments('anthropic',model);
 assert.ok(args.includes('--safe-mode'));assert.ok(!args.includes('--bare'));
 assert.equal(args[args.indexOf('--tools')+1],'');assert.equal(args[args.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
 assert.ok(args.includes('--no-session-persistence'));assert.equal(args[args.indexOf('--max-turns')+1],'1');
});
