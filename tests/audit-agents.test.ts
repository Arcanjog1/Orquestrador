import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopFixture,ScriptedAgent} from './helpers/desktop-fixture.js';
import {createGitFixture} from './helpers/git-fixture.js';
import type {AgentInputView,WorkspaceView} from '../apps/desktop/src/shared/ipc-contract.js';
import {Database} from '../src/database/database.js';

test('audit P1: agents CRUD, same-account identities, validation and restart',async()=>{
 const f=createDesktopFixture();const repo=createGitFixture();
 try{
 const account=f.services.accounts.create('Account','anthropic');
 const codex=f.services.accounts.create('Supervisor','openai');
 const input:AgentInputView={name:'Backend',role:'CODING_WORKER',provider:'anthropic',accountId:account.id,model:'sonnet',reasoning:'medium',maxCapability:'BALANCED',maxReasoning:'MEDIUM',enabled:true};
 const a=f.services.agents.create(input),b=f.services.agents.create(input);
 assert.notEqual(a.id,b.id);assert.equal(a.accountId,b.accountId);
 assert.throws(()=>f.services.agents.create({...input,provider:'openai'}),/provedor/);
 assert.throws(()=>f.services.agents.create({...input,model:'not-a-model'}),/Modelo/);
 assert.throws(()=>f.services.agents.create({...input,accountId:codex.id}),/conta/);
 const ws=f.services.workspaces.create({name:'Test',localPath:repo.dir});
 const bound=f.services.workspaces.setTeam(ws.id,{accountId:codex.id},[{agentId:a.id,accountId:account.id},{agentId:b.id,accountId:account.id}]);
 assert.deepEqual(bound.team.workers.map(w=>w.agentId),[a.id,b.id]);
 const session=f.services.database.chat.createSession({id:'chat-audit',workspaceId:ws.id,title:'Identity'});
 for(const [agent,providerSession] of [[a,'session-a'],[b,'session-b']] as const) f.services.database.agentSessions.remember({chatSessionId:session.id,connectionId:account.id,agentScope:agent.id,providerSessionId:providerSession,adapterId:'claude-code',workingDirectory:repo.dir});
 assert.equal(f.services.database.agentSessions.find(session.id,account.id,repo.dir,a.id)?.provider_session_id,'session-a');
 assert.equal(f.services.database.agentSessions.find(session.id,account.id,repo.dir,b.id)?.provider_session_id,'session-b');
 f.services.agents.update(a.id,{...input,name:'Review',enabled:false});
 assert.throws(()=>f.services.workspaces.setTeam(ws.id,{accountId:codex.id},{agentId:a.id,accountId:account.id}),/ativo/);
 const reopened=new Database({paths:f.paths});try{assert.equal(reopened.agents.require(a.id).display_name,'Review');assert.equal(reopened.agents.require(a.id).enabled,0);assert.equal(reopened.agentSessions.find(session.id,account.id,repo.dir,b.id)?.provider_session_id,'session-b');}finally{reopened.close();}
 f.services.agents.remove(b.id);f.services.agents.sync();assert.equal(f.services.agents.manage().some(x=>x.id===b.id),false);
 assert.equal(f.services.database.agents.require(b.id).enabled,-1);
 }finally{await f.cleanup();repo.cleanup();}
});

test('audit: two managed agents on one account retain separate invocations and provider sessions',async()=>{
 const repo=createGitFixture();let accountId='',agentA='',agentB='';
 const a=new ScriptedAgent('mock-claude','Backend',['Backend analysis']);a.sessionId='provider-session-a';
 const b=new ScriptedAgent('mock-claude','Review',['Review analysis']);b.sessionId='provider-session-b';
 const delegate=(workerId:string)=>JSON.stringify({action:'delegate',workerId,task:'Analyze design',acceptanceCriteria:[],verificationCommands:[]});
 const o=new ScriptedAgent('mock-codex','Supervisor',[delegate('worker-1'),delegate('worker-2'),JSON.stringify({action:'blocked',reason:'Audit complete',acceptanceCriteria:[],verificationCommands:[]})]);
 const f=createDesktopFixture({fastPath:false,createRunners:async()=>({orchestrator:o,worker:a,workerAccountId:accountId,workers:[{id:'worker-1',label:'Backend',agentId:agentA,accountId,providerId:'anthropic',connectionKind:'cli',runner:a},{id:'worker-2',label:'Review',agentId:agentB,accountId,providerId:'anthropic',connectionKind:'cli',runner:b}]})});
 try{
 accountId=f.services.accounts.create('Shared','anthropic').id;f.services.database.accounts.updateAuth(accountId,'connected','fixture');
 const input:AgentInputView={name:'Backend',role:'CODING_WORKER',provider:'anthropic',accountId,model:null,reasoning:null,maxCapability:null,maxReasoning:null,enabled:true};
 agentA=f.services.agents.create(input).id;agentB=f.services.agents.create({...input,name:'Review'}).id;
 const ws=f.services.workspaces.create({name:'Identity run',localPath:repo.dir});f.services.workspaces.setTeam(ws.id,{accountId:f.services.accounts.create('Supervisor','openai').id},[{accountId,agentId:agentA},{accountId,agentId:agentB}]);
 const session=await f.router.handle('chat.createSession',{workspaceId:ws.id,title:'Identity run'});assert.ok(session.ok);const sessionId=(session.value as {id:string}).id;
 const sent=await f.router.handle('chat.sendMessage',{sessionId,text:'Analyze the architecture'});assert.ok(sent.ok);const runId=(sent.value as {run:{id:string}}).run.id;await f.services.orchestration.waitFor(runId,30000);
 const calls=f.services.database.runs.invocations(runId).filter(i=>i.role==='CODING_WORKER');assert.deepEqual(calls.map(i=>i.agent_id),[agentA,agentB]);assert.ok(calls.every(i=>i.account_id===accountId));
 assert.equal(f.services.database.agentSessions.find(sessionId,accountId,repo.dir,agentA)?.provider_session_id,'provider-session-a');assert.equal(f.services.database.agentSessions.find(sessionId,accountId,repo.dir,agentB)?.provider_session_id,'provider-session-b');
 }finally{await f.cleanup();repo.cleanup();}
});
