/**
 * Electron Main.
 *
 * Owns the window, the services and the IPC surface. The renderer runs with
 * `contextIsolation` on, `nodeIntegration` off and `sandbox` on, so it reaches
 * the machine only through the channels the preload bridge exposes.
 *
 * The window opens dark and stays dark: the approved design is dark-first, and
 * a white flash on launch would be the first thing the user sees.
 */

import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Services } from './services.js';
import { registerIpcHandlers } from './ipc.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Matches `--background` in the design tokens (oklch(0.176 0.008 264)). */
const BACKGROUND = '#1c1f26';

const DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];

let window: BrowserWindow | null = null;
let services: Services | null = null;

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1440,
    height: 900,
    // The design's narrowest validated layout: below this the panels have
    // nowhere left to collapse to.
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: BACKGROUND,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Nothing in the interface needs to run a remote page.
      webviewTag: false,
      spellcheck: false,
    },
  });

  created.once('ready-to-show', () => created.show());

  // Any navigation the interface does not perform itself goes to the system
  // browser instead of replacing the application's own page.
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  created.webContents.on('will-navigate', (event, url) => {
    const current = created.webContents.getURL();
    if (url !== current) {
      event.preventDefault();
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    }
  });

  if (DEV_SERVER_URL) {
    void created.loadURL(DEV_SERVER_URL);
  } else {
    void created.loadFile(join(here, '../renderer/index.html'));
  }

  created.on('closed', () => {
    window = null;
  });

  return created;
}

// One instance only: two of them would fight over the same SQLite file and the
// same runtime directories.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  void app.whenReady().then(() => {
    services = new Services();
    registerIpcHandlers({ services, getWindow: () => window });
    window = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) window = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    void services?.dispose();
    services = null;
  });
}
