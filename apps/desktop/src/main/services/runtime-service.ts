/**
 * What the interface is allowed to do with runtimes.
 *
 * The screen never implements diagnosis: it renders whatever
 * `RuntimeManager.diagnose()` returns. This service exists to translate
 * between that layer and the bridge - trimming manifests down to what a
 * user-facing screen needs, turning install phases into friendly steps, and
 * owning the cancellation handles - not to reimplement any of it.
 */

import type { RuntimeManager } from '../../../../../src/runtime/runtime-manager.js';
import type { DiagnosticReport } from '../../../../../src/runtime/runtime-manager.js';
import {
  RuntimeError,
  type InstallProgress,
  type InstallResult,
  type RuntimeId,
} from '../../../../../src/runtime/types.js';
import {
  PHASE_TO_STEP,
  type InstallProgressEvent,
  type InstallSummary,
} from '../../shared/ipc-contract.js';

export interface RuntimeServiceOptions {
  runtimeManager: RuntimeManager;
  /** Pushes an event to the interface. Injected so it is testable without Electron. */
  emitProgress: (event: InstallProgressEvent) => void;
  /** Developer mode adds the raw phase to every progress event. Off by default. */
  developerMode?: boolean;
}

/**
 * Words that belong in the developer view and nowhere else.
 *
 * The core already speaks in the product's voice, but a message is data from
 * another layer: if one ever arrives carrying a path, an exit code or a spawn
 * detail, the interface shows the step name instead of leaking it.
 */
const DEVELOPER_VOCABULARY =
  /\b(PATH|spawn|stderr|stdout|tarball|argv|exit code|CLAUDE_CONFIG_DIR|ENOENT|EACCES|npm|sha256|checksum)\b|[\\/]{1,2}[A-Za-z0-9_.-]+[\\/]/;

export class RuntimeService {
  private readonly manager: RuntimeManager;
  private readonly emitProgress: (event: InstallProgressEvent) => void;
  private readonly developerMode: boolean;
  private readonly inFlight = new Map<RuntimeId, AbortController>();

  constructor(options: RuntimeServiceOptions) {
    this.manager = options.runtimeManager;
    this.emitProgress = options.emitProgress;
    this.developerMode = options.developerMode ?? false;
  }

  /** The whole first-run checklist, straight from the approved layer. */
  async diagnose(): Promise<DiagnosticReport> {
    return this.manager.diagnose();
  }

  async install(runtimeId: RuntimeId): Promise<InstallSummary> {
    return this.run(runtimeId, (report, signal) =>
      this.manager.install(runtimeId, report, { signal }),
    );
  }

  async repair(runtimeId: RuntimeId): Promise<InstallSummary> {
    return this.run(runtimeId, (report, signal) =>
      this.manager.repair(runtimeId, report, { signal }),
    );
  }

  /**
   * Asks a running install to stop.
   *
   * Returns whether there was anything to cancel, so the interface can say
   * "cancelado" only when something really was.
   */
  cancelInstall(runtimeId: RuntimeId): { cancelled: boolean } {
    const controller = this.inFlight.get(runtimeId);
    if (!controller) return { cancelled: false };
    controller.abort();
    return { cancelled: true };
  }

  get busy(): RuntimeId[] {
    return [...this.inFlight.keys()];
  }

  private async run(
    runtimeId: RuntimeId,
    operation: (
      report: (progress: InstallProgress) => void,
      signal: AbortSignal,
    ) => Promise<InstallResult>,
  ): Promise<InstallSummary> {
    if (this.inFlight.has(runtimeId)) {
      throw new RuntimeError(
        runtimeId,
        'Este componente já está sendo preparado.',
        'Aguardar',
        'an install for this runtime is already running',
      );
    }

    const controller = new AbortController();
    this.inFlight.set(runtimeId, controller);
    try {
      const result = await operation((progress) => {
        this.emitProgress(this.toEvent(progress));
      }, controller.signal);
      return this.toSummary(result);
    } finally {
      this.inFlight.delete(runtimeId);
    }
  }

  private toEvent(progress: InstallProgress): InstallProgressEvent {
    const step = PHASE_TO_STEP[progress.phase];
    const safe = DEVELOPER_VOCABULARY.test(progress.message) ? `${step}...` : progress.message;
    const event: InstallProgressEvent = { runtimeId: progress.runtimeId, step, message: safe };
    if (typeof progress.percent === 'number') event.percent = progress.percent;
    if (this.developerMode) event.diagnostic = progress;
    return event;
  }

  /**
   * Trims an install result for the bridge.
   *
   * The manifest carries the URL, host, checksum and source contract. Those
   * are support material, not onboarding material, so they stop here.
   */
  private toSummary(result: InstallResult): InstallSummary {
    const summary: InstallSummary = {
      runtimeId: result.runtimeId,
      displayName: this.manager.get(result.runtimeId).displayName,
      version: result.manifest.version,
      healthy: result.health.healthy,
      rolledBack: result.rolledBack === true,
    };
    if (result.health.problem) summary.problem = result.health.problem;
    return summary;
  }
}
