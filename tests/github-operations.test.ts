/**
 * Trabalhar no repositório sem checkout — e sem mentir sobre o que aconteceu.
 *
 * O pedido: "quero trabalhar diretamente com meus repositórios GitHub, sem
 * precisar clonar manualmente cada projeto". A API oficial faz isso — leitura,
 * blobs, árvores, commits, referências, PRs — e não faz outra coisa: **não
 * executa código**. Estes testes fixam as duas metades.
 *
 * O falso repositório em `helpers/fake-repository.ts` guarda blobs, árvores, commits e
 * referências como o git guarda, então "a árvore ficou igual" e "a branch não
 * era fast-forward" são observações, não flags que o teste liga.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPERATION_LIMITS,
  RepositoryConflictError,
  RepositoryOperations,
  UnsupportedChangeError,
  pathProblem,
} from '../src/github/repository-operations.js';
import { GitHubError } from '../src/github/github-client.js';
import { FakeRepository } from './helpers/fake-repository.js';
import type { RepositoryRef } from '../src/github/repository-reader.js';

const REF: RepositoryRef = { owner: 'arcanjo', repo: 'projeto', ref: null };
const TOKEN = 'token-de-teste';

function build(options: {
  files?: Record<string, string>;
  defaultBranch?: string;
  canWrite?: boolean;
}): { github: FakeRepository; operations: RepositoryOperations } {
  const github = new FakeRepository({
    owner: REF.owner,
    repo: REF.repo,
    // Deliberately not `main`: nothing in this application may assume it.
    defaultBranch: options.defaultBranch ?? 'trunk',
    files: options.files ?? { 'README.md': '# projeto\n', 'src/app.ts': 'export const a = 1;\n' },
    ...(options.canWrite === false ? { canWrite: false } : {}),
  });
  return {
    github,
    operations: new RepositoryOperations({ fetchImpl: github.fetch }),
  };
}

/* ---------------------------------------------------------------- leitura */

test('a branch padrão vem do GitHub, e o ref é resolvido para um commit real', async () => {
  const { github, operations } = build({ defaultBranch: 'principal' });
  const resolved = await operations.resolveRef(REF, 'principal', TOKEN);
  assert.equal(resolved.commitSha, github.head('principal'));
  assert.ok(resolved.treeSha.length > 0);
  // E `main` não existe, porque ninguém disse que existia.
  await assert.rejects(() => operations.resolveRef(REF, 'main', TOKEN), GitHubError);
});

test('a árvore lista os arquivos com tamanho e sha, e diz quando foi truncada', async () => {
  const { operations } = build({ files: { 'a.txt': 'a\n', 'dir/b.txt': 'bb\n' } });
  const tree = await operations.tree(REF, 'trunk', TOKEN);
  assert.deepEqual(tree.entries.map((entry) => entry.path).sort(), ['a.txt', 'dir/b.txt']);
  assert.equal(tree.entries.find((entry) => entry.path === 'dir/b.txt')?.size, 3);
  assert.equal(tree.truncated, false);
});

test('um arquivo de texto volta como texto, e bytes que não são UTF-8 voltam como binário', async () => {
  const { github, operations } = build({ files: { 'README.md': '# olá\n' } });
  const text = await operations.readFile(REF, 'README.md', 'trunk', TOKEN);
  assert.equal(text.text, '# olá\n');
  assert.equal(text.isBinary, false);
  assert.equal(text.truncated, false);

  github.pushDirectly('trunk', { 'logo.png': '\u0000PNG\u0001\u0002' });
  const binary = await operations.readFile(REF, 'logo.png', 'trunk', TOKEN);
  // Bytes que não são texto não viram texto remendado: viram "binário", com o
  // tamanho, que é a única coisa honesta a dizer sobre eles.
  assert.equal(binary.text, null);
  assert.equal(binary.isBinary, true);
  assert.ok(binary.bytes > 0);
});

