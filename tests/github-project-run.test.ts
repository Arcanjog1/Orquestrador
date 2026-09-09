/**
 * Um projeto GitHub, do início ao PR, sem checkout nenhum.
 *
 * O pedido: "abrir o Orquestrador → selecionar meu repositório GitHub →
 * trabalhar nele sem checkout local permanente → permitir que Codex e Claude
 * analisem e alterem o código → criar branch, commit e PR → visualizar
 * evidências". Estes testes exercitam exatamente esse caminho pelo **mesmo
 * motor**: Codex planeja, Claude propõe, o aplicativo aplica, o aplicativo
 * mede, o DoneGate decide.
 *
 * As três regras que estes testes existem para fixar:
 *
 *  1. um parágrafo descrevendo uma alteração **não é** uma alteração — só o
 *     bloco estruturado vira commit, e só depois de validado;
 *  2. a evidência vem do GitHub, não do relato do worker;
 *  3. a API do GitHub **não executa código**, então um comando de verificação
 *     é recusado, o critério fica sem prova, e o DoneGate recusa o DONE. Nunca
 *     um PASS inventado.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import { FakeRepository } from './helpers/fake-repository.js';
import type { DesktopFixture } from './helpers/desktop-fixture.js';
import type { IpcResult, RunView } from '../apps/desktop/src/shared/ipc-contract.js';
import type { AgentInput } from '../src/core/types.js';

const OWNER = 'arcanjo';
const REPO = 'projeto';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

interface Prepared {
  fixture: DesktopFixture;
  github: FakeRepository;
  sessionId: string;
  workspaceId: string;
  worker: ScriptedAgent;
  cleanup(): Promise<void>;
}

async function prepare(options: {
  orchestratorScript: ReadonlyArray<string | ((input: AgentInput) => string)>;
  workerScript: ReadonlyArray<string | ((input: AgentInput) => string)>;
  files?: Record<string, string>;
  defaultBranch?: string;
  maxIterations?: number;
}): Promise<Prepared> {
  const github = new FakeRepository({
    owner: OWNER,
    repo: REPO,
    // Never `main`, so an assumption anywhere fails loudly.
    defaultBranch: options.defaultBranch ?? 'trunk',
    files: options.files ?? { 'README.md': '# projeto\n', 'src/app.ts': 'export const a = 1;\n' },
  });
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', options.orchestratorScript);
  const worker = new ScriptedAgent('mock-claude', 'Claude', options.workerScript);
  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    github: { fetchImpl: github.fetch },
    // The desktop shell supplies the OS keychain; a test supplies a store that
    // keeps the bytes in memory. What matters is that one exists, because a
    // machine without one legitimately refuses to keep the login at all.
    secrets: {
      available: true,
      encrypt: (plain: string) => Buffer.from(plain, 'utf8').toString('base64'),
      decrypt: (cipher: string) => Buffer.from(cipher, 'base64').toString('utf8'),
    },
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
  });

  // The account is connected through the real service and the real device
  // flow, against the fake. Writing to a repository needs a credential, and a
  // test that reached into the token store would not be exercising the code
  // that refuses without one.
  value(await fixture.router.handle('github.configure', { clientId: 'Iv1.fake' }));
  // `connect` starts the device flow and returns; the login lands when the
  // polling finishes, exactly as it does in the application.
  value(await fixture.router.handle('github.connect', undefined));
  const deadline = Date.now() + 5000;
  for (;;) {
    const status = value<{ connected: boolean }>(await fixture.router.handle('github.status', undefined));
    if (status.connected) break;
    if (Date.now() > deadline) throw new Error('o GitHub não conectou a tempo');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const workspace = value<{ id: string }>(
    await fixture.router.handle('workspace.createGitHub', { repository: `${OWNER}/${REPO}` }),
  );
  value(await fixture.router.handle('accounts.create', { name: 'Claude', provider: 'anthropic' }));
  const agents = value<Array<{ id: string; role: string }>>(
    await fixture.router.handle('agents.list', null),
  );
  value(
    await fixture.router.handle('workspace.setAgents', {
      workspaceId: workspace.id,
      orchestratorAgentId: agents.find((a) => a.role === 'ORCHESTRATOR')!.id,
      workerAgentId: agents.find((a) => a.role === 'CODING_WORKER')!.id,
    }),
  );
  const session = value<{ id: string }>(
    await fixture.router.handle('chat.createSession', { workspaceId: workspace.id, title: 'C' }),
  );
  return {
    fixture,
    github,
    worker,
    sessionId: session.id,
    workspaceId: workspace.id,
    async cleanup() {
      await fixture.cleanup();
    },
  };
}

const delegate = (task: string, criteria: string[], fileChecks: unknown[] = []) =>
  JSON.stringify({
    action: 'delegate',
    task,
    acceptanceCriteria: criteria,
    verificationCommands: [],
    fileChecks,
    summary: 'Vou pedir a alteração.',
  });

const done = (fileChecks: unknown[] = []) =>
  JSON.stringify({
    action: 'done',
    acceptanceCriteria: [],
    verificationCommands: [],
    fileChecks,
    summary: 'Pronto.',
  });

/* ------------------------------------------------------------------------ */

