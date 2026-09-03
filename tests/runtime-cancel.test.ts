/**
 * Cancelling an install.
 *
 * The first-run screen offers Cancelar, so the pipeline has to honour it -
 * but only where backing out is free. Once the staged build has been promoted
 * the pipeline owns the outcome and finishes: it health-checks, and rolls
 * back if that fails. A half-promoted runtime would be worse than one extra
 * install, so these tests pin down where the boundary is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedRuntime } from '../src/runtime/managed-runtime.js';
import { appPaths, ensureAppPaths } from '../src/runtime/paths.js';
import {
  RuntimeCancelledError,
  type RuntimeId,
  type RuntimeSource,
} from '../src/runtime/types.js';
import { buildFakeArchive, makeFetch, StubSource } from './helpers/fake-runtime-source.js';

/**
 * Runs `fn` against a throwaway app home and removes it afterwards.
 *
 * Async on purpose: a synchronous version deletes the directory the moment
 * the callback hands back its promise, so the body of an async test would run
 * against a home that no longer exists.
 */
async function withTempHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'lao-cancel-'));
  try {
    return await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

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

function setup(home: string, sources?: RuntimeSource[]) {
  const paths = ensureAppPaths(appPaths({ AI_ORCHESTRATOR_HOME: home } as NodeJS.ProcessEnv));
  const archive = buildFakeArchive(home, 'codex');
  const source = new StubSource('test-source', 'Test source', 'DOCUMENTED', {
    url: archive.url,
    version: '0.153.0',
    archiveKind: 'tgz',
    integrity: archive.integrity,
    executableNames: ['codex.exe', 'codex'],
  });
  const runtime = new TestRuntime(sources ?? [source], {
    paths,
    fetchImpl: makeFetch({ [archive.url]: { bytes: archive.bytes } }),
  });
  return { paths, runtime, source };
}

test('an install cancelled before it starts never contacts a source', async () => {
  await withTempHome(async (home) => {
    const { runtime, source } = setup(home);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => runtime.install(undefined, { signal: controller.signal }),
      (err: unknown) => err instanceof RuntimeCancelledError,
    );
    assert.equal(source.calls, 0, 'nothing should have been downloaded');
  });
});

test('a cancellation reads as the user backing out, not as a broken source', async () => {
  await withTempHome(async (home) => {
    const { runtime } = setup(home);
    const controller = new AbortController();
    controller.abort();

    try {
      await runtime.install(undefined, { signal: controller.signal });
      assert.fail('should have been cancelled');
    } catch (err) {
      assert.ok(err instanceof RuntimeCancelledError);
      assert.match(err.userMessage, /cancelada/i);
      assert.equal(err.remedy, 'Tentar novamente');
      assert.ok(!/spawn|PATH|exit code/.test(err.userMessage));
    }
  });
});

test('cancelling stops the whole attempt instead of falling through to the next source', async () => {
  await withTempHome(async (home) => {
    const paths = ensureAppPaths(appPaths({ AI_ORCHESTRATOR_HOME: home } as NodeJS.ProcessEnv));
    const archive = buildFakeArchive(home, 'codex');

    // Two sources: cancelling during the first must not silently retry with
    // the second, which would download exactly what the user just refused.
    const first = new StubSource('first', 'First', 'DOCUMENTED', {
      url: archive.url,
      version: '0.153.0',
      archiveKind: 'tgz',
      integrity: archive.integrity,
      executableNames: ['codex.exe', 'codex'],
    });
    const second = new StubSource('second', 'Second', 'DOCUMENTED', {
      url: archive.url,
      version: '0.153.0',
      archiveKind: 'tgz',
      integrity: archive.integrity,
      executableNames: ['codex.exe', 'codex'],
    });

    const controller = new AbortController();
    const runtime = new TestRuntime([first, second], {
      paths,
      fetchImpl: makeFetch({
        [archive.url]: {
          bytes: archive.bytes,
          // The user presses Cancelar while the download is in flight.
          onRequest: () => controller.abort(),
        },
      }),
    });

    await assert.rejects(
      () => runtime.install(undefined, { signal: controller.signal }),
      (err: unknown) => err instanceof RuntimeCancelledError,
    );
    assert.equal(second.calls, 0, 'the second source must not be tried after a cancellation');
  });
});

test('a cancelled install leaves nothing behind for the next attempt to trip over', async () => {
  await withTempHome(async (home) => {
    const { paths, runtime } = setup(home);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(() => runtime.install(undefined, { signal: controller.signal }));

    assert.equal(existsSync(runtime.currentDir), false, 'no half-promoted install');
    assert.deepEqual(
      (await runtime.detect()).origin,
      'missing',
      'a cancelled install must not look like a broken one',
    );
    assert.equal(readdirSync(paths.staging).length, 0, 'the staging area is cleaned up');
  });
});

test('an install with no signal behaves exactly as before', async () => {
  await withTempHome(async (home) => {
    const { runtime } = setup(home);
    const result = await runtime.install();
    assert.equal(result.manifest.version, '0.153.0');
    assert.equal(result.health.healthy, true);
  });
});