test('um arquivo grande demais é relatado como truncado, com o tamanho, e não como vazio', async () => {
  const { operations } = build({ files: { 'grande.txt': 'x'.repeat(5000) } });
  const small = new RepositoryOperations({
    fetchImpl: build({ files: { 'grande.txt': 'x'.repeat(5000) } }).github.fetch,
    limits: { maxFileBytes: 100 },
  });
  const file = await small.readFile(REF, 'grande.txt', 'trunk', TOKEN);
  assert.equal(file.truncated, true);
  assert.equal(file.text, null);
  assert.equal(file.bytes, 5000);
  // E o mesmo arquivo, sem o limite apertado, volta inteiro.
  assert.equal((await operations.readFile(REF, 'grande.txt', 'trunk', TOKEN)).text?.length, 5000);
});

test('commits e diff vêm do GitHub, não de um relato', async () => {
  const { github, operations } = build({ files: { 'a.txt': '1\n' } });
  const base = github.head('trunk')!;
  github.pushDirectly('trunk', { 'a.txt': '2\n', 'b.txt': 'novo\n' }, 'segunda');

  const commits = await operations.commits(REF, 'trunk', TOKEN, 5);
  assert.equal(commits[0]?.message, 'segunda');
  assert.equal(commits.length, 2);

  const diff = await operations.compare(REF, base, 'trunk', TOKEN);
  assert.deepEqual(
    diff.files.map((file) => [file.path, file.status]),
    [
      ['a.txt', 'modified'],
      ['b.txt', 'added'],
    ],
  );
});

test('um repositório privado sem acesso responde como inexistente, e a mensagem diz por quê', async () => {
  const operations = new RepositoryOperations({
    fetchImpl: (async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })) as typeof fetch,
  });
  await assert.rejects(
    () => operations.tree(REF, 'trunk', null),
    (error: unknown) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.kind, 'not-found');
      assert.match(error.message, /privado.*o GitHub responde igual nos dois casos/s);
      return true;
    },
  );
});

test('uma falha de rede é uma falha de rede, e não vira "repositório não existe"', async () => {
  const operations = new RepositoryOperations({
    fetchImpl: (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch,
  });
  await assert.rejects(
    () => operations.tree(REF, 'trunk', TOKEN),
    (error: unknown) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.kind, 'network');
      return true;
    },
  );
});

/* ----------------------------------------------------------------- escrita */

test('branch de trabalho, alteração e commit: um commit só, e a origem intocada', async () => {
  const { github, operations } = build({ files: { 'README.md': '# antes\n', 'src/app.ts': 'a\n' } });
  const origin = github.head('trunk')!;

  const branch = await operations.createBranch(REF, 'orq/tarefa-1', origin, TOKEN);
  assert.equal(branch.commitSha, origin);

  const result = await operations.commit(
    REF,
    {
      branch: 'orq/tarefa-1',
      expectedHeadSha: origin,
      message: 'Corrige o README',
      changes: [{ op: 'write', path: 'README.md', text: '# depois\n' }],
    },
    TOKEN,
  );

  assert.equal(result.committed, true);
  assert.deepEqual(result.written, ['README.md']);
  assert.equal(result.parentSha, origin);
  // A branch de trabalho mudou; a de origem não. Nada de commit na principal.
  assert.equal(github.head('orq/tarefa-1'), result.commitSha);
  assert.equal(github.head('trunk'), origin);
  assert.deepEqual(github.snapshot('orq/tarefa-1'), { 'README.md': '# depois\n', 'src/app.ts': 'a\n' });
});

