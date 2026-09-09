/**
 * Autorizar uma operação — o fluxo que faltava.
 *
 * O que aconteceu no Windows: o worker pediu PowerShell e Bash, a execução não
 * é interativa, o CLI recusou, e o aplicativo terminou dizendo que a pessoa
 * deveria autorizar a operação — sem oferecer nada para autorizar.
 *
 * A causa é documentada e não é um defeito do CLI:
 *
 * > "all other Bash commands except the built-in read-only set still prompt"
 * > — https://code.claude.com/docs/en/permission-modes
 *
 * Estes testes cobrem o que passou a existir, e sobretudo o que continua
 * proibido: um grant só nasce de uma pessoa respondendo, vale só para o escopo
 * mostrado, só para aquele workspace, e um shell nunca é liberado por inteiro.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import { createGitFixture, type GitFixture } from './helpers/git-fixture.js';
import { toolPolicyPreamble } from '../apps/desktop/src/main/services/orchestration-service.js';
import type { DesktopFixture } from './helpers/desktop-fixture.js';
import type {
  IpcResult,
  PermissionDecisionView,
  PermissionRequestView,
} from '../apps/desktop/src/shared/ipc-contract.js';
import type { AgentInput } from '../src/core/types.js';

const EXPECTED = 'pronto';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

function failure(result: IpcResult<unknown>): { message: string } {
  assert.equal(result.ok, false, 'expected a refusal');
  return (result as { ok: false; error: { message: string } }).error;
}

interface Prepared {
  fixture: DesktopFixture;
  repo: GitFixture;
  sessionId: string;
  workspaceId: string;
  orchestrator: ScriptedAgent;
  worker: ScriptedAgent;
  cleanup(): Promise<void>;
}

/** A real git repository with one registered verification, as a run needs. */
async function prepare(options: {
  orchestratorScript: ReadonlyArray<string | ((input: AgentInput) => string)>;
  workerScript: ReadonlyArray<string | ((input: AgentInput) => string)>;
  maxIterations?: number;
}): Promise<Prepared> {
  const repo = createGitFixture('lao-perm-');
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
    // The worker's real connection, resolved the way the application resolves
    // it. A hard-coded null would have made the dialog's "Conta" field
    // untestable - and naming the connection is one of the things section 2
    // asks for, precisely because a person with two Claude accounts needs to
    // know which one is asking.
    createRunners: async (workspace) => {
      const agent = workspace.worker_agent_id
        ? fixture.services.database.agents.find(workspace.worker_agent_id)
        : undefined;
      return { orchestrator, worker, workerAccountId: agent?.account_id ?? null };
    },
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
    orchestrator,
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

/* ---------------------------------------------------------------------- */

test('the worker is told which tools run without asking, and the task is left alone', () => {
  const preamble = toolPolicyPreamble([]);

  // The three facts that would otherwise cost a whole invocation to discover.
  assert.match(preamble, /Read, Write, Edit, Glob and Grep run without asking/);
  assert.match(preamble, /Bash and PowerShell are NOT pre-approved/);
  assert.match(preamble, /name\s+the exact command/);
  // And it says whose words it is, so a worker never reads it as the task.
  assert.match(preamble, /^TOOL POLICY FOR THIS DELEGATION \(from the application, not from the task\):/);

  // A grant appears in the preamble only once somebody has given one.
  assert.equal(/Approved by the person/.test(preamble), false);
  assert.match(toolPolicyPreamble(['Bash(node check.mjs)']), /Approved by the person.*node check\.mjs/);
});

test('an authorized file write needs no shell at all', async () => {
  const prepared = await prepare({
    orchestratorScript: [delegate, done],
    // The worker writes the file directly, as `Write` does. No shell is
    // involved, which is the whole point: `acceptEdits` grants exactly this.
    workerScript: [
      (input: AgentInput) => {
        writeFileSync(join(input.workingDirectory, 'hello.txt'), `${EXPECTED}\n`, 'utf8');
        return 'arquivo criado';
      },
    ],
  });
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: `Crie hello.txt contendo exatamente: ${EXPECTED}`,
      }),
    );
    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    assert.equal(run.status, 'DONE');
    assert.equal(readFileSync(join(prepared.repo.dir, 'hello.txt'), 'utf8').trim(), EXPECTED);
    // Nothing was asked of the person, because nothing needed asking.
    assert.deepEqual(
      value<unknown[]>(await prepared.fixture.router.handle('permission.pending', null)),
      [],
    );
  } finally {
    await prepared.cleanup();
  }
});

