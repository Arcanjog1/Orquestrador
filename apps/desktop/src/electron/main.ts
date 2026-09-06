/**
 * Electron main entry point.
 *
 * Its whole job is wiring: build the services, create one hardened window, put
 * the router behind `ipcMain.handle`, and forward service events to the
 * renderer. Any real logic here would be logic the tests cannot reach.
 */

import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { REQUEST_CHANNELS } from '../shared/ipc-contract.js';
import { IpcRouter, type ShellBridge } from '../main/ipc-router.js';
import { AppServices } from '../main/services/app-services.js';
import {
  CONTENT_SECURITY_POLICY,
  WEB_PREFERENCES,
  assertHardened,
  lockDownNavigation,
} from './security.js';
import { reportSmoke, runSmokeChecks, smokeRequested } from './smoke.js';

const here = dirname(fileURLToPath(import.meta.url));
/** `dist/apps/desktop/src/electron` → the app root that holds the bundles. */
const appRoot = resolve(here, '../../../../..');
const PRELOAD = join(appRoot, 'dist-renderer', 'preload.cjs');
const INDEX_HTML = join(appRoot, 'dist-renderer', 'index.html');

let services: AppServices | null = null;
let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#12141a',
    title: 'AI Orchestrator',
    webPreferences: { ...WEB_PREFERENCES, preload: PRELOAD },
  });

  lockDownNavigation(window.webContents, `file://${INDEX_HTML}`, (url) => {
    void shell.openExternal(url);
  });

  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      },
    });
  });

  window.once('ready-to-show', () => window.show());
  return window;
}

function buildShellBridge(): ShellBridge {
  return {
    async selectFolder() {
      const parent = mainWindow;
      const result = parent
        ? await dialog.showOpenDialog(parent, {
            title: 'Escolha a pasta do projeto',
            properties: ['openDirectory', 'createDirectory'],
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
    // The router has already validated the scheme; checking again here means
    // neither side alone decides what may be launched.
    async openExternal(url: string) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      await shell.openExternal(parsed.toString());
      return true;
    },
    // Only the router calls this, and only with a path it read from the
    // workspaces table; the renderer never names a path.
    async openPath(path: string) {
      const problem = await shell.openPath(path);
      return problem === '';
    },
    // Windows and macOS have a login item for the app; Linux has none Electron
    // can set, and the setting says so rather than pretending.
    startWithSystem: () =>
      process.platform === 'win32' || process.platform === 'darwin'
        ? app.getLoginItemSettings().openAtLogin
        : null,
    setStartWithSystem: (enabled: boolean) => {
      if (process.platform !== 'win32' && process.platform !== 'darwin') return null;
      app.setLoginItemSettings({ openAtLogin: enabled });
      return app.getLoginItemSettings().openAtLogin;
    },
    appInfo: () => ({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome ?? '',
      packaged: app.isPackaged,
    }),
  };
}

async function boot(): Promise<void> {
  services = new AppServices({
    openUrl: (url) => {
      void shell.openExternal(url);
    },
    // Electron's safeStorage: DPAPI on Windows, Keychain on macOS, the
    // desktop keyring on Linux. Without one, the GitHub login is refused
    // rather than written in the clear.
    secrets: {
      get available() {
        return safeStorage.isEncryptionAvailable();
      },
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64')),
    },
  });

  const router = new IpcRouter(services, buildShellBridge());
  for (const channel of REQUEST_CHANNELS) {
    ipcMain.handle(channel, async (_event, payload: unknown) => router.handle(channel, payload));
  }

  services.events.subscribe((channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  });

  mainWindow = createWindow();
  assertHardened(mainWindow);
  await mainWindow.loadFile(INDEX_HTML);

  // The packaged build can be asked to check itself and quit. Never in normal
  // use: it only happens when AI_ORCHESTRATOR_SMOKE is set, which CI sets.
  if (smokeRequested()) {
    const passed = reportSmoke(await runSmokeChecks(services, mainWindow));
    await services.shutdown();
    app.exit(passed ? 0 : 1);
  }
}

app.on('web-contents-created', (_event, contents) => {
  lockDownNavigation(contents, `file://${INDEX_HTML}`, (url) => {
    void shell.openExternal(url);
  });
});

app.whenReady().then(boot).catch((error: unknown) => {
  dialog.showErrorBox(
    'AI Orchestrator não pôde iniciar',
    error instanceof Error ? error.message : String(error),
  );
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void boot();
});

app.on('before-quit', () => {
  void services?.shutdown();
});
