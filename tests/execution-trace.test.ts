import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import { createGitFixture } from './helpers/git-fixture.js';
import { Database, DATABASE_FILENAME } from '../src/database/database.js';
import { terminalExecutionStatuses } from '../src/execution/events.js';
import { DelegationProgressGuard, progressFingerprint } from '../src/orchestrator/progress-guard.js';
import { executionGraph } from '../apps/desktop/src/shared/execution-graph.js';
import { chronologicalTrace, activityTrace } from '../apps/desktop/src/shared/execution-trace.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';
import type { RunStatus } from '../src/database/repositories.js';
import { encodeEventData } from '../src/database/execution-events.js';
import { parseMission } from '../src/orchestrator/mission-brief.js';
import { buildWorkerPrompt } from '../src/orchestrator/worker-prompt.js';

function value<T>(r:IpcResult<unknown>):T {assert.equal(r.ok,true,r.ok?'':r.error.message);return (r as {value:T}).value;}

for(const status of terminalExecutionStatuses) test(`${status}: exactly one durable final, including replay and late completion`,async()=>{
  const f=createDesktopFixture();
  try {
    const w=f.services.workspaces.createConversation({name:'Trace'});
    const s=f.services.database.chat.createSession({id:'trace-session',workspaceId:w.id,title:'Trace'});
    const runs=f.services.database.runs;
    runs.create({id:'trace-run',sessionId:s.id,workspaceId:w.id,objective:'Objetivo',orchestratorAgentId:null,maxIterations:4});
    runs.recordInvocation({runId:'trace-run',iteration:1,agentId:null,accountId:null,role:'CODING_WORKER',task:'Tarefa',outcome:'running',exitCode:null,durationMs:null,startedAt:new Date().toISOString()});
    runs.setStatus('trace-run',status as RunStatus,'Motivo registrado');
    runs.setStatus('trace-run',status as RunStatus,'Motivo registrado');
    const finals=runs.events('trace-run').filter(e=>e.type==='FINAL_RESPONSE');
    assert.equal(finals.length,1);
    assert.equal(finals[0]!.status,status);
    assert.equal(f.services.database.chat.listMessages(s.id).filter(m=>JSON.parse(m.payload ?? '{}').kind==='final').length,1);
    const detail=f.services.orchestration.detail('trace-run');
    assert.ok(executionGraph(detail).nodes.every(n=>!['running','started','pending'].includes(n.status)));
    const reopened=new Database({filePath:join(f.paths.data,DATABASE_FILENAME)});
    try {assert.deepEqual(reopened.runs.events('trace-run'),runs.events('trace-run'));}finally{reopened.close();}
  }finally{await f.cleanup();}
});

test('permission continuation retains the human pause and publishes one new final',async()=>{
  const f=createDesktopFixture();try{
    const w=f.services.workspaces.createConversation({name:'Trace'}),runs=f.services.database.runs;
    runs.create({id:'r',sessionId:null,workspaceId:w.id,objective:'Task',orchestratorAgentId:null,maxIterations:3});
    runs.setStatus('r','NEEDS_HUMAN','Autorize a operação.');runs.setStatus('r','RUNNING');
    assert.equal(runs.events('r').filter(e=>e.type==='FINAL_RESPONSE').length,0);
    assert.equal(runs.events('r').filter(e=>e.type==='NEEDS_HUMAN').length,1);
    runs.setStatus('r','DONE','Concluído');
    assert.equal(runs.events('r').filter(e=>e.type==='FINAL_RESPONSE').length,1);
  }finally{await f.cleanup();}
});

test('progress facts deduplicate reads, timestamps and call counters; changed bytes remain progress',()=>{
  assert.equal(progressFingerprint({reads:[['a','hash']],iteration:1}),progressFingerprint({iteration:9,reads:[['a','hash'],['a','hash']]}));
  const g=new DelegationProgressGuard();assert.equal(g.admit({task:'Verificar!'}, {hash:'abc'}),true);
  assert.equal(g.admit({task:'verificar'}, {hash:'abc'}),false);
  assert.equal(g.admit({task:'verificar'}, {hash:'xyz'}),true);
  assert.notEqual(progressFingerprint({path:'A.ts'}),progressFingerprint({path:'a.ts'}));
});

