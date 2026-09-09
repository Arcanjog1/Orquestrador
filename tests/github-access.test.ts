/**
 * "Arcanjog1/teste não encontrado" — para um repositório que existe.
 *
 * O incidente: a pessoa criou um repositório **privado**, conectou o GitHub,
 * autorizou o aplicativo na tela oficial, selecionou o projeto — e o
 * aplicativo respondeu 404, com todos os campos do painel dizendo "não
 * informado". A execução terminou em NEEDS_HUMAN com 0 iterações e 0
 * invocações, sem dizer o que fazer.
 *
 * A causa: **um token guardado foi tratado como prova de acesso**. Quatro
 * situações diferentes chegam ao aplicativo como o mesmo 404 — ninguém
 * conectado, credencial expirada, App instalado em outro lugar, e repositório
 * que realmente não existe — e o GitHub responde igual de propósito, para que
 * um token não sirva para descobrir quais repositórios privados existem. Três
 * das quatro têm conserto, e cada uma em uma tela diferente.
 *
 * Cada teste aqui mede um fato: como a requisição terminou, se alguma
 * credencial foi enviada, quem o GitHub diz que ela é, e o que a instalação
 * cobre. Nenhum deles conclui coisa alguma da presença de uma linha no banco.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import { FakeRepository, type FakeRepositoryOptions } from './helpers/fake-repository.js';
import type { DesktopFixture } from './helpers/desktop-fixture.js';
import type { IpcResult, RepositoryCapabilitiesView } from '../apps/desktop/src/shared/ipc-contract.js';

const OWNER = 'Arcanjog1';
const REPO = 'teste';
const FULL = `${OWNER}/${REPO}`;

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

interface Prepared {
  fixture: DesktopFixture;
  github: FakeRepository;
  workspaceId: string;
  sessionId: string;
  capabilities(): Promise<RepositoryCapabilitiesView>;
  cleanup(): Promise<void>;
}

async function prepare(options: {
  repository?: Partial<FakeRepositoryOptions>;
  connected?: boolean;
}): Promise<Prepared> {
  const github = new FakeRepository({
    owner: OWNER,
    repo: REPO,
    defaultBranch: 'main',
    files: { 'README.md': '# teste\n' },
    isPrivate: true,
    ...options.repository,
  });
  const agent = new ScriptedAgent('mock-codex', 'Codex', [
    () => JSON.stringify({ action: 'done', acceptanceCriteria: [], verificationCommands: [], summary: 'ok' }),
  ]);
  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator: agent, worker: agent, workerAccountId: null }),
    github: { fetchImpl: github.fetch },
    secrets: {
      available: true,
      encrypt: (plain: string) => Buffer.from(plain, 'utf8').toString('base64'),
      decrypt: (cipher: string) => Buffer.from(cipher, 'base64').toString('utf8'),
    },
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
    await fixture.router.handle('workspace.createGitHub', { repository: FULL }),
  );
  value(await fixture.router.handle('accounts.create', { name: 'Codex', provider: 'openai' }));
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
    workspaceId: workspace.id,
    sessionId: session.id,
    capabilities: async () =>
      value<RepositoryCapabilitiesView>(
        await fixture.router.handle('workspace.githubCapabilities', { workspaceId: workspace.id }),
      ),
    cleanup: () => fixture.cleanup(),
  };
}

/** An installation that covers exactly these repositories. */
function installation(repositories: string[], selection: 'all' | 'selected' = 'selected') {
  return [
    {
      id: 42,
      account: OWNER,
      repositorySelection: selection,
      htmlUrl: 'https://github.com/settings/installations/42',
      repositories,
    },
  ];
}

/* ---- the four situations behind one 404 --------------------------------- */

test('o caminho que funciona: privado, App instalado e cobrindo o repositório', async () => {
  const prepared = await prepare({ repository: { installations: installation([FULL]) } });
  try {
    const view = await prepared.capabilities();
    assert.equal(view.canRead, true);
    assert.equal(view.access, 'ok');
    assert.equal(view.problem, null);
    assert.equal(view.isPrivate, true);
    assert.equal(view.defaultBranch, 'main', 'a branch vem do GitHub, nunca de "main" por suposição');
    assert.equal(view.action, null);
    assert.notEqual(view.fullName, null, '"não informado" era o painel inteiro no incidente');
  } finally {
    await prepared.cleanup();
  }
});

test('ninguém conectado: a leitura foi anônima, e isso não é ausência do repositório', async () => {
  const prepared = await prepare({ connected: false });
  try {
    const view = await prepared.capabilities();
    assert.equal(view.canRead, false);
    assert.equal(view.access, 'not-connected');
    assert.match(view.problem ?? '', /anônima/);
    // O que não pode acontecer: dizer que o repositório não existe.
    assert.doesNotMatch(view.problem ?? '', /não existe/);
  } finally {
    await prepared.cleanup();
  }
});

test('App autorizado na conta, mas não instalado no dono', async () => {
  // Instalado em outra conta: o token é válido, a conta é a certa, e mesmo
  // assim o repositório é invisível.
  const prepared = await prepare({
    repository: {
      visibleToCredential: false,
      installations: [{ id: 7, account: 'outra-conta', repositories: ['outra-conta/x'] }],
    },
  });
  try {
    const view = await prepared.capabilities();
    assert.equal(view.access, 'app-not-installed');
    assert.match(view.problem ?? '', /instalado/);
    assert.equal(view.action?.url, 'https://github.com/settings/installations');
  } finally {
    await prepared.cleanup();
  }
});

