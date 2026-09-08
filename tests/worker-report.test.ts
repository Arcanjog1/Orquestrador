/**
 * O que o worker fez, numa forma que o supervisor consegue ler.
 *
 * O supervisor roda em modo leitura. Depois de uma delegação, a única forma que
 * ele tinha de saber o que aconteceu era ler um texto livre e adivinhar — ou
 * pedir uma verificação que podia não existir. O aplicativo **já tinha** os
 * fatos: o envelope do CLI, a saída do processo, as notas de atividade, a
 * evidência que ele mesmo coletou e as verificações que ele mesmo rodou. Eles
 * simplesmente nunca eram reunidos.
 *
 * A regra em torno da qual tudo isto é construído: **relatório é declaração,
 * evidência é medição.** Ficam em campos separados, aparecem sob títulos
 * separados, e nada aqui promove um ao outro. Quando os dois discordam, os dois
 * são reportados e a discordância é nomeada.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkerReport,
  renderWorkerReport,
  type WorkerReportInput,
} from '../src/worker/worker-report.js';
import type { GitEvidence, WorkerRecord } from '../src/core/types.js';

function worker(over: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    agent: 'claude-code',
    profile: null,
    task: 'crie hello.txt com o texto pronto',
    startedAt: '2026-09-08T10:00:00.000Z',
    finishedAt: '2026-09-08T10:00:05.000Z',
    exitCode: 0,
    outcome: 'completed',
    durationMs: 5000,
    routing: {
      requestedCapability: 'FAST',
      requestedReasoning: 'LOW',
      resolvedModel: 'haiku',
      resolvedReasoning: 'low',
      selectionMode: 'auto',
      selectionReason: 'tarefa pequena',
      fallbackUsed: false,
    },
    ...over,
  };
}

function evidence(over: Partial<GitEvidence> = {}): GitEvidence {
  return {
    isGitRepository: true,
    source: 'git',
    branch: 'main',
    head: 'abc1234',
    changedSinceBaseline: true,
    changedFiles: [],
    addedFiles: ['hello.txt'],
    deletedFiles: [],
    statusShort: 'A  hello.txt',
    diff: '',
    stagedDiff: '',
    unstagedDiff: '',
    diffStat: '1 file changed',
    evidenceProblem: null,
    ...over,
  } as GitEvidence;
}

function input(over: Partial<WorkerReportInput> = {}): WorkerReportInput {
  return {
    worker: worker(),
    answer: 'Criei hello.txt com os seis bytes pedidos.',
    evidence: evidence(),
    verifications: [{ label: '[leitura direta] hello.txt', passed: true }],
    unproven: [],
    failedCriteria: [],
    awaitingApproval: [],
    invocationId: 'inv-1',
    iteration: 1,
    sessionId: 'sess-abc',
    failureDetail: null,
    tools: ['Write'],
    ...over,
  };
}

test('a clean delegation with everything proven is "completed", and says what was measured', () => {
  const report = buildWorkerReport(input());
  assert.equal(report.status, 'completed');
  assert.match(report.headline, /Concluído em 5\.0s — 1 arquivo\(s\) alterado\(s\)/);
  assert.deepEqual([...report.evidenceFiles.created], ['hello.txt']);
  assert.equal(report.model, 'haiku');
  assert.equal(report.sessionId, 'sess-abc');
  assert.equal(report.invocationId, 'inv-1');
  assert.deepEqual([...report.tools], ['Write']);
  assert.match(report.recommendation, /conclua/);

  const text = renderWorkerReport(report);
  // The two halves, and the labels that keep them apart.
  assert.match(text, /O QUE O WORKER RELATOU \(declaração, não prova\)/);
  assert.match(text, /O QUE O APLICATIVO MEDIU \(evidência\)/);
  assert.match(text, /criados:\s+hello\.txt/);
  assert.match(text, /sessão do Claude: sess-abc/);
});

test('a delegation that left a criterion unproven is "partial", not "completed"', () => {
  const report = buildWorkerReport(input({ unproven: ['hello.txt tem exatamente 6 bytes'] }));
  assert.equal(report.status, 'partial');
  assert.deepEqual([...report.pending], ['hello.txt tem exatamente 6 bytes']);
  assert.match(report.recommendation, /Falta comprovar/);
  assert.match(report.recommendation, /não redelegue o que já está feito/);
});

test('a refused tool is "blocked", which is not the same as a failure', () => {
  const report = buildWorkerReport(
    input({
      worker: worker({ deniedTools: ['Bash', 'PowerShell'] }),
      answer: '',
      evidence: evidence({ addedFiles: [], changedSinceBaseline: false }),
    }),
  );
  assert.equal(report.status, 'blocked');
  assert.deepEqual([...report.deniedTools], ['Bash', 'PowerShell']);
  assert.match(report.recommendation, /Autorize Bash, PowerShell/);
  assert.match(report.recommendation, /nenhum modelo recebe uma permissão que foi negada/);

  const text = renderWorkerReport(report);
  assert.match(text, /AUTORIZAÇÕES:/);
  assert.match(text, /recusada: Bash/);
  // Nothing was said, and the report says so instead of inventing a summary.
  assert.match(text, /\(não informado\)/);
});

test('a mechanical failure says not to raise the model, in those words', () => {
  const report = buildWorkerReport(
    input({
      worker: worker({ outcome: 'completed', exitCode: 1, mechanical: true }),
      answer: '',
      failureDetail: 'subtype=success · is_error=true',
      evidence: evidence({ addedFiles: [], changedSinceBaseline: false }),
      verifications: [],
    }),
  );
  assert.equal(report.status, 'failed');
  assert.equal(report.mechanical, true);
  assert.match(report.recommendation, /NÃO aumente o modelo/);
  assert.match(report.recommendation, /subtype=success · is_error=true/);
  assert.deepEqual([...report.errors], ['subtype=success · is_error=true']);
});

test('a worker that failed before answering still produces a report, from the process', () => {
  const report = buildWorkerReport(
    input({
      worker: worker({ outcome: 'spawn-error', exitCode: null, durationMs: 120 }),
      answer: '',
      evidence: null,
      verifications: [],
      failureDetail: 'sem envelope legível (outcome=spawn-error, exit=null)',
      tools: [],
    }),
  );
  assert.equal(report.status, 'failed');
  assert.equal(report.declared, '', 'nothing was said, and nothing is invented');
  assert.equal(report.evidenceUnavailable, true);
  const text = renderWorkerReport(report);
  assert.match(text, /evidência indisponível/);
  assert.match(text, /"nada mudou" aqui significa "não deu para observar"/);
  assert.match(text, /saída: spawn-error/);
});

test('a report that claims a change the evidence does not show is named as a disagreement', () => {
  const report = buildWorkerReport(
    input({
      answer: 'Criei hello.txt com o conteúdo correto.',
      evidence: evidence({ addedFiles: [], changedFiles: [], changedSinceBaseline: false }),
      verifications: [],
      unproven: ['hello.txt existe'],
    }),
  );
  const text = renderWorkerReport(report);
  assert.match(text, /DIVERGÊNCIA/);
  assert.match(text, /A evidência decide/);
  // And the claim is still shown - kept as what was said, not deleted.
  assert.match(text, /Criei hello\.txt com o conteúdo correto/);
  // The status comes from the evidence, never from the confident sentence.
  assert.equal(report.status, 'partial');
});

test('no disagreement is claimed when the evidence could not be observed', () => {
  const report = buildWorkerReport(
    input({ answer: 'Criei o arquivo.', evidence: null, verifications: [], unproven: ['x'] }),
  );
  assert.doesNotMatch(renderWorkerReport(report), /DIVERGÊNCIA/);
});

test('a failed verification is reported with its problem, and drops the status to partial', () => {
  const report = buildWorkerReport(
    input({
      verifications: [
        { label: '[leitura direta] hello.txt', passed: false, problem: 'conteúdo diferente' },
      ],
    }),
  );
  assert.equal(report.status, 'partial');
  assert.ok(report.errors.includes('conteúdo diferente'));
  assert.match(renderWorkerReport(report), /FALHOU: \[leitura direta\] hello\.txt — conteúdo diferente/);
});

test('an authorisation still waiting on the person is blocked, and named', () => {
  const report = buildWorkerReport(input({ awaitingApproval: ['Bash'] }));
  assert.equal(report.status, 'blocked');
  assert.match(renderWorkerReport(report), /aguardando você: Bash/);
});

test('fields the tool did not report render as "não informado", never invented', () => {
  const report = buildWorkerReport(
    input({
      worker: worker({ routing: undefined }),
      invocationId: null,
      sessionId: null,
      tools: [],
    }),
  );
  const text = renderWorkerReport(report);
  assert.equal(report.model, null);
  assert.match(text, /id: não informado/);
  assert.match(text, /modelo: não informado/);
  assert.match(text, /sessão do Claude: não informada/);
  assert.doesNotMatch(text, /ferramentas:/);
});

test('a created file is not counted twice when git names it added and changed', () => {
  // git reports a new file in both lists. Listing both verbatim reported one
  // file as two, and "2 arquivos alterados" for a single hello.txt is the kind
  // of small wrongness that makes a reader stop trusting the rest.
  const report = buildWorkerReport(
    input({ evidence: evidence({ addedFiles: ['hello.txt'], changedFiles: ['hello.txt'] }) }),
  );
  assert.deepEqual([...report.evidenceFiles.created], ['hello.txt']);
  assert.deepEqual([...report.evidenceFiles.modified], []);
  assert.match(report.headline, /1 arquivo\(s\) alterado\(s\)/);
});
