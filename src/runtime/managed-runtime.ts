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
import { moveDirectoryWithRetry, removeTreeWithRetry } from './fs-retry.js';
import {
  describeProbe,
  dropEnvKeys,
  probeExecution,
  probeFailedLocally,
  type EnvironmentPolicy,
  type ExecutionProbe,
} from './execution-probe.js';
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
  RuntimeInstallCancelledError,
  RuntimeIncompatibleError,
  RuntimeNotReadyError,
  type HealthStatus,
  type InstallOptions,
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
  /**
   * How long the staged build gets to answer `--version`, and how long each
   * comparison run gets after a failure. Tests shorten them; the product's
   * values are the defaults.
   */
  probeTimeouts?: { primaryMs: number; followUpMs: number };
}

/** One step of one install attempt, as the record a person can open shows it. */
export interface InstallTrailEntry {
  readonly source: string;
  readonly phase: InstallPhase;
  readonly message: string;
}

/** Why the last install of this runtime failed, step by step. */
export interface InstallFailure {
  readonly at: string;
  readonly message: string;
  /** One line per attempted step: `[source] phase: what happened`. */
  readonly detail: string;
  readonly trail: readonly InstallTrailEntry[];
}

/** An error inside `installFrom`, tagged with the phase it happened in. */
class InstallStepError extends Error {
  constructor(
    readonly phase: InstallPhase,
    message: string,
    /**
     * True when the bytes were fine and this machine could not run them. A
     * second source ships the same build, so trying it downloads 136 MB to
     * reach the same place; the record says so instead.
     */
    readonly local = false,
    /** The sentence the interface shows, when one more specific than the default fits. */
    readonly userMessage: string | null = null,
  ) {
    super(message);
    this.name = 'InstallStepError';
  }
}

