import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appPaths, ensureAppPaths } from '../src/runtime/paths.js';
import { RuntimeManager } from '../src/runtime/runtime-manager.js';
import { CONTRACT_LABELS } from '../src/runtime/types.js';
import { defaultCodexSources, CodexNpmRegistrySource } from '../src/runtime/sources/codex-sources.js';
import { defaultClaudeSources } from '../src/runtime/sources/claude-sources.js';
import { MinGitReleaseSource } from '../src/runtime/sources/git-sources.js';
import { makeFetch } from './helpers/fake-runtime-source.js';

/**
 * Runs `fn` against a throwaway app home and removes it afterwards.
 *
 * Async on purpose: a synchronous version deletes the directory the moment
 * the callback hands back its promise, so the body of an async test would run
 * against a home that no longer exists.
 */
async function withTempHome<T>(
  fn: (paths: ReturnType<typeof appPaths>) => T | Promise<T>,
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'lao-mgr-'));
  try {
    return await fn(ensureAppPaths(appPaths({ AI_ORCHESTRATOR_HOME: home } as NodeJS.ProcessEnv)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('the diagnostic covers every runtime, not only the broken ones', async () => {
  await withTempHome(async (paths) => {
    const manager = new RuntimeManager({ paths, fetchImpl: makeFetch({}) });
    const report = await manager.diagnose();

    assert.deepEqual(
      report.runtimes.map((r) => r.runtimeId).sort(),
      ['claude-code', 'codex', 'git'],
      'the first-run screen needs a complete checklist',
    );
    for (const row of report.runtimes) {
      assert.ok(row.displayName.length > 0);
      assert.ok(typeof row.health.healthy === 'boolean');
    }
    assert.ok(typeof report.ready === 'boolean');
    assert.ok(report.checkedAt);
  });
});

test('an unconfigured runtime offers automatic setup and never mentions PATH', async () => {
  await withTempHome(async (paths) => {
    const manager = new RuntimeManager({ paths, fetchImpl: makeFetch({}) });
    const report = await manager.diagnose();

    const codex = report.runtimes.find((r) => r.runtimeId === 'codex')!;
    if (!codex.health.healthy) {
      assert.match(codex.health.problem ?? '', /ainda não está configurado/);
      assert.equal(codex.health.remedy, 'Configurar automaticamente');
      assert.ok(!/PATH/i.test(codex.health.problem ?? ''));
      assert.equal(codex.canAutoConfigure, true, 'Codex has sources, so the app can fix it');
    }
  });
});

test('Git can be prepared automatically, so the user never installs it', async () => {
  await withTempHome(async (paths) => {
    const manager = new RuntimeManager({ paths, fetchImpl: makeFetch({}) });
    const git = manager.get('git');
    assert.ok(git.sources.length > 0, 'MinGit gives Git an automatic path');
    assert.equal(git.sources[0]!.contract, 'DOCUMENTED');
  });
});

test('MinGit picks the portable archive and declines off Windows', async () => {
  const release = {
    tag_name: 'v2.47.0.windows.1',
    assets: [
      { name: 'Git-2.47.0-64-bit.exe', browser_download_url: 'https://x/installer.exe', size: 1 },
      { name: 'MinGit-2.47.0-busybox-64-bit.zip', browser_download_url: 'https://x/busybox.zip', size: 2 },
      { name: 'MinGit-2.47.0-64-bit.zip', browser_download_url: 'https://x/mingit.zip', size: 3 },
    ],
  };
  const api = 'https://api.github.com/repos/git-for-windows/git/releases/latest';
  const source = new MinGitReleaseSource(undefined, makeFetch({ [api]: { body: release } }));

  const windows = await source.resolve({ platform: 'win32', arch: 'x64' }, { kind: 'latest' });
  // The plain portable build, not the full installer and not busybox.
  assert.equal(windows?.url, 'https://x/mingit.zip');
  assert.equal(windows?.version, '2.47.0');
  assert.equal(windows?.archiveKind, 'zip');
  assert.deepEqual(windows?.executableNames, ['git.exe']);

  // MinGit is Windows-only; elsewhere the source declines rather than guessing.
  assert.equal(await source.resolve({ platform: 'linux', arch: 'x64' }, { kind: 'latest' }), null);
});

test('MinGit falls back to the busybox build when only that is published', async () => {
  const api = 'https://api.github.com/repos/git-for-windows/git/releases/latest';
  const source = new MinGitReleaseSource(
    undefined,
    makeFetch({
      [api]: {
        body: {
          tag_name: 'v2.47.0.windows.1',
          assets: [
            { name: 'MinGit-2.47.0-busybox-64-bit.zip', browser_download_url: 'https://x/bb.zip' },
          ],
        },
      },
    }),
  );
  const resolved = await source.resolve({ platform: 'win32', arch: 'x64' }, { kind: 'latest' });
  assert.equal(resolved?.url, 'https://x/bb.zip');
});

test('prepareAll collects failures instead of stopping at the first one', async () => {
  await withTempHome(async (paths) => {
    // Nothing installed and nothing installable: an empty PATH hides whatever
    // the developer's own machine happens to have, so the assertion below is
    // about the behaviour and not about this host, and every network call
    // fails so nothing can be acquired either.
    const realPath = process.env.PATH;
    process.env.PATH = '';
    let result;
    try {
      const manager = new RuntimeManager({ paths, fetchImpl: makeFetch({}) });
      result = await manager.prepareAll();
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(result.ready, false);
    assert.equal(
      result.failures.length,
      3,
      'one failure per runtime: the first one must not end the run',
    );
    for (const failure of result.failures) {
      assert.ok(failure.message.length > 0);
      assert.ok(failure.remedy.length > 0);
      assert.ok(!/PATH/i.test(failure.message), 'user-facing text must stay actionable');
    }
  });
});

test('asking for an unknown runtime is a programming error, not a silent null', async () => {
  await withTempHome((paths) => {
    const manager = new RuntimeManager({ paths, fetchImpl: makeFetch({}) });
    assert.throws(() => manager.get('nope' as 'codex'), /No runtime registered/);
  });
});

// ---------------------------------------------------------------------------
// Source ordering and contract classification
// ---------------------------------------------------------------------------

test('Codex prefers the documented release channel over package internals', () => {
  const sources = defaultCodexSources(makeFetch({}));
  assert.equal(sources[0]!.contract, 'DOCUMENTED');
  assert.equal(sources[0]!.id, 'codex-official-release');
  const npmSource = sources.find((s) => s.id === 'codex-npm-registry')!;
  assert.equal(npmSource.contract, 'PACKAGE_INTERNAL');
  assert.ok(sources.indexOf(npmSource) > 0, 'npm must not be the primary contract');
});

test('Claude puts the documented installer first and the observed host last', () => {
  const sources = defaultClaudeSources(makeFetch({}));
  assert.equal(sources[0]!.contract, 'DOCUMENTED');
  const last = sources[sources.length - 1]!;
  assert.equal(last.id, 'claude-release-host');
  assert.equal(
    last.contract,
    'NOT_PUBLIC_CONTRACT',
    'a host observed inside a binary is not a public interface',
  );
});

test('the contract labels are the exact strings shown in reports', () => {
  assert.equal(CONTRACT_LABELS.DOCUMENTED, 'DOCUMENTED');
  assert.equal(CONTRACT_LABELS.PACKAGE_INTERNAL, 'PACKAGE INTERNAL');
  assert.equal(
    CONTRACT_LABELS.NOT_PUBLIC_CONTRACT,
    'IMPLEMENTATION DETAIL / NOT PUBLIC CONTRACT',
  );
});

test('a source that cannot serve the target declines instead of guessing a URL', async () => {
  // The release channel answers with a manifest that has no matching asset.
  const { CodexOfficialReleaseSource } = await import('../src/runtime/sources/codex-sources.js');
  const fetchImpl = makeFetch({
    'https://releases.openai.com/codex/latest': {
      body: { version: '1.0.0', assets: [{ name: 'codex-linux-arm64.tar.gz', url: 'https://x/y' }] },
    },
  });
  const source = new CodexOfficialReleaseSource(undefined, fetchImpl);
  const resolved = await source.resolve({ platform: 'win32', arch: 'x64' }, { kind: 'latest' });
  assert.equal(resolved, null, 'no Windows asset means decline, not a wrong URL');
});

test('the release channel resolves a matching Windows asset', async () => {
  const { CodexOfficialReleaseSource } = await import('../src/runtime/sources/codex-sources.js');
  const fetchImpl = makeFetch({
    'https://releases.openai.com/codex/latest': {
      body: {
        version: '2.5.0',
        assets: [
          { name: 'codex-aarch64-apple-darwin.tar.gz', url: 'https://x/mac' },
          { name: 'codex-x86_64-pc-windows-msvc.zip', url: 'https://x/win.zip' },
        ],
      },
    },
  });
  const source = new CodexOfficialReleaseSource(undefined, fetchImpl);
  const resolved = await source.resolve({ platform: 'win32', arch: 'x64' }, { kind: 'latest' });
  assert.equal(resolved?.url, 'https://x/win.zip');
  assert.equal(resolved?.version, '2.5.0');
  assert.equal(resolved?.archiveKind, 'zip');
  assert.deepEqual(resolved?.executableNames, ['codex.exe']);
});

test('an unreachable source declines rather than throwing the install away', async () => {
  const source = new CodexNpmRegistrySource(makeFetch({}));
  const resolved = await source.resolve({ platform: 'win32', arch: 'x64' }, { kind: 'latest' });
  assert.equal(resolved, null);
});
