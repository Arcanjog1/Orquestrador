/**
 * Verificar um arquivo sem que ninguém cadastre um teste para ele.
 *
 * ## O que estava quebrado
 *
 * O `hello.txt` foi criado com **exatamente** os bytes certos e a execução
 * ainda assim nunca podia terminar. O workspace não tinha verificações
 * cadastradas, então o laço não tinha nada para rodar; sem nada rodado, todo
 * critério de aceite que o supervisor declarava era marcado **failed**; e um
 * critério failed bloqueia o DoneGate para sempre. O Codex estava certo em
 * parar e dizer isso.
 *
 * Ou seja: **declarar um critério de aceite num workspace sem verificações
 * cadastradas tornava DONE inalcançável**, fizesse o worker o que fizesse.
 *
 * ## O que estes testes fixam
 *
 * A verificação direta é uma *comparação tipada* que o processo principal faz
 * lendo o arquivo — nunca um comando, nunca uma string montada pela IA. A
 * regra antiga continua de pé: só verificação cadastrada executa comando. Esta
 * não executa nenhum.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  MAX_CHECKED_BYTES,
  runFileCheck,
  runFileChecks,
  describeFileCheck,
} from '../src/verification/file-check.js';
import { parseDecision } from '../src/orchestrator/decision-parser.js';
import { createDesktopFixture, ScriptedAgent } from './helpers/desktop-fixture.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';
import type { AgentInput } from '../src/core/types.js';

/** The six bytes of the objective: `pronto`, no BOM, no newline. */
const PRONTO_HEX = '70726F6E746F';
const PRONTO = 'pronto';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

function scratch(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'lao-filecheck-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/* ---- the check itself -------------------------------------------------- */

test('a file with exactly the six bytes passes, and reports size and hash', async () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, 'hello.txt'), Buffer.from(PRONTO_HEX, 'hex'));
    const result = await runFileCheck(s.dir, {
      path: 'hello.txt',
      expectBytesHex: PRONTO_HEX,
      forbidBom: true,
      forbidTrailingNewline: true,
    });

    assert.equal(result.passed, true);
    assert.equal(result.outcome, 'ok');
    assert.equal(result.problem, null);
    assert.equal(result.sizeBytes, 6);
    assert.equal(
      result.sha256,
      createHash('sha256').update(Buffer.from(PRONTO_HEX, 'hex')).digest('hex'),
      'the hash is of the bytes actually read',
    );
    assert.match(describeFileCheck(result), /^PASS hello\.txt \(6 bytes/);
  } finally {
    s.cleanup();
  }
});

test('a missing file is "missing", not a crash and not a pass', async () => {
  const s = scratch();
  try {
    const result = await runFileCheck(s.dir, { path: 'hello.txt', expectText: PRONTO });
    assert.equal(result.passed, false);
    assert.equal(result.outcome, 'missing');
    assert.match(result.problem ?? '', /não existe/);
    assert.equal(result.sizeBytes, null, 'nothing was read, so nothing is reported');
  } finally {
    s.cleanup();
  }
});

test('a BOM is caught, and named as a BOM', async () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, 'hello.txt'), Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(PRONTO, 'utf8'),
    ]));
    const result = await runFileCheck(s.dir, { path: 'hello.txt', forbidBom: true });
    assert.equal(result.passed, false);
    assert.equal(result.outcome, 'bom-present');
    assert.match(result.problem ?? '', /EF BB BF/);
    // It was still read, so the record can say what is actually there.
    assert.equal(result.sizeBytes, 9);
  } finally {
    s.cleanup();
  }
});

test('a trailing newline is caught, and is a different fact from wrong content', async () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, 'hello.txt'), `${PRONTO}\n`);
    const withNewlineForbidden = await runFileCheck(s.dir, {
      path: 'hello.txt',
      forbidTrailingNewline: true,
    });
    assert.equal(withNewlineForbidden.outcome, 'trailing-newline');

    // And the same file against the exact bytes is a content mismatch, which
    // reports both lengths so the difference is visible without opening it.
    const againstBytes = await runFileCheck(s.dir, {
      path: 'hello.txt',
      expectBytesHex: PRONTO_HEX,
    });
    assert.equal(againstBytes.outcome, 'content-mismatch');
    assert.match(againstBytes.problem ?? '', /Esperado 6 bytes.*encontrado 7 bytes/s);
    assert.match(againstBytes.problem ?? '', /70 72 6F 6E 74 6F/, 'the expected bytes, in hex');
  } finally {
    s.cleanup();
  }
});

