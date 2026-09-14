import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopFixture } from './helpers/desktop-fixture.js';
import { executionTrace, chronologicalTrace } from '../apps/desktop/src/shared/execution-trace.js';
import { missionLayout, MISSION_NODE_WIDTH, MISSION_NODE_HEIGHT } from '../apps/desktop/src/shared/mission-layout.js';
import { traceSummary, type ExecutionEvent } from '../src/execution/events.js';
import { DelegationProgressGuard } from '../src/orchestrator/progress-guard.js';
import { RejectedProgressGuard, type RejectedRound } from '../src/orchestrator/rejected-progress.js';

test('public summary removes echoed sentences without conflating file names', () => {
  assert.equal(traceSummary('Arquivo A.ts alterado. Arquivo A.ts alterado.\nArquivo a.ts validado.'),
    'Arquivo A.ts alterado.\nArquivo a.ts validado.');
});

test('mission admission preserves case-sensitive paths and literal operators', () => {
  const guard = new DelegationProgressGuard();
  for (const task of ['Write A.ts', 'Write a.ts', 'Set x = a+b', 'Set x = a-b']) {
    assert.equal(guard.admit({task}, {hash:'same'}), true);
    assert.equal(guard.admit({task}, {hash:'same'}), false);
  }
  assert.equal(guard.admit({task:'Write A.ts'}, {hash:'changed'}), true);
});

test('alternating rejected states stop on return; newly measured bytes allow progress', () => {
  const guard = new RejectedProgressGuard();
  const round: RejectedRound = {answer:'Proposta',reads:[],criteria:[],
    evidence:{collectedAt:'now',isGitRepository:true,commit:'abc',branch:'main',statusShort:'',diff:'',diffStat:'',changedFiles:[],addedFiles:[],deletedFiles:[],changedSinceBaseline:false},
    gate:{passed:false,failures:['Missing proof'],checkedAt:'now',verification:[]}};
  assert.equal(guard.observe(round),false);
  assert.equal(guard.observe({...round,gate:{...round.gate,failures:['Different rejection']}}),false);
  assert.equal(guard.observe({...round,answer:'Reworded proposal'}),true);
  assert.equal(guard.observe({...round,evidence:{...round.evidence,diff:'+new measured bytes'}}),false);
});

test('parallel and dependent missions keep complete sources, identities and acyclic paths in both views', async () => {
  const f = createDesktopFixture();
  try {
    const workspace = f.services.workspaces.createConversation({name:'Mission'});
    f.services.database.runs.create({id:'mission',sessionId:null,workspaceId:workspace.id,objective:'Research and review',orchestratorAgentId:null,maxIterations:3});
    const detail = f.services.orchestration.detail('mission');
    const events: ExecutionEvent[] = [];
    const add = (id:string,type:ExecutionEvent['type'],parentId:string|null,data:Record<string,unknown>={},invocationId:string|null=null,role='ORCHESTRATOR') => {
      events.push({id,runId:'mission',sequence:events.length+1,type,parentId,data,invocationId,role,agentId:null,iteration:1,status:'completed',summary:id,timestamp:'2026-09-14T12:00:00Z'});
    };
    add('objective','USER_OBJECTIVE',null);
    add('plan','PLAN_CREATED','objective');
    add('decision','REVIEW_REQUESTED','plan');
    add('delegate-a','DELEGATION_STARTED','decision',{taskId:'research',agentName:'Pesquisador'},'a','RESEARCHER');
    add('start-a','AGENT_STARTED','delegate-a',{taskId:'research',agentName:'Pesquisador'},'a','RESEARCHER');
    add('delegate-b','DELEGATION_STARTED','decision',{taskId:'design',agentName:'Desenhista'},'b','DESIGNER');
    add('start-b','AGENT_STARTED','delegate-b',{taskId:'design',agentName:'Desenhista'},'b','DESIGNER');
    add('result-b','AGENT_RESULT','start-b',{fullOutput:'Design complete'},'b','DESIGNER');
    add('result-a','AGENT_RESULT','start-a',{fullOutput:'Research complete'},'a','RESEARCHER');
    add('delegate-c','DELEGATION_STARTED','plan',{taskId:'review',dependsOn:['research','design'],agentName:'Analista'},'c','ANALYST');
    add('start-c','AGENT_STARTED','delegate-c',{taskId:'review',agentName:'Analista'},'c','ANALYST');
    add('result-c','AGENT_RESULT','start-c',{fullOutput:'Review complete'},'c','ANALYST');
    add('evidence','EVIDENCE_CREATED','result-c');
    add('gate','REVIEW_RESULT','evidence');
    add('final','FINAL_RESPONSE','gate');
    detail.executionEvents = events;
    const graph = executionTrace(detail);
    assert.deepEqual(chronologicalTrace(detail),graph.nodes);
    assert.deepEqual(graph.nodes.flatMap(n=>n.sourceIds).sort(),events.map(e=>e.id).sort());
    const a=graph.nodes.find(n=>n.id==='inv:a')!, b=graph.nodes.find(n=>n.id==='inv:b')!, c=graph.nodes.find(n=>n.id==='inv:c')!;
    assert.equal(a.label,'Pesquisador'); assert.equal(b.label,'Desenhista');
    assert.equal(a.row,b.row);assert.ok(c.row>a.row);
    assert.ok(a.fullText.includes('Research complete') && a.fullText.includes('delegate-a'));
    for (const edge of graph.edges) assert.ok(graph.nodes.find(n=>n.id===edge.to)!.row > graph.nodes.find(n=>n.id===edge.from)!.row,edge.id);
    const placed = missionLayout(graph.nodes);
    for (const [i,node] of placed.entries()) for (const other of placed.slice(i+1)) {
      assert.ok(Math.abs(node.x-other.x)>=MISSION_NODE_WIDTH || Math.abs(node.y-other.y)>=MISSION_NODE_HEIGHT,'nodes never overlap');
    }
    assert.equal(placed.find(n=>n.id===a.id)!.x,placed.find(n=>n.id===b.id)!.x);
    assert.ok(new Set(placed.map(n=>n.y)).size>1,'mission uses vertical space');
  } finally { await f.cleanup(); }
});

test('long final answers retain visible blockers and complete report', async () => {
  const f=createDesktopFixture();
  try {
    const runs=f.services.database.runs, w=f.services.workspaces.createConversation({name:'Final'});
    runs.create({id:'final',sessionId:null,workspaceId:w.id,objective:'Validate delivery',orchestratorAgentId:null,maxIterations:3});
    runs.event({runId:'final',key:'review',type:'REVIEW_RESULT',iteration:1,status:'rejected',summary:'Unverified',data:{criteria:[{text:'Tests must pass',status:'pending'}]}});
    runs.setStatus('final','FAILED','Concrete failure. '.repeat(50));
    const result=runs.events('final').find(e=>e.type==='FINAL_RESPONSE')!;
    assert.ok(result.summary.length<=280);
    assert.match(result.summary,/Pendente: Tests must pass/);
    assert.ok(String(result.data.fullOutput).includes('Concrete failure. '.repeat(20)));
  } finally {await f.cleanup();}
});
