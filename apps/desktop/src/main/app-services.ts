/**
 * Everything the main process owns, assembled once.
 *
 * The renderer holds none of this. `Database`, `RuntimeManager`,
 * `ProcessManager` and `ClaudeAccountManager` live here, behind services that
 * the IPC router calls; the only thing that crosses the bridge is data.
 *
 * Nothing in this file imports Electron. The bits that need it - opening a
 * browser, pushing an event to a window - are injected by the Electron entry
 * point, which keeps the whole surface testable in the ordinary suite.
 */

import { ClaudeAccountManager } from '../../../../src/accounts/claude-account-manager.js';
import { Database } from '../../../../src/database/database.js';
import { ProcessManager } from '../../../../src/process/process-manager.js';
import { RuntimeManager } from '../../../../src/runtime/runtime-manager.js';
import { ensureAppPaths, appPaths, type AppPaths } from '../../../../src/runtime/paths.js';
import type {
  AppInfo,
  BootstrapState,
  InstallProgressEvent,
  LoginProgressEvent,
} from '../shared/ipc-contract.js';
import { AccountService } from './services/account-service.js';
import { RuntimeService } from './services/runtime-service.js';

export interface BootstrapOptions {
  /** Application name and version, read from Electron in production. */
  appName: string;
  appVersion: string;
  /** Pushes an event to the interface. */
  emit: (channel: 'runtime:progress', event: InstallProgressEvent) => void;
  emitLogin: (channel: 'accounts:loginProgress', event: LoginProgressEvent) => void;
  /** Opens a URL in the system browser (`shell.openExternal`). */
  openExternal: (url: string) => void | Promise<void>;
  /** Where diagnostic lines go. Never the interface. */
  log?: (line: string) => void;
  paths?: AppPaths;
  developerMode?: boolean;
}

export class AppServices {
  readonly paths: AppPaths;
  readonly database: Database;
  readonly runtimeManager: RuntimeManager;
  readonly processManager: ProcessManager;
  readonly claudeAccounts: ClaudeAccountManager;
  readonly runtime: RuntimeService;
  readonly accounts: AccountService;
  readonly log: (line: string) => void;

  private readonly appName: string;
  private readonly appVersion: string;
  private readonly bootstrap: BootstrapState;

  constructor(options: BootstrapOptions) {
    this.appName = options.appName;
    this.appVersion = options.appVersion;
    this.log = options.log ?? (() => {});

    this.paths = ensureAppPaths(options.paths ?? appPaths());
    this.processManager = new ProcessManager();
    this.runtimeManager = new RuntimeManager({ paths: this.paths });
    this.claudeAccounts = new ClaudeAccountManager({
      runtimeManager: this.runtimeManager,
      paths: this.paths,
      processManager: this.processManager,
    });

    // The database is opened before the window exists, so a failure is a
    // state the first screen can render rather than a crash on startup.
    let database: Database;
    let bootstrap: BootstrapState;
    try {
      database = new Database({ paths: this.paths });
      bootstrap = { databaseReady: true, schemaVersion: database.schemaVersion };
    } catch (err) {
      this.log(`bootstrap: database unavailable: ${(err as Error).message}`);
      throw err;
    }
    this.database = database;
    this.bootstrap = bootstrap;

    this.runtime = new RuntimeService({
      runtimeManager: this.runtimeManager,
      emitProgress: (event) => options.emit('runtime:progress', event),
      developerMode: options.developerMode ?? false,
    });

    this.accounts = new AccountService({
      database: this.database,
      claudeAccounts: this.claudeAccounts,
      emitLoginProgress: (event) => options.emitLogin('accounts:loginProgress', event),
      openExternal: options.openExternal,
    });
  }

  appInfo(): AppInfo {
    return {
      name: this.appName,
      version: this.appVersion,
      platform: process.platform,
      arch: process.arch,
      versions: {
        electron: process.versions.electron ?? 'n/a',
        node: process.versions.node,
        chrome: process.versions.chrome ?? 'n/a',
        sqlite: process.versions.sqlite ?? 'n/a',
      },
    };
  }

  bootstrapState(): BootstrapState {
    return { ...this.bootstrap, schemaVersion: this.database.schemaVersion };
  }

  /** Called on quit. Leaves no sign-in or install process behind. */
  async dispose(): Promise<void> {
    await this.processManager.cancelAll(3000).catch(() => undefined);
    try {
      this.database.close();
    } catch {
      /* already closed */
    }
  }
}