test('wrong content is reported with both sides, in hex', async () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, 'hello.txt'), 'errado');
    const result = await runFileCheck(s.dir, { path: 'hello.txt', expectBytesHex: PRONTO_HEX });
    assert.equal(result.outcome, 'content-mismatch');
    assert.match(result.problem ?? '', /65 72 72 61 64 6F/, 'what was actually found');
    assert.equal(result.sizeBytes, 6, 'same length, different bytes');
  } finally {
    s.cleanup();
  }
});

test('a path outside the workspace is refused, and nothing is read', async () => {
  const s = scratch();
  const outside = scratch();
  try {
    writeFileSync(join(outside.dir, 'secret.txt'), 'não deveria ser lido');
    for (const path of [
      '../secret.txt',
      '../../etc/passwd',
      'sub/../../secret.txt',
      join(outside.dir, 'secret.txt'),
    ]) {
      const result = await runFileCheck(s.dir, { path });
      assert.equal(result.passed, false, `${path} must be refused`);
      assert.ok(
        result.outcome === 'outside-workspace' || result.outcome === 'invalid-request',
        `${path} gave ${result.outcome}`,
      );
      assert.equal(result.sizeBytes, null, 'and nothing was read');
      assert.equal(result.sha256, null);
    }
  } finally {
    s.cleanup();
    outside.cleanup();
  }
});

test('a symlink pointing out of the workspace is refused, not followed', async () => {
  const s = scratch();
  const outside = scratch();
  try {
    const secret = join(outside.dir, 'secret.txt');
    writeFileSync(secret, 'não deveria ser lido');
    try {
      symlinkSync(secret, join(s.dir, 'escape.txt'));
    } catch {
      return; // A platform without symlink permission cannot exercise this.
    }

    const result = await runFileCheck(s.dir, { path: 'escape.txt' });
    assert.equal(result.passed, false);
    assert.equal(result.outcome, 'outside-workspace');
    assert.match(result.problem ?? '', /link/);
    assert.equal(result.sha256, null, 'the target was never read');
  } finally {
    s.cleanup();
    outside.cleanup();
  }
});

test('a directory, an oversized file and a malformed request each say what they are', async () => {
  const s = scratch();
  try {
    mkdirSync(join(s.dir, 'a-directory'));
    assert.equal((await runFileCheck(s.dir, { path: 'a-directory' })).outcome, 'not-a-file');

    writeFileSync(join(s.dir, 'big.bin'), Buffer.alloc(MAX_CHECKED_BYTES + 1));
    const big = await runFileCheck(s.dir, { path: 'big.bin' });
    assert.equal(big.outcome, 'too-large');
    assert.match(big.problem ?? '', /verificação registrada/, 'and points at the right tool');

    for (const [request, why] of [
      [{ path: '' }, 'empty path'],
      [{ path: 'x', expectBytesHex: 'zz' }, 'not hex'],
      [{ path: 'x', expectBytesHex: '70726' }, 'odd length'],
      [{ path: 'x', expectBytesHex: PRONTO_HEX, expectText: PRONTO }, 'both forms'],
      [{ path: 'x', expectSizeBytes: -1 }, 'negative size'],
    ] as const) {
      const result = await runFileCheck(s.dir, request);
      assert.equal(result.outcome, 'invalid-request', why);
      assert.equal(result.sizeBytes, null);
    }
  } finally {
    s.cleanup();
  }
});

