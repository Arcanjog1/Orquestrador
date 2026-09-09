/**
 * "Autorizei, e a tarefa não continuou."
 *
 * O incidente, na ordem em que aconteceu: a pessoa perguntou se o orquestrador
 * conseguia acessar um repositório do GitHub; o Codex delegou uma consulta
 * somente-leitura; o worker tentou `WebFetch`; a execução não é interativa,
 * então o runtime recusou; o aplicativo pediu a autorização; **a pessoa
 * autorizou; e nada aconteceu**. Ao pedir "tente novamente", o Codex criou uma
 * *segunda* execução — plano novo, avaliação nova — e escalou para um modelo
 * mais forte uma pergunta que nunca precisou de um. O Claude ainda recebeu
 * "Claude requested permissions to use WebFetch, but you haven't granted it
 * yet", porque a chamada nunca chegou à rede.
 *
 * Eram quatro defeitos empilhados, e cada um sozinho bastava:
 *
 *  1. `permission.approve` gravava o grant e **não retomava nada**;
 *  2. a regra gerada era `WebFetch(<url>)`, que a sintaxe documentada não casa;
 *  3. `allowedTools` do adapter **nunca era fornecido**, então nenhum grant
 *     chegava à linha de comando;
 *  4. uma recusa podia ser perguntada de novo, indefinidamente.
 *
 * O critério destes testes é o da própria pessoa: "autorizei, o runtime
 * recebeu a autorização e a tarefa original continuou".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import { createGitFixture, type GitFixture } from './helpers/git-fixture.js';
import { decideResumption } from '../src/permissions/resumption.js';
import { toolPolicyPreamble } from '../apps/desktop/src/main/services/orchestration-service.js';
import type { DesktopFixture } from './helpers/desktop-fixture.js';
import type {
  IpcResult,
  PermissionDecisionView,
  PermissionRequestView,
  RunView,
} from '../apps/desktop/src/shared/ipc-contract.js';
import type { AgentInput } from '../src/core/types.js';

const EXPECTED = 'pronto';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

/** The facts a stopped run has when nobody has answered anything yet. */
const WAITING = {
  status: 'NEEDS_HUMAN',
  cancelRequested: false,
  running: false,
  pending: 1,
  approvedForRun: 0,
  grantedRules: [] as string[],
};

/* ---------------------------------------------------------------------- *
 * The decision, case by case.
 * ---------------------------------------------------------------------- */

test('an answered authorisation continues the run that stopped for it', () => {
  assert.deepEqual(
    decideResumption({
      ...WAITING,
      pending: 0,
      approvedForRun: 1,
      grantedRules: ['WebFetch(domain:github.com)'],
    }),
    { resume: true, rules: ['WebFetch(domain:github.com)'] },
  );
});

test('a cancellation outranks any authorisation, whenever it arrives', () => {
  // The person said stop. An approval landing afterwards - theirs or anybody's -
  // does not start the work again, and this holds even before the loop has got
  // round to writing the terminal state.
  for (const status of ['NEEDS_HUMAN', 'RUNNING', 'CANCELLED']) {
    assert.deepEqual(
      decideResumption({
        ...WAITING,
        status,
        cancelRequested: true,
        pending: 0,
        approvedForRun: 1,
        grantedRules: ['Bash(git status)'],
      }),
      { resume: false, because: 'cancelled' },
    );
  }
});

test('a finished run is never revived from here', () => {
  for (const status of ['DONE', 'FAILED', 'CANCELLED']) {
    assert.deepEqual(
      decideResumption({ ...WAITING, status, pending: 0, approvedForRun: 1, grantedRules: ['Read'] }),
      { resume: false, because: 'finished' },
    );
  }
});

test('a run that is already going is not started a second time', () => {
  assert.deepEqual(
    decideResumption({
      ...WAITING,
      status: 'RUNNING',
      running: true,
      pending: 0,
      approvedForRun: 1,
      grantedRules: ['Read'],
    }),
    { resume: false, because: 'already-running' },
  );
});

