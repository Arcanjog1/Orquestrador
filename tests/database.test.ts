import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/database/database.js';
import { NodeSqliteDriver } from '../src/database/node-sqlite-driver.js';
import { nodeSqliteAvailable } from '../src/database/driver.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/database/schema.js';
import type { RuntimeManifest } from '../src/runtime/types.js';

function memoryDb(): Database {
  return new Database({ driver: new NodeSqliteDriver(':memory:') });
}

function manifest(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    runtimeId: 'codex',
    version: '0.153.0',
    sourceId: 'codex-official-release',
    sourceLabel: 'Canal oficial',
    contract: 'DOCUMENTED',
    url: 'https://example.invalid/codex.zip',
    host: 'example.invalid',
    platform: 'win32',
    arch: 'x64',
    bytes: 1234,
    sha256: 'a'.repeat(64),
    integrity: {
      strategy: 'SHA256',
      trustLevel: 'VERIFIED',
      verified: true,
      detail: 'SHA-256 conferido.',
    },
    trustLevel: 'VERIFIED',
    executableRelativePath: join('bin', 'codex.exe'),
    installedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

test('node:sqlite is available, so no native module has to be shipped', () => {
  assert.equal(nodeSqliteAvailable(), true);
});

test('migrations bring an empty database to the current schema version', () => {
  const db = memoryDb();
  try {
    assert.equal(db.schemaVersion, SCHEMA_VERSION);
    assert.equal(db.expectedSchemaVersion, SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test('migrating twice is a no-op, so reopening never rebuilds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lao-db-'));
  try {
    const file = join(dir, 'data', 'test.db');
    const first = new Database({ filePath: file });
    first.settings.set('theme', 'dark');
    first.close();

    const second = new Database({ filePath: file });
    assert.equal(second.schemaVersion, SCHEMA_VERSION);
    assert.equal(second.settings.get('theme'), 'dark', 'existing data must survive');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every entity the product needs exists', () => {
  const db = memoryDb();
  try {
    const tables = db.driver
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r.name);

    for (const expected of [
      'providers',
      'accounts',
      'agents',
      'workspaces',
      'workspace_agents',
      'chat_sessions',
      'messages',
      'runs',
      'run_steps',
      'agent_invocations',
      'artifacts',
      'verification_definitions',
      'verification_results',
      'runtime_installations',
      'settings',
    ]) {
      assert.ok(tables.includes(expected), `missing table: ${expected}`);
    }
  } finally {
    db.close();
  }
});

test('foreign keys are enforced, so orphan rows cannot be written', () => {
  const db = memoryDb();
  try {
    assert.throws(
      () =>
        db.driver.run(
          'INSERT INTO accounts (id, provider_id, display_name, profile_directory, auth_state, created_at) VALUES (?,?,?,?,?,?)',
          ['a1', 'no-such-provider', 'X', '/tmp/x', 'disconnected', '2026-09-01'],
        ),
      /FOREIGN KEY/i,
    );
  } finally {
    db.close();
  }
});

test('a failed transaction leaves nothing behind', () => {
  const db = memoryDb();
  try {
    assert.throws(() =>
      db.transaction(() => {
        db.settings.set('a', '1');
        throw new Error('boom');
      }),
    );
    assert.equal(db.settings.get('a'), null, 'the write must have rolled back');
  } finally {
    db.close();
  }
});

test('records a runtime installation with its provenance and trust level', () => {
  const db = memoryDb();
  try {
    db.runtimeInstallations.record(manifest(), { healthy: true });

    const current = db.runtimeInstallations.current('codex');
    assert.equal(current?.version, '0.153.0');
    assert.equal(current?.trust_level, 'VERIFIED');
    assert.equal(current?.contract, 'DOCUMENTED');
    assert.equal(current?.integrity_verified, 1);
    assert.equal(current?.health_status, 'healthy');
    assert.equal(current?.update_status, 'current');
  } finally {
    db.close();
  }
});

test('installing a new version supersedes the old one but keeps the history', () => {
  const db = memoryDb();
  try {
    db.runtimeInstallations.record(manifest({ version: '0.152.0' }), { healthy: true });
    db.runtimeInstallations.record(
      manifest({ version: '0.153.0', previousVersion: '0.152.0', installedAt: '2026-09-02T10:00:00.000Z' }),
      { healthy: true },
    );

    const current = db.runtimeInstallations.current('codex');
    assert.equal(current?.version, '0.153.0');
    assert.equal(current?.previous_version, '0.152.0');

    const history = db.runtimeInstallations.history('codex');
    assert.equal(history.length, 2, 'the previous install is kept for the developer view');
    assert.equal(history[1]?.update_status, 'superseded');
  } finally {
    db.close();
  }
});

test('a rollback is recorded, so a substitution is never silent', () => {
  const db = memoryDb();
  try {
    db.runtimeInstallations.record(manifest({ version: '0.152.0' }), { healthy: true });
    db.runtimeInstallations.record(
      manifest({ version: '0.153.0', installedAt: '2026-09-02T10:00:00.000Z' }),
      { healthy: false, problem: 'did not answer' },
    );

    db.runtimeInstallations.recordRollback('codex', '0.152.0');

    assert.equal(db.runtimeInstallations.current('codex')?.version, '0.152.0');
    const rolled = db.runtimeInstallations
      .history('codex')
      .find((row) => row.version === '0.153.0');
    assert.equal(rolled?.update_status, 'rolled-back');
  } finally {
    db.close();
  }
});

test('an unverified install is queryable, so the UI can flag it', () => {
  const db = memoryDb();
  try {
    db.runtimeInstallations.record(
      manifest({
        runtimeId: 'claude-code',
        trustLevel: 'UNVERIFIED_BINARY_SOURCE',
        integrity: {
          strategy: 'HTTPS_ONLY_LAST_RESORT',
          trustLevel: 'UNVERIFIED_BINARY_SOURCE',
          verified: false,
          detail: 'Nenhum checksum publicado.',
        },
      }),
      { healthy: true },
    );
    db.runtimeInstallations.record(manifest(), { healthy: true });

    const unverified = db.runtimeInstallations.unverified();
    assert.equal(unverified.length, 1);
    assert.equal(unverified[0]?.runtime_id, 'claude-code');
  } finally {
    db.close();
  }
});

test('licence files are stored alongside the installation record', () => {
  const db = memoryDb();
  try {
    db.runtimeInstallations.record(
      manifest({ runtimeId: 'git', licenseFiles: ['LICENSE.txt', join('doc', 'COPYING')] }),
      { healthy: true },
    );
    const row = db.runtimeInstallations.current('git') as unknown as { license_files: string };
    assert.deepEqual(JSON.parse(row.license_files), ['LICENSE.txt', join('doc', 'COPYING')]);
  } finally {
    db.close();
  }
});

test('settings round-trip and upsert', () => {
  const db = memoryDb();
  try {
    assert.equal(db.settings.get('theme'), null);
    db.settings.set('theme', 'dark');
    db.settings.set('theme', 'light');
    assert.equal(db.settings.get('theme'), 'light');
    assert.deepEqual(db.settings.all(), { theme: 'light' });
  } finally {
    db.close();
  }
});

test('migrations are ordered and uniquely numbered', () => {
  const ids = MIGRATIONS.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(new Set(ids).size, ids.length);
});