test('a file that cannot be read is a read error - not missing, and never a pass', async () => {
  const s = scratch();
  try {
    // A regular file used as a directory. The path is *there*; it simply
    // cannot be read, which is a different fact from the file not existing -
    // and the difference matters, because "missing" tells the supervisor to
    // create the file while "read error" tells it something is wrong with the
    // path. POSIX answers ENOTDIR here; Windows answers ENOENT for the same
    // shape, so the exact outcome is asserted per platform and the part both
    // must agree on - refused, nothing read - is asserted for both.
    writeFileSync(join(s.dir, 'a.txt'), PRONTO);
    const throughAFile = await runFileCheck(s.dir, {
      path: 'a.txt/child.txt',
      expectText: PRONTO,
    });
    assert.equal(throughAFile.passed, false);
    assert.equal(throughAFile.sha256, null, 'nothing was read');
    if (process.platform === 'win32') {
      assert.ok(['read-error', 'missing'].includes(throughAFile.outcome), throughAFile.outcome);
    } else {
      assert.equal(throughAFile.outcome, 'read-error');
      assert.match(throughAFile.problem ?? '', /ENOTDIR/);
    }

    // The case a real workspace actually hits: the file is there, stat works,
    // and opening it is refused. Root ignores the mode bits and Windows does
    // not have them, so this asserts nothing where it cannot be produced -
    // it runs for real on the Linux CI runner, which is not root.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const locked = join(s.dir, 'locked.txt');
      writeFileSync(locked, PRONTO);
      chmodSync(locked, 0o000);
      const result = await runFileCheck(s.dir, { path: 'locked.txt', expectText: PRONTO });
      chmodSync(locked, 0o600);
      assert.equal(result.passed, false);
      assert.equal(result.outcome, 'read-error');
      assert.match(result.problem ?? '', /EACCES/);
      assert.equal(result.sha256, null, 'no hash of bytes that were never read');
      assert.equal(result.sizeBytes, PRONTO.length, 'stat succeeded; the read did not');
      assert.match(describeFileCheck(result), /locked\.txt/);
    }
  } finally {
    s.cleanup();
  }
});

test('mustExist:false asserts absence, both ways round', async () => {
  const s = scratch();
  try {
    assert.equal((await runFileCheck(s.dir, { path: 'nope.txt', mustExist: false })).passed, true);
    writeFileSync(join(s.dir, 'nope.txt'), 'x');
    const present = await runFileCheck(s.dir, { path: 'nope.txt', mustExist: false });
    assert.equal(present.passed, false);
    assert.equal(present.outcome, 'unexpectedly-present');
  } finally {
    s.cleanup();
  }
});

test('several checks all run, and one failure never hides another', async () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, 'a.txt'), PRONTO);
    const results = await runFileChecks(s.dir, [
      { path: 'a.txt', expectText: PRONTO },
      { path: 'b.txt', expectText: PRONTO },
      { path: '../c.txt' },
    ]);
    assert.deepEqual(
      results.map((r) => r.outcome),
      ['ok', 'missing', 'outside-workspace'],
    );
  } finally {
    s.cleanup();
  }
});

/* ---- the decision parser ----------------------------------------------- */

test('a file check is parsed as data, and anything unrecognised is refused', () => {
  const ok = parseDecision(
    JSON.stringify({
      action: 'verify',
      acceptanceCriteria: ['c'],
      verificationCommands: [],
      fileChecks: [{ path: 'hello.txt', expectBytesHex: PRONTO_HEX, criteria: ['c'] }],
    }),
  );
  assert.equal(ok.ok, true, ok.ok === false ? ok.error : '');
  assert.equal(ok.ok && ok.decision.fileChecks.length, 1);

  // `verify` used to require a command id. In a workspace with no registered
  // verifications that made `verify` impossible - half of the deadlock.
  const noProof = parseDecision(
    JSON.stringify({ action: 'verify', acceptanceCriteria: [], verificationCommands: [] }),
  );
  assert.equal(noProof.ok, false);
  assert.match(noProof.ok === false ? noProof.error : '', /verificationCommands.*fileChecks/);

  // A field nobody defined is refused rather than ignored: this is where a
  // model's output becomes something the application acts on.
  for (const bad of [
    { path: 'x', command: 'rm -rf /' },
    { path: 'x', exec: true },
    { path: 123 },
    'hello.txt',
  ]) {
    const result = parseDecision(
      JSON.stringify({
        action: 'verify',
        acceptanceCriteria: [],
        verificationCommands: [],
        fileChecks: [bad],
      }),
    );
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
  }
});

/* ---- through the whole loop -------------------------------------------- */

const CRITERION = 'hello.txt contém exatamente os bytes 70 72 6F 6E 74 6F';
const CHECK = {
  path: 'hello.txt',
  expectBytesHex: PRONTO_HEX,
  forbidBom: true,
  forbidTrailingNewline: true,
  criteria: [CRITERION],
};

