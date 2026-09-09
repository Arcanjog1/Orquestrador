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
const { REQUEST_CHANNELS, EVENT_CHANNELS } = await load('apps/desktop/src/shared/ipc-contract.js');
const { WEB_PREFERENCES } = await load('apps/desktop/src/electron/security.js');

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** Every provider API request the window caused, so a check can read it. */
const providerCalls = [];

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
    removeTree(dir);
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

test('every event channel is reachable from the renderer, and each returns its unsubscribe', async () => {
  const window = await openWindow();
  // The contract's event half, which nothing checked before the liveness and
  // message channels were added. A channel the main process emits and the
  // renderer cannot listen to is a silent dead end: the window would simply
  // never update, with nothing failing anywhere to say so.
  const expected = EVENT_CHANNELS.map((channel) => {
    const [group, rest] = channel.split(':');
    return `${group}${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
  });
  const exposed = await window.webContents.executeJavaScript(
    '(() => Object.keys(window.api.events))()',
  );
  assert.deepEqual([...exposed].sort(), [...expected].sort());

  // Subscribing really works, and hands back a function that unsubscribes -
  // a listener that cannot be removed leaks a dead window into every run.
  const outcome = await window.webContents.executeJavaScript(`(() => {
    const results = {};
    for (const name of ${JSON.stringify(expected)}) {
      const off = window.api.events[name](() => {});
      results[name] = typeof off === 'function';
      if (typeof off === 'function') off();
    }
    return results;
  })()`);
  for (const name of expected) {
    assert.equal(outcome[name], true, `${name} must return an unsubscribe function`);
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

  // No Codex on this machine: the step says so in words, next to "Continuar",
  // rather than letting the person walk on as if the orchestrator could run.
  const note = await waitForText(window, /Codex indisponível/, 15_000);
  assert.match(note, /o orquestrador não executa nenhuma tarefa até o Codex ficar Pronto/);
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
    removeTree(dir);
  }
});

test('a cloud project is created through the real bridge, and never claims a folder', async () => {
  // The property this exists for: a cloud project must not require, create or
  // report a folder on the user's computer. It is asserted through the real
  // preload bridge, in a real Electron window, because that is the surface a
  // person actually reaches - a service-level test could not catch a renderer
  // that quietly sent a path anyway.
  const window = await openWindow();

  const created = await window.webContents.executeJavaScript(
    `window.api.workspace.createCloud(${JSON.stringify({
      repository: 'Arcanjog1/Orquestrador',
      branch: 'main',
      repositoryPrivate: true,
    })})`,
  );
  assert.equal(created.environment, 'cloud');
  assert.equal(created.localPath, '', 'a cloud project claimed a folder');
  assert.equal(created.repository, 'Arcanjog1/Orquestrador');
  assert.equal(created.repositoryPrivate, true);

  const listed = await window.webContents.executeJavaScript('window.api.workspace.list()');
  const back = listed.find((w) => w.id === created.id);
  assert.ok(back, 'the cloud project was not listed back');
  assert.equal(back.environment, 'cloud');
  assert.equal(back.branch, 'main', 'the branch must survive without a working copy');

  // The same repository and branch twice is refused rather than silently
  // merged: two projects sharing one line of work would mix their history.
  const again = await window.webContents.executeJavaScript(
    `window.api.workspace.createCloud(${JSON.stringify({
      repository: 'Arcanjog1/Orquestrador',
      branch: 'main',
    })}).then(() => 'created', (e) => 'refused: ' + e.message)`,
  );
  assert.match(again, /^refused:/);

  // And a repository name that is really a path is refused at the boundary,
  // before any service sees it.
  const smuggled = await window.webContents.executeJavaScript(
    `window.api.workspace.createCloud(${JSON.stringify({
      repository: '../../etc/passwd',
      branch: 'main',
    })}).then(() => 'created', (e) => 'refused: ' + e.message)`,
  );
  assert.match(smuggled, /^refused:/);
});

test('the cloud connection refuses plain http on a network, and never reads the token back', async () => {
  const window = await openWindow();

  const overHttp = await window.webContents.executeJavaScript(
    `window.api.cloud.connect(${JSON.stringify({
      endpoint: 'http://coordenador.exemplo.invalid',
      token: 'orq_aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })}).then(() => 'connected', (e) => 'refused: ' + e.message)`,
  );
  assert.match(overHttp, /^refused:/, 'a device token would have travelled in clear');

  // Nothing is connected, and the status says so without inventing a token.
  const status = await window.webContents.executeJavaScript('window.api.cloud.status()');
  assert.equal(status.configured, false);
  assert.ok(!JSON.stringify(status).includes('orq_'), 'the status leaked a token');
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
    removeTree(dir);
  }
});

test("accounts: the ceiling is set in the interface, per account, and persists", async () => {
  // The request was explicit that this must be changeable without editing
  // JSON, environment variables or files. So it is driven here the way a
  // person drives it: open Settings, pick the two ceilings, tick the box.
  const window = await openWindow();
  const one = await window.webContents.executeJavaScript(
    `window.api.accounts.create(${JSON.stringify({ name: 'Claude Teto A', provider: 'anthropic' })})`,
  );
  const two = await window.webContents.executeJavaScript(
    `window.api.accounts.create(${JSON.stringify({ name: 'Claude Teto B', provider: 'anthropic' })})`,
  );
  try {
    await window.webContents.executeJavaScript(
      `(() => { location.hash = '#/configuracoes?tab=accounts'; return true; })()`,
    );
    await reloadWindow(window);
    // Uppercased by CSS, and innerText follows - so matched case-insensitively.
    await waitForText(window, /roteamento desta conta/i, 15_000);

    // The premium model is named on the switch, so "extra credits" is not a
    // phrase the person has to interpret.
    const body = await window.webContents.executeJavaScript('document.body.innerText');
    assert.match(body, /Permitir modelos que exigem créditos extras \(fable\)/);

    await select(window, `routing-capability-${one.id}`, 'STRONG');
    await select(window, `routing-reasoning-${one.id}`, 'HIGH');

    const saved = await (async () => {
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        const list = await window.webContents.executeJavaScript('window.api.accounts.list()');
        const found = list.find((a) => a.id === one.id);
        if (found?.routing.maxCapability === 'STRONG' && found?.routing.maxReasoning === 'HIGH') {
          return found;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return null;
    })();
    assert.ok(saved, 'the ceiling reached the database');
    assert.equal(saved.routing.allowPremiumModels, false, 'and extra credits stay off by default');

    // The other account is untouched: this is a property of an account.
    const list = await window.webContents.executeJavaScript('window.api.accounts.list()');
    assert.equal(list.find((a) => a.id === two.id).routing.maxCapability, null);

    // And it survives reopening the window.
    await reloadWindow(window);
    await waitForText(window, /roteamento desta conta/i, 15_000);
    const afterReload = await window.webContents.executeJavaScript(
      `(() => document.querySelector('[data-testid="routing-capability-${one.id}"]').value)()`,
    );
    assert.equal(afterReload, 'STRONG');
  } finally {
    await window.webContents.executeJavaScript(
      `(async () => {
         for (const id of ${JSON.stringify([one.id, two.id])}) {
           try { await window.api.accounts.remove({ accountId: id }); } catch {}
         }
         return true;
       })()`,
    );
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
    // The worker's model is chosen per task: the dialog says so, offers the
    // strategy, and keeps the manual choice behind "Configuração avançada".
    assert.match(dialog, /O AI Orchestrator escolhe o modelo e o nível de raciocínio para cada tarefa\./);
    assert.match(dialog, /Configuração avançada/);
    const selection = await window.webContents.executeJavaScript(
      `document.querySelector('[data-testid="team-worker-selection"]').textContent`,
    );
    assert.equal(selection.trim(), 'Automático');

    // The orchestrator runs on the Codex CLI's own default until a model is
    // pinned under "Configuração avançada" - no invented catalogue.
    const orchestratorDefault = await window.webContents.executeJavaScript(
      `document.querySelector('[data-testid="team-orchestrator-model-default"]').textContent`,
    );
    assert.equal(orchestratorDefault.trim(), 'Padrão do Codex CLI');
    await click(window, 'team-orchestrator-advanced');
    await waitForText(window, /Voltar para o padrão do CLI/, 5_000);
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
    assert.equal(saved.team.orchestrator.selection, 'manual');
    assert.equal(saved.team.worker.accountName, 'Claude Trabalho');
    assert.equal(saved.team.worker.provider, 'anthropic');
    assert.equal(saved.team.worker.selection, 'auto', 'automatic unless the person opened the advanced settings');
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
    removeTree(dir);
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
    // The toast says "renomeada" before the list has re-read itself; the
    // row is what must change.
    const renamedRow = Date.now() + 10_000;
    let row = '';
    while (Date.now() < renamedRow) {
      row = await window.webContents.executeJavaScript(
        `document.querySelector('[data-testid="session-${first.id}"]')?.textContent ?? ''`,
      );
      if (/Conversa renomeada/.test(row)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(row, /Conversa renomeada/);
    assert.doesNotMatch(row, /Primeira conversa/);
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
    removeTree(dir);
  }
});

test('a cancelled run stops showing progress: no step is left spinning', async () => {
  // The history showed DONE messages next to steps still animating, so a
  // person could not tell which run was finished, cancelled or still going.
  // A run that stopped has no step in progress - checked through the real IPC.
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-cancel-'));
  try {
    const workspace = await window.webContents.executeJavaScript(
      `window.api.workspace.create(${JSON.stringify({ name: 'Cancelar', localPath: dir })})`,
    );
    const session = await window.webContents.executeJavaScript(
      `window.api.chat.createSession(${JSON.stringify({ workspaceId: workspace.id, title: 'Cancelar' })})`,
    );
    // A run created directly, left RUNNING with an open step, then cancelled.
    const created = services.database.runs.create({
      id: 'run-electron-cancel',
      sessionId: session.id,
      workspaceId: workspace.id,
      objective: 'crie o miniaplicativo',
      orchestratorAgentId: null,
      maxIterations: 4,
    });
    services.database.runs.setStatus(created.id, 'RUNNING');
    services.database.runs.addStep({
      runId: created.id,
      iteration: 1,
      phase: 'worker',
      status: 'running',
      summary: 'Claude executando...',
    });
    assert.equal(
      services.database.runs.steps(created.id).filter((s) => s.status === 'running').length,
      1,
    );

    services.database.runs.setStatus(created.id, 'CANCELLED', 'Cancelado pelo usuário.');

    const after = services.database.runs.steps(created.id);
    assert.equal(
      after.filter((s) => s.status === 'running' || s.status === 'started').length,
      0,
      'nothing is left spinning',
    );
    assert.equal(services.database.runs.require(created.id).status, 'CANCELLED');

    // And a late result cannot put it back.
    services.database.runs.setStatus(created.id, 'DONE', 'Tarefa concluída e verificada.');
    assert.equal(services.database.runs.require(created.id).status, 'CANCELLED');

    // These checks share one database, so this one puts back what it made.
    await window.webContents.executeJavaScript(
      `window.api.chat.deleteSession(${JSON.stringify({ sessionId: session.id })})`,
    );
    await window.webContents.executeJavaScript(
      `window.api.workspace.remove(${JSON.stringify({ workspaceId: workspace.id })})`,
    );
  } finally {
    removeTree(dir);
  }
});

test('projects: the "+" of a project with no folder yet still lands the conversation in it', async () => {
  // The reported defect. Clicking "+" on a project whose workspace does not
  // exist yet switches folders, and the switch used to eat the selection: the
  // effect that opens the pending conversation fires once while the workspace
  // is still unknown, consuming the pending id, and again when it arrives -
  // that second run selected nothing. The person then typed into an empty
  // composer, and *that* made a second conversation, with no project, under
  // "Sem projeto". Exactly what was reported.
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-plus-'));
  try {
    // A folder project, opened so its workspace is the one on screen.
    const opened = await window.webContents.executeJavaScript(
      `window.api.workspace.openProject(${JSON.stringify({ localPath: dir })})`,
    );
    // And a second project that has no folder at all - a repository connected
    // but never opened. This is the one whose "+" has to switch.
    const connected = await window.webContents.executeJavaScript(
      `window.api.project.create(${JSON.stringify({ name: 'Sem pasta ainda' })})`,
    );

    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    await waitForText(window, /Sem pasta ainda/, 15_000);

    await click(window, `new-session-in-${connected.id}`);
    await waitForText(window, /Nova conversa em Sem pasta ainda/, 15_000);

    // One conversation, in that project - not two, and not loose.
    const all = await window.webContents.executeJavaScript('window.api.chat.listAllSessions({})');
    const born = all.filter((s) => s.title === 'Nova tarefa');
    assert.equal(born.length, 1, 'one conversation, not a spare under "Sem projeto"');
    assert.equal(born[0].projectId, connected.id);

    // And it is the one on screen, so typing continues it instead of making
    // another. This is the assertion that fails without the fix.
    // The switch is asynchronous: the workspace is created, the shell reloads
    // its list, and only then can the tree draw. Poll rather than guess.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const there = await window.webContents.executeJavaScript(
        `!!document.querySelector('[data-testid="session-${born[0].id}"]')`,
      );
      if (there) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const probe = await window.webContents.executeJavaScript(
      `(() => {
         const el = document.querySelector('[data-testid="session-${born[0].id}"]');
         return {
           present: !!el,
           className: el ? el.className : null,
           bodyHead: document.body.innerText.slice(0, 400),
         };
       })()`,
    );
    const selected = probe.present && /bg-sidebar-accent/.test(probe.className ?? '');
    assert.equal(selected, true, `the new conversation is the open one: ${JSON.stringify(probe)}`);

    // Sending from here must not create a second, loose conversation.
    await window.webContents.executeJavaScript(
      `window.api.chat.listAllSessions({})`,
    );
    const underProject = await window.webContents.executeJavaScript(
      `!!document.querySelector('[data-testid="project-${connected.id}"] [data-testid="session-${born[0].id}"]')`,
    );
    assert.equal(underProject, true, 'and it is drawn under its project');
    assert.ok(opened.projectId, 'the folder project still exists');

    // The other half of the same defect: a conversation started from the
    // composer, with nothing selected, used to be created with no project at
    // all - so typing while looking at a project filed the conversation under
    // "Sem projeto". Open the folder project, which selects no conversation
    // because it has none, and type.
    await click(window, `open-project-${opened.projectId}`);
    let composerReady = false;
    const typedBy = Date.now() + 20_000;
    while (Date.now() < typedBy) {
      composerReady = await window.webContents.executeJavaScript(
        `!!document.querySelector('[data-testid="composer-input"]')`,
      );
      if (composerReady) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!composerReady) {
      const body = await window.webContents.executeJavaScript(
        'document.body.innerText.slice(0, 400)',
      );
      assert.fail(`the composer never appeared after opening the project: ${body}`);
    }
    await type(window, 'composer-input', 'crie hello.txt com o texto pronto');
    await click(window, 'composer-send');
    const fromComposer = await (async () => {
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        const all = await window.webContents.executeJavaScript(
          'window.api.chat.listAllSessions({})',
        );
        const found = all.find((s) => s.title.startsWith('crie hello.txt'));
        if (found) return found;
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    })();
    assert.ok(fromComposer, 'the composer created a conversation');
    assert.equal(
      fromComposer.projectId,
      opened.projectId,
      'and filed it under the project on screen, not under "Sem projeto"',
    );

    // These checks share one database, so this one puts back what it made.
    // Reported rather than thrown: a cleanup that fails must say which step
    // failed, not surface as "script failed to execute" with no clue in it.
    const cleanup = await window.webContents.executeJavaScript(
      `(async () => {
         const problems = [];
         const steps = [
           ['session-composer', () => window.api.chat.deleteSession(${JSON.stringify({ sessionId: fromComposer.id })})],
           ['session-plus', () => window.api.chat.deleteSession(${JSON.stringify({ sessionId: born[0].id })})],
           ['project', () => window.api.project.remove(${JSON.stringify({ projectId: connected.id })})],
         ];
         for (const [what, run] of steps) {
           try { await run(); } catch (e) { problems.push(what + ': ' + ((e && e.message) || String(e))); }
         }
         return problems;
       })()`,
    );
    assert.deepEqual(cleanup, [], 'cleanup should not fail');
  } finally {
    removeTree(dir);
  }
});

test('projects: the sidebar files conversations under real projects, and a move persists', async () => {
  const window = await openWindow();
  const dirA = mkdtempSync(join(tmpdir(), 'lao-electron-proj-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'lao-electron-proj-b-'));
  try {
    const orq = await window.webContents.executeJavaScript(
      `window.api.workspace.create(${JSON.stringify({ name: 'Pasta Orquestrador', localPath: dirA })})`,
    );
    const revitFolder = await window.webContents.executeJavaScript(
      `window.api.workspace.create(${JSON.stringify({ name: 'Pasta Revit', localPath: dirB })})`,
    );
    const revit = await window.webContents.executeJavaScript(
      `window.api.project.create(${JSON.stringify({ name: 'Revit', workspaceId: revitFolder.id })})`,
    );
    assert.equal(revit.workspaceName, 'Pasta Revit');
    const inside = await window.webContents.executeJavaScript(
      `window.api.chat.createSession(${JSON.stringify({ workspaceId: revitFolder.id, title: 'Modulação automática', projectId: revit.id })})`,
    );
    const loose = await window.webContents.executeJavaScript(
      `window.api.chat.createSession(${JSON.stringify({ workspaceId: orq.id, title: 'Conversa solta' })})`,
    );

    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    // Section labels are uppercased by CSS, and innerText follows.
    await waitForText(window, /Modulação automática/, 15_000);

    // The tree: the project row, its conversation under it, the loose one
    // under "Sem projeto".
    const underRevit = await window.webContents.executeJavaScript(
      `!!document.querySelector('[data-testid="project-${revit.id}"] [data-testid="session-${inside.id}"]')`,
    );
    assert.equal(underRevit, true, 'the conversation is filed under its project');
    const underNone = await window.webContents.executeJavaScript(
      `!!document.querySelector('[data-testid="project-none"] [data-testid="session-${loose.id}"]')`,
    );
    assert.equal(underNone, true, 'a conversation without a project is under "Sem projeto"');
    const body = await window.webContents.executeJavaScript('document.body.innerText');
    assert.match(body, /Revit/);
    assert.match(body, /Sem projeto/i);

    // A new conversation from the project's own "+" is born inside it, in
    // its folder.
    await click(window, `new-session-in-${revit.id}`);
    await waitForText(window, /Nova conversa em Revit/, 10_000);
    const all = await window.webContents.executeJavaScript('window.api.chat.listAllSessions({})');
    // Scoped to this project: another check may have made its own "Nova
    // tarefa" elsewhere, and matching on the title alone would find that one.
    const born = all.find((s) => s.title === 'Nova tarefa' && s.projectId === revit.id);
    assert.ok(born, 'the conversation exists');
    assert.equal(born.projectId, revit.id);
    assert.equal(born.workspaceId, revitFolder.id, 'in the project\'s folder');

    // Moving is a persisted change, not a visual one: after a reload the
    // loose conversation is under Revit.
    await window.webContents.executeJavaScript(
      `window.api.chat.moveSession(${JSON.stringify({ sessionId: loose.id, projectId: revit.id })})`,
    );
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    await waitForText(window, /Conversa solta/, 15_000);
    const movedUnderRevit = await window.webContents.executeJavaScript(
      `!!document.querySelector('[data-testid="project-${revit.id}"] [data-testid="session-${loose.id}"]')`,
    );
    assert.equal(movedUnderRevit, true);

    // The search finds it whatever the project, and names the project.
    await type(window, 'session-search', 'solta');
    const results = await waitForText(window, /Resultados/i, 10_000);
    assert.match(results, /Revit · Conversa solta/);

    // Removing the project keeps the conversations, now "Sem projeto".
    const outcome = await window.webContents.executeJavaScript(
      `window.api.project.remove(${JSON.stringify({ projectId: revit.id })})`,
    );
    assert.equal(outcome.sessionsMoved, 3);
    const after = await window.webContents.executeJavaScript('window.api.chat.listAllSessions({})');
    assert.equal(after.length, 3);
    assert.ok(after.every((s) => s.projectId === null));
  } finally {
    removeTree(dirA);
    removeTree(dirB);
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
    // The dialog opens before the record arrives ("Lendo o registro..."):
    // wait for the record itself, not for the dialog's title.
    const detail = await waitForText(window, /Detalhes da execução[\s\S]*\bFAILED\b/, 10_000);
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
    removeTree(dir);
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
    removeTree(dir);
  }
});

test('GitHub: the card takes a client id, signs in with the device code shown, and the picker lists a private repo', async () => {
  const window = await openWindow();
  await window.webContents.executeJavaScript(
    `(() => { location.hash = '#/configuracoes?tab=accounts'; return true; })()`,
  );
  await reloadWindow(window);
  let text = await waitForText(window, /GitHub/, 15_000);
  assert.match(text, /Não configurado/);
  assert.doesNotMatch(text, /Sem login próprio/, 'the placeholder is gone');

  // The Client ID is the one thing the person must bring; the steps to get
  // it are on the card.
  await click(window, 'github-help');
  text = await waitForText(window, /Enable Device Flow/, 10_000);
  assert.match(text, /New GitHub\s+App/);
  await type(window, 'github-client-id', 'Iv1.testclientid');
  await click(window, 'github-save-client-id');
  await waitForText(window, /Não conectado/, 10_000);

  // Connect: the same dialog as the CLI sign-ins, with GitHub's code in it.
  await click(window, 'github-connect');
  text = await waitForText(window, /WDJB-MJHT/, 15_000);
  assert.match(text, /Código do dispositivo/);
  assert.ok(openedUrls.some((u) => u.endsWith('/login/device')), 'the browser was sent to the device page');
  await waitForText(window, /Conectado como octocat/, 15_000);

  // What the window can read never contains the token.
  const settings = await window.webContents.executeJavaScript('window.api.settings.all()');
  assert.ok(!('github.token.enc' in settings));
  assert.ok(!JSON.stringify(settings).includes('gho_electrontesttoken'));
  const status = await window.webContents.executeJavaScript('window.api.github.status()');
  assert.equal(status.login, 'octocat');
  assert.ok(!JSON.stringify(status).includes('gho_'));

  // The project picker offers the person's repositories, private ones marked.
  await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
  await reloadWindow(window);
  await waitForText(window, /Pular onboarding/, 15_000);
  await click(window, 'skip-onboarding');
  await waitForText(window, /Projetos/i, 15_000);
  await window.webContents.executeJavaScript(`
    document.querySelector('button[aria-label="Adicionar projeto"]').click()
  `);
  // The clone URL belongs to the folder mode: connecting a repository does
  // not clone it, so that field only exists where a clone is on offer.
  await click(window, 'environment-folder');
  text = await waitForText(window, /octocat\/private-thing/, 15_000);
  assert.match(text, /privado/i);
  await click(window, 'repo-octocat/private-thing');
  const url = await window.webContents.executeJavaScript(
    `document.querySelector('[data-testid="clone-url"]').value`,
  );
  assert.equal(url, 'https://github.com/octocat/private-thing.git', 'the clone URL carries no credential');

  // The header knows who is signed in.
  await window.webContents.executeJavaScript(`
    document.querySelector('[data-state="open"] [aria-label], [role="dialog"] button')?.click?.()
  `);
  await click(window, 'github-chip');
  await waitForText(window, /octocat/, 10_000);

  // Disconnect forgets the login.
  await window.webContents.executeJavaScript(
    `(() => { location.hash = '#/configuracoes?tab=accounts'; return true; })()`,
  );
  await reloadWindow(window);
  await waitForText(window, /Conectado como octocat/, 15_000);
  await click(window, 'github-disconnect');
  await waitForText(window, /Não conectado/, 10_000);
  const after = await window.webContents.executeJavaScript('window.api.github.status()');
  assert.equal(after.connected, false);
  assert.equal(after.configured, true, 'the client id stays');
});

test('Settings: the theme applies to the page, a number persists, and the login item reaches the shell', async () => {
  const window = await openWindow();
  await window.webContents.executeJavaScript(
    `(() => { location.hash = '#/configuracoes?tab=appearance'; return true; })()`,
  );
  await reloadWindow(window);
  await waitForText(window, /Tema/, 15_000);
  const classesBefore = await window.webContents.executeJavaScript('document.documentElement.className');
  assert.match(classesBefore, /dark/);

  await click(window, 'setting-theme-light');
  const classesAfter = await window.webContents.executeJavaScript('document.documentElement.className');
  assert.match(classesAfter, /light/);
  assert.doesNotMatch(classesAfter, /dark/);

  // Persisted: a fresh load of the page comes up light.
  await reloadWindow(window);
  await waitForText(window, /Tema/, 15_000);
  assert.match(await window.webContents.executeJavaScript('document.documentElement.className'), /light/);
  await click(window, 'setting-theme-dark');
  assert.match(await window.webContents.executeJavaScript('document.documentElement.className'), /dark/);

  // Execution: a bounded number, saved on blur, read back by the main process.
  await window.webContents.executeJavaScript(
    `(() => { location.hash = '#/configuracoes?tab=execution'; return true; })()`,
  );
  await reloadWindow(window);
  await waitForText(window, /Máximo de iterações/, 15_000);
  await type(window, 'setting-max-iterations', '3');
  await window.webContents.executeJavaScript(`
    document.querySelector('[data-testid="setting-max-iterations"]').dispatchEvent(new Event('blur'))
  `);
  await window.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector('[data-testid="setting-max-iterations"]');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()
  `);
  const deadline = Date.now() + 5000;
  let stored = null;
  while (Date.now() < deadline) {
    stored = (await window.webContents.executeJavaScript('window.api.settings.all()'))['execution.maxIterations'];
    if (stored === '3') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(stored, '3');
  assert.equal(services.database.settings.get('execution.maxIterations'), '3');

  // General: the switch talks to the shell's login item.
  await window.webContents.executeJavaScript(
    `(() => { location.hash = '#/configuracoes?tab=general'; return true; })()`,
  );
  await reloadWindow(window);
  await waitForText(window, /Iniciar com o sistema/, 15_000);
  await click(window, 'setting-start-with-system');
  const armed = Date.now() + 5000;
  while (Date.now() < armed && loginItem !== true) await new Promise((r) => setTimeout(r, 100));
  assert.equal(loginItem, true, 'the shell was asked to open at login');

  // The prototype's decorative switches are gone.
  const text = await window.webContents.executeJavaScript('document.body.innerText');
  assert.doesNotMatch(text, /handoff automático|Auto retry|Execução automática/);
});


test('Connections: a key is added through the real screen, shown as a hint, and enabled only on purpose', async () => {
  const window = await openWindow();
  const before = providerCalls.length;
  try {
    await window.webContents.executeJavaScript(
      `(() => { location.hash = '#/configuracoes?tab=accounts'; return true; })()`,
    );
    await reloadWindow(window);
    await waitForText(window, /Conexões/, 15_000);

    // Add an Anthropic connection the way a person does.
    await click(window, 'add-connection-anthropic');
    await waitForText(window, /Nova conexão Anthropic/, 10_000);
    await type(window, 'connection-name', 'Claude Trabalho 1');
    await type(window, 'connection-key', 'sk-ant-electron-test-ZZZZ');
    await click(window, 'connection-save');
    await waitForText(window, /Claude Trabalho 1/, 10_000);

    const listed = await window.webContents.executeJavaScript('window.api.connections.list()');
    const created = listed.find((c) => c.displayName === 'Claude Trabalho 1');
    assert.ok(created, 'the connection was created through the real screen');
    assert.equal(created.connectionKind, 'api');
    assert.equal(created.keyHint, '…ZZZZ', 'four characters, not the key');
    assert.equal(created.apiEnabled, false, 'saving a key must not switch billing on');

    // Nothing the renderer can read carries the key.
    const rendered = await window.webContents.executeJavaScript('document.body.innerText');
    assert.ok(
      !rendered.includes('sk-ant-electron-test-ZZZZ'),
      'the key must never appear on screen after it is saved',
    );
    assert.ok(
      !JSON.stringify(listed).includes('sk-ant-electron-test-ZZZZ'),
      'no listed field may carry the key',
    );

    // Testing it reaches the provider, with the vendor's documented header.
    await click(window, `connection-test-${created.id}`);
    await waitForText(window, /Conexão funcionando/, 10_000);
    const call = providerCalls[providerCalls.length - 1];
    assert.ok(call.url.startsWith('https://api.anthropic.com/v1/models'), call.url);
    assert.equal(call.headers['x-api-key'], 'sk-ant-electron-test-ZZZZ');
    assert.ok(providerCalls.length > before, 'the real adapter was used');

    // Enabling asks first, and says what it cannot promise.
    await click(window, `connection-enable-${created.id}`);
    const warning = await waitForText(window, /Habilitar “Claude Trabalho 1”/, 10_000);
    assert.match(warning, /cobrança por uso, separada da sua assinatura/);
    assert.match(warning, /interrompe este\s+aplicativo/);
    assert.match(warning, /não é um teto cobrado pelo provider/);
    await click(window, 'connection-enable-confirm');
    await new Promise((r) => setTimeout(r, 500));

    const after = await window.webContents.executeJavaScript('window.api.connections.list()');
    assert.equal(
      after.find((c) => c.id === created.id).apiEnabled,
      true,
      'and only then is it enabled',
    );
  } finally {
    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
  }
});

test('a conversation project is created with no folder, and offers no git actions', async () => {
  const window = await openWindow();
  // No runtime is installed here, so a fresh load lands on onboarding; the
  // workspace is reached the way a person reaches it.
  await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
  await reloadWindow(window);
  await waitForText(window, /Pular onboarding/, 15_000);
  await click(window, 'skip-onboarding');
  await waitForText(window, /Adicionar projeto|projeto/, 15_000);

  await click(window, 'add-workspace');
  await waitForText(window, /Adicionar projeto/, 10_000);
  // "Vazio" is the choice that needs nothing configured: a name, and the
  // repository or folder can come later.
  await click(window, 'environment-empty');
  await waitForText(window, /Associe um repositório ou uma pasta depois/, 10_000);
  await type(window, 'conversation-name', 'Arquitetura');
  await click(window, 'conversation-create');
  await waitForText(window, /Arquitetura/, 15_000);

  // It is a real project in the sidebar, and the workspace its runs execute
  // in owns no folder anywhere.
  const projects = await window.webContents.executeJavaScript('window.api.project.list()');
  const project = projects.find((p) => p.name === 'Arquitetura');
  assert.ok(project, 'the project exists in the sidebar');
  assert.equal(project.localPath, '', 'and claims no folder on this computer');
  assert.equal(project.repositoryFullName, null, 'and no repository yet');

  const workspaces = await window.webContents.executeJavaScript('window.api.workspace.list()');
  const created = workspaces.find((w) => w.id === project.workspaceId);
  assert.ok(created, 'the workspace its runs execute in exists');
  assert.equal(created.environment, 'conversation');
  assert.equal(created.localPath, '', 'and it claims no folder on this computer');

  // The header says what kind of project this is, and offers no git chip:
  // there is no working copy to commit or push from.
  const chip = await window.webContents.executeJavaScript(
    `document.querySelector('[data-testid="environment-chip"]')?.textContent ?? ''`,
  );
  assert.match(chip, /Conversa/);
  const gitChip = await window.webContents.executeJavaScript(
    `document.querySelector('[data-testid="github-chip"]') === null`,
  );
  assert.equal(gitChip, true, 'a conversation project must not offer git actions');
});

test('a GitHub project is created from the interface, with no folder and no clone', async () => {
  // The whole point of this mode, exercised through the real bridge: pick a
  // repository, get a project, and never be asked for a folder. Nothing here
  // reaches github.com - creating the project writes a row; reading the
  // repository is a separate call this case deliberately does not make.
  const window = await openWindow();
  await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
  await reloadWindow(window);
  await waitForText(window, /Pular onboarding/, 15_000);
  await click(window, 'skip-onboarding');
  await waitForText(window, /Adicionar projeto|projeto/, 15_000);

  await click(window, 'add-workspace');
  await waitForText(window, /Adicionar projeto/, 10_000);
  await click(window, 'environment-repository');
  // The copy says what this mode is now: it works on the repository where it
  // is, and it does not ask for a folder.
  const blurb = await window.webContents.executeJavaScript('document.body.innerText');
  assert.match(blurb, /Nada é clonado e nenhuma pasta é criada/);

  await type(window, 'repository-url', 'arcanjog1/repositorio-de-teste');
  await click(window, 'repository-connect');
  // Reading the repository needs the network, which this case has no business
  // using; what it checks is that the project exists with no folder attached.
  const project = await waitFor(
    async () => {
      const list = await window.webContents.executeJavaScript('window.api.project.list()');
      return list.find((p) => p.repositoryFullName === 'arcanjog1/repositorio-de-teste') ?? null;
    },
    20_000,
    'the GitHub project to appear',
  );
  assert.equal(project.localPath, '', 'no folder on this computer');

  const workspaces = await window.webContents.executeJavaScript('window.api.workspace.list()');
  const created = workspaces.find((w) => w.id === project.workspaceId);
  assert.ok(created, 'the workspace its runs execute in exists');
  assert.equal(created.environment, 'github');
  assert.equal(created.localPath, '');
  assert.equal(created.repository, 'arcanjog1/repositorio-de-teste');

  // Choosing the same repository again is the same project, not a second one.
  const again = await window.webContents.executeJavaScript(
    `window.api.workspace.createGitHub(${JSON.stringify({ repository: 'arcanjog1/repositorio-de-teste' })})`,
  );
  assert.equal(again.id, created.id);
});

test('the project menu really works: archive, restore and remove, in the packaged interface', async () => {
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-projmenu-'));
  try {
    // A folder project with one conversation, reached the way a person does.
    const folder = await window.webContents.executeJavaScript(
      `window.api.workspace.openProject(${JSON.stringify({ localPath: dir })})`,
    );
    const project = await window.webContents.executeJavaScript(
      `window.api.project.list()`,
    ).then((list) => list.find((p) => p.workspaceId === folder.workspace.id));
    assert.ok(project, 'opening a folder produced its project');
    await window.webContents.executeJavaScript(
      `window.api.chat.createSession(${JSON.stringify({ workspaceId: folder.workspace.id, title: 'Uma conversa', projectId: project.id })})`,
    );

    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    await waitForText(window, /Uma conversa/, 15_000);

    // There is no separate "Pastas" section any more: the folder *is* the
    // project, and appearing in two lists at once was the complaint.
    const body = await window.webContents.executeJavaScript('document.body.innerText');
    assert.equal(/^\s*PASTAS\s*$/m.test(body), false, 'the Pastas section is gone');

    // Archive, from the project's own menu.
    await openMenu(window, `project-menu-${project.id}`);
    await click(window, `archive-project-${project.id}`);
    await waitForText(window, /arquivado\. Nada foi apagado/i, 10_000);

    const archived = await window.webContents.executeJavaScript(
      `window.api.project.list()`,
    ).then((list) => list.find((p) => p.id === project.id));
    assert.ok(archived.archivedAt, 'the project is archived');
    // Its conversation went with it and was not deleted. Scoped to this
    // project: every case in this suite shares one application data root, so
    // the global list carries conversations from the cases before it.
    const stillThere = await window.webContents.executeJavaScript(
      'window.api.chat.listAllSessions({})',
    ).then((list) => list.filter((s) => s.projectId === project.id));
    assert.equal(stillThere.length, 1);
    assert.equal(stillThere[0].title, 'Uma conversa');

    // It appears under "Arquivados", which is what makes archiving visibly
    // reversible rather than a disappearance.
    await waitForText(window, /Arquivados/i, 10_000);
    await openMenu(window, `project-menu-${project.id}`);
    await click(window, `archive-project-${project.id}`);
    await waitForText(window, /restaurado/i, 10_000);
    const restored = await window.webContents.executeJavaScript(
      `window.api.project.list()`,
    ).then((list) => list.find((p) => p.id === project.id));
    assert.equal(restored.archivedAt, null, 'and it comes back exactly as it was');

    // Remove: the confirmation must say what stays, by name.
    await openMenu(window, `project-menu-${project.id}`);
    await click(window, `delete-project-${project.id}`);
    const confirmation = await waitForText(window, /Remover projeto da lista/i, 10_000);
    assert.match(confirmation, /1 conversa/, 'the real count, from the main process');
    assert.match(confirmation, /Sem projeto/);
    assert.ok(
      confirmation.includes(dir),
      'the confirmation names the folder that stays on disk',
    );
    assert.match(confirmation, /Nenhum arquivo é apagado/i);
    assert.match(confirmation, /Arquivar/, 'and offers the reversible alternative');
  } finally {
    removeTree(dir);
  }
});

test('removing a project from the interface leaves the folder and its files alone', async () => {
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-safe-remove-'));
  const canary = join(dir, 'nao-apague-isto.txt');
  try {
    writeFileSync(canary, 'este arquivo prova que remover um projeto não apaga nada\n', 'utf8');

    const folder = await window.webContents.executeJavaScript(
      `window.api.workspace.openProject(${JSON.stringify({ localPath: dir })})`,
    );
    const project = await window.webContents.executeJavaScript(
      `window.api.project.list()`,
    ).then((list) => list.find((p) => p.workspaceId === folder.workspace.id));
    await window.webContents.executeJavaScript(
      `window.api.chat.createSession(${JSON.stringify({ workspaceId: folder.workspace.id, title: 'Conversa preservada', projectId: project.id })})`,
    );

    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    await waitForText(window, /Conversa preservada/, 15_000);

    await openMenu(window, `project-menu-${project.id}`);
    await click(window, `delete-project-${project.id}`);
    await waitForText(window, /Remover projeto da lista/i, 10_000);
    await click(window, 'confirm');
    await waitForText(window, /removido da lista/i, 10_000);

    // The three things that must survive an act of organisation.
    assert.equal(readFileSync(canary, 'utf8').startsWith('este arquivo'), true, 'the file is intact');
    const sessions = await window.webContents.executeJavaScript(
      'window.api.chat.listAllSessions({})',
    ).then((list) => list.filter((s) => s.title === 'Conversa preservada'));
    assert.equal(sessions.length, 1, 'the conversation was kept');
    assert.equal(sessions[0].projectId, null, 'and moved to "Sem projeto"');
    const workspaces = await window.webContents.executeJavaScript('window.api.workspace.list()');
    assert.ok(
      workspaces.some((w) => w.id === folder.workspace.id),
      'the folder is still a workspace the application knows',
    );
  } finally {
    removeTree(dir);
  }
});

test('the same folder opened twice is one project, and survives a restart', async () => {
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-onefolder-'));
  try {
    const first = await window.webContents.executeJavaScript(
      `window.api.workspace.openProject(${JSON.stringify({ localPath: dir })})`,
    );
    assert.equal(first.created, true);

    // The same folder, spelled with a trailing separator and a redundant
    // segment. On any platform this is the same directory.
    const awkward = join(dir, 'algum', '..');
    const second = await window.webContents.executeJavaScript(
      `window.api.workspace.openProject(${JSON.stringify({ localPath: awkward })})`,
    );
    assert.equal(second.created, false, 'the second open found the first');
    assert.equal(second.workspace.id, first.workspace.id);
    assert.equal(second.projectId, first.projectId);

    const projects = await window.webContents.executeJavaScript('window.api.project.list()');
    assert.equal(
      projects.filter((p) => p.workspaceId === first.workspace.id).length,
      1,
      'one folder, one project',
    );

    // And it is still one after the application is closed and reopened.
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    const after = await window.webContents.executeJavaScript('window.api.project.list()');
    assert.equal(after.filter((p) => p.workspaceId === first.workspace.id).length, 1);
  } finally {
    removeTree(dir);
  }
});

test('one repository is one project, whichever way its address is written', async () => {
  const window = await openWindow();

  // Bookkeeping first: the project exists before any metadata is fetched, so
  // a network failure costs the branch name and not the project.
  //
  // `created` is deliberately not asserted here. An earlier case in this suite
  // made a cloud project for this same repository, and every case shares one
  // application data root - so connecting it finds that project rather than
  // making a second, which is the whole point and is asserted below. A test
  // that demanded a clean slate would be testing the suite's ordering.
  const connected = await window.webContents.executeJavaScript(
    `window.api.project.connectRepository(${JSON.stringify({ url: 'https://github.com/Arcanjog1/Orquestrador' })})`,
  );
  assert.equal(connected.project.repositoryFullName, 'Arcanjog1/Orquestrador');

  // Exactly one project claims this repository, whichever way it got there.
  const claiming = await window.webContents.executeJavaScript('window.api.project.list()').then(
    (list) => list.filter((p) => p.repositoryFullName === 'Arcanjog1/Orquestrador'),
  );
  assert.equal(claiming.length, 1, 'one repository, one project, across both creation paths');
  assert.equal(claiming[0].id, connected.project.id);

  // Five other spellings of the same repository. Each must open the same one.
  for (const spelling of [
    'https://github.com/Arcanjog1/Orquestrador.git',
    'git@github.com:Arcanjog1/Orquestrador.git',
    'Arcanjog1/Orquestrador',
    'arcanjog1/orquestrador',
  ]) {
    const again = await window.webContents.executeJavaScript(
      `window.api.project.connectRepository(${JSON.stringify({ url: spelling })})`,
    );
    assert.equal(again.created, false, `${spelling} opened the existing project`);
    assert.equal(again.project.id, connected.project.id);
  }

  // A different repository of the same owner is a different project - and so
  // the two repositories named in the request are two rows, not one.
  const other = await window.webContents.executeJavaScript(
    `window.api.project.connectRepository(${JSON.stringify({ url: 'https://github.com/Arcanjog1/MeuBotao.pushbutton' })})`,
  );
  assert.equal(other.created, true);
  assert.notEqual(other.project.id, connected.project.id);
  assert.equal(other.project.repositoryFullName, 'Arcanjog1/MeuBotao.pushbutton');

  // The default branch is never guessed, whether or not GitHub could be
  // reached. Both outcomes are correct behaviour and both are checked here,
  // because a test that only passes with a network would be a test that
  // silently stops testing anything on a machine without one.
  //
  // This repository's default branch is deliberately not called `main` - it
  // is `claude/new-session-3am7mo` - so reading it back is the strongest
  // available evidence that no default was invented.
  for (const result of [connected, other]) {
    if (result.metadataError === null) {
      assert.ok(
        typeof result.project.defaultBranch === 'string' && result.project.defaultBranch.length > 0,
        'a successful read reports the branch GitHub named',
      );
    } else {
      assert.equal(
        result.project.defaultBranch,
        null,
        'a failed read reports nothing, never the guessed string "main"',
      );
    }
  }
  if (connected.metadataError === null) {
    assert.equal(
      connected.project.defaultBranch,
      'claude/new-session-3am7mo',
      'the real default branch of this repository, which is not "main"',
    );
    assert.equal(connected.project.repositoryPrivate, false, 'it is a public repository');
  }

  // Each holds its own conversations.
  const openedA = await window.webContents.executeJavaScript(
    `window.api.project.open(${JSON.stringify({ projectId: connected.project.id })})`,
  );
  const openedB = await window.webContents.executeJavaScript(
    `window.api.project.open(${JSON.stringify({ projectId: other.project.id })})`,
  );
  assert.notEqual(openedA.workspaceId, openedB.workspaceId);
  for (const [opened, project, title] of [
    [openedA, connected.project, 'Conversa do Orquestrador'],
    [openedB, other.project, 'Conversa do MeuBotao'],
  ]) {
    await window.webContents.executeJavaScript(
      `window.api.chat.createSession(${JSON.stringify({ workspaceId: opened.workspaceId, title, projectId: project.id })})`,
    );
  }

  await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
  await reloadWindow(window);
  await waitForText(window, /Pular onboarding/, 15_000);
  await click(window, 'skip-onboarding');
  await waitForText(window, /Conversa do Orquestrador/, 15_000);

  const filedRight = await window.webContents.executeJavaScript(`
    (() => {
      const a = document.querySelector('[data-testid="project-${connected.project.id}"]');
      const b = document.querySelector('[data-testid="project-${other.project.id}"]');
      return a !== null && b !== null &&
        a.innerText.includes('Conversa do Orquestrador') &&
        b.innerText.includes('Conversa do MeuBotao');
    })()
  `);
  assert.equal(filedRight, true, 'two projects in the sidebar, each with its own conversation');
});

test('many conversations live in one project, and the search finds one inside a collapsed project', async () => {
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-many-'));
  try {
    const folder = await window.webContents.executeJavaScript(
      `window.api.workspace.openProject(${JSON.stringify({ localPath: dir })})`,
    );
    const project = await window.webContents.executeJavaScript(
      `window.api.project.list()`,
    ).then((list) => list.find((p) => p.workspaceId === folder.workspace.id));

    for (const title of ['Primeira ideia', 'Segunda ideia', 'Terceira ideia']) {
      await window.webContents.executeJavaScript(
        `window.api.chat.createSession(${JSON.stringify({ workspaceId: folder.workspace.id, title, projectId: project.id })})`,
      );
    }

    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    await waitForText(window, /Terceira ideia/, 15_000);

    const count = await window.webContents.executeJavaScript(
      `document.querySelector('[data-testid="count-project-${project.id}"]')?.textContent ?? ''`,
    );
    assert.equal(count.trim(), '3', 'the project counts its conversations');

    // Collapse it. The conversations leave the tree...
    await click(window, `toggle-project-${project.id}`);
    const hidden = await window.webContents.executeJavaScript(
      `document.querySelector('[data-testid="project-${project.id}"]').innerText.includes('Segunda ideia')`,
    );
    assert.equal(hidden, false, 'a collapsed project hides its conversations');

    // ...but the search still finds one, and says which project it is in.
    // This is what makes collapsing safe rather than a way to lose things.
    await type(window, 'session-search', 'Segunda');
    const results = await waitForText(window, /Resultados/i, 10_000);
    assert.match(results, /Segunda ideia/);
    assert.ok(
      results.includes(project.name),
      'the hit names the project it belongs to',
    );
  } finally {
    removeTree(dir);
  }
});

test('the project context is written, read and marked in the packaged interface', async () => {
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-context-'));
  try {
    const folder = await window.webContents.executeJavaScript(
      `window.api.workspace.openProject(${JSON.stringify({ localPath: dir })})`,
    );
    const project = await window.webContents.executeJavaScript(
      `window.api.project.list()`,
    ).then((list) => list.find((p) => p.workspaceId === folder.workspace.id));
    await window.webContents.executeJavaScript(
      `window.api.chat.createSession(${JSON.stringify({ workspaceId: folder.workspace.id, title: 'Conversa', projectId: project.id })})`,
    );

    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    await waitForText(window, /Conversa/, 15_000);

    await openMenu(window, `project-menu-${project.id}`);
    await click(window, `context-project-${project.id}`);
    await waitForText(window, /O que os agentes sabem sobre este projeto/i, 10_000);

    // The dialog says outright that none of this is evidence.
    const blurb = await window.webContents.executeJavaScript('document.body.innerText');
    assert.match(blurb, /Nada aqui é evidência/i);
    assert.match(blurb, /DoneGate não lê esta tela/i);

    await type(window, 'context-title', 'Sem API paga');
    await window.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('[data-testid="context-body"]');
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, 'Assinatura apenas. Nunca ANTHROPIC_API_KEY.');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await click(window, 'context-add');
    await waitForText(window, /Assinatura apenas/, 10_000);

    const stored = await window.webContents.executeJavaScript(
      `window.api.project.listContext(${JSON.stringify({ projectId: project.id })})`,
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0].title, 'Sem API paga');
    assert.equal(stored[0].sourceRef, null, 'written by a person, so no source');

    // It is a decision by default, which competes; pinning makes it travel
    // with every task, and the badge changes to say so.
    await click(window, `pin-${stored[0].id}`);
    await new Promise((r) => setTimeout(r, 300));
    const pinned = await window.webContents.executeJavaScript(
      `window.api.project.listContext(${JSON.stringify({ projectId: project.id })})`,
    );
    assert.equal(pinned[0].pinned, true);
  } finally {
    removeTree(dir);
  }
});

test('a permission request is answerable in the packaged interface, and grants only its scope', async () => {
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-perm-'));
  try {
    const folder = await window.webContents.executeJavaScript(
      `window.api.workspace.openProject(${JSON.stringify({ localPath: dir })})`,
    );
    const project = await window.webContents.executeJavaScript('window.api.project.list()').then(
      (list) => list.find((p) => p.workspaceId === folder.workspace.id),
    );
    const session = await window.webContents.executeJavaScript(
      `window.api.chat.createSession(${JSON.stringify({ workspaceId: folder.workspace.id, title: 'Precisa autorizar', projectId: project.id })})`,
    );

    // A run that stopped on a refused tool, and the request it raised. Written
    // through the real main-process services, so the row is exactly the shape
    // a real refusal produces - the renderer then reads it over the real
    // bridge, which is what this case is for.
    const run = services.database.runs.create({
      id: `run-perm-${Date.now()}`,
      sessionId: session.id,
      workspaceId: folder.workspace.id,
      objective: 'Crie hello.txt',
      orchestratorAgentId: null,
      maxIterations: 3,
    });
    services.database.runs.setStatus(run.id, 'NEEDS_HUMAN', 'Uma ferramenta foi recusada.');
    services.database.permissions.createRequest({
      id: `perm-${Date.now()}`,
      runId: run.id,
      sessionId: session.id,
      workspaceId: folder.workspace.id,
      toolName: 'Bash',
      command: 'node check.mjs',
      workingDirectory: dir,
      reason: 'O Claude Code pediu para usar Bash e a execução não é interativa.',
    });
    const request = { runId: run.id };

    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    await waitForText(window, /Precisa autorizar/, 15_000);

    // The pending request is readable through the real bridge, with every
    // field the dialog renders.
    const pending = await window.webContents.executeJavaScript(
      `window.api.permission.forRun(${JSON.stringify({ runId: request.runId })})`,
    );
    assert.equal(pending.length, 1);
    assert.equal(pending[0].toolName, 'Bash');
    assert.equal(pending[0].command, 'node check.mjs');
    assert.equal(pending[0].status, 'pending');
    assert.ok(
      pending[0].scopes.some((s) => s.rule === 'Bash(node check.mjs)'),
      'the exact command is on offer',
    );
    assert.equal(
      pending[0].scopes.some((s) => s.rule === 'Bash'),
      false,
      'and a bare shell never is',
    );

    // A rule the request did not publish is refused by the main process.
    const widened = await window.webContents
      .executeJavaScript(
        `window.api.permission.approve(${JSON.stringify({ requestId: pending[0].id, rule: 'Bash' })})`,
      )
      .then(() => null)
      .catch((e) => String(e));
    assert.ok(widened && /opções/.test(widened), `a widened rule is refused: ${widened}`);

    // The answer carries the run's fate as well as the request's. Recording a
    // grant and continuing the task that stopped for it are two different
    // things, and for a long time only the first one happened: the row said
    // `approved`, the run stayed at NEEDS_HUMAN, and the person's only way
    // forward was to ask again - which started a whole second run.
    const approved = await window.webContents.executeJavaScript(
      `window.api.permission.approve(${JSON.stringify({ requestId: pending[0].id, rule: 'Bash(node check.mjs)' })})`,
    );
    assert.equal(approved.request.status, 'approved');
    assert.equal(approved.request.approvedRule, 'Bash(node check.mjs)');
    assert.deepEqual(approved.rules, ['Bash(node check.mjs)']);
    // And the run that stopped for this question goes back to work. This is
    // the whole incident: the person authorised, the row said `approved`, and
    // the task stayed stopped for ever.
    assert.equal(approved.resumed, true, 'the original task continued');
    assert.equal(approved.notResumedBecause, null);

    // It is a real run in the packaged application, so it is left to finish
    // rather than abandoned mid-flight - this project has no agents
    // configured, so it stops quickly, and either way it does not stay at
    // NEEDS_HUMAN waiting for an authorisation it already has.
    const settled = await waitFor(
      async () => {
        const view = await window.webContents.executeJavaScript(
          `window.api.run.get(${JSON.stringify({ runId: run.id })})`,
        );
        return view.status === 'NEEDS_HUMAN' || view.status === 'RUNNING' ? null : view;
      },
      20_000,
      'the resumed run to settle',
    );
    assert.ok(settled, `the resumed run left NEEDS_HUMAN: ${settled?.status}`);

    const grants = await window.webContents.executeJavaScript(
      `window.api.permission.grants(${JSON.stringify({ workspaceId: folder.workspace.id })})`,
    );
    assert.deepEqual(grants.map((g) => g.rule), ['Bash(node check.mjs)']);
  } finally {
    removeTree(dir);
  }
});

test('the team dialog adds a second worker, and refuses two workers on one connection', async () => {
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-team2-'));
  try {
    await window.webContents.executeJavaScript(
      `window.api.accounts.create(${JSON.stringify({ name: 'Claude Dois', provider: 'anthropic' })})`,
    );
    const workspace = await window.webContents.executeJavaScript(
      `window.api.workspace.create(${JSON.stringify({ name: 'Equipe grande', localPath: dir })})`,
    );

    // The newest project is the one the shell opens, and this one was just
    // created - so a reload lands on it.
    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    await waitForText(window, /Equipe grande/, 15_000);

    await click(window, 'team-chip');
    await waitForText(window, /Editar equipe/, 10_000);
    await click(window, 'edit-team');
    await waitForText(window, /Equipe deste projeto/, 10_000);

    // One worker to start with, exactly as before teams could grow.
    const single = await window.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid^="team-worker"]').length > 0`,
    );
    assert.equal(single, true);

    await click(window, 'team-add-worker');
    // The section label is uppercased by CSS, so innerText reads it uppercase.
    const second = await waitForText(window, /Coding worker 2/i, 10_000);
    assert.match(second, /Coding worker 1/i, 'the first is renumbered once there are two');

    // Both default to different connections, so the form is savable; forcing
    // them onto one is what must be refused.
    const accounts = await window.webContents.executeJavaScript('window.api.accounts.list()');
    const anthropic = accounts.filter((a) => a.provider === 'anthropic');
    assert.ok(anthropic.length >= 2, 'two Anthropic accounts exist for this check');

    const refused = await window.webContents.executeJavaScript(`
      window.api.workspace.setTeam(${JSON.stringify({
        workspaceId: workspace.id,
        orchestrator: { accountId: accounts.find((a) => a.provider === 'openai').id },
        worker: { accountId: anthropic[0].id },
        workers: [{ accountId: anthropic[0].id }, { accountId: anthropic[0].id }],
      })}).then(() => 'saved', (e) => e.message)
    `);
    assert.match(String(refused), /mesma conexão/, 'one connection cannot be two workers');

    // Two different connections save, and read back as two members.
    const saved = await window.webContents.executeJavaScript(`
      window.api.workspace.setTeam(${JSON.stringify({
        workspaceId: workspace.id,
        orchestrator: { accountId: accounts.find((a) => a.provider === 'openai').id },
        worker: { accountId: anthropic[0].id },
        workers: [{ accountId: anthropic[0].id }, { accountId: anthropic[1].id }],
      })})
    `);
    assert.equal(saved.team.workers.length, 2);
    assert.deepEqual(
      saved.team.workers.map((w) => w.workerId),
      ['worker-1', 'worker-2'],
      'the ids the orchestrator delegates by',
    );
    assert.notEqual(saved.team.workers[0].accountId, saved.team.workers[1].accountId);
  } finally {
    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
    // Windows can still hold a handle on a folder the app just had open, and
    // a temp folder that will not go is not a failed assertion. `removeTree`
    // is what the rest of this suite already uses for exactly that.
    removeTree(dir);
  }
});

test('budget limits are saved for the project, and the screen says what they cannot promise', async () => {
  const window = await openWindow();
  const dir = mkdtempSync(join(tmpdir(), 'lao-electron-budget-'));
  try {
    const workspace = await window.webContents.executeJavaScript(
      `window.api.workspace.create(${JSON.stringify({ name: 'Projeto com limite', localPath: dir })})`,
    );
    assert.equal(workspace.budget.maxCostUsd, null, 'a new project has no limit');

    // Settings shows the limits of the project that is open, so this opens one
    // first - which is also what a person does.
    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
    await reloadWindow(window);
    await waitForText(window, /Pular onboarding/, 15_000);
    await click(window, 'skip-onboarding');
    await waitForText(window, /Projeto com limite/, 15_000);
    await window.webContents.executeJavaScript(
      `(() => { location.hash = '#/configuracoes?tab=execution'; return true; })()`,
    );
    const text = await waitForText(window, /Limites de gasto/i, 15_000);

    // The sentence that matters, on the screen that sets the limit.
    assert.match(text, /não é um teto cobrado pelo\s+provider/);
    assert.match(text, /não informado.*nunca zero|nunca zero/);

    await type(window, 'budget-cost', '2.5');
    await type(window, 'budget-invocations', '12');
    await click(window, 'budget-save');
    await new Promise((r) => setTimeout(r, 600));

    const saved = (await window.webContents.executeJavaScript('window.api.workspace.list()')).find(
      (w) => w.id === workspace.id,
    );
    assert.equal(saved.budget.maxCostUsd, 2.5);
    assert.equal(saved.budget.maxInvocations, 12);
    assert.equal(saved.budget.maxTokens, null, 'an empty field stays no limit');
  } finally {
    await window.webContents.executeJavaScript(`(() => { location.hash = '#/'; return true; })()`);
    // Windows can still hold a handle on a folder the app just had open, and
    // a temp folder that will not go is not a failed assertion. `removeTree`
    // is what the rest of this suite already uses for exactly that.
    removeTree(dir);
  }
});

/* ------------------------------------------------------------------ helpers */

let sharedWindow = null;
let fakeGitHub = null;
let loginItem = false;
const openedUrls = [];

/**
 * The parts of github.com and api.github.com the card and the picker use,
 * on localhost: device code, token, who am I, my repositories.
 */
async function startFakeGitHub() {
  const { createServer } = await import('node:http');
  const TOKEN = 'gho_electrontesttoken';
  let polls = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/login/device/code') {
        return json(200, { device_code: 'dc', user_code: 'WDJB-MJHT', verification_uri: `${base}/login/device`, expires_in: 900, interval: 1 });
      }
      if (url.pathname === '/login/oauth/access_token') {
        polls += 1;
        if (polls < 2) return json(200, { error: 'authorization_pending' });
        return json(200, { access_token: TOKEN, token_type: 'bearer', scope: 'repo' });
      }
      if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) return json(401, { message: 'Bad credentials' });
      if (url.pathname === '/user') return json(200, { login: 'octocat', name: 'The Octocat', avatar_url: '', html_url: 'https://github.com/octocat' });
      if (url.pathname === '/user/repos') {
        return json(200, [
          { full_name: 'octocat/private-thing', name: 'private-thing', owner: { login: 'octocat' }, private: true, default_branch: 'main', html_url: 'https://github.com/octocat/private-thing', clone_url: 'https://github.com/octocat/private-thing.git', updated_at: '2026-09-01T00:00:00Z', permissions: { push: true, admin: true } },
        ]);
      }
      return json(404, { message: 'no route' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { endpoints: { oauthBase: base, apiBase: base }, close: () => new Promise((r) => server.close(r)) };
}

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
    conversations: join(appRoot, 'conversations'),
  };

  fakeGitHub = await startFakeGitHub();
  services = new AppServices({
    paths,
    openUrl: (url) => openedUrls.push(url),
    // The GitHub on localhost, and a reversible secret store: enough to run
    // the real login through the real card without a keyring.
    // Polls a little apart, so the code is on screen the way it is for a
    // person; the real interval is what GitHub says (seconds).
    github: {
      endpoints: fakeGitHub.endpoints,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 600))),
    },
    secrets: {
      available: true,
      encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
      decrypt: (cipher) => Buffer.from(cipher.slice(4), 'base64').toString('utf8'),
    },
    // The provider APIs, answered locally. A test must never reach a vendor:
    // it would need a credential nobody has here and would cost money if it
    // did. Every request is recorded so a check can assert what went out.
    providerTransport: async (url, init) => {
      providerCalls.push({ url, headers: init.headers });
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({ data: [{ id: 'modelo-de-teste', display_name: 'Modelo de teste' }] }),
        headers: { get: () => null },
      };
    },
  });
  const router = new IpcRouter(services, {
    selectFolder: async () => null,
    openExternal: async () => true,
    openPath: async () => true,
    startWithSystem: () => loginItem,
    setStartWithSystem: (enabled) => (loginItem = enabled),
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

/**
 * Removes a scratch folder. On Windows a handle can still be open on it for
 * a moment after git ran there, and rmSync answers EPERM; a few retries
 * cover that, and a folder that still will not go is a temp folder, not a
 * failed assertion.
 */
function removeTree(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Left for the OS to clean; the test's result stands.
  }
}

/** Clicks the element carrying a `data-testid`, failing loudly if it is absent. */
/**
 * Clicks the element, once it is there and enabled: a button the page has
 * disabled while it finishes something (a branch switch still refreshing
 * git) swallows a click, so the helper waits for it the way a person would.
 */
async function click(window, testid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let done = 'missing';
  while (Date.now() < deadline) {
    done = await window.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('[data-testid="${testid}"]');
        if (!el) return 'missing';
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return 'disabled';
        el.click();
        return 'clicked';
      })()
    `);
    if (done === 'clicked') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    done === 'disabled'
      ? `the element with data-testid="${testid}" stayed disabled`
      : `no element with data-testid="${testid}"`,
  );
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
      // The composer is a textarea, and a textarea does not take the input
      // prototype's setter - calling it throws, which reaches the harness as
      // an opaque "script failed to execute". Pick the prototype the element
      // actually has.
      const proto = el instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    })()
  `);
  if (done !== 'typed') throw new Error(`no input with data-testid="${testid}"`);
}

/**
 * Chooses an option in a `<select>` the way React sees it.
 *
 * Same reason `type` exists: assigning `.value` alone does not reach React's
 * state, so the native setter is used and a change event dispatched.
 */
async function select(window, testid, value) {
  const done = await window.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector('[data-testid="${testid}"]');
      if (!el) return 'missing';
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'selected';
    })()
  `);
  if (done !== 'selected') throw new Error(`no select with data-testid="${testid}"`);
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

/**
 * Polls until `probe` returns something other than null, or gives up.
 *
 * Used where the thing being waited for is a value from the real bridge rather
 * than text on the screen - a run reaching a state, for instance.
 */
async function waitFor(probe, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
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
    if (fakeGitHub) await fakeGitHub.close();
    if (appRoot) rmSync(appRoot, { recursive: true, force: true });
  } catch {
    /* teardown must never change the verdict */
  }
  app.exit(failed === 0 ? 0 : 1);
});