test('a run still holding unanswered questions waits for all of them', () => {
  assert.deepEqual(
    decideResumption({ ...WAITING, pending: 2, approvedForRun: 1, grantedRules: ['Read'] }),
    { resume: false, because: 'still-waiting-on-answers' },
  );
});

test('a refusal does not continue the run, even where the project has older grants', () => {
  // The trap: the project holds a grant from last week. The person has just
  // refused today's question, and refusing is a decision - not a reason to run.
  assert.deepEqual(
    decideResumption({
      ...WAITING,
      pending: 0,
      approvedForRun: 0,
      grantedRules: ['Bash(git status)'],
    }),
    { resume: false, because: 'nothing-authorised' },
  );
});

test('a run that never stopped for a person has nothing to continue', () => {
  assert.deepEqual(
    decideResumption({ ...WAITING, status: 'BLOCKED', pending: 0, approvedForRun: 1 }),
    { resume: false, because: 'not-waiting' },
  );
});

/* ---------------------------------------------------------------------- *
 * What the worker is told.
 * ---------------------------------------------------------------------- */

test('a refusal is named to the worker, so it stops reaching for the same tool', () => {
  const preamble = toolPolicyPreamble([], ['WebFetch(https://github.com/x/y)']);
  assert.match(preamble, /REFUSED by the person/);
  assert.match(preamble, /not up for asking again/);
});

test('a connected repository is read by the application, not fetched by the worker', () => {
  const preamble = toolPolicyPreamble([], [], 'https://github.com/Arcanjog1/Orquestrador');
  assert.match(preamble, /reads it\n {2}through the GitHub API/);
  assert.match(preamble, /You do NOT need WebFetch/);
  // And the sentence that stops the answer this incident produced: a refused
  // tool says nothing whatsoever about whether a repository exists.
  assert.match(preamble, /Never conclude that something does not exist because a tool was refused/);
});

/* ---------------------------------------------------------------------- *
 * End to end, against the loop.
 * ---------------------------------------------------------------------- */

interface Prepared {
  fixture: DesktopFixture;
  repo: GitFixture;
  sessionId: string;
  workspaceId: string;
  worker: ScriptedAgent;
  cleanup(): Promise<void>;
}

async function prepare(options: {
  orchestratorScript: ReadonlyArray<string | ((input: AgentInput) => string)>;
  workerScript: ReadonlyArray<string | ((input: AgentInput) => string)>;
  maxIterations?: number;
}): Promise<Prepared> {
  const repo = createGitFixture('lao-resume-');
  repo.write('README.md', '# scratch\n');
  repo.write(
    'check.mjs',
    [
      "import { readFileSync } from 'node:fs';",
      "let a = null; try { a = readFileSync('hello.txt','utf8').trim(); } catch {}",
      `if (a !== ${JSON.stringify(EXPECTED)}) { console.error('bad: ' + a); process.exit(1); }`,
      "console.log('ok');",
    ].join('\n'),
  );
  repo.commitAll('baseline');

  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', options.orchestratorScript);
  const worker = new ScriptedAgent('mock-claude', 'Claude', options.workerScript);
  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
  });
  const workspace = value<{ id: string }>(
    await fixture.router.handle('workspace.create', { name: 'Scratch', localPath: repo.dir }),
  );
  fixture.services.database.verifications.upsert({
    workspaceId: workspace.id,
    id: 'hello-exists',
    label: 'hello.txt tem o conteúdo exato',
    command: 'node check.mjs',
  });
  value(await fixture.router.handle('accounts.create', { name: 'Claude Trabalho', provider: 'anthropic' }));
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
    repo,
    worker,
    sessionId: session.id,
    workspaceId: workspace.id,
    async cleanup() {
      await fixture.cleanup();
      repo.cleanup();
    },
  };
}

const delegate = JSON.stringify({
  action: 'delegate',
  task: 'Crie hello.txt',
  acceptanceCriteria: ['hello.txt existe com o conteúdo exato'],
  verificationCommands: ['hello-exists'],
  summary: 'Vou pedir a criação do arquivo.',
});
const done = JSON.stringify({
  action: 'done',
  acceptanceCriteria: [],
  verificationCommands: ['hello-exists'],
  summary: 'Pronto.',
});

