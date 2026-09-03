/**
 * The application's private folder layout.
 *
 *   %LOCALAPPDATA%\AI-Orchestrator\
 *     runtimes\   codex\  claude-code\  git\
 *     profiles\   <account-id>\          <- becomes CLAUDE_CONFIG_DIR
 *     data\       SQLite and other state
 *     logs\
 *     artifacts\
 *     updates\
 *     staging\    downloads in flight, never a half-installed runtime
 *
 * The user never needs to know any of these exist.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RuntimeId } from './types.js';

export const APP_FOLDER_NAME = 'AI-Orchestrator';

/**
 * Root of the application's private data.
 *
 * Windows uses `%LOCALAPPDATA%`, which is per-user and needs no administrator
 * rights - the installer targets the same place, so nothing ever prompts for
 * elevation. The other platforms follow their own conventions so the code is
 * runnable and testable during development.
 */
export function appDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AI_ORCHESTRATOR_HOME;
  if (override) return resolve(override);

  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(localAppData, APP_FOLDER_NAME);
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_FOLDER_NAME);
  }
  const xdg = env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(xdg, APP_FOLDER_NAME);
}

export interface AppPaths {
  root: string;
  runtimes: string;
  profiles: string;
  data: string;
  logs: string;
  artifacts: string;
  updates: string;
  staging: string;
}

export function appPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const root = appDataRoot(env);
  return {
    root,
    runtimes: join(root, 'runtimes'),
    profiles: join(root, 'profiles'),
    data: join(root, 'data'),
    logs: join(root, 'logs'),
    artifacts: join(root, 'artifacts'),
    updates: join(root, 'updates'),
    staging: join(root, 'staging'),
  };
}

/** Creates every directory the application expects. Idempotent. */
export function ensureAppPaths(paths: AppPaths = appPaths()): AppPaths {
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  return paths;
}

/** Install directory for one managed runtime. */
export function runtimeDir(runtimeId: RuntimeId, paths: AppPaths = appPaths()): string {
  return join(paths.runtimes, runtimeId);
}

/** Where a runtime's manifest lives. Its presence marks a completed install. */
export function runtimeManifestPath(runtimeId: RuntimeId, paths: AppPaths = appPaths()): string {
  return join(runtimeDir(runtimeId, paths), 'runtime.json');
}

/** Config directory for one Claude Code account. Always absolute. */
export function accountProfileDir(accountId: string, paths: AppPaths = appPaths()): string {
  return join(paths.profiles, accountId);
}
