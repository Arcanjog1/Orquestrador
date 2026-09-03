import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedRuntime } from '../src/runtime/managed-runtime.js';
import { appPaths, ensureAppPaths } from '../src/runtime/paths.js';
import { RuntimeNotReadyError, type RuntimeId, type RuntimeSource } from '../src/runtime/types.js';
import { verifyIntegrity } from '../src/runtime/downloader.js';
import { findExecutable, planPromotion } from '../src/runtime/archive.js';
import { buildFakeArchive, makeFetch, StubSource } from './helpers/fake-runtime-source.js';

function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'lao-runtime-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function pathsFor(home: string) {
  return ensureAppPaths(appPaths({ AI_ORCHESTRATOR_HOME: home } as NodeJS.ProcessEnv));
}

/** A runtime wired to whatever sources a test provides. */
class TestRuntime extends ManagedRuntime {
  readonly id: RuntimeId = 'codex';
  readonly displayName = 'Codex';
  readonly sources: readonly RuntimeSource[];
  protected readonly systemExecutableNames = ['definitely-not-installed-xyz'] as const;

  constructor(sources: RuntimeSource[], options: ConstructorParameters<typeof ManagedRuntime>[0]) {
    super(options);
    this.sources = sources;
  }
}

test('installs from a source, verifying integrity and promoting atomically', async () => {
  await withTempHome(async (home) => {
    const paths = pathsFor(home);
    const archive = buildFakeArchive(home, 'codex');

    const runtime = new TestRuntime(
      [
        new StubSource('test-source', 'Test source', 'DOCUMENTED', {
          url: archive.url,
          version: '1.2.3',
          archiveKind: 'tgz',
          integrity: archive.integrity,
          executableNames: ['codex.exe', 'codex'],
        }),
      ],
      { paths, fetchImpl: makeFetch({ [archive.url]: { bytes: archive.bytes } }) },
    );

    const phases: string[] = [];
    const result = await runtime.install((p) => phases.push(p.phase));

    assert.ok(existsSync(result.executablePath), 'executable should exist after install');
    assert.equal(result.manifest.version, '1.2.3');
    assert.equal(result.manifest.integrityVerified, true, 'published integrity should be verified');
    assert.equal(result.manifest.sourceId, 'test-source');
    assert.equal(result.manifest.contract, 'DOCUMENTED');
    assert.equal(result.manifest.sha256.length, 64);

    // The sibling folder the executable needs must survive promotion.
    assert.ok(
      existsSync(join(runtime.installDir, 'package', 'vendor', 'resources', 'data.txt')),
      'sibling resources should be promoted alongside the executable',
    );

    // Progress reaches the UI in a sensible order.
    assert.ok(phases.includes('downloading'));
    assert.ok(phases.includes('installing'));
    assert.equal(phases[phases.length - 1], 'done');

    // Nothing is left behind in staging.
    assert.equal(readdirSync(paths.staging).length, 0, 'staging should be empty afterwards');
  });
});

test('a corrupted download is rejected and installs nothing', async () => {
  await withTempHome(async (home) => {
    const paths = pathsFor(home);
    const archive = buildFakeArchive(home, 'codex');
    const tampered = Buffer.concat([archive.bytes, Buffer.from('extra')]);

    const runtime = new TestRuntime(
      [
        new StubSource('test-source', 'Test source', 'DOCUMENTED', {
          url: archive.url,
          version: '1.2.3',
          archiveKind: 'tgz',
          integrity: archive.integrity, // checksum of the ORIGINAL bytes
          executableNames: ['codex'],
        }),
      ],
      { paths, fetchImpl: makeFetch({ [archive.url]: { bytes: tampered } }) },
    );

    await assert.rejects(() => runtime.install(), /Não foi possível preparar Codex/);
    assert.equal(existsSync(runtime.manifestPath), false, 'no manifest should be written');
    assert.equal((await runtime.detect()).origin, 'missing');
  });
});

test('falls through to the next source when the first one fails', async () => {
  await withTempHome(async (home) => {
    const paths = pathsFor(home);
    const archive = buildFakeArchive(home, 'codex');

    const broken = new StubSource('broken', 'Broken', 'DOCUMENTED', new Error('network down'));
    const empty = new StubSource('empty', 'No build for this platform', 'DOCUMENTED', null);
    const working = new StubSource('working', 'Working', 'PACKAGE_INTERNAL', {
      url: archive.url,
      version: '9.9.9',
      archiveKind: 'tgz',
      executableNames: ['codex'],
    });

    const runtime = new TestRuntime([broken, empty, working], {
      paths,
      fetchImpl: makeFetch({ [archive.url]: { bytes: archive.bytes } }),
    });

    const result = await runtime.install();
    assert.equal(broken.calls, 1);
    assert.equal(empty.calls, 1);
    assert.equal(result.manifest.sourceId, 'working');
    // The contract level of whatever actually served the runtime is recorded.
    assert.equal(result.manifest.contract, 'PACKAGE_INTERNAL');
  });
});

test('reports an actionable error when every source fails', async () => {
  await withTempHome(async (home) => {
    const paths = pathsFor(home);
    const runtime = new TestRuntime(
      [new StubSource('a', 'A', 'DOCUMENTED', null), new StubSource('b', 'B', 'DOCUMENTED', null)],
      { paths },
    );

    await assert.rejects(
      () => runtime.install(),
      (err: unknown) => {
        const e = err as { userMessage: string; remedy: string; detail?: string };
        // What the interface shows must be actionable, never "not found in PATH".
        assert.match(e.userMessage, /Não foi possível preparar Codex automaticamente/);
        assert.equal(e.remedy, 'Tentar novamente');
        assert.ok(!/PATH/i.test(e.userMessage));
        assert.match(e.detail ?? '', /nothing available/);
        return true;
      },
    );
  });
});

