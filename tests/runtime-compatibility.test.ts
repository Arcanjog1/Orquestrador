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