async function runSmall(stagnant:boolean) {
  const repo=createGitFixture('trace-controlled-');repo.write('README.md','# Scratch');repo.commitAll('baseline');
  const criterion='hello.txt contém pronto';
  const decision=JSON.stringify({action:'delegate',task:'Crie hello.txt com pronto',acceptanceCriteria:[criterion],fileChecks:[{path:'hello.txt',expectText:'pronto',criteria:[criterion]}],summary:'Vou verificar.'});
  const lead=new ScriptedAgent('mock-codex','Codex',[decision,decision,decision,decision]);
  const worker=new ScriptedAgent('mock-claude','Worker',stagnant?['Não consegui.','Não consegui!','Não consegui.']:[input=>{writeFileSync(join(input.workingDirectory,'hello.txt'),'pronto');return 'Arquivo hello.txt corrigido.';}]);
  const f=createDesktopFixture({createRunners:async()=>({orchestrator:lead,worker,workerAccountId:null}),maxIterations:4,fastPath:!stagnant});
  try {
    const w=value<{id:string}>(await f.router.handle('workspace.create',{name:'Scratch',localPath:repo.dir}));
    value(await f.router.handle('accounts.create',{name:'Worker',provider:'anthropic'}));
    const agents=value<{id:string;role:string}[]>(await f.router.handle('agents.list',null));
    value(await f.router.handle('workspace.setAgents',{workspaceId:w.id,orchestratorAgentId:agents.find(a=>a.role==='ORCHESTRATOR')!.id,workerAgentId:agents.find(a=>a.role==='CODING_WORKER')!.id}));
    const session=value<{id:string}>(await f.router.handle('chat.createSession',{workspaceId:w.id,title:'Controlled run'}));
    const sent=value<{run:{id:string}}>(await f.router.handle('chat.sendMessage',{sessionId:session.id,text:'Crie hello.txt com pronto e valide seu conteúdo.'}));
    const run=await f.services.orchestration.waitFor(sent.run.id);
    const detail=f.services.orchestration.detail(run.id),events=detail.executionEvents!;
    assert.equal(events.filter(e=>e.type==='FINAL_RESPONSE').length,1);
    if(stagnant){assert.equal(run.status,'FAILED');assert.ok(worker.calls.length<=2,`no third redundant worker: ${worker.calls.length}`);assert.match(run.summary ?? '',/progresso|evidência nova|STAGNATION/);}
    else{
      assert.equal(run.status,'DONE');assert.equal(worker.calls.length,1);assert.equal(readFileSync(join(repo.dir,'hello.txt'),'utf8'),'pronto');
      assert.ok(events.some(e=>e.type==='PLAN_CREATED'));
      assert.ok(events.some(e=>e.type==='DELEGATION_STARTED'));
      assert.equal(events.filter(e=>e.type==='REVIEW_RESULT'&&e.status==='passed').length,1,'one DoneGate review, no diagnostic echo');
      assert.ok(events.findIndex(e=>e.type==='PLAN_CREATED')<events.findIndex(e=>e.type==='DELEGATION_STARTED'));
      assert.ok(events.filter(e=>e.role==='ORCHESTRATOR'&&e.type!=='FINAL_RESPONSE').every(e=>!e.summary.includes('Arquivo hello.txt corrigido')),'supervisor never echoes worker');
      const graph=executionGraph(detail),linear=chronologicalTrace(detail);
      const plan=events.find(e=>e.type==='PLAN_CREATED')!;
      const next=events.find(e=>e.type==='REVIEW_REQUESTED')!;
      assert.equal(next.parentId,plan.id,'the first action follows its plan');
      assert.deepEqual(graph.nodes.flatMap(n=>n.sourceIds).sort(),linear.flatMap(n=>n.sourceIds).sort());
      assert.equal(graph.nodes.length,5);assert.equal(linear.length,6);
      assert.deepEqual(activityTrace(detail).filter(n=>n.invocation).map(n=>n.invocation!.id),linear.filter(n=>n.invocation).map(n=>n.invocation!.id));
      // Changing old chat messages cannot change either modern projection.
      assert.deepEqual(executionGraph(detail,[{text:'unrelated'} as never]),graph);
      assert.deepEqual(executionGraph(JSON.parse(JSON.stringify(detail))),graph);
    }
  }finally{await f.cleanup();repo.cleanup();}
}
test('three equivalent worker outputs never cause a third redundant invocation',()=>runSmall(true));
test('controlled small task writes real bytes, verifies them and returns one final; all views share sources',()=>runSmall(false));