test('vários arquivos viram um commit coerente, nunca uma sequência de commits', async () => {
  const { github, operations } = build({ files: { 'a.txt': '1\n', 'b.txt': '2\n', 'c.txt': '3\n' } });
  const origin = github.head('trunk')!;
  await operations.createBranch(REF, 'orq/multi', origin, TOKEN);

  const result = await operations.commit(
    REF,
    {
      branch: 'orq/multi',
      expectedHeadSha: origin,
      message: 'Três de uma vez',
      changes: [
        { op: 'write', path: 'a.txt', text: 'um\n' },
        { op: 'write', path: 'novo/d.txt', text: 'quatro\n' },
        { op: 'delete', path: 'c.txt' },
      ],
    },
    TOKEN,
  );

  assert.equal(result.committed, true);
  assert.deepEqual(result.written, ['a.txt', 'novo/d.txt']);
  assert.deepEqual(result.deleted, ['c.txt']);
  assert.deepEqual(github.snapshot('orq/multi'), {
    'a.txt': 'um\n',
    'b.txt': '2\n',
    'novo/d.txt': 'quatro\n',
  });
  // Um commit, e um só: o pai dele é a origem.
  const commits = await operations.commits(REF, 'orq/multi', TOKEN, 10);
  assert.equal(commits.length, 2);
  assert.equal(commits[0]?.sha, result.commitSha);
});

test('escrever o conteúdo que já existe não cria commit nenhum', async () => {
  // "Se a tarefa não produziu alterações, não crie commit vazio apenas para
  // apresentar progresso."
  const { github, operations } = build({ files: { 'a.txt': 'igual\n' } });
  const origin = github.head('trunk')!;
  await operations.createBranch(REF, 'orq/nada', origin, TOKEN);

  const result = await operations.commit(
    REF,
    {
      branch: 'orq/nada',
      expectedHeadSha: origin,
      message: 'Sem novidade',
      changes: [{ op: 'write', path: 'a.txt', text: 'igual\n' }],
    },
    TOKEN,
  );

  assert.equal(result.committed, false);
  assert.equal(result.commitSha, null);
  assert.match(result.note ?? '', /idêntica/);
  assert.equal(github.head('orq/nada'), origin, 'a branch não se moveu');
});

test('uma branch que mudou desde o preparo é um conflito, e nada é escrito', async () => {
  const { github, operations } = build({ files: { 'a.txt': '1\n' } });
  const origin = github.head('trunk')!;
  await operations.createBranch(REF, 'orq/conflito', origin, TOKEN);
  // Outra pessoa (ou outra run) publica primeiro.
  const moved = github.pushDirectly('orq/conflito', { 'a.txt': 'de outra pessoa\n' });

  const before = github.calls.length;
  await assert.rejects(
    () =>
      operations.commit(
        REF,
        {
          branch: 'orq/conflito',
          expectedHeadSha: origin,
          message: 'Minha versão',
          changes: [{ op: 'write', path: 'a.txt', text: 'minha versão\n' }],
        },
        TOKEN,
      ),
    (error: unknown) => {
      assert.ok(error instanceof RepositoryConflictError);
      assert.equal(error.expectedSha, origin);
      assert.equal(error.actualSha, moved);
      assert.match(error.message, /Nada foi escrito/);
      return true;
    },
  );

  // E o trabalho da outra pessoa continua lá, inteiro.
  assert.deepEqual(github.snapshot('orq/conflito'), { 'a.txt': 'de outra pessoa\n' });
  // Nenhum blob foi criado: a checagem acontece antes de qualquer escrita.
  const written = github.calls.slice(before).filter((call) => call.method === 'POST');
  assert.deepEqual(written, []);
});