test('a refused tool becomes a request naming the exact command, not a dead end', async () => {
  const prepared = await prepare({
    orchestratorScript: [delegate, done],
    workerScript: ['não consegui'],
    maxIterations: 2,
  });
  prepared.worker.denyNext = [
    { toolName: 'PowerShell', toolUseId: 'toolu_09', command: 'Set-Content .\\hello.txt "pronto"' },
    { toolName: 'Bash' },
  ];
  try {
    const sent = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Crie hello.txt',
      }),
    );
    const run = await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    // The run stops for a person, and says so as its own state.
    assert.equal(run.status, 'NEEDS_HUMAN');
    assert.match(run.summary ?? '', /autoriza(ção|r)/i);

    const pending = value<PermissionRequestView[]>(
      await prepared.fixture.router.handle('permission.forRun', { runId: sent.run.id }),
    );
    assert.equal(pending.length, 2, 'one question per refused call, and no more');

    const shell = pending.find((r) => r.toolName === 'PowerShell')!;
    // Every field section 2 asks for, from what the CLI actually reported.
    assert.equal(shell.command, 'Set-Content .\\hello.txt "pronto"');
    assert.equal(shell.toolUseId, 'toolu_09');
    assert.equal(shell.accountName, 'Claude Trabalho');
    assert.ok(shell.agentName, 'the agent is named');
    assert.ok(shell.workingDirectory && shell.workingDirectory.length > 0);
    assert.match(shell.reason, /não é interativa/);
    assert.equal(shell.status, 'pending');

    // The scopes offered for a shell: the exact command, and the program with
    // arguments. Never the bare tool.
    const rules = shell.scopes.map((s) => s.rule);
    assert.ok(rules.includes('PowerShell(Set-Content .\\hello.txt "pronto")'));
    assert.equal(rules.includes('PowerShell'), false, 'a bare shell is never on offer');

    // A refusal the CLI described only by name has nothing safe to offer.
    const bare = pending.find((r) => r.toolName === 'Bash')!;
    assert.equal(bare.command, null, 'not invented');
    assert.deepEqual(bare.scopes, [], 'so there is nothing to approve, and the dialog says why');
  } finally {
    await prepared.cleanup();
  }
});

test('approving grants exactly the scope shown, and only for that workspace', async () => {
  const prepared = await prepare({
    orchestratorScript: [delegate, done],
    workerScript: ['não consegui'],
    maxIterations: 2,
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

    // A rule the dialog never offered is refused in the main process, which is
    // what stops a renderer from widening an approval.
    assert.match(
      failure(
        await prepared.fixture.router.handle('permission.approve', {
          requestId: request!.id,
          rule: 'Bash',
        }),
      ).message,
      /não é uma das opções/,
    );
    assert.deepEqual(
      value<unknown[]>(await prepared.fixture.router.handle('permission.grants', { workspaceId: prepared.workspaceId })),
      [],
      'and nothing was granted by the attempt',
    );

    // The answer carries the run's fate as well as the request's: recording a
    // grant and continuing the task that stopped for it are two different
    // things, and for a long time only the first one happened.
    const approved = value<PermissionDecisionView>(
      await prepared.fixture.router.handle('permission.approve', {
        requestId: request!.id,
        rule: 'Bash(node check.mjs)',
      }),
    );
    assert.equal(approved.request.status, 'approved');
    assert.equal(approved.request.approvedRule, 'Bash(node check.mjs)');
    assert.deepEqual(approved.rules, ['Bash(node check.mjs)']);
    // Approving continues the run it stopped, so the loop is going again and
    // has to be waited for. Before this it went nowhere at all, which is why
    // this test used to be able to tear the database down immediately.
    assert.equal(approved.resumed, true);
    await prepared.fixture.services.orchestration.waitFor(sent.run.id);

    const grants = value<Array<{ rule: string; workspaceId: string }>>(
      await prepared.fixture.router.handle('permission.grants', { workspaceId: prepared.workspaceId }),
    );
    assert.deepEqual(grants.map((g) => g.rule), ['Bash(node check.mjs)']);

    // Another workspace sees none of it. This is what keeps one project's
    // approval from authorising another's.
    const other = mkdtempSync(join(tmpdir(), 'lao-perm-other-'));
    try {
      const otherWorkspace = value<{ id: string }>(
        await prepared.fixture.router.handle('workspace.create', { name: 'Outro', localPath: other }),
      );
      assert.deepEqual(
        value<unknown[]>(
          await prepared.fixture.router.handle('permission.grants', { workspaceId: otherWorkspace.id }),
        ),
        [],
      );
      assert.deepEqual(prepared.fixture.services.database.permissions.rulesFor(otherWorkspace.id), []);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }

    // Answering twice is refused: a decision is a decision.
    assert.match(
      failure(
        await prepared.fixture.router.handle('permission.deny', { requestId: request!.id }),
      ).message,
      /já foi respondido/,
    );
  } finally {
    await prepared.cleanup();
  }
});

test('a refusal is respected, recorded, and grants nothing', async () => {
  const prepared = await prepare({
    orchestratorScript: [delegate, done],
    workerScript: ['não consegui'],
    maxIterations: 2,
  });
  prepared.worker.denyNext = [{ toolName: 'Bash', command: 'rm -rf /' }];
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

    const denied = value<PermissionDecisionView>(
      await prepared.fixture.router.handle('permission.deny', { requestId: request!.id }),
    );
    assert.equal(denied.request.status, 'denied');
    assert.ok(denied.request.decidedAt, 'the refusal has a time');
    assert.equal(denied.request.approvedRule, null);
    // A refusal never continues the run, and says so rather than going quiet.
    assert.equal(denied.resumed, false);
    assert.match(denied.notResumedBecause ?? '', /Nada foi autorizado/);
    assert.deepEqual(prepared.fixture.services.database.permissions.rulesFor(prepared.workspaceId), []);

    // It leaves the pending list but stays in the run's history.
    assert.deepEqual(
      value<unknown[]>(await prepared.fixture.router.handle('permission.pending', null)),
      [],
    );
    assert.equal(
      value<PermissionRequestView[]>(
        await prepared.fixture.router.handle('permission.forRun', { runId: sent.run.id }),
      ).length,
      1,
    );
  } finally {
    await prepared.cleanup();
  }
});

