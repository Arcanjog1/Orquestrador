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
import { ensureAppPaths, appPaths } from './paths.js';
import { ClaudeCodeRuntime, CodexRuntime, GitRuntime } from './runtimes.js';
import { RuntimeError, } from './types.js';
export class RuntimeManager {
    runtimes = new Map();
    paths;
    constructor(options = {}) {
        this.paths = options.paths ?? appPaths();
        ensureAppPaths(this.paths);
        const shared = { ...options, paths: this.paths };
        this.register(new CodexRuntime(shared));
        this.register(new ClaudeCodeRuntime(shared));
        this.register(new GitRuntime(shared));
    }
    register(runtime) {
        this.runtimes.set(runtime.id, runtime);
    }
    get(runtimeId) {
        const runtime = this.runtimes.get(runtimeId);
        if (!runtime)
            throw new Error(`No runtime registered with id "${runtimeId}".`);
        return runtime;
    }
    list() {
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
    async upgradeOutdated(onProgress, options = {}) {
        const results = [];
        for (const runtime of this.list()) {
            const result = await runtime.ensureCompatible(onProgress, options);
            if (result)
                results.push(result);
        }
        return results;
    }
    /** What a child process of this runtime must not inherit (see the manifest's policy). */
    childEnvironmentOverlay(runtimeId) {
        return this.get(runtimeId).childEnvironmentOverlay();
    }
    async getExecutablePath(runtimeId) {
        return this.get(runtimeId).getExecutablePath();
    }
    async detect(runtimeId) {
        return this.get(runtimeId).detect();
    }
    async healthCheck(runtimeId) {
        return this.get(runtimeId).healthCheck();
    }
    /**
     * Runs the whole diagnostic the first-run screen is built on.
     *
     * Every runtime is checked, including ones that turn out to be fine, so the
     * screen can show a complete checklist rather than only failures.
     */
    async diagnose() {
        const runtimes = [];
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
                needsManaged: detection.origin === 'system' && detection.incompatible !== undefined && runtime.sources.length > 0,
                lastFailure: runtime.lastFailure,
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
    async install(runtimeId, onProgress, options) {
        return this.get(runtimeId).install(onProgress, options);
    }
    async repair(runtimeId, onProgress, options) {
        return this.get(runtimeId).repair(onProgress, options);
    }
    async update(runtimeId, onProgress, options) {
        return this.get(runtimeId).update(onProgress, options);
    }
    /**
     * Prepares everything the application needs, reporting progress as it goes.
     *
     * Failures are collected rather than thrown one at a time, so the first-run
     * screen can show which runtimes succeeded and which still need attention.
     */
    async prepareAll(onProgress) {
        const installed = [];
        const failures = [];
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
            }
            catch (err) {
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
//# sourceMappingURL=runtime-manager.js.map