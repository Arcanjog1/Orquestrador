/**
 * The RuntimeManager.
 *
 * One place that answers "is everything this application needs ready, and if
 * not, can I fix it myself?" - which is what the first-run screen shows and
 * what every adapter depends on.
 *
 * Two rules hold throughout:
 *   1. an adapter receives an absolute executable path, never a bare command
 *      name resolved through the machine's PATH at execution time;
 *   2. a problem is reported as something the user can act on, never as
 *      "codex not found in PATH".
 */

import { ensureAppPaths, appPaths, type AppPaths } from './paths.js';
import { ClaudeCodeRuntime, CodexRuntime, GitRuntime } from './runtimes.js';
import type { ManagedRuntime, ManagedRuntimeOptions } from './managed-runtime.js';
import {
  RuntimeError,
  type HealthStatus,
  type InstallOptions,
  type InstallResult,
  type ProgressReporter,
  type RuntimeDetection,
  type RuntimeId,
} from './types.js';

/** One row of the first-run diagnostic. */
export interface RuntimeStatus {
  runtimeId: RuntimeId;
  displayName: string;
  detection: RuntimeDetection;
  health: HealthStatus;
  /** True when the application can fix this without the user leaving the app. */
  canAutoConfigure: boolean;
  /** A managed install older than the tested version; `upgradeOutdated` moves it. */
  outdated: { installed: string; tested: string } | null;
}

/** What the onboarding screen renders. */
export interface DiagnosticReport {
  ready: boolean;
  runtimes: RuntimeStatus[];
  /** Runtimes that need preparing, in the order they should be handled. */
  pending: RuntimeId[];
  checkedAt: string;
}

export class RuntimeManager {
  private readonly runtimes = new Map<RuntimeId, ManagedRuntime>();
  readonly paths: AppPaths;

  constructor(options: ManagedRuntimeOptions = {}) {
    this.paths = options.paths ?? appPaths();
    ensureAppPaths(this.paths);
    const shared: ManagedRuntimeOptions = { ...options, paths: this.paths };
    this.register(new CodexRuntime(shared));
    this.register(new ClaudeCodeRuntime(shared));
    this.register(new GitRuntime(shared));
  }

  register(runtime: ManagedRuntime): void {
    this.runtimes.set(runtime.id, runtime);
  }

  get(runtimeId: RuntimeId): ManagedRuntime {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new Error(`No runtime registered with id "${runtimeId}".`);
    return runtime;
  }

  list(): ManagedRuntime[] {
    return [...this.runtimes.values()];
  }

  /**
   * The absolute executable path for a runtime.
   *
   * Throws `RuntimeNotReadyError`, which carries a user-facing message and the
   * label for the button that fixes it.
   */
  /**
   * Moves every managed install that is older than its tested version up to
   * it. Called at start-up, in the background: a person who installed Codex
   * 0.153.0 through the application gets 0.153.4 without doing anything, and
   * their accounts (kept under `paths.profiles`) are not touched.
   */
  async upgradeOutdated(onProgress?: ProgressReporter, options: InstallOptions = {}): Promise<InstallResult[]> {
    const results: InstallResult[] = [];
    for (const runtime of this.list()) {
      if (!runtime.outdatedManagedVersion()) continue;
      const result = await runtime.ensureTested(onProgress, options);
      if (result) results.push(result);
    }
    return results;
  }

  async getExecutablePath(runtimeId: RuntimeId): Promise<string> {
    return this.get(runtimeId).getExecutablePath();
  }

  async detect(runtimeId: RuntimeId): Promise<RuntimeDetection> {
    return this.get(runtimeId).detect();
  }

  async healthCheck(runtimeId: RuntimeId): Promise<HealthStatus> {
    return this.get(runtimeId).healthCheck();
  }

  /**
   * Runs the whole diagnostic the first-run screen is built on.
   *
   * Every runtime is checked, including ones that turn out to be fine, so the
   * screen can show a complete checklist rather than only failures.
   */
  async diagnose(): Promise<DiagnosticReport> {
    const runtimes: RuntimeStatus[] = [];

    for (const runtime of this.list()) {
      const detection = await runtime.detect();
      const health = await runtime.healthCheck();
      runtimes.push({
        runtimeId: runtime.id,
        displayName: runtime.displayName,
        detection,
        health,
        canAutoConfigure: runtime.sources.length > 0,
        outdated: runtime.outdatedManagedVersion(),
      });
    }

    const pending = runtimes.filter((r) => !r.health.healthy).map((r) => r.runtimeId);
    return {
      ready: pending.length === 0,
      runtimes,
      pending,
      checkedAt: new Date().toISOString(),
    };
  }

  async install(
    runtimeId: RuntimeId,
    onProgress?: ProgressReporter,
    options?: InstallOptions,
  ): Promise<InstallResult> {
    return this.get(runtimeId).install(onProgress, options);
  }

  async repair(
    runtimeId: RuntimeId,
    onProgress?: ProgressReporter,
    options?: InstallOptions,
  ): Promise<InstallResult> {
    return this.get(runtimeId).repair(onProgress, options);
  }

  async update(
    runtimeId: RuntimeId,
    onProgress?: ProgressReporter,
    options?: InstallOptions,
  ): Promise<InstallResult | null> {
    return this.get(runtimeId).update(onProgress, options);
  }

  /**
   * Prepares everything the application needs, reporting progress as it goes.
   *
   * Failures are collected rather than thrown one at a time, so the first-run
   * screen can show which runtimes succeeded and which still need attention.
   */
  async prepareAll(onProgress?: ProgressReporter): Promise<{
    ready: boolean;
    installed: InstallResult[];
    failures: { runtimeId: RuntimeId; displayName: string; message: string; remedy: string }[];
  }> {
    const installed: InstallResult[] = [];
    const failures: { runtimeId: RuntimeId; displayName: string; message: string; remedy: string }[] = [];

    const report = await this.diagnose();
    for (const runtimeId of report.pending) {
      const runtime = this.get(runtimeId);
      if (runtime.sources.length === 0) {
        failures.push({
          runtimeId,
          displayName: runtime.displayName,
          message: `${runtime.displayName} precisa ser instalado para usar este agente.`,
          remedy: 'Ver instruções',
        });
        continue;
      }
      try {
        installed.push(await runtime.install(onProgress));
      } catch (err) {
        const runtimeError = err instanceof RuntimeError ? err : null;
        failures.push({
          runtimeId,
          displayName: runtime.displayName,
          message: runtimeError?.userMessage ?? `Não foi possível preparar ${runtime.displayName}.`,
          remedy: runtimeError?.remedy ?? 'Tentar novamente',
        });
      }
    }

    return { ready: failures.length === 0, installed, failures };
  }
}
