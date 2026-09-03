import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, parseVersion } from '../src/runtime/version.js';
import {
  evaluateCompatibility,
  firstInstallRequest,
  RUNTIME_COMPATIBILITY,
  type RuntimeCompatibility,
} from '../src/runtime/compatibility.js';
import { judgeAuthenticode, verifyBytes, verifySubresourceIntegrity } from '../src/runtime/integrity.js';
import { ManagedRuntime } from '../src/runtime/managed-runtime.js';
import { appPaths, ensureAppPaths } from '../src/runtime/paths.js';
import type { RuntimeId, RuntimeSource } from '../src/runtime/types.js';
import { buildFakeArchive, makeFetch, StubSource } from './helpers/fake-runtime-source.js';

// ---------------------------------------------------------------------------
// 1. Version comparison
// ---------------------------------------------------------------------------

test('the platform suffix on a published build is not read as a prerelease', () => {
  // Strict semver would sort 0.153.0-win32-x64 BEFORE 0.153.0, which would make
  // every platform build look older than the release it belongs to.
  const parsed = parseVersion('0.153.0-win32-x64');
  assert.equal(parsed?.platformSuffix, 'win32-x64');
  assert.equal(parsed?.prerelease, null);
  assert.equal(compareVersions('0.153.0-win32-x64', '0.153.0'), 0);
});

test('versions order correctly, including genuine prereleases', () => {
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('v2.1.252', '2.1.252'), 0);
  // A real prerelease still ranks below its release.
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
});

// ---------------------------------------------------------------------------
// 2. Compatibility policy
// ---------------------------------------------------------------------------

test('a first install asks for the tested version, not for latest', () => {
  const request = firstInstallRequest(RUNTIME_COMPATIBILITY.codex);
  assert.equal(request.kind, 'tested');
  assert.equal(request.version, RUNTIME_COMPATIBILITY.codex.testedVersion);
});

test('the compatible policy accepts inside the window and refuses outside it', () => {
  const policy: RuntimeCompatibility = {
    runtimeId: 'codex',
    testedVersion: '1.5.0',
    minVersion: '1.0.0',
    maxVersion: '2.0.0',
    updatePolicy: 'compatible',
  };
  assert.equal(evaluateCompatibility(policy, '1.5.0').compatible, true);
  assert.equal(evaluateCompatibility(policy, '1.9.9').compatible, true);

  const tooOld = evaluateCompatibility(policy, '0.9.0');
  assert.equal(tooOld.compatible, false);
  assert.equal(tooOld.verdict, 'below-minimum');

  const tooNew = evaluateCompatibility(policy, '2.1.0');
  assert.equal(tooNew.compatible, false);
  assert.equal(tooNew.verdict, 'above-maximum');
  assert.match(tooNew.reason, /máxima testada/);
});

test('the pinned policy refuses anything but the tested version', () => {
  const policy: RuntimeCompatibility = {
    runtimeId: 'codex',
    testedVersion: '1.5.0',
    updatePolicy: 'pinned',
  };
  assert.equal(evaluateCompatibility(policy, '1.5.0').compatible, true);
  assert.equal(evaluateCompatibility(policy, '1.6.0').verdict, 'not-tested-policy-pinned');
});

test('an unreadable version is refused rather than assumed compatible', () => {
  const policy = RUNTIME_COMPATIBILITY.codex;
  const decision = evaluateCompatibility(policy, 'nightly-build');
  assert.equal(decision.compatible, false);
  assert.equal(decision.verdict, 'unparseable');
});

test('every shipped runtime declares a tested version and a policy', () => {
  for (const [id, policy] of Object.entries(RUNTIME_COMPATIBILITY)) {
    assert.equal(policy.runtimeId, id);
    assert.ok(parseVersion(policy.testedVersion), `${id} testedVersion must parse`);
    assert.notEqual(policy.updatePolicy, 'latest', `${id} must not blindly track latest`);
  }
});

// ---------------------------------------------------------------------------
// 3. Integrity and trust
// ---------------------------------------------------------------------------

test('a missing checksum is UNVERIFIED, never a pass', () => {
  const bytes = Buffer.from('anything');
  const verdict = verifyBytes('NPM_INTEGRITY', bytes, undefined);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.trustLevel, 'UNVERIFIED_BINARY_SOURCE');
  assert.match(verdict.detail, /não pôde ser comprovada/);
});