test('selecionar o repositório cria UM projeto, sem pasta e sem clone', async () => {
  const prepared = await prepare({ orchestratorScript: [done()], workerScript: ['ok'] });
  try {
    const workspace = prepared.fixture.services.database.workspaces.require(prepared.workspaceId);
    assert.equal(workspace.environment, 'github');
    assert.equal(workspace.local_path, '', 'nenhuma pasta neste computador');
    assert.equal(workspace.repository_full_name, `${OWNER}/${REPO}`);

    // Selecionar o mesmo repositório de novo abre o mesmo projeto: um
    // repositório é um projeto, não três.
    const again = value<{ id: string }>(
      await prepared.fixture.router.handle('workspace.createGitHub', {
        repository: `${OWNER}/${REPO}`,
      }),
    );
    assert.equal(again.id, prepared.workspaceId);
    assert.equal(
      prepared.fixture.services.database.workspaces.list().filter((w) => w.environment === 'github').length,
      1,
    );
  } finally {
    await prepared.cleanup();
  }
});

test('o aplicativo cria um repositório descartável pela conexão já autorizada', async () => {
  const prepared = await prepare({ orchestratorScript: [done()], workerScript: ['ok'] });
  try {
    const created = value<{ fullName: string; defaultBranch: string | null; isPrivate: boolean }>(
      await prepared.fixture.router.handle('github.createRepository', {
        name: 'descartavel',
        private: true,
      }),
    );
    assert.equal(created.fullName, `${OWNER}/descartavel`);
    assert.equal(created.isPrivate, true, 'privado por padrão, nunca público por descuido');
    // Criado com um primeiro commit, senão não haveria branch padrão nem
    // árvore de onde tirar a branch de trabalho.
    assert.ok(created.defaultBranch, 'tem branch padrão');
  } finally {
    await prepared.cleanup();
  }
});

test('uma conexão que não pode criar repositórios diz o motivo e o caminho oficial', async () => {
  // A recusa mais importante desta tela: um GitHub App não cria repositório em
  // conta pessoal, e isso é o tipo da conexão, não uma configuração esquecida.
  // A resposta precisa dizer isso e apontar o caminho — nunca pedir um token.
  const prepared = await prepare({ orchestratorScript: [done()], workerScript: ['ok'] });
  prepared.github.failNext = {
    method: 'POST',
    pathIncludes: '/user/repos',
    status: 403,
    message: 'Resource not accessible by integration',
  };
  try {
    const refused = await prepared.fixture.router.handle('github.createRepository', {
      name: 'descartavel',
    });
    assert.equal(refused.ok, false);
    const message = (refused as { ok: false; error: { message: string } }).error.message;
    assert.match(message, /não pode criar repositórios/);
    assert.match(message, /github\.com\/new/);
    assert.match(message, /Nenhum token precisa ser informado/);
  } finally {
    await prepared.cleanup();
  }
});

test('as capacidades são medidas: lê, escreve, e NÃO executa código', async () => {
  const prepared = await prepare({ orchestratorScript: [done()], workerScript: ['ok'] });
  try {
    const capabilities = value<{
      fullName: string | null;
      defaultBranch: string | null;
      canRead: boolean;
      execution: string;
    }>(
      await prepared.fixture.router.handle('workspace.githubCapabilities', {
        workspaceId: prepared.workspaceId,
      }),
    );
    assert.equal(capabilities.canRead, true);
    assert.equal(capabilities.fullName, `${OWNER}/${REPO}`);
    // A branch padrão vem do GitHub, e não é `main`.
    assert.equal(capabilities.defaultBranch, 'trunk');
    // A API do GitHub nunca aparece como executor.
    assert.equal(capabilities.execution, 'none');
  } finally {
    await prepared.cleanup();
  }
});