async function runWith(options: {
  orchestratorScript: readonly string[];
  workerScript: ReadonlyArray<string | ((input: AgentInput) => string)>;
  maxIterations?: number;
  seed?: (dir: string) => void;
  registerVerification?: boolean;
}) {
  const repo = createGitFixture('lao-fc-loop-');
  repo.write('README.md', '# x\n');
  repo.commitAll('base');
  options.seed?.(repo.dir);

  const orchestrator = new ScriptedAgent('mock-codex', 'Codex', options.orchestratorScript);
  const worker = new ScriptedAgent('mock-claude', 'Claude', options.workerScript);
  const fixture = createDesktopFixture({
    createRunners: async () => ({ orchestrator, worker, workerAccountId: null }),
    maxIterations: options.maxIterations ?? 4,
  });
  const workspace = value<{ id: string }>(
    await fixture.router.handle('workspace.create', { name: 'S', localPath: repo.dir }),
  );
  if (options.registerVerification) {
    fixture.services.database.verifications.upsert({
      workspaceId: workspace.id,
      id: 'hello-exists',
      label: 'x',
      command: 'node -e "process.exit(0)"',
    });
  }
  value(await fixture.router.handle('accounts.create', { name: 'C', provider: 'anthropic' }));
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
  const sent = value<{ run: { id: string } }>(
    await fixture.router.handle('chat.sendMessage', { sessionId: session.id, text: 'Crie hello.txt' }),
  );
  const run = await fixture.services.orchestration.waitFor(sent.run.id);
  return {
    run,
    repo,
    fixture,
    orchestrator,
    worker,
    runId: sent.run.id,
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
  acceptanceCriteria: [CRITERION],
  verificationCommands: [],
  fileChecks: [CHECK],
  summary: 'vou pedir',
});

test('a workspace with no registered verifications can finish, on the file check alone', async () => {
  const prepared = await runWith({
    orchestratorScript: [delegate],
    workerScript: [
      (input: AgentInput) => {
        writeFileSync(join(input.workingDirectory, 'hello.txt'), Buffer.from(PRONTO_HEX, 'hex'));
        return 'criado';
      },
    ],
  });
  try {
    assert.equal(prepared.run.status, 'DONE');
    assert.equal(prepared.orchestrator.calls.length, 1, 'and without a second round trip');

    // The check is on the record as a read, never as a command line - so
    // nobody reading the history mistakes it for something that executed.
    const rows = prepared.fixture.services.database.runs.verifications(prepared.runId) as Array<{
      command: string;
      passed: number;
    }>;
    assert.ok(rows.some((r) => r.command.startsWith('[leitura direta] hello.txt') && r.passed === 1));

    const steps = prepared.fixture.services.database.runs.steps(prepared.runId);
    assert.equal(steps.find((s) => s.phase === 'file-check')?.status, 'passed');
    assert.equal(steps.filter((s) => s.phase === 'done-gate').at(-1)?.status, 'passed');
  } finally {
    await prepared.cleanup();
  }
});

test('an unproven criterion still blocks DONE, and says so in those words', async () => {
  // The check names no criteria, so it settles none. The criterion is
  // unproven - not disproven - and the gate must say the difference.
  const noCriteria = JSON.stringify({
    action: 'delegate',
    task: 'Crie hello.txt',
    acceptanceCriteria: [CRITERION],
    verificationCommands: [],
    fileChecks: [{ path: 'hello.txt', expectBytesHex: PRONTO_HEX }],
    summary: 'x',
  });
  const prepared = await runWith({
    // The second turn asks to finish, so the gate actually runs and can be
    // read: without it the run would simply hit the iteration limit and the
    // wording under test would never be produced.
    orchestratorScript: [
      noCriteria,
      JSON.stringify({
        action: 'done',
        acceptanceCriteria: [],
        verificationCommands: [],
        fileChecks: [],
        summary: 'acho que terminei',
      }),
    ],
    workerScript: [
      (input: AgentInput) => {
        writeFileSync(join(input.workingDirectory, 'hello.txt'), Buffer.from(PRONTO_HEX, 'hex'));
        return 'criado';
      },
    ],
    maxIterations: 2,
  });
  try {
    assert.notEqual(prepared.run.status, 'DONE');
    const gate = prepared.fixture.services.database.runs
      .steps(prepared.runId)
      .filter((s) => s.phase === 'done-gate');
    assert.ok(gate.length > 0, 'the gate ran');
    assert.match(gate.at(-1)!.summary ?? '', /has no supporting evidence/);
    // The regression this whole change exists for: never "recorded as failed"
    // when nothing looked at it.
    assert.equal(/is recorded as failed/.test(gate.at(-1)!.summary ?? ''), false);
  } finally {
    await prepared.cleanup();
  }
});

