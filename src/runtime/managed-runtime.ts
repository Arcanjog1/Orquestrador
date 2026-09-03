/**
 * A runtime the application owns.
 *
 * The install pipeline is deliberately conservative:
 *
 *   resolve -> download -> verify integrity -> extract -> health check in
 *   staging -> capability check -> promote -> health check again
 *
 * Only a build that has already proved itself in staging is promoted, and the
 * previous build is kept so a bad update can be undone. The user is never left
 * without a working runtime because an update went wrong.
 *
 *   runtimes/<id>/
 *     current/        the build in use
 *     previous/       the build it replaced, kept for rollback
 *     runtime.json    manifest describing `current`
 *     previous.json   manifest describing `previous`
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ProcessManager } from '../process/process-manager.js';
import { scanPath } from '../preflight/preflight.js';
import { extractArchive, findExecutable, planPromotion } from './archive.js';
import { downloadAndVerify } from './downloader.js';
import {
  judgeAuthenticode,
  readAuthenticode,
  strongestVerdict,
  verifyBytes,
  type IntegrityVerdict,
} from './integrity.js';
import {
  compatibilityFor,
  evaluateCompatibility,
  firstInstallRequest,
  type RuntimeCompatibility,
  type VersionRequest,
} from './compatibility.js';
import { compareVersions } from './version.js';
import { appPaths, runtimeDir, type AppPaths } from './paths.js';
import {
  RuntimeError,
  RuntimeNotReadyError,
  type HealthStatus,
  type InstallPhase,
  type InstallResult,
  type ProgressReporter,
  type ResolvedDownload,
  type RuntimeDetection,
  type RuntimeId,
  type RuntimeManifest,
  type RuntimeSource,
  type RuntimeTarget,
} from './types.js';

export interface ManagedRuntimeOptions {
  paths?: AppPaths;
  processManager?: ProcessManager;
  target?: RuntimeTarget;
  fetchImpl?: typeof fetch;
  /** Overrides the compiled-in policy. Used by tests. */
  compatibility?: RuntimeCompatibility;
}

/** Filenames inside a runtime's directory. */
const CURRENT = 'current';
const PREVIOUS = 'previous';
const MANIFEST = 'runtime.json';
const PREVIOUS_MANIFEST = 'previous.json';

export abstract class ManagedRuntime {
  abstract readonly id: RuntimeId;
  abstract readonly displayName: string;
  abstract readonly sources: readonly RuntimeSource[];
  protected readonly versionArgs: string[] = ['--version'];
  protected abstract readonly systemExecutableNames: readonly string[];

  protected readonly paths: AppPaths;
  protected readonly processManager: ProcessManager;
  protected readonly target: RuntimeTarget;
  protected readonly fetchImpl: typeof fetch | undefined;
  private readonly compatibilityOverride: RuntimeCompatibility | undefined;

  constructor(options: ManagedRuntimeOptions = {}) {
    this.paths = options.paths ?? appPaths();
    this.processManager = options.processManager ?? new ProcessManager();
    this.target = options.target ?? {
      platform: process.platform,
      arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    };
    this.fetchImpl = options.fetchImpl;
    this.compatibilityOverride = options.compatibility;
  }

  get installDir(): string {
    return runtimeDir(this.id, this.paths);
  }
  get currentDir(): string {
    return join(this.installDir, CURRENT);
  }
  get previousDir(): string {
    return join(this.installDir, PREVIOUS);
  }
  get manifestPath(): string {
    return join(this.installDir, MANIFEST);
  }
  get previousManifestPath(): string {
    return join(this.installDir, PREVIOUS_MANIFEST);
  }

  /** The compatibility window this runtime is held to. */
  get compatibility(): RuntimeCompatibility {
    return this.compatibilityOverride ?? compatibilityFor(this.id);
  }

  readManifest(): RuntimeManifest | null {
    return readManifestFile(this.manifestPath);
  }
  readPreviousManifest(): RuntimeManifest | null {
    return readManifestFile(this.previousManifestPath);
  }

  /** True when a previous build is available to roll back to. */
  get canRollBack(): boolean {
    const manifest = this.readPreviousManifest();
    if (!manifest) return false;
    return existsSync(join(this.previousDir, manifest.executableRelativePath));
  }

