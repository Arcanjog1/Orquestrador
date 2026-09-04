/**
 * Electron hardening, in one place so it can be read and tested as a unit.
 *
 * The four flags below are not defaults to be tuned later — they are the reason
 * the renderer can be treated as untrusted. With them on, a bug (or a hostile
 * string) in the React tree cannot reach Node, the filesystem, SQLite, the
 * RuntimeManager, the ProcessManager, Codex, Claude or Git: the only way out is
 * a named channel in the contract.
 */

import type { BrowserWindow, WebContents } from 'electron';

export const WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
} as const;

/**
 * A restrictive CSP for the packaged page.
 *
 * The renderer is a local bundle: it needs no remote script, no remote style,
 * no remote font and no network of its own. Everything it displays arrives over
 * IPC.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/**
 * Refuses navigation and new windows.
 *
 * The app is one local page. A link that would take the renderer somewhere else
 * is opened in the system browser instead, where it is the operating system's
 * problem and not ours.
 */
export function lockDownNavigation(
  contents: WebContents,
  allowedOrigin: string,
  openExternally: (url: string) => void,
): void {
  contents.on('will-navigate', (event, url) => {
    if (url !== allowedOrigin) {
      event.preventDefault();
      if (isExternalHttp(url)) openExternally(url);
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttp(url)) openExternally(url);
    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // Nothing in this app needs a camera, a microphone or a location.
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
}

export function isExternalHttp(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Applied to every window before it is shown, as a defence in depth check. */
export function assertHardened(window: BrowserWindow): void {
  // `getLastWebPreferences` is present at run time but missing from the
  // published typings, so the shape is asserted rather than assumed.
  const contents = window.webContents as unknown as {
    getLastWebPreferences?: () => Record<string, unknown> | null;
  };
  const preferences = contents.getLastWebPreferences?.() ?? null;
  if (!preferences) return;
  const problems: string[] = [];
  if (preferences['contextIsolation'] !== true) problems.push('contextIsolation must be true');
  if (preferences['nodeIntegration'] === true) problems.push('nodeIntegration must be false');
  if (preferences['sandbox'] !== true) problems.push('sandbox must be true');
  if (preferences['webSecurity'] === false) problems.push('webSecurity must be true');
  if (problems.length > 0) throw new Error(`Insecure window: ${problems.join('; ')}`);
}
