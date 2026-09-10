import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RejectedProgressGuard, mechanicalGateFailure, publicGateAnswer, type RejectedRound } from '../src/orchestrator/rejected-progress.js';
const round:RejectedRound={answer:'Sim, acesso confirmado.',reads:[],criteria:[{text:'Tests pass',status:'pending'}],evidence:{collectedAt:'now',isGitRepository:true,commit:'abc',branch:'main',statusShort:'',diff:'',diffStat:'',changedFiles:[],addedFiles:[],deletedFiles:[],changedSinceBaseline:false},gate:{passed:false,failures:['Missing proof'],checkedAt:'now',verification:[]}};
test('two equivalent rejections stop; timestamps and answer punctuation are not progress',()=>{
  const guard=new RejectedProgressGuard();assert.equal(guard.observe(round),false);
  assert.equal(guard.observe({...round,answer:'Sim — acesso confirmado!',gate:{...round.gate,checkedAt:'later'}}),true);
});
test('only new content, criteria or measured result permits another round',()=>{
  for(const updated of [{...round,evidence:{...round.evidence,commit:'def'}},{...round,criteria:[{text:'Tests pass',status:'satisfied'}]},{...round,gate:{...round.gate,failures:['New failure']}}]) {
    const guard=new RejectedProgressGuard();guard.observe(round);assert.equal(guard.observe(updated),false);
  }
});
test('plumbing rejection is mechanical; a genuinely executed failing test is not',()=>{
  assert.equal(mechanicalGateFailure(round.gate),true);
  assert.equal(mechanicalGateFailure({...round.gate,verification:[{command:'test',exitCode:null,stdout:'',stderr:'',durationMs:0,refused:'No executor',timedOut:false}]}),true);
  assert.equal(mechanicalGateFailure({...round.gate,verification:[{command:'test',exitCode:1,stdout:'',stderr:'assertion failed',durationMs:1,timedOut:false}]}),false);
  assert.equal(mechanicalGateFailure({...round.gate,verification:[{command:'test',exitCode:null,stdout:'',stderr:'spawn error',durationMs:1,timedOut:false}]}),true);
  assert.equal(mechanicalGateFailure({...round.gate,verification:[{command:'test',exitCode:1,stdout:'',stderr:'timeout',durationMs:1,timedOut:true}]}),true);
});
test('internal gate flags never become user instructions',()=>assert.ok(!publicGateAnswer('Reexecute com --allow-no-changes.').includes('--')));
