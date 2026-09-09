/**
 * "consegue ler os arquivos q tem nesse repositorio?"
 *
 * O incidente, literal. Repositório público, projeto GitHub sem checkout. O
 * aplicativo identificou corretamente o repositório, a branch e o commit — e
 * então o Codex delegou ao Claude *"liste os arquivos do projeto disponíveis
 * no workspace"*, o Claude respondeu (corretamente) que não existe checkout, e
 * a execução terminou em revisão humana por falta da árvore de arquivos.
 *
 * A causa era estrutural: o supervisor era instruído a usar `fileReads`, e
 * `fileReads` exige um **caminho**. Nada lhe dava como descobrir um. Ler um
 * arquivo que não se pode nomear não é uma capacidade.
 *
 * ## A regra destes testes
 *
 * **Nenhum nome de arquivo é entregue ao supervisor pelo teste.** O script do
 * Codex aqui nunca escreve "README.md": ele lê os caminhos do próprio prompt,
 * como o Codex real faria. Um teste que passasse o caminho pronto provaria a
 * leitura e esconderia exatamente o defeito que existia — que era a
 * *descoberta*.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import { FakeRepository } from './helpers/fake-repository.js';
import type { DesktopFixture } from './helpers/desktop-fixture.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';
import type { AgentInput } from '../src/core/types.js';

const OWNER = 'arcanjog1';
const REPO = 'MeuBotao.pushbutton';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

/**
 * The paths the supervisor can see in its prompt.
 *
 * This is the whole point: the scripted Codex learns filenames the way the
 * real one must - by reading them out of what the application put in front of
 * it. If discovery is broken, this returns nothing and every case below fails.
 */
function pathsVisibleTo(prompt: string): string[] {
  const start = prompt.indexOf('FILES IN THIS REPOSITORY');
  if (start === -1) return [];
  const block = prompt.slice(start);
  const end = block.indexOf('\n\n');
  return (end === -1 ? block : block.slice(0, end))
    .split('\n')
    .slice(1)
    .map((line) => line.trim().replace(/\s*\(\d+ bytes\)$/, ''))
    .filter((line) => line.length > 0 && !line.startsWith('...') && !line.startsWith('ATENÇÃO'));
}

interface Prepared {
  fixture: DesktopFixture;
  github: FakeRepository;
  sessionId: string;
  workspaceId: string;
  workerCalls: AgentInput[];
  cleanup(): Promise<void>;
}

async function prepare(options: {
  files: Record<string, string>;
  orchestrator: (input: AgentInput) => string;
  connected?: boolean;
  isPrivate?: boolean;
  defaultBranch?: string;
  maxIterations?: number;
  worker?: (input: AgentInput) => string;
}): Promise<Prepared> {
  const github = new FakeRepository({
    owner: OWNER,
    repo: REPO,
    defaultBranch: options.defaultBranch ?? 'main',
    files: options.files,
    ...(options.isPrivate ? { isPrivate: true } : {}),
  });
  const workerCalls: AgentInput[] = [];
  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', [options.orchestrator]);
  const worker = new ScriptedAgent('mock-claude', 'Claude', [
    (input: AgentInput) => {
      workerCalls.push(input);
      // The real worker's honest answer, kept verbatim: there is no checkout,
      // so it cannot list anything. If the engine delegates discovery here,
      // this is what comes back and the case fails.
      if (options.worker) return options.worker(input);
      return 'Não existe checkout local neste projeto; não há como listar arquivos daqui.';
    },
  ]);
  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    github: { fetchImpl: github.fetch },
    secrets: {
      available: true,
      encrypt: (plain: string) => Buffer.from(plain, 'utf8').toString('base64'),
      decrypt: (cipher: string) => Buffer.from(cipher, 'base64').toString('utf8'),
    },
    maxIterations: options.maxIterations ?? 3,
  });

  if (options.connected !== false) {
    value(await fixture.router.handle('github.configure', { clientId: 'Iv1.fake' }));
    value(await fixture.router.handle('github.connect', undefined));
    const deadline = Date.now() + 5000;
    for (;;) {
      const status = value<{ connected: boolean }>(await fixture.router.handle('github.status', undefined));
      if (status.connected) break;
      if (Date.now() > deadline) throw new Error('o GitHub não conectou a tempo');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
    workerCalls,
    sessionId: session.id,
    workspaceId: workspace.id,
    async cleanup() {
      await fixture.cleanup();
    },
  };
}

