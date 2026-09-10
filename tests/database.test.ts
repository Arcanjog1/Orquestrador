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


test('a database from before worker routing upgrades in place: old rows read as "not routed"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lao-db-upgrade4-'));
  try {
    const file = join(dir, 'data', 'old.db');
    const older = new NodeSqliteDriver(file);
    older.exec(
      'CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    for (const migration of MIGRATIONS.filter((m) => m.id < 4)) {
      older.exec(migration.sql);
      older.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
        migration.id,
        migration.name,
        '2026-01-01T00:00:00.000Z',
      ]);
    }
    const t = '2026-01-01T00:00:00.000Z';
    older.run("INSERT INTO providers (id, display_name, created_at) VALUES ('anthropic','Anthropic',?)", [t]);
    older.run(
      "INSERT INTO accounts (id, provider_id, display_name, profile_directory, auth_state, created_at) VALUES ('acc-1','anthropic','Claude Trabalho','/p','connected',?)",
      [t],
    );
    older.run(
      "INSERT INTO agents (id, display_name, provider_id, account_id, adapter_id, role, created_at) VALUES ('agent-worker-acc-1','Claude Trabalho','anthropic','acc-1','claude-code','CODING_WORKER',?)",
      [t],
    );
    older.run(
      "INSERT INTO workspaces (id, display_name, local_path, created_at, updated_at) VALUES ('ws-1','Projeto','/w',?,?)",
      [t, t],
    );
    older.run(
      "INSERT INTO workspace_agents (workspace_id, agent_id, role, model, reasoning) VALUES ('ws-1','agent-worker-acc-1','CODING_WORKER','claude-opus-5','high')",
    );
    older.run(
      "INSERT INTO runs (id, workspace_id, objective, status, max_iterations, started_at) VALUES ('run-1','ws-1','x','DONE',8,?)",
      [t],
    );
    older.run(
      "INSERT INTO agent_invocations (id, run_id, iteration, agent_id, account_id, role, task, outcome, exit_code, duration_ms, started_at) VALUES ('inv-1','run-1',1,'agent-worker-acc-1','acc-1','CODING_WORKER','antigo','completed',0,10,?)",
      [t],
    );
    older.close();

    const upgraded = new Database({ filePath: file });
    try {
      assert.equal(upgraded.schemaVersion, SCHEMA_VERSION);
      const workspace = upgraded.workspaces.require('ws-1');
      assert.equal(workspace.worker_model, 'claude-opus-5', 'the old choice survived');
      assert.equal(workspace.worker_selection, null, 'no selection was ever made: automatic');

      const [old] = upgraded.runs.invocations('run-1');
      assert.equal(old!.task, 'antigo');
      assert.equal(old!.resolved_model, null, 'an old invocation was not routed');
      assert.equal(old!.selection_mode, null);

      // The new columns are writable and read back.
      upgraded.runs.recordInvocation({
        runId: 'run-1',
        iteration: 2,
        agentId: 'agent-worker-acc-1',
        accountId: 'acc-1',
        role: 'CODING_WORKER',
        task: 'novo',
        outcome: 'completed',
        exitCode: 0,
        durationMs: 5,
        startedAt: t,
        routing: {
          requestedCapability: 'STRONG',
          requestedReasoning: 'HIGH',
          resolvedModel: 'opus',
          resolvedReasoning: 'high',
          selectionMode: 'auto',
          selectionReason: 'Codex pediu STRONG/HIGH; modelo opus',
          fallbackUsed: false,
        },
      });
      const rows = upgraded.runs.invocations('run-1');
      const routed = rows.find((r) => r.task === 'novo')!;
      assert.equal(routed.resolved_model, 'opus');
      assert.equal(routed.requested_capability, 'STRONG');
      assert.equal(routed.selection_mode, 'auto');
      assert.equal(routed.fallback_used, 0);

      upgraded.workspaces.setTeam(
        'ws-1',
        { agentId: 'agent-worker-acc-1' },
        { agentId: 'agent-worker-acc-1', model: 'claude-opus-5', reasoning: 'high', selection: 'manual' },
      );
      assert.equal(upgraded.workspaces.require('ws-1').worker_selection, 'manual');
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conversations from before projects existed read as "Sem projeto", and nothing is lost', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lao-db-upgrade5-'));
  try {
    const file = join(dir, 'data', 'old.db');
    const older = new NodeSqliteDriver(file);
    older.exec(
      'CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    for (const migration of MIGRATIONS.filter((m) => m.id < 5)) {
      older.exec(migration.sql);
      older.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
        migration.id,
        migration.name,
        '2026-01-01T00:00:00.000Z',
      ]);
    }
    const t = '2026-01-01T00:00:00.000Z';
    older.run(
      "INSERT INTO workspaces (id, display_name, local_path, created_at, updated_at) VALUES ('ws-1','Projeto','/w',?,?)",
      [t, t],
    );
    older.run(
      "INSERT INTO chat_sessions (id, workspace_id, title, created_at, updated_at) VALUES ('chat-1','ws-1','Conversa antiga',?,?)",
      [t, t],
    );
    older.run(
      "INSERT INTO messages (id, session_id, kind, author, body, created_at) VALUES ('msg-1','chat-1','text','user','olá',?)",
      [t],
    );
    older.close();

    const upgraded = new Database({ filePath: file });
    try {
      assert.equal(upgraded.schemaVersion, SCHEMA_VERSION);
      assert.deepEqual(upgraded.projects.list(), [], 'no project was invented');
      const session = upgraded.chat.requireSession('chat-1');
      assert.equal(session.project_id, null, '"Sem projeto"');
      assert.equal(session.title, 'Conversa antiga');
      assert.equal(upgraded.chat.countMessages('chat-1'), 1);
      assert.equal(upgraded.chat.listAllSessions({ projectId: null }).length, 1);

      // And the new entity works on the old database.
      const project = upgraded.projects.create({ id: 'proj-1', name: 'Revit', workspaceId: 'ws-1' });
      upgraded.chat.setSessionProject('chat-1', project.id);
      assert.equal(upgraded.chat.requireSession('chat-1').project_id, 'proj-1');
      assert.equal(upgraded.projects.countSessions('proj-1'), 1);
      assert.deepEqual(upgraded.projects.remove('proj-1'), { removed: true, sessionsMoved: 1 });
      assert.equal(upgraded.chat.requireSession('chat-1').project_id, null, 'back to "Sem projeto", kept');
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a database written before connections and run kinds upgrades, keeping every row', () => {
  // Migration 9 is the one that touches accounts, runs and agent_invocations -
  // the three tables carrying the things a person would be most upset to lose:
  // their logins, their history and the record of what ran. So: build the
  // database exactly as the previous release left it, fill it with all three,
  // open it with the current Database, and check that nothing moved.
  const dir = mkdtempSync(join(tmpdir(), 'lao-db-connections-'));
  try {
    const file = join(dir, 'data', 'old.db');
    const older = new NodeSqliteDriver(file);
    older.exec(
      'CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    for (const migration of MIGRATIONS.filter((m) => m.id < 9)) {
      older.exec(migration.sql);
      older.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
        migration.id,
        migration.name,
        '2026-01-01T00:00:00.000Z',
      ]);
    }
    const t = '2026-01-01T00:00:00.000Z';
    older.run("INSERT INTO providers (id, display_name, created_at) VALUES ('anthropic','Anthropic',?)", [t]);
    older.run(
      "INSERT INTO accounts (id, provider_id, display_name, profile_directory, auth_state, auth_method, created_at) " +
        "VALUES ('acc-1','anthropic','Claude Trabalho','/profiles/acc-1','connected','oauth',?)",
      [t],
    );
    older.run(
      "INSERT INTO agents (id, display_name, provider_id, account_id, adapter_id, role, created_at) " +
        "VALUES ('agent-worker-acc-1','Claude Trabalho','anthropic','acc-1','claude-code-cli','CODING_WORKER',?)",
      [t],
    );
    older.run(
      "INSERT INTO workspaces (id, display_name, local_path, created_at, updated_at) VALUES ('ws-1','Projeto','/w',?,?)",
      [t, t],
    );
    older.run(
      "INSERT INTO workspace_agents (workspace_id, agent_id, role) VALUES ('ws-1','agent-worker-acc-1','CODING_WORKER')",
    );
    older.run(
      "INSERT INTO runs (id, session_id, workspace_id, objective, status, iteration, max_iterations, started_at) " +
        "VALUES ('run-1',NULL,'ws-1','Corrigir o bug','DONE',2,8,?)",
      [t],
    );
    older.run(
      "INSERT INTO agent_invocations (id, run_id, iteration, agent_id, account_id, role, outcome, started_at) " +
        "VALUES ('inv-1','run-1',1,'agent-worker-acc-1','acc-1','CODING_WORKER','completed',?)",
      [t],
    );
    older.close();

    const upgraded = new Database({ filePath: file });
    try {
      assert.equal(upgraded.schemaVersion, SCHEMA_VERSION);

      // The account is untouched, and it is a CLI connection - so the person's
      // existing login keeps working with nothing to re-authenticate.
      const account = upgraded.accounts.require('acc-1');
      assert.equal(account.display_name, 'Claude Trabalho');
      assert.equal(account.profile_directory, '/profiles/acc-1');
      assert.equal(account.auth_state, 'connected');
      assert.equal(account.auth_method, 'oauth');
      assert.equal(account.connection_kind, 'cli', 'an existing account is the official tool');
      assert.equal(account.api_enabled, 0, 'and nothing metered is switched on for it');
      assert.equal(account.secret_ref, null);
      assert.equal(account.key_hint, null);

      // The run kept its history and reads as a coding run, which is the gate
      // it actually had to pass.
      const run = upgraded.runs.require('run-1');
      assert.equal(run.objective, 'Corrigir o bug');
      assert.equal(run.status, 'DONE');
      assert.equal(run.iteration, 2);
      assert.equal(run.kind, 'coding');
      // Nothing reported consumption back then, and nothing is invented now.
      assert.equal(run.total_tokens, null);
      assert.equal(run.total_cost_usd, null);
      assert.equal(run.invocation_count, 0);

      assert.equal(upgraded.runs.invocations('run-1').length, 1, 'the invocation survived');

      // The team binding survived and reads as slot 0.
      assert.equal(upgraded.workspaces.require('ws-1').worker_agent_id, 'agent-worker-acc-1');
      const team = upgraded.workspaces.team('ws-1');
      assert.equal(team.length, 1);
      assert.equal(team[0]!.slot, 0);
      assert.equal(team[0]!.label, null);

      // And the new columns are writable on the old rows.
      upgraded.accounts.setPreferences('acc-1', 'claude-sonnet-5', 'high');
      assert.equal(upgraded.accounts.require('acc-1').default_model, 'claude-sonnet-5');
      upgraded.providerSecrets.put('acc-1', 'enc:whatever');
      assert.equal(upgraded.providerSecrets.get('acc-1'), 'enc:whatever');
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a database from before the project became the entity upgrades with every row intact', () => {
  // Migrations 14 and 15 are the ones this request adds. What they must never
  // do is what section 8 forbids in so many words: "Não apague nem recrie o
  // banco do usuário […] preservando: projetos, workspaces, conversas,
  // mensagens, runs, invocations, evidências, contas, configurações."
  //
  // So a database is built at version 13 - the state a person upgrading from
  // the previous installer is actually in - with one row of each of those
  // nine things, and every one of them is read back afterwards.
  const dir = mkdtempSync(join(tmpdir(), 'lao-db-upgrade14-'));
  try {
    const file = join(dir, 'data', 'old.db');
    const older = new NodeSqliteDriver(file);
    older.exec(
      'CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    for (const migration of MIGRATIONS.filter((m) => m.id <= 13)) {
      older.exec(migration.sql);
      older.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
        migration.id,
        migration.name,
        '2026-01-01T00:00:00.000Z',
      ]);
    }
    const t = '2026-01-01T00:00:00.000Z';
    older.run(
      "INSERT INTO workspaces (id, display_name, local_path, created_at, updated_at) VALUES ('ws-1','Pasta Antiga','/w',?,?)",
      [t, t],
    );
    older.run(
      "INSERT INTO projects (id, name, workspace_id, created_at, updated_at) VALUES ('proj-1','Projeto Antigo','ws-1',?,?)",
      [t, t],
    );
    older.run(
      "INSERT INTO chat_sessions (id, workspace_id, project_id, title, created_at, updated_at) VALUES ('chat-1','ws-1','proj-1','Conversa antiga',?,?)",
      [t, t],
    );
    older.run(
      "INSERT INTO messages (id, session_id, kind, author, body, created_at) VALUES ('msg-1','chat-1','text','user','olá',?)",
      [t],
    );
    older.run(
      "INSERT INTO providers (id, display_name, created_at) VALUES ('anthropic','Anthropic',?)",
      [t],
    );
    older.run(
      `INSERT INTO accounts (id, provider_id, display_name, profile_directory, auth_state, created_at)
       VALUES ('acc-1','anthropic','Claude Trabalho','/profiles/acc-1','connected',?)`,
      [t],
    );
    older.run(
      `INSERT INTO runs (id, session_id, workspace_id, objective, status, iteration, max_iterations, started_at)
       VALUES ('run-1','chat-1','ws-1','criar hello.txt','DONE',2,8,?)`,
      [t],
    );
    older.run(
      `INSERT INTO agent_invocations (run_id, iteration, role, outcome, started_at, failure_detail, cli_version)
       VALUES ('run-1',1,'CODING_WORKER','completed',?,'subtype=ok','2.1.263')`,
      [t],
    );
    older.run(
      `INSERT INTO verification_results (run_id, iteration, command, exit_code, passed, duration_ms, created_at)
       VALUES ('run-1',1,'node check.mjs',0,1,120,?)`,
      [t],
    );
    older.run("INSERT INTO settings (key, value, updated_at) VALUES ('execution.maxIterations','7',?)", [t]);
    older.close();

    const upgraded = new Database({ filePath: file });
    try {
      assert.equal(upgraded.schemaVersion, SCHEMA_VERSION);

      // 1. workspaces
      assert.equal(upgraded.workspaces.require('ws-1').display_name, 'Pasta Antiga');
      // 2. projects - and the new columns read as what an old row already meant
      const project = upgraded.projects.require('proj-1');
      assert.equal(project.name, 'Projeto Antigo');
      assert.equal(project.archived_at, null, 'an old project is not archived');
      assert.equal(project.repository_key, '', 'and has no repository');
      assert.equal(project.default_branch, null, 'and no invented default branch');
      assert.equal(project.source, 'folder', 'it was created next to a folder, so it is one');
      // 3. conversations, still filed under it
      assert.equal(upgraded.chat.requireSession('chat-1').project_id, 'proj-1');
      // 4. messages
      assert.equal(upgraded.chat.countMessages('chat-1'), 1);
      // 5. runs
      assert.equal(upgraded.runs.require('run-1').status, 'DONE');
      assert.equal(upgraded.runs.require('run-1').iteration, 2);
      // 6. invocations, with the diagnostics migration 13 added still there
      const invocations = upgraded.runs.invocations('run-1') as Array<Record<string, unknown>>;
      assert.equal(invocations.length, 1);
      assert.equal(invocations[0]!.failure_detail, 'subtype=ok');
      assert.equal(invocations[0]!.cli_version, '2.1.263');
      // 7. verification results
      assert.equal(upgraded.runs.verifications('run-1').length, 1);
      // 8. accounts
      assert.equal(upgraded.accounts.require('acc-1').display_name, 'Claude Trabalho');
      // 9. settings
      assert.equal(upgraded.settings.get('execution.maxIterations'), '7');

      // A step from before migration 15 has no duration, and says so with a
      // null rather than a zero that would read as "this phase was instant".
      upgraded.runs.addStep({ runId: 'run-1', iteration: 1, phase: 'evidence', status: 'changed' });
      const steps = upgraded.runs.steps('run-1');
      assert.equal(steps.at(-1)!.duration_ms, null);
      upgraded.runs.addStep({
        runId: 'run-1',
        iteration: 1,
        phase: 'verification',
        status: 'done',
        durationMs: 1234,
      });
      assert.equal(upgraded.runs.steps('run-1').at(-1)!.duration_ms, 1234);

      // The new entities work on the upgraded database.
      const withRepository = upgraded.projects.setRepository('proj-1', {
        key: 'github.com/arcanjog1/orquestrador',
        url: 'https://github.com/Arcanjog1/Orquestrador',
        fullName: 'Arcanjog1/Orquestrador',
        isPrivate: false,
        defaultBranch: 'claude/new-session-3am7mo',
      });
      assert.equal(withRepository.repository_full_name, 'Arcanjog1/Orquestrador');
      assert.equal(
        upgraded.projects.findByRepositoryKey('github.com/arcanjog1/orquestrador')?.id,
        'proj-1',
      );
      assert.ok(upgraded.projects.setArchived('proj-1', true).archived_at);
      assert.equal(upgraded.projects.setArchived('proj-1', false).archived_at, null);
      upgraded.projectContext.create({
        id: 'ctx-1',
        projectId: 'proj-1',
        kind: 'rule',
        title: 'Sem API paga',
        body: 'assinatura apenas',
      });
      assert.equal(upgraded.projectContext.list('proj-1').length, 1);
    } finally {
      upgraded.close();
    }

    // Idempotent: reopening applies nothing and changes nothing.
    const reopened = new Database({ filePath: file });
    try {
      assert.equal(reopened.schemaVersion, SCHEMA_VERSION);
      assert.equal(reopened.projects.require('proj-1').name, 'Projeto Antigo');
      assert.equal(reopened.projectContext.list('proj-1').length, 1);
      // Recording new evidence on the terminal legacy run consolidates one final
      // response; the original message remains intact across the reopen.
      assert.equal(reopened.chat.countMessages('chat-1'), 2);
      assert.equal(reopened.driver.get('SELECT body FROM messages WHERE id=?', ['msg-1'])!.body, 'olá');
      assert.equal(reopened.runs.events('run-1').filter(e=>e.type==='FINAL_RESPONSE').length, 1);
      assert.equal(reopened.runs.events('run-1').filter(e=>e.type==='AGENT_STARTED').length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