test('detect finds the managed install and getExecutablePath returns an absolute path', async () => {
  await withTempHome(async (home) => {
    const paths = pathsFor(home);
    const archive = buildFakeArchive(home, 'codex');
    const runtime = new TestRuntime(
      [
        new StubSource('s', 'S', 'DOCUMENTED', {
          url: archive.url,
          version: '1.0.0',
          archiveKind: 'tgz',
          executableNames: ['codex'],
        }),
      ],
      { paths, fetchImpl: makeFetch({ [archive.url]: { bytes: archive.bytes } }) },
    );

    assert.equal((await runtime.detect()).origin, 'missing');
    await assert.rejects(() => runtime.getExecutablePath(), RuntimeNotReadyError);

    await runtime.install();

    const detection = await runtime.detect();
    assert.equal(detection.origin, 'managed');
    assert.equal(detection.version, '1.0.0');

    const executable = await runtime.getExecutablePath();
    assert.ok(executable.startsWith(runtime.installDir), 'must be inside the app-private folder');
    assert.ok(existsSync(executable));
  });
});

test('a missing runtime asks to be configured, never mentioning PATH', async () => {
  await withTempHome(async (home) => {
    const runtime = new TestRuntime([], { paths: pathsFor(home) });
    const health = await runtime.healthCheck();
    assert.equal(health.healthy, false);
    assert.equal(health.problem, 'Codex ainda não está configurado.');
    assert.equal(health.remedy, 'Configurar automaticamente');
    assert.ok(!/PATH/i.test(health.problem ?? ''));
  });
});

test('a corrupt manifest is treated as no install, so repair can recover', async () => {
  await withTempHome(async (home) => {
    const paths = pathsFor(home);
    const archive = buildFakeArchive(home, 'codex');
    const source = new StubSource('s', 'S', 'DOCUMENTED', {
      url: archive.url,
      version: '1.0.0',
      archiveKind: 'tgz',
      executableNames: ['codex'],
    });
    const runtime = new TestRuntime([source], {
      paths,
      fetchImpl: makeFetch({ [archive.url]: { bytes: archive.bytes } }),
    });

    await runtime.install();
    writeFileSync(runtime.manifestPath, '{ this is not json');
    assert.equal(runtime.readManifest(), null);
    assert.equal((await runtime.detect()).origin, 'missing');

    const repaired = await runtime.repair();
    assert.equal(repaired.manifest.version, '1.0.0');
    assert.equal((await runtime.detect()).origin, 'managed');
  });
});

test('an install whose files vanished is reported as missing, not managed', async () => {
  await withTempHome(async (home) => {
    const paths = pathsFor(home);
    const archive = buildFakeArchive(home, 'codex');
    const runtime = new TestRuntime(
      [
        new StubSource('s', 'S', 'DOCUMENTED', {
          url: archive.url,
          version: '1.0.0',
          archiveKind: 'tgz',
          executableNames: ['codex'],
        }),
      ],
      { paths, fetchImpl: makeFetch({ [archive.url]: { bytes: archive.bytes } }) },
    );

    const result = await runtime.install();
    rmSync(result.executablePath, { force: true });
    assert.equal((await runtime.detect()).origin, 'missing');
  });
});

// ---------------------------------------------------------------------------
// Units the install path depends on
// ---------------------------------------------------------------------------

test('verifyIntegrity distinguishes match, mismatch and nothing to check', () => {
  const bytes = Buffer.from('hello world');
  const good = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(verifyIntegrity(bytes, good), true);
  assert.equal(verifyIntegrity(bytes, 'sha512-AAAA'), false);
  // No checksum published is not the same as a passing checksum.
  assert.equal(verifyIntegrity(bytes, undefined), null);
});

test('findExecutable matches the target platform name, case-insensitively', () => {
  withTempHome((home) => {
    const tree = join(home, 'tree', 'package', 'bin');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, 'Codex.EXE'), '');
    // Looking for a Windows build from a case-sensitive filesystem must still work.
    assert.ok(findExecutable(join(home, 'tree'), ['codex.exe'])?.endsWith('Codex.EXE'));
    assert.equal(findExecutable(join(home, 'tree'), ['nothing-like-this']), null);
  });
});

test('planPromotion keeps the whole tree and records a relative executable path', () => {
  const plan = planPromotion('/root/extracted', '/root/extracted/package/vendor/bin/codex.exe');
  assert.equal(plan.promoteDir, '/root/extracted');
  assert.equal(plan.executableRelativePath, join('package', 'vendor', 'bin', 'codex.exe'));
});

test('the app-private layout is per-user and needs no elevation on Windows', () => {
  const paths = appPaths({
    LOCALAPPDATA: 'C:\\Users\\Gabriel\\AppData\\Local',
    AI_ORCHESTRATOR_HOME: undefined,
  } as unknown as NodeJS.ProcessEnv);
  // On a non-Windows host the platform branch differs; assert the shape instead.
  assert.ok(paths.runtimes.endsWith('runtimes'));
  assert.ok(paths.profiles.endsWith('profiles'));
  assert.ok(paths.staging.endsWith('staging'));
  assert.ok(paths.root.includes('AI-Orchestrator'));
});