/** A downloaded executable's first run: the antivirus scans it first. Not raised: a slow start is measured, not waited out. */
export const STAGED_VERSION_TIMEOUT_MS = 180_000;
/** Each comparison run after a failed first run; a start held by a scan is fast by then. */
const FOLLOW_UP_TIMEOUT_MS = 30_000;

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
  /** The variable naming this runtime's profile directory (`CODEX_HOME`), if any. */
  protected readonly homeEnvVar: string | null = null;
  protected abstract readonly systemExecutableNames: readonly string[];

  protected readonly paths: AppPaths;
  protected readonly processManager: ProcessManager;
  protected readonly target: RuntimeTarget;
  protected readonly fetchImpl: typeof fetch | undefined;
  private readonly compatibilityOverride: RuntimeCompatibility | undefined;
  private readonly probeTimeouts: { primaryMs: number; followUpMs: number };
  /** The last failed install, kept so the interface can show its steps. */
  lastFailure: InstallFailure | null = null;

  constructor(options: ManagedRuntimeOptions = {}) {
    this.paths = options.paths ?? appPaths();
    this.processManager = options.processManager ?? new ProcessManager();
    this.target = options.target ?? {
      platform: process.platform,
      arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    };
    this.fetchImpl = options.fetchImpl;
    this.compatibilityOverride = options.compatibility;
    this.probeTimeouts = options.probeTimeouts ?? {
      primaryMs: STAGED_VERSION_TIMEOUT_MS,
      followUpMs: FOLLOW_UP_TIMEOUT_MS,
    };
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

  /**
   * What is on this machine, and whether it may be used.
   *
   * A managed install wins over anything on the PATH. Either one is then held
   * to the compatibility window: an executable below the minimum version is
   * reported as found *and* incompatible, so the interface can say "Codex
   * 0.130.0 is too old" and install the tested build, rather than running a
   * binary the adapters were never written against. That is how a machine
   * with an old global Codex ended up refusing the model catalogue with
   * "unknown variant `max`" while the application believed it was ready.
   */
  async detect(): Promise<RuntimeDetection> {
    const manifest = this.readManifest();
    if (manifest) {
      const executablePath = join(this.currentDir, manifest.executableRelativePath);
      if (existsSync(executablePath)) {
        return this.withWindow({
          runtimeId: this.id,
          origin: 'managed',
          executablePath,
          version: manifest.version,
          manifest,
        });
      }
    }

    const systemPath = this.findSystemInstallation();
    if (systemPath) {
      const version = await this.readVersion(systemPath);
      return this.withWindow({
        runtimeId: this.id,
        origin: 'system',
        executablePath: systemPath,
        version: versionNumberOf(version),
        manifest: null,
      });
    }

    return { runtimeId: this.id, origin: 'missing', executablePath: null, version: null, manifest: null };
  }

  private withWindow(detection: RuntimeDetection): RuntimeDetection {
    if (!detection.version) return detection;
    const decision = evaluateCompatibility(this.compatibility, detection.version);
    // Only the lower bound refuses an executable: a build newer than the
    // tested one still speaks the interface (the window's upper bound only
    // holds *updates* back), and an unparseable version is left to the health
    // check, which reports it in its own words.
    if (decision.verdict === 'below-minimum') {
      return { ...detection, incompatible: decision.reason };
    }
    return detection;
  }

  async getExecutablePath(): Promise<string> {
    const detection = await this.detect();
    if (!detection.executablePath) throw new RuntimeNotReadyError(this.id, this.displayName);
    if (detection.incompatible) {
      throw new RuntimeIncompatibleError(
        this.id,
        this.displayName,
        detection.version ?? '?',
        detection.incompatible,
      );
    }
    return detection.executablePath;
  }

  /**
   * True when a managed install is older than the version this build was
   * tested with. Nothing is downloaded here; `ensureTested` does that.
   */
  outdatedManagedVersion(): { installed: string; tested: string } | null {
    const manifest = this.readManifest();
    if (!manifest) return null;
    if (compareVersions(manifest.version, this.compatibility.testedVersion) >= 0) return null;
    return { installed: manifest.version, tested: this.compatibility.testedVersion };
  }

  /**
   * Brings a managed install that is older than the tested version up to it.
   *
   * The tested version is requested by its own tag - not "latest" - and the
   * install goes through staging, the capability check and promotion like a
   * first install, keeping the replaced build as `previous`. The runtime
   * directory is the only thing touched: account profiles (CODEX_HOME,
   * CLAUDE_CONFIG_DIR) live under `paths.profiles` and are never in play.
   */
  async ensureTested(onProgress?: ProgressReporter, options: InstallOptions = {}): Promise<InstallResult | null> {
    const outdated = this.outdatedManagedVersion();
    if (!outdated) return null;
    return this.acquire(firstInstallRequest(this.compatibility), onProgress, options);
  }

  /**
   * Makes sure the executable the adapters will get is one they can use:
   * a managed install behind the tested version is brought up to it, and a
   * machine whose only build is an incompatible one on the PATH gets the
   * managed build installed next to it. The PATH build is never touched -
   * not renamed, not removed, not overwritten; the application simply
   * prefers its own from then on. Null when nothing needed doing.
   */
  async ensureCompatible(onProgress?: ProgressReporter, options: InstallOptions = {}): Promise<InstallResult | null> {
    const detection = await this.detect();
    if (detection.origin === 'managed') return this.ensureTested(onProgress, options);
    if (detection.origin === 'system' && detection.incompatible && this.sources.length > 0) {
      return this.acquire(firstInstallRequest(this.compatibility), onProgress, options);
    }
    return null;
  }

  async getVersion(): Promise<string | null> {
    return (await this.detect()).version;
  }

  async healthCheck(versionTimeoutMs?: number): Promise<HealthStatus> {
    const detection = await this.detect();
    if (!detection.executablePath) {
      return {
        healthy: false,
        problem: `${this.displayName} ainda não está configurado.`,
        remedy: 'Configurar automaticamente',
      };
    }
    if (detection.incompatible) {
      const where = detection.origin === 'system' ? 'encontrado no PATH' : 'instalado';
      return {
        healthy: false,
        ...(detection.version ? { version: detection.version } : {}),
        executablePath: detection.executablePath,
        problem: `${this.displayName} ${detection.version ?? ''} ${where} é anterior à versão mínima ${this.compatibility.minVersion ?? ''}. O aplicativo instala a versão testada (${this.compatibility.testedVersion}) sem mexer nas suas contas.`,
        remedy: 'Atualizar automaticamente',
      };
    }
    const version = await this.readVersion(detection.executablePath, versionTimeoutMs);
    if (version === null) {
      // Only now, and briefly: what the executable did, in the record's words.
      const probe = await this.probe(detection.executablePath, Math.min(versionTimeoutMs ?? 60_000, 30_000), {
        thorough: false,
        hash: false,
      });
      return {
        healthy: false,
        executablePath: detection.executablePath,
        problem: `${this.displayName} está instalado, mas não respondeu.`,
        remedy: 'Reparar instalação',
        detail: describeProbe(probe, this.target.platform),
      };
    }
    return { healthy: true, version, executablePath: detection.executablePath };
  }

  /**
   * Static check, then `--version` through the product's own ProcessManager;
   * with `thorough`, the comparison runs on a failure. Scratch folders go
   * under `paths.staging`, which Codex accepts as a profile directory (it
   * refuses one under the system temp folder).
   */
  async probe(
    executablePath: string,
    timeoutMs: number,
    options: { thorough: boolean; hash?: boolean; onStep?: (message: string) => void },
  ): Promise<ExecutionProbe> {
    const overlay = this.childEnvironmentOverlay();
    return probeExecution({
      executablePath,
      args: this.versionArgs,
      cwd: this.paths.root,
      processManager: this.processManager,
      timeoutMs,
      followUpTimeoutMs: this.probeTimeouts.followUpMs,
      ...(Object.keys(overlay).length ? { envOverlay: overlay } : {}),
      scratchRoot: this.paths.staging,
      homeEnvVar: this.homeEnvVar,
      platform: this.target.platform,
      arch: this.target.arch,
      thorough: options.thorough,
      hash: options.hash !== false,
      ...(options.onStep ? { onStep: options.onStep } : {}),
    });
  }

  /**
   * A check the adapter can extend to confirm the build speaks the interface it
   * relies on. Runs against the staged build before anything is promoted.
   */
  async capabilityCheck(
    executablePath: string,
    onStep?: (message: string) => void,
  ): Promise<{ ok: boolean; detail: string; local: boolean; probe: ExecutionProbe }> {
    const probe = await this.probe(executablePath, this.probeTimeouts.primaryMs, {
      thorough: true,
      ...(onStep ? { onStep } : {}),
    });
    const detail = describeProbe(probe, this.target.platform);
    if (probe.state === 'OK' || probe.recovered) {
      return { ok: true, detail, local: false, probe };
    }
    return { ok: false, detail, local: probeFailedLocally(probe), probe };
  }

  /**
   * The environment overlay every run of the managed build gets: the
   * variables its manifest says to drop, resolved to the keys actually
   * present now (Windows names are case-insensitive). Empty when the
   * manifest carries no policy or the build is not managed.
   */
  childEnvironmentOverlay(env: NodeJS.ProcessEnv = process.env): Record<string, undefined> {
    const policy = this.readManifest()?.environment;
    if (!policy) return {};
    return dropEnvKeys(env, policy.drop);
  }

  /**
   * First install. Prefers the version this project has been tested against,
   * rather than whatever a source happens to call "latest".
   */
  async install(onProgress?: ProgressReporter, options: InstallOptions = {}): Promise<InstallResult> {
    return this.acquire(firstInstallRequest(this.compatibility), onProgress, options);
  }

  async repair(onProgress?: ProgressReporter, options: InstallOptions = {}): Promise<InstallResult> {
    rmSync(this.installDir, { recursive: true, force: true });
    return this.install(onProgress, options);
  }

  /**
   * Checks for a newer build and installs it only if the policy allows and it
   * passes staging. A failure leaves the working build exactly where it was.
   */
  async update(onProgress?: ProgressReporter, options: InstallOptions = {}): Promise<InstallResult | null> {
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

    return this.acquire({ kind: 'latest' }, onProgress, options);
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
    options: InstallOptions = {},
  ): Promise<InstallResult> {
    const report = (phase: InstallPhase, message: string, percent?: number): void => {
      onProgress?.({ runtimeId: this.id, phase, message, ...(percent === undefined ? {} : { percent }) });
    };
    const trail: InstallTrailEntry[] = [];
    let specificMessage: string | null = null;
    const wanted = request.kind === 'tested' ? `version ${request.version}` : 'latest';
    const where = `${this.target.platform}-${this.target.arch}`;

    for (const source of this.orderedSources()) {
      // Cancellation is checked between phases as well as inside the download:
      // giving up before touching the next source is what makes "Cancelar"
      // feel immediate rather than eventual.
      throwIfCancelled(this.id, options.signal);
      report('resolving', `Procurando ${this.displayName}...`);

      let resolved: ResolvedDownload | null;
      try {
        resolved = await source.resolve(this.target, request);
      } catch (err) {
        trail.push({ source: source.id, phase: 'resolving', message: (err as Error).message });
        continue;
      }
      if (!resolved) {
        trail.push({
          source: source.id,
          phase: 'resolving',
          message: `nothing available for ${wanted} on ${where}`,
        });
        continue;
      }

      const decision = evaluateCompatibility(this.compatibility, resolved.version);
      if (!decision.compatible) {
        trail.push({ source: source.id, phase: 'resolving', message: decision.reason });
        continue;
      }

      try {
        throwIfCancelled(this.id, options.signal);
        const result = await this.installFrom(source, resolved, report, options.signal);
        report('done', `${this.displayName} pronto`, 100);
        this.lastFailure = null;
        return result;
      } catch (err) {
        // The person's cancel is not one more failed source.
        if (err instanceof RuntimeInstallCancelledError) throw err;
        const phase = err instanceof InstallStepError ? err.phase : 'installing';
        trail.push({ source: source.id, phase, message: `${(err as Error).message} (url: ${resolved.url})` });
        if (err instanceof InstallStepError && err.userMessage) specificMessage = err.userMessage;
        if (err instanceof InstallStepError && err.local) {
          // The download, the checksum and the extraction were fine; the
          // machine could not run the result. Another source ships the same
          // build, so the failure is reported as local, not tried again.
          trail.push({
            source: source.id,
            phase,
            message:
              'falha local de execução, não da fonte: as outras fontes entregam o mesmo executável e não foram baixadas',
          });
          break;
        }
      }
    }

    throwIfCancelled(this.id, options.signal);
    const message = specificMessage ?? `Não foi possível preparar ${this.displayName} automaticamente.`;
    const detail = trail.map((entry) => `[${entry.source}] ${entry.phase}: ${entry.message}`).join('\n');
    this.lastFailure = { at: new Date().toISOString(), message, detail, trail };
    throw new RuntimeError(this.id, message, 'Tentar novamente', detail);
  }

  private async installFrom(
    source: RuntimeSource,
    resolved: ResolvedDownload,
    report: (phase: InstallPhase, message: string, percent?: number) => void,
    signal?: AbortSignal,
  ): Promise<InstallResult> {
    const stagingDir = join(this.paths.staging, `${this.id}-${Date.now()}`);
    mkdirSync(stagingDir, { recursive: true });
    // Every throw below is tagged with the phase it came from, so the record
    // says "extracting: tar.exe ..." rather than only "could not prepare".
    let phase: InstallPhase = 'downloading';

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
        signal,
        fetchImpl: this.fetchImpl,
        onProgress: (received, total) => {
          const percent = total ? Math.min(99, Math.round((received / total) * 100)) : undefined;
          const mb = (received / 1_048_576).toFixed(0);
          const of = total ? ` de ${(total / 1_048_576).toFixed(0)}` : '';
          report('downloading', `Baixando ${this.displayName}... ${mb}${of} MB`, percent);
        },
      });

      throwIfCancelled(this.id, signal);
      phase = 'verifying';
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

      phase = 'extracting';
      let stagedExecutable: string | null;
      if (resolved.archiveKind === 'raw') {
        const target = join(extractedRoot, archiveName);
        renameSync(archivePath, target);
        stagedExecutable = target;
      } else {
        report('extracting', 'Extraindo...');
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
          `no executable named ${resolved.executableNames.join(' or ')} inside the download (${download.bytes} bytes, ${resolved.archiveKind})`,
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
      phase = 'staging-health-check';
      report('staging-health-check', 'Testando...');
      const capability = await this.capabilityCheck(stagedExecutable, (message) =>
        report('staging-health-check', message),
      );
      if (!capability.ok) {
        throw new InstallStepError(
          'staging-health-check',
          `the downloaded build failed its capability check:\n${capability.detail}`,
          capability.local,
          capability.probe?.state === 'CPU_CAPABILITY_OVERRIDE_INCOMPATIBLE'
            ? `Esta versão do ${this.displayName} não consegue iniciar neste computador.`
            : null,
        );
      }
      const environmentPolicy: EnvironmentPolicy | null = capability.probe?.environmentPolicy ?? null;

      const promotion = planPromotion(extractedRoot, stagedExecutable);
      const previousManifest = this.readManifest();

      phase = 'installing';
      report('installing', 'Instalando...');
      await this.promote(promotion.promoteDir, previousManifest);

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
        ...(environmentPolicy ? { environment: environmentPolicy } : {}),
        ...(previousManifest ? { previousVersion: previousManifest.version } : {}),
        ...(this.licenseFilesIn(this.currentDir).length
          ? { licenseFiles: this.licenseFilesIn(this.currentDir) }
          : {}),
      };
      writeFileSync(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      phase = 'health-check';
      report('health-check', 'Testando...');
      const health = await this.healthCheck(this.probeTimeouts.primaryMs);

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
    } catch (err) {
      if (err instanceof RuntimeInstallCancelledError || err instanceof InstallStepError) throw err;
      throw new InstallStepError(phase, (err as Error).message);
    } finally {
      // Best effort, and never the reason an otherwise finished install is
      // reported as failed: on Windows the folder can stay locked for a
      // moment after the staged build ran.
      await removeTreeWithRetry(stagingDir, { maxWaitMs: 5000 });
    }
  }

  /**
   * Moves the staged tree into `current`, keeping the old one as `previous`.
   *
   * Each move retries transient Windows refusals (a just-run executable is
   * still being scanned) and copies when the two folders are on different
   * volumes; a plain rename did neither and failed installs it had finished.
   */
  private async promote(stagedDir: string, previousManifest: RuntimeManifest | null): Promise<void> {
    mkdirSync(this.installDir, { recursive: true });
    await removeTreeWithRetry(this.previousDir, { force: false });

    if (existsSync(this.currentDir)) {
      await moveDirectoryWithRetry(this.currentDir, this.previousDir);
      if (previousManifest) {
        writeFileSync(
          this.previousManifestPath,
          `${JSON.stringify(previousManifest, null, 2)}\n`,
          'utf8',
        );
      }
    }
    mkdirSync(dirname(this.currentDir), { recursive: true });
    await moveDirectoryWithRetry(stagedDir, this.currentDir);
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

  protected async readVersion(executablePath: string, timeoutMs = 60_000): Promise<string | null> {
    // The managed build runs under its manifest's policy here too, or a
    // health check would trip over the very variable the install proved.
    const overlay = this.childEnvironmentOverlay();
    const result = await this.processManager.run({
      command: executablePath,
      args: this.versionArgs,
      cwd: this.paths.root,
      ...(Object.keys(overlay).length ? { env: overlay } : {}),
      timeoutMs,
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

/**
 * Stops the pipeline the moment the user cancels.
 *
 * Checked between phases so a cancelled install never leaves a half-promoted
 * build behind: the staging directory is discarded by the caller's cleanup and
 * whatever was working before is untouched.
 */
function throwIfCancelled(runtimeId: RuntimeId, signal?: AbortSignal): void {
  if (signal?.aborted) throw new RuntimeInstallCancelledError(runtimeId);
}

/**
 * The version number inside a `--version` line: "codex-cli 0.130.0" gives
 * "0.130.0". Null when the line carries no version at all.
 */
export function versionNumberOf(line: string | null): string | null {
  if (!line) return null;
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(line);
  return match ? match[1]! : null;
}
