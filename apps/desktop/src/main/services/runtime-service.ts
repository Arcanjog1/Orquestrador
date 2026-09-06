/**
 * Runtimes, as the interface sees them.
 *
 * All the hard parts already live in `RuntimeManager`; this service does three
 * things and no more: translate its report into a view the renderer can render
 * without any logic of its own, stream install progress, and hold the
 * `AbortController` that makes "Cancelar" possible.
 */

import type { Database, InstallPhase, InstallProgress, RuntimeId, RuntimeManager } from '../core.js';
import type {
  DiagnosticView,
  InstallResultView,
  RuntimeStatusView,
} from '../../shared/ipc-contract.js';
import type { EventBus } from '../events.js';

/** What each install phase is called in the interface. */
const PHASE_LABELS: Record<InstallPhase, string> = {
  resolving: 'Procurando a versão testada',
  downloading: 'Baixando',
  verifying: 'Verificando',
  extracting: 'Extraindo',
  'staging-health-check': 'Testando',
  installing: 'Instalando',
  'health-check': 'Testando',
  'rolled-back': 'Revertido',
  done: 'Concluído',
};

export class RuntimeService {
  private readonly running = new Map<RuntimeId, AbortController>();

  constructor(
    private readonly runtimeManager: RuntimeManager,
    private readonly events: EventBus,
    private readonly database: Database | null,
  ) {}

  async diagnose(): Promise<DiagnosticView> {
    const report = await this.runtimeManager.diagnose();
    const runtimes: RuntimeStatusView[] = report.runtimes.map((status) => ({
      runtimeId: status.runtimeId,
      displayName: status.displayName,
      origin: status.detection.origin,
      version: status.detection.version,
      ready: status.health.healthy,
      canAutoConfigure: status.canAutoConfigure,
      detail: describe(status.health.healthy, status.detection.origin, status.health.problem),
      outdated: status.outdated,
    }));
    return {
      ready: report.ready,
      runtimes,
      pending: report.pending,
      checkedAt: report.checkedAt,
    };
  }

  /**
   * Moves managed installs older than their tested version up to it, with
   * the same progress events an install shows. Runs in the background at
   * start-up; a failure leaves the working build in place and is reported on
   * the event channel, never thrown at the caller.
   */
  async upgradeOutdated(): Promise<InstallResultView[]> {
    const out: InstallResultView[] = [];
    for (const status of (await this.runtimeManager.diagnose()).runtimes) {
      if (!status.outdated || this.running.has(status.runtimeId)) continue;
      this.events.emit('runtime:progress', {
        runtimeId: status.runtimeId,
        phase: 'resolving',
        label: 'Atualizando',
        message: `Atualizando ${status.displayName} ${status.outdated.installed} para ${status.outdated.tested}...`,
        percent: null,
      });
      out.push(await this.install(status.runtimeId));
    }
    return out;
  }

  /** Installs one runtime, reporting progress as it goes. */
  async install(runtimeId: RuntimeId): Promise<InstallResultView> {
    if (this.running.has(runtimeId)) {
      return { ok: false, runtimeId, version: null, message: 'Já existe uma instalação em andamento.' };
    }
    const controller = new AbortController();
    this.running.set(runtimeId, controller);

    const report = (progress: InstallProgress): void => {
      this.events.emit('runtime:progress', {
        runtimeId: progress.runtimeId,
        phase: progress.phase,
        label: PHASE_LABELS[progress.phase] ?? progress.phase,
        message: progress.message,
        percent: progress.percent ?? null,
      });
    };

    try {
      const result = await this.runtimeManager.install(runtimeId, report, {
        signal: controller.signal,
      });
      this.database?.runtimeInstallations.record(result.manifest, {
        healthy: result.health.healthy,
        ...(result.health.problem ? { problem: result.health.problem } : {}),
      });
      report({
        runtimeId,
        phase: 'done',
        message: `${result.manifest.version} pronto para uso.`,
        percent: 100,
      });
      return {
        ok: true,
        runtimeId,
        version: result.manifest.version,
        message: `${result.manifest.version} instalado.`,
      };
    } catch (error) {
      // A cancellation is not a failure: the interface says so, and offers the
      // action again instead of apologising.
      const cancelled = controller.signal.aborted;
      const message = cancelled ? 'Instalação cancelada.' : userMessageFor(error);
      this.events.emit('runtime:progress', {
        runtimeId,
        phase: cancelled ? 'cancelled' : 'failed',
        label: cancelled ? 'Cancelado' : 'Não foi possível configurar',
        message,
        percent: null,
      });
      return { ok: false, runtimeId, version: null, message };
    } finally {
      this.running.delete(runtimeId);
    }
  }

  cancelInstall(runtimeId: RuntimeId): boolean {
    const controller = this.running.get(runtimeId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async executablePath(runtimeId: RuntimeId): Promise<string> {
    return this.runtimeManager.getExecutablePath(runtimeId);
  }
}

function describe(healthy: boolean, origin: string, problem: string | undefined): string {
  if (healthy) return origin === 'managed' ? 'Pronto (gerenciado pelo aplicativo)' : 'Pronto';
  return problem ?? 'Não configurado';
}

/**
 * Never lets a raw error reach the interface.
 *
 * `RuntimeError` already carries a sentence written for the user; anything else
 * gets a generic one, because "ENOENT: spawn codex" is not a message a person
 * can act on.
 */
function userMessageFor(error: unknown): string {
  if (error && typeof error === 'object' && 'userMessage' in error) {
    const message = (error as { userMessage?: unknown }).userMessage;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'Não foi possível configurar automaticamente. Tente novamente.';
}
