import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyObjective } from '../src/orchestrator/query-proof.js';
import { createDesktopFixture, fakeSecretStore, ScriptedAgent } from './helpers/desktop-fixture.js';
import { FakeRepository } from './helpers/fake-repository.js';

const literal = 'consegue acessar esse repositorio?';
test('incident: the literal repository access question is read-only', () => {
  assert.equal(isReadOnlyObjective(literal), true);
});

for(const mismatch of [false,true])test(mismatch?'gate mismatch stops after two equivalent rejections':'incident: Arcanjog1/teste access completes once without writes or human review', async () => {
  const github = new FakeRepository({owner:'Arcanjog1',repo:'teste',defaultBranch:'main',files:{'README.md':'# teste\n'},isPrivate:true});
  const answer='Sim, consegui acessar Arcanjog1/teste na branch main. README.md está na árvore do repositório.';
  const decision=JSON.stringify({action:'done',summary:answer,acceptanceCriteria:[mismatch?'Comprovar execução dos testes':'Confirmar acesso ao repositório'],verificationCommands:[],fileChecks:[]});
  const orchestrator=new ScriptedAgent('codex','Codex',Array(6).fill(decision));
  const worker=new ScriptedAgent('mock-claude','Claude',[]);
  const fixture=createDesktopFixture({createRunners:async()=>({orchestrator,worker,workerAccountId:null}),github:{fetchImpl:github.fetch},secrets:fakeSecretStore(),maxIterations:6});
  try {
    await fixture.router.handle('github.configure',{clientId:'Iv1.fixture'});
    await fixture.router.handle('github.connect',undefined);
    for(let i=0;i<500;i++) {const status=await fixture.router.handle('github.status',undefined);if(status.ok&&(status.value as {connected:boolean}).connected)break;await new Promise(r=>setTimeout(r,10));}
    const workspace=fixture.services.workspaces.createGitHub({repository:'Arcanjog1/teste'});
    fixture.services.accounts.create('Claude','anthropic');
    const agents=await fixture.router.handle('agents.list',null);
    assert.ok(agents.ok);
    const list=agents.value as Array<{id:string;role:string}>;
    await fixture.router.handle('workspace.setAgents',{workspaceId:workspace.id,orchestratorAgentId:list.find(a=>a.role==='ORCHESTRATOR')!.id,workerAgentId:list.find(a=>a.role==='CODING_WORKER')!.id});
    const session=fixture.services.chat.createSession(workspace.id,'Consulta');
    const started=fixture.services.orchestration.start({sessionId:session.id,objective:literal});
    const run=await fixture.services.orchestration.waitFor(started.id);
    const messages=fixture.services.database.chat.listMessages(session.id);
    assert.equal(run.status,mismatch?'FAILED':'DONE',JSON.stringify({run,messages}));
    assert.equal(run.iterations,mismatch?2:1);
    assert.equal(orchestrator.calls.length,mismatch?2:1);
    assert.equal(worker.calls.length,0);
    const finals=fixture.services.database.runs.events(run.id).filter(e=>e.type==='FINAL_RESPONSE');
    assert.equal(finals.length,1,'one final after the gate, never a premature answer');
    if(!mismatch)assert.ok(finals[0]!.summary.includes(answer));
    else assert.ok(!finals[0]!.summary.includes(answer),'rejected success is not published as completion');
    assert.ok(messages.every(m=>!m.body.includes('--allow-no-changes')));
    assert.equal(github.calls.filter(c=>c.method!=='GET'&&!c.path.includes('/login/')).length,0);
    assert.ok(fixture.services.database.runs.steps(run.id).some(s=>s.phase==='query-proof'&&s.status==='passed'));
    if(mismatch)assert.match(run.summary??'',/GATE_MISMATCH/);
  } finally {await fixture.cleanup();}
});