test('HTTPS_ONLY_LAST_RESORT is always unverified, even with a value present', () => {
  const bytes = Buffer.from('anything');
  const verdict = verifyBytes('HTTPS_ONLY_LAST_RESORT', bytes, 'sha512-whatever');
  assert.equal(verdict.trustLevel, 'UNVERIFIED_BINARY_SOURCE');
});

test('npm integrity and sha256 both verify and both detect tampering', () => {
  const bytes = Buffer.from('the real payload');
  const sri = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  assert.equal(verifyBytes('NPM_INTEGRITY', bytes, sri).trustLevel, 'VERIFIED');
  assert.equal(verifyBytes('SHA256', bytes, sha256).trustLevel, 'VERIFIED');
  assert.equal(verifyBytes('SHA256', bytes, `sha256-${sha256}`).verified, true);

  const tampered = Buffer.from('the real payload!');
  assert.equal(verifyBytes('NPM_INTEGRITY', tampered, sri).verified, false);
  assert.equal(verifyBytes('SHA256', tampered, sha256).verified, false);
  assert.equal(verifySubresourceIntegrity(tampered, sri), false);
});

test('Authenticode records the observed publisher instead of inventing one', () => {
  // No expectation configured: a valid signature is trusted and the subject is
  // recorded for someone to confirm later.
  const observed = judgeAuthenticode(
    { status: 'Valid', subject: 'CN=Example Corp, O=Example Corp', valid: true },
    undefined,
  );
  assert.equal(observed.trustLevel, 'VERIFIED');
  assert.equal(observed.observedPublisher, 'CN=Example Corp, O=Example Corp');
  assert.match(observed.detail, /registrado para conferência/);

  // With an expectation configured, a mismatch is refused.
  const mismatch = judgeAuthenticode(
    { status: 'Valid', subject: 'CN=Someone Else', valid: true },
    'Example Corp',
  );
  assert.equal(mismatch.verified, false);
  assert.equal(mismatch.trustLevel, 'UNVERIFIED_BINARY_SOURCE');

  // An unsigned or broken signature is never trusted.
  assert.equal(judgeAuthenticode({ status: 'NotSigned', subject: null, valid: false }, undefined).verified, false);
  assert.equal(judgeAuthenticode(null, undefined).trustLevel, 'UNVERIFIED_BINARY_SOURCE');
});

// ---------------------------------------------------------------------------
// 4. Source ordering, rollback and staged promotion
// ---------------------------------------------------------------------------

