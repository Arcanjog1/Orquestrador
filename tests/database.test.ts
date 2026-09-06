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

test('a database written before the team columns existed upgrades in place, rows intact', () => {
  // Migration 3 (`team-and-conversations`) is the first one to add columns to
  // tables that already carry a person's data. So: build a database exactly
  // as the previous release left it - the migrations before this one, applied
  // by hand - fill it, then open it with the current Database and check that
  // nothing was lost and the new columns read as "not set".
  const dir = mkdtempSync(join(tmpdir(), 'lao-db-upgrade-'));
  try {
    const file = join(dir, 'data', 'old.db');
    const older = new NodeSqliteDriver(file);
    older.exec(
      'CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    for (const migration of MIGRATIONS.filter((m) => m.id < 3)) {
      older.exec(migration.sql);
      older.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
        migration.id,
        migration.name,
        '2026-01-01T00:00:00.000Z',
      ]);
    }
    const t = '2026-01-01T00:00:00.000Z';
    older.run("INSERT INTO providers (id, display_name, created_at) VALUES ('openai','OpenAI',?)", [t]);
    older.run(
      "INSERT INTO accounts (id, provider_id, display_name, profile_directory, auth_state, created_at) VALUES ('acc-1','openai','Codex Trabalho','/p','connected',?)",
      [t],
    );
    older.run(
      "INSERT INTO agents (id, display_name, provider_id, account_id, adapter_id, role, created_at) VALUES ('agent-orchestrator-acc-1','Codex Trabalho','openai','acc-1','codex-cli','ORCHESTRATOR',?)",
      [t],
    );
    older.run(
      "INSERT INTO workspaces (id, display_name, local_path, created_at, updated_at) VALUES ('ws-1','Projeto','/w',?,?)",
      [t, t],
    );
    older.run(
      "INSERT INTO workspace_agents (workspace_id, agent_id, role) VALUES ('ws-1','agent-orchestrator-acc-1','ORCHESTRATOR')",
    );
    older.run(
      "INSERT INTO chat_sessions (id, workspace_id, title, created_at, updated_at) VALUES ('chat-1','ws-1','Primeira conversa',?,?)",
      [t, t],
    );
    older.close();

    const upgraded = new Database({ filePath: file });
    try {
      assert.equal(upgraded.schemaVersion, SCHEMA_VERSION);
      const workspace = upgraded.workspaces.require('ws-1');
      assert.equal(workspace.orchestrator_agent_id, 'agent-orchestrator-acc-1', 'the binding survived');
      assert.equal(workspace.orchestrator_model, null, 'no model was ever chosen');
      assert.equal(workspace.orchestrator_reasoning, null);
      assert.equal(workspace.worker_agent_id, null);
      const session = upgraded.chat.requireSession('chat-1');
      assert.equal(session.title, 'Primeira conversa');
      assert.equal((session as { archived_at?: string | null }).archived_at ?? null, null);
      // And the new columns are writable on the old rows.
      upgraded.workspaces.setTeam(
        'ws-1',
        { agentId: 'agent-orchestrator-acc-1', model: 'gpt-5.1-codex', reasoning: 'high' },
        { agentId: 'agent-orchestrator-acc-1' },
      );
      assert.equal(upgraded.workspaces.require('ws-1').orchestrator_model, 'gpt-5.1-codex');
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
