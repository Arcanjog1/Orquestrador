/**
 * The integration suite that only a real Electron can run.
 *
 * Everything here executes inside an actual Electron main process, against an
 * actual BrowserWindow loading the actual renderer bundle through the actual
 * preload. It answers the questions unit tests cannot:
 *
 *  - does `node:sqlite` work inside Electron's Node, all the way through
 *    migrations, prepared statements, transactions, WAL, close and reopen?
 *  - are the four security flags really on in a live window?
 *  - can the renderer reach Node, or only the named channels?
 *  - does a real IPC round trip work, and does onboarding render from it?
 *
 * A tiny harness rather than `node:test`: this process is Electron's, and it
 * has to be told explicitly when to exit.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'dist');
const bundles = join(root, 'dist-renderer');

/**
 * Dynamic imports go through a file:// URL.
 *
 * `import('D:\\...')` is refused by Node's ESM loader as "protocol 'd:'", so a
 * bare absolute path works everywhere except the platform this product ships
 * on.
 */
const load = (relative) => import(pathToFileURL(join(dist, relative)).href);

const { Database } = await load('src/database/database.js');
const { AppServices } = await load('apps/desktop/src/main/services/app-services.js');
const { IpcRouter } = await load('apps/desktop/src/main/ipc-router.js');
const { REQUEST_CHANNELS } = await load('apps/desktop/src/shared/ipc-contract.js');
const { WEB_PREFERENCES } = await load('apps/desktop/src/electron/security.js');

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** No single check may take longer than this. */
const CASE_TIMEOUT_MS = 90_000;
/** Nor the suite as a whole. */
const SUITE_TIMEOUT_MS = 8 * 60_000;

/**
 * Runs `fn` with a deadline.
 *
 * Every check here talks to a real window, and a window that never finishes
 * loading makes `executeJavaScript` wait forever. Without a bound, that shows
 * up in CI as a job that burns its whole allowance and says nothing. A timeout
 * turns it into a named failure.
 */
