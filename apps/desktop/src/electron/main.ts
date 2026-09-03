/**
 * The Electron entry point.
 *
 * Its whole job is to be the thin, Electron-aware shell around
 * `AppServices`: create a locked-down window, bind the IPC router to
 * `ipcMain`, and inject the two things only Electron can provide - a browser
 * opener and a way to push events at a renderer.
 *
 * Security posture, non-negotiable:
 *   contextIsolation: true    the preload and the page share no scope
 *   nodeIntegration:  false   the page has no require, no fs, no child_process
 *   sandbox:          true    the renderer runs in Chromium's sandbox
 *   webSecurity:      true
 * plus a refusal to navigate anywhere but our own page, and a refusal to open
 * a second window at all. Anything that must reach the operating system goes
 * over the typed IPC surface, which names operations rather than commands.
 */

import { BrowserWindow, app, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppServices } from '../main/app-services.js';
import { dispatch, missingHandlers } from '../main/ipc/router.js';
import { formatSelfTest, runSelfTest } from '../main/self-test.js';
import { formatSmokeTest, runSmokeTest } from './smoke-test.js';
import { BRIDGE_KEY, EVENT_CHANNELS, INVOKE_CHANNELS } from '../shared/ipc-contract.js';

/** The renderer is served from disk in production and from Vite in dev. */
const DEV_SERVER_URL = process.env.ORCHESTRATOR_DEV_SERVER_URL;
const RENDERER_FILE = join(__dirname, '..', 'renderer', 'index.html');
const RENDERER_ORIGIN = DEV_SERVER_URL ?? pathToFileURL(RENDERER_FILE).toString();

let services: AppServices | null = null;
let mainWindow: BrowserWindow | null = null;

function log(line: string): void {
  // Main-process diagnostics. Never shown in the interface.
  process.stdout.write(`[main] ${line}\n`);
}

function send(channel: (typeof EVENT_CHANNELS)[number], payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

/**
 * Rejects a request that did not come from our own page.
 *
 * `ipcMain.handle` will listen to any frame in any window; this keeps the
 * surface to the one document we loaded ourselves.
 */
function senderIsOurs(event: Electron.IpcMainInvokeEvent): boolean {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window !== mainWindow) return false;
  const url = event.senderFrame?.url ?? '';
  if (DEV_SERVER_URL) return url.startsWith(DEV_SERVER_URL);
  return url.startsWith('file://');
}

function registerIpc(): void {
  const missing = missingHandlers();
  if (missing.length > 0) {
    // A channel in the contract with no handler is a hole, not a warning.
    throw new Error(`IPC channels declared but not handled: ${missing.join(', ')}`);
  }

  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      if (!senderIsOurs(event)) {
        log(`ipc: refused ${channel} from an unexpected frame`);
        return {
          ok: false,
          code: 'INVALID_REQUEST',
          userMessage: 'Esta ação não existe neste aplicativo.',
        };
      }
      if (!services) {
        return {
          ok: false,
          code: 'INTERNAL',
          userMessage: 'O aplicativo ainda está iniciando.',
          remedy: 'Aguardar',
        };
      }
      return dispatch(services, channel, payload);
    });
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1115',
    title: 'AI Orchestrator',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  // A link in the interface opens in the user's browser; it never becomes a
  // second Electron window with its own privileges.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The renderer loads exactly one document and stays there.
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(RENDERER_ORIGIN)) {
      event.preventDefault();
      log(`navigation refused: ${url}`);
    }
  });

  // Nothing in this application needs a camera, a microphone or a location.
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    log(`permission refused: ${permission}`);
    callback(false);
  });

  window.once('ready-to-show', () => window.show());
  return window;
}

async function start(): Promise<void> {
  services = new AppServices({
    appName: app.getName(),
    appVersion: app.getVersion(),
    emit: (channel, event) => send(channel, event),
    emitLogin: (channel, event) => send(channel, event),
    openExternal: async (url) => {
      // The sign-in URL is opened here, in the main process. It never
      // reaches the renderer.
      if (!/^https:\/\//.test(url)) throw new Error('refusing to open a non-https URL');
      await shell.openExternal(url);
    },
    log,
    developerMode: process.env.ORCHESTRATOR_DEVELOPER_MODE === '1',
  });

  registerIpc();
  mainWindow = createWindow();

  if (DEV_SERVER_URL) {
    await mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(RENDERER_FILE);
  }

  log(`bridge exposed as window.${BRIDGE_KEY}`);
}

// A single instance owns the database file and the profile directories.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // `--self-test` runs the SQLite proof and exits. Same code in dev and in
    // the packaged executable, which is the only way to know the packaged
    // one works.
    if (process.argv.includes('--self-test')) {
      const report = await runSelfTest({ packaged: app.isPackaged });
      process.stdout.write(`${formatSelfTest(report)}\n`);
      app.exit(report.ok ? 0 : 1);
      return;
    }

    await start();

    // `--smoke-test` boots the real window, checks the bridge end to end and
    // exits. Same code in development and inside the installed executable.
    if (process.argv.includes('--smoke-test') && mainWindow) {
      const report = await runSmokeTest(mainWindow, { packaged: app.isPackaged });
      process.stdout.write(`${formatSmokeTest(report)}\n`);
      app.exit(report.ok ? 0 : 1);
      return;
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void start();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async (event) => {
    if (!services) return;
    event.preventDefault();
    const closing = services;
    services = null;
    await closing.dispose();
    app.quit();
  });
}