test('authorising continues the original run, in the same run, with the rule on the command line', async () => {
  const prompts: string[] = [];
  let workerRef: ScriptedAgent | undefined;
  const prepared = await prepare({
    orchestratorScript: [delegate, delegate, done],
    workerScript: [
      (input: AgentInput) => {
        prompts.push(input.prompt);
        // Only once the grant is visible. A worker that wrote on the first
        // call would prove nothing about the authorisation. Clearing
        // `denyNext` here is the fixture's way of saying what the real CLI
        // does once the rule is on its command line: it stops refusing.
        if (/Approved by the person/.test(input.prompt)) {
          if (workerRef) workerRef.denyNext = null;
          writeFileSync(join(input.workingDirectory, 'hello.txt'), `${EXPECTED}\n`, 'utf8');
          return 'arquivo criado';
        }
        return 'não consegui: preciso consultar o repositório';
      },
    ],
    maxIterations: 4,
  });
  workerRef = prepared.worker;
  prepared.worker.denyNext = [
    { toolName: 'WebFetch', command: 'https://github.com/Arcanjog1/Orquestrador' },
  ];
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'O orquestrador consegue acessar o repositório?',
      }),
    );
    const stopped = await prepared.fixture.services.orchestration.waitFor(sent.run.id);
    assert.equal(stopped.status, 'NEEDS_HUMAN');

    const [request] = value<PermissionRequestView[]>(
      await prepared.fixture.router.handle('permission.forRun', { runId: sent.run.id }),
    );
    // The rule offered is one the CLI can match. `WebFetch(<url>)` is not.
    assert.deepEqual(
      request!.scopes.map((scope) => scope.rule),
      ['WebFetch(domain:github.com)', 'WebFetch'],
    );

    const decided = value<PermissionDecisionView>(
      await prepared.fixture.router.handle('permission.approve', {
        requestId: request!.id,
        rule: 'WebFetch(domain:github.com)',
      }),
    );
    assert.equal(decided.resumed, true, 'the task continued');
    assert.equal(decided.notResumedBecause, null);

    const finished = await prepared.fixture.services.orchestration.waitFor(sent.run.id);
    assert.equal(finished.status, 'DONE');
    assert.equal(readFileSync(join(prepared.repo.dir, 'hello.txt'), 'utf8').trim(), EXPECTED);

    // The same run. Nobody had to ask again, and no second plan was made -
    // which is what escalated a read-only question to a stronger model.
    const runs = value<RunView[]>(
      await prepared.fixture.router.handle('run.list', { workspaceId: prepared.workspaceId }),
    );
    assert.deepEqual(runs.map((run) => run.id), [sent.run.id]);

    // The grant reached the delegation that followed, in its own preamble.
    assert.ok(
      prompts.some((prompt) => prompt.includes('WebFetch(domain:github.com)')),
      'the approved rule is in the worker prompt',
    );
  } finally {
    await prepared.cleanup();
  }
});

test('a grant that never reaches the command line is recorded as not carried', async () => {
  // The defect this guards: `allowedTools` was an option of the adapter that
  // nothing ever supplied, so every rule a person approved was written to the
  // database and never put on the command line. From the grant row the two
  // cases - carried and not carried - looked identical, and both produced the
  // same "you haven't granted it yet". They do not look identical any more.
  const prepared = await prepare({
    orchestratorScript: [delegate, delegate, done],
    workerScript: ['não consegui'],
    maxIterations: 3,
  });
  prepared.worker.denyNext = [{ toolName: 'Bash', command: 'node check.mjs' }];
  // The runtime reports carrying only the file tools. Whatever the person
  // approves, it is not among them.
  prepared.worker.authorisedTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Crie hello.txt',
      }),
    );
    await prepared.fixture.services.orchestration.waitFor(sent.run.id);
    const [request] = value<PermissionRequestView[]>(
      await prepared.fixture.router.handle('permission.forRun', { runId: sent.run.id }),
    );
    value(
      await prepared.fixture.router.handle('permission.approve', {
        requestId: request!.id,
        rule: 'Bash(node check.mjs)',
      }),
    );
    await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    const detail = value<{ steps: ReadonlyArray<{ phase: string; status: string; detail: string }> }>(
      await prepared.fixture.router.handle('run.detail', { runId: sent.run.id }),
    );
    const missed = detail.steps.filter(
      (step) => step.phase === 'permission' && step.status === 'not-carried',
    );
    assert.ok(missed.length > 0, 'the run says the grant did not reach the CLI');
    assert.match(missed.at(-1)!.detail, /Bash\(node check\.mjs\)/);
  } finally {
    await prepared.cleanup();
  }
});

