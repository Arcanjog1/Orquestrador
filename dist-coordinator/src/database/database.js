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
import { DatabaseUnavailableError } from './driver.js';
import { AccountRepository, AgentRepository, ChatRepository, CloudWorkspaceRepository, ProviderRepository, RunRepository, VerificationDefinitionRepository, WorkspaceRepository, ProjectRepository, } from './repositories.js';
import { appPaths } from '../runtime/paths.js';
export const DATABASE_FILENAME = 'orchestrator.db';
export class Database {
    driver;
    constructor(options = {}) {
        const paths = options.paths ?? appPaths();
        this.driver =
            options.driver ?? new NodeSqliteDriver(options.filePath ?? join(paths.data, DATABASE_FILENAME));
        this.migrate();
    }
    /** Applies pending migrations in order, recording each one. */
    migrate() {
        this.driver.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
        const applied = new Set(this.driver.all('SELECT id FROM schema_migrations').map((row) => row.id));
        for (const migration of MIGRATIONS) {
            if (applied.has(migration.id))
                continue;
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
    get schemaVersion() {
        const row = this.driver.get('SELECT MAX(id) AS id FROM schema_migrations');
        return row?.id ?? 0;
    }
    get expectedSchemaVersion() {
        return SCHEMA_VERSION;
    }
    /** Runs several writes as one unit. */
    transaction(fn) {
        return this.driver.transaction(fn);
    }
    close() {
        this.driver.close();
    }
    // -- Repositories --------------------------------------------------------
    runtimeInstallations = new RuntimeInstallationRepository(() => this.driver);
    settings = new SettingsRepository(() => this.driver);
    providers = new ProviderRepository(() => this.driver);
    accounts = new AccountRepository(() => this.driver);
    agents = new AgentRepository(() => this.driver);
    workspaces = new WorkspaceRepository(() => this.driver);
    chat = new ChatRepository(() => this.driver);
    projects = new ProjectRepository(() => this.driver);
    runs = new RunRepository(() => this.driver);
    verifications = new VerificationDefinitionRepository(() => this.driver);
    cloudWorkspaces = new CloudWorkspaceRepository(() => this.driver);
}
/** Shared helpers for the repositories. */
class Repository {
    getDriver;
    constructor(getDriver) {
        this.getDriver = getDriver;
    }
    get db() {
        return this.getDriver();
    }
}
/**
 * The record of what is installed, where it came from and how far it is trusted.
 *
 * Kept as history rather than a single row: when an update is rolled back, the
 * story of what happened is worth having in the developer view.
 */
export class RuntimeInstallationRepository extends Repository {
    /** Records a completed install and marks any earlier one as superseded. */
    record(manifest, health) {
        return this.db.transaction(() => {
            this.db.run("UPDATE runtime_installations SET update_status = 'superseded', superseded_at = ? WHERE runtime_id = ? AND update_status = 'current'", [new Date().toISOString(), manifest.runtimeId]);
            const result = this.db.run(`INSERT INTO runtime_installations (
           runtime_id, version, source_id, source_label, contract, trust_level,
           integrity_strategy, integrity_verified, integrity_detail, observed_publisher,
           url, host, platform, arch, bytes, sha256, executable_path, license_files,
           previous_version, update_status, health_status, health_detail, installed_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'current',?,?,?)`, [
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
            ]);
            return Number(result.lastInsertRowid);
        });
    }
    /** The installation currently in use for a runtime. */
    current(runtimeId) {
        return this.db.get("SELECT * FROM runtime_installations WHERE runtime_id = ? AND update_status = 'current' ORDER BY installed_at DESC LIMIT 1", [runtimeId]);
    }
    history(runtimeId, limit = 20) {
        return this.db.all('SELECT * FROM runtime_installations WHERE runtime_id = ? ORDER BY installed_at DESC LIMIT ?', [runtimeId, limit]);
    }
    /** Marks the current row as rolled back and reinstates the previous one. */
    recordRollback(runtimeId, restoredVersion) {
        this.db.transaction(() => {
            this.db.run("UPDATE runtime_installations SET update_status = 'rolled-back', superseded_at = ? WHERE runtime_id = ? AND update_status = 'current'", [new Date().toISOString(), runtimeId]);
            this.db.run("UPDATE runtime_installations SET update_status = 'current', superseded_at = NULL WHERE id = (SELECT id FROM runtime_installations WHERE runtime_id = ? AND version = ? ORDER BY installed_at DESC LIMIT 1)", [runtimeId, restoredVersion]);
        });
    }
    /** Installations that could not prove what they served. */
    unverified() {
        return this.db.all("SELECT * FROM runtime_installations WHERE trust_level = 'UNVERIFIED_BINARY_SOURCE' AND update_status = 'current'");
    }
}
export class SettingsRepository extends Repository {
    get(key) {
        return this.db.get('SELECT value FROM settings WHERE key = ?', [key])?.value ?? null;
    }
    set(key, value) {
        this.db.run('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [key, value, new Date().toISOString()]);
    }
    remove(key) {
        return Number(this.db.run('DELETE FROM settings WHERE key = ?', [key]).changes) > 0;
    }
    all() {
        const rows = this.db.all('SELECT key, value FROM settings');
        return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    }
}
export { DatabaseUnavailableError };
export * from './repositories.js';
//# sourceMappingURL=database.js.map