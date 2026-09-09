import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopFixture,ScriptedAgent} from './helpers/desktop-fixture.js';
import {AgentExecutionPolicy} from '../apps/desktop/src/main/services/agent-execution-policy.js';
import {defaultAgentPolicy,type ModelPolicy} from '../apps/desktop/src/shared/agent-policy.js';
import type {AgentInputView} from '../apps/desktop/src/shared/ipc-contract.js';
import type {AgentInput} from '../src/core/types.js';
import {ClaudeCodeAdapter} from '../apps/desktop/src/main/adapters/claude-adapter.js';
import type {ProcessRunner} from '../src/execution/process-runner.js';
const caps={modelFlag:true,effortFlag:true,declaredModels:['sonnet','opus','haiku','gpt-test'],declaredEfforts:['low','medium','high']};
function prepare(role='CODING_WORKER') {
 const f=createDesktopFixture();const db=f.services.database;
 const account=f.services.accounts.create('Account A','anthropic');db.accounts.updateAuth(account.id,'connected','fixture');
 const config:AgentInputView={name:'Agent A',provider:'anthropic',accountId:account.id,role,enabled:true,model:'sonnet',reasoning:null,maxCapability:null,maxReasoning:null,policy:defaultAgentPolicy(role,'sonnet')};
 const agent=f.services.agents.create(config);
 const ws=db.workspaces.create({id:'ws-policy',name:'Policy',localPath:f.paths.root,environment:'conversation'});
 const run=db.runs.create({id:'run-policy',workspaceId:ws.id,sessionId:null,objective:'Policy test',orchestratorAgentId:null,maxIterations:4});db.runs.setStatus(run.id,'RUNNING');
 const runner=new ScriptedAgent('mock-claude','fixture',['ok']);
 const boundary=new AgentExecutionPolicy(db);
 const args:AgentInput={prompt:'test',runId:run.id,workingDirectory:f.paths.root,iteration:1,timeoutMs:60000,routing:{model:'opus',reasoning:'high'}};
 const invoke=()=>boundary.invoke({workspaceId:ws.id,agentId:agent.id,accountId:account.id,runner,args,capabilities:caps});
 return {f,db,config,account,agent,ws,run,runner,boundary,args,invoke};
}
const blocked=(modelId:string):ModelPolicy=>({modelId,provider:'anthropic',allowed:false,premium:false,confirmationRequired:false,allowedRoles:[],capability:null});
test('a supervisor model confirmation pauses with zero invocations and resumes the same run over IPC',async()=>{
 const supervisor=new ScriptedAgent('mock-claude','Supervisor',[JSON.stringify({action:'blocked',reason:'Test complete',acceptanceCriteria:[],verificationCommands:[]})]);
 Object.assign(supervisor,{describeCapabilities:async()=>caps});
 const worker=new ScriptedAgent('mock-claude','Worker',[]);
 const f=createDesktopFixture({fastPath:false,createRunners:async()=>({orchestrator:supervisor,worker,workerAccountId:null})});
 try {
  const db=f.services.database;const account=f.services.accounts.create('Claude supervisor','anthropic');db.accounts.updateAuth(account.id,'connected','fixture');
  const agent=f.services.agents.create({name:'Supervisor',role:'ORCHESTRATOR',provider:'anthropic',accountId:account.id,model:'sonnet',reasoning:null,maxCapability:null,maxReasoning:null,enabled:true,policy:defaultAgentPolicy('ORCHESTRATOR','sonnet')});
  const ws=db.workspaces.create({id:'ws-confirm',name:'Confirm',localPath:f.paths.root,environment:'conversation'});
  f.services.workspaces.setTeam(ws.id,{accountId:account.id,agentId:agent.id},{accountId:account.id});
  f.services.agents.savePolicies({models:[{...blocked('sonnet'),allowed:true,confirmationRequired:true}],defaults:{},routing:{}});
  db.chat.createSession({id:'session-confirm',workspaceId:ws.id,title:'Confirm'});
  const sent=f.services.chat.sendMessage('session-confirm','Analyze architecture');await f.services.orchestration.waitFor(sent.run.id,10000);
  assert.equal(db.runs.require(sent.run.id).status,'NEEDS_HUMAN');assert.equal(supervisor.calls.length,0);assert.equal(db.runs.invocations(sent.run.id).length,0);
  const approved=await f.router.handle('agents.confirmModel',{runId:sent.run.id,agentId:agent.id,model:'sonnet'});assert.equal(approved.ok,true,JSON.stringify(approved));
  await f.services.orchestration.waitFor(sent.run.id,10000);assert.equal(supervisor.calls.length,1);assert.equal(db.runs.listForSession('session-confirm').length,1);
 } finally {await f.cleanup();}
});