async function ask(prepared: Prepared, text: string) {
  const sent = value<{ run: { id: string } }>(
    await prepared.fixture.router.handle('chat.sendMessage', { sessionId: prepared.sessionId, text }),
  );
  const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);
  const detail = value<{ steps: ReadonlyArray<{ phase: string; status: string; summary: string | null }> }>(
    await prepared.fixture.router.handle('run.detail', { runId: sent.run.id }),
  );
  // What the person actually reads. The run's own `summary` is its termination
  // reason, not the answer, so an assertion about the answer belongs here.
  const messages = value<ReadonlyArray<{ author: string; text: string }>>(
    await prepared.fixture.router.handle('chat.listMessages', { sessionId: prepared.sessionId }),
  );
  const answer = messages
    .filter((message) => message.author === 'orchestrator')
    .map((message) => message.text)
    .join('\n');
  return { run, steps: detail.steps, messages, answer };
}

const PROJECT = {
  'README.md': '# MeuBotao\n\nUm botão para o Revit.\n',
  'src/index.ts': 'export * from "./auth/login.js";\n',
  'src/auth/login.ts': 'export function login(user: string) { return user; }\n',
};

/* --------------------------------------------------------------- o incidente */

test('o incidente, literal: "consegue ler os arquivos q tem nesse repositorio?"', async () => {
  let seen: string[] = [];
  const prepared = await prepare({
    files: PROJECT,
    orchestrator: (input: AgentInput) => {
      // O supervisor lê os caminhos do próprio prompt. Nenhum nome de arquivo
      // é fornecido por este teste em lugar nenhum.
      seen = pathsVisibleTo(input.prompt);
      return JSON.stringify({
        action: 'done',
        acceptanceCriteria: [],
        verificationCommands: [],
        summary: `Os arquivos deste repositório são: ${seen.join(', ')}.`,
      });
    },
  });
  try {
    const { run, steps, answer } = await ask(prepared, 'consegue ler os arquivos q tem nesse repositorio?');

    // A prova de descoberta: o supervisor viu os caminhos reais, e este teste
    // nunca os escreveu.
    assert.deepEqual(seen.sort(), ['README.md', 'src/auth/login.ts', 'src/index.ts']);
    // And the answer with those paths in it reached the conversation.
    assert.match(answer, /src\/auth\/login\.ts/);

    // E nada disso passou por um worker, por uma pasta, ou por revisão humana.
    assert.equal(prepared.workerCalls.length, 0, 'nenhum worker foi chamado só para listar');
    assert.notEqual(run.status, 'NEEDS_HUMAN');
    assert.notEqual(run.status, 'BLOCKED');
    assert.equal(run.status, 'DONE');
    assert.ok(
      steps.some((step) => step.phase === 'repository-tree' && step.status === 'read'),
      'a árvore foi lida pela API',
    );
  } finally {
    await prepared.cleanup();
  }
});

/* ------------------------------------------------------------------ casos 1-3 */

test('caso 1: "quais arquivos existem?" é respondido com os caminhos reais, sem worker', async () => {
  let seen: string[] = [];
  const prepared = await prepare({
    files: PROJECT,
    orchestrator: (input: AgentInput) => {
      seen = pathsVisibleTo(input.prompt);
      return JSON.stringify({
        action: 'done',
        acceptanceCriteria: [],
        verificationCommands: [],
        summary: seen.join(', '),
      });
    },
  });
  try {
    const { run } = await ask(prepared, 'quais arquivos existem neste repositório?');
    assert.equal(run.status, 'DONE');
    assert.equal(seen.length, 3);
    assert.equal(prepared.workerCalls.length, 0);
  } finally {
    await prepared.cleanup();
  }
});

