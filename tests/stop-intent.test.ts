/**
 * "pare tudo q esteja fazendo" não é uma tarefa.
 *
 * Foi o que a pessoa digitou vendo a execução andar em círculos, e depois
 * *"pare oq o claude esta fazendo"*. As duas viraram **novas runs**: o
 * supervisor foi planejar como parar e o worker foi delegado a confirmar que
 * tinha parado. A execução que ela queria parar continuou.
 *
 * A regra deste leitor: generoso com as formas de pedir para parar, rigoroso
 * com tudo que apenas menciona parar. Na dúvida, não. Um pedido perdido custa
 * mais um clique; uma execução cancelada por engano custa o trabalho.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStopIntent } from '../src/orchestrator/stop-intent.js';

test('the two messages from the incident are read as a stop', () => {
  assert.equal(readStopIntent('pare tudo q esteja fazendo'), 'stop');
  assert.equal(readStopIntent('pare oq o claude esta fazendo'), 'stop');
});

test('the ordinary ways of asking, typed the ordinary ways', () => {
  for (const text of [
    'pare',
    'PARE',
    'para',
    'pára',
    'pare tudo',
    'pare agora',
    'pare isso',
    'pare a tarefa',
    'pare a execução',
    'pare o claude',
    'pare o codex',
    'pare os agentes',
    'cancele',
    'cancela',
    'cancelar',
    'cancele a tarefa',
    'cancele essa execução',
    'aborte',
    'interrompa',
    'stop',
    'stop everything',
    'stop it',
    'cancel the run',
    'por favor pare',
    'pf cancele',
  ]) {
    assert.equal(readStopIntent(text), 'stop', text);
  }
});

test('a question about cancelling is a question', () => {
  for (const text of [
    'como eu cancelo uma tarefa?',
    'como cancelo isso',
    'dá para cancelar no meio?',
    'tem como parar a execução?',
    'posso cancelar depois?',
    'o que acontece se eu cancelar?',
    'how do i cancel a run?',
    'can i stop this?',
  ]) {
    assert.equal(readStopIntent(text), 'none', text);
  }
});

test('the opposite of a stop is not a stop', () => {
  for (const text of ['não pare', 'nao pare agora', "don't stop", 'do not cancel']) {
    assert.equal(readStopIntent(text), 'none', text);
  }
});

test('an instruction that happens to contain the word is left alone', () => {
  for (const text of [
    'pare de usar tabs e use espaços',
    'pare o servidor de desenvolvimento antes de rodar os testes',
    'cancele o pedido no formulário quando o usuário clicar em voltar',
    'stop the dev server in the npm script',
    'implemente um botão de cancelar no formulário',
    'adicione um teste que cancela a requisição',
  ]) {
    assert.equal(readStopIntent(text), 'none', text);
  }
});

test('a long message is a task, whatever it contains', () => {
  const long =
    'pare tudo e depois ' + 'crie um miniaplicativo de tarefas com index.html, style.css, app.js e README.md, '.repeat(3);
  assert.ok(long.length > 200);
  assert.equal(readStopIntent(long), 'none');
});

test('empty and whitespace are nothing', () => {
  assert.equal(readStopIntent(''), 'none');
  assert.equal(readStopIntent('   \n  '), 'none');
});
