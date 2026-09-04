/**
 * The self-check the packaged application can run on itself.
 *
 * A build that starts is not the same as a build that works: `node:sqlite`
 * could be missing from the packaged Node, the preload could be excluded from
 * the asar, the renderer bundle could be stale. Running this inside the
 * packaged binary is the only honest way to find out, and it is what CI runs
 * against `AI-Orchestrator-Setup.exe`'s payload.
 *
 * Enabled by `AI_ORCHESTRATOR_SMOKE=1`, so it can never fire in normal use.
 */

import type { BrowserWindow } from 'electron';
import type { AppServices } from '../main/services/app-services.js';

export interface SmokeCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export function smokeRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AI_ORCHESTRATOR_SMOKE'] === '1';
}

export async function runSmokeChecks(
  services: AppServices,
  window: BrowserWindow,
): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = [];
  const check = async (name: string, fn: () => Promise<string> | string): Promise<void> => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  await check('electron-versions', () => {
    const { electron, node, chrome } = process.versions;
    if (!electron) throw new Error('not running under Electron');
    return `electron ${electron}, node ${node}, chromium ${chrome}`;
  });

  await check('node-sqlite', () => {
    const version = services.database.schemaVersion;
    if (version !== services.database.expectedSchemaVersion) {
      throw new Error(`schema ${version}, expected ${services.database.expectedSchemaVersion}`);
    }
    services.database.settings.set('smoke', new Date().toISOString());
    const mode = services.database.driver.get('PRAGMA journal_mode');
    const journal = String(Object.values(mode ?? {})[0]).toLowerCase();
    if (journal !== 'wal') throw new Error(`journal_mode is ${journal}`);
    if (!services.database.settings.get('smoke')) throw new Error('write/read round trip failed');
    return `schema ${version}, journal ${journal}`;
  });

  await check('renderer-loaded', async () => {
    const title = await window.webContents.executeJavaScript('document.title');
    if (typeof title !== 'string' || title.length === 0) throw new Error('no document title');
    return title;
  });

  await check('preload-bridge', async () => {
    const shape = (await window.webContents.executeJavaScript(
      '({ api: typeof window.api, require: typeof window.require })',
    )) as { api: string; require: string };
    if (shape.api !== 'object') throw new Error('window.api is missing');
    if (shape.require !== 'undefined') throw new Error('window.require is reachable');
    return 'bridge present, node unreachable';
  });

  await check('ipc-round-trip', async () => {
    const info = (await window.webContents.executeJavaScript('window.api.app.info()')) as {
      packaged: boolean;
      sqliteAvailable: boolean;
    };
    if (!info.sqliteAvailable) throw new Error('app.info reports sqlite unavailable');
    return `packaged=${info.packaged}`;
  });

  await check('runtime-diagnose', async () => {
    const report = (await window.webContents.executeJavaScript(
      'window.api.runtime.diagnose()',
    )) as { runtimes: Array<{ runtimeId: string }> };
    const ids = report.runtimes.map((r) => r.runtimeId).sort();
    if (ids.length !== 3) throw new Error(`expected 3 runtimes, got ${ids.join(', ')}`);
    return ids.join(', ');
  });

  await check('onboarding-rendered', async () => {
    const deadline = Date.now() + 20_000;
    let text = '';
    while (Date.now() < deadline) {
      text = (await window.webContents.executeJavaScript('document.body.innerText')) as string;
      if (/Codex/.test(text) && /Git/.test(text)) return 'runtime checklist rendered';
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`checklist never rendered; body was: ${text.slice(0, 400)}`);
  });

  return checks;
}

export function reportSmoke(checks: readonly SmokeCheck[]): boolean {
  for (const check of checks) {
    console.log(`${check.ok ? 'ok' : 'not ok'} - ${check.name}: ${check.detail}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`# pass ${checks.length - failed}`);
  console.log(`# fail ${failed}`);
  return failed === 0;
}
