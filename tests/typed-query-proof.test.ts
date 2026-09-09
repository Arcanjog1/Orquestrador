import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryProofProblems, readProofProblems, type QueryEvidence } from '../src/orchestrator/query-proof.js';
import { classifyObjective } from '../src/orchestrator/objective-intent.js';
import type { FileReadResult } from '../src/verification/file-check.js';
const snapshot={repository:'Arcanjog1/teste',branch:'main',commit:'abc'};
const facts:QueryEvidence[]=[{kind:'REPOSITORY_ACCESS',...snapshot},{kind:'REPOSITORY_METADATA',...snapshot},{kind:'REPOSITORY_TREE',...snapshot,paths:['README.md'],complete:true},{kind:'FILE_EXISTENCE',...snapshot,paths:['README.md'],complete:true},{kind:'COMMIT',...snapshot,commits:[{sha:'abc',message:'Initial'}]}];
const proof={criteria:[],citations:[]};
const read:FileReadResult={request:{path:'README.md'},ok:true,outcome:'ok',resolvedPath:'README.md',text:'# teste\n',sizeBytes:8,sha256:'actual-read-hash',truncated:false,problem:null};
for(const phrase of ['consegue acessar esse repositorio?','qual é a branch principal?','quais arquivos tem aqui?','README.md existe?','consulte os commits'])test('typed metadata proof needs no file citation: '+phrase,()=>{
  assert.deepEqual(queryProofProblems(phrase,'Arcanjog1/teste: main, README.md; commit abc.',proof,[],facts),[]);
  assert.ok(queryProofProblems(phrase,'Acesso confirmado.',proof,[],[]).length);
});
test('metadata cannot satisfy a content question; content must be delivered and quoted exactly',()=>{
  assert.ok(queryProofProblems('leia o README','README.md contém teste',proof,[],facts).length);
  const grounded={criteria:[],citations:[{path:'README.md',quote:'# teste'}]};
  assert.deepEqual(queryProofProblems('leia o README','README.md contém teste',grounded,[read],facts),[]);
  assert.ok(queryProofProblems('leia o README','README.md contém teste',grounded,[{...read,text:null}],facts).length);
  assert.ok(queryProofProblems('leia o README','README.md contém teste',{...grounded,citations:[{path:'README.md',quote:'inventado'}]},[read],facts).length);
});
test('truncated listing cannot prove an absent file or an exhaustive tree',()=>{
  const partial=facts.map(e=>({...e,complete:false}));
  assert.ok(queryProofProblems('quais arquivos tem aqui?','README.md',proof,[],partial).length);
  assert.ok(queryProofProblems('ausente.txt existe?','Não',proof,[],partial).length);
  assert.deepEqual(queryProofProblems('README.md existe?','Sim',proof,[],partial),[]);
});
test('mixed tasks retain their content proof as well as the change/execution obligations',()=>{
  const intent=classifyObjective('leia README.md e corrija o erro');
  assert.equal(intent.requiresChanges,true);
  assert.ok(readProofProblems(intent,'Corrigido',undefined,[],facts).length);
});
