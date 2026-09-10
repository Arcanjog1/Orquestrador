import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import { createGitFixture } from './helpers/git-fixture.js';
import { defaultAgentPolicy } from '../apps/desktop/src/shared/agent-policy.js';
import type { WorkerSlot } from '../apps/desktop/src/main/services/orchestration-service.js';

const caps = {modelFlag:true,effortFlag:true,declaredModels:['sonnet'],declaredEfforts:['low','medium','high']};
const exact = 'AI Orchestrator Team Test\nStatus: OK';
const file = 'orchestrator-team-test.txt';
const criterion = 'sum(2,3) retorna 5';

for (const complexity of ['TRIVIAL','SIMPLE','STANDARD'] as const) test(`${complexity}: configured team is used only when necessary`,async () => {
  const repo = createGitFixture('minimum-team-');
  repo.write('sum.mjs','export const sum = (a,b) => a-b;');
  repo.write('check.mjs',"import assert from 'node:assert/strict';import {sum} from './sum.mjs';assert.equal(sum(2,3),5);assert.equal(sum(-1,1),0);console.log('PASS sum');");
  repo.commitAll('baseline');
  const one = {action:'delegate',task:'Corrija a função sum.',workerId:'coder',taskKind:'IMPLEMENTATION',acceptanceCriteria:[criterion],verificationCommands:['sum']};
  const plans = complexity === 'STANDARD' ? [
    {action:'delegate',task:'Diagnostique a causa do bug.',workerId:'analyst',taskKind:'CODE_REVIEW',acceptanceCriteria:[],fileReads:[{path:'sum.mjs'}]},
    one,
    {action:'delegate',task:'Avalie casos adversariais da correção.',workerId:'tester',taskKind:'TESTING',acceptanceCriteria:[criterion],verificationCommands:['sum']},
    {action:'done',summary:'Causa diagnosticada, corrigida e testada.',acceptanceCriteria:[]},
  ] : complexity === 'SIMPLE' ? [one] : [{action:'delegate',task:'Crie o TXT.',acceptanceCriteria:['TXT exato'],fileChecks:[{path:file,expectText:exact,criteria:['TXT exato']}],delegations:[
    {taskId:'analysis',workerId:'analyst',task:'Analise o TXT.',taskKind:'CODE_REVIEW',requiresTools:true,dependsOn:[]},
    {taskId:'write',workerId:'coder',task:'Escreva o TXT.',taskKind:'IMPLEMENTATION',requiresTools:true,dependsOn:['analysis']},
    {taskId:'test',workerId:'tester',task:'Conte os bytes.',taskKind:'TESTING',requiresTools:true,dependsOn:['write']},
  ]}];
  const lead = new ScriptedAgent('mock-codex','Lead',plans.map(p => JSON.stringify(p)));
  const coder = new ScriptedAgent('mock-claude','Programador',[input => {writeFileSync(join(input.workingDirectory,complexity==='TRIVIAL'?file:'sum.mjs'),complexity==='TRIVIAL'?exact:'export const sum = (a,b) => a+b;');return 'Implementação concluída.';}]);
  const analyst = new ScriptedAgent('mock-claude','Analista',['A função subtrai onde deveria somar.']);
  const tester = new ScriptedAgent('mock-claude','Testador',['Casos adversariais incluem operandos negativos e zero. Validar pelo teste registrado.']);
  const slots: WorkerSlot[] = [];
  const f = createDesktopFixture({createRunners:async () => ({orchestrator:lead,worker:coder,workerAccountId:null,workers:slots}),fastPath:complexity!=='STANDARD',maxIterations:5});
  try {
    const db=f.services.database, account=f.services.accounts.create('Test team','anthropic'); db.accounts.updateAuth(account.id,'connected','test');
    for (const [id,role,runner] of [['analyst','ANALYST',analyst],['coder','CODING_WORKER',coder],['tester','TESTER',tester]] as const) {
      const agent=f.services.agents.create({name:id,role,provider:'anthropic',accountId:account.id,model:'sonnet',reasoning:'low',maxCapability:null,maxReasoning:null,enabled:true,policy:defaultAgentPolicy(role,'sonnet')});
      slots.push({id,label:id,runner,accountId:account.id,agentId:agent.id,providerId:'anthropic',connectionKind:'cli',routing:{provider:'anthropic',selection:'manual',manual:{model:'sonnet',reasoning:'low'},capabilities:async()=>caps}});
    }
    f.services.agents.sync();
    const w=f.services.workspaces.create({name:'Minimum team',localPath:repo.dir});
    const supervisor=db.agents.list().find(a => a.role === 'ORCHESTRATOR' && a.account_id === null)!;
    db.workspaces.setTeam(w.id,{agentId:supervisor.id},slots.map(s => ({agentId:s.agentId!})));
    db.verifications.upsert({workspaceId:w.id,id:'sum',label:'Sum regression',command:'node check.mjs'});
    const session=db.chat.createSession({id:'minimum-session',workspaceId:w.id,title:'Minimum'});
    const objective=complexity==='TRIVIAL'?`Crie ${file} na raiz.\n\nConteúdo exato:\n\n${exact}\n\nSEM newline final.`:complexity==='SIMPLE'?'Altere uma pequena função em sum.mjs e rode o teste existente.':'Corrija o bug de causa desconhecida em sum.mjs e rode o teste existente.';
    const run=f.services.orchestration.start({sessionId:session.id,objective});
    const ended=await f.services.orchestration.waitFor(run.id), detail=f.services.orchestration.detail(run.id);
    assert.equal(ended.status,'DONE',ended.summary ?? '');
    assert.equal(detail.orchestrationMetrics!.complexityClass,complexity);
    assert.equal(coder.calls.length,1); assert.equal(analyst.calls.length,complexity==='STANDARD'?1:0); assert.equal(tester.calls.length,complexity==='STANDARD'?1:0);
    assert.equal(detail.executionEvents!.filter(e=>e.type==='FINAL_RESPONSE').length,1);
    assert.equal(detail.orchestrationMetrics!.actualWorkerInvocations,complexity==='STANDARD'?3:1);
    if(complexity==='TRIVIAL') {assert.equal(readFileSync(join(repo.dir,file)).length,36);assert.equal(lead.calls.length,1);}
    else assert.ok(detail.verifications.some(v=>v.command==='node check.mjs'&&v.passed));
  } finally {await f.cleanup();repo.cleanup();}
});
