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
import type {
  EnvironmentFactory,
  RunnerFactory,
} from '../../apps/desktop/src/main/services/orchestration-service.js';
import { IpcRouter, type ShellBridge } from '../../apps/desktop/src/main/ipc-router.js';
import type { AppPaths } from '../../src/runtime/paths.js';
import type { GitHubClientOptions } from '../../src/github/github-client.js';
import type { SecretStore } from '../../apps/desktop/src/main/services/github-service.js';
import type { EventMap } from '../../apps/desktop/src/shared/ipc-contract.js';
import type { AgentInput, AgentResult, HealthStatus } from '../../src/core/types.js';
import { makeAgentResult, type AgentRunner } from '../../src/agents/agent-runner.js';
import type { HttpTransport } from '../../src/providers/provider-http.js';
import type {
  AgentProvider,
  AuthenticationStatus,
  InvocationUsage,
  ModelDescriptor,
  ProviderCapabilities,
} from '../../src/providers/provider-types.js';
import { addUsage, emptyUsage } from '../../src/providers/provider-types.js';

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
  /** Where runs execute. Omitted means this computer, as it always has. */
  environments?: EnvironmentFactory;
  selectFolder?: () => Promise<string | null>;
  maxIterations?: number;
  allowNoChanges?: boolean;
  /** Where the GitHub client talks; tests run a local fake. */
  github?: GitHubClientOptions;
  /** Off by default; a test that needs the login sets it on. */
  secrets?: SecretStore;
  /** HTTP for the provider APIs; a test points it at a scripted transport. */
  providerTransport?: HttpTransport;
}

/**
 * A store that is reversible and visibly not the plain text: enough to prove
 * what is written at rest is not the token, without an OS keyring.
 */
export function fakeSecretStore(): SecretStore {
  return {
    available: true,
    encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: (cipher) => {
      if (!cipher.startsWith('enc:')) throw new Error('not ours');
      return Buffer.from(cipher.slice(4), 'base64').toString('utf8');
    },
  };
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
  let loginItem = false;
  const services = new AppServices({
    paths,
    ...(options.createRunners ? { createRunners: options.createRunners } : {}),
    openUrl: (url) => {
      openedUrls.push(url);
    },
    orchestration: {
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
      ...(options.allowNoChanges !== undefined ? { allowNoChanges: options.allowNoChanges } : {}),
      ...(options.environments ? { environments: options.environments } : {}),
    },
    ...(options.github ? { github: options.github } : {}),
    ...(options.secrets ? { secrets: options.secrets } : {}),
    ...(options.providerTransport ? { providerTransport: options.providerTransport } : {}),
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
    startWithSystem: () => loginItem,
    setStartWithSystem: (enabled: boolean) => {
      loginItem = enabled;
      return loginItem;
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

  /**
   * A session id to report back, as a tool that supports resume would.
   *
   * Set by a test that wants to exercise continuity; absent means this runner
   * reports no session, which is what a build without `--resume` does.
   */
  sessionId: string | null = null;

  async run(input: AgentInput): Promise<AgentResult> {
    this.calls.push(input);
    const step = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    const startedAt = new Date().toISOString();
    const stdout = typeof step === 'function' ? await step(input) : (step ?? '');
    return makeAgentResult({
      startedAt,
      stdout,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    });
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

/**
 * A scripted agent that also *declares what it is*.
 *
 * The point of this one is the declaration: a conversation worker says
 * `toolExecution: false`, and the loop must then refuse to send it work that
 * needs files changed. Without a runner that declares, that rule could only be
 * asserted against the real API adapters and a network.
 */
export class ScriptedProvider extends ScriptedAgent implements AgentProvider {
  readonly providerId: 'anthropic' | 'openai';
  readonly connectionId: string | null;
  private total: InvocationUsage;

  constructor(
    kind: AgentRunner['kind'],
    label: string,
    script: ReadonlyArray<string | ((input: AgentInput) => string | Promise<string>)>,
    private readonly declared: ProviderCapabilities,
    connectionId: string | null = null,
    /** Charged on every call, so a test can drive a budget to its limit. */
    private readonly perCall: InvocationUsage | null = null,
  ) {
    super(kind, label, script);
    this.providerId = declared.providerId as 'anthropic' | 'openai';
    this.connectionId = connectionId;
    this.total = emptyUsage(declared.billing);
  }

  override async run(input: AgentInput): Promise<AgentResult> {
    const result = await super.run(input);
    if (!this.perCall) return result;
    this.total = addUsage(this.total, this.perCall);
    return { ...result, usage: this.perCall };
  }

  getCapabilities(): ProviderCapabilities {
    return this.declared;
  }

  async getAvailableModels(): Promise<ModelDescriptor[]> {
    return [{ id: 'scripted-model', displayName: 'Scripted' }];
  }

  async getAuthenticationStatus(): Promise<AuthenticationStatus> {
    return {
      connectionId: this.connectionId,
      providerId: this.providerId,
      connectionKind: this.declared.connectionKind,
      authenticated: true,
      checkedAt: new Date().toISOString(),
    };
  }

  getUsage(): InvocationUsage {
    return this.total;
  }
}

/** A connection that answers and analyses but cannot touch a file. */
export function conversationCapabilities(
  providerId: 'anthropic' | 'openai',
): ProviderCapabilities {
  return {
    providerId,
    connectionKind: 'api',
    conversation: true,
    toolExecution: false,
    workspaceRequired: false,
    streaming: false,
    structuredOutput: providerId === 'openai',
    usageReporting: true,
    modelSelection: true,
    reasoningSelection: true,
    billing: 'api-metered',
  };
}

/** A connection with a real executor behind it: the vendor's official CLI. */
export function codingCapabilities(providerId: 'anthropic' | 'openai'): ProviderCapabilities {
  return {
    ...conversationCapabilities(providerId),
    connectionKind: 'cli',
    toolExecution: true,
    workspaceRequired: true,
    usageReporting: false,
    billing: 'subscription',
  };
}