test('instalado no dono, mas sem este repositório entre os selecionados', async () => {
  const prepared = await prepare({
    repository: { visibleToCredential: false, installations: installation([`${OWNER}/outro-projeto`]) },
  });
  try {
    const view = await prepared.capabilities();
    assert.equal(view.access, 'repository-not-in-installation');
    assert.match(view.problem ?? '', /não está entre os repositórios/);
    assert.equal(view.action?.url, 'https://github.com/settings/installations/42');
  } finally {
    await prepared.cleanup();
  }
});

test('sem conseguir listar as instalações, o aplicativo diz o que não sabe', async () => {
  // Sem `installations` o endpoint responde 404, como acontece com um token de
  // OAuth App. A resposta honesta é dizer quais possibilidades restam.
  const prepared = await prepare({ repository: { visibleToCredential: false } });
  try {
    const view = await prepared.capabilities();
    assert.equal(view.access, 'unknown');
    assert.match(view.problem ?? '', /não consegui listar as instalações/i);
    assert.notEqual(view.action, null, 'as duas causas prováveis se resolvem na mesma tela');
  } finally {
    await prepared.cleanup();
  }
});

/* ---- os códigos que não são 404 ----------------------------------------- */

test('401: o GitHub não aceitou o login guardado', async () => {
  const prepared = await prepare({ repository: { installations: installation([FULL]) } });
  try {
    prepared.github.failNext = { method: 'GET', pathIncludes: `/repos/${OWNER}/${REPO}`, status: 401 };
    const view = await prepared.capabilities();
    assert.equal(view.access, 'credential-expired');
  } finally {
    await prepared.cleanup();
  }
});

test('403: alcança o repositório, e a permissão do App é que falta', async () => {
  const prepared = await prepare({ repository: { installations: installation([FULL]) } });
  try {
    prepared.github.failNext = { method: 'GET', pathIncludes: `/repos/${OWNER}/${REPO}`, status: 403 };
    const view = await prepared.capabilities();
    assert.equal(view.access, 'insufficient-permission');
    assert.match(view.problem ?? '', /Contents/);
    assert.equal(view.action?.url, 'https://github.com/settings/installations/42');
  } finally {
    await prepared.cleanup();
  }
});

/* ---- a regra que não se dobra ------------------------------------------- */

test('uma leitura autenticada que falha nunca é repetida sem credencial', async () => {
  const prepared = await prepare({
    repository: { visibleToCredential: false, installations: installation([`${OWNER}/outro`]) },
  });
  try {
    await prepared.capabilities();
    const anonymous = prepared.github.calls.filter(
      (call) => call.path.startsWith(`/repos/${OWNER}/${REPO}`) && !call.authorised,
    );
    assert.deepEqual(anonymous, [], 'um retry anônimo responde 404 e vira "não existe"');
  } finally {
    await prepared.cleanup();
  }
});

test('o acesso é medido de novo, e um repositório incluído depois passa a funcionar', async () => {
  // A revalidação é uma medição nova, não uma suposição por ter aberto a tela
  // do GitHub: o mesmo pedido sai de novo, e é ele que decide.
  const covered: string[] = [`${OWNER}/outro`];
  const prepared = await prepare({
    repository: {
      visibleToCredential: false,
      installations: [{ id: 42, account: OWNER, repositories: covered }],
    },
  });
  try {
    assert.equal((await prepared.capabilities()).access, 'repository-not-in-installation');
    covered.push(FULL);
    prepared.github.visible = true;
    const after = await prepared.capabilities();
    assert.equal(after.access, 'ok');
    assert.equal(after.canRead, true);
  } finally {
    await prepared.cleanup();
  }
});

/* ---- e o que a execução faz com isso ------------------------------------ */

test('a execução para com o motivo e o conserto, sem invocar ninguém e sem deixar nada girando', async () => {
  const prepared = await prepare({
    repository: { visibleToCredential: false, installations: installation([`${OWNER}/outro-projeto`]) },
  });
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'consegue ler os arquivos q tem nesse repositorio?',
      }),
    );
    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);
    assert.equal(run.status, 'NEEDS_HUMAN');
    // Isto é o que NEEDS_HUMAN deve significar: existe uma decisão que o
    // aplicativo não pode tomar sozinho, e ela está dita.
    const messages = value<ReadonlyArray<{ text: string }>>(
      await prepared.fixture.router.handle('chat.listMessages', { sessionId: prepared.sessionId }),
    );
    const said = messages.map((m) => m.text).join('\n');
    assert.match(said, /não está entre os repositórios/);
    assert.match(said, /https:\/\/github\.com\/settings\/installations/);

    const detail = value<{
      run: { finishedAt: string | null };
      steps: ReadonlyArray<{ phase: string; status: string }>;
      invocations: readonly unknown[];
    }>(await prepared.fixture.router.handle('run.detail', { runId: sent.run.id }));

    // Nenhum modelo foi chamado: o problema é anterior a qualquer pergunta.
    assert.deepEqual(detail.invocations, []);
    // O relógio congela, e nenhum passo continua girando.
    assert.notEqual(detail.run.finishedAt, null, 'sem finishedAt o tempo continua contando na tela');
    assert.deepEqual(
      detail.steps.filter((step) => ['running', 'started', 'pending'].includes(step.status)),
      [],
    );
  } finally {
    await prepared.cleanup();
  }
});
