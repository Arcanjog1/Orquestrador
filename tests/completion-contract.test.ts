import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import { createGitFixture } from './helpers/git-fixture.js';
import { createMissionContract, contractChecks, preserveChecks } from '../src/orchestrator/mission-contract.js';
import { localTreeProof, fileFactIdentity, measurementProofs } from '../src/orchestrator/evidence-bridge.js';
import { classifyObjective } from '../src/orchestrator/objective-intent.js';
import { readProofProblems } from '../src/orchestrator/query-proof.js';
import { runFileCheck } from '../src/verification/file-check.js';
import { recoveryAction } from '../src/orchestrator/completion-state.js';
import { evaluateDone } from '../src/orchestrator/done-gate.js';
import { AcceptanceCriteriaLedger } from '../src/orchestrator/acceptance-criteria.js';
import { verifierWithoutExecutor } from '../src/orchestrator/verifier.js';
import { RejectedProgressGuard } from '../src/orchestrator/rejected-progress.js';
import type { AgentInput, Baseline, GitEvidence } from '../src/core/types.js';
import { classifyComplexity } from '../src/orchestrator/complexity.js';
import { executionGraph } from '../apps/desktop/src/shared/execution-graph.js';
import { chronologicalTrace } from '../apps/desktop/src/shared/execution-trace.js';

export const EXACT = 'AI Orchestrator Team Test\nStatus: OK';
export const FILE = 'orchestrator-team-test.txt';
export const OBJECTIVE = `Crie ${FILE} na raiz.\n\nConteúdo exato:\n\n${EXACT}\n\nSEM newline final.`;
const criterion = `${FILE} tem conteúdo exato`;
const plan = (content = EXACT, extra: string[] = []) => JSON.stringify({action:'delegate',task:`Crie ${FILE}`,summary:'Vou criar o arquivo e validar o conteúdo.',
  acceptanceCriteria:[criterion,...extra],fileChecks:[{path:FILE,expectText:content,criteria:[criterion]}]});

export async function runContract(options: {objective?:string; plans?: string[]; worker?: ((input:AgentInput) => string)[]; fastPath?:boolean} = {}) {
  const repo = createGitFixture('completion-contract-'); repo.write('README.md','# Fixture'); repo.commitAll('baseline');
  const lead = new ScriptedAgent('mock-codex','Orquestrador', options.plans ?? [plan()]);
  const worker = new ScriptedAgent('mock-claude','Programador',options.worker ?? [input => {writeFileSync(join(input.workingDirectory,FILE),EXACT); return 'Arquivo criado.';}]);
  const fixture = createDesktopFixture({createRunners:async () => ({orchestrator:lead,worker,workerAccountId:null}), maxIterations:6, ...(options.fastPath === undefined ? {} : {fastPath:options.fastPath})});
  const w = fixture.services.workspaces.create({name:'Contract test',localPath:repo.dir});
  fixture.services.accounts.create('Worker','anthropic'); fixture.services.agents.sync();
  const agents = fixture.services.database.agents.list();
  fixture.services.database.workspaces.setAgents(w.id,agents.find(a => a.role === 'ORCHESTRATOR')!.id,agents.find(a => a.role === 'CODING_WORKER')!.id);
  const session = fixture.services.database.chat.createSession({id:'contract-session',workspaceId:w.id,title:'Contract'});
  const run = fixture.services.orchestration.start({sessionId:session.id,objective:options.objective ?? OBJECTIVE});
  const ended = await fixture.services.orchestration.waitFor(run.id);
  return {fixture, repo, lead, worker, ended, detail:fixture.services.orchestration.detail(run.id),
    cleanup:async () => {await fixture.cleanup();repo.cleanup();}};
}

test('36 bytes: one worker, real filesystem comparison, DoneGate PASS, one final', async () => {
  const f = await runContract(); try {
    assert.equal(f.ended.status,'DONE',f.ended.summary ?? '');
    assert.equal(f.worker.calls.length,1); assert.equal(f.lead.calls.length,1);
    const bytes = readFileSync(join(f.repo.dir,FILE)); assert.equal(bytes.length,36); assert.equal(bytes.toString(),EXACT);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),createMissionContract(OBJECTIVE).exactLiterals[0]!.expectedHash);
    const gate = f.detail.executionEvents!.find(e => e.type === 'REVIEW_RESULT' && e.status === 'passed');
    assert.ok(gate); assert.equal(f.detail.executionEvents!.filter(e => e.type === 'FINAL_RESPONSE').length,1);
    assert.equal(f.detail.executionEvents!.at(-1)!.type,'FINAL_RESPONSE');
    assert.equal(f.detail.executionEvents!.filter(e => e.type === 'NEEDS_HUMAN').length,0);
    assert.equal(f.detail.orchestrationMetrics!.complexityClass,'TRIVIAL');
    assert.equal(f.detail.orchestrationMetrics!.actualWorkerInvocations,1);
    assert.equal(f.detail.orchestrationMetrics!.actualModelInvocations,2);
    assert.equal(executionGraph(f.detail).nodes.length,5);
    assert.equal(chronologicalTrace(f.detail).length,6);
    assert.deepEqual(executionGraph(f.detail).nodes.flatMap(n=>n.sourceIds).sort(),chronologicalTrace(f.detail).flatMap(n=>n.sourceIds).sort());
  } finally {await f.cleanup();}
});

