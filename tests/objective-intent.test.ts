import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyObjective } from '../src/orchestrator/objective-intent.js';
test('an ability question about available files uses listing evidence; reading contents still needs bytes',()=>{
  assert.deepEqual(classifyObjective('consegue ler os arquivos q tem nesse repositorio?').readProofs,['REPOSITORY_TREE']);
  assert.ok(classifyObjective('leia os arquivos').readProofs.includes('FILE_CONTENT'));
  assert.ok(classifyObjective('consegue ler o conteúdo dos arquivos?').readProofs.includes('FILE_CONTENT'));
});

for(const phrase of ['consegue acessar esse repositorio?','você tem acesso a esse repositório?','consegue ver os arquivos?','quais arquivos tem aqui?','leia o README','qual é a branch principal?','onde está a lógica do botão?','analise esse código','esse arquivo existe?','consulte os commits','consegue ver esse repo?','esse repositório está acessível?','consigo consultar esse projeto?','você consegue abrir esse arquivo?','tem acesso ao GitHub?','o que tem nesse repo?','veja se consegue acessar'])test('read-only: '+phrase,()=>{
  const intent=classifyObjective(phrase);assert.equal(intent.kind,'READ_ONLY_QUERY');assert.equal(intent.requiresChanges,false);assert.equal(intent.requiresExecution,false);
});
for(const phrase of ['corrija o README','crie um arquivo txt','altere a primeira linha','implemente login','remova esse código','mude README','analise o problema e corrija','veja se existe e, se não existir, crie','leia o código e implemente a solução','rode os testes e ajuste o que falhar'])test('change: '+phrase,()=>{
  assert.equal(classifyObjective(phrase).requiresChanges,true);
});
for(const phrase of ['rode os testes','faça build','execute esse script','execute o projeto','abra no navegador'])test('execution: '+phrase,()=>{
  const intent=classifyObjective(phrase);assert.equal(intent.kind,'EXECUTION_REQUEST');assert.equal(intent.requiresChanges,false);assert.equal(intent.requiresExecution,true);
});
test('operation precedence, negation, quoted examples and conservative fallback',()=>{
  assert.equal(classifyObjective('não altere arquivos; leia o README').kind,'READ_ONLY_QUERY');
  assert.equal(classifyObjective('explique como corrigir esse código').kind,'READ_ONLY_QUERY');
  assert.equal(classifyObjective('explique o código e corrija o erro').kind,'MIXED_REQUEST');
  assert.equal(classifyObjective('leia o exemplo "crie um arquivo" no README').kind,'READ_ONLY_QUERY');
  assert.equal(classifyObjective('xyz').requiresChanges,true);
  assert.deepEqual(classifyObjective('consegue acessar esse repositorio?').readProofs,['REPOSITORY_ACCESS']);
  assert.deepEqual(classifyObjective('leia o README').readProofs,['FILE_CONTENT']);
});
