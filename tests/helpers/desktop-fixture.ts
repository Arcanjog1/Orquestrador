/**
 * Builds the desktop service graph against throwaway directories.
 *
 * The same `AppServices` the Electron main process constructs, pointed at a
 * temporary app root with a real (file-backed) SQLite database and whatever
 * agent runners a test wants to supply. Nothing here imports Electron, which is
 * the whole reason the services were written the way they were.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServices } from '../../apps/desktop/src/main/services/app-services.js';
import type { RunnerFactory } from '../../apps/desktop/src/main/services/orchestration-service.js';
import { IpcRouter, type ShellBridge } from '../../apps/desktop/src/main/ipc-router.js';
import type { AppPaths } from '../../src/runtime/paths.js';
import type { EventMap } from '../../apps/desktop/src/shared/ipc-contract.js';
import type { AgentInput, AgentResult, HealthStatus } from '../../src/core/types.js';
import { makeAgentResult, type AgentRunner } from '../../src/agents/agent-runner.js';

export interface DesktopFixture {
  services: AppServices;
  router: IpcRouter;
  paths: AppPaths;
  /** Everything the services emitted, in order. */
  events: Array<{ channel: keyof EventMap; payload: EventMap[keyof EventMap] }>;
  openedUrls: string[];
  openedPaths: string[];
  selectedFolder: string | null;
  cleanup(): Promise<void>;
}

export interface DesktopFixtureOptions {
  createRunners?: RunnerFactory;
  selectFolder?: () => Promise<string | null>;
  maxIterations?: number;
  allowNoChanges?: boolean;
}

export function createDesktopFixture(options: DesktopFixtureOptions = {}): DesktopFixture {
  const root = mkdtempSync(join(tmpdir(), 'lao-desktop-'));
  const paths: AppPaths = {
    root,
    runtimes: join(root, 'runtimes'),
    profiles: join(root, 'profiles'),
    data: join(root, 'data'),
    logs: join(root, 'logs'),
    artifacts: join(root, 'artifacts'),
    updates: join(root, 'updates'),
    staging: join(root, 'staging'),
  };

  const openedUrls: string[] = [];
  const openedPaths: string[] = [];
  const services = new AppServices({
    paths,
    ...(options.createRunners ? { createRunners: options.createRunners } : {}),
    openUrl: (url) => {
      openedUrls.push(url);
    },
    orchestration: {
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
      ...(options.allowNoChanges !== undefined ? { allowNoChanges: options.allowNoChanges } : {}),
    },
  });

  const events: DesktopFixture['events'] = [];
  services.events.subscribe((channel, payload) => {
    events.push({ channel, payload });
  });

  const shell: ShellBridge = {
    selectFolder: options.selectFolder ?? (async () => null),
    // Records instead of launching, and applies the same scheme rule the real
    // shell does, so the guard is exercised rather than assumed.
    async openExternal(url: string) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      openedUrls.push(parsed.toString());
      return true;
    },
    async openPath(path: string) {
      openedPaths.push(path);
      return true;
    },
    appInfo: () => ({
      appVersion: '0.0.0-test',
      electronVersion: 'test',
      nodeVersion: process.versions.node,
      chromeVersion: 'test',
      packaged: false,
    }),
  };

  const router = new IpcRouter(services, shell);

  return {
    services,
    router,
    paths,
    events,
    openedUrls,
    openedPaths,
    selectedFolder: null,
    async cleanup() {
      await services.shutdown();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A scripted agent: each call returns the next canned stdout. */
export class ScriptedAgent implements AgentRunner {
  readonly calls: AgentInput[] = [];
  private index = 0;

  constructor(
    readonly kind: AgentRunner['kind'],
    readonly label: string,
    private readonly script: ReadonlyArray<string | ((input: AgentInput) => string | Promise<string>)>,
  ) {}

  async run(input: AgentInput): Promise<AgentResult> {
    this.calls.push(input);
    const step = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    const startedAt = new Date().toISOString();
    const stdout = typeof step === 'function' ? await step(input) : (step ?? '');
    return makeAgentResult({ startedAt, stdout });
  }

  async cancel(): Promise<void> {}

  async healthCheck(): Promise<HealthStatus> {
    return { healthy: true };
  }
}

/**
 * An agent that hangs until it is cancelled.
 *
 * Stands in for a real CLI that is mid-work: the run can only end if
 * `cancel()` actually reaches it, which is exactly what the cancel test needs
 * to prove.
 */
export class HangingAgent implements AgentRunner {
  readonly kind = 'mock-claude' as const;
  readonly label = 'Hanging';
  started = 0;
  cancelled = 0;
  private release: (() => void) | null = null;

  async run(input: AgentInput): Promise<AgentResult> {
    this.started += 1;
    const startedAt = new Date().toISOString();
    await new Promise<void>((resolve) => {
      // The timer is cleared on release: a stray 15-minute handle would keep
      // the test process alive long after the run ended.
      const timer = setTimeout(resolve, input.timeoutMs);
      this.release = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    return makeAgentResult({ startedAt, outcome: 'cancelled', exitCode: null, stdout: '' });
  }

  async cancel(): Promise<void> {
    this.cancelled += 1;
    this.release?.();
    this.release = null;
  }

  async healthCheck(): Promise<HealthStatus> {
    return { healthy: true };
  }
}