test('o aplicativo lê a árvore e os arquivos pela API, sem pedir uma pasta', async () => {
  const prepared = await prepare({
    orchestratorScript: [done()],
    workerScript: ['ok'],
    files: { 'README.md': '# olá\n', 'src/app.ts': 'a\n' },
  });
  try {
    const tree = value<{ entries: Array<{ path: string }>; commitSha: string }>(
      await prepared.fixture.router.handle('workspace.githubTree', {
        workspaceId: prepared.workspaceId,
      }),
    );
    assert.deepEqual(tree.entries.map((entry) => entry.path).sort(), ['README.md', 'src/app.ts']);
    assert.equal(tree.commitSha, prepared.github.head('trunk'));

    const file = value<{ text: string | null; isBinary: boolean }>(
      await prepared.fixture.router.handle('workspace.githubFile', {
        workspaceId: prepared.workspaceId,
        path: 'README.md',
      }),
    );
    assert.equal(file.text, '# olá\n');
    assert.equal(file.isBinary, false);
  } finally {
    await prepared.cleanup();
  }
});

test('o fluxo completo: plano, proposta, commit na branch de trabalho, evidência do GitHub e PR', async () => {
  const prompts: string[] = [];
  const prepared = await prepare({
    orchestratorScript: [
      delegate('Troque o título do README para "# depois".', ['README.md começa com "# depois"'], [
        { path: 'README.md', expectText: '# depois\n', mustExist: true, expectBytesHex: null, expectSizeBytes: null, forbidBom: null, forbidTrailingNewline: null, criteria: ['README.md começa com "# depois"'] },
      ]),
      done([
        { path: 'README.md', expectText: '# depois\n', mustExist: true, expectBytesHex: null, expectSizeBytes: null, forbidBom: null, forbidTrailingNewline: null, criteria: ['README.md começa com "# depois"'] },
      ]),
    ],
    workerScript: [
      (input: AgentInput) => {
        prompts.push(input.prompt);
        // The commit the application showed the worker, echoed back. A
        // proposal written against anything else is refused.
        // The commit the application put in the worker's own instructions.
        const sha = /at commit ([0-9a-f]{7,40})/.exec(input.prompt)?.[1] ?? '';
        return [
          'Troquei o título. Segue a alteração:',
          '',
          '```orquestrador-changes',
          JSON.stringify({
            baseCommit: sha,
            message: 'Troca o título do README',
            changes: [{ op: 'write', path: 'README.md', text: '# depois\n' }],
          }),
          '```',
        ].join('\n');
      },
    ],
    files: { 'README.md': '# antes\n', 'src/app.ts': 'a\n' },
    maxIterations: 3,
  });
  const origin = prepared.github.head('trunk')!;
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Troque o título do README.',
      }),
    );
    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);
    assert.equal(run.status, 'DONE', run.summary ?? '');

    // A alteração aconteceu de verdade, no GitHub, numa branch de trabalho.
    const branches = prepared.github.branches().filter((name) => name !== 'trunk');
    assert.equal(branches.length, 1, `uma branch de trabalho: ${branches.join(', ')}`);
    const work = branches[0]!;
    assert.match(work, /^orquestrador\//);
    assert.deepEqual(prepared.github.snapshot(work), { 'README.md': '# depois\n', 'src/app.ts': 'a\n' });
    // E a branch de origem não foi tocada.
    assert.equal(prepared.github.head('trunk'), origin);

    // Um PR foi aberto, da branch de trabalho para a de origem, sem merge.
    const pulls = prepared.github.pullRequests();
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0]!.head, work);
    assert.equal(pulls[0]!.base, 'trunk');
    assert.equal(prepared.github.head('trunk'), origin, 'nada foi mesclado');

    // O worker recebeu o contrato de proposta, e não uma promessa de escrever.
    assert.ok(prompts.some((prompt) => prompt.includes('orquestrador-changes')));
    assert.ok(prompts.some((prompt) => /You cannot write files here/.test(prompt)));

    // A evidência veio do GitHub: o diff está registrado com o arquivo real.
    const detail = value<{ steps: ReadonlyArray<{ phase: string; status: string; summary: string | null }> }>(
      await prepared.fixture.router.handle('run.detail', { runId: sent.run.id }),
    );
    const commit = detail.steps.find((step) => step.phase === 'commit' && step.status === 'created');
    assert.ok(commit, 'o commit está registrado');
    assert.match(commit!.summary ?? '', /README\.md|1 escrito/);
    assert.ok(detail.steps.some((step) => step.phase === 'pull-request' && step.status === 'opened'));
  } finally {
    await prepared.cleanup();
  }
});

