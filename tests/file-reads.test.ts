/**
 * O aplicativo lê o arquivo; o worker não precisa copiá-lo.
 *
 * ## O que aconteceu
 *
 * O Claude criou os quatro arquivos numa delegação. Depois disso, o Codex
 * passou a pedir **repetidamente o conteúdo integral dos mesmos quatro
 * arquivos** para revisar. As respostas voltavam truncadas, os critérios
 * continuavam pendentes, e a execução subiu até Opus/Alto por um problema que
 * modelo nenhum resolveria: o aplicativo podia ter aberto os arquivos sozinho o
 * tempo todo.
 *
 * ## As duas regras
 *
 * Ler é olhar; `fileChecks` é provar. São campos separados de propósito, e uma
 * leitura nunca resolve critério.
 *
 * E truncamento é **reportado**. Um truncamento silencioso é como o supervisor
 * passou a acreditar que tinha visto um arquivo inteiro.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_READ_BYTES,
  MAX_READ_TOTAL_BYTES,
  describeFileRead,
  runFileRead,
  runFileReads,
} from '../src/verification/file-check.js';
import { parseDecision } from '../src/orchestrator/decision-parser.js';
import { createPlainDir } from './helpers/git-fixture.js';

test('a small file comes back whole, with its size and hash', async () => {
  const s = createPlainDir('lao-read-');
  try {
    writeFileSync(join(s.dir, 'app.js'), 'const tarefas = [];\n');
    const read = await runFileRead(s.dir, { path: 'app.js' });
    assert.equal(read.ok, true);
    assert.equal(read.text, 'const tarefas = [];\n');
    assert.equal(read.sizeBytes, 20);
    assert.equal(read.truncated, false);
    assert.match(read.sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.match(describeFileRead(read), /app\.js \(20 bytes, sha256 [0-9a-f]{12}…\)/);
  } finally {
    s.cleanup();
  }
});

test('a long file is truncated, and says so - never silently', async () => {
  const s = createPlainDir('lao-read-big-');
  try {
    const body = 'x'.repeat(MAX_READ_BYTES + 500);
    writeFileSync(join(s.dir, 'big.txt'), body);
    const read = await runFileRead(s.dir, { path: 'big.txt' });
    assert.equal(read.ok, true);
    assert.equal(read.truncated, true);
    assert.equal(read.text?.length, MAX_READ_BYTES);
    // The full size is still reported, so nobody mistakes the excerpt for it.
    assert.equal(read.sizeBytes, body.length);
    assert.match(describeFileRead(read), /TRUNCADO/);
  } finally {
    s.cleanup();
  }
});

test('a smaller budget is honoured, and a bigger one is capped', async () => {
  const s = createPlainDir('lao-read-budget-');
  try {
    writeFileSync(join(s.dir, 'a.txt'), 'abcdefghij');
    assert.equal((await runFileRead(s.dir, { path: 'a.txt', maxBytes: 4 })).text, 'abcd');
    const huge = await runFileRead(s.dir, { path: 'a.txt', maxBytes: 10_000_000 });
    assert.equal(huge.text, 'abcdefghij');
    assert.equal(huge.truncated, false);
  } finally {
    s.cleanup();
  }
});

test('the four files of the incident are read in one round, by the application', async () => {
  const s = createPlainDir('lao-read-four-');
  try {
    for (const [name, body] of [
      ['index.html', '<!doctype html><title>Tarefas</title>'],
      ['style.css', 'body { margin: 0 }'],
      ['app.js', 'const tarefas = [];'],
      ['README.md', '# Tarefas'],
    ]) {
      writeFileSync(join(s.dir, name!), body!);
    }
    const reads = await runFileReads(
      s.dir,
      ['index.html', 'style.css', 'app.js', 'README.md'].map((path) => ({ path })),
    );
    assert.equal(reads.length, 4);
    assert.ok(reads.every((read) => read.ok));
    assert.equal(reads[2]!.text, 'const tarefas = [];');
  } finally {
    s.cleanup();
  }
});

test('the round budget is shared, and a file that does not fit says so', async () => {
  const s = createPlainDir('lao-read-total-');
  try {
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(join(s.dir, `f${index}.txt`), 'y'.repeat(MAX_READ_BYTES));
    }
    const reads = await runFileReads(
      s.dir,
      Array.from({ length: 6 }, (_, index) => ({ path: `f${index}.txt` })),
    );
    const returned = reads.reduce((total, read) => total + (read.text?.length ?? 0), 0);
    assert.ok(returned <= MAX_READ_TOTAL_BYTES, `${returned} bytes returned`);
    const refused = reads.filter((read) => !read.ok);
    assert.ok(refused.length > 0, 'the ones that did not fit are reported');
    assert.match(refused[0]!.problem ?? '', /orçamento de leitura/);
  } finally {
    s.cleanup();
  }
});

test('a read obeys the same boundary as a check: nothing outside the workspace', async () => {
  const s = createPlainDir('lao-read-in-');
  const outside = createPlainDir('lao-read-out-');
  try {
    writeFileSync(join(outside.dir, 'secret.txt'), 'não deveria ser lido');
    for (const path of ['../secret.txt', join(outside.dir, 'secret.txt')]) {
      const read = await runFileRead(s.dir, { path });
      assert.equal(read.ok, false, path);
      assert.equal(read.text, null, 'and nothing was read');
    }
    try {
      symlinkSync(join(outside.dir, 'secret.txt'), join(s.dir, 'escape.txt'));
      const followed = await runFileRead(s.dir, { path: 'escape.txt' });
      assert.equal(followed.ok, false);
      assert.equal(followed.outcome, 'outside-workspace');
    } catch {
      // A platform without symlink permission cannot exercise this.
    }
    mkdirSync(join(s.dir, 'sub'));
    assert.equal((await runFileRead(s.dir, { path: 'sub' })).outcome, 'not-a-file');
    assert.equal((await runFileRead(s.dir, { path: 'nope.txt' })).outcome, 'missing');
  } finally {
    s.cleanup();
    outside.cleanup();
  }
});

test('fileReads is parsed as data, and anything else is refused', () => {
  const base = {
    action: 'verify',
    acceptanceCriteria: [],
    verificationCommands: [],
    fileChecks: [{ path: 'a.txt', expectText: 'x' }],
  };
  const good = parseDecision(
    JSON.stringify({ ...base, fileReads: [{ path: 'app.js', maxBytes: null }, { path: 'style.css' }] }),
  );
  assert.equal(good.ok, true, good.ok === false ? good.error : '');
  if (good.ok) {
    assert.deepEqual(good.decision.fileReads, [{ path: 'app.js' }, { path: 'style.css' }]);
  }

  for (const bad of [
    { path: 'x', command: 'cat x' },
    { path: 'x', criteria: ['algo'] },
    { path: '' },
    { path: 'x', maxBytes: 0 },
    { path: 'x', maxBytes: -1 },
    { path: 'x', maxBytes: 1.5 },
    'app.js',
  ]) {
    const result = parseDecision(JSON.stringify({ ...base, fileReads: [bad] }));
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
  }
});

test('a read never settles a criterion: it takes no criteria at all', () => {
  // The field simply does not exist on a read, so there is no way to express
  // "this read proves that" - which is the whole separation.
  const result = parseDecision(
    JSON.stringify({
      action: 'verify',
      acceptanceCriteria: ['x'],
      verificationCommands: [],
      fileChecks: [],
      fileReads: [{ path: 'a.txt', criteria: ['x'] }],
    }),
  );
  assert.equal(result.ok, false);
});
