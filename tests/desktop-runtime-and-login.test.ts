/**
 * The two flows the first-run experience is made of: configuring a runtime and
 * connecting an account, both driven entirely from the interface.
 *
 * Both are tested against fakes standing in for `RuntimeManager` and
 * `ClaudeAccountManager`: the real ones are already covered by their own
 * suites, and what matters here is the translation into progress events, view
 * models and persisted rows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeService } from '../apps/desktop/src/main/services/runtime-service.js';
import { AccountService } from '../apps/desktop/src/main/services/account-service.js';
import { EventBus } from '../apps/desktop/src/main/events.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/database/database.js';
import { RuntimeManager as RealRuntimeManager } from '../src/runtime/runtime-manager.js';
import { ManagedRuntime } from '../src/runtime/managed-runtime.js';
import { ensureAppPaths } from '../src/runtime/paths.js';
import type { RuntimeSource } from '../src/runtime/types.js';
import { StubSource } from './helpers/fake-runtime-source.js';

/** A codex runtime whose only source stalls, so a cancel has something to cut. */
class StallingRuntime extends ManagedRuntime {
  readonly id: RuntimeId = 'codex';
  readonly displayName = 'Codex';
  readonly sources: readonly RuntimeSource[];
  protected readonly systemExecutableNames = ['definitely-not-installed-xyz'] as const;

  constructor(sources: RuntimeSource[], options: ConstructorParameters<typeof ManagedRuntime>[0]) {
    super(options);
    this.sources = sources;
  }
}
import type { RuntimeManager } from '../src/runtime/runtime-manager.js';
import type { ClaudeAccountManager } from '../src/accounts/claude-account-manager.js';
import type { InstallProgress, ProgressReporter, RuntimeId } from '../src/runtime/types.js';
import type { RuntimeProgressEvent, AccountProgressEvent } from '../apps/desktop/src/shared/ipc-contract.js';

function memoryDatabase(): Database {
  const db = new Database({ filePath: ':memory:' });
  db.providers.ensureSeeded();
  return db;
}

/* ------------------------------------------------------------- runtimes */

test('diagnose is translated for the interface without the renderer deciding anything', async () => {
  const manager = {
    async diagnose() {
      return {
        ready: false,
        checkedAt: '2026-09-04T00:00:00.000Z',
        pending: ['codex'] as RuntimeId[],
        runtimes: [
          {
            runtimeId: 'codex' as RuntimeId,
            displayName: 'Codex',
            detection: { runtimeId: 'codex', origin: 'missing', executablePath: null, version: null, manifest: null },
            health: { healthy: false, problem: 'Codex ainda não está configurado.' },
            canAutoConfigure: true,
          },
          {
            runtimeId: 'git' as RuntimeId,
            displayName: 'Git',
            detection: { runtimeId: 'git', origin: 'managed', executablePath: '/g/git.exe', version: '2.47.0', manifest: null },
            health: { healthy: true },
            canAutoConfigure: true,
          },
        ],
      };
    },
  } as unknown as RuntimeManager;

  const service = new RuntimeService(manager, new EventBus(), null);
  const view = await service.diagnose();

  assert.equal(view.ready, false);
  assert.deepEqual(view.pending, ['codex']);
  assert.equal(view.runtimes[0]!.detail, 'Codex ainda não está configurado.');
  assert.equal(view.runtimes[0]!.ready, false);
  assert.equal(view.runtimes[1]!.ready, true);
  assert.equal(view.runtimes[1]!.detail, 'Pronto (gerenciado pelo aplicativo)');
  assert.equal(view.runtimes[1]!.version, '2.47.0');
});

test('installing streams friendly progress and records the installation', async () => {
  const manager = {
    async install(runtimeId: RuntimeId, onProgress?: ProgressReporter) {
      const phases: InstallProgress[] = [
        { runtimeId, phase: 'resolving', message: 'procurando' },
        { runtimeId, phase: 'downloading', message: 'baixando', percent: 40 },
        { runtimeId, phase: 'verifying', message: 'conferindo' },
        { runtimeId, phase: 'installing', message: 'instalando' },
        { runtimeId, phase: 'health-check', message: 'testando' },
      ];
      for (const phase of phases) onProgress?.(phase);
      return {
        runtimeId,
        executablePath: '/managed/codex.exe',
        health: { healthy: true },
        manifest: {
          runtimeId,
          version: '0.153.0',
          sourceId: 'official',
          sourceLabel: 'Official release',
          contract: 'DOCUMENTED',
          url: 'https://example.invalid/codex.zip',
          host: 'example.invalid',
          platform: 'win32',
          arch: 'x64',
          bytes: 10,
          sha256: 'abc',
          integrity: { strategy: 'SHA256', verified: true, detail: 'ok' },
          trustLevel: 'VERIFIED',
          executableRelativePath: 'bin/codex.exe',
          installedAt: '2026-09-04T00:00:00.000Z',
        },
      };
    },
  } as unknown as RuntimeManager;

  const events = new EventBus();
  const seen: RuntimeProgressEvent[] = [];
  events.subscribe((channel, payload) => {
    if (channel === 'runtime:progress') seen.push(payload as RuntimeProgressEvent);
  });

  const database = memoryDatabase();
  try {
    const service = new RuntimeService(manager, events, database);
    const result = await service.install('codex');

    assert.equal(result.ok, true);
    assert.equal(result.version, '0.153.0');

    const labels = seen.map((e) => e.label);
    assert.deepEqual(labels, [
      'Procurando a versão testada',
      'Baixando',
      'Verificando',
      'Instalando',
      'Testando',
      'Concluído',
    ]);
    assert.equal(seen[1]!.percent, 40);

    // The developer view can answer "what is installed and where did it come from".
    const record = database.runtimeInstallations.current('codex');
    assert.equal(record?.version, '0.153.0');
    assert.equal(record?.health_status, 'healthy');
  } finally {
    database.close();
  }
});

