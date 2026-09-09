import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionGraph, compactText } from '../apps/desktop/src/shared/execution-graph.js';
import type { RunDetailView, RunInvocationView } from '../apps/desktop/src/shared/ipc-contract.js';
const time=(n:number)=>new Date(1700000000000+n*1000).toISOString();
const inv=(id:string,start:number,end:number|null,role='CODING_WORKER'):RunInvocationView => ({id,agentId:id,workerId:id,iteration:1,role,task:'Analisar '+id,outcome:end===null?'running':'completed',startedAt:time(start),finishedAt:end===null?null:time(end),exitCode:0,durationMs:end===null?null:(end-start)*1000} as RunInvocationView);
const detail=(status='DONE',invocations:RunInvocationView[]=[]):RunDetailView=>({run:{id:'run1',sessionId:'s1',workspaceId:'w1',failureKind:null,objective:'Analisar projeto',startedAt:time(0),finishedAt:status==='RUNNING'?null:time(10),status,iterations:1,summary:'Resultado'},steps:[{id:1,iteration:1,phase:'task-join',status:'completed',summary:'Resultados reunidos',detail:null,startedAt:time(9),durationMs:0}],invocations,verifications:[],providerSessions:[],baseline:{branch:'dev',commit:'sha',dirty:false}} as RunDetailView);

test('zero invocations never creates phantom agents; rebuilding is deterministic',()=>{
 const d=detail();const a=executionGraph(d),b=executionGraph(JSON.parse(JSON.stringify(d)));
 assert.deepEqual(a,b);assert.ok(!a.nodes.some(n=>n.kind==='worker'||n.kind==='orchestrator'));assert.equal(a.nodes.at(-1)?.kind,'done');
});
test('overlapping workers produce two branches and a join, sequential workers do not',()=>{
 for(const parallel of [true,false]) {
  const graph=executionGraph(detail('DONE',[inv('codex',1,2,'ORCHESTRATOR'),inv('a',3,5),inv('b',parallel?3.2:6,8)]));
  const a=graph.nodes.find(n=>n.id==='inv:a')!, b=graph.nodes.find(n=>n.id==='inv:b')!;
  assert.equal(a.row===b.row,parallel);assert.equal(graph.edges.filter(e=>e.kind==='join').length,parallel?2:0);
  for(const edge of graph.edges) assert.ok(graph.nodes.find(n=>n.id===edge.from)!.row<graph.nodes.find(n=>n.id===edge.to)!.row);
 }
});
test('all terminal statuses suppress running invocations, including a late result and human gate',()=>{
 for(const status of ['DONE','FAILED','CANCELLED','BLOCKED','NEEDS_HUMAN']) {
  const graph=executionGraph(detail(status,[inv('a',2,null)]));
  assert.ok(!graph.nodes.some(n=>n.status==='running'));
  assert.equal(graph.nodes.at(-1)?.kind,['NEEDS_HUMAN','BLOCKED'].includes(status)?'human':status==='DONE'?'done':'error');
 }
});
test('full response is preserved while the summary remains bounded',()=>{
 const text='Resultado importante\n'+'Detalhes completos.\n'.repeat(100);
 const d=detail('DONE',[inv('a',2,5)]);
 const graph=executionGraph(d,[{id:'m1',runId:'run1',report:{invocationId:'a',declared:text,headline:text}} as any]);
 assert.equal(graph.nodes.find(n=>n.id==='inv:a')!.fullText,text);
 assert.ok(compactText(text).length<=220);
});
