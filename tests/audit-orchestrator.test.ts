import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopFixture,ScriptedAgent} from './helpers/desktop-fixture.js';
import {createGitFixture} from './helpers/git-fixture.js';
import type {AgentInput} from '../src/core/types.js';

for(const manual of [false,true]) test(`audit P1: orchestrator ceiling before every call (${manual?'manual':'auto'})`,async()=>{
 const repo=createGitFixture();const calls:AgentInput[]=[];
 const orchestrator=new ScriptedAgent('mock-codex','Supervisor',[input=>{calls.push(input);return JSON.stringify({action:'blocked',summary:'Audit done',...(calls.length>1?{reason:'Audit finished'}:{}),acceptanceCriteria:[],verificationCommands:[]});}]);
 const worker=new ScriptedAgent('mock-claude','Worker',['unused']);
 const f=createDesktopFixture({fastPath:false,createRunners:async()=>({orchestrator,worker,workerAccountId:null})});
 try{
 const a=f.services.accounts.create('Supervisor','openai'),b=f.services.accounts.create('Worker','anthropic');
 f.services.database.accounts.setRoutingPolicy(a.id,{maxCapability:'FAST',maxReasoning:'LOW',allowPremiumModels:false});
 const ws=f.services.workspaces.create({name:'Audit',localPath:repo.dir});
 f.services.workspaces.setTeam(ws.id,{accountId:a.id,...(manual?{selection:'manual' as const,model:'gpt-5.3-codex',reasoning:'max' as const}:{})},{accountId:b.id});
 const session=await f.router.handle('chat.createSession',{workspaceId:ws.id,title:'Audit'});assert.ok(session.ok);
 const sent=await f.router.handle('chat.sendMessage',{sessionId:(session.value as {id:string}).id,text:'Analyze this project'});assert.ok(sent.ok,JSON.stringify(sent));
 const run=await f.services.orchestration.waitFor((sent.value as {run:{id:string}}).run.id,30000);
 if(manual){assert.equal(calls.length,0);assert.equal(run.status,'NEEDS_HUMAN');}
 else{assert.equal(calls.length,2);for(const call of calls)assert.deepEqual(call.routing,{model:'gpt-5.1-codex-mini',reasoning:'low'});assert.equal(calls[0]!.strictRouting,true);}
 }finally{await f.cleanup();repo.cleanup();}
});

for (const batch of [false,true]) test(`audit P1: worker policy pause remains terminal (${batch?'DAG':'single'})`,async()=>{
 const repo=createGitFixture();
 const decision=JSON.stringify({action:'delegate',task:'Analyze design',...(batch?{delegations:[{taskId:'inspect',workerId:'worker-1',task:'Analyze design',dependsOn:[],requiresTools:false}]}:{}),acceptanceCriteria:[],verificationCommands:[]});
 const orchestrator=new ScriptedAgent('mock-codex','Supervisor',[decision]);
 const worker=new ScriptedAgent('mock-claude','Worker',['must not run']);
 const f=createDesktopFixture({fastPath:false,maxIterations:3,createRunners:async()=>({orchestrator,worker,workerAccountId:null,workerRouting:{provider:'anthropic',selection:'auto',manual:{model:null,reasoning:null},capabilities:async()=>({modelFlag:false,effortFlag:false,declaredModels:null,declaredEfforts:null})}})});
 try{
 const ws=f.services.workspaces.create({name:'Policy pause',localPath:repo.dir});
 f.services.workspaces.setTeam(ws.id,{accountId:f.services.accounts.create('Supervisor','openai').id},{accountId:f.services.accounts.create('Worker','anthropic').id});
 const session=await f.router.handle('chat.createSession',{workspaceId:ws.id,title:'Policy pause'});assert.ok(session.ok);
 const sent=await f.router.handle('chat.sendMessage',{sessionId:(session.value as {id:string}).id,text:'Analyze architecture'});assert.ok(sent.ok,JSON.stringify(sent));
 const run=await f.services.orchestration.waitFor((sent.value as {run:{id:string}}).run.id,30000);
 assert.equal(run.status,'NEEDS_HUMAN');assert.equal(orchestrator.calls.length,1,'no second supervisor call after policy pause');assert.equal(worker.calls.length,0);
 const stored=f.services.database.runs.require(run.id);assert.match(String(stored.termination_reason??''),/política/);
 }finally{await f.cleanup();repo.cleanup();}
});