test('a failed install reports a sentence, never a raw error', async () => {
  const manager = {
    async install() {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND releases.example'), {
        userMessage: 'Não foi possível baixar o Codex agora.',
      });
    },
  } as unknown as RuntimeManager;

  const events = new EventBus();
  const seen: RuntimeProgressEvent[] = [];
  events.subscribe((channel, payload) => {
    if (channel === 'runtime:progress') seen.push(payload as RuntimeProgressEvent);
  });

  const service = new RuntimeService(manager, events, null);
  const result = await service.install('codex');

  assert.equal(result.ok, false);
  assert.equal(result.message, 'Não foi possível baixar o Codex agora.');
  // The sentence is what the row says; the raw reason is kept for "Detalhes",
  // where a person who wants it can read which step failed and why.
  assert.ok(!/ENOTFOUND/.test(result.message));
  assert.match(result.detail ?? '', /ENOTFOUND releases\.example/);
  assert.equal(seen.at(-1)!.label, 'Não foi possível configurar');
  assert.equal(seen.at(-1)!.detail, result.detail);
});

test('cancelling a real install aborts the download and is not reported as a failure', async () => {
  // A fetch that never finishes unless its signal aborts: exactly what a slow
  // download looks like, and the only honest way to prove Cancelar works.
  const neverFinishes = ((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
    })) as unknown as typeof fetch;

  const dir = mkdtempSync(join(tmpdir(), 'lao-cancel-'));
  const paths = ensureAppPaths({
    root: dir,
    runtimes: join(dir, 'runtimes'),
    profiles: join(dir, 'profiles'),
    data: join(dir, 'data'),
    logs: join(dir, 'logs'),
    artifacts: join(dir, 'artifacts'),
    updates: join(dir, 'updates'),
    staging: join(dir, 'staging'),
  });

  try {
    const manager = new RealRuntimeManager({ paths, fetchImpl: neverFinishes });
    manager.register(
      new StallingRuntime(
        [
          new StubSource('stub', 'Stub', 'DOCUMENTED', {
            version: '0.153.0',
            url: 'https://example.invalid/codex.zip',
            archiveKind: 'zip',
            executableNames: ['codex.exe'],
          }),
        ],
        { paths, fetchImpl: neverFinishes },
      ),
    );

    const events = new EventBus();
    const seen: RuntimeProgressEvent[] = [];
    events.subscribe((channel, payload) => {
      if (channel === 'runtime:progress') seen.push(payload as RuntimeProgressEvent);
    });

    const service = new RuntimeService(manager, events, null);
    const running = service.install('codex');

    // Wait until the download has actually started.
    const deadline = Date.now() + 5000;
    while (!seen.some((e) => e.phase === 'downloading') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(seen.some((e) => e.phase === 'downloading'), 'the download must have started');

    assert.equal(service.cancelInstall('codex'), true);
    const result = await running;

    assert.equal(result.ok, false);
    assert.equal(result.message, 'Instalação cancelada.');
    assert.equal(seen.at(-1)!.phase, 'cancelled');
    assert.equal(seen.at(-1)!.label, 'Cancelado');

    // Nothing was promoted: whatever was there before is still what is there.
    assert.equal(existsSync(join(paths.runtimes, 'codex', 'current')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancelling reports whether there was anything to cancel', async () => {
  let release: null | (() => void) = null;
  const setRelease = (fn: () => void): void => {
    release = fn;
  };
  const manager = {
    async install(runtimeId: RuntimeId) {
      await new Promise<void>((resolve) => setRelease(resolve));
      throw new Error('cancelled');
    },
  } as unknown as RuntimeManager;

  const service = new RuntimeService(manager, new EventBus(), null);
  assert.equal(service.cancelInstall('codex'), false, 'nothing running yet');

  const running = service.install('codex');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(service.cancelInstall('codex'), true);
  (release as (() => void) | null)?.();
  await running;
  assert.equal(service.cancelInstall('codex'), false, 'no longer running');
});

/* -------------------------------------------------------------- accounts */

test('connecting an account opens the browser for the user and records the result', async () => {
  const database = memoryDatabase();
  const opened: string[] = [];
  const events = new EventBus();
  const progress: AccountProgressEvent[] = [];
  events.subscribe((channel, payload) => {
    if (channel === 'account:progress') progress.push(payload as AccountProgressEvent);
  });

  const profiles = new Map<string, string>();
  const accountManager = {
    profileDirectory: (id: string) => `/profiles/${id}`,
    createAccount: (account: { id: string }) => {
      profiles.set(account.id, `/profiles/${account.id}`);
      return account;
    },
    removeAccount: (id: string) => profiles.delete(id),
    async connect(
      account: { id: string; displayName: string },
      options: {
        onProgress?: (p: { accountId: string; phase: string; message: string; url?: string }) => void;
        openUrl?: (url: string) => void;
      },
    ) {
      options.onProgress?.({ accountId: account.id, phase: 'starting', message: 'iniciando' });
      const url = 'https://claude.ai/oauth/authorize?code=xyz';
      options.onProgress?.({ accountId: account.id, phase: 'awaiting-browser', message: 'abra', url });
      await options.openUrl?.(url);
      options.onProgress?.({ accountId: account.id, phase: 'waiting-for-completion', message: 'aguardando' });
      return {
        accountId: account.id,
        displayName: account.displayName,
        state: 'connected' as const,
        authMethod: 'oauth',
        checkedAt: new Date().toISOString(),
      };
    },
  } as unknown as ClaudeAccountManager;

  try {
    const service = new AccountService(database, { anthropic: accountManager, openai: accountManager }, events, (url) => {
      opened.push(url);
    });

    const created = service.create('Claude Trabalho');
    assert.equal(created.state, 'disconnected');

    const connected = await service.connect(created.id);
    assert.equal(connected.state, 'connected');

    // The application opened the browser; the user copied nothing.
    assert.deepEqual(opened, ['https://claude.ai/oauth/authorize?code=xyz']);

    // The interface was told, in order, what was happening.
    assert.deepEqual(progress.map((p) => p.stage), [
      'starting',
      'awaiting-browser',
      'waiting-for-completion',
    ]);
    assert.equal(progress[1]!.url, 'https://claude.ai/oauth/authorize?code=xyz');

    // And the row survives a restart as `connected`, not optimistically.
    const row = database.accounts.require(created.id);
    assert.equal(row.auth_state, 'connected');
    assert.equal(row.auth_method, 'oauth');
    assert.ok(row.last_connected_at);
  } finally {
    database.close();
  }
});

test('a login that fails leaves the account disconnected and says why', async () => {
  const database = memoryDatabase();
  const accountManager = {
    profileDirectory: (id: string) => `/profiles/${id}`,
    createAccount: (account: unknown) => account,
    async connect() {
      throw Object.assign(new Error('exit 1'), {
        userMessage: 'O Claude Code não concluiu o login.',
      });
    },
  } as unknown as ClaudeAccountManager;

  try {
    const service = new AccountService(
      database,
      { anthropic: accountManager, openai: accountManager },
      new EventBus(),
      () => {},
    );
    const created = service.create('Claude Pessoal');
    const result = await service.connect(created.id);

    assert.equal(result.state, 'disconnected');
    assert.equal(result.detail, 'O Claude Code não concluiu o login.');
    assert.equal(database.accounts.require(created.id).auth_state, 'disconnected');
  } finally {
    database.close();
  }
});

test('an ambient credential is never reported as connected', async () => {
  const database = memoryDatabase();
  const accountManager = {
    profileDirectory: (id: string) => `/profiles/${id}`,
    createAccount: (account: unknown) => account,
    async getStatus(account: { id: string; displayName: string }) {
      return {
        accountId: account.id,
        displayName: account.displayName,
        state: 'ambient-credential' as const,
        checkedAt: new Date().toISOString(),
      };
    },
  } as unknown as ClaudeAccountManager;

  try {
    const service = new AccountService(
      database,
      { anthropic: accountManager, openai: accountManager },
      new EventBus(),
      () => {},
    );
    const created = service.create('Claude Compartilhada');
    const status = await service.status(created.id);

    assert.equal(status.state, 'ambient-credential');
    assert.match(status.detail, /não é desta conta/i);
    assert.equal(database.accounts.require(created.id).auth_state, 'ambient-credential');
  } finally {
    database.close();
  }
});
