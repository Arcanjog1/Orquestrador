/**
 * The services Main owns, built once and shared by every IPC handler.
 *
 * Nothing here is new machinery: `RuntimeManager`, `Database`,
 * `ClaudeAccountManager` and `ProcessManager` already exist and already solve
 * their problems. This module only decides when they are constructed and keeps
 * the failure of one from taking down the rest - the interface has to be able
 * to render and explain a broken database, not disappear behind it.
 */

import { randomUUID } from 'node:crypto';
import { Database } from '../database/database.js';
import { ClaudeAccountManager } from '../accounts/claude-account-manager.js';
import { ProcessManager } from '../process/process-manager.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import { ensureAppPaths, appPaths, type AppPaths } from '../runtime/paths.js';

/** Vendors the application knows how to talk to. */
const KNOWN_PROVIDERS = [
  { id: 'openai', displayName: 'OpenAI' },
  { id: 'anthropic', displayName: 'Anthropic' },
  { id: 'google', displayName: 'Google' },
];

export class Services {
  readonly paths: AppPaths;
  readonly processManager: ProcessManager;
  readonly runtimeManager: RuntimeManager;
  readonly claudeAccounts: ClaudeAccountManager;

  private db: Database | null = null;
  /** Set when the database could not be opened, so the UI can say why. */
  databaseProblem: string | undefined;

  /** Sign-ins in flight, so the interface can cancel one it started. */
  readonly logins = new Map<string, AbortController>();

  constructor() {
    this.paths = ensureAppPaths(appPaths());
    this.processManager = new ProcessManager();
    this.runtimeManager = new RuntimeManager({ paths: this.paths, processManager: this.processManager });
    this.claudeAccounts = new ClaudeAccountManager({
      runtimeManager: this.runtimeManager,
      paths: this.paths,
      processManager: this.processManager,
    });

    try {
      this.db = new Database({ paths: this.paths });
      this.db.providers.ensure(KNOWN_PROVIDERS);
    } catch (error) {
      this.db = null;
      this.databaseProblem =
        error instanceof Error ? error.message : 'O banco de dados local não pôde ser aberto.';
    }
  }

  /**
   * The database, or a thrown error naming the problem.
   *
   * Handlers that need it call this; handlers that do not (runtime diagnosis,
   * for one) keep working when SQLite is unavailable.
   */
  database(): Database {
    if (!this.db) {
      throw new Error(this.databaseProblem ?? 'O banco de dados local não está disponível.');
    }
    return this.db;
  }

  get databaseAvailable(): boolean {
    return this.db !== null;
  }

  newId(): string {
    return randomUUID();
  }

  async dispose(): Promise<void> {
    for (const controller of this.logins.values()) controller.abort();
    this.logins.clear();
    await this.processManager.cancelAll();
    this.db?.close();
    this.db = null;
  }
}