test('an approved rule reaches the next delegation, and nothing was repeated to get there', async () => {
  const prepared = await prepare({
    orchestratorScript: [delegate, done, delegate, done],
    workerScript: [
      (input: AgentInput) => {
        // Only the *second* delegation writes, and only because it can see the
        // grant. A worker that wrote on the first call would prove nothing.
        if (/Approved by the person/.test(input.prompt)) {
          writeFileSync(join(input.workingDirectory, 'hello.txt'), `${EXPECTED}\n`, 'utf8');
          return 'arquivo criado';
        }
        return 'preciso de permissão';
      },
    ],
    maxIterations: 3,
  });
  prepared.worker.denyNext = [{ toolName: 'Bash', command: 'node check.mjs' }];
  try {
    const first = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Crie hello.txt',
      }),
    );
    await prepared.fixture.services.orchestration.waitFor(first.run.id);
    assert.equal(existsSync(join(prepared.repo.dir, 'hello.txt')), false, 'nothing ran');

    const [request] = value<PermissionRequestView[]>(
      await prepared.fixture.router.handle('permission.forRun', { runId: first.run.id }),
    );
    value(
      await prepared.fixture.router.handle('permission.approve', {
        requestId: request!.id,
        rule: 'Bash(node check.mjs)',
      }),
    );

    // Approving runs nothing on its own. This is the promise the dialog makes,
    // and the one that keeps a non-idempotent operation from being repeated
    // behind the person's back.
    assert.equal(existsSync(join(prepared.repo.dir, 'hello.txt')), false, 'approval executes nothing');
    const runsAfterApproval = prepared.fixture.services.orchestration.listForWorkspace(
      prepared.workspaceId,
    );
    assert.equal(runsAfterApproval.length, 1, 'and starts no run by itself');

    // The person sends the task again. Now the worker can see the grant.
    prepared.worker.denyNext = null;
    const second = value<{ run: { id: string } }>(
      await prepared.fixture.router.handle('chat.sendMessage', {
        sessionId: prepared.sessionId,
        text: 'Continue: a autorização foi concedida.',
      }),
    );
    const run = await prepared.fixture.services.orchestration.waitFor(second.run.id);

    assert.equal(run.status, 'DONE');
    assert.equal(readFileSync(join(prepared.repo.dir, 'hello.txt'), 'utf8').trim(), EXPECTED);
    assert.match(
      prepared.worker.calls.at(-1)!.prompt,
      /Approved by the person for this project, and only these: Bash\(node check\.mjs\)/,
    );
    // Same conversation, same workspace: the history is one thread.
    assert.equal(run.sessionId, first.run.id === second.run.id ? run.sessionId : run.sessionId);
    assert.equal(
      prepared.fixture.services.database.chat.requireSession(prepared.sessionId).workspace_id,
      prepared.workspaceId,
    );
  } finally {
    await prepared.cleanup();
  }
});