test('original incident format: unfenced literal and an initial plan with no fileChecks still finish immediately',async()=>{
  const objective=`Crie um arquivo chamado \`${FILE}\` na raiz do projeto com o conteúdo exato:\n\n${EXACT}\n\nDepois valide que o arquivo existe e que o conteúdo está exatamente correto.\n\nUse somente os agentes necessários. Não altere outros arquivos. Working Tree e Raciocínio em linha devem mostrar os resultados.`;
  const f=await runContract({objective,plans:[JSON.stringify({action:'delegate',task:'Crie o arquivo.',acceptanceCriteria:[`\`${FILE}\` exists at the project root.`,`\`${FILE}\` content is exactly "AI Orchestrator Team Test\\nStatus: OK" with no extra bytes.`],fileChecks:[]})]});
  try {assert.equal(f.ended.status,'DONE',f.ended.summary ?? '');assert.equal(f.worker.calls.length,1);assert.equal(f.lead.calls.length,1);assert.equal(readFileSync(join(f.repo.dir,FILE)).length,36);}finally{await f.cleanup();}
});

test('complexity selects only necessary roles; unknown bugs retain a full team', () => {
  assert.deepEqual(classifyComplexity(createMissionContract(OBJECTIVE)).plannedAgents,['CODING_WORKER']);
  assert.equal(classifyComplexity(createMissionContract('Altere uma pequena função em sum.ts e rode o teste existente.')).complexityClass,'SIMPLE');
  const standard = classifyComplexity(createMissionContract('Investigue a causa desconhecida do bug e corrija o código.'));
  assert.equal(standard.complexityClass,'STANDARD');
  assert.deepEqual(standard.plannedAgents,['ANALYST','CODING_WORKER','TESTER']);
  assert.equal(classifyComplexity(createMissionContract('Refatoração grande da arquitetura em múltiplos subsistemas.')).complexityClass,'COMPLEX');
});

test('byte comparison bridges content/existence; a single file does not manufacture a complete tree', async () => {
  const repo = createGitFixture('proof-bridge-'); try {
    repo.write(FILE,EXACT);
    const check = await runFileCheck(repo.dir,contractChecks(createMissionContract(OBJECTIVE))[0]!);
    assert.deepEqual(measurementProofs(check),['FILE_EXISTENCE','PATH_EXISTS','FILE_HASH','FILE_CONTENT']);
    assert.equal(check.measurement!.byteLength,36); assert.equal(check.measurement!.content,EXACT);
    const intent = {...classifyObjective(OBJECTIVE),readProofs:['FILE_CONTENT','FILE_EXISTENCE','REPOSITORY_TREE'] as const};
    assert.deepEqual(readProofProblems(intent,'Arquivo validado.',undefined,[],[],[check]),['Missing independent proof: REPOSITORY_TREE']);
    const tree = await localTreeProof(repo.dir,{repository:repo.dir,branch:'main',commit:'measured'});
    assert.deepEqual(readProofProblems(intent,'Arquivo validado.',undefined,[],[tree],[check]),[]);
    const semantic = classifyObjective(`Leia e explique ${FILE}`);
    assert.ok(readProofProblems(semantic,'Explicação sem leitura entregue.',undefined,[],[tree],[check]).length);
  } finally {repo.cleanup();}
});

test('FAILED_CONTENT: 37 bytes reopens implementation, retry keeps the original 36 bytes', async () => {
  const prompts: string[] = [];
  const f = await runContract({plans:[plan(),plan(EXACT+'\n')],worker:[input => {prompts.push(input.prompt);writeFileSync(join(input.workingDirectory,FILE),EXACT+'\n');return 'Criado.';},input => {prompts.push(input.prompt);writeFileSync(join(input.workingDirectory,FILE),EXACT);return 'Corrigido.';}]});
  try {
    assert.equal(f.ended.status,'DONE',f.ended.summary ?? ''); assert.equal(f.worker.calls.length,2);
    for (const prompt of prompts) {assert.ok(prompt.includes(JSON.stringify(EXACT))); assert.ok(prompt.includes('"expectedByteLength":36')); assert.ok(!prompt.includes(JSON.stringify(EXACT+'\n')));}
    assert.equal(readFileSync(join(f.repo.dir,FILE)).length,36);
  } finally {await f.cleanup();}
});

