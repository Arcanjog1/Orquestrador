import {test} from 'node:test';import assert from 'node:assert/strict';
import {createDesktopFixture,ScriptedAgent} from './helpers/desktop-fixture.js';
import {createGitFixture} from './helpers/git-fixture.js';
import {makeAgentResult} from '../src/agents/agent-runner.js';
import type {AgentInput} from '../src/core/types.js';
import type {AgentRunner} from '../src/agents/agent-runner.js';

test('audit P1: model refusal on account A never poisons account B fallback',async()=>{
 const repo=createGitFixture();const seen:{a:(string|null)[];b:(string|null)[]}={a:[],b:[]};
 const make=(key:'a'|'b'):AgentRunner=>({kind:'mock-claude',label:key,healthCheck:async()=>({healthy:true}),cancel:async()=>{},run:async(input:AgentInput)=>{seen[key].push(input.routing?.model??null);return makeAgentResult({startedAt:new Date().toISOString(),stdout:'Analysis delivered',...(key==='a'&&seen.a.length===1?{exitCode:1,stderr:'Error: model sonnet is not available',failure:'model-unavailable' as const}: {})});}});
 const a=make('a'),b=make('b');
 const decision=(workerId:string)=>JSON.stringify({action:'delegate',workerId,task:'Analyze the design',acceptanceCriteria:[],verificationCommands:[],workerRequirements:{capability:'BALANCED',reasoning:'MEDIUM'}});
 const orchestrator=new ScriptedAgent('mock-codex','Supervisor',[decision('worker-1'),decision('worker-2'),JSON.stringify({action:'blocked',reason:'Audit complete',acceptanceCriteria:[],verificationCommands:[]})]);
 let aId='',bId='';
 const routing={provider:'anthropic' as const,selection:'auto' as const,manual:{model:null,reasoning:null},capabilities:async()=>({modelFlag:true,effortFlag:true,declaredModels:null,declaredEfforts:['low','medium','high']})};
 const f=createDesktopFixture({fastPath:false,createRunners:async()=>({orchestrator,worker:a,workerAccountId:aId,workers:[{id:'worker-1',label:'A',runner:a,accountId:aId,providerId:'anthropic',connectionKind:'cli',agentId:`agent-worker-${aId}`,routing},{id:'worker-2',label:'B',runner:b,accountId:bId,providerId:'anthropic',connectionKind:'cli',agentId:`agent-worker-${bId}`,routing}]})});
 try{
 aId=f.services.accounts.create('A','anthropic').id;bId=f.services.accounts.create('B','anthropic').id;
 const ws=f.services.workspaces.create({name:'Audit',localPath:repo.dir});
 f.services.workspaces.setTeam(ws.id,{accountId:f.services.accounts.create('Codex','openai').id},[{accountId:aId},{accountId:bId}]);
 const session=await f.router.handle('chat.createSession',{workspaceId:ws.id,title:'Routing'});assert.ok(session.ok);
 const sent=await f.router.handle('chat.sendMessage',{sessionId:(session.value as {id:string}).id,text:'Analyze the architecture'});assert.ok(sent.ok,JSON.stringify(sent));
 await f.services.orchestration.waitFor((sent.value as {run:{id:string}}).run.id,30000);
 assert.equal(seen.a[0],'sonnet');assert.equal(seen.b[0],'sonnet','B must get its own initial choice');
 }finally{await f.cleanup();repo.cleanup();}
});