function withHome<T>(fn: (paths: ReturnType<typeof appPaths>, home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'lao-policy-'));
  try {
    return fn(ensureAppPaths(appPaths({ AI_ORCHESTRATOR_HOME: home } as NodeJS.ProcessEnv)), home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

class PolicyRuntime extends ManagedRuntime {
  readonly id: RuntimeId = 'codex';
  readonly displayName = 'Codex';
  readonly sources: readonly RuntimeSource[];
  protected readonly systemExecutableNames = ['not-installed-anywhere-xyz'] as const;

  constructor(sources: RuntimeSource[], options: ConstructorParameters<typeof ManagedRuntime>[0]) {
    super(options);
    this.sources = sources;
  }
}

const OPEN_POLICY: RuntimeCompatibility = {
  runtimeId: 'codex',
  testedVersion: '1.0.0',
  minVersion: '0.0.1',
  updatePolicy: 'compatible',
};

test('a NOT_PUBLIC_CONTRACT source is never tried before a documented one', () => {
  withHome((paths) => {
    const notPublic = new StubSource('observed', 'Observed host', 'NOT_PUBLIC_CONTRACT', null);
    const documented = new StubSource('official', 'Official', 'DOCUMENTED', null);
    const packageInternal = new StubSource('pkg', 'Package', 'PACKAGE_INTERNAL', null);

    // Declared deliberately in the worst possible order.
    const runtime = new PolicyRuntime([notPublic, packageInternal, documented], { paths });
    assert.deepEqual(
      runtime.orderedSources().map((s) => s.id),
      ['official', 'pkg', 'observed'],
    );
  });
});

test('an unverifiable source is ranked below one that can prove itself', () => {
  withHome((paths) => {
    const unverifiable = new StubSource('loose', 'Loose', 'DOCUMENTED', null, 'HTTPS_ONLY_LAST_RESORT');
    const verifiable = new StubSource('strict', 'Strict', 'DOCUMENTED', null, 'SHA256');
    const runtime = new PolicyRuntime([unverifiable, verifiable], { paths });
    assert.deepEqual(runtime.orderedSources().map((s) => s.id), ['strict', 'loose']);
  });
});

test('an install requests the tested version rather than latest', async () => {
  await withHome(async (paths, home) => {
    const archive = buildFakeArchive(home, 'codex');
    const source = new StubSource('s', 'S', 'DOCUMENTED', {
      url: archive.url,
      version: '1.0.0',
      archiveKind: 'tgz',
      integrity: archive.integrity,
      executableNames: ['codex'],
    });
    const runtime = new PolicyRuntime([source], {
      paths,
      compatibility: OPEN_POLICY,
      fetchImpl: makeFetch({ [archive.url]: { bytes: archive.bytes } }),
    });

    await runtime.install();
    assert.deepEqual(source.requests[0], { kind: 'tested', version: '1.0.0' });
  });
});

test('a version outside the window is refused, even when a source offers it', async () => {
  await withHome(async (paths, home) => {
    const archive = buildFakeArchive(home, 'codex');
    const runtime = new PolicyRuntime(
      [
        new StubSource('s', 'S', 'DOCUMENTED', {
          url: archive.url,
          version: '99.0.0',
          archiveKind: 'tgz',
          executableNames: ['codex'],
        }),
      ],
      {
        paths,
        compatibility: { ...OPEN_POLICY, maxVersion: '2.0.0' },
        fetchImpl: makeFetch({ [archive.url]: { bytes: archive.bytes } }),
      },
    );

    await assert.rejects(
      () => runtime.install(),
      (err: unknown) => {
        assert.match((err as { detail?: string }).detail ?? '', /máxima testada/);
        return true;
      },
    );
    assert.equal(existsSync(runtime.manifestPath), false, 'nothing may be installed');
  });
});

test('an update keeps the replaced build as previous, and can roll back to it', async () => {
  await withHome(async (paths, home) => {
    const first = buildFakeArchive(join(home, 'v1'), 'codex', '#!/bin/sh\necho "v1"\n');
    const second = buildFakeArchive(join(home, 'v2'), 'codex', '#!/bin/sh\necho "v2"\n');

    const options = {
      paths,
      compatibility: OPEN_POLICY,
      fetchImpl: makeFetch({
        [first.url]: { bytes: first.bytes },
        ['https://example.invalid/v2.tgz']: { bytes: second.bytes },
      }),
    };

    const runtimeV1 = new PolicyRuntime(
      [
        new StubSource('s', 'S', 'DOCUMENTED', {
          url: first.url,
          version: '1.0.0',
          archiveKind: 'tgz',
          executableNames: ['codex'],
        }),
      ],
      options,
    );
    await runtimeV1.install();
    assert.equal(runtimeV1.readManifest()?.version, '1.0.0');
    assert.equal(runtimeV1.canRollBack, false, 'nothing to roll back to on a first install');

    const runtimeV2 = new PolicyRuntime(
      [
        new StubSource('s', 'S', 'DOCUMENTED', {
          url: 'https://example.invalid/v2.tgz',
          version: '1.1.0',
          archiveKind: 'tgz',
          executableNames: ['codex'],
        }),
      ],
      options,
    );
    await runtimeV2.install();

    const manifest = runtimeV2.readManifest();
    assert.equal(manifest?.version, '1.1.0');
    assert.equal(manifest?.previousVersion, '1.0.0', 'the manifest records what it replaced');
    assert.equal(runtimeV2.canRollBack, true);
    assert.equal(runtimeV2.readPreviousManifest()?.version, '1.0.0');

    const restored = await runtimeV2.rollBack();
    assert.equal(restored?.rolledBack, true);
    assert.equal(runtimeV2.readManifest()?.version, '1.0.0');
    assert.match(readFileSync(restored!.executablePath, 'utf8'), /v1/);
  });
});

test('a build that fails its capability check never replaces the working one', async () => {
  await withHome(async (paths, home) => {
    const good = buildFakeArchive(join(home, 'good'), 'codex', '#!/bin/sh\necho "good"\n');
    const options = {
      paths,
      compatibility: OPEN_POLICY,
      fetchImpl: makeFetch({ [good.url]: { bytes: good.bytes } }),
    };

    const runtime = new PolicyRuntime(
      [
        new StubSource('s', 'S', 'DOCUMENTED', {
          url: good.url,
          version: '1.0.0',
          archiveKind: 'tgz',
          executableNames: ['codex'],
        }),
      ],
      options,
    );
    await runtime.install();
    const workingExecutable = join(runtime.currentDir, runtime.readManifest()!.executableRelativePath);
    const workingContents = readFileSync(workingExecutable, 'utf8');

    // The next build refuses its capability check.
    const failing = new PolicyRuntime(
      [
        new StubSource('s2', 'S2', 'DOCUMENTED', {
          url: good.url,
          version: '1.2.0',
          archiveKind: 'tgz',
          executableNames: ['codex'],
        }),
      ],
      options,
    );
    Object.defineProperty(failing, 'capabilityCheck', {
      value: async () => ({ ok: false, detail: 'does not speak the expected interface' }),
      writable: true,
    });

    await assert.rejects(() => failing.install(), /capability check/);

    // The working build is exactly as it was: still 1.0.0, same bytes.
    assert.equal(runtime.readManifest()?.version, '1.0.0');
    assert.equal(readFileSync(workingExecutable, 'utf8'), workingContents);
  });
});

test('staging is cleaned up even when an install fails', async () => {
  await withHome(async (paths, home) => {
    const archive = buildFakeArchive(home, 'codex');
    const runtime = new PolicyRuntime(
      [
        new StubSource('s', 'S', 'DOCUMENTED', {
          url: archive.url,
          version: '1.0.0',
          archiveKind: 'tgz',
          integrity: 'sha512-DEFINITELYWRONG',
          executableNames: ['codex'],
        }),
      ],
      { paths, compatibility: OPEN_POLICY, fetchImpl: makeFetch({ [archive.url]: { bytes: archive.bytes } }) },
    );

    await assert.rejects(() => runtime.install());
    const { readdirSync } = await import('node:fs');
    assert.equal(readdirSync(paths.staging).length, 0);
  });
});

test('rollBack does nothing when there is no previous build', async () => {
  await withHome(async (paths) => {
    const runtime = new PolicyRuntime([], { paths, compatibility: OPEN_POLICY });
    assert.equal(await runtime.rollBack(), null);
  });
});

test('licence files shipped with a runtime are recorded in the manifest', async () => {
  await withHome(async (paths, home) => {
    const archive = buildFakeArchive(home, 'git');
    // Add a licence next to the executable, as MinGit ships one.
    const { execFileSync } = await import('node:child_process');
    const extra = join(home, 'licensed');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(extra, 'package'), { recursive: true });
    writeFileSync(join(extra, 'package', 'LICENSE.txt'), 'GNU GENERAL PUBLIC LICENSE v2\n');
    writeFileSync(join(extra, 'package', 'git'), '#!/bin/sh\necho "git version 2.47.0"\n', { mode: 0o755 });
    const tarball = join(home, 'licensed.tgz');
    execFileSync('tar', ['-czf', tarball, '-C', extra, 'package'], { stdio: 'ignore' });
    const bytes = readFileSync(tarball);

    const { GitRuntime } = await import('../src/runtime/runtimes.js');
    const runtime = new GitRuntime({
      paths,
      compatibility: { runtimeId: 'git', testedVersion: '2.47.0', minVersion: '2.0.0', updatePolicy: 'compatible' },
      fetchImpl: makeFetch({ 'https://example.invalid/git.tgz': { bytes } }),
    });
    Object.defineProperty(runtime, 'sources', {
      value: [
        new StubSource('git-src', 'Git source', 'DOCUMENTED', {
          url: 'https://example.invalid/git.tgz',
          version: '2.47.0',
          archiveKind: 'tgz',
          executableNames: ['git'],
        }),
      ],
      writable: true,
    });

    const result = await runtime.install();
    assert.deepEqual(result.manifest.licenseFiles, [join('package', 'LICENSE.txt')]);
    void archive;
  });
});