test('spec is immutable; five identical measurements are one logical evidence fact', async () => {
  const contract = createMissionContract(OBJECTIVE), pins = new Map(contractChecks(contract).map(c => [c.path,c]));
  assert.equal(contract.exactLiterals[0]!.trailingNewline,false);
  assert.equal(preserveChecks([{path:FILE,expectText:EXACT+'\n'}],pins)[0]!.expectText,EXACT);
  const f = await runContract(); try {
    const identities = new Set<string>();
    for (let i=0;i<5;i++) {
      const check = await runFileCheck(f.repo.dir,contractChecks(contract)[0]!); identities.add(fileFactIdentity(check));
      f.fixture.services.database.runs.event({runId:f.ended.id,key:`dedupe-${i}`,type:'EVIDENCE_CREATED',iteration:i,status:'passed',summary:'same check',data:{phase:'dedupe-test',checks:[check]}});
    }
    assert.equal(identities.size,1);
    assert.equal(f.fixture.services.database.runs.events(f.ended.id).filter(e => e.data.phase === 'dedupe-test').length,1);
  } finally {await f.cleanup();}
});

test('a completed implementation cannot be delegated again to repair proof', async () => {
  const f = await runContract({fastPath:false,plans:[plan(),plan(EXACT+'\n')]});
  try {
    assert.equal(f.ended.status,'DONE',f.ended.summary ?? '');
    assert.equal(f.worker.calls.length,1);
    assert.equal(readFileSync(join(f.repo.dir,FILE)).length,36);
    assert.ok(f.detail.steps.some(s => s.phase === 'proof-recovery' && s.status === 'redirected'));
  } finally {await f.cleanup();}
});

test('stalled proof stops before a third equivalent collection and never asks a human', async () => {
  const f = await runContract({plans:[plan(EXACT,['Comportamento sem verificação disponível']),plan(EXACT,['Comportamento sem verificação disponível'])]});
  try {
    assert.equal(f.ended.status,'FAILED'); assert.match(f.ended.summary ?? '',/VERIFICATION_STALLED/);
    assert.equal(f.worker.calls.length,1);
    assert.equal(f.detail.steps.filter(s => s.phase === 'proof-recovery' && s.status === 'collecting').length,1);
    assert.equal(f.detail.executionEvents!.filter(e => e.type === 'NEEDS_HUMAN').length,0);
  } finally {await f.cleanup();}
});

test('MISSING_PROOF is collected by the gate without a worker; stale PASS is never accepted', async () => {
  const repo = createGitFixture('gate-recovery-'); try {
    repo.write(FILE,EXACT);
    const contract = createMissionContract(OBJECTIVE), ledger = new AcceptanceCriteriaLedger(); ledger.add(contract.acceptanceCriteria,1);
    const baseline: Baseline = {capturedAt:'now',isGitRepository:false,commit:null,branch:null,statusShort:'',unstagedDiff:'',stagedDiff:'',modifiedFiles:[],stagedFiles:[],dirty:false};
    const evidence: GitEvidence = {collectedAt:'now',isGitRepository:false,commit:null,branch:null,statusShort:'',diff:'',diffStat:'',changedFiles:[FILE],addedFiles:[FILE],deletedFiles:[],changedSinceBaseline:true};
    const input = {ledger,baseline,evidence,iterations:[],verificationCommands:[],verifier:verifierWithoutExecutor('No executor'),allowNoChanges:false,
      objectiveIntent:{...classifyObjective(OBJECTIVE),readProofs:['FILE_CONTENT'] as const},fileChecks:contractChecks(contract),workspaceRoot:repo.dir};
    const missing = await evaluateDone({...input,objectiveProofProblems:['Missing FILE_CONTENT']});
    assert.equal(recoveryAction(missing),'collect-proof');
    const proof = await evaluateDone({...input,measureObjectiveProof:async checks => readProofProblems(input.objectiveIntent,'Arquivo validado.',undefined,[],[],checks)});
    assert.equal(proof.passed,true,proof.failures.join('; '));
    repo.write(FILE,EXACT+'\n');
    const mismatch = await evaluateDone({...input,objectiveProofProblems:[]});
    assert.equal(recoveryAction(mismatch),'implement'); assert.ok(mismatch.rejections!.some(r => r.kind === 'IMPLEMENTATION_MISMATCH'));
    const guard = new RejectedProgressGuard();
    const round = {answer:'Uma resposta',reads:[],criteria:ledger.all(),evidence,gate:missing};
    assert.equal(guard.observe(round),false); assert.equal(guard.observe({...round,answer:'Outra paráfrase'}),true);
    repo.write(FILE,EXACT);
    const conflicting = await runFileCheck(repo.dir,{path:FILE,expectText:EXACT,expectSizeBytes:35});
    assert.equal(conflicting.passed,false);assert.equal(conflicting.outcome,'size-mismatch');
  } finally {repo.cleanup();}
});