test('default teams are inherited by new projects and never rewrite existing project teams',async()=>{const p=prepare();try{
 const supervisor=p.f.services.agents.create({...p.config,name:'Supervisor',role:'ORCHESTRATOR',policy:defaultAgentPolicy('ORCHESTRATOR','sonnet')});
 p.f.services.agents.savePolicies({models:[],defaults:{},routing:{},defaultTeam:{orchestrator:supervisor.id,agents:[p.agent.id]}});
 const ws=p.db.workspaces.create({id:'ws-default-team',name:'New',localPath:p.f.paths.root,environment:'conversation'});
 assert.equal(ws.orchestrator_agent_id,supervisor.id);assert.equal(ws.worker_agent_id,p.agent.id);assert.equal(p.db.workspaces.require(p.ws.id).worker_agent_id,null);
}finally{await p.f.cleanup();}});
test('every call rechecks global policy; fixed sent model never follows the requested escalation',async()=>{const p=prepare();try{await p.invoke();assert.equal(p.runner.calls[0]?.routing?.model,'sonnet');p.f.services.agents.savePolicies({models:[blocked('sonnet')],defaults:{},routing:{}});const result=await p.invoke();assert.equal(result.invocationSkipped,true);assert.equal(p.runner.calls.length,1);assert.equal(p.db.runs.require(p.run.id).status,'NEEDS_HUMAN');}finally{await p.f.cleanup();}});
test('attempt ceiling includes repeated calls and persists in the database',async()=>{const p=prepare();try{p.f.services.agents.update(p.agent.id,{...p.config,policy:{...p.config.policy!,maxAttempts:1}});await p.invoke();const result=await p.invoke();assert.equal(result.invocationSkipped,true);assert.match(result.stderr,/tentativas/);assert.equal(p.runner.calls.length,1);assert.equal(p.boundary.calls(p.run.id).length,2);}finally{await p.f.cleanup();}});
test('premium confirmation is required once per run and invalidated by policy changes',async()=>{const p=prepare();try{const rule={...blocked('sonnet'),allowed:true,confirmationRequired:true};p.f.services.agents.savePolicies({models:[rule],defaults:{},routing:{}});assert.equal((await p.invoke()).invocationSkipped,true);assert.equal(p.runner.calls.length,0);p.boundary.confirm(p.run.id,p.agent.id,'sonnet');await p.invoke();await p.invoke();assert.equal(p.runner.calls.length,2);p.f.services.agents.savePolicies({models:[blocked('sonnet')],defaults:{},routing:{}});assert.equal((await p.invoke()).invocationSkipped,true);assert.equal(p.runner.calls.length,2);}finally{await p.f.cleanup();}});
test('account changes, disabled agents and image roles result in zero provider calls',async()=>{for(const role of ['CODING_WORKER','IMAGE_GENERATOR']){const p=prepare(role);try{if(role==='CODING_WORKER')p.f.services.agents.update(p.agent.id,{...p.config,enabled:false});assert.equal((await p.invoke()).invocationSkipped,true);assert.equal(p.runner.calls.length,0);}finally{await p.f.cleanup();}}});
test('project restrictions and agent read-only tools are passed to the actual runner',async()=>{const p=prepare('ANALYST');try{p.f.services.agents.saveProjectPolicy(p.ws.id,{reasoningCeiling:'low',timeoutMs:5000});await p.invoke();assert.deepEqual(p.runner.calls[0]?.toolPolicy,['read','diff','evidence']);assert.equal(p.runner.calls[0]?.timeoutMs,5000);assert.equal(p.runner.calls[0]?.routing?.reasoning,'low');}finally{await p.f.cleanup();}});
test('IPC accepts a Claude supervisor and OpenAI reviewer while rejecting tool-policy bypass',async()=>{const p=prepare();try{const supervisor=await p.f.router.handle('agents.create',{...p.config,role:'ORCHESTRATOR',policy:defaultAgentPolicy('ORCHESTRATOR','sonnet')});assert.ok(supervisor.ok);const openai=p.f.services.accounts.create('OpenAI A','openai');const reviewer=await p.f.router.handle('agents.create',{...p.config,provider:'openai',accountId:openai.id,role:'ANALYST',model:null,policy:defaultAgentPolicy('ANALYST','gpt-test')});assert.ok(reviewer.ok);const team=p.f.services.workspaces.setTeam(p.ws.id,{accountId:p.account.id,agentId:(supervisor.value as {id:string}).id},{accountId:openai.id,agentId:(reviewer.value as {id:string}).id});assert.equal(team.team.orchestrator.provider,'anthropic');assert.equal(team.team.worker.provider,'openai');const forged=await p.f.router.handle('agents.create',{...p.config,role:'ANALYST',policy:{...defaultAgentPolicy('ANALYST','sonnet'),tools:['read','write']}});assert.equal(forged.ok,false);}finally{await p.f.cleanup();}});
test('invocation snapshots preserve names and roles after rename and soft deletion',async()=>{const p=prepare();try{const id=p.db.runs.recordInvocation({runId:p.run.id,iteration:1,agentId:p.agent.id,accountId:p.account.id,role:'CODING_WORKER',task:'test',outcome:'completed',exitCode:0,durationMs:1,startedAt:new Date().toISOString()});p.db.runs.setStatus(p.run.id,'DONE');p.f.services.agents.update(p.agent.id,{...p.config,name:'Renamed'});p.f.services.agents.remove(p.agent.id);const row=p.db.runs.invocations(p.run.id).find(r=>r.id===id)!;assert.equal(JSON.parse(String(row.agent_snapshot)).name,'Agent A');}finally{await p.f.cleanup();}});
test('Claude tool allowlist excludes shell/write even when the workspace has broader grants',async()=>{
 const calls:Array<{args?:readonly string[]}>=[];
 const help='Usage: claude [options]\nOptions:\n  --print Print\n  --model <model> Model (sonnet, opus, haiku)\n  --effort <level> Effort (low, medium, high)\n  --tools <tools> Tools\n  --strict-mcp-config Strict MCP\n  --permission-mode <mode> Permissions\n  --allowedTools <tools> Allow tools';
 const manager={run:async(options:{args?:string[]})=>{calls.push(options);return {outcome:'completed',exitCode:0,signal:null,stdout:options.args?.includes('--help')?help:'ok',stderr:'',durationMs:1,truncated:false};}} as unknown as ProcessRunner;
 const adapter=new ClaudeCodeAdapter({processManager:manager,resolveExecutable:async()=>'/fake/claude',buildEnvironment:()=>({}),allowedTools:()=>['Bash(*)','Write','Edit']});
 await adapter.run({prompt:'review',runId:'r',iteration:1,workingDirectory:process.cwd(),timeoutMs:1000,toolPolicy:['read','diff','evidence']});
 const args=calls.find(c=>c.args?.includes('--print'))!.args!;assert.equal(args[args.indexOf('--tools')+1],'Read,Glob,Grep');assert.ok(!args.includes('Write'));assert.ok(!args.includes('Bash(*)'));assert.equal(args[args.indexOf('--permission-mode')+1],'default');
});