test('uma branch que muda durante o commit é recusada pelo force:false, sem sobrescrever', async () => {
  const { github, operations } = build({ files: { 'a.txt': '1\n' } });
  const origin = github.head('trunk')!;
  await operations.createBranch(REF, 'orq/corrida', origin, TOKEN);

  // A corrida: a branch se move entre a verificação e o PATCH da referência.
  github.onBeforeRefUpdate = () => {
    github.onBeforeRefUpdate = null;
    github.pushDirectly('orq/corrida', { 'a.txt': 'chegou antes\n' });
  };

  await assert.rejects(
    () =>
      operations.commit(
        REF,
        {
          branch: 'orq/corrida',
          expectedHeadSha: origin,
          message: 'Minha versão',
          changes: [{ op: 'write', path: 'a.txt', text: 'minha versão\n' }],
        },
        TOKEN,
      ),
    RepositoryConflictError,
  );
  assert.deepEqual(github.snapshot('orq/corrida'), { 'a.txt': 'chegou antes\n' });
});

test('remover um arquivo que não existe é recusado pelo nome, antes de escrever', async () => {
  const { github, operations } = build({ files: { 'a.txt': '1\n' } });
  const origin = github.head('trunk')!;
  await operations.createBranch(REF, 'orq/remove', origin, TOKEN);

  await assert.rejects(
    () =>
      operations.commit(
        REF,
        {
          branch: 'orq/remove',
          expectedHeadSha: origin,
          message: 'Remove',
          changes: [{ op: 'delete', path: 'nunca-existiu.txt' }],
        },
        TOKEN,
      ),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedChangeError);
      assert.match(error.message, /nunca-existiu\.txt/);
      assert.match(error.message, /Nada foi escrito/);
      return true;
    },
  );
  assert.equal(github.head('orq/remove'), origin);
});

test('sem permissão de escrita, a resposta diz que é permissão — não que o repositório sumiu', async () => {
  const { github, operations } = build({ files: { 'a.txt': '1\n' }, canWrite: false });
  const origin = github.head('trunk')!;
  await assert.rejects(
    () => operations.createBranch(REF, 'orq/sem-permissao', origin, TOKEN),
    (error: unknown) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.kind, 'forbidden');
      assert.match(error.message, /permissão de escrita|branch pode estar protegida/);
      return true;
    },
  );
  assert.deepEqual(github.branches(), ['trunk']);
});

test('uma branch que já existe não é tomada de volta', async () => {
  const { github, operations } = build({ files: { 'a.txt': '1\n' } });
  const origin = github.head('trunk')!;
  await operations.createBranch(REF, 'orq/ocupada', origin, TOKEN);
  const mine = github.pushDirectly('orq/ocupada', { 'a.txt': 'trabalho de alguém\n' });
  await assert.rejects(() => operations.createBranch(REF, 'orq/ocupada', origin, TOKEN), GitHubError);
  assert.equal(github.head('orq/ocupada'), mine);
});

/* --------------------------------------------------- o que nem é tentado */

test('um caminho que sai do repositório, é absoluto, ou é do Windows, é recusado', () => {
  assert.match(pathProblem('../fora.txt')!, /sai da raiz/);
  assert.match(pathProblem('/etc/passwd')!, /absoluto/);
  assert.match(pathProblem('C:\\Users\\x\\a.txt')!, /caminho do Windows/);
  assert.match(pathProblem('a\\b.txt')!, /usa "\\"\. Caminhos/);
  assert.match(pathProblem('.git/config')!, /\.git/);
  assert.match(pathProblem('')!, /vazio/);
  assert.match(pathProblem('a/../b.txt')!, /sai da raiz/);
  assert.match(pathProblem('x'.repeat(500))!, /longo demais/);
  assert.equal(pathProblem('src/app.ts'), null);
  assert.equal(pathProblem('dir com espaço/arquivo.md'), null);
});

