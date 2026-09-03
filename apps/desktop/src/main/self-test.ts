/**
 * The startup proof, run inside the real main process.
 *
 * `node:sqlite` is the one thing this architecture could not survive losing
 * quietly: it is what lets the application ship without a native module, an
 * `electron-rebuild` step or a prebuild per architecture. So the proof is not
 * a one-off script - it is a mode of the application itself
 * (`--self-test`), which means the exact same code runs under `npm run dev`
 * and inside the packaged executable, where the asar archive and the bundled
 * Node are the real risk.
 *
 * It exercises the same `Database` the product uses, not a toy connection, so
 * a passing self-test says the migrations ran too.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/database/database.js';
import { NodeSqliteDriver } from '../../../../src/database/node-sqlite-driver.js';
import { nodeSqliteAvailable } from '../../../../src/database/driver.js';

export interface SelfTestStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SelfTestReport {
  ok: boolean;
  packaged: boolean;
  versions: { electron: string; node: string; chrome: string; sqlite: string };
  steps: SelfTestStep[];
}

/**
 * Runs the SQLite proof against a throwaway database file.
 *
 * A temporary directory is used rather than the real one so the check can run
 * on a machine that already has data, and so a failure cannot damage it.
 */
export async function runSelfTest(options: { packaged: boolean }): Promise<SelfTestReport> {
  const steps: SelfTestStep[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'ai-orchestrator-selftest-'));
  const file = join(dir, 'selftest.db');

  const step = (name: string, fn: () => string): boolean => {
    try {
      steps.push({ name, ok: true, detail: fn() });
      return true;
    } catch (err) {
      steps.push({ name, ok: false, detail: (err as Error).message });
      return false;
    }
  };

  let database: Database | null = null;

  try {
    if (
      step('node:sqlite disponivel', () => {
        if (!nodeSqliteAvailable()) throw new Error('node:sqlite is not exposed by this runtime');
        return 'yes';
      }) &&
      step('abrir banco', () => {
        database = new Database({ driver: new NodeSqliteDriver(file) });
        return file;
      }) &&
      step('migrations', () => {
        const db = database as unknown as Database;
        const applied = db.schemaVersion;
        if (applied !== db.expectedSchemaVersion) {
          throw new Error(`schema is at ${applied}, expected ${db.expectedSchemaVersion}`);
        }
        return `schema ${applied}`;
      }) &&
      step('WAL', () => {
        const db = database as unknown as Database;
        const mode = db.driver.get<{ journal_mode: string }>('PRAGMA journal_mode');
        if (mode?.journal_mode?.toLowerCase() !== 'wal') {
          throw new Error(`journal_mode is ${mode?.journal_mode ?? 'unknown'}`);
        }
        return 'wal';
      }) &&
      step('prepared statement + INSERT', () => {
        const db = database as unknown as Database;
        const result = db.driver.run(
          'INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)',
          ['self-test', 'ok', new Date().toISOString()],
        );
        if (result.changes !== 1) throw new Error(`expected 1 row, wrote ${result.changes}`);
        return '1 row';
      }) &&
      step('SELECT', () => {
        const db = database as unknown as Database;
        const row = db.driver.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
          'self-test',
        ]);
        if (row?.value !== 'ok') throw new Error('the row did not come back');
        return 'value=ok';
      }) &&
      step('transaction', () => {
        const db = database as unknown as Database;
        db.transaction(() => {
          db.settings.set('self-test-tx-a', '1');
          db.settings.set('self-test-tx-b', '2');
        });
        try {
          db.transaction(() => {
            db.settings.set('self-test-tx-c', '3');
            throw new Error('rolled back on purpose');
          });
        } catch {
          /* expected */
        }
        const committed = db.settings.get('self-test-tx-b');
        const rolledBack = db.settings.get('self-test-tx-c');
        if (committed !== '2') throw new Error('a committed transaction did not persist');
        if (rolledBack !== null) throw new Error('a failed transaction was not rolled back');
        return 'commit and rollback both behaved';
      }) &&
      step('fechar banco', () => {
        (database as unknown as Database).close();
        database = null;
        return 'closed';
      })
    ) {
      step('reabrir e ler', () => {
        const reopened = new Database({ driver: new NodeSqliteDriver(file) });
        const value = reopened.settings.get('self-test');
        reopened.close();
        if (value !== 'ok') throw new Error('the data did not survive a reopen');
        return 'persisted';
      });
    }
  } finally {
    try {
      (database as Database | null)?.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  }

  return {
    ok: steps.every((s) => s.ok),
    packaged: options.packaged,
    versions: {
      electron: process.versions.electron ?? 'n/a',
      node: process.versions.node,
      chrome: process.versions.chrome ?? 'n/a',
      sqlite: process.versions.sqlite ?? 'n/a',
    },
    steps,
  };
}

/** Marker the packaging check greps for. Kept stable on purpose. */
export const SELF_TEST_MARKER = 'AI_ORCHESTRATOR_SELF_TEST';

export function formatSelfTest(report: SelfTestReport): string {
  return `${SELF_TEST_MARKER} ${JSON.stringify(report)}`;
}