test('a thrown provider call consumes an attempt and cannot retry beyond the ceiling',async()=>{const p=prepare();try{
 p.f.services.agents.update(p.agent.id,{...p.config,policy:{...p.config.policy!,maxAttempts:1}});
 let calls=0;p.runner.run=async()=>{calls++;throw new Error('mechanical crash');};
 const first=await p.invoke();assert.equal(first.invocationSkipped,false);assert.equal(p.boundary.calls(p.run.id)[0]?.status,'FAILED');
 const second=await p.invoke();assert.equal(second.invocationSkipped,true);assert.equal(calls,1);assert.match(second.stderr,/tentativas/);
}finally{await p.f.cleanup();}});
test('startup recovery closes policy calls without inventing provider usage or observations',async()=>{const p=prepare();try{
 await p.invoke();p.db.driver.run("UPDATE agent_policy_calls SET status='RUNNING',finished_at=NULL,observation=NULL WHERE run_id=?",[p.run.id]);
 p.f.services.orchestration.reconcileInterrupted();const call=p.boundary.calls(p.run.id)[0]!;assert.equal(call.status,'FAILED');assert.equal(call.observation?.failure,'interrupted');assert.equal(call.observation?.usage,null);assert.equal(call.observation?.observed,null);
}finally{await p.f.cleanup();}});
test('explicit Astra and Fable global blocks prevent fixed calls before invocation',async()=>{for(const model of ['astra','fable']){const p=prepare();try{
 p.f.services.agents.update(p.agent.id,{...p.config,policy:defaultAgentPolicy('CODING_WORKER',model)});
 p.f.services.agents.savePolicies({models:[blocked(model)],defaults:{},routing:{}});
 const result=await p.boundary.invoke({workspaceId:p.ws.id,agentId:p.agent.id,accountId:p.account.id,runner:p.runner,args:p.args,capabilities:{...caps,declaredModels:[...caps.declaredModels,model]}});
 assert.equal(result.invocationSkipped,true);assert.equal(p.runner.calls.length,0);
}finally{await p.f.cleanup();}}});