  async detect(): Promise<RuntimeDetection> {
    const manifest = this.readManifest();
    if (manifest) {
      const executablePath = join(this.currentDir, manifest.executableRelativePath);
      if (existsSync(executablePath)) {
        return { runtimeId: this.id, origin: 'managed', executablePath, version: manifest.version, manifest };
      }
    }

    const systemPath = this.findSystemInstallation();
    if (systemPath) {
      const version = await this.readVersion(systemPath);
      return { runtimeId: this.id, origin: 'system', executablePath: systemPath, version, manifest: null };
    }

    return { runtimeId: this.id, origin: 'missing', executablePath: null, version: null, manifest: null };
  }

  async getExecutablePath(): Promise<string> {
    const detection = await this.detect();
    if (!detection.executablePath) throw new RuntimeNotReadyError(this.id, this.displayName);
    return detection.executablePath;
  }

  async getVersion(): Promise<string | null> {
    return (await this.detect()).version;
  }

  async healthCheck(): Promise<HealthStatus> {
    const detection = await this.detect();
    if (!detection.executablePath) {
      return {
        healthy: false,
        problem: `${this.displayName} ainda não está configurado.`,
        remedy: 'Configurar automaticamente',
      };
    }
    const version = await this.readVersion(detection.executablePath);
    if (version === null) {
      return {
        healthy: false,
        executablePath: detection.executablePath,
        problem: `${this.displayName} está instalado, mas não respondeu.`,
        remedy: 'Reparar instalação',
      };
    }
    return { healthy: true, version, executablePath: detection.executablePath };
  }

  /**
   * A check the adapter can extend to confirm the build speaks the interface it
   * relies on. Runs against the staged build before anything is promoted.
   */
  async capabilityCheck(executablePath: string): Promise<{ ok: boolean; detail: string }> {
    const version = await this.readVersion(executablePath);
    if (version === null) return { ok: false, detail: 'the executable did not report a version' };
    return { ok: true, detail: `reported "${version}"` };
  }

  /**
   * First install. Prefers the version this project has been tested against,
   * rather than whatever a source happens to call "latest".
   */
  async install(onProgress?: ProgressReporter): Promise<InstallResult> {
    return this.acquire(firstInstallRequest(this.compatibility), onProgress);
  }

  async repair(onProgress?: ProgressReporter): Promise<InstallResult> {
    rmSync(this.installDir, { recursive: true, force: true });
    return this.install(onProgress);
  }

  /**
   * Checks for a newer build and installs it only if the policy allows and it
   * passes staging. A failure leaves the working build exactly where it was.
   */
  async update(onProgress?: ProgressReporter): Promise<InstallResult | null> {
    const installed = this.readManifest();
    const available = await this.findAvailableVersion();
    if (!available) return null;

    if (installed && compareVersions(available.version, installed.version) <= 0) return null;

    const decision = evaluateCompatibility(this.compatibility, available.version);
    if (!decision.compatible) {
      // A newer build exists but is outside the tested window: held back on
      // purpose rather than installed and hoped for.
      return null;
    }

    return this.acquire({ kind: 'latest' }, onProgress);
  }

  /** Restores the previous build. Used when an update misbehaves after promotion. */
  async rollBack(): Promise<InstallResult | null> {
    const previous = this.readPreviousManifest();
    if (!previous || !this.canRollBack) return null;

    const discard = join(this.installDir, `discard-${Date.now()}`);
    if (existsSync(this.currentDir)) renameSync(this.currentDir, discard);
    renameSync(this.previousDir, this.currentDir);
    writeFileSync(this.manifestPath, `${JSON.stringify(previous, null, 2)}\n`, 'utf8');
    rmSync(this.previousManifestPath, { force: true });
    rmSync(discard, { recursive: true, force: true });

    const executablePath = join(this.currentDir, previous.executableRelativePath);
    return {
      runtimeId: this.id,
      executablePath,
      manifest: previous,
      health: await this.healthCheck(),
      rolledBack: true,
    };
  }

