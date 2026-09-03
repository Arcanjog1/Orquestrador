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
import { makeFetch } from './helpers/fake-runtime-source.js';

function withTempHome<T>(fn: (paths: ReturnType<typeof appPaths>) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'lao-mgr-'));
  try {
    return fn(ensureAppPaths(appPaths({ AI_ORCHESTRATOR_HOME: home } as NodeJS.ProcessEnv)));
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

test('Git offers instructions rather than automatic setup until a source exists', async () => {
  await withTempHome(async (paths) => {
    const manager = new RuntimeManager({ paths, fetchImpl: makeFetch({}) });
    const git = manager.get('git');
    assert.equal(git.sources.length, 0);

    const result = await manager.prepareAll();
    const gitFailure = result.failures.find((f) => f.runtimeId === 'git');
    if (gitFailure) {
      assert.match(gitFailure.message, /precisa ser instalado/);
      assert.equal(gitFailure.remedy, 'Ver instruções');
    }
  });
});

test('prepareAll collects failures instead of stopping at the first one', async () => {
  await withTempHome(async (paths) => {
    // Every network call fails, so nothing can be installed.
    const manager = new RuntimeManager({ paths, fetchImpl: makeFetch({}) });
    const result = await manager.prepareAll();

    assert.equal(result.ready, false);
    assert.ok(result.failures.length >= 2, 'each unmet runtime should be reported');
    for (const failure of result.failures) {
      assert.ok(failure.message.length > 0);
      assert.ok(failure.remedy.length > 0);
      assert.ok(!/PATH/i.test(failure.message), 'user-facing text must stay actionable');
    }
  });
});

test('asking for an unknown runtime is a programming error, not a silent null', () => {
  withTempHome((paths) => {
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
  const resolved = await source.resolve({ platform: 'win32', arch: 'x64' });
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
  const resolved = await source.resolve({ platform: 'win32', arch: 'x64' });
  assert.equal(resolved?.url, 'https://x/win.zip');
  assert.equal(resolved?.version, '2.5.0');
  assert.equal(resolved?.archiveKind, 'zip');
  assert.deepEqual(resolved?.executableNames, ['codex.exe']);
});

test('an unreachable source declines rather than throwing the install away', async () => {
  const source = new CodexNpmRegistrySource(makeFetch({}));
  const resolved = await source.resolve({ platform: 'win32', arch: 'x64' });
  assert.equal(resolved, null);
});
