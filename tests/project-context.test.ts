/**
 * The project's shared context: what gets sent, and what never does.
 *
 * The requirement has two halves that pull against each other — a project must
 * accumulate what it knows, and a prompt must not become a dump of every
 * conversation. So the selection is the subject here: which entries travel,
 * in what order, and what the block says about their standing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderContext,
  selectContext,
  type ContextEntry,
} from '../src/context/project-context.js';
import { createDesktopFixture } from './helpers/desktop-fixture.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

let clock = 0;
function entry(partial: Partial<ContextEntry> & Pick<ContextEntry, 'kind' | 'title'>): ContextEntry {
  clock += 1;
  return {
    id: `ctx-${clock}`,
    body: partial.body ?? 'corpo',
    sourceRef: partial.sourceRef ?? null,
    pinned: partial.pinned ?? false,
    updatedAt: partial.updatedAt ?? `2026-09-08T00:00:${String(clock).padStart(2, '0')}Z`,
    ...partial,
  };
}

test('rules and the project objective always travel, however irrelevant they look', () => {
  const entries = [
    entry({ kind: 'rule', title: 'Nunca usar API paga', body: 'assinatura apenas' }),
    entry({ kind: 'objective', title: 'Um orquestrador de agentes', body: 'codex supervisiona' }),
    entry({ kind: 'decision', title: 'Tailwind para estilos', body: 'decidido em julho' }),
  ];

  // An objective with nothing in common with any of them.
  const selection = selectContext(entries, 'renomear um arquivo de imagem');
  const kinds = selection.entries.map((e) => e.kind);

  assert.ok(kinds.includes('rule'), 'a rule that is dropped is a rule that is broken');
  assert.ok(kinds.includes('objective'));
});

test('a pinned entry outranks the score, and the rest compete on the objective', () => {
  const entries = [
    entry({ kind: 'decision', title: 'Assunto irrelevante', body: 'nada a ver', pinned: true }),
    entry({ kind: 'decision', title: 'Migrações aditivas', body: 'nunca recriar o banco' }),
    entry({ kind: 'decision', title: 'Cores do tema', body: 'escuro por padrão' }),
  ];

  const selection = selectContext(entries, 'escrever uma migração aditiva do banco');
  const titles = selection.entries.map((e) => e.title);

  assert.ok(titles.includes('Assunto irrelevante'), 'somebody pinned it, so it goes');
  // The relevant one is ahead of the irrelevant one among the competitors.
  assert.ok(titles.indexOf('Migrações aditivas') < titles.indexOf('Cores do tema'));
});

test('the character budget is respected, and what was left out is counted', () => {
  const entries = [
    entry({ kind: 'rule', title: 'Regra', body: 'curta' }),
    ...Array.from({ length: 20 }, (_, i) =>
      entry({ kind: 'decision', title: `Decisão ${i}`, body: 'x'.repeat(500) }),
    ),
  ];

  const selection = selectContext(entries, 'uma tarefa qualquer', { maxChars: 1500 });
  const size = selection.entries.reduce((n, e) => n + e.title.length + e.body.length, 0);

  assert.ok(size <= 1500, `the block stayed within budget (${size})`);
  assert.ok(selection.omitted > 0, 'and says how many it left out');
  assert.equal(selection.entries.length + selection.omitted, entries.length);
});

test('the same project and objective always select the same entries, in the same order', () => {
  const entries = [
    entry({ kind: 'decision', title: 'A', body: 'banco de dados' }),
    entry({ kind: 'decision', title: 'B', body: 'banco de dados' }),
    entry({ kind: 'state', title: 'C', body: 'banco de dados' }),
  ];
  const objective = 'mexer no banco de dados';

  const first = selectContext(entries, objective).entries.map((e) => e.id);
  const second = selectContext(entries, objective).entries.map((e) => e.id);
  const third = selectContext([...entries].reverse(), objective).entries.map((e) => e.id);

  assert.deepEqual(first, second, 'two calls agree');
  assert.deepEqual(
    [...first].sort(),
    [...third].sort(),
    'and the stored order does not change *which* entries are chosen',
  );
});

test('the rendered block says it is not evidence, and cites every source', () => {
  const selection = selectContext(
    [
      entry({ kind: 'state', title: 'Última execução', body: 'DONE', sourceRef: 'run:run-1' }),
      entry({ kind: 'rule', title: 'Escrita à mão', body: 'sem fonte' }),
    ],
    'qualquer coisa',
  );
  const text = renderContext(selection);

  // One language inside a prompt: the block speaks to a model, in the same
  // English as the rest of the orchestrator prompt. The interface speaks
  // Portuguese to the person, which is a different audience.
  assert.match(text, /Never cite this section as evidence/i);
  assert.match(text, /the repository\n?is right|repository\n?is right/i);
  assert.match(text, /\[source: run:run-1\]/);
  assert.match(text, /\[no source recorded\]/, 'an entry with no source says so');
  // The *framing* is one language. The entries themselves keep whatever
  // language the person wrote them in - "Última execução" above is content,
  // not a label, and translating somebody's note would be worse than leaving
  // it alone.
  assert.equal(/\[fonte:|anotação\(ões\)/.test(text), false, 'no half-translated framing');
});

test('an empty project renders nothing at all, not an empty heading', () => {
  assert.equal(renderContext(selectContext([], 'qualquer coisa')), '');
});

/* ---- through the real IPC surface ------------------------------------- */