test('an authorisation granted after a cancellation does not restart the run', async () => {
  const prepared = await prepare({
    orchestratorScript: [delegate, delegate, done],
    workerScript: ['não consegui'],
    maxIterations: 4,
  });
  prepared.worker.denyNext = [{ toolName: 'Bash', command: 'node check.mjs' }];
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Crie hello.txt',
      }),
    );
    await prepared.fixture.services.orchestration.waitFor(sent.run.id);
    const [request] = value<PermissionRequestView[]>(
      await prepared.fixture.router.handle('permission.forRun', { runId: sent.run.id }),
    );

    // The person stops the run while the question is still on screen.
    value(await prepared.fixture.router.handle('run.cancel', { runId: sent.run.id }));
    assert.equal(
      value<RunView>(await prepared.fixture.router.handle('run.get', { runId: sent.run.id })).status,
      'CANCELLED',
    );

    // And then answers it. The grant is kept - it was a real decision - and
    // the cancelled run stays cancelled.
    const decided = value<PermissionDecisionView>(
      await prepared.fixture.router.handle('permission.approve', {
        requestId: request!.id,
        rule: 'Bash(node check.mjs)',
      }),
    );
    assert.equal(decided.resumed, false);
    assert.match(decided.notResumedBecause ?? '', /cancelada/i);
    assert.deepEqual(decided.rules, ['Bash(node check.mjs)']);
    assert.equal(
      value<RunView>(await prepared.fixture.router.handle('run.get', { runId: sent.run.id })).status,
      'CANCELLED',
    );
    assert.equal(prepared.fixture.services.orchestration.isActive(sent.run.id), false);
  } finally {
    await prepared.cleanup();
  }
});

test('a refusal is not asked again, in this run or the next one', async () => {
  const prompts: string[] = [];
  const prepared = await prepare({
    orchestratorScript: [delegate, done, delegate, done],
    workerScript: [
      (input: AgentInput) => {
        prompts.push(input.prompt);
        return 'não consegui';
      },
    ],
    maxIterations: 2,
  });
  prepared.worker.denyNext = [{ toolName: 'Bash', command: 'rm -rf /' }];
  try {
    const first = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Crie hello.txt',
      }),
    );
    await prepared.fixture.services.orchestration.waitFor(first.run.id);
    const [request] = value<PermissionRequestView[]>(
      await prepared.fixture.router.handle('permission.forRun', { runId: first.run.id }),
    );
    value(await prepared.fixture.router.handle('permission.deny', { requestId: request!.id }));

    // A second run, in the same project, where the worker asks for exactly the
    // same thing. The person is not asked twice.
    prepared.worker.denyNext = [{ toolName: 'Bash', command: 'rm -rf /' }];
    const second = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Tente de novo',
      }),
    );
    await prepared.fixture.services.orchestration.waitFor(second.run.id);
    assert.deepEqual(
      value<PermissionRequestView[]>(
        await prepared.fixture.router.handle('permission.forRun', { runId: second.run.id }),
      ),
      [],
      'the refusal stands; nothing is asked again',
    );
    assert.deepEqual(
      value<unknown[]>(await prepared.fixture.router.handle('permission.pending', null)),
      [],
    );
    // And the worker is told, so it stops walking into the same wall.
    assert.ok(
      prompts.some((prompt) => /REFUSED by the person/.test(prompt) && prompt.includes('rm -rf /')),
      'the refusal is named in the worker prompt',
    );
  } finally {
    await prepared.cleanup();
  }
});