test('structured mission preserves scope and rejects missing completion criteria',()=>{
  const mission={expectedResult:'Arquivo corrigido',acceptanceCriteria:['hello correto'],evidence:['bytes'],relevantFiles:['hello.txt'],constraints:['não publicar'],outOfScope:['README']};
  assert.deepEqual(parseMission(mission),mission);
  assert.throws(()=>parseMission({...mission,acceptanceCriteria:[]}));
  assert.throws(()=>parseMission({...mission,shell:'rm'}));
  const prompt=buildWorkerPrompt({preamble:'Policy',task:'Corrigir hello',criteria:mission.acceptanceCriteria,mission}).text;
  for(const text of ['Arquivo corrigido','bytes','hello.txt','não publicar','README','hello correto'])assert.ok(prompt.includes(text));
});

test('event redaction never corrupts JSON, including a quoted token inside a result',()=>{
  const encoded=encodeEventData({token:'secret',report:{sessionId:'a-session',fullOutput:'access_token="abcdefghijklmnopqrstuv"'}});
  assert.doesNotThrow(()=>JSON.parse(encoded));assert.ok(!encoded.includes('abcdefghijklmnopqrstuv'));
  assert.equal(JSON.parse(encoded).token,'[REDACTED]');
});

test('old run history is imported once; interrupted history retains its real invocation',async()=>{
  const f=createDesktopFixture();try{
    const runs=f.services.database.runs,w=f.services.workspaces.createConversation({name:'Old run'});
    runs.create({id:'legacy',sessionId:null,workspaceId:w.id,objective:'Legacy objective',orchestratorAgentId:null,maxIterations:2});
    runs.recordInvocation({runId:'legacy',iteration:1,agentId:null,accountId:null,role:'CODING_WORKER',task:'Old task',outcome:'running',exitCode:null,durationMs:null,startedAt:new Date().toISOString()});
    f.services.database.driver.run('DELETE FROM execution_events WHERE run_id=?',['legacy']);
    runs.setStatus('legacy','FAILED','Aplicativo interrompido');
    const imported=runs.events('legacy');
    assert.equal(imported.filter(e=>e.type==='USER_OBJECTIVE').length,1);
    assert.equal(imported.filter(e=>e.type==='AGENT_STARTED').length,1);
    f.services.orchestration.detail('legacy');assert.deepEqual(runs.events('legacy'),imported);
    runs.addStep({runId:'legacy',iteration:1,phase:'evidence',status:'unavailable',summary:'Diagnóstico de encerramento'});
    assert.equal(runs.events('legacy').at(-1)!.type,'FINAL_RESPONSE');
    assert.equal(runs.events('legacy').filter(e=>e.type==='FINAL_RESPONSE').length,1);
  }finally{await f.cleanup();}
});

test('parallel results appear in return order and keep both real branches',async()=>{
  const f=createDesktopFixture();try{
    const runs=f.services.database.runs,w=f.services.workspaces.createConversation({name:'Parallel'});
    runs.create({id:'parallel',sessionId:null,workspaceId:w.id,objective:'Independent analyses',orchestratorAgentId:null,maxIterations:2});
    const base={runId:'parallel',iteration:1,agentId:null,accountId:null,role:'CODING_WORKER',task:'Analyze',exitCode:null,durationMs:null,startedAt:new Date().toISOString()};
    const a=runs.recordInvocation({...base,workerId:'a',outcome:'running'});
    const b=runs.recordInvocation({...base,workerId:'b',outcome:'running'});
    runs.recordInvocation({...base,id:b,workerId:'b',outcome:'completed',exitCode:0});
    runs.recordInvocation({...base,id:a,workerId:'a',outcome:'completed',exitCode:0});
    runs.setStatus('parallel','DONE','Reviewed');
    const detail=f.services.orchestration.detail('parallel');
    assert.deepEqual(chronologicalTrace(detail).filter(n=>n.kind==='worker').map(n=>n.invocation!.id),[b,a]);
    const graph=executionGraph(detail);
    assert.equal(graph.nodes.filter(n=>n.kind==='worker').length,2);
    assert.equal(graph.edges.filter(e=>e.kind==='join'&&e.to==='end:parallel').length,2);
  }finally{await f.cleanup();}
});
