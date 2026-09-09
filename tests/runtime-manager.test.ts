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

async function withTempHome<T>(fn: (paths: ReturnType<typeof appPaths>) => T): Promise<Awaited<T>> {
  const home = mkdtempSync(join(tmpdir(), 'lao-mgr-'));
  try {
    return await fn(ensureAppPaths(appPaths({ AI_ORCHESTRATOR_HOME: home } as NodeJS.ProcessEnv)));
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
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
    // Every network call fails, so nothing can be installed.
    const manager = new RuntimeManager({ paths, fetchImpl: makeFetch({}) });
    const result = await manager.prepareAll();

    assert.equal(result.ready, false);
    assert.ok(result.failures.length > 0, 'an unavailable source is reported');
    const pending = (await manager.diagnose()).pending;
    assert.equal(result.failures.length, pending.length, 'each unmet runtime is reported, including when this machine already has a working runtime');
    for (const failure of result.failures) {
      assert.ok(failure.message.length > 0);
      assert.ok(failure.remedy.length > 0);
      assert.ok(!/PATH/i.test(failure.message), 'user-facing text must stay actionable');
    }
  });
});

test('asking for an unknown runtime is a programming error, not a silent null', () => {
  return withTempHome((paths) => {
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
  assert.equal(sources[0]!.id, 'codex-github-releases');
  const npmSource = sources.find((s) => s.id === 'codex-npm-registry')!;
  assert.equal(npmSource.contract, 'PACKAGE_INTERNAL');
  assert.ok(sources.indexOf(npmSource) > 0, 'npm must not be the primary contract');
});

test('Claude installs from the channel the official installer itself uses', () => {
  const sources = defaultClaudeSources(makeFetch({}));
  assert.deepEqual(sources.map((s) => s.id), ['claude-official-releases']);
  assert.equal(sources[0]!.contract, 'DOCUMENTED');
  assert.equal(
    sources[0]!.integrityStrategy,
    'SHA256',
    'the manifest publishes a digest per platform and it is enforced',
  );
});

test('the Claude manifest decides the platform key; nothing is guessed', async () => {
  const { ClaudeOfficialReleaseSource, claudePlatformKeys, pickPlatform } = await import(
    '../src/runtime/sources/claude-sources.js'
  );
  const digest = 'e'.repeat(64);

  // Windows spelling is unknown from the POSIX installer, so every plausible
  // key is offered and only one the manifest declares is used.
  const keys = claudePlatformKeys({ platform: 'win32', arch: 'x64' });
  assert.ok(keys.includes('win32-x64') && keys.includes('windows-x64'));

  const manifest = { platforms: { 'windows-x64': { checksum: digest, size: 1234 } } };
  const entry = pickPlatform(manifest, { platform: 'win32', arch: 'x64' });
  assert.equal(entry?.key, 'windows-x64');
  assert.equal(entry?.checksum, digest);

  // A platform the manifest does not declare produces no download at all.
  assert.equal(pickPlatform({ platforms: {} }, { platform: 'win32', arch: 'x64' }), null);
  // Nor does one whose checksum is not a real digest.
  assert.equal(
    pickPlatform({ platforms: { 'win32-x64': { checksum: 'nope' } } }, { platform: 'win32', arch: 'x64' }),
    null,
    'an agent binary is never installed without a usable digest',
  );

  const base = 'https://downloads.example.invalid/claude-code-releases';
  const source = new ClaudeOfficialReleaseSource(
    base,
    makeFetch({
      [`${base}/stable`]: { text: '2.1.236\n' },
      [`${base}/2.1.236/manifest.json`]: { body: manifest },
    }),
  );

  const resolved = await source.resolve({ platform: 'win32', arch: 'x64' }, { kind: 'latest' });
  assert.equal(resolved?.url, `${base}/2.1.236/windows-x64/claude.exe`);
  assert.equal(resolved?.version, '2.1.236');
  assert.equal(resolved?.integrity, digest);
  assert.equal(resolved?.expectedBytes, 1234);
  assert.equal(resolved?.archiveKind, 'raw', 'the release is a bare executable, not an archive');
  assert.deepEqual(resolved?.executableNames, ['claude.exe']);
});

test('a tested Claude version is fetched by version, never through the channel', async () => {
  const { ClaudeOfficialReleaseSource } = await import('../src/runtime/sources/claude-sources.js');
  const base = 'https://downloads.example.invalid/claude-code-releases';
  const digest = 'f'.repeat(64);
  const asked: string[] = [];
  const inner = makeFetch({
    [`${base}/2.1.252/manifest.json`]: {
      body: { platforms: { 'linux-x64-musl': { checksum: digest } } },
    },
  });
  const fetchImpl = ((input: string, init?: RequestInit) => {
    asked.push(String(input));
    return inner(input as never, init as never);
  }) as typeof fetch;

  const source = new ClaudeOfficialReleaseSource(base, fetchImpl);
  const resolved = await source.resolve(
    { platform: 'linux', arch: 'x64' },
    { kind: 'tested', version: '2.1.252' },
  );

  assert.equal(resolved?.url, `${base}/2.1.252/linux-x64-musl/claude`);
  assert.ok(!asked.some((u) => u.endsWith('/stable')), 'the channel is not consulted');
});

test('a channel that answers something other than a version is refused', async () => {
  const { ClaudeOfficialReleaseSource } = await import('../src/runtime/sources/claude-sources.js');
  const base = 'https://downloads.example.invalid/claude-code-releases';
  // A region block or an error page is not a version.
  const source = new ClaudeOfficialReleaseSource(
    base,
    makeFetch({ [`${base}/stable`]: { text: '<html>not available in your country</html>' } }),
  );
  const resolved = await source.resolve({ platform: 'linux', arch: 'x64' }, { kind: 'latest' });
  assert.equal(resolved, null);
});

test('the contract labels are the exact strings shown in reports', () => {
  assert.equal(CONTRACT_LABELS.DOCUMENTED, 'DOCUMENTED');
  assert.equal(CONTRACT_LABELS.PACKAGE_INTERNAL, 'PACKAGE INTERNAL');
  assert.equal(
    CONTRACT_LABELS.NOT_PUBLIC_CONTRACT,
    'IMPLEMENTATION DETAIL / NOT PUBLIC CONTRACT',
  );
});

interface FakeAsset {
  name: string;
  url: string;
  bytes?: number;
}

/** A GitHub release payload in the shape the API really returns. */
function release(tag: string, assets: readonly FakeAsset[]): Record<string, unknown> {
  return {
    tag_name: tag,
    name: tag.replace(/^rust-v/, ''),
    draft: false,
    prerelease: false,
    assets: assets.map((a) => ({
      name: a.name,
      browser_download_url: a.url,
      size: a.bytes ?? 0,
    })),
  };
}

const CODEX_LATEST = 'https://api.github.com/repos/openai/codex/releases/latest';
const CODEX_TAGGED = 'https://api.github.com/repos/openai/codex/releases/tags/rust-v0.153.0';

test('a source that cannot serve the target declines instead of guessing a URL', async () => {
  // A release with builds for other platforms, but nothing for Windows x64.
  const { CodexGitHubReleaseSource } = await import('../src/runtime/sources/codex-sources.js');
  const fetchImpl = makeFetch({
    [CODEX_LATEST]: {
      body: release('rust-v1.0.0', [
        { name: 'codex-package-aarch64-apple-darwin.tar.gz', url: 'https://x/mac' },
      ]),
    },
  });
  const source = new CodexGitHubReleaseSource(fetchImpl, 'openai/codex', {});
  const resolved = await source.resolve({ platform: 'win32', arch: 'x64' }, { kind: 'latest' });
  assert.equal(resolved, null, 'no Windows asset means decline, not a wrong URL');
});

test('the Windows asset is matched by target triple, not by the word "windows"', async () => {
  const { CodexGitHubReleaseSource } = await import('../src/runtime/sources/codex-sources.js');
  const digest = 'a'.repeat(64);
  const arm = 'b'.repeat(64);
  const fetchImpl = makeFetch({
    [CODEX_LATEST]: {
      body: release('rust-v2.5.0', [
        // The ARM64 build is listed first on purpose: a matcher that takes the
        // first asset mentioning windows would pick exactly the wrong one.
        { name: 'codex-package-aarch64-pc-windows-msvc.tar.gz', url: 'https://x/win-arm' },
        { name: 'codex-package-x86_64-pc-windows-msvc.tar.gz', url: 'https://x/win-x64', bytes: 42 },
        { name: 'codex-package_SHA256SUMS', url: 'https://x/sums' },
      ]),
    },
    'https://x/sums': {
      text: [
        `${arm}  codex-package-aarch64-pc-windows-msvc.tar.gz`,
        `${digest}  codex-package-x86_64-pc-windows-msvc.tar.gz`,
      ].join('\n'),
    },
  });

  const source = new CodexGitHubReleaseSource(fetchImpl, 'openai/codex', {});
  const resolved = await source.resolve({ platform: 'win32', arch: 'x64' }, { kind: 'latest' });

  assert.equal(resolved?.url, 'https://x/win-x64');
  assert.equal(resolved?.version, '2.5.0');
  assert.equal(resolved?.archiveKind, 'tgz');
  assert.equal(resolved?.integrity, digest);
  assert.equal(resolved?.expectedBytes, 42);
  assert.deepEqual(resolved?.executableNames, ['codex.exe']);
});

test('an asset with no published digest is refused rather than installed unverified', async () => {
  const { CodexGitHubReleaseSource } = await import('../src/runtime/sources/codex-sources.js');
  const fetchImpl = makeFetch({
    [CODEX_LATEST]: {
      body: release('rust-v2.5.0', [
        { name: 'codex-package-x86_64-pc-windows-msvc.tar.gz', url: 'https://x/win' },
        { name: 'codex-x86_64-pc-windows-msvc.exe.zip', url: 'https://x/win-zip' },
        // The manifest exists but covers neither asset.
        { name: 'codex-package_SHA256SUMS', url: 'https://x/sums' },
      ]),
    },
    'https://x/sums': { text: `${'c'.repeat(64)}  codex-package-x86_64-apple-darwin.tar.gz` },
  });

  const source = new CodexGitHubReleaseSource(fetchImpl, 'openai/codex', {});
  const resolved = await source.resolve({ platform: 'win32', arch: 'x64' }, { kind: 'latest' });
  assert.equal(resolved, null, 'an agent binary is never installed without a published digest');
});

test('a tested version is requested by its own tag, never silently as latest', async () => {
  const { CodexGitHubReleaseSource } = await import('../src/runtime/sources/codex-sources.js');
  const digest = 'd'.repeat(64);
  const asked: string[] = [];
  const base = makeFetch({
    [CODEX_TAGGED]: {
      body: release('rust-v0.153.0', [
        { name: 'codex-package-x86_64-pc-windows-msvc.tar.gz', url: 'https://x/win' },
        { name: 'codex-package_SHA256SUMS', url: 'https://x/sums' },
      ]),
    },
    'https://x/sums': { text: `${digest}  codex-package-x86_64-pc-windows-msvc.tar.gz` },
  });
  const fetchImpl = ((input: string, init?: RequestInit) => {
    asked.push(String(input));
    return base(input as never, init as never);
  }) as typeof fetch;

  const source = new CodexGitHubReleaseSource(fetchImpl, 'openai/codex', {});
  const resolved = await source.resolve(
    { platform: 'win32', arch: 'x64' },
    { kind: 'tested', version: '0.153.0' },
  );

  assert.equal(resolved?.version, '0.153.0');
  assert.ok(asked.includes(CODEX_TAGGED), 'the tested version is asked for by tag');
  assert.ok(!asked.includes(CODEX_LATEST), 'and latest is never consulted behind its back');
});

test('a tested version that no longer has a release declines instead of taking latest', async () => {
  const { CodexGitHubReleaseSource } = await import('../src/runtime/sources/codex-sources.js');
  const fetchImpl = makeFetch({
    // Only `latest` is served: the tagged release is gone.
    [CODEX_LATEST]: {
      body: release('rust-v9.9.9', [
        { name: 'codex-package-x86_64-pc-windows-msvc.tar.gz', url: 'https://x/win' },
      ]),
    },
  });
  const source = new CodexGitHubReleaseSource(fetchImpl, 'openai/codex', {});
  const resolved = await source.resolve(
    { platform: 'win32', arch: 'x64' },
    { kind: 'tested', version: '0.153.0' },
  );
  assert.equal(resolved, null, 'a missing tested release is not an invitation to install latest');
});

test('the ARM64 Windows triple is prepared, even while it is out of scope', async () => {
  const { codexTargetTriple, codexAssetCandidates } = await import(
    '../src/runtime/sources/codex-sources.js'
  );
  const triple = codexTargetTriple({ platform: 'win32', arch: 'arm64' });
  assert.equal(triple, 'aarch64-pc-windows-msvc');
  const names = codexAssetCandidates(triple!, { platform: 'win32', arch: 'arm64' }).map(
    (c) => c.name,
  );
  assert.deepEqual(names, [
    'codex-package-aarch64-pc-windows-msvc.tar.gz',
    'codex-aarch64-pc-windows-msvc.exe.zip',
  ]);
});

test('the endpoint that answered 404 on real Windows is no longer tried', async () => {
  const { defaultCodexSources } = await import('../src/runtime/sources/codex-sources.js');
  const ids = defaultCodexSources().map((s) => s.id);
  assert.deepEqual(ids, ['codex-github-releases', 'codex-npm-registry']);
  assert.ok(
    !ids.includes('codex-official-release'),
    'releases.openai.com/codex 404s; it must not spend a first run',
  );
});

test('an unreachable source declines rather than throwing the install away', async () => {
  const source = new CodexNpmRegistrySource(makeFetch({}));
  const resolved = await source.resolve({ platform: 'win32', arch: 'x64' }, { kind: 'latest' });
  assert.equal(resolved, null);
});