  /** The newest version any source offers, without installing anything. */
  async findAvailableVersion(): Promise<{ version: string; sourceId: string } | null> {
    for (const source of this.orderedSources()) {
      try {
        const resolved = await source.resolve(this.target, { kind: 'latest' });
        if (resolved) return { version: resolved.version, sourceId: source.id };
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Sources in the order they should be tried.
   *
   * Documented contracts come first, then sources that can prove what they
   * served. A source marked NOT_PUBLIC_CONTRACT is never promoted ahead of a
   * documented one, however convenient it might be.
   */
  orderedSources(): RuntimeSource[] {
    const contractRank = { DOCUMENTED: 0, PACKAGE_INTERNAL: 1, NOT_PUBLIC_CONTRACT: 2 } as const;
    const strategyRank = (source: RuntimeSource): number =>
      source.integrityStrategy === 'HTTPS_ONLY_LAST_RESORT' ? 1 : 0;

    return [...this.sources]
      .map((source, index) => ({ source, index }))
      .sort((a, b) => {
        const contract = contractRank[a.source.contract] - contractRank[b.source.contract];
        if (contract !== 0) return contract;
        const strategy = strategyRank(a.source) - strategyRank(b.source);
        if (strategy !== 0) return strategy;
        return a.index - b.index; // declared order is the tie-breaker
      })
      .map((entry) => entry.source);
  }

  // -------------------------------------------------------------------------

  private async acquire(
    request: VersionRequest,
    onProgress?: ProgressReporter,
  ): Promise<InstallResult> {
    const report = (phase: InstallPhase, message: string, percent?: number): void => {
      onProgress?.({ runtimeId: this.id, phase, message, ...(percent === undefined ? {} : { percent }) });
    };
    const failures: string[] = [];

    for (const source of this.orderedSources()) {
      report('resolving', `Procurando ${this.displayName}...`);

      let resolved: ResolvedDownload | null;
      try {
        resolved = await source.resolve(this.target, request);
      } catch (err) {
        failures.push(`${source.id}: ${(err as Error).message}`);
        continue;
      }
      if (!resolved) {
        failures.push(`${source.id}: nothing available for this request`);
        continue;
      }

      const decision = evaluateCompatibility(this.compatibility, resolved.version);
      if (!decision.compatible) {
        failures.push(`${source.id}: ${decision.reason}`);
        continue;
      }

      try {
        const result = await this.installFrom(source, resolved, report);
        report('done', `${this.displayName} pronto`, 100);
        return result;
      } catch (err) {
        failures.push(`${source.id}: ${(err as Error).message}`);
      }
    }

    throw new RuntimeError(
      this.id,
      `Não foi possível preparar ${this.displayName} automaticamente.`,
      'Tentar novamente',
      failures.join('; '),
    );
  }

  private async installFrom(
    source: RuntimeSource,
    resolved: ResolvedDownload,
    report: (phase: InstallPhase, message: string, percent?: number) => void,
  ): Promise<InstallResult> {
    const stagingDir = join(this.paths.staging, `${this.id}-${Date.now()}`);
    mkdirSync(stagingDir, { recursive: true });

    try {
      const archiveName = resolved.archiveKind === 'raw'
        ? (resolved.executableNames[0] ?? this.id)
        : `${this.id}.archive`;
      const archivePath = join(stagingDir, archiveName);

      report('downloading', `Baixando ${this.displayName}...`, 0);
      const download = await downloadAndVerify({
        url: resolved.url,
        destination: archivePath,
        expectedBytes: resolved.expectedBytes,
        fetchImpl: this.fetchImpl,
        onProgress: (received, total) => {
          const percent = total ? Math.min(99, Math.round((received / total) * 100)) : undefined;
          report('downloading', `Baixando ${this.displayName}...`, percent);
        },
      });

      report('verifying', 'Verificando...', 100);
      const bytes = readFileSync(archivePath);
      let verdict: IntegrityVerdict = verifyBytes(
        source.integrityStrategy,
        bytes,
        resolved.integrity,
      );
      // A checksum that was published and did not match is fatal.
      if (resolved.integrity && !verdict.verified && source.integrityStrategy !== 'AUTHENTICODE') {
        throw new Error(verdict.detail);
      }

      const extractedRoot = join(stagingDir, 'extracted');
      mkdirSync(extractedRoot, { recursive: true });

      let stagedExecutable: string | null;
      if (resolved.archiveKind === 'raw') {
        const target = join(extractedRoot, archiveName);
        renameSync(archivePath, target);
        stagedExecutable = target;
      } else {
        report('extracting', 'Instalando...');
        await extractArchive({
          archivePath,
          destination: extractedRoot,
          kind: resolved.archiveKind,
          processManager: this.processManager,
        });
        stagedExecutable = findExecutable(extractedRoot, resolved.executableNames);
      }

      if (!stagedExecutable) {
        throw new Error(
          `no executable named ${resolved.executableNames.join(' or ')} inside the download`,
        );
      }
      if (process.platform !== 'win32') {
        try {
          chmodSync(stagedExecutable, 0o755);
        } catch {
          /* Windows has no executable bit */
        }
      }

      // Authenticode is checked on the extracted binary, not the archive.
      if (source.integrityStrategy === 'AUTHENTICODE' || this.target.platform === 'win32') {
        const reading = await readAuthenticode(stagedExecutable, this.processManager);
        if (reading) {
          verdict = strongestVerdict(verdict, judgeAuthenticode(reading, source.expectedPublisher));
        }
      }

      // Prove the staged build works BEFORE it replaces a working one.
      report('staging-health-check', 'Testando...');
      const capability = await this.capabilityCheck(stagedExecutable);
      if (!capability.ok) {
        throw new Error(`the downloaded build failed its capability check: ${capability.detail}`);
      }

      const promotion = planPromotion(extractedRoot, stagedExecutable);
      const previousManifest = this.readManifest();

      report('installing', 'Instalando...');
      this.promote(promotion.promoteDir, previousManifest);

      const manifest: RuntimeManifest = {
        runtimeId: this.id,
        version: resolved.version,
        sourceId: source.id,
        sourceLabel: source.label,
        contract: source.contract,
        url: resolved.url,
        host: safeHost(download.finalUrl),
        platform: this.target.platform,
        arch: this.target.arch,
        bytes: download.bytes,
        sha256: download.sha256,
        integrity: verdict,
        trustLevel: verdict.trustLevel,
        executableRelativePath: promotion.executableRelativePath,
        installedAt: new Date().toISOString(),
        ...(previousManifest ? { previousVersion: previousManifest.version } : {}),
        ...(this.licenseFilesIn(this.currentDir).length
          ? { licenseFiles: this.licenseFilesIn(this.currentDir) }
          : {}),
      };
      writeFileSync(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      report('health-check', 'Testando...');
      const health = await this.healthCheck();

      // A promoted build that fails its health check is undone immediately.
      if (!health.healthy && this.canRollBack) {
        report('rolled-back', `Atualização revertida; ${this.displayName} anterior restaurado.`);
        const restored = await this.rollBack();
        if (restored) return restored;
      }

      return {
        runtimeId: this.id,
        executablePath: join(this.currentDir, promotion.executableRelativePath),
        manifest,
        health,
      };
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  /** Moves the staged tree into `current`, keeping the old one as `previous`. */
  private promote(stagedDir: string, previousManifest: RuntimeManifest | null): void {
    mkdirSync(this.installDir, { recursive: true });
    rmSync(this.previousDir, { recursive: true, force: true });

    if (existsSync(this.currentDir)) {
      renameSync(this.currentDir, this.previousDir);
      if (previousManifest) {
        writeFileSync(
          this.previousManifestPath,
          `${JSON.stringify(previousManifest, null, 2)}\n`,
          'utf8',
        );
      }
    }
    mkdirSync(dirname(this.currentDir), { recursive: true });
    renameSync(stagedDir, this.currentDir);
  }

  /** Licence and notice files shipped with a runtime, so they are preserved. */
  protected licenseFilesIn(_root: string): string[] {
    return [];
  }

  protected findSystemInstallation(): string | null {
    for (const name of this.systemExecutableNames) {
      const found = scanPath(name);
      if (found) return found;
    }
    return null;
  }

  protected async readVersion(executablePath: string): Promise<string | null> {
    const result = await this.processManager.run({
      command: executablePath,
      args: this.versionArgs,
      cwd: this.paths.root,
      timeoutMs: 60_000,
    });
    if (result.outcome !== 'completed' || result.exitCode !== 0) return null;
    const line = (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim();
    return line && line.length > 0 ? line : null;
  }
}

function readManifestFile(path: string): RuntimeManifest | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RuntimeManifest;
  } catch {
    // A manifest that cannot be read means the install cannot be trusted.
    return null;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(unknown)';
  }
}
