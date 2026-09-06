/**
 * The compatibility window, applied to what is actually on the machine.
 *
 * The incident: a machine had an old Codex on its PATH. The application
 * found it, called it ready, and ran it; the backend's model catalogue now
 * carries reasoning levels that build did not know, so every run died at
 * start-up. The window existed but only governed *downloads*. Now it governs
 * every executable: too old on the PATH means "install the tested build",
 * and a managed install behind the tested version is brought up to it - with
 * the person's account profiles left exactly where they are.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedRuntime, versionNumberOf } from '../src/runtime/managed-runtime.js';
import { RuntimeManager } from '../src/runtime/runtime-manager.js';
import { appPaths, ensureAppPaths } from '../src/runtime/paths.js';
import { RUNTIME_COMPATIBILITY } from '../src/runtime/compatibility.js';
import {
  RuntimeIncompatibleError,
  type ResolvedDownload,
  type RuntimeId,
  type RuntimeSource,
  type RuntimeTarget,
} from '../src/runtime/types.js';
import type { VersionRequest } from '../src/runtime/compatibility.js';
import { buildFakeArchive, fakeExecutableNames, makeFetch } from './helpers/fake-runtime-source.js';

function pathsFor(home: string) {
  return ensureAppPaths(appPaths({ AI_ORCHESTRATOR_HOME: home } as NodeJS.ProcessEnv));
}

/** A Codex runtime whose PATH lookup and `--version` are what the test says. */
class CodexOnPath extends ManagedRuntime {
  readonly id: RuntimeId = 'codex';
  readonly displayName = 'Codex';
  readonly sources: readonly RuntimeSource[];
  protected readonly systemExecutableNames = ['codex'] as const;

  constructor(
    sources: RuntimeSource[],
    options: ConstructorParameters<typeof ManagedRuntime>[0],
    private readonly onPath: { path: string; versionLine: string } | null,
  ) {
    super(options);
    this.sources = sources;
  }

  protected override findSystemInstallation(): string | null {
    return this.onPath?.path ?? null;
  }

  protected override async readVersion(executablePath: string): Promise<string | null> {
    if (this.onPath && executablePath === this.onPath.path) return this.onPath.versionLine;
    return super.readVersion(executablePath);
  }
}

test('the tested Codex is the current stable release, and the catalogue fixture carries max', () => {
  assert.equal(RUNTIME_COMPATIBILITY.codex.testedVersion, '0.153.4');
  assert.equal(RUNTIME_COMPATIBILITY.codex.minVersion, '0.150.0');
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), 'scripts', 'fixtures', 'codex-models-with-max.json'), 'utf8'),
  ) as { models: Array<{ supported_reasoning_levels: Array<{ effort: string }> }> };
  const efforts = fixture.models.flatMap((m) => m.supported_reasoning_levels.map((l) => l.effort));
  assert.ok(efforts.includes('max') && efforts.includes('ultra'), `fixture efforts: ${efforts.join(',')}`);
  assert.equal(versionNumberOf('codex-cli 0.130.0'), '0.130.0');
  assert.equal(versionNumberOf('git version 2.47.0.windows.1'), '2.47.0');
  assert.equal(versionNumberOf(null), null);
});