test('um parágrafo descrevendo a alteração não vira commit', async () => {
  const prepared = await prepare({
    orchestratorScript: [delegate('Troque o título.', ['README.md mudou']), done()],
    // O worker "diz" que alterou, sem bloco nenhum. É exatamente a falha que o
    // produto se recusa a ter: a narração tomada pela alteração.
    workerScript: ['Pronto! Alterei o README.md para "# depois".'],
    files: { 'README.md': '# antes\n' },
    maxIterations: 2,
  });
  const origin = prepared.github.head('trunk')!;
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Troque o título do README.',
      }),
    );
    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);
    assert.notEqual(run.status, 'DONE', 'nada foi alterado, então nada está feito');
    assert.deepEqual(prepared.github.branches(), ['trunk'], 'nenhuma branch foi criada');
    assert.equal(prepared.github.head('trunk'), origin);
    assert.deepEqual(prepared.github.snapshot('trunk'), { 'README.md': '# antes\n' });
  } finally {
    await prepared.cleanup();
  }
});

test('uma proposta contra outro commit, ou com caminho inválido, é recusada e explicada', async () => {
  const attempts: string[] = [];
  const prepared = await prepare({
    orchestratorScript: [
      delegate('Altere o README.', ['README.md mudou']),
      delegate('Tente de novo.', ['README.md mudou']),
      done(),
    ],
    workerScript: [
      (input: AgentInput) => {
        attempts.push(input.prompt);
        if (attempts.length === 1) {
          return [
            '```orquestrador-changes',
            JSON.stringify({
              baseCommit: '0000000000000000000000000000000000000000',
              message: 'contra outro commit',
              changes: [{ op: 'write', path: 'README.md', text: 'x\n' }],
            }),
            '```',
          ].join('\n');
        }
        const sha = /at commit ([0-9a-f]{7,40})/.exec(input.prompt)?.[1] ?? '';
        return [
          '```orquestrador-changes',
          JSON.stringify({
            baseCommit: sha,
            message: 'para fora do repositório',
            changes: [{ op: 'write', path: '../fora.txt', text: 'x\n' }],
          }),
          '```',
        ].join('\n');
      },
    ],
    files: { 'README.md': '# antes\n' },
    maxIterations: 3,
  });
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Altere o README.',
      }),
    );
    await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    const detail = value<{ steps: ReadonlyArray<{ phase: string; status: string; summary: string | null }> }>(
      await prepared.fixture.router.handle('run.detail', { runId: sent.run.id }),
    );
    const rejected = detail.steps.filter((step) => step.phase === 'proposal' && step.status === 'rejected');
    assert.equal(rejected.length, 2, 'as duas propostas foram recusadas');
    assert.match(rejected[0]!.summary ?? '', /commit em mãos|escrita contra/);
    assert.match(rejected[1]!.summary ?? '', /sai da raiz|Nada foi aplicado/);
    // E nada foi escrito por nenhuma das duas.
    assert.deepEqual(prepared.github.branches(), ['trunk']);
    assert.deepEqual(prepared.github.snapshot('trunk'), { 'README.md': '# antes\n' });
  } finally {
    await prepared.cleanup();
  }
});

test('sem executor, um comando de verificação é recusado e o DONE não passa', async () => {
  // "Se não houver executor para rodar testes, mantenha os critérios
  // funcionais sem prova ou solicite revisão humana objetiva. Não invente PASS."
  const prepared = await prepare({
    orchestratorScript: [
      JSON.stringify({
        action: 'done',
        acceptanceCriteria: ['os testes passam'],
        verificationCommands: ['npm test'],
        summary: 'Acho que está pronto.',
      }),
      JSON.stringify({
        action: 'blocked',
        reason: 'Preciso de um executor para rodar os testes.',
        acceptanceCriteria: [],
        verificationCommands: [],
      }),
    ],
    workerScript: ['ok'],
    maxIterations: 2,
  });
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Rode os testes e conclua.',
      }),
    );
    const run: RunView = await prepared.fixture.services.orchestration.waitFor(sent.run.id);
    assert.notEqual(run.status, 'DONE');

    const detail = value<{ steps: ReadonlyArray<{ phase: string; status: string; summary: string | null }> }>(
      await prepared.fixture.router.handle('run.detail', { runId: sent.run.id }),
    );
    const gate = detail.steps.find((step) => step.phase === 'done-gate');
    assert.ok(gate, 'o gate rodou');
    assert.equal(gate!.status, 'rejected');
    // A razão diz que o comando não rodou, e por quê - não que ele falhou.
    assert.match(gate!.summary ?? '', /refused and never ran|não executa código|não foi executado|no supporting evidence/);
  } finally {
    await prepared.cleanup();
  }
});