test('caso 2: "leia o README" descobre o caminho e recebe o conteúdo real', async () => {
  let round = 0;
  let content: string | null = null;
  const prepared = await prepare({
    files: PROJECT,
    orchestrator: (input: AgentInput) => {
      round += 1;
      if (round === 1) {
        // Escolhe o README entre os caminhos que viu - sem que ninguém lhe
        // dissesse que existe um README.
        const readme = pathsVisibleTo(input.prompt).find((path) => /readme/i.test(path));
        assert.ok(readme, 'o supervisor viu um README na árvore');
        return JSON.stringify({
          action: 'verify',
          acceptanceCriteria: [],
          verificationCommands: [],
          fileReads: [{ path: readme, maxBytes: null }],
          summary: 'Vou ler o README.',
        });
      }
      // O conteúdo real chega no prompt da rodada seguinte.
      const marker = input.prompt.indexOf('Um botão para o Revit.');
      content = marker === -1 ? null : 'encontrado';
      return JSON.stringify({
        action: 'done',
        acceptanceCriteria: [],
        verificationCommands: [],
        summary: 'É um botão para o Revit.',
      });
    },
    maxIterations: 3,
  });
  try {
    const { run, steps } = await ask(prepared, 'leia o README e me diga do que se trata');
    assert.equal(content, 'encontrado', 'o conteúdo real do arquivo chegou ao supervisor');
    assert.equal(run.status, 'DONE');
    assert.ok(steps.some((step) => step.phase === 'file-read'));
    assert.equal(prepared.workerCalls.length, 0);
  } finally {
    await prepared.cleanup();
  }
});

test('caso 3: "onde está a lógica de login?" filtra a árvore e abre o candidato', async () => {
  let round = 0;
  let listed: string[] = [];
  let sawSource = false;
  const prepared = await prepare({
    files: PROJECT,
    orchestrator: (input: AgentInput) => {
      round += 1;
      if (round === 1) {
        return JSON.stringify({
          action: 'verify',
          acceptanceCriteria: [],
          verificationCommands: [],
          listFiles: { prefix: null, contains: 'login', limit: null },
          summary: 'Procurando os caminhos que falam de login.',
        });
      }
      if (round === 2) {
        const start = input.prompt.indexOf('FILES YOU ASKED FOR');
        assert.notEqual(start, -1, 'a listagem filtrada voltou');
        listed = input.prompt
          .slice(start)
          .split('\n')
          .slice(1)
          .map((line) => line.trim().replace(/\s*\(\d+ bytes\)$/, ''))
          .filter((line) => line.includes('/') || line.endsWith('.ts'));
        return JSON.stringify({
          action: 'verify',
          acceptanceCriteria: [],
          verificationCommands: [],
          fileReads: [{ path: listed[0], maxBytes: null }],
          summary: 'Vou abrir o candidato.',
        });
      }
      sawSource = input.prompt.includes('export function login');
      return JSON.stringify({
        action: 'done',
        acceptanceCriteria: [],
        verificationCommands: [],
        summary: 'A lógica de login está em src/auth/login.ts.',
      });
    },
    maxIterations: 4,
  });
  try {
    const { run, steps } = await ask(prepared, 'onde está a lógica de login?');
    assert.deepEqual(listed, ['src/auth/login.ts']);
    assert.equal(sawSource, true, 'o código real chegou ao supervisor');
    assert.equal(run.status, 'DONE');
    assert.ok(steps.some((step) => step.phase === 'repository-tree' && step.status === 'listed'));
    assert.equal(prepared.workerCalls.length, 0, 'nenhuma busca em pasta vazia');
  } finally {
    await prepared.cleanup();
  }
});

/* -------------------------------------------------------------- casos 4 a 7 */

