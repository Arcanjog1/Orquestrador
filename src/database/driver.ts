/**
 * The SQL driver seam.
 *
 * Everything above this interface - repositories, orchestrator core, agents,
 * workspaces, the UI - depends only on `SqlDriver`. Which SQLite binding sits
 * underneath is an implementation detail that can be replaced without touching
 * any of them, which matters because the packaging story for SQLite under
 * Electron is the part most likely to need changing.
 */

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqlDriver {
  /** Runs statements with no result: DDL, PRAGMA, migrations. */
  exec(sql: string): void;
  /** Runs a parameterised statement and reports what it changed. */
  run(sql: string, params?: readonly SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  /** Returns every matching row. */
  all<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): T[];
  /** Returns the first matching row, or undefined. */
  get<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): T | undefined;
  /** Runs `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export class DatabaseUnavailableError extends Error {
  constructor(
    readonly userMessage: string,
    readonly remedy: string,
    detail?: string,
  ) {
    super(`${userMessage}${detail ? ` (${detail})` : ''}`);
    this.name = 'DatabaseUnavailableError';
  }
}

/** The slice of `node:sqlite` this project uses. */
export interface NodeSqliteModule {
  DatabaseSync: new (path: string) => unknown;
}

/**
 * Loads `node:sqlite` without caring how this file was packaged.
 *
 * `process.getBuiltinModule` is used first and deliberately:
 * `createRequire(import.meta.url)` works under plain Node but breaks the
 * moment the main process is bundled to CommonJS, where a bundler replaces
 * `import.meta` with an empty object and the require is handed `undefined`.
 * That failure looked exactly like "Electron has no node:sqlite", which it
 * was not. `getBuiltinModule` is a plain function on `process`, so it is
 * identical in ESM, in CommonJS and inside an asar archive.
 */
export function loadNodeSqlite(): NodeSqliteModule {
  const fromProcess = (
    process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule?.('node:sqlite') as NodeSqliteModule | undefined;
  if (fromProcess?.DatabaseSync) return fromProcess;

  // Hosts older than the one this project targets. Kept as a fallback rather
  // than as the primary path, for the reason above.
  return createRequire(import.meta.url)('node:sqlite') as NodeSqliteModule;
}

/**
 * Whether the Node build running this process exposes `node:sqlite`.
 *
 * This is the packaging-safest option available: it is part of Node itself, so
 * there is no native module to rebuild against Electron's ABI and no prebuilt
 * binary to ship per architecture. It is checked at runtime rather than
 * assumed, because availability depends on which Node the host embeds.
 */
export function nodeSqliteAvailable(): boolean {
  try {
    return typeof loadNodeSqlite()?.DatabaseSync === 'function';
  } catch {
    return false;
  }
}

import { createRequire } from 'node:module';