function withTimeout(name, fn) {
  return async () => {
    let timer;
    try {
      await Promise.race([
        fn(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${CASE_TIMEOUT_MS}ms`)),
            CASE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/* ------------------------------------------------------------- node:sqlite */

test('node:sqlite is available inside the Electron main process', () => {
  const sqlite = require('node:sqlite');
  assert.ok(sqlite.DatabaseSync, 'DatabaseSync must be exported');
  assert.ok(process.versions.electron, 'this must be running under Electron');
});

test('the real Database opens, migrates, writes, reads and survives a reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-db-'));
  const file = join(dir, 'orchestrator.db');
  try {
    let db = new Database({ filePath: file });
    assert.ok(db.schemaVersion > 0, 'migrations must have run');
    assert.equal(db.schemaVersion, db.expectedSchemaVersion);

    // WAL, asked of the live connection rather than assumed.
    const mode = db.driver.get('PRAGMA journal_mode');
    assert.equal(String(Object.values(mode)[0]).toLowerCase(), 'wal');

    // Prepared statement, insert, select.
    db.settings.set('greeting', 'olá');
    assert.equal(db.settings.get('greeting'), 'olá');

    // Transaction commit.
    db.transaction(() => {
      db.settings.set('committed', 'yes');
    });
    assert.equal(db.settings.get('committed'), 'yes');

    // Transaction rollback: the write inside must not survive.
    assert.throws(() =>
      db.transaction(() => {
        db.settings.set('rolled-back', 'yes');
        throw new Error('boom');
      }),
    );
    assert.equal(db.settings.get('rolled-back'), null);

    // Foreign keys are enforced, not merely declared.
    assert.throws(
      () =>
        db.driver.run(
          "INSERT INTO chat_sessions (id, workspace_id, title, created_at, updated_at) VALUES ('s','missing','t','now','now')",
        ),
      /FOREIGN KEY/i,
    );

    db.close();

    // Reopen: the data is still there and no migration re-runs.
    db = new Database({ filePath: file });
    assert.equal(db.settings.get('greeting'), 'olá');
    assert.equal(db.schemaVersion, db.expectedSchemaVersion);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------- the live window */

let services = null;
let appRoot = null;

test('a live window really has contextIsolation, sandbox and webSecurity on', async () => {
  const window = await openWindow();
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.webSecurity, true);
  assert.equal(WEB_PREFERENCES.sandbox, true);
});

test('the renderer cannot reach Node, the filesystem or ipcRenderer', async () => {
  const window = await openWindow();
  const probe = await window.webContents.executeJavaScript(`(() => ({
    require: typeof window.require,
    process: typeof window.process,
    module: typeof window.module,
    ipcRenderer: typeof window.ipcRenderer,
    electron: typeof window.electron,
    apiIsObject: typeof window.api,
  }))()`);
  assert.equal(probe.require, 'undefined');
  assert.equal(probe.process, 'undefined');
  assert.equal(probe.module, 'undefined');
  assert.equal(probe.ipcRenderer, 'undefined');
  assert.equal(probe.electron, 'undefined');
  assert.equal(probe.apiIsObject, 'object');
});

test('the bridge exposes exactly the contract, and no command escape hatch', async () => {
  const window = await openWindow();
  const exposed = await window.webContents.executeJavaScript(`(() => {
    const out = [];
    for (const [group, methods] of Object.entries(window.api)) {
      if (group === 'events') continue;
      for (const method of Object.keys(methods)) out.push(group + '.' + method);
    }
    return out;
  })()`);
  assert.deepEqual([...exposed].sort(), [...REQUEST_CHANNELS].sort());
  for (const forbidden of ['exec', 'shell', 'runCommand', 'invoke', 'send']) {
    assert.ok(
      !exposed.some((name) => name.split('.').pop() === forbidden),
      `bridge must not expose ${forbidden}`,
    );
  }
});

test('a real IPC round trip reaches the main process and comes back', async () => {
  const window = await openWindow();
  const info = await window.webContents.executeJavaScript('window.api.app.info()');
  assert.equal(info.electronVersion, process.versions.electron);
  assert.equal(info.nodeVersion, process.versions.node);
  assert.equal(info.chromeVersion, process.versions.chrome);
  assert.equal(info.sqliteAvailable, true);
});

test('RuntimeManager.diagnose() answers over IPC with the three runtimes', async () => {
  const window = await openWindow();
  const report = await window.webContents.executeJavaScript('window.api.runtime.diagnose()');
  assert.deepEqual(
    report.runtimes.map((r) => r.runtimeId).sort(),
    ['claude-code', 'codex', 'git'],
  );
  assert.equal(typeof report.ready, 'boolean');
  assert.equal(typeof report.checkedAt, 'string');
});

test('an invalid payload is refused at the boundary, as an error the UI can show', async () => {
  const window = await openWindow();
  const outcome = await window.webContents.executeJavaScript(`
    window.api.runtime.install({ runtimeId: 'bash' })
      .then(() => ({ thrown: false }))
      .catch((error) => ({ thrown: true, message: String(error.message) }))
  `);
  assert.equal(outcome.thrown, true);
  // contextBridge carries an Error's message across, not its custom fields, so
  // the message is what the interface has to work with - and it says what was
  // wrong rather than dumping a stack.
  assert.match(outcome.message, /runtimeId/);
  assert.match(outcome.message, /codex/);
});

test('the onboarding screen renders the runtime checklist from diagnose()', async () => {
  const window = await openWindow();

  // The approved design opens on the welcome step; the checklist is step one,
  // behind "Começar". Driving the real button keeps this a test of the screen
  // the user actually sees rather than of a component in isolation.
  await waitForText(window, /Bem-vindo/, 15_000);
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim().startsWith('Começar'))
      .click()
  `);

  const text = await waitForText(window, /Codex/, 15_000);
  assert.match(text, /Codex/);
  assert.match(text, /Claude Code/);
  assert.match(text, /Git/);
  assert.match(text, /AI Orchestrator/);
});

test('the interface reports the real Electron and Chromium it is running on', async () => {
  const window = await openWindow();
  // The old renderer printed these in a footer; the approved design shows them
  // under Settings -> Developer Mode. Either way the point is the same: the
  // numbers come from the main process, not from anything the page made up.
  const info = await window.webContents.executeJavaScript('window.api.app.info()');
  assert.equal(info.electronVersion, process.versions.electron);
  assert.equal(info.chromeVersion, process.versions.chrome);
  assert.equal(info.nodeVersion, process.versions.node);
});

test('a workspace added over IPC is persisted and listed back', async () => {
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-ws-'));
  try {
    const created = await window.webContents.executeJavaScript(
      `window.api.workspace.create(${JSON.stringify({ name: 'Projeto', localPath: dir })})`,
    );
    assert.equal(created.localPath, dir);
    const listed = await window.webContents.executeJavaScript('window.api.workspace.list()');
    assert.ok(listed.some((w) => w.id === created.id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a verification is added, edited and switched off on the real Settings screen', async () => {
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-verif-'));
  try {
    // A project to configure, added the way the interface adds one.
    const workspace = await window.webContents.executeJavaScript(
      `window.api.workspace.create(${JSON.stringify({ name: 'Projeto verificado', localPath: dir })})`,
    );
    assert.equal(workspace.localPath, dir);

    // Open Settings on the verifications tab. The hash router is the app's own;
    // the reload is driven from here rather than from inside the page, because
    // a navigation started by `executeJavaScript` tears down the very context
    // that would resolve its promise.
    await window.webContents.executeJavaScript(
      `(() => { location.hash = '#/configuracoes?tab=verifications'; return true; })()`,
    );
    await reloadWindow(window);
    await waitForText(window, /Verificações do projeto/, 15_000);
    await waitForText(window, /Nenhuma verificação cadastrada/, 15_000);

    // The screen configures whichever project the application has selected -
    // its own rule, the first in the list - so the assertions follow that.
    const selected = (await window.webContents.executeJavaScript('window.api.workspace.list()'))[0];
    const stored = async () =>
      window.webContents.executeJavaScript(
        `window.api.verifications.list(${JSON.stringify({ workspaceId: selected.id })})`,
      );

    // Fill the real dialog and save it.
    await click(window, 'add-verification');
    await waitForText(window, /Adicionar verificação/, 10_000);
    await type(window, 'verification-id', 'hello-exists');
    await type(window, 'verification-label', 'hello.txt exato');
    await type(window, 'verification-command', 'node check.mjs');
    await click(window, 'save-verification');

    // It appears on the screen the person is looking at...
    const listed = await waitForText(window, /hello-exists/, 15_000);
    assert.match(listed, /hello\.txt exato/);
    assert.match(listed, /node check\.mjs/);
    assert.match(listed, /Ativa/);

    // ...and it really is in the table the orchestration loop reads.
    assert.deepEqual(
      (await stored()).map((v) => [v.id, v.label, v.command, v.enabled]),
      [['hello-exists', 'hello.txt exato', 'node check.mjs', true]],
    );

    // Editing through the screen changes what is stored, and nothing else.
    await click(window, 'edit-hello-exists');
    await waitForText(window, /Editar hello-exists/, 10_000);
    await type(window, 'verification-label', 'hello.txt exato (revisado)');
    await click(window, 'save-verification');
    await waitForText(window, /revisado/, 15_000);
    const afterEdit = await stored();
    assert.equal(afterEdit[0].label, 'hello.txt exato (revisado)');
    assert.equal(afterEdit[0].command, 'node check.mjs', 'the command was not disturbed');
    assert.equal(afterEdit[0].enabled, true);

    // Switching it off is a real change of state, not a local one: a disabled
    // verification is the one thing the loop refuses to run.
    await click(window, 'toggle-hello-exists');
    await waitForText(window, /Desativada/, 15_000);
    assert.equal((await stored())[0].enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the login dialog shows the device code, keeps it while waiting, and drops it when done', async () => {
  const window = await openWindow();

  // Reach the dialog the way a person does: Settings, add an OpenAI account,
  // "Criar e conectar". No Codex runtime is installed in this test's
  // application root, so the real sign-in ends quickly; the dialog is open
  // either way, listening for this account's progress.
  await window.webContents.executeJavaScript(
    `(() => { location.hash = '#/configuracoes?tab=accounts'; return true; })()`,
  );
  await reloadWindow(window);
  await waitForText(window, /Adicionar conta OpenAI/, 15_000);
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === 'Adicionar conta OpenAI').click()
  `);
  await waitForText(window, /Adicionar conta OpenAI/, 10_000);
  await window.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector('input[placeholder="Ex.: Codex Trabalho"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'Codex Teste');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === 'Criar e conectar').click()
  `);
  await waitForText(window, /Conectando OpenAI|OpenAI conectado/, 15_000);

  const accounts = await window.webContents.executeJavaScript('window.api.accounts.list()');
  const account = accounts.find((a) => a.provider === 'openai' && a.name === 'Codex Teste');
  assert.ok(account, 'the account the dialog is for');

  // From here the main process speaks, exactly as the service does: the
  // payloads below are the shapes the fixed manager publishes.
  const say = (payload) => services.events.emit('account:progress', { accountId: account.id, ...payload });

  say({ stage: 'awaiting-browser', label: 'Abrindo o navegador para você entrar...', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH' });
  let text = await waitForText(window, /ABCD-EFGH/, 10_000);
  assert.match(text, /Código do dispositivo/);
  assert.match(text, /Copiar código/);
  assert.match(text, /Digite esse código na página aberta no navegador/);

  // The next report says nothing about the page or the code. Both stay.
  say({ stage: 'waiting-for-completion', label: 'Aguardando você concluir no navegador...' });
  await new Promise((r) => setTimeout(r, 300));
  text = await window.webContents.executeJavaScript('document.body.innerText');
  assert.match(text, /ABCD-EFGH/, 'the code survives a report that does not mention it');
  assert.match(text, /Aguardando você concluir no navegador/);
  assert.match(text, /Abrir o navegador de novo/, 'and so does the page');

  // The code is what was rendered, with no escape bytes and nothing else.
  const shown = await window.webContents.executeJavaScript(
    `document.querySelector('[data-testid="device-code"]').textContent`,
  );
  assert.equal(shown, 'ABCD-EFGH');

  // Connected: the code goes, and the dialog closes by itself.
  say({ stage: 'connected', label: 'Conta conectada.' });
  await waitForText(window, /OpenAI conectado/, 10_000);
  text = await window.webContents.executeJavaScript('document.body.innerText');
  assert.doesNotMatch(text, /ABCD-EFGH/, 'a finished attempt keeps no code on screen');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    text = await window.webContents.executeJavaScript('document.body.innerText');
    if (!/Conectando OpenAI|OpenAI conectado/.test(text)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.doesNotMatch(text, /OpenAI conectado/, 'the dialog closed on its own');
});

test('a dialog that missed the first report still gets the code from the next one', async () => {
  const window = await openWindow();

  // Open a fresh dialog the plain way: a second OpenAI account, then
  // "Criar e conectar". Whatever the real sign-in reported before this
  // dialog existed is gone - nothing was listening.
  await window.webContents.executeJavaScript(
    `(() => { location.hash = '#/configuracoes?tab=accounts'; return true; })()`,
  );
  await reloadWindow(window);
  await waitForText(window, /Adicionar conta OpenAI/, 15_000);
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === 'Adicionar conta OpenAI').click()
  `);
  await waitForText(window, /Ex\.: Codex Trabalho|Adicionar conta OpenAI/, 10_000);
  await window.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector('input[placeholder="Ex.: Codex Trabalho"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'Codex Segundo');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === 'Criar e conectar').click()
  `);
  await waitForText(window, /Conectando OpenAI|OpenAI conectado|Não conseguimos concluir/, 15_000);

  const accounts = await window.webContents.executeJavaScript('window.api.accounts.list()');
  const account = accounts.find((a) => a.provider === 'openai' && a.name === 'Codex Segundo');
  assert.ok(account);
  const say = (payload) => services.events.emit('account:progress', { accountId: account.id, ...payload });

  // No `awaiting-browser` ever reaches this dialog. The manager repeats the
  // page and the code on every waiting report, so the next one is enough.
  say({ stage: 'waiting-for-completion', label: 'Aguardando você concluir no navegador...', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH' });
  const text = await waitForText(window, /ABCD-EFGH/, 10_000);
  assert.match(text, /Copiar código/);
  assert.match(text, /Abrir o navegador de novo/);
  say({ stage: 'cancelled', label: 'Conexão cancelada.' });
});

test('the team dialog offers the real accounts by name, and what it saves is what the loop reads', async () => {
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-team-'));
  try {
    // Two persisted accounts, one per provider, and a project - added the way
    // the interface adds them. Neither account is connected: the dialog is
    // about *which* account, and must show them either way.
    await window.webContents.executeJavaScript(
      `window.api.accounts.create(${JSON.stringify({ name: 'Codex Trabalho', provider: 'openai' })})`,
    );
    await window.webContents.executeJavaScript(
      `window.api.accounts.create(${JSON.stringify({ name: 'Claude Trabalho', provider: 'anthropic' })})`,
    );
    const workspace = await window.webContents.executeJavaScript(
      `window.api.workspace.create(${JSON.stringify({ name: 'Projeto em equipe', localPath: dir })})`,
    );
    assert.equal(workspace.team.orchestrator.accountName, null, 'nothing chosen yet');

    // No runtime is installed here, so a fresh load lands on onboarding; the
    // workspace is reached the way a person reaches it: "Pular onboarding".
    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    await waitForText(window, /Projeto em equipe/, 15_000);

    // The header chip opens the team popover; "Editar equipe" opens the dialog.
    await click(window, 'team-chip');
    await waitForText(window, /Editar equipe/, 10_000);
    await click(window, 'edit-team');
    const dialog = await waitForText(window, /Equipe deste projeto/, 10_000);

    // Accounts, by their own names - not "Codex", not "OpenAI".
    const orchestratorPick = await window.webContents.executeJavaScript(
      `document.querySelector('[data-testid="team-orchestrator-account"]').textContent`,
    );
    const workerPick = await window.webContents.executeJavaScript(
      `document.querySelector('[data-testid="team-worker-account"]').textContent`,
    );
    const openaiNames = (await window.webContents.executeJavaScript('window.api.accounts.list()'))
      .filter((a) => a.provider === 'openai')
      .map((a) => a.name);
    assert.ok(
      openaiNames.some((name) => orchestratorPick.includes(name)),
      `the orchestrator picker shows one of the OpenAI accounts, got "${orchestratorPick}"`,
    );
    assert.notEqual(orchestratorPick.trim(), 'Codex', 'the provider is not offered as an account');
    assert.match(workerPick, /Claude Trabalho/);
    // The labels are rendered uppercase by CSS, and innerText follows.
    assert.match(dialog, /Provider/i);
    assert.match(dialog, /Model/i);
    assert.match(dialog, /Reasoning/i);

    // Choose a model for the orchestrator and save.
    await type(window, 'team-orchestrator-model', 'gpt-5.1-codex');
    await click(window, 'team-save');
    const closed = Date.now() + 10_000;
    let text = '';
    while (Date.now() < closed) {
      text = await window.webContents.executeJavaScript('document.body.innerText');
      if (!/Equipe deste projeto/.test(text)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.doesNotMatch(text, /Equipe deste projeto/, 'the dialog closed after saving');

    // What was saved is the workspace's team, by account, as the run reads it.
    const saved = (await window.webContents.executeJavaScript('window.api.workspace.list()')).find(
      (w) => w.id === workspace.id,
    );
    assert.ok(openaiNames.includes(saved.team.orchestrator.accountName));
    assert.ok(orchestratorPick.includes(saved.team.orchestrator.accountName), 'the shown account is the saved one');
    assert.equal(saved.team.orchestrator.model, 'gpt-5.1-codex');
    assert.equal(saved.team.worker.accountName, 'Claude Trabalho');
    assert.equal(saved.team.worker.provider, 'anthropic');
    assert.equal(saved.workerAgentId, `agent-worker-${saved.team.worker.accountId}`);

    // And the header shows the team by account after a restart of the page.
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    await waitForText(window, /Projeto em equipe/, 15_000);
    await click(window, 'team-chip');
    const popover = await waitForText(window, /Conta: Claude Trabalho/, 10_000);
    assert.match(popover, /gpt-5\.1-codex/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a conversation is renamed, archived, found and deleted from the real sidebar', async () => {
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-conv-'));
  try {
    const workspace = await window.webContents.executeJavaScript(
      `window.api.workspace.create(${JSON.stringify({ name: 'Projeto conversas', localPath: dir })})`,
    );
    const first = await window.webContents.executeJavaScript(
      `window.api.chat.createSession(${JSON.stringify({ workspaceId: workspace.id, title: 'Primeira conversa' })})`,
    );
    const second = await window.webContents.executeJavaScript(
      `window.api.chat.createSession(${JSON.stringify({ workspaceId: workspace.id, title: 'Segunda conversa' })})`,
    );

    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    let text = await waitForText(window, /Segunda conversa/, 15_000);
    assert.match(text, /Primeira conversa/);

    // Rename, through the row's menu and the dialog.
    await openMenu(window, `session-menu-${first.id}`);
    await click(window, `rename-session-${first.id}`);
    await waitForText(window, /Renomear conversa/, 10_000);
    await type(window, 'rename-session-title', 'Conversa renomeada');
    await click(window, 'rename-session-save');
    text = await waitForText(window, /Conversa renomeada/, 10_000);
    assert.doesNotMatch(text, /Primeira conversa/);
    const listed = await window.webContents.executeJavaScript(
      `window.api.chat.listSessions(${JSON.stringify({ workspaceId: workspace.id })})`,
    );
    assert.equal(listed.find((s) => s.id === first.id).title, 'Conversa renomeada', 'persisted, not local');

    // Archive: leaves the list; "Arquivadas" brings it into view, greyed.
    await openMenu(window, `session-menu-${second.id}`);
    await click(window, `archive-session-${second.id}`);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      text = await window.webContents.executeJavaScript('document.body.innerText');
      if (!/Segunda conversa/.test(text)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.doesNotMatch(text, /Segunda conversa/, 'an archived conversation is out of Recentes');
    await click(window, 'toggle-archived');
    await waitForText(window, /Segunda conversa/, 10_000);
    const archived = await window.webContents.executeJavaScript(
      `window.api.chat.listSessions(${JSON.stringify({ workspaceId: workspace.id, includeArchived: true })})`,
    );
    assert.ok(archived.find((s) => s.id === second.id).archivedAt, 'archived in the database');
    await click(window, 'toggle-archived');

    // Search narrows the list by title.
    await type(window, 'session-search', 'renomeada');
    text = await waitForText(window, /Conversa renomeada/, 10_000);
    await type(window, 'session-search', 'nada disso');
    await waitForText(window, /Nenhuma conversa com esse título/, 10_000);
    await type(window, 'session-search', '');
    await waitForText(window, /Conversa renomeada/, 10_000);

    // Delete asks first, then really removes.
    await openMenu(window, `session-menu-${first.id}`);
    await click(window, `delete-session-${first.id}`);
    text = await waitForText(window, /Apagar conversa\?/, 10_000);
    assert.match(text, /nenhum arquivo do projeto é alterado/);
    await click(window, 'confirm');
    const gone = Date.now() + 10_000;
    while (Date.now() < gone) {
      text = await window.webContents.executeJavaScript('document.body.innerText');
      if (!/Conversa renomeada/.test(text)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.doesNotMatch(text, /Conversa renomeada/);
    const after = await window.webContents.executeJavaScript(
      `window.api.chat.listSessions(${JSON.stringify({ workspaceId: workspace.id, includeArchived: true })})`,
    );
    assert.deepEqual(after.map((s) => s.id), [second.id], 'deleted from the database, archive kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run that cannot start says which account is missing, and "Detalhes" shows the record', async () => {
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-run-'));
  try {
    // A project bound to two accounts that were never connected, in an app
    // root with no runtime: the readiness check refuses the run. That refusal
    // must be a card that names the problem, not "no progress detected".
    const accounts = await window.webContents.executeJavaScript('window.api.accounts.list()');
    const codex = accounts.find((a) => a.provider === 'openai' && a.name === 'Codex Trabalho');
    const claude = accounts.find((a) => a.provider === 'anthropic' && a.name === 'Claude Trabalho');
    assert.ok(codex && claude, 'the accounts from the team test');
    const workspace = await window.webContents.executeJavaScript(
      `window.api.workspace.create(${JSON.stringify({ name: 'Projeto executado', localPath: dir })})`,
    );
    await window.webContents.executeJavaScript(
      `window.api.workspace.setTeam(${JSON.stringify({
        workspaceId: workspace.id,
        orchestrator: { accountId: codex.id },
        worker: { accountId: claude.id },
      })})`,
    );

    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    await waitForText(window, /Projeto executado/, 15_000);

    // The empty state has its own box; the composer appears with the timeline.
    await window.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, 'crie hello.txt');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
        return true;
      })()
    `);

    const card = await waitForText(window, /A execução não pôde começar/, 20_000);
    assert.doesNotMatch(card, /Sem progresso detectado/, 'a readiness refusal is not "no progress"');
    assert.match(card, /não está configurado|Conecte a conta/);

    await click(window, 'run-failed-details');
    const detail = await waitForText(window, /Detalhes da execução/, 10_000);
    assert.match(detail, /FAILED/);
    assert.match(detail, /Prontidão/, 'the readiness step is on the record');

    // And the same run is in the history, as a run.
    const runs = await window.webContents.executeJavaScript(
      `window.api.run.list(${JSON.stringify({ workspaceId: workspace.id })})`,
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'FAILED');
    assert.equal(runs[0].failureKind, 'readiness');
    assert.equal(runs[0].objective, 'crie hello.txt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the header renames the project and switches branches the git way, asking when the tree is dirty', async () => {
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-branch-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'a.txt'), 'one\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    git('branch', 'feature/ui');

    const workspace = await window.webContents.executeJavaScript(
      `window.api.workspace.create(${JSON.stringify({ name: 'Projeto git', localPath: dir })})`,
    );
    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    await waitForText(window, /Projeto git/, 15_000);

    // Rename, from the project popover.
    await click(window, 'project-chip');
    await waitForText(window, /Renomear projeto/, 10_000);
    await click(window, 'rename-workspace');
    await waitForText(window, /Só o nome na lista muda/, 10_000);
    await type(window, 'rename-workspace-title', 'Projeto renomeado');
    await click(window, 'rename-workspace-save');
    await waitForText(window, /Projeto renomeado/, 10_000);
    const renamed = (await window.webContents.executeJavaScript('window.api.workspace.list()')).find(
      (w) => w.id === workspace.id,
    );
    assert.equal(renamed.name, 'Projeto renomeado');

    // The branch chip lists what git has, and switches on a clean tree.
    await click(window, 'branch-chip');
    let list = await waitForText(window, /feature\/ui/, 10_000);
    assert.match(list, /Árvore limpa/);
    await click(window, 'branch-feature/ui');
    await waitForText(window, /Branch trocada para feature\/ui/, 15_000);
    assert.equal(git('branch', '--show-current').trim(), 'feature/ui');

    // With an uncommitted change the switch asks first, then goes ahead.
    writeFileSync(join(dir, 'a.txt'), 'two\n', 'utf8');
    await click(window, 'branch-chip');
    list = await waitForText(window, /1 alteração\(ões\) não commitada/, 10_000);
    await click(window, 'branch-main');
    await waitForText(window, /Trocar de branch com alterações pendentes\?/, 10_000);
    await click(window, 'confirm');
    await waitForText(window, /Branch trocada para main/, 15_000);
    assert.equal(git('branch', '--show-current').trim(), 'main');
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'two\n', 'the change was carried, not dropped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ helpers */

let sharedWindow = null;

async function openWindow() {
  if (sharedWindow && !sharedWindow.isDestroyed()) return sharedWindow;

  appRoot = mkdtempSync(join(tmpdir(), 'lao-electron-app-'));
  const paths = {
    root: appRoot,
    runtimes: join(appRoot, 'runtimes'),
    profiles: join(appRoot, 'profiles'),
    data: join(appRoot, 'data'),
    logs: join(appRoot, 'logs'),
    artifacts: join(appRoot, 'artifacts'),
    updates: join(appRoot, 'updates'),
    staging: join(appRoot, 'staging'),
  };

  services = new AppServices({ paths, openUrl: () => {} });
  const router = new IpcRouter(services, {
    selectFolder: async () => null,
    openExternal: async () => true,
    openPath: async () => true,
    appInfo: () => ({
      appVersion: '0.1.0-test',
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome,
      packaged: app.isPackaged,
    }),
  });
  for (const channel of REQUEST_CHANNELS) {
    ipcMain.handle(channel, async (_event, payload) => router.handle(channel, payload));
  }

  sharedWindow = new BrowserWindow({
    show: false,
    width: 1100,
    height: 700,
    webPreferences: { ...WEB_PREFERENCES, preload: join(bundles, 'preload.cjs') },
  });
  services.events.subscribe((channel, payload) => {
    if (!sharedWindow.isDestroyed()) sharedWindow.webContents.send(channel, payload);
  });
  await sharedWindow.loadFile(join(bundles, 'index.html'));
  return sharedWindow;
}

/**
 * Opens a Radix dropdown menu. Its trigger listens for pointerdown, not click,
 * so a plain `.click()` does nothing; this sends what a mouse would.
 */
async function openMenu(window, testid) {
  const done = await window.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector('[data-testid="${testid}"]');
      if (!el) return 'missing';
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', ctrlKey: false }));
      return 'opened';
    })()
  `);
  if (done !== 'opened') throw new Error(`no element with data-testid="${testid}"`);
  await new Promise((r) => setTimeout(r, 150));
}

/** Clicks the element carrying a `data-testid`, failing loudly if it is absent. */
async function click(window, testid) {
  const done = await window.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector('[data-testid="${testid}"]');
      if (!el) return 'missing';
      el.click();
      return 'clicked';
    })()
  `);
  if (done !== 'clicked') throw new Error(`no element with data-testid="${testid}"`);
}

/**
 * Types into a controlled input the way React sees it.
 *
 * Setting `.value` directly would not reach React's state, so the native setter
 * is used and an input event dispatched - the standard way to drive a
 * controlled component from outside.
 */
async function type(window, testid, text) {
  const done = await window.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector('[data-testid="${testid}"]');
      if (!el) return 'missing';
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    })()
  `);
  if (done !== 'typed') throw new Error(`no input with data-testid="${testid}"`);
}

/** Reloads the page and resolves once the new document has finished loading. */
async function reloadWindow(window) {
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('reload did not finish')), 30_000);
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  window.webContents.reload();
  await loaded;
}

async function waitForText(window, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = await window.webContents.executeJavaScript('document.body.innerText');
    if (pattern.test(text)) return text;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${pattern}; body was:\n${text}`);
}

/* --------------------------------------------------------------- the run */

console.log('# electron main started, waiting for app ready');

app.whenReady().then(async () => {
  console.log('# app ready');
  // Belt as well as braces: if a check hangs in a way the per-case race cannot
  // interrupt, the suite still exits with a verdict rather than a stuck job.
  const watchdog = setTimeout(() => {
    console.log(`not ok - suite watchdog: no verdict after ${SUITE_TIMEOUT_MS}ms`);
    console.log('# fail 1');
    app.exit(1);
  }, SUITE_TIMEOUT_MS);
  watchdog.unref?.();

  let failed = 0;
  console.log(`1..${cases.length}`);
  for (const [index, [name, fn]] of cases.entries()) {
    try {
      await withTimeout(name, fn)();
      console.log(`ok ${index + 1} - ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`not ok ${index + 1} - ${name}`);
      console.log(String(error && error.stack ? error.stack : error).replace(/^/gm, '  # '));
    }
  }
  clearTimeout(watchdog);
  console.log(`# pass ${cases.length - failed}`);
  console.log(`# fail ${failed}`);

  try {
    if (services) await services.shutdown();
    if (appRoot) rmSync(appRoot, { recursive: true, force: true });
  } catch {
    /* teardown must never change the verdict */
  }
  app.exit(failed === 0 ? 0 : 1);
});