test('caso 4: uma árvore truncada nunca é apresentada como completa', async () => {
  let warned = false;
  const many: Record<string, string> = {};
  for (let i = 0; i < 400; i += 1) many[`arquivo-${String(i).padStart(3, '0')}.txt`] = `${i}\n`;
  const prepared = await prepare({
    files: many,
    orchestrator: (input: AgentInput) => {
      // A prévia é capada, e diz que é.
      warned = /caminho\(s\) a mais correspondem e não estão/.test(input.prompt);
      return JSON.stringify({
        action: 'done',
        acceptanceCriteria: [],
        verificationCommands: [],
        summary: 'Listagem parcial.',
      });
    },
  });
  try {
    await ask(prepared, 'quais arquivos existem?');
    assert.equal(warned, true, 'a prévia diz que foi capada e como pedir o resto');
  } finally {
    await prepared.cleanup();
  }
});

test('caso 5: um arquivo inexistente é ausência daquele arquivo, não repositório vazio', async () => {
  let round = 0;
  let message = '';
  const prepared = await prepare({
    files: PROJECT,
    orchestrator: (input: AgentInput) => {
      round += 1;
      if (round === 1) {
        return JSON.stringify({
          action: 'verify',
          acceptanceCriteria: [],
          verificationCommands: [],
          fileReads: [{ path: 'nao/existe.txt', maxBytes: null }],
          summary: 'Vou tentar ler um arquivo que não existe.',
        });
      }
      message = input.prompt;
      return JSON.stringify({
        action: 'done',
        acceptanceCriteria: [],
        verificationCommands: [],
        summary: 'Aquele arquivo não existe.',
      });
    },
    maxIterations: 3,
  });
  try {
    await ask(prepared, 'leia nao/existe.txt');
    assert.match(message, /não existe/);
    // E a árvore continua lá, com os arquivos que existem: a ausência de um
    // arquivo não apaga o repositório.
    assert.ok(pathsVisibleTo(message).length === 3 || message.includes('README.md'));
  } finally {
    await prepared.cleanup();
  }
});

test('caso 6: um repositório público funciona sem login nenhum', async () => {
  let seen: string[] = [];
  const prepared = await prepare({
    files: PROJECT,
    connected: false,
    orchestrator: (input: AgentInput) => {
      seen = pathsVisibleTo(input.prompt);
      return JSON.stringify({
        action: 'done',
        acceptanceCriteria: [],
        verificationCommands: [],
        summary: seen.join(', '),
      });
    },
  });
  try {
    const { run } = await ask(prepared, 'consegue ler os arquivos q tem nesse repositorio?');
    assert.equal(seen.length, 3, 'a árvore veio anonimamente');
    assert.equal(run.status, 'DONE');
  } finally {
    await prepared.cleanup();
  }
});

test('caso 7: um repositório privado autorizado segue exatamente o mesmo caminho', async () => {
  let seen: string[] = [];
  const prepared = await prepare({
    files: PROJECT,
    isPrivate: true,
    orchestrator: (input: AgentInput) => {
      seen = pathsVisibleTo(input.prompt);
      return JSON.stringify({
        action: 'done',
        acceptanceCriteria: [],
        verificationCommands: [],
        summary: seen.join(', '),
      });
    },
  });
  try {
    const { run } = await ask(prepared, 'quais arquivos existem?');
    assert.equal(seen.length, 3);
    assert.equal(run.status, 'DONE');
  } finally {
    await prepared.cleanup();
  }
});

/* ------------------------------------------------- não parar pelo que dá pra obter */