test('context entries survive a restart and belong to their project', async () => {
  const fixture = createDesktopFixture();
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.createConversation', { name: 'Projeto A' }),
    );
    fixture.services.workspaces.reconcileFolders(fixture.services.projects);
    const project = fixture.services.projects.list().find((p) => p.workspaceId === workspace.id)!;

    value(
      await fixture.router.handle('project.addContext', {
        projectId: project.id,
        kind: 'rule',
        title: 'Sem API paga',
        body: 'Assinatura apenas; nunca ANTHROPIC_API_KEY.',
        pinned: true,
      }),
    );

    const listed = value<Array<{ title: string; pinned: boolean; kind: string }>>(
      await fixture.router.handle('project.listContext', { projectId: project.id }),
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.title, 'Sem API paga');
    assert.equal(listed[0]!.pinned, true);
    assert.equal(listed[0]!.kind, 'rule');

    // A second project sees none of it: context belongs to one project.
    const other = value<{ id: string }>(
      await fixture.router.handle('workspace.createConversation', { name: 'Projeto B' }),
    );
    fixture.services.workspaces.reconcileFolders(fixture.services.projects);
    const otherProject = fixture.services.projects.list().find((p) => p.workspaceId === other.id)!;
    const otherList = value<unknown[]>(
      await fixture.router.handle('project.listContext', { projectId: otherProject.id }),
    );
    assert.equal(otherList.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('removing a project takes its context with it, and nothing else', async () => {
  const fixture = createDesktopFixture();
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.createConversation', { name: 'Projeto' }),
    );
    fixture.services.workspaces.reconcileFolders(fixture.services.projects);
    const project = fixture.services.projects.list().find((p) => p.workspaceId === workspace.id)!;
    value(
      await fixture.router.handle('project.addContext', {
        projectId: project.id,
        kind: 'decision',
        title: 'Uma decisão',
        body: 'tomada',
      }),
    );

    value(await fixture.router.handle('project.remove', { projectId: project.id }));

    // The workspace - the folder the runs execute in - is untouched.
    assert.ok(fixture.services.database.workspaces.find(workspace.id));
    // The context rows went with the project, through the foreign key.
    assert.equal(fixture.services.database.projectContext.list(project.id).length, 0);
  } finally {
    await fixture.cleanup();
  }
});
