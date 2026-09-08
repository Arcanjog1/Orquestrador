/**
 * A tarefa era de um repositório; a pasta era outra coisa.
 *
 * ## O incidente
 *
 * Uma tarefa para `Arcanjog1/Orquestrador` foi iniciada em
 * `C:\Users\twitc\Desktop\Orquestrador-claude-new-session-3am7mo`. O baseline
 * informou, corretamente, que a pasta não era um repositório Git — e a execução
 * seguiu assim mesmo. A primeira delegação escreveu um documento de baseline, a
 * segunda morreu em 5,3s, e o roteador escalou por "ausência de progresso".
 * Nada ali podia funcionar: o código não estava naquela pasta.
 *
 * O nome parecia certo. É exatamente por isso que **um nome não é prova**, e
 * nada aqui compara um.
 *
 * ## A regra
 *
 * Bloqueia só quando o **projeto declara um repositório** e a pasta é
 * comprovadamente outra coisa. Um projeto que é só uma pasta nunca é medido
 * contra repositório nenhum — criar `hello.txt` numa pasta sem Git continua
 * sendo tarefa legítima, e bloquear isso seria trocar um defeito por outro.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessPreflight,
  renderPreflight,
  type PreflightFacts,
} from '../src/workspace/preflight.js';

const REPO = 'https://github.com/Arcanjog1/Orquestrador';

function facts(over: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    workspacePath: 'C:\\Users\\twitc\\Projetos\\Orquestrador',
    folderExists: true,
    isGitRepository: true,
    gitProblem: null,
    remoteUrl: REPO,
    branch: 'claude/ai-orchestrator-buzz-arch-vblrau',
    dirty: false,
    declaredRepositoryUrl: REPO,
    declaredDefaultBranch: 'claude/new-session-3am7mo',
    ...over,
  };
}

test('a checkout of the declared repository is ready, and says which branch', () => {
  const result = assessPreflight(facts());
  assert.equal(result.kind, 'ready');
  assert.equal(result.blocksCodeWork, false);
  assert.match(result.detail, /Orquestrador/);
  assert.match(result.detail, /branch claude\/ai-orchestrator-buzz-arch-vblrau/);
  // The real default branch, never assumed to be `main`.
  assert.match(result.detail, /padrão claude\/new-session-3am7mo/);
  assert.doesNotMatch(result.detail, /\bmain\b/);
});

test('the incident: a same-named folder that is not a checkout is refused', () => {
  const result = assessPreflight(
    facts({
      workspacePath: 'C:\\Users\\twitc\\Desktop\\Orquestrador-claude-new-session-3am7mo',
      isGitRepository: false,
      remoteUrl: null,
      branch: null,
    }),
  );
  assert.equal(result.kind, 'not-a-repository');
  assert.equal(result.blocksCodeWork, true);
  assert.match(result.detail, /não é um repositório Git/);
  assert.match(result.detail, /nome parecido não torna a pasta o repositório certo/);
  assert.deepEqual([...result.actions], ['clone-repository', 'associate-folder']);
});

test('a checkout of a different repository is refused, and both are named', () => {
  const result = assessPreflight(facts({ remoteUrl: 'https://github.com/Arcanjog1/MeuBotao.pushbutton' }));
  assert.equal(result.kind, 'remote-mismatch');
  assert.equal(result.blocksCodeWork, true);
  assert.match(result.detail, /MeuBotao\.pushbutton/);
  assert.match(result.detail, /nada foi alterado/i);
});

test('the same repository written another way is the same repository', () => {
  for (const remote of [
    'git@github.com:Arcanjog1/Orquestrador.git',
    'https://github.com/arcanjog1/orquestrador.git',
    'https://github.com/Arcanjog1/Orquestrador/tree/main',
  ]) {
    const result = assessPreflight(facts({ remoteUrl: remote }));
    assert.equal(result.kind, 'ready', remote);
    assert.equal(result.blocksCodeWork, false, remote);
  }
});

test('a folder with no git is fine when the project claims no repository', () => {
  // This is the hello.txt case, and it must keep working.
  const result = assessPreflight(
    facts({ isGitRepository: false, remoteUrl: null, branch: null, declaredRepositoryUrl: null }),
  );
  assert.equal(result.kind, 'ready-without-git');
  assert.equal(result.blocksCodeWork, false);
  assert.match(result.detail, /Tarefas de arquivo funcionam/);
});

test('git failing to answer is not the same as "not a repository"', () => {
  const result = assessPreflight(
    facts({ isGitRepository: false, gitProblem: 'git: not found', remoteUrl: null }),
  );
  assert.equal(result.kind, 'git-unavailable');
  assert.equal(result.blocksCodeWork, true);
  assert.match(result.detail, /git: not found/);
  // Nothing to click: a missing git is not fixed by choosing a folder.
  assert.deepEqual([...result.actions], []);
});

test('a checkout with no remote cannot prove it is the right one', () => {
  const result = assessPreflight(facts({ remoteUrl: null }));
  assert.equal(result.kind, 'no-remote');
  assert.equal(result.blocksCodeWork, true);
});

test('no folder at all, with and without a repository to clone', () => {
  const withRepo = assessPreflight(facts({ workspacePath: '', folderExists: false }));
  assert.equal(withRepo.kind, 'no-workspace');
  assert.equal(withRepo.blocksCodeWork, true);
  assert.deepEqual([...withRepo.actions], ['clone-repository', 'associate-folder']);

  const withoutRepo = assessPreflight(
    facts({ workspacePath: '', folderExists: false, declaredRepositoryUrl: null }),
  );
  assert.equal(withoutRepo.kind, 'no-workspace');
  // Nothing to clone, so nothing offers to.
  assert.deepEqual([...withoutRepo.actions], ['associate-folder']);
});

test('a folder that is gone is reported as gone, and nothing was deleted', () => {
  const result = assessPreflight(facts({ folderExists: false }));
  assert.equal(result.kind, 'folder-missing');
  assert.equal(result.blocksCodeWork, true);
  assert.match(result.detail, /Nada foi criado nem apagado/);
});

test('a dirty tree is reported and never blocks', () => {
  const result = assessPreflight(facts({ dirty: true }));
  assert.equal(result.kind, 'ready');
  assert.equal(result.blocksCodeWork, false);
  assert.equal(result.dirty, true);
  assert.match(result.detail, /árvore com alterações locais/);
  assert.match(renderPreflight(result), /Nothing here will overwrite them/);
});

test('the prompt block tells the supervisor not to delegate, and not to escalate', () => {
  const blocked = renderPreflight(assessPreflight(facts({ isGitRepository: false, remoteUrl: null })));
  assert.match(blocked, /WORKSPACE CHECK \(measured by the application/);
  assert.match(blocked, /A delegation that changes code cannot run here/);
  assert.match(blocked, /do not\s+ask for a stronger model/s);
  assert.match(blocked, /Answer "blocked"/);

  const ready = renderPreflight(assessPreflight(facts()));
  assert.doesNotMatch(ready, /cannot run here/);
});

test('an unparseable "repository" is not a repository, and does not block', () => {
  // A project whose repository field holds something that is not a repository
  // is a project without one. Blocking on it would block a plain folder.
  const result = assessPreflight(
    facts({ declaredRepositoryUrl: 'não é um repositório', isGitRepository: false, remoteUrl: null }),
  );
  assert.equal(result.blocksCodeWork, false);
});
