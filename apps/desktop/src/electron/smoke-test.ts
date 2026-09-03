/**
 * The startup smoke check, run against the real window.
 *
 * `--self-test` proves the database. This proves the rest of the chain that
 * only exists once Electron is actually running: preload, context isolation,
 * the typed IPC surface, and `RuntimeManager.diagnose()` arriving in the
 * renderer. Like the self-test it is a mode of the application itself, so the
 * packaged executable is checked by the same code as the development build -
 * which is the only way to find out early that something works under
 * `npm run dev` and nowhere else.
 *
 * It asks the page questions from the main process and prints one JSON line.
 * Nothing here runs unless `--smoke-test` was passed on the command line.
 */

import { writeFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';

export interface SmokeStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SmokeReport {
  ok: boolean;
  packaged: boolean;
  steps: SmokeStep[];
}

export const SMOKE_MARKER = 'AI_ORCHESTRATOR_SMOKE_TEST';

/**
 * Optional extra: really install a runtime through the interface.
 *
 * Named by `ORCHESTRATOR_SMOKE_INSTALL`, because it downloads. It is the only
 * way to prove the whole chain the product depends on - renderer, IPC,
 * RuntimeManager.install, progress events, renderer again - rather than the
 * halves of it that a unit test can reach.
 */
const INSTALL_PROBE = (runtimeId: string) => `(async () => {
  const api = window.orchestrator;
  const report = [];
  const add = (name, ok, detail) => report.push({ name, ok, detail: String(detail) });

  const steps = [];
  const stop = api.runtime.onProgress((event) => steps.push(event));

  const result = await api.runtime.install(${JSON.stringify(runtimeId)});
  stop();

  add('install pela interface', result.ok === true,
      result.ok ? result.data.displayName + ' ' + result.data.version : result.userMessage);

  const seen = [...new Set(steps.map((s) => s.step))];
  add('progresso chegou ao renderer', steps.length > 0, seen.join(' > '));
  add('fases foram traduzidas', seen.every((s) => ['Baixando','Verificando','Instalando','Testando','Concluído','Restaurado'].includes(s)), seen.join(','));
  add('nenhum detalhe tecnico no progresso',
      steps.every((s) => !/PATH|spawn|stderr|tarball|exit code|registry\.npmjs/.test(s.message)),
      steps.map((s) => s.message).join(' | ').slice(0, 160));

  const after = await api.runtime.diagnose();
  const row = after.ok ? after.data.runtimes.find((r) => r.runtimeId === ${JSON.stringify(runtimeId)}) : null;
  add('diagnose reflete a instalacao', Boolean(row && row.health.healthy), row ? String(row.health.healthy) : 'sem linha');

  return report;
})()`;

/**
 * Questions the renderer answers about itself.
 *
 * The isolation checks are the important ones: a page that can see `require`
 * or `process` has none of the guarantees this architecture is built on, and
 * that must fail loudly rather than be discovered later.
 */
const PROBE = `(async () => {
  const api = window.orchestrator;
  const report = [];
  const add = (name, ok, detail) => report.push({ name, ok, detail: String(detail) });

  add('preload expos window.orchestrator', Boolean(api), api ? Object.keys(api).join(',') : 'missing');
  add('renderer sem require', typeof require === 'undefined', typeof require);
  add('renderer sem process', typeof process === 'undefined', typeof process);
  add('renderer sem module', typeof module === 'undefined', typeof module);
  add(
    'renderer sem canal generico',
    !api || (!('exec' in api) && !('shell' in api) && !('runCommand' in api) && !('invoke' in api)),
    api ? Object.keys(api).join(',') : 'n/a',
  );

  if (!api) return report;

  const info = await api.app.getInfo();
  add('IPC app.getInfo', info.ok === true, info.ok ? info.data.name + ' ' + info.data.version : info.userMessage);

  const boot = await api.app.getBootstrapState();
  add('IPC app.getBootstrapState', boot.ok === true && boot.data.databaseReady === true,
      boot.ok ? 'schema ' + boot.data.schemaVersion : boot.userMessage);

  const diagnosis = await api.runtime.diagnose();
  add('IPC runtime.diagnose', diagnosis.ok === true,
      diagnosis.ok
        ? diagnosis.data.runtimes.map((r) => r.runtimeId + '=' + (r.health.healthy ? 'ok' : 'pendente')).join(' ')
        : diagnosis.userMessage);

  const accounts = await api.accounts.list();
  add('IPC accounts.list', accounts.ok === true, accounts.ok ? accounts.data.length + ' conta(s)' : accounts.userMessage);

  // An invalid payload must be refused by the main process, not accepted
  // because TypeScript would have caught it at compile time.
  const rejected = await api.runtime.install('../../etc/passwd');
  add('payload invalido recusado', rejected.ok === false && rejected.code === 'INVALID_REQUEST',
      rejected.ok ? 'ACCEPTED' : rejected.code);

  const unknown = await api.accounts.status('../escape');
  add('accountId com traversal recusado', unknown.ok === false && unknown.code === 'INVALID_REQUEST',
      unknown.ok ? 'ACCEPTED' : unknown.code);

  // The onboarding screen must have rendered something from the diagnosis.
  const text = document.body.innerText || '';
  add('onboarding renderizado', text.includes('AI Orchestrator'), text.slice(0, 120).replace(/\\s+/g, ' '));
  add('nenhum termo de terminal na tela',
      !/PATH|spawn|stderr|CLAUDE_CONFIG_DIR|exit code|tarball/.test(text),
      text.slice(0, 200).replace(/\\s+/g, ' '));

  return report;
})()`;

/**
 * Optional extra: really start a Claude sign-in from the interface.
 *
 * Enabled by `ORCHESTRATOR_SMOKE_LOGIN`, because it launches the Claude Code
 * CLI. It cannot finish without a person and a browser, so it starts the flow,
 * gives it a bounded moment and then cancels - which is enough to prove the
 * part the product promises: the user presses a button, the application
 * creates the profile and drives the CLI, and no terminal appears anywhere.
 */
const LOGIN_PROBE = `(async () => {
  const api = window.orchestrator;
  const report = [];
  const add = (name, ok, detail) => report.push({ name, ok, detail: String(detail) });
  try {

  const events = [];
  const stop = api.accounts.onLoginProgress((event) => events.push(event));

  const created = await api.accounts.create('anthropic', 'Claude Smoke');
  add('conta criada pela interface', created.ok === true,
      created.ok ? created.data.displayName + ' (' + created.data.id + ')' : created.userMessage);
  if (!created.ok) { stop(); return report; }

  const id = created.data.id;
  const connecting = api.accounts.connect(id);
  await new Promise((resolve) => setTimeout(resolve, 20000));
  const cancelled = await api.accounts.cancelConnect(id);
  const result = await connecting;
  stop();

  add('login iniciado pela interface', events.length > 0,
      events.map((e) => e.phase).join(' > ') || 'nenhum evento');
  add('cancelamento reconhecido', cancelled.ok === true && cancelled.data.cancelled === true,
      cancelled.ok ? String(cancelled.data.cancelled) : cancelled.userMessage);
  const serialised = JSON.stringify(events);
  add('renderer nunca recebe a URL de login',
      !serialised.includes('http') && !serialised.includes('oauth'),
      serialised.slice(0, 160));
  add('resultado do login e um estado, nao um erro cru',
      result.ok === true || (result.ok === false && typeof result.userMessage === 'string'),
      result.ok ? result.data.state : result.userMessage);

  const removed = await api.accounts.remove(id);
  add('conta removida pela interface', removed.ok === true && removed.data.removed === true,
      removed.ok ? 'removida' : removed.userMessage);
  } catch (err) {
    add('login pela interface', false, (err && err.stack) || String(err));
  }

  return report;
})()`;

export async function runSmokeTest(
  window: BrowserWindow,
  options: { packaged: boolean },
): Promise<SmokeReport> {
  const steps: SmokeStep[] = [];

  try {
    // Give the first render and its diagnose call time to settle.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const probed = (await window.webContents.executeJavaScript(PROBE, true)) as SmokeStep[];
    steps.push(...probed);
  } catch (err) {
    steps.push({ name: 'probe', ok: false, detail: (err as Error).message });
  }

  const installTarget = process.env.ORCHESTRATOR_SMOKE_INSTALL;
  if (installTarget && steps.every((s) => s.ok)) {
    try {
      const probed = (await window.webContents.executeJavaScript(
        INSTALL_PROBE(installTarget),
        true,
      )) as SmokeStep[];
      steps.push(...probed);
    } catch (err) {
      steps.push({ name: 'install pela interface', ok: false, detail: (err as Error).message });
    }
  }

  if (process.env.ORCHESTRATOR_SMOKE_LOGIN && steps.every((s) => s.ok)) {
    try {
      const probed = (await window.webContents.executeJavaScript(
        LOGIN_PROBE,
        true,
      )) as SmokeStep[];
      steps.push(...probed);
    } catch (err) {
      steps.push({ name: 'login pela interface', ok: false, detail: (err as Error).message });
    }
  }

  // A screenshot on request, so a reviewer can see the screen the assertions
  // above only describe. Written only when a path is named, under a flag that
  // already exits the application.
  const shot = process.env.ORCHESTRATOR_SMOKE_SCREENSHOT;
  if (shot) {
    try {
      const image = await window.webContents.capturePage();
      writeFileSync(shot, image.toPNG());
      steps.push({ name: 'captura de tela', ok: true, detail: shot });
    } catch (err) {
      steps.push({ name: 'captura de tela', ok: false, detail: (err as Error).message });
    }
  }

  return { ok: steps.length > 0 && steps.every((s) => s.ok), packaged: options.packaged, steps };
}

export function formatSmokeTest(report: SmokeReport): string {
  return `${SMOKE_MARKER} ${JSON.stringify(report)}`;
}