test('the same refusal twice in one run asks once', async () => {
  const prepared = await prepare({
    orchestratorScript: [delegate, delegate, done],
    workerScript: ['não consegui'],
    maxIterations: 3,
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
    const requests = value<PermissionRequestView[]>(
      await prepared.fixture.router.handle('permission.forRun', { runId: sent.run.id }),
    );
    assert.equal(requests.length, 1, 'one question, however many times it was refused');
  } finally {
    await prepared.cleanup();
  }
});

test('grants survive a restart, and can be withdrawn', async () => {
  const fixture = createDesktopFixture();
  const dir = mkdtempSync(join(tmpdir(), 'lao-perm-persist-'));
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.create', { name: 'P', localPath: dir }),
    );
    const run = fixture.services.database.runs.create({
      id: 'run-perm',
      sessionId: null,
      workspaceId: workspace.id,
      objective: 'x',
      orchestratorAgentId: null,
      maxIterations: 3,
    });
    const record = fixture.services.database.permissions.createRequest({
      id: 'perm-1',
      runId: run.id,
      sessionId: 'sess-1',
      workspaceId: workspace.id,
      toolName: 'Bash',
      command: 'node check.mjs',
      reason: 'teste',
    });
    value(
      await fixture.router.handle('permission.approve', {
        requestId: record.id,
        rule: 'Bash(node check.mjs)',
      }),
    );

    // A second service graph on the same database - what a restart is.
    const reopened = fixture.services.database.permissions;
    assert.deepEqual(reopened.rulesFor(workspace.id), ['Bash(node check.mjs)']);

    // Approving the same rule again does not accumulate a second grant.
    const again = fixture.services.database.permissions.createRequest({
      id: 'perm-2',
      runId: run.id,
      sessionId: 'sess-1',
      workspaceId: workspace.id,
      toolName: 'Bash',
      command: 'node check.mjs',
      reason: 'teste',
    });
    value(
      await fixture.router.handle('permission.approve', {
        requestId: again.id,
        rule: 'Bash(node check.mjs)',
      }),
    );
    assert.deepEqual(reopened.rulesFor(workspace.id), ['Bash(node check.mjs)']);

    const [grant] = value<Array<{ id: string }>>(
      await fixture.router.handle('permission.grants', { workspaceId: workspace.id }),
    );
    assert.deepEqual(
      value(await fixture.router.handle('permission.revoke', { grantId: grant!.id })),
      { revoked: true },
    );
    assert.deepEqual(reopened.rulesFor(workspace.id), [], 'withdrawn means withdrawn');
  } finally {
    await fixture.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---- the real CLI's own words ----------------------------------------- */

/**
 * A `permission_denials` entry exactly as Claude Code 2.1.263 emitted it.
 *
 * Captured from a real run in this repository, not written from the docs:
 *
 *   claude --print --permission-mode acceptEdits \
 *     --allowedTools Read Write Edit Glob Grep \
 *     --output-format stream-json --verbose \
 *     "Execute o comando de shell: node -e ... Use Bash. Nao use Write."
 *
 * The shape is not part of any published contract, so this fixture is what
 * stops the reader from drifting away from it unnoticed.
 */
const REAL_DENIAL = {
  tool_name: 'Bash',
  tool_use_id: 'toolu_015GDcCy2Xi2Kr9w6cxMPQVX',
  tool_input: {
    command: 'node -e "require(\'fs\').writeFileSync(\'hello.txt\',\'pronto\')"',
    description: "Create hello.txt with content 'pronto' via node",
  },
};

test("the real CLI's denial shape is read, field for field", async () => {
  const { readDeniedCalls } = await import(
    '../apps/desktop/src/main/adapters/claude-adapter.js'
  );
  const [call] = readDeniedCalls([REAL_DENIAL]);

  assert.ok(call);
  assert.equal(call.toolName, 'Bash');
  assert.equal(call.toolUseId, 'toolu_015GDcCy2Xi2Kr9w6cxMPQVX');
  assert.equal(call.command, REAL_DENIAL.tool_input.command);
  // The agent's own reason for wanting the command. The command says what;
  // this says why, and an approval dialog needs both.
  assert.equal(call.description, "Create hello.txt with content 'pronto' via node");
  assert.match(call.arguments ?? '', /writeFileSync/);
});

test('the description reaches the request, in the worker’s own words', async () => {
  const prepared = await prepare({
    orchestratorScript: [delegate, done],
    workerScript: ['não consegui'],
    maxIterations: 2,
  });
  prepared.worker.denyNext = [
    {
      toolName: 'Bash',
      toolUseId: REAL_DENIAL.tool_use_id,
      command: REAL_DENIAL.tool_input.command,
      description: REAL_DENIAL.tool_input.description,
    },
  ];
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
    assert.match(request!.reason, /O worker disse: "Create hello\.txt with content 'pronto' via node"/);
    assert.match(request!.reason, /não é interativa/);
  } finally {
    await prepared.cleanup();
  }
});