test('conteúdo ausente, dobrado ou grande demais é recusado pelo nome do arquivo', async () => {
  const { github, operations } = build({ files: { 'a.txt': '1\n' } });
  const origin = github.head('trunk')!;
  const attempt = (changes: Parameters<RepositoryOperations['commit']>[1]['changes']) =>
    operations.commit(REF, { branch: 'trunk', expectedHeadSha: origin, message: 'm', changes }, TOKEN);

  await assert.rejects(
    () => attempt([{ op: 'write', path: 'a.txt' }]),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedChangeError);
      assert.equal(error.reason, 'missing-content');
      // E diz qual é a operação certa, porque vazio e removido não são o mesmo.
      assert.match(error.message, /"delete"/);
      return true;
    },
  );
  await assert.rejects(
    () => attempt([{ op: 'write', path: 'a.txt', text: 'x', base64: 'eA==' }]),
    (error: unknown) => (error as UnsupportedChangeError).reason === 'both-encodings',
  );
  await assert.rejects(
    () => attempt([{ op: 'write', path: 'a.txt', text: 'x'.repeat(OPERATION_LIMITS.maxFileBytes + 1) }]),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedChangeError);
      assert.equal(error.reason, 'too-large');
      // A alternativa real é dita, em vez de "não deu".
      assert.match(error.message, /executor com checkout/);
      return true;
    },
  );
  await assert.rejects(
    () =>
      attempt([
        { op: 'write', path: 'a.txt', text: '1' },
        { op: 'write', path: 'a.txt', text: '2' },
      ]),
    (error: unknown) => (error as UnsupportedChangeError).reason === 'invalid-path',
  );
  await assert.rejects(() => attempt([]), UnsupportedChangeError);

  // Nenhuma dessas tentativas mexeu no repositório.
  assert.equal(github.head('trunk'), origin);
});

test('um arquivo binário é escrito como bytes, sem passar por texto', async () => {
  const { github, operations } = build({ files: { 'a.txt': '1\n' } });
  const origin = github.head('trunk')!;
  await operations.createBranch(REF, 'orq/bin', origin, TOKEN);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
  const result = await operations.commit(
    REF,
    {
      branch: 'orq/bin',
      expectedHeadSha: origin,
      message: 'Adiciona um ícone',
      changes: [{ op: 'write', path: 'icone.png', base64: bytes.toString('base64') }],
    },
    TOKEN,
  );
  assert.equal(result.committed, true);
  const read = await operations.readFile(REF, 'icone.png', 'orq/bin', TOKEN);
  assert.equal(read.isBinary, true);
  assert.equal(read.bytes, bytes.byteLength);
});

/* --------------------------------------------------------------------- PR */

test('o PR sai da branch de trabalho para a de origem, e nada é mesclado', async () => {
  const { github, operations } = build({ files: { 'a.txt': '1\n' } });
  const origin = github.head('trunk')!;
  await operations.createBranch(REF, 'orq/pr', origin, TOKEN);
  await operations.commit(
    REF,
    {
      branch: 'orq/pr',
      expectedHeadSha: origin,
      message: 'Altera',
      changes: [{ op: 'write', path: 'a.txt', text: '2\n' }],
    },
    TOKEN,
  );

  const pull = await operations.openPullRequest(
    REF,
    { head: 'orq/pr', base: 'trunk', title: 'Altera a.txt', body: 'Feito pelo Orquestrador.' },
    TOKEN,
  );
  assert.equal(pull.number, 1);
  assert.equal(pull.base, 'trunk');
  assert.match(pull.htmlUrl, /\/pull\/1$/);
  // A branch de origem continua onde estava: abrir um PR não é mesclar.
  assert.equal(github.head('trunk'), origin);
  assert.equal(github.pullRequests().length, 1);
});

test('um cancelamento no meio interrompe a operação sem publicar nada', async () => {
  const { github, operations } = build({ files: { 'a.txt': '1\n' } });
  const origin = github.head('trunk')!;
  await operations.createBranch(REF, 'orq/cancel', origin, TOKEN);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      operations.commit(
        REF,
        {
          branch: 'orq/cancel',
          expectedHeadSha: origin,
          message: 'm',
          changes: [{ op: 'write', path: 'a.txt', text: '2\n' }],
        },
        TOKEN,
        controller.signal,
      ),
  );
  assert.equal(github.head('orq/cancel'), origin);
});