test('an old Codex on the PATH is found, refused, and offered an automatic update', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lao-compat-'));
  try {
    const paths = pathsFor(home);
    const runtime = new CodexOnPath([], { paths }, { path: '/usr/local/bin/codex', versionLine: 'codex-cli 0.130.0' });

    const detection = await runtime.detect();
    assert.equal(detection.origin, 'system');
    assert.equal(detection.version, '0.130.0', 'the number, not the whole line');
    assert.match(detection.incompatible ?? '', /0\.130\.0.*anterior à mínima.*0\.150\.0/);

    const health = await runtime.healthCheck();
    assert.equal(health.healthy, false);
    assert.match(health.problem ?? '', /Codex 0\.130\.0 encontrado no PATH é anterior à versão mínima 0\.150\.0/);
    assert.match(health.problem ?? '', /sem mexer nas suas contas/);
    assert.equal(health.remedy, 'Atualizar automaticamente');

    // No adapter ever gets this binary.
    await assert.rejects(runtime.getExecutablePath(), (error: unknown) => {
      assert.ok(error instanceof RuntimeIncompatibleError);
      assert.match(error.userMessage, /Codex 0\.130\.0 não é compatível/);
      return true;
    });

    // And the diagnostic the first-run screen is built on says so.
    const manager = new RuntimeManager({ paths });
    manager.register(runtime);
    const report = await manager.diagnose();
    const codex = report.runtimes.find((r) => r.runtimeId === 'codex')!;
    assert.equal(codex.health.healthy, false);
    assert.ok(report.pending.includes('codex'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a compatible Codex on the PATH is used as before', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lao-compat-ok-'));
  try {
    const runtime = new CodexOnPath([], { paths: pathsFor(home) }, { path: '/opt/codex', versionLine: 'codex-cli 0.153.4' });
    const detection = await runtime.detect();
    assert.equal(detection.incompatible, undefined);
    assert.equal(await runtime.getExecutablePath(), '/opt/codex');
    assert.equal((await runtime.healthCheck()).healthy, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a managed install behind the tested version is brought up to it, and the account profiles are untouched', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lao-compat-upgrade-'));
  try {
    const paths = pathsFor(home);
    // What the previous build installed: 0.150.0, in the managed layout.
    const old = buildFakeArchive(home, 'codex', '0.150.0');
    const fresh = buildFakeArchive(join(home, 'fresh'), 'codex', RUNTIME_COMPATIBILITY.codex.testedVersion);
    // The helper names every archive the same; two builds need two addresses.
    const freshUrl = 'https://example.invalid/fresh.tgz';
    const source = new StubSourceByRequest({
      tested: {
        url: freshUrl,
        version: RUNTIME_COMPATIBILITY.codex.testedVersion,
        archiveKind: 'tgz',
        integrity: fresh.integrity,
        executableNames: fakeExecutableNames('codex'),
      },
      latest: {
        url: old.url,
        version: '0.150.0',
        archiveKind: 'tgz',
        integrity: old.integrity,
        executableNames: fakeExecutableNames('codex'),
      },
    });
    const fetchImpl = makeFetch({ [old.url]: { bytes: old.bytes }, [freshUrl]: { bytes: fresh.bytes } });
    const runtime = new CodexOnPath([source], { paths, fetchImpl }, null);

    // Install the old one the way the old build did: asking for "latest".
    const installed = await runtime.update();
    assert.equal(installed?.manifest.version, '0.150.0');

    // The person's Codex account lives under profiles, beside the runtime.
    const profile = join(paths.profiles, 'openai', 'acc-1');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'auth.json'), '{"tokens":"theirs"}', 'utf8');

    assert.deepEqual(runtime.outdatedManagedVersion(), {
      installed: '0.150.0',
      tested: RUNTIME_COMPATIBILITY.codex.testedVersion,
    });

    const manager = new RuntimeManager({ paths, fetchImpl });
    manager.register(runtime);
    const phases: string[] = [];
    const results = await manager.upgradeOutdated((p) => phases.push(p.phase));
    assert.equal(results.length, 1);
    assert.equal(results[0]!.manifest.version, RUNTIME_COMPATIBILITY.codex.testedVersion);
    assert.equal(source.requests.at(-1)?.kind, 'tested', 'the tested version by its own tag, never "latest"');
    assert.ok(phases.includes('installing') && phases.at(-1) === 'done');

    assert.equal(runtime.outdatedManagedVersion(), null, 'nothing left to do');
    assert.equal((await runtime.detect()).version, RUNTIME_COMPATIBILITY.codex.testedVersion);
    assert.ok(runtime.canRollBack, 'the replaced build is kept as previous');
    assert.equal(readFileSync(join(profile, 'auth.json'), 'utf8'), '{"tokens":"theirs"}', 'the account is exactly as it was');
    assert.ok(existsSync(paths.profiles));

    // Running it again does nothing: it is current.
    assert.deepEqual(await manager.upgradeOutdated(), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** A source that answers differently for the tested version and for "latest". */
class StubSourceByRequest implements RuntimeSource {
  readonly id = 'by-request';
  readonly label = 'By request';
  readonly contract = 'DOCUMENTED' as const;
  readonly integrityStrategy = 'NPM_INTEGRITY' as const;
  readonly requests: Array<{ kind: string }> = [];
  constructor(private readonly answers: { tested: ResolvedDownload; latest: ResolvedDownload }) {}
  async resolve(_target: RuntimeTarget, request: VersionRequest): Promise<ResolvedDownload | null> {
    this.requests.push(request);
    return request.kind === 'tested' ? this.answers.tested : this.answers.latest;
  }
}

/* ------------------------------------------------------------------------ *
 * The Windows incident, end to end: an old Codex on the PATH, no managed
 * build, and "Atualizar". The managed build must be installed beside the old
 * one, win from then on, and the old one must be left exactly as it was.
 * ------------------------------------------------------------------------ */

import { RuntimeService } from '../apps/desktop/src/main/services/runtime-service.js';
import { EventBus } from '../apps/desktop/src/main/events.js';
import { fakeExecutableName, fakeExecutableBody } from './helpers/fake-runtime-source.js';

/** A source that resolves to a fake archive on disk, served by a fake fetch. */
function archiveSource(home: string, version: string, id = 'fake-source'): { source: RuntimeSource; fetch: typeof fetch } {
  const archive = buildFakeArchive(join(home, `archive-${id}`), 'codex', version);
  const source: RuntimeSource = {
    id,
    label: id,
    contract: 'DOCUMENTED',
    integrityStrategy: 'NPM_INTEGRITY',
    async resolve(): Promise<ResolvedDownload> {
      return {
        url: archive.url,
        version,
        archiveKind: 'tgz',
        executableNames: archive.executableNames,
        integrity: archive.integrity,
      };
    },
  };
  return { source, fetch: makeFetch({ [archive.url]: { bytes: archive.bytes } }) };
}

test('an old Codex on the PATH: the managed build is installed beside it, wins, and the old one is untouched', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lao-path-old-'));
  try {
    const paths = pathsFor(home);
    // The person's own Codex 0.104.0, installed by npm, on the PATH. A real
    // file, so "untouched" can be checked byte for byte.
    const pathDir = join(home, 'on-path');
    mkdirSync(pathDir, { recursive: true });
    const oldCodex = join(pathDir, fakeExecutableName('codex'));
    writeFileSync(oldCodex, fakeExecutableBody('codex-cli 0.104.0'), 'utf8');
    const oldBytes = readFileSync(oldCodex);

    const tested = RUNTIME_COMPATIBILITY.codex.testedVersion;
    const { source, fetch } = archiveSource(home, tested);
    const runtime = new CodexOnPath([source], { paths, fetchImpl: fetch }, { path: oldCodex, versionLine: 'codex-cli 0.104.0' });

    // Before: found, refused, not ready.
    const before = await runtime.detect();
    assert.equal(before.origin, 'system');
    assert.equal(before.version, '0.104.0');
    assert.ok(before.incompatible);
    await assert.rejects(runtime.getExecutablePath(), RuntimeIncompatibleError);

    const manager = new RuntimeManager({ paths, fetchImpl: fetch });
    manager.register(runtime);
    const status = (await manager.diagnose()).runtimes.find((r) => r.runtimeId === 'codex')!;
    assert.equal(status.needsManaged, true, 'the diagnostic says the managed build is needed');
    assert.equal(status.canAutoConfigure, true);

    // "Atualizar": the same call the button makes.
    const phases: string[] = [];
    const result = await manager.install('codex', (p) => phases.push(p.phase));
    assert.equal(result.manifest.version, tested);
    assert.equal(result.health.healthy, true);
    assert.deepEqual(
      [...new Set(phases)],
      ['resolving', 'downloading', 'verifying', 'extracting', 'staging-health-check', 'installing', 'health-check', 'done'],
      'the flow the person watches: preparing, downloading, verifying, installing, testing, ready',
    );

    // After: the managed build wins, and is what adapters get.
    const after = await runtime.detect();
    assert.equal(after.origin, 'managed');
    assert.equal(after.version, tested);
    assert.equal(after.incompatible, undefined);
    const executable = await runtime.getExecutablePath();
    assert.ok(executable.startsWith(paths.runtimes), `managed path, got ${executable}`);
    assert.notEqual(executable, oldCodex);
    assert.equal((await runtime.healthCheck()).healthy, true);
    assert.equal(status.lastFailure, null);

    // The old Codex on the PATH: same file, same bytes, same place.
    assert.ok(existsSync(oldCodex));
    assert.deepEqual(readFileSync(oldCodex), oldBytes);

    // And the start-up sweep does nothing more once the build is right.
    assert.deepEqual(await manager.upgradeOutdated(), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the start-up sweep installs the managed build by itself when the PATH one is too old', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lao-path-sweep-'));
  try {
    const paths = pathsFor(home);
    const tested = RUNTIME_COMPATIBILITY.codex.testedVersion;
    const { source, fetch } = archiveSource(home, tested);
    const runtime = new CodexOnPath([source], { paths, fetchImpl: fetch }, { path: '/usr/bin/codex', versionLine: 'codex-cli 0.104.0' });
    const manager = new RuntimeManager({ paths, fetchImpl: fetch });
    manager.register(runtime);

    const results = await manager.upgradeOutdated();
    assert.equal(results.length, 1);
    assert.equal(results[0]!.manifest.version, tested);
    assert.equal((await runtime.detect()).origin, 'managed');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a failed install says which step failed, per source, and the service hands it to the interface', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lao-path-fail-'));
  try {
    const paths = pathsFor(home);
    const tested = RUNTIME_COMPATIBILITY.codex.testedVersion;
    // Source one: the GitHub API refuses (rate limit). Source two: resolves,
    // but the download answers 404.
    const limited: RuntimeSource = {
      id: 'codex-github-releases',
      label: 'GitHub',
      contract: 'DOCUMENTED',
      integrityStrategy: 'SHA256',
      async resolve() {
        throw new Error('GitHub API answered HTTP 403 - API rate limit exhausted, resets at 2026-09-06T20:00:00.000Z for https://api.github.com/repos/openai/codex/releases/tags/rust-v0.153.4');
      },
    };
    const gone: RuntimeSource = {
      id: 'codex-npm-registry',
      label: 'npm',
      contract: 'PACKAGE_INTERNAL',
      integrityStrategy: 'NPM_INTEGRITY',
      async resolve(): Promise<ResolvedDownload> {
        return { url: 'https://example.invalid/gone.tgz', version: tested, archiveKind: 'tgz', executableNames: ['codex'] };
      },
    };
    const fetch404 = makeFetch({});
    const runtime = new CodexOnPath([limited, gone], { paths, fetchImpl: fetch404 }, { path: '/usr/bin/codex', versionLine: 'codex-cli 0.104.0' });
    const manager = new RuntimeManager({ paths, fetchImpl: fetch404 });
    manager.register(runtime);

    const bus = new EventBus();
    const events: Array<{ phase: string; detail?: string | null }> = [];
    bus.subscribe((channel, payload) => {
      if (channel === 'runtime:progress') {
        const e = payload as { phase: string; detail?: string | null };
        events.push({ phase: e.phase, detail: e.detail });
      }
    });
    const service = new RuntimeService(manager, bus, null);

    const outcome = await service.install('codex');
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /Não foi possível preparar Codex automaticamente/);
    assert.ok(outcome.detail, 'the steps are on the record');
    assert.match(outcome.detail!, /\[codex-github-releases\] resolving: GitHub API answered HTTP 403 - API rate limit exhausted/);
    assert.match(outcome.detail!, /\[codex-npm-registry\] downloading: Could not download https:\/\/example\.invalid\/gone\.tgz: the server answered HTTP 404/);
    const failed = events.find((e) => e.phase === 'failed');
    assert.ok(failed?.detail?.includes('rate limit'), 'the event carries the same detail');

    // The diagnostic keeps it until an install succeeds.
    const view = await service.diagnose();
    const codex = view.runtimes.find((r) => r.runtimeId === 'codex')!;
    assert.equal(codex.ready, false);
    assert.equal(codex.needsManaged, true);
    assert.match(codex.lastFailure?.detail ?? '', /resolving: GitHub API answered HTTP 403/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