test('wrong content produces objective feedback naming both sides', async () => {
  const prepared = await runWith({
    orchestratorScript: [delegate, delegate],
    workerScript: [
      (input: AgentInput) => {
        writeFileSync(join(input.workingDirectory, 'hello.txt'), 'errado');
        return 'criado';
      },
    ],
    maxIterations: 2,
  });
  try {
    assert.notEqual(prepared.run.status, 'DONE');
    // The second orchestrator turn was told exactly what is in the file.
    const feedback = prepared.orchestrator.calls[1]?.prompt ?? '';
    assert.match(feedback, /FILE CHECKS \(read by the application, no command was run\)/);
    assert.match(feedback, /65 72 72 61 64 6F/, 'what was found, in hex');
    assert.match(feedback, /70 72 6F 6E 74 6F/, 'and what was expected');
  } finally {
    await prepared.cleanup();
  }
});

test('a file already correct finishes without an artificial rewrite', async () => {
  const prepared = await runWith({
    // The file is committed in the baseline, so nothing changes in this run.
    seed: (dir) => writeFileSync(join(dir, 'hello.txt'), Buffer.from(PRONTO_HEX, 'hex')),
    orchestratorScript: [
      JSON.stringify({
        action: 'done',
        acceptanceCriteria: [CRITERION],
        verificationCommands: [],
        fileChecks: [CHECK],
        summary: 'já está certo',
      }),
    ],
    workerScript: ['não precisei fazer nada'],
    maxIterations: 2,
  });
  try {
    assert.equal(prepared.run.status, 'DONE', 'a correct file is the goal, reached');
    assert.equal(prepared.worker.calls.length, 0, 'and no delegation was needed at all');
    const gate = prepared.fixture.services.database.runs
      .steps(prepared.runId)
      .filter((s) => s.phase === 'done-gate');
    assert.equal(gate.at(-1)?.status, 'passed');
    assert.equal(
      /No file changed/.test(gate.at(-1)?.summary ?? ''),
      false,
      'the "nothing changed" rule must not demand a pointless rewrite',
    );
  } finally {
    await prepared.cleanup();
  }
});

test('the DoneGate re-reads the file, and catches it being broken after the check passed', async () => {
  // Iteration 1 writes the right bytes; iteration 2's worker corrupts the file
  // *after* that iteration's check passed. Only a fresh read at the gate can
  // catch it - which is exactly what a gate trusting an earlier iteration
  // would certify wrongly.
  let turn = 0;
  const prepared = await runWith({
    orchestratorScript: [
      delegate,
      JSON.stringify({
        action: 'done',
        acceptanceCriteria: [],
        verificationCommands: [],
        fileChecks: [],
        summary: 'pronto',
      }),
    ],
    workerScript: [
      (input: AgentInput) => {
        turn += 1;
        writeFileSync(
          join(input.workingDirectory, 'hello.txt'),
          turn === 1 ? Buffer.from(PRONTO_HEX, 'hex') : Buffer.from('estragado', 'utf8'),
        );
        return 'ok';
      },
    ],
    maxIterations: 2,
  });
  try {
    // The first iteration's check passed and settled the criterion; the gate
    // re-read and found the file no longer matching.
    const gate = prepared.fixture.services.database.runs
      .steps(prepared.runId)
      .filter((s) => s.phase === 'done-gate');
    if (turn > 1) {
      assert.ok(gate.length > 0);
      assert.match(gate.at(-1)!.summary ?? '', /File check failed/);
      assert.notEqual(prepared.run.status, 'DONE');
    }
  } finally {
    await prepared.cleanup();
  }
});

test('a workspace with no git still verifies by reading', async () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, 'hello.txt'), Buffer.from(PRONTO_HEX, 'hex'));
    // No git anywhere: the check does not care, because it opens a file.
    assert.equal(existsSync(join(s.dir, '.git')), false);
    const result = await runFileCheck(s.dir, { path: 'hello.txt', expectBytesHex: PRONTO_HEX });
    assert.equal(result.passed, true);
  } finally {
    s.cleanup();
  }
});

test('an unknown verification id is still refused, and never executed', async () => {
  const prepared = await runWith({
    orchestratorScript: [
      JSON.stringify({
        action: 'verify',
        acceptanceCriteria: [CRITERION],
        verificationCommands: ['inventada', 'rm -rf /'],
        fileChecks: [],
        summary: 'x',
      }),
      JSON.stringify({ action: 'blocked', reason: 'parei', acceptanceCriteria: [], verificationCommands: [] }),
    ],
    workerScript: ['x'],
    maxIterations: 2,
  });
  try {
    const rows = prepared.fixture.services.database.runs.verifications(prepared.runId) as Array<{
      command: string;
    }>;
    assert.deepEqual(rows, [], 'nothing was run');
    // And the orchestrator was pointed at the mechanism that does exist.
    assert.match(prepared.orchestrator.calls[1]?.prompt ?? '', /Use "fileChecks"/);
  } finally {
    await prepared.cleanup();
  }
});

