/**
 * `SqlDriver` implemented over `node:sqlite`.
 *
 * Chosen because it ships inside Node: no native module to rebuild against
 * Electron's ABI, no per-architecture prebuilds to distribute, nothing extra in
 * the installer. If a host turns out not to expose it, only this file is
 * replaced - see `driver.ts` for the seam.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseUnavailableError } from './driver.js';
export class NodeSqliteDriver {
    db;
    transactionDepth = 0;
    constructor(filePath) {
        let DatabaseSync;
        try {
            const sqlite = createRequire(import.meta.url)('node:sqlite');
            DatabaseSync = sqlite.DatabaseSync;
        }
        catch (err) {
            throw new DatabaseUnavailableError('Não foi possível abrir o banco de dados local.', 'Reinstalar o aplicativo', `node:sqlite is unavailable: ${err.message}`);
        }
        if (filePath !== ':memory:')
            mkdirSync(dirname(filePath), { recursive: true });
        this.db = new DatabaseSync(filePath);
        // WAL keeps readers from blocking the writer, which matters once the UI
        // reads while a run is writing. Foreign keys are off by default in SQLite.
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA foreign_keys = ON');
        this.db.exec('PRAGMA busy_timeout = 5000');
    }
    exec(sql) {
        this.db.exec(sql);
    }
    run(sql, params = []) {
        const result = this.db.prepare(sql).run(...params);
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    }
    all(sql, params = []) {
        return this.db.prepare(sql).all(...params);
    }
    get(sql, params = []) {
        return this.db.prepare(sql).get(...params);
    }
    /** Nested calls join the outer transaction via savepoints. */
    transaction(fn) {
        const savepoint = `sp_${this.transactionDepth}`;
        const outermost = this.transactionDepth === 0;
        this.db.exec(outermost ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
        this.transactionDepth += 1;
        try {
            const result = fn();
            this.transactionDepth -= 1;
            this.db.exec(outermost ? 'COMMIT' : `RELEASE ${savepoint}`);
            return result;
        }
        catch (err) {
            this.transactionDepth -= 1;
            this.db.exec(outermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
            throw err;
        }
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=node-sqlite-driver.js.map