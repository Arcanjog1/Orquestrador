import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDone, type DoneGateInput } from '../src/orchestrator/done-gate.js';
import { classifyObjective } from '../src/orchestrator/objective-intent.js';
import { AcceptanceCriteriaLedger } from '../src/orchestrator/acceptance-criteria.js';
import { Verifier } from '../src/orchestrator/verifier.js';
import { ProcessManager } from '../src/process/process-manager.js';
function input(objective:string,allowNoChanges=false) {
  const base:DoneGateInput={ledger:new AcceptanceCriteriaLedger(),verificationCommands:[],iterations:[],baseline:{capturedAt:'now',isGitRepository:true,commit:'abc',branch:'main',statusShort:'',unstagedDiff:'',stagedDiff:'',modifiedFiles:[],stagedFiles:[],dirty:false},evidence:{collectedAt:'now',isGitRepository:true,commit:'abc',branch:'main',statusShort:'',diff:'',diffStat:'',changedFiles:[],addedFiles:[],deletedFiles:[],changedSinceBaseline:false},verifier:new Verifier({cwd:process.cwd(),timeoutMs:3000,processManager:new ProcessManager()}),allowNoChanges};
  return {...base,objectiveIntent:classifyObjective(objective),objectiveProofProblems:[] as string[]};
}
test('read-only gate accepts independently proven access without a diff',async()=>assert.equal((await evaluateDone(input('consegue acessar esse repositorio?'))).passed,true));
test('execution gate refuses an answer without any actual execution',async()=>assert.equal((await evaluateDone(input('rode os testes',true))).passed,false));
test('change intent cannot use the read-only exemption',async()=>assert.equal((await evaluateDone(input('corrija o README',true))).passed,false));
test('a missing content proof blocks a read query even with an empty ledger',async()=>{
  const request=input('leia o README',true);request.objectiveProofProblems=['Missing FILE_CONTENT'];
  assert.equal((await evaluateDone(request)).passed,false);
});
test('execution requires a real successful command, with captured output, but no diff',async()=>{
  const request=input('rode os testes');
  request.verificationCommands=[`"${process.execPath}" -e "console.log('executed')"`];
  const result=await evaluateDone(request);
  assert.equal(result.passed,true,result.failures.join('; '));
  assert.equal(result.verification[0]?.exitCode,0);
  assert.match(result.verification[0]!.stdout,/executed/);
});
test('mixed execution and change retains both obligations',async()=>{
  const request=input('rode os testes e ajuste o que falhar',true);
  request.verificationCommands=[`"${process.execPath}" -e "process.exit(0)"`];
  assert.equal((await evaluateDone(request)).passed,false,'execution alone is insufficient');
  request.evidence={...request.evidence,changedSinceBaseline:true,changedFiles:['fix.ts']};
  assert.equal((await evaluateDone(request)).passed,true);
  request.verificationCommands=[];
  assert.equal((await evaluateDone(request)).passed,false,'diff alone is insufficient');
});
