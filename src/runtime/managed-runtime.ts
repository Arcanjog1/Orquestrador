/**
 * A runtime the application owns.
 *
 * Install is deliberately staged: resolve -> download -> verify -> extract ->
 * locate -> promote atomically -> health check. Only the final rename makes an
 * install visible, so a crash or a lost connection never leaves something
 * behind that looks installed but is not.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ProcessManager } from '../process/process-manager.js';
import { scanPath } from '../preflight/preflight.js';
import { extractArchive, findExecutable, planPromotion } from './archive.js';
import { downloadAndVerify, DownloadError, IntegrityError } from './downloader.js';
import { appPaths, runtimeDir, runtimeManifestPath, type AppPaths } from './paths.js';
import {
  RuntimeError,
  RuntimeNotReadyError,
  type HealthStatus,
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
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

export abstract class ManagedRuntime {
  abstract readonly id: RuntimeId;
  /** Name shown to the user, e.g. "Codex". */
  abstract readonly displayName: string;
  /** Candidate sources, most trustworthy first. */
  abstract readonly sources: readonly RuntimeSource[];
  /** Arguments that make the executable print its version. */
  protected readonly versionArgs: string[] = ['--version'];
  /** Executable names to look for when scanning the machine's PATH. */
  protected abstract readonly systemExecutableNames: readonly string[];

  protected readonly paths: AppPaths;
  protected readonly processManager: ProcessManager;
  protected readonly target: RuntimeTarget;
  protected readonly fetchImpl: typeof fetch | undefined;

  constructor(options: ManagedRuntimeOptions = {}) {
    this.paths = options.paths ?? appPaths();
    this.processManager = options.processManager ?? new ProcessManager();
    this.target = options.target ?? {
      platform: process.platform,
      arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    };
    this.fetchImpl = options.fetchImpl;
  }

  get installDir(): string {
    return runtimeDir(this.id, this.paths);
  }

  get manifestPath(): string {
    return runtimeManifestPath(this.id, this.paths);
  }

  /** The manifest of the managed install, or null when there is none. */
  readManifest(): RuntimeManifest | null {
    if (!existsSync(this.manifestPath)) return null;
    try {
      return JSON.parse(readFileSync(this.manifestPath, 'utf8')) as RuntimeManifest;
    } catch {
      // A corrupt manifest means the install cannot be trusted; treat it as absent
      // so `repair()` reinstalls rather than running an unknown binary.
      return null;
    }
  }

  /**
   * Looks for a usable runtime: the application's own install first, then a
   * compatible one already on the machine.
   */
  async detect(): Promise<RuntimeDetection> {
    const manifest = this.readManifest();
    if (manifest) {
      const executablePath = join(this.installDir, manifest.executableRelativePath);
      if (existsSync(executablePath)) {
        return {
          runtimeId: this.id,
          origin: 'managed',
          executablePath,
          version: manifest.version,
          manifest,
        };
      }
    }

    const systemPath = this.findSystemInstallation();
    if (systemPath) {
      const version = await this.readVersion(systemPath);
      return {
        runtimeId: this.id,
        origin: 'system',
        executablePath: systemPath,
        version,
        manifest: null,
      };
    }

    return { runtimeId: this.id, origin: 'missing', executablePath: null, version: null, manifest: null };
  }

  /**
   * The absolute path an adapter should execute.
   *
   * Throws `RuntimeNotReadyError` rather than returning a bare command name:
   * nothing in this application resolves an agent through the global PATH at
   * execution time.
   */
  async getExecutablePath(): Promise<string> {
    const detection = await this.detect();
    if (!detection.executablePath) throw new RuntimeNotReadyError(this.id, this.displayName);
    return detection.executablePath;
  }

  async getVersion(): Promise<string | null> {
    const detection = await this.detect();
    return detection.version;
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
   * Downloads and installs the runtime, trying each source in order.
   *
   * The first source that yields a working install wins; failures are collected
   * so the user gets one clear message instead of a stack trace.
   */
  async install(onProgress?: ProgressReporter): Promise<InstallResult> {
    const report = (phase: Parameters<typeof this.progress>[0], message: string, percent?: number): void => {
      onProgress?.(this.progress(phase, message, percent));
    };

    const failures: string[] = [];

    for (const source of this.sources) {
      report('resolving', `Procurando ${this.displayName}...`);

      let resolved: ResolvedDownload | null;
      try {
        resolved = await source.resolve(this.target);
      } catch (err) {
        failures.push(`${source.id}: ${(err as Error).message}`);
        continue;
      }
      if (!resolved) {
        failures.push(`${source.id}: nothing available for ${this.target.platform}-${this.target.arch}`);
        continue;
      }

      try {
        const result = await this.installFrom(source, resolved, report);
        report('done', `${this.displayName} pronto`, 100);
        return result;
      } catch (err) {
        failures.push(`${source.id}: ${(err as Error).message}`);
        // Try the next source rather than giving up on the first problem.
      }
    }

    throw new RuntimeError(
      this.id,
      `Não foi possível preparar ${this.displayName} automaticamente.`,
      'Tentar novamente',
      failures.join('; '),
    );
  }

  /** Reinstalls from scratch, discarding whatever is there. */
  async repair(onProgress?: ProgressReporter): Promise<InstallResult> {
    rmSync(this.installDir, { recursive: true, force: true });
    return this.install(onProgress);
  }

  /** Installs the newest available version when it differs from the current one. */
  async update(onProgress?: ProgressReporter): Promise<InstallResult | null> {
    const current = this.readManifest();
    for (const source of this.sources) {
      const resolved = await source.resolve(this.target).catch(() => null);
      if (!resolved) continue;
      if (current && current.version === resolved.version) return null;
      return this.install(onProgress);
    }
    return null;
  }

  // -------------------------------------------------------------------------

  private async installFrom(
    source: RuntimeSource,
    resolved: ResolvedDownload,
    report: (phase: Parameters<typeof this.progress>[0], message: string, percent?: number) => void,
  ): Promise<InstallResult> {
    const stagingDir = join(this.paths.staging, `${this.id}-${Date.now()}`);
    mkdirSync(stagingDir, { recursive: true });

    try {
      const archiveName = resolved.archiveKind === 'raw' ? this.rawFileName(resolved) : `${this.id}.archive`;
      const archivePath = join(stagingDir, archiveName);

      report('downloading', `Baixando ${this.displayName}...`, 0);
      const download = await downloadAndVerify({
        url: resolved.url,
        destination: archivePath,
        integrity: resolved.integrity,
        expectedBytes: resolved.expectedBytes,
        fetchImpl: this.fetchImpl,
        onProgress: (received, total) => {
          const percent = total ? Math.min(99, Math.round((received / total) * 100)) : undefined;
          report('downloading', `Baixando ${this.displayName}...`, percent);
        },
      });

      report('verifying', 'Verificando...', 100);

      const extractedRoot = join(stagingDir, 'extracted');
      mkdirSync(extractedRoot, { recursive: true });

      let executablePath: string | null;
      if (resolved.archiveKind === 'raw') {
        // A bare executable: move it into the tree we are about to promote.
        const target = join(extractedRoot, archiveName);
        renameSync(archivePath, target);
        executablePath = target;
      } else {
        report('extracting', 'Instalando...');
        await extractArchive({
          archivePath,
          destination: extractedRoot,
          kind: resolved.archiveKind,
          processManager: this.processManager,
        });
        executablePath = findExecutable(extractedRoot, resolved.executableNames);
      }

      if (!executablePath) {
        throw new Error(
          `no executable named ${resolved.executableNames.join(' or ')} inside the downloaded archive`,
        );
      }

      const promotion = planPromotion(extractedRoot, executablePath);

      report('installing', 'Instalando...');
      // Atomic promotion: everything is verified before this single rename, and
      // the manifest is written only afterwards, so a manifest always describes
      // a complete install.
      mkdirSync(dirname(this.installDir), { recursive: true });
      rmSync(this.installDir, { recursive: true, force: true });
      renameSync(promotion.promoteDir, this.installDir);

      const finalExecutable = join(this.installDir, promotion.executableRelativePath);
      if (process.platform !== 'win32') {
        try {
          chmodSync(finalExecutable, 0o755);
        } catch {
          /* best effort; Windows has no executable bit anyway */
        }
      }

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
        integrityVerified: download.integrityVerified,
        executableRelativePath: promotion.executableRelativePath,
        installedAt: new Date().toISOString(),
      };
      writeFileSync(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      report('health-check', 'Testando...');
      const health = await this.healthCheck();

      return { runtimeId: this.id, executablePath: finalExecutable, manifest, health };
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  private rawFileName(resolved: ResolvedDownload): string {
    return resolved.executableNames[0] ?? this.id;
  }

  private progress(
    phase: 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'installing' | 'health-check' | 'done',
    message: string,
    percent?: number,
  ): { runtimeId: RuntimeId; phase: typeof phase; message: string; percent?: number } {
    return { runtimeId: this.id, phase, message, ...(percent === undefined ? {} : { percent }) };
  }

  /** Best-effort search for a compatible installation already on the machine. */
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

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(unknown)';
  }
}

export { DownloadError, IntegrityError };