test('um "blocked" por falta da lista de arquivos é respondido, não vira revisão humana', async () => {
  // A regra do §6: NEEDS_HUMAN/BLOCKED é para o que o aplicativo não consegue
  // obter. A árvore ele consegue.
  let round = 0;
  let offered = false;
  const prepared = await prepare({
    files: PROJECT,
    orchestrator: (input: AgentInput) => {
      round += 1;
      if (round === 1) {
        return JSON.stringify({
          action: 'blocked',
          reason: 'Não tenho a árvore de arquivos do repositório.',
          acceptanceCriteria: [],
          verificationCommands: [],
        });
      }
      offered = input.prompt.includes('VOCÊ DISSE QUE ESTAVA BLOQUEADO');
      return JSON.stringify({
        action: 'done',
        acceptanceCriteria: [],
        verificationCommands: [],
        summary: 'Agora tenho os arquivos.',
      });
    },
    maxIterations: 3,
  });
  try {
    const { run, steps } = await ask(prepared, 'analise este repositório');
    assert.equal(offered, true, 'o aplicativo ofereceu a lista em vez de parar');
    assert.equal(run.status, 'DONE');
    assert.notEqual(run.status, 'BLOCKED');
    assert.ok(steps.some((step) => step.phase === 'blocked' && step.status === 'answered'));
  } finally {
    await prepared.cleanup();
  }
});


test('fileReads: discovered bytes reach the worker in the SAME delegation, then cited query reaches DONE', async () => {
  let round = 0;
  let scriptPath = '';
  let logicPath = '';
  const prepared = await prepare({
    files: { 'Script.py': 'from nuvem.core import wall_modeling', 'AGENTS.md': 'Project instructions', 'nuvem/core/wall_modeling.py': 'def build_wall(): return 42' },
    maxIterations: 4,
    orchestrator: input => {
      round++;
      if (round === 1) {
        scriptPath = pathsVisibleTo(input.prompt).find(p => p.endsWith('.py') && !p.includes('/'))!;
        return JSON.stringify({ action: 'verify', fileReads: [{path: scriptPath}] });
      }
      if (round === 2) {
        assert.ok(input.prompt.includes('from nuvem.core import wall_modeling'));
        const module = /from (\w+)\.(\w+) import (\w+)/.exec(input.prompt)!;
        logicPath = [module[1], module[2], module[3]].join('/') + '.py';
        return JSON.stringify({ action: 'delegate', task: 'Explique a lógica nos arquivos fornecidos.', fileReads: [{path: logicPath}], acceptanceCriteria: ['Localizar a lógica'] });
      }
      return JSON.stringify({action: 'done', summary: 'A lógica está em ' + logicPath + ', função build_wall.', queryProof: { criteria: ['Localizar a lógica'], citations: [{path: logicPath, quote: 'def build_wall(): return 42'}] } });
    },
    worker: input => {
      assert.ok(input.prompt.includes('from nuvem.core import wall_modeling'));
      assert.ok(input.prompt.includes('def build_wall(): return 42'));
      return 'A lógica está em nuvem/core/wall_modeling.py.';
    },
  });
  try {
    const result = await ask(prepared, 'onde está a lógica do botão?');
    assert.equal(result.run.status, 'DONE', JSON.stringify(result));
    assert.equal(prepared.workerCalls.length, 1);
    assert.ok(result.steps.some(s => s.phase === 'file-context' && s.status === 'worker-carried'));
    assert.ok(result.steps.some(s => s.phase === 'query-proof' && s.status === 'passed'));
  } finally { await prepared.cleanup(); }
});

test('missing payload report stops before a repeated delegation or escalation', async () => {
  const prepared = await prepare({
    files: {'Script.py': 'print(42)'}, maxIterations: 8,
    orchestrator: input => JSON.stringify({action:'delegate', task:'Analise o arquivo fornecido.', fileReads: [{path: pathsVisibleTo(input.prompt)[0]}]}),
    worker: () => 'não recebi o conteúdo de nenhum arquivo',
  });
  try {
    const result = await ask(prepared, 'onde está a lógica?');
    assert.equal(result.run.status, 'NEEDS_HUMAN');
    assert.equal(prepared.workerCalls.length, 1);
    assert.ok(result.steps.some(s => s.phase === 'file-read' && s.status === 'not-carried'));
  } finally { await prepared.cleanup(); }
});
