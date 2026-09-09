import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDelegations, readyDelegations } from '../src/orchestrator/delegation-plan.js';
const task=(taskId:string,dependsOn:string[]=[])=>({taskId,workerId:taskId,task:'Analisar',dependsOn,requiresTools:false});
test('explicit dependencies enforce a join before dependent work and cap shared runtimes',()=>{
 const tasks=validateDelegations([task('a'),task('b'),task('c',['a','b'])]);
 const pending=new Set(['a','b','c']);
 assert.deepEqual(readyDelegations(tasks,new Set(),pending,t=>t.workerId,3).map(t=>t.taskId),['a','b']);
 assert.equal(readyDelegations(tasks,new Set(),pending,()=> 'shared',3).length,1);
 assert.deepEqual(readyDelegations(tasks,new Set(['a','b']),new Set(['c']),t=>t.workerId,3).map(t=>t.taskId),['c']);
});
test('cycles, duplicate ids and unknown dependencies are rejected before invoking anything',()=>{
 for(const tasks of [[task('a',['b']),task('b',['a'])],[task('a'),task('a')],[task('a',['missing'])]]) assert.throws(()=>validateDelegations(tasks));
});
