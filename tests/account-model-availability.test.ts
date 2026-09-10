import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountModelAvailability,parseAccountModelListing} from '../apps/desktop/src/main/services/account-model-availability.js';
import {decorateAgentModels,knownAgentModels} from '../apps/desktop/src/main/services/agent-model-catalog.js';
import {defaultAgentPolicy} from '../apps/desktop/src/shared/agent-policy.js';
import {createDesktopFixture} from './helpers/desktop-fixture.js';
import type {ProcessResult} from '../src/process/process-manager.js';

const opus='claude-opus-5';
const record=(accountId:string,confirmed:string[]=[],denied:string[]=[])=>({accountId,provider:'anthropic' as const,confirmed,denied,checkedAt:new Date().toISOString(),detail:'fixture'});
test('account A confirmation never confirms account B, another provider or an alias',()=>{
 const values=new Map<string,string>();const store=new AccountModelAvailability({get:k=>values.get(k)??null,set:(k,v)=>{values.set(k,v);}});
 store.write('A',record('A',[opus]));
 const rows=knownAgentModels('anthropic');
 assert.equal(store.apply('A','anthropic',rows).find(m=>m.id===opus)?.availability,'CONFIRMED_FOR_ACCOUNT');
 assert.equal(store.apply('B','anthropic',rows).find(m=>m.id===opus)?.availability,'KNOWN_BUT_UNVERIFIED');
 assert.equal(store.read('A','openai'),null);
 assert.throws(()=>store.write('B',record('A',[opus])));
 values.set('account-model-availability.B',JSON.stringify(record('A',[opus])));
 assert.equal(store.read('B','anthropic'),null);
 values.set('account-model-availability.A',JSON.stringify({...record('A',[],[opus]),checkedAt:'2020-01-01T00:00:00Z'}));
 assert.equal(store.read('A','anthropic'),null);
});
test('parser requires entitlement evidence and never infers denial from missing entries',()=>{
 assert.equal(parseAccountModelListing('{"models":["claude-opus-5"]}','A'),null);
 assert.equal(parseAccountModelListing('{"loggedIn":true}','A'),null);
 assert.equal(parseAccountModelListing(JSON.stringify({accountId:'B',scope:'account',models:[opus]}),'A'),null);
 assert.deepEqual(parseAccountModelListing(JSON.stringify({scope:'account',complete:true,models:[opus]}),'A'),{confirmed:[opus],denied:[]});
 assert.deepEqual(parseAccountModelListing(JSON.stringify({models:[{id:opus,entitled:false}]}),'A'),{confirmed:[],denied:[opus]});
});
for(const scenario of ['confirmed','denied','no-enumeration','timeout','network-error','wrong-account','enumeration'] as const) {
 test(`account verification IPC: ${scenario}; only bound account metadata, no inference`,async()=>{
  const f=createDesktopFixture();try {
   const a=f.services.accounts.create('A','anthropic'),b=f.services.accounts.create('B','anthropic');
   const agent=f.services.agents.create({name:'A worker',provider:'anthropic',accountId:a.id,role:'CODING_WORKER',model:opus,reasoning:null,maxCapability:null,maxReasoning:null,enabled:true,policy:defaultAgentPolicy('CODING_WORKER',opus)});
   const calls:Array<{args?:string[];env?:NodeJS.ProcessEnv}>=[];
   f.services.runtimeManager.getExecutablePath=async()=>'/fixture/claude';
   f.services.processManager.run=async options=>{
    calls.push(options);
    if(scenario==='network-error')throw new Error('network error');
    const args=options.args??[];
    let stdout='Usage: claude\nOptions:\n --model <model>\n';
    if(scenario==='enumeration'&&args.includes('--help'))stdout=args.includes('list')?' --json JSON':args.includes('models')?'  list List models':'  models Manage models';
    if(args.includes('--json'))stdout=JSON.stringify({accountId:scenario==='wrong-account'?b.id:a.id,models:scenario==='no-enumeration'?undefined:[{id:opus,entitled:scenario!=='denied'}]});
    return {outcome:scenario==='timeout'?'timeout':'completed',exitCode:scenario==='timeout'?null:0,stdout,stderr:'',truncated:false} as ProcessResult;
   };
   const response=await f.router.handle('agents.verifyModels',{agentId:agent.id});assert.equal(response.ok,true,JSON.stringify(response));
   const store=new AccountModelAvailability(f.services.database.settings),evidence=store.read(a.id,'anthropic')!;
   assert.ok(evidence);assert.equal(store.read(b.id,'anthropic'),null);
   assert.deepEqual(evidence.denied,scenario==='denied'?[opus]:[]);
   assert.deepEqual(evidence.confirmed,['confirmed','enumeration'].includes(scenario)?[opus]:[]);
   for(const call of calls){assert.equal(call.env?.CLAUDE_CONFIG_DIR,f.services.accountManager.buildEnvironment(a.id).CLAUDE_CONFIG_DIR);assert.ok(call.args?.includes('--help')||call.args?.join(' ')==='auth status --json'||call.args?.join(' ')==='models list --json');assert.ok(!call.args?.some(a=>['exec','--print','-p'].includes(a)));}
   if(scenario==='enumeration')assert.ok(calls.some(c=>c.args?.join(' ')==='models list --json'));
   const rows=await f.services.agentModels(a.id);
   assert.equal(rows.find(m=>m.id===opus)?.availability,scenario==='denied'?'UNAVAILABLE':['confirmed','enumeration'].includes(scenario)?'CONFIRMED_FOR_ACCOUNT':'KNOWN_BUT_UNVERIFIED');
   const forged=await f.router.handle('settings.set',{key:'account-model-availability.'+b.id,value:JSON.stringify(record(b.id,[opus]))});assert.equal(forged.ok,false);
   assert.equal((await f.router.handle('agents.verifyModels',{agentId:agent.id,accountId:b.id})).ok,false);
  } finally {await f.cleanup();}
 });
}
test('confirmed availability remains separate from global, premium, allowed-model and ceiling restrictions',()=>{
 const rows=knownAgentModels('anthropic').map(m=>({...m,accountAllowed:true}));
 const account={provider_id:'anthropic',max_capability:null,max_reasoning:null,allow_premium_models:1};
 const global={models:[],defaults:{blockedModels:[opus]},routing:{}};
 const selected=decorateAgentModels(rows,account,global).find(m=>m.id===opus)!;
 assert.equal(selected.availability,'CONFIRMED_FOR_ACCOUNT');assert.match(selected.blockedReason!,/global/);
 const premium=decorateAgentModels(rows,{...account,allow_premium_models:0},{models:[],defaults:{},routing:{}}).find(m=>m.id==='claude-fable-5-1')!;
 assert.equal(premium.availability,'CONFIRMED_FOR_ACCOUNT');assert.match(premium.blockedReason!,/premium/);
 assert.match(decorateAgentModels(rows,account,{models:[],defaults:{allowedModels:['claude-sonnet-5']},routing:{}}).find(m=>m.id===opus)!.blockedReason!,/global/);
 assert.match(decorateAgentModels(rows,{...account,max_capability:'FAST'},{models:[],defaults:{},routing:{}}).find(m=>m.id===opus)!.blockedReason!,/máximo/);
});
