/**
 * O worker descreve; o aplicativo executa.
 *
 * Sem checkout, o worker não pode escrever um arquivo — ele só pode *dizer* o
 * que o arquivo deve virar. A falha mais antiga do produto é justamente essa:
 * o modelo narra uma alteração, a narração é tomada pela alteração, e a
 * execução termina "com sucesso" sobre um repositório em que nada mudou.
 *
 * Estes testes fixam a fronteira: só um bloco estruturado, válido, escrito
 * contra o commit em mãos, vira uma alteração. Qualquer outra coisa é uma
 * recusa com motivo — nunca um silêncio, e nunca um "aplicado".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROPOSAL_FENCE,
  proposalInstructions,
  readChangeProposal,
} from '../src/github/change-proposal.js';

const COMMIT = 'da01c0f10d36a8ab828646adb3d1a8599d283bf6';

function block(body: unknown): string {
  return ['Aqui está:', '', '```' + PROPOSAL_FENCE, JSON.stringify(body), '```'].join('\n');
}

test('uma resposta sem bloco não é uma alteração, e não é um erro', () => {
  const result = readChangeProposal('Alterei o README.md para "# depois".', COMMIT);
  assert.deepEqual(result, { kind: 'none' });
});

test('um bloco válido vira uma alteração tipada', () => {
  const result = readChangeProposal(
    block({
      baseCommit: COMMIT,
      message: 'Troca o título',
      changes: [
        { op: 'write', path: 'README.md', text: '# depois\n' },
        { op: 'delete', path: 'velho.md' },
      ],
    }),
    COMMIT,
  );
  assert.equal(result.kind, 'proposal');
  if (result.kind !== 'proposal') return;
  assert.equal(result.proposal.message, 'Troca o título');
  assert.deepEqual(result.proposal.changes, [
    { op: 'write', path: 'README.md', text: '# depois\n' },
    { op: 'delete', path: 'velho.md' },
  ]);
});

test('um bloco escrito contra outro commit é recusado, dizendo qual é o commit em mãos', () => {
  const result = readChangeProposal(
    block({
      baseCommit: '0000000000000000000000000000000000000000',
      message: 'm',
      changes: [{ op: 'write', path: 'a.md', text: 'x' }],
    }),
    COMMIT,
  );
  assert.equal(result.kind, 'invalid');
  if (result.kind !== 'invalid') return;
  assert.match(result.problem, /commit em mãos é da01c0f10d36/);
  assert.match(result.problem, /Nada foi aplicado/);
});

test('o commit abreviado que o worker copiou do prompt é aceito', () => {
  // Git aceita um prefixo inequívoco, e um worker copiando de um prompt copia
  // com frequência a forma curta. Sete é o mínimo do próprio git.
  const result = readChangeProposal(
    block({ baseCommit: COMMIT.slice(0, 12), message: 'm', changes: [{ op: 'write', path: 'a.md', text: 'x' }] }),
    COMMIT,
  );
  assert.equal(result.kind, 'proposal');
  // Mas um prefixo curto demais não: cinco caracteres não identificam nada.
  assert.equal(
    readChangeProposal(
      block({ baseCommit: COMMIT.slice(0, 5), message: 'm', changes: [{ op: 'write', path: 'a.md', text: 'x' }] }),
      COMMIT,
    ).kind,
    'invalid',
  );
});

test('dois blocos são uma ambiguidade, e escolher um seria adivinhar', () => {
  const answer = [
    block({ baseCommit: COMMIT, message: 'a', changes: [{ op: 'write', path: 'a.md', text: '1' }] }),
    block({ baseCommit: COMMIT, message: 'b', changes: [{ op: 'write', path: 'a.md', text: '2' }] }),
  ].join('\n\n');
  const result = readChangeProposal(answer, COMMIT);
  assert.equal(result.kind, 'invalid');
  if (result.kind !== 'invalid') return;
  assert.match(result.problem, /2 blocos/);
});

test('um bloco que não fecha não é meia alteração: não é alteração nenhuma', () => {
  const answer = ['```' + PROPOSAL_FENCE, '{"baseCommit":"' + COMMIT + '","message":"m",'].join('\n');
  assert.deepEqual(readChangeProposal(answer, COMMIT), { kind: 'none' });
});

test('um campo que o contrato não define é recusado, não ignorado', () => {
  const result = readChangeProposal(
    block({
      baseCommit: COMMIT,
      message: 'm',
      changes: [{ op: 'write', path: 'a.md', text: 'x' }],
      // O campo que este contrato existe para nunca ter.
      command: 'rm -rf /',
    }),
    COMMIT,
  );
  assert.equal(result.kind, 'invalid');
  if (result.kind !== 'invalid') return;
  assert.match(result.problem, /command/);
});

test('uma alteração com campo estranho, operação inventada ou caminho perigoso é recusada', () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ op: 'run', path: 'a.md' }, /não existe/],
    [{ op: 'write', path: '../fora.md', text: 'x' }, /sai da raiz/],
    [{ op: 'write', path: '/etc/passwd', text: 'x' }, /absoluto/],
    [{ op: 'write', path: 'C:\\a.md', text: 'x' }, /caminho do Windows/],
    [{ op: 'write', path: '.git/config', text: 'x' }, /\.git/],
    [{ op: 'write', path: 'a.md' }, /não trouxe conteúdo/],
    [{ op: 'write', path: 'a.md', text: 'x', base64: 'eA==' }, /ao mesmo tempo/],
    [{ op: 'write', path: 'a.md', base64: 'não é base64!!' }, /base64/],
    [{ op: 'delete', path: 'a.md', text: 'x' }, /ainda envia conteúdo/],
    [{ op: 'write', path: 'a.md', text: 'x', shell: true }, /shell/],
  ];
  for (const [change, expected] of cases) {
    const result = readChangeProposal(
      block({ baseCommit: COMMIT, message: 'm', changes: [change] }),
      COMMIT,
    );
    assert.equal(result.kind, 'invalid', `esperava recusar ${JSON.stringify(change)}`);
    if (result.kind !== 'invalid') continue;
    assert.match(result.problem, expected);
    assert.match(result.problem, /Nada foi aplicado/);
  }
});

test('um bloco vazio, sem mensagem ou com o mesmo caminho duas vezes é recusado', () => {
  const bad = (body: Record<string, unknown>, expected: RegExp) => {
    const result = readChangeProposal(block({ baseCommit: COMMIT, ...body }), COMMIT);
    assert.equal(result.kind, 'invalid');
    if (result.kind === 'invalid') assert.match(result.problem, expected);
  };
  bad({ message: 'm', changes: [] }, /nenhuma alteração/);
  bad({ changes: [{ op: 'write', path: 'a.md', text: 'x' }] }, /mensagem de commit/);
  bad(
    {
      message: 'm',
      changes: [
        { op: 'write', path: 'a.md', text: '1' },
        { op: 'write', path: 'a.md', text: '2' },
      ],
    },
    /repete o caminho/,
  );
});

test('JSON inválido é recusado com o motivo, e nunca "consertado"', () => {
  const answer = ['```' + PROPOSAL_FENCE, '{ isto não é json }', '```'].join('\n');
  const result = readChangeProposal(answer, COMMIT);
  assert.equal(result.kind, 'invalid');
  if (result.kind !== 'invalid') return;
  assert.match(result.problem, /não é JSON válido/);
});

test('a instrução enviada ao worker diz o commit, proíbe afirmar que escreveu, e mostra o contrato', () => {
  const text = proposalInstructions({
    fullName: 'arcanjo/projeto',
    branch: 'trunk',
    commitSha: COMMIT,
  });
  assert.match(text, /no checkout on this computer/);
  assert.match(text, /You cannot write files here, and you must not say that you did/);
  assert.match(text, new RegExp(`"baseCommit": "${COMMIT}"`));
  assert.match(text, /There is no command field and nothing is executed/);
  // O bloco de exemplo usa a mesma cerca que o parser lê: se ela mudar de um
  // lado sem mudar do outro, este teste cai.
  assert.ok(text.includes('```' + PROPOSAL_FENCE));
});