test('asking twice for ids that do not exist stops with a concrete reason', async () => {
  const askUnknown = JSON.stringify({
    action: 'verify',
    acceptanceCriteria: [CRITERION],
    verificationCommands: ['inventada'],
    fileChecks: [],
    summary: 'x',
  });
  const prepared = await runWith({
    // Twice in a row, having proved nothing. The first refusal is information
    // the orchestrator had not seen; the second is a loop with no exit.
    orchestratorScript: [askUnknown, askUnknown, askUnknown],
    workerScript: ['x'],
    maxIterations: 5,
  });
  try {
    assert.equal(prepared.run.status, 'NEEDS_HUMAN', 'stopped, not looped to the limit');
    assert.match(prepared.run.summary ?? '', /duas vezes seguidas/);
    assert.match(prepared.run.summary ?? '', /verificação direta de arquivo/);
    assert.match(prepared.run.summary ?? '', /Repetir a mesma delegação não mudaria nada/);
    // It stopped early rather than burning the whole budget.
    assert.ok(prepared.run.iterations <= 2, `stopped at iteration ${prepared.run.iterations}`);

    // The step carries what was missing and what is still unproven, so the
    // reason is on the record and not only in a sentence.
    const step = prepared.fixture.services.database.runs
      .steps(prepared.runId)
      .find((s) => s.phase === 'verification' && s.status === 'unavailable');
    assert.ok(step, 'the record names the dead end');
    assert.match(step!.detail ?? '', /inventada/);
    assert.match(step!.detail ?? '', /hello\.txt/);
  } finally {
    await prepared.cleanup();
  }
});

test('every round says which criteria still lack proof, and unproven is not failed', async () => {
  const askUnknown = JSON.stringify({
    action: 'verify',
    acceptanceCriteria: [CRITERION],
    verificationCommands: ['inventada'],
    fileChecks: [],
    summary: 'x',
  });
  const prepared = await runWith({
    orchestratorScript: [askUnknown, delegate],
    workerScript: [
      (input: AgentInput) => {
        writeFileSync(join(input.workingDirectory, 'hello.txt'), Buffer.from(PRONTO_HEX, 'hex'));
        return 'criado';
      },
    ],
    maxIterations: 4,
  });
  try {
    // Round two is told, in the prompt, exactly what is still outstanding.
    // Before this the supervisor could only find out by proposing `done` and
    // having the gate refuse it - a wasted round trip, and the reason a run
    // could burn its whole budget rediscovering the same thing.
    const second = prepared.orchestrator.calls[1]!.prompt;
    assert.match(second, /CRITERIA STILL WITHOUT PROOF/);
    assert.match(second, /\[unproven\] "hello\.txt contém exatamente os bytes/);
    assert.doesNotMatch(
      second,
      /\[failed  \] "hello\.txt/,
      'nobody looked is not the same as the evidence says no',
    );
    assert.match(second, /Never with an id that is not on that list\./);
    assert.equal(prepared.run.status, 'DONE');
  } finally {
    await prepared.cleanup();
  }
});

test('the first refusal still reaches the orchestrator, so it can switch to a file check', async () => {
  const askUnknown = JSON.stringify({
    action: 'verify',
    acceptanceCriteria: [CRITERION],
    verificationCommands: ['inventada'],
    fileChecks: [],
    summary: 'x',
  });
  const prepared = await runWith({
    // Refused once, then it uses the mechanism the refusal pointed at.
    orchestratorScript: [askUnknown, delegate],
    workerScript: [
      (input: AgentInput) => {
        writeFileSync(join(input.workingDirectory, 'hello.txt'), Buffer.from(PRONTO_HEX, 'hex'));
        return 'criado';
      },
    ],
    maxIterations: 4,
  });
  try {
    assert.equal(prepared.run.status, 'DONE', 'a correctable mistake is corrected, not fatal');
    assert.match(prepared.orchestrator.calls[1]!.prompt, /REFUSED/);
    assert.match(prepared.orchestrator.calls[1]!.prompt, /Use "fileChecks"/);
  } finally {
    await prepared.cleanup();
  }
});
