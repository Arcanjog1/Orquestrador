/**
 * `SqlDriver` implemented over `node:sqlite`.
 *
 * Chosen because it ships inside Node: no native module to rebuild against
 * Electron's ABI, no per-architecture prebuilds to distribute, nothing extra in
 * the installer. If a host turns out not to expose it, only this file is
 * replaced - see `driver.ts` for the seam.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DatabaseUnavailableError,
  loadNodeSqlite,
  type SqlDriver,
  type SqlRow,
  type SqlValue,
} from './driver.js';

interface NodeSqliteStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
}

interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

export class NodeSqliteDriver implements SqlDriver {
  private readonly db: NodeSqliteDatabase;
  private transactionDepth = 0;

  constructor(filePath: string) {
    let DatabaseSync: new (path: string) => NodeSqliteDatabase;
    try {
      const sqlite = loadNodeSqlite() as {
        DatabaseSync: new (path: string) => NodeSqliteDatabase;
      };
      DatabaseSync = sqlite.DatabaseSync;
    } catch (err) {
      throw new DatabaseUnavailableError(
        'Não foi possível abrir o banco de dados local.',
        'Reinstalar o aplicativo',
        `node:sqlite is unavailable: ${(err as Error).message}`,
      );
    }

    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);

    // WAL keeps readers from blocking the writer, which matters once the UI
    // reads while a run is writing. Foreign keys are off by default in SQLite.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: readonly SqlValue[] = []): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.db.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  all<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  /** Nested calls join the outer transaction via savepoints. */
  transaction<T>(fn: () => T): T {
    const savepoint = `sp_${this.transactionDepth}`;
    const outermost = this.transactionDepth === 0;
    this.db.exec(outermost ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = fn();
      this.transactionDepth -= 1;
      this.db.exec(outermost ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      this.transactionDepth -= 1;
      this.db.exec(outermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
