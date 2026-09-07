/**
 * The database facade and its repositories.
 *
 * Callers depend on this surface, never on SQL or on a particular SQLite
 * binding. Swapping the driver is a one-file change (`driver.ts`), which is the
 * point: SQLite packaging under Electron is the piece most likely to move.
 */

import { join } from 'node:path';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';
import { NodeSqliteDriver } from './node-sqlite-driver.js';
import { DatabaseUnavailableError, type SqlDriver, type SqlRow, type SqlValue } from './driver.js';
import {
  AccountRepository,
  AgentRepository,
  ChatRepository,
  CloudWorkspaceRepository,
  ProviderRepository,
  RunRepository,
  VerificationDefinitionRepository,
  WorkspaceRepository,
  ProjectRepository,
} from './repositories.js';
import { appPaths, type AppPaths } from '../runtime/paths.js';
import type { RuntimeManifest } from '../runtime/types.js';

export const DATABASE_FILENAME = 'orchestrator.db';

export interface DatabaseOptions {
  paths?: AppPaths;
  /** Overrides the driver. `:memory:` is handy for tests. */
  driver?: SqlDriver;
  filePath?: string;
}

export class Database {
  readonly driver: SqlDriver;

  constructor(options: DatabaseOptions = {}) {
    const paths = options.paths ?? appPaths();
    this.driver =
      options.driver ?? new NodeSqliteDriver(options.filePath ?? join(paths.data, DATABASE_FILENAME));
    this.migrate();
  }

  /** Applies pending migrations in order, recording each one. */
  migrate(): void {
    this.driver.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    const applied = new Set(
      this.driver.all<{ id: number }>('SELECT id FROM schema_migrations').map((row) => row.id),
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      this.driver.transaction(() => {
        this.driver.exec(migration.sql);
        this.driver.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
          migration.id,
          migration.name,
          new Date().toISOString(),
        ]);
      });
    }
  }

  get schemaVersion(): number {
    const row = this.driver.get<{ id: number }>('SELECT MAX(id) AS id FROM schema_migrations');
    return row?.id ?? 0;
  }

  get expectedSchemaVersion(): number {
    return SCHEMA_VERSION;
  }

  /** Runs several writes as one unit. */
  transaction<T>(fn: () => T): T {
    return this.driver.transaction(fn);
  }

  close(): void {
    this.driver.close();
  }

  // -- Repositories --------------------------------------------------------

  readonly runtimeInstallations = new RuntimeInstallationRepository(() => this.driver);
  readonly settings = new SettingsRepository(() => this.driver);
  readonly providers = new ProviderRepository(() => this.driver);
  readonly accounts = new AccountRepository(() => this.driver);
  readonly agents = new AgentRepository(() => this.driver);
  readonly workspaces = new WorkspaceRepository(() => this.driver);
  readonly chat = new ChatRepository(() => this.driver);
  readonly projects = new ProjectRepository(() => this.driver);
  readonly runs = new RunRepository(() => this.driver);
  readonly verifications = new VerificationDefinitionRepository(() => this.driver);
  readonly cloudWorkspaces = new CloudWorkspaceRepository(() => this.driver);
}

/** Shared helpers for the repositories. */
abstract class Repository {
  constructor(protected readonly getDriver: () => SqlDriver) {}
  protected get db(): SqlDriver {
    return this.getDriver();
  }
}

export interface RuntimeInstallationRecord extends SqlRow {
  id: number;
  runtime_id: string;
  version: string;
  source_id: string;
  trust_level: string;
  contract: string;
  integrity_verified: number;
  health_status: string;
  update_status: string;
  installed_at: string;
  previous_version: string | null;
}

/**
 * The record of what is installed, where it came from and how far it is trusted.
 *
 * Kept as history rather than a single row: when an update is rolled back, the
 * story of what happened is worth having in the developer view.
 */
export class RuntimeInstallationRepository extends Repository {
  /** Records a completed install and marks any earlier one as superseded. */
  record(manifest: RuntimeManifest, health: { healthy: boolean; problem?: string }): number {
    return this.db.transaction(() => {
      this.db.run(
        "UPDATE runtime_installations SET update_status = 'superseded', superseded_at = ? WHERE runtime_id = ? AND update_status = 'current'",
        [new Date().toISOString(), manifest.runtimeId],
      );

      const result = this.db.run(
        `INSERT INTO runtime_installations (
           runtime_id, version, source_id, source_label, contract, trust_level,
           integrity_strategy, integrity_verified, integrity_detail, observed_publisher,
           url, host, platform, arch, bytes, sha256, executable_path, license_files,
           previous_version, update_status, health_status, health_detail, installed_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'current',?,?,?)`,
        [
          manifest.runtimeId,
          manifest.version,
          manifest.sourceId,
          manifest.sourceLabel,
          manifest.contract,
          manifest.trustLevel,
          manifest.integrity.strategy,
          manifest.integrity.verified ? 1 : 0,
          manifest.integrity.detail,
          manifest.integrity.observedPublisher ?? null,
          manifest.url,
          manifest.host,
          manifest.platform,
          manifest.arch,
          manifest.bytes,
          manifest.sha256,
          manifest.executableRelativePath,
          manifest.licenseFiles ? JSON.stringify(manifest.licenseFiles) : null,
          manifest.previousVersion ?? null,
          health.healthy ? 'healthy' : 'unhealthy',
          health.problem ?? null,
          manifest.installedAt,
        ] as SqlValue[],
      );
      return Number(result.lastInsertRowid);
    });
  }

  /** The installation currently in use for a runtime. */
  current(runtimeId: string): RuntimeInstallationRecord | undefined {
    return this.db.get<RuntimeInstallationRecord>(
      "SELECT * FROM runtime_installations WHERE runtime_id = ? AND update_status = 'current' ORDER BY installed_at DESC LIMIT 1",
      [runtimeId],
    );
  }

  history(runtimeId: string, limit = 20): RuntimeInstallationRecord[] {
    return this.db.all<RuntimeInstallationRecord>(
      'SELECT * FROM runtime_installations WHERE runtime_id = ? ORDER BY installed_at DESC LIMIT ?',
      [runtimeId, limit],
    );
  }

  /** Marks the current row as rolled back and reinstates the previous one. */
  recordRollback(runtimeId: string, restoredVersion: string): void {
    this.db.transaction(() => {
      this.db.run(
        "UPDATE runtime_installations SET update_status = 'rolled-back', superseded_at = ? WHERE runtime_id = ? AND update_status = 'current'",
        [new Date().toISOString(), runtimeId],
      );
      this.db.run(
        "UPDATE runtime_installations SET update_status = 'current', superseded_at = NULL WHERE id = (SELECT id FROM runtime_installations WHERE runtime_id = ? AND version = ? ORDER BY installed_at DESC LIMIT 1)",
        [runtimeId, restoredVersion],
      );
    });
  }

  /** Installations that could not prove what they served. */
  unverified(): RuntimeInstallationRecord[] {
    return this.db.all<RuntimeInstallationRecord>(
      "SELECT * FROM runtime_installations WHERE trust_level = 'UNVERIFIED_BINARY_SOURCE' AND update_status = 'current'",
    );
  }
}

export class SettingsRepository extends Repository {
  get(key: string): string | null {
    return this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, value, new Date().toISOString()],
    );
  }

  remove(key: string): boolean {
    return Number(this.db.run('DELETE FROM settings WHERE key = ?', [key]).changes) > 0;
  }

  all(): Record<string, string> {
    const rows = this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
}

export { DatabaseUnavailableError };
export * from './repositories.js';
export type { SqlDriver, SqlRow, SqlValue };
